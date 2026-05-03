import type { AgentOutput, EvaluationMetric, ModeratorSynthesis, ProfileId } from '../domain/types';
import { id, nowSeconds } from './storage';

export function synthesizeRun(runId: string, outputs: AgentOutput[], model: string): ModeratorSynthesis {
  const selected = new Map(outputs.map((output) => [output.profileId, output.structuredDecision.selectedOptionId]));
  const uniqueSelections = new Set(selected.values());
  const substantiveDivergence = uniqueSelections.size > 1;

  return {
    id: id('synthesis'),
    runId,
    moderatorProvider: 'deterministic',
    moderatorModel: model,
    agreementSummary: substantiveDivergence ? 'Agents used the same adoption-case facts but selected different interventions.' : 'Agents selected the same intervention with different wording.',
    disagreementSummary: substantiveDivergence ? summarizeSelections(selected) : 'No selected-intervention difference found.',
    substantiveDivergence,
    pathAttribution: outputs.map((output) => {
      const topDrives = [...output.driveTrace]
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 2)
        .map((drive) => drive.drive)
        .join(', ');
      return {
        profileId: output.profileId,
        attribution: `${output.profileSnapshot.name} selected ${output.structuredDecision.selectedOptionId} with visible motivation weights: ${topDrives}.`,
        support: 'supported',
      };
    }),
    rubricNotes: { method: 'selected-intervention and motivation-weight comparison', rubricVersion: 'mvp-1' },
    rawOutput: JSON.stringify(Object.fromEntries(selected), null, 2),
    createdAt: nowSeconds(),
  };
}

export function computeMetrics(runId: string, outputs: AgentOutput[], synthesis: ModeratorSynthesis): EvaluationMetric[] {
  const total = outputs.length || 1;
  const uniqueSelections = new Set(outputs.map((output) => output.structuredDecision.selectedOptionId));
  const divergenceScore = Math.min(1, (uniqueSelections.size - 1) / Math.max(1, total - 1));
  const signatureAligned = outputs.filter((output) => output.driveTrace.some((trace) => trace.influence === 'high')).length;

  return [
    {
      id: id('metric'),
      runId,
      metricType: 'divergence',
      metricValue: divergenceScore,
      metricLabel: synthesis.substantiveDivergence ? 'different selected interventions' : 'same selected intervention',
      method: 'selected-intervention comparison',
      rubricVersion: 'mvp-1',
      details: { uniqueSelections: [...uniqueSelections] },
      createdAt: nowSeconds(),
    },
    {
      id: id('metric'),
      runId,
      metricType: 'signature',
      metricValue: signatureAligned / total,
      metricLabel: 'motivation weight evidence present',
      method: 'motivation weight evidence coverage',
      rubricVersion: 'mvp-1',
      details: { alignedOutputs: signatureAligned, total },
      createdAt: nowSeconds(),
    },
    {
      id: id('metric'),
      runId,
      metricType: 'attribution',
      metricValue: synthesis.pathAttribution.filter((item) => item.support === 'supported').length / total,
      metricLabel: 'comparison note supported',
      method: 'comparison note coverage',
      rubricVersion: 'mvp-1',
      details: { pathAttribution: synthesis.pathAttribution },
      createdAt: nowSeconds(),
    },
  ];
}

function summarizeSelections(selected: Map<ProfileId, string>): string {
  return [...selected.entries()].map(([profileId, selectedOptionId]) => `${profileId}: ${selectedOptionId}`).join('; ');
}
