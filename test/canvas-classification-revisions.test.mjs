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
      return state[key].filter((record) => matches(record, query)).slice(0, limit).map((record) => structuredClone(record));
    },
    async get(id) {
      const record = state[key].find((candidate) => candidate.id === id);
      if (!record) throw new Error('not found');
      return structuredClone(record);
    },
    async create(value) {
      const record = { ...structuredClone(value), id: `${prefix}_${++state.sequence}` };
      state[key].push(record);
      return structuredClone(record);
    },
    async updateMany(query, update) {
      if (key === 'heads' && state.forceHeadConflict) {
        const head = state.heads.find((candidate) => candidate.id === query.id);
        if (head) {
          head.version += 1;
          head.head_revision_id = `canvas_revision_${'f'.repeat(64)}`;
        }
        state.forceHeadConflict = false;
      }
      const selected = state[key].filter((record) => matches(record, query));
      for (const record of selected) Object.assign(record, structuredClone(update.$set || {}));
      return { success: true, updated: selected.length, has_more: false };
    },
  };
}

function analysisResult() {
  const units = [
    {
      id: 'unit-a',
      canvas_role: 'uncertain',
      opportunity: null,
      street_names: ['Amber Ave'],
      neighbor_ids: ['unit-b'],
    },
    {
      id: 'unit-b',
      canvas_role: 'uncertain',
      opportunity: null,
      street_names: ['Amber Ave'],
      neighbor_ids: ['unit-a', 'unit-c'],
    },
    {
      id: 'unit-c',
      canvas_role: 'opportunity',
      opportunity: { min: 4, expected: 5, max: 6 },
      street_names: ['Home St'],
      neighbor_ids: ['unit-b', 'unit-d'],
    },
    {
      id: 'unit-d',
      canvas_role: 'transit',
      opportunity: null,
      street_names: ['Connector Rd'],
      neighbor_ids: ['unit-c'],
    },
  ];
  return {
    ok: true,
    status: 'needs_review',
    deployable: false,
    classified_street_units: units,
    work_units: [units[2]],
    context_street_units: [units[0], units[1], units[3]],
    uncertain_street_units: [units[0], units[1]],
    excluded_street_units: [],
    transit_street_units: [units[3]],
    unresolved_unit_count: 2,
    partition: { ok: true },
    summary: { source_unit_count: 4 },
  };
}

function snapshot(managerId = 'manager-1') {
  const result = analysisResult();
  const resultJson = canonicalJson(result);
  const value = {
    schema_version: 1,
    manager_id: managerId,
    created_by_user_id: managerId,
    created_at: '2026-08-14T12:00:00.000Z',
    provider: 'static-fixture',
    release_id: `cer1_${'a'.repeat(64)}`,
    manifest_hash: 'b'.repeat(64),
    source_versions: { fixture: '1' },
    compiler_version: 'fixture-compiler/1',
    classifier_version: 'fixture-classifier/1',
    polygon: [
      { lat: 33.4, lng: -112.1 },
      { lat: 33.4, lng: -112.0 },
      { lat: 33.5, lng: -112.0 },
    ],
    tile_ids: [`cet1_${'c'.repeat(64)}`],
    analysis_result: result,
    result_hash: sha256(resultJson),
    result_bytes: Buffer.byteLength(resultJson),
    summary: { source_unit_count: 4 },
    source_attribution: 'Deterministic local fixture',
    production_trusted: true,
  };
  const identity = {
    purpose: 'firstknock-canvas-analysis-snapshot-v1',
    schema_version: value.schema_version,
    manager_id: value.manager_id,
    created_by_user_id: value.created_by_user_id,
    created_at: value.created_at,
    provider: value.provider,
    release_id: value.release_id,
    manifest_hash: value.manifest_hash,
    source_versions: value.source_versions,
    compiler_version: value.compiler_version,
    classifier_version: value.classifier_version,
    polygon: value.polygon,
    tile_ids: value.tile_ids,
    result_hash: value.result_hash,
    result_bytes: value.result_bytes,
    summary: value.summary,
    source_attribution: value.source_attribution,
    production_trusted: value.production_trusted,
  };
  value.snapshot_hash = sha256(identity);
  value.evidence_id = `canvas_evidence_${value.snapshot_hash}`;
  return value;
}

function manager(id = 'manager-1') {
  return { id, role: 'admin', app_role: 'manager' };
}

function makeHarness(user = manager()) {
  const storedSnapshot = snapshot();
  const state = {
    jobs: [],
    snapshots: [{ ...structuredClone(storedSnapshot), id: 'snapshot-1' }],
    revisions: [],
    heads: [],
    sequence: 1,
    fetchCalls: 0,
    forceHeadConflict: false,
  };
  const entities = {
    CanvasAnalysisJob: entity(state, 'jobs', 'job'),
    CanvasAnalysisSnapshot: entity(state, 'snapshots', 'snapshot'),
    CanvasClassificationRevision: entity(state, 'revisions', 'revision'),
    CanvasClassificationRevisionHead: entity(state, 'heads', 'head'),
  };
  const base44 = {
    auth: { me: async () => user },
    entities,
    asServiceRole: { entities },
  };
  return { state, base44, snapshot: storedSnapshot };
}

function loadHandler(name, harness) {
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
  vm.runInNewContext(result.outputText.replace(/^import .*;\s*$/gm, ''), {
    console,
    createClientFromRequest: () => harness.base44,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Request,
    Response,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    structuredClone,
    fetch: async () => {
      harness.state.fetchCalls += 1;
      throw new Error('stored snapshot paths must not call a provider');
    },
    Deno: {
      env: { get: () => null },
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

function unit(result, id) {
  return result.analysis_result.classified_street_units.find((candidate) => candidate.id === id);
}

test('stored evidence and revision access are manager-only, tenant-scoped, and network-free', async () => {
  const own = makeHarness();
  const get = loadHandler('canvasGetAnalysis', own);
  const loaded = await invoke(get, { evidence_id: own.snapshot.evidence_id, use_revision_head: false });
  assert.equal(loaded.response.status, 200);
  assert.equal(loaded.result.evidence_id, own.snapshot.evidence_id);
  assert.equal(own.state.fetchCalls, 0);

  const repHarness = makeHarness({ id: 'rep-1', role: 'user', app_role: 'rep' });
  const repApply = loadHandler('canvasApplyClassificationOverride', repHarness);
  const forbidden = await invoke(repApply, {
    evidence_id: repHarness.snapshot.evidence_id,
    street_unit_ids: ['unit-a'],
    override_canvas_role: 'knock',
    opportunity_count: 5,
    override_reason: 'Manager verified this residential street.',
  });
  assert.equal(forbidden.response.status, 403);
  assert.equal(repHarness.state.revisions.length, 0);

  const otherHarness = makeHarness(manager('manager-2'));
  const otherApply = loadHandler('canvasApplyClassificationOverride', otherHarness);
  const hidden = await invoke(otherApply, {
    evidence_id: otherHarness.snapshot.evidence_id,
    street_unit_ids: ['unit-a'],
    override_canvas_role: 'knock',
    opportunity_count: 5,
    override_reason: 'Manager verified this residential street.',
  });
  assert.equal(hidden.response.status, 404);
  assert.equal(otherHarness.state.revisions.length, 0);
  assert.equal(otherHarness.state.fetchCalls, 0);
});

test('content-addressed overrides replay deterministically and same-parent retries are idempotent', async () => {
  const harness = makeHarness();
  const apply = loadHandler('canvasApplyClassificationOverride', harness);
  const get = loadHandler('canvasGetAnalysis', harness);
  const request = {
    evidence_id: harness.snapshot.evidence_id,
    street_unit_ids: ['unit-a'],
    override_canvas_role: 'knock',
    opportunity_count: 7,
    override_reason: 'Manager confirmed seven accessible residential doors.',
  };
  const first = await invoke(apply, request);
  assert.equal(first.response.status, 200);
  assert.equal(first.result.idempotent, false);
  assert.match(first.result.revision_id, /^canvas_revision_[a-f0-9]{64}$/);
  assert.equal(first.result.head_version, 1);
  assert.deepEqual(first.result.original_classifications, [{
    street_unit_id: 'unit-a',
    canvas_role: 'uncertain',
    opportunity_low: 0,
    opportunity_expected: 0,
    opportunity_high: 0,
  }]);
  assert.equal(harness.state.revisions.length, 1);
  assert.equal(harness.state.heads.length, 1);
  const stored = harness.state.revisions[0];
  const identity = {
    purpose: 'firstknock-canvas-classification-revision-v1',
    schema_version: 1,
    manager_id: 'manager-1',
    evidence_id: harness.snapshot.evidence_id,
    parent_revision_id: null,
    street_unit_ids: ['unit-a'],
    original_classifications: first.result.original_classifications,
    override_canvas_role: 'knock',
    opportunity_low: 7,
    opportunity_expected: 7,
    opportunity_high: 7,
    override_reason: request.override_reason,
    created_by_user_id: 'manager-1',
  };
  assert.equal(stored.revision_hash, sha256(identity));
  assert.equal(stored.revision_id, `canvas_revision_${sha256(identity)}`);

  const explicit = await invoke(get, {
    evidence_id: harness.snapshot.evidence_id,
    revision_id: first.result.revision_id,
    use_revision_head: false,
  });
  assert.equal(explicit.response.status, 200);
  assert.equal(unit(explicit.result, 'unit-a').canvas_role, 'knock');
  assert.deepEqual(unit(explicit.result, 'unit-a').opportunity, { low: 7, expected: 7, high: 7 });
  assert.equal(explicit.result.unresolved_unit_count, 1);
  assert.deepEqual(explicit.result.summary.canvas_role_counts, {
    knock: 2,
    transit_only: 1,
    excluded: 0,
    uncertain: 1,
  });
  assert.equal(explicit.result.summary.opportunity_expected, 12);

  const fromHead = await invoke(get, { evidence_id: harness.snapshot.evidence_id });
  assert.equal(fromHead.result.revision_id, first.result.revision_id);
  assert.equal(fromHead.result.replayed_result_hash, explicit.result.replayed_result_hash);
  const base = await invoke(get, { evidence_id: harness.snapshot.evidence_id, use_revision_head: false });
  assert.equal(base.result.revision_id, undefined);
  assert.equal(base.result.analysis_result.unresolved_unit_count, 2);

  const retried = await invoke(apply, request);
  assert.equal(retried.response.status, 200);
  assert.equal(retried.result.idempotent, true);
  assert.equal(retried.result.revision_id, first.result.revision_id);
  assert.equal(harness.state.revisions.length, 1);
  assert.equal(harness.state.heads[0].version, 1);
  assert.equal(harness.state.fetchCalls, 0);
});

test('a chained audited group resolves remaining uncertainty and recomputes all derived summaries', async () => {
  const harness = makeHarness();
  const apply = loadHandler('canvasApplyClassificationOverride', harness);
  const get = loadHandler('canvasGetAnalysis', harness);
  const first = await invoke(apply, {
    evidence_id: harness.snapshot.evidence_id,
    street_unit_ids: ['unit-a'],
    override_canvas_role: 'knock',
    opportunity_count: 7,
    override_reason: 'Manager confirmed seven accessible residential doors.',
  });
  const second = await invoke(apply, {
    evidence_id: harness.snapshot.evidence_id,
    parent_revision_id: first.result.revision_id,
    street_unit_ids: ['unit-d', 'unit-b'],
    override_canvas_role: 'excluded',
    override_reason: 'Manager verified this grouped pocket is non-residential.',
  });
  assert.equal(second.response.status, 200);
  assert.equal(second.result.head_version, 2);
  assert.deepEqual(second.result.street_unit_ids, ['unit-b', 'unit-d']);
  assert.deepEqual(second.result.original_classifications.map((item) => [item.street_unit_id, item.canvas_role]), [
    ['unit-b', 'uncertain'],
    ['unit-d', 'transit_only'],
  ]);

  const loaded = await invoke(get, { evidence_id: harness.snapshot.evidence_id });
  assert.equal(loaded.response.status, 200);
  assert.equal(loaded.result.revision_depth, 2);
  assert.equal(loaded.result.unresolved_unit_count, 0);
  assert.equal(loaded.result.analysis_result.deployable, true);
  assert.deepEqual(loaded.result.summary.canvas_role_counts, {
    knock: 2,
    transit_only: 0,
    excluded: 2,
    uncertain: 0,
  });
  assert.deepEqual(loaded.result.summary.opportunity_summary, { low: 11, expected: 12, high: 13 });
  assert.deepEqual(loaded.result.analysis_result.shared_transit_unit_ids, []);
  assert.deepEqual(loaded.result.analysis_result.work_units.map((item) => item.id), ['unit-a', 'unit-c']);
  assert.equal(unit(loaded.result, 'unit-b').opportunity, null);
  assert.equal(unit(loaded.result, 'unit-b').opportunity_expected, 0);
});

test('validation enforces group roles, whole-number knock workload, reason bounds, and zero-workload uncertainty', async () => {
  const harness = makeHarness();
  const apply = loadHandler('canvasApplyClassificationOverride', harness);
  const common = {
    evidence_id: harness.snapshot.evidence_id,
    override_reason: 'Manager provided a sufficiently detailed review reason.',
  };
  const groupKnock = await invoke(apply, {
    ...common,
    street_unit_ids: ['unit-a', 'unit-b'],
    override_canvas_role: 'knock',
    opportunity_count: 4,
  });
  assert.equal(groupKnock.response.status, 400);

  for (const opportunity_count of [undefined, 0, 1.5, '7']) {
    const invalid = await invoke(apply, {
      ...common,
      street_unit_ids: ['unit-a'],
      override_canvas_role: 'knock',
      ...(opportunity_count === undefined ? {} : { opportunity_count }),
    });
    assert.equal(invalid.response.status, 400);
  }
  const nonzeroContext = await invoke(apply, {
    ...common,
    street_unit_ids: ['unit-a'],
    override_canvas_role: 'excluded',
    opportunity_count: 2,
  });
  assert.equal(nonzeroContext.response.status, 400);
  const shortReason = await invoke(apply, {
    ...common,
    override_reason: 'too short',
    street_unit_ids: ['unit-a'],
    override_canvas_role: 'uncertain',
  });
  assert.equal(shortReason.response.status, 400);
  const longReason = await invoke(apply, {
    ...common,
    override_reason: 'x'.repeat(1_001),
    street_unit_ids: ['unit-a'],
    override_canvas_role: 'uncertain',
  });
  assert.equal(longReason.response.status, 400);
  const oversized = await invoke(apply, {
    ...common,
    street_unit_ids: Array.from({ length: 251 }, (_, index) => `unit-${index}`),
    override_canvas_role: 'excluded',
  });
  assert.equal(oversized.response.status, 400);
  assert.equal(harness.state.revisions.length, 0);

  const uncertain = await invoke(apply, {
    ...common,
    street_unit_ids: ['unit-a'],
    override_canvas_role: 'uncertain',
  });
  assert.equal(uncertain.response.status, 200);
  assert.equal(uncertain.result.unresolved_unit_count, 2);
  assert.equal(harness.state.revisions[0].opportunity_expected, 0);
});

test('stale parents, failed head CAS, snapshot tampering, and revision tampering all fail closed', async () => {
  const harness = makeHarness();
  const apply = loadHandler('canvasApplyClassificationOverride', harness);
  const get = loadHandler('canvasGetAnalysis', harness);
  const first = await invoke(apply, {
    evidence_id: harness.snapshot.evidence_id,
    street_unit_ids: ['unit-a'],
    override_canvas_role: 'knock',
    opportunity_count: 7,
    override_reason: 'Manager confirmed seven accessible residential doors.',
  });
  const stale = await invoke(apply, {
    evidence_id: harness.snapshot.evidence_id,
    street_unit_ids: ['unit-b'],
    override_canvas_role: 'excluded',
    override_reason: 'Manager verified this street is entirely commercial.',
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.result.error, 'classification_revision_stale_parent');
  assert.equal(harness.state.revisions.length, 1);

  harness.state.revisions[0].override_reason = 'Tampered but still long enough';
  const corruptRevision = await invoke(get, { evidence_id: harness.snapshot.evidence_id });
  assert.equal(corruptRevision.response.status, 409);
  assert.equal(corruptRevision.result.error, 'classification_revision_invalid');
  harness.state.revisions[0].override_reason = 'Manager confirmed seven accessible residential doors.';
  assert.equal(first.response.status, 200);

  harness.state.snapshots[0].analysis_result.classified_street_units[0].street_names = ['Tampered'];
  const corruptSnapshot = await invoke(apply, {
    evidence_id: harness.snapshot.evidence_id,
    parent_revision_id: first.result.revision_id,
    street_unit_ids: ['unit-b'],
    override_canvas_role: 'excluded',
    override_reason: 'Manager verified this street is entirely commercial.',
  });
  assert.equal(corruptSnapshot.response.status, 409);
  assert.equal(corruptSnapshot.result.error, 'analysis_snapshot_invalid');

  const casHarness = makeHarness();
  const casApply = loadHandler('canvasApplyClassificationOverride', casHarness);
  casHarness.state.forceHeadConflict = true;
  const conflict = await invoke(casApply, {
    evidence_id: casHarness.snapshot.evidence_id,
    street_unit_ids: ['unit-a'],
    override_canvas_role: 'knock',
    opportunity_count: 7,
    override_reason: 'Manager confirmed seven accessible residential doors.',
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.result.error, 'classification_revision_stale_head');
  assert.equal(casHarness.state.heads[0].version, 1);
  assert.equal(casHarness.state.revisions.length, 1, 'append-only orphan is safe when a competing head wins');
});

test('revision endpoints are self-contained, Base44-only, tenant-filtered, append-only, and CAS guarded', () => {
  const applySource = readFileSync(resolve(rootDirectory, 'base44/functions/canvasApplyClassificationOverride/entry.ts'), 'utf8');
  const getSource = readFileSync(resolve(rootDirectory, 'base44/functions/canvasGetAnalysis/entry.ts'), 'utf8');
  for (const source of [applySource, getSource]) {
    assert.match(source, /firstknock-canvas-classification-revision-v1/);
    assert.match(source, /CanvasClassificationRevision\.filter\(\{[\s\S]*?manager_id:/);
    assert.match(source, /CanvasClassificationRevisionHead\.filter\(\{[\s\S]*?manager_id:/);
    assert.doesNotMatch(source, /from ["']\.\.?\//);
    assert.doesNotMatch(source, /@neondatabase|DATABASE_URL|Precision|MasterProperty/);
    assert.doesNotMatch(source, /entities\.User|User\.updateMany/);
  }
  assert.match(applySource, /MAX_GROUP_UNITS = 250/);
  assert.match(applySource, /CanvasAnalysisSnapshot\.filter\(\{[\s\S]*?manager_id: user\.id/);
  assert.match(applySource, /CanvasClassificationRevision\.create\(record\)/);
  assert.doesNotMatch(applySource, /CanvasClassificationRevision\.(?:update|updateMany|delete)/);
  assert.match(applySource, /CanvasClassificationRevisionHead\.updateMany\(\{[\s\S]*?version: expectedHeadVersion/);
  assert.doesNotMatch(applySource, /\bfetch\s*\(|CANVAS_ANALYSIS_SERVICE|OVERPASS/);
  assert.match(getSource, /resolveRevisionReplay/);
  assert.match(getSource, /classification_revision_parent_mismatch/);
});
