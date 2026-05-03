/**
 * TabSteps - numbered sub-step renderer used inside every top-level tab.
 *
 * Rationale (from user feedback): the previous one-tab-many-cards layout was
 * too tall to scan. The reworked layout breaks each tab into 1-2-3-...
 * vertical numbered cards so the user sees discrete, scannable steps and
 * never has to scroll past unrelated content.
 *
 * Each step is rendered as a standalone card with:
 *   - circular step number ("1", "2", ...)
 *   - title (h3)
 *   - body (any ReactNode - usually a panel or grid)
 *
 * `subtitle` (optional, NEW for the 5-tab IA): a short "What you'll learn"
 * one-liner rendered above the numbered list. Backwards compatible - when
 * `subtitle` is omitted the component renders exactly as before.
 *
 * Pure presentational. No state. No hooks.
 */
export default function TabSteps({ steps, subtitle }) {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  return (
    <div className="tab-steps-shell">
      {subtitle ? (
        <p className="tab-steps-subtitle" role="note">
          <span className="eyebrow">What you'll learn</span>
          <span className="tab-steps-subtitle-text">{subtitle}</span>
        </p>
      ) : null}
      <ol className="tab-steps" aria-label="Sub-steps">
        {steps.map((step) => (
          <li key={`step-${step.n}-${step.title}`} className="tab-step">
            <div className="tab-step-head">
              <span className="tab-step-num" aria-hidden="true">{step.n}</span>
              <h3 className="tab-step-title">{step.title}</h3>
            </div>
            <div className="tab-step-body">{step.body}</div>
          </li>
        ))}
      </ol>
    </div>
  );
}
