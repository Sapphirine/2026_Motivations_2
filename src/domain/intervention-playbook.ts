import type { AxisId, Scenario } from './types';

export type InterventionPolicy = {
  id: string;
  blocker: string;
  signals: string[];
  recommendedFrame: AxisId[];
  strategy: string;
  interventionTemplate: string;
  avoid: string;
};

const policies: InterventionPolicy[] = [
  {
    id: 'low-trust-output',
    blocker: 'low trust in AI output',
    signals: ['do not trust', 'distrust', 'wrong', 'wrong answers', 'hallucinated', 'review overhead', 'rework', 'quality', 'generated code', 'trust generated'],
    recommendedFrame: ['security', 'achievement'],
    strategy: 'bounded low-risk experiment',
    interventionTemplate: 'Use AI only on a reversible support task with a clear stop condition, then compare its output against the worker own baseline.',
    avoid: 'forcing full-workflow adoption or measuring raw usage before trust is established',
  },
  {
    id: 'manager-evaluation-anxiety',
    blocker: 'fear of manager evaluation',
    signals: ['manager', 'dependence', 'less capable', 'competence', 'performance review', 'stigma', 'perceived dependence', 'seen as'],
    recommendedFrame: ['benevolence', 'security'],
    strategy: 'manager-safe accountability statement',
    interventionTemplate: 'Give the worker language that frames AI use as careful experimentation and skill-building rather than dependency.',
    avoid: 'public leaderboards or usage dashboards that make first use feel like surveillance',
  },
  {
    id: 'unclear-use-case',
    blocker: 'unclear workflow entry point',
    signals: ['where to use', 'which workflow', 'unclear', 'too busy', 'not sure', 'use case'],
    recommendedFrame: ['selfDirection', 'achievement'],
    strategy: 'use-case menu',
    interventionTemplate: 'Offer three low-risk workflow options and let the worker choose the first one that feels relevant this week.',
    avoid: 'generic training content that does not connect to a concrete task',
  },
  {
    id: 'rework-risk',
    blocker: 'concern that AI increases rework',
    signals: ['rework', 'create rework', 'takes longer', 'edited', 'editing', 'writing from scratch', 'review overhead', 'approval churn'],
    recommendedFrame: ['security', 'achievement'],
    strategy: 'compare-before-adopt trial',
    interventionTemplate: 'Run AI on one already-completed task and compare time saved, quality, and editing burden before using it live.',
    avoid: 'asking the worker to use AI on active sensitive work before the rework cost is visible',
  },
  {
    id: 'professional-identity-threat',
    blocker: 'professional identity threat',
    signals: ['voice', 'personal voice', 'craft', 'legal quality', 'lower-quality', 'expertise', 'professional', 'personal style', 'creative ownership'],
    recommendedFrame: ['benevolence', 'selfDirection'],
    strategy: 'human-in-command framing',
    interventionTemplate: 'Position AI as a suggestion generator while the worker keeps final judgment, voice, and accountability.',
    avoid: 'messages that imply the tool replaces expert judgment or standardizes professional work',
  },
  {
    id: 'data-confidentiality',
    blocker: 'confidentiality or data-boundary concern',
    signals: ['confidential', 'policy', 'legal', 'customer data', 'benefits', 'leave', 'security'],
    recommendedFrame: ['security'],
    strategy: 'approved-input boundary',
    interventionTemplate: 'Start with approved public, archived, or synthetic material and name exactly what data must not be entered.',
    avoid: 'open-ended prompting on sensitive, live, or personally identifying information',
  },
  {
    id: 'peer-norm-resistance',
    blocker: 'peer norm resistance',
    signals: ['peers', 'team norms', 'manual', 'public', 'shared workflow', 'social'],
    recommendedFrame: ['benevolence', 'achievement'],
    strategy: 'peer-supported trial',
    interventionTemplate: 'Pair two workers for a short AI-assisted trial and have them compare what helped, what failed, and what should remain human.',
    avoid: 'individual pressure that makes adoption feel like a competence contest',
  },
  {
    id: 'governance-uncertainty',
    blocker: 'unclear governance',
    signals: ['approved', 'governance', 'policy', 'audit', 'risk', 'compliance', 'audit trail', 'explainable'],
    recommendedFrame: ['security'],
    strategy: 'safe-use checklist',
    interventionTemplate: 'Attach a short checklist for allowed inputs, required review, and when to stop or escalate.',
    avoid: 'asking employees to infer policy boundaries from tool availability alone',
  },
  {
    id: 'productivity-pressure-backlash',
    blocker: 'pressure-based adoption backlash',
    signals: ['pressure', 'leaderboard', 'scoreboard', 'forced', 'mandate', 'usage target'],
    recommendedFrame: ['benevolence', 'security'],
    strategy: 'psychological-safety reset',
    interventionTemplate: 'Remove penalties from the first experiment and define success as learning where AI helps or hurts.',
    avoid: 'counting usage volume as the first success metric',
  },
  {
    id: 'time-scarcity',
    blocker: 'time scarcity',
    signals: ['too busy', 'time', 'deadline', 'no time', 'rush', 'capacity'],
    recommendedFrame: ['achievement', 'security'],
    strategy: 'ten-minute task wedge',
    interventionTemplate: 'Use a ten-minute micro-task that happens inside an existing workflow and does not add a separate training session.',
    avoid: 'long documentation assignments before the worker sees practical value',
  },
  {
    id: 'auditability-risk',
    blocker: 'auditability and accountability risk',
    signals: ['audit', 'accountability', 'assumption', 'forecast', 'metric', 'citation', 'dashboard', 'audit trail', 'blamed'],
    recommendedFrame: ['security', 'achievement'],
    strategy: 'traceable-output trial',
    interventionTemplate: 'Require AI output to cite its source inputs or assumptions, then have the worker validate the trace before using the result.',
    avoid: 'accepting AI-generated analysis without provenance or review notes',
  },
  {
    id: 'customer-facing-risk',
    blocker: 'customer-facing quality risk',
    signals: ['customer', 'brand', 'tone', 'support', 'external', 'response'],
    recommendedFrame: ['benevolence', 'security'],
    strategy: 'internal-only rehearsal',
    interventionTemplate: 'Run AI internally on a past customer-facing artifact, then review tone, accuracy, and escalation risk before live use.',
    avoid: 'sending first AI-assisted output directly to customers',
  },
  {
    id: 'training-fatigue',
    blocker: 'training fatigue',
    signals: ['training', 'documentation', 'course', 'already trained', 'fatigue'],
    recommendedFrame: ['achievement', 'selfDirection'],
    strategy: 'task-first enablement',
    interventionTemplate: 'Replace another training module with one concrete task, a prompt starter, and a visible before/after comparison.',
    avoid: 'more passive documentation when the blocker is behavior, not awareness',
  },
  {
    id: 'workflow-friction',
    blocker: 'workflow friction',
    signals: ['switching', 'separate tool', 'workflow', 'handoff', 'friction', 'copy paste'],
    recommendedFrame: ['achievement', 'security'],
    strategy: 'in-workflow insertion',
    interventionTemplate: 'Place the first AI action inside a tool or step the worker already uses, then measure whether it reduces or adds friction.',
    avoid: 'new standalone portals that require context switching before value is proven',
  },
  {
    id: 'autonomy-threat',
    blocker: 'loss of autonomy',
    signals: ['mandate', 'forced', 'choice', 'autonomy', 'control', 'opt out'],
    recommendedFrame: ['selfDirection', 'benevolence'],
    strategy: 'choice-preserving trial',
    interventionTemplate: 'Let the worker choose the task, the stop condition, and what evidence would make the tool worth trying again.',
    avoid: 'one-size-fits-all adoption playbooks that ignore local workflow context',
  },
  {
    id: 'roi-visibility-gap',
    blocker: 'ROI visibility gap',
    signals: ['roi', 'license', 'seat', 'cost', 'renewal', 'value', 'business case'],
    recommendedFrame: ['achievement'],
    strategy: 'small ROI ledger',
    interventionTemplate: 'Track one concrete before/after measure such as minutes saved, rework avoided, or quality defects caught during the micro-trial.',
    avoid: 'high-level AI enthusiasm without a measurable operational signal',
  },
  {
    id: 'human-care-concern',
    blocker: 'human-care concern',
    signals: ['impersonal', 'employee', 'benefits', 'leave', 'accommodation', 'care'],
    recommendedFrame: ['benevolence', 'security'],
    strategy: 'human-first review',
    interventionTemplate: 'Use AI only to draft or locate policy support, then require a human review step before any employee-facing response.',
    avoid: 'automation-first messaging in sensitive employee or customer moments',
  },
  {
    id: 'low-competence-confidence',
    blocker: 'low confidence using AI well',
    signals: ['prompt', 'skill', 'do not know how', 'confidence', 'new to AI'],
    recommendedFrame: ['achievement', 'benevolence'],
    strategy: 'small mastery experience',
    interventionTemplate: 'Give one prompt starter, one success criterion, and one review checklist so the first attempt creates confidence instead of confusion.',
    avoid: 'asking for sophisticated prompt engineering before the worker has a first win',
  },
];

function scorePolicy(policy: InterventionPolicy, scenario: Scenario): number {
  const primaryText = [
    scenario.title,
    scenario.domain,
    scenario.context,
  ].join(' ').toLowerCase();
  const secondaryText = [
    scenario.tradeoffs.join(' '),
    scenario.conflictNotes,
  ].join(' ').toLowerCase();
  const stakeholderText = scenario.stakeholders.join(' ').toLowerCase();

  let score = 0;
  for (const signal of policy.signals) {
    const normalized = signal.toLowerCase();
    if (primaryText.includes(normalized)) score += 2;
    if (secondaryText.includes(normalized)) score += 0.5;
    if (stakeholderText.includes(normalized)) score += 0.1;
  }
  return score;
}

export function retrieveInterventionPolicies(scenario: Scenario, limit = 4): InterventionPolicy[] {
  return [...policies]
    .map((policy) => ({ policy, score: scorePolicy(policy, scenario) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.policy.id.localeCompare(b.policy.id))
    .slice(0, limit)
    .map((entry) => entry.policy);
}

export function listInterventionPolicies(): InterventionPolicy[] {
  return policies;
}
