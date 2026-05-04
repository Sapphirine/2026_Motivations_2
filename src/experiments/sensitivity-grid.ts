/**
 * 144-cell Sensitivity Grid Runner (per 02-design.md §6.3).
 *
 * Threading model: client-driven polling with worker-side batching.
 *   - POST /api/sensitivity-grid inserts the job row, returns {jobId} in <500ms,
 *     then kicks off `runNextBatch` via `ctx.waitUntil`.
 *   - `runNextBatch` processes batch=4 cells in parallel per tick, then
 *     re-schedules itself (recursive ctx.waitUntil) until all cells done
 *     OR the 25-sec wall-clock guard fires OR the error budget trips.
 *   - The next polling request from the client kicks off another
 *     runNextBatch invocation if D1 still shows pending cells.
 *
 * D1 is authoritative — every cell completion writes back to
 * sensitivity_grid_jobs.results_json so a Worker eviction is recoverable
 * (the next poll resumes from where the in-memory state was lost).
 */

import { presetScenarios, valueProfiles } from '../domain/seeds';
import type {
  AgentOutput,
  Env,
  JudgeAxisId,
  ProfileId,
  Scenario,
  SensitivityGridCell,
  SensitivityGridCellError,
  SensitivityGridJob,
  ValueProfile,
} from '../domain/types';
import { getConfig } from '../services/config';
import { computeBaselineModal } from '../services/experiment';
import { runProfileProvider } from '../services/provider';
import {
  getScenario,
  getGridJob,
  insertGridJob,
  loadAgentOutputsWithThreeLayer,
  nowSeconds,
  id as makeId,
  updateGridJob,
} from '../services/storage';

const ALL_AXES: readonly JudgeAxisId[] = ['achievement', 'self_direction', 'security', 'benevolence'];
const ALL_PROFILES: readonly ProfileId[] = ['achievement', 'exploration', 'preservation', 'neutral'];
const BATCH_SIZE = 4;
const TICK_BUDGET_MS = 25_000;
const PER_CELL_TIMEOUT_MS = 25_000;

/**
 * Map between the legacy AxisId (camelCase, used in profile snapshots)
 * and the JudgeAxisId (snake_case, used in the three-layer pipeline).
 */
const AXIS_LEGACY_TO_JUDGE: Record<string, JudgeAxisId> = {
  achievement: 'achievement',
  selfDirection: 'self_direction',
  security: 'security',
  benevolence: 'benevolence',
};
const AXIS_JUDGE_TO_LEGACY: Record<JudgeAxisId, 'achievement' | 'selfDirection' | 'security' | 'benevolence'> = {
  achievement: 'achievement',
  self_direction: 'selfDirection',
  security: 'security',
  benevolence: 'benevolence',
};

export type SensitivityGridInput = {
  scenarioIds?: string[];
  profileIds?: ProfileId[];
  axisIds?: JudgeAxisId[];
  batteryId?: string;
  idempotencyKey: string;
  errorBudget?: number;
};

export type GridStartResult = {
  job: SensitivityGridJob;
  alreadyExisted: boolean;
};

/**
 * Create or resume a sensitivity grid job and schedule the first batch.
 * The caller is responsible for invoking `ctx.waitUntil(runGridBatches(env, jobId))`
 * AFTER this function returns so the response can land in <500 ms.
 */
export async function startSensitivityGridJob(env: Env, input: SensitivityGridInput): Promise<GridStartResult> {
  const scenarioIds = input.scenarioIds ?? presetScenarios.map((s) => s.id);
  const profileIds = input.profileIds ?? [...ALL_PROFILES];
  const axisIds = input.axisIds ?? [...ALL_AXES];
  const totalCells = scenarioIds.length * profileIds.length * axisIds.length;
  const now = nowSeconds();

  const candidate: SensitivityGridJob = {
    id: makeId('grid'),
    batteryId: input.batteryId,
    status: 'pending',
    totalCells,
    completedCells: 0,
    failedCells: 0,
    errorBudget: input.errorBudget ?? 10,
    scenarioIds,
    profileIds,
    axisIds,
    results: [],
    errors: [],
    idempotencyKey: input.idempotencyKey,
    createdAt: now,
    updatedAt: now,
  };

  const { inserted, job } = await insertGridJob(env, candidate);
  return { job, alreadyExisted: !inserted };
}

/**
 * Run one or more batches of cells inside a single Worker invocation.
 * Stops when:
 *   - all cells completed
 *   - error budget exhausted (status -> 'partial')
 *   - 25-sec wall-clock guard fires (caller should re-schedule)
 *
 * Safe to call multiple times concurrently because each batch SELECTs
 * the current `results_json`/`errors_json` state from D1 before computing
 * the "next pending cells" set. (There's a small race window where two
 * simultaneous batches process the same cell; the last writer wins via
 * INSERT OR REPLACE on the cell-run experiment_runs row, so the worst
 * case is a duplicated provider call rather than corrupted data.)
 */
export async function runGridBatches(env: Env, jobId: string, userKey?: string): Promise<void> {
  const tickStart = Date.now();

  while (Date.now() - tickStart < TICK_BUDGET_MS) {
    const job = await getGridJob(env, jobId);
    if (!job) {
      console.warn('[grid] job missing, abort:', jobId);
      return;
    }
    if (job.status === 'completed' || job.status === 'partial' || job.status === 'failed') {
      return;
    }

    if (job.failedCells >= job.errorBudget) {
      job.status = 'partial';
      job.completedAt = nowSeconds();
      await updateGridJob(env, job);
      return;
    }

    if (job.completedCells >= job.totalCells) {
      job.status = 'completed';
      job.completedAt = nowSeconds();
      await updateGridJob(env, job);
      return;
    }

    if (job.status === 'pending') {
      job.status = 'running';
      await updateGridJob(env, job);
    }

    const pendingCells = computePendingCells(job);
    const batch = pendingCells.slice(0, BATCH_SIZE);
    if (batch.length === 0) {
      // Nothing pending but counters not equal to total — terminal mismatch.
      job.status = job.failedCells > 0 ? 'partial' : 'completed';
      job.completedAt = nowSeconds();
      await updateGridJob(env, job);
      return;
    }

    await processCellBatch(env, job, batch, userKey);
  }
}

export async function runGridErrorRetries(env: Env, jobId: string, retryCells: CellPlan[], userKey?: string): Promise<void> {
  const tickStart = Date.now();
  const retryKeys = new Set(retryCells.map((cell) => cellKey(cell.scenarioId, cell.profileId, cell.axisId)));

  while (Date.now() - tickStart < TICK_BUDGET_MS && retryKeys.size > 0) {
    const job = await getGridJob(env, jobId);
    if (!job) {
      console.warn('[grid] retry job missing, abort:', jobId);
      return;
    }
    const existingResultKeys = new Set(job.results.map((cell) => cellKey(cell.scenarioId, cell.profileId, cell.axisId)));
    const existingErrorKeys = new Set(job.errors.map((error) => cellKey(error.scenarioId, error.profileId, error.axisId)));
    const batch = retryCells
      .filter((cell) => retryKeys.has(cellKey(cell.scenarioId, cell.profileId, cell.axisId)))
      .filter((cell) => !existingResultKeys.has(cellKey(cell.scenarioId, cell.profileId, cell.axisId)) || existingErrorKeys.has(cellKey(cell.scenarioId, cell.profileId, cell.axisId)))
      .slice(0, BATCH_SIZE);

    if (batch.length === 0) {
      job.status = job.errors.length > 0 ? 'partial' : 'completed';
      job.completedCells = job.results.length;
      job.failedCells = job.errors.length;
      job.completedAt = nowSeconds();
      job.updatedAt = nowSeconds();
      await updateGridJob(env, job);
      return;
    }

    if (job.status === 'pending' || job.status === 'partial' || job.status === 'failed') {
      job.status = 'running';
      job.completedAt = undefined;
      await updateGridJob(env, job);
    }

    await processCellBatch(env, job, batch, userKey);
    for (const cell of batch) {
      retryKeys.delete(cellKey(cell.scenarioId, cell.profileId, cell.axisId));
    }
  }
}

async function processCellBatch(env: Env, job: SensitivityGridJob, batch: CellPlan[], userKey?: string): Promise<void> {
  const retryKeys = new Set(batch.map((cell) => cellKey(cell.scenarioId, cell.profileId, cell.axisId)));
  job.errors = job.errors.filter((error) => !retryKeys.has(cellKey(error.scenarioId, error.profileId, error.axisId)));
  const resultKeys = new Set(job.results.map((cell) => cellKey(cell.scenarioId, cell.profileId, cell.axisId)));
  const settled = await Promise.allSettled(batch.map((cellPlan) => processOneCell(env, job, cellPlan, userKey)));
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      const { cell, error } = outcome.value;
      if (cell) {
        const key = cellKey(cell.scenarioId, cell.profileId, cell.axisId);
        if (!resultKeys.has(key)) {
          job.results.push(cell);
          resultKeys.add(key);
        }
      }
      if (error) {
        job.errors.push(error);
      }
    } else {
      console.error('[grid] unexpected cell rejection:', outcome.reason);
    }
  }

  job.completedCells = job.results.length;
  job.failedCells = job.errors.length;
  if (job.completedCells >= job.totalCells) {
    job.status = job.failedCells > 0 ? 'partial' : 'completed';
    job.completedAt = nowSeconds();
  }
  job.updatedAt = nowSeconds();
  await updateGridJob(env, job);
}

type CellPlan = { scenarioId: string; profileId: ProfileId; axisId: JudgeAxisId };

function computePendingCells(job: SensitivityGridJob): CellPlan[] {
  const seen = new Set<string>();
  for (const cell of job.results) {
    seen.add(cellKey(cell.scenarioId, cell.profileId, cell.axisId));
  }
  for (const err of job.errors) {
    seen.add(cellKey(err.scenarioId, err.profileId as ProfileId, err.axisId as JudgeAxisId));
  }
  const pending: CellPlan[] = [];
  for (const scenarioId of job.scenarioIds) {
    for (const profileId of job.profileIds) {
      for (const axisId of job.axisIds) {
        const key = cellKey(scenarioId, profileId, axisId);
        if (!seen.has(key)) pending.push({ scenarioId, profileId, axisId });
      }
    }
  }
  return pending;
}

function cellKey(scenarioId: string, profileId: string, axisId: string): string {
  return `${scenarioId}::${profileId}::${axisId}`;
}

async function processOneCell(
  env: Env,
  job: SensitivityGridJob,
  plan: CellPlan,
  userKey?: string,
): Promise<{ cell?: SensitivityGridCell; error?: SensitivityGridCellError }> {
  const scenario = getScenario(plan.scenarioId);
  const profile = valueProfiles.find((p) => p.id === plan.profileId);
  if (!scenario || !profile) {
    return {
      error: {
        scenarioId: plan.scenarioId,
        profileId: plan.profileId,
        axisId: plan.axisId,
        errorType: 'parse',
        message: `Unknown scenario or profile (${plan.scenarioId}/${plan.profileId})`,
        attempts: 1,
        loggedAt: nowSeconds(),
      },
    };
  }

  // Baseline modal lookup. The baseline lives in the most-recent (scenario,
  // profile) batteryId-grouped run with trial_count >= 1. We naively search
  // across the run's outputs — for the canonical battery this is the umbrella
  // run pinned to the same batteryId as the grid job.
  const baseline = await findBaselineModal(env, plan.scenarioId, plan.profileId, job.batteryId);

  const lowProfile = setAxisEndpoint(profile, plan.axisId, 0.2);
  const highProfile = setAxisEndpoint(profile, plan.axisId, 0.8);
  let lowOption: string | null = null;
  let highOption: string | null = null;
  let lowRationale = '';
  let highRationale = '';
  let lowCellRunId = '';
  let highCellRunId = '';
  const config = getConfig(env);

  try {
    const lowResult = await withBudget(
      runProfileProvider(env, env.OPENAI_MODEL ?? 'gpt-5.4-nano', config.generationSettings, scenario, lowProfile, userKey),
      PER_CELL_TIMEOUT_MS,
    );
    lowOption = lowResult.structuredDecision.selectedOptionId;
    lowRationale = lowResult.structuredDecision.rationale ?? '';
    lowCellRunId = makeId('celllow');

    const highResult = await withBudget(
      runProfileProvider(env, env.OPENAI_MODEL ?? 'gpt-5.4-nano', config.generationSettings, scenario, highProfile, userKey),
      PER_CELL_TIMEOUT_MS,
    );
    highOption = highResult.structuredDecision.selectedOptionId;
    highRationale = highResult.structuredDecision.rationale ?? '';
    highCellRunId = makeId('cellhigh');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      error: {
        scenarioId: plan.scenarioId,
        profileId: plan.profileId,
        axisId: plan.axisId,
        errorType: /budget exceeded|abort/i.test(message) ? 'timeout' : /OpenAI/i.test(message) ? 'openai' : 'parse',
        message: message.slice(0, 280),
        attempts: 1,
        loggedAt: nowSeconds(),
      },
    };
  }

  const flipped = lowOption === null || highOption === null
    ? null
    : lowOption !== highOption;

  const cell: SensitivityGridCell = {
    scenarioId: plan.scenarioId,
    profileId: plan.profileId,
    axisId: plan.axisId,
    contrastMode: 'low_high',
    lowOption,
    highOption,
    lowRationaleExcerpt: lowRationale.slice(0, 320),
    highRationaleExcerpt: highRationale.slice(0, 320),
    lowCellRunId,
    highCellRunId,
    baselineOption: baseline.option,
    baselineStability: baseline.stability,
    perturbedOption: highOption,
    flipped,
    perturbedRationaleExcerpt: highRationale.slice(0, 320),
    cellRunId: highCellRunId,
    completedAt: nowSeconds(),
  };
  return { cell };
}

/**
 * Find baseline modal option for a (scenario, profile) cell. Looks up
 * the most recent run for this scenario+profile (optionally pinned to
 * a batteryId) and computes the modal across its trial_index outputs.
 */
async function findBaselineModal(
  env: Env,
  scenarioId: string,
  profileId: ProfileId,
  batteryId?: string,
): Promise<{ option: string | null; stability: number }> {
  if (!env.DB) return { option: null, stability: 0 };
  const query = batteryId
    ? `SELECT id FROM experiment_runs WHERE scenario_id = ? AND status IN ('completed','partial') AND battery_id = ? ORDER BY created_at DESC LIMIT 1`
    : `SELECT id FROM experiment_runs WHERE scenario_id = ? AND status IN ('completed','partial') ORDER BY created_at DESC LIMIT 1`;
  const stmt = batteryId ? env.DB.prepare(query).bind(scenarioId, batteryId) : env.DB.prepare(query).bind(scenarioId);
  let runId: string | undefined;
  try {
    const row = await stmt.first<{ id: string }>();
    runId = row?.id;
  } catch (error) {
    console.warn('[grid] baseline lookup failed:', error instanceof Error ? error.message : error);
    return { option: null, stability: 0 };
  }
  if (!runId) return { option: null, stability: 0 };
  const outputs = await loadAgentOutputsWithThreeLayer(env, runId);
  return computeBaselineModal(outputs as AgentOutput[], profileId);
}

function setAxisEndpoint(profile: ValueProfile, axisId: JudgeAxisId, endpoint: 0.2 | 0.8): ValueProfile {
  const legacy = AXIS_JUDGE_TO_LEGACY[axisId];
  const level: 'high' | 'low' = endpoint === 0.8 ? 'high' : 'low';
  const newWeights = profile.axisWeights.map((weight) => {
    if (weight.axis !== legacy) return weight;
    return { ...weight, value: endpoint, level };
  });
  return { ...profile, name: `${profile.name} (${axisId}=${level})`, axisWeights: newWeights };
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

export { ALL_AXES, ALL_PROFILES, AXIS_LEGACY_TO_JUDGE, AXIS_JUDGE_TO_LEGACY };
