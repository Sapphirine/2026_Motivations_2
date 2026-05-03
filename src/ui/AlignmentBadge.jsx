import { useState } from 'react';
import { Check, AlertTriangle, Zap } from 'lucide-react';

/**
 * AlignmentBadge - one of four colored pills for L1 / L2 / L3 alignment patterns.
 *
 * Patterns (from 01-spec.md §2.1):
 *   - Aligned        green - declared motivation, intervention, and rationale all agree
 *   - Rationalizing  amber - intervention diverges from declared motivation, rationale matches intervention
 *   - Drifting       amber - intervention matches declared motivation, rationale wanders
 *   - Contradictory  red   - both diverge from declared motivation
 *
 * Click toggles a popover that surfaces the L2 judge reasoning string (and,
 * when present, the matched L3 lexicon words). This is the evidence reveal
 * for §9.2 of the spec.
 */
const PATTERN_META = {
  Aligned: {
    cls: 'aligned',
    icon: Check,
    summary: 'Declared motivation, intervention, and rationale all agree.',
  },
  Rationalizing: {
    cls: 'rationalizing',
    icon: AlertTriangle,
    summary: 'Intervention does not reflect declared motivation; rationale retrofits to the option.',
  },
  Drifting: {
    cls: 'drifting',
    icon: AlertTriangle,
    summary: 'Intervention fits the profile, but the rationale wanders into another motivation frame.',
  },
  Contradictory: {
    cls: 'contradictory',
    icon: Zap,
    summary: 'Intervention and rationale both diverge from the declared motivation.',
  },
};

export default function AlignmentBadge({ pattern, judgeReasoning, lexiconMatches }) {
  const [open, setOpen] = useState(false);
  const meta = PATTERN_META[pattern];
  if (!meta) {
    return <span className="alignment-badge alignment-unknown" aria-label="Alignment unknown">Unknown</span>;
  }
  const Icon = meta.icon;
  const lexiconList = Array.isArray(lexiconMatches) ? lexiconMatches : [];

  return (
    <div className={`alignment-badge-shell alignment-${meta.cls}`}>
      <button
        type="button"
        className={`alignment-badge alignment-${meta.cls}`}
        aria-expanded={open}
        aria-controls={`align-pop-${pattern}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon aria-hidden="true" />
        <strong>{pattern}</strong>
      </button>
      {open ? (
        <div id={`align-pop-${pattern}`} className="alignment-pop" role="region" aria-label={`${pattern} explanation`}>
          <p className="alignment-summary">{meta.summary}</p>
          {judgeReasoning ? (
            <div className="alignment-section">
              <span className="eyebrow">Judge reasoning (L2)</span>
              <p>{judgeReasoning}</p>
            </div>
          ) : null}
          {lexiconList.length > 0 ? (
            <div className="alignment-section">
              <span className="eyebrow">Matched rationale words (L3)</span>
              <div className="alignment-chips">
                {lexiconList.map((w) => (
                  <span key={w} className="alignment-chip">{w}</span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
