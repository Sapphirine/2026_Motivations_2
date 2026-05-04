import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { z } from 'zod';
import {
  canonicalBatterySchema,
  customScenarioSchema,
  questionSchema,
  retryProfileSchema,
  runExperimentSchema,
  sensitivityGridRetryFailedSchema,
  sensitivityGridSchema,
  sensitivitySchema,
  threeLayerSchema,
} from './api/schemas';
import type { Env, ProblemDetails } from './domain/types';
import { isArtifactExpired, readRunExport, readRunManifest } from './services/artifacts';
import { retryProfileForRun, runExperiment, runSensitivity } from './services/experiment';
import { ProblemError, problem } from './services/problem';
import { answerScenarioQuestion, sanitizeUserKey } from './services/provider';
import {
  aggregateAlignmentPatterns,
  createCustomScenario,
  getCanonicalHeatmapGridJob,
  getD1Mode,
  getGridJob,
  getGridJobByBatteryId,
  getRun,
  getRunAuthoritative,
  getScenario,
  listLedgerEntries,
  listProfiles,
  listRecentRunsFromD1,
  listRuns,
  listScenarios,
  nowSeconds,
  updateGridJob,
} from './services/storage';
import { getConfig } from './services/config';
import { runThreeLayerAnalysis } from './analysis/three-layer-runner';
import { runGridBatches, runGridErrorRetries, startSensitivityGridJob } from './experiments/sensitivity-grid';
import { startCanonicalBattery } from './experiments/canonical-battery';
import { evaluateAdoptionReadiness, evaluateCanonicalBattery } from './experiments/adoption-evaluation';

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  const origin = c.req.header('origin');
  const allowedOrigins = (c.env.ALLOWED_ORIGINS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  if (origin && allowedOrigins.includes(origin)) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Vary', 'Origin');
  }
  c.header('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key, X-OpenAI-Key');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
});

app.onError((error, c) => {
  if (error instanceof ProblemError) {
    return c.json(error.details, error.details.status as 400 | 404 | 500);
  }
  if (isProblemDetails(error)) {
    return c.json(error, error.status as 400 | 404 | 500);
  }
  console.error('[onError] unhandled error on', c.req.path, error instanceof Error ? error.message : error);
  return c.json(problem(500, 'Internal server error', 'Unexpected server error.', c.req.path), 500);
});

function rateLimit(endpointTag: string) {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const limit = Number(c.env.RUN_RATE_LIMIT ?? 12);
    const windowSeconds = Number(c.env.RUN_RATE_LIMIT_WINDOW_SECONDS ?? 3600);
    if (!c.env.CACHE || !Number.isFinite(limit) || limit <= 0) {
      return next();
    }
    const clientIp = c.req.header('cf-connecting-ip') ?? 'unknown';
    const bucketKey = `rl:${clientIp}:${endpointTag}`;
    const raw = await c.env.CACHE.get(bucketKey);
    const current = raw ? Number.parseInt(raw, 10) : 0;
    const safeCurrent = Number.isFinite(current) && current >= 0 ? current : 0;
    if (safeCurrent >= limit) {
      const retryAfter = Math.max(1, windowSeconds);
      c.header('Retry-After', String(retryAfter));
      const body = problem(429, 'Rate limit exceeded', `Too many requests for ${endpointTag}. Limit is ${limit} per ${windowSeconds}s window.`, c.req.path);
      return c.json(body, 429);
    }
    await c.env.CACHE.put(bucketKey, String(safeCurrent + 1), { expirationTtl: windowSeconds });
    return next();
  };
}

app.get('/', (c) => c.json({
  service: 'motiveops-api',
  message: 'This is the local backend API. Open the frontend UI at http://localhost:5173.',
  frontend: 'http://localhost:5173',
  diagnostics: '/api/diagnostics',
  usefulRoutes: [
    '/api/diagnostics',
    '/api/scenarios',
    '/api/value-profiles',
  ],
}));

app.get('/api/health', async (c) => {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};
  if (c.env.DB) {
    try {
      const row = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
      checks.d1 = { ok: row?.ok === 1 };
    } catch (error) {
      checks.d1 = { ok: false, detail: error instanceof Error ? error.message : 'D1 query failed' };
    }
  } else {
    checks.d1 = { ok: false, detail: 'binding not configured' };
  }
  if (c.env.CACHE) {
    try {
      const heartbeatKey = 'health:heartbeat';
      const stamp = String(Math.floor(Date.now() / 1000));
      await c.env.CACHE.put(heartbeatKey, stamp, { expirationTtl: 60 });
      const readBack = await c.env.CACHE.get(heartbeatKey);
      checks.kv = { ok: readBack === stamp };
    } catch (error) {
      checks.kv = { ok: false, detail: error instanceof Error ? error.message : 'KV write/read failed' };
    }
  } else {
    checks.kv = { ok: false, detail: 'binding not configured' };
  }
  if (c.env.ARTIFACTS) {
    try {
      await c.env.ARTIFACTS.list({ prefix: 'runs/', limit: 1 });
      checks.r2 = { ok: true };
    } catch (error) {
      checks.r2 = { ok: false, detail: error instanceof Error ? error.message : 'R2 list failed' };
    }
  } else {
    checks.r2 = { ok: false, detail: 'binding not configured' };
  }
  const failed = Object.entries(checks).filter(([, value]) => !value.ok).map(([name]) => name);
  const body = {
    ok: failed.length === 0,
    service: 'motiveops-api',
    env: c.env.APP_ENV ?? 'local',
    d1: getD1Mode(c.env),
    bindings: checks,
  };
  return c.json(body, failed.length === 0 ? 200 : 503);
});

app.get('/api/diagnostics', async (c) => {
  const config = getConfig(c.env);
  const probe = async (run: () => Promise<unknown>): Promise<boolean> => {
    try { await run(); return true; } catch { return false; }
  };
  const [d1Ok, kvOk, r2Ok] = await Promise.all([
    c.env.DB ? probe(() => c.env.DB!.prepare('SELECT 1').first()) : Promise.resolve(false),
    c.env.CACHE ? probe(() => c.env.CACHE!.get('health:heartbeat')) : Promise.resolve(false),
    c.env.ARTIFACTS ? probe(() => c.env.ARTIFACTS!.list({ prefix: 'runs/', limit: 1 })) : Promise.resolve(false),
  ]);
  return c.json({
    appEnv: config.appEnv,
    demoMode: config.demoMode,
    openaiKeyConfigured: Boolean(c.env.OPENAI_API_KEY),
    openaiModel: config.openAIModel,
    openaiModelAllowlist: config.openAIModelAllowlist,
    runTimeoutSeconds: config.runTimeoutSeconds,
    rateLimitPerHour: Number(c.env.RUN_RATE_LIMIT ?? 12),
    rateLimitWindowSeconds: Number(c.env.RUN_RATE_LIMIT_WINDOW_SECONDS ?? 3600),
    bindings: {
      d1: { configured: Boolean(c.env.DB), lastProbeOk: d1Ok },
      kv: { configured: Boolean(c.env.CACHE), lastProbeOk: kvOk },
      r2: { configured: Boolean(c.env.ARTIFACTS), lastProbeOk: r2Ok },
    },
    schemaVersion: '2026-04-27-three-layer',
    features: {
      llmModeratorEnabled: true,
      threeLayerEnabled: true,
      sensitivityGridEnabled: true,
      userKeyAcceptHeader: 'X-OpenAI-Key',
    },
  });
});

app.get('/api/scenarios', (c) => c.json({
  scenarios: listScenarios().map((scenario) => ({
    id: scenario.id,
    kind: scenario.kind,
    title: scenario.title,
    domain: scenario.domain,
    stakeholderCount: scenario.stakeholders.length,
    optionCount: scenario.decisionOptions.length,
    version: scenario.version,
  })),
}));

app.get('/api/scenarios/:id', (c) => {
  const scenario = getScenario(c.req.param('id'));
  if (!scenario) return c.json(problem(404, 'Scenario not found', 'The requested scenario does not exist.', c.req.path), 404);
  return c.json({ scenario });
});

app.post('/api/scenarios/custom', rateLimit('scenarios-custom'), async (c) => {
  const parsed = customScenarioSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json(validationProblem(parsed.error, c.req.path), 400);
  return c.json({ scenario: await createCustomScenario(c.env, parsed.data) }, 201);
});

app.get('/api/value-profiles', (c) => c.json({ profiles: listProfiles() }));

app.post('/api/questions/answer', rateLimit('questions-answer'), async (c) => {
  const parsed = questionSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json(validationProblem(parsed.error, c.req.path), 400);
  const scenario = getScenario(parsed.data.scenarioId);
  if (!scenario) return c.json(problem(404, 'Scenario not found', 'The requested scenario does not exist.', c.req.path), 404);
  const profile = listProfiles().find((item) => item.id === parsed.data.profileId);
  if (!profile) return c.json(problem(400, 'Invalid profile', 'The requested profile does not exist.', c.req.path), 400);
  const userKey = sanitizeUserKey(c.req.header('x-openai-key'));
  return c.json({ result: await answerScenarioQuestion(c.env, scenario, profile, parsed.data.question, userKey) });
});

app.post('/api/experiments/run', rateLimit('experiments-run'), async (c) => {
  const body = await c.req.json();
  const idempotencyHeader = c.req.header('idempotency-key');
  const parsed = runExperimentSchema.safeParse({ ...body, idempotencyKey: body.idempotencyKey ?? idempotencyHeader });
  if (!parsed.success) return c.json(validationProblem(parsed.error, c.req.path), 400);
  const userKey = sanitizeUserKey(c.req.header('x-openai-key'));
  try {
    const run = await runExperiment(c.env, parsed.data, c.req.path, userKey);
    // Auto-fire three-layer analysis once the run completes (background).
    if ((run.status === 'completed' || run.status === 'partial') && run.outputs.length > 0) {
      c.executionCtx.waitUntil(runThreeLayerAnalysis(c.env, run.id, { force: false }, userKey).catch((error) => {
        console.warn('[experiments/run] three-layer waitUntil failed:', error instanceof Error ? error.message : error);
      }));
    }
    const body = {
      runId: run.id,
      status: run.status,
      run,
      detail: run.error?.detail ?? null,
    };
    return c.json(body, run.status === 'failed' ? 502 : 200);
  } catch (error) {
    if (error instanceof Error && /OpenAI auth failed/.test(error.message)) {
      const detail = userKey
        ? 'The X-OpenAI-Key header was rejected by OpenAI. Verify the key, or omit the header to use the server-configured key.'
        : 'The server-configured OpenAI key was rejected. Provide a valid X-OpenAI-Key header or contact the operator.';
      return c.json(problem(401, 'OpenAI authentication failed', detail, c.req.path), 401);
    }
    throw error;
  }
});

app.get('/api/experiments/runs', async (c) => {
  const limitParam = c.req.query('limit');
  const batteryIdParam = c.req.query('batteryId');
  const limitNum = limitParam ? Number.parseInt(limitParam, 10) : 20;
  const limit = Number.isFinite(limitNum) && limitNum > 0 ? Math.min(limitNum, 200) : 20;
  const runs = await listRecentRunsFromD1(c.env, limit, batteryIdParam ?? undefined);
  return c.json({
    runs: runs.map((run) => ({ ...run, hydratable: true, hydrateable: true })),
    generatedAt: nowSeconds(),
    batteryId: batteryIdParam ?? null,
    totalRuns: runs.length,
  });
});

app.get('/api/experiments/:runId', async (c) => {
  const run = await getRunAuthoritative(c.env, c.req.param('runId'), { hydrateOutputs: true });
  if (!run) return c.json(problem(404, 'Run not found', 'The requested experiment run does not exist.', c.req.path), 404);
  return c.json({ run });
});

app.post('/api/experiments/:runId/moderate', (c) => {
  const run = getRun(c.req.param('runId'));
  if (!run) return c.json(problem(404, 'Run not found', 'The requested experiment run does not exist.', c.req.path), 404);
  return c.json({
    synthesis: run.synthesis ?? null,
    metrics: run.metrics,
    aiCommentary: run.synthesis?.aiCommentary ?? null,
    aiCommentaryProvided: Boolean(run.synthesis?.aiCommentary),
  });
});

app.post('/api/experiments/:runId/sensitivity', async (c) => {
  const parsed = sensitivitySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json(validationProblem(parsed.error, c.req.path), 400);
  const userKey = sanitizeUserKey(c.req.header('x-openai-key'));
  try {
    const sensitivityRun = await runSensitivity(c.env, c.req.param('runId'), parsed.data.profileId, parsed.data.axisChanges, c.req.path, userKey);
    return c.json({ sensitivityRun }, 201);
  } catch (error) {
    if (error instanceof Error && /OpenAI auth failed/.test(error.message)) {
      const detail = userKey
        ? 'The X-OpenAI-Key header was rejected by OpenAI during sensitivity rerun.'
        : 'The server-configured OpenAI key was rejected during sensitivity rerun.';
      return c.json(problem(401, 'OpenAI authentication failed', detail, c.req.path), 401);
    }
    throw error;
  }
});

/**
 * NEW: POST /api/experiments/:runId/retry-profile
 *
 * Re-runs a single (scenarioId, profileId) cell × trialCount times within an
 * already-terminal run. Used when the original 4×N parallel fan-out blew the
 * Worker 25s wall budget for one profile (e.g. neutral baseline at
 * status=QUEUED with "No decision yet" while the other three completed).
 *
 * Idempotency: if `Idempotency-Key` header is provided, the response body is
 * cached in KV under `idem:retry-profile:{runId}:{profileId}:{key}` for 1
 * hour. A second request within that window returns the same body without
 * re-running the provider.
 *
 * Auto-fires three-layer analysis via ctx.waitUntil after the retry
 * completes so the new outputs get classified.
 */
app.post('/api/experiments/:runId/retry-profile', rateLimit('experiments-retry-profile'), async (c) => {
  const runId = c.req.param('runId');
  if (!runId) {
    return c.json(problem(400, 'Missing runId', 'Path parameter runId is required.', c.req.path), 400);
  }
  const idempotencyKey = c.req.header('idempotency-key') ?? c.req.header('Idempotency-Key');
  const userKey = sanitizeUserKey(c.req.header('x-openai-key'));

  const parsed = retryProfileSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json(validationProblem(parsed.error, c.req.path), 400);
  const { profileId, trialCount } = parsed.data;

  // Idempotency cache lookup (KV). Returns the previous body verbatim so
  // a rapid double-click doesn't double-bill the provider.
  const cacheKey = idempotencyKey ? `idem:retry-profile:${runId}:${profileId}:${idempotencyKey}` : null;
  if (cacheKey && c.env.CACHE) {
    try {
      const cached = await c.env.CACHE.get(cacheKey);
      if (cached) {
        const body = JSON.parse(cached);
        return c.json(body, 200);
      }
    } catch (error) {
      // KV read failure is non-fatal — fall through to live execution.
      console.warn('[retry-profile] idempotency KV read failed:', error instanceof Error ? error.message : error);
    }
  }

  try {
    const result = await retryProfileForRun(c.env, runId, profileId, trialCount, c.req.path, userKey);

    // Persist the response shape under the idempotency key (1h TTL).
    if (cacheKey && c.env.CACHE) {
      try {
        await c.env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 3600 });
      } catch (error) {
        console.warn('[retry-profile] idempotency KV write failed:', error instanceof Error ? error.message : error);
      }
    }

    // Auto-fire three-layer analysis once we added outputs. Background.
    if (result.addedOutputs > 0) {
      c.executionCtx.waitUntil(runThreeLayerAnalysis(c.env, runId, { force: true }, userKey).catch((error) => {
        console.warn('[retry-profile] three-layer waitUntil failed:', error instanceof Error ? error.message : error);
      }));
    }

    if (result.addedOutputs === 0 && result.error) {
      return c.json({
        ...result,
        title: 'Retry profile failed',
        detail: `No outputs were added (${result.error}). Wait for the provider to recover, then call retry-profile again with the same profileId.`,
        httpStatus: 502,
      }, 502);
    }

    return c.json(result, 200);
  } catch (error) {
    if (error instanceof Error && /OpenAI auth failed/.test(error.message)) {
      return c.json(problem(401, 'OpenAI authentication failed', 'OpenAI rejected the retry-profile call.', c.req.path), 401);
    }
    throw error;
  }
});

/**
 * NEW: POST /api/experiments/:runId/three-layer-analysis
 * Computes L1 / L2 / L3 + alignment for every agent_outputs row in the run.
 * Idempotent — returns cached unless ?force=1.
 */
app.post('/api/experiments/:runId/three-layer-analysis', async (c) => {
  const runId = c.req.param('runId');
  const queryForce = c.req.query('force');
  const bodyText = await c.req.text();
  let force = queryForce === '1' || queryForce === 'true';
  if (bodyText && bodyText.trim().length > 0) {
    try {
      const parsed = threeLayerSchema.safeParse(JSON.parse(bodyText));
      if (parsed.success) force = force || parsed.data.force;
    } catch {
      // Ignore body parse errors — query-string `force` already handled.
    }
  }
  const userKey = sanitizeUserKey(c.req.header('x-openai-key'));

  // Refuse to run on a still-running run unless force.
  const run = await getRunAuthoritative(c.env, runId, { hydrateOutputs: false });
  if (!run) {
    return c.json(problem(404, 'Run not found', 'The requested experiment run does not exist.', c.req.path), 404);
  }
  if (run.status === 'running' && !force) {
    return c.json(problem(409, 'Run still running', 'The run has not completed; pass ?force=1 to analyze partial output.', c.req.path), 409);
  }

  try {
    const result = await runThreeLayerAnalysis(c.env, runId, { force }, userKey);
    if (!result) {
      return c.json(problem(404, 'Run not found', 'The requested experiment run does not exist.', c.req.path), 404);
    }
    return c.json(result);
  } catch (error) {
    if (error instanceof Error && /OpenAI auth failed/.test(error.message)) {
      return c.json(problem(401, 'OpenAI authentication failed', 'OpenAI rejected the L2/L3 judge call.', c.req.path), 401);
    }
    throw error;
  }
});

/**
 * NEW: POST /api/sensitivity-grid
 * Returns {jobId} in <500ms; runs the 144-cell batch via ctx.waitUntil.
 */
app.post('/api/sensitivity-grid', rateLimit('sensitivity-grid'), async (c) => {
  const parsed = sensitivityGridSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json(validationProblem(parsed.error, c.req.path), 400);
  const userKey = sanitizeUserKey(c.req.header('x-openai-key'));

  const start = await startSensitivityGridJob(c.env, parsed.data);
  // Fire-and-forget batch runner.
  c.executionCtx.waitUntil(runGridBatches(c.env, start.job.id, userKey).catch((error) => {
    console.warn('[sensitivity-grid] waitUntil failed:', error instanceof Error ? error.message : error);
  }));
  return c.json({
    jobId: start.job.id,
    totalCells: start.job.totalCells,
    status: start.job.status,
    alreadyExisted: start.alreadyExisted,
  }, 202);
});

app.post('/api/sensitivity-grid/:jobId/retry-failed', rateLimit('sensitivity-grid-retry-failed'), async (c) => {
  const jobId = c.req.param('jobId');
  if (!jobId) {
    return c.json(problem(400, 'Missing jobId', 'Path parameter jobId is required.', c.req.path), 400);
  }
  const parsed = sensitivityGridRetryFailedSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json(validationProblem(parsed.error, c.req.path), 400);

  const job = await getGridJob(c.env, jobId);
  if (!job) {
    return c.json(problem(404, 'Job not found', 'The requested sensitivity grid job does not exist.', c.req.path), 404);
  }

  const requested = parsed.data.cells ? new Set(parsed.data.cells.map((cell) => gridCellKey(cell.scenarioId, cell.profileId, cell.axisId))) : null;
  const retryErrors = requested
    ? job.errors.filter((error) => requested.has(gridCellKey(error.scenarioId, error.profileId, error.axisId)))
    : [...job.errors];

  if (retryErrors.length === 0) {
    return c.json({
      jobId: job.id,
      status: job.status,
      retriedCells: 0,
      failedCells: job.failedCells,
      completedCells: job.completedCells,
      totalCells: job.totalCells,
      errors: job.errors,
    }, 202);
  }

  job.status = 'pending';
  job.completedAt = undefined;
  job.updatedAt = nowSeconds();
  await updateGridJob(c.env, job);

  const retryCells = retryErrors.map((error) => ({
    scenarioId: error.scenarioId,
    profileId: error.profileId as 'achievement' | 'exploration' | 'preservation' | 'neutral',
    axisId: error.axisId as 'achievement' | 'self_direction' | 'security' | 'benevolence',
  }));
  const userKey = sanitizeUserKey(c.req.header('x-openai-key'));
  c.executionCtx.waitUntil(runGridErrorRetries(c.env, job.id, retryCells, userKey).catch((error) => {
    console.warn('[sensitivity-grid] retry-failed waitUntil failed:', error instanceof Error ? error.message : error);
  }));

  return c.json({
    jobId: job.id,
    status: job.status,
    retriedCells: retryErrors.length,
    failedCells: job.failedCells,
    completedCells: job.completedCells,
    totalCells: job.totalCells,
    errors: job.errors,
  }, 202);
});

/**
 * NEW: GET /api/sensitivity-grid/:jobId
 */
app.get('/api/sensitivity-grid/:jobId', async (c) => {
  const jobId = c.req.param('jobId');
  const job = await getGridJob(c.env, jobId);
  if (!job) {
    return c.json(problem(404, 'Job not found', 'The requested sensitivity grid job does not exist.', c.req.path), 404);
  }
  // Opportunistic resume: if the job is still pending/running, kick another batch.
  if (job.status === 'pending' || job.status === 'running') {
    const userKey = sanitizeUserKey(c.req.header('x-openai-key'));
    c.executionCtx.waitUntil(runGridBatches(c.env, job.id, userKey).catch((error) => {
      console.warn('[sensitivity-grid] resume waitUntil failed:', error instanceof Error ? error.message : error);
    }));
  }
  return c.json({
    jobId: job.id,
    status: job.status,
    totalCells: job.totalCells,
    completedCells: job.completedCells,
    failedCells: job.failedCells,
    errorBudget: job.errorBudget,
    results: job.results,
    errors: job.errors,
  });
});

/**
 * NEW: GET /api/findings/heatmap
 *
 * Aggregates a 144-cell grid job into the shape `<BoundaryHeatmap>` expects:
 *   { scenarios: [{ id, title, group? }],
 *     profiles:  [{ id, name }],
 *     axes:      [{ id, label }],
 *     cells:     [...] }
 *
 * Selection rules (Lane G1 bug-fix 2026-04-27):
 *   - `?gridJobId=<id>` query param pins the response to that exact job
 *     (used by reviewers to compare specific jobs across deploys).
 *   - Default behavior filters out probe/stub jobs by requiring
 *     `total_cells === 144 AND completed_cells >= 100 AND status IN
 *     ('completed','partial')`. See `getCanonicalHeatmapGridJob`.
 */
app.get('/api/findings/heatmap', async (c) => {
  const gridJobIdParam = c.req.query('gridJobId') || undefined;
  const job = await getCanonicalHeatmapGridJob(c.env, gridJobIdParam);
  if (!job) {
    return c.json({
      scenarios: [],
      profiles: [],
      axes: [],
      cells: [],
      generatedAt: Math.floor(Date.now() / 1000),
      gridJobId: null,
    });
  }
  const profilesAll = listProfiles();
  return c.json({
    scenarios: job.scenarioIds.map((scenarioId) => {
      const scenario = getScenario(scenarioId);
      return {
        id: scenarioId,
        title: scenario?.title ?? scenarioId,
        group: scenarioGroupOf(scenarioId),
      };
    }),
    profiles: job.profileIds.map((profileId) => {
      const profile = profilesAll.find((item) => item.id === profileId);
      return { id: profileId, name: profile?.name ?? profileId };
    }),
    axes: job.axisIds.map((axisId) => ({
      id: axisId,
      label: axisLabelOf(axisId),
    })),
    cells: job.results.map((cell) => ({
      scenarioId: cell.scenarioId,
      profileId: cell.profileId,
      axisId: cell.axisId,
      flipped: cell.flipped,
      baselineOption: cell.baselineOption,
      perturbedOption: cell.perturbedOption,
      stability: cell.baselineStability,
    })),
    generatedAt: job.updatedAt,
    gridJobId: job.id,
    status: job.status,
    completedCells: job.completedCells,
    failedCells: job.failedCells,
    totalCells: job.totalCells,
    errors: job.errors,
  });
});

/**
 * NEW: GET /api/findings/alignment-patterns
 *
 * Returns counts plus optional `profileMeta` / `scenarioMeta` lookup maps
 * (added 2026-04-27, Lane G1 bug-fix). The lookup maps are ADDITIVE — the
 * existing `byProfile` / `byScenario` shapes remain keyed by ID for
 * backward compatibility. Clients may use the meta maps to render labels
 * (`name`, `title`, `group`) without making a second `/api/scenarios` or
 * `/api/value-profiles` call.
 */
app.get('/api/findings/alignment-patterns', async (c) => {
  const aggregate = await aggregateAlignmentPatterns(c.env);
  const profileMeta: Record<string, { id: string; name: string }> = {};
  for (const profile of listProfiles()) {
    profileMeta[profile.id] = { id: profile.id, name: profile.name };
  }
  const scenarioMeta: Record<string, { id: string; title: string; group: string | null }> = {};
  for (const scenario of listScenarios()) {
    scenarioMeta[scenario.id] = {
      id: scenario.id,
      title: scenario.title,
      group: scenarioGroupOf(scenario.id),
    };
  }
  return c.json({
    ...aggregate,
    profileMeta,
    scenarioMeta,
  });
});

/**
 * NEW: POST /api/research/run-canonical-battery
 * Umbrella orchestrator: 36 main runs + 20 baseline + 144 grid cells.
 */
app.post('/api/research/run-canonical-battery', rateLimit('canonical-battery'), async (c) => {
  const parsed = canonicalBatterySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json(validationProblem(parsed.error, c.req.path), 400);
  const userKey = sanitizeUserKey(c.req.header('x-openai-key'));
  const result = await startCanonicalBattery(
    c.env,
    parsed.data.idempotencyKey,
    (promise) => c.executionCtx.waitUntil(promise),
    userKey,
  );
  return c.json(result, 202);
});

/**
 * Worker-mediated artifact download (Phase 6 contract). Unchanged.
 */
app.get('/api/artifacts/:runId', async (c) => {
  const runId = c.req.param('runId');
  if (!c.env.ARTIFACTS) {
    return c.json(problem(503, 'Artifact storage unavailable', 'R2 binding is not configured for this environment.', c.req.path), 503);
  }
  const run = await getRunAuthoritative(c.env, runId);
  if (!run) return c.json(problem(404, 'Run not found', 'The requested experiment run does not exist.', c.req.path), 404);
  if (run.status !== 'completed' && run.status !== 'partial') {
    return c.json(problem(409, 'Artifact not available', `Run status is "${run.status}"; artifacts are only readable for completed or partial runs.`, c.req.path), 409);
  }
  const manifest = await readRunManifest(c.env, run);
  if (!manifest) return c.json(problem(404, 'Artifact manifest not found', 'No manifest exists for this run.', c.req.path), 404);
  if (isArtifactExpired(manifest)) {
    return c.json(problem(410, 'Artifact expired', 'Retention window for this artifact has elapsed.', c.req.path), 410);
  }
  const object = await readRunExport(c.env, run);
  if (!object) return c.json(problem(404, 'Artifact body not found', 'The R2 object for this run no longer exists.', c.req.path), 404);
  const exportObject = manifest.objects.find((entry) => entry.key.endsWith('/export.json'));
  const contentType = exportObject?.contentType ?? 'application/json';
  const safeRunId = manifest.runId.replace(/[^A-Za-z0-9_-]/g, '');
  const filename = `motiveops-${safeRunId}-v${manifest.artifactVersion}.json`;
  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'private, no-cache',
      'Content-Disposition': `attachment; filename="${filename}"`,
      ...(exportObject?.sha256 ? { 'X-Artifact-SHA256': exportObject.sha256 } : {}),
    },
  });
});

/**
 * GET /api/evidence-ledger
 *
 * D1-authoritative ledger of recent battery runs. Replaces the previous
 * in-memory-only behaviour where Worker isolate rotation would silently
 * empty the ledger between deploys.
 *
 * Response shape (Lane E redesign 2026-04-27):
 *   {
 *     runs: RecentRunSummary[],   // primary shape (the new one)
 *     entries: LedgerEntry[],     // legacy shape — kept for back-compat
 *     generatedAt: number,        // unix seconds
 *     batteryId?: string,         // echoed when ?batteryId= filter is set
 *     totalRuns: number,
 *   }
 *
 * `runs` exposes the columns needed by the Three-Layer Analysis tab and
 * the canonical-evidence aggregator: `profileIds`, `trialCount`,
 * `batteryId`. The legacy `entries` array (carrying the artifact-manifest
 * pointer) is still emitted so any link/downstream that read the previous
 * shape keeps working.
 *
 * Query params:
 *   limit      — max rows (default 36, max 200)
 *   batteryId  — filter to one battery (e.g. battery_canonical-2026-04-27)
 */
app.get('/api/evidence-ledger', async (c) => {
  const limitParam = c.req.query('limit');
  const batteryIdParam = c.req.query('batteryId');
  const limitNum = limitParam ? Number.parseInt(limitParam, 10) : 36;
  const limit = Number.isFinite(limitNum) && limitNum > 0 ? limitNum : 36;
  const [runs, entries] = await Promise.all([
    listRecentRunsFromD1(c.env, limit, batteryIdParam ?? undefined),
    listLedgerEntries(c.env),
  ]);
  return c.json({
    runs,
    entries,
    generatedAt: nowSeconds(),
    batteryId: batteryIdParam ?? null,
    totalRuns: runs.length,
  });
});

/**
 * GET /api/research/canonical-evidence
 *
 * Serves the canonical battery evidence JSON (Lane C output) so reviewers
 * and Lane D's paper can fetch the underlying numbers without running
 * their own battery. The R2 object is the authoritative artifact —
 * byte-exact provenance with what `_aggregate.py` produced locally.
 *
 * Source: R2 object `canonical-evidence-{YYYY-MM-DD}.json` under the
 *         `ARTIFACTS` binding (motiveops-artifacts-production).
 *
 * Query params:
 *   date  — explicit YYYY-MM-DD slug. Defaults to `2026-04-27` (the
 *           shipped paper-grade battery).
 *
 * Response: `application/json` with the full canonical envelope
 * (battery, runs, sensitivityGrid, alignmentPatterns, headline …).
 *
 * 404 when the requested object does not exist (e.g. a stale date slug).
 */
app.get('/api/research/canonical-evidence', async (c) => {
  if (!c.env.ARTIFACTS) {
    return c.json(problem(503, 'Artifact storage unavailable', 'R2 binding is not configured for this environment.', c.req.path), 503);
  }
  const dateParam = c.req.query('date');
  const slug = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : '2026-04-27';
  const key = `canonical-evidence-${slug}.json`;
  const object = await c.env.ARTIFACTS.get(key);
  if (!object) {
    return c.json(problem(404, 'Canonical evidence not found', `No object found at R2 key "${key}". Has the JSON been uploaded for this date?`, c.req.path), 404);
  }
  // Mirror the global CORS middleware's origin echo (which only runs on
  // Hono `c.json` paths — a raw Response bypasses the header merge).
  const origin = c.req.header('origin');
  const allowedOrigins = (c.env.ALLOWED_ORIGINS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  const corsHeaders: Record<string, string> = {};
  if (origin && allowedOrigins.includes(origin)) {
    corsHeaders['Access-Control-Allow-Origin'] = origin;
    corsHeaders['Vary'] = 'Origin';
  }
  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
      'Content-Disposition': `inline; filename="${key}"`,
      'X-Source-Slug': slug,
      ...corsHeaders,
    },
  });
});

app.get('/api/findings', (c) => {
  const runs = listRuns();
  const completed = runs.filter((run) => run.status === 'completed' || run.status === 'partial');
  const divergent = completed.filter((run) => run.synthesis?.substantiveDivergence).length;
  const sensitivityRuns = completed.flatMap((run) => run.sensitivityRuns);
  const flips = sensitivityRuns.filter((run) => run.flipped).length;
  return c.json({
    completedRuns: completed.length,
    divergenceRate: completed.length ? divergent / completed.length : 0,
    signatureDetectionRate: averageMetric(completed, 'signature'),
    flipRate: sensitivityRuns.length ? flips / sensitivityRuns.length : 0,
    representativeRuns: completed.slice(0, 4),
  });
});

app.get('/api/evaluations/adoption-readiness', async (c) => {
  const runId = c.req.query('runId');
  const run = runId ? await getRunAuthoritative(c.env, runId, { hydrateOutputs: true }) : null;
  if (runId && !run) return c.json(problem(404, 'Run not found', 'The requested experiment run does not exist.', c.req.path), 404);
  return c.json(evaluateAdoptionReadiness(run ?? null));
});

app.get('/api/evaluations/canonical-battery', async (c) => {
  const batteryId = c.req.query('batteryId');
  const gridJobId = c.req.query('gridJobId');
  if (!batteryId) {
    return c.json(problem(400, 'Missing batteryId', 'Provide ?batteryId=<battery-id> from POST /api/research/run-canonical-battery.', c.req.path), 400);
  }
  const summaries = await listRecentRunsFromD1(c.env, 100, batteryId);
  const runs = (await Promise.all(
    summaries.map((summary) => getRunAuthoritative(c.env, summary.runId, { hydrateOutputs: true })),
  )).filter((run): run is NonNullable<typeof run> => Boolean(run));
  const grid = gridJobId
    ? await getGridJob(c.env, gridJobId)
    : await getGridJobByBatteryId(c.env, batteryId);
  return c.json(evaluateCanonicalBattery(runs, grid ?? null));
});

function validationProblem(error: z.ZodError, instance: string): ProblemDetails {
  return problem(400, 'Validation failed', 'Request payload did not match the expected schema.', instance, error.issues.map((issue) => ({
    path: issue.path.map((part) => String(part)),
    message: issue.message,
  })));
}

/**
 * Map an adoption-case ID to the group label ('A' | 'B' | 'C') or null if
 * the scenario is custom / unknown. The 9 preset scenarios are clustered
 * as Trust/Psychological Safety/Exploration; the BoundaryHeatmap uses this
 * to draw 3-row gutters between groups.
 *
 * Source of truth: `src/domain/seeds.ts` (Group A/B/C section comments).
 */
function scenarioGroupOf(scenarioId: string): 'A' | 'B' | 'C' | null {
  const groupA = new Set(['coding-assistant-low-trust-evaluation-anxiety', 'customer-support-ai-draft-rework-risk', 'analytics-copilot-data-confidence-gap']);
  const groupB = new Set(['manager-stigma-ai-dependence', 'legal-review-ai-confidentiality-concern', 'sales-ai-coach-unclear-use-case']);
  const groupC = new Set(['marketing-ai-content-brand-risk', 'finance-ai-forecasting-accountability-risk', 'hr-ai-policy-answer-trust-gap']);
  if (groupA.has(scenarioId)) return 'A';
  if (groupB.has(scenarioId)) return 'B';
  if (groupC.has(scenarioId)) return 'C';
  return null;
}

/**
 * Map a JudgeAxisId (snake_case) to the human-readable label used in the
 * heatmap column headers. The judge layer uses `self_direction` while
 * motivation profiles use `selfDirection` (camelCase) - this helper bridges
 * the two for the UI.
 */
function axisLabelOf(axisId: string): string {
  switch (axisId) {
    case 'achievement': return 'Achievement';
    case 'self_direction': return 'Self-direction';
    case 'security': return 'Security';
    case 'benevolence': return 'Benevolence';
    default: return axisId;
  }
}

function gridCellKey(scenarioId: string, profileId: string, axisId: string): string {
  return `${scenarioId}::${profileId}::${axisId}`;
}

function isProblemDetails(error: unknown): error is ProblemDetails {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as Partial<ProblemDetails>;
  return typeof candidate.status === 'number' && typeof candidate.title === 'string' && typeof candidate.detail === 'string' && typeof candidate.type === 'string';
}

function averageMetric(runs: ReturnType<typeof listRuns>, metricType: 'signature'): number {
  const values = runs.flatMap((run) => run.metrics.filter((metric) => metric.metricType === metricType).map((metric) => metric.metricValue ?? 0));
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export default app;
