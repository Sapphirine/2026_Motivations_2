import { presetScenarios } from '../domain/seeds';
import type { AgentOutput, Env, ExperimentRun, Scenario } from '../domain/types';
import { detectRiskContext, retrievePolicyGrounding } from '../services/policy-rag';
import { getRunAuthoritative, listRecentRunsFromD1 } from '../services/storage';

type PolicyRagFixture = {
  scenarioId: string;
  expectedDomain: string;
  expectedRiskTypes: string[];
  expectedChunkIds: string[];
};

const fixtures: PolicyRagFixture[] = [
  {
    scenarioId: 'coding-assistant-low-trust-evaluation-anxiety',
    expectedDomain: 'software engineering',
    expectedRiskTypes: ['output accuracy', 'security', 'surveillance', 'worker well-being'],
    expectedChunkIds: ['software-code-review-001', 'nist-genai-profile-content-001', 'nist-csf-001'],
  },
  {
    scenarioId: 'customer-support-ai-draft-rework-risk',
    expectedDomain: 'customer support',
    expectedRiskTypes: ['consumer harm', 'output accuracy', 'human oversight'],
    expectedChunkIds: ['support-quality-001', 'nist-genai-profile-content-001', 'ftc-ai-claims-001'],
  },
  {
    scenarioId: 'analytics-copilot-data-confidence-gap',
    expectedDomain: 'business analytics',
    expectedRiskTypes: ['output accuracy', 'human oversight', 'model validation', 'accountability'],
    expectedChunkIds: ['nist-ai-rmf-measure-001', 'model-risk-management-002', 'nist-genai-profile-content-001'],
  },
  {
    scenarioId: 'manager-stigma-ai-dependence',
    expectedDomain: 'workplace AI adoption',
    expectedRiskTypes: ['worker well-being', 'surveillance', 'transparency'],
    expectedChunkIds: ['dol-ai-worker-001', 'dol-ai-transparency-001', 'ibm-trust-001'],
  },
  {
    scenarioId: 'legal-review-ai-confidentiality-concern',
    expectedDomain: 'legal operations',
    expectedRiskTypes: ['confidentiality', 'output accuracy', 'human oversight'],
    expectedChunkIds: ['aba-legal-ai-001', 'aba-legal-confidentiality-001', 'nist-genai-profile-data-001'],
  },
  {
    scenarioId: 'sales-ai-coach-unclear-use-case',
    expectedDomain: 'sales',
    expectedRiskTypes: ['consumer harm', 'worker well-being', 'transparency'],
    expectedChunkIds: ['dol-ai-training-001', 'nist-ai-rmf-map-001', 'ftc-ai-claims-001'],
  },
  {
    scenarioId: 'marketing-ai-content-brand-risk',
    expectedDomain: 'marketing',
    expectedRiskTypes: ['consumer harm', 'deceptive claims', 'output accuracy'],
    expectedChunkIds: ['ftc-ai-claims-001', 'nist-genai-profile-transparency-001', 'nist-genai-profile-content-001'],
  },
  {
    scenarioId: 'finance-ai-forecasting-accountability-risk',
    expectedDomain: 'finance',
    expectedRiskTypes: ['model validation', 'accountability', 'human oversight'],
    expectedChunkIds: ['model-risk-management-001', 'model-risk-management-002', 'nist-ai-rmf-measure-001'],
  },
  {
    scenarioId: 'hr-ai-policy-answer-trust-gap',
    expectedDomain: 'human resources',
    expectedRiskTypes: ['bias and fairness', 'human oversight', 'privacy', 'worker well-being'],
    expectedChunkIds: ['eeoc-selection-001', 'eeoc-accommodation-001', 'openai-usage-high-stakes-001'],
  },
];

export async function evaluatePolicyRag(env: Env) {
  const scenarioById = new Map(presetScenarios.map((scenario) => [scenario.id, scenario]));
  const fixtureRows = fixtures
    .map((fixture) => {
      const scenario = scenarioById.get(fixture.scenarioId);
      return scenario ? { fixture, scenario } : null;
    })
    .filter((row): row is { fixture: PolicyRagFixture; scenario: Scenario } => Boolean(row));

  const riskRows = fixtureRows.map(({ fixture, scenario }) => {
    const detected = detectRiskContext(scenario);
    const domainMatched = domainMatches(detected.domain, fixture.expectedDomain);
    const matchedRiskTypes = fixture.expectedRiskTypes.filter((risk) => riskMatches(detected.riskTypes, risk));
    const missingRiskTypes = fixture.expectedRiskTypes.filter((risk) => !matchedRiskTypes.includes(risk));
    const expectedLabels = 1 + fixture.expectedRiskTypes.length;
    const matchedLabels = (domainMatched ? 1 : 0) + matchedRiskTypes.length;
    return {
      scenarioId: scenario.id,
      title: scenario.title,
      expectedDomain: fixture.expectedDomain,
      detectedDomain: detected.domain,
      domainMatched,
      expectedRiskTypes: fixture.expectedRiskTypes,
      detectedRiskTypes: detected.riskTypes,
      matchedRiskTypes,
      missingRiskTypes,
      matchedLabels,
      expectedLabels,
      passed: domainMatched && missingRiskTypes.length === 0,
    };
  });

  const retrievalRows = await Promise.all(fixtureRows.map(async ({ fixture, scenario }) => {
    const grounding = await retrievePolicyGrounding(env, scenario, { topK: 5, timeoutMs: 1200 });
    const retrievedChunkIds = grounding.chunks.map((chunk) => chunk.id);
    const matchedChunkIds = fixture.expectedChunkIds.filter((chunkId) => retrievedChunkIds.includes(chunkId));
    const missingChunkIds = fixture.expectedChunkIds.filter((chunkId) => !matchedChunkIds.includes(chunkId));
    return {
      scenarioId: scenario.id,
      title: scenario.title,
      enabled: grounding.enabled,
      mode: grounding.mode,
      warning: grounding.warning ?? null,
      expectedChunkIds: fixture.expectedChunkIds,
      retrievedChunkIds,
      matchedChunkIds,
      missingChunkIds,
      recallAt5: fixture.expectedChunkIds.length ? matchedChunkIds.length / fixture.expectedChunkIds.length : null,
    };
  }));

  const uptake = await evaluateConstraintUptake(env);
  const totalRiskLabels = sum(riskRows.map((row) => row.expectedLabels));
  const matchedRiskLabels = sum(riskRows.map((row) => row.matchedLabels));
  const totalExpectedChunks = sum(retrievalRows.map((row) => row.expectedChunkIds.length));
  const matchedExpectedChunks = sum(retrievalRows.map((row) => row.matchedChunkIds.length));
  const retrievalAvailable = retrievalRows.some((row) => row.enabled && row.retrievedChunkIds.length > 0);

  return {
    generatedAt: Math.floor(Date.now() / 1000),
    corpus: {
      canonicalScenarios: fixtureRows.length,
      curatedPolicyChunks: 37,
      sourcePath: 'rag_corpus/policy_chunks.json',
    },
    riskDetection: {
      passedScenarios: riskRows.filter((row) => row.passed).length,
      totalScenarios: riskRows.length,
      matchedLabels: matchedRiskLabels,
      expectedLabels: totalRiskLabels,
      labelCoverage: totalRiskLabels ? matchedRiskLabels / totalRiskLabels : null,
      rows: riskRows,
    },
    retrievalRecall: {
      available: retrievalAvailable,
      recallAt5: totalExpectedChunks ? matchedExpectedChunks / totalExpectedChunks : null,
      matchedExpectedChunks,
      expectedChunks: totalExpectedChunks,
      rows: retrievalRows,
    },
    constraintUptake: uptake,
  };
}

async function evaluateConstraintUptake(env: Env) {
  const fixtureScenarioIds = new Set(fixtures.map((fixture) => fixture.scenarioId));
  const summaries = await listRecentRunsFromD1(env, 200);
  const runs = (await Promise.all(
    summaries.map((summary) => getRunAuthoritative(env, summary.runId, { hydrateOutputs: true })),
  )).filter((run): run is ExperimentRun => Boolean(run));
  const latestByScenario = new Map<string, ExperimentRun>();
  for (const run of runs) {
    if (!fixtureScenarioIds.has(run.scenarioId)) continue;
    const previous = latestByScenario.get(run.scenarioId);
    if (!previous || (run.completedAt ?? run.createdAt) > (previous.completedAt ?? previous.createdAt)) {
      latestByScenario.set(run.scenarioId, run);
    }
  }
  const outputs = Array.from(latestByScenario.values()).flatMap((run) => run.outputs ?? []);
  const completedOutputs = outputs.filter((output) => output.status === 'completed');
  const withCompliance = completedOutputs.filter((output) => output.structuredDecision?.policyCompliance);
  const passOutputs = withCompliance.filter((output) => output.structuredDecision.policyCompliance?.status === 'pass');
  const reviewOutputs = withCompliance.filter((output) => output.structuredDecision.policyCompliance?.status === 'review');
  const unavailableOutputs = completedOutputs.length - withCompliance.length
    + withCompliance.filter((output) => output.structuredDecision.policyCompliance?.status === 'unavailable').length;
  const rows = summarizeUptakeByScenario(Array.from(latestByScenario.values()));
  return {
    available: completedOutputs.length > 0 && withCompliance.length > 0,
    evaluatedOutputs: completedOutputs.length,
    outputsWithCompliance: withCompliance.length,
    passOutputs: passOutputs.length,
    reviewOutputs: reviewOutputs.length,
    unavailableOutputs,
    uptakeRate: withCompliance.length ? passOutputs.length / withCompliance.length : null,
    rows,
  };
}

function summarizeUptakeByScenario(runs: ExperimentRun[]) {
  return runs.map((run) => {
    const outputs = (run.outputs ?? []).filter((output): output is AgentOutput => output.status === 'completed');
    const checks = outputs.map((output) => output.structuredDecision?.policyCompliance).filter(Boolean);
    const pass = checks.filter((check) => check?.status === 'pass').length;
    const review = checks.filter((check) => check?.status === 'review').length;
    const unavailable = outputs.length - checks.length + checks.filter((check) => check?.status === 'unavailable').length;
    return {
      scenarioId: run.scenarioId,
      title: run.scenarioSnapshot.title,
      runId: run.id,
      evaluatedOutputs: outputs.length,
      pass,
      review,
      unavailable,
    };
  });
}

function domainMatches(actual: string, expected: string): boolean {
  const a = normalize(actual);
  const e = normalize(expected);
  return a === e || a.includes(e) || e.includes(a);
}

function riskMatches(actualRisks: string[], expectedRisk: string): boolean {
  const expected = normalize(expectedRisk);
  return actualRisks.some((risk) => {
    const actual = normalize(risk);
    return actual === expected || actual.includes(expected) || expected.includes(actual);
  });
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
