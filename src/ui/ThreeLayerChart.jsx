/**
 * ThreeLayerChart - per-agent chart that overlays L1 declared / L2 judged /
 * L3 extracted axes onto a single 4-axis bar grid.
 *
 * Visual contract (per 02-design §7.3):
 *   - 4 columns (axes), one per Schwartz axis.
 *   - L1 declared bar height = 0/0.5/0.8 normalized.
 *   - L2 judge marker (▲ triangle) sits at the top of the column the judge
 *     selected; opacity = confidence.
 *   - L3 extracted marker (● dot) sits at top of the column the rationale
 *     invokes.
 *   - Reading rule: when bar + triangle + dot all align on one column,
 *     the agent is Aligned. Diverging markers are visually obvious.
 *
 * Props:
 *   l1Top2:        ['achievement', 'self_direction']      // top-2 from declared profile
 *   l1Weights:     { axis -> 0..1 }                       // full weight bars
 *   l2Axis:        'achievement' | ...                     // judge axis
 *   l2Confidence:  0..1
 *   l3Axis:        'achievement' | ...                     // rationale axis
 *   l3Resolution:  'lexicon' | 'llm_fallback' | 'ambiguous'
 */
const AXES = [
  { id: 'achievement',    label: 'Achieve',  full: 'Achievement' },
  { id: 'self_direction', label: 'Self-dir',  full: 'Self-Direction' },
  { id: 'security',       label: 'Security',  full: 'Security' },
  { id: 'benevolence',    label: 'Benevolence',  full: 'Benevolence' },
];

const COL_WIDTH = 64;
const COL_GAP = 16;
const CHART_HEIGHT = 140;
const CHART_PAD_X = 18;
const CHART_PAD_Y = 24;

export default function ThreeLayerChart({ l1Top2, l1Weights, l2Axis, l2Confidence, l3Axis, l3Resolution }) {
  const totalWidth = AXES.length * COL_WIDTH + (AXES.length - 1) * COL_GAP + CHART_PAD_X * 2;
  const totalHeight = CHART_HEIGHT + CHART_PAD_Y * 2 + 28; /* axis label row */

  const columnX = (i) => CHART_PAD_X + i * (COL_WIDTH + COL_GAP);
  const top2Set = new Set(Array.isArray(l1Top2) ? l1Top2 : []);

  return (
    <div className="three-layer-chart" role="figure" aria-label="L1 declared, L2 judged, L3 rationale per axis">
      <svg viewBox={`0 0 ${totalWidth} ${totalHeight}`} className="three-layer-chart-svg" role="img">
        {/* Background grid lines (0.25, 0.5, 0.75, 1.0) */}
        {[0.25, 0.5, 0.75, 1].map((t) => {
          const y = CHART_PAD_Y + CHART_HEIGHT - t * CHART_HEIGHT;
          return (
            <line key={t} x1={CHART_PAD_X} y1={y} x2={totalWidth - CHART_PAD_X} y2={y}
              stroke="#e0dccf" strokeDasharray={t === 1 ? '0' : '2 4'} strokeWidth="1" />
          );
        })}
        {AXES.map((axis, i) => {
          const x = columnX(i);
          const w = (l1Weights && typeof l1Weights[axis.id] === 'number') ? l1Weights[axis.id] : 0;
          const barH = w * CHART_HEIGHT;
          const barY = CHART_PAD_Y + CHART_HEIGHT - barH;
          const isTop2 = top2Set.has(axis.id);
          const isL2 = l2Axis === axis.id;
          const isL3 = l3Axis === axis.id;
          const triY = CHART_PAD_Y - 8;
          const dotY = CHART_PAD_Y + CHART_HEIGHT + 8;
          return (
            <g key={axis.id}>
              {/* L1 declared bar */}
              <rect
                x={x}
                y={barY}
                width={COL_WIDTH}
                height={barH}
                rx={6}
                fill={isTop2 ? '#5b5ce2' : '#bcb7ad'}
                opacity={isTop2 ? 0.85 : 0.45}
              />
              {/* Column baseline */}
              <line x1={x} y1={CHART_PAD_Y + CHART_HEIGHT} x2={x + COL_WIDTH} y2={CHART_PAD_Y + CHART_HEIGHT}
                stroke="#a39c8d" strokeWidth="1.2" />
              {/* L2 marker (triangle, top) */}
              {isL2 ? (
                <g>
                  <polygon
                    points={`${x + COL_WIDTH / 2 - 8},${triY + 12} ${x + COL_WIDTH / 2 + 8},${triY + 12} ${x + COL_WIDTH / 2},${triY}`}
                    fill="#dc6b34"
                    opacity={typeof l2Confidence === 'number' ? Math.max(0.4, l2Confidence) : 0.85}
                  >
                    <title>L2 judge axis · confidence {(l2Confidence ?? 0).toFixed(2)}</title>
                  </polygon>
                </g>
              ) : null}
              {/* L3 marker (dot, bottom) */}
              {isL3 ? (
                <circle
                  cx={x + COL_WIDTH / 2}
                  cy={dotY}
                  r={7}
                  fill={l3Resolution === 'ambiguous' ? '#8a8d96' : '#3f7d5a'}
                >
                  <title>L3 rationale axis · {l3Resolution ?? 'lexicon'}</title>
                </circle>
              ) : null}
              {/* Axis label */}
              <text
                x={x + COL_WIDTH / 2}
                y={dotY + 22}
                textAnchor="middle"
                className="three-layer-axis-label"
              >
                {axis.label}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="three-layer-legend" aria-label="Legend">
        <span className="legend-cell"><span className="legend-bar" /> L1 declared</span>
        <span className="legend-cell"><span className="legend-tri" /> L2 judge</span>
        <span className="legend-cell"><span className="legend-dot" /> L3 rationale</span>
      </div>
    </div>
  );
}
