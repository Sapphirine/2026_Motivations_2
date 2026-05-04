/**
 * Canonical Battery Orchestrator (per 02-design.md §5.7).
 *
 * Endpoint: POST /api/research/run-canonical-battery
 *   Returns: { batteryId, runIds[36], baselineRunIds[20-equiv], gridJobId,
 *             sameProfileBaselineScheduled }
 *
 * Composition:
 *   1. Main 5-trial battery: 9 scenarios × 4 profiles = 36 runs, each with
 *      trialCount=5, all sharing one batteryId. (180 nano calls.)
 *   2. Same-profile baseline noise floor:
 *      coding-assistant-low-trust-evaluation-anxiety,
 *      4 profiles, 5 trials each = 20 calls. Stored in
 *      same_profile_baseline_runs.
 *   3. Sensitivity grid: 9 × 4 × 4 = 144 cells; idempotency_key pinned to
 *      this battery so re-running resumes.
 *
 * Idempotency: the umbrella endpoint accepts an `idempotencyKey`. On a
 * duplicate call, the existing batteryId is returned with the same
 * runIds and gridJobId.
 *
 * All long-running work runs via `ctx.waitUntil` so the umbrella response
 * lands in <500 ms.
 */

import { presetScenarios } from '../domain/seeds';
import type { Env, ProfileId, SameProfileBaselineRun } from '../domain/types';
import { runThreeLayerAnalysis } from '../analysis/three-layer-runner';
import { runExperiment } from '../services/experiment';
import { runProfileProvider } from '../services/provider';
import {
  getProfiles,
  getScenario,
  id as makeId,
  insertSameProfileBaselineRun,
  nowSeconds,
} from '../services/storage';
import { runGridBatches, startSensitivityGridJob } from './sensitivity-grid';

export type CanonicalBatteryResult = {
  batteryId: string;
  runIds: string[];
  baselineRunIds: string[];
  gridJobId: string;
  sameProfileBaselineScheduled: boolean;
};

const ALL_PROFILES: readonly ProfileId[] = ['achievement', 'exploration', 'preservation', 'neutral'];
const SAME_PROFILE_SCENARIO = 'coding-assistant-low-trust-evaluation-anxiety';
const TRIAL_COUNT = 5;

/**
 * Schedule the full canonical battery. Returns immediately; long-running
 * work is performed via the supplied waitUntil callback.
 *
 * Sequencing fix (Lane E, 2026-04-27):
 *   The previous orchestrator fired `runMainBattery`, `runSameProfileBaseline`,
 *   and `runGrid` in parallel via three separate `waitUntil` calls. Because
 *   the grid's per-cell baseline lookup depends on the modal option from
 *   `experiment_runs.status IN ('completed','partial')`, racing the grid
 *   against the main battery caused every cell to see "no baseline" and
 *   record `flipped: null`.
 *
 *   The new flow chains under a single `waitUntil`:
 *     1. await sequential main 9 runs        // experiment_runs reach terminal
 *     2. await Promise.all(20 baseline trials)
 *     3. INSERT sensitivity_grid_jobs THEN runGridBatches
 *
 *   The umbrella endpoint still lands in <500 ms because the grid job
 *   does NOT exist yet at response time — the synchronous response carries
 *   `gridJobId: 'pending::will-start-after-main-battery'`. Polling
 *   `GET /api/sensitivity-grid?batteryId=` (or the job id surfaced via
 *   findings/heatmap once it lands) is how clients learn the real id.
 */
export async function startCanonicalBattery(
  env: Env,
  idempotencyKey: string,
  waitUntil: (promise: Promise<unknown>) => void,
  userKey?: string,
): Promise<CanonicalBatteryResult> {
  const batteryId = `battery_${idempotencyKey}`;

  // Pre-compute the deterministic per-scenario × per-profile idempotency keys
  // so that this whole umbrella call is replay-safe. If the user re-POSTs
  // the same `idempotencyKey`, the existing run rows are returned by
  // reserveRunForIdempotency (UNIQUE on idempotency_key).
  const runIds: string[] = [];
  const profiles = getProfiles([...ALL_PROFILES]);
  const scenarios = presetScenarios;

  // Pre-allocate the per-run and per-baseline ids so the synchronous
  // response carries stable `pending::` placeholders the client can echo
  // back in subsequent polls.
  const baselineRunIds: string[] = [];
  for (const profile of profiles) {
    for (let trial = 0; trial < TRIAL_COUNT; trial += 1) {
      baselineRunIds.push(makeId('sameprof'));
    }
  }
  for (const scenario of scenarios) {
    const runIdempotencyKey = `${idempotencyKey}::${scenario.id}`;
    runIds.push(`pending::${runIdempotencyKey}`);
  }

  // Single waitUntil wraps the entire main -> baseline -> grid pipeline so
  // the grid only sees terminal `experiment_runs` rows when it computes
  // per-cell baselines. The sequencing here is the FIX: previously, racing
  // the grid against the main battery caused every cell to see "no
  // baseline" and record `flipped: null` (Lane C bug report).
  waitUntil((async () => {
    // ===== Stage 1: main battery (9 runs, sequential by scenario) =====
    // Each run still fans out 4 profiles x 5 trials internally. Running the
    // nine scenarios sequentially avoids a 180-call subject-model burst.
    for (const scenario of scenarios) {
      const runIdempotencyKey = `${idempotencyKey}::${scenario.id}`;
      try {
        const run = await runExperiment(env, {
          scenarioId: scenario.id,
          profileIds: [...ALL_PROFILES],
          trialCount: TRIAL_COUNT,
          idempotencyKey: runIdempotencyKey,
          batteryId,
        }, '/api/research/run-canonical-battery', userKey);
        console.info('[battery] main run complete', { runId: run.id, scenario: scenario.id, status: run.status });
        try {
          await runThreeLayerAnalysis(env, run.id, { force: false }, userKey);
        } catch (error) {
          console.error('[battery] three-layer audit failed', { runId: run.id, scenario: scenario.id, error: error instanceof Error ? error.message : String(error) });
        }
      } catch (error) {
        console.error('[battery] main run failed', { scenario: scenario.id, error: error instanceof Error ? error.message : String(error) });
      }
    }

    // ===== Stage 2: same-profile baseline (20 trials in parallel) =====
    let baselineCursor = 0;
    const baselinePromises: Array<Promise<void>> = [];
    for (const profile of profiles) {
      for (let trial = 0; trial < TRIAL_COUNT; trial += 1) {
        const baselineId = baselineRunIds[baselineCursor++];
        baselinePromises.push(
          runOneSameProfileTrial(env, batteryId, baselineId, profile.id, trial, userKey).catch((error) => {
            console.error('[battery] same-profile trial failed', { profile: profile.id, trial, error: error instanceof Error ? error.message : String(error) });
          }),
        );
      }
    }
    await Promise.all(baselinePromises);

    // ===== Stage 3: sensitivity grid (insert job, then run batches) =====
    // Done after main + baseline so the grid's per-cell baseline lookup
    // sees terminal `experiment_runs` rows. Without this ordering the
    // grid records `flipped: null` for every cell.
    try {
      const grid = await startSensitivityGridJob(env, {
        scenarioIds: scenarios.map((s) => s.id),
        profileIds: [...ALL_PROFILES],
        axisIds: ['achievement', 'self_direction', 'security', 'benevolence'],
        batteryId,
        idempotencyKey: `canonical-grid-${idempotencyKey}`,
      });
      console.info('[battery] grid job created post-main-battery', { batteryId, jobId: grid.job.id, alreadyExisted: grid.alreadyExisted });
      await runGridBatches(env, grid.job.id, userKey);
    } catch (error) {
      console.error('[battery] grid stage failed:', error instanceof Error ? error.message : String(error));
    }
  })().catch((error) => {
    console.error('[battery] umbrella orchestrator failed:', error instanceof Error ? error.message : String(error));
  }));

  return {
    batteryId,
    runIds,
    baselineRunIds,
    // Real grid job id is not known synchronously — it is INSERTed only
    // after main battery + baseline finish (~5-10 min wall clock). Clients
    // poll GET /api/sensitivity-grid?batteryId={batteryId} (Lane E follow-up)
    // or GET /api/findings/heatmap (uses most-recent terminal grid job).
    gridJobId: `pending::will-start-after-main-battery::${batteryId}`,
    sameProfileBaselineScheduled: true,
  };
}

async function runOneSameProfileTrial(
  env: Env,
  batteryId: string,
  baselineId: string,
  profileId: ProfileId,
  trial: number,
  userKey?: string,
): Promise<void> {
  const scenario = getScenario(SAME_PROFILE_SCENARIO);
  if (!scenario) {
    console.warn('[battery] same-profile scenario missing, skipping trial', { profileId, trial });
    return;
  }
  const profiles = getProfiles([profileId]);
  if (profiles.length === 0) return;
  const result = await runProfileProvider(
    env,
    env.OPENAI_MODEL ?? 'gpt-5.4-nano',
    { temperature: 0.2, maxTokens: 1200 },
    scenario,
    profiles[0],
    userKey,
  );
  const baseline: SameProfileBaselineRun = {
    id: baselineId,
    batteryId,
    scenarioId: scenario.id,
    profileId,
    trial,
    selectedOption: result.structuredDecision.selectedOptionId,
    rawOutput: result.rawOutput,
    rationale: result.structuredDecision.rationale ?? '',
    createdAt: nowSeconds(),
  };
  await insertSameProfileBaselineRun(env, baseline);
}
