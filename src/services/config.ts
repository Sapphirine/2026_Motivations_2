import type { Env, GenerationSettings } from '../domain/types';
import { problemError } from './problem';

export type AppConfig = {
  appEnv: string;
  allowedOrigins: string[];
  demoMode: boolean;
  openAIModel: string;
  openAIModelAllowlist: string[];
  runTimeoutSeconds: number;
  artifactMaxBytes: number;
  artifactRetentionDays: number;
  generationSettings: GenerationSettings;
};

const defaultModel = 'gpt-5.4-nano';

export function getConfig(env: Env): AppConfig {
  return {
    appEnv: env.APP_ENV ?? 'local',
    allowedOrigins: (env.ALLOWED_ORIGINS ?? 'http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean),
    demoMode: (env.DEMO_MODE ?? 'true') === 'true',
    openAIModel: env.OPENAI_MODEL ?? defaultModel,
    openAIModelAllowlist: (env.OPENAI_MODEL_ALLOWLIST ?? defaultModel).split(',').map((model) => model.trim()).filter(Boolean),
    runTimeoutSeconds: Number(env.RUN_TIMEOUT_SECONDS ?? 25),
    artifactMaxBytes: Number(env.ARTIFACT_MAX_BYTES ?? 500_000),
    artifactRetentionDays: Number(env.ARTIFACT_RETENTION_DAYS ?? 14),
    generationSettings: { temperature: 0.2, maxTokens: 2500 },
  };
}

export function assertLiveOpenAIConfig(env: Env, instance: string): void {
  const config = getConfig(env);
  if (config.demoMode) return;
  if (!env.OPENAI_API_KEY) {
    throw problemError(503, 'Provider unavailable', 'OPENAI_API_KEY is required when DEMO_MODE is false.', instance);
  }
  if (!config.openAIModelAllowlist.includes(config.openAIModel)) {
    throw problemError(400, 'Model not allowlisted', 'OPENAI_MODEL must be included in OPENAI_MODEL_ALLOWLIST.', instance);
  }
}
