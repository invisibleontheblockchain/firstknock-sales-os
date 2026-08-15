import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildSnapshot, CanvasAnalysisService } from '../src/analysis-service.mjs';
import { canonicalStringify, sha256Hex } from '../src/canonical.mjs';
import { EvidenceRepository } from '../src/evidence.mjs';
import { createAnalysisHttpServer, listen } from '../src/http-server.mjs';
import { MemoryStore } from '../src/store.mjs';
import { FIXTURE_KEY_ID, FIXTURE_PUBLIC_KEY, makeEvidenceFixture } from './fixture.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const serviceDirectory = resolve(testDirectory, '..');
const SERVICE_TOKEN = 'fixture-service-token-at-least-32-bytes';
const FIXED_TIME = '2026-08-14T13:00:00.000Z';

const boundary = [
  { lat: 33.4498, lng: -112.0792 },
  { lat: 33.4498, lng: -112.0786 },
  { lat: 33.4504, lng: -112.0786 },
  { lat: 33.4504, lng: -112.0792 },
];

function areaSqMi(points) {
  const averageLat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
  const latScale = 69;
  const lngScale = 69 * Math.cos(averageLat * Math.PI / 180);
  const origin = points[0];
  const projected = points.map((point) => ({ x: (point.lng - origin.lng) * lngScale, y: (point.lat - origin.lat) * latScale }));
  let sum = 0;
  for (let index = 0; index < projected.length; index += 1) {
    const next = projected[(index + 1) % projected.length];
    sum += projected[index].x * next.y - next.x * projected[index].y;
  }
  return Math.abs(sum) / 2;
}

function startBody(areaCount = 2, retryFailedJob = false) {
  const managerId = 'manager_1';
  const requestHash = sha256Hex(canonicalStringify({
    purpose: 'firstknock-canvas-analysis-v1', manager_id: managerId, polygon: boundary, area_count: areaCount,
  }));
  return {
    job_id: `canvas_analysis_job_${requestHash}`,
    request_hash: requestHash,
    manager_id: managerId,
    polygon: boundary,
    area_count: areaCount,
    area_sq_mi: Number(areaSqMi(boundary).toFixed(6)),
    retry_failed_job: retryFailedJob,
  };
}

function manifestFetch(fixture, calls) {
  return async (input, options = {}) => {
    const url = String(input);
    calls.push({ url, options });
    if (url === fixture.manifestUrl) return new Response(fixture.manifestBytes, { status: 200 });
    if (url === fixture.tileUrl) return new Response(fixture.tileBytes, { status: 200 });
    return new Response('missing', { status: 404 });
  };
}

async function request(baseUrl, path, { method = 'GET', body, managerId, jobId, authenticated = true } = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      ...(authenticated ? { authorization: `Bearer ${SERVICE_TOKEN}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(managerId ? { 'x-firstknock-manager-id': managerId } : {}),
      ...(jobId ? { 'x-firstknock-job-id': jobId } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { response, result: await response.json() };
}

function snapshotIdentity(snapshot) {
  return {
    purpose: 'firstknock-canvas-analysis-snapshot-v1',
    schema_version: snapshot.schema_version,
    manager_id: snapshot.manager_id,
    created_by_user_id: snapshot.created_by_user_id,
    created_at: snapshot.created_at,
    provider: snapshot.provider,
    release_id: snapshot.release_id,
    manifest_hash: snapshot.manifest_hash,
    source_versions: snapshot.source_versions,
    compiler_version: snapshot.compiler_version,
    classifier_version: snapshot.classifier_version,
    polygon: snapshot.polygon,
    tile_ids: snapshot.tile_ids,
    result_hash: snapshot.result_hash,
    result_bytes: snapshot.result_bytes,
    summary: snapshot.summary,
    source_attribution: snapshot.source_attribution,
    production_trusted: snapshot.production_trusted,
  };
}

test('fixture HTTP API and worker complete the signed evidence lifecycle end to end', async (context) => {
  const fixture = makeEvidenceFixture();
  const evidenceCalls = [];
  const store = new MemoryStore();
  const evidence = new EvidenceRepository({
    manifestUrl: fixture.manifestUrl,
    manifestPublicKey: FIXTURE_PUBLIC_KEY,
    expectedKeyId: FIXTURE_KEY_ID,
    fetchImpl: manifestFetch(fixture, evidenceCalls),
  });
  const service = new CanvasAnalysisService({ store, evidenceRepository: evidence, clock: () => new Date(FIXED_TIME) });
  const server = createAnalysisHttpServer({ service, serviceToken: SERVICE_TOKEN, store });
  await listen(server, { host: '127.0.0.1', port: 0 });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const health = await request(baseUrl, '/healthz', { authenticated: false });
  assert.equal(health.response.status, 200);
  const unauthorized = await request(baseUrl, '/v1/canvas/analyses', { method: 'POST', body: startBody(), authenticated: false });
  assert.equal(unauthorized.response.status, 401);

  const body = startBody();
  const started = await request(baseUrl, '/v1/canvas/analyses', { method: 'POST', body });
  assert.equal(started.response.status, 200);
  assert.equal(started.result.job.status, 'queued');
  assert.equal(started.result.job.release_id, fixture.ids.release);
  assert.deepEqual(started.result.job.tile_ids, [fixture.ids.tile]);
  const repeated = await request(baseUrl, '/v1/canvas/analyses', { method: 'POST', body });
  assert.equal(repeated.result.job.job_id, started.result.job.job_id);
  assert.equal(evidenceCalls.filter((call) => call.url === fixture.manifestUrl).length, 1, 'idempotent enqueue avoids a second manifest download');

  const workerResult = await service.processNextJob('fixture-worker', 60_000);
  assert.equal(workerResult.job.status, 'complete');
  const workerId = started.result.job.worker_job_id;
  const wrongTenant = await request(baseUrl, `/v1/canvas/analyses/${workerId}/status`, {
    managerId: 'manager_2', jobId: body.job_id,
  });
  assert.equal(wrongTenant.response.status, 404);
  const status = await request(baseUrl, `/v1/canvas/analyses/${workerId}/status`, {
    managerId: body.manager_id, jobId: body.job_id,
  });
  assert.equal(status.result.job.status, 'complete');
  assert.equal(status.result.job.progress_pct, 100);

  const result = await request(baseUrl, `/v1/canvas/analyses/${workerId}/result`, {
    managerId: body.manager_id, jobId: body.job_id,
  });
  assert.equal(result.response.status, 200);
  const snapshot = result.result.job.evidence;
  assert.equal(snapshot.created_at, FIXED_TIME);
  assert.equal(snapshot.analysis_result.classified_street_units.length, 2, 'protected cul-de-sac expands atomically');
  assert.deepEqual(snapshot.analysis_result.external_neighbor_ids, [fixture.ids.external]);
  assert.ok(snapshot.analysis_result.classified_street_units.every((unit) => unit.canvas_role === 'knock'));
  const resultJson = canonicalStringify(snapshot.analysis_result);
  assert.equal(snapshot.result_bytes, Buffer.byteLength(resultJson));
  assert.equal(snapshot.result_hash, sha256Hex(resultJson));
  assert.equal(snapshot.snapshot_hash, sha256Hex(canonicalStringify(snapshotIdentity(snapshot))));
  assert.equal(snapshot.evidence_id, `canvas_evidence_${snapshot.snapshot_hash}`);
  assert.equal(JSON.stringify(result.result).includes(SERVICE_TOKEN), false);
});

test('queued cancellation is idempotent and the same content-addressed job can be explicitly retried', async () => {
  const fixture = makeEvidenceFixture();
  const store = new MemoryStore();
  const evidence = new EvidenceRepository({
    manifestUrl: fixture.manifestUrl,
    manifestPublicKey: FIXTURE_PUBLIC_KEY,
    expectedKeyId: FIXTURE_KEY_ID,
    fetchImpl: manifestFetch(fixture, []),
  });
  const service = new CanvasAnalysisService({ store, evidenceRepository: evidence, clock: () => new Date(FIXED_TIME) });
  const body = startBody(3);
  const started = await service.start(body);
  const cancelled = await service.cancel(started.worker_job_id, { job_id: body.job_id, manager_id: body.manager_id });
  assert.equal(cancelled.status, 'cancelled');
  const cancelledAgain = await service.cancel(started.worker_job_id, { job_id: body.job_id, manager_id: body.manager_id });
  assert.equal(cancelledAgain.status, 'cancelled');
  const retried = await service.start({ ...body, retry_failed_job: true });
  assert.equal(retried.status, 'queued');
  const completed = await service.processNextJob('fixture-worker', 60_000);
  assert.equal(completed.job.status, 'complete');
  assert.equal(completed.snapshot.evidence_id, `canvas_evidence_${completed.snapshot.snapshot_hash}`);
});

test('tampered signed metadata and tile bytes fail closed before results are published', async () => {
  const tamperedManifestFixture = makeEvidenceFixture();
  tamperedManifestFixture.manifest.release.dataset_version = 'tampered';
  tamperedManifestFixture.manifestBytes = Buffer.from(canonicalStringify(tamperedManifestFixture.manifest));
  const manifestStore = new MemoryStore();
  const manifestService = new CanvasAnalysisService({
    store: manifestStore,
    evidenceRepository: new EvidenceRepository({
      manifestUrl: tamperedManifestFixture.manifestUrl,
      manifestPublicKey: FIXTURE_PUBLIC_KEY,
      expectedKeyId: FIXTURE_KEY_ID,
      fetchImpl: manifestFetch(tamperedManifestFixture, []),
    }),
    clock: () => new Date(FIXED_TIME),
  });
  await assert.rejects(manifestService.start(startBody(8)), (error) => error.code === 'evidence_manifest_signature_invalid');
  assert.equal(manifestStore.jobs.size, 0);

  const tileFixture = makeEvidenceFixture();
  tileFixture.tileBytes = Buffer.from(tileFixture.tileBytes.toString('utf8').replace('0.94', '0.93'), 'utf8');
  const tileStore = new MemoryStore();
  const tileService = new CanvasAnalysisService({
    store: tileStore,
    evidenceRepository: new EvidenceRepository({
      manifestUrl: tileFixture.manifestUrl,
      manifestPublicKey: FIXTURE_PUBLIC_KEY,
      expectedKeyId: FIXTURE_KEY_ID,
      fetchImpl: manifestFetch(tileFixture, []),
    }),
    clock: () => new Date(FIXED_TIME),
  });
  const body = startBody(9);
  await tileService.start(body);
  const processed = await tileService.processNextJob('fixture-worker', 60_000);
  assert.equal(processed.error.code, 'evidence_tile_digest_mismatch');
  const failed = await tileStore.getJobByJobId(body.job_id, body.manager_id);
  assert.equal(failed.status, 'failed');
  assert.equal(tileStore.results.size, 0);
});

test('durable store contains transactional SKIP LOCKED claims and separate result persistence', () => {
  const source = readFileSync(resolve(serviceDirectory, 'src/store.mjs'), 'utf8');
  assert.match(source, /FOR UPDATE SKIP LOCKED/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS canvas_analysis_jobs/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS canvas_analysis_results/);
  assert.match(source, /BEGIN[\s\S]*canvas_analysis_results[\s\S]*COMMIT/);
  assert.doesNotMatch(source, /Precision|MasterProperty|OVERPASS|PRECISION_DATABASE_URL/);
});

test('buildSnapshot uses the adapter-compatible content identity', () => {
  const fixture = makeEvidenceFixture();
  const release = {
    release_id: fixture.ids.release,
    source_versions: { fixture: '1' },
    source_attribution: 'fixture',
    manifest: fixture.manifest,
  };
  const job = {
    ...startBody(), provider: 'fixture', release_id: fixture.ids.release,
    manifest_hash: 'a'.repeat(64), tile_ids: [fixture.ids.tile],
  };
  const snapshot = buildSnapshot(job, release, {
    work_units: fixture.tile.work_units,
    protected_groups: fixture.tile.protected_groups,
    external_neighbor_ids: fixture.tile.external_neighbor_ids,
  }, FIXED_TIME);
  assert.equal(snapshot.snapshot_hash, sha256Hex(canonicalStringify(snapshotIdentity(snapshot))));
  assert.equal(snapshot.evidence_id, `canvas_evidence_${snapshot.snapshot_hash}`);

  const oversizedUnit = structuredClone(fixture.tile.work_units[0]);
  oversizedUnit.provenance[0].feature_id = 'x'.repeat(5_500_000);
  assert.throws(() => buildSnapshot(job, release, {
    work_units: [oversizedUnit], protected_groups: [], external_neighbor_ids: [],
  }, FIXED_TIME), (error) => error.code === 'analysis_result_too_large');
});
