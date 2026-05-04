import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { classifyAlignment, deriveL1Top2 } from '../src/analysis/alignment-pattern.ts';
import { presetScenarios, valueProfiles } from '../src/domain/seeds.ts';
import type {
  AgentOutput,
  AxisId,
  AxisWeight,
  Env,
  ExperimentRun,
  JudgeAxisId,
  ProfileId,
  Scenario,
  SensitivityGridCell,
  SensitivityGridJob,
  ValueProfile,
} from '../src/domain/types.ts';
import { evaluateCanonicalBattery } from '../src/experiments/adoption-evaluation.ts';
import { extractRationaleAxis } from '../src/extractors/rationale-values.ts';
import { judgeOption } from '../src/judges/value-judge.ts';
import { getConfig } from '../src/services/config.ts';
import { runProfileProvider } from '../src/services/provider.ts';

const AXES: JudgeAxisId[] = ['achievement', 'self_direction', 'security', 'benevolence'];
const SAME_PROFILE_SCENARIO = 'coding-assistant-low-trust-evaluation-anxiety';
const SUBJECT_TRIALS = 5;
const RAW_PATH = path.join('evaluation-results', 'local-canonical-evaluation.raw.json');
const SUMMARY_PATH = path.join('evaluation-results', 'local-canonical-evaluation.summary.json');
const PUBLIC_SUMMARY_PATH = path.join('public', 'evaluation', 'latest-local-evaluation.json');
const TEX_RESULTS_PATH = path.join('final_program_tex', 'local_eval_results.tex');
const PROVIDER_MAX_ATTEMPTS = 4;

type RawState = {
  schemaVersion: 1;
  batteryId: string;
  generatedAt: number;
  mode: 'demo' | 'openai';
  model: string;
  subjectOutputs: AgentOutput[];
  sameProfileBaseline: SameProfileBaselineResult[];
  gridResults: SensitivityGridCell[];
  gridErrors: Array<{ scenarioId: string; profileId: ProfileId; axisId: JudgeAxisId; message: string; loggedAt: number }>;
};

type SameProfileBaselineResult = {
  scenarioId: string;
  profileId: ProfileId;
  trial: number;
  selectedOption: string;
  rationale: string;
  createdAt: number;
};

type CliOptions = {
  demoOverride: boolean;
  liveOverride: boolean;
  reset: boolean;
};

const AXIS_LEGACY_TO_JUDGE: Record<AxisId, JudgeAxisId> = {
  achievement: 'achievement',
  selfDirection: 'self_direction',
  security: 'security',
  benevolence: 'benevolence',
};

const AXIS_JUDGE_TO_LEGACY: Record<JudgeAxisId, AxisId> = {
  achievement: 'achievement',
  self_direction: 'selfDirection',
  security: 'security',
  benevolence: 'benevolence',
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const vars = await readDevVars('.dev.vars');
  const env = buildEnv(vars, options);
  const config = getConfig(env);
  const generationSettings = {
    ...config.generationSettings,
    maxTokens: Number(vars.EVALUATION_MAX_TOKENS ?? process.env.EVALUATION_MAX_TOKENS ?? 2500),
  };
  const mode = (env.DEMO_MODE ?? 'true') === 'true' ? 'demo' : 'openai';

  if (mode === 'demo' && !options.demoOverride) {
    throw new Error('Paper-grade evaluation requires DEMO_MODE=false and OPENAI_API_KEY in .dev.vars. For a deterministic smoke test, rerun with --demo.');
  }
  if (mode === 'openai' && !env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required when DEMO_MODE=false. Put it in .dev.vars before running the paper-grade local evaluation.');
  }

  const state = options.reset ? createState(mode, config.openAIModel) : await loadState(mode, config.openAIModel);
  state.generatedAt = nowSeconds();
  state.mode = mode;
  state.model = config.openAIModel;

  console.log(`[eval:local] mode=${mode} model=${config.openAIModel} batteryId=${state.batteryId}`);
  console.log('[eval:local] running 9 cases x 4 profiles x 5 trials = 180 subject outputs');
  await runSubjectOutputs(state, env, config.openAIModel, generationSettings);

  console.log('[eval:local] running 20 same-profile baseline calls for the coding-assistant case');
  await runSameProfileBaseline(state, env, config.openAIModel, generationSettings);

  console.log('[eval:local] running 144 low-vs-high axis contrast cells');
  await runSensitivityGrid(state, env, config.openAIModel, generationSettings);

  const runs = buildExperimentRuns(state, config.openAIModel, generationSettings);
  const grid = buildGridJob(state);
  const summary = {
    ...evaluateCanonicalBattery(runs, grid),
    localRun: {
      mode,
      model: config.openAIModel,
      batteryId: state.batteryId,
      rawPath: RAW_PATH,
      summaryPath: SUMMARY_PATH,
      publicSummaryPath: PUBLIC_SUMMARY_PATH,
      generatedAt: state.generatedAt,
    },
    sameProfileBaseline: summarizeSameProfileBaseline(state.sameProfileBaseline),
  };

  await saveState(state);
  await writeJson(SUMMARY_PATH, summary);
  await writeJson(PUBLIC_SUMMARY_PATH, summary);
  await writeFileWithDirs(TEX_RESULTS_PATH, renderLatexResults(summary));

  printSummary(summary);
}

async function runSubjectOutputs(state: RawState, env: Env, model: string, settings: ExperimentRun['generationSettings']) {
  for (const scenario of presetScenarios) {
    for (const profile of valueProfiles) {
      for (let trial = 0; trial < SUBJECT_TRIALS; trial += 1) {
        if (findSubjectOutput(state, scenario.id, profile.id, trial)) continue;
        const output = await runOneSubjectOutput(env, state, model, settings, scenario, profile, trial);
        state.subjectOutputs.push(output);
        await saveState(state);
        console.log(`[eval:local] subject ${state.subjectOutputs.length}/180 ${scenario.id} ${profile.id} trial=${trial}`);
      }
    }
  }
}

async function runOneSubjectOutput(env: Env, state: RawState, model: string, settings: ExperimentRun['generationSettings'], scenario: Scenario, profile: ValueProfile, trial: number): Promise<AgentOutput> {
  const result = await runProviderWithRetries(env, model, settings, scenario, profile, `subject ${scenario.id} ${profile.id} trial=${trial}`);
  const judge = await judgeOption(env, scenario, result.structuredDecision.selectedOptionId, env.OPENAI_API_KEY);
  const extraction = await extractRationaleAxis(env, result.structuredDecision.rationale ?? '', env.OPENAI_API_KEY);
  const l1Top2 = computeL1Top2(profile);
  const l2 = judge.primaryAxis === 'unknown' ? l1Top2[0] : judge.primaryAxis;
  const l3 = extraction.topAxis === 'unknown' ? l1Top2[0] : extraction.topAxis;
  const runId = runIdForScenario(scenario.id);

  return {
    id: `localout_${safeId(scenario.id)}_${profile.id}_${trial}`,
    runId,
    profileId: profile.id,
    profileSnapshot: profile,
    translatedPrompt: result.prompt,
    rawOutput: result.rawOutput,
    structuredDecision: result.structuredDecision,
    driveTrace: result.structuredDecision.driveAttributions,
    confidence: result.structuredDecision.confidence,
    status: 'completed',
    createdAt: nowSeconds(),
    trialIndex: trial,
    judgeAxis: judge.primaryAxis,
    judgeConfidence: judge.confidence,
    judgeReasoning: judge.reasoning,
    rationaleDrives: extraction.drives,
    rationaleTopAxis: extraction.topAxis,
    rationaleResolution: extraction.resolution,
    alignmentPattern: classifyAlignment(l1Top2, l2, l3),
    threeLayerCompletedAt: nowSeconds(),
  };
}

async function runSameProfileBaseline(state: RawState, env: Env, model: string, settings: ExperimentRun['generationSettings']) {
  const scenario = presetScenarios.find((item) => item.id === SAME_PROFILE_SCENARIO);
  if (!scenario) throw new Error(`Missing same-profile scenario: ${SAME_PROFILE_SCENARIO}`);

  for (const profile of valueProfiles) {
    for (let trial = 0; trial < SUBJECT_TRIALS; trial += 1) {
      if (state.sameProfileBaseline.some((item) => item.scenarioId === scenario.id && item.profileId === profile.id && item.trial === trial)) continue;
      const result = await runProviderWithRetries(env, model, settings, scenario, profile, `same-profile ${profile.id} trial=${trial}`);
      state.sameProfileBaseline.push({
        scenarioId: scenario.id,
        profileId: profile.id,
        trial,
        selectedOption: result.structuredDecision.selectedOptionId,
        rationale: result.structuredDecision.rationale ?? '',
        createdAt: nowSeconds(),
      });
      await saveState(state);
      console.log(`[eval:local] same-profile ${state.sameProfileBaseline.length}/20 ${profile.id} trial=${trial}`);
    }
  }
}

async function runSensitivityGrid(state: RawState, env: Env, model: string, settings: ExperimentRun['generationSettings']) {
  for (const scenario of presetScenarios) {
    for (const profile of valueProfiles) {
      const baseline = computeBaselineModal(state.subjectOutputs, scenario.id, profile.id);
      for (const axisId of AXES) {
        const existingIndex = state.gridResults.findIndex((cell) => cell.scenarioId === scenario.id && cell.profileId === profile.id && cell.axisId === axisId);
        if (existingIndex >= 0 && state.gridResults[existingIndex]?.contrastMode === 'low_high') continue;
        if (existingIndex >= 0) state.gridResults.splice(existingIndex, 1);
        try {
          const lowProfile = setAxisEndpoint(profile, axisId, 0.2);
          const highProfile = setAxisEndpoint(profile, axisId, 0.8);
          const lowResult = await runProviderWithRetries(env, model, settings, scenario, lowProfile, `grid ${scenario.id} ${profile.id} ${axisId} low`);
          const highResult = await runProviderWithRetries(env, model, settings, scenario, highProfile, `grid ${scenario.id} ${profile.id} ${axisId} high`);
          const cell: SensitivityGridCell = {
            scenarioId: scenario.id,
            profileId: profile.id,
            axisId,
            contrastMode: 'low_high',
            lowOption: lowResult.structuredDecision.selectedOptionId,
            highOption: highResult.structuredDecision.selectedOptionId,
            lowRationaleExcerpt: (lowResult.structuredDecision.rationale ?? '').slice(0, 320),
            highRationaleExcerpt: (highResult.structuredDecision.rationale ?? '').slice(0, 320),
            lowCellRunId: `localcell_low_${safeId(scenario.id)}_${profile.id}_${axisId}`,
            highCellRunId: `localcell_high_${safeId(scenario.id)}_${profile.id}_${axisId}`,
            baselineOption: baseline.option,
            baselineStability: baseline.stability,
            perturbedOption: highResult.structuredDecision.selectedOptionId,
            flipped: lowResult.structuredDecision.selectedOptionId !== highResult.structuredDecision.selectedOptionId,
            perturbedRationaleExcerpt: (highResult.structuredDecision.rationale ?? '').slice(0, 320),
            cellRunId: `localcell_high_${safeId(scenario.id)}_${profile.id}_${axisId}`,
            completedAt: nowSeconds(),
          };
          state.gridResults.push(cell);
        } catch (error) {
          state.gridErrors.push({
            scenarioId: scenario.id,
            profileId: profile.id,
            axisId,
            message: error instanceof Error ? error.message.slice(0, 280) : String(error).slice(0, 280),
            loggedAt: nowSeconds(),
          });
        }
        await saveState(state);
        console.log(`[eval:local] grid ${state.gridResults.length}/144 errors=${state.gridErrors.length} ${scenario.id} ${profile.id} ${axisId}`);
      }
    }
  }
}

async function runProviderWithRetries(
  env: Env,
  model: string,
  settings: ExperimentRun['generationSettings'],
  scenario: Scenario,
  profile: ValueProfile,
  label: string,
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PROVIDER_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await runProfileProvider(env, model, settings, scenario, profile, env.OPENAI_API_KEY);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= PROVIDER_MAX_ATTEMPTS) break;
      console.warn(`[eval:local] retrying ${label} after attempt ${attempt}/${PROVIDER_MAX_ATTEMPTS}: ${message.slice(0, 180)}`);
      await sleep(800 * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function buildExperimentRuns(state: RawState, model: string, generationSettings: ExperimentRun['generationSettings']): ExperimentRun[] {
  return presetScenarios.map((scenario) => ({
    id: runIdForScenario(scenario.id),
    scenarioId: scenario.id,
    scenarioSnapshot: scenario,
    profileIds: valueProfiles.map((profile) => profile.id),
    modelProvider: 'openai',
    modelName: model,
    generationSettings,
    status: 'completed',
    outputs: state.subjectOutputs.filter((output) => output.runId === runIdForScenario(scenario.id)),
    metrics: [],
    sensitivityRuns: [],
    createdAt: state.generatedAt,
    startedAt: state.generatedAt,
    completedAt: state.generatedAt,
    trialCount: SUBJECT_TRIALS,
    batteryId: state.batteryId,
  }));
}

function buildGridJob(state: RawState): SensitivityGridJob {
  const status = state.gridResults.length >= 144 && state.gridErrors.length === 0
    ? 'completed'
    : state.gridResults.length > 0
      ? 'partial'
      : 'pending';
  return {
    id: `grid_${state.batteryId}`,
    batteryId: state.batteryId,
    status,
    totalCells: 144,
    completedCells: state.gridResults.length,
    failedCells: state.gridErrors.length,
    errorBudget: 12,
    scenarioIds: presetScenarios.map((scenario) => scenario.id),
    profileIds: valueProfiles.map((profile) => profile.id),
    axisIds: AXES,
    results: state.gridResults,
    errors: state.gridErrors.map((error) => ({
      scenarioId: error.scenarioId,
      profileId: error.profileId,
      axisId: error.axisId,
      errorType: 'openai',
      message: error.message,
      attempts: 1,
      loggedAt: error.loggedAt,
    })),
    idempotencyKey: state.batteryId,
    createdAt: state.generatedAt,
    updatedAt: nowSeconds(),
    completedAt: status === 'completed' ? nowSeconds() : undefined,
  };
}

function summarizeSameProfileBaseline(records: SameProfileBaselineResult[]) {
  const cells = valueProfiles.map((profile) => {
    const rows = records.filter((item) => item.profileId === profile.id);
    const modal = modalOption(rows.map((row) => row.selectedOption));
    return {
      scenarioId: SAME_PROFILE_SCENARIO,
      profileId: profile.id,
      completedTrials: rows.length,
      modalOption: modal.option,
      modalStability: rows.length ? modal.count / rows.length : 0,
    };
  });
  return {
    expectedCalls: 20,
    completedCalls: records.length,
    completionRate: records.length / 20,
    averageModalStability: average(cells.map((cell) => cell.modalStability)),
    cells,
  };
}

function computeBaselineModal(outputs: AgentOutput[], scenarioId: string, profileId: ProfileId): { option: string | null; stability: number } {
  const rows = outputs.filter((output) => output.runId === runIdForScenario(scenarioId) && output.profileId === profileId);
  const modal = modalOption(rows.map((row) => row.structuredDecision.selectedOptionId));
  return { option: modal.option, stability: rows.length ? modal.count / rows.length : 0 };
}

function modalOption(values: string[]): { option: string | null; count: number } {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let option: string | null = null;
  let count = 0;
  for (const [candidate, candidateCount] of counts) {
    if (candidateCount > count) {
      option = candidate;
      count = candidateCount;
    }
  }
  return { option, count };
}

function computeL1Top2(profile: ValueProfile): readonly [JudgeAxisId, JudgeAxisId] {
  const weights: Record<JudgeAxisId, number> = {
    achievement: 0,
    self_direction: 0,
    security: 0,
    benevolence: 0,
  };
  for (const weight of profile.axisWeights as AxisWeight[]) {
    weights[AXIS_LEGACY_TO_JUDGE[weight.axis]] = weight.value;
  }
  return deriveL1Top2(weights);
}

function setAxisEndpoint(profile: ValueProfile, axisId: JudgeAxisId, endpoint: 0.2 | 0.8): ValueProfile {
  const legacyAxis = AXIS_JUDGE_TO_LEGACY[axisId];
  const level: 'high' | 'low' = endpoint === 0.8 ? 'high' : 'low';
  return {
    ...profile,
    name: `${profile.name} (${axisId}=${level})`,
    axisWeights: profile.axisWeights.map((weight) => {
      if (weight.axis !== legacyAxis) return weight;
      return { ...weight, value: endpoint, level };
    }),
  };
}

function findSubjectOutput(state: RawState, scenarioId: string, profileId: ProfileId, trial: number): AgentOutput | undefined {
  const outputId = `localout_${safeId(scenarioId)}_${profileId}_${trial}`;
  return state.subjectOutputs.find((output) => output.id === outputId);
}

async function loadState(mode: RawState['mode'], model: string): Promise<RawState> {
  if (!existsSync(RAW_PATH)) return createState(mode, model);
  const raw = JSON.parse(await readFile(RAW_PATH, 'utf8')) as RawState;
  if (raw.schemaVersion !== 1) return createState(mode, model);
  if (raw.mode !== mode) {
    throw new Error(`Existing raw evaluation state is mode=${raw.mode}, but this run is mode=${mode}. Rerun with --reset to avoid mixing demo and live outputs.`);
  }
  if (raw.model !== model) {
    throw new Error(`Existing raw evaluation state used model=${raw.model}, but this run uses model=${model}. Rerun with --reset to avoid mixing model outputs.`);
  }
  return {
    ...raw,
    mode,
    model,
    subjectOutputs: raw.subjectOutputs ?? [],
    sameProfileBaseline: raw.sameProfileBaseline ?? [],
    gridResults: raw.gridResults ?? [],
    gridErrors: raw.gridErrors ?? [],
  };
}

function createState(mode: RawState['mode'], model: string): RawState {
  return {
    schemaVersion: 1,
    batteryId: `local_canonical_${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`,
    generatedAt: nowSeconds(),
    mode,
    model,
    subjectOutputs: [],
    sameProfileBaseline: [],
    gridResults: [],
    gridErrors: [],
  };
}

async function saveState(state: RawState) {
  await writeJson(RAW_PATH, state);
}

async function writeJson(filePath: string, value: unknown) {
  await writeFileWithDirs(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFileWithDirs(filePath: string, contents: string) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, 'utf8');
}

async function readDevVars(filePath: string): Promise<Record<string, string>> {
  if (!existsSync(filePath)) return {};
  const source = await readFile(filePath, 'utf8');
  const result: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals === -1) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function buildEnv(vars: Record<string, string>, options: CliOptions): Env {
  const demoMode = options.demoOverride
    ? 'true'
    : options.liveOverride
      ? 'false'
      : vars.DEMO_MODE ?? process.env.DEMO_MODE ?? 'true';
  return {
    ...vars,
    APP_ENV: vars.APP_ENV ?? 'local-evaluation',
    DEMO_MODE: demoMode,
    OPENAI_API_KEY: vars.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
    OPENAI_MODEL: vars.OPENAI_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-5.4-nano',
    OPENAI_MODEL_ALLOWLIST: vars.OPENAI_MODEL_ALLOWLIST ?? process.env.OPENAI_MODEL_ALLOWLIST ?? vars.OPENAI_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-5.4-nano',
    RUN_TIMEOUT_SECONDS: vars.RUN_TIMEOUT_SECONDS ?? '25',
  };
}

function parseArgs(args: string[]): CliOptions {
  return {
    demoOverride: args.includes('--demo'),
    liveOverride: args.includes('--live'),
    reset: args.includes('--reset'),
  };
}

function renderLatexResults(summary: any): string {
  const modeLabel = summary.localRun.mode === 'openai'
    ? `Live local OpenAI run (${latexEscape(summary.localRun.model)})`
    : 'Demo-mode smoke run (not paper-grade)';
  const statusLine = summary.localRun.mode === 'openai'
    ? 'The reported numbers were produced locally with \\texttt{DEMO\\_MODE=false}; no Cloudflare deployment was used.'
    : 'These numbers verify the local evaluation pipeline only. Replace them by running \\texttt{npm run eval:local} after adding a real \\texttt{OPENAI\\_API\\_KEY} and setting \\texttt{DEMO\\_MODE=false}.';
  return [
    '% Auto-generated by npm run eval:local. Do not edit by hand.',
    '\\begin{table}[t]',
    '\\centering',
    '\\caption{Local canonical evaluation results.}',
    '\\label{tab:canonical-battery}',
    '\\small',
    '\\begin{tabular}{p{0.44\\columnwidth}p{0.44\\columnwidth}}',
    '\\toprule',
    'Metric & Local result \\\\',
    '\\midrule',
    `Mode & ${modeLabel} \\\\`,
    `Subject outputs & ${summary.battery.subjectOutputs}/180 (${pct(summary.battery.subjectOutputCompletionRate)}) \\\\`,
    `Profile cells complete & ${summary.battery.profileCells}/36 (${pct(summary.battery.profileCellCompletionRate)}) \\\\`,
    `Average modal stability & ${pct(summary.stability.averageModalStability)} \\\\`,
    `Divergent scenario rate & ${pct(summary.profileDivergence.divergentScenarioRate)} \\\\`,
    `Card complete output rate & ${pct(summary.interventionCardCompleteness.completeOutputRate)} \\\\`,
    `Three-layer audit coverage & ${summary.threeLayerAudit.auditedOutputs}/180 (${pct(summary.threeLayerAudit.auditCoverage)}) \\\\`,
    `Sensitivity cells & ${summary.sensitivityGrid.completedCells}/144 (${pct(summary.sensitivityGrid.completionRate ?? 0)}) \\\\`,
    `Endpoint flip rate & ${pct(summary.sensitivityGrid.flipRate)} \\\\`,
    `Same-profile baseline & ${summary.sameProfileBaseline.completedCalls}/20; average modal stability ${pct(summary.sameProfileBaseline.averageModalStability)} \\\\`,
    '\\bottomrule',
    '\\end{tabular}',
    `\\par\\vspace{2pt}{\\footnotesize ${statusLine}}`,
    '\\end{table}',
    '',
  ].join('\n');
}

function printSummary(summary: any) {
  console.log('[eval:local] complete');
  console.log(`[eval:local] subject outputs: ${summary.battery.subjectOutputs}/180`);
  console.log(`[eval:local] grid cells: ${summary.sensitivityGrid.completedCells}/144`);
  console.log(`[eval:local] average modal stability: ${pct(summary.stability.averageModalStability)}`);
  console.log(`[eval:local] endpoint flip rate: ${pct(summary.sensitivityGrid.flipRate)}`);
  console.log(`[eval:local] wrote ${SUMMARY_PATH}`);
  console.log(`[eval:local] wrote ${PUBLIC_SUMMARY_PATH}`);
  console.log(`[eval:local] wrote ${TEX_RESULTS_PATH}`);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}\\%`;
}

function latexEscape(value: string): string {
  return value.replaceAll('_', '\\_').replaceAll('%', '\\%').replaceAll('&', '\\&');
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runIdForScenario(scenarioId: string): string {
  return `localrun_${safeId(scenarioId)}`;
}

function safeId(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

main().catch((error) => {
  console.error(`[eval:local] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
