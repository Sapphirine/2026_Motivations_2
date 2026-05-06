/**
 * MotiveOps - front-end shell (5-tab IA).
 *
 * UPDATED 2026-05-02 for the MotiveOps AI workflow adoption pivot
 * (see 01-spec.md + 02-design.md). Replaces the prior 6-tab layout with:
 *   1. Setup              - adoption-case picker + motivation compass + canonical-battery CTA
 *   2. Run Live           - 4 AgentLane cards (summary-first)
 *   3. Three-Layer Analysis - per-agent ThreeLayerChart + AlignmentBadge
 *   4. Boundary Map       - sensitivity BoundaryHeatmap + job progress
 *   5. Method / Report    - PurposeCallout + methodology + Q&A + artifacts
 *
 * Backend contracts consumed (Lane A is implementing in parallel):
 *   GET  /api/scenarios
 *   GET  /api/scenarios/:id
 *   POST /api/experiments/run                          { scenarioId, profileIds, trialCount: 5 } -> { runId, run }
 *   POST /api/experiments/:runId/three-layer-analysis  -> { perAgent: [...] }
 *   POST /api/sensitivity-grid                         { scenarioIds?, profileIds?, idempotencyKey } -> { jobId }
 *   GET  /api/sensitivity-grid/:jobId                  -> { status, completedCells, totalCells, results, errors }
 *   GET  /api/findings/heatmap                         -> { scenarios, profiles, axes, cells }
 *   GET  /api/findings/alignment-patterns              -> { totals, byProfile, byScenario }
 *   POST /api/research/run-canonical-battery           { idempotencyKey } -> { batteryId, runIds, gridJobId }
 *   POST /api/questions/answer                         (existing - unchanged)
 *   GET  /api/diagnostics                              (existing - unchanged)
 *   GET  /api/evidence-ledger                          (existing - unchanged)
 *
 * Invariants:
 *   - Always send `X-OpenAI-Key` from localStorage when present (authHeaders).
 *   - Idempotency-Key on every POST that creates a run (crypto.randomUUID()).
 *   - Only render numbers the API actually returned. Demo fallback is clearly labeled.
 *   - localStorage prefix: `motivationLab.` (legacy key preserved for migration).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  ClipboardList,
  Database,
  FileText,
  Grid3x3,
  KeyRound,
  Layers,
  Loader2,
  MessageCircle,
  Microscope,
  Play,
  RefreshCcw,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import AgentWorkflowDiagram from './ui/AgentWorkflowDiagram.jsx';
import EvidenceLedger, { formatLocalTimestamp } from './ui/EvidenceLedger.jsx';
import TabSteps from './ui/TabSteps.jsx';
import SchwartzCompass from './ui/SchwartzCompass.jsx';
import ThreeLayerChart from './ui/ThreeLayerChart.jsx';
import BoundaryHeatmap from './ui/BoundaryHeatmap.jsx';
import AlignmentBadge from './ui/AlignmentBadge.jsx';
import AgentLane from './ui/AgentLane.jsx';
import PurposeCallout from './ui/PurposeCallout.jsx';
import { presetScenarios } from './domain/seeds';

const ACTIVE_MODEL = 'gpt-5.4-nano';
const JUDGE_MODEL = 'gpt-5.4-mini';
const USER_KEY_STORAGE = 'userOpenAIKey';
const USER_KEY_REMEMBER = 'userOpenAIKeyRemember';
const THREE_LAYER_RUN_STORAGE = 'motivationLab.selectedThreeLayerRunId';

// --- 5 top-level tabs (IA per 01-spec §11) ---
const tabs = [
  { id: 'setup',       label: 'Setup',                detail: 'Pick an adoption case - set the motivation profile',
    subtitle: 'Pick the AI workflow adoption case and motivational profile.' },
  { id: 'run',         label: 'Run Live',             detail: '4 motivated agents - same adoption case',
    subtitle: 'Watch four motivated agents recommend interventions for the same adoption case.' },
  { id: 'three-layer', label: 'Three-Layer Analysis', detail: 'Declared · chosen · justified',
    subtitle: 'How declared, chosen, and justified intervention motivations agree or disagree.' },
  { id: 'boundary',    label: 'Boundary Map',         detail: '16 single-case contrasts',
    subtitle: 'Which motivation weight actually changes the recommended intervention.' },
  { id: 'method',      label: 'Method / Report',      detail: 'Purpose · methodology · Q&A · evidence',
    subtitle: 'How the experiment is set up, and how to read the result.' },
];

const quickQuestions = [
  'Why did Preservation choose a bounded trial?',
  'Why did Exploration prefer a sandbox?',
  'What does Achievement optimize for?',
];

// 9 canonical adoption cases. Names mirror src/domain/seeds.ts.
const scenarioMeta = [
  { id: 'coding-assistant-low-trust-evaluation-anxiety', title: 'AI Coding Assistant: Low Trust and Manager Anxiety', group: 'Trust vs Productivity', conflict: 'Security vs Achievement' },
  { id: 'customer-support-ai-draft-rework-risk', title: 'Support Copilot: Draft Quality and Rework Fear', group: 'Trust vs Productivity', conflict: 'Security vs Achievement' },
  { id: 'analytics-copilot-data-confidence-gap', title: 'Analytics Copilot: Data Confidence Gap', group: 'Trust vs Productivity', conflict: 'Security vs Achievement' },
  { id: 'manager-stigma-ai-dependence', title: 'Manager Stigma: AI Use Looks Like Dependence', group: 'Psychological Safety vs Speed', conflict: 'Benevolence vs Achievement' },
  { id: 'legal-review-ai-confidentiality-concern', title: 'Legal Review: Confidentiality and Competence Concern', group: 'Psychological Safety vs Speed', conflict: 'Benevolence vs Achievement' },
  { id: 'sales-ai-coach-unclear-use-case', title: 'Sales AI Coach: Unclear Use Case', group: 'Psychological Safety vs Speed', conflict: 'Benevolence vs Achievement' },
  { id: 'marketing-ai-content-brand-risk', title: 'Marketing Content AI: Brand Risk', group: 'Exploration vs Process Risk', conflict: 'Self-Direction vs Security' },
  { id: 'finance-ai-forecasting-accountability-risk', title: 'Finance Forecasting AI: Accountability Risk', group: 'Exploration vs Process Risk', conflict: 'Self-Direction vs Security' },
  { id: 'hr-ai-policy-answer-trust-gap', title: 'HR Policy Assistant: Trust Gap', group: 'Exploration vs Process Risk', conflict: 'Self-Direction vs Security' },
];
const scenarioDetailsById = Object.fromEntries(presetScenarios.map((scenario) => [scenario.id, scenario]));
const scenarios = scenarioMeta.map((meta) => ({ ...scenarioDetailsById[meta.id], ...meta }));
const customOptionTemplates = [
  {
    id: 'option_a',
    label: 'Outcome-focused adoption challenge',
    description: 'Use a short, visible adoption challenge with a clear success metric. This favors speed, measurable progress, and productivity evidence.',
  },
  {
    id: 'option_b',
    label: 'Bounded safety pilot',
    description: 'Use a reversible, low-risk pilot with a stop condition, review gate, and limited data or stakeholder exposure.',
  },
  {
    id: 'option_c',
    label: 'Stakeholder trust review',
    description: 'Use peer or stakeholder review to protect psychological safety, legitimacy, fairness, and perceived care.',
  },
  {
    id: 'option_d',
    label: 'User-choice exploration sandbox',
    description: 'Use an optional sandbox or menu of use cases so participants can discover fit before committing to deployment.',
  },
];
const customScenarioExample = {
  title: 'AI Tutor Deployment in Public Schools',
  domain: 'education technology adoption',
  context:
    'A school district is deciding whether to deploy an AI tutor in public schools. It may improve learning outcomes and teacher capacity, but it could increase student surveillance, bias, and parent distrust if the rollout is not bounded.',
  stakeholders: 'students, teachers, parents, school administrators, district technology team, equity reviewers',
  tradeoffs: 'learning outcomes, student privacy, bias risk, teacher workload, public trust',
  conflictNotes:
    'Achievement may emphasize learning gains and faster support. Security should contain privacy and bias risks. Benevolence should protect students and teachers from harm. Self-direction should preserve educator and family choice during early use.',
  decisionOptions: customOptionTemplates,
};

function makeEmptyCustomScenarioDraft() {
  return {
    title: '',
    domain: '',
    context: '',
    stakeholders: 'decision owner, affected users, implementation team, governance reviewer',
    tradeoffs: 'adoption value, trust, risk, autonomy',
    conflictNotes: '',
    decisionOptions: customOptionTemplates.map((option) => ({ ...option })),
  };
}

function enrichCustomScenario(scenario) {
  return {
    ...scenario,
    group: 'Custom scenario',
    conflict: scenario.conflictNotes || 'User-authored adoption case',
  };
}

function splitListInput(value) {
  return String(value ?? '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const profiles = [
  { id: 'achievement',  name: 'Achievement',       tone: 'ROI and visible competence',       schwartz: 'Achievement · high', weights: { achievement: 0.8, self_direction: 0.5, security: 0.5, benevolence: 0.2 } },
  { id: 'exploration',  name: 'Exploration',       tone: 'learning and choice',              schwartz: 'Self-Direction · high', weights: { achievement: 0.5, self_direction: 0.8, security: 0.2, benevolence: 0.5 } },
  { id: 'preservation', name: 'Preservation',      tone: 'trust and reversibility',          schwartz: 'Security · high',     weights: { achievement: 0.5, self_direction: 0.2, security: 0.8, benevolence: 0.5 } },
  { id: 'neutral',      name: 'Neutral baseline',  tone: 'balanced weights',                schwartz: 'All axes balanced',   weights: { achievement: 0.5, self_direction: 0.5, security: 0.5, benevolence: 0.5 } },
];

const motivationIntakeItems = [
  {
    id: 'visible_progress',
    label: 'I need visible performance gains.',
    description: 'The adoption action should show measurable value, speed, or skill growth.',
    weights: { achievement: 2 },
  },
  {
    id: 'experiment_choice',
    label: 'I want freedom to experiment before committing.',
    description: 'The rollout should preserve choice, discovery, and workflow fit.',
    weights: { self_direction: 2, achievement: 0.5 },
  },
  {
    id: 'risk_safety',
    label: 'I am worried about risk, safety, or policy.',
    description: 'The first action needs safeguards, reversibility, and clear stop conditions.',
    weights: { security: 2 },
  },
  {
    id: 'protect_people',
    label: 'I care most about protecting affected people.',
    description: 'The intervention should protect students, employees, customers, or other stakeholders from harm.',
    weights: { benevolence: 2, security: 0.5 },
  },
  {
    id: 'manager_judgment',
    label: 'I worry my manager or team will judge my AI use.',
    description: 'The action should reduce stigma and make appropriate AI use socially safe.',
    weights: { benevolence: 1.5, security: 1 },
  },
  {
    id: 'safe_start',
    label: 'I do not know where to safely start.',
    description: 'The action should define a small entry point with an explicit boundary.',
    weights: { security: 1.5, self_direction: 0.5 },
  },
];

const axes = [
  { id: 'achievement',    label: 'Achieve', full: 'Achievement' },
  { id: 'self_direction', label: 'Self-dir', full: 'Self-Direction' },
  { id: 'security',       label: 'Security', full: 'Security' },
  { id: 'benevolence',    label: 'Benevolence', full: 'Benevolence' },
];

const defaultScenarioId = 'coding-assistant-low-trust-evaluation-anxiety';
const profileNameById = Object.fromEntries(profiles.map((p) => [p.id, p.name]));
const axisNameById = Object.fromEntries(axes.map((axis) => [axis.id, axis.full]));

function inferMotivationIntake(selectedIds) {
  const selected = motivationIntakeItems.filter((item) => selectedIds.includes(item.id));
  const scores = { achievement: 0, self_direction: 0, security: 0, benevolence: 0 };
  for (const item of selected) {
    for (const [axis, value] of Object.entries(item.weights)) {
      scores[axis] += value;
    }
  }

  if (selected.length === 0) {
    return {
      selectedCount: 0,
      scores,
      weights: profiles.find((profile) => profile.id === 'neutral').weights,
      profileId: 'neutral',
      profileName: 'Neutral baseline',
      primaryAxes: ['No intake selected'],
      summary: 'No self-report blockers selected yet. The benchmark still compares all four profiles.',
    };
  }

  const maxScore = Math.max(...Object.values(scores));
  const weights = Object.fromEntries(Object.entries(scores).map(([axis, score]) => {
    if (score === 0) return [axis, 0.2];
    if (score === maxScore) return [axis, 0.8];
    return [axis, 0.5];
  }));
  const nearest = profiles.reduce((best, profile) => {
    const distance = Object.keys(scores).reduce((sum, axis) => sum + Math.abs((profile.weights[axis] ?? 0.5) - weights[axis]), 0);
    return distance < best.distance ? { profile, distance } : best;
  }, { profile: profiles[3], distance: Number.POSITIVE_INFINITY }).profile;
  const primaryAxes = Object.entries(scores)
    .filter(([, score]) => score === maxScore)
    .map(([axis]) => axisNameById[axis] ?? axis);

  return {
    selectedCount: selected.length,
    scores,
    weights,
    profileId: nearest.id,
    profileName: nearest.name,
    primaryAxes,
    summary: `Self-report intake estimates ${nearest.name.toLowerCase()} as the closest profile, with strongest signal on ${primaryAxes.join(' and ')}.`,
  };
}

// ============================================================================
// localStorage / auth helpers (preserved from prior shell)
// ============================================================================
function readUserKey() {
  try { return localStorage.getItem(USER_KEY_STORAGE) || ''; } catch { return ''; }
}
function writeUserKey(key, remember) {
  try {
    if (remember) {
      localStorage.setItem(USER_KEY_STORAGE, key);
      localStorage.setItem(USER_KEY_REMEMBER, '1');
    } else {
      localStorage.removeItem(USER_KEY_STORAGE);
      localStorage.removeItem(USER_KEY_REMEMBER);
    }
  } catch { /* private mode no-op */ }
}
function clearUserKey() {
  try { localStorage.removeItem(USER_KEY_STORAGE); localStorage.removeItem(USER_KEY_REMEMBER); } catch { /* no-op */ }
}

function authHeaders(extra) {
  const headers = { 'content-type': 'application/json', ...(extra || {}) };
  const userKey = readUserKey();
  if (userKey && userKey.trim().length > 0) headers['X-OpenAI-Key'] = userKey.trim();
  return headers;
}

function newIdempotencyKey(prefix) {
  const uniq = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return `${prefix}-${Date.now()}-${uniq}`;
}

function getProblemMessage(error, fallback) {
  if (!error) return fallback;
  if (typeof error === 'string') return error;
  return error.detail || error.message || error.title || fallback;
}

// Defensive normalizer for heatmap dimensions (Lane G1 backend may ship enriched
// objects { id, title|name|label }; older deploys may still emit raw string IDs).
// Component contract requires objects only - normalize at the boundary.
function normalizeHeatmapDimension(arr, labelKey) {
  if (!Array.isArray(arr)) return arr;
  return arr.map((item) => {
    if (typeof item === 'string') {
      return labelKey ? { id: item, [labelKey]: item } : { id: item };
    }
    return item;
  });
}

function normalizeHeatmapPayload(data) {
  if (!data || typeof data !== 'object') return data;
  const normalized = {
    ...data,
    scenarios: normalizeHeatmapDimension(data.scenarios, 'title'),
    profiles:  normalizeHeatmapDimension(data.profiles,  'name'),
    axes:      normalizeHeatmapDimension(data.axes,      'label'),
  };
  if (normalized.gridJobId && !normalized.jobId) normalized.jobId = normalized.gridJobId;
  return normalized;
}

function inferProfileId(question) {
  const q = question.trim().toLowerCase();
  if (q.includes('preservation') || q.includes('bounded') || q.includes('trust') || q.includes('audit') || q.includes('safety')) return 'preservation';
  if (q.includes('exploration') || q.includes('sandbox') || q.includes('trial') || q.includes('learning')) return 'exploration';
  if (q.includes('achievement') || q.includes('roi') || q.includes('productivity') || q.includes('progress')) return 'achievement';
  return 'neutral';
}

// ============================================================================
// Title bar + tab strip
// ============================================================================
function TitleBar() {
  return (
    <div className="title-bar" role="banner">
      <span className="title-eyebrow" aria-hidden="true">EECS 6895 · Final project</span>
      <h1 className="title-main">MotiveOps - AI Workflow Adoption Observatory</h1>
    </div>
  );
}

function TabButton({ tab, active, onSelect }) {
  return (
    <button
      className={`tab-button ${active ? 'is-active' : ''}`}
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(tab.id)}
    >
      <strong>{tab.label}</strong>
      <span>{tab.detail}</span>
    </button>
  );
}

// ============================================================================
// Setup tab: scenario picker + Schwartz Compass + canonical battery CTA
// ============================================================================
function ScenarioGroupedDropdown({ value, onChange, items = scenarios }) {
  const grouped = useMemo(() => {
    const map = new Map();
    for (const s of items) {
      if (!map.has(s.group)) map.set(s.group, []);
      map.get(s.group).push(s);
    }
    return [...map.entries()];
  }, [items]);

  return (
    <label className="scenario-dropdown" htmlFor="scenario-select">
      <span className="eyebrow">Adoption case</span>
      <select
        id="scenario-select"
        name="scenarioId"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Pick an AI workflow adoption case"
      >
        {grouped.map(([group, items]) => (
          <optgroup key={group} label={group}>
            {items.map((s) => (
              <option key={s.id} value={s.id}>{s.title}</option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function ScenarioModeToggle({ mode, onChange }) {
  return (
    <div className="scenario-mode-toggle" role="tablist" aria-label="Scenario source">
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'canonical'}
        className={mode === 'canonical' ? 'is-active' : ''}
        onClick={() => onChange('canonical')}
      >
        Canonical case
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'custom'}
        className={mode === 'custom' ? 'is-active' : ''}
        onClick={() => onChange('custom')}
      >
        Custom scenario
      </button>
    </div>
  );
}

function ScenarioDetailPanel({ scenario }) {
  const options = Array.isArray(scenario?.decisionOptions) ? scenario.decisionOptions : [];
  const tradeoffs = Array.isArray(scenario?.tradeoffs) ? scenario.tradeoffs : [];
  const stakeholders = Array.isArray(scenario?.stakeholders) ? scenario.stakeholders : [];

  return (
    <div className="scenario-detail-panel" aria-label="Selected adoption case details">
      <p className="scenario-context">{scenario.context}</p>
      <div className="scenario-detail-grid">
        <div>
          <p className="detail-subhead">Tradeoffs</p>
          <div className="tag-row scenario-tradeoff-row">
            {tradeoffs.map((tradeoff) => <span key={tradeoff}>{tradeoff}</span>)}
          </div>
        </div>
        <div>
          <p className="detail-subhead">Stakeholders</p>
          <ul className="stakeholder-list compact">
            {stakeholders.map((stakeholder) => <li key={stakeholder}>{stakeholder}</li>)}
          </ul>
        </div>
      </div>
      <div>
        <p className="detail-subhead">Intervention options</p>
        <ol className="intervention-option-list">
          {options.map((option) => (
            <li key={option.id}>
              <strong>{option.id.replace('option_', '').toUpperCase()}. {option.label}</strong>
              <span>{option.description}</span>
            </li>
          ))}
        </ol>
      </div>
      <p className="dim-note scenario-conflict-note">{scenario.conflictNotes}</p>
    </div>
  );
}

function PolicyGroundingPanel({ grounding, loading, error, onRefresh }) {
  const riskContext = grounding?.riskContext;
  const chunks = Array.isArray(grounding?.chunks) ? grounding.chunks : [];
  const enabled = Boolean(grounding?.enabled && chunks.length > 0);

  return (
    <section className="policy-grounding-panel" aria-labelledby="policy-grounding-title">
      <div className="policy-grounding-head">
        <div>
          <span className="eyebrow">Risk / domain detection</span>
          <h3 id="policy-grounding-title">Policy grounding</h3>
        </div>
        <button type="button" className="control-btn secondary compact" onClick={onRefresh} disabled={loading}>
          {loading ? <Loader2 aria-hidden="true" className="spinner-icon" /> : <RefreshCcw aria-hidden="true" />}
          {loading ? 'Checking...' : 'Refresh'}
        </button>
      </div>
      {riskContext ? (
        <div className="policy-context-grid">
          <div><span>Domain</span><strong>{riskContext.domain}</strong></div>
          <div><span>Stage</span><strong>{riskContext.deploymentStage}</strong></div>
          <div><span>Stakeholders</span><strong>{riskContext.affectedStakeholders?.slice(0, 4).join(', ') || 'unspecified'}</strong></div>
        </div>
      ) : null}
      {riskContext?.riskTypes?.length ? (
        <div className="tag-row policy-risk-tags" aria-label="Detected risk types">
          {riskContext.riskTypes.map((risk) => <span key={risk}>{risk}</span>)}
        </div>
      ) : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {!error && grounding?.warning ? <p className="panel-note dim-note">{grounding.warning}</p> : null}
      {enabled ? (
        <ol className="policy-chunk-list">
          {chunks.map((chunk) => (
            <li key={chunk.id}>
              <div className="policy-chunk-title">
                <ShieldCheck aria-hidden="true" />
                <strong>{chunk.title}</strong>
                {Number.isFinite(chunk.score) ? <span>{Math.round(chunk.score * 100)}%</span> : null}
              </div>
              <p>{chunk.text}</p>
              <small>{chunk.source} · {chunk.riskTypes?.slice(0, 3).join(', ')}</small>
            </li>
          ))}
        </ol>
      ) : (
        <div className="policy-empty-state">
          <Database aria-hidden="true" />
          <p>Start the local Chroma sidecar with <code>npm run rag:policy</code> to retrieve policy constraints.</p>
        </div>
      )}
    </section>
  );
}

function CustomScenarioComposer({
  draft,
  onDraftChange,
  onSubmit,
  onLoadExample,
  isSaving,
  error,
  customScenarios,
  selectedScenarioId,
  onSelectScenario,
}) {
  const updateField = (field, value) => onDraftChange((prev) => ({ ...prev, [field]: value }));
  const updateOption = (index, field, value) => {
    onDraftChange((prev) => ({
      ...prev,
      decisionOptions: prev.decisionOptions.map((option, optionIndex) => (
        optionIndex === index ? { ...option, [field]: value } : option
      )),
    }));
  };

  return (
    <form className="custom-scenario-form" onSubmit={onSubmit}>
      {customScenarios.length > 0 ? (
        <label className="scenario-dropdown custom-existing-select" htmlFor="custom-scenario-select">
          <span className="eyebrow">Saved custom scenario</span>
          <select
            id="custom-scenario-select"
            value={selectedScenarioId}
            onChange={(event) => onSelectScenario(event.target.value)}
          >
            {customScenarios.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>{scenario.title}</option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="custom-form-grid">
        <label className="custom-form-field">
          <span>Scenario title</span>
          <input
            type="text"
            value={draft.title}
            onChange={(event) => updateField('title', event.target.value)}
            placeholder="AI Tutor Deployment in Public Schools"
          />
        </label>
        <label className="custom-form-field">
          <span>Domain</span>
          <input
            type="text"
            value={draft.domain}
            onChange={(event) => updateField('domain', event.target.value)}
            placeholder="education technology adoption"
          />
        </label>
        <label className="custom-form-field span-2">
          <span>Decision scenario</span>
          <textarea
            rows={5}
            value={draft.context}
            onChange={(event) => updateField('context', event.target.value)}
            placeholder="Describe the deployment decision, the upside, the risks, and why people may resist adoption."
          />
        </label>
        <label className="custom-form-field">
          <span>Stakeholders</span>
          <textarea
            rows={3}
            value={draft.stakeholders}
            onChange={(event) => updateField('stakeholders', event.target.value)}
            placeholder="students, teachers, parents"
          />
        </label>
        <label className="custom-form-field">
          <span>Tradeoffs</span>
          <textarea
            rows={3}
            value={draft.tradeoffs}
            onChange={(event) => updateField('tradeoffs', event.target.value)}
            placeholder="learning outcomes, privacy, bias risk"
          />
        </label>
        <label className="custom-form-field span-2">
          <span>Motivational conflict notes</span>
          <textarea
            rows={3}
            value={draft.conflictNotes}
            onChange={(event) => updateField('conflictNotes', event.target.value)}
            placeholder="Name the tension between progress, safety, care, and user choice."
          />
        </label>
      </div>

      <div className="custom-options-editor" aria-label="Candidate intervention options">
        <p className="detail-subhead">Candidate intervention options</p>
        {draft.decisionOptions.map((option, index) => (
          <div className="custom-option-row" key={option.id}>
            <span className="custom-option-letter">{String.fromCharCode(65 + index)}</span>
            <label>
              <span>Label</span>
              <input
                type="text"
                value={option.label}
                onChange={(event) => updateOption(index, 'label', event.target.value)}
              />
            </label>
            <label>
              <span>Description</span>
              <textarea
                rows={2}
                value={option.description}
                onChange={(event) => updateOption(index, 'description', event.target.value)}
              />
            </label>
          </div>
        ))}
      </div>

      <div className="custom-form-actions">
        <button className="control-btn primary" type="submit" disabled={isSaving}>
          {isSaving ? <Loader2 aria-hidden="true" className="spinner-icon" /> : <ClipboardList aria-hidden="true" />}
          {isSaving ? 'Creating scenario...' : 'Create custom scenario'}
        </button>
        <button className="control-btn secondary" type="button" onClick={onLoadExample} disabled={isSaving}>
          <RefreshCcw aria-hidden="true" />
          Load AI tutor example
        </button>
      </div>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
    </form>
  );
}

function MotivationIntakePanel({ selectedIds, onToggle, result, onApply }) {
  const hasSelections = result.selectedCount > 0;
  return (
    <section className="motivation-intake" aria-labelledby="motivation-intake-title">
      <div className="motivation-intake-head">
        <div>
          <span className="eyebrow">Motivation intake</span>
          <h3 id="motivation-intake-title">Estimate the user's adoption blocker from self-report</h3>
        </div>
        <div className="intake-estimate" aria-live="polite">
          <span>{hasSelections ? 'Inferred profile' : 'Default profile'}</span>
          <strong>{result.profileName}</strong>
        </div>
      </div>

      <p className="panel-note">
        This is an explicit intake layer, not hidden psychometric inference. It estimates which profile to inspect; the canonical evaluation still runs the controlled 9 cases across all four profiles.
      </p>

      <div className="intake-option-grid">
        {motivationIntakeItems.map((item) => (
          <label key={item.id} className={`intake-option ${selectedIds.includes(item.id) ? 'is-selected' : ''}`}>
            <input
              type="checkbox"
              checked={selectedIds.includes(item.id)}
              onChange={() => onToggle(item.id)}
            />
            <span>
              <strong>{item.label}</strong>
              <small>{item.description}</small>
            </span>
          </label>
        ))}
      </div>

      <div className="intake-result-row">
        <div>
          <strong>{result.summary}</strong>
          <span>Estimated axes: {result.primaryAxes.join(' · ')}</span>
        </div>
        <button className="control-btn secondary" type="button" onClick={onApply}>
          Apply estimate to compass
        </button>
      </div>
    </section>
  );
}

function CanonicalScenarioMatrix() {
  const grouped = useMemo(() => {
    const map = new Map();
    for (const scenario of scenarios) {
      if (!map.has(scenario.group)) map.set(scenario.group, []);
      map.get(scenario.group).push(scenario);
    }
    return [...map.entries()];
  }, []);

  return (
    <section className="panel canonical-scenario-matrix" aria-labelledby="canonical-scenarios-title">
      <div className="section-heading">
        <div><span className="eyebrow">Evaluation set</span><h2 id="canonical-scenarios-title">9 canonical adoption cases</h2></div>
        <Microscope aria-hidden="true" />
      </div>
      <div className="canonical-scenario-groups">
        {grouped.map(([group, items]) => (
          <section key={group} className="canonical-scenario-group" aria-labelledby={`case-group-${group.replace(/\W+/g, '-').toLowerCase()}`}>
            <div className="case-group-heading">
              <h3 id={`case-group-${group.replace(/\W+/g, '-').toLowerCase()}`}>{group}</h3>
              <span>{items[0]?.conflict}</span>
            </div>
            <div className="case-table" role="table" aria-label={`${group} cases`}>
              {items.map((scenario) => (
                <div className="case-table-row" role="row" key={scenario.id}>
                  <strong role="cell">{scenario.title}</strong>
                  <span role="cell">{scenario.domain}</span>
                  <span role="cell">{scenario.tradeoffs?.slice(0, 3).join(' · ')}</span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function PresetChips({ active, onPick }) {
  return (
    <div className="preset-chip-row" role="radiogroup" aria-label="Preset motivation profiles">
      {profiles.map((p) => (
        <button
          key={p.id}
          type="button"
          role="radio"
          aria-checked={active === p.id}
          className={`preset-chip ${active === p.id ? 'is-active' : ''}`}
          onClick={() => onPick(p)}
        >
          <strong>{p.name}</strong>
          <span>{p.tone}</span>
        </button>
      ))}
    </div>
  );
}

function CanonicalBatteryCTA({ onRun, batteryState }) {
  const isRunning = batteryState?.status === 'pending' || batteryState?.status === 'running';
  return (
    <section className="panel battery-cta" aria-labelledby="battery-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Replication path</span>
          <h2 id="battery-title">Run canonical 9-case adoption battery</h2>
        </div>
        <Activity aria-hidden="true" />
      </div>
      <p className="panel-note">
        9 adoption cases × 4 profiles × 5 trials + 20-call same-profile baseline + 144 low-vs-high sensitivity contrasts (288 endpoint calls) + 9 moderator calls.
        Approximately <strong>~497 live OpenAI calls</strong>; budget before running and expect <strong>~10-20 min</strong> wall clock.
        Idempotent - re-running with the same key resumes pending contrasts.
      </p>
      <button
        className="run-action"
        type="button"
        onClick={onRun}
        disabled={isRunning}
      >
        {isRunning ? <Loader2 aria-hidden="true" className="spinner-icon" /> : <Play aria-hidden="true" />}
        {isRunning ? 'Running canonical battery...' : 'Run canonical battery'}
      </button>
      {batteryState?.error ? <p className="error-text" role="alert">{batteryState.error}</p> : null}
      {batteryState?.batteryId ? (
        <p className="dim-note">Battery id: <code>{batteryState.batteryId}</code> · runs: {batteryState.runIds?.length ?? 0} · grid job: <code>{batteryState.gridJobId ?? '-'}</code></p>
      ) : null}
    </section>
  );
}

// ============================================================================
// Run Live tab: 4 AgentLane cards, summary-first
// ============================================================================
function RunLivePanel({
  profiles,
  outputsArrayByProfile,
  runStatus,
  alignmentByProfile,
  onRetryProfile,
  retryingByProfile,
  retryErrorsByProfile,
}) {
  return (
    <section className="panel" aria-labelledby="run-live-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Live agents</span>
          <h2 id="run-live-title">Intervention recommendations, side by side</h2>
        </div>
        <BarChart3 aria-hidden="true" />
      </div>
      <div className="lane-grid">
        {profiles.map((p) => {
          const arr = outputsArrayByProfile?.[p.id] ?? [];
          return (
            <AgentLane
              key={p.id}
              profile={p}
              outputs={arr}
              status={runStatus?.[p.id] ?? (arr.length > 0 ? 'completed' : 'queued')}
              alignmentPattern={alignmentByProfile?.[p.id] ?? null}
              onRetry={onRetryProfile ? () => onRetryProfile(p.id) : undefined}
              retrying={retryingByProfile?.[p.id] ?? false}
              retryError={retryErrorsByProfile?.[p.id] ?? null}
            />
          );
        })}
      </div>
    </section>
  );
}

// ============================================================================
// Final Recommendation Panel: synthesize all agent outputs into a clear answer
// ============================================================================
const OPTION_LABELS = {
  option_a: { short: 'Option A', long: 'Outcome-focused adoption challenge' },
  option_b: { short: 'Option B', long: 'Bounded safety pilot' },
  option_c: { short: 'Option C', long: 'Stakeholder trust review' },
  option_d: { short: 'Option D', long: 'User-choice exploration sandbox' },
};

function getOptionLabel(optionId, scenario) {
  // Try scenario-specific labels first.
  if (scenario?.decisionOptions) {
    const opt = scenario.decisionOptions.find((o) => o.id === optionId);
    if (opt) return opt.label || opt.description?.slice(0, 60) || optionId;
  }
  return OPTION_LABELS[optionId]?.long ?? optionId;
}

function getOptionShort(optionId) {
  return OPTION_LABELS[optionId]?.short ?? optionId;
}

function FinalRecommendationPanel({ profiles, outputsArrayByProfile, alignmentByProfile, perAgent, heatmap, selectedScenario, run }) {
  // Aggregate: what did each profile pick as its modal (most frequent) option?
  const profilePicks = useMemo(() => {
    const picks = [];
    for (const p of profiles) {
      const outputs = outputsArrayByProfile?.[p.id] ?? [];
      if (outputs.length === 0) continue;
      const counts = {};
      for (const o of outputs) {
        const key = o?.structuredDecision?.selectedOptionId;
        if (key) counts[key] = (counts[key] ?? 0) + 1;
      }
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      if (sorted.length > 0) {
        const [modal, count] = sorted[0];
        const stability = Math.round((count / outputs.length) * 100);
        const rationale = outputs.find((o) => o?.structuredDecision?.selectedOptionId === modal)?.structuredDecision?.rationale;
        picks.push({
          profileId: p.id,
          profileName: p.name,
          modal,
          count,
          total: outputs.length,
          stability,
          rationale: rationale?.slice(0, 300) ?? null,
          alignment: alignmentByProfile?.[p.id] ?? null,
        });
      }
    }
    return picks;
  }, [profiles, outputsArrayByProfile, alignmentByProfile]);

  // Consensus analysis.
  const consensus = useMemo(() => {
    if (profilePicks.length === 0) return null;
    const optionCounts = {};
    for (const pick of profilePicks) {
      optionCounts[pick.modal] = (optionCounts[pick.modal] ?? 0) + 1;
    }
    const sorted = Object.entries(optionCounts).sort((a, b) => b[1] - a[1]);
    const [topOption, topCount] = sorted[0];
    const totalProfiles = profilePicks.length;
    const unanimity = topCount === totalProfiles ? 'unanimous' : topCount >= totalProfiles * 0.75 ? 'strong' : topCount >= totalProfiles * 0.5 ? 'majority' : 'split';
    const dissenters = profilePicks.filter((p) => p.modal !== topOption);
    return { topOption, topCount, totalProfiles, unanimity, dissenters, allOptions: sorted };
  }, [profilePicks]);

  // Boundary map flip summary.
  const flipSummary = useMemo(() => {
    const cells = heatmap?.cells ?? [];
    if (cells.length === 0) return null;
    const flipped = cells.filter((c) => c.flipped === true);
    const stable = cells.filter((c) => c.flipped === false);
    return {
      total: cells.length,
      flippedCount: flipped.length,
      stableCount: stable.length,
      flippedCells: flipped.map((c) => ({
        profile: profileNameById[c.profileId] ?? c.profileId,
        axis: axes.find((a) => a.id === c.axisId)?.full ?? c.axisId,
        from: getOptionShort(c.lowOption),
        to: getOptionShort(c.highOption),
      })),
    };
  }, [heatmap]);

  // Three-layer alignment summary.
  const alignmentSummary = useMemo(() => {
    if (!Array.isArray(perAgent) || perAgent.length === 0) return null;
    const patterns = {};
    for (const row of perAgent) {
      if (row.alignment) {
        patterns[row.alignment] = (patterns[row.alignment] ?? 0) + 1;
      }
    }
    return patterns;
  }, [perAgent]);

  const hasOutputs = profilePicks.length > 0;
  const isComplete = run && ['completed', 'partial'].includes(run.status) && hasOutputs;
  const hasThreeLayerAudit = Boolean(alignmentSummary);
  const hasBoundaryAudit = Boolean(flipSummary);
  const visibleFlippedCells = flipSummary?.flippedCells?.slice(0, 8) ?? [];
  const hiddenFlipCount = Math.max(0, (flipSummary?.flippedCells?.length ?? 0) - visibleFlippedCells.length);

  if (!isComplete) {
    return (
      <section className="panel final-recommendation" aria-labelledby="final-rec-title">
        <div className="section-heading">
          <div>
            <span className="eyebrow">MotiveOps synthesis</span>
            <h2 id="final-rec-title">Recommended next action</h2>
          </div>
          <ShieldCheck aria-hidden="true" />
        </div>
        <p className="panel-note dim-note">Run an experiment above to generate the profile-grounded recommendation.</p>
      </section>
    );
  }

  const unanimityLabels = {
    unanimous: { text: 'Unanimous consensus', cls: 'consensus-unanimous' },
    strong: { text: 'Strong consensus', cls: 'consensus-strong' },
    majority: { text: 'Majority consensus', cls: 'consensus-majority' },
    split: { text: 'Split decision', cls: 'consensus-split' },
  };
  const consensusInfo = unanimityLabels[consensus?.unanimity] ?? unanimityLabels.split;

  return (
    <section className="panel final-recommendation" aria-labelledby="final-rec-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">MotiveOps synthesis</span>
          <h2 id="final-rec-title">Recommended next action</h2>
        </div>
        <ShieldCheck aria-hidden="true" />
      </div>

      <div className="recommendation-readiness" aria-label="Recommendation audit readiness">
        <span className="readiness-chip is-ready">Agent outputs ready</span>
        <span className={`readiness-chip ${hasThreeLayerAudit ? 'is-ready' : 'is-pending'}`}>
          {hasThreeLayerAudit ? 'L1/L2/L3 audit ready' : 'L1/L2/L3 audit pending'}
        </span>
        <span className={`readiness-chip ${hasBoundaryAudit ? 'is-ready' : 'is-pending'}`}>
          {hasBoundaryAudit ? 'Boundary map ready' : 'Boundary map pending'}
        </span>
      </div>
      <p className="panel-note">
        This synthesis is generated from the four motivation-profile agents. The audit and sensitivity sections populate after
        you run Three-Layer Analysis and Boundary Map.
      </p>

      {/* Hero recommendation */}
      <div className={`recommendation-hero ${consensusInfo.cls}`}>
        <span className="recommendation-badge">{consensusInfo.text}</span>
        <h3 className="recommendation-option">
          {getOptionShort(consensus.topOption)}: {getOptionLabel(consensus.topOption, selectedScenario)}
        </h3>
        <p className="recommendation-subtitle">
          {consensus.topCount} of {consensus.totalProfiles} motivation profiles recommended this intervention across {profilePicks[0]?.total ?? 5} trials each.
        </p>
      </div>

      {/* Actionable summary */}
      <div className="recommendation-action">
        <span className="eyebrow">Actionable summary</span>
        <div className="action-card">
          <p>
            <strong>Recommended next action:</strong> {getOptionLabel(consensus.topOption, selectedScenario)}.
          </p>
          {consensus.dissenters.length > 0 ? (
            <p>
              <strong>Address dissent:</strong> The {consensus.dissenters.map((d) => d.profileName).join(' and ')} profile{consensus.dissenters.length > 1 ? 's' : ''} preferred
              {' '}{consensus.dissenters.map((d) => getOptionShort(d.modal)).join(' / ')} respectively.
              Consider incorporating elements from {consensus.dissenters.length > 1 ? 'these alternatives' : 'this alternative'} to
              address {consensus.dissenters.map((d) => d.profileName.toLowerCase()).join(' and ')} motivational needs.
            </p>
          ) : null}
          {!flipSummary ? (
            <p>
              <strong>Boundary status:</strong> Boundary Map has not run yet. Run it to test whether a motivation-axis shift changes this recommendation.
            </p>
          ) : flipSummary.flippedCells.length > 0 ? (
            <p>
              <strong>Monitor:</strong> {flipSummary.flippedCells.length} load-bearing contrast{flipSummary.flippedCells.length > 1 ? 's' : ''} appeared
              {visibleFlippedCells.length > 0 ? `, including ${visibleFlippedCells.map((c) => `${c.profile}/${c.axis}`).join(', ')}` : ''}.
              If organizational weight on {flipSummary.flippedCells.length > 1 ? 'these axes' : 'this axis'} shifts, the recommendation may change.
            </p>
          ) : (
            <p>
              <strong>Boundary status:</strong> No axis perturbation flipped the recommendation. The intervention was robust across the tested low-vs-high contrasts.
            </p>
          )}
        </div>
      </div>

      <details className="recommendation-evidence">
        <summary>Evidence behind this recommendation</summary>
        <div className="recommendation-evidence-body">
          {/* Per-profile breakdown table */}
          <div className="recommendation-breakdown">
            <span className="eyebrow">Per-profile recommendations</span>
            <table className="recommendation-table">
              <thead>
                <tr>
                  <th>Profile</th>
                  <th>Recommended</th>
                  <th>Stability</th>
                  <th>Alignment</th>
                </tr>
              </thead>
              <tbody>
                {profilePicks.map((pick) => (
                  <tr key={pick.profileId} className={pick.modal === consensus.topOption ? 'rec-row-consensus' : 'rec-row-dissent'}>
                    <td><strong>{pick.profileName}</strong></td>
                    <td>{getOptionShort(pick.modal)} - {getOptionLabel(pick.modal, selectedScenario)}</td>
                    <td>{pick.stability}% ({pick.count}/{pick.total})</td>
                    <td>
                      {pick.alignment ? (
                        <span className={`lane-alignment-pill alignment-${pick.alignment.toLowerCase()}`}>{pick.alignment}</span>
                      ) : <span className="dim-note">-</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Dissent analysis */}
          {consensus.dissenters.length > 0 ? (
            <div className="recommendation-dissent">
              <span className="eyebrow">Dissenting perspectives</span>
              {consensus.dissenters.map((d) => (
                <div key={d.profileId} className="dissent-card">
                  <strong>{d.profileName}</strong> recommended <strong>{getOptionShort(d.modal)}</strong> - {getOptionLabel(d.modal, selectedScenario)}
                  {d.rationale ? <p className="dissent-rationale">"{d.rationale}"</p> : null}
                </div>
              ))}
            </div>
          ) : null}

          {/* Three-layer alignment audit */}
          {alignmentSummary ? (
            <div className="recommendation-audit">
              <span className="eyebrow">Motivation alignment audit (L1/L2/L3)</span>
              <div className="audit-chips">
                {Object.entries(alignmentSummary).map(([pattern, count]) => (
                  <span key={pattern} className={`audit-chip alignment-${pattern.toLowerCase()}`}>
                    {pattern}: {count} profile{count > 1 ? 's' : ''}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {/* Boundary map insights */}
          {flipSummary ? (
            <div className="recommendation-boundary">
              <span className="eyebrow">Sensitivity boundary analysis</span>
              <p className="panel-note">
                {flipSummary.flippedCount} of {flipSummary.total} axis-weight contrasts changed the recommended intervention.
                {flipSummary.flippedCount === 0
                  ? ' The recommendation is robust: no single axis perturbation flipped the decision.'
                  : ` ${flipSummary.stableCount} contrasts were stable.`}
              </p>
              {visibleFlippedCells.length > 0 ? (
                <table className="recommendation-table flip-table">
                  <thead>
                    <tr>
                      <th>Profile</th>
                      <th>Load-bearing axis</th>
                      <th>Low to high</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleFlippedCells.map((cell, i) => (
                      <tr key={`flip-${i}`}>
                        <td>{cell.profile}</td>
                        <td><strong>{cell.axis}</strong></td>
                        <td>{cell.from} to {cell.to}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
              {hiddenFlipCount > 0 ? <p className="panel-note dim-note">Showing 8 of {flipSummary.flippedCells.length} flipped contrasts.</p> : null}
            </div>
          ) : null}
        </div>
      </details>
    </section>
  );
}


// ============================================================================
// Three-Layer tab: run picker + 4 charts + 4 alignment badges
// ============================================================================
const TERMINAL_RUN_STATUSES = new Set(['completed', 'partial', 'failed']);

function getRunEntryTime(entry) {
  const value = entry?.createdAt ?? entry?.completedAt ?? entry?.timestamp ?? entry?.recordedAt;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRunEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const runId = entry.runId ?? entry.id;
  if (!runId) return null;
  return {
    ...entry,
    id: String(runId),
    runId: String(runId),
    scenarioId: entry.scenarioId ?? entry.scenario ?? null,
    status: entry.status ?? (entry.completedAt || entry.completed_at ? 'completed' : undefined),
    hydratable: entry.hydratable ?? entry.hydrateable,
    createdAt: entry.createdAt ?? entry.created_at ?? entry.timestamp ?? entry.recordedAt ?? null,
    completedAt: entry.completedAt ?? entry.completed_at ?? null,
  };
}

function isHydrateableRun(entry) {
  if (!entry) return false;
  if (entry.status && !TERMINAL_RUN_STATUSES.has(entry.status)) return false;
  if (entry.hydratable === false || entry.hydrateable === false || entry.hasRun === false) return false;
  if (entry.source === 'ledger' && entry.hydratable !== true && entry.hydrateable !== true && entry.hasRun !== true) return false;
  return Boolean(entry.runId || entry.id);
}

function normalizeRunOptions(source) {
  const seen = new Set();
  return source
    .map(normalizeRunEntry)
    .filter(isHydrateableRun)
    .filter((entry) => {
      if (seen.has(entry.runId)) return false;
      seen.add(entry.runId);
      return true;
    })
    .sort((a, b) => getRunEntryTime(b) - getRunEntryTime(a));
}

async function fetchRunPickerOptions() {
  try {
    const response = await fetch('/api/experiments/runs?limit=20');
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw data || new Error('Run history unavailable');
    const entries = normalizeRunOptions(Array.isArray(data.runs) ? data.runs : []);
    if (entries.length > 0) return { entries, error: '' };
  } catch {
    // Fall through to the evidence ledger; it is display-only unless rows are hydrateable.
  }

  const response = await fetch('/api/evidence-ledger?limit=20');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw data || new Error('Evidence ledger unavailable');
  return { entries: normalizeRunOptions(Array.isArray(data.entries) ? data.entries : []), error: '' };
}

function RunPicker({ value, onPick }) {
  const [options, setOptions] = useState(null); // null=loading, []=empty
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await fetchRunPickerOptions();
        if (cancelled) return;
        setOptions(result.entries);
        setError(result.error);
      } catch (err) {
        if (!cancelled) {
          setOptions([]);
          setError(getProblemMessage(err, 'Could not load run history.'));
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="run-picker">
      <label className="scenario-dropdown" htmlFor="three-layer-run-select">
        <span className="eyebrow">Pick a run</span>
        <select
          id="three-layer-run-select"
          name="threeLayerRunId"
          value={value ?? ''}
          onChange={(e) => {
            const rid = e.target.value;
            if (!rid) return;
            const entry = options?.find((o) => (o.runId ?? o.id) === rid) ?? null;
            onPick(rid, entry);
          }}
          aria-label="Select an experiment run for three-layer analysis"
          disabled={options === null}
        >
          {options === null ? (
            <option value="">Loading runs...</option>
          ) : options.length === 0 ? (
            <option value="">No runs available</option>
          ) : (
            <>
              {!value ? <option value="">- select a run -</option> : null}
              {options.map((entry) => {
                const rid = entry.runId ?? entry.id;
                const scenario = entry.scenarioId ?? entry.scenario ?? 'unknown adoption case';
                const when = formatLocalTimestamp(entry.completedAt ?? entry.createdAt ?? entry.timestamp ?? entry.recordedAt);
                return (
                  <option key={rid} value={rid}>
                    {scenario} · {String(rid).slice(0, 8)}{when ? ` · ${when}` : ''}
                  </option>
                );
              })}
            </>
          )}
        </select>
      </label>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
    </div>
  );
}

function ThreeLayerPanel({ run, perAgent, onCompute, isComputing, error, onPickRun, pickedRunId, onContinueBoundary, canDisplaySelectedRun, hasComputedSelectedRun }) {
  const isSelectedRunHydrateable = isHydrateableRun(run);
  const canComputeSelectedRun = Boolean(run && isSelectedRunHydrateable);
  const byProfile = useMemo(() => {
    const map = {};
    if (!canDisplaySelectedRun) return map;
    for (const row of perAgent ?? []) {
      if (!map[row.profileId]) map[row.profileId] = row;
    }
    return map;
  }, [canDisplaySelectedRun, perAgent]);
  const statusForProfile = (row) => {
    if (error) return { label: 'Error', className: 'three-layer-status-error' };
    if (isComputing && row) return { label: 'Running', className: 'three-layer-status-running' };
    if (row) return { label: 'Updated', className: 'three-layer-status-updated' };
    if (isComputing) return { label: 'Running', className: 'three-layer-status-running' };
    return { label: 'Pending', className: 'three-layer-status-pending' };
  };

  return (
    <section className="panel" aria-labelledby="three-layer-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Triangulation</span>
          <h2 id="three-layer-title">L1 declared · L2 judged · L3 justified</h2>
        </div>
        <Layers aria-hidden="true" />
      </div>
      <RunPicker value={pickedRunId ?? run?.id ?? ''} onPick={onPickRun} />
      {!run ? (
        <p className="panel-note dim-note">Pick a hydrateable run above or start a new experiment to populate three-layer analysis.</p>
      ) : (
        <>
          {!isSelectedRunHydrateable ? (
            <p className="error-text" role="alert">This selected run is listed in history but is not hydrateable. Pick another run or start a new experiment.</p>
          ) : null}
          <div className="three-layer-actions">
            <button className={`control-btn ${perAgent?.length ? 'secondary' : 'primary'}`} type="button" onClick={() => onCompute(undefined, undefined)} disabled={isComputing || !canComputeSelectedRun}>
              {isComputing ? 'Computing L1/L2/L3...' : (perAgent?.length ? 'Recompute analysis' : 'Run three-layer analysis')}
            </button>
            <span className="dim-note">Judge model: {JUDGE_MODEL} · independent of subject {ACTIVE_MODEL}</span>
          </div>
          {error ? <p className="error-text" role="alert">{error}</p> : null}
          {isComputing ? (
            <p className="three-layer-pending" aria-live="polite"><Loader2 aria-hidden="true" className="spinner-icon" /> Computing selected run. Existing charts stay visible until fresh results arrive.</p>
          ) : null}
          {hasComputedSelectedRun ? (
            <div className="three-layer-actions">
              <button className="control-btn primary" type="button" onClick={onContinueBoundary}>
                Continue to Boundary Map
              </button>
            </div>
          ) : null}
          <div className={`three-layer-grid ${isComputing ? 'is-pending' : ''}`} aria-busy={isComputing}>
            {profiles.map((p) => {
              const row = byProfile[p.id];
              const profileWeights = p.weights;
              const profileStatus = statusForProfile(row);
              return (
                <article key={p.id} className="three-layer-cell">
                  <header className="three-layer-cell-head">
                    <h3>{p.name}</h3>
                    <div className="three-layer-cell-badges">
                      <span className={`three-layer-state-chip ${profileStatus.className}`}>{profileStatus.label}</span>
                      {row?.alignment ? (
                        <AlignmentBadge
                          pattern={row.alignment}
                          judgeReasoning={row.L2?.reasoning}
                          lexiconMatches={row.L3?.matchedWords ?? []}
                        />
                      ) : null}
                    </div>
                  </header>
                  {isComputing && row ? <p className="per-agent-pending"><Loader2 aria-hidden="true" className="spinner-icon" /> Updating this profile</p> : null}
                  <ThreeLayerChart
                    l1Top2={row?.L1?.top2 ?? Object.entries(profileWeights).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k)}
                    l1Weights={profileWeights}
                    l2Axis={row?.L2?.primaryAxis}
                    l2Confidence={row?.L2?.confidence}
                    l3Axis={row?.L3?.topAxis}
                    l3Resolution={row?.L3?.resolution}
                  />
                </article>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

// ============================================================================
// Boundary Map tab: low-vs-high contrast heatmap + job status bar
// ============================================================================
function BoundaryMapPanel({ heatmap, jobState, loading, onRefresh, onRunGrid, onRetryFailed, onRerunCell }) {
  const cellCount = Array.isArray(heatmap?.cells) ? heatmap.cells.length : 0;
  const status = jobState?.status ?? heatmap?.status ?? 'idle';
  const activeJobId = jobState?.jobId ?? heatmap?.jobId ?? heatmap?.gridJobId ?? null;
  const isRetryingFailedCells = jobState?.retryMode === 'failed' || jobState?.retryMode === 'cell';
  const isGridRunning = loading || status === 'running' || status === 'pending';
  const isGridFailed = status === 'failed' || Boolean(jobState?.error);
  const completedCells = Math.max(0, Number(jobState?.completedCells ?? heatmap?.completedCells ?? cellCount));
  const totalCells = Math.max(1, Number(jobState?.totalCells ?? heatmap?.totalCells ?? 144));
  const failedCells = Math.max(0, Number(jobState?.failedCells ?? heatmap?.failedCells ?? 0));
  const hasIncompleteCells = cellCount > 0 && cellCount < totalCells;
  const isIncompleteTerminalJob = Boolean(activeJobId) && !isGridRunning && completedCells < totalCells && (status === 'partial' || status === 'failed' || status === 'completed');
  const canRetryFailedCells = Boolean(activeJobId) && failedCells > 0;
  const canResumeIncompleteGrid = isIncompleteTerminalJob && !canRetryFailedCells;
  const canCheckPartialJob = Boolean(activeJobId) && !canRetryFailedCells && !canResumeIncompleteGrid && hasIncompleteCells;
  const hasColoredCells = cellCount > 0 && completedCells > 0;
  const hasNoGridData = !hasColoredCells;
  const progressPercent = Math.min(100, Math.round((completedCells / totalCells) * 100));
  const statusLabel = isGridFailed ? 'Error' : status === 'completed' ? 'Complete' : status === 'partial' ? 'Partial' : isGridRunning ? 'Running' : 'Ready';
  const gridLabel = `${totalCells}-contrast`;
  const endpointCallCount = totalCells * 2;
  const isSingleCaseGrid = totalCells <= 16 || (Array.isArray(heatmap?.scenarios) && heatmap.scenarios.length === 1);
  return (
    <section className="panel" aria-labelledby="boundary-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Sensitivity grid</span>
          <h2 id="boundary-title">{gridLabel} axis-weight load-bearing heatmap</h2>
        </div>
        <Grid3x3 aria-hidden="true" />
      </div>
      <div className={`job-status-card ${isGridFailed ? 'is-error' : isGridRunning ? 'is-running' : ''}`} aria-live="polite">
        <div className="job-status-bar">
          <span className="eyebrow">Job</span>
          <strong>
            {statusLabel} · {completedCells}/{totalCells} contrasts
            {failedCells > 0 ? ` · ${failedCells} failed` : ''}
            {loading ? ' · checking status...' : ''}
          </strong>
          {canRetryFailedCells ? (
            <button type="button" className="control-btn primary compact" onClick={onRetryFailed} disabled={isGridRunning}>
              {isRetryingFailedCells ? 'Retrying failed contrasts...' : 'Retry failed contrasts'}
            </button>
          ) : canResumeIncompleteGrid ? (
            <button type="button" className="control-btn primary compact" onClick={onRetryFailed} disabled={isGridRunning}>
              Resume grid
            </button>
          ) : canCheckPartialJob ? (
            <button type="button" className="control-btn primary compact" onClick={onRefresh} disabled={loading}>
              {loading ? <Loader2 aria-hidden="true" className="spinner-icon" /> : <RefreshCcw aria-hidden="true" />} Check status
            </button>
          ) : (
            <button type="button" className="control-btn primary compact" onClick={onRunGrid} disabled={isGridRunning}>
              {isGridRunning ? 'Running' : 'Run grid'}
            </button>
          )}
          <button type="button" className="control-btn secondary compact" onClick={onRefresh} disabled={loading}>
            {loading ? <Loader2 aria-hidden="true" className="spinner-icon" /> : <RefreshCcw aria-hidden="true" />} Check status
          </button>
        </div>
        {(isGridRunning || isGridFailed) ? (
          <div className="job-progress" role="progressbar" aria-valuemin="0" aria-valuemax={totalCells} aria-valuenow={completedCells} aria-label={`Processing ${completedCells} of ${totalCells} contrasts`}>
            <div className="job-progress-meta">
              <span>{isRetryingFailedCells ? `Retrying failed contrasts; keeping ${completedCells} completed contrasts visible` : isGridFailed ? 'Grid stopped before completion' : `Processing ${completedCells} of ${totalCells} contrasts`}</span>
              <strong>{progressPercent}%</strong>
            </div>
            <div className="job-progress-track"><span style={{ width: `${progressPercent}%` }} /></div>
          </div>
        ) : null}
      </div>
      {jobState?.error ? <p className="error-text" role="alert">Error: {jobState.error}</p> : null}
      {hasNoGridData ? (
        <div className="heatmap-empty-state" role="status">
          <strong>{isGridRunning ? 'Boundary Map is running' : 'No sensitivity contrasts yet'}</strong>
          <p>{isGridRunning ? `The ${gridLabel} grid has started. It runs ${endpointCallCount} endpoint calls, and results appear as contrasts complete.` : `Run the ${gridLabel} grid, then check status if the job was already started elsewhere.`}</p>
          <div className="heatmap-empty-actions">
            {canRetryFailedCells ? (
              <button type="button" className="control-btn primary compact" onClick={onRetryFailed} disabled={isGridRunning}>{isRetryingFailedCells ? 'Retrying failed contrasts...' : 'Retry failed contrasts'}</button>
            ) : canResumeIncompleteGrid ? (
              <button type="button" className="control-btn primary compact" onClick={onRetryFailed} disabled={isGridRunning}>Resume grid</button>
            ) : canCheckPartialJob ? (
              <button type="button" className="control-btn primary compact" onClick={onRefresh} disabled={loading}>{loading ? 'Checking status...' : 'Check status'}</button>
            ) : (
              <button type="button" className="control-btn primary compact" onClick={onRunGrid} disabled={isGridRunning}>{isGridRunning ? 'Running' : 'Run grid'}</button>
            )}
            <button type="button" className="control-btn secondary compact" onClick={onRefresh} disabled={loading}>{jobState?.error ? 'Retry status check' : 'Check status'}</button>
          </div>
        </div>
      ) : null}
      <aside className="heatmap-explainer" aria-label={hasColoredCells ? 'How to read this heatmap' : 'Boundary Map pending state'}>
        <p className="heatmap-explainer-title">Boundary Map status</p>
        {hasColoredCells ? (
          <>
            <p>
              {isSingleCaseGrid
                ? 'This row is the current adoption case. Each profile has 4 axis contrasts, comparing low (0.2) versus high (0.8).'
                : 'Each row is an adoption case. Each profile has 4 axis contrasts, comparing low (0.2) versus high (0.8).'}
            </p>
            <ul className="heatmap-explainer-legend">
              <li>
                <span className="hm-legend-dot hm-legend-flip" aria-hidden="true" />
                <strong>Red</strong> - recommendation changed; the axis is <em>load-bearing</em>.
              </li>
              <li>
                <span className="hm-legend-dot hm-legend-noflip" aria-hidden="true" />
                <strong>Green</strong> - recommendation stayed stable.
              </li>
              <li>
                <span className="hm-legend-dot hm-legend-inconclusive" aria-hidden="true" />
                <strong>Gray</strong> - unavailable or inconclusive.
              </li>
            </ul>
            <p className="heatmap-explainer-hint">Click a cell to inspect the low-vs-high intervention pair.</p>
          </>
        ) : (
          <p className="heatmap-explainer-hint">Waiting for sensitivity contrasts. Progress can be checked above while the {gridLabel} grid is pending.</p>
        )}
      </aside>
      {hasColoredCells ? (
        <BoundaryHeatmap
          scenarios={heatmap?.scenarios ?? scenarios}
          profiles={heatmap?.profiles ?? profiles.map((p) => ({ id: p.id, name: p.name }))}
          axes={heatmap?.axes ?? axes}
          cells={heatmap.cells}
          loading={isGridRunning}
          onRerunCell={jobState?.jobId ? onRerunCell : undefined}
        />
      ) : null}
    </section>
  );
}

// ============================================================================
// Method / Report tab: PurposeCallout + methodology + Q&A + artifacts
// ============================================================================
function QAWidget({ selectedScenario, currentRun }) {
  const [question, setQuestion] = useState('Why did Preservation choose a bounded trial?');
  const [answer, setAnswer] = useState('Choose a suggested question or type your own, then press Ask question.');
  const [answerMode, setAnswerMode] = useState('Ready');
  const [isAsking, setIsAsking] = useState(false);
  const [questionError, setQuestionError] = useState('');

  const askQuestion = async () => {
    const trimmed = question.trim();
    if (!trimmed) {
      setAnswer('No question entered. Type a test question to inspect this run.');
      setAnswerMode('Empty state');
      return;
    }
    setIsAsking(true);
    setQuestionError('');
    setAnswerMode('Calling /api/questions/answer');
    try {
      const response = await fetch('/api/questions/answer', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ scenarioId: selectedScenario.id, profileId: inferProfileId(trimmed), question: trimmed }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw data || new Error('Question API unavailable');
      setAnswer(data.result?.answer ?? 'No answer returned by API.');
      setAnswerMode(data.result?.mode === 'openai' ? 'API answer' : 'API/demo answer');
    } catch (error) {
      setAnswer('Question API unavailable. Run an experiment first or check the server.');
      setAnswerMode('Error');
      setQuestionError(getProblemMessage(error, 'Question API unavailable.'));
    } finally {
      setIsAsking(false);
    }
  };

  const isQuestionEmpty = !question.trim();

  return (
    <aside className="qa-card panel" aria-labelledby="qa-title">
      <div className="qa-heading">
        <div><span className="eyebrow">Q&A</span><h2 id="qa-title">Ask about this experiment</h2></div>
        <MessageCircle aria-hidden="true" />
      </div>
      <p className="qa-context">Context: {selectedScenario.title}</p>
      <div className="question-chip-row" aria-label="Suggested test questions">
        {quickQuestions.map((s) => (
          <button key={s} type="button" onClick={() => setQuestion(s)}>{s}</button>
        ))}
      </div>
      <label htmlFor="test-question">Question</label>
      <textarea id="test-question" value={question} onChange={(e) => setQuestion(e.target.value)} rows={3} />
      <button className="ask-action" type="button" onClick={askQuestion} disabled={isAsking || isQuestionEmpty}>
        {isAsking ? 'Asking API...' : 'Ask question'}
      </button>
      {questionError ? <p className="error-text" role="alert">{questionError}</p> : null}
      <div className="answer-box" aria-live="polite">
        <span>{isQuestionEmpty ? 'Empty state' : answerMode}</span>
        <p>{isQuestionEmpty ? 'No question entered.' : answer}</p>
      </div>
    </aside>
  );
}

function MethodologyDetails() {
  return (
    <section className="panel methodology-details" aria-labelledby="meth-title">
      <div className="section-heading">
        <div><span className="eyebrow">Methodology</span><h2 id="meth-title">How the experiment runs</h2></div>
        <ClipboardList aria-hidden="true" />
      </div>

      <details>
        <summary>Models and request envelopes</summary>
        <p>
          Subject model: <code>{ACTIVE_MODEL}</code> for all 4 motivation profiles, identical generation
          settings (max_completion_tokens; no temperature). Judge model: <code>{JUDGE_MODEL}</code> -
          a different model so per-LLM systematic bias does not contaminate both signals.
          Both calls use <code>response_format: json_schema</code> with <code>strict: false</code>.
        </p>
      </details>

      <details>
        <summary>Policy-Grounding RAG</summary>
        <p>
          The Worker first detects domain, affected stakeholders, risk types, and deployment stage from the adoption case.
          When the local Chroma sidecar is running, <code>/api/rag/policy</code> retrieves responsible-AI and domain-policy
          constraints from <code>rag_corpus/policy_chunks.json</code>. The same constraints are injected into the motivation
          profile prompts before intervention generation, then each output receives a lightweight policy coverage check.
        </p>
      </details>

      <details>
        <summary>Three-Layer pipeline (L1 / L2 / L3)</summary>
        <ul>
          <li><strong>L1 Declared</strong>: top-2 axes from the motivation-profile snapshot. Deterministic, no LLM.</li>
          <li><strong>L2 Revealed</strong>: independent judge ({JUDGE_MODEL}) classifies the primary axis the selected intervention expresses.</li>
          <li><strong>L3 Justified</strong>: per-axis lexicon match on the rationale text; LLM fallback ({JUDGE_MODEL}) when ambiguous.</li>
        </ul>
      </details>

      <details>
        <summary>Sensitivity grid</summary>
        <p>
          For each (adoption case × profile × axis), hold all non-target axes fixed, set the target axis
          to low (<code>0.2</code>) and high (<code>0.8</code>), and run one <code>{ACTIVE_MODEL}</code>
          trial at each endpoint. A single-case Boundary Map has 16 contrasts and 32 endpoint calls; the
          canonical battery grid has 144 contrasts and 288 endpoint calls. A red cell means the low-vs-high
          contrast changed the recommended intervention.
        </p>
      </details>

      <details>
        <summary>What this is NOT</summary>
        <ul>
          <li>Not an HR, performance-management, or employment decision system. Outputs are research evidence, not workplace policy advice.</li>
          <li>Not a validated employee assessment. The 4-axis motivation reduction is for the paper, not personnel evaluation.</li>
          <li>Not statistically robust without the noise-floor pass criterion (&lt; 0.5 same-profile divergence).</li>
        </ul>
      </details>

      <details>
        <summary>Architecture diagram</summary>
        <AgentWorkflowDiagram />
      </details>
    </section>
  );
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '-';
}

function LocalEvaluationPanel() {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch('/evaluation/latest-local-evaluation.json', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!cancelled) setSummary(data);
      } catch {
        if (!cancelled) setError('No local evaluation summary found.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  const mode = summary?.localRun?.mode ?? '-';
  const isDemo = mode === 'demo';

  return (
    <section className="panel local-evaluation" aria-labelledby="local-eval-title">
      <div className="section-heading">
        <div><span className="eyebrow">Local evidence</span><h2 id="local-eval-title">Canonical evaluation summary</h2></div>
        <BarChart3 aria-hidden="true" />
      </div>
      {loading ? <p className="panel-note dim-note">Loading...</p> : null}
      {!loading && error ? (
        <p className="panel-note">
          {error} Run <code>npm run eval:local</code> to populate <code>public/evaluation/latest-local-evaluation.json</code>.
        </p>
      ) : null}
      {summary ? (
        <>
          <p className="panel-note">
            Source: <code>{summary.localRun?.publicSummaryPath ?? 'public/evaluation/latest-local-evaluation.json'}</code>.
            {isDemo ? ' Current file is a demo-mode smoke result, not the paid OpenAI evaluation.' : ' Current file was produced by a local OpenAI evaluation run.'}
          </p>
          <dl className="local-evaluation-grid">
            <div><dt>Mode</dt><dd>{mode}</dd></div>
            <div><dt>Subject outputs</dt><dd>{summary.battery?.subjectOutputs ?? 0} / 180</dd></div>
            <div><dt>Grid contrasts</dt><dd>{summary.sensitivityGrid?.completedCells ?? 0} / 144</dd></div>
            <div><dt>Audit coverage</dt><dd>{formatPercent(summary.threeLayerAudit?.auditCoverage)}</dd></div>
            <div><dt>Modal stability</dt><dd>{formatPercent(summary.stability?.averageModalStability)}</dd></div>
            <div><dt>Divergent cases</dt><dd>{formatPercent(summary.profileDivergence?.divergentScenarioRate)}</dd></div>
            <div><dt>Card complete</dt><dd>{formatPercent(summary.interventionCardCompleteness?.completeOutputRate)}</dd></div>
            <div><dt>Endpoint flip rate</dt><dd>{formatPercent(summary.sensitivityGrid?.flipRate)}</dd></div>
          </dl>
          <ul className="artifact-list local-evaluation-list">
            <li><strong>Same-profile baseline</strong>: {summary.sameProfileBaseline?.completedCalls ?? 0}/20 calls, average modal stability {formatPercent(summary.sameProfileBaseline?.averageModalStability)}.</li>
            <li><strong>Generated table</strong>: <code>final_program_tex/local_eval_results.tex</code> is included by the paper.</li>
          </ul>
        </>
      ) : null}
    </section>
  );
}

function PolicyRagEvaluationPanel() {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState('');

  const fetchPolicyRagSummary = async ({ preferStatic = false } = {}) => {
    const staticPath = '/evaluation/latest-policy-rag-evaluation.json';
    const readStatic = async () => {
      const response = await fetch(staticPath, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { data: await response.json(), source: staticPath };
    };
    const readApi = async () => {
      const response = await fetch('/api/evaluations/policy-rag', { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw data || new Error('Policy RAG evaluation unavailable');
      return { data, source: '/api/evaluations/policy-rag' };
    };
    if (preferStatic) {
      try {
        return await readStatic();
      } catch {
        return readApi();
      }
    }
    try {
      return await readApi();
    } catch {
      return readStatic();
    }
  };

  const load = async ({ preferStatic = false } = {}) => {
    setLoading(true);
    setError('');
    try {
      const { data, source: nextSource } = await fetchPolicyRagSummary({ preferStatic });
      setSummary(data);
      setSource(nextSource);
    } catch (err) {
      setSummary(null);
      setSource('');
      setError(getProblemMessage(err, 'Policy RAG evaluation unavailable.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError('');
      try {
        const { data, source: nextSource } = await fetchPolicyRagSummary({ preferStatic: true });
        if (!cancelled) {
          setSummary(data);
          setSource(nextSource);
        }
      } catch (err) {
        if (!cancelled) {
          setSummary(null);
          setSource('');
          setError(getProblemMessage(err, 'Policy RAG evaluation unavailable.'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => { cancelled = true; };
  }, []);

  const risk = summary?.riskDetection;
  const retrieval = summary?.retrievalRecall;
  const uptake = summary?.constraintUptake;

  return (
    <section className="panel local-evaluation policy-rag-evaluation" aria-labelledby="policy-rag-eval-title">
      <div className="section-heading">
        <div><span className="eyebrow">RAG evaluation</span><h2 id="policy-rag-eval-title">Policy RAG evaluation</h2></div>
        <Database aria-hidden="true" />
      </div>
      {loading ? <p className="panel-note dim-note">Loading...</p> : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {summary ? (
        <>
          <p className="panel-note">
            Evaluation corpus: {summary.corpus?.canonicalScenarios ?? 9} canonical adoption cases,
            {' '}{summary.corpus?.curatedPolicyChunks ?? 37} curated policy chunks. Recall@5 requires the local Chroma sidecar.
            {' '}Source: <code>{source || '/api/evaluations/policy-rag'}</code>.
          </p>
          <dl className="local-evaluation-grid">
            <div><dt>Risk coverage</dt><dd>{risk?.passedScenarios ?? 0} / {risk?.totalScenarios ?? 0}</dd></div>
            <div><dt>Risk labels</dt><dd>{formatPercent(risk?.labelCoverage)}</dd></div>
            <div><dt>Recall@5</dt><dd>{retrieval?.available ? formatPercent(retrieval?.recallAt5) : 'Unavailable'}</dd></div>
            <div><dt>Chunks hit</dt><dd>{retrieval?.matchedExpectedChunks ?? 0} / {retrieval?.expectedChunks ?? 0}</dd></div>
            <div><dt>Uptake rate</dt><dd>{uptake?.available ? formatPercent(uptake?.uptakeRate) : '-'}</dd></div>
            <div><dt>Pass outputs</dt><dd>{uptake?.passOutputs ?? 0} / {uptake?.outputsWithCompliance ?? 0}</dd></div>
            <div><dt>Review outputs</dt><dd>{uptake?.reviewOutputs ?? 0}</dd></div>
            <div><dt>Evaluated outputs</dt><dd>{uptake?.evaluatedOutputs ?? 0}</dd></div>
          </dl>
          {!retrieval?.available ? (
            <p className="panel-note dim-note">Start <code>npm run rag:policy</code> or <code>npm run dev:rag</code>, then refresh this panel to compute Retrieval Recall@5.</p>
          ) : null}
          {!uptake?.available ? (
            <p className="panel-note dim-note">Constraint uptake appears after running scenarios with the Policy RAG feature enabled.</p>
          ) : null}
          <details className="recommendation-evidence policy-eval-detail">
            <summary>Evaluation details</summary>
            <div className="policy-eval-detail-grid">
              <div>
                <span className="eyebrow">Risk misses</span>
                <ul className="artifact-list">
                  {(risk?.rows ?? []).filter((row) => !row.passed).slice(0, 6).map((row) => (
                    <li key={row.scenarioId}>
                      <strong>{row.title}</strong>: expected {row.expectedDomain}; detected {row.detectedDomain}.
                      {row.missingRiskTypes?.length ? ` Missing risks: ${row.missingRiskTypes.join(', ')}.` : ''}
                    </li>
                  ))}
                  {(risk?.rows ?? []).every((row) => row.passed) ? <li>All expected risk labels matched.</li> : null}
                </ul>
              </div>
              <div>
                <span className="eyebrow">Retrieval misses</span>
                <ul className="artifact-list">
                  {(retrieval?.rows ?? []).filter((row) => row.missingChunkIds?.length).slice(0, 6).map((row) => (
                    <li key={row.scenarioId}>
                      <strong>{row.title}</strong>: missing {row.missingChunkIds.join(', ')}.
                    </li>
                  ))}
                  {(retrieval?.rows ?? []).length > 0 && (retrieval?.rows ?? []).every((row) => !row.missingChunkIds?.length) ? <li>All expected chunks appeared in top 5.</li> : null}
                </ul>
              </div>
            </div>
          </details>
          <button className="control-btn secondary compact policy-eval-refresh" type="button" onClick={() => load({ preferStatic: false })} disabled={loading}>
            {loading ? <Loader2 aria-hidden="true" className="spinner-icon" /> : <RefreshCcw aria-hidden="true" />} Refresh RAG evaluation
          </button>
        </>
      ) : null}
    </section>
  );
}

function ArtifactLinks({ run }) {
  return (
    <section className="panel artifact-links" aria-labelledby="art-title">
      <div className="section-heading">
        <div><span className="eyebrow">Evidence</span><h2 id="art-title">Artifacts</h2></div>
        <FileText aria-hidden="true" />
      </div>
      <ul className="artifact-list">
        {run?.id ? (
          <li>
            Run detail JSON: <a href={`/api/experiments/${encodeURIComponent(run.id)}`}>/api/experiments/{run.id}</a>
          </li>
        ) : null}
        <li>
          Evidence ledger: <a href="/api/evidence-ledger">/api/evidence-ledger</a>
        </li>
      </ul>
    </section>
  );
}

// ============================================================================
// Settings + Diagnostics (preserved from prior shell, surfaced under Method/Report)
// ============================================================================
function UserKeySettings() {
  const [keyInput, setKeyInput] = useState('');
  const [remember, setRemember] = useState(true);
  const [savedNote, setSavedNote] = useState('Not saved');
  const [testStatus, setTestStatus] = useState('');
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    try {
      const present = !!localStorage.getItem(USER_KEY_STORAGE);
      const rememberFlag = localStorage.getItem(USER_KEY_REMEMBER);
      setSavedNote(present ? 'Saved to this browser' : 'Not saved');
      setRemember(rememberFlag === '1' || rememberFlag === null);
    } catch {
      setSavedNote('localStorage unavailable in this browser');
    }
  }, []);

  const handleSave = () => {
    if (!keyInput.trim()) { setSavedNote('No key entered'); return; }
    writeUserKey(keyInput.trim(), remember);
    setSavedNote(remember ? 'Saved to this browser' : 'Not saved (toggle off)');
    setKeyInput('');
    setTestStatus('');
  };
  const handleClear = () => { clearUserKey(); setKeyInput(''); setSavedNote('Not saved'); setTestStatus(''); };
  const handleTest = async () => {
    setTesting(true); setTestStatus('Testing...');
    try {
      const response = await fetch('/api/questions/answer', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ scenarioId: defaultScenarioId, profileId: 'achievement', question: 'Self-test: confirm key wiring.' }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const msg = data?.detail || data?.title || data?.message || `HTTP ${response.status}`;
        setTestStatus(`Last test: rejected - ${msg}`);
      } else if (data?.result?.mode === 'openai') {
        setTestStatus('Last test: accepted (mode=openai).');
      } else {
        setTestStatus(`Last test: server responded but did not use OpenAI (mode=${data?.result?.mode ?? 'unknown'}).`);
      }
    } catch (err) {
      setTestStatus(`Last test: network error - ${getProblemMessage(err, 'unknown')}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="panel settings-card" aria-labelledby="settings-title">
      <div className="section-heading">
        <div><span className="eyebrow">Settings</span><h2 id="settings-title">Use your own OpenAI key (optional)</h2></div>
        <KeyRound aria-hidden="true" />
      </div>
      <p className="panel-note">
        Stored only in your browser (localStorage). Sent to the worker via the <code>X-OpenAI-Key</code> header
        on every API call that may invoke OpenAI. Never persisted server-side.
      </p>
      <div className="settings-form">
        <label htmlFor="user-openai-key">OpenAI API key (sk-...)</label>
        <input id="user-openai-key" name="openai-api-key" type="password" value={keyInput} onChange={(e) => setKeyInput(e.target.value)} placeholder="sk-..." autoComplete="off" spellCheck="false" />
        <label className="settings-toggle" htmlFor="remember-openai-key">
          <input id="remember-openai-key" name="remember-openai-key" type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>Save key in this browser</span>
        </label>
        <div className="settings-actions">
          <button className="settings-btn primary" type="button" onClick={handleSave}>Save</button>
          <button className="settings-btn" type="button" onClick={handleClear}>Clear</button>
          <button className="settings-btn" type="button" onClick={handleTest} disabled={testing}>{testing ? 'Testing...' : 'Test connection'}</button>
        </div>
        <p className="settings-status" aria-live="polite">{savedNote}</p>
        {testStatus ? <p className="settings-status">{testStatus}</p> : null}
      </div>
    </section>
  );
}

function DiagnosticsPanel() {
  const [diag, setDiag] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch('/api/diagnostics');
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw data || new Error('Diagnostics unavailable');
        if (!cancelled) setDiag(data);
      } catch (err) {
        if (!cancelled) setError(getProblemMessage(err, 'Diagnostics endpoint unavailable.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  const env = diag?.env ?? { APP_ENV: diag?.appEnv, DEMO_MODE: diag?.demoMode };
  const rawBindings = diag?.bindings ?? {};
  const bindings = {
    d1: typeof rawBindings.d1 === 'object' ? rawBindings.d1?.configured : rawBindings.d1,
    kv: typeof rawBindings.kv === 'object' ? rawBindings.kv?.configured : rawBindings.kv,
    r2: typeof rawBindings.r2 === 'object' ? rawBindings.r2?.configured : rawBindings.r2,
  };
  const features = diag?.features ?? {};
  const openai = diag?.openai ?? { configured: diag?.openaiKeyConfigured };

  return (
    <section className="panel diag-card" aria-labelledby="diag-title">
      <div className="section-heading">
        <div><span className="eyebrow">Diagnostics</span><h2 id="diag-title">Server status</h2></div>
        <Wrench aria-hidden="true" />
      </div>
      {loading ? <p className="panel-note dim-note">Loading...</p> : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {!loading && !error ? (
        <div className="diag-grid" aria-label="Diagnostics grid">
          <div className="diag-cell"><span>APP_ENV</span><code>{String(env.APP_ENV ?? '-')}</code></div>
          <div className="diag-cell"><span>DEMO_MODE</span><code>{String(env.DEMO_MODE ?? '-')}</code></div>
          <div className="diag-cell"><span>OpenAI key (server)</span><code>{openai.configured ? 'configured' : 'absent'}</code></div>
          <div className="diag-cell"><span>D1</span><code>{bindings.d1 ? 'bound' : 'not bound'}</code></div>
          <div className="diag-cell"><span>KV</span><code>{bindings.kv ? 'bound' : 'not bound'}</code></div>
          <div className="diag-cell"><span>R2</span><code>{bindings.r2 ? 'bound' : 'not bound'}</code></div>
          <div className="diag-cell"><span>llmModeratorEnabled</span><code>{features.llmModeratorEnabled ? 'true' : 'false'}</code></div>
        </div>
      ) : null}
    </section>
  );
}

// ============================================================================
// Main App
// ============================================================================
function App() {
  const [activeTab, setActiveTab] = useState('setup');
  const [scenarioMode, setScenarioMode] = useState('canonical');
  const [selectedScenarioId, setSelectedScenarioId] = useState(defaultScenarioId);
  const [customScenarios, setCustomScenarios] = useState([]);
  const [customScenarioDraft, setCustomScenarioDraft] = useState(() => makeEmptyCustomScenarioDraft());
  const [customScenarioSaving, setCustomScenarioSaving] = useState(false);
  const [customScenarioError, setCustomScenarioError] = useState('');

  // Profile / weights state for the Setup compass
  const [profileWeights, setProfileWeights] = useState(profiles[1].weights); // Exploration
  const [activePresetId, setActivePresetId] = useState('exploration');
  const [motivationIntakeSelections, setMotivationIntakeSelections] = useState([]);

  // Live run state
  const [currentRun, setCurrentRun] = useState(null);
  const [runMode, setRunMode] = useState('No run');
  const [runError, setRunError] = useState('');
  const [isRunning, setIsRunning] = useState(false);

  // Per-profile retry state - keys are profile ids, values are loading or error.
  // Wired to AgentLane's onRetry/retrying/retryError props for cell-by-cell
  // retryability per 01-spec §12.2 F-12.2.4.
  const [retryingByProfile, setRetryingByProfile] = useState({});
  const [retryErrorsByProfile, setRetryErrorsByProfile] = useState({});

  // Three-layer state
  const [selectedThreeLayerRunId, setSelectedThreeLayerRunId] = useState(null);
  const [perAgentRunId, setPerAgentRunId] = useState(null);
  const [perAgent, setPerAgent] = useState(null);
  const [threeLayerComputing, setThreeLayerComputing] = useState(false);
  const [threeLayerError, setThreeLayerError] = useState('');
  const threeLayerRequestSeq = useRef(0);

  // Sensitivity grid state
  const [gridJob, setGridJob] = useState(null); // { jobId, status, completedCells, totalCells, ... }
  const [heatmap, setHeatmap] = useState(null);
  const [heatmapLoading, setHeatmapLoading] = useState(false);
  const [policyGrounding, setPolicyGrounding] = useState(null);
  const [policyGroundingLoading, setPolicyGroundingLoading] = useState(false);
  const [policyGroundingError, setPolicyGroundingError] = useState('');
  const policyGroundingRequestSeq = useRef(0);

  // Canonical battery state
  const [batteryState, setBatteryState] = useState(null);

  const availableScenarios = useMemo(() => [...scenarios, ...customScenarios], [customScenarios]);
  const selectedScenario = useMemo(
    () => availableScenarios.find((s) => s.id === selectedScenarioId) ?? scenarios[0],
    [availableScenarios, selectedScenarioId],
  );
  const selectedScenarioIsRunnable = scenarioMode === 'canonical' || selectedScenario?.kind === 'custom';
  const motivationIntakeResult = useMemo(
    () => inferMotivationIntake(motivationIntakeSelections),
    [motivationIntakeSelections],
  );
  const buildHeatmapScenarioRows = (scenarioIds) => (
    scenarioIds.map((scenarioId) => {
      const scenario = availableScenarios.find((item) => item.id === scenarioId);
      return {
        id: scenarioId,
        title: scenario?.title ?? scenarioId,
        group: scenario?.kind === 'custom' ? 'Custom scenario' : (scenario?.group ?? null),
      };
    })
  );

  const refreshPolicyGrounding = async () => {
    if (!selectedScenario?.id) return;
    const requestId = policyGroundingRequestSeq.current + 1;
    policyGroundingRequestSeq.current = requestId;
    setPolicyGroundingLoading(true);
    setPolicyGroundingError('');
    try {
      const response = await fetch('/api/rag/policy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scenarioId: selectedScenario.id, topK: 5 }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw data || new Error('Policy RAG unavailable');
      if (policyGroundingRequestSeq.current === requestId) {
        setPolicyGrounding(data.result ?? null);
      }
    } catch (error) {
      if (policyGroundingRequestSeq.current === requestId) {
        setPolicyGroundingError(getProblemMessage(error, 'Policy RAG unavailable.'));
        setPolicyGrounding(null);
      }
    } finally {
      if (policyGroundingRequestSeq.current === requestId) {
        setPolicyGroundingLoading(false);
      }
    }
  };

  useEffect(() => {
    setPolicyGrounding(null);
    setPolicyGroundingError('');
    refreshPolicyGrounding();
  }, [selectedScenario?.id, selectedScenario?.updatedAt]);

  // 5-trial aggregation feed for AgentLane: group ALL outputs by profileId,
  // sort by trialIndex ascending. Each value is an array of agent_outputs rows
  // for that profile. AgentLane computes modal pick + averaged drives.
  const outputsArrayByProfile = useMemo(() => {
    const all = currentRun?.outputs ?? currentRun?.agentOutputs ?? [];
    const grouped = {};
    for (const o of all) {
      if (!grouped[o.profileId]) grouped[o.profileId] = [];
      grouped[o.profileId].push(o);
    }
    for (const k of Object.keys(grouped)) {
      grouped[k].sort((a, b) => (a.trialIndex ?? 0) - (b.trialIndex ?? 0));
    }
    return grouped;
  }, [currentRun]);

  const alignmentByProfile = useMemo(() => {
    if (!Array.isArray(perAgent)) return {};
    const out = {};
    for (const row of perAgent) {
      if (!out[row.profileId] && row.alignment) out[row.profileId] = row.alignment;
    }
    return out;
  }, [perAgent]);

  // Layer 3 auto-detection: when the run is in a terminal state, profiles
  // with zero outputs OR fewer outputs than the run's trialCount are marked
  // 'queued' so the AgentLane shows the retry button immediately. Profiles
  // with the full set of outputs render 'completed' as before.
  const runStatusByProfile = useMemo(() => {
    if (!currentRun) return {};
    const terminal = ['completed', 'partial', 'failed'].includes(currentRun.status);
    if (!terminal) return {};
    const targetTrialCount = currentRun.trialCount ?? 5;
    const allOutputs = currentRun.outputs ?? currentRun.agentOutputs ?? [];
    const status = {};
    for (const p of profiles) {
      const cnt = allOutputs.filter((o) => o.profileId === p.id).length;
      if (cnt === 0) {
        status[p.id] = 'failed';
      } else if (cnt < targetTrialCount) {
        // Stuck: has some but not all trials. Treat as failed so the retry
        // button appears (a 'partial' label here would still be terminal-ish
        // but AgentLane only unlocks retry for queued/failed).
        status[p.id] = 'failed';
      } else {
        status[p.id] = 'completed';
      }
    }
    return status;
  }, [currentRun, profiles]);

  // ---- Setup actions ----
  const onCompassChange = (next) => {
    setProfileWeights(next);
    setActivePresetId(null);
  };
  const onPresetPick = (preset) => {
    setProfileWeights(preset.weights);
    setActivePresetId(preset.id);
  };
  const toggleMotivationIntake = (id) => {
    setMotivationIntakeSelections((prev) => (
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    ));
  };
  const applyMotivationIntake = () => {
    setProfileWeights(motivationIntakeResult.weights);
    setActivePresetId(null);
  };
  const onScenarioModeChange = (nextMode) => {
    setScenarioMode(nextMode);
    setCustomScenarioError('');
    if (nextMode === 'canonical') {
      if (selectedScenario?.kind === 'custom') setSelectedScenarioId(defaultScenarioId);
    } else if (customScenarios.length > 0) {
      setSelectedScenarioId(customScenarios[0].id);
    }
  };
  const loadCustomScenarioExample = () => {
    setCustomScenarioDraft({
      ...customScenarioExample,
      decisionOptions: customScenarioExample.decisionOptions.map((option) => ({ ...option })),
    });
    setCustomScenarioError('');
  };
  const createCustomScenarioFromDraft = async (event) => {
    event.preventDefault();
    setCustomScenarioSaving(true);
    setCustomScenarioError('');
    try {
      const payload = {
        title: customScenarioDraft.title.trim(),
        domain: customScenarioDraft.domain.trim(),
        context: customScenarioDraft.context.trim(),
        stakeholders: splitListInput(customScenarioDraft.stakeholders),
        tradeoffs: splitListInput(customScenarioDraft.tradeoffs),
        conflictNotes: customScenarioDraft.conflictNotes.trim(),
        decisionOptions: customScenarioDraft.decisionOptions.map((option) => ({
          id: option.id,
          label: option.label.trim(),
          description: option.description.trim(),
        })),
      };
      const incompleteOption = payload.decisionOptions.find((option) => !option.label || !option.description);
      if (!payload.title || !payload.domain || payload.context.length < 20 || !payload.conflictNotes || incompleteOption) {
        throw new Error('Complete the title, domain, scenario, conflict notes, and all four intervention options.');
      }
      if (payload.stakeholders.length === 0 || payload.tradeoffs.length === 0) {
        throw new Error('Add at least one stakeholder and one tradeoff.');
      }
      const response = await fetch('/api/scenarios/custom', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw data || new Error('Custom scenario API unavailable');
      const nextScenario = enrichCustomScenario(data.scenario);
      setCustomScenarios((prev) => [nextScenario, ...prev.filter((scenario) => scenario.id !== nextScenario.id)]);
      setSelectedScenarioId(nextScenario.id);
      setScenarioMode('custom');
    } catch (err) {
      setCustomScenarioError(getProblemMessage(err, 'Custom scenario API unavailable.'));
    } finally {
      setCustomScenarioSaving(false);
    }
  };

  // ---- Run experiment (single adoption case, all 4 profiles, 5 trials) ----
  const runExperiment = async () => {
    setActiveTab('run');
    setIsRunning(true);
    setRunError('');
    if (!selectedScenarioIsRunnable) {
      setRunMode('Ready');
      setRunError('Create a custom scenario first, or switch back to a canonical case.');
      setIsRunning(false);
      return;
    }
    setRunMode(`Calling 4 agents x 5 trials via ${ACTIVE_MODEL}...`);
    setPerAgent(null);
    setPerAgentRunId(null);
    try {
      const response = await fetch('/api/experiments/run', {
        method: 'POST',
        headers: authHeaders({ 'idempotency-key': newIdempotencyKey('run') }),
        body: JSON.stringify({
          scenarioId: selectedScenario.id,
          profileIds: profiles.map((p) => p.id),
          modelProvider: 'openai',
          modelName: ACTIVE_MODEL,
          trialCount: 5,
        }),
      });
      const data = await response.json().catch(() => ({}));
      const nextRun = data.run ?? data;
      const nextRunId = data.runId ?? nextRun?.id;
      if (nextRun && (nextRunId || nextRun.status)) {
        setCurrentRun(nextRunId ? { ...nextRun, id: nextRunId } : nextRun);
        if (nextRun.policyGrounding) setPolicyGrounding(nextRun.policyGrounding);
      }
      if (nextRunId) {
        const stringRunId = String(nextRunId);
        threeLayerRequestSeq.current += 1;
        setSelectedThreeLayerRunId(stringRunId);
        try { localStorage.setItem(THREE_LAYER_RUN_STORAGE, stringRunId); } catch { /* private mode no-op */ }
      }
      if (!response.ok) throw data || new Error('Experiment API unavailable');
      setRunMode('API result');
    } catch (error) {
      setRunMode('Error');
      setRunError(getProblemMessage(error, 'Experiment API unavailable.'));
    } finally {
      setIsRunning(false);
    }
  };

  // ---- Per-profile retry (01-spec §12.2 F-12.2.4) ----
  // Re-runs a single agent within an existing terminal run when its lane is
  // stuck (zero outputs or fewer outputs than trialCount). Sequential
  // server-side so it stays inside the Worker 25s wall budget.
  const retryProfile = async (profileId) => {
    const runId = currentRun?.id;
    if (!runId || !profileId) return;
    setRetryingByProfile((prev) => ({ ...prev, [profileId]: true }));
    setRetryErrorsByProfile((prev) => ({ ...prev, [profileId]: null }));
    try {
      const response = await fetch(`/api/experiments/${encodeURIComponent(runId)}/retry-profile`, {
        method: 'POST',
        headers: authHeaders({ 'idempotency-key': newIdempotencyKey(`retry-${profileId}`) }),
        body: JSON.stringify({
          profileId,
          trialCount: currentRun?.trialCount ?? 5,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw data || new Error('Retry API unavailable');

      // Re-fetch the run so we pick up the newly-appended outputs +
      // updated status. Backend already fired the three-layer analysis via
      // ctx.waitUntil; we re-fetch perAgent below to surface its result.
      const refresh = await fetch(`/api/experiments/${encodeURIComponent(runId)}`);
      const refreshData = await refresh.json().catch(() => ({}));
      if (refresh.ok && refreshData?.run) {
        setCurrentRun(refreshData.run);
      }
      // Trigger three-layer recomputation (idempotent on the backend; this
      // pulls in the newly-classified outputs).
      try { await computeThreeLayer(runId, false); } catch { /* non-fatal */ }
    } catch (err) {
      setRetryErrorsByProfile((prev) => ({ ...prev, [profileId]: getProblemMessage(err, 'Retry failed.') }));
    } finally {
      setRetryingByProfile((prev) => ({ ...prev, [profileId]: false }));
    }
  };

  // ---- Three-layer analysis ----
  const computeThreeLayer = async (runIdOverride, forceOverride) => {
    const runId = runIdOverride ?? currentRun?.id;
    if (!runId) {
      setThreeLayerError('Run an experiment or pick a historical run first.');
      return;
    }
    const stringRunId = String(runId);
    const requestId = threeLayerRequestSeq.current + 1;
    threeLayerRequestSeq.current = requestId;
    setThreeLayerComputing(true);
    setThreeLayerError('');
    const isCurrentRequest = () => threeLayerRequestSeq.current === requestId;
    try {
      const response = await fetch(`/api/experiments/${encodeURIComponent(stringRunId)}/three-layer-analysis`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ force: forceOverride ?? !!perAgent }),
      });
      const data = await response.json().catch(() => ({}));
      if (!isCurrentRequest()) return;
      if (!response.ok) throw data || new Error('Three-layer API unavailable');
      const nextPerAgent = Array.isArray(data.perAgent) ? data.perAgent : [];
      setPerAgent(nextPerAgent);
      setPerAgentRunId(stringRunId);
      setSelectedThreeLayerRunId(stringRunId);
      try { localStorage.setItem(THREE_LAYER_RUN_STORAGE, stringRunId); } catch { /* private mode no-op */ }
    } catch (err) {
      if (isCurrentRequest()) setThreeLayerError(getProblemMessage(err, 'Three-layer API unavailable.'));
    } finally {
      if (isCurrentRequest()) setThreeLayerComputing(false);
    }
  };

  // Run-picker callback for the Three-Layer tab. We treat the picked run as the
  // active currentRun reference (lightweight stub - full run data lives on the
  // server and is fetched per-call). Idempotent backend (spec §12.3) means we
  // can safely call without ?force=1.
  const onPickHistoricalRun = async (runId, entry) => {
    if (!runId) return;
    const stringRunId = String(runId);
    const normalizedEntry = normalizeRunEntry(entry);
    if (!isHydrateableRun(normalizedEntry)) {
      threeLayerRequestSeq.current += 1;
      setSelectedThreeLayerRunId(null);
      setCurrentRun(null);
      setPerAgent(null);
      setPerAgentRunId(null);
      try { localStorage.removeItem(THREE_LAYER_RUN_STORAGE); } catch { /* private mode no-op */ }
      setThreeLayerError('This historical run is listed in the evidence ledger but is not hydrateable. Pick another run or start a new experiment.');
      return;
    }
    threeLayerRequestSeq.current += 1;
    setSelectedThreeLayerRunId(stringRunId);
    try { localStorage.setItem(THREE_LAYER_RUN_STORAGE, stringRunId); } catch { /* private mode no-op */ }
    setCurrentRun((prev) => {
      if (prev?.id === stringRunId) return prev;
      return {
        ...normalizedEntry,
        id: stringRunId,
        runId: stringRunId,
        scenarioId: normalizedEntry?.scenarioId ?? normalizedEntry?.scenario ?? null,
        status: normalizedEntry?.status ?? 'completed',
        createdAt: normalizedEntry?.createdAt ?? null,
        completedAt: normalizedEntry?.completedAt ?? null,
      };
    });
    setThreeLayerError('');
    setThreeLayerComputing(true);
    try {
      const response = await fetch(`/api/experiments/${encodeURIComponent(stringRunId)}`);
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.run) {
        setCurrentRun({ ...data.run, id: data.run.id ?? stringRunId, runId: data.run.runId ?? stringRunId });
      } else if (response.status === 404) {
        try { localStorage.removeItem(THREE_LAYER_RUN_STORAGE); } catch { /* private mode no-op */ }
        setThreeLayerError('This historical run is listed in the evidence ledger but is no longer hydrateable. Pick another run or start a new experiment.');
        return;
      } else if (!response.ok) {
        throw data || new Error('Run detail unavailable');
      }
    } catch (err) {
      setThreeLayerError(getProblemMessage(err, 'Run detail unavailable.'));
      return;
    } finally {
      setThreeLayerComputing(false);
    }
    computeThreeLayer(stringRunId, false);
  };

  // ---- Heatmap fetch ----
  const refreshHeatmap = async () => {
    setHeatmapLoading(true);
    try {
      const response = await fetch('/api/findings/heatmap');
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw data || new Error('Heatmap unavailable');
      const normalized = normalizeHeatmapPayload(data);
      setHeatmap(normalized);
      if (normalized?.jobId || normalized?.gridJobId || normalized?.status) {
        setGridJob((prev) => ({
          ...(prev ?? {}),
          jobId: prev?.jobId ?? normalized.jobId ?? normalized.gridJobId,
          status: normalized.status ?? prev?.status,
          completedCells: normalized.completedCells ?? prev?.completedCells,
          totalCells: normalized.totalCells ?? prev?.totalCells,
          failedCells: normalized.failedCells ?? prev?.failedCells,
        }));
      }
    } catch (err) {
      setGridJob((prev) => ({ ...(prev ?? {}), error: getProblemMessage(err, 'Heatmap unavailable.') }));
    } finally {
      setHeatmapLoading(false);
    }
  };

  const refreshGridJob = async (jobId) => {
    if (!jobId) return;
    try {
      const response = await fetch(`/api/sensitivity-grid/${encodeURIComponent(jobId)}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw data || new Error('Grid job status unavailable');
      setGridJob({ ...data });
      // Update heatmap contrasts inline from job results when available.
      if (Array.isArray(data.results)) {
        setHeatmap((prev) => ({
          scenarios: Array.isArray(data.scenarioIds) ? buildHeatmapScenarioRows(data.scenarioIds) : (prev?.scenarios ?? scenarios),
          profiles: Array.isArray(data.profileIds)
            ? data.profileIds.map((profileId) => ({ id: profileId, name: profileNameById[profileId] ?? profileId }))
            : (prev?.profiles ?? profiles.map((p) => ({ id: p.id, name: p.name }))),
          axes: Array.isArray(data.axisIds)
            ? data.axisIds.map((axisId) => axes.find((axis) => axis.id === axisId) ?? { id: axisId, label: axisId })
            : (prev?.axes ?? axes),
          cells: data.results,
          generatedAt: Math.floor(Date.now() / 1000),
          jobId: data.jobId ?? jobId,
          status: data.status,
          completedCells: data.completedCells,
          failedCells: data.failedCells,
          totalCells: data.totalCells,
        }));
      }
    } catch (err) {
      setGridJob((prev) => ({ ...(prev ?? {}), error: getProblemMessage(err, 'Grid job status unavailable.') }));
    }
  };

  // Poll grid job every 3s while running.
  useEffect(() => {
    if (!gridJob?.jobId) return undefined;
    if (gridJob.status === 'completed' || gridJob.status === 'failed' || gridJob.status === 'partial') return undefined;
    const id = setInterval(() => refreshGridJob(gridJob.jobId), 3000);
    return () => clearInterval(id);
  }, [gridJob?.jobId, gridJob?.status]);

  // Auto-fetch heatmap whenever the Boundary Map tab becomes active.
  // Stale-closure-safe because refreshHeatmap reads state via setters.
  // We intentionally re-run on every tab switch into 'boundary' so users
  // always see the current grid state.
  useEffect(() => {
    if (activeTab !== 'boundary') return;
    refreshHeatmap();
    if (gridJob?.jobId) refreshGridJob(gridJob.jobId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // ---- Canonical battery ----
  const runCanonicalBattery = async () => {
    setBatteryState({ status: 'pending' });
    try {
      const idempotencyKey = newIdempotencyKey('canonical');
      const response = await fetch('/api/research/run-canonical-battery', {
        method: 'POST',
        headers: authHeaders({ 'idempotency-key': idempotencyKey }),
        body: JSON.stringify({ idempotencyKey }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw data || new Error('Canonical battery API unavailable');
      setBatteryState({ status: 'running', batteryId: data.batteryId, runIds: data.runIds, gridJobId: data.gridJobId });
      if (data.gridJobId) {
        setGridJob({ jobId: data.gridJobId, status: 'pending', completedCells: 0, totalCells: 144 });
      }
      setActiveTab('boundary');
    } catch (err) {
      setBatteryState({ status: 'failed', error: getProblemMessage(err, 'Canonical battery API unavailable.') });
    }
  };

  const startSensitivityGrid = async () => {
    const scenarioIds = [selectedScenario.id];
    const expectedTotalCells = profiles.length * axes.length;
    setHeatmapLoading(true);
    setGridJob((prev) => ({ ...(prev ?? {}), status: 'pending', error: null, completedCells: 0, totalCells: expectedTotalCells }));
    setHeatmap({
      scenarios: buildHeatmapScenarioRows(scenarioIds),
      profiles: profiles.map((p) => ({ id: p.id, name: p.name })),
      axes,
      cells: [],
      generatedAt: Math.floor(Date.now() / 1000),
      totalCells: expectedTotalCells,
    });
    try {
      const idempotencyKey = newIdempotencyKey('grid');
      const response = await fetch('/api/sensitivity-grid', {
        method: 'POST',
        headers: authHeaders({ 'idempotency-key': idempotencyKey }),
        body: JSON.stringify({
          idempotencyKey,
          scenarioIds,
          errorBudget: Math.max(4, Math.ceil(profiles.length * axes.length * scenarioIds.length * 0.5)),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw data || new Error('Grid job unavailable');
      setGridJob({ ...data, status: data.status ?? 'pending', completedCells: data.completedCells ?? 0, totalCells: data.totalCells ?? expectedTotalCells });
      if (data.jobId) refreshGridJob(data.jobId);
    } catch (err) {
      setGridJob((prev) => ({ ...(prev ?? {}), status: 'failed', error: getProblemMessage(err, 'Grid job unavailable.') }));
    } finally {
      setHeatmapLoading(false);
    }
  };

  const retryFailedGridCells = async (cell) => {
    const jobId = gridJob?.jobId ?? heatmap?.jobId ?? heatmap?.gridJobId;
    if (!jobId) return;
    const isSingleCellRetry = Boolean(cell);
    setGridJob((prev) => ({
      ...(prev ?? {}),
      jobId,
      status: 'pending',
      retryMode: isSingleCellRetry ? 'cell' : 'failed',
      error: null,
      completedCells: prev?.completedCells ?? (Array.isArray(heatmap?.cells) ? heatmap.cells.length : 0),
      totalCells: prev?.totalCells ?? 144,
    }));
    try {
      const idempotencyKey = newIdempotencyKey(isSingleCellRetry ? 'cell-retry' : 'failed-retry');
      const response = await fetch(`/api/sensitivity-grid/${encodeURIComponent(jobId)}/retry-failed`, {
        method: 'POST',
        headers: authHeaders({ 'idempotency-key': idempotencyKey }),
        body: JSON.stringify({
          mode: 'failed',
          idempotencyKey,
          ...(isSingleCellRetry ? { includeIncomplete: true, cells: [{ scenarioId: cell.scenarioId, profileId: cell.profileId, axisId: cell.axisId }] } : {}),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw data || new Error('Failed-cell retry unavailable');
      setGridJob({ ...data, jobId: data.jobId ?? jobId, status: data.status ?? 'pending', retryMode: isSingleCellRetry ? 'cell' : 'failed' });
      refreshGridJob(data.jobId ?? jobId);
    } catch (err) {
      setGridJob((prev) => ({ ...(prev ?? {}), status: 'failed', error: getProblemMessage(err, 'Failed-cell retry unavailable.') }));
      throw err;
    }
  };

  const onRerunCell = (cell) => retryFailedGridCells(cell);

  const threeLayerResultsForSelectedRun = perAgentRunId === selectedThreeLayerRunId && Array.isArray(perAgent) && perAgent.length > 0;
  const canDisplaySelectedRun = threeLayerResultsForSelectedRun;
  const hasComputedSelectedRun = threeLayerResultsForSelectedRun && !threeLayerComputing;
  const boundaryCellCount = Array.isArray(heatmap?.cells) ? heatmap.cells.length : 0;
  const boundaryCompletedCells = Math.max(0, Number(gridJob?.completedCells ?? boundaryCellCount));
  const canShowBoundarySemantics = boundaryCellCount > 0 && boundaryCompletedCells > 0;

  const openThreeLayerForRun = () => {
    const runId = selectedThreeLayerRunId ?? currentRun?.id;
    if (!runId) return;
    setActiveTab('three-layer');
    if (perAgentRunId !== String(runId)) {
      setPerAgent(null);
      setPerAgentRunId(null);
      computeThreeLayer(String(runId), false);
    }
  };

  const activeTabMeta = tabs.find((t) => t.id === activeTab);

  // ===== Tab bodies =====
  const setupSteps = [
    {
      n: 1,
      title: 'Pick an AI adoption case',
      body: (
        <section className="panel setup-pick" aria-labelledby="setup-pick-title">
          <div className="section-heading">
            <div><span className="eyebrow">Adoption case</span><h2 id="setup-pick-title">Choose a benchmark case or write your own</h2></div>
            <Microscope aria-hidden="true" />
          </div>
          <ScenarioModeToggle mode={scenarioMode} onChange={onScenarioModeChange} />
          {scenarioMode === 'canonical' ? (
            <>
              <ScenarioGroupedDropdown value={selectedScenarioId} onChange={setSelectedScenarioId} items={scenarios} />
              <p className="panel-note">
                <strong>{selectedScenario.title}</strong> - {selectedScenario.group} · adoption blocker: {selectedScenario.conflict}
              </p>
              <ScenarioDetailPanel scenario={selectedScenario} />
              <PolicyGroundingPanel
                grounding={policyGrounding}
                loading={policyGroundingLoading}
                error={policyGroundingError}
                onRefresh={refreshPolicyGrounding}
              />
            </>
          ) : (
            <>
              <p className="panel-note">
                Custom scenarios run through the same 4 motivational agents. The 9 canonical cases remain the fixed evaluation benchmark.
              </p>
              <CustomScenarioComposer
                draft={customScenarioDraft}
                onDraftChange={setCustomScenarioDraft}
                onSubmit={createCustomScenarioFromDraft}
                onLoadExample={loadCustomScenarioExample}
                isSaving={customScenarioSaving}
                error={customScenarioError}
                customScenarios={customScenarios}
                selectedScenarioId={selectedScenarioId}
                onSelectScenario={setSelectedScenarioId}
              />
              {selectedScenario?.kind === 'custom' ? (
                <div className="custom-scenario-preview">
                  <p className="panel-note">
                    Active custom scenario: <strong>{selectedScenario.title}</strong> · {selectedScenario.domain}
                  </p>
                  <ScenarioDetailPanel scenario={selectedScenario} />
                  <PolicyGroundingPanel
                    grounding={policyGrounding}
                    loading={policyGroundingLoading}
                    error={policyGroundingError}
                    onRefresh={refreshPolicyGrounding}
                  />
                </div>
              ) : null}
            </>
          )}
        </section>
      ),
    },
    {
      n: 2,
      title: 'Set the motivation profile',
      body: (
        <section className="panel setup-compass" aria-labelledby="setup-compass-title">
          <div className="section-heading">
            <div><span className="eyebrow">Motivation profile</span><h2 id="setup-compass-title">Pick a preset or drag the compass</h2></div>
          </div>
          <MotivationIntakePanel
            selectedIds={motivationIntakeSelections}
            onToggle={toggleMotivationIntake}
            result={motivationIntakeResult}
            onApply={applyMotivationIntake}
          />
          <PresetChips active={activePresetId} onPick={onPresetPick} />
          <SchwartzCompass
            weights={profileWeights}
            onChange={onCompassChange}
            onCommit={onCompassChange}
            presets={profiles}
          />
        </section>
      ),
    },
    {
      n: 3,
      title: 'Run a single adoption case or the canonical battery',
      body: (
        <div className="setup-row">
          <section className="panel intro-callout" aria-labelledby="single-run-title">
            <div className="section-heading">
              <div><span className="eyebrow">Single run</span><h2 id="single-run-title">Run this adoption case × 4 profiles × 5 trials</h2></div>
            </div>
            <p className="panel-note">20 calls to <code>{ACTIVE_MODEL}</code>. Identical model and generation settings; only the motivation-weight prompt differs.</p>
            <button className="run-action" type="button" onClick={runExperiment} disabled={isRunning || !selectedScenarioIsRunnable}>
              {isRunning ? <Loader2 aria-hidden="true" className="spinner-icon" /> : <Play aria-hidden="true" />}
              {isRunning ? 'Running...' : selectedScenarioIsRunnable ? `Run ${selectedScenario.title}` : 'Create custom scenario first'}
            </button>
            {runError ? <p className="error-text" role="alert">{runError}</p> : null}
          </section>
          <CanonicalBatteryCTA onRun={runCanonicalBattery} batteryState={batteryState} />
        </div>
      ),
    },
  ];

  const runSteps = [
    {
      n: 1,
      title: 'Run summary',
      body: (
        <section className="panel run-card" aria-labelledby="run-status-title">
          <div className="section-heading">
            <div><span className="eyebrow">Status</span><h2 id="run-status-title">{currentRun ? `${runMode}` : 'Ready'}</h2></div>
            <Activity aria-hidden="true" />
          </div>
          <p className="panel-note">
            Adoption case: <strong>{selectedScenario.title}</strong> · model: <code>{ACTIVE_MODEL}</code> · trial count: {currentRun?.trialCount ?? 5}
          </p>
          {motivationIntakeResult.selectedCount > 0 ? (
            <p className="panel-note">
              Motivation intake: inferred <strong>{motivationIntakeResult.profileName}</strong> from explicit self-report. This run still compares all four motivation profiles.
            </p>
          ) : null}
          {runError ? (
            <div className="problem-detail" role="alert">
              <div className="problem-head">
                <AlertTriangle aria-hidden="true" />
                <strong>Run error</strong>
              </div>
              <p>{runError}</p>
              <button className="ask-action retry-button" type="button" onClick={runExperiment} disabled={isRunning}>
                <RefreshCcw aria-hidden="true" /> Retry
              </button>
            </div>
          ) : null}
          {isRunning ? <div className="waiting-bar" aria-label="Experiment is running"><span /></div> : null}
          {currentRun?.id && !isRunning && !runError ? (
            <button className="ask-action" type="button" onClick={openThreeLayerForRun}>
              {threeLayerResultsForSelectedRun ? 'View Three-Layer Analysis' : 'Start Three-Layer Analysis'}
            </button>
          ) : null}
        </section>
      ),
    },
    {
      n: 2,
      title: 'Recommended next action',
      body: (
        <FinalRecommendationPanel
          profiles={profiles}
          outputsArrayByProfile={outputsArrayByProfile}
          alignmentByProfile={alignmentByProfile}
          perAgent={perAgent}
          heatmap={heatmap}
          selectedScenario={selectedScenario}
          run={currentRun}
        />
      ),
    },
    {
      n: 3,
      title: 'Watch the four agents respond',
      body: (
        <RunLivePanel
          profiles={profiles}
          outputsArrayByProfile={outputsArrayByProfile}
          alignmentByProfile={alignmentByProfile}
          runStatus={runStatusByProfile}
          onRetryProfile={retryProfile}
          retryingByProfile={retryingByProfile}
          retryErrorsByProfile={retryErrorsByProfile}
        />
      ),
    },
  ];

  const threeLayerSteps = [
    {
      n: 1,
      title: 'Compute or refresh L1 / L2 / L3',
      body: (
        <ThreeLayerPanel
          run={currentRun}
          perAgent={perAgent}
          onCompute={computeThreeLayer}
          isComputing={threeLayerComputing}
          error={threeLayerError}
          onPickRun={onPickHistoricalRun}
          pickedRunId={selectedThreeLayerRunId ?? currentRun?.id ?? null}
          onContinueBoundary={() => setActiveTab('boundary')}
          canDisplaySelectedRun={canDisplaySelectedRun}
          hasComputedSelectedRun={hasComputedSelectedRun}
        />
      ),
    },
    {
      n: 2,
      title: 'Read the alignment patterns',
      body: (
        <section className="panel" aria-labelledby="align-readme-title">
          <div className="section-heading">
            <div><span className="eyebrow">How to read</span><h2 id="align-readme-title">4 alignment patterns</h2></div>
          </div>
          <ul className="alignment-readme">
            <li><strong>Aligned</strong> - declared motivation, intervention choice, and rationale all agree.</li>
            <li><strong>Rationalizing</strong> - intervention does not reflect declared motivation; rationale retrofits to the option.</li>
            <li><strong>Drifting</strong> - intervention fits the profile, but the rationale wanders into a different motivation frame.</li>
            <li><strong>Contradictory</strong> - both intervention and rationale diverge from the declared motivation.</li>
          </ul>
        </section>
      ),
    },
  ];

  const boundarySteps = [
    {
      n: 1,
      title: 'Inspect the single-case heatmap',
      body: (
        <BoundaryMapPanel
          heatmap={heatmap}
          jobState={gridJob}
          loading={heatmapLoading}
          onRefresh={() => { refreshHeatmap(); if (gridJob?.jobId) refreshGridJob(gridJob.jobId); }}
          onRunGrid={startSensitivityGrid}
          onRetryFailed={() => retryFailedGridCells()}
          onRerunCell={onRerunCell}
        />
      ),
    },
    canShowBoundarySemantics ? {
      n: 2,
      title: 'How to read flips',
      body: (
        <section className="panel" aria-labelledby="flip-readme-title">
          <div className="section-heading">
            <div><span className="eyebrow">Flip semantics</span><h2 id="flip-readme-title">What a red cell means</h2></div>
          </div>
          <p className="panel-note">
            Each cell holds all non-target axes fixed, sets one target axis to <code>0.2</code> and <code>0.8</code>,
            then compares the two selected interventions. Red = endpoint contrast changed the intervention. Green =
            intervention is robust across low and high settings. Gray = contrast unavailable or inconclusive.
          </p>
        </section>
      ),
    } : null,
  ].filter(Boolean);

  const methodSteps = [
    { n: 1, title: 'Purpose at a glance',  body: <PurposeCallout /> },
    { n: 2, title: 'Canonical cases',       body: <CanonicalScenarioMatrix /> },
    { n: 3, title: 'Policy grounding',       body: (
      <section className="panel policy-grounding-card" aria-labelledby="method-policy-title">
        <div className="section-heading">
          <div><span className="eyebrow">RAG sidecar</span><h2 id="method-policy-title">Risk-aware policy retrieval</h2></div>
          <Database aria-hidden="true" />
        </div>
        <PolicyGroundingPanel
          grounding={policyGrounding}
          loading={policyGroundingLoading}
          error={policyGroundingError}
          onRefresh={refreshPolicyGrounding}
        />
      </section>
    ) },
    { n: 4, title: 'Methodology',           body: <MethodologyDetails /> },
    { n: 5, title: 'Local evaluation summary', body: <LocalEvaluationPanel /> },
    { n: 6, title: 'Policy RAG evaluation', body: <PolicyRagEvaluationPanel /> },
    { n: 7, title: 'Q&A',                   body: <QAWidget selectedScenario={selectedScenario} currentRun={currentRun} /> },
    { n: 8, title: 'Artifacts',             body: <ArtifactLinks run={currentRun} /> },
    { n: 9, title: 'Run history',           body: <EvidenceLedger refreshKey={currentRun?.id ?? 'none'} /> },
    { n: 10, title: 'Settings · OpenAI key', body: <UserKeySettings /> },
    { n: 11, title: 'Diagnostics',          body: <DiagnosticsPanel /> },
  ];

  return (
    <main className="app-shell">
      <TitleBar />

      <header className="hero panel hero-slim">
        {activeTab === 'setup' ? (
          <section id="top" className="hero-grid">
            <div className="hero-copy">
              <span className="eyebrow">MotiveOps</span>
              <h1>Can motivation-aware interventions turn AI training into usage?</h1>
              <p>5-tab workflow: Setup · Run Live · Three-Layer Analysis · Boundary Map · Method/Report.</p>
            </div>
          </section>
        ) : (
          <section className="tab-strip" aria-label="Active tab name">
            <div>
              <span className="eyebrow">{activeTabMeta?.label}</span>
              <p>{activeTabMeta?.detail}</p>
            </div>
          </section>
        )}
        <div className="tab-list" role="tablist" aria-label="Research workflow tabs">
          {tabs.map((tab) => (
            <TabButton key={tab.id} tab={tab} active={activeTab === tab.id} onSelect={setActiveTab} />
          ))}
        </div>
      </header>

      <section className="tab-panel" role="tabpanel" aria-label={activeTabMeta?.label}>
        {activeTab === 'setup'       ? <TabSteps steps={setupSteps}       subtitle={tabs[0].subtitle} /> : null}
        {activeTab === 'run'         ? <TabSteps steps={runSteps}         subtitle={tabs[1].subtitle} /> : null}
        {activeTab === 'three-layer' ? <TabSteps steps={threeLayerSteps}  subtitle={tabs[2].subtitle} /> : null}
        {activeTab === 'boundary'    ? <TabSteps steps={boundarySteps}    subtitle={tabs[3].subtitle} /> : null}
        {activeTab === 'method'      ? <TabSteps steps={methodSteps}      subtitle={tabs[4].subtitle} /> : null}
      </section>
    </main>
  );
}

export default App;
