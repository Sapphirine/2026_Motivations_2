import type { Scenario, ValueProfile } from './types';

const now = 1_777_249_600;
const disclaimer = 'This is a fictional workplace adoption scenario. Outputs are experimental evidence for comparing intervention alignment and must not be used as employment, legal, HR, or performance-management advice.';

type OptionSpec = { id: string; label: string; description: string };

const opt = (id: string, label: string, description: string): OptionSpec => ({ id, label, description });

const standardOptions = (
  achievementLabel: string,
  securityLabel: string,
  benevolenceLabel: string,
  explorationLabel: string,
): OptionSpec[] => [
  opt('option_a', achievementLabel, 'Use a productivity-forward challenge with a visible success metric and a short timebox. This can work for high-competence, low-anxiety workers, but can backfire when trust or evaluation anxiety is the main blocker.'),
  opt('option_b', securityLabel, 'Use a bounded, reversible experiment on a low-risk support task with a clear stop condition. The worker can compare AI output to their own work before adopting anything.'),
  opt('option_c', benevolenceLabel, 'Use peer support, manager-safe language, or psychological-safety framing so the worker does not experience AI use as a competence threat.'),
  opt('option_d', explorationLabel, 'Use an exploratory sandbox, menu of use cases, or autonomy-preserving trial so the worker can discover where AI fits without being forced into a full workflow change.'),
];

/**
 * 9-Case MotiveOps Canonical Battery.
 *
 * The previous decision-analysis scenarios are reframed as AI workflow
 * adoption cases. The option structure stays intact: every case still has
 * four stable option ids so the existing three-layer audit and sensitivity
 * grid can run without a schema rewrite.
 *
 * Group A: Trust vs Productivity         (Security vs Achievement)
 * Group B: Psychological Safety vs Speed (Benevolence vs Achievement)
 * Group C: Exploration vs Process Risk   (Self-Direction vs Security)
 */
export const presetScenarios: Scenario[] = [
  {
    id: 'coding-assistant-low-trust-evaluation-anxiety',
    kind: 'preset',
    title: 'AI Coding Assistant: Low Trust and Manager Anxiety',
    domain: 'software engineering adoption',
    context:
      'A software engineer avoids the company AI coding assistant even though the team has paid enterprise seats. They do not trust generated code, worry that accepting AI output will create rework, and fear their manager will see AI use as dependence rather than competence. The company wants one intervention that converts training into safe first use without turning adoption into surveillance.',
    decisionOptions: standardOptions(
      'All-week coding productivity challenge',
      '10-minute unit-test-name experiment',
      'Manager-safe accountability statement',
      'Choose-your-own support-task sandbox',
    ),
    stakeholders: ['software engineer', 'engineering manager', 'team lead', 'AI enablement owner', 'security reviewer'],
    tradeoffs: ['AI trust', 'rework risk', 'manager perception', 'time-to-first-use', 'licensed-seat ROI'],
    conflictNotes:
      'Achievement may push for a visible productivity challenge. Security should prefer a reversible low-risk experiment. Benevolence should reduce evaluation anxiety through manager-safe framing. Self-direction should preserve choice over the first use case.',
    disclaimer,
    version: 2,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'customer-support-ai-draft-rework-risk',
    kind: 'preset',
    title: 'Support Copilot: Draft Quality and Rework Fear',
    domain: 'customer support adoption',
    context:
      'A customer support team has access to an AI drafting tool, but experienced agents avoid it because edited drafts sometimes take longer than writing from scratch. They worry about tone mistakes, policy errors, and losing their personal voice with customers. Leadership wants higher usage because support licenses were purchased for the whole team.',
    decisionOptions: standardOptions(
      'Tickets-per-hour AI sprint',
      'Low-risk draft comparison on one solved ticket',
      'Peer review of AI-assisted draft edits',
      'Prompt sandbox for tone variants',
    ),
    stakeholders: ['support agents', 'support manager', 'customers', 'quality assurance lead', 'operations finance'],
    tradeoffs: ['response speed', 'brand tone', 'rework load', 'quality assurance', 'seat-utilization ROI'],
    conflictNotes:
      'Achievement may choose a throughput sprint. Security should bound the first trial to a solved or low-risk ticket. Benevolence should use peer review to protect quality and confidence. Self-direction should let agents explore tone controls before production use.',
    disclaimer,
    version: 2,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'analytics-copilot-data-confidence-gap',
    kind: 'preset',
    title: 'Analytics Copilot: Data Confidence Gap',
    domain: 'business analytics adoption',
    context:
      'A revenue operations analyst avoids an AI analytics copilot because they distrust SQL suggestions and fear a wrong metric will spread in an executive dashboard. They already know the data model well and worry AI will add review overhead. The company wants analysts to use the copilot for faster insight generation without weakening data confidence.',
    decisionOptions: standardOptions(
      'Weekly insight-output leaderboard',
      'Read-only query explanation trial',
      'Two-person metric review ritual',
      'Sandbox exploration on archived dashboards',
    ),
    stakeholders: ['revenue analyst', 'data team', 'sales leadership', 'finance partner', 'AI platform owner'],
    tradeoffs: ['data accuracy', 'analysis speed', 'review overhead', 'executive trust', 'analytics capacity'],
    conflictNotes:
      'Achievement may emphasize more insights per week. Security should restrict AI to read-only explanation first. Benevolence should add review support to protect stakeholder trust. Self-direction should test archived dashboards before live reporting.',
    disclaimer,
    version: 2,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'manager-stigma-ai-dependence',
    kind: 'preset',
    title: 'Manager Stigma: AI Use Looks Like Dependence',
    domain: 'team management adoption',
    context:
      'A project manager privately uses AI for meeting summaries but avoids using it in shared workflows because they think peers will see them as less capable. Their director publicly says the organization should use AI more, but team norms still reward doing work manually. The adoption team wants a first intervention that changes the social meaning of AI use.',
    decisionOptions: standardOptions(
      'Public productivity scoreboard',
      'Private low-risk summary check',
      'Leader-normalized AI use script',
      'Voluntary workflow-discovery session',
    ),
    stakeholders: ['project manager', 'director', 'peer managers', 'implementation team', 'HR business partner'],
    tradeoffs: ['competence signaling', 'team norms', 'productivity optics', 'psychological safety', 'behavior change'],
    conflictNotes:
      'Achievement may favor public metrics. Security should start privately. Benevolence should normalize AI use through manager-safe scripts. Self-direction should let the team identify workflows worth trying.',
    disclaimer,
    version: 2,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'legal-review-ai-confidentiality-concern',
    kind: 'preset',
    title: 'Legal Review: Confidentiality and Competence Concern',
    domain: 'legal operations adoption',
    context:
      'An in-house legal team has an approved AI assistant for clause comparison, but attorneys hesitate to use it. They worry about confidentiality boundaries, hallucinated citations, and whether AI-assisted analysis will be perceived as lower-quality legal work. Leadership wants adoption because outside counsel spend is rising.',
    decisionOptions: standardOptions(
      'Outside-counsel-cost reduction challenge',
      'Approved-public-clause comparison trial',
      'Peer-reviewed usage note for matter files',
      'Sandbox map of safe legal use cases',
    ),
    stakeholders: ['in-house attorneys', 'general counsel', 'compliance team', 'business stakeholders', 'outside counsel manager'],
    tradeoffs: ['confidentiality', 'legal quality', 'cost reduction', 'professional identity', 'safe-use governance'],
    conflictNotes:
      'Achievement may frame adoption around cost savings. Security should restrict the first action to approved public or non-confidential text. Benevolence should protect professional identity through peer review. Self-direction should map safe use cases before mandating usage.',
    disclaimer,
    version: 2,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'sales-ai-coach-unclear-use-case',
    kind: 'preset',
    title: 'Sales AI Coach: Unclear Use Case',
    domain: 'sales productivity adoption',
    context:
      'A sales team has an AI coach that can summarize calls, suggest follow-ups, and draft account plans. Reps say they are too busy to experiment and do not know which workflow would actually help close deals. Managers want adoption because the tool is bundled into an expensive CRM renewal.',
    decisionOptions: standardOptions(
      'Pipeline-creation productivity contest',
      'One-call-summary comparison trial',
      'Manager-approved no-penalty experiment',
      'Use-case menu with rep choice',
    ),
    stakeholders: ['sales reps', 'sales managers', 'RevOps team', 'customers', 'finance leadership'],
    tradeoffs: ['selling time', 'deal quality', 'workflow clarity', 'manager pressure', 'CRM renewal ROI'],
    conflictNotes:
      'Achievement may optimize for pipeline activity. Security should begin with one call summary and no live customer risk. Benevolence should remove penalty pressure. Self-direction should offer a menu so reps can choose a relevant use case.',
    disclaimer,
    version: 2,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'marketing-ai-content-brand-risk',
    kind: 'preset',
    title: 'Marketing Content AI: Brand Risk',
    domain: 'marketing adoption',
    context:
      'A marketing team bought an AI writing suite, but brand managers avoid it because generic drafts feel off-brand and require heavy editing. Leadership wants faster campaign output, while the creative team worries that forced AI usage will flatten voice and increase approval churn.',
    decisionOptions: standardOptions(
      'Campaign-output acceleration challenge',
      'Low-risk subject-line variant test',
      'Creative-pair review of AI suggestions',
      'Brand-voice sandbox exploration',
    ),
    stakeholders: ['brand managers', 'creative team', 'marketing leadership', 'legal approvers', 'campaign operations'],
    tradeoffs: ['campaign speed', 'brand quality', 'approval churn', 'creative ownership', 'tool ROI'],
    conflictNotes:
      'Achievement may prefer campaign volume. Security should start with reversible variants. Benevolence should protect creative ownership through paired review. Self-direction should use a brand-voice sandbox to discover fit.',
    disclaimer,
    version: 2,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'finance-ai-forecasting-accountability-risk',
    kind: 'preset',
    title: 'Finance Forecasting AI: Accountability Risk',
    domain: 'finance planning adoption',
    context:
      'A finance planning team has an AI forecasting assistant but analysts avoid using it in budget reviews because they fear being blamed for model-driven assumptions. They need explainable inputs, audit trails, and a way to test AI without weakening accountability to business partners.',
    decisionOptions: standardOptions(
      'Forecast-cycle compression target',
      'Variance-explanation trial on closed period',
      'Finance partner review checkpoint',
      'Sandbox assumption explorer',
    ),
    stakeholders: ['FP&A analysts', 'finance leadership', 'business unit leaders', 'internal audit', 'AI governance team'],
    tradeoffs: ['forecast speed', 'auditability', 'accountability', 'business trust', 'planning-cycle ROI'],
    conflictNotes:
      'Achievement may compress the forecast cycle. Security should use closed-period data first. Benevolence should add partner review. Self-direction should let analysts explore assumptions without committing them to the live plan.',
    disclaimer,
    version: 2,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'hr-ai-policy-answer-trust-gap',
    kind: 'preset',
    title: 'HR Policy Assistant: Trust Gap',
    domain: 'human resources adoption',
    context:
      'An HR operations team has an AI policy assistant, but coordinators avoid using it because wrong answers could affect employee benefits, leave, or accommodations. They also worry that AI use in HR feels impersonal. The organization wants faster internal service without increasing employee-relations risk.',
    decisionOptions: standardOptions(
      'Case-resolution speed challenge',
      'Policy-citation check on archived question',
      'Human-first response review ritual',
      'Sandbox map of safe HR questions',
    ),
    stakeholders: ['HR coordinators', 'employees', 'HR leadership', 'legal team', 'people operations'],
    tradeoffs: ['response speed', 'employee trust', 'policy accuracy', 'human care', 'service-cost ROI'],
    conflictNotes:
      'Achievement may emphasize case-resolution speed. Security should require policy-citation checks on archived questions. Benevolence should preserve a human-first review ritual. Self-direction should map safe HR questions before live use.',
    disclaimer,
    version: 2,
    createdAt: now,
    updatedAt: now,
  },
];

export const valueProfiles: ValueProfile[] = [
  {
    id: 'achievement',
    name: 'Achievement',
    description: 'Optimizes for measurable productivity, visible competence, ROI, speed, and goal attainment.',
    axisWeights: [
      { axis: 'achievement', label: 'Achievement', level: 'high', value: 0.8 },
      { axis: 'selfDirection', label: 'Self-direction', level: 'medium', value: 0.5 },
      { axis: 'security', label: 'Security', level: 'medium', value: 0.5 },
      { axis: 'benevolence', label: 'Benevolence', level: 'low', value: 0.2 },
    ],
    oppositionConstraints: [{ highAxis: 'achievement', lowAxis: 'benevolence', reason: 'A productivity-first adoption intervention should not simultaneously maximize comfort for every stakeholder.' }],
    promptTranslation: 'Prioritize measurable adoption progress, productivity ROI, skill growth, and visible competence while staying honest about trust and rework risks.',
    isBaseline: false,
    version: 2,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'exploration',
    name: 'Exploration',
    description: 'Optimizes for autonomy, discovery, low-pressure experimentation, and finding the right workflow fit.',
    axisWeights: [
      { axis: 'achievement', label: 'Achievement', level: 'medium', value: 0.5 },
      { axis: 'selfDirection', label: 'Self-direction', level: 'high', value: 0.8 },
      { axis: 'security', label: 'Security', level: 'low', value: 0.2 },
      { axis: 'benevolence', label: 'Benevolence', level: 'medium', value: 0.5 },
    ],
    oppositionConstraints: [{ highAxis: 'selfDirection', lowAxis: 'security', reason: 'Autonomous exploration should not simultaneously maximize process stability and risk containment.' }],
    promptTranslation: 'Prioritize voluntary experimentation, workflow discovery, optionality, and employee choice over forced adoption.',
    isBaseline: false,
    version: 2,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'preservation',
    name: 'Preservation',
    description: 'Optimizes for trust, safety, reversibility, governance, and reducing perceived downside.',
    axisWeights: [
      { axis: 'achievement', label: 'Achievement', level: 'medium', value: 0.5 },
      { axis: 'selfDirection', label: 'Self-direction', level: 'low', value: 0.2 },
      { axis: 'security', label: 'Security', level: 'high', value: 0.8 },
      { axis: 'benevolence', label: 'Benevolence', level: 'medium', value: 0.5 },
    ],
    oppositionConstraints: [{ highAxis: 'security', lowAxis: 'selfDirection', reason: 'Risk containment should not simultaneously maximize open-ended experimentation.' }],
    promptTranslation: 'Prioritize trust-building, bounded experiments, reversibility, clear stop conditions, and containment of rework or evaluation risk.',
    isBaseline: false,
    version: 2,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: 'neutral',
    name: 'Neutral Baseline',
    description: 'Uses balanced medium weights and no strong motivational emphasis.',
    axisWeights: [
      { axis: 'achievement', label: 'Achievement', level: 'medium', value: 0.5 },
      { axis: 'selfDirection', label: 'Self-direction', level: 'medium', value: 0.5 },
      { axis: 'security', label: 'Security', level: 'medium', value: 0.5 },
      { axis: 'benevolence', label: 'Benevolence', level: 'medium', value: 0.5 },
    ],
    oppositionConstraints: [],
    promptTranslation: 'Use balanced adoption analysis without over-emphasizing productivity pressure, open exploration, risk avoidance, or social support.',
    isBaseline: true,
    version: 2,
    createdAt: now,
    updatedAt: now,
  },
];
