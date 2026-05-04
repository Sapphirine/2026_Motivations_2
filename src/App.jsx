/**
 * MotiveOps - front-end shell (5-tab IA).
 *
 * UPDATED 2026-05-02 for the MotiveOps AI workflow adoption pivot
 * (see 01-spec.md + 02-design.md). Replaces the prior 6-tab layout with:
 *   1. Setup              - adoption-case picker + motivation compass + canonical-battery CTA
 *   2. Run Live           - 4 AgentLane cards (summary-first)
 *   3. Three-Layer Analysis - per-agent ThreeLayerChart + AlignmentBadge
 *   4. Boundary Map       - 144-cell BoundaryHeatmap + job progress
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
  FileText,
  Grid3x3,
  KeyRound,
  Layers,
  Loader2,
  MessageCircle,
  Microscope,
  Play,
  RefreshCcw,
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
  { id: 'boundary',    label: 'Boundary Map',         detail: '144-cell intervention sensitivity grid',
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
const scenarios = [
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

const profiles = [
  { id: 'achievement',  name: 'Achievement',       tone: 'ROI and visible competence',       schwartz: 'Achievement · high', weights: { achievement: 0.8, self_direction: 0.5, security: 0.5, benevolence: 0.2 } },
  { id: 'exploration',  name: 'Exploration',       tone: 'learning and choice',              schwartz: 'Self-Direction · high', weights: { achievement: 0.5, self_direction: 0.8, security: 0.2, benevolence: 0.5 } },
  { id: 'preservation', name: 'Preservation',      tone: 'trust and reversibility',          schwartz: 'Security · high',     weights: { achievement: 0.5, self_direction: 0.2, security: 0.8, benevolence: 0.5 } },
  { id: 'neutral',      name: 'Neutral baseline',  tone: 'balanced weights',                schwartz: 'All axes balanced',   weights: { achievement: 0.5, self_direction: 0.5, security: 0.5, benevolence: 0.5 } },
];

const axes = [
  { id: 'achievement',    label: 'Achieve', full: 'Achievement' },
  { id: 'self_direction', label: 'Self-dir', full: 'Self-Direction' },
  { id: 'security',       label: 'Security', full: 'Security' },
  { id: 'benevolence',    label: 'Benevolence', full: 'Benevolence' },
];

const defaultScenarioId = 'coding-assistant-low-trust-evaluation-anxiety';
const profileNameById = Object.fromEntries(profiles.map((p) => [p.id, p.name]));

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
function ScenarioGroupedDropdown({ value, onChange }) {
  const grouped = useMemo(() => {
    const map = new Map();
    for (const s of scenarios) {
      if (!map.has(s.group)) map.set(s.group, []);
      map.get(s.group).push(s);
    }
    return [...map.entries()];
  }, []);

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
        9 adoption cases × 4 profiles × 5 trials + 20-call same-profile baseline + 144-cell sensitivity grid + 9 moderator calls.
        Approximately <strong>~353 live OpenAI calls</strong>; budget before running and expect <strong>~5-10 min</strong> wall clock.
        Idempotent - re-running with the same key resumes pending cells.
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
// Boundary Map tab: 144-cell heatmap + job status bar
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
  const canRetryFailedCells = Boolean(activeJobId) && (failedCells > 0 || status === 'partial' || status === 'failed');
  const canCheckPartialJob = Boolean(activeJobId) && !canRetryFailedCells && hasIncompleteCells;
  const hasColoredCells = cellCount > 0 && completedCells > 0;
  const hasNoGridData = !hasColoredCells;
  const progressPercent = Math.min(100, Math.round((completedCells / totalCells) * 100));
  const statusLabel = isGridFailed ? 'Error' : status === 'completed' || status === 'partial' ? 'Success' : isGridRunning ? 'Running' : 'Ready';
  return (
    <section className="panel" aria-labelledby="boundary-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Sensitivity grid</span>
          <h2 id="boundary-title">144-cell axis-weight load-bearing heatmap</h2>
        </div>
        <Grid3x3 aria-hidden="true" />
      </div>
      <div className={`job-status-card ${isGridFailed ? 'is-error' : isGridRunning ? 'is-running' : ''}`} aria-live="polite">
        <div className="job-status-bar">
          <span className="eyebrow">Job</span>
          <strong>
            {statusLabel} · {completedCells}/{totalCells} cells
            {failedCells > 0 ? ` · ${failedCells} failed` : ''}
            {loading ? ' · checking status...' : ''}
          </strong>
          {canRetryFailedCells ? (
            <button type="button" className="control-btn primary compact" onClick={onRetryFailed} disabled={isGridRunning}>
              {isRetryingFailedCells ? 'Retrying failed cells...' : 'Retry failed cells'}
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
          <div className="job-progress" role="progressbar" aria-valuemin="0" aria-valuemax={totalCells} aria-valuenow={completedCells} aria-label={`Processing ${completedCells} of ${totalCells} cells`}>
            <div className="job-progress-meta">
              <span>{isRetryingFailedCells ? `Retrying failed cells; keeping ${completedCells} completed cells visible` : isGridFailed ? 'Grid stopped before completion' : `Processing ${completedCells} of ${totalCells} cells`}</span>
              <strong>{progressPercent}%</strong>
            </div>
            <div className="job-progress-track"><span style={{ width: `${progressPercent}%` }} /></div>
          </div>
        ) : null}
      </div>
      {jobState?.error ? <p className="error-text" role="alert">Error: {jobState.error}</p> : null}
      {hasNoGridData ? (
        <div className="heatmap-empty-state" role="status">
          <strong>{isGridRunning ? 'Boundary Map is running' : 'No sensitivity cells yet'}</strong>
          <p>{isGridRunning ? 'The 144-cell grid has started. Results will appear after cells complete.' : 'Run the 144-cell grid, then check status if the job was already started elsewhere.'}</p>
          <div className="heatmap-empty-actions">
            {canRetryFailedCells ? (
              <button type="button" className="control-btn primary compact" onClick={onRetryFailed} disabled={isGridRunning}>{isRetryingFailedCells ? 'Retrying failed cells...' : 'Retry failed cells'}</button>
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
              Each row is an adoption case, each major column is one of 4 motivational profiles, and each profile splits into 4 sub-cells representing which motivation axis weight was forcibly weakened: Achievement, Self-direction, Security, or Benevolence.
            </p>
            <ul className="heatmap-explainer-legend">
              <li>
                <span className="hm-legend-dot hm-legend-flip" aria-hidden="true" />
                <strong>Red</strong> - agent changed its intervention when that axis was lowered, revealing the <em>load-bearing</em> motivation in that adoption case.
              </li>
              <li>
                <span className="hm-legend-dot hm-legend-noflip" aria-hidden="true" />
                <strong>Green</strong> - intervention held under perturbation.
              </li>
              <li>
                <span className="hm-legend-dot hm-legend-inconclusive" aria-hidden="true" />
                <strong>Gray</strong> - baseline modal stability &lt; 0.6 (inconclusive).
              </li>
            </ul>
            <p className="heatmap-explainer-hint">Click any cell for the baseline-vs-perturbed intervention pair.</p>
          </>
        ) : (
          <p className="heatmap-explainer-hint">Waiting for sensitivity cells. Progress can be checked above while the 144-cell grid is pending.</p>
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
        <summary>Three-Layer pipeline (L1 / L2 / L3)</summary>
        <ul>
          <li><strong>L1 Declared</strong>: top-2 axes from the motivation-profile snapshot. Deterministic, no LLM.</li>
          <li><strong>L2 Revealed</strong>: independent judge ({JUDGE_MODEL}) classifies the primary axis the selected intervention expresses.</li>
          <li><strong>L3 Justified</strong>: per-axis lexicon match on the rationale text; LLM fallback ({JUDGE_MODEL}) when ambiguous.</li>
        </ul>
      </details>

      <details>
        <summary>Sensitivity grid (144 cells)</summary>
        <p>
          For each (adoption case × profile × axis), perturb the named axis weight to 0.2 and re-run one
          {' '}<code>{ACTIVE_MODEL}</code> trial. Compare the perturbed selected option to the
          baseline 5-trial modal option and classify whether the perturbation changed the recommended intervention.
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
            <div><dt>Grid cells</dt><dd>{summary.sensitivityGrid?.completedCells ?? 0} / 144</dd></div>
            <div><dt>Audit coverage</dt><dd>{formatPercent(summary.threeLayerAudit?.auditCoverage)}</dd></div>
            <div><dt>Modal stability</dt><dd>{formatPercent(summary.stability?.averageModalStability)}</dd></div>
            <div><dt>Divergent cases</dt><dd>{formatPercent(summary.profileDivergence?.divergentScenarioRate)}</dd></div>
            <div><dt>Card complete</dt><dd>{formatPercent(summary.interventionCardCompleteness?.completeOutputRate)}</dd></div>
            <div><dt>Flip rate</dt><dd>{formatPercent(summary.sensitivityGrid?.flipRate)}</dd></div>
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
            Per-run JSON: <a href={`/api/artifacts/${encodeURIComponent(run.id)}`}>/api/artifacts/{run.id}</a>
          </li>
        ) : null}
        <li>
          Canonical evidence (battery): <a href="/api/research/canonical-evidence" download>Canonical adoption evidence - 392 KB JSON</a>
        </li>
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
  const [selectedScenarioId, setSelectedScenarioId] = useState(defaultScenarioId);

  // Profile / weights state for the Setup compass
  const [profileWeights, setProfileWeights] = useState(profiles[1].weights); // Exploration
  const [activePresetId, setActivePresetId] = useState('exploration');

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

  // Canonical battery state
  const [batteryState, setBatteryState] = useState(null);

  const selectedScenario = useMemo(
    () => scenarios.find((s) => s.id === selectedScenarioId) ?? scenarios[0],
    [selectedScenarioId],
  );

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

  // ---- Run experiment (single adoption case, all 4 profiles, 5 trials) ----
  const runExperiment = async () => {
    setActiveTab('run');
    setIsRunning(true);
    setRunError('');
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
      // Update heatmap cells inline from job results when available.
      if (Array.isArray(data.results)) {
        setHeatmap((prev) => ({
          scenarios: prev?.scenarios ?? scenarios,
          profiles: prev?.profiles ?? profiles.map((p) => ({ id: p.id, name: p.name })),
          axes: prev?.axes ?? axes,
          cells: data.results,
          generatedAt: Math.floor(Date.now() / 1000),
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
    setHeatmapLoading(true);
    setGridJob((prev) => ({ ...(prev ?? {}), status: 'pending', error: null, completedCells: prev?.completedCells ?? 0, totalCells: prev?.totalCells ?? 144 }));
    try {
      const idempotencyKey = newIdempotencyKey('grid');
      const response = await fetch('/api/sensitivity-grid', {
        method: 'POST',
        headers: authHeaders({ 'idempotency-key': idempotencyKey }),
        body: JSON.stringify({ idempotencyKey }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw data || new Error('Grid job unavailable');
      setGridJob({ ...data, status: data.status ?? 'pending', completedCells: data.completedCells ?? 0, totalCells: data.totalCells ?? 144 });
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
            <div><span className="eyebrow">Adoption case</span><h2 id="setup-pick-title">Choose from 9 canonical adoption cases in 3 groups</h2></div>
            <Microscope aria-hidden="true" />
          </div>
          <ScenarioGroupedDropdown value={selectedScenarioId} onChange={setSelectedScenarioId} />
          <p className="panel-note">
            <strong>{selectedScenario.title}</strong> - {selectedScenario.group} · adoption blocker: {selectedScenario.conflict}
          </p>
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
            <button className="run-action" type="button" onClick={runExperiment} disabled={isRunning}>
              {isRunning ? <Loader2 aria-hidden="true" className="spinner-icon" /> : <Play aria-hidden="true" />}
              {isRunning ? 'Running...' : `Run ${selectedScenario.title}`}
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
      title: 'Inspect the 144-cell heatmap',
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
            Each cell perturbs <em>one axis weight</em> from the profile default to <code>0.2</code>, then re-runs the
            adoption case once. Red = perturbed run picked a different intervention than the baseline 5-trial modal. Green =
            intervention is robust to that single-axis change. Gray = baseline modal stability &lt; 0.6 (inconclusive).
          </p>
        </section>
      ),
    } : null,
  ].filter(Boolean);

  const methodSteps = [
    { n: 1, title: 'Purpose at a glance',  body: <PurposeCallout /> },
    { n: 2, title: 'Methodology',           body: <MethodologyDetails /> },
    { n: 3, title: 'Local evaluation summary', body: <LocalEvaluationPanel /> },
    { n: 4, title: 'Q&A',                   body: <QAWidget selectedScenario={selectedScenario} currentRun={currentRun} /> },
    { n: 5, title: 'Artifacts',             body: <ArtifactLinks run={currentRun} /> },
    { n: 6, title: 'Run history',           body: <EvidenceLedger refreshKey={currentRun?.id ?? 'none'} /> },
    { n: 7, title: 'Settings · OpenAI key', body: <UserKeySettings /> },
    { n: 8, title: 'Diagnostics',           body: <DiagnosticsPanel /> },
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
