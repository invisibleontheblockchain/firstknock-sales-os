import { CanvasAnalysisService } from './analysis-service.mjs';
import { loadConfig } from './config.mjs';
import { EvidenceRepository } from './evidence.mjs';
import { createAnalysisHttpServer, createHealthHttpServer, listen } from './http-server.mjs';
import { PostgresStore } from './store.mjs';
import { WorkerRunner } from './worker-runner.mjs';

const config = loadConfig();
const store = new PostgresStore(config.databaseUrl, { maxConnections: config.databaseMaxConnections });
await store.migrate();
const evidenceRepository = new EvidenceRepository({
  manifestUrl: config.manifestUrl,
  manifestPublicKey: config.manifestPublicKey,
  expectedKeyId: config.expectedKeyId,
  evidenceBearerToken: config.evidenceBearerToken,
  maxManifestBytes: config.maxManifestBytes,
  cacheTtlMs: config.manifestCacheTtlMs,
});
const service = new CanvasAnalysisService({ store, evidenceRepository });
let server = null;
let runner = null;

if (['api', 'both'].includes(config.mode)) {
  server = createAnalysisHttpServer({ service, serviceToken: config.serviceToken, store });
  await listen(server, config);
  console.log(`[canvas-analysis-service] listening on ${config.host}:${config.port}`);
} else {
  server = createHealthHttpServer({ store });
  await listen(server, config);
  console.log(`[canvas-analysis-service] worker health endpoint listening on ${config.host}:${config.port}`);
}
if (['worker', 'both'].includes(config.mode)) {
  runner = new WorkerRunner({
    service,
    concurrency: config.workerConcurrency,
    pollMs: config.workerPollMs,
    leaseMs: config.workerLeaseMs,
  });
  runner.start();
  console.log(`[canvas-analysis-service] ${config.workerConcurrency} worker loop(s) started`);
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[canvas-analysis-service] shutting down after ${signal}`);
  if (server) await new Promise((resolve) => server.close(resolve));
  if (runner) await runner.stop();
  await store.close();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal).then(() => process.exit(0), () => process.exit(1)));
}
