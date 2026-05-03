import type { ArtifactManifest, Env, ExperimentRun } from '../domain/types';
import { getConfig } from './config';
import { nowSeconds } from './storage';

/**
 * Write the canonical run artifacts to R2.
 *
 * Atomicity (C3 fix):
 * R2 has no native multi-object transaction. We previously did two sequential
 * `put`s (export.json then manifest.json). If the second failed, the first
 * was orphaned and `GET /api/artifacts/:runId` permanently 404'd because the
 * manifest was missing while the body still existed.
 *
 * Strategy: write the larger object (export.json) FIRST. If the body write
 * succeeds and the manifest write fails, attempt to roll back by deleting the
 * orphaned body before rethrowing. The artifact endpoint already requires the
 * manifest to be present before serving the body, so the only failure mode we
 * need to prevent is "body exists, manifest doesn't" — rollback handles it.
 *
 * Why option (b) over (c): a `manifestComplete: false` flag would require all
 * readers to interpret it. Single rollback path is simpler and the manifest
 * endpoint already gates on manifest presence.
 */
export async function writeRunArtifacts(env: Env, run: ExperimentRun): Promise<ArtifactManifest> {
  const config = getConfig(env);
  const baseKey = `runs/${run.id}/v1`;
  const exportJson = JSON.stringify(run, null, 2);
  const exportBytes = new TextEncoder().encode(exportJson);
  const exportObject = {
    key: `${baseKey}/export.json`,
    contentType: 'application/json',
    byteSize: exportBytes.byteLength,
    sha256: await sha256(exportJson),
  };
  const manifest: ArtifactManifest = {
    runId: run.id,
    artifactVersion: 1,
    provider: config.demoMode ? 'demo' : 'openai',
    model: run.modelName,
    generationSettings: run.generationSettings,
    createdAt: nowSeconds(),
    objects: [exportObject],
    redactionStatus: 'not_required',
    retentionDays: config.artifactRetentionDays,
  };
  const manifestJson = JSON.stringify(manifest, null, 2);
  const manifestKey = `${baseKey}/manifest.json`;

  if (env.ARTIFACTS && exportBytes.byteLength <= config.artifactMaxBytes) {
    let exportWritten = false;
    try {
      await env.ARTIFACTS.put(exportObject.key, exportJson, { httpMetadata: { contentType: exportObject.contentType } });
      exportWritten = true;
      await env.ARTIFACTS.put(manifestKey, manifestJson, { httpMetadata: { contentType: 'application/json' } });
    } catch (error) {
      // Rollback: if export was written but manifest failed, remove the
      // orphan so the artifact endpoint sees a clean "no manifest, no body"
      // state instead of "body but no manifest" (which would 404 forever).
      if (exportWritten) {
        try {
          await env.ARTIFACTS.delete(exportObject.key);
        } catch (deleteError) {
          // Best-effort cleanup. Log and rethrow original.
          console.error('[artifacts] orphan rollback failed for', exportObject.key, deleteError instanceof Error ? deleteError.message : deleteError);
        }
      }
      throw error;
    }
  }

  return manifest;
}

/**
 * Read a previously-written manifest for a run. Used by the
 * Worker-mediated GET /api/artifacts/:runId endpoint to avoid exposing
 * the R2 bucket publicly.
 */
export async function readRunManifest(env: Env, run: ExperimentRun): Promise<ArtifactManifest | null> {
  // Prefer the in-memory snapshot if the current process already wrote it.
  if (run.artifactManifest) return run.artifactManifest;
  if (!env.ARTIFACTS) return null;
  const manifestKey = `runs/${run.id}/v1/manifest.json`;
  const object = await env.ARTIFACTS.get(manifestKey);
  if (!object) return null;
  const text = await object.text();
  try {
    return JSON.parse(text) as ArtifactManifest;
  } catch {
    return null;
  }
}

/**
 * Stream the canonical export.json for a run from R2. The bucket itself
 * stays private — this Worker-mediated handler is the only egress path.
 * Returns null if the object is missing or the binding is absent.
 *
 * Takes an `ExperimentRun` (server-source-of-truth) so we use `run.id`
 * directly and never interpolate untrusted URL-path input into the R2 key.
 */
export async function readRunExport(env: Env, run: ExperimentRun): Promise<R2ObjectBody | null> {
  if (!env.ARTIFACTS) return null;
  const exportKey = `runs/${run.id}/v1/export.json`;
  return env.ARTIFACTS.get(exportKey);
}

/**
 * Returns true when the manifest's createdAt + retentionDays is in the past.
 * Caller should refuse to serve expired artifacts even if the R2 object
 * still exists (lifecycle rules may not have purged yet).
 */
export function isArtifactExpired(manifest: ArtifactManifest, nowEpochSeconds: number = nowSeconds()): boolean {
  const expirySeconds = manifest.createdAt + manifest.retentionDays * 86_400;
  return nowEpochSeconds > expirySeconds;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
