import { ServiceError } from './errors.mjs';

function required(env, name, minimumLength = 1) {
  const value = String(env[name] || '').trim();
  if (value.length < minimumLength) throw new ServiceError(503, 'configuration_missing', `${name} is required.`);
  return value;
}

function integer(env, name, fallback, min, max) {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw new ServiceError(503, 'configuration_invalid', `${name} is invalid.`);
  return value;
}

export function loadConfig(env = process.env) {
  const mode = String(env.CANVAS_SERVICE_MODE || 'both').trim().toLowerCase();
  if (!['api', 'worker', 'both'].includes(mode)) throw new ServiceError(503, 'configuration_invalid', 'CANVAS_SERVICE_MODE must be api, worker, or both.');
  const manifestUrl = required(env, 'CANVAS_EVIDENCE_MANIFEST_URL');
  const parsedManifestUrl = new URL(manifestUrl);
  if (parsedManifestUrl.protocol !== 'https:' || parsedManifestUrl.username || parsedManifestUrl.password) {
    throw new ServiceError(503, 'configuration_invalid', 'CANVAS_EVIDENCE_MANIFEST_URL must use HTTPS.');
  }
  return Object.freeze({
    mode,
    host: String(env.HOST || '0.0.0.0'),
    port: integer(env, 'PORT', 8080, 1, 65_535),
    databaseUrl: required(env, 'CANVAS_DATABASE_URL'),
    serviceToken: required(env, 'CANVAS_ANALYSIS_SERVICE_TOKEN', 32),
    manifestUrl,
    manifestPublicKey: required(env, 'CANVAS_EVIDENCE_MANIFEST_PUBLIC_KEY', 32).replaceAll('\\n', '\n'),
    expectedKeyId: required(env, 'CANVAS_EVIDENCE_MANIFEST_KEY_ID'),
    evidenceBearerToken: String(env.CANVAS_EVIDENCE_BEARER_TOKEN || '').trim() || null,
    maxManifestBytes: integer(env, 'CANVAS_MAX_MANIFEST_BYTES', 64 * 1024 * 1024, 1_000_000, 256 * 1024 * 1024),
    manifestCacheTtlMs: integer(env, 'CANVAS_MANIFEST_CACHE_TTL_MS', 300_000, 1_000, 3_600_000),
    workerConcurrency: integer(env, 'CANVAS_WORKER_CONCURRENCY', 2, 1, 16),
    workerPollMs: integer(env, 'CANVAS_WORKER_POLL_MS', 1_000, 100, 60_000),
    workerLeaseMs: integer(env, 'CANVAS_WORKER_LEASE_MS', 120_000, 10_000, 900_000),
    databaseMaxConnections: integer(env, 'CANVAS_DATABASE_MAX_CONNECTIONS', 10, 1, 50),
  });
}
