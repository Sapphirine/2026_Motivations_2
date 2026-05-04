import type { AgentOutput, AxisId, AxisWeight, Env, ExperimentRun, GenerationSettings, ProfileId, SensitivityRun, StructuredDecision, ValueProfile } from '../domain/types';
import { writeRunArtifacts } from './artifacts';
import { assertLiveOpenAIConfig, getConfig } from './config';
import { computeMetrics, synthesizeRun } from './metrics';
import { attachPolicyCompliance, retrievePolicyGrounding } from './policy-rag';
import { problem, problemError } from './problem';
import { runModeratorCommentary, runProfileProvider } from './provider';
import { findRunByIdempotencyKeyInD1, getProfiles, getRunAuthoritative, getRunByIdempotencyKey, getScenario, id, nowSeconds, reserveRunForIdempotency, saveOutputs, saveRun, saveSensitivityRun } from './storage';

/**
 * Three-Layer redesign (2026-04-27):
 *  - `trialCount` (default 5, range 1-10) loops the provider call inside
 *    each (run, profile) cell. Each trial is one row in agent_outputs with
 *    a sequential `trial_index` (0..trialCount-1).
 *  - `batteryId` (optional) groups runs that belong to one
 *    canonical-battery invocation.
 *  - All trials within a cell share the SAME scenario snapshot, profile
 *    snapshot, model, and generation settings (per 01-spec §6.1). Only
 *    the random seed changes (we don't pin a seed; we rely on provider
 *    nondeterminism so the modal-stability statistic is meaningful).
 */
export async function runExperiment(
  env: Env,
  input: {
    scenarioId: string;
    profileIds: ProfileId[];
    modelName?: string;
    generationSettings?: GenerationSettings;
    trialCount?: number;
    idempotencyKey?: string;
    batteryId?: string;
  },
  instance: string,
  userKey?: string,
): Promise<ExperimentRun> {
  // Fast path: in-memory cache hit for an already-known idempotency key.
  // The authoritative D1 check still happens below via reserveRunForIdempotency
  // (or findRunByIdempotencyKeyInD1) so this is a hot-cache shortcut, not a
  // duplicate-prevention source of truth.
  if (input.idempotencyKey) {
    const cached = getRunByIdempotencyKey(input.idempotencyKey);
    if (cached && cached.status !== 'running') return cached;
    const persisted = await findRunByIdempotencyKeyInD1(env, input.idempotencyKey);
    if (persisted && persisted.status !== 'running') return persisted;
  }

  const scenario = getScenario(input.scenarioId);
  if (!scenario) throw problemError(404, 'Scenario not found', 'The requested scenario does not exist.', instance);

  const profiles = getProfiles(input.profileIds);
  if (profiles.length !== input.profileIds.length) throw problemError(400, 'Invalid profile', 'One or more profile ids are unknown.', instance);

  const config = getConfig(env);
  assertLiveOpenAIConfig(env, instance);

  const modelName = input.modelName ?? config.openAIModel;
  const generationSettings = input.generationSettings ?? config.generationSettings;
  const trialCount = clampTrialCount(input.trialCount ?? 1);
  const policyGrounding = await retrievePolicyGrounding(env, scenario);
  const createdAt = nowSeconds();
  const candidate: ExperimentRun = {
    id: id('run'),
    scenarioId: scenario.id,
    scenarioSnapshot: scenario,
    profileIds: profiles.map((profile) => profile.id),
    modelProvider: 'openai',
    modelName,
    generationSettings,
    status: 'running',
    idempotencyKey: input.idempotencyKey,
    outputs: [],
    metrics: [],
    sensitivityRuns: [],
    createdAt,
    startedAt: createdAt,
    trialCount,
    batteryId: input.batteryId,
    policyGrounding,
  };

  const reservation = await reserveRunForIdempotency(env, candidate);
  if (!reservation.reserved) {
    return reservation.run;
  }
  const run = reservation.run;
  // Re-apply trial/battery fields in case the reserved run came back from
  // a fresh INSERT (the reservation echoes the candidate; the persisted-then-
  // hydrated path would not — we set them either way to be safe).
  run.trialCount = trialCount;
  run.batteryId = input.batteryId;
  run.policyGrounding = policyGrounding;

  try {
    // Generate (profile, trialIndex) cell pairs. Total = profiles × trialCount.
    // Each cell is one provider call. We use Promise.allSettled so partial
    // success preserves completed trials.
    const cellPlans: Array<{ profile: ValueProfile; trialIndex: number }> = [];
    for (const profile of profiles) {
      for (let t = 0; t < trialCount; t += 1) {
        cellPlans.push({ profile, trialIndex: t });
      }
    }

    const settled = await Promise.allSettled(cellPlans.map(async (cell): Promise<AgentOutput> => {
      const result = await withBudget(
        runProfileProvider(env, modelName, generationSettings, scenario, cell.profile, userKey, policyGrounding),
        config.runTimeoutSeconds * 1000,
      );
      const structuredDecision = attachPolicyCompliance(result.structuredDecision, policyGrounding);
      return {
        id: id('output'),
        runId: run.id,
        profileId: cell.profile.id,
        profileSnapshot: cell.profile,
        translatedPrompt: result.prompt,
        rawOutput: result.rawOutput,
        structuredDecision,
        driveTrace: structuredDecision.driveAttributions,
        confidence: structuredDecision.confidence,
        status: 'completed',
        createdAt: nowSeconds(),
        trialIndex: cell.trialIndex,
      };
    }));

    const outputs = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    const failures = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    await saveOutputs(env, run.id, outputs);

    const expected = profiles.length * trialCount;
    if (outputs.length === expected) {
      run.status = 'completed';
    } else if (outputs.length > 0) {
      run.status = 'partial';
      run.error = problem(
        207,
        'Partial run',
        `${failures.length} of ${expected} profile/trial calls failed (${summarizeProviderFailures(failures)}); completed outputs were preserved. Retry missing profiles with POST /api/experiments/${run.id}/retry-profile after the provider recovers.`,
        instance,
      );
    } else {
      run.status = 'failed';
      run.error = problem(
        502,
        'Provider run failed',
        `No profile outputs completed (${summarizeProviderFailures(failures)}). The run remains retryable by profile after the provider recovers; use POST /api/experiments/${run.id}/retry-profile with a profileId.`,
        instance,
      );
    }

    run.outputs = outputs;
    if (outputs.length > 0) {
      // Synthesis + metrics still operate on the per-profile selection set.
      // For trialCount > 1, synthesizeRun sees N profiles × M trials of
      // outputs. We feed the modal-per-cell to synthesizeRun so the
      // existing one-profile-per-row semantics carry over without rewrite.
      const modalPerProfile = computeModalPerProfile(outputs);
      run.synthesis = synthesizeRun(run.id, modalPerProfile, modelName);
      run.metrics = computeMetrics(run.id, modalPerProfile, run.synthesis);
      try {
        const commentary = await withBudget(
          runModeratorCommentary(env, modelName, generationSettings, scenario, profiles, modalPerProfile, run.synthesis, userKey),
          config.runTimeoutSeconds * 1000,
        );
        run.synthesis.aiCommentary = commentary;
      } catch (commentaryError) {
        console.warn('[experiment] moderator AI commentary failed, continuing with deterministic only:', commentaryError instanceof Error ? commentaryError.message : commentaryError);
        run.synthesis.aiCommentary = null;
      }
    }
    run.completedAt = nowSeconds();
    run.artifactManifest = await writeRunArtifacts(env, run);
    await saveRun(env, run);
    return run;
  } catch (error) {
    console.error('[experiment] run pipeline failed for', run.id, error instanceof Error ? error.message : error);
    run.status = 'failed';
    run.completedAt = nowSeconds();
    run.error = problem(500, 'Run pipeline failed', 'An internal error occurred while completing the run. The run has been marked failed and is safe to retry.', instance);
    try {
      await saveRun(env, run);
    } catch (persistError) {
      console.error('[experiment] failed to persist failed-run row for', run.id, persistError instanceof Error ? persistError.message : persistError);
    }
    throw error;
  }
}

function clampTrialCount(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > 10) return 10;
  return Math.floor(n);
}

function summarizeProviderFailures(errors: unknown[]): string {
  if (errors.length === 0) return 'provider failure reason unavailable';
  const statuses = new Set<string>();
  const types = new Set<string>();
  const codes = new Set<string>();
  const params = new Set<string>();
  let authFailed = false;
  let budgetExceeded = false;
  let malformed = false;
  for (const error of errors) {
    const message = error instanceof Error ? error.message : String(error);
    const statusMatch = message.match(/status\s+(\d{3})/i);
    if (statusMatch) statuses.add(statusMatch[1]);
    const typeMatch = message.match(/\btype=([A-Za-z0-9_.-]+)/);
    if (typeMatch) types.add(typeMatch[1]);
    const codeMatch = message.match(/\bcode=([A-Za-z0-9_.-]+)/);
    if (codeMatch) codes.add(codeMatch[1]);
    const paramMatch = message.match(/\bparam=([A-Za-z0-9_.-]+)/);
    if (paramMatch) params.add(paramMatch[1]);
    if (/auth failed|rejected by OpenAI/i.test(message)) authFailed = true;
    if (/Run budget exceeded|budget exceeded|abort/i.test(message)) budgetExceeded = true;
    if (/refused|malformed|did not contain JSON|missing/i.test(message)) malformed = true;
  }
  const parts: string[] = [];
  if (statuses.size > 0) parts.push(`OpenAI status ${Array.from(statuses).sort().join('/')}`);
  if (types.size > 0) parts.push(`type=${Array.from(types).sort().join('/')}`);
  if (codes.size > 0) parts.push(`code=${Array.from(codes).sort().join('/')}`);
  if (params.size > 0) parts.push(`param=${Array.from(params).sort().join('/')}`);
  if (authFailed) parts.push('OpenAI authentication failed');
  if (budgetExceeded) parts.push('run budget exceeded');
  if (malformed) parts.push('OpenAI response was malformed or refused');
  return parts.length > 0 ? parts.join('; ') : 'provider calls failed before producing usable output';
}

/**
 * Reduce N×M outputs to one-row-per-profile by picking each profile's
 * modal selectedOptionId across its trials. Ties broken by the first
 * trial-order occurrence (so the synthesizer sees a stable row even
 * when modal stability is 0.5).
 */
function computeModalPerProfile(outputs: AgentOutput[]): AgentOutput[] {
  const byProfile = new Map<ProfileId, AgentOutput[]>();
  for (const out of outputs) {
    const existing = byProfile.get(out.profileId);
    if (existing) existing.push(out);
    else byProfile.set(out.profileId, [out]);
  }
  const modalRows: AgentOutput[] = [];
  for (const profileOutputs of byProfile.values()) {
    if (profileOutputs.length === 1) {
      modalRows.push(profileOutputs[0]);
      continue;
    }
    const counts = new Map<string, number>();
    for (const out of profileOutputs) {
      const optionId = out.structuredDecision.selectedOptionId;
      counts.set(optionId, (counts.get(optionId) ?? 0) + 1);
    }
    let modalOption: string | undefined;
    let modalCount = -1;
    for (const [option, count] of counts) {
      if (count > modalCount) {
        modalOption = option;
        modalCount = count;
      }
    }
    const modalRow = profileOutputs.find((o) => o.structuredDecision.selectedOptionId === modalOption)
      ?? profileOutputs[0];
    modalRows.push(modalRow);
  }
  return modalRows;
}

/**
 * Compute baseline modal option + stability for a (run, profile) cell.
 * Used by the sensitivity grid runner. Returns null option when the
 * stability is below the threshold (default 0.6 per O-3).
 */
export function computeBaselineModal(
  outputs: AgentOutput[],
  profileId: ProfileId,
  stabilityThreshold: number = 0.6,
): { option: string | null; stability: number } {
  const cellOutputs = outputs.filter((o) => o.profileId === profileId);
  if (cellOutputs.length === 0) return { option: null, stability: 0 };
  const counts = new Map<string, number>();
  for (const o of cellOutputs) {
    const opt = o.structuredDecision.selectedOptionId;
    counts.set(opt, (counts.get(opt) ?? 0) + 1);
  }
  let modalOption: string | undefined;
  let modalCount = 0;
  for (const [opt, count] of counts) {
    if (count > modalCount) {
      modalOption = opt;
      modalCount = count;
    }
  }
  const stability = modalCount / cellOutputs.length;
  if (!modalOption || stability < stabilityThreshold) {
    return { option: null, stability };
  }
  return { option: modalOption, stability };
}

/**
 * Sensitivity rerun (legacy single-profile axis-perturbation endpoint;
 * unchanged). Three-Layer redesign keeps this for the existing
 * /api/experiments/:runId/sensitivity endpoint; the new grid uses
 * src/experiments/sensitivity-grid.ts.
 */
export async function runSensitivity(env: Env, runId: string, profileId: ProfileId, axisChanges: SensitivityRun['axisChanges'], instance: string, userKey?: string): Promise<SensitivityRun> {
  const baseRun = await getRunAuthoritative(env, runId, { hydrateOutputs: true });
  if (!baseRun) throw problemError(404, 'Run not found', 'The requested run does not exist.', instance);

  const originalOutput = baseRun.outputs.find((output) => output.profileId === profileId);
  if (!originalOutput) throw problemError(400, 'Profile output missing', 'The selected profile has no completed output in this run.', instance);

  const config = getConfig(env);
  const scenario = baseRun.scenarioSnapshot;
  const originalProfile = originalOutput.profileSnapshot;
  const perturbedProfile = applyAxisChanges(originalProfile, axisChanges);
  const isDemo = config.demoMode || (!userKey && !env.OPENAI_API_KEY);

  const createdAt = nowSeconds();
  let rerunDecision: StructuredDecision = originalOutput.structuredDecision;
  let status: SensitivityRun['status'] = 'completed';

  try {
    if (isDemo) {
      const demoProfile = perturbedProfileForDemo(perturbedProfile, axisChanges);
      const policyGrounding = baseRun.policyGrounding ?? await retrievePolicyGrounding(env, scenario);
      const demoResult = await runProfileProvider(env, baseRun.modelName, baseRun.generationSettings, scenario, demoProfile, userKey, policyGrounding);
      rerunDecision = attachPolicyCompliance(demoResult.structuredDecision, policyGrounding);
    } else {
      const policyGrounding = baseRun.policyGrounding ?? await retrievePolicyGrounding(env, scenario);
      const live = await withBudget(
        runProfileProvider(env, baseRun.modelName, baseRun.generationSettings, scenario, perturbedProfile, userKey, policyGrounding),
        config.runTimeoutSeconds * 1000,
      );
      rerunDecision = attachPolicyCompliance(live.structuredDecision, policyGrounding);
    }
  } catch (error) {
    console.error('[sensitivity] rerun failed for run', runId, 'profile', profileId, error instanceof Error ? error.message : error);
    status = 'failed';
  }

  const flipped = originalOutput.structuredDecision.selectedOptionId !== rerunDecision.selectedOptionId;
  const nearFlip = !flipped && computeNearFlip(originalOutput.structuredDecision, rerunDecision);

  const sensitivityRun: SensitivityRun = {
    id: id('sensitivity'),
    baseRunId: runId,
    profileId,
    axisChanges,
    originalDecision: originalOutput.structuredDecision,
    rerunDecision,
    flipped,
    nearFlip,
    status,
    createdAt,
    completedAt: nowSeconds(),
  };
  await saveSensitivityRun(env, sensitivityRun);
  return sensitivityRun;
}

function applyAxisChanges(profile: ValueProfile, axisChanges: SensitivityRun['axisChanges']): ValueProfile {
  const overrides = new Map<AxisId, number>();
  for (const change of axisChanges) {
    const clamped = Math.max(0, Math.min(1, change.to));
    overrides.set(change.axis, clamped);
  }
  const newWeights = profile.axisWeights.map<AxisWeight>((weight) => {
    const override = overrides.get(weight.axis);
    if (override === undefined) return weight;
    const snapped: 0.2 | 0.5 | 0.8 = override >= 0.65 ? 0.8 : override >= 0.35 ? 0.5 : 0.2;
    const level: AxisWeight['level'] = snapped === 0.8 ? 'high' : snapped === 0.5 ? 'medium' : 'low';
    return { ...weight, value: snapped, level };
  });
  return { ...profile, axisWeights: newWeights };
}

function perturbedProfileForDemo(profile: ValueProfile, axisChanges: SensitivityRun['axisChanges']): ValueProfile {
  const significant = axisChanges.some((change) => Math.abs(change.from - change.to) >= 0.3);
  if (!significant) return profile;
  const rotation: Record<ProfileId, ProfileId> = {
    achievement: 'preservation',
    preservation: 'achievement',
    exploration: 'neutral',
    neutral: 'exploration',
  };
  return { ...profile, id: rotation[profile.id] };
}

function computeNearFlip(original: StructuredDecision, rerun: StructuredDecision): boolean {
  if (!original.rankedOptions?.length || !rerun.rankedOptions?.length) return false;
  if (original.rankedOptions.length < 2 || rerun.rankedOptions.length < 2) return false;
  return original.rankedOptions[0] === rerun.rankedOptions[0]
    && original.rankedOptions[1] !== rerun.rankedOptions[1];
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

/**
 * Per-profile retry helper (01-spec §12.2 F-12.2.4).
 *
 * Re-runs a single (scenarioId, profileId) cell × `trialCount` times within an
 * already-terminal run, appending new agent_outputs rows with `trial_index`
 * continuing from the existing max for that profile. Used when the original
 * 4×N parallel fan-out blew the Worker 25s wall budget for one profile and
 * the operator wants to resurrect that lane without re-running the others.
 *
 * Wall-budget strategy: trials run SEQUENTIALLY. With N=5 and ~3-5s per
 * provider call this fits inside the 25s budget for a single profile (vs.
 * the 4×5 parallel fan-out that didn't). Caller can pass smaller
 * `trialCount` to stay even further inside the budget if needed.
 *
 * Returns a typed summary so the worker can echo it back in the response
 * body. Idempotency-Key handling lives in the worker layer (KV-cached
 * response), not here — this helper is intentionally non-idempotent so the
 * KV cache can store the *result* of the first call.
 */
export type RetryProfileResult = {
  runId: string;
  profileId: ProfileId;
  addedOutputs: number;
  status: ExperimentRun['status'];
  totalOutputs: number;
  trialCount: number;
  error?: string;
};

export async function retryProfileForRun(
  env: Env,
  runId: string,
  profileId: ProfileId,
  requestedTrialCount: number | undefined,
  instance: string,
  userKey?: string,
): Promise<RetryProfileResult> {
  const run = await getRunAuthoritative(env, runId, { hydrateOutputs: true });
  if (!run) {
    throw problemError(404, 'Run not found', 'The requested experiment run does not exist.', instance);
  }
  if (run.status === 'running') {
    throw problemError(409, 'Run still running', 'The run has not reached a terminal state; wait for completion before retrying a profile.', instance);
  }
  if (run.status !== 'completed' && run.status !== 'partial' && run.status !== 'failed') {
    throw problemError(409, 'Run not retryable', `Run status "${run.status}" cannot be retried; only completed, partial, or failed runs are eligible.`, instance);
  }

  if (!run.profileIds.includes(profileId)) {
    throw problemError(400, 'Profile not in run', `Profile "${profileId}" was not part of the original run.`, instance);
  }

  const profiles = getProfiles([profileId]);
  if (profiles.length !== 1) {
    throw problemError(400, 'Invalid profile', 'The requested profile id is unknown.', instance);
  }
  const profile = profiles[0];

  // Resolve trial count: caller-provided > run's original > 5.
  const trialCount = clampTrialCount(requestedTrialCount ?? run.trialCount ?? 5);

  const config = getConfig(env);
  assertLiveOpenAIConfig(env, instance);

  const scenario = run.scenarioSnapshot;
  const modelName = run.modelName;
  const generationSettings = run.generationSettings;
  const policyGrounding = run.policyGrounding ?? await retrievePolicyGrounding(env, scenario);
  run.policyGrounding = policyGrounding;

  // Compute the next trial_index for this profile so retries don't collide
  // with whatever (zero or more) outputs already exist.
  const existingForProfile = (run.outputs ?? []).filter((o) => o.profileId === profileId);
  const maxTrialIndex = existingForProfile.reduce((max, o) => Math.max(max, o.trialIndex ?? 0), -1);
  let nextTrialIndex = maxTrialIndex + 1;

  // Sequential per-trial loop. Sequential (vs parallel) is intentional —
  // the original fan-out blew the wall budget; one profile × N trials in
  // sequence stays inside the 25s window for typical N=5.
  const newOutputs: AgentOutput[] = [];
  let lastError: string | undefined;
  for (let t = 0; t < trialCount; t += 1) {
    try {
      const result = await withBudget(
        runProfileProvider(env, modelName, generationSettings, scenario, profile, userKey, policyGrounding),
        config.runTimeoutSeconds * 1000,
      );
      const structuredDecision = attachPolicyCompliance(result.structuredDecision, policyGrounding);
      newOutputs.push({
        id: id('output'),
        runId: run.id,
        profileId: profile.id,
        profileSnapshot: profile,
        translatedPrompt: result.prompt,
        rawOutput: result.rawOutput,
        structuredDecision,
        driveTrace: structuredDecision.driveAttributions,
        confidence: structuredDecision.confidence,
        status: 'completed',
        createdAt: nowSeconds(),
        trialIndex: nextTrialIndex,
      });
      nextTrialIndex += 1;
    } catch (error) {
      console.error('[retry-profile] trial failed for run', runId, 'profile', profileId, 'trial', nextTrialIndex, error instanceof Error ? error.message : error);
      lastError = summarizeProviderFailures([error]);
      // Stop on first failure inside the retry loop — the caller can re-fire
      // the endpoint with a smaller trialCount or wait. We still persist the
      // partial outputs gathered so far so the work isn't lost.
      break;
    }
  }

  // Compute the full output list ONCE before the saveOutputs call.
  // saveOutputs mutates the in-memory cache's outputs array, and because
  // getRunAuthoritative returned a reference into that same cache (after
  // hydrateOutputs), reading run.outputs *after* saveOutputs would
  // double-count the new rows. Snapshot first, then persist.
  const allOutputs = [...(run.outputs ?? []), ...newOutputs];
  if (newOutputs.length > 0) {
    await saveOutputs(env, run.id, allOutputs);
  }
  const targetTrialCount = run.trialCount ?? trialCount;
  const allComplete = run.profileIds.every((pid) => {
    const cnt = allOutputs.filter((o) => o.profileId === pid).length;
    return cnt >= targetTrialCount;
  });
  if (allComplete) {
    run.status = 'completed';
    run.error = undefined;
  } else if (allOutputs.length > 0) {
    run.status = 'partial';
  } else {
    run.status = 'failed';
  }
  run.outputs = allOutputs;
  run.completedAt = nowSeconds();
  await saveRun(env, run);

  return {
    runId: run.id,
    profileId: profile.id,
    addedOutputs: newOutputs.length,
    status: run.status,
    totalOutputs: allOutputs.length,
    trialCount,
    error: lastError,
  };
}
