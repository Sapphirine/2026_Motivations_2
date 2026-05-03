import { useEffect, useRef, useState } from 'react';
import { X, Loader2, CircleCheck, RefreshCw } from 'lucide-react';

/**
 * HeatmapCellModal - opens on a BoundaryHeatmap cell click. Shows the
 * baseline option, the perturbed option, the flip flag, and the perturbed
 * rationale excerpt. Implements the §10.3 single-cell sensitivity probe.
 *
 * Re-run feedback: the parent submits this cell to the active grid job's
 * retry-failed endpoint, then polling refreshes the heatmap after the batch lands.
 *
 * Props:
 *   cell:                { scenarioId, profileId, axisId, baselineOption,
 *                          perturbedOption, flipped, perturbedRationaleExcerpt,
 *                          stability }
 *   scenarioLabel:       human-readable adoption case name
 *   profileLabel:        human-readable profile name
 *   axisLabel:           human-readable axis name
 *   onClose:             () => void
 *   onRerun:             () => void  // optional - re-run this cell
 */
export default function HeatmapCellModal({ cell, scenarioLabel, profileLabel, axisLabel, onClose, onRerun }) {
  const closeBtnRef = useRef(null);
  const [rerunning, setRerunning] = useState(false);
  const [rerunDoneAt, setRerunDoneAt] = useState(null);
  const [rerunError, setRerunError] = useState(null);
  const [previousSnapshot, setPreviousSnapshot] = useState(null);
  const successHideTimer = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', handler);
    closeBtnRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', handler);
      if (successHideTimer.current) clearTimeout(successHideTimer.current);
    };
  }, [onClose]);

  if (!cell) return null;

  const flipState = cell.flipped === true ? 'flipped' : cell.flipped === false ? 'no-flip' : 'inconclusive';
  const flipLabel = flipState === 'flipped' ? 'Intervention changed' : flipState === 'no-flip' ? 'No change' : 'Inconclusive (baseline unstable)';

  function handleRerun() {
    if (rerunning || typeof onRerun !== 'function') return;
    setPreviousSnapshot({
      perturbedOption: cell.perturbedOption ?? null,
      flipped: cell.flipped,
    });
    setRerunError(null);
    setRerunning(true);
    if (successHideTimer.current) {
      clearTimeout(successHideTimer.current);
      successHideTimer.current = null;
    }
    Promise.resolve()
      .then(() => onRerun())
      .then(() => new Promise((resolve) => setTimeout(resolve, 3000)))
      .then(() => {
        setRerunning(false);
        setRerunDoneAt(Date.now());
        successHideTimer.current = setTimeout(() => {
          successHideTimer.current = null;
        }, 4000);
      })
      .catch((err) => {
        setRerunning(false);
        setRerunError(typeof err === 'string' ? err : (err?.message ?? 'Re-run failed'));
      });
  }

  // Only show the success line for ~4s after completion (timer resolves
  // quietly above; the conditional below is still based on rerunDoneAt).
  const showSuccess = rerunDoneAt && Date.now() - rerunDoneAt < 4000 && !rerunning;

  return (
    <div className="cell-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="cell-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cell-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cell-modal-head">
          <div>
            <span className="eyebrow">Sensitivity cell</span>
            <h3 id="cell-modal-title">{scenarioLabel} · {profileLabel} · {axisLabel}</h3>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            className="cell-modal-close"
            aria-label="Close cell detail"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </div>

        <div className={`cell-flip-banner cell-${flipState}`}>
          <strong>{flipLabel}</strong>
          {typeof cell.stability === 'number' ? (
            <span>baseline stability {cell.stability.toFixed(2)}</span>
          ) : null}
        </div>

        <dl className="cell-modal-grid">
          <div>
            <dt>Baseline intervention</dt>
            <dd>{cell.baselineOption ?? <span className="dim-note">(unstable - no modal)</span>}</dd>
          </div>
          <div>
            <dt>Perturbed intervention (axis weight to 0.2)</dt>
            <dd>{cell.perturbedOption ?? <span className="dim-note">(no perturbed run)</span>}</dd>
          </div>
        </dl>

        {cell.perturbedRationaleExcerpt ? (
          <div className="cell-modal-rationale">
            <span className="eyebrow">Perturbed rationale excerpt</span>
            <p>{cell.perturbedRationaleExcerpt}</p>
          </div>
        ) : null}

        {typeof onRerun === 'function' ? (
          <>
            <div className="cell-modal-actions">
              <button
                type="button"
                className="settings-btn"
                onClick={handleRerun}
                disabled={rerunning}
                aria-label="Re-run this cell"
              >
                {rerunning ? (
                  <Loader2 aria-hidden="true" className="spinner-icon" />
                ) : (
                  <RefreshCw aria-hidden="true" />
                )}
                {rerunning ? 'Submitting...' : 'Re-run this cell'}
              </button>
            </div>

            {previousSnapshot && rerunDoneAt ? (
              <div className="cell-rerun-compare">
                <span className="eyebrow">Before vs after</span>
                <div className="cell-rerun-cols">
                  <div>
                    <strong>Previous</strong>
                    <p>Picked {previousSnapshot.perturbedOption ?? '-'}</p>
                    <p>
                      Flip:{' '}
                      {previousSnapshot.flipped === true
                        ? 'yes'
                        : previousSnapshot.flipped === false
                          ? 'no'
                          : '-'}
                    </p>
                  </div>
                  <div>
                    <strong>Pending refresh</strong>
                    <p className="dim-note">
                      New result will appear after the active grid job retry completes. Check status or wait for polling, then re-click the cell.
                    </p>
                  </div>
                </div>
                <p className="dim-note" style={{ margin: '6px 0 0', fontSize: '13px' }}>
                  Submitted to the active grid job - refresh the heatmap to see the new flip flag.
                </p>
              </div>
            ) : null}

            {showSuccess ? (
              <p className="cell-rerun-status" role="status">
                <CircleCheck aria-hidden="true" />
                Re-run submitted.
              </p>
            ) : null}

            {rerunError ? (
              <p className="error-text" role="alert">{rerunError}</p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
