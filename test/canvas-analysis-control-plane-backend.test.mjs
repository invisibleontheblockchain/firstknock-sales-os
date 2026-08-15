import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const rootDirectory = resolve(testDirectory, '..');
const SERVICE_URL = 'https://analysis.example.test/control/';
const SERVICE_TOKEN = 'test-analysis-service-token-at-least-32-bytes';
const TILE_ID = `cet1_${'a'.repeat(64)}`;
const RELEASE_ID = `cer1_${'b'.repeat(64)}`;
const MANIFEST_HASH = 'c'.repeat(64);

const polygon = [
  { lat: 33.45, lng: -112.08 },
  { lat: 33.45, lng: -112.07 },
  { lat: 33.46, lng: -112.07 },
  { lat: 33.46, lng: -112.08 },
];

function manager(id = 'manager_1') {
  return { id, role: 'admin', app_role: 'manager' };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function matches(record, query) {
  return Object.entries(query || {}).every(([key, value]) => record[key] === value);
}

function entity(state, key, prefix) {
  return {
    async filter(query, _sort, limit = 100) {
      return state[key].filter((record) => matches(record, query)).slice(0, limit);
    },
    async get(id) {
      const record = state[key].find((candidate) => candidate.id === id);
      if (!record) throw new Error('not found');
      return record;
    },
    async create(value) {
      const record = { ...structuredClone(value), id: `${prefix}_${++state.sequence}` };
      state[key].push(record);
      return record;
    },
    async updateMany(query, update) {
      const selected = state[key].filter((record) => matches(record, query));
      for (const record of selected) Object.assign(record, structuredClone(update.$set || {}));
      return { success: true, updated: selected.length, has_more: false };
    },
  };
}

function makeState() {
  const state = { jobs: [], snapshots: [], revisions: [], revisionHeads: [], sequence: 0 };
  const entities = {
    CanvasAnalysisJob: entity(state, 'jobs', 'job'),
    CanvasAnalysisSnapshot: entity(state, 'snapshots', 'snapshot'),
    CanvasClassificationRevision: entity(state, 'revisions', 'revision'),
    CanvasClassificationRevisionHead: entity(state, 'revisionHeads', 'revision_head'),
  };
  return {
    state,
    base44For(user) {
      return {
        auth: { me: async () => user },
        entities,
        asServiceRole: { entities },
      };
    },
  };
}

function snapshotFor(startRequest) {
  const analysisResult = {
    classified_work_units: [
      {
        work_unit_id: `cewu1_${'d'.repeat(64)}`,
        canvas_role: 'opportunity',
        opportunity: { min: 8, expected: 10, max: 12 },
      },
    ],
    unresolved_unit_count: 0,
  };
  const resultJson = canonicalJson(analysisResult);
  const snapshot = {
    schema_version: 1,
    manager_id: startRequest.manager_id,
    created_by_user_id: startRequest.manager_id,
    created_at: '2026-08-14T12:00:00.000Z',
    provider: 'fixture-provider',
    release_id: RELEASE_ID,
    manifest_hash: MANIFEST_HASH,
    source_versions: { fixture: '2026-08-14.1' },
    compiler_version: 'fixture-compiler/1',
    classifier_version: 'fixture-classifier/1',
    polygon: startRequest.polygon,
    tile_ids: [TILE_ID],
    analysis_result: analysisResult,
    result_hash: sha256(resultJson),
    result_bytes: Buffer.byteLength(resultJson),
    summary: { opportunity_work_units: 1 },
    source_attribution: 'Local deterministic fixture',
    production_trusted: true,
  };
  const identity = {
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
  snapshot.snapshot_hash = sha256(identity);
  snapshot.evidence_id = `canvas_evidence_${snapshot.snapshot_hash}`;
  return snapshot;
}

function makeAnalysisService() {
  const calls = [];
  const serviceJobs = new Map();
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    assert.equal(init.headers.authorization, `Bearer ${SERVICE_TOKEN}`);
    assert.equal(init.redirect, 'error');
    if (url.pathname.endsWith('/v1/canvas/analyses') && init.method === 'POST') {
      const request = JSON.parse(init.body);
      assert.deepEqual(Object.keys(request).sort(), [
        'area_count', 'area_sq_mi', 'job_id', 'manager_id', 'polygon', 'request_hash', 'retry_failed_job',
      ]);
      assert.equal('provider_url' in request, false);
      assert.equal('release_id' in request, false);
      const workerJobId = `worker_${request.job_id.slice(-24)}`;
      const snapshot = snapshotFor(request);
      const serviceJob = {
        job_id: request.job_id,
        manager_id: request.manager_id,
        worker_job_id: workerJobId,
        status: 'queued',
        provider: snapshot.provider,
        release_id: snapshot.release_id,
        manifest_hash: snapshot.manifest_hash,
        tile_scheme: 'fixture-grid/1',
        tile_ids: snapshot.tile_ids,
        tile_count: 1,
        completed_tile_count: 0,
        failed_tile_count: 0,
        progress_pct: 0,
        worker_status_cursor: 'cursor-1',
        retryable: true,
      };
      serviceJobs.set(workerJobId, { serviceJob, snapshot });
      return Response.json({ job: serviceJob });
    }
    const match = url.pathname.match(/\/v1\/canvas\/analyses\/([^/]+)\/(status|cancel|result)$/);
    assert.ok(match, `unexpected service path ${url.pathname}`);
    const [, workerJobId, operation] = match;
    const found = serviceJobs.get(workerJobId);
    assert.ok(found, `unknown worker ${workerJobId}`);
    if (operation === 'status') {
      return Response.json({
        job: {
          ...found.serviceJob,
          status: 'complete',
          completed_tile_count: 1,
          progress_pct: 100,
          evidence_id: found.snapshot.evidence_id,
          snapshot_hash: found.snapshot.snapshot_hash,
          worker_status_cursor: 'cursor-2',
        },
      });
    }
    if (operation === 'cancel') {
      const request = JSON.parse(init.body);
      assert.deepEqual(request, { job_id: found.serviceJob.job_id, manager_id: found.serviceJob.manager_id });
      return Response.json({ job: { ...found.serviceJob, status: 'cancelled' } });
    }
    return Response.json({
      job: {
        job_id: found.serviceJob.job_id,
        manager_id: found.serviceJob.manager_id,
        worker_job_id: found.serviceJob.worker_job_id,
        status: 'complete',
        evidence: found.snapshot,
      },
    });
  };
  return { calls, fetchImpl };
}

function loadHandler(name, { base44, fetchImpl, configured = true }) {
  const path = resolve(rootDirectory, `base44/functions/${name}/entry.ts`);
  const source = readFileSync(path, 'utf8');
  const result = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], `${name} contains TypeScript syntax errors`);
  let handler;
  const executable = result.outputText.replace(/^import .*;\s*$/gm, '');
  vm.runInNewContext(executable, {
    console,
    createClientFromRequest: () => base44,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Request,
    Response,
    URL,
    AbortController,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    structuredClone,
    Deno: {
      env: {
        get: (key) => configured
          ? { CANVAS_ANALYSIS_SERVICE_URL: SERVICE_URL, CANVAS_ANALYSIS_SERVICE_TOKEN: SERVICE_TOKEN }[key] || null
          : null,
      },
      serve: (registered) => { handler = registered; },
    },
  }, { filename: path });
  return handler;
}

async function invoke(handler, body) {
  const response = await handler(new Request('https://firstknock.example.test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { response, result: await response.json() };
}

test('analysis lifecycle is idempotent, tenant-scoped, integrity checked, and locally snapshotted', async () => {
  const { state, base44For } = makeState();
  const service = makeAnalysisService();
  const managerOne = base44For(manager());
  const start = loadHandler('canvasStartAnalysis', { base44: managerOne, fetchImpl: service.fetchImpl });

  const first = await invoke(start, { polygon, area_count: 4 });
  assert.equal(first.response.status, 200);
  assert.equal(first.result.success, true);
  assert.match(first.result.job_id, /^canvas_analysis_job_[a-f0-9]{64}$/);
  assert.equal(first.result.status, 'queued');
  assert.equal(state.jobs.length, 1);
  assert.equal(JSON.stringify(first.result).includes(SERVICE_TOKEN), false);

  const reversedRotation = [polygon[2], polygon[1], polygon[0], polygon[3]];
  const repeated = await invoke(start, { polygon: reversedRotation, area_count: 4 });
  assert.equal(repeated.result.job_id, first.result.job_id);
  assert.equal(state.jobs.length, 1);
  assert.equal(service.calls.length, 1, 'an equivalent request reuses its content-addressed receipt');

  const forbiddenControl = await invoke(start, { polygon, area_count: 4, release_id: RELEASE_ID });
  assert.equal(forbiddenControl.response.status, 400);
  assert.equal(service.calls.length, 1);

  const otherManagerStatus = loadHandler('canvasGetAnalysisStatus', {
    base44: base44For(manager('manager_2')),
    fetchImpl: service.fetchImpl,
  });
  const hidden = await invoke(otherManagerStatus, { job_id: first.result.job_id });
  assert.equal(hidden.response.status, 404);
  assert.equal(service.calls.length, 1, 'cross-tenant lookup never reaches the service');

  const status = loadHandler('canvasGetAnalysisStatus', { base44: managerOne, fetchImpl: service.fetchImpl });
  const completed = await invoke(status, { job_id: first.result.job_id });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.result.status, 'complete');
  assert.match(completed.result.evidence_id, /^canvas_evidence_[a-f0-9]{64}$/);
  assert.equal(state.jobs[0].status, 'complete');

  const getAnalysis = loadHandler('canvasGetAnalysis', { base44: managerOne, fetchImpl: service.fetchImpl });
  const loaded = await invoke(getAnalysis, { evidence_id: completed.result.evidence_id, use_revision_head: true });
  assert.equal(loaded.response.status, 200);
  assert.equal(loaded.result.success, true);
  assert.equal(loaded.result.evidence_id, completed.result.evidence_id);
  assert.equal(loaded.result.analysis_result.unresolved_unit_count, 0);
  assert.equal(loaded.result.production_trusted, true);
  assert.equal(state.snapshots.length, 1);
  const callsAfterSnapshot = service.calls.length;
  const loadedAgain = await invoke(getAnalysis, { evidence_id: completed.result.evidence_id });
  assert.deepEqual(loadedAgain.result, loaded.result);
  assert.equal(service.calls.length, callsAfterSnapshot, 'immutable snapshots are served without re-downloading results');

  state.snapshots[0].summary.opportunity_work_units = 999;
  const tampered = await invoke(getAnalysis, { evidence_id: completed.result.evidence_id });
  assert.equal(tampered.response.status, 409);
  assert.equal(tampered.result.error, 'analysis_snapshot_invalid');
});

test('cancellation is idempotent and missing configuration or oversized geography fails closed', async () => {
  const { state, base44For } = makeState();
  const service = makeAnalysisService();
  const managerBase44 = base44For(manager());
  const start = loadHandler('canvasStartAnalysis', { base44: managerBase44, fetchImpl: service.fetchImpl });
  const started = await invoke(start, { polygon, area_count: 5 });
  assert.equal(started.response.status, 200);

  const cancel = loadHandler('canvasCancelAnalysis', { base44: managerBase44, fetchImpl: service.fetchImpl });
  const cancelled = await invoke(cancel, { job_id: started.result.job_id });
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.result.status, 'cancelled');
  assert.equal(state.jobs[0].cancelled_by_user_id, 'manager_1');
  const callsAfterCancel = service.calls.length;
  const cancelledAgain = await invoke(cancel, { job_id: started.result.job_id });
  assert.equal(cancelledAgain.result.status, 'cancelled');
  assert.equal(service.calls.length, callsAfterCancel);

  const unconfigured = loadHandler('canvasStartAnalysis', {
    base44: managerBase44,
    fetchImpl: () => { throw new Error('must not call network'); },
    configured: false,
  });
  const unavailable = await invoke(unconfigured, { polygon, area_count: 1 });
  assert.equal(unavailable.response.status, 503);
  assert.equal(unavailable.result.error, 'canvas_analysis_service_unavailable');

  const callsBeforeLargeArea = service.calls.length;
  const tooLarge = await invoke(start, {
    polygon: [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 1 }, { lat: 1, lng: 0 }],
    area_count: 1,
  });
  assert.equal(tooLarge.response.status, 400);
  assert.equal(tooLarge.result.error, 'invalid_polygon');
  assert.equal(service.calls.length, callsBeforeLargeArea);
});
