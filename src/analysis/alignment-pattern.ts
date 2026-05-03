/**
 * Three-Layer alignment classifier (pure deterministic function).
 *
 * Per 01-spec.md §7.4, given:
 *   L1 — top-2 axes from the declared profile (highest weight first).
 *   L2 — primary axis the SELECTED OPTION expresses (judge LLM).
 *   L3 — primary axis the rationale TEXT invokes (lexicon + LLM fallback).
 *
 * we map the (declared_choice, choice_rationale) pair onto one of four patterns.
 *
 *   declared_choice  := L2 ∈ L1.top2
 *   choice_rationale := L2 === L3
 *
 *   Aligned       (✓):  declared_choice  &&  choice_rationale
 *   Rationalizing (⚠):  !declared_choice &&  choice_rationale
 *   Drifting      (⚠):  declared_choice  && !choice_rationale
 *   Contradictory (⚡): !declared_choice && !choice_rationale
 *
 * The function is unit-testable; the 16-row truth table (4 axis values for
 * each of L1.top, L1.second, L2, L3 tightened to the relevant set) collapses
 * to four distinct outputs.
 */

import type { JudgeAxisId } from '../judges/value-judge';

export type AlignmentPattern = 'Aligned' | 'Rationalizing' | 'Drifting' | 'Contradictory';

export type L1Top2 = readonly [JudgeAxisId, JudgeAxisId];

/**
 * Classify the alignment pattern for one (L1, L2, L3) reading.
 *
 * The function does not panic on equal axes in L1.top2 — if both entries
 * are the same axis, the membership check still works. Defensive against
 * upstream tie-break bugs.
 */
export function classifyAlignment(
  L1Top2: L1Top2,
  L2: JudgeAxisId,
  L3: JudgeAxisId,
): AlignmentPattern {
  const declaredChoice = L2 === L1Top2[0] || L2 === L1Top2[1];
  const choiceRationale = L2 === L3;
  if (declaredChoice && choiceRationale) return 'Aligned';
  if (!declaredChoice && choiceRationale) return 'Rationalizing';
  if (declaredChoice && !choiceRationale) return 'Drifting';
  return 'Contradictory';
}

/**
 * Tie-break for L1 top-2 derivation (per 01-spec §7.1):
 * sort by weight desc; ties broken by stable axis order
 *   achievement > self_direction > security > benevolence
 */
const AXIS_TIEBREAK_ORDER: readonly JudgeAxisId[] = [
  'achievement',
  'self_direction',
  'security',
  'benevolence',
];

export function deriveL1Top2(weights: Record<JudgeAxisId, number>): L1Top2 {
  const ranked = AXIS_TIEBREAK_ORDER.slice().sort((a, b) => {
    const delta = weights[b] - weights[a];
    if (delta !== 0) return delta;
    return AXIS_TIEBREAK_ORDER.indexOf(a) - AXIS_TIEBREAK_ORDER.indexOf(b);
  });
  return [ranked[0], ranked[1]] as const;
}
