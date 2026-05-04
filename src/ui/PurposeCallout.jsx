import { Microscope, Users, Layers, Sparkles } from 'lucide-react';

/**
 * PurposeCallout - 4-chip card on Tab 5 (Method/Report).
 *
 * Chips:
 *   1. Purpose   - research question one-liner
 *   2. Agents    - number + identity of subject agents
 *   3. Layer 1   - what L1 measures (declared)
 *   4. Layer 2   - what L2 measures (judge LLM)
 *
 * Compact, presentational. Read once on tab open and never updates.
 */
const ITEMS = [
  {
    Icon: Microscope,
    eyebrow: 'Purpose',
    title: 'Can motivation-aware interventions turn AI training into actual AI usage?',
    body: 'Three-layer triangulation across declared motivation, recommended adoption intervention, and justification, plus single-case or full-benchmark sensitivity heatmaps.',
  },
  {
    Icon: Users,
    eyebrow: 'Agents',
    title: '4 subject profiles · gpt-5.4-nano',
    body: 'Achievement · Exploration · Preservation · Neutral baseline. Identical model and generation settings; only the motivation-weight prompt differs.',
  },
  {
    Icon: Layers,
    eyebrow: 'Layer 1 - Declared',
    title: 'Top-2 axes from the profile',
    body: 'Deterministic JSON extraction from the motivation profile snapshot. No LLM call.',
  },
  {
    Icon: Sparkles,
    eyebrow: 'Layer 2 - Revealed',
    title: 'Independent judge: gpt-5.4-mini',
    body: 'A different model classifies the primary axis the selected intervention expresses, regardless of the agent\'s own justification.',
  },
];

export default function PurposeCallout() {
  return (
    <section className="purpose-callout panel" aria-labelledby="purpose-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">At a glance</span>
          <h2 id="purpose-title">What this experiment tests</h2>
        </div>
      </div>
      <div className="purpose-grid">
        {ITEMS.map((item) => {
          const Icon = item.Icon;
          return (
            <div key={item.eyebrow} className="purpose-chip" role="group" aria-label={item.eyebrow}>
              <div className="purpose-chip-head">
                <Icon aria-hidden="true" />
                <span className="eyebrow">{item.eyebrow}</span>
              </div>
              <p className="purpose-chip-title">{item.title}</p>
              <p className="purpose-chip-body">{item.body}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
