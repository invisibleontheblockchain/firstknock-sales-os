import assert from 'node:assert/strict';
import { randomUUID, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const entity = (name) => JSON.parse(read(`base44/entities/${name}.jsonc`));

function matches(row, filter = {}) {
  return Object.entries(filter).every(([field, expected]) => {
    if (field === '$or') return expected.some((candidate) => matches(row, candidate));
    if (field === '$and') return expected.every((candidate) => matches(row, candidate));
    const actual = row[field];
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('$in' in expected) return expected.$in.includes(actual);
      if ('$exists' in expected) return expected.$exists ? actual !== undefined : actual === undefined;
      if ('$lte' in expected) return actual !== undefined && actual <= expected.$lte;
    }
    return actual === expected;
  });
}

function memoryEntity(rows, prefix, sequence) {
  return {
    async get(id) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) throw new Error('not found');
      return row;
    },
    async filter(filter, _sort, limit = 100, skip = 0) {
      return rows.filter((row) => matches(row, filter)).sort((left, right) => Number(left.tile_index || 0) - Number(right.tile_index || 0)).slice(skip, skip + limit);
    },
    async create(record) {
      const created = { ...structuredClone(record), id: `${prefix}_${++sequence.value}` };
      rows.push(created);
      return created;
    },
    async updateMany(filter, update) {
      const selected = rows.filter((row) => matches(row, filter));
      for (const row of selected) {
        Object.assign(row, structuredClone(update.$set || {}));
        for (const field of Object.keys(update.$unset || {})) delete row[field];
      }
      return { success: true, updated: selected.length, has_more: false };
    },
    async delete(id) {
      const index = rows.findIndex((row) => row.id === id);
      if (index >= 0) rows.splice(index, 1);
      return { success: index >= 0 };
    },
  };
}

function loadHandler(path, { base44, fetchImpl = fetch, env = {}, exposeInternals = false }) {
  const transpiled = ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: path, reportDiagnostics: true });
  assert.deepEqual((transpiled.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error), []);
  let handler;
  const context = {
    console,
    createClientFromRequest: () => base44,
    crypto: { subtle: { digest: (...args) => webcrypto.subtle.digest(...args) }, randomUUID },
    TextEncoder,
    TextDecoder,
    Request,
    Response,
    URL,
    URLSearchParams,
    AbortController,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    structuredClone,
    Deno: { env: { get: (key) => env[key] ?? null }, serve: (registered) => { handler = registered; } },
  };
  let executable = transpiled.outputText.replace(/^import .*;\s*$/gm, '');
  if (exposeInternals) executable = executable.replace('Deno.serve(',
    'globalThis.__canvasLargeInternals = { clipClassifiedStreetUnitsToOwnedCore, mergeStreetUnitResults }; Deno.serve(');
  vm.runInNewContext(executable, context, { filename: path });
  if (exposeInternals) handler.internals = context.__canvasLargeInternals;
  return handler;
}

async function invoke(handler, body) {
  const response = await handler(new Request('https://example.test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { response, body: await response.json() };
}

test('large Canvas analysis uses tenant-owned CAS jobs and immutable tile evidence', () => {
  const job = entity('CanvasAnalysisJob');
  const tile = entity('CanvasAnalysisTile');
  const evidence = entity('CanvasAnalysisTileEvidence');
  assert.deepEqual(job.rls.read.$or[0], { manager_id: '{{user.id}}' });
  assert.deepEqual(tile.rls.read.$or[0], { manager_id: '{{user.id}}' });
  assert.deepEqual(job.properties.processor_token.rls.read, { user_condition: { role: 'admin' } });
  assert.deepEqual(job.properties.lock_token.rls.write, { user_condition: { role: 'admin' } });
  assert.ok(job.required.includes('version'));
  assert.ok(job.required.includes('cache_epoch'));
  assert.ok(job.required.includes('tile_manifest'));
  assert.ok(tile.required.includes('tile_hash'));
  assert.ok(tile.required.includes('query_area_sq_mi'));
  assert.equal(tile.properties.query_area_sq_mi.minimum, 5);
  assert.equal(tile.properties.query_area_sq_mi.maximum, 25);
  assert.deepEqual(evidence.rls.read, { user_condition: { role: 'admin' } });
  assert.deepEqual(evidence.rls.update, { user_condition: { id: '__immutable_canvas_tile_evidence__' } });
});

test('large Canvas processor is bounded, private-provider-only, resumable, and content addressed', () => {
  const source = read('base44/functions/canvasStartAnalysis/entry.ts');
  assert.match(source, /MAX_AREA_SQ_MI = 50/);
  assert.match(source, /MAX_LARGE_AREA_SQ_MI = 1_000/);
  assert.match(source, /LARGE_TILE_QUERY_MILES = 4\.8/);
  assert.match(source, /LARGE_TILE_CORE_MILES = 4\.4/);
  assert.match(source, /MAX_LARGE_TILE_COUNT = 128/);
  assert.match(source, /MAX_TILE_ATTEMPTS = 4/);
  assert.match(source, /MAX_ACTIVE_ANALYSIS_JOBS_PER_MANAGER = 3/);
  assert.match(source, /DEFAULT_ANALYSIS_CACHE_TTL_MS = 24 \* 60 \* 60 \* 1_000/);
  assert.match(source, /LARGE_TILE_TIMEOUT_MS = 25_000/);
  assert.match(source, /LARGE_TILE_RESULT_BYTES = 5_500_000/);
  assert.match(source, /TILE_PLAN_VERSION = 'canvas-grid-buffered-v2'/);
  assert.match(source, /CANVAS_OVERPASS_LARGE_AREA_URL/);
  assert.match(source, /PUBLIC_OVERPASS_HOSTS\.has/);
  assert.match(source, /parsed\.protocol !== 'https:'/);
  assert.match(source, /CanvasAnalysisJob\.updateMany\([\s\S]*?version: expectedVersion/);
  assert.match(source, /lock_expires_at: \{ \$lte:/);
  assert.match(source, /canvas_tile_stale_lease/);
  assert.match(source, /retryDelayMs/);
  assert.match(source, /ensureDurableTileTasks/);
  assert.match(source, /CanvasAnalysisTileEvidence\.create/);
  assert.match(source, /canvas_tile_evidence_\$\{tileEvidenceHash\}/);
  assert.match(source, /canvas_immutable_tile_manifest_v1/);
  assert.match(source, /mergeStreetUnitResults/);
  assert.match(source, /classifyStreetEvidence\(rawEvidence, tile\.query_polygon, \{ include_tiling_metadata: true \}\)/);
  assert.match(source, /clipClassifiedStreetUnitsToOwnedCore\(contextStreetUnits, tile\.core_polygon, job\.polygon\)/);
  assert.match(source, /block\.access_states\.has\('restricted'\)[\s\S]*?block\.access_states\.has\('uncertain'\)[\s\S]*?block\.access_states\.has\('permitted'\)/);
  assert.match(source, /opportunity_features/);
  assert.match(source, /if \(areaSqMi > MAX_AREA_SQ_MI\) return Response\.json\(await startLargeAnalysis/);
  assert.match(source, /internal_action: 'process_large_analysis_job'/);
  assert.doesNotMatch(source, /BatchData|RentCast|DATABASE_URL|Neon/);
});

test('large tiles emit only core-owned manager geometry and rebuild topology across seams', () => {
  const handler = loadHandler('base44/functions/canvasStartAnalysis/entry.ts', {
    base44: {},
    exposeInternals: true,
    env: { CANVAS_OVERPASS_LARGE_AREA_URL: 'https://osm.internal.example/api/interpreter' },
  });
  const { clipClassifiedStreetUnitsToOwnedCore, mergeStreetUnitResults } = handler.internals;
  const managerPolygon = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 0.1 },
    { lat: 0.1, lng: 0.1 },
    { lat: 0.1, lng: 0 },
  ];
  const corePolygon = [
    { lat: 0, lng: -0.01 },
    { lat: 0, lng: 0.06 },
    { lat: 0.1, lng: 0.06 },
    { lat: 0.1, lng: -0.01 },
  ];
  const classified = [{
    id: 'osm_way_90',
    unit_id: 'osm_way_90',
    source_way_id: 90,
    source_edge_ids: ['osm_way_90_0'],
    kind: 'residential',
    street_names: ['Core Street'],
    opportunity_classification: 'none',
    access_classification: 'permitted',
    protected: true,
    protected_group_id: 'tile_local_false_terminal',
    protected_group_ids: ['tile_local_false_terminal'],
    protected_origin_node_ids: [],
    segments: [{
      edge_id: 'osm_way_90_0',
      source_edge_id: 'osm_way_90_0',
      source_way_id: 90,
      source_edge_index: 0,
      source_from: 0,
      source_to: 1,
      source_start_node_id: 900,
      source_end_node_id: 901,
      start: { lat: 0.05, lng: -0.02 },
      end: { lat: 0.05, lng: 0.12 },
      length_meters: 1,
    }],
  }];
  const owned = clipClassifiedStreetUnitsToOwnedCore(classified, corePolygon, managerPolygon);
  assert.equal(owned.length, 1);
  assert.ok(Math.abs(owned[0].segments[0].start.lng - 0) < 1e-9, 'manager boundary clips the west context');
  assert.ok(Math.abs(owned[0].segments[0].end.lng - 0.06) < 1e-9, 'tile core clips the east context');
  assert.equal(owned[0].protected, false, 'tile-local terminal conclusions are never emitted');
  assert.equal(owned[0].protected_group_id, undefined);

  const fragment = ({ way, edge = 0, from = 0, to = 1, start, end, startNode = null, endNode = null,
    access = 'permitted', opportunity = 'none', features = [], origins = [], single = false }) => {
    const sourceEdgeId = `osm_way_${way}_${edge}`;
    return {
      id: `${sourceEdgeId}_${from}_${to}`,
      unit_id: `${sourceEdgeId}_${from}_${to}`,
      source_edge_ids: [sourceEdgeId],
      source_way_id: way,
      source_single_edge_way: single,
      kind: 'residential',
      street_names: [`Way ${way}`],
      opportunity_classification: opportunity,
      access_classification: access,
      opportunity_features: features,
      protected_origin_node_ids: origins,
      segments: [{
        edge_id: `${sourceEdgeId}_${from}_${to}`,
        source_edge_id: sourceEdgeId,
        source_way_id: way,
        source_edge_index: edge,
        source_from: from,
        source_to: to,
        source_start_node_id: startNode,
        source_end_node_id: endNode,
        start,
        end,
        length_meters: 100,
      }],
    };
  };
  const homeFeature = {
    feature_id: 'osm_way_home_1',
    association_distance_meters: 5,
    low: 1,
    expected: 1,
    high: 1,
    source: 'deduplicated_addresses',
  };
  const tile0 = { tile_index: 0, analysis_result: { street_units: [
    fragment({ way: 100, from: 0, to: 0.5, start: { lat: 0.02, lng: 0 }, end: { lat: 0.02, lng: 0.05 }, startNode: 1,
      access: 'permitted', opportunity: 'likely', features: [homeFeature] }),
    fragment({ way: 200, start: { lat: 0.04, lng: 0 }, end: { lat: 0.04, lng: 0.05 }, startNode: 20, endNode: 21 }),
    fragment({ way: 300, start: { lat: 0.06, lng: 0.05 }, end: { lat: 0.06, lng: 0 }, startNode: 30, endNode: 31 }),
    fragment({ way: 400, edge: 0, start: { lat: 0.06, lng: 0.05 }, end: { lat: 0.07, lng: 0.05 }, startNode: 30, endNode: 40 }),
  ] } };
  const tile1 = { tile_index: 1, analysis_result: { street_units: [
    fragment({ way: 100, from: 0.5, to: 1, start: { lat: 0.02, lng: 0.05 }, end: { lat: 0.02, lng: 0.1 }, endNode: 2,
      access: 'uncertain', opportunity: 'likely', features: [homeFeature] }),
    fragment({ way: 201, start: { lat: 0.04, lng: 0.05 }, end: { lat: 0.04, lng: 0.1 }, startNode: 21, endNode: 22 }),
    fragment({ way: 301, start: { lat: 0.06, lng: 0.05 }, end: { lat: 0.06, lng: 0.1 }, startNode: 30, endNode: 32 }),
    fragment({ way: 400, edge: 1, start: { lat: 0.07, lng: 0.05 }, end: { lat: 0.08, lng: 0.05 }, startNode: 40, endNode: 41 }),
  ] } };
  const merged = mergeStreetUnitResults([tile1, tile0], managerPolygon);
  const seamRoad = merged.find((unit) => unit.source_edge_ids.includes('osm_way_100_0'));
  assert.ok(seamRoad);
  assert.equal(seamRoad.segments.length, 1, 'two core fragments reconstruct one source edge');
  assert.ok(Math.abs(seamRoad.segments[0].start.lng - 0) < 1e-9);
  assert.ok(Math.abs(seamRoad.segments[0].end.lng - 0.1) < 1e-9);
  assert.equal(seamRoad.protected, false, 'the former tile seam is not a terminal branch');
  assert.equal(seamRoad.access_classification, 'uncertain', 'uncertain access outranks an incomplete permitted observation');
  assert.equal(seamRoad.canvas_role, 'uncertain');
  assert.equal(seamRoad.opportunity_expected, 1, 'buffered duplicate opportunity evidence is counted once');

  const leftNeighbor = merged.find((unit) => unit.source_edge_ids.includes('osm_way_200_0'));
  const rightNeighbor = merged.find((unit) => unit.source_edge_ids.includes('osm_way_201_0'));
  assert.ok(leftNeighbor.neighbor_ids.includes(rightNeighbor.unit_id));
  assert.ok(rightNeighbor.neighbor_ids.includes(leftNeighbor.unit_id), 'neighbors are rebuilt from global OSM node identity');

  const culDeSac = merged.find((unit) => unit.source_edge_ids.includes('osm_way_400_0'));
  assert.equal(culDeSac.source_edge_ids.join(','), 'osm_way_400_0,osm_way_400_1', 'degree-two branch edges coalesce across tiles');
  assert.equal(culDeSac.protected, true);
  assert.equal(culDeSac.protected_group_ids.length, 1);
  for (const mainEdge of ['osm_way_300_0', 'osm_way_301_0']) {
    assert.equal(merged.find((unit) => unit.source_edge_ids.includes(mainEdge)).protected, false,
      'the terminal group stops at the globally reconstructed junction');
  }
});

test('a large boundary runs queued tiles to one deduplicated composite evidence snapshot', async () => {
  const sequence = { value: 0 };
  const user = { id: 'manager_large_1', role: 'admin', app_role: 'manager' };
  const state = { jobs: [], tiles: [], tileEvidence: [], snapshots: [], heads: [], users: [user] };
  const entities = {
    CanvasAnalysisJob: memoryEntity(state.jobs, 'job', sequence),
    CanvasAnalysisTile: memoryEntity(state.tiles, 'tile', sequence),
    CanvasAnalysisTileEvidence: memoryEntity(state.tileEvidence, 'tile_evidence', sequence),
    CanvasAnalysisSnapshot: memoryEntity(state.snapshots, 'snapshot', sequence),
    CanvasClassificationRevisionHead: memoryEntity(state.heads, 'head', sequence),
    User: memoryEntity(state.users, 'user', sequence),
  };
  const queuedInvocations = [];
  const base44 = {
    auth: { me: async () => user },
    entities,
    asServiceRole: {
      entities,
      functions: {
        invoke: async (name, payload) => {
          assert.equal(name, 'canvasStartAnalysis');
          queuedInvocations.push(payload);
          return { data: { success: true, accepted: true } };
        },
      },
    },
  };
  const osm = {
    osm3s: { timestamp_osm_base: '2026-07-18T00:00:00Z' },
    elements: [
      { type: 'node', id: 1, lat: 35.06, lon: -81.94 },
      { type: 'node', id: 2, lat: 35.06, lon: -81.93 },
      { type: 'node', id: 3, lat: 35.0602, lon: -81.9398 },
      { type: 'node', id: 4, lat: 35.0602, lon: -81.9396 },
      { type: 'node', id: 5, lat: 35.0604, lon: -81.9396 },
      { type: 'node', id: 6, lat: 35.0604, lon: -81.9398 },
      { type: 'way', id: 100, nodes: [1, 2], tags: { highway: 'residential', name: 'Oak Street', access: 'private' } },
      { type: 'way', id: 200, nodes: [3, 4, 5, 6, 3], tags: { building: 'house', 'addr:housenumber': '12' } },
    ],
  };
  const start = loadHandler('base44/functions/canvasStartAnalysis/entry.ts', {
    base44,
    env: { CANVAS_OVERPASS_LARGE_AREA_URL: 'https://osm.internal.example/api/interpreter' },
    fetchImpl: async () => new Response(JSON.stringify(osm), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const polygon = [
    { lat: 35, lng: -82 },
    { lat: 35, lng: -81.87 },
    { lat: 35.13, lng: -81.87 },
    { lat: 35.13, lng: -82 },
  ];
  const started = await invoke(start, { polygon, area_count: 8 });
  assert.equal(started.response.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.status, 'queued');
  assert.match(started.body.job_id, /^canvas_analysis_job_[a-f0-9]{64}$/);
  assert.ok(started.body.tile_count > 1);

  let safety = 0;
  while (queuedInvocations.length && safety < 200) {
    safety += 1;
    const processed = await invoke(start, queuedInvocations.shift());
    assert.ok([200, 503].includes(processed.response.status), JSON.stringify(processed.body));
  }
  assert.ok(safety < 200, 'processor must converge within its bounded tile plan');
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(state.tiles.length, 0, 'terminal tile rows are compacted after the final immutable snapshot commits');
  assert.equal(state.tileEvidence.length, 0, 'terminal raw tile evidence is compacted after its hashes enter the snapshot manifest');
  assert.equal(state.snapshots.length, 1);
  assert.equal(state.snapshots[0].raw_evidence.format, 'canvas_immutable_tile_manifest_v1');
  assert.equal(state.snapshots[0].analysis_result.opportunity_total_expected, 1,
    'the same buffered building must count once globally even when access excludes it from knock workload');
  assert.equal(state.snapshots[0].analysis_result.street_units[0].canvas_role, 'excluded');
  assert.equal(state.snapshots[0].analysis_result.street_units[0].opportunity_expected, 1,
    'restricted and uncertain units retain their opportunity evidence for manager review');
  assert.equal(state.snapshots[0].analysis_result.street_units[0].confidence, 'high');

  const status = loadHandler('base44/functions/canvasGetAnalysisStatus/entry.ts', { base44 });
  const completed = await invoke(status, { job_id: started.body.job_id });
  assert.equal(completed.response.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.status, 'complete');
  assert.equal(completed.body.progress_pct, 100);
  assert.equal(completed.body.evidence_id, state.snapshots[0].evidence_id);
  user.id = 'manager_other';
  const forbidden = await invoke(status, { job_id: started.body.job_id });
  assert.equal(forbidden.response.status, 404, 'cross-tenant job identities must not be disclosed');
});

test('large analysis status is tenant scoped and never returns processor capabilities', () => {
  const source = read('base44/functions/canvasGetAnalysisStatus/entry.ts');
  assert.match(source, /CanvasAnalysisJob\.filter\(\{ job_id: jobId, manager_id: user\.id \}/);
  assert.match(source, /processor re-kick/);
  assert.match(source, /lockExpiresAt > now/);
  const responseFunction = source.slice(source.indexOf('function responseForJob'), source.indexOf('Deno.serve'));
  assert.doesNotMatch(responseFunction, /processor_token|lock_token|lock_expires_at/);
  assert.match(responseFunction, /evidence_id: job\.evidence_id/);
  assert.match(responseFunction, /poll_after_ms: terminal \? null : 1_500/);
});

test('manager cancellation is tenant scoped, CAS committed, and invalidates processor leases', async () => {
  const sequence = { value: 0 };
  const user = { id: 'manager_cancel', role: 'admin', app_role: 'manager' };
  const jobs = [{
    id: 'job_record_cancel',
    job_id: `canvas_analysis_job_${'c'.repeat(64)}`,
    manager_id: user.id,
    status: 'running',
    version: 7,
    processor_token: 'secret-processor-token',
    processor_token_hash: 'secret-processor-token-hash',
    lock_token: 'active-lease',
    lock_acquired_at: new Date().toISOString(),
    lock_expires_at: new Date(Date.now() + 60_000).toISOString(),
  }];
  const tiles = [];
  const tileEvidence = [];
  const entities = {
    CanvasAnalysisJob: memoryEntity(jobs, 'job', sequence),
    CanvasAnalysisTile: memoryEntity(tiles, 'tile', sequence),
    CanvasAnalysisTileEvidence: memoryEntity(tileEvidence, 'tile_evidence', sequence),
  };
  const base44 = { auth: { me: async () => user }, asServiceRole: { entities } };
  const cancel = loadHandler('base44/functions/canvasCancelAnalysis/entry.ts', { base44 });

  const cancelled = await invoke(cancel, { job_id: jobs[0].job_id });
  assert.equal(cancelled.response.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(jobs[0].version, 9, 'cancellation and terminal compaction each advance the CAS version');
  assert.equal(jobs[0].cancelled_by_user_id, user.id);
  assert.equal('processor_token' in jobs[0], false);
  assert.equal('processor_token_hash' in jobs[0], false);
  assert.equal('lock_token' in jobs[0], false);
  assert.equal(jobs[0].intermediate_storage_policy, 'compact-terminal-intermediates-v1');

  const repeated = await invoke(cancel, { job_id: jobs[0].job_id });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.body.idempotent, true);
  user.id = 'another_manager';
  const hidden = await invoke(cancel, { job_id: jobs[0].job_id });
  assert.equal(hidden.response.status, 404);
});

test('Canvas client reports queued progress and cancels polling without leaking abort listeners', async () => {
  const source = read('src/components/canvas/canvasProductionClient.js')
    .replace(/^import \{ base44 \} from ['"]@\/api\/base44Client['"];?$/m, 'const base44 = globalThis.__canvasLargeBase44Test;');
  const calls = [];
  const stored = new Map();
  globalThis.localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: (key) => stored.delete(key),
  };
  globalThis.__canvasLargeBase44Test = {
    functions: {
      invoke: async (name, payload) => {
        calls.push({ name, payload });
        if (name === 'canvasCancelAnalysis') return { data: { success: true, job_id: payload.job_id, status: 'cancelled' } };
        return { data: { success: true, job_id: payload.job_id, status: 'running', progress_pct: 50, poll_after_ms: 1_500 } };
      },
    },
  };
  try {
    const client = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#large-analysis`);
    const status = await client.getCanvasAnalysisStatus({ jobId: 'canvas_analysis_job_abc' });
    assert.equal(status.progress_pct, 50);
    assert.deepEqual(calls[0], { name: 'canvasGetAnalysisStatus', payload: { job_id: 'canvas_analysis_job_abc' } });

    const controller = new AbortController();
    const progress = [];
    await assert.rejects(client.waitForCanvasAnalysis({
      jobId: 'canvas_analysis_job_abc',
      initialStatus: { job_id: 'canvas_analysis_job_abc', status: 'queued', progress_pct: 0, poll_after_ms: 1_500 },
      signal: controller.signal,
      onProgress: (value) => {
        progress.push(value.progress_pct);
        controller.abort();
      },
    }), (error) => error.code === 'CANVAS_ANALYSIS_CANCELLED');
    assert.deepEqual(progress, [0]);
    assert.match(source, /signal\?\.removeEventListener\('abort', handleAbort\)/);

    const durableJobId = `canvas_analysis_job_${'d'.repeat(64)}`;
    assert.equal(client.persistCanvasAnalysisJob({
      managerId: 'manager_durable',
      jobId: durableJobId,
      polygon: [{ lat: 35, lng: -82 }, { lat: 35, lng: -81 }, { lat: 36, lng: -81 }],
      areaCount: 20,
    }), true);
    assert.equal(client.readPersistedCanvasAnalysisJob('manager_durable').jobId, durableJobId);
    const cancelled = await client.cancelCanvasAnalysis({ jobId: durableJobId });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(client.clearPersistedCanvasAnalysisJob('manager_durable', durableJobId), true);
    assert.equal(client.readPersistedCanvasAnalysisJob('manager_durable'), null);
  } finally {
    delete globalThis.__canvasLargeBase44Test;
    delete globalThis.localStorage;
  }
});

test('completed residential v2 evidence can save and deploy through 1000 square miles without changing v1 validation', () => {
  const save = read('base44/functions/canvasSaveDraft/entry.ts');
  const deploy = read('base44/functions/canvasDeployCampaign/entry.ts');
  assert.match(save, /MAX_AREA_SQ_MI = 1_000/);
  assert.match(deploy, /MAX_RESIDENTIAL_CANVAS_AREA_SQ_MI = 1e3/);
  assert.match(deploy, /if \(residentialV2\) \{[\s\S]*?residentialPolygonAreaSqMi/);
  assert.match(deploy, /\["street_territory_v1", "residential_street_territory_v2"\]/);
  assert.match(deploy, /if \(session\.territory_model === "residential_street_territory_v2"\) return verifyResidentialEvidence/);
});
