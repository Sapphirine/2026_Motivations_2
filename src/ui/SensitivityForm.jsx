import { useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';

/**
 * Sensitivity Loop form.
 *
 * Sends the schema-correct payload accepted by `sensitivitySchema` in
 * `src/api/schemas.ts:32-39`:
 *
 *   POST /api/experiments/:runId/sensitivity
 *   body: {
 *     profileId: 'achievement' | 'exploration' | 'preservation' | 'neutral',
 *     axisChanges: Array<{
 *       axis: 'achievement' | 'selfDirection' | 'security' | 'benevolence',
 *       from: number,    // current weight in [0, 1]
 *       to:   number,    // perturbed weight in [0, 1]
 *     }>,
 *     // rerunMode defaults to 'selected-profile-only' on the server.
 *   }
 *
 * UX contract:
 *   - User picks a profile, an axis, and a magnitude (+/- 0.2).
 *   - We read the current axis weight from
 *     `outputsByProfile[profileId].profileSnapshot.axisWeights[i].value` and
 *     compute `from = currentWeight`, `to = clamp(currentWeight + delta, 0, 1)`.
 *   - The original H1 defect was POSTing `{ drive, delta }` - that field set
 *     does not match the Zod schema and the backend returned an RFC 9457 400
 *     on every submit. The schema mismatch is now fixed and verified with the
 *     JSDoc above mirroring `runExperimentSchema`'s sibling.
 *
 * Backend response shape:
 *   { sensitivityRun: { id, baseRunId, profileId, axisChanges, flipped, ... } }
 */
const drives = [
  { id: 'achievement', label: 'Achievement' },
  { id: 'selfDirection', label: 'Self-direction' },
  { id: 'security', label: 'Security' },
  { id: 'benevolence', label: 'Benevolence' },
];

const profileOptions = [
  { id: 'achievement', label: 'Achievement profile' },
  { id: 'exploration', label: 'Exploration profile' },
  { id: 'preservation', label: 'Preservation profile' },
  { id: 'neutral', label: 'Neutral profile' },
];

// Local fallback when an output's profileSnapshot is missing (e.g. demo run).
// Mirrors the seed values in src/domain/seeds.ts so the UI can still preview a
// payload without a server response, even though the form is gated on runId.
const fallbackAxisWeights = {
  achievement: { achievement: 0.8, selfDirection: 0.5, security: 0.2, benevolence: 0.5 },
  exploration: { achievement: 0.5, selfDirection: 0.8, security: 0.5, benevolence: 0.2 },
  preservation: { achievement: 0.2, selfDirection: 0.5, security: 0.8, benevolence: 0.8 },
  neutral: { achievement: 0.5, selfDirection: 0.5, security: 0.5, benevolence: 0.5 },
};

function clampUnit(value) {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function readCurrentWeight(outputsByProfile, profileId, axisId) {
  const output = outputsByProfile?.[profileId];
  const axisWeights = output?.profileSnapshot?.axisWeights;
  if (Array.isArray(axisWeights)) {
    const match = axisWeights.find((entry) => entry?.axis === axisId);
    if (match && typeof match.value === 'number') return match.value;
  }
  return fallbackAxisWeights[profileId]?.[axisId] ?? 0.5;
}

export default function SensitivityForm({ runId, outputsByProfile }) {
  const [profileId, setProfileId] = useState('preservation');
  const [drive, setDrive] = useState('security');
  const [delta, setDelta] = useState(0.2);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!runId) {
      setError('Run an experiment first; sensitivity needs a runId.');
      return;
    }
    setSubmitting(true);
    setError('');
    setResult(null);
    try {
      const numericDelta = Number(delta);
      const fromWeight = clampUnit(readCurrentWeight(outputsByProfile, profileId, drive));
      const toWeight = clampUnit(fromWeight + numericDelta);
      const response = await fetch(`/api/experiments/${runId}/sensitivity`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profileId,
          axisChanges: [{ axis: drive, from: fromWeight, to: toWeight }],
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw data || new Error('Sensitivity API unavailable');
      }
      setResult(data.sensitivityRun ?? null);
    } catch (err) {
      setError(typeof err === 'string' ? err : err?.detail || err?.title || err?.message || 'Sensitivity API unavailable.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="panel sensitivity-card" aria-labelledby="sensitivity-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">Sensitivity Loop</span>
          <h2 id="sensitivity-title">Perturb one axis · re-run</h2>
        </div>
        <SlidersHorizontal aria-hidden="true" />
      </div>
      <p className="panel-note">
        Adjust a single motivation axis weight by a small delta and re-issue the run for one profile.
        The backend reports change / no-change vs the original intervention.
      </p>
      <div className="sensitivity-form">
        <label htmlFor="sens-profile">Profile</label>
        <select id="sens-profile" value={profileId} onChange={(event) => setProfileId(event.target.value)}>
          {profileOptions.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>

        <label htmlFor="sens-drive">Axis</label>
        <select id="sens-drive" value={drive} onChange={(event) => setDrive(event.target.value)}>
          {drives.map((item) => (
            <option key={item.id} value={item.id}>{item.label}</option>
          ))}
        </select>

        <label htmlFor="sens-delta">Delta</label>
        <select id="sens-delta" value={delta} onChange={(event) => setDelta(Number(event.target.value))}>
          <option value={0.2}>+0.2</option>
          <option value={-0.2}>-0.2</option>
        </select>

        <button
          className="ask-action"
          type="button"
          onClick={submit}
          disabled={submitting || !runId}
        >
          {submitting ? 'Re-running profile...' : 'Run sensitivity check'}
        </button>
      </div>
      {!runId ? (
        <p className="panel-note dim-note">
          Sensitivity is enabled after a successful API run; demo-fallback runs are not eligible.
        </p>
      ) : null}
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {result ? (
        <div className="sensitivity-result" aria-live="polite">
          <span className={`flip-badge ${result.flipped ? 'flip-yes' : 'flip-no'}`}>
            {result.flipped ? 'Intervention changed' : 'No change'}
          </span>
          <p>
            Profile <strong>{result.profileId}</strong>
            {Array.isArray(result.axisChanges) && result.axisChanges.length > 0
              ? ` · axis ${result.axisChanges[0].axis} ${result.axisChanges[0].from} to ${result.axisChanges[0].to}`
              : ''}
          </p>
        </div>
      ) : null}
    </section>
  );
}
