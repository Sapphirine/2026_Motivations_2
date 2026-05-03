/**
 * Three-Layer Analysis Runner (per 02-design.md §5.2 + §6.2).
 *
 * For each agent_outputs row in a run:
 *   1. L1 Declared (deterministic): top-2 axes from profile snapshot.
 *   2. L2 Revealed (gpt-5.4-mini): judge classifies the SELECTED OPTION.
 *   3. L3 Justified (lexicon + gpt-5.4-mini fallback): rationale axis.
 *   4. classifyAlignment(L1, L2, L3) -> 4-pattern label.
 *
 * Idempotent: returns persisted columns without new LLM calls when
 * `judge_axis` is already populated. `force: true` bypasses the cache.
 */

import { classifyAlignment, deriveL1Top2 } from '../analysis/alignment-pattern';
import { extractRationaleAxis } from '../extractors/rationale-values';
import { judgeOption, type JudgeAxisId } from '../judges/value-judge';
import type {
  AgentOutput,
  AxisId,
  AxisWeight,
  Env,
  ThreeLayerAnalysisResult,
  ThreeLayerPerAgent,
  ValueProfile,
} from '../domain/types';
import {
  getRunAuthoritative,
  loadAgentOutputsWithThreeLayer,
  nowSeconds,
  updateAgentOutputThreeLayer,
} from '../services/storage';

const BATCH_SIZE = 4;

const AXIS_LEGACY_TO_JUDGE: Record<AxisId, JudgeAxisId> = {
  achievement: 'achievement',
  selfDirection: 'self_direction',
  security: 'security',
  benevolence: 'benevolence',
};

export async function runThreeLayerAnalysis(
  env: Env,
  runId: string,
  options: { force: boolean },
  userKey?: string,
): Promise<ThreeLayerAnalysisResult | null> {
  const run = await getRunAuthoritative(env, runId, { hydrateOutputs: false });
  if (!run) return null;

  const outputs = await loadAgentOutputsWithThreeLayer(env, runId);
  if (outputs.length === 0) {
    return { runId, perAgent: [] };
  }

  // Idempotency: if all rows already have alignment_pattern populated
  // and force is false, return the cached state.
  const allCached = outputs.every((o) => o.alignmentPattern && o.judgeAxis);
  if (allCached && !options.force) {
    return {
      runId,
      perAgent: outputs.map(toPerAgent),
    };
  }

  // Process in batches of 4 to stay under the OpenAI burst limit.
  const updated: AgentOutput[] = [];
  for (let i = 0; i < outputs.length; i += BATCH_SIZE) {
    const batch = outputs.slice(i, i + BATCH_SIZE);
    const settled = await Promise.allSettled(batch.map((output) => processOneOutput(env, run.scenarioSnapshot, output, options.force, userKey)));
    for (let j = 0; j < settled.length; j += 1) {
      const outcome = settled[j];
      if (outcome.status === 'fulfilled') {
        updated.push(outcome.value);
      } else {
        // On failure, keep the existing row but fill PARSE_FALLBACK markers
        // so the audit can count the rate.
        const fallback = buildParseFallback(batch[j]);
        updated.push(fallback);
        console.warn('[three-layer] cell failed:', outcome.reason instanceof Error ? outcome.reason.message : outcome.reason);
      }
    }
  }

  // Persist updates.
  await Promise.allSettled(updated.map((o) => updateAgentOutputThreeLayer(env, o)));

  return {
    runId,
    perAgent: updated.map(toPerAgent),
  };
}

async function processOneOutput(
  env: Env,
  scenarioSnapshot: AgentOutput['profileSnapshot'] extends infer _ ? import('../domain/types').Scenario : never,
  output: AgentOutput,
  force: boolean,
  userKey?: string,
): Promise<AgentOutput> {
  if (!force && output.judgeAxis && output.alignmentPattern) {
    return output;
  }
  const judge = await judgeOption(env, scenarioSnapshot, output.structuredDecision.selectedOptionId, userKey);
  const rationale = output.structuredDecision.rationale ?? '';
  const extraction = await extractRationaleAxis(env, rationale, userKey);

  const L1Top2 = computeL1Top2(output.profileSnapshot);
  const L2 = judge.primaryAxis === 'unknown' ? L1Top2[0] : judge.primaryAxis;
  const L3 = extraction.topAxis === 'unknown' ? L1Top2[0] : extraction.topAxis;
  const alignment = classifyAlignment(L1Top2, L2, L3);

  return {
    ...output,
    judgeAxis: judge.primaryAxis,
    judgeConfidence: judge.confidence,
    judgeReasoning: judge.reasoning,
    rationaleDrives: extraction.drives,
    rationaleTopAxis: extraction.topAxis,
    rationaleResolution: extraction.resolution,
    alignmentPattern: alignment,
    threeLayerCompletedAt: nowSeconds(),
  };
}

function buildParseFallback(output: AgentOutput): AgentOutput {
  const L1Top2 = computeL1Top2(output.profileSnapshot);
  return {
    ...output,
    judgeAxis: 'unknown',
    judgeConfidence: 0,
    judgeReasoning: 'PARSE_FALLBACK',
    rationaleDrives: { achievement: 0, self_direction: 0, security: 0, benevolence: 0 },
    rationaleTopAxis: 'unknown',
    rationaleResolution: 'ambiguous',
    alignmentPattern: classifyAlignment(L1Top2, L1Top2[0], L1Top2[0]),
    threeLayerCompletedAt: nowSeconds(),
  };
}

function computeL1Top2(profile: ValueProfile): readonly [JudgeAxisId, JudgeAxisId] {
  const weights: Record<JudgeAxisId, number> = {
    achievement: 0,
    self_direction: 0,
    security: 0,
    benevolence: 0,
  };
  for (const w of profile.axisWeights as AxisWeight[]) {
    const judgeAxis = AXIS_LEGACY_TO_JUDGE[w.axis];
    if (judgeAxis) weights[judgeAxis] = w.value;
  }
  return deriveL1Top2(weights);
}

function toPerAgent(output: AgentOutput): ThreeLayerPerAgent {
  const L1Top2 = computeL1Top2(output.profileSnapshot);
  const L2axis = output.judgeAxis === 'unknown' || !output.judgeAxis ? L1Top2[0] : output.judgeAxis;
  const L3axis = output.rationaleTopAxis === 'unknown' || !output.rationaleTopAxis ? L1Top2[0] : output.rationaleTopAxis;
  return {
    agentOutputId: output.id,
    profileId: output.profileId,
    trialIndex: output.trialIndex ?? 0,
    L1: { top2: [L1Top2[0], L1Top2[1]] },
    L2: {
      primaryAxis: output.judgeAxis ?? 'unknown',
      confidence: output.judgeConfidence ?? 0,
      reasoning: output.judgeReasoning ?? '',
    },
    L3: {
      topAxis: output.rationaleTopAxis ?? 'unknown',
      drives: output.rationaleDrives ?? { achievement: 0, self_direction: 0, security: 0, benevolence: 0 },
      resolution: output.rationaleResolution ?? 'ambiguous',
    },
    alignment: output.alignmentPattern ?? classifyAlignment(L1Top2, L2axis as JudgeAxisId, L3axis as JudgeAxisId),
  };
}
