/**
 * L3 Justified - Rationale Axis Extractor (per 01-spec §7.3).
 *
 * Two-stage extraction on the rationale text:
 *   Stage 3a (lexicon, deterministic): per-axis word-boundary matches.
 *   Stage 3b (LLM fallback): when top-1 < 2 matches OR (top-1 - top-2) < 2,
 *     call gpt-5.4-mini with a no-scenario-context classifier prompt.
 *
 * The fallback judge uses the SAME model as L2 (gpt-5.4-mini) but a different
 * prompt - the rationale must speak for itself, no scenario context.
 *
 * OpenAI envelope rules (matches value-judge.ts):
 *   - max_completion_tokens (NOT max_tokens)
 *   - NO temperature
 *   - response_format: { type: 'json_schema', json_schema: { strict: false, schema } }
 */

import type { Env } from '../domain/types';
import type { JudgeAxisId } from '../judges/value-judge';

export type ResolutionMethod = 'lexicon' | 'llm_fallback' | 'ambiguous';

export type RationaleExtraction = {
  topAxis: JudgeAxisId | 'unknown';
  drives: Record<JudgeAxisId, number>;
  resolution: ResolutionMethod;
};

const FALLBACK_MODEL = 'gpt-5.4-mini';
const FALLBACK_MAX_TOKENS = 200;
const FALLBACK_TIMEOUT_MS = 25_000;

/**
 * Per-axis lexicon (per 01-spec §7.3, slightly extended after a 10-rationale
 * spot check). Each token is matched case-insensitively at word boundaries,
 * so "explore" matches "explore" and "Explores" but not "exploration" — that
 * is intentional: we count distinct surface forms so the (top-1 - top-2)
 * gap stays meaningful.
 *
 * If stage-3a unambiguous-resolution rate falls below 70% on the canonical
 * battery, this list iterates per O-2 default in 01-spec §18.
 */
const LEXICON: Record<JudgeAxisId, readonly string[]> = {
  achievement: [
    'success', 'win', 'outperform', 'optimal', 'productive', 'efficient',
    'high-performing', 'deliver', 'ship', 'beat', 'target', 'kpi',
    'measurable', 'progress', 'achieve', 'achievement', 'goal', 'best',
    'maximize', 'top-performing', 'roi', 'license', 'seat', 'saves time',
    'time saved', 'throughput', 'capacity', 'faster', 'productivity',
  ],
  self_direction: [
    'explore', 'novel', 'learn', 'autonomy', 'curiosity', 'experiment',
    'freedom', 'independent', 'creative', 'original', 'discover',
    'open-ended', 'innovate', 'pivot', 'try', 'investigate', 'autonomous',
    'curious', 'novelty', 'sandbox', 'choose', 'choice', 'voluntary',
    'workflow fit', 'use-case menu', 'menu',
  ],
  security: [
    'risk', 'safety', 'safe', 'harm', 'secure', 'stable', 'conservative',
    'cautious', 'prevent', 'guard', 'mitigate', 'downside', 'fail-safe',
    'irreversible', 'hazard', 'dangerous', 'careful', 'avoid', 'preserve',
    'protect', 'trust', 'rework', 'reversible', 'bounded', 'stop condition',
    'confidential', 'audit', 'governance', 'approved', 'review',
  ],
  benevolence: [
    'fair', 'equitable', 'equal', 'vulnerable', 'care', 'marginalized',
    'dignity', 'compassion', 'inclusive', 'just', 'accommodate',
    'fairness', 'equity', 'support', 'help', 'kind', 'empathy',
    'underserved', 'humane', 'peer', 'manager-safe', 'psychological',
    'safe to try', 'human-first', 'no-penalty', 'confidence',
  ],
};

const ALL_AXES: readonly JudgeAxisId[] = [
  'achievement',
  'self_direction',
  'security',
  'benevolence',
];

/**
 * Public entry point - returns L3 extraction with resolution method tag.
 *
 * Stage 3a is fully deterministic (no LLM call). Stage 3b only fires when
 * the lexicon result is ambiguous (gap < 2 OR top < 2).
 */
export async function extractRationaleAxis(
  env: Env,
  rationale: string,
  userKey?: string,
): Promise<RationaleExtraction> {
  const drives = countLexiconMatches(rationale);
  const sorted = ALL_AXES.slice().sort((a, b) => drives[b] - drives[a]);
  const top1 = drives[sorted[0]];
  const top2 = drives[sorted[1]];
  const ambiguous = top1 < 2 || (top1 - top2) < 2;

  if (!ambiguous) {
    return { topAxis: sorted[0], drives, resolution: 'lexicon' };
  }

  const effectiveKey = userKey ?? env.OPENAI_API_KEY;
  if ((env.DEMO_MODE ?? 'true') === 'true' || !effectiveKey) {
    // Demo path: tag as ambiguous, pick the lexicon-top axis (or first in
    // tie-break order) as a deterministic fallback. The audit JSON records
    // resolution='ambiguous' so the paper can report the rate.
    const fallbackAxis = top1 > 0 ? sorted[0] : 'unknown';
    return { topAxis: fallbackAxis, drives, resolution: 'ambiguous' };
  }

  try {
    const llmAxis = await withBudget(
      callRationaleClassifierMini(effectiveKey, rationale),
      FALLBACK_TIMEOUT_MS,
    );
    return { topAxis: llmAxis, drives, resolution: 'llm_fallback' };
  } catch (error) {
    console.warn('[extractor] L3 LLM fallback failed, returning ambiguous:', error instanceof Error ? error.message : error);
    const fallbackAxis = top1 > 0 ? sorted[0] : 'unknown';
    return { topAxis: fallbackAxis, drives, resolution: 'ambiguous' };
  }
}

/**
 * Stage 3a - lexicon counts.
 * Word-boundary regex per token (escaped); case-insensitive. Each token
 * counted once per match. The score is "number of distinct match events"
 * across the entire rationale.
 */
export function countLexiconMatches(rationale: string): Record<JudgeAxisId, number> {
  const drives: Record<JudgeAxisId, number> = {
    achievement: 0,
    self_direction: 0,
    security: 0,
    benevolence: 0,
  };
  if (!rationale) return drives;

  for (const axis of ALL_AXES) {
    let count = 0;
    for (const token of LEXICON[axis]) {
      // Use word-boundary on each side. Hyphenated tokens (fail-safe,
      // open-ended, high-performing) are matched literally — \b around a
      // hyphen still works because - is a non-word char.
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`\\b${escaped}\\b`, 'gi');
      const matches = rationale.match(pattern);
      if (matches) count += matches.length;
    }
    drives[axis] = count;
  }
  return drives;
}

async function callRationaleClassifierMini(key: string, rationale: string): Promise<JudgeAxisId | 'unknown'> {
  const prompt = [
    "You will be given an agent's free-text justification for a fictional AI workflow adoption intervention.",
    'Classify the *single most prominent* motivational axis the rationale invokes.',
    'Respond with strict JSON: {"primary_axis": "<id>"}.',
    'Allowed: achievement | self_direction | security | benevolence.',
    '',
    `Rationale: ${rationale.slice(0, 1800)}`,
  ].join('\n');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: FALLBACK_MODEL,
      max_completion_tokens: FALLBACK_MAX_TOKENS,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'rationale_axis_classifier',
          strict: false,
          schema: classifierSchema(),
        },
      },
      messages: [
        { role: 'system', content: 'Return only valid JSON with one of the four allowed axis ids.' },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`OpenAI auth failed for L3 fallback (${response.status})`);
    }
    throw new Error(`OpenAI L3 fallback failed with status ${response.status}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string; refusal?: string | null } }> };
  if (data.choices?.[0]?.message?.refusal) {
    throw new Error('OpenAI refused L3 fallback response');
  }
  const rawOutput = data.choices?.[0]?.message?.content ?? '{}';
  let parsed: { primary_axis?: unknown };
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    const match = rawOutput.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('L3 fallback response did not contain JSON');
    parsed = JSON.parse(match[0]);
  }
  const candidate = typeof parsed.primary_axis === 'string' ? parsed.primary_axis.trim() : '';
  return (ALL_AXES as readonly string[]).includes(candidate) ? candidate as JudgeAxisId : 'unknown';
}

function classifierSchema() {
  return {
    type: 'object',
    required: ['primary_axis'],
    properties: {
      primary_axis: { type: 'string', enum: ['achievement', 'self_direction', 'security', 'benevolence'] },
    },
  };
}

async function withBudget<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Run budget exceeded')), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
