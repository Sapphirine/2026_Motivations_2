import type { PolicyGroundingResult, Scenario, ValueProfile } from '../domain/types';
import { retrieveInterventionPolicies } from '../domain/intervention-playbook';
import { formatPolicyGroundingForPrompt } from './policy-rag';

export function translateProfilePrompt(profile: ValueProfile, scenario: Scenario, policyGrounding?: PolicyGroundingResult): string {
  const weights = profile.axisWeights
    .map((weight) => `${weight.label}: ${weight.level.toUpperCase()} (${weight.value})`)
    .join('\n');
  const playbook = retrieveInterventionPolicies(scenario)
    .map((policy) => [
      `- Blocker: ${policy.blocker}`,
      `  Strategy: ${policy.strategy}`,
      `  Frames: ${policy.recommendedFrame.join(', ')}`,
      `  Template: ${policy.interventionTemplate}`,
      `  Avoid: ${policy.avoid}`,
    ].join('\n'))
    .join('\n');

  return [
    'You are participating in a controlled MotiveOps experiment for AI workflow adoption.',
    `Profile: ${profile.name}`,
    profile.promptTranslation,
    'Only the motivational lens changes. Do not alter adoption-case facts, available intervention options, stakeholder information, or the experimental disclaimer.',
    'Weights:',
    weights,
    `Adoption case: ${scenario.title}`,
    `Context: ${scenario.context}`,
    `Intervention options: ${scenario.decisionOptions.map((option) => `${option.id}: ${option.label}`).join('; ')}`,
    `Stakeholders: ${scenario.stakeholders.join(', ')}`,
    `Tradeoffs: ${scenario.tradeoffs.join(', ')}`,
    playbook ? `Retrieved Behavioral Intervention Playbook policies:\n${playbook}` : 'Retrieved Behavioral Intervention Playbook policies: none matched. Use the scenario facts and keep the intervention bounded.',
    formatPolicyGroundingForPrompt(policyGrounding),
    'Task: choose the most motivationally coherent micro-intervention option for this worker or team. Diagnose the adoption blocker, explain why the intervention fits the profile, and avoid generic encouragement.',
    'Policy-grounding task: when retrieved policy constraints are available, make the micro-action explicitly compatible with the detected risk context. Mention concrete safeguards in riskNotes, interventionCard.ifThenPlan, or interventionCard.successMetric when relevant.',
    'Return strict JSON with selectedOptionId, rankedOptions, decisionSummary, interventionCard, rationale, tradeoffs, driveAttributions, confidence, riskNotes, and notAdviceDisclaimer=true.',
    'The interventionCard object must include exactly these user-facing fields: diagnosedBlocker, motivationProfile, retrievedStrategy, microAction, ifThenPlan, accountabilityScript, and successMetric. Keep each field concrete enough for a manager or enablement lead to inspect.',
    scenario.disclaimer,
  ].join('\n\n');
}
