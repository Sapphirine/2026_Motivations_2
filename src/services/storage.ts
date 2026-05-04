import { presetScenarios, valueProfiles } from '../domain/seeds';
import type {
  AgentOutput,
  Env,
  ExperimentRun,
  JudgeAxisId,
  ProfileId,
  SameProfileBaselineRun,
  Scenario,
  SensitivityGridCell,
  SensitivityGridCellError,
  SensitivityGridJob,
  SensitivityGridStatus,
  SensitivityRun,
  ValueProfile,
} from '../domain/types';

const runs = new Map<string, ExperimentRun>();
const idempotency = new Map<string, string>();
const customScenarios = new Map<string, Scenario>();
const sensitivityRuns = new Map<string, SensitivityRun[]>();
const unavailableD1 = new WeakSet<D1Database>();
const initializedD1 = new WeakSet<D1Database>();
const seededD1 = new WeakSet<D1Database>();

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function id(prefix: string): string {
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return `${prefix}_${random}`;
}

export function listScenarios(): Scenario[] {
  return [...presetScenarios, ...customScenarios.values()];
}

export function getScenario(scenarioId: string): Scenario | undefined {
  return listScenarios().find((scenario) => scenario.id === scenarioId);
}

export async function createCustomScenario(env: Env, input: Omit<Scenario, 'id' | 'kind' | 'version' | 'createdAt' | 'updatedAt' | 'disclaimer'>): Promise<Scenario> {
  const createdAt = nowSeconds();
  const scenario: Scenario = {
    ...input,
    id: id('scenario'),
    kind: 'custom',
    disclaimer: 'This is a fictional AI workflow adoption case. Outputs are research artifacts for comparing motivational intervention alignment and must not be used as HR, employment, legal, or performance-management advice.',
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
  customScenarios.set(scenario.id, scenario);
  // FIX 1: persist the new custom scenario into D1 so a subsequent
  // experiment_runs INSERT referencing this scenario_id does not FK-fail.
  // ensureSeedsInD1 also covers presets in the same call site.
  if (env.DB && !unavailableD1.has(env.DB)) {
    await ensureSeedsInD1(env);
    try {
      await tryPersist(() => env.DB!.prepare(`
        INSERT OR IGNORE INTO scenarios (
          id, kind, title, domain, context, decision_options_json, stakeholders_json,
          tradeoffs_json, conflict_notes, disclaimer, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        scenario.id,
        scenario.kind,
        scenario.title,
        scenario.domain,
        scenario.context,
        JSON.stringify(scenario.decisionOptions),
        JSON.stringify(scenario.stakeholders),
        JSON.stringify(scenario.tradeoffs),
        scenario.conflictNotes,
        scenario.disclaimer,
        scenario.version,
        scenario.createdAt,
        scenario.updatedAt,
      ).run().then(() => undefined), env.DB);
    } catch (error) {
      console.error('[d1] custom scenario persist failed:', error instanceof Error ? error.message : error);
      // Non-fatal — the scenario is in-memory, so subsequent run will
      // still work in the in-memory fallback path.
    }
  }
  return scenario;
}

export function listProfiles(): ValueProfile[] {
  return valueProfiles;
}

export function getProfiles(profileIds: string[]): ValueProfile[] {
  return profileIds.map((profileId) => valueProfiles.find((profile) => profile.id === profileId)).filter((profile): profile is ValueProfile => Boolean(profile));
}

export function getRun(runId: string): ExperimentRun | undefined {
  return runs.get(runId);
}

export function getRunByIdempotencyKey(key: string): ExperimentRun | undefined {
  const runId = idempotency.get(key);
  return runId ? runs.get(runId) : undefined;
}

/**
 * D1-authoritative idempotency lookup. Returns the persisted run if a row
 * with this idempotency_key already exists. The in-memory map is a hot
 * cache only; the D1 unique constraint on `experiment_runs.idempotency_key`
 * is the source of truth.
 *
 * Stale-`running` recovery (C2 defense-in-depth):
 * If we find a row stuck in `running` whose `created_at` is older than
 * 2x the configured run timeout, we treat it as failed for retry purposes
 * (return as `failed` so callers can re-enter `runExperiment` and the
 * D1 row will be overwritten via INSERT OR REPLACE in `saveRun`).
 * Without this, a Worker that crashed mid-run would leave the row
 * permanently `running` and any retry with the same Idempotency-Key would
 * dedupe to the wedged row forever.
 */
export async function findRunByIdempotencyKeyInD1(env: Env, key: string): Promise<ExperimentRun | undefined> {
  if (!env.DB || unavailableD1.has(env.DB)) return undefined;
  const row = await tryFirst(() => env.DB!.prepare(`
    SELECT id, scenario_id, scenario_snapshot_json, profile_ids_json, model_provider, model_name,
      generation_settings_json, status, idempotency_key, artifact_manifest_key, error_json,
      created_at, started_at, completed_at
    FROM experiment_runs
    WHERE idempotency_key = ?
    LIMIT 1
  `).bind(key).first<RunRow>(), env.DB);
  if (!row) return undefined;
  const hydrated = hydrateRunFromRow(row);
  // Stale-running recovery: if the run is `running` but older than twice
  // the configured run-timeout window, treat it as `failed` for retry
  // purposes. The retry path will overwrite the row via INSERT OR REPLACE.
  if (hydrated.status === 'running') {
    const runTimeoutSeconds = Number(env.RUN_TIMEOUT_SECONDS ?? 25);
    const stalenessSeconds = nowSeconds() - hydrated.createdAt;
    if (stalenessSeconds > runTimeoutSeconds * 2) {
      console.error('[d1] stale running run detected, marking failed for retry:', hydrated.id, 'age=', stalenessSeconds, 's');
      hydrated.status = 'failed';
    }
  }
  runs.set(hydrated.id, hydrated);
  idempotency.set(key, hydrated.id);
  return hydrated;
}

/**
 * Atomically reserve a run id by INSERTing the initial row into D1. If
 * another concurrent request already inserted the same idempotency key,
 * the UNIQUE constraint fires and we return the existing row instead of
 * making a duplicate provider call. D1 is authoritative; KV is only a
 * best-effort rate-limit signal.
 *
 * Returns: `{ reserved: true, run }` if this caller owns the new row, or
 * `{ reserved: false, run }` if another caller already has it.
 */
export async function reserveRunForIdempotency(env: Env, run: ExperimentRun): Promise<{ reserved: boolean; run: ExperimentRun }> {
  if (env.DB && !unavailableD1.has(env.DB)) {
    // FIX 1: ensure FK targets (scenarios + value_profiles) exist in D1
    // before the experiment_runs INSERT. Without this, a deployed Worker
    // with the migration applied but no seed data 500s with
    // `D1_ERROR: FOREIGN KEY constraint failed` on the first run.
    await ensureSeedsInD1(env);
    try {
      await tryPersist(() => insertNewRunToD1(env.DB as D1Database, run), env.DB);
      runs.set(run.id, run);
      if (run.idempotencyKey) idempotency.set(run.idempotencyKey, run.id);
      return { reserved: true, run };
    } catch (error) {
      if (isUniqueConstraintError(error) && run.idempotencyKey) {
        const existing = await findRunByIdempotencyKeyInD1(env, run.idempotencyKey);
        if (existing) return { reserved: false, run: existing };
      }
      if (isProductionEnv(env)) throw error;
    }
  }
  // Fallback: in-memory only. Useful for local dev without D1 or when D1
  // is flagged unavailable. Idempotency here is best-effort.
  if (run.idempotencyKey) {
    const existingId = idempotency.get(run.idempotencyKey);
    const existing = existingId ? runs.get(existingId) : undefined;
    if (existing) return { reserved: false, run: existing };
    idempotency.set(run.idempotencyKey, run.id);
  }
  runs.set(run.id, run);
  return { reserved: true, run };
}

export async function saveRun(env: Env, run: ExperimentRun): Promise<void> {
  if (env.DB && !unavailableD1.has(env.DB)) {
    const persisted = await tryPersist(() => persistRunToD1(env.DB as D1Database, run), env.DB);
    if (!persisted && isProductionEnv(env)) throw new Error('D1 persistence is unavailable in production.');
  }
  runs.set(run.id, run);
  if (run.idempotencyKey) idempotency.set(run.idempotencyKey, run.id);
}

export async function saveOutputs(env: Env, runId: string, outputs: AgentOutput[]): Promise<void> {
  const run = runs.get(runId);
  if (!run) return;
  if (env.DB && !unavailableD1.has(env.DB)) {
    // FIX 1: defensive seed — agent_outputs.profile_id FK -> value_profiles.id.
    await ensureSeedsInD1(env);
    for (const output of outputs) {
      const persisted = await tryPersist(() => persistOutputToD1(env.DB as D1Database, output), env.DB);
      if (!persisted && isProductionEnv(env)) throw new Error('D1 persistence is unavailable in production.');
    }
  }
  run.outputs = outputs;
  runs.set(runId, run);
}

export async function saveSensitivityRun(env: Env, sensitivityRun: SensitivityRun): Promise<void> {
  if (env.DB && !unavailableD1.has(env.DB)) {
    // FIX 1: defensive seed — sensitivity_runs.profile_id FK -> value_profiles.id.
    await ensureSeedsInD1(env);
    const persisted = await tryPersist(() => persistSensitivityToD1(env.DB as D1Database, sensitivityRun), env.DB);
    if (!persisted && isProductionEnv(env)) throw new Error('D1 persistence is unavailable in production.');
  }
  sensitivityRuns.set(sensitivityRun.baseRunId, [...(sensitivityRuns.get(sensitivityRun.baseRunId) ?? []), sensitivityRun]);
  const run = runs.get(sensitivityRun.baseRunId);
  if (run) run.sensitivityRuns = sensitivityRuns.get(sensitivityRun.baseRunId) ?? [];
}

export type LedgerEntry = {
  runId: string;
  scenarioId: string;
  scenarioTitle: string;
  status: string;
  modelProvider: string;
  modelName: string;
  createdAt: number;
  completedAt?: number;
  divergenceScore: number | null;
  hasFlip: boolean;
  artifactManifest: unknown;
};

/**
 * Compact run-summary shape for the evidence-ledger endpoint and the
 * Three-Layer Analysis tab's run-picker. Returns the columns needed to
 * uniquely identify a battery run plus its trial/profile metadata so the
 * front-end can group runs by `batteryId` and locate historical evidence.
 *
 * Distinct from `LedgerEntry` (which carries the legacy artifact-manifest
 * key) — this one carries the three-layer-redesign columns
 * (`profileIds`, `trialCount`, `batteryId`) added in migration 0003.
 */
export type RecentRunSummary = {
  runId: string;
  scenarioId: string;
  scenarioTitle: string;
  profileIds: ProfileId[];
  status: string;
  modelProvider: string;
  modelName: string;
  trialCount: number;
  batteryId: string | null;
  createdAt: number;
  completedAt: number | null;
};

export function listRuns(): ExperimentRun[] {
  return [...runs.values()].filter((run) => run.status !== 'running').sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * D1-authoritative recent-runs lookup for the evidence-ledger endpoint.
 *
 * Why this exists (FIX 2026-04-27, Lane E): the legacy `listLedgerEntries`
 * uses the pre-three-layer column set and does not surface `profileIds`,
 * `trialCount`, or `batteryId`. The Three-Layer Analysis tab needs those
 * three to discover historical battery runs without re-running the
 * battery, and the canonical-evidence aggregator needs them to reconstruct
 * the batteryId -> runId fan-out.
 *
 * Returns `RecentRunSummary[]` ordered by `created_at DESC`. When
 * `batteryId` is provided, filters to that battery only. Falls back to
 * the in-memory map (no D1 binding) returning the same shape.
 *
 * Forward-compatible with `experiment_runs` lacking `trial_count` /
 * `battery_id` (pre-migration-0003 deploys) — those columns default to
 * `1` / `null`.
 */
export async function listRecentRunsFromD1(env: Env, limit = 36, batteryId?: string): Promise<RecentRunSummary[]> {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 200));
  if (env.DB && !unavailableD1.has(env.DB)) {
    type RecentRow = {
      id: string;
      scenario_id: string;
      scenario_snapshot_json: string;
      profile_ids_json: string;
      model_provider: string;
      model_name: string;
      status: string;
      trial_count: number | null;
      battery_id: string | null;
      created_at: number;
      completed_at: number | null;
    };
    const baseSelect = `
      SELECT id, scenario_id, scenario_snapshot_json, profile_ids_json, model_provider, model_name,
        status, trial_count, battery_id, created_at, completed_at
      FROM experiment_runs
      WHERE status != 'running'
    `;
    let rows: D1Result<RecentRow> | null = null;
    try {
      rows = batteryId
        ? await tryQuery(() => env.DB!.prepare(`${baseSelect} AND battery_id = ? ORDER BY created_at DESC LIMIT ?`).bind(batteryId, safeLimit).all<RecentRow>(), env.DB)
        : await tryQuery(() => env.DB!.prepare(`${baseSelect} ORDER BY created_at DESC LIMIT ?`).bind(safeLimit).all<RecentRow>(), env.DB);
    } catch (error) {
      if (!isMissingColumnError(error)) throw error;
      // Migration 0003 not yet applied — fall back to legacy column set.
      const legacySelect = `
        SELECT id, scenario_id, scenario_snapshot_json, profile_ids_json, model_provider, model_name,
          status, created_at, completed_at
        FROM experiment_runs
        WHERE status != 'running'
        ORDER BY created_at DESC
        LIMIT ?
      `;
      type LegacyRow = Omit<RecentRow, 'trial_count' | 'battery_id'>;
      const legacyRows = await tryQuery(() => env.DB!.prepare(legacySelect).bind(safeLimit).all<LegacyRow>(), env.DB);
      if (!legacyRows || !legacyRows.results) return [];
      return legacyRows.results.map<RecentRunSummary>((row) => {
        const scenario = JSON.parse(row.scenario_snapshot_json) as Scenario;
        const profileIds = JSON.parse(row.profile_ids_json) as ProfileId[];
        return {
          runId: row.id,
          scenarioId: row.scenario_id,
          scenarioTitle: scenario.title,
          profileIds,
          status: row.status,
          modelProvider: row.model_provider,
          modelName: row.model_name,
          trialCount: 1,
          batteryId: null,
          createdAt: row.created_at,
          completedAt: row.completed_at,
        };
      });
    }
    if (rows && rows.results) {
      return rows.results.map<RecentRunSummary>((row) => {
        const scenario = JSON.parse(row.scenario_snapshot_json) as Scenario;
        const profileIds = JSON.parse(row.profile_ids_json) as ProfileId[];
        return {
          runId: row.id,
          scenarioId: row.scenario_id,
          scenarioTitle: scenario.title,
          profileIds,
          status: row.status,
          modelProvider: row.model_provider,
          modelName: row.model_name,
          trialCount: row.trial_count ?? 1,
          batteryId: row.battery_id,
          createdAt: row.created_at,
          completedAt: row.completed_at,
        };
      });
    }
  }
  // In-memory fallback — pre-D1 dev path.
  return listRuns()
    .filter((run) => !batteryId || run.batteryId === batteryId)
    .slice(0, safeLimit)
    .map<RecentRunSummary>((run) => ({
      runId: run.id,
      scenarioId: run.scenarioId,
      scenarioTitle: run.scenarioSnapshot.title,
      profileIds: run.profileIds,
      status: run.status,
      modelProvider: run.modelProvider,
      modelName: run.modelName,
      trialCount: run.trialCount ?? 1,
      batteryId: run.batteryId ?? null,
      createdAt: run.createdAt,
      completedAt: run.completedAt ?? null,
    }));
}

export async function listLedgerEntries(env: Env): Promise<LedgerEntry[]> {
  if (env.DB && !unavailableD1.has(env.DB)) {
    const rows = await tryQuery(() => env.DB!.prepare(`
      SELECT id, scenario_id, scenario_snapshot_json, model_provider, model_name, status,
        generation_settings_json, artifact_manifest_key, created_at, completed_at
      FROM experiment_runs
      WHERE status != 'running'
      ORDER BY created_at DESC
      LIMIT 50
    `).all<{
      id: string;
      scenario_id: string;
      scenario_snapshot_json: string;
      model_provider: string;
      model_name: string;
      status: string;
      artifact_manifest_key: string | null;
      created_at: number;
      completed_at: number | null;
    }>(), env.DB);
    if (rows) {
      return rows.results.map((row) => {
        const scenario = JSON.parse(row.scenario_snapshot_json) as Scenario;
        return {
          runId: row.id,
          scenarioId: row.scenario_id,
          scenarioTitle: scenario.title,
          status: row.status,
          modelProvider: row.model_provider,
          modelName: row.model_name,
          createdAt: row.created_at,
          completedAt: row.completed_at ?? undefined,
          divergenceScore: null,
          hasFlip: false,
          artifactManifest: row.artifact_manifest_key,
        };
      });
    }
  }
  return listRuns().map((run) => ({
    runId: run.id,
    scenarioId: run.scenarioId,
    scenarioTitle: run.scenarioSnapshot.title,
    status: run.status,
    modelProvider: run.modelProvider,
    modelName: run.modelName,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    divergenceScore: run.metrics.find((metric) => metric.metricType === 'divergence')?.metricValue ?? null,
    hasFlip: run.sensitivityRuns.some((sensitivityRun) => sensitivityRun.flipped),
    artifactManifest: run.artifactManifest ?? null,
  }));
}

export function getD1Mode(env: Env): 'available' | 'fallback' | 'unbound' {
  if (!env.DB) return 'unbound';
  return unavailableD1.has(env.DB) ? 'fallback' : 'available';
}

async function tryPersist(operation: () => Promise<void>, db: D1Database): Promise<boolean> {
  try {
    await operation();
    return true;
  } catch (error) {
    if (isMissingD1TableError(error) && !initializedD1.has(db)) {
      await initializeD1(db);
      initializedD1.add(db);
      await operation();
      return true;
    }
    if (isMissingD1TableError(error)) {
      unavailableD1.add(db);
      return false;
    }
    throw error;
  }
}

async function tryQuery<T>(operation: () => Promise<D1Result<T>>, db: D1Database): Promise<D1Result<T> | null> {
  try {
    return await operation();
  } catch (error) {
    if (isMissingD1TableError(error) && !initializedD1.has(db)) {
      await initializeD1(db);
      initializedD1.add(db);
      return await operation();
    }
    if (isMissingD1TableError(error)) {
      unavailableD1.add(db);
      return null;
    }
    throw error;
  }
}

/**
 * Variant of tryQuery for `.first<T>()` calls which return `T | null`
 * directly (no `D1Result` wrapper). Same auto-init semantics.
 */
async function tryFirst<T>(operation: () => Promise<T | null>, db: D1Database): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    if (isMissingD1TableError(error) && !initializedD1.has(db)) {
      await initializeD1(db);
      initializedD1.add(db);
      return await operation();
    }
    if (isMissingD1TableError(error)) {
      unavailableD1.add(db);
      return null;
    }
    throw error;
  }
}

/**
 * D1 surfaces "table missing" as a generic D1_ERROR with a "no such table"
 * substring. The match is intentionally narrow so unrelated errors propagate
 * normally. This is a brittle string-match against an SDK error message —
 * we log on the catch path so a future SDK rewording is loud, not silent
 * (the in-memory fallback would otherwise mask a real D1 outage).
 */
function isMissingD1TableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const matched = message.includes('D1_ERROR') && message.includes('no such table');
  if (matched) {
    console.error('[d1] missing table detected, will attempt auto-init or fall back to in-memory:', message);
  }
  return matched;
}

/**
 * Lazy seed of `scenarios` and `value_profiles` rows into D1.
 *
 * Why this exists (FIX 1, 2026-04-27): the migration `0001_initial.sql`
 * declares FK references `experiment_runs.scenario_id -> scenarios(id)`,
 * `agent_outputs.profile_id -> value_profiles(id)`, and
 * `sensitivity_runs.profile_id -> value_profiles(id)`. The Worker's seed
 * data lives in `src/domain/seeds.ts` and was previously never INSERTed
 * into the live D1 database, so the first `INSERT INTO experiment_runs`
 * failed with `D1_ERROR: FOREIGN KEY constraint failed` on the deployed
 * Worker.
 *
 * This helper INSERTs every preset adoption case and every motivation profile via
 * `INSERT OR IGNORE` (idempotent — re-applying is safe). It is called
 * lazily before any insert into `experiment_runs`/`agent_outputs`/
 * `sensitivity_runs`, gated by a module-level `WeakSet<D1Database>` so
 * the seed runs at most once per binding instance per Worker invocation.
 *
 * Custom (user-created) scenarios are also persisted here so a run that
 * uses a freshly-created custom scenario does not violate the FK either.
 */
export async function ensureSeedsInD1(env: Env): Promise<void> {
  if (!env.DB || unavailableD1.has(env.DB) || seededD1.has(env.DB)) return;
  const db = env.DB;
  try {
    const scenarioStatements = listScenarios().map((scenario) => db.prepare(`
      INSERT OR IGNORE INTO scenarios (
        id, kind, title, domain, context, decision_options_json, stakeholders_json,
        tradeoffs_json, conflict_notes, disclaimer, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      scenario.id,
      scenario.kind,
      scenario.title,
      scenario.domain,
      scenario.context,
      JSON.stringify(scenario.decisionOptions),
      JSON.stringify(scenario.stakeholders),
      JSON.stringify(scenario.tradeoffs),
      scenario.conflictNotes,
      scenario.disclaimer,
      scenario.version,
      scenario.createdAt,
      scenario.updatedAt,
    ));
    const profileStatements = listProfiles().map((profile) => db.prepare(`
      INSERT OR IGNORE INTO value_profiles (
        id, name, description, axis_weights_json, opposition_constraints_json,
        prompt_translation, is_baseline, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      profile.id,
      profile.name,
      profile.description,
      JSON.stringify(profile.axisWeights),
      JSON.stringify(profile.oppositionConstraints),
      profile.promptTranslation,
      profile.isBaseline ? 1 : 0,
      profile.version,
      profile.createdAt,
      profile.updatedAt,
    ));
    if (scenarioStatements.length || profileStatements.length) {
      await db.batch([...scenarioStatements, ...profileStatements]);
    }
    seededD1.add(db);
  } catch (error) {
    if (isMissingD1TableError(error) && !initializedD1.has(db)) {
      // Auto-init created the runs/outputs/sensitivity tables but not the
      // scenarios/value_profiles tables (those live in 0001 only). If those
      // are missing the binding is misconfigured — flag unavailable so we
      // fall back to in-memory rather than 500 every request.
      console.error('[d1] seed failed because base tables are missing — flagging D1 unavailable:', error instanceof Error ? error.message : error);
      unavailableD1.add(db);
      return;
    }
    // Don't poison the binding for transient errors — log and let the next
    // request retry the seed. We do NOT mark seededD1 here.
    console.error('[d1] ensureSeedsInD1 failed (will retry on next call):', error instanceof Error ? error.message : error);
    throw error;
  }
}

async function initializeD1(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS experiment_runs (
      id TEXT PRIMARY KEY,
      scenario_id TEXT NOT NULL,
      scenario_snapshot_json TEXT NOT NULL,
      profile_ids_json TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      model_name TEXT NOT NULL,
      generation_settings_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'partial')),
      idempotency_key TEXT UNIQUE,
      artifact_manifest_key TEXT,
      error_json TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS experiment_runs_status_idx ON experiment_runs(status)'),
    db.prepare('CREATE INDEX IF NOT EXISTS experiment_runs_created_idx ON experiment_runs(created_at)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_outputs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      profile_snapshot_json TEXT NOT NULL,
      translated_prompt TEXT NOT NULL,
      raw_output TEXT NOT NULL,
      structured_decision_json TEXT NOT NULL,
      drive_trace_json TEXT NOT NULL,
      confidence REAL,
      status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'retryable')),
      error_json TEXT,
      created_at INTEGER NOT NULL
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS agent_outputs_run_idx ON agent_outputs(run_id)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS sensitivity_runs (
      id TEXT PRIMARY KEY,
      base_run_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      axis_changes_json TEXT NOT NULL,
      rerun_output_id TEXT,
      original_decision_json TEXT NOT NULL,
      rerun_decision_json TEXT NOT NULL,
      flipped INTEGER NOT NULL,
      near_flip INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS sensitivity_runs_base_run_idx ON sensitivity_runs(base_run_id)'),
  ]);
}

function isProductionEnv(env: Env): boolean {
  return env.APP_ENV === 'production';
}

async function persistRunToD1(db: D1Database, run: ExperimentRun): Promise<void> {
  // Try the extended INSERT first (includes trial_count + battery_id from
  // migration 0003). If those columns are missing (D1 not yet migrated),
  // fall back to the legacy INSERT shape so the Worker keeps working
  // through a partial deploy.
  try {
    await db.prepare(`
      INSERT OR REPLACE INTO experiment_runs (
        id, scenario_id, scenario_snapshot_json, profile_ids_json, model_provider, model_name,
        generation_settings_json, status, idempotency_key, artifact_manifest_key, error_json,
        created_at, started_at, completed_at, trial_count, battery_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      run.id,
      run.scenarioId,
      JSON.stringify(run.scenarioSnapshot),
      JSON.stringify(run.profileIds),
      run.modelProvider,
      run.modelName,
      JSON.stringify(run.generationSettings),
      run.status,
      run.idempotencyKey ?? null,
      run.artifactManifest ? `runs/${run.id}/v${run.artifactManifest.artifactVersion}/manifest.json` : null,
      run.error ? JSON.stringify(run.error) : null,
      run.createdAt,
      run.startedAt ?? null,
      run.completedAt ?? null,
      run.trialCount ?? 1,
      run.batteryId ?? null,
    ).run();
  } catch (error) {
    if (isMissingColumnError(error)) {
      await db.prepare(`
        INSERT OR REPLACE INTO experiment_runs (
          id, scenario_id, scenario_snapshot_json, profile_ids_json, model_provider, model_name,
          generation_settings_json, status, idempotency_key, artifact_manifest_key, error_json,
          created_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        run.id,
        run.scenarioId,
        JSON.stringify(run.scenarioSnapshot),
        JSON.stringify(run.profileIds),
        run.modelProvider,
        run.modelName,
        JSON.stringify(run.generationSettings),
        run.status,
        run.idempotencyKey ?? null,
        run.artifactManifest ? `runs/${run.id}/v${run.artifactManifest.artifactVersion}/manifest.json` : null,
        run.error ? JSON.stringify(run.error) : null,
        run.createdAt,
        run.startedAt ?? null,
        run.completedAt ?? null,
      ).run();
      return;
    }
    throw error;
  }
}

/**
 * Strict INSERT (no OR REPLACE) so the UNIQUE(idempotency_key) constraint
 * surfaces a real D1 error we can branch on. Used by reserveRunForIdempotency
 * to detect duplicate idempotency keys before the LLM call.
 */
async function insertNewRunToD1(db: D1Database, run: ExperimentRun): Promise<void> {
  try {
    await db.prepare(`
      INSERT INTO experiment_runs (
        id, scenario_id, scenario_snapshot_json, profile_ids_json, model_provider, model_name,
        generation_settings_json, status, idempotency_key, artifact_manifest_key, error_json,
        created_at, started_at, completed_at, trial_count, battery_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      run.id,
      run.scenarioId,
      JSON.stringify(run.scenarioSnapshot),
      JSON.stringify(run.profileIds),
      run.modelProvider,
      run.modelName,
      JSON.stringify(run.generationSettings),
      run.status,
      run.idempotencyKey ?? null,
      run.artifactManifest ? `runs/${run.id}/v${run.artifactManifest.artifactVersion}/manifest.json` : null,
      run.error ? JSON.stringify(run.error) : null,
      run.createdAt,
      run.startedAt ?? null,
      run.completedAt ?? null,
      run.trialCount ?? 1,
      run.batteryId ?? null,
    ).run();
  } catch (error) {
    if (isMissingColumnError(error)) {
      await db.prepare(`
        INSERT INTO experiment_runs (
          id, scenario_id, scenario_snapshot_json, profile_ids_json, model_provider, model_name,
          generation_settings_json, status, idempotency_key, artifact_manifest_key, error_json,
          created_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        run.id,
        run.scenarioId,
        JSON.stringify(run.scenarioSnapshot),
        JSON.stringify(run.profileIds),
        run.modelProvider,
        run.modelName,
        JSON.stringify(run.generationSettings),
        run.status,
        run.idempotencyKey ?? null,
        run.artifactManifest ? `runs/${run.id}/v${run.artifactManifest.artifactVersion}/manifest.json` : null,
        run.error ? JSON.stringify(run.error) : null,
        run.createdAt,
        run.startedAt ?? null,
        run.completedAt ?? null,
      ).run();
      return;
    }
    throw error;
  }
}

function isMissingColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such column|table .* has no column named/i.test(message);
}

type RunRow = {
  id: string;
  scenario_id: string;
  scenario_snapshot_json: string;
  profile_ids_json: string;
  model_provider: string;
  model_name: string;
  generation_settings_json: string;
  status: string;
  idempotency_key: string | null;
  artifact_manifest_key: string | null;
  error_json: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
};

function hydrateRunFromRow(row: RunRow): ExperimentRun {
  const scenarioSnapshot = JSON.parse(row.scenario_snapshot_json) as Scenario;
  const profileIds = JSON.parse(row.profile_ids_json) as ExperimentRun['profileIds'];
  const generationSettings = JSON.parse(row.generation_settings_json) as ExperimentRun['generationSettings'];
  const error = row.error_json ? JSON.parse(row.error_json) as ExperimentRun['error'] : undefined;
  return {
    id: row.id,
    scenarioId: row.scenario_id,
    scenarioSnapshot,
    profileIds,
    modelProvider: row.model_provider as ExperimentRun['modelProvider'],
    modelName: row.model_name,
    generationSettings,
    status: row.status as ExperimentRun['status'],
    idempotencyKey: row.idempotency_key ?? undefined,
    outputs: [],
    metrics: [],
    sensitivityRuns: [],
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    error,
  };
}

/**
 * D1 surfaces UNIQUE-constraint violations as a `D1_ERROR` whose message
 * contains "UNIQUE constraint failed". This matcher is intentionally narrow
 * so unrelated errors (network, timeout, etc.) propagate normally.
 */
function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE constraint failed');
}

/**
 * Read-through helper used by the artifact endpoint. Tries D1 first, then
 * the in-memory cache. Returns undefined when neither has a record.
 *
 * GAP 1 fix (2026-04-27): added `hydrateOutputs` flag so the sensitivity
 * endpoint can recover the full `outputs` array from `agent_outputs` even
 * when the Worker isolate that ran the original experiment has rotated
 * away. Default `false` preserves the artifact endpoint's existing
 * behavior (manifest-only — outputs are already in R2 export.json).
 */
export async function getRunAuthoritative(env: Env, runId: string, options?: { hydrateOutputs?: boolean }): Promise<ExperimentRun | undefined> {
  if (env.DB && !unavailableD1.has(env.DB)) {
    const row = await tryFirst(() => env.DB!.prepare(`
      SELECT id, scenario_id, scenario_snapshot_json, profile_ids_json, model_provider, model_name,
        generation_settings_json, status, idempotency_key, artifact_manifest_key, error_json,
        created_at, started_at, completed_at
      FROM experiment_runs
      WHERE id = ?
      LIMIT 1
    `).bind(runId).first<RunRow>(), env.DB);
    if (row) {
      const hydrated = hydrateRunFromRow(row);
      // Prefer the in-memory copy when present so the caller sees the most
      // recent outputs/metrics/synthesis (D1 has the row but cached in-memory
      // has the full graph for the current request lifecycle).
      const cached = runs.get(runId);
      const merged = cached ? { ...cached, status: hydrated.status } : hydrated;
      // GAP 1 fix: when the caller needs the agent_outputs (sensitivity
      // rerun comparing original-vs-perturbed decisions), and the
      // in-memory copy is empty (post-isolate-rotation), refill from D1.
      if (options?.hydrateOutputs && (!merged.outputs || merged.outputs.length === 0)) {
        const outputs = await loadAgentOutputsForRun(env, runId);
        if (outputs.length > 0) {
          merged.outputs = outputs;
          runs.set(runId, merged);
        }
      }
      return merged;
    }
  }
  return runs.get(runId);
}

type OutputRow = {
  id: string;
  run_id: string;
  profile_id: string;
  profile_snapshot_json: string;
  translated_prompt: string;
  raw_output: string;
  structured_decision_json: string;
  drive_trace_json: string;
  confidence: number | null;
  status: string;
  error_json: string | null;
  created_at: number;
};

/**
 * Load all agent_outputs rows for a run from D1 and reconstruct
 * AgentOutput[]. Used by getRunAuthoritative when the caller passes
 * `hydrateOutputs: true` (sensitivity rerun, which needs the original
 * decision per profile to compare against the perturbed-rerun decision).
 *
 * Returns [] (not throwing) when D1 is unavailable or the row set is
 * empty so callers can fall back to in-memory / 400 cleanly.
 */
async function loadAgentOutputsForRun(env: Env, runId: string): Promise<AgentOutput[]> {
  if (!env.DB || unavailableD1.has(env.DB)) return [];
  const rows = await tryQuery(() => env.DB!.prepare(`
    SELECT id, run_id, profile_id, profile_snapshot_json, translated_prompt, raw_output,
      structured_decision_json, drive_trace_json, confidence, status, error_json, created_at
    FROM agent_outputs
    WHERE run_id = ?
    ORDER BY created_at ASC
  `).bind(runId).all<OutputRow>(), env.DB);
  if (!rows || !rows.results) return [];
  return rows.results.map<AgentOutput>((row) => ({
    id: row.id,
    runId: row.run_id,
    profileId: row.profile_id as AgentOutput['profileId'],
    profileSnapshot: JSON.parse(row.profile_snapshot_json) as ValueProfile,
    translatedPrompt: row.translated_prompt,
    rawOutput: row.raw_output,
    structuredDecision: JSON.parse(row.structured_decision_json) as AgentOutput['structuredDecision'],
    driveTrace: JSON.parse(row.drive_trace_json) as AgentOutput['driveTrace'],
    confidence: row.confidence,
    status: row.status as AgentOutput['status'],
    error: row.error_json ? JSON.parse(row.error_json) as AgentOutput['error'] : undefined,
    createdAt: row.created_at,
  }));
}

async function persistOutputToD1(db: D1Database, output: AgentOutput): Promise<void> {
  // Try the extended INSERT first (trial_index + three-layer columns from
  // 0003). Fall back to the legacy 12-column shape if the columns are
  // not yet present (D1 not migrated).
  try {
    await db.prepare(`
      INSERT OR REPLACE INTO agent_outputs (
        id, run_id, profile_id, profile_snapshot_json, translated_prompt, raw_output,
        structured_decision_json, drive_trace_json, confidence, status, error_json, created_at,
        trial_index, judge_axis, judge_confidence, judge_reasoning,
        rationale_drives, rationale_top_axis, rationale_resolution,
        alignment_pattern, three_layer_completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      output.id,
      output.runId,
      output.profileId,
      JSON.stringify(output.profileSnapshot),
      output.translatedPrompt,
      output.rawOutput,
      JSON.stringify(output.structuredDecision),
      JSON.stringify(output.driveTrace),
      output.confidence,
      output.status,
      output.error ? JSON.stringify(output.error) : null,
      output.createdAt,
      output.trialIndex ?? 0,
      output.judgeAxis ?? null,
      output.judgeConfidence ?? null,
      output.judgeReasoning ?? null,
      output.rationaleDrives ? JSON.stringify(output.rationaleDrives) : null,
      output.rationaleTopAxis ?? null,
      output.rationaleResolution ?? null,
      output.alignmentPattern ?? null,
      output.threeLayerCompletedAt ?? null,
    ).run();
  } catch (error) {
    if (isMissingColumnError(error)) {
      await db.prepare(`
        INSERT OR REPLACE INTO agent_outputs (
          id, run_id, profile_id, profile_snapshot_json, translated_prompt, raw_output,
          structured_decision_json, drive_trace_json, confidence, status, error_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        output.id,
        output.runId,
        output.profileId,
        JSON.stringify(output.profileSnapshot),
        output.translatedPrompt,
        output.rawOutput,
        JSON.stringify(output.structuredDecision),
        JSON.stringify(output.driveTrace),
        output.confidence,
        output.status,
        output.error ? JSON.stringify(output.error) : null,
        output.createdAt,
      ).run();
      return;
    }
    throw error;
  }
}

/**
 * Update only the three-layer columns for a single agent_outputs row.
 * Used by /three-layer-analysis. Idempotent — re-running on a row that
 * already has these columns populated is a no-op DB-side (overwrite).
 */
export async function updateAgentOutputThreeLayer(env: Env, output: AgentOutput): Promise<void> {
  if (!env.DB || unavailableD1.has(env.DB)) {
    // In-memory fallback: the caller already mutated the in-memory object;
    // nothing else to do.
    return;
  }
  try {
    await env.DB.prepare(`
      UPDATE agent_outputs
      SET judge_axis = ?, judge_confidence = ?, judge_reasoning = ?,
          rationale_drives = ?, rationale_top_axis = ?, rationale_resolution = ?,
          alignment_pattern = ?, three_layer_completed_at = ?
      WHERE id = ?
    `).bind(
      output.judgeAxis ?? null,
      output.judgeConfidence ?? null,
      output.judgeReasoning ?? null,
      output.rationaleDrives ? JSON.stringify(output.rationaleDrives) : null,
      output.rationaleTopAxis ?? null,
      output.rationaleResolution ?? null,
      output.alignmentPattern ?? null,
      output.threeLayerCompletedAt ?? null,
      output.id,
    ).run();
  } catch (error) {
    if (isMissingColumnError(error)) {
      console.warn('[d1] three-layer columns missing on agent_outputs — migration 0003 not applied');
      return;
    }
    throw error;
  }
}

// ===== Sensitivity Grid Job storage helpers =====

export async function insertGridJob(env: Env, job: SensitivityGridJob): Promise<{ inserted: boolean; job: SensitivityGridJob }> {
  if (!env.DB || unavailableD1.has(env.DB)) {
    return { inserted: true, job };
  }
  try {
    await env.DB.prepare(`
      INSERT INTO sensitivity_grid_jobs (
        id, battery_id, status, total_cells, completed_cells, failed_cells, error_budget,
        scenario_ids_json, profile_ids_json, axis_ids_json, results_json, errors_json,
        idempotency_key, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      job.id,
      job.batteryId ?? null,
      job.status,
      job.totalCells,
      job.completedCells,
      job.failedCells,
      job.errorBudget,
      JSON.stringify(job.scenarioIds),
      JSON.stringify(job.profileIds),
      JSON.stringify(job.axisIds),
      JSON.stringify(job.results),
      JSON.stringify(job.errors),
      job.idempotencyKey ?? null,
      job.createdAt,
      job.updatedAt,
      job.completedAt ?? null,
    ).run();
    return { inserted: true, job };
  } catch (error) {
    if (isUniqueConstraintError(error) && job.idempotencyKey) {
      const existing = await getGridJobByIdempotencyKey(env, job.idempotencyKey);
      if (existing) return { inserted: false, job: existing };
    }
    throw error;
  }
}

export async function updateGridJob(env: Env, job: SensitivityGridJob): Promise<void> {
  if (!env.DB || unavailableD1.has(env.DB)) return;
  await env.DB.prepare(`
    UPDATE sensitivity_grid_jobs
    SET status = ?, completed_cells = ?, failed_cells = ?, updated_at = ?,
        results_json = ?, errors_json = ?, completed_at = ?
    WHERE id = ?
  `).bind(
    job.status,
    job.completedCells,
    job.failedCells,
    job.updatedAt,
    JSON.stringify(job.results),
    JSON.stringify(job.errors),
    job.completedAt ?? null,
    job.id,
  ).run();
}

export async function getGridJob(env: Env, jobId: string): Promise<SensitivityGridJob | undefined> {
  if (!env.DB || unavailableD1.has(env.DB)) return undefined;
  const row = await tryFirst(() => env.DB!.prepare(`
    SELECT id, battery_id, status, total_cells, completed_cells, failed_cells, error_budget,
      scenario_ids_json, profile_ids_json, axis_ids_json, results_json, errors_json,
      idempotency_key, created_at, updated_at, completed_at
    FROM sensitivity_grid_jobs
    WHERE id = ?
    LIMIT 1
  `).bind(jobId).first<GridJobRow>(), env.DB);
  return row ? hydrateGridJobRow(row) : undefined;
}

export async function getGridJobByIdempotencyKey(env: Env, key: string): Promise<SensitivityGridJob | undefined> {
  if (!env.DB || unavailableD1.has(env.DB)) return undefined;
  const row = await tryFirst(() => env.DB!.prepare(`
    SELECT id, battery_id, status, total_cells, completed_cells, failed_cells, error_budget,
      scenario_ids_json, profile_ids_json, axis_ids_json, results_json, errors_json,
      idempotency_key, created_at, updated_at, completed_at
    FROM sensitivity_grid_jobs
    WHERE idempotency_key = ?
    LIMIT 1
  `).bind(key).first<GridJobRow>(), env.DB);
  return row ? hydrateGridJobRow(row) : undefined;
}

export async function getGridJobByBatteryId(env: Env, batteryId: string): Promise<SensitivityGridJob | undefined> {
  if (!env.DB || unavailableD1.has(env.DB)) return undefined;
  const row = await tryFirst(() => env.DB!.prepare(`
    SELECT id, battery_id, status, total_cells, completed_cells, failed_cells, error_budget,
      scenario_ids_json, profile_ids_json, axis_ids_json, results_json, errors_json,
      idempotency_key, created_at, updated_at, completed_at
    FROM sensitivity_grid_jobs
    WHERE battery_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(batteryId).first<GridJobRow>(), env.DB);
  return row ? hydrateGridJobRow(row) : undefined;
}

/**
 * Fetch the most recent completed-or-partial grid job (used by
 * GET /api/findings/heatmap). Returns undefined if no job has reached a
 * terminal state.
 */
export async function getMostRecentTerminalGridJob(env: Env): Promise<SensitivityGridJob | undefined> {
  if (!env.DB || unavailableD1.has(env.DB)) return undefined;
  const row = await tryFirst(() => env.DB!.prepare(`
    SELECT id, battery_id, status, total_cells, completed_cells, failed_cells, error_budget,
      scenario_ids_json, profile_ids_json, axis_ids_json, results_json, errors_json,
      idempotency_key, created_at, updated_at, completed_at
    FROM sensitivity_grid_jobs
    WHERE status IN ('completed', 'partial', 'running')
    ORDER BY created_at DESC
    LIMIT 1
  `).first<GridJobRow>(), env.DB);
  return row ? hydrateGridJobRow(row) : undefined;
}

/**
 * Fetch the canonical grid job for the Boundary Map heatmap.
 *
 * Filters out probe / partial-stub jobs that pollute the most-recent
 * lookup. The default heatmap view requires:
 *   - total_cells === 144   (canonical 9×16 shape)
 *   - status IN ('completed','partial')
 *   - completed_cells >= 100  (enough density for the map to be useful)
 *
 * Tie-break: most recent (`created_at DESC`).
 *
 * If `gridJobId` is provided, the filter is bypassed and the explicit job
 * is returned regardless of size/density (used by the `?gridJobId=` query
 * param so reviewers can pin a specific job).
 *
 * Returns undefined if no qualifying job exists.
 */
export async function getCanonicalHeatmapGridJob(
  env: Env,
  gridJobId?: string,
): Promise<SensitivityGridJob | undefined> {
  if (!env.DB || unavailableD1.has(env.DB)) return undefined;
  if (gridJobId) {
    return getGridJob(env, gridJobId);
  }
  const row = await tryFirst(() => env.DB!.prepare(`
    SELECT id, battery_id, status, total_cells, completed_cells, failed_cells, error_budget,
      scenario_ids_json, profile_ids_json, axis_ids_json, results_json, errors_json,
      idempotency_key, created_at, updated_at, completed_at
    FROM sensitivity_grid_jobs
    WHERE status IN ('completed', 'partial')
      AND total_cells = 144
      AND completed_cells >= 100
    ORDER BY created_at DESC
    LIMIT 1
  `).first<GridJobRow>(), env.DB);
  return row ? hydrateGridJobRow(row) : undefined;
}

type GridJobRow = {
  id: string;
  battery_id: string | null;
  status: string;
  total_cells: number;
  completed_cells: number;
  failed_cells: number;
  error_budget: number;
  scenario_ids_json: string;
  profile_ids_json: string;
  axis_ids_json: string;
  results_json: string;
  errors_json: string;
  idempotency_key: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

function hydrateGridJobRow(row: GridJobRow): SensitivityGridJob {
  return {
    id: row.id,
    batteryId: row.battery_id ?? undefined,
    status: row.status as SensitivityGridStatus,
    totalCells: row.total_cells,
    completedCells: row.completed_cells,
    failedCells: row.failed_cells,
    errorBudget: row.error_budget,
    scenarioIds: JSON.parse(row.scenario_ids_json) as string[],
    profileIds: JSON.parse(row.profile_ids_json) as ProfileId[],
    axisIds: JSON.parse(row.axis_ids_json) as JudgeAxisId[],
    results: JSON.parse(row.results_json) as SensitivityGridCell[],
    errors: JSON.parse(row.errors_json) as SensitivityGridCellError[],
    idempotencyKey: row.idempotency_key ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

// ===== Same-profile baseline storage =====

export async function insertSameProfileBaselineRun(env: Env, baseline: SameProfileBaselineRun): Promise<void> {
  if (!env.DB || unavailableD1.has(env.DB)) return;
  try {
    await env.DB.prepare(`
      INSERT OR REPLACE INTO same_profile_baseline_runs (
        id, battery_id, scenario_id, profile_id, trial, selected_option, raw_output, rationale, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      baseline.id,
      baseline.batteryId ?? null,
      baseline.scenarioId,
      baseline.profileId,
      baseline.trial,
      baseline.selectedOption,
      baseline.rawOutput,
      baseline.rationale,
      baseline.createdAt,
    ).run();
  } catch (error) {
    if (isMissingD1TableError(error)) {
      console.warn('[d1] same_profile_baseline_runs missing — migration 0003 not applied');
      return;
    }
    throw error;
  }
}

// ===== Three-Layer aggregation =====

/**
 * Aggregate alignment-pattern counts across all completed three-layer
 * analyses (per /api/findings/alignment-patterns response shape).
 * Returns totals plus per-profile and per-scenario breakdowns.
 */
export async function aggregateAlignmentPatterns(env: Env): Promise<{
  totals: Record<string, number>;
  byProfile: Record<string, Record<string, number>>;
  byScenario: Record<string, Record<string, number>>;
}> {
  const empty = { Aligned: 0, Rationalizing: 0, Drifting: 0, Contradictory: 0 };
  const totals: Record<string, number> = { ...empty };
  const byProfile: Record<string, Record<string, number>> = {};
  const byScenario: Record<string, Record<string, number>> = {};

  if (!env.DB || unavailableD1.has(env.DB)) {
    return { totals, byProfile, byScenario };
  }

  const rows = await tryQuery(() => env.DB!.prepare(`
    SELECT ao.profile_id AS profile_id, ao.alignment_pattern AS pattern, er.scenario_id AS scenario_id
    FROM agent_outputs ao
    JOIN experiment_runs er ON ao.run_id = er.id
    WHERE ao.alignment_pattern IS NOT NULL
  `).all<{ profile_id: string; pattern: string; scenario_id: string }>(), env.DB);

  if (!rows || !rows.results) return { totals, byProfile, byScenario };

  for (const row of rows.results) {
    if (!totals[row.pattern]) totals[row.pattern] = 0;
    totals[row.pattern] += 1;

    if (!byProfile[row.profile_id]) byProfile[row.profile_id] = { ...empty };
    byProfile[row.profile_id][row.pattern] = (byProfile[row.profile_id][row.pattern] ?? 0) + 1;

    if (!byScenario[row.scenario_id]) byScenario[row.scenario_id] = { ...empty };
    byScenario[row.scenario_id][row.pattern] = (byScenario[row.scenario_id][row.pattern] ?? 0) + 1;
  }

  return { totals, byProfile, byScenario };
}

/**
 * Load all agent_outputs rows for a run, INCLUDING the three-layer columns,
 * for the three-layer-analysis endpoint. Different from loadAgentOutputsForRun
 * which intentionally returns the legacy column set only.
 */
export async function loadAgentOutputsWithThreeLayer(env: Env, runId: string): Promise<AgentOutput[]> {
  const cachedOutputs = runs.get(runId)?.outputs ?? [];
  if (!env.DB || unavailableD1.has(env.DB)) return cachedOutputs;
  let rows: D1Result<ExtendedOutputRow> | null = null;
  try {
    rows = await tryQuery(() => env.DB!.prepare(`
      SELECT id, run_id, profile_id, profile_snapshot_json, translated_prompt, raw_output,
        structured_decision_json, drive_trace_json, confidence, status, error_json, created_at,
        trial_index, judge_axis, judge_confidence, judge_reasoning,
        rationale_drives, rationale_top_axis, rationale_resolution,
        alignment_pattern, three_layer_completed_at
      FROM agent_outputs
      WHERE run_id = ?
      ORDER BY profile_id ASC, trial_index ASC, created_at ASC
    `).bind(runId).all<ExtendedOutputRow>(), env.DB);
  } catch {
    return cachedOutputs;
  }
  if (!rows || !Array.isArray(rows.results)) return cachedOutputs;
  if (rows.results.length === 0) return [];
  return rows.results.map<AgentOutput>((row) => ({
    id: row.id,
    runId: row.run_id,
    profileId: row.profile_id as ProfileId,
    profileSnapshot: JSON.parse(row.profile_snapshot_json) as ValueProfile,
    translatedPrompt: row.translated_prompt,
    rawOutput: row.raw_output,
    structuredDecision: JSON.parse(row.structured_decision_json) as AgentOutput['structuredDecision'],
    driveTrace: JSON.parse(row.drive_trace_json) as AgentOutput['driveTrace'],
    confidence: row.confidence,
    status: row.status as AgentOutput['status'],
    error: row.error_json ? JSON.parse(row.error_json) as AgentOutput['error'] : undefined,
    createdAt: row.created_at,
    trialIndex: row.trial_index ?? 0,
    judgeAxis: (row.judge_axis as AgentOutput['judgeAxis']) ?? null,
    judgeConfidence: row.judge_confidence,
    judgeReasoning: row.judge_reasoning,
    rationaleDrives: row.rationale_drives ? JSON.parse(row.rationale_drives) as AgentOutput['rationaleDrives'] : null,
    rationaleTopAxis: (row.rationale_top_axis as AgentOutput['rationaleTopAxis']) ?? null,
    rationaleResolution: (row.rationale_resolution as AgentOutput['rationaleResolution']) ?? null,
    alignmentPattern: (row.alignment_pattern as AgentOutput['alignmentPattern']) ?? null,
    threeLayerCompletedAt: row.three_layer_completed_at,
  }));
}

type ExtendedOutputRow = OutputRow & {
  trial_index: number | null;
  judge_axis: string | null;
  judge_confidence: number | null;
  judge_reasoning: string | null;
  rationale_drives: string | null;
  rationale_top_axis: string | null;
  rationale_resolution: string | null;
  alignment_pattern: string | null;
  three_layer_completed_at: number | null;
};

async function persistSensitivityToD1(db: D1Database, sensitivityRun: SensitivityRun): Promise<void> {
  await db.prepare(`
    INSERT OR REPLACE INTO sensitivity_runs (
      id, base_run_id, profile_id, axis_changes_json, rerun_output_id, original_decision_json,
      rerun_decision_json, flipped, near_flip, status, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    sensitivityRun.id,
    sensitivityRun.baseRunId,
    sensitivityRun.profileId,
    JSON.stringify(sensitivityRun.axisChanges),
    null,
    JSON.stringify(sensitivityRun.originalDecision),
    JSON.stringify(sensitivityRun.rerunDecision),
    sensitivityRun.flipped ? 1 : 0,
    sensitivityRun.nearFlip ? 1 : 0,
    sensitivityRun.status,
    sensitivityRun.createdAt,
    sensitivityRun.completedAt ?? null,
  ).run();
}
