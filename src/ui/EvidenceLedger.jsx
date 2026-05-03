import { useEffect, useState } from 'react';
import { Database } from 'lucide-react';

const LOCAL_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});

export function formatLocalTimestamp(value) {
  if (value === null || value === undefined || value === '') return '';
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return LOCAL_TIMESTAMP_FORMATTER.format(date);
}

/**
 * Evidence Ledger - fetches GET /api/evidence-ledger.
 * Backend response shape (assumed from worker.ts route):
 *   { entries: Array<{ id, runId, scenarioId, profilesIncluded, divergenceResult, flipIndicator, createdAt, ... }> }
 * Only renders fields actually returned. No fabricated zeros.
 */
export default function EvidenceLedger({ refreshKey }) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const response = await fetch('/api/evidence-ledger');
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw data || new Error('Evidence ledger unavailable');
        }
        if (!cancelled) {
          setEntries(Array.isArray(data.entries) ? data.entries : []);
        }
      } catch (err) {
        if (!cancelled) {
          setError(typeof err === 'string' ? err : err?.detail || err?.title || err?.message || 'Evidence ledger unavailable.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return (
    <section className="panel ledger-table-card" aria-labelledby="ledger-table-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Evidence ledger</span>
          <h2 id="ledger-table-title">Audit log of saved runs</h2>
        </div>
        <Database aria-hidden="true" />
      </div>
      {loading ? <p className="panel-note">Loading ledger entries...</p> : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {!loading && !error && entries && entries.length === 0 ? (
        <p className="panel-note">No ledger entries returned by the API.</p>
      ) : null}
      {entries && entries.length > 0 ? (
        <div className="ledger-table-wrap" role="region" aria-label="Evidence ledger table">
          <table className="ledger-table">
            <thead>
              <tr>
                <th scope="col">Entry</th>
                <th scope="col">Adoption case</th>
                <th scope="col">Run</th>
                <th scope="col">Result</th>
                <th scope="col">Recorded</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => {
                const id = entry.id ?? entry.entryId ?? `row-${index}`;
                const scenario = entry.scenarioId ?? entry.scenario ?? '-';
                const runId = entry.runId ?? '-';
                const result = entry.divergenceResult ?? entry.result ?? entry.summary ?? (entry.flipIndicator ? `flip: ${entry.flipIndicator}` : '-');
                const created = formatLocalTimestamp(entry.createdAt ?? entry.timestamp ?? entry.recordedAt) || '-';
                return (
                  <tr key={id}>
                    <td>{id}</td>
                    <td>{scenario}</td>
                    <td>{runId}</td>
                    <td>{String(result)}</td>
                    <td>{created}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
