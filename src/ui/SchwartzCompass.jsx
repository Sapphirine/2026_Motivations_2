import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * MotivationCompass - 4-axis SVG radar with draggable handles (desktop) and
 * tap-to-set tier targets (mobile / coarse pointer).
 *
 * Axes (positions per 02-design §7.2):
 *   achievement      -> top         (200,  40)
 *   self_direction   -> right       (360, 200)
 *   security         -> bottom-right(317, 317)
 *   benevolence      -> bottom-left ( 83, 317)
 *
 * Constraint: opposing axes are auto-balanced on commit. When an axis goes
 * >= 0.6, its opposite is clamped to <= 0.4. (Achievement vs Benevolence,
 * Self-Direction vs Security.)
 *
 * Auto-detect: after each commit, the nearest preset within Euclidean
 * distance 0.05 in 4-D weight space is surfaced as "Near <Preset>".
 *
 * Props:
 *   weights:           { achievement, self_direction, security, benevolence }
 *   onChange:          (next) => void   // called on every drag update
 *   onCommit:          (next) => void   // called on pointer up / tap commit
 *   presets:           Array<{ id, name, weights }>
 */
const AXES = [
  { id: 'achievement',    label: 'Achievement',    angle: -Math.PI / 2 },
  { id: 'self_direction', label: 'Self-Direction', angle: 0 },
  { id: 'security',       label: 'Security',       angle: Math.PI / 4 },
  { id: 'benevolence',    label: 'Benevolence',    angle: Math.PI - Math.PI / 4 },
];

const CENTER = 200;
const RADIUS = 160;
const TAP_TIERS = [0.2, 0.35, 0.5, 0.65, 0.8];
const OPPOSITES = {
  achievement: 'benevolence',
  benevolence: 'achievement',
  self_direction: 'security',
  security: 'self_direction',
};

function pointForWeight(angle, weight) {
  return {
    x: CENTER + Math.cos(angle) * RADIUS * weight,
    y: CENTER + Math.sin(angle) * RADIUS * weight,
  };
}

function clamp01(v) {
  if (Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function projectToAxis(angle, mouseX, mouseY) {
  // Vector from center to mouse projected onto axis unit vector.
  const dx = mouseX - CENTER;
  const dy = mouseY - CENTER;
  const t = (dx * Math.cos(angle) + dy * Math.sin(angle)) / RADIUS;
  return clamp01(t);
}

function detectCoarsePointer() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

function nearestPreset(weights, presets) {
  let best = null;
  let bestDist = Infinity;
  for (const preset of presets) {
    let sumSq = 0;
    for (const a of AXES) {
      const d = (weights[a.id] ?? 0.5) - (preset.weights[a.id] ?? 0.5);
      sumSq += d * d;
    }
    const dist = Math.sqrt(sumSq);
    if (dist < bestDist) {
      bestDist = dist;
      best = preset;
    }
  }
  if (best && bestDist < 0.05) return { preset: best, distance: bestDist };
  return null;
}

function applyOpposingClamp(weights, changedAxis) {
  const opposite = OPPOSITES[changedAxis];
  if (!opposite) return weights;
  const value = weights[changedAxis];
  if (value < 0.6) return weights;
  // Auto-clamp the opposing axis to 0.4 or less only if it currently exceeds.
  if ((weights[opposite] ?? 0) <= 0.4) return weights;
  return { ...weights, [opposite]: 0.4 };
}

export default function SchwartzCompass({ weights, onChange, onCommit, presets }) {
  const svgRef = useRef(null);
  const draggingRef = useRef(null);
  const [coarse, setCoarse] = useState(detectCoarsePointer);
  const [flashAxis, setFlashAxis] = useState(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(pointer: coarse)');
    const handler = () => setCoarse(mq.matches);
    if (mq.addEventListener) mq.addEventListener('change', handler);
    else if (mq.addListener) mq.addListener(handler);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', handler);
      else if (mq.removeListener) mq.removeListener(handler);
    };
  }, []);

  const presetMatch = useMemo(() => nearestPreset(weights, presets ?? []), [weights, presets]);

  const localCoords = useCallback((event) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    // Map into viewBox 400x400.
    return {
      x: (px / rect.width) * 400,
      y: (py / rect.height) * 400,
    };
  }, []);

  const commitWithClamp = useCallback((axisId, raw) => {
    const next = applyOpposingClamp({ ...weights, [axisId]: raw }, axisId);
    if (next[OPPOSITES[axisId]] !== weights[OPPOSITES[axisId]]) {
      setFlashAxis(OPPOSITES[axisId]);
      setTimeout(() => setFlashAxis(null), 350);
    }
    if (typeof onCommit === 'function') onCommit(next);
    else if (typeof onChange === 'function') onChange(next);
  }, [weights, onChange, onCommit]);

  const onPointerDown = useCallback((axis, event) => {
    if (coarse) return; // mobile uses tap targets
    event.preventDefault();
    event.target.setPointerCapture?.(event.pointerId);
    draggingRef.current = axis;
    const { x, y } = localCoords(event);
    const t = projectToAxis(axis.angle, x, y);
    if (typeof onChange === 'function') onChange({ ...weights, [axis.id]: t });
  }, [coarse, weights, onChange, localCoords]);

  const onPointerMove = useCallback((event) => {
    const axis = draggingRef.current;
    if (!axis) return;
    const { x, y } = localCoords(event);
    const t = projectToAxis(axis.angle, x, y);
    if (typeof onChange === 'function') onChange({ ...weights, [axis.id]: t });
  }, [weights, onChange, localCoords]);

  const onPointerUp = useCallback((event) => {
    const axis = draggingRef.current;
    if (!axis) return;
    const { x, y } = localCoords(event);
    const t = projectToAxis(axis.angle, x, y);
    draggingRef.current = null;
    commitWithClamp(axis.id, t);
  }, [commitWithClamp, localCoords]);

  const onTierTap = useCallback((axisId, tier) => {
    commitWithClamp(axisId, tier);
  }, [commitWithClamp]);

  return (
    <div className="schwartz-compass">
      <svg
        ref={svgRef}
        viewBox="0 0 400 400"
        role="img"
        aria-label="Motivation compass - drag a handle to set an axis weight"
        className="schwartz-compass-svg"
        onPointerMove={coarse ? undefined : onPointerMove}
        onPointerUp={coarse ? undefined : onPointerUp}
        onPointerCancel={coarse ? undefined : onPointerUp}
      >
        {/* Concentric guide rings */}
        {[0.25, 0.5, 0.75, 1].map((t) => (
          <circle
            key={t}
            cx={CENTER}
            cy={CENTER}
            r={RADIUS * t}
            fill="none"
            stroke="#d8d2c8"
            strokeDasharray={t === 1 ? '0' : '3 3'}
            strokeWidth={t === 1 ? 1.4 : 1}
          />
        ))}
        {/* Axis lines */}
        {AXES.map((axis) => {
          const tip = pointForWeight(axis.angle, 1);
          return (
            <line
              key={`line-${axis.id}`}
              x1={CENTER}
              y1={CENTER}
              x2={tip.x}
              y2={tip.y}
              stroke="#c4bdb1"
              strokeWidth="1.2"
            />
          );
        })}
        {/* Filled polygon for current weights */}
        <polygon
          points={AXES.map((a) => {
            const p = pointForWeight(a.angle, weights[a.id] ?? 0.5);
            return `${p.x},${p.y}`;
          }).join(' ')}
          fill="rgba(91, 92, 226, 0.18)"
          stroke="#5b5ce2"
          strokeWidth="1.6"
        />
        {/* Mobile tier targets */}
        {coarse
          ? AXES.flatMap((axis) =>
              TAP_TIERS.map((tier) => {
                const p = pointForWeight(axis.angle, tier);
                const active = Math.abs((weights[axis.id] ?? 0.5) - tier) < 0.04;
                return (
                  <circle
                    key={`tier-${axis.id}-${tier}`}
                    cx={p.x}
                    cy={p.y}
                    r={active ? 12 : 9}
                    className={`compass-tier ${active ? 'is-active' : ''}`}
                    onClick={() => onTierTap(axis.id, tier)}
                    role="button"
                    aria-label={`${axis.label} weight ${tier}`}
                  />
                );
              }),
            )
          : null}
        {/* Desktop draggable handles */}
        {!coarse
          ? AXES.map((axis) => {
              const handle = pointForWeight(axis.angle, weights[axis.id] ?? 0.5);
              const isFlash = flashAxis === axis.id;
              return (
                <circle
                  key={`handle-${axis.id}`}
                  cx={handle.x}
                  cy={handle.y}
                  r={11}
                  className={`compass-handle ${isFlash ? 'is-flash' : ''}`}
                  onPointerDown={(e) => onPointerDown(axis, e)}
                  role="slider"
                  aria-label={`${axis.label} weight`}
                  aria-valuemin={0}
                  aria-valuemax={1}
                  aria-valuenow={weights[axis.id] ?? 0.5}
                  tabIndex={0}
                />
              );
            })
          : null}
        {/* Axis labels */}
        {AXES.map((axis) => {
          const tip = pointForWeight(axis.angle, 1.18);
          return (
            <text
              key={`lbl-${axis.id}`}
              x={tip.x}
              y={tip.y}
              textAnchor="middle"
              dominantBaseline="middle"
              className="compass-label"
            >
              {axis.label}
            </text>
          );
        })}
      </svg>
      <div className="compass-readout">
        {AXES.map((axis) => (
          <span key={`r-${axis.id}`} className={`compass-readout-cell ${flashAxis === axis.id ? 'is-flash' : ''}`}>
            <span className="eyebrow">{axis.label}</span>
            <strong>{(weights[axis.id] ?? 0.5).toFixed(2)}</strong>
          </span>
        ))}
      </div>
      <p className="compass-preset-line">
        {presetMatch
          ? <>Near <strong>{presetMatch.preset.name}</strong> preset (distance {presetMatch.distance.toFixed(2)})</>
          : <span className="dim-note">Custom profile (no preset within 0.05)</span>}
      </p>
    </div>
  );
}
