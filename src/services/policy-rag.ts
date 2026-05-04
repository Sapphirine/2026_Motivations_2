import type {
  PolicyComplianceCheck,
  PolicyGroundingChunk,
  PolicyGroundingResult,
  RiskContext,
  Scenario,
  StructuredDecision,
  Env,
} from '../domain/types';

const defaultPolicyRagOrigin = 'http://127.0.0.1:8010';
const defaultTopK = 5;
const ragTimeoutMs = 1600;
const groundingCache = new Map<string, { expiresAt: number; result: PolicyGroundingResult }>();

export function detectRiskContext(scenario: Scenario): RiskContext {
  const text = [
    scenario.title,
    scenario.domain,
    scenario.context,
    scenario.stakeholders.join(' '),
    scenario.tradeoffs.join(' '),
    scenario.conflictNotes,
  ].join(' ').toLowerCase();

  const domain = detectDomain(text, scenario.domain);
  const riskTypes = new Set<string>();
  const signals: string[] = [];

  const addRisk = (risk: string, signal: string) => {
    riskTypes.add(risk);
    signals.push(signal);
  };

  if (matches(text, ['school', 'student', 'teacher', 'parent', 'tutor', 'education', 'ferpa', 'classroom'])) {
    addRisk('student privacy', 'education/student context');
    addRisk('minors', 'student or school stakeholder');
    addRisk('human oversight', 'education deployment');
    addRisk('transparency', 'parent/student trust');
  }
  if (matches(text, ['privacy', 'pii', 'data', 'record', 'confidential', 'customer data', 'employee data'])) {
    addRisk('privacy', 'data or privacy concern');
  }
  if (matches(text, ['surveillance', 'monitor', 'tracking', 'manager will see', 'visibility', 'scoreboard'])) {
    addRisk('surveillance', 'monitoring or evaluation anxiety');
  }
  if (matches(text, ['bias', 'fairness', 'equity', 'disparate', 'accommodation', 'benefits', 'leave', 'hiring', 'employment', 'selection'])) {
    addRisk('bias and fairness', 'fairness or employment impact');
  }
  if (matches(text, ['wrong', 'hallucinated', 'accuracy', 'quality', 'rework', 'policy errors', 'citation', 'source', 'metric'])) {
    addRisk('output accuracy', 'wrong output or rework risk');
    addRisk('human oversight', 'verification need');
  }
  if (matches(text, ['security', 'approved', 'public', 'non-confidential', 'clause', 'legal', 'attorney', 'matter'])) {
    addRisk('confidentiality', 'legal or confidential data concern');
  }
  if (matches(text, ['finance', 'forecast', 'model', 'dashboard', 'metric', 'audit', 'assumption', 'planning'])) {
    addRisk('model validation', 'finance or analytics model use');
    addRisk('accountability', 'audit or assumption ownership');
  }
  if (matches(text, ['customer', 'marketing', 'brand', 'claims', 'sales', 'support', 'consumer'])) {
    addRisk('consumer harm', 'customer-facing workflow');
    addRisk('deceptive claims', 'customer-facing AI content or claims');
  }
  if (matches(text, ['employee', 'worker', 'manager', 'team', 'peers', 'psychological safety', 'stigma', 'dependence'])) {
    addRisk('worker well-being', 'workplace adoption context');
    addRisk('transparency', 'social meaning of AI use');
  }
  if (matches(text, ['code', 'coding', 'software', 'repository', 'generated code'])) {
    addRisk('security', 'software engineering workflow');
    addRisk('output accuracy', 'generated code review');
  }

  if (riskTypes.size === 0) {
    riskTypes.add('responsible AI governance');
    signals.push('general AI adoption scenario');
  }

  return {
    domain,
    affectedStakeholders: dedupe(scenario.stakeholders).slice(0, 8),
    riskTypes: Array.from(riskTypes).slice(0, 8),
    deploymentStage: detectDeploymentStage(text),
    detectionSignals: dedupe(signals).slice(0, 8),
  };
}

export async function retrievePolicyGrounding(
  env: Env,
  scenario: Scenario,
  options?: { topK?: number; timeoutMs?: number },
): Promise<PolicyGroundingResult> {
  const riskContext = detectRiskContext(scenario);
  if ((env.POLICY_RAG_ENABLED ?? 'true') === 'false') {
    return { enabled: false, mode: 'disabled', riskContext, chunks: [], warning: 'Policy RAG disabled by POLICY_RAG_ENABLED=false.' };
  }

  const origin = normalizeOrigin(env.POLICY_RAG_ORIGIN ?? defaultPolicyRagOrigin);
  const topK = Math.max(1, Math.min(options?.topK ?? defaultTopK, 8));
  const cacheKey = `${origin}:${scenario.id}:${scenario.updatedAt}:${topK}`;
  const cached = groundingCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  try {
    const response = await fetchWithTimeout(`${origin}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: buildPolicyQuery(scenario, riskContext),
        riskContext,
        topK,
      }),
    }, options?.timeoutMs ?? ragTimeoutMs);
    if (!response.ok) {
      return {
        enabled: false,
        mode: 'fallback',
        riskContext,
        chunks: [],
        warning: `Policy RAG sidecar returned HTTP ${response.status}. Start it with npm run rag:policy.`,
      };
    }
    const payload = await response.json() as { chunks?: unknown; mode?: unknown; warning?: unknown };
    const chunks = Array.isArray(payload.chunks)
      ? payload.chunks.map(normalizePolicyChunk).filter((chunk): chunk is PolicyGroundingChunk => Boolean(chunk)).slice(0, topK)
      : [];
    const result: PolicyGroundingResult = {
      enabled: chunks.length > 0,
      mode: payload.mode === 'chroma' ? 'chroma' : 'fallback',
      riskContext,
      chunks,
      warning: typeof payload.warning === 'string' ? payload.warning : chunks.length ? undefined : 'Policy RAG returned no chunks for this scenario.',
    };
    groundingCache.set(cacheKey, { expiresAt: Date.now() + 10 * 60 * 1000, result });
    return result;
  } catch {
    const result: PolicyGroundingResult = {
      enabled: false,
      mode: 'fallback',
      riskContext,
      chunks: [],
      warning: `Policy RAG sidecar unavailable at ${origin}. Start it with npm run rag:policy.`,
    };
    groundingCache.set(cacheKey, { expiresAt: Date.now() + 60 * 1000, result });
    return result;
  }
}

export function formatPolicyGroundingForPrompt(grounding: PolicyGroundingResult | undefined): string {
  if (!grounding) return 'Policy grounding: not requested.';
  const risk = grounding.riskContext;
  const header = [
    'Detected responsible-AI risk context:',
    `- Domain: ${risk.domain}`,
    `- Deployment stage: ${risk.deploymentStage}`,
    `- Affected stakeholders: ${risk.affectedStakeholders.join(', ') || 'unspecified'}`,
    `- Risk types: ${risk.riskTypes.join(', ')}`,
  ].join('\n');
  if (!grounding.enabled || grounding.chunks.length === 0) {
    return [
      header,
      `Policy-Grounding RAG: unavailable (${grounding.warning ?? 'no retrieved constraints'}).`,
      'Use the detected risk context to keep the intervention bounded, transparent, reversible, and human-reviewed.',
    ].join('\n');
  }
  const constraints = grounding.chunks.map((chunk, index) => [
    `${index + 1}. ${chunk.title}`,
    `   Source: ${chunk.source}`,
    `   Applies to: ${chunk.domain}; risks: ${chunk.riskTypes.join(', ')}`,
    `   Constraint: ${chunk.text}`,
  ].join('\n')).join('\n');
  return [
    header,
    'Retrieved Policy-Grounding RAG constraints:',
    constraints,
    'Use these constraints to make the intervention deployable. Prefer bounded pilots, human review, transparency, data safeguards, and audit trails when relevant. Do not invent legal claims.',
  ].join('\n');
}

export function attachPolicyCompliance(
  decision: StructuredDecision,
  grounding: PolicyGroundingResult | undefined,
): StructuredDecision {
  return {
    ...decision,
    policyCompliance: checkPolicyCompliance(decision, grounding),
  };
}

export function checkPolicyCompliance(
  decision: StructuredDecision,
  grounding: PolicyGroundingResult | undefined,
): PolicyComplianceCheck {
  if (!grounding || !grounding.enabled || grounding.chunks.length === 0) {
    return {
      status: 'unavailable',
      coveredRiskTypes: [],
      missingRiskTypes: grounding?.riskContext.riskTypes ?? [],
      evidence: [grounding?.warning ?? 'Policy RAG did not return retrieved constraints.'],
    };
  }
  const decisionText = stringifyDecision(decision).toLowerCase();
  const riskTypes = grounding.riskContext.riskTypes.slice(0, 8);
  const covered: string[] = [];
  const missing: string[] = [];
  for (const riskType of riskTypes) {
    const keywords = coverageKeywords(riskType);
    if (keywords.some((keyword) => decisionText.includes(keyword))) {
      covered.push(riskType);
    } else {
      missing.push(riskType);
    }
  }
  const evidence = grounding.chunks.slice(0, 3).map((chunk) => `${chunk.title} (${chunk.source})`);
  return {
    status: missing.length === 0 ? 'pass' : 'review',
    coveredRiskTypes: covered,
    missingRiskTypes: missing,
    evidence,
  };
}

function detectDomain(text: string, scenarioDomain: string): string {
  if (matches(text, ['school', 'student', 'teacher', 'education', 'tutor'])) return 'education';
  if (matches(text, ['hr', 'employee', 'benefits', 'leave', 'accommodation', 'hiring'])) return 'human resources';
  if (matches(text, ['legal', 'attorney', 'clause', 'matter', 'counsel'])) return 'legal operations';
  if (matches(text, ['finance', 'forecast', 'budget', 'planning'])) return 'finance';
  if (matches(text, ['analytics', 'dashboard', 'metric', 'sql', 'data model'])) return 'business analytics';
  if (matches(text, ['support', 'ticket', 'customer'])) return 'customer support';
  if (matches(text, ['sales', 'crm', 'account plan'])) return 'sales';
  if (matches(text, ['marketing', 'brand', 'campaign'])) return 'marketing';
  if (matches(text, ['software', 'coding', 'code'])) return 'software engineering';
  if (matches(text, ['manager', 'team', 'worker', 'employee'])) return 'workplace AI adoption';
  return scenarioDomain || 'general AI adoption';
}

function detectDeploymentStage(text: string): string {
  if (matches(text, ['pre-deployment', 'predeployment', 'deciding whether', 'before deploy', 'before deploying'])) return 'pre-deployment decision';
  if (matches(text, ['pilot', 'trial', 'experiment', 'sandbox'])) return 'pilot or bounded trial';
  if (matches(text, ['deployed', 'already use', 'has access', 'licenses were purchased', 'paid enterprise seats'])) return 'post-purchase adoption';
  return 'adoption planning';
}

function buildPolicyQuery(scenario: Scenario, riskContext: RiskContext): string {
  return [
    scenario.title,
    scenario.domain,
    scenario.context,
    `Stakeholders: ${riskContext.affectedStakeholders.join(', ')}`,
    `Risks: ${riskContext.riskTypes.join(', ')}`,
    `Stage: ${riskContext.deploymentStage}`,
    `Tradeoffs: ${scenario.tradeoffs.join(', ')}`,
  ].join('\n');
}

function normalizePolicyChunk(value: unknown): PolicyGroundingChunk | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const id = stringValue(item.id);
  const title = stringValue(item.title);
  const source = stringValue(item.source);
  const text = stringValue(item.text);
  if (!id || !title || !source || !text) return null;
  return {
    id,
    title,
    source,
    domain: stringValue(item.domain) || 'general',
    riskTypes: stringArray(item.riskTypes),
    stakeholders: stringArray(item.stakeholders),
    deploymentStage: stringValue(item.deploymentStage) || 'any',
    text,
    score: typeof item.score === 'number' ? item.score : null,
  };
}

function stringifyDecision(decision: StructuredDecision): string {
  const card = decision.interventionCard;
  const parts = [
    decision.decisionSummary,
    decision.rationale,
    ...(decision.riskNotes ?? []),
    ...(decision.tradeoffs ?? []).flatMap((item) => [item.dimension, item.assessment]),
    card?.diagnosedBlocker,
    card?.retrievedStrategy,
    card?.microAction,
    card?.ifThenPlan,
    card?.accountabilityScript,
    card?.successMetric,
  ];
  return parts.filter((part): part is string => typeof part === 'string').join(' ');
}

function coverageKeywords(riskType: string): string[] {
  const normalized = riskType.toLowerCase();
  if (normalized.includes('student')) return ['student', 'education record', 'parent', 'ferpa', 'data', 'privacy'];
  if (normalized.includes('minor')) return ['minor', 'child', 'student', 'parent', 'age', 'safeguard'];
  if (normalized.includes('privacy')) return ['privacy', 'data', 'pii', 'consent', 'record', 'confidential'];
  if (normalized.includes('surveillance')) return ['surveillance', 'monitor', 'tracking', 'visible', 'manager-safe'];
  if (normalized.includes('bias') || normalized.includes('fairness')) return ['bias', 'fair', 'equity', 'adverse', 'review'];
  if (normalized.includes('human oversight')) return ['human', 'review', 'approve', 'manager', 'teacher', 'supervision'];
  if (normalized.includes('transparency')) return ['transparent', 'disclose', 'notice', 'explain', 'script', 'communicate'];
  if (normalized.includes('accuracy')) return ['accuracy', 'wrong', 'source', 'citation', 'compare', 'review', 'validate'];
  if (normalized.includes('confidentiality')) return ['confidential', 'public', 'approved', 'client', 'matter', 'data'];
  if (normalized.includes('validation')) return ['validate', 'validation', 'test', 'monitor', 'closed period', 'assumption'];
  if (normalized.includes('accountability')) return ['accountability', 'owner', 'audit', 'trace', 'checkpoint', 'review'];
  if (normalized.includes('consumer')) return ['customer', 'consumer', 'harm', 'quality', 'review', 'claim'];
  if (normalized.includes('deceptive')) return ['claim', 'deceptive', 'mislead', 'evidence', 'accurate', 'review'];
  if (normalized.includes('worker')) return ['worker', 'employee', 'psychological', 'safe', 'no-penalty', 'voluntary'];
  if (normalized.includes('security')) return ['security', 'sandbox', 'approved', 'access', 'safe', 'review'];
  return normalized.split(/\W+/).filter(Boolean);
}

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
}

function normalizeOrigin(value: string): string {
  return value.replace(/\/+$/, '');
}

function matches(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}
