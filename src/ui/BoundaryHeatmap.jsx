import { useMemo, useState } from 'react';
import HeatmapCellModal from './HeatmapCellModal.jsx';

/**
 * BoundaryHeatmap - 9-row x 16-cell sensitivity grid.
 *
 * Layout:
 *   - 9 rows = AI workflow adoption cases clustered into 3 groups
 *   - 16 columns = 4 profiles × 4 axes per profile
 *   - Color: red low/high endpoint flip / green no endpoint flip / gray inconclusive
 *
 * Cell hover -> tooltip via SVG <title>; cell click -> HeatmapCellModal.
 *
 * Props:
 *   scenarios:  Array<{ id, title, group? }>
 *   profiles:   Array<{ id, name }>
 *   axes:       Array<{ id, label }>
 *   cells:      Array<Cell>     // see 02-design §3.2.3
 *   loading:    boolean         // shows shimmer overlay
 *   onRerunCell: (cell) => void // optional
 */
const FLIP_COLOR = '#dc2626';
const NOFLIP_COLOR = '#16a34a';
const INCONCLUSIVE_COLOR = '#9ca3af';
const PENDING_COLOR = '#ece8df';

const CELL_SIZE = 22;
const CELL_GAP = 2;
const PROFILE_GAP = 10;
const ROW_GAP = 4;
const ROW_LABEL_W = 220;
const COL_LABEL_H = 72;

// 4-char axis abbreviations to prevent label overlap inside narrow cell widths.
// Full canonical name is preserved via SVG <title> tooltip on hover.
const AXIS_ABBREV = {
  achievement: 'Achieve',
  self_direction: 'Self-dir',
  security: 'Security',
  benevolence: 'Benevolence',
};
const axisAbbrev = (aid) => AXIS_ABBREV[aid] || (typeof aid === 'string' ? aid.slice(0, 4) : aid);

function colorForCell(cell) {
  if (!cell) return PENDING_COLOR;
  if (cell.flipped === true) return FLIP_COLOR;
  if (cell.flipped === false) return NOFLIP_COLOR;
  return INCONCLUSIVE_COLOR;
}

function buildLookup(cells) {
  const map = new Map();
  for (const c of cells ?? []) {
    map.set(`${c.scenarioId}::${c.profileId}::${c.axisId}`, c);
  }
  return map;
}

export default function BoundaryHeatmap({
  scenarios,
  profiles,
  axes,
  cells,
  loading,
  onRerunCell,
}) {
  const [active, setActive] = useState(null);
  const cellMap = useMemo(() => buildLookup(cells), [cells]);

  if (!Array.isArray(scenarios) || scenarios.length === 0 || !Array.isArray(profiles) || !Array.isArray(axes) || !Array.isArray(cells) || cells.length === 0) {
    return <p className="dim-note" role="status">Boundary Map pending. No sensitivity contrasts are available yet.</p>;
  }

  const profileBlockWidth = axes.length * CELL_SIZE + (axes.length - 1) * CELL_GAP;
  const totalWidth =
    ROW_LABEL_W +
    profiles.length * profileBlockWidth +
    (profiles.length - 1) * PROFILE_GAP;
  const totalHeight = COL_LABEL_H + scenarios.length * (CELL_SIZE + ROW_GAP);

  const profileX = (pi) =>
    ROW_LABEL_W + pi * (profileBlockWidth + PROFILE_GAP);
  const cellX = (pi, ai) => profileX(pi) + ai * (CELL_SIZE + CELL_GAP);
  const rowY = (si) => COL_LABEL_H + si * (CELL_SIZE + ROW_GAP);

  // group dividers - find first row of each group change
  let lastGroup = null;
  const groupDividers = [];
  scenarios.forEach((s, i) => {
    if (s.group && s.group !== lastGroup) {
      if (lastGroup !== null) groupDividers.push(i);
      lastGroup = s.group;
    }
  });

  const profileLabel = (pid) => profiles.find((p) => p.id === pid)?.name ?? pid;
  const scenarioLabel = (sid) => scenarios.find((s) => s.id === sid)?.title ?? sid;
  const axisLabel = (aid) => axes.find((a) => a.id === aid)?.label ?? aid;

  return (
    <div className={`boundary-heatmap ${loading ? 'is-loading' : ''}`}>
      <svg
        viewBox={`0 0 ${totalWidth} ${totalHeight}`}
        role="img"
        aria-label="9-by-16 sensitivity heatmap. Red low-high endpoint contrast changed intervention, green no change, gray inconclusive."
        className="boundary-heatmap-svg"
      >
        {/* Profile column headers */}
        {profiles.map((p, pi) => (
          <g key={`pcol-${p.id}`}>
            <text
              x={profileX(pi) + profileBlockWidth / 2}
              y={20}
              textAnchor="middle"
              className="hm-profile-label"
            >
              {p.name}
            </text>
            {axes.map((a, ai) => {
              const cx = cellX(pi, ai) + CELL_SIZE / 2;
              const cy = 50;
              return (
                <text
                  key={`acol-${p.id}-${a.id}`}
                  x={cx}
                  y={cy}
                  textAnchor="middle"
                  className="hm-axis-label"
                  transform={`rotate(-30 ${cx} ${cy})`}
                >
                  <title>{a.label}</title>
                  {axisAbbrev(a.id)}
                </text>
              );
            })}
          </g>
        ))}

        {/* Scenario row labels */}
        {scenarios.map((s, si) => (
          <text
            key={`row-${s.id}`}
            x={ROW_LABEL_W - 12}
            y={rowY(si) + CELL_SIZE / 2 + 4}
            textAnchor="end"
            className="hm-row-label"
          >
            {s.title}
          </text>
        ))}

        {/* Group dividers */}
        {groupDividers.map((rowIdx) => (
          <line
            key={`gdiv-${rowIdx}`}
            x1={ROW_LABEL_W - 200}
            x2={totalWidth}
            y1={rowY(rowIdx) - ROW_GAP / 2}
            y2={rowY(rowIdx) - ROW_GAP / 2}
            stroke="#d8d2c8"
            strokeWidth="1"
            strokeDasharray="4 4"
          />
        ))}

        {/* Cells */}
        {scenarios.map((s, si) =>
          profiles.map((p, pi) =>
            axes.map((a, ai) => {
              const key = `${s.id}::${p.id}::${a.id}`;
              const cell = cellMap.get(key);
              const fill = colorForCell(cell);
              return (
                <rect
                  key={key}
                  x={cellX(pi, ai)}
                  y={rowY(si)}
                  width={CELL_SIZE}
                  height={CELL_SIZE}
                  rx={3}
                  fill={fill}
                  stroke="#fbf8f1"
                  strokeWidth="1"
                  className="hm-cell"
                  role="button"
                  tabIndex={0}
                  aria-label={`${s.title} · ${p.name} · ${a.label} · ${cell ? (cell.flipped === true ? 'flipped' : cell.flipped === false ? 'no flip' : 'inconclusive') : 'pending'}`}
                  onClick={() => cell ? setActive(cell) : null}
                  onKeyDown={(e) => {
                    if ((e.key === 'Enter' || e.key === ' ') && cell) {
                      e.preventDefault();
                      setActive(cell);
                    }
                  }}
                >
                  <title>
                    {`${s.title} · ${p.name} · ${a.label} · ${cell ? (cell.flipped === true ? 'flipped' : cell.flipped === false ? 'no-flip' : 'inconclusive') : 'pending'}`}
                  </title>
                </rect>
              );
            }),
          ),
        )}
      </svg>

      <div className="hm-legend" aria-label="Heatmap legend">
        <span><span className="hm-swatch" style={{ background: FLIP_COLOR }} /> endpoint flip</span>
        <span><span className="hm-swatch" style={{ background: NOFLIP_COLOR }} /> no endpoint flip</span>
        <span><span className="hm-swatch" style={{ background: INCONCLUSIVE_COLOR }} /> inconclusive</span>
        <span><span className="hm-swatch" style={{ background: PENDING_COLOR }} /> pending</span>
      </div>

      {active ? (
        <HeatmapCellModal
          cell={active}
          scenarioLabel={scenarioLabel(active.scenarioId)}
          profileLabel={profileLabel(active.profileId)}
          axisLabel={axisLabel(active.axisId)}
          onClose={() => setActive(null)}
          onRerun={onRerunCell ? () => onRerunCell(active) : undefined}
        />
      ) : null}
    </div>
  );
}
