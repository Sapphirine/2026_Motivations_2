import { z } from 'zod';

export const decisionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
});

export const customScenarioSchema = z.object({
  title: z.string().min(3),
  domain: z.string().min(2),
  context: z.string().min(20),
  decisionOptions: z.array(decisionOptionSchema).min(3).max(5),
  stakeholders: z.array(z.string().min(1)).min(1),
  tradeoffs: z.array(z.string().min(1)).min(1),
  conflictNotes: z.string().min(5),
});

/**
 * Three-Layer redesign (2026-04-27): trialCount field added (default 5,
 * range 1-10). All trials within a (scenario, profile) cell use identical
 * model + settings + snapshots; only random seed differs.
 */
export const runExperimentSchema = z.object({
  scenarioId: z.string().min(1),
  profileIds: z.array(z.enum(['achievement', 'exploration', 'preservation', 'neutral'])).min(1).max(4).default(['achievement', 'exploration', 'preservation', 'neutral']),
  modelProvider: z.literal('openai').default('openai'),
  modelName: z.string().min(1).optional(),
  generationSettings: z.object({
    temperature: z.number().min(0).max(2),
    maxTokens: z.number().int().min(128).max(4096),
    seed: z.number().int().optional(),
  }).optional(),
  trialCount: z.number().int().min(1).max(10).default(5),
  idempotencyKey: z.string().min(8).max(200).optional(),
  batteryId: z.string().min(1).max(200).optional(),
});

export const sensitivitySchema = z.object({
  profileId: z.enum(['achievement', 'exploration', 'preservation', 'neutral']),
  axisChanges: z.array(z.object({
    axis: z.enum(['achievement', 'selfDirection', 'security', 'benevolence']),
    from: z.number().min(0).max(1),
    to: z.number().min(0).max(1),
  })).min(1),
  rerunMode: z.literal('selected-profile-only').default('selected-profile-only'),
});

export const questionSchema = z.object({
  scenarioId: z.string().min(1),
  profileId: z.enum(['achievement', 'exploration', 'preservation', 'neutral']).default('neutral'),
  question: z.string().min(3).max(1000),
});

/**
 * Three-Layer analysis input (per 02-design.md §5.2).
 * `force: true` re-runs the L2/L3 LLM calls; default returns cached.
 */
export const threeLayerSchema = z.object({
  force: z.boolean().default(false),
});

/**
 * Sensitivity grid input (per 02-design.md §5.3). All arrays optional —
 * defaults are filled in by sensitivity-grid.ts (9 scenarios, 4 profiles,
 * 4 axes = 144 cells).
 */
export const sensitivityGridSchema = z.object({
  scenarioIds: z.array(z.string().min(1)).min(1).max(20).optional(),
  profileIds: z.array(z.enum(['achievement', 'exploration', 'preservation', 'neutral'])).min(1).max(4).optional(),
  axisIds: z.array(z.enum(['achievement', 'self_direction', 'security', 'benevolence'])).min(1).max(4).optional(),
  batteryId: z.string().min(1).max(200).optional(),
  idempotencyKey: z.string().min(4).max(200),
  errorBudget: z.number().int().min(1).max(144).default(10),
});

export const sensitivityGridRetryFailedSchema = z.object({
  mode: z.literal('failed'),
  includeIncomplete: z.boolean().optional(),
  cells: z.array(z.object({
    scenarioId: z.string().min(1),
    profileId: z.enum(['achievement', 'exploration', 'preservation', 'neutral']),
    axisId: z.enum(['achievement', 'self_direction', 'security', 'benevolence']),
  })).min(1).max(144).optional(),
});

/**
 * Canonical battery (umbrella) input (per 02-design.md §5.7).
 */
export const canonicalBatterySchema = z.object({
  idempotencyKey: z.string().min(4).max(200),
});

/**
 * Per-profile retry input (per 01-spec §12.2 F-12.2.4).
 *
 * `POST /api/experiments/:runId/retry-profile` re-runs a single agent within
 * an existing terminal run when the original parallel fan-out timed out
 * before the profile produced any outputs. `trialCount` defaults to the
 * run's original trial count (resolved server-side); when omitted from the
 * payload the worker substitutes `run.trialCount`.
 */
export const retryProfileSchema = z.object({
  profileId: z.enum(['achievement', 'exploration', 'preservation', 'neutral']),
  trialCount: z.number().int().min(1).max(10).optional(),
});
