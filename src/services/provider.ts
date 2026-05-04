import type { AgentOutput, Env, GenerationSettings, ModeratorAICommentary, ModeratorSynthesis, Scenario, StructuredDecision, ValueProfile } from '../domain/types';
import { extractRationaleAxis, type RationaleExtraction } from '../extractors/rationale-values';
import { judgeOption, type JudgeResult } from '../judges/value-judge';
import { getConfig } from './config';
import { translateProfilePrompt } from './prompts';

/**
 * Re-exports honoring the Lane A contract: Three-Layer judge + classifier
 * are accessible via provider.ts as `runJudgeMini` and
 * `runRationaleClassifierMini`. The actual envelope-bound implementations
 * live in src/judges/value-judge.ts and src/extractors/rationale-values.ts
 * to keep the L2/L3 prompt templates next to their schemas.
 *
 * Both wrappers preserve the OpenAI envelope rules (max_completion_tokens,
 * no temperature, json_schema response_format) — see the underlying files.
 */
export async function runJudgeMini(
  env: Env,
  scenario: Scenario,
  selectedOptionId: string,
  userKey?: string,
): Promise<JudgeResult> {
  return judgeOption(env, scenario, selectedOptionId, userKey);
}

export async function runRationaleClassifierMini(
  env: Env,
  rationale: string,
  userKey?: string,
): Promise<RationaleExtraction> {
  return extractRationaleAxis(env, rationale, userKey);
}

export type ProviderResult = {
  prompt: string;
  rawOutput: string;
  structuredDecision: StructuredDecision;
  providerMetadata: Record<string, unknown>;
};

export type QuestionResult = {
  answer: string;
  scenarioId: string;
  profileId: string;
  evidence: string[];
  mode: 'demo' | 'openai';
  disclaimer: string;
  // GAP 2 fix (2026-04-27): when the live OpenAI call fails (auth, parse,
  // timeout) we silently fall back to the deterministic templated answer
  // and surface a sanitized error string here. The header X-OpenAI-Key
  // value is NEVER echoed in this field.
  error?: string;
};

/**
 * Sanitize and validate a user-supplied OpenAI key from the X-OpenAI-Key
 * header. The header value is NEVER persisted (no D1, no R2, no KV) and
 * NEVER logged. We only inspect shape:
 *   - must start with `sk-`
 *   - length 20..200 chars
 * If validation fails, we return undefined (silent fallback to env.OPENAI_API_KEY)
 * rather than 400 — the contract explicitly chooses silent ignore so
 * malformed headers don't break a demo. A live OpenAI 401/403 response is
 * surfaced as a sanitized RFC 9457 problem upstream (see callers).
 */
export function sanitizeUserKey(rawHeader: string | undefined | null): string | undefined {
  if (!rawHeader) return undefined;
  const trimmed = rawHeader.trim();
  if (!trimmed.startsWith('sk-')) return undefined;
  if (trimmed.length < 20 || trimmed.length > 200) return undefined;
  return trimmed;
}

/**
 * Select the OpenAI API key to use, in priority order:
 *   1. userKey (from `X-OpenAI-Key` header, after sanitizeUserKey).
 *   2. env.OPENAI_API_KEY (Wrangler secret).
 *   3. undefined -> caller falls back to demo/mock path.
 *
 * The key value is never logged or returned to the client.
 */
function selectOpenAIKey(env: Env, userKey: string | undefined): string | undefined {
  if (userKey) return userKey;
  return env.OPENAI_API_KEY;
}

export async function answerScenarioQuestion(env: Env, scenario: Scenario, profile: ValueProfile, question: string, userKey?: string): Promise<QuestionResult> {
  const topDrive = [...profile.axisWeights].sort((a, b) => b.value - a.value)[0];
  const optionPreview = scenario.decisionOptions.slice(0, 3).map((option) => `${option.id}: ${option.label}`).join('; ');
  const focus = inferQuestionFocus(question);
  const deterministicAnswer = [
    `Question focus: ${focus}.`,
    `In this fictional ${scenario.domain} case, the ${profile.name} lens tests that focus against ${topDrive.label.toLowerCase()} (${topDrive.value}).`,
    `Relevant intervention options are ${optionPreview}.`,
    focus === 'risk containment'
      ? 'The useful comparison is whether security-weighted profiles narrow the first action, add safeguards, or reduce rework risk compared with achievement-weighted profiles.'
      : focus === 'learning strategy'
        ? 'The useful comparison is whether exploration-weighted profiles choose autonomy-preserving trials or workflow-discovery options more often than other profiles.'
        : focus === 'success criteria'
          ? 'The useful comparison is whether achievement-weighted profiles prioritize visible AI usage, time saved, or license ROI over caution.'
          : 'The useful comparison is whether the question changes selected interventions, rankings, or only rationale wording across profiles.',
    'This response is a deterministic demo artifact, not HR, employment, or adoption advice.',
  ].join(' ');

  const baseEvidence = [scenario.context, scenario.conflictNotes, `Question: ${question}`];
  const effectiveKey = selectOpenAIKey(env, userKey);
  const isDemo = (env.DEMO_MODE ?? 'true') === 'true' || !effectiveKey;

  // GAP 2 fix (2026-04-27): when a live key is available and DEMO_MODE
  // is off, actually call OpenAI for the scenario Q&A. Previously this
  // function returned `mode: 'openai'` while computing the deterministic
  // templated answer — the label was dishonest. We now route to the
  // model and only fall back to the deterministic answer on error.
  //
  // gpt-5.4-nano API constraints (verified 2026-04-27):
  //   - use `max_completion_tokens` (NOT `max_tokens`)
  //   - DO NOT pass `temperature` (model pins to 1.0; non-default returns 400)
  //   - response_format json_schema with strict:false works
  //
  // Failure handling: any non-OK status, parse failure, refusal, or
  // budget timeout falls back to the deterministic answer with
  // `mode: 'demo'` and a sanitized `error` field. The user-supplied
  // key value is NEVER logged, persisted, or echoed.
  if (!isDemo && effectiveKey) {
    try {
      const config = getConfig(env);
      const settings = config.generationSettings;
      const live = await withBudget(
        callOpenAIForQuestion(effectiveKey, config.openAIModel, settings, scenario, profile, question, deterministicAnswer),
        config.runTimeoutSeconds * 1000,
      );
      return {
        answer: live.answer,
        scenarioId: scenario.id,
        profileId: profile.id,
        evidence: live.evidence.length ? live.evidence : baseEvidence,
        mode: 'openai',
        disclaimer: scenario.disclaimer,
      };
    } catch (error) {
      const sanitized = sanitizeProviderError(error, Boolean(userKey));
      console.warn('[provider] answerScenarioQuestion live call failed, falling back to deterministic:', sanitized);
      return {
        answer: deterministicAnswer,
        scenarioId: scenario.id,
        profileId: profile.id,
        evidence: baseEvidence,
        mode: 'demo',
        disclaimer: scenario.disclaimer,
        error: sanitized,
      };
    }
  }

  return {
    answer: deterministicAnswer,
    scenarioId: scenario.id,
    profileId: profile.id,
    evidence: baseEvidence,
    mode: 'demo',
    disclaimer: scenario.disclaimer,
  };
}

/**
 * GAP 2 helper (2026-04-27): live OpenAI call for the scenario Q&A
 * endpoint. Returns a structured `{ answer, evidence }` shape. On any
 * non-OK status the caller falls back to deterministic. Notes:
 *  - Uses `max_completion_tokens` (gpt-5.4-nano rejects `max_tokens`).
 *  - Omits `temperature` (gpt-5 family pins to 1.0; sending non-default
 *    returns 400 invalid_request_error).
 *  - response_format json_schema with strict:false (matches the same
 *    pattern used by runProfileProvider + runModeratorCommentary).
 */
async function callOpenAIForQuestion(
  key: string,
  model: string,
  settings: GenerationSettings,
  scenario: Scenario,
  profile: ValueProfile,
  question: string,
  deterministicHint: string,
): Promise<{ answer: string; evidence: string[] }> {
  const profileSnapshot = profile.axisWeights
    .map((weight) => `${weight.label}=${weight.level}(${weight.value})`)
    .join(', ');
  const optionsBlock = scenario.decisionOptions
    .map((option) => `- ${option.id}: ${option.label}`)
    .join('\n');
  const prompt = [
    'You are an experimental research moderator answering a question ABOUT a fictional AI workflow adoption case.',
    'You are NOT giving HR, employment, or real-world advice. You are characterizing how the supplied motivation profile would compare intervention options.',
    '',
    `Adoption case title: ${scenario.title}`,
    `Domain: ${scenario.domain}`,
    `Context: ${scenario.context}`,
    `Conflict notes: ${scenario.conflictNotes}`,
    'Intervention options:',
    optionsBlock,
    '',
    `Profile: ${profile.name} (${profile.id})`,
    `Profile axis weights: ${profileSnapshot}`,
    `Profile description: ${profile.description}`,
    '',
    `User question: ${question}`,
    '',
    'Return strict JSON: { answer: string (<= 600 chars, value-axis-grounded, fictional-experiment framing), evidence: string[] (1-3 short citations from the adoption case context or options) }.',
    `For reference, a deterministic baseline answer is: "${deterministicHint}". You may improve on it but stay value-axis-grounded.`,
  ].join('\n');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_completion_tokens: Math.min(settings.maxTokens, 600),
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'scenario_question_answer',
          strict: false,
          schema: questionAnswerSchema(),
        },
      },
      messages: [
        { role: 'system', content: 'Return only valid JSON for an experimental research artifact. This is interpretive commentary, not real-world advice.' },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const diagnostic = await readOpenAIErrorDiagnostic(response);
    if (response.status === 401 || response.status === 403) {
      throw new Error(`OpenAI auth failed (${response.status})${diagnostic}`);
    }
    throw new Error(`OpenAI question request failed with status ${response.status}${diagnostic}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string; refusal?: string | null } }> };
  if (data.choices?.[0]?.message?.refusal) {
    throw new Error('OpenAI refused question response');
  }
  const rawOutput = data.choices?.[0]?.message?.content ?? '{}';
  let parsed: { answer?: unknown; evidence?: unknown };
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    const match = rawOutput.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('OpenAI question response did not contain JSON');
    parsed = JSON.parse(match[0]);
  }
  const answer = typeof parsed.answer === 'string' && parsed.answer.length > 0
    ? parsed.answer.slice(0, 1200)
    : '';
  if (!answer) throw new Error('OpenAI question response missing answer field');
  const evidence = Array.isArray(parsed.evidence)
    ? parsed.evidence.filter((entry): entry is string => typeof entry === 'string').slice(0, 3).map((entry) => entry.slice(0, 280))
    : [];
  return { answer, evidence };
}

function questionAnswerSchema() {
  return {
    type: 'object',
    properties: {
      answer: { type: 'string' },
      evidence: { type: 'array', items: { type: 'string' } },
    },
  };
}

async function readOpenAIErrorDiagnostic(response: Response): Promise<string> {
  try {
    const payload = await response.json() as {
      error?: {
        type?: unknown;
        code?: unknown;
        param?: unknown;
      };
    };
    const error = payload?.error;
    const parts: string[] = [];
    if (typeof error?.type === 'string' && error.type.trim()) {
      parts.push(`type=${error.type.trim()}`);
    }
    if (typeof error?.code === 'string' && error.code.trim()) {
      parts.push(`code=${error.code.trim()}`);
    }
    if (typeof error?.param === 'string' && error.param.trim()) {
      parts.push(`param=${error.param.trim()}`);
    }
    return parts.length ? ` (${parts.join(', ')})` : '';
  } catch {
    return '';
  }
}

/**
 * Surface a stable, key-safe error string for logging + the QuestionResult
 * `error` field. NEVER include the API key or raw OpenAI body details.
 */
function sanitizeProviderError(error: unknown, hadUserKey: boolean): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Run budget exceeded|budget exceeded|abort/i.test(message)) {
    return 'Live LLM call exceeded the run budget; deterministic answer returned.';
  }
  if (/auth failed/i.test(message)) {
    return hadUserKey
      ? 'X-OpenAI-Key was rejected by OpenAI; deterministic answer returned.'
      : 'Server-configured OpenAI key was rejected; deterministic answer returned.';
  }
  if (/refused/i.test(message)) {
    return 'OpenAI refused the structured response; deterministic answer returned.';
  }
  const statusMatch = message.match(/status\s+(\d{3})/i);
  if (statusMatch) {
    const diagnostic = summarizeOpenAIDiagnosticFromMessage(message);
    return `Live LLM call failed with OpenAI status ${statusMatch[1]}${diagnostic}; deterministic answer returned.`;
  }
  if (/missing answer field|did not contain JSON/i.test(message)) {
    return 'OpenAI response was malformed; deterministic answer returned.';
  }
  // Generic fallback — avoid leaking arbitrary error text from underlying SDK.
  return 'Live LLM call failed; deterministic answer returned.';
}

function summarizeOpenAIDiagnosticFromMessage(message: string): string {
  const parts: string[] = [];
  const typeMatch = message.match(/\btype=([A-Za-z0-9_.-]+)/);
  const codeMatch = message.match(/\bcode=([A-Za-z0-9_.-]+)/);
  const paramMatch = message.match(/\bparam=([A-Za-z0-9_.-]+)/);
  if (typeMatch) parts.push(`type=${typeMatch[1]}`);
  if (codeMatch) parts.push(`code=${codeMatch[1]}`);
  if (paramMatch) parts.push(`param=${paramMatch[1]}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/**
 * Local 25-second budget wrapper, mirrors the helper in experiment.ts so
 * provider.ts has no cross-file dependency cycle. Same semantics: a
 * timer races the underlying promise; the timer is always cleared on
 * settle to avoid runtime leaks in the Worker.
 */
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

export async function runProfileProvider(env: Env, model: string, settings: GenerationSettings, scenario: Scenario, profile: ValueProfile, userKey?: string): Promise<ProviderResult> {
  const prompt = translateProfilePrompt(profile, scenario);
  // FIX 2: key priority is userKey -> env.OPENAI_API_KEY -> demo fallback.
  // The DEMO_MODE env var still overrides everything (preserves the
  // existing demo-only deploy story).
  const effectiveKey = selectOpenAIKey(env, userKey);
  if ((env.DEMO_MODE ?? 'true') === 'true' || !effectiveKey) {
    return mockProviderResult(model, settings, scenario, profile, prompt);
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${effectiveKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_completion_tokens: settings.maxTokens,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'motiveops_intervention',
          strict: false,
          schema: decisionSchema(),
        },
      },
      messages: [
        { role: 'system', content: 'Return only valid JSON for a fictional experimental AI workflow adoption task. Do not provide HR, employment, or real-world advice.' },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const diagnostic = await readOpenAIErrorDiagnostic(response);
    if (response.status === 401 || response.status === 403) {
      const hint = userKey
        ? 'Provided key was rejected by OpenAI'
        : 'Server-configured OpenAI key was rejected';
      throw new Error(`OpenAI auth failed (${response.status}): ${hint}${diagnostic}`);
    }
    throw new Error(`OpenAI request failed with status ${response.status}${diagnostic}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string; refusal?: string | null } }>; usage?: unknown; id?: string; model?: string };
  const refusal = data.choices?.[0]?.message?.refusal;
  if (refusal) {
    throw new Error(`OpenAI refused structured response: ${refusal}`);
  }
  const rawOutput = data.choices?.[0]?.message?.content ?? '{}';
  const parsed = parseStructuredDecision(rawOutput);

  return {
    prompt,
    rawOutput,
    structuredDecision: normalizeDecision(parsed, scenario, profile),
    providerMetadata: { id: data.id, model: data.model, usage: data.usage },
  };
}

function inferQuestionFocus(question: string): string {
  const normalized = question.toLowerCase();
  if (normalized.includes('bounded') || normalized.includes('low-risk')) return 'risk containment';
  if (normalized.includes('risk') || normalized.includes('safe') || normalized.includes('trust') || normalized.includes('audit') || normalized.includes('rework')) return 'risk containment';
  if (normalized.includes('learn') || normalized.includes('trial') || normalized.includes('explore') || normalized.includes('use case')) return 'learning strategy';
  if (normalized.includes('success') || normalized.includes('achievement') || normalized.includes('progress') || normalized.includes('roi') || normalized.includes('productivity')) return 'success criteria';
  return 'general comparison';
}

function mockProviderResult(model: string, settings: GenerationSettings, scenario: Scenario, profile: ValueProfile, prompt: string): ProviderResult {
  const selected = selectMockOption(scenario, profile);
  const rankedOptions = [selected.id, ...scenario.decisionOptions.map((option) => option.id).filter((id) => id !== selected.id)];
  const topDrive = [...profile.axisWeights].sort((a, b) => b.value - a.value)[0];
  const decision: StructuredDecision = {
    selectedOptionId: selected.id,
    rankedOptions,
    decisionSummary: `${profile.name} recommends ${selected.label}.`,
    interventionCard: {
      diagnosedBlocker: scenario.tradeoffs.slice(0, 2).join(' and '),
      motivationProfile: profile.name,
      retrievedStrategy: selected.label,
      microAction: selected.description,
      ifThenPlan: 'If the first trial creates extra rework, stop and switch to a lower-risk support task.',
      accountabilityScript: 'I am testing AI on a bounded support task and tracking where it helps versus creates rework.',
      successMetric: 'One completed low-risk trial with a clear keep/change/stop decision.',
    },
    rationale: `${profile.name} emphasizes ${topDrive.label.toLowerCase()} while comparing ${scenario.tradeoffs.slice(0, 2).join(' and ')} for AI workflow adoption.`,
    tradeoffs: scenario.tradeoffs.slice(0, 3).map((dimension) => ({ dimension, assessment: `${profile.name} weighs ${dimension} through the ${topDrive.label.toLowerCase()} adoption lens.` })),
    driveAttributions: profile.axisWeights.map((weight) => ({
      drive: weight.axis,
      weight: weight.value,
      influence: weight.level,
      evidence: `${weight.label} was ${weight.level} in the profile matrix.`,
    })),
    confidence: null,
    riskNotes: ['Fictional experimental output only.', 'Confidence not measured in demo mode.', 'Not HR, employment, or real-world adoption advice.'],
    notAdviceDisclaimer: true,
  };

  return {
    prompt,
    rawOutput: JSON.stringify(decision, null, 2),
    structuredDecision: decision,
    providerMetadata: { mode: 'demo', model, settings },
  };
}

function selectMockOption(scenario: Scenario, profile: ValueProfile) {
  if (profile.id === 'preservation') return scenario.decisionOptions[1] ?? scenario.decisionOptions[0];
  if (profile.id === 'exploration') return scenario.decisionOptions[3] ?? scenario.decisionOptions[1] ?? scenario.decisionOptions[0];
  if (profile.id === 'achievement') return scenario.decisionOptions[0];
  return scenario.decisionOptions[2] ?? scenario.decisionOptions[1] ?? scenario.decisionOptions[0];
}

function parseStructuredDecision(rawOutput: string): StructuredDecision {
  const jsonText = extractJsonObject(rawOutput);
  const candidates = [rawOutput, jsonText, repairMissingCommas(jsonText)];
  try {
    return JSON.parse(candidates[0]) as StructuredDecision;
  } catch (firstError) {
    for (const candidate of candidates.slice(1)) {
      try {
        return JSON.parse(candidate) as StructuredDecision;
      } catch {
        // Try the next candidate.
      }
    }
    throw firstError;
  }
}

function extractJsonObject(rawOutput: string): string {
  const trimmed = rawOutput.replace(/```json|```/gi, '').trim();
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('OpenAI response did not contain JSON.');
  return match[0];
}

function repairMissingCommas(jsonText: string): string {
  return jsonText
    .replace(/}\s*(?={)/g, '},')
    .replace(/([}\]"0-9]|true|false|null)([ \t\r]*\n[ \t]*)(?=("|[{]))/g, '$1,$2');
}

function normalizeDecision(decision: StructuredDecision, scenario: Scenario, profile: ValueProfile): StructuredDecision {
  const selectedOptionId = scenario.decisionOptions.some((option) => option.id === decision.selectedOptionId)
    ? decision.selectedOptionId
    : scenario.decisionOptions[0].id;
  return {
    ...decision,
    selectedOptionId,
    rankedOptions: decision.rankedOptions?.length ? decision.rankedOptions : scenario.decisionOptions.map((option) => option.id),
    tradeoffs: decision.tradeoffs?.length ? decision.tradeoffs : scenario.tradeoffs.map((dimension) => ({ dimension, assessment: 'Not supplied by provider.' })),
    driveAttributions: decision.driveAttributions?.length ? decision.driveAttributions : profile.axisWeights.map((weight) => ({
      drive: weight.axis,
      weight: weight.value,
      influence: weight.level,
      evidence: `${weight.label} profile weight`,
    })),
    riskNotes: decision.riskNotes?.length ? decision.riskNotes : ['Fictional experimental output only.', 'Not HR, employment, or real-world adoption advice.'],
    confidence: typeof decision.confidence === 'number' ? decision.confidence : null,
    notAdviceDisclaimer: true,
  };
}

/**
 * FIX 3 (2026-04-27): Layer-2 qualitative LLM commentary on top of the
 * deterministic moderator synthesis. The deterministic metrics remain the
 * audit-quality numbers; this is clearly secondary and labeled.
 *
 * Contract:
 *  - Builds a prompt with the four agent intervention choices, deterministic
 *    metrics, and adoption case summary.
 *  - Calls the same OpenAI model the run used (gpt-5.4-nano default) with
 *    a json_schema response_format pinned to ModeratorAICommentary shape.
 *  - Fail-safe: if no key (user OR env) AND DEMO_MODE, returns a deterministic
 *    mock derived from the existing agreement/disagreement strings.
 *  - On any LLM failure (auth, timeout, parse), the caller is expected to
 *    set `synthesis.aiCommentary = null` and continue — never fail the run.
 *  - The user-supplied key (if provided) follows the same priority as
 *    runProfileProvider: userKey -> env.OPENAI_API_KEY -> demo mock.
 */
export async function runModeratorCommentary(
  env: Env,
  model: string,
  settings: GenerationSettings,
  scenario: Scenario,
  profiles: ValueProfile[],
  agentOutputs: AgentOutput[],
  deterministicSynthesis: ModeratorSynthesis,
  userKey?: string,
): Promise<ModeratorAICommentary> {
  const effectiveKey = selectOpenAIKey(env, userKey);
  if ((env.DEMO_MODE ?? 'true') === 'true' || !effectiveKey || agentOutputs.length === 0) {
    return mockModeratorCommentary(profiles, agentOutputs, deterministicSynthesis);
  }

  const decisionsBlock = agentOutputs.map((output) => {
    const profile = profiles.find((p) => p.id === output.profileId);
    return [
      `Profile: ${profile?.name ?? output.profileId} (${output.profileId})`,
      `Selected: ${output.structuredDecision.selectedOptionId}`,
      `Rationale: ${output.structuredDecision.rationale}`,
      `Top drives: ${output.driveTrace.slice(0, 2).map((d) => `${d.drive}=${d.influence}`).join(', ')}`,
    ].join('\n');
  }).join('\n\n');

  const prompt = [
    'You are an experimental moderator commenting on four motivated AI agents who answered the same fictional AI workflow adoption case.',
    `Adoption case: ${scenario.title}`,
    `Context: ${scenario.context}`,
    `Intervention options: ${scenario.decisionOptions.map((o) => `${o.id}: ${o.label}`).join('; ')}`,
    '',
    'Agent interventions:',
    decisionsBlock,
    '',
    'Deterministic synthesis (audit-quality, do not contradict):',
    `- substantiveDivergence: ${deterministicSynthesis.substantiveDivergence}`,
    `- agreementSummary: ${deterministicSynthesis.agreementSummary}`,
    `- disagreementSummary: ${deterministicSynthesis.disagreementSummary}`,
    '',
    'Return strict JSON: { headline, disagreementDriver, supportingEvidence:[{profileId,evidence}], openQuestions:[<=3 strings] }.',
    'Keep it interpretive, value-axis-grounded, and short. Do not give HR, employment, or real-world advice.',
  ].join('\n');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${effectiveKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_completion_tokens: Math.min(settings.maxTokens, 800),
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'moderator_ai_commentary',
          strict: false,
          schema: aiCommentarySchema(),
        },
      },
      messages: [
        { role: 'system', content: 'Return only valid JSON for an experimental research artifact. This is interpretive commentary, not real-world advice.' },
        { role: 'user', content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const diagnostic = await readOpenAIErrorDiagnostic(response);
    if (response.status === 401 || response.status === 403) {
      const hint = userKey
        ? 'Provided key was rejected by OpenAI'
        : 'Server-configured OpenAI key was rejected';
      throw new Error(`OpenAI auth failed for moderator commentary (${response.status}): ${hint}${diagnostic}`);
    }
    throw new Error(`OpenAI moderator commentary failed with status ${response.status}${diagnostic}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string; refusal?: string | null } }> };
  if (data.choices?.[0]?.message?.refusal) {
    throw new Error(`OpenAI refused moderator commentary: ${data.choices[0].message.refusal}`);
  }
  const rawOutput = data.choices?.[0]?.message?.content ?? '{}';
  const parsed = parseAICommentary(rawOutput);
  return normalizeAICommentary(parsed, profiles, 'openai');
}

function mockModeratorCommentary(profiles: ValueProfile[], agentOutputs: AgentOutput[], synthesis: ModeratorSynthesis): ModeratorAICommentary {
  // Deterministic fallback grounded in the deterministic synthesis. No LLM
  // call. Used in DEMO_MODE or when no key is available.
  const driver = synthesis.substantiveDivergence
    ? 'Achievement and Preservation diverge on the first adoption move: measurable AI usage is weighed against trust, reversibility, and rework risk.'
    : 'Profiles agree on the intervention option; divergence appears only in rationale wording, not in the chosen action.';
  const supporting = agentOutputs.slice(0, 4).map((output) => ({
    profileId: output.profileId,
    evidence: `${output.profileSnapshot.name} chose ${output.structuredDecision.selectedOptionId}: ${output.structuredDecision.rationale.slice(0, 180)}`,
  }));
  const headline = synthesis.substantiveDivergence
    ? 'Profiles selected different adoption interventions on the same case facts.'
    : 'Profiles converged on one intervention; disagreement is interpretive only.';
  return {
    mode: 'demo',
    headline,
    disagreementDriver: driver,
    supportingEvidence: supporting,
    openQuestions: [
      'Would weakening the security axis push the intervention toward a productivity challenge?',
      'Are the agents treating rework risk and manager-evaluation risk as separate blockers?',
      'Does the neutral baseline track any single motivation-weighted profile?',
    ].slice(0, profiles.length === 0 ? 0 : 3),
  };
}

function parseAICommentary(rawOutput: string): unknown {
  try {
    return JSON.parse(rawOutput);
  } catch {
    const match = rawOutput.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('OpenAI moderator commentary did not contain JSON.');
    return JSON.parse(match[0]);
  }
}

function normalizeAICommentary(value: unknown, profiles: ValueProfile[], mode: 'openai' | 'demo'): ModeratorAICommentary {
  const v = (value ?? {}) as Partial<ModeratorAICommentary>;
  const knownIds = new Set<string>(profiles.map((p) => p.id));
  const supportingEvidence = Array.isArray(v.supportingEvidence)
    ? v.supportingEvidence
        .filter((entry): entry is { profileId: string; evidence: string } =>
          Boolean(entry) && typeof entry.profileId === 'string' && typeof entry.evidence === 'string')
        .map((entry) => ({
          profileId: knownIds.has(entry.profileId) ? entry.profileId : entry.profileId.slice(0, 64),
          evidence: entry.evidence.slice(0, 600),
        }))
    : [];
  const openQuestions = Array.isArray(v.openQuestions)
    ? v.openQuestions.filter((q): q is string => typeof q === 'string').slice(0, 3).map((q) => q.slice(0, 280))
    : [];
  return {
    mode,
    headline: typeof v.headline === 'string' && v.headline.length ? v.headline.slice(0, 280) : 'No headline supplied.',
    disagreementDriver: typeof v.disagreementDriver === 'string' && v.disagreementDriver.length ? v.disagreementDriver.slice(0, 600) : 'No disagreement driver supplied.',
    supportingEvidence,
    openQuestions,
  };
}

function aiCommentarySchema() {
  return {
    type: 'object',
    properties: {
      headline: { type: 'string' },
      disagreementDriver: { type: 'string' },
      supportingEvidence: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            profileId: { type: 'string' },
            evidence: { type: 'string' },
          },
        },
      },
      openQuestions: {
        type: 'array',
        items: { type: 'string' },
      },
    },
  };
}

function decisionSchema() {
  return {
    type: 'object',
    properties: {
      selectedOptionId: { type: 'string' },
      rankedOptions: { type: 'array', items: { type: 'string' } },
      decisionSummary: { type: 'string' },
      interventionCard: {
        type: 'object',
        properties: {
          diagnosedBlocker: { type: 'string' },
          motivationProfile: { type: 'string' },
          retrievedStrategy: { type: 'string' },
          microAction: { type: 'string' },
          ifThenPlan: { type: 'string' },
          accountabilityScript: { type: 'string' },
          successMetric: { type: 'string' },
        },
      },
      rationale: { type: 'string' },
      tradeoffs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            dimension: { type: 'string' },
            assessment: { type: 'string' },
          },
        },
      },
      driveAttributions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            drive: { type: 'string' },
            weight: { type: 'number' },
            influence: { type: 'string' },
            evidence: { type: 'string' },
          },
        },
      },
      confidence: { type: ['number', 'null'] },
      riskNotes: { type: 'array', items: { type: 'string' } },
      notAdviceDisclaimer: { type: 'boolean' },
    },
  };
}
