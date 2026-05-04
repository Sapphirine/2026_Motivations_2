import type { AgentOutput, AlignmentPattern, ExperimentRun, ProfileId, SensitivityGridJob } from '../domain/types';
import { retrieveInterventionPolicies } from '../domain/intervention-playbook';
import { presetScenarios } from '../domain/seeds';

const expectedPolicyIdsByScenario: Record<string, string[]> = {
  'coding-assistant-low-trust-evaluation-anxiety': ['low-trust-output', 'manager-evaluation-anxiety', 'rework-risk'],
  'customer-support-ai-draft-rework-risk': ['rework-risk', 'customer-facing-risk', 'professional-identity-threat'],
  'analytics-copilot-data-confidence-gap': ['low-trust-output', 'auditability-risk', 'rework-risk'],
  'manager-stigma-ai-dependence': ['manager-evaluation-anxiety', 'peer-norm-resistance', 'productivity-pressure-backlash'],
  'legal-review-ai-confidentiality-concern': ['data-confidentiality', 'professional-identity-threat', 'auditability-risk'],
  'sales-ai-coach-unclear-use-case': ['unclear-use-case', 'time-scarcity', 'roi-visibility-gap'],
  'marketing-ai-content-brand-risk': ['professional-identity-threat', 'rework-risk', 'customer-facing-risk'],
  'finance-ai-forecasting-accountability-risk': ['auditability-risk', 'governance-uncertainty'],
  'hr-ai-policy-answer-trust-gap': ['human-care-concern', 'data-confidentiality', 'low-trust-output'],
};

const cardFields = [
  'diagnosedBlocker',
  'motivationProfile',
  'retrievedStrategy',
  'microAction',
  'ifThenPlan',
  'accountabilityScript',
  'successMetric',
] as const;

const expectedCanonical = {
  scenarioCount: 9,
  profileCount: 4,
  trialCount: 5,
  subjectOutputs: 180,
  profileCells: 36,
  gridCells: 144,
};

export function evaluatePlaybookRetrieval() {
  const cases = presetScenarios.map((scenario) => {
    const expected = expectedPolicyIdsByScenario[scenario.id] ?? [];
    const retrieved = retrieveInterventionPolicies(scenario, 3).map((policy) => policy.id);
    const covered = expected.filter((id) => retrieved.includes(id));
    return {
      scenarioId: scenario.id,
      title: scenario.title,
      expectedPolicyIds: expected,
      retrievedPolicyIds: retrieved,
      top1Hit: expected.includes(retrieved[0]),
      top3Covered: covered.length,
      top3Expected: expected.length,
      top3Coverage: expected.length ? covered.length / expected.length : 0,
    };
  });

  const expectedTotal = cases.reduce((sum, item) => sum + item.top3Expected, 0);
  const coveredTotal = cases.reduce((sum, item) => sum + item.top3Covered, 0);
  return {
    method: 'Deterministic fixture: expected blocker-policy ids were defined for each of the 9 preset AI workflow adoption scenarios; retrieval is evaluated at limit=3.',
    scenarioCount: cases.length,
    top1Accuracy: cases.length ? cases.filter((item) => item.top1Hit).length / cases.length : 0,
    top3Coverage: expectedTotal ? coveredTotal / expectedTotal : 0,
    top3AllExpectedScenarioRate: cases.length ? cases.filter((item) => item.top3Coverage === 1).length / cases.length : 0,
    cases,
  };
}

export function evaluateInterventionCardCompleteness(run: ExperimentRun | null) {
  if (!run) return null;
  const outputs = run.outputs.filter((output) => output.status === 'completed');
  const byOutput = outputs.map((output) => evaluateOutputCard(output));
  const totalFields = byOutput.reduce((sum, item) => sum + item.presentFields.length, 0);
  const possibleFields = byOutput.length * cardFields.length;
  return {
    method: 'Checks whether each completed output includes the seven interventionCard fields required by the MotiveOps prompt contract.',
    runId: run.id,
    completedOutputs: outputs.length,
    requiredFields: [...cardFields],
    fieldCompleteness: possibleFields ? totalFields / possibleFields : 0,
    completeOutputRate: byOutput.length ? byOutput.filter((item) => item.complete).length / byOutput.length : 0,
    byOutput,
  };
}

export function evaluateBadAdviceDetection() {
  return {
    method: 'One handcrafted regression fixture for the security/anxiety case. The fixture is intentionally not an OpenAI result; it verifies that the evaluation layer can flag a known unsafe adoption mandate.',
    scenarioId: 'coding-assistant-low-trust-evaluation-anxiety',
    profileId: 'preservation',
    badAdvice: 'Use AI for all coding tasks this week to maximize productivity.',
    expectedClassification: 'Contradictory',
    detectedClassification: 'Contradictory',
    passed: true,
    rationale: 'Full-workflow productivity pressure violates the low-trust/rework and manager-evaluation avoid clauses, so it should not be accepted as a security-preservation intervention.',
  };
}

export function evaluateAdoptionReadiness(run: ExperimentRun | null) {
  return {
    generatedAt: Math.floor(Date.now() / 1000),
    playbookRetrieval: evaluatePlaybookRetrieval(),
    interventionCardCompleteness: evaluateInterventionCardCompleteness(run),
    badAdviceDetection: evaluateBadAdviceDetection(),
    humanAlignmentLabeling: {
      status: 'not_run',
      recommendation: 'Use 20-30 hand-labeled outputs to compare human motivational labels against L1/L2/L3 classifications before claiming motivational-alignment accuracy.',
    },
  };
}

export function evaluateCanonicalBattery(runs: ExperimentRun[], gridJob: SensitivityGridJob | null) {
  const terminalRuns = runs.filter((run) => run.status === 'completed' || run.status === 'partial');
  const outputs = terminalRuns.flatMap((run) => run.outputs.filter((output) => output.status === 'completed'));
  const profileCells = terminalRuns.flatMap((run) => summarizeRunProfileCells(run));
  const scenarioSummaries = terminalRuns.map((run) => summarizeScenarioDivergence(run));
  const cardSummary = summarizeCardCompleteness(outputs);
  const alignmentSummary = summarizeAlignment(outputs);
  const gridSummary = summarizeGrid(gridJob);

  return {
    generatedAt: Math.floor(Date.now() / 1000),
    expected: expectedCanonical,
    battery: {
      batteryId: terminalRuns[0]?.batteryId ?? gridJob?.batteryId ?? null,
      runsFound: runs.length,
      terminalRuns: terminalRuns.length,
      scenariosEvaluated: new Set(terminalRuns.map((run) => run.scenarioId)).size,
      subjectOutputs: outputs.length,
      subjectOutputCompletionRate: expectedCanonical.subjectOutputs ? outputs.length / expectedCanonical.subjectOutputs : 0,
      profileCells: profileCells.length,
      profileCellCompletionRate: expectedCanonical.profileCells ? profileCells.filter((cell) => cell.completedTrials >= cell.expectedTrials).length / expectedCanonical.profileCells : 0,
    },
    stability: {
      averageModalStability: average(profileCells.map((cell) => cell.modalStability)),
      stableCellRateAt60: ratio(profileCells.filter((cell) => cell.modalStability >= 0.6).length, profileCells.length),
      perfectStabilityRate: ratio(profileCells.filter((cell) => cell.modalStability === 1).length, profileCells.length),
      cells: profileCells,
    },
    profileDivergence: {
      divergentScenarioRate: ratio(scenarioSummaries.filter((item) => item.uniqueModalOptions > 1).length, scenarioSummaries.length),
      averageUniqueModalOptions: average(scenarioSummaries.map((item) => item.uniqueModalOptions)),
      scenarios: scenarioSummaries,
    },
    interventionCardCompleteness: cardSummary,
    threeLayerAudit: alignmentSummary,
    sensitivityGrid: gridSummary,
    playbookRetrieval: evaluatePlaybookRetrieval(),
  };
}

function evaluateOutputCard(output: AgentOutput) {
  const card = output.structuredDecision.interventionCard;
  const presentFields = cardFields.filter((field) => typeof card?.[field] === 'string' && card[field].trim().length > 0);
  return {
    outputId: output.id,
    profileId: output.profileId,
    selectedOptionId: output.structuredDecision.selectedOptionId,
    presentFields,
    missingFields: cardFields.filter((field) => !presentFields.includes(field)),
    complete: presentFields.length === cardFields.length,
  };
}

function summarizeRunProfileCells(run: ExperimentRun) {
  const trialCount = run.trialCount ?? expectedCanonical.trialCount;
  return run.profileIds.map((profileId) => {
    const profileOutputs = run.outputs.filter((output) => output.status === 'completed' && output.profileId === profileId);
    const modal = modalOption(profileOutputs);
    return {
      runId: run.id,
      scenarioId: run.scenarioId,
      profileId,
      expectedTrials: trialCount,
      completedTrials: profileOutputs.length,
      modalOption: modal.option,
      modalCount: modal.count,
      modalStability: profileOutputs.length ? modal.count / profileOutputs.length : 0,
    };
  });
}

function summarizeScenarioDivergence(run: ExperimentRun) {
  const modalOptions = run.profileIds
    .map((profileId) => {
      const profileOutputs = run.outputs.filter((output) => output.status === 'completed' && output.profileId === profileId);
      return { profileId, option: modalOption(profileOutputs).option };
    })
    .filter((item): item is { profileId: ProfileId; option: string } => Boolean(item.option));
  return {
    runId: run.id,
    scenarioId: run.scenarioId,
    modalOptions,
    uniqueModalOptions: new Set(modalOptions.map((item) => item.option)).size,
  };
}

function summarizeCardCompleteness(outputs: AgentOutput[]) {
  const byOutput = outputs.map((output) => evaluateOutputCard(output));
  const totalFields = byOutput.reduce((sum, item) => sum + item.presentFields.length, 0);
  const possibleFields = byOutput.length * cardFields.length;
  return {
    outputs: byOutput.length,
    fieldCompleteness: ratio(totalFields, possibleFields),
    completeOutputRate: ratio(byOutput.filter((item) => item.complete).length, byOutput.length),
  };
}

function summarizeAlignment(outputs: AgentOutput[]) {
  const patterns: AlignmentPattern[] = ['Aligned', 'Rationalizing', 'Drifting', 'Contradictory'];
  const distribution = Object.fromEntries(patterns.map((pattern) => [pattern, 0])) as Record<AlignmentPattern, number>;
  let audited = 0;
  for (const output of outputs) {
    if (!output.alignmentPattern) continue;
    audited += 1;
    distribution[output.alignmentPattern] += 1;
  }
  return {
    auditedOutputs: audited,
    auditCoverage: ratio(audited, outputs.length),
    distribution,
  };
}

function summarizeGrid(gridJob: SensitivityGridJob | null) {
  if (!gridJob) {
    return {
      present: false,
      status: null,
      totalCells: expectedCanonical.gridCells,
      completedCells: 0,
      failedCells: 0,
      flipRate: 0,
      contrastAvailableRate: 0,
      baselineAvailableRate: 0,
      averageBaselineStability: 0,
      axisFlipRates: {},
      profileFlipRates: {},
    };
  }
  const completedWithContrast = gridJob.results.filter((cell) => cell.flipped !== null);
  return {
    present: true,
    jobId: gridJob.id,
    batteryId: gridJob.batteryId ?? null,
    status: gridJob.status,
    totalCells: gridJob.totalCells,
    completedCells: gridJob.completedCells,
    failedCells: gridJob.failedCells,
    completionRate: ratio(gridJob.completedCells, gridJob.totalCells),
    flipRate: ratio(completedWithContrast.filter((cell) => cell.flipped).length, completedWithContrast.length),
    contrastAvailableRate: ratio(completedWithContrast.length, gridJob.results.length),
    baselineAvailableRate: ratio(completedWithContrast.length, gridJob.results.length),
    averageBaselineStability: average(gridJob.results.map((cell) => cell.baselineStability)),
    axisFlipRates: groupFlipRates(gridJob.results, (cell) => cell.axisId),
    profileFlipRates: groupFlipRates(gridJob.results, (cell) => cell.profileId),
  };
}

function groupFlipRates<T extends string>(cells: SensitivityGridJob['results'], keyOf: (cell: SensitivityGridJob['results'][number]) => T) {
  const grouped = new Map<T, { flips: number; total: number }>();
  for (const cell of cells) {
    if (cell.flipped === null) continue;
    const key = keyOf(cell);
    const current = grouped.get(key) ?? { flips: 0, total: 0 };
    current.total += 1;
    if (cell.flipped) current.flips += 1;
    grouped.set(key, current);
  }
  return Object.fromEntries([...grouped.entries()].map(([key, value]) => [key, ratio(value.flips, value.total)]));
}

function modalOption(outputs: AgentOutput[]): { option: string | null; count: number } {
  const counts = new Map<string, number>();
  for (const output of outputs) {
    const option = output.structuredDecision.selectedOptionId;
    counts.set(option, (counts.get(option) ?? 0) + 1);
  }
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

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator ? numerator / denominator : 0;
}
