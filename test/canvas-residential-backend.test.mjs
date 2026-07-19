import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const entity = (name) => JSON.parse(read(`base44/entities/${name}.jsonc`));

function canonicalizeForHash(value) {
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalizeForHash(value[key])]));
}

async function canonicalHash(value) {
  const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonicalizeForHash(value))));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function matches(row, filter = {}) {
  return Object.entries(filter).every(([field, expected]) => {
    if (field === '$or') return expected.some((candidate) => matches(row, candidate));
    if (field === '$and') return expected.every((candidate) => matches(row, candidate));
    const actual = row[field];
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('$in' in expected) return expected.$in.includes(actual);
      if ('$exists' in expected) return expected.$exists ? actual !== undefined : actual === undefined;
      if ('$lte' in expected) return actual !== undefined && actual <= expected.$lte;
      if ('$gte' in expected) return actual !== undefined && actual >= expected.$gte;
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
      return rows.filter((row) => matches(row, filter)).slice(skip, skip + limit);
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
    }
  };
}

function loadHandler(path, { base44, fetchImpl = fetch, env = {} }) {
  const transpiled = ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: path, reportDiagnostics: true });
  assert.deepEqual((transpiled.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error), []);
  let handler;
  vm.runInNewContext(transpiled.outputText.replace(/^import .*;\s*$/gm, ''), {
    console, createClientFromRequest: () => base44, crypto: webcrypto, TextEncoder, TextDecoder,
    Request, Response, URL, URLSearchParams, AbortController, fetch: fetchImpl, setTimeout, clearTimeout, structuredClone,
    Deno: { env: { get: (key) => env[key] ?? null }, serve: (registered) => { handler = registered; } }
  }, { filename: path });
  return handler;
}

async function invoke(handler, body) {
  const response = await handler(new Request('https://example.test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { response, body: await response.json() };
}

test('residential Canvas persistence is isolated, content-addressed, and manager scoped', () => {
  const snapshot = entity('CanvasAnalysisSnapshot');
  const revision = entity('CanvasClassificationRevision');
  const head = entity('CanvasClassificationRevisionHead');
  for (const schema of [snapshot, revision, head]) {
    assert.deepEqual(schema.rls.create, { user_condition: { role: 'admin' } });
    assert.deepEqual(schema.rls.read.$or[0], { manager_id: '{{user.id}}' });
  }
  assert.deepEqual(snapshot.rls.update, { user_condition: { id: '__immutable_canvas_analysis_snapshot__' } });
  assert.deepEqual(snapshot.rls.delete, { user_condition: { id: '__immutable_canvas_analysis_snapshot__' } });
  assert.deepEqual(revision.rls.update, { user_condition: { id: '__append_only_canvas_classification_revision__' } });
  assert.deepEqual(revision.rls.delete, { user_condition: { id: '__append_only_canvas_classification_revision__' } });
  assert.deepEqual(head.rls.update, { user_condition: { role: 'admin' } });
  assert.ok(snapshot.required.includes('evidence_id'));
  assert.ok(snapshot.required.includes('snapshot_hash'));
  assert.ok(revision.required.includes('revision_id'));
  assert.ok(revision.required.includes('revision_hash'));
  assert.ok(revision.properties.parent_revision_id);
  assert.equal(revision.properties.street_unit_ids.maxItems, 250);
  assert.equal(revision.properties.original_classifications.maxItems, 250);
  assert.ok(head.properties.head_revision_id);
  assert.ok(head.properties.version);
});

test('server analysis is bounded, server-side, canonical, and development fallback is explicit', () => {
  const source = read('base44/functions/canvasStartAnalysis/entry.ts');
  assert.match(source, /MAX_AREA_SQ_MI = 50/);
  assert.match(source, /MAX_OSM_BYTES = 6_000_000/);
  assert.match(source, /MAX_OSM_ELEMENTS = 150_000/);
  assert.match(source, /MAX_SNAPSHOT_BYTES = 7_500_000/);
  assert.match(source, /CANVAS_OVERPASS_URL/);
  assert.match(source, /CANVAS_ALLOW_PUBLIC_OVERPASS_FALLBACK['"]\) === ['"]true['"]/);
  assert.match(source, /crypto\.subtle\.digest\(['"]SHA-256['"]/);
  assert.match(source, /CanvasAnalysisSnapshot\.create/);
  assert.match(source, /evidence_id: evidenceId, manager_id: managerId/);
  assert.match(source, /semidetached_house/);
  assert.doesNotMatch(source, /residentialHighway \|\| expected/);
  assert.match(source, /function buildClippedStreetUnits\(/);
  assert.match(source, /function associatedStreetHints\(/);
  assert.match(source, /function addressEvidenceKeys\(/);
  assert.match(source, /protected_group_id: protectedGroupId/);
  assert.match(source, /association_distance_meters: selected\.distance_meters/);
  assert.match(source, /const canvasRole = access === 'restricted' \? 'excluded'/);
});

test('direct analysis rejects insecure or implicit public providers and labels the explicit fallback untrusted', async () => {
  const sequence = { value: 0 };
  const user = { id: 'manager_provider_policy', role: 'admin', app_role: 'manager' };
  const rep = { id: 'rep_provider_policy', email: 'rep-provider@example.com', role: 'user', app_role: 'rep', team_manager_id: user.id };
  const state = {
    snapshots: [], heads: [], revisions: [], sessions: [], users: [user, rep],
    members: [{ id: 'tm_provider_policy', manager_id: user.id, user_id: rep.id, email: rep.email, role: 'rep', status: 'active' }]
  };
  const entities = {
    CanvasAnalysisSnapshot: memoryEntity(state.snapshots, 'snapshot', sequence),
    CanvasClassificationRevisionHead: memoryEntity(state.heads, 'head', sequence),
    CanvasClassificationRevision: memoryEntity(state.revisions, 'revision', sequence),
    CanvasSession: memoryEntity(state.sessions, 'session', sequence),
    TeamMember: memoryEntity(state.members, 'member', sequence),
    User: memoryEntity(state.users, 'user', sequence)
  };
  const base44 = { auth: { me: async () => user }, entities, asServiceRole: { entities } };
  const polygon = [{ lat: 35, lng: -82 }, { lat: 35, lng: -81.999 }, { lat: 35.001, lng: -81.999 }, { lat: 35.001, lng: -82 }];
  const fetchImpl = async () => new Response(JSON.stringify({
    osm3s: { timestamp_osm_base: '2026-07-19T00:00:00Z' },
    elements: [
      { type: 'node', id: 1, lat: 35.0004, lon: -82 },
      { type: 'node', id: 2, lat: 35.0004, lon: -81.999 },
      { type: 'node', id: 3, lat: 35.00055, lon: -81.9998, tags: { building: 'house', 'addr:housenumber': '1', 'addr:street': 'Fallback Street' } },
      { type: 'way', id: 100, nodes: [1, 2], tags: { highway: 'residential', name: 'Fallback Street' } }
    ]
  }), { status: 200 });
  const insecure = loadHandler('base44/functions/canvasStartAnalysis/entry.ts', {
    base44, fetchImpl, env: { CANVAS_OVERPASS_URL: 'http://osm.internal.example/api/interpreter' }
  });
  const insecureResult = await invoke(insecure, { polygon });
  assert.equal(insecureResult.response.status, 503);
  assert.equal(insecureResult.body.error, 'canvas_analysis_provider_not_private');
  const implicitPublic = loadHandler('base44/functions/canvasStartAnalysis/entry.ts', {
    base44, fetchImpl, env: { CANVAS_OVERPASS_URL: 'https://overpass-api.de/api/interpreter' }
  });
  const implicitResult = await invoke(implicitPublic, { polygon });
  assert.equal(implicitResult.response.status, 503);
  assert.equal(implicitResult.body.error, 'canvas_analysis_provider_not_private');
  const explicitPublic = loadHandler('base44/functions/canvasStartAnalysis/entry.ts', {
    base44, fetchImpl, env: {
      CANVAS_OVERPASS_URL: 'https://overpass-api.de/api/interpreter',
      CANVAS_ALLOW_PUBLIC_OVERPASS_FALLBACK: 'true'
    }
  });
  const explicitResult = await invoke(explicitPublic, { polygon });
  assert.equal(explicitResult.response.status, 200, JSON.stringify(explicitResult.body));
  assert.equal(explicitResult.body.provider, 'openstreetmap-public-development-fallback');
  assert.equal(explicitResult.body.summary.development_fallback, true);
  assert.equal(state.snapshots[0].provider, 'openstreetmap-public-development-fallback');
  const unit = state.snapshots[0].analysis_result.street_units[0];
  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44 });
  const saved = await invoke(save, {
    territory_model: 'residential_street_territory_v2', evidence_id: explicitResult.body.evidence_id,
    snapshot_hash: explicitResult.body.snapshot_hash, revision_id: null, session_name: 'Development evidence draft',
    polygon: state.snapshots[0].polygon, planning_method: 'street_workload', assignment_basis: 'street_work_unit_ids',
    workload_basis: 'residential_opportunity', division_mode: 'area_count', selected_team_member_ids: [],
    work_units: [unit],
    zones: [{ zone_id: 'zone_dev', zone_number: 1, geometry_role: 'display_only', work_unit_ids: [unit.unit_id], assigned_team_member_id: null, street_length_meters: unit.street_length_meters, workload_score: unit.opportunity_expected }],
    qa: { connected_zones: true, atomic_work_units: true, protected_units_intact: true, cul_de_sac_splits: 0 }
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.qa.evidence_trust, 'development_fallback');
  assert.equal(saved.body.qa.trusted_evidence, false);
  const assign = loadHandler('base44/functions/canvasAssignTerritories/entry.ts', { base44 });
  const assigned = await invoke(assign, {
    session_id: saved.body.session_id, expected_version: saved.body.version, expected_assignment_version: 0,
    assignments: [{ zone_id: 'zone_dev', assigned_team_member_id: 'tm_provider_policy' }]
  });
  assert.equal(assigned.response.status, 200, JSON.stringify(assigned.body));
  assert.equal(assigned.body.lifecycle_state, 'partially_assigned');
  assert.equal(assigned.body.ready_to_send, false);
});

test('analysis reads and overrides replay canonical tenant-owned revision chains', () => {
  const get = read('base44/functions/canvasGetAnalysis/entry.ts');
  const override = read('base44/functions/canvasApplyClassificationOverride/entry.ts');
  assert.match(get, /CanvasAnalysisSnapshot\.filter\(\{ evidence_id: evidenceId, manager_id: managerId \}/);
  assert.match(get, /revision\.revision_id !== `canvas_revision_\$\{calculatedHash\}`/);
  assert.match(get, /applyRevisions\(snapshot\.analysis_result, revisions\)/);
  assert.match(override, /override_reason/);
  assert.match(override, /revision_head_conflict/);
  assert.match(override, /CanvasClassificationRevisionHead\.updateMany/);
  assert.match(override, /version: Number\(head\.version \|\| 0\)/);
  assert.match(override, /invalid_classification_combination/);
  assert.match(override, /explicit_opportunity_required/);
  assert.match(override, /group_override_role_invalid/);
  assert.match(override, /group_override_requires_uncertain_units/);
  assert.match(override, /revision_chain_limit/);
  assert.match(override, /schema_version: grouped \? 2 : 1/);
  assert.match(override, /CanvasClassificationRevisionHead\.updateMany/);
  assert.doesNotMatch(override, /for \(const unitId of requestedTargetIds\).*CanvasClassificationRevision\.create/s);
  assert.match(get, /for \(const streetUnitId of revisionTargetUnitIds\(revision\)\)/);
  assert.match(override, /unresolved_unit_count: unresolvedUnitCount/);
});

test('save and assign preserve v1 while enforcing the v2 assign-later lifecycle', () => {
  const session = entity('CanvasSession');
  const save = read('base44/functions/canvasSaveDraft/entry.ts');
  const assign = read('base44/functions/canvasAssignTerritories/entry.ts');
  assert.deepEqual(session.properties.territory_model.enum, ['street_territory_v1', 'residential_street_territory_v2']);
  for (const state of ['saved_unassigned', 'partially_assigned', 'ready_to_send', 'active']) assert.ok(session.properties.lifecycle_state.enum.includes(state));
  assert.match(save, /loadResidentialEvidence\(base44, String\(user\.id\), evidenceId, snapshotHash, revisionId\)/);
  assert.match(save, /evidence_identity_immutable/);
  assert.match(save, /saved_unassigned/);
  assert.match(save, /partially_assigned/);
  assert.match(save, /ready_to_send/);
  assert.match(save, /residentialZonesConnected\(workUnits, zones\)/);
  assert.match(save, /for \(const streetUnitId of revisionTargetUnitIds\(revision\)\)/);
  assert.match(assign, /manager_id: managerId, id: \{ \$in: ids \}/);
  assert.match(assign, /expected_assignment_version/);
  assert.match(assign, /qa\.no_missing_work_units === true/);
  assert.match(assign, /CanvasSession\.updateMany/);
  assert.match(assign, /assignment_version: expectedAssignmentVersion/);
});

test('deployment replays pinned evidence and pins are limited to owned knock units', () => {
  const deploy = read('base44/functions/canvasDeployCampaign/entry.ts');
  const log = read('base44/functions/canvasLogHouseDecision/entry.ts');
  const map = read('base44/functions/canvasGetCampaignMap/entry.ts');
  assert.match(deploy, /verifyResidentialEvidence\(base44, session\)/);
  assert.match(deploy, /CanvasClassificationRevision\.filter\(\{ revision_id: cursor, manager_id: session\.manager_id, evidence_id: session\.evidence_id \}/);
  assert.match(deploy, /evidence_replay_mismatch/);
  assert.match(deploy, /public_overpass_used_during_deploy: false/);
  assert.match(deploy, /session\.lifecycle_state !== ["']ready_to_send["']/);
  assert.match(deploy, /verifyResidentialZoneTopology\(effectiveUnits, session\.zones\)/);
  assert.match(deploy, /for \(const streetUnitId of residentialRevisionTargetUnitIds\(revision\)\)/);
  assert.match(log, /candidate\.canvas_role === ["']knock["']/);
  assert.match(log, /street_unit_id: roadOwnership\.street_unit_id/);
  assert.match(log, /evidence_id: session\.evidence_id \|\| null/);
  assert.match(map, /session\.territory_model === ["']residential_street_territory_v2["']/);
  assert.match(map, /assignment_version/);
});

test('audited amber groups commit and replay as one bounded atomic revision', async () => {
  const sequence = { value: 0 };
  const manager = { id: 'manager_group', email: 'manager-group@example.com', role: 'admin', app_role: 'manager' };
  const rep = { id: 'rep_group', email: 'rep-group@example.com', role: 'user', app_role: 'rep', team_manager_id: manager.id };
  const state = {
    snapshots: [], revisions: [], heads: [], sessions: [], pins: [], events: [], decisionCampaignStates: [], decisionZoneStates: [],
    members: [{ id: 'tm_group', manager_id: manager.id, user_id: rep.id, email: rep.email, role: 'rep', status: 'active' }],
    users: [manager, rep]
  };
  const entities = {
    CanvasAnalysisSnapshot: memoryEntity(state.snapshots, 'snapshot', sequence),
    CanvasClassificationRevision: memoryEntity(state.revisions, 'revision', sequence),
    CanvasClassificationRevisionHead: memoryEntity(state.heads, 'head', sequence),
    CanvasSession: memoryEntity(state.sessions, 'session', sequence),
    CanvasHousePin: memoryEntity(state.pins, 'pin', sequence),
    CanvasHouseEvent: memoryEntity(state.events, 'event', sequence),
    CanvasDecisionCampaignState: memoryEntity(state.decisionCampaignStates, 'decision-campaign', sequence),
    CanvasDecisionZoneState: memoryEntity(state.decisionZoneStates, 'decision-zone', sequence),
    TeamMember: memoryEntity(state.members, 'member', sequence),
    User: memoryEntity(state.users, 'user', sequence)
  };
  let actor = manager;
  const base44 = { auth: { me: async () => actor }, entities, asServiceRole: { entities } };
  const polygon = [
    { lat: 35, lng: -82 },
    { lat: 35, lng: -81.99 },
    { lat: 35.01, lng: -81.99 },
    { lat: 35.01, lng: -82 }
  ];
  const segment = (edgeId, start, end) => ({
    edge_id: edgeId,
    start,
    end,
    street_names: ['Audit Street'],
    length_meters: 100
  });
  const streetUnits = [
    {
      id: 'street_knock', unit_id: 'street_knock', kind: 'residential', canvas_role: 'knock',
      opportunity_classification: 'likely', access_classification: 'permitted',
      opportunity_low: 5, opportunity_expected: 5, opportunity_high: 5,
      opportunity_source: 'deduplicated_addresses', confidence: 'high', protected: false,
      street_names: ['Audit Street'], neighbor_ids: ['street_amber_a'], street_length_meters: 100,
      segments: [segment('edge_knock', { lat: 35.002, lng: -81.999 }, { lat: 35.002, lng: -81.998 })]
    },
    {
      id: 'street_amber_a', unit_id: 'street_amber_a', kind: 'residential', canvas_role: 'uncertain',
      opportunity_classification: 'uncertain', access_classification: 'uncertain',
      opportunity_low: 0, opportunity_expected: 0, opportunity_high: 0,
      opportunity_source: 'none', confidence: 'uncertain', protected: false,
      street_names: ['Audit Street'], neighbor_ids: ['street_knock', 'street_amber_b'], street_length_meters: 100,
      segments: [segment('edge_amber_a', { lat: 35.002, lng: -81.998 }, { lat: 35.002, lng: -81.997 })]
    },
    {
      id: 'street_amber_b', unit_id: 'street_amber_b', kind: 'residential', canvas_role: 'uncertain',
      opportunity_classification: 'uncertain', access_classification: 'uncertain',
      opportunity_low: 0, opportunity_expected: 0, opportunity_high: 0,
      opportunity_source: 'none', confidence: 'uncertain', protected: false,
      street_names: ['Audit Street'], neighbor_ids: ['street_amber_a'], street_length_meters: 100,
      segments: [segment('edge_amber_b', { lat: 35.002, lng: -81.997 }, { lat: 35.002, lng: -81.996 })]
    }
  ];
  const snapshotContent = {
    schema_version: 1,
    manager_id: manager.id,
    provider: 'openstreetmap-contracted-or-self-hosted',
    source_version: 'test-source-v1',
    extraction_version: 'test-extraction-v1',
    classifier_version: 'test-classifier-v1',
    polygon,
    raw_evidence: { elements: [] },
    analysis_result: {
      territory_model: 'residential_street_territory_v2',
      street_units: streetUnits,
      unresolved_unit_count: 2,
      opportunity_total_expected: 5
    },
    source_attribution: '© OpenStreetMap contributors'
  };
  const snapshotHash = await canonicalHash(snapshotContent);
  const evidenceId = `canvas_evidence_${snapshotHash}`;
  state.snapshots.push({
    ...structuredClone(snapshotContent),
    id: 'snapshot_group',
    evidence_id: evidenceId,
    snapshot_hash: snapshotHash,
    status: 'complete',
    created_by_user_id: manager.id,
    created_at: new Date().toISOString()
  });

  const override = loadHandler('base44/functions/canvasApplyClassificationOverride/entry.ts', { base44 });
  const targetIds = ['street_amber_b', 'street_amber_a'];
  const invalidResidential = await invoke(override, {
    evidence_id: evidenceId,
    street_unit_ids: targetIds,
    override_canvas_role: 'knock',
    opportunity_count: 10,
    override_reason: 'Grouped residential counts are not legal.'
  });
  assert.equal(invalidResidential.response.status, 422);
  assert.equal(invalidResidential.body.error, 'group_override_role_invalid');
  assert.equal(state.revisions.length, 0);

  const oversized = await invoke(override, {
    evidence_id: evidenceId,
    street_unit_ids: Array.from({ length: 251 }, (_, index) => `street_${index}`),
    override_canvas_role: 'excluded',
    override_reason: 'This group exceeds the safe atomic bound.'
  });
  assert.equal(oversized.response.status, 413);
  assert.equal(oversized.body.error, 'override_group_too_large');
  assert.equal(state.revisions.length, 0);

  const mixedReviewedState = await invoke(override, {
    evidence_id: evidenceId,
    street_unit_ids: ['street_knock', 'street_amber_a'],
    override_canvas_role: 'transit_only',
    override_reason: 'Bulk review must not overwrite a non-amber unit.'
  });
  assert.equal(mixedReviewedState.response.status, 422);
  assert.equal(mixedReviewedState.body.error, 'group_override_requires_uncertain_units');
  assert.equal(state.revisions.length, 0);

  const atomicPayload = {
    evidence_id: evidenceId,
    parent_revision_id: null,
    street_unit_ids: targetIds,
    override_canvas_role: 'transit_only',
    override_opportunity_classification: 'none',
    override_access_classification: 'permitted',
    override_reason: 'Manager audited all ambiguous segments on Audit Street as legal transit with no doors.'
  };
  const updateRevisionHead = entities.CanvasClassificationRevisionHead.updateMany;
  entities.CanvasClassificationRevisionHead.updateMany = async () => ({ success: true, updated: 0, has_more: false });
  const conflicted = await invoke(override, atomicPayload);
  entities.CanvasClassificationRevisionHead.updateMany = updateRevisionHead;
  assert.equal(conflicted.response.status, 409);
  assert.equal(conflicted.body.error, 'revision_head_conflict');
  assert.equal(state.revisions.length, 1, 'a failed head CAS may leave only an unreachable immutable revision');
  assert.equal(state.heads[0].head_revision_id, null);
  const get = loadHandler('base44/functions/canvasGetAnalysis/entry.ts', { base44 });
  const unchanged = await invoke(get, { evidence_id: evidenceId });
  assert.equal(unchanged.response.status, 200, JSON.stringify(unchanged.body));
  assert.equal(unchanged.body.evidence.analysis_result.unresolved_unit_count, 2,
    'a failed group head CAS exposes none of the target changes');

  const applied = await invoke(override, atomicPayload);
  assert.equal(applied.response.status, 200, JSON.stringify(applied.body));
  assert.equal(applied.body.idempotent, true, 'retry reuses the content-addressed orphan and advances the head once');
  assert.deepEqual(applied.body.street_unit_ids, ['street_amber_a', 'street_amber_b']);
  assert.equal(applied.body.target_count, 2);
  assert.equal(applied.body.unresolved_unit_count, 0);
  assert.equal(state.revisions.length, 1, 'one group produces one immutable revision record');
  assert.equal(state.revisions[0].schema_version, 2);
  assert.deepEqual(state.revisions[0].street_unit_ids, ['street_amber_a', 'street_amber_b']);
  assert.equal(state.revisions[0].original_classifications.length, 2);
  assert.equal(state.heads.length, 1);
  assert.equal(state.heads[0].version, 1, 'one group advances the revision head once');

  actor = { id: 'other_manager', email: 'other@example.com', role: 'admin', app_role: 'manager' };
  const crossTenant = await invoke(override, {
    evidence_id: evidenceId,
    parent_revision_id: null,
    street_unit_id: 'street_knock',
    override_canvas_role: 'excluded',
    override_reason: 'Cross-tenant attempts must fail.'
  });
  assert.equal(crossTenant.response.status, 404);
  assert.equal(state.revisions.length, 1);
  actor = manager;

  const replayed = await invoke(get, { evidence_id: evidenceId, revision_id: applied.body.revision_id });
  assert.equal(replayed.response.status, 200, JSON.stringify(replayed.body));
  assert.equal(replayed.body.revision_chain.length, 1);
  assert.equal(replayed.body.revision_chain[0].target_count, 2);
  const effectiveUnits = replayed.body.evidence.analysis_result.street_units;
  assert.ok(effectiveUnits.filter((unit) => unit.unit_id.startsWith('street_amber_'))
    .every((unit) => unit.canvas_role === 'transit_only'));

  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44 });
  const saved = await invoke(save, {
    territory_model: 'residential_street_territory_v2',
    evidence_id: evidenceId,
    snapshot_hash: snapshotHash,
    revision_id: applied.body.revision_id,
    session_name: 'Atomic Amber Group Campaign',
    polygon,
    planning_method: 'street_workload',
    assignment_basis: 'street_work_unit_ids',
    workload_basis: 'residential_opportunity',
    division_mode: 'area_count',
    selected_team_member_ids: ['tm_group'],
    work_units: effectiveUnits,
    zones: [{
      zone_id: 'canvas-residential-zone:1', zone_number: 1, geometry_role: 'display_only',
      work_unit_ids: ['street_knock'], assigned_team_member_id: 'tm_group',
      street_length_meters: 100, workload_score: 5
    }],
    qa: { connected_zones: true, atomic_work_units: true, protected_units_intact: true, cul_de_sac_splits: 0 }
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.lifecycle_state, 'ready_to_send');
  assert.equal(state.sessions[0].revision_id, applied.body.revision_id);

  const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', {
    base44,
    env: { CANVAS_DEPLOYMENT_SIGNING_SECRET: 'test-atomic-group-signing-secret-32-bytes' }
  });
  const deployed = await invoke(deploy, {
    session_id: saved.body.session_id,
    expected_version: saved.body.version,
    idempotency_key: 'deploy:atomic-amber-group'
  });
  assert.equal(deployed.response.status, 200, JSON.stringify(deployed.body));
  assert.equal(deployed.body.status, 'deployed');
  assert.equal(state.sessions[0].deployment_qa.revision_count, 1);
  assert.equal(state.sessions[0].deployment_qa.evidence_replay_verified, true);
});

test('server classifier clips stable street edges and applies v1.1 residential evidence precedence', async () => {
  const sequence = { value: 0 };
  const user = { id: 'manager_classifier', email: 'classifier@example.com', role: 'admin', app_role: 'manager' };
  const state = { snapshots: [], revisions: [], heads: [], users: [user] };
  const entities = {
    CanvasAnalysisSnapshot: memoryEntity(state.snapshots, 'snapshot', sequence),
    CanvasClassificationRevision: memoryEntity(state.revisions, 'revision', sequence),
    CanvasClassificationRevisionHead: memoryEntity(state.heads, 'head', sequence),
    User: memoryEntity(state.users, 'user', sequence)
  };
  const base44 = { auth: { me: async () => user }, entities, asServiceRole: { entities } };
  const elements = [];
  const addRoad = (id, lat, tags = {}) => {
    const nodeIds = [id * 100 + 1, id * 100 + 2, id * 100 + 3, id * 100 + 4];
    [-82.002, -81.999, -81.995, -81.988].forEach((lon, index) => {
      elements.push({ type: 'node', id: nodeIds[index], lat, lon });
    });
    elements.push({ type: 'way', id, nodes: nodeIds, tags: { highway: 'residential', name: `Road ${id}`, ...tags } });
    return nodeIds;
  };
  addRoad(100, 35.0005, { access: 'private', foot: 'yes' });
  addRoad(200, 35.0017);
  addRoad(300, 35.0029);
  addRoad(400, 35.0041);
  addRoad(500, 35.0053);
  addRoad(600, 35.0065, { access: 'yes', foot: 'no' });
  addRoad(700, 35.0077);
  addRoad(900, 35.0089);
  elements.push(
    { type: 'node', id: 100001, lat: 35.00055, lon: -81.997, tags: { 'addr:housenumber': '12', 'addr:unit': 'A', 'addr:street': 'Road 100' } },
    { type: 'node', id: 100002, lat: 35.00056, lon: -81.9971, tags: { 'addr:housenumber': '12', 'addr:unit': 'A', 'addr:street': 'Road 100' } },
    { type: 'node', id: 100003, lat: 35.00045, lon: -81.9966, tags: { 'building:units': '3' } },
    { type: 'node', id: 100004, lat: 35.0006, lon: -81.9968, tags: { building: 'apartments', entrance: 'main' } },
    { type: 'node', id: 100004, lat: 35.0006, lon: -81.9968, tags: { building: 'apartments', entrance: 'main' } },
    { type: 'node', id: 200001, lat: 35.00175, lon: -81.997, tags: { building: 'yes', 'building:units': '4', 'addr:housenumber': '20' } },
    { type: 'node', id: 300001, lat: 35.00295, lon: -81.997, tags: { landuse: 'grass' } },
    { type: 'node', id: 400001, lat: 35.00415, lon: -81.997, tags: { shop: 'supermarket' } },
    { type: 'node', id: 400002, lat: 35.00405, lon: -81.9968, tags: { building: 'house' } },
    { type: 'node', id: 500001, lat: 35.00535, lon: -81.997, tags: { building: 'commercial', 'building:use': 'mixed', shop: 'convenience' } },
    { type: 'node', id: 600001, lat: 35.00655, lon: -81.997, tags: { building: 'house' } },
    { type: 'node', id: 700001, lat: 35.00775, lon: -81.997, tags: { building: 'house' } },
    { type: 'node', id: 700002, lat: 35.00772, lon: -81.9968, tags: { barrier: 'gate' } },
    { type: 'node', id: 900001, tags: { 'building:units': '2' } },
    { type: 'node', id: 900002, tags: { building: 'apartments', entrance: 'main' } },
    { type: 'relation', id: 990000, members: [
      { type: 'way', ref: 900, role: 'street' },
      { type: 'node', ref: 900001, role: 'house' },
      { type: 'node', ref: 900002, role: 'house' }
    ], tags: { type: 'associatedStreet', name: 'Road 900' } }
  );
  const culdesacNodes = [95001, 95002, 95003, 95004];
  [[35.0101, -81.9985], [35.0101, -81.9975], [35.0101, -81.9965], [35.0101, -81.9955]].forEach(([lat, lon], index) => {
    elements.push({ type: 'node', id: culdesacNodes[index], lat, lon,
      ...(index === 0 ? { tags: { highway: 'turning_circle' } } : {}) });
  });
  elements.push({ type: 'way', id: 950, nodes: culdesacNodes, tags: { highway: 'residential', name: 'Protected Court' } });
  const footwayNodes = [98001, 98002];
  elements.push(
    { type: 'node', id: footwayNodes[0], lat: 35.0003, lon: -81.997 },
    { type: 'node', id: footwayNodes[1], lat: 35.0007, lon: -81.997 },
    { type: 'way', id: 980, nodes: footwayNodes, tags: { highway: 'footway' } }
  );
  const osm = { osm3s: { timestamp_osm_base: '2026-07-18T00:00:00Z' }, elements };
  const start = loadHandler('base44/functions/canvasStartAnalysis/entry.ts', {
    base44,
    env: { CANVAS_OVERPASS_URL: 'https://osm.example.test' },
    fetchImpl: async () => new Response(JSON.stringify(osm), { status: 200, headers: { 'content-type': 'application/json' } })
  });
  const polygon = [
    { lat: 34.9995, lng: -82 }, { lat: 34.9995, lng: -81.99 },
    { lat: 35.011, lng: -81.99 }, { lat: 35.011, lng: -82 }
  ];
  const started = await invoke(start, { polygon });
  assert.equal(started.response.status, 200, JSON.stringify(started.body));
  const units = state.snapshots[0].analysis_result.street_units;
  const roadUnits = (roadId) => units.filter((unit) => unit.unit_id === `osm_way_${roadId}`
    || unit.unit_id.startsWith(`osm_block_${roadId}_`));
  assert.equal(roadUnits(100).length, 1, 'degree-2 curve nodes must coalesce into one clipped block face');
  assert.equal(roadUnits(100)[0].segments.length, 3);
  assert.match(roadUnits(100)[0].unit_id, /^osm_block_100_/);
  assert.equal(roadUnits(980).length, 0, 'pedestrian-only ways are context, not amber street units');
  for (const unit of units) for (const segment of unit.segments) {
    for (const point of [segment.start, segment.end]) {
      assert.ok(point.lng >= -82.0000001 && point.lng <= -81.9899999, JSON.stringify(segment));
      assert.ok(point.lat >= 34.9994999 && point.lat <= 35.0110001, JSON.stringify(segment));
    }
  }
  assert.ok(roadUnits(100).every((unit) => unit.protected === false), 'artificial boundary cuts are not terminals');
  const counted = roadUnits(100).find((unit) => unit.opportunity_expected === 12);
  assert.ok(counted, JSON.stringify(roadUnits(100)));
  assert.equal(counted.access_classification, 'restricted', 'an explicit access denial outranks an allowed foot signal');
  assert.equal(counted.canvas_role, 'excluded');
  assert.deepEqual(counted.opportunity_features.map((feature) => feature.source).sort(),
    ['deduplicated_addresses', 'explicit_building_units', 'multi_unit_proxy']);
  assert.ok(counted.opportunity_features.every((feature) => 'association_distance_meters' in feature));
  const ambiguousBuilding = roadUnits(200).find((unit) => unit.opportunity_classification === 'uncertain');
  assert.ok(ambiguousBuilding);
  assert.equal(ambiguousBuilding.opportunity_expected, 0, 'building=yes cannot promote generic address/unit evidence');
  assert.equal(roadUnits(300).find((unit) => unit.opportunity_classification === 'none')?.canvas_role, 'excluded');
  assert.equal(roadUnits(400).find((unit) => unit.opportunity_expected === 1)?.opportunity_classification, 'likely',
    'residential evidence wins over co-located commercial evidence');
  assert.equal(roadUnits(500).find((unit) => unit.opportunity_expected === 8)?.canvas_role, 'knock',
    'mixed-use residential opportunity is retained');
  const restricted = roadUnits(600).find((unit) => unit.opportunity_expected === 1);
  assert.equal(restricted?.access_classification, 'restricted');
  assert.equal(restricted?.canvas_role, 'excluded', 'explicit pedestrian denial wins');
  const gated = roadUnits(700).find((unit) => unit.opportunity_expected === 1);
  assert.equal(gated?.access_classification, 'uncertain');
  assert.equal(gated?.canvas_role, 'uncertain', 'an unsigned gate is not an automatic restriction');
  const relationCount = roadUnits(900).find((unit) => unit.opportunity_expected === 10);
  assert.ok(relationCount, JSON.stringify(roadUnits(900)));
  assert.ok(relationCount.opportunity_features.every((feature) => feature.association_distance_meters === null));
  const protectedBranch = roadUnits(950);
  assert.equal(protectedBranch.length, 1);
  assert.equal(protectedBranch[0].segments.length, 3);
  assert.ok(protectedBranch.every((unit) => unit.protected));
  assert.equal(new Set(protectedBranch.map((unit) => unit.protected_group_id)).size, 1,
    'all edges in a multi-edge cul-de-sac carry one stable protected group');

});

test('server classifier builds block faces, filters service context, and resolves hierarchical frontage evidence', async () => {
  const elements = [
    { type: 'node', id: 1, lat: 35.002, lon: -81.999 },
    { type: 'node', id: 2, lat: 35.0021, lon: -81.997 },
    { type: 'node', id: 3, lat: 35.002, lon: -81.995 },
    { type: 'node', id: 4, lat: 35.0019, lon: -81.993 },
    { type: 'node', id: 5, lat: 35.002, lon: -81.991 },
    { type: 'node', id: 6, lat: 35.001, lon: -81.995 },
    { type: 'node', id: 7, lat: 35.003, lon: -81.995 },
    { type: 'way', id: 1000, nodes: [1, 2, 3, 4, 5], tags: { highway: 'residential', name: 'Curved Street' } },
    { type: 'way', id: 1001, nodes: [6, 3, 7], tags: { highway: 'residential', name: 'Cross Street' } },

    { type: 'node', id: 10, lat: 35.00275, lon: -81.997, tags: { building: 'house', entrance: 'main' } },
    { type: 'way', id: 1100, nodes: [2, 10], tags: { highway: 'service', service: 'driveway' } },
    { type: 'node', id: 11, lat: 35.0026, lon: -81.993 },
    { type: 'way', id: 1101, nodes: [4, 11], tags: { highway: 'service', service: 'parking_aisle' } },
    { type: 'node', id: 12, lat: 35.00265, lon: -81.996 },
    { type: 'way', id: 1102, nodes: [2, 12], tags: { highway: 'service', service: 'drive-through' } },
    { type: 'node', id: 13, lat: 35.00265, lon: -81.994 },
    { type: 'way', id: 1103, nodes: [4, 13], tags: { highway: 'service', service: 'emergency_access' } },
    { type: 'node', id: 14, lat: 35.004, lon: -81.998 },
    { type: 'node', id: 15, lat: 35.004, lon: -81.996 },
    { type: 'way', id: 1110, nodes: [14, 15], tags: { highway: 'service', service: 'alley', name: 'Public Alley', access: 'yes' } },
    { type: 'node', id: 16, lat: 35.0045, lon: -81.998 },
    { type: 'node', id: 17, lat: 35.0045, lon: -81.996 },
    { type: 'way', id: 1111, nodes: [16, 17], tags: { highway: 'service', service: 'alley', name: 'Unverified Alley' } },

    { type: 'node', id: 20, lat: 35.006, lon: -81.999 },
    { type: 'node', id: 21, lat: 35.006, lon: -81.991 },
    { type: 'node', id: 22, lat: 35.0061, lon: -81.999 },
    { type: 'node', id: 23, lat: 35.0061, lon: -81.991 },
    { type: 'way', id: 1200, nodes: [20, 21], tags: { highway: 'residential', name: 'Divided Avenue' } },
    { type: 'way', id: 1201, nodes: [22, 23], tags: { highway: 'residential', name: 'Divided Avenue' } },
    { type: 'node', id: 30, lat: 35.00614, lon: -81.9962 },
    { type: 'node', id: 31, lat: 35.00614, lon: -81.9958 },
    { type: 'node', id: 32, lat: 35.00618, lon: -81.9958 },
    { type: 'node', id: 33, lat: 35.00618, lon: -81.9962 },
    { type: 'node', id: 34, lat: 35.006153, lon: -81.99605 },
    { type: 'node', id: 35, lat: 35.006153, lon: -81.99595 },
    { type: 'node', id: 36, lat: 35.006167, lon: -81.99595 },
    { type: 'node', id: 37, lat: 35.006167, lon: -81.99605 },
    { type: 'way', id: 1300, nodes: [30, 31, 32] },
    { type: 'way', id: 1301, nodes: [32, 33, 30] },
    { type: 'way', id: 1302, nodes: [34, 35, 36, 37, 34] },
    { type: 'node', id: 38, lat: 35.006145, lon: -81.99615, tags: { entrance: 'main' } },
    { type: 'relation', id: 1400, members: [
      { type: 'way', ref: 1300, role: 'outer' },
      { type: 'way', ref: 1301, role: 'outer' },
      { type: 'way', ref: 1302, role: 'inner' }
    ], tags: { type: 'multipolygon', building: 'apartments', 'building:units': '6', 'addr:street': 'Divided Avenue' } }
  ];
  const polygon = [
    { lat: 35, lng: -82 }, { lat: 35, lng: -81.99 },
    { lat: 35.009, lng: -81.99 }, { lat: 35.009, lng: -82 }
  ];
  const analyze = async (rawElements, managerId) => {
    const sequence = { value: 0 };
    const user = { id: managerId, role: 'admin', app_role: 'manager' };
    const state = { snapshots: [], revisions: [], heads: [], users: [user] };
    const entities = {
      CanvasAnalysisSnapshot: memoryEntity(state.snapshots, 'snapshot', sequence),
      CanvasClassificationRevision: memoryEntity(state.revisions, 'revision', sequence),
      CanvasClassificationRevisionHead: memoryEntity(state.heads, 'head', sequence),
      User: memoryEntity(state.users, 'user', sequence)
    };
    const base44 = { auth: { me: async () => user }, entities, asServiceRole: { entities } };
    const start = loadHandler('base44/functions/canvasStartAnalysis/entry.ts', {
      base44,
      env: { CANVAS_OVERPASS_URL: 'https://osm.example.test' },
      fetchImpl: async () => new Response(JSON.stringify({
        osm3s: { timestamp_osm_base: '2026-07-18T00:00:00Z' }, elements: rawElements
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    });
    const result = await invoke(start, { polygon });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    return state.snapshots[0].analysis_result.street_units;
  };
  const units = await analyze(elements, 'manager_hierarchy_a');
  const repeated = await analyze([...elements].reverse(), 'manager_hierarchy_b');
  const byWay = (sourceWayId) => units.filter((unit) => unit.unit_id === `osm_way_${sourceWayId}`
    || unit.unit_id.startsWith(`osm_block_${sourceWayId}_`));
  const repeatedShape = repeated.map((unit) => ({
    id: unit.unit_id,
    segment_ids: unit.segments.map((segment) => segment.edge_id)
  })).sort((left, right) => left.id.localeCompare(right.id));
  const originalShape = units.map((unit) => ({
    id: unit.unit_id,
    segment_ids: unit.segments.map((segment) => segment.edge_id)
  })).sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(originalShape, repeatedShape, 'block IDs and source-edge seams are order independent');

  const curvedBlocks = byWay(1000);
  assert.equal(curvedBlocks.length, 2, 'the true intersection splits one way into two block faces');
  assert.deepEqual(curvedBlocks.map((unit) => unit.segments.length).sort(), [2, 2],
    'degree-2 shape and driveway nodes do not create ownership boundaries');
  assert.ok(curvedBlocks.every((unit) => unit.segments.every((segment) => /^osm_way_1000_\d+/.test(segment.edge_id))),
    'stable segment IDs retain their raw OSM edge identity without exposing tiling internals');

  for (const contextWayId of [1100, 1101, 1102, 1103, 1111]) {
    assert.equal(byWay(contextWayId).length, 0, `service context ${contextWayId} must never become ownership`);
  }
  assert.equal(byWay(1110).length, 1, 'a named service street requires explicit public access');
  const drivewayOpportunity = curvedBlocks.flatMap((unit) => unit.opportunity_features)
    .find((feature) => feature.association_basis === 'driveway');
  assert.ok(drivewayOpportunity, JSON.stringify(curvedBlocks));
  assert.equal(drivewayOpportunity.source, 'residential_footprint');
  assert.deepEqual(drivewayOpportunity.association_point, { lat: 35.00275, lng: -81.997 });

  const relationUnit = units.find((unit) => unit.opportunity_features.some((feature) => feature.feature_id === 'osm_relation_1400'));
  assert.ok(relationUnit, JSON.stringify(units));
  assert.ok(relationUnit.unit_id === 'osm_way_1201' || relationUnit.unit_id.startsWith('osm_block_1201_'),
    'side-of-street resolution chooses the outside-facing carriageway');
  const relationFeature = relationUnit.opportunity_features.find((feature) => feature.feature_id === 'osm_relation_1400');
  assert.equal(relationFeature.source, 'explicit_building_units');
  assert.equal(relationFeature.expected, 6);
  assert.equal(relationFeature.association_basis, 'address_street');
  assert.equal(relationFeature.association_resolution, 'side_of_street');
});

test('server analysis and override endpoints execute an authenticated append-only round trip', async () => {
  const sequence = { value: 0 };
  const user = { id: 'manager_1', email: 'manager@example.com', role: 'admin', app_role: 'manager' };
  const state = {
    snapshots: [], revisions: [], heads: [], sessions: [], pins: [], events: [], decisionCampaignStates: [], decisionZoneStates: [],
    members: [{ id: 'tm_1', manager_id: 'manager_1', user_id: 'rep_user_1', email: 'rep@example.com', role: 'rep', status: 'active' }],
    users: [user, { id: 'rep_user_1', email: 'rep@example.com', role: 'user', app_role: 'rep', team_manager_id: 'manager_1' }]
  };
  const entities = {
    CanvasAnalysisSnapshot: memoryEntity(state.snapshots, 'snapshot', sequence),
    CanvasClassificationRevision: memoryEntity(state.revisions, 'revision', sequence),
    CanvasClassificationRevisionHead: memoryEntity(state.heads, 'head', sequence),
    CanvasSession: memoryEntity(state.sessions, 'session', sequence),
    CanvasHousePin: memoryEntity(state.pins, 'pin', sequence),
    CanvasHouseEvent: memoryEntity(state.events, 'event', sequence),
    CanvasDecisionCampaignState: memoryEntity(state.decisionCampaignStates, 'decision-campaign', sequence),
    CanvasDecisionZoneState: memoryEntity(state.decisionZoneStates, 'decision-zone', sequence),
    TeamMember: memoryEntity(state.members, 'member', sequence),
    User: memoryEntity(state.users, 'user', sequence)
  };
  let actor = user;
  const base44 = { auth: { me: async () => actor }, entities, asServiceRole: { entities } };
  const osm = {
    osm3s: { timestamp_osm_base: '2026-07-18T00:00:00Z' },
    elements: [
      { type: 'node', id: 1, lat: 35, lon: -82 },
      { type: 'node', id: 2, lat: 35, lon: -81.999 },
      { type: 'node', id: 3, lat: 35.0001, lon: -81.9998 },
      { type: 'node', id: 4, lat: 35.0001, lon: -81.9997 },
      { type: 'node', id: 5, lat: 35.0002, lon: -81.9997 },
      { type: 'node', id: 6, lat: 35.0002, lon: -81.9998 },
      { type: 'way', id: 100, nodes: [1, 2], tags: { highway: 'residential', name: 'Oak Street' } },
      { type: 'way', id: 200, nodes: [3, 4, 5, 6, 3], tags: { building: 'house', 'addr:housenumber': '12' } }
    ]
  };
  const start = loadHandler('base44/functions/canvasStartAnalysis/entry.ts', {
    base44,
    env: { CANVAS_OVERPASS_URL: 'https://osm.example.test' },
    fetchImpl: async () => new Response(JSON.stringify(osm), { status: 200, headers: { 'content-type': 'application/json' } })
  });
  const request = { polygon: [{ lat: 34.999, lng: -82.001 }, { lat: 34.999, lng: -81.998 }, { lat: 35.002, lng: -81.998 }, { lat: 35.002, lng: -82.001 }] };
  const concurrentStarts = await Promise.all([invoke(start, request), invoke(start, request)]);
  const started = concurrentStarts[0];
  assert.ok(concurrentStarts.every((result) => result.response.status === 200), JSON.stringify(concurrentStarts.map((result) => result.body)));
  assert.deepEqual(concurrentStarts.map((result) => result.body.idempotent).sort(), [false, true]);
  assert.equal(started.response.status, 200, JSON.stringify(started.body));
  assert.match(started.body.evidence_id, /^canvas_evidence_[a-f0-9]{64}$/);
  assert.equal(state.snapshots.length, 1);
  assert.equal(state.snapshots[0].analysis_result.street_units[0].canvas_role, 'knock');
  assert.deepEqual(state.snapshots[0].analysis_result.street_units[0].neighbor_ids, []);
  assert.equal(state.snapshots[0].analysis_result.street_units[0].protected, true);

  const override = loadHandler('base44/functions/canvasApplyClassificationOverride/entry.ts', { base44 });
  const overrideRequest = {
    evidence_id: started.body.evidence_id,
    parent_revision_id: null,
    street_unit_id: 'osm_way_100',
    override_canvas_role: 'excluded',
    override_opportunity_classification: 'none',
    override_access_classification: 'restricted',
    override_reason: 'Manager verified a private non-residential street.'
  };
  const concurrentOverrides = await Promise.all([invoke(override, overrideRequest), invoke(override, overrideRequest)]);
  const applied = concurrentOverrides[0];
  assert.ok(concurrentOverrides.every((result) => result.response.status === 200), JSON.stringify(concurrentOverrides.map((result) => result.body)));
  assert.deepEqual(concurrentOverrides.map((result) => result.body.idempotent).sort(), [false, true]);
  assert.equal(applied.response.status, 200, JSON.stringify(applied.body));
  assert.match(applied.body.revision_id, /^canvas_revision_[a-f0-9]{64}$/);
  assert.equal(applied.body.unresolved_unit_count, 0);
  assert.equal(state.revisions.length, 1);
  assert.equal(state.heads[0].head_revision_id, applied.body.revision_id);

  const stale = await invoke(override, {
    evidence_id: started.body.evidence_id,
    parent_revision_id: null,
    street_unit_id: 'osm_way_100',
    override_canvas_role: 'excluded',
    override_reason: 'Stale concurrent override.'
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error, 'revision_head_conflict');

  const get = loadHandler('base44/functions/canvasGetAnalysis/entry.ts', { base44 });
  const loaded = await invoke(get, { evidence_id: started.body.evidence_id, revision_id: applied.body.revision_id });
  assert.equal(loaded.response.status, 200, JSON.stringify(loaded.body));
  assert.equal(loaded.body.evidence.analysis_result.street_units[0].canvas_role, 'excluded');
  assert.equal(loaded.body.revision_chain.length, 1);
  const latest = await invoke(get, { evidence_id: started.body.evidence_id });
  assert.equal(latest.response.status, 200, JSON.stringify(latest.body));
  assert.equal(latest.body.evidence.analysis_result.street_units[0].canvas_role, 'excluded');
  assert.equal(latest.body.revision_source, 'latest_head');
  assert.equal(latest.body.revision_chain.length, 1);
  const pinnedRaw = await invoke(get, { evidence_id: started.body.evidence_id, use_revision_head: false });
  assert.equal(pinnedRaw.response.status, 200, JSON.stringify(pinnedRaw.body));
  assert.equal(pinnedRaw.body.evidence.analysis_result.street_units[0].canvas_role, 'knock');
  assert.equal(pinnedRaw.body.revision_source, 'pinned_raw');
  assert.equal(pinnedRaw.body.revision_chain.length, 0);

  const snapshotUnit = structuredClone(state.snapshots[0].analysis_result.street_units[0]);
  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44 });
  const saved = await invoke(save, {
    territory_model: 'residential_street_territory_v2',
    evidence_id: started.body.evidence_id,
    snapshot_hash: started.body.snapshot_hash,
    revision_id: null,
    session_name: 'Residential Evidence Campaign',
    polygon: state.snapshots[0].polygon,
    planning_method: 'street_workload',
    assignment_basis: 'street_work_unit_ids',
    workload_basis: 'residential_opportunity',
    division_mode: 'area_count',
    selected_team_member_ids: [],
    work_units: [snapshotUnit],
    zones: [{ zone_id: 'zone_1', zone_number: 1, geometry_role: 'display_only', work_unit_ids: [snapshotUnit.unit_id], assigned_team_member_id: null, street_length_meters: snapshotUnit.street_length_meters, workload_score: snapshotUnit.opportunity_expected }],
    qa: { connected_zones: true, atomic_work_units: true, protected_units_intact: true, cul_de_sac_splits: 0 }
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.lifecycle_state, 'saved_unassigned');
  assert.equal(saved.body.qa.deployable, false);

  const assign = loadHandler('base44/functions/canvasAssignTerritories/entry.ts', { base44 });
  const assigned = await invoke(assign, { session_id: saved.body.session_id, expected_version: saved.body.version, expected_assignment_version: 0, assignments: [{ zone_id: 'zone_1', assigned_team_member_id: 'tm_1' }] });
  assert.equal(assigned.response.status, 200, JSON.stringify(assigned.body));
  assert.equal(assigned.body.lifecycle_state, 'ready_to_send');
  assert.equal(assigned.body.ready_to_send, true);

  const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', { base44, env: { CANVAS_DEPLOYMENT_SIGNING_SECRET: 'test-residential-canvas-signing-secret-32-bytes' } });
  const deployed = await invoke(deploy, { session_id: saved.body.session_id, expected_version: assigned.body.version, idempotency_key: 'deploy:residential-v2' });
  assert.equal(deployed.response.status, 200, JSON.stringify(deployed.body));
  assert.equal(deployed.body.status, 'deployed');
  assert.equal(state.sessions[0].lifecycle_state, 'active');
  assert.equal(state.sessions[0].deployment_qa.evidence_replay_verified, true);
  assert.equal(state.sessions[0].deployment_qa.public_overpass_used_during_deploy, false);

  actor = state.users[1];
  const log = loadHandler('base44/functions/canvasLogHouseDecision/entry.ts', { base44, env: { CANVAS_DEPLOYMENT_SIGNING_SECRET: 'test-residential-canvas-signing-secret-32-bytes' } });
  const logged = await invoke(log, { campaign_id: saved.body.session_id, zone_id: 'zone_1', street_unit_id: 'osm_way_100', idempotency_key: 'decision:residential-v2', outcome: 'no_answer', point: { lat: 35.0001, lng: -81.9998 }, client_recorded_at: new Date().toISOString() });
  assert.equal(logged.response.status, 200, JSON.stringify(logged.body));
  assert.equal(logged.body.pin.street_unit_id, 'osm_way_100');
  assert.equal(logged.body.pin.evidence_id, started.body.evidence_id);
  assert.equal(state.events[0].revision_id, null);

  const assignments = loadHandler('base44/functions/canvasGetMyAssignments/entry.ts', { base44, env: { CANVAS_DEPLOYMENT_SIGNING_SECRET: 'test-residential-canvas-signing-secret-32-bytes' } });
  const fetchedAssignments = await invoke(assignments, { session_id: saved.body.session_id });
  assert.equal(fetchedAssignments.response.status, 200, JSON.stringify(fetchedAssignments.body));
  assert.equal(fetchedAssignments.body.assignments.length, 1);
  assert.equal(fetchedAssignments.body.assignments[0].evidence_id, started.body.evidence_id);
  assert.equal(fetchedAssignments.body.assignments[0].work_units[0].canvas_role, 'knock');

  const map = loadHandler('base44/functions/canvasGetCampaignMap/entry.ts', { base44, env: { CANVAS_DEPLOYMENT_SIGNING_SECRET: 'test-residential-canvas-signing-secret-32-bytes' } });
  const fetchedMap = await invoke(map, { campaign_id: saved.body.session_id, include_events: true });
  assert.equal(fetchedMap.response.status, 200, JSON.stringify(fetchedMap.body));
  assert.equal(fetchedMap.body.access_scope, 'rep_assigned_zones');
  assert.equal(fetchedMap.body.pins[0].street_unit_id, 'osm_way_100');
  assert.equal(fetchedMap.body.events[0].evidence_id, started.body.evidence_id);
});
