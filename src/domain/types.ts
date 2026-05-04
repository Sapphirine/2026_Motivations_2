export type ScenarioKind = 'preset' | 'custom';
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'partial';
export type OutputStatus = 'completed' | 'failed' | 'retryable';
export type ProfileId = 'achievement' | 'exploration' | 'preservation' | 'neutral';
export type AxisId = 'achievement' | 'selfDirection' | 'security' | 'benevolence';
export type ValueLevel = 'high' | 'medium' | 'low';

export type DecisionOption = {
  id: string;
  label: string;
  description: string;
};

export type Scenario = {
  id: string;
  kind: ScenarioKind;
  title: string;
  domain: string;
  context: string;
  decisionOptions: DecisionOption[];
  stakeholders: string[];
  tradeoffs: string[];
  conflictNotes: string;
  disclaimer: string;
  version: number;
  createdAt: number;
  updatedAt: number;
};

export type AxisWeight = {
  axis: AxisId;
  label: string;
  level: ValueLevel;
  value: 0.8 | 0.5 | 0.2;
};

export type OppositionConstraint = {
  highAxis: AxisId;
  lowAxis: AxisId;
  reason: string;
};

export type ValueProfile = {
  id: ProfileId;
  name: string;
  description: string;
  axisWeights: AxisWeight[];
  oppositionConstraints: OppositionConstraint[];
  promptTranslation: string;
  isBaseline: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
};

export type GenerationSettings = {
  temperature: number;
  maxTokens: number;
  seed?: number;
};

export type StructuredDecision = {
  selectedOptionId: string;
  rankedOptions: string[];
  decisionSummary: string;
  interventionCard?: {
    diagnosedBlocker: string;
    motivationProfile: string;
    retrievedStrategy: string;
    microAction: string;
    ifThenPlan: string;
    accountabilityScript: string;
    successMetric: string;
  };
  rationale: string;
  tradeoffs: Array<{ dimension: string; assessment: string }>;
  driveAttributions: Array<{
    drive: AxisId;
    weight: number;
    influence: 'high' | 'medium' | 'low';
    evidence: string;
  }>;
  confidence: number | null;
  riskNotes: string[];
  policyCompliance?: PolicyComplianceCheck;
  notAdviceDisclaimer: true;
};

export type RiskContext = {
  domain: string;
  affectedStakeholders: string[];
  riskTypes: string[];
  deploymentStage: string;
  detectionSignals: string[];
};

export type PolicyGroundingChunk = {
  id: string;
  title: string;
  source: string;
  domain: string;
  riskTypes: string[];
  stakeholders: string[];
  deploymentStage: string;
  text: string;
  score: number | null;
};

export type PolicyGroundingResult = {
  enabled: boolean;
  mode: 'chroma' | 'fallback' | 'disabled';
  riskContext: RiskContext;
  chunks: PolicyGroundingChunk[];
  warning?: string;
};

export type PolicyComplianceCheck = {
  status: 'pass' | 'review' | 'unavailable';
  coveredRiskTypes: string[];
  missingRiskTypes: string[];
  evidence: string[];
};

export type AgentOutput = {
  id: string;
  runId: string;
  profileId: ProfileId;
  profileSnapshot: ValueProfile;
  translatedPrompt: string;
  rawOutput: string;
  structuredDecision: StructuredDecision;
  driveTrace: StructuredDecision['driveAttributions'];
  confidence: number | null;
  status: OutputStatus;
  error?: ProblemDetails;
  createdAt: number;
  // Three-Layer (added 2026-04-27, all optional until /three-layer-analysis runs).
  trialIndex?: number;
  judgeAxis?: 'achievement' | 'self_direction' | 'security' | 'benevolence' | 'unknown' | null;
  judgeConfidence?: number | null;
  judgeReasoning?: string | null;
  rationaleDrives?: Record<'achievement' | 'self_direction' | 'security' | 'benevolence', number> | null;
  rationaleTopAxis?: 'achievement' | 'self_direction' | 'security' | 'benevolence' | 'unknown' | null;
  rationaleResolution?: 'lexicon' | 'llm_fallback' | 'ambiguous' | null;
  alignmentPattern?: 'Aligned' | 'Rationalizing' | 'Drifting' | 'Contradictory' | null;
  threeLayerCompletedAt?: number | null;
};

/**
 * Layer 2 (FIX 3, 2026-04-27): qualitative LLM commentary on top of the
 * deterministic synthesis. Deterministic divergence/signature/flip metrics
 * remain the audit-quality numbers; this is purely interpretive and is
 * clearly labeled in the UI as "AI commentary, not measurement".
 */
export type ModeratorAICommentary = {
  mode: 'openai' | 'demo';
  headline: string;
  disagreementDriver: string;
  supportingEvidence: Array<{ profileId: string; evidence: string }>;
  openQuestions: string[];
};

export type ModeratorSynthesis = {
  id: string;
  runId: string;
  moderatorProvider: 'deterministic' | 'openai';
  moderatorModel: string;
  agreementSummary: string;
  disagreementSummary: string;
  substantiveDivergence: boolean;
  pathAttribution: Array<{ profileId: ProfileId; attribution: string; support: 'supported' | 'weak' | 'contradicted' | 'unclear' }>;
  rubricNotes: Record<string, unknown>;
  rawOutput: string;
  /**
   * Optional Layer 2 LLM commentary. `null` when the LLM call failed or no
   * key was available; the deterministic fields above remain authoritative.
   */
  aiCommentary?: ModeratorAICommentary | null;
  createdAt: number;
};

export type EvaluationMetric = {
  id: string;
  runId: string;
  metricType: 'divergence' | 'signature' | 'attribution' | 'sensitivity' | 'flip_rate';
  metricValue?: number;
  metricLabel?: string;
  method: string;
  rubricVersion: string;
  details: Record<string, unknown>;
  createdAt: number;
};

export type SensitivityRun = {
  id: string;
  baseRunId: string;
  profileId: ProfileId;
  axisChanges: Array<{ axis: AxisId; from: number; to: number }>;
  originalDecision: StructuredDecision;
  rerunDecision: StructuredDecision;
  flipped: boolean;
  nearFlip: boolean;
  status: 'queued' | 'running' | 'completed' | 'failed';
  createdAt: number;
  completedAt?: number;
};

export type ArtifactManifest = {
  runId: string;
  artifactVersion: number;
  provider: 'openai' | 'demo';
  model: string;
  generationSettings: GenerationSettings;
  createdAt: number;
  objects: Array<{ key: string; contentType: string; byteSize: number; sha256: string }>;
  redactionStatus: 'not_required' | 'redacted' | 'blocked';
  retentionDays: number;
};

export type ExperimentRun = {
  id: string;
  scenarioId: string;
  scenarioSnapshot: Scenario;
  profileIds: ProfileId[];
  modelProvider: 'openai';
  modelName: string;
  generationSettings: GenerationSettings;
  status: RunStatus;
  idempotencyKey?: string;
  artifactManifest?: ArtifactManifest;
  error?: ProblemDetails;
  outputs: AgentOutput[];
  synthesis?: ModeratorSynthesis;
  metrics: EvaluationMetric[];
  sensitivityRuns: SensitivityRun[];
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  // Three-Layer redesign (added 2026-04-27).
  trialCount?: number;
  batteryId?: string;
  policyGrounding?: PolicyGroundingResult;
};

export type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  errors?: Array<{ path: Array<string | number>; message: string }>;
};

// ===== Three-Layer + Sensitivity Grid (added 2026-04-27) =====

/**
 * Judge axis IDs use snake_case to match the L2/L3 lexicon spec, even
 * though the legacy `AxisId` type uses camelCase (`selfDirection`). The
 * two coexist: AxisId is the on-the-wire profile-snapshot key, JudgeAxisId
 * is the on-the-wire three-layer-analysis key. Bridging happens in
 * src/judges/value-judge.ts and src/analysis/alignment-pattern.ts.
 */
export type JudgeAxisId = 'achievement' | 'self_direction' | 'security' | 'benevolence';

export type AlignmentPattern = 'Aligned' | 'Rationalizing' | 'Drifting' | 'Contradictory';

export type SensitivityGridStatus = 'pending' | 'running' | 'completed' | 'partial' | 'failed';

export type SensitivityGridCell = {
  scenarioId: string;
  profileId: ProfileId;
  axisId: JudgeAxisId;
  contrastMode?: 'low_high';
  lowOption?: string | null;
  highOption?: string | null;
  lowRationaleExcerpt?: string;
  highRationaleExcerpt?: string;
  lowCellRunId?: string;
  highCellRunId?: string;
  baselineOption: string | null;
  baselineStability: number;
  perturbedOption: string | null;
  flipped: boolean | null;
  perturbedRationaleExcerpt: string;
  cellRunId: string;
  completedAt: number;
};

export type SensitivityGridCellError = {
  scenarioId: string;
  profileId: ProfileId;
  axisId: string;
  errorType: 'openai' | 'parse' | 'baseline_unstable' | 'timeout';
  message: string;
  attempts: number;
  loggedAt: number;
};

export type SensitivityGridJob = {
  id: string;
  batteryId?: string;
  status: SensitivityGridStatus;
  totalCells: number;
  completedCells: number;
  failedCells: number;
  errorBudget: number;
  scenarioIds: string[];
  profileIds: ProfileId[];
  axisIds: JudgeAxisId[];
  results: SensitivityGridCell[];
  errors: SensitivityGridCellError[];
  idempotencyKey?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};

export type SameProfileBaselineRun = {
  id: string;
  batteryId?: string;
  scenarioId: string;
  profileId: ProfileId;
  trial: number;
  selectedOption: string;
  rawOutput: string;
  rationale: string;
  createdAt: number;
};

export type ThreeLayerPerAgent = {
  agentOutputId: string;
  profileId: ProfileId;
  trialIndex: number;
  L1: { top2: [JudgeAxisId, JudgeAxisId] };
  L2: { primaryAxis: JudgeAxisId | 'unknown'; confidence: number; reasoning: string };
  L3: {
    topAxis: JudgeAxisId | 'unknown';
    drives: Record<JudgeAxisId, number>;
    resolution: 'lexicon' | 'llm_fallback' | 'ambiguous';
  };
  alignment: AlignmentPattern;
};

export type ThreeLayerAnalysisResult = {
  runId: string;
  perAgent: ThreeLayerPerAgent[];
};

export type Env = {
  DB?: D1Database;
  ARTIFACTS?: R2Bucket;
  CACHE?: KVNamespace;
  ASSETS?: Fetcher;
  APP_ENV?: string;
  ALLOWED_ORIGINS?: string;
  LLM_PROVIDER_DEFAULT?: string;
  OPENAI_MODEL?: string;
  OPENAI_MODEL_ALLOWLIST?: string;
  OPENAI_API_KEY?: string;
  RUN_TIMEOUT_SECONDS?: string;
  RUN_RATE_LIMIT?: string;
  RUN_RATE_LIMIT_WINDOW_SECONDS?: string;
  ARTIFACT_MAX_BYTES?: string;
  ARTIFACT_RETENTION_DAYS?: string;
  DEMO_MODE?: string;
  POLICY_RAG_ENABLED?: string;
  POLICY_RAG_ORIGIN?: string;
};
