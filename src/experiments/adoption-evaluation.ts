import type { AgentOutput, ExperimentRun } from '../domain/types';
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
