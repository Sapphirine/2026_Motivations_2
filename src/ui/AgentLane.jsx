import { Loader2, CircleCheck, CircleAlert, Clock, RefreshCw } from 'lucide-react';

/**
 * AgentLane - fixed preset frame for ONE profile aggregating its 5 trials.
 *
 * Old: single-trial display (output prop). User feedback ("프리셋으로 만드는거면
 * 클리어하게 틀을 만들어서 고정하라는거였음"): make the 5-trial aggregation
 * legible with a deterministic fixed frame, hide the LLM verbatim text behind
 * the Detail disclosure.
 *
 * Frame (always visible, no LLM text):
 *   - Status chip + alignment pill
 *   - Headline:  "Recommended X · N of T trials · stability P%"
 *   - Top drivers row: averaged top-2 drives across all trials
 *   - Retry button (Lane J - preserved)
 *
 * Detail disclosure:
 *   1. Per-trial breakdown table (deterministic columns)
 *   2. Representative trial rationale (LLM verbatim, framed)
 *   3. Averaged drive attribution table
 *
 * Props:
 *   profile:           { id, name, schwartz?, tone? }
 *   outputs:           array of agent_outputs rows for this profile, sorted by trialIndex asc
 *   status:            'queued'|'running'|'completed'|'partial'|'failed'
 *   alignmentPattern?: 'Aligned' | ...   // optional badge
 *   onRetry?:          () => void
 *   retrying?:         boolean
 *   retryError?:       string
 */
const STATUS_META = {
  queued:    { Icon: Clock,        label: 'Queued',    cls: 'queued' },
  running:   { Icon: Loader2,      label: 'Running',   cls: 'running' },
  completed: { Icon: CircleCheck,  label: 'Completed', cls: 'completed' },
  partial:   { Icon: CircleAlert,  label: 'Partial',   cls: 'partial' },
  failed:    { Icon: CircleAlert,  label: 'Failed',    cls: 'failed' },
};

function formatDriverLabel(drive) {
  const map = {
    achievement:    'Achievement',
    self_direction: 'Self-Direction',
    selfDirection:  'Self-Direction',
    security:       'Security',
    benevolence:    'Benevolence',
  };
  return map[drive] ?? drive;
}

function pickedKey(out) {
  // Deterministic identity for "what this trial picked".
  const decision = out?.structuredDecision;
  return decision?.selectedOptionId ?? decision?.decisionSummary ?? null;
}

function topDriverForTrial(out) {
  const trace =
    out?.driveTrace && Array.isArray(out.driveTrace) && out.driveTrace.length > 0
      ? out.driveTrace
      : (out?.structuredDecision?.driveAttributions ?? []);
  const sorted = [...(Array.isArray(trace) ? trace : [])]
    .filter((entry) => entry && typeof entry.weight === 'number')
    .sort((a, b) => b.weight - a.weight);
  return sorted[0] ?? null;
}

function aggregate(outputs) {
  const total = Array.isArray(outputs) ? outputs.length : 0;
  if (total === 0) {
    return { total: 0, modal: null, modalCount: 0, stabilityPct: null, top2Avg: [], driveStats: [] };
  }

  // Modal pick: most-frequent picked key, tie-break = first alphabetically.
  const counts = {};
  for (const o of outputs) {
    const k = pickedKey(o);
    if (k == null) continue;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  const sortedKeys = Object.keys(counts).sort((a, b) => {
    if (counts[b] !== counts[a]) return counts[b] - counts[a];
    return a.localeCompare(b);
  });
  const modal = sortedKeys[0] ?? null;
  const modalCount = modal ? counts[modal] : 0;

  // Drive averaging: each drive's weight averaged across all trials (missing = 0).
  const driveSum = {};
  const driveSeen = {};
  for (const o of outputs) {
    const trace =
      o?.driveTrace && Array.isArray(o.driveTrace) && o.driveTrace.length > 0
        ? o.driveTrace
        : (o?.structuredDecision?.driveAttributions ?? []);
    if (!Array.isArray(trace)) continue;
    for (const entry of trace) {
      if (!entry || typeof entry.weight !== 'number') continue;
      driveSum[entry.drive] = (driveSum[entry.drive] ?? 0) + entry.weight;
      driveSeen[entry.drive] = (driveSeen[entry.drive] ?? 0) + 1;
    }
  }
  const driveStats = Object.keys(driveSum).map((drive) => ({
    drive,
    avgWeight: driveSum[drive] / total, // missing-as-zero average
    trialsSeen: driveSeen[drive] ?? 0,
  }));
  driveStats.sort((a, b) => b.avgWeight - a.avgWeight);
  const top2Avg = driveStats.slice(0, 2);

  const stabilityPct = total > 1 ? Math.round((modalCount / total) * 100) : null;

  return { total, modal, modalCount, stabilityPct, top2Avg, driveStats };
}

export default function AgentLane({ profile, outputs, status, alignmentPattern, onRetry, retrying, retryError }) {
  const safeOutputs = Array.isArray(outputs) ? outputs : [];
  const agg = aggregate(safeOutputs);
  const effectiveStatus = status ?? (agg.total > 0 ? 'completed' : 'queued');
  const meta = STATUS_META[effectiveStatus] ?? STATUS_META.queued;
  const StatusIcon = meta.Icon;

  // Headline string per spec - fixed wording, no LLM text.
  let headline;
  if (agg.total === 0) {
    if (effectiveStatus === 'failed') {
      headline = 'No trials completed';
    } else if (effectiveStatus === 'running') {
      headline = 'Awaiting response...';
    } else {
      headline = 'Queued - no trials yet';
    }
  } else {
    const stability = agg.stabilityPct == null ? '-' : `${agg.stabilityPct}%`;
    const pickLabel = agg.modal ?? '(no modal)';
    headline = `Recommended ${pickLabel} · ${agg.modalCount} of ${agg.total} trials · stability ${stability}`;
  }

  const retryEligible = typeof onRetry === 'function'
    && (effectiveStatus === 'queued' || effectiveStatus === 'failed');

  // Representative trial: first trial that matched the modal pick.
  const representativeTrial = agg.modal
    ? safeOutputs.find((o) => pickedKey(o) === agg.modal)
    : null;
  const representativeRationale = representativeTrial?.structuredDecision?.rationale ?? null;
  const policyCompliance = representativeTrial?.structuredDecision?.policyCompliance ?? null;

  return (
    <article className={`agent-lane lane-${meta.cls}`}>
      <header className="lane-header">
        <div className="lane-id">
          <span className={`lane-status-dot lane-${meta.cls}`} aria-hidden="true" />
          <h3>{profile?.name ?? 'Profile'}</h3>
          {profile?.schwartz ? <span className="lane-schwartz">{profile.schwartz}</span> : null}
        </div>
        <span className={`lane-status-chip lane-${meta.cls}`}>
          <StatusIcon
            aria-hidden="true"
            className={effectiveStatus === 'running' ? 'spinner-icon' : ''}
          />
          {meta.label}
        </span>
      </header>

      <p className="lane-headline">{headline}</p>

      {agg.top2Avg.length > 0 ? (
        <>
          <div className="lane-driver-chips" aria-label="Average top drivers across trials">
            {agg.top2Avg.map((d) => (
              <span key={d.drive} className="lane-driver-chip">
                {formatDriverLabel(d.drive)} <strong>{d.avgWeight.toFixed(2)}</strong>
              </span>
            ))}
          </div>
          <p className="lane-meta-line">Avg drivers across {agg.total} trials</p>
        </>
      ) : null}

      {retryEligible ? (
        <div className="lane-retry-row">
          <button
            type="button"
            className="lane-retry-button"
            onClick={onRetry}
            disabled={Boolean(retrying)}
            aria-label={`Retry ${profile?.name ?? 'this agent'}`}
          >
            <RefreshCw aria-hidden="true" className={retrying ? 'spinner-icon' : ''} />
            {retrying ? 'Retrying...' : 'Retry this agent'}
          </button>
          {retryError ? <p className="lane-retry-error" role="alert">{retryError}</p> : null}
        </div>
      ) : null}

      {alignmentPattern ? (
        <div className="lane-alignment-row">
          <span className="eyebrow">Alignment</span>
          <span className={`lane-alignment-pill alignment-${alignmentPattern.toLowerCase()}`}>
            {alignmentPattern}
          </span>
        </div>
      ) : null}

      {/* Detail disclosure - collapsed by default. */}
      {agg.total > 0 ? (
        <details className="lane-detail">
          <summary>Detail</summary>

          {/* 1. Per-trial breakdown */}
          <div className="lane-detail-block">
            <span className="eyebrow">Per-trial breakdown</span>
            <table className="lane-trial-table">
              <thead>
                <tr>
                  <th>Trial</th>
                  <th>Picked</th>
                  <th>Top driver</th>
                  <th>Tradeoff count</th>
                </tr>
              </thead>
              <tbody>
                {safeOutputs.map((o, i) => {
                  const k = pickedKey(o);
                  const matchesModal = agg.modal && k === agg.modal;
                  const top = topDriverForTrial(o);
                  const tradeoffs = o?.structuredDecision?.tradeoffs;
                  const tcount = Array.isArray(tradeoffs) ? tradeoffs.length : 0;
                  const trialNum = (o?.trialIndex ?? i) + 1;
                  const pickedLabel = k
                    ? (k.length > 40 ? `${k.slice(0, 40)}...` : k)
                    : '-';
                  return (
                    <tr key={`trial-${trialNum}-${i}`} className={matchesModal ? 'lane-trial-modal' : ''}>
                      <td>#{trialNum}</td>
                      <td>{pickedLabel}</td>
                      <td>{top ? `${formatDriverLabel(top.drive)} ${top.weight.toFixed(2)}` : '-'}</td>
                      <td>{tcount}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* 2. Representative trial rationale (LLM verbatim) */}
          {representativeTrial && representativeRationale ? (
            <div className="lane-detail-block">
              <span className="eyebrow">
                Representative trial · #{(representativeTrial.trialIndex ?? 0) + 1}
              </span>
              <p>{representativeRationale}</p>
            </div>
          ) : null}

          {policyCompliance ? (
            <div className="lane-detail-block">
              <span className="eyebrow">Policy compliance check</span>
              <p>
                Status: <strong>{policyCompliance.status}</strong>
                {policyCompliance.coveredRiskTypes?.length ? ` · covered: ${policyCompliance.coveredRiskTypes.join(', ')}` : ''}
                {policyCompliance.missingRiskTypes?.length ? ` · review: ${policyCompliance.missingRiskTypes.join(', ')}` : ''}
              </p>
            </div>
          ) : null}

          {/* 3. Averaged drive attribution */}
          {agg.driveStats.length > 0 ? (
            <div className="lane-detail-block">
              <span className="eyebrow">Averaged drive attribution</span>
              <table className="lane-drive-table">
                <thead>
                  <tr>
                    <th>Axis</th>
                    <th>Avg weight</th>
                    <th>Trials seen</th>
                  </tr>
                </thead>
                <tbody>
                  {agg.driveStats.map((d) => (
                    <tr key={`avg-${d.drive}`}>
                      <td>{formatDriverLabel(d.drive)}</td>
                      <td>{d.avgWeight.toFixed(2)}</td>
                      <td>{d.trialsSeen} / {agg.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </details>
      ) : null}
    </article>
  );
}
