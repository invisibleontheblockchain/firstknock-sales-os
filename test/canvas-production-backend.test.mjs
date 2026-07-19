import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { polygon as geoJsonPolygon } from 'turf-helpers';
import intersectPolygons from 'turf-intersect';

import { planCanvasTerritories } from '../src/components/logic/canvasStreetTerritoryPlanner.js';
import {
  canvasRepTeamMemberIds,
  canvasStoredPlanForHash,
  signCanvasLifecycle,
  verifyCanvasLifecycleSession
} from './helpers/canvasLifecycleSignature.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');
const SIGNING_SECRET = 'test-canvas-signing-secret-32-bytes-minimum';

function canonicalizeForHash(value) {
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalizeForHash(value[key])]));
}

async function canonicalHash(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalizeForHash(value)));
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const polygon = [
  { lat: 34.999, lng: -82.011 },
  { lat: 34.999, lng: -81.989 },
  { lat: 35.011, lng: -81.989 },
  { lat: 35.011, lng: -82.011 }
];
const node = (id, lat, lon, tags = {}) => ({ type: 'node', id, lat, lon, tags });
const way = (id, nodes, name) => ({ type: 'way', id, nodes, tags: { highway: 'residential', name } });

function roadNetwork() {
  return {
    elements: [
      node(1, 35, -82.011), node(2, 35, -82), node(3, 35, -81.989),
      node(4, 35.004, -82), node(5, 35.006, -82.001),
      node(6, 35.008, -82, { highway: 'turning_circle' }), node(7, 35.006, -81.999),
      way(100, [1, 2, 3], 'Main Street'), way(300, [2, 4], 'Loop Court'),
      way(301, [4, 5, 6, 7, 4], 'Loop Court')
    ]
  };
}

function unevenRoadNetwork() {
  return {
    elements: [
      node(1, 35, -82.01), node(2, 35, -82), node(3, 35, -81.99), node(4, 35.001, -82),
      way(100, [1, 2, 3], 'Long Street'), way(200, [2, 4], 'Tiny Court')
    ]
  };
}

function largeConnectedRoadNetwork() {
  const rows = 33;
  const columns = 33;
  const elements = [];
  const gridNodeId = (row, column) => 1 + row * columns + column;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      elements.push(node(
        gridNodeId(row, column),
        34.9992 + 0.0116 * (row + 0.5) / rows,
        -82.0108 + 0.0216 * (column + 0.5) / columns,
      ));
    }
  }
  for (let row = 0; row < rows; row += 1) {
    elements.push(way(
      100_000 + row,
      Array.from({ length: columns }, (_, column) => gridNodeId(row, column)),
      `Large Row ${row}`,
    ));
  }
  for (let column = 0; column < columns; column += 1) {
    elements.push(way(
      200_000 + column,
      Array.from({ length: rows }, (_, row) => gridNodeId(row, column)),
      `Large Column ${column}`,
    ));
  }
  return { elements };
}

function parallelRoadNetwork(count = 20) {
  const elements = [];
  for (let index = 0; index < count; index += 1) {
    const firstId = 10_000 + index * 2;
    const latitude = 34.9995 + (index + 1) * 0.0005;
    elements.push(
      node(firstId, latitude, -82.009),
      node(firstId + 1, latitude, -81.991),
      way(50_000 + index, [firstId, firstId + 1], `Parallel Street ${index + 1}`),
    );
  }
  return { elements };
}

function managerUser() {
  return {
    id: 'manager_1', email: 'manager@example.com', role: 'admin', app_role: 'manager',
    subscription_tier: 'canvas', subscription_status: 'active', subscription_paid_confirmed: true
  };
}

function makeState() {
  return {
    sessions: [],
    analysisSnapshots: [],
    classificationRevisions: [],
    pins: [],
    events: [],
    decisionCampaignStates: [],
    decisionZoneStates: [],
    members: [
      { id: 'tm_1', name: 'Rep One', email: 'rep1@example.com', user_id: 'auth_rep_1', role: 'rep', status: 'active', manager_id: 'manager_1' },
      { id: 'tm_2', name: 'Rep Two', email: 'rep2@example.com', user_id: 'auth_rep_2', role: 'rep', status: 'active', manager_id: 'manager_1' },
      { id: 'tm_other', name: 'Other Rep', email: 'other@example.com', user_id: 'auth_other', role: 'rep', status: 'active', manager_id: 'manager_other' }
    ],
    users: [
      managerUser(),
      { id: 'auth_rep_1', email: 'rep1@example.com', role: 'user', app_role: 'rep', team_manager_id: 'manager_1' },
      { id: 'auth_rep_2', email: 'rep2@example.com', role: 'user', app_role: 'rep', team_manager_id: 'manager_1' },
      { id: 'auth_other', email: 'other@example.com', role: 'user', app_role: 'rep', team_manager_id: 'manager_other' }
    ],
    id: 0
  };
}

function getPath(record, path) {
  return String(path).split('.').reduce((value, key) => value?.[key], record);
}

function matches(record, query = {}) {
  return Object.entries(query).every(([field, expected]) => {
    if (field === '$or') return expected.some((candidate) => matches(record, candidate));
    if (field === '$and') return expected.every((candidate) => matches(record, candidate));
    const actual = getPath(record, field);
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      return Object.entries(expected).every(([operator, operand]) => {
        if (operator === '$exists') return operand ? actual !== undefined : actual === undefined;
        if (operator === '$lte') return actual !== undefined && actual <= operand;
        if (operator === '$gte') return actual !== undefined && actual >= operand;
        if (operator === '$in') return operand.includes(actual);
        return false;
      });
    }
    return actual === expected;
  });
}

function makeEntity(state, key, prefix) {
  const rows = state[key];
  return {
    async get(id) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) throw new Error('not found');
      return row;
    },
    async filter(query, sort = '', limit = 100, skip = 0) {
      const selected = rows.filter((row) => matches(row, query));
      const sortField = String(sort || '').replace(/^-/, '');
      if (sortField) selected.sort((left, right) => String(left[sortField] || '').localeCompare(String(right[sortField] || '')) * (String(sort).startsWith('-') ? -1 : 1));
      return selected.slice(skip, skip + limit);
    },
    async create(record) {
      if (key === 'decisionZoneStates' && state.failDecisionZoneCreateOnce) {
        state.failDecisionZoneCreateOnce = false;
        throw new Error('simulated transient decision-zone create failure');
      }
      const now = new Date().toISOString();
      const created = { ...structuredClone(record), id: `${prefix}_${++state.id}`, created_date: now, updated_date: now };
      rows.push(created);
      return created;
    },
    async delete(id) {
      const index = rows.findIndex((candidate) => candidate.id === id);
      if (index < 0) throw new Error('not found');
      rows.splice(index, 1);
      return { success: true };
    },
    async updateMany(query, update) {
      if (key === 'sessions' && state.failDeploymentCommitOnce && query?.status === 'draft' && update?.$set?.status === 'deployed') {
        state.failDeploymentCommitOnce = false;
        return { success: false, updated: 0, has_more: false };
      }
      if (key === 'decisionCampaignStates' && state.failSupersessionFinalizeOnce && update?.$set?.state === 'superseded') {
        state.failSupersessionFinalizeOnce = false;
        return { success: false, updated: 0, has_more: false };
      }
      if (key === 'events' && state.failEventCommitOnce && update?.$set?.write_status === 'committed') {
        state.failEventCommitOnce = false;
        return { success: false, updated: 0, has_more: false };
      }
      const selected = rows.filter((row) => matches(row, query));
      for (const row of selected) {
        if (update.$set) Object.assign(row, structuredClone(update.$set));
        if (update.$unset) for (const field of Object.keys(update.$unset)) delete row[field];
        row.updated_date = new Date().toISOString();
      }
      return { success: true, updated: selected.length, has_more: false };
    }
  };
}

function makeBase44(user, state) {
  const entities = {
    CanvasSession: makeEntity(state, 'sessions', 'session'),
    CanvasAnalysisSnapshot: makeEntity(state, 'analysisSnapshots', 'snapshot'),
    CanvasClassificationRevision: makeEntity(state, 'classificationRevisions', 'revision'),
    CanvasHousePin: makeEntity(state, 'pins', 'pin'),
    CanvasHouseEvent: makeEntity(state, 'events', 'event'),
    CanvasDecisionCampaignState: makeEntity(state, 'decisionCampaignStates', 'decision-campaign'),
    CanvasDecisionZoneState: makeEntity(state, 'decisionZoneStates', 'decision-zone'),
    TeamMember: makeEntity(state, 'members', 'member'),
    User: makeEntity(state, 'users', 'user')
  };
  return {
    auth: { me: async () => user },
    entities,
    asServiceRole: { entities }
  };
}

function loadHandler(path, { base44, network = roadNetwork(), fetchImpl = null, sourceTransform = null, env = null } = {}) {
  const source = typeof sourceTransform === 'function' ? sourceTransform(readSource(path)) : readSource(path);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: path,
    reportDiagnostics: true
  });
  const errors = (transpiled.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], `${path} contains TypeScript errors`);
  let handler;
  const executable = transpiled.outputText.replace(/^import .*;\s*$/gm, '');
  const topologyFetch = fetchImpl || (async () => new Response(JSON.stringify(network), { status: 200 }));
  class FakeStripe {
    constructor() { throw new Error('Admin test user must bypass Stripe.'); }
  }
  vm.runInNewContext(executable, {
    console,
    createClientFromRequest: () => base44,
    Stripe: FakeStripe,
    planCanvasTerritories,
    geoJsonPolygon,
    intersectPolygons,
    canvasRepTeamMemberIds,
    canvasStoredPlanForHash,
    signCanvasLifecycle,
    verifyCanvasLifecycleSession,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Request,
    Response,
    URL,
    URLSearchParams,
    AbortController,
    fetch: topologyFetch,
    setTimeout,
    clearTimeout,
    structuredClone,
    Deno: {
      env: { get: (key) => env ? env[key] ?? null : key === 'CANVAS_DEPLOYMENT_SIGNING_SECRET' ? SIGNING_SECRET : null },
      serve: (registered) => { handler = registered; }
    }
  }, { filename: path });
  return handler;
}

async function invoke(handler, body = {}) {
  const response = await handler(new Request('https://example.test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }));
  return { response, result: await response.json() };
}

function productionPlan({ assigned = true, divisionMode = 'selected_reps', targetWorkload = 2000 } = {}) {
  const selected = divisionMode === 'selected_reps' ? ['tm_1', 'tm_2'] : [];
  const generated = planCanvasTerritories({
    polygon,
    roadNetwork: roadNetwork(),
    ...(selected.length
      ? { selected_team_member_ids: selected }
      : divisionMode === 'street_workload_target'
        ? { target_street_workload_meters_per_area: targetWorkload }
        : { requested_zone_count: 2 })
  });
  assert.equal(generated.ok, true, JSON.stringify(generated));
  const zones = generated.zones.map((zone, index) => ({
    ...zone,
    assigned_team_member_id: assigned ? `tm_${index + 1}` : null
  }));
  return {
    session_name: 'Northside Canvas',
    territory_model: 'street_territory_v1',
    polygon,
    planning_method: generated.planning_method,
    assignment_basis: generated.assignment_basis,
    workload_basis: generated.workload_basis,
    division_mode: divisionMode,
    selected_team_member_ids: assigned ? ['tm_1', 'tm_2'] : [],
    target_workload: divisionMode === 'street_workload_target' ? targetWorkload : null,
    zones,
    work_units: generated.work_units,
    qa: generated.qa,
    algorithm_version: generated.algorithm_version,
    data_version: generated.data_version
  };
}

function unevenHeadcountPlan({ acknowledged = false } = {}) {
  const generated = planCanvasTerritories({ polygon, roadNetwork: unevenRoadNetwork(), requested_zone_count: 3 });
  assert.equal(generated.ok, true, JSON.stringify(generated));
  assert.ok(generated.qa.max_workload_deviation_percent > 25);
  return {
    session_name: 'Uneven Canvas',
    territory_model: 'street_territory_v1',
    polygon,
    planning_method: generated.planning_method,
    assignment_basis: generated.assignment_basis,
    workload_basis: generated.workload_basis,
    division_mode: 'area_count',
    selected_team_member_ids: ['tm_1', 'tm_2', 'tm_3'],
    target_workload: null,
    zones: generated.zones.map((zone, index) => ({ ...zone, assigned_team_member_id: `tm_${index + 1}` })),
    work_units: generated.work_units,
    qa: { ...generated.qa, manager_workload_exception_acknowledged: acknowledged },
    algorithm_version: generated.algorithm_version,
    data_version: generated.data_version
  };
}

function syntheticHeadcountPlan({ repCount = 200, workUnitCount = 720 } = {}) {
  const baseline = productionPlan({ divisionMode: 'area_count' });
  const selectedTeamMemberIds = Array.from({ length: repCount }, (_, index) => `tm_${index + 1}`);
  const baselineSegment = baseline.work_units[0].segments[0];
  const workUnits = Array.from({ length: workUnitCount }, (_, index) => ({
    id: `synthetic_unit_${index + 1}`,
    kind: 'street_segment',
    protected: false,
    street_names: [],
    neighbor_ids: [],
    street_length_meters: 100,
    segments: [{
      edge_id: `synthetic_edge_${index + 1}`,
      start: structuredClone(baselineSegment.start),
      end: structuredClone(baselineSegment.end),
      street_names: [],
      length_meters: 100,
    }],
  }));
  const unitIdsByZone = Array.from({ length: repCount }, () => []);
  workUnits.forEach((unit, index) => unitIdsByZone[index % repCount].push(unit.id));
  const zones = unitIdsByZone.map((workUnitIds, index) => ({
    ...structuredClone(baseline.zones[index % baseline.zones.length]),
    zone_id: `synthetic_zone_${index + 1}`,
    zone_number: index + 1,
    assigned_team_member_id: selectedTeamMemberIds[index],
    work_unit_ids: workUnitIds,
    street_work_unit_ids: workUnitIds,
    street_length_meters: workUnitIds.length * 100,
    workload_score: workUnitIds.length * 100,
    workload_share: workUnitIds.length / workUnitCount,
  }));
  return {
    ...baseline,
    session_name: `${repCount}-rep Canvas`,
    division_mode: 'area_count',
    selected_team_member_ids: selectedTeamMemberIds,
    target_workload: null,
    zones,
    work_units: workUnits,
    qa: {
      ...baseline.qa,
      deployable: true,
      street_coverage_complete: true,
      no_duplicate_work_units: true,
      no_missing_work_units: true,
      connected_zones: true,
      atomic_work_units: true,
      protected_units_intact: true,
      cul_de_sac_splits: 0,
    },
  };
}

function parallelZonePlan(count = 20) {
  const network = parallelRoadNetwork(count);
  const generated = planCanvasTerritories({ polygon, roadNetwork: network, requested_zone_count: count });
  assert.equal(generated.ok, true, JSON.stringify(generated));
  const selectedTeamMemberIds = Array.from({ length: count }, (_, index) => `tm_${index + 1}`);
  return {
    network,
    plan: {
      session_name: `${count}-zone concurrent Canvas`,
      territory_model: 'street_territory_v1',
      polygon,
      planning_method: generated.planning_method,
      assignment_basis: generated.assignment_basis,
      workload_basis: generated.workload_basis,
      division_mode: 'area_count',
      selected_team_member_ids: selectedTeamMemberIds,
      target_workload: null,
      zones: generated.zones.map((zone, index) => ({ ...zone, assigned_team_member_id: selectedTeamMemberIds[index] })),
      work_units: generated.work_units,
      qa: generated.qa,
      algorithm_version: generated.algorithm_version,
      data_version: generated.data_version,
    },
  };
}

async function directResidentialDraft(state, {
  provider = 'openstreetmap-contracted-or-self-hosted',
  evidenceTrust = 'trusted',
  trustedEvidence = true,
} = {}) {
  const streetUnit = {
    id: 'residential_unit_1', unit_id: 'residential_unit_1', kind: 'residential', canvas_role: 'knock',
    opportunity_classification: 'likely', access_classification: 'permitted',
    opportunity_low: 5, opportunity_expected: 5, opportunity_high: 5,
    protected: false, protected_group_id: null, protected_group_ids: [],
    street_names: ['Residential Test Street'], neighbor_ids: [], street_length_meters: 100,
    segments: [{
      edge_id: 'residential_edge_1',
      start: { lat: 35.002, lng: -82.002 }, end: { lat: 35.002, lng: -81.998 },
      street_names: ['Residential Test Street'], length_meters: 100,
    }],
  };
  const snapshotContent = {
    schema_version: 1, manager_id: 'manager_1', provider,
    source_version: 'osm-test-v1', extraction_version: 'extract-test-v1', classifier_version: 'classifier-test-v1',
    polygon, raw_evidence: { elements: [] },
    analysis_result: {
      territory_model: 'residential_street_territory_v2', street_units: [streetUnit],
      unresolved_unit_count: 0, opportunity_total_expected: 5,
    },
    source_attribution: '© OpenStreetMap contributors',
  };
  const snapshotHash = await canonicalHash(snapshotContent);
  const evidenceId = `canvas_evidence_${snapshotHash}`;
  state.analysisSnapshots.push({
    ...structuredClone(snapshotContent), id: `snapshot_${++state.id}`, evidence_id: evidenceId,
    snapshot_hash: snapshotHash, status: 'complete', created_by_user_id: 'manager_1', created_at: new Date().toISOString(),
  });
  const session = {
    id: `session_${++state.id}`, manager_id: 'manager_1', session_name: 'Residential provider trust test',
    status: 'draft', version: 1, territory_model: 'residential_street_territory_v2', polygon,
    rep_count: 1, planning_method: 'street_workload', assignment_basis: 'street_work_unit_ids',
    workload_basis: 'residential_opportunity', division_mode: 'selected_reps', target_workload: null,
    selected_team_member_ids: ['tm_1'],
    zones: [{
      zone_id: 'residential_zone_1', zone_number: 1, geometry_role: 'display_only',
      work_unit_ids: [streetUnit.id], assigned_team_member_id: 'tm_1',
      street_length_meters: 100, workload_score: 5,
    }],
    work_units: [streetUnit],
    qa: {
      deployable: true, street_coverage_complete: true, no_duplicate_work_units: true,
      connected_zones: true, atomic_work_units: true, protected_units_intact: true,
      cul_de_sac_splits: 0, total_street_length_meters: 100, total_residential_opportunity: 5,
      evidence_trust: evidenceTrust, trusted_evidence: trustedEvidence,
    },
    algorithm_version: 'residential-test-v1', data_version: 'osm-test-v1', lifecycle_state: 'ready_to_send',
    evidence_id: evidenceId, revision_id: null, snapshot_hash: snapshotHash, evidence_schema_version: 1,
    unresolved_unit_count: 0, assignment_version: 1,
  };
  session.plan_hash = await canonicalHash(canvasStoredPlanForHash(session));
  state.sessions.push(session);
  return session;
}

async function savePlan(state, body = productionPlan()) {
  const base44 = makeBase44(managerUser(), state);
  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44 });
  const saved = await invoke(save, body);
  assert.equal(saved.response.status, 200, JSON.stringify(saved.result));
  return { base44, saved };
}

async function deployPlan(state, saved, body = {}) {
  const base44 = makeBase44(managerUser(), state);
  const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', { base44, network: body.network || roadNetwork() });
  return invoke(deploy, {
    session_id: saved.result.session_id,
    expected_version: saved.result.version,
    idempotency_key: body.idempotency_key || `deploy:${saved.result.session_id}`,
    ...(body.supersede_session_ids ? { supersede_session_ids: body.supersede_session_ids } : {})
  });
}

test('Canvas schemas are territory-first and field writes are server-owned', () => {
  const session = JSON.parse(readSource('base44/entities/CanvasSession.jsonc'));
  const pin = JSON.parse(readSource('base44/entities/CanvasHousePin.jsonc'));
  const event = JSON.parse(readSource('base44/entities/CanvasHouseEvent.jsonc'));
  const campaignState = JSON.parse(readSource('base44/entities/CanvasDecisionCampaignState.jsonc'));
  const zoneState = JSON.parse(readSource('base44/entities/CanvasDecisionZoneState.jsonc'));
  const user = JSON.parse(readSource('base44/entities/User.jsonc'));
  assert.equal(session.properties.territory_model.default, 'street_territory_v1');
  assert.ok(session.required.includes('work_units'));
  assert.equal(session.properties.doors, undefined);
  assert.equal(session.properties.analysis_id, undefined);
  assert.deepEqual(session.properties.division_mode.enum, ['selected_reps', 'area_count', 'street_workload_target']);
  assert.equal(session.properties.target_workload.exclusiveMinimum, 0);
  assert.equal(pin.properties.unit_label.maxLength, 100);
  assert.equal(event.properties.unit_label.maxLength, 100);
  assert.deepEqual(pin.rls.create, { user_condition: { role: 'admin' } });
  assert.deepEqual(event.rls.update, { user_condition: { role: 'admin' } });
  assert.equal(user.properties.canvas_deployment_lock_token.rls.write.user_condition.role, 'admin');
  assert.equal(session.properties.canvas_field_write_lock_token, undefined);
  assert.deepEqual(campaignState.properties.state.enum, ['active', 'draining', 'completed', 'recalled', 'superseded']);
  assert.equal(campaignState.rls.read.user_condition.role, 'admin');
  assert.equal(zoneState.properties.lease_token.type, 'string');
  assert.equal(zoneState.rls.update.user_condition.role, 'admin');
});

test('obsolete house-inventory Canvas functions and Canvas Neon dependencies are gone', () => {
  for (const path of [
    'base44/functions/canvasAnalyzeTerritory/entry.ts',
    'base44/functions/canvasFeedback/entry.ts',
    'base44/functions/setupCanvasOpportunityTables/entry.ts'
  ]) assert.equal(existsSync(resolve(rootDir, path)), false, path);
  const canvasSources = [
    'base44/functions/canvasSaveDraft/entry.ts',
    'base44/functions/canvasDeployCampaign/entry.ts',
    'base44/functions/canvasGetMyAssignments/entry.ts',
    'base44/functions/canvasLogHouseDecision/entry.ts',
    'base44/functions/canvasGetCampaignMap/entry.ts'
  ].map(readSource).join('\n');
  assert.doesNotMatch(canvasSources, /DATABASE_URL|@neondatabase/);
  assert.doesNotMatch(readSource('base44/functions/canvasSaveDraft/entry.ts'), /stable_door_id|analysis_id/);
});

test('every Canvas backend function is a self-contained Base44 isolate', () => {
  const names = [
    'canvasSaveDraft', 'canvasDeployCampaign', 'canvasCloseCampaign',
    'canvasGetMyAssignments', 'canvasListCampaigns', 'canvasLogHouseDecision',
    'canvasGetCampaignMap', 'canvasStartAnalysis', 'canvasGetAnalysis',
    'canvasApplyClassificationOverride', 'canvasAssignTerritories'
  ];
  for (const name of names) {
    const source = readSource(`base44/functions/${name}/entry.ts`);
    assert.doesNotMatch(source, /from ['"]\.\.?\//, `${name} has an unsupported local import`);
  }
});

test('save accepts an unassigned area-count draft but marks it nondeployable', async () => {
  const state = makeState();
  const { saved } = await savePlan(state, productionPlan({ assigned: false, divisionMode: 'area_count' }));
  assert.equal(saved.result.qa.deployable, false);
  assert.equal(saved.result.qa.every_zone_assigned, false);
  assert.equal(state.sessions[0].territory_model, 'street_territory_v1');
  assert.equal(state.sessions[0].doors, undefined);
  assert.equal(state.sessions[0].work_units.length, 3);
});

test('canvasSaveDraft enforces declared and normalized UTF-8 byte limits before plan acceptance', async () => {
  const source = readSource('base44/functions/canvasSaveDraft/entry.ts');
  const declaredSizeIndex = source.indexOf("const declaredBodyBytes = Number(req.headers.get('content-length'))");
  const parseIndex = source.indexOf('const body = await req.json()', declaredSizeIndex);
  const normalizedSizeIndex = source.indexOf('const normalizedBodyBytes = new TextEncoder().encode(JSON.stringify(body)).byteLength', parseIndex);
  const planAcceptanceIndex = source.indexOf('const sessionId = optionalString(body?.session_id', normalizedSizeIndex);
  assert.ok(declaredSizeIndex >= 0 && parseIndex > declaredSizeIndex);
  assert.ok(normalizedSizeIndex > parseIndex && planAcceptanceIndex > normalizedSizeIndex);

  const state = makeState();
  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', {
    base44: makeBase44(managerUser(), state),
  });
  let declaredBodyParseCalls = 0;
  const declaredResponse = await save({
    headers: { get: (name) => String(name).toLowerCase() === 'content-length' ? '8000001' : null },
    json: async () => {
      declaredBodyParseCalls += 1;
      return productionPlan();
    },
  });
  const declaredResult = await declaredResponse.json();
  assert.equal(declaredResponse.status, 413);
  assert.equal(declaredResult.error, 'plan_too_large');
  assert.equal(declaredBodyParseCalls, 0);

  const multibyteBody = { marker: '界'.repeat(2_666_667) };
  const serializedMultibyteBody = JSON.stringify(multibyteBody);
  const serializedUtf8Bytes = new TextEncoder().encode(serializedMultibyteBody).byteLength;
  assert.ok(serializedMultibyteBody.length < 8_000_000);
  assert.ok(serializedUtf8Bytes > 8_000_000);
  let normalizedBodyParseCalls = 0;
  const normalizedResponse = await save({
    headers: { get: () => null },
    json: async () => {
      normalizedBodyParseCalls += 1;
      return multibyteBody;
    },
  });
  const normalizedResult = await normalizedResponse.json();
  assert.equal(normalizedResponse.status, 413);
  assert.equal(normalizedResult.error, 'plan_too_large');
  assert.equal(normalizedBodyParseCalls, 1);
  assert.equal(state.sessions.length, 0);
});

test('save accepts a planner result above 2,000 work units without legacy display corridors', async () => {
  const generated = planCanvasTerritories({
    polygon,
    roadNetwork: largeConnectedRoadNetwork(),
    requested_zone_count: 10,
  });
  assert.equal(generated.ok, true, generated.message || generated.code);
  assert.ok(generated.work_units.length > 2_000);
  assert.equal(generated.qa.display_geometry_complete, false);
  assert.ok(generated.zones.every((zone) => (
    zone.geometry_role === 'display_only'
      && zone.geometry.length === 0
      && zone.parts.length === 0
      && zone.work_unit_ids.length > 0
  )));

  const state = makeState();
  const { saved } = await savePlan(state, {
    session_name: 'Large street-owned Canvas',
    territory_model: 'street_territory_v1',
    polygon,
    planning_method: generated.planning_method,
    assignment_basis: generated.assignment_basis,
    workload_basis: generated.workload_basis,
    division_mode: 'area_count',
    selected_team_member_ids: [],
    target_workload: null,
    zones: generated.zones,
    work_units: generated.work_units,
    qa: generated.qa,
    algorithm_version: generated.algorithm_version,
    data_version: generated.data_version,
  });

  assert.equal(saved.response.status, 200);
  assert.equal(saved.result.qa.deployable, false);
  assert.equal(state.sessions[0].work_units.length, generated.work_units.length);
  assert.ok(state.sessions[0].zones.every((zone) => (
    zone.geometry_role === 'display_only'
      && zone.geometry.length === 0
      && zone.parts.length === 0
      && zone.work_unit_ids.length > 0
  )));
});

test('area-count drafts may assign multiple areas per rep but require exact selected-roster coverage', async () => {
  const state = makeState();
  const repeated = productionPlan({ divisionMode: 'area_count' });
  repeated.zones = repeated.zones.map((zone) => ({ ...zone, assigned_team_member_id: 'tm_1' }));
  repeated.selected_team_member_ids = ['tm_1'];
  const { saved } = await savePlan(state, repeated);
  assert.equal(saved.result.qa.every_zone_assigned, true);
  assert.equal(saved.result.qa.selected_reps_one_to_one, null);
  assert.equal(saved.result.qa.deployable, true);
  const deployed = await deployPlan(state, saved, { idempotency_key: 'deploy:deferred-area-count' });
  assert.equal(deployed.response.status, 200, JSON.stringify(deployed.result));
  assert.equal(deployed.result.delivery_count, 1);
  assert.equal(state.sessions[0].deployment_qa.selected_reps_one_to_one, null);

  const omittedState = makeState();
  const omitted = productionPlan({ divisionMode: 'area_count' });
  omitted.zones = omitted.zones.map((zone) => ({ ...zone, assigned_team_member_id: 'tm_1' }));
  omitted.selected_team_member_ids = ['tm_1', 'tm_2'];
  const { saved: omittedSaved } = await savePlan(omittedState, omitted);
  assert.equal(omittedSaved.result.qa.selected_reps_one_to_one, null);
  assert.equal(omittedSaved.result.qa.deployable, false);
  const rejected = await deployPlan(omittedState, omittedSaved, { idempotency_key: 'deploy:omitted-area-count-rep' });
  assert.equal(rejected.response.status, 422, JSON.stringify(rejected.result));
  assert.equal(rejected.result.error, 'selected_rep_contract_failed');
});

test('selected-rep drafts preserve strict one-area-per-rep deployment', async () => {
  const state = makeState();
  const repeated = productionPlan({ divisionMode: 'selected_reps' });
  repeated.zones = repeated.zones.map((zone) => ({ ...zone, assigned_team_member_id: 'tm_1' }));
  repeated.selected_team_member_ids = ['tm_1'];
  const { saved } = await savePlan(state, repeated);
  assert.equal(saved.result.qa.every_zone_assigned, true);
  assert.equal(saved.result.qa.selected_reps_one_to_one, false);
  assert.equal(saved.result.qa.deployable, false);
  const rejected = await deployPlan(state, saved, { idempotency_key: 'deploy:repeated-selected-rep' });
  assert.equal(rejected.response.status, 422, JSON.stringify(rejected.result));
  assert.equal(rejected.result.error, 'selected_rep_contract_failed');
});

test('save rejects plans above the interactive complexity boundary without mutating the draft', async () => {
  const state = makeState();
  const first = await savePlan(state);
  const originalId = first.saved.result.session_id;
  const originalVersion = state.sessions[0].version;
  const originalHash = state.sessions[0].plan_hash;
  const oversized = syntheticHeadcountPlan({ repCount: 250, workUnitCount: 8_001 });
  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44: first.base44 });
  const rejected = await invoke(save, {
    ...oversized,
    session_id: originalId,
    expected_version: originalVersion,
  });
  assert.equal(rejected.response.status, 413, JSON.stringify(rejected.result));
  assert.equal(rejected.result.error, 'plan_too_complex');
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].id, originalId);
  assert.equal(state.sessions[0].version, originalVersion);
  assert.equal(state.sessions[0].plan_hash, originalHash);
});

test('legacy oversized drafts fail deployment before roster reads or Overpass', async () => {
  const state = makeState();
  const base44 = makeBase44(managerUser(), state);
  const oversized = syntheticHeadcountPlan({ repCount: 250, workUnitCount: 8_001 });
  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', {
    base44,
    sourceTransform: (source) => {
      const guardStart = source.indexOf('    if (workUnits.length > MAX_CANVAS_INTERACTIVE_WORK_UNITS');
      const nextStatement = source.indexOf('    const zoneAssigneeIds', guardStart);
      assert.ok(guardStart >= 0 && nextStatement > guardStart);
      return `${source.slice(0, guardStart)}${source.slice(nextStatement)}`;
    },
  });
  const legacy = await invoke(save, oversized);
  assert.equal(legacy.response.status, 200, JSON.stringify(legacy.result));

  let teamFilterCalls = 0;
  let userFilterCalls = 0;
  let fetchCalls = 0;
  const originalTeamFilter = base44.entities.TeamMember.filter;
  const originalUserFilter = base44.asServiceRole.entities.User.filter;
  base44.entities.TeamMember.filter = async (...args) => { teamFilterCalls += 1; return originalTeamFilter(...args); };
  base44.asServiceRole.entities.User.filter = async (...args) => { userFilterCalls += 1; return originalUserFilter(...args); };
  const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', {
    base44,
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify(roadNetwork()), { status: 200 });
    },
  });
  const rejected = await invoke(deploy, {
    session_id: legacy.result.session_id,
    expected_version: legacy.result.version,
    idempotency_key: 'deploy:legacy-oversized',
  });
  assert.equal(rejected.response.status, 422, JSON.stringify(rejected.result));
  assert.equal(rejected.result.error, 'plan_too_complex');
  assert.equal(teamFilterCalls, 0);
  assert.equal(userFilterCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('200-rep deployment validates roster identity in four bounded batch reads', async () => {
  const state = makeState();
  state.members = Array.from({ length: 200 }, (_, index) => ({
    id: `tm_${index + 1}`,
    name: `Rep ${index + 1}`,
    email: `rep${index + 1}@example.com`,
    user_id: `auth_rep_${index + 1}`,
    role: 'rep',
    status: 'active',
    manager_id: 'manager_1',
  }));
  state.users = [managerUser(), ...state.members.map((member) => ({
    id: member.user_id,
    email: member.email,
    role: 'user',
    app_role: 'rep',
    team_manager_id: 'manager_1',
  }))];
  const base44 = makeBase44(managerUser(), state);
  let teamFilterCalls = 0;
  let userFilterCalls = 0;
  const originalTeamFilter = base44.entities.TeamMember.filter;
  const originalUserFilter = base44.asServiceRole.entities.User.filter;
  base44.entities.TeamMember.filter = async (...args) => { teamFilterCalls += 1; return originalTeamFilter(...args); };
  base44.asServiceRole.entities.User.filter = async (...args) => { userFilterCalls += 1; return originalUserFilter(...args); };

  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44 });
  const saved = await invoke(save, syntheticHeadcountPlan());
  assert.equal(saved.response.status, 200, JSON.stringify(saved.result));
  assert.equal(saved.result.qa.deployable, true);
  const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', {
    base44,
    sourceTransform: (source) => source.replace(
      'const topologyVerification = await verifyServerTopology(session, base44);',
      'const topologyVerification = { server_topology_verified: true, validator_version: 3 };',
    ),
  });
  const deployed = await invoke(deploy, {
    session_id: saved.result.session_id,
    expected_version: saved.result.version,
    idempotency_key: 'deploy:two-hundred-reps',
  });
  assert.equal(deployed.response.status, 200, JSON.stringify(deployed.result));
  assert.equal(deployed.result.delivery_count, 200);
  assert.equal(teamFilterCalls, 2);
  assert.equal(userFilterCalls, 2);
});

test('uneven workload acceptance is manager-authenticated, stored, and signed', async () => {
  const unacceptedState = makeState();
  unacceptedState.members.push({ id: 'tm_3', name: 'Rep Three', email: 'rep3@example.com', user_id: 'auth_rep_3', role: 'rep', status: 'active', manager_id: 'manager_1' });
  unacceptedState.users.push({ id: 'auth_rep_3', email: 'rep3@example.com', role: 'user', app_role: 'rep', team_manager_id: 'manager_1' });
  const { saved: unaccepted } = await savePlan(unacceptedState, unevenHeadcountPlan());
  assert.equal(unaccepted.result.qa.max_workload_deviation_percent, 83);
  assert.equal(unaccepted.result.qa.manager_workload_exception_acknowledged, false);
  assert.equal(unaccepted.result.qa.deployable, false);

  const acceptedState = makeState();
  acceptedState.members.push({ id: 'tm_3', name: 'Rep Three', email: 'rep3@example.com', user_id: 'auth_rep_3', role: 'rep', status: 'active', manager_id: 'manager_1' });
  acceptedState.users.push({ id: 'auth_rep_3', email: 'rep3@example.com', role: 'user', app_role: 'rep', team_manager_id: 'manager_1' });
  const base44 = makeBase44(managerUser(), acceptedState);
  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44 });
  const accepted = await invoke(save, unevenHeadcountPlan({ acknowledged: true }));
  assert.equal(accepted.response.status, 200, JSON.stringify(accepted.result));
  assert.equal(accepted.result.qa.deployable, true);
  assert.equal(accepted.result.qa.manager_workload_exception_acknowledged, true);
  assert.equal(accepted.result.qa.manager_workload_exception_acknowledged_by_user_id, 'manager_1');
  assert.ok(Date.parse(accepted.result.qa.manager_workload_exception_acknowledged_at));

  const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', { base44, network: unevenRoadNetwork() });
  const deployed = await invoke(deploy, {
    session_id: accepted.result.session_id,
    expected_version: accepted.result.version,
    idempotency_key: 'deploy:uneven-accepted'
  });
  assert.equal(deployed.response.status, 200, JSON.stringify(deployed.result));
  assert.equal(acceptedState.sessions[0].deployment_qa.manager_workload_exception_acknowledged, true);
  assert.equal(await verifyCanvasLifecycleSession(SIGNING_SECRET, acceptedState.sessions[0], 'active'), true);
});

test('workload-size drafts store a positive street target and deploy by replaying that target', async () => {
  const state = makeState();
  const plan = productionPlan({ divisionMode: 'street_workload_target', targetWorkload: 2000 });
  assert.equal(plan.zones.length, 2);
  const { saved } = await savePlan(state, plan);
  assert.equal(state.sessions[0].division_mode, 'street_workload_target');
  assert.equal(state.sessions[0].target_workload, 2000);
  const deployed = await deployPlan(state, saved, { idempotency_key: 'deploy:workload-target' });
  assert.equal(deployed.response.status, 200, JSON.stringify(deployed.result));
  assert.equal(await verifyCanvasLifecycleSession(SIGNING_SECRET, state.sessions[0], 'active'), true);

  const deploySource = readSource('base44/functions/canvasDeployCampaign/entry.ts');
  assert.match(deploySource, /target_street_workload_meters_per_area: Number\(session\.target_workload\)/);
  assert.doesNotMatch(deploySource, /target_workload: session\.target_workload/);

  const invalidState = makeState();
  const invalid = productionPlan({ divisionMode: 'area_count' });
  invalid.division_mode = 'street_workload_target';
  invalid.target_workload = 0;
  const invalidSave = loadHandler('base44/functions/canvasSaveDraft/entry.ts', {
    base44: makeBase44(managerUser(), invalidState)
  });
  const rejected = await invoke(invalidSave, invalid);
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.result.error, 'invalid_plan');
});

test('territory save, deploy, signed rep handoff, and idempotent deploy work end to end', async () => {
  const state = makeState();
  const { saved } = await savePlan(state);
  assert.equal(saved.result.qa.deployable, true);
  const deployed = await deployPlan(state, saved, { idempotency_key: 'deploy:end-to-end' });
  assert.equal(deployed.response.status, 200, JSON.stringify(deployed.result));
  assert.equal(state.sessions[0].status, 'deployed');
  assert.equal(await verifyCanvasLifecycleSession(SIGNING_SECRET, state.sessions[0], 'active'), true);
  assert.equal(state.users[0].canvas_deployment_lock_token, undefined);

  const retry = await deployPlan(state, saved, { idempotency_key: 'deploy:end-to-end' });
  assert.equal(retry.response.status, 200);
  assert.equal(retry.result.idempotent, true);

  const rep = state.users.find((user) => user.id === 'auth_rep_1');
  const assignments = loadHandler('base44/functions/canvasGetMyAssignments/entry.ts', {
    base44: makeBase44(rep, state)
  });
  const result = await invoke(assignments, {});
  assert.equal(result.response.status, 200, JSON.stringify(result.result));
  assert.equal(result.result.assignments.length, 1);
  assert.equal(result.result.assignments[0].zone.assigned_team_member_id, 'tm_1');
  assert.ok(result.result.assignments[0].work_units.length > 0);
  assert.equal('doors' in result.result.assignments[0], false);
  assert.equal('pins' in result.result.assignments[0], false);
});

test('deployment prepares decision states before commit and recovers a partial preparation with a new client key', async () => {
  const state = makeState();
  const { saved } = await savePlan(state);
  state.failDecisionZoneCreateOnce = true;
  const first = await deployPlan(state, saved, { idempotency_key: 'deploy:prepare-old-key' });
  assert.equal(first.response.status, 503, JSON.stringify(first.result));
  assert.equal(state.sessions[0].status, 'draft', 'the lifecycle must remain a draft when decision-state preparation fails');
  assert.equal(state.decisionCampaignStates.length, 1, 'a transient may leave a signed prepared campaign anchor');
  assert.equal(state.decisionZoneStates.length, 0);

  const recovered = await deployPlan(state, saved, { idempotency_key: 'deploy:prepare-new-key' });
  assert.equal(recovered.response.status, 200, JSON.stringify(recovered.result));
  assert.equal(state.sessions[0].status, 'deployed');
  assert.equal(state.sessions[0].deployment_idempotency_key, 'deploy:prepare-new-key');
  assert.equal(state.decisionCampaignStates.length, 1);
  assert.equal(state.decisionCampaignStates[0].state, 'active');
  assert.equal(state.decisionCampaignStates[0].transition_idempotency_key, 'deploy:prepare-new-key');
  assert.equal(state.decisionZoneStates.length, state.sessions[0].zones.length);
});

test('deployment never reconciles an unsigned or mismatched prepared decision state', async () => {
  const state = makeState();
  const { saved } = await savePlan(state);
  state.decisionCampaignStates.push({
    id: 'forged-prepared-state', manager_id: 'manager_1', campaign_id: saved.result.session_id,
    deployment_plan_version: saved.result.version, plan_hash: state.sessions[0].plan_hash,
    state: 'active', state_version: 1, transition_action: 'deploy', transition_idempotency_key: 'deploy:forged',
    transition_started_at: new Date().toISOString(), transition_completed_at: new Date().toISOString(),
    anchor_signature: 'forged-anchor', state_signature: 'forged-state-signature',
  });
  const rejected = await deployPlan(state, saved, { idempotency_key: 'deploy:must-not-overwrite-forgery' });
  assert.equal(rejected.response.status, 409, JSON.stringify(rejected.result));
  assert.equal(rejected.result.error, 'canvas_prepared_state_integrity_failed');
  assert.equal(state.sessions[0].status, 'draft');
  assert.equal(state.decisionCampaignStates.length, 1);
  assert.equal(state.decisionCampaignStates[0].id, 'forged-prepared-state');
  assert.equal(state.decisionZoneStates.length, 0);
});

test('a valid deployed lifecycle repairs missing decision states even when a reloaded client sends a new key', async () => {
  const state = makeState();
  const { saved } = await savePlan(state);
  const deployed = await deployPlan(state, saved, { idempotency_key: 'deploy:committed-original' });
  assert.equal(deployed.response.status, 200, JSON.stringify(deployed.result));
  state.decisionCampaignStates.splice(0);
  state.decisionZoneStates.splice(0);

  const recovered = await deployPlan(state, saved, { idempotency_key: 'deploy:reloaded-client-key' });
  assert.equal(recovered.response.status, 200, JSON.stringify(recovered.result));
  assert.equal(recovered.result.idempotent, true);
  assert.equal(state.sessions[0].deployment_idempotency_key, 'deploy:committed-original');
  assert.equal(state.decisionCampaignStates[0].transition_idempotency_key, 'deploy:committed-original');
  assert.equal(state.decisionZoneStates.length, state.sessions[0].zones.length);
});

test('residential activation rejects public fallback evidence even when client QA claims it is trusted', async () => {
  const state = makeState();
  const session = await directResidentialDraft(state, { provider: 'openstreetmap-public-development-fallback' });
  const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', { base44: makeBase44(managerUser(), state) });
  const rejected = await invoke(deploy, {
    session_id: session.id, expected_version: session.version, idempotency_key: 'deploy:public-fallback-forged-trust'
  });
  assert.equal(rejected.response.status, 422, JSON.stringify(rejected.result));
  assert.equal(rejected.result.error, 'development_evidence_not_activatable');
  assert.equal(session.status, 'draft');
  assert.equal(state.decisionCampaignStates.length, 0);
});

test('residential activation requires server-derived trusted-evidence QA before snapshot replay', async () => {
  const state = makeState();
  const session = await directResidentialDraft(state, { evidenceTrust: 'development', trustedEvidence: false });
  const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', { base44: makeBase44(managerUser(), state) });
  const rejected = await invoke(deploy, {
    session_id: session.id, expected_version: session.version, idempotency_key: 'deploy:untrusted-qa'
  });
  assert.equal(rejected.response.status, 422, JSON.stringify(rejected.result));
  assert.equal(rejected.result.error, 'untrusted_residential_evidence');
  assert.equal(session.status, 'draft');
});

test('deploy rejects unassigned drafts and forged street partitions', async () => {
  const state = makeState();
  const { saved } = await savePlan(state, productionPlan({ assigned: false, divisionMode: 'area_count' }));
  const unassigned = await deployPlan(state, saved);
  assert.equal(unassigned.response.status, 422, JSON.stringify(unassigned.result));
  assert.equal(unassigned.result.error, 'selected_rep_contract_failed');

  const forgedState = makeState();
  const forged = productionPlan();
  forged.work_units[0].segments[0].start.lat += 0.001;
  const { saved: forgedSaved } = await savePlan(forgedState, forged);
  const rejected = await deployPlan(forgedState, forgedSaved);
  assert.equal(rejected.response.status, 422);
  assert.equal(rejected.result.error, 'server_work_unit_snapshot_mismatch');
});

test('Base44 User CAS serializes overlapping manager deployments without Neon', async () => {
  const state = makeState();
  const first = await savePlan(state);
  const second = await savePlan(state);
  const [left, right] = await Promise.all([
    deployPlan(state, first.saved, { idempotency_key: 'deploy:concurrent-left' }),
    deployPlan(state, second.saved, { idempotency_key: 'deploy:concurrent-right' })
  ]);
  const statuses = [left.response.status, right.response.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.equal(state.sessions.filter((session) => session.status === 'deployed').length, 1);
  const failure = left.response.status === 409 ? left.result : right.result;
  assert.ok(['canvas_deployment_in_progress', 'canvas_deployment_overlap'].includes(failure.error));
});

test('house decisions are zone-enforced, append-only, and offline-idempotent', async () => {
  const state = makeState();
  const { saved } = await savePlan(state);
  const deployed = await deployPlan(state, saved, { idempotency_key: 'deploy:decisions' });
  assert.equal(deployed.response.status, 200, JSON.stringify(deployed.result));
  const session = state.sessions[0];
  const rep = state.users.find((user) => user.id === 'auth_rep_1');
  const zone = session.zones.find((candidate) => candidate.assigned_team_member_id === 'tm_1');
  const unit = session.work_units.find((candidate) => zone.work_unit_ids.includes(candidate.id));
  const segment = unit.segments[0];
  const point = { lat: (segment.start.lat + segment.end.lat) / 2, lng: (segment.start.lng + segment.end.lng) / 2 };
  const log = loadHandler('base44/functions/canvasLogHouseDecision/entry.ts', {
    base44: makeBase44(rep, state)
  });
  const request = {
    campaign_id: session.id,
    zone_id: zone.zone_id,
    idempotency_key: 'decision:offline-0001',
    client_recorded_at: new Date().toISOString(),
    point,
    outcome: 'callback',
    address: '100 Loop Court',
    note: 'Call tomorrow'
  };
  const first = await invoke(log, request);
  assert.equal(first.response.status, 200, JSON.stringify(first.result));
  assert.equal(first.result.pin.latest_outcome, 'callback');
  assert.equal(state.pins.length, 1);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].write_status, 'committed');
  assert.equal(state.decisionZoneStates.find((item) => item.zone_id === zone.zone_id).lease_token, undefined);

  const retry = await invoke(log, request);
  assert.equal(retry.response.status, 200);
  assert.equal(retry.result.idempotent, true);
  assert.equal(state.pins.length, 1);
  assert.equal(state.events.length, 1);

  const otherZone = session.zones.find((candidate) => candidate.zone_id !== zone.zone_id);
  const wrongZone = await invoke(log, { ...request, zone_id: otherZone.zone_id, idempotency_key: 'decision:wrong-zone' });
  assert.equal(wrongZone.response.status, 403);
  assert.equal(wrongZone.result.error, 'zone_not_assigned');
});

test('apartment units at the same building and coordinates keep distinct Canvas pins', async () => {
  const state = makeState();
  const { saved } = await savePlan(state);
  const deployed = await deployPlan(state, saved, { idempotency_key: 'deploy:apartment-units' });
  assert.equal(deployed.response.status, 200, JSON.stringify(deployed.result));
  const session = state.sessions[0];
  const rep = state.users.find((user) => user.id === 'auth_rep_1');
  const zone = session.zones.find((candidate) => candidate.assigned_team_member_id === 'tm_1');
  const unit = session.work_units.find((candidate) => zone.work_unit_ids.includes(candidate.id));
  const segment = unit.segments[0];
  const point = { lat: (segment.start.lat + segment.end.lat) / 2, lng: (segment.start.lng + segment.end.lng) / 2 };
  const log = loadHandler('base44/functions/canvasLogHouseDecision/entry.ts', {
    base44: makeBase44(rep, state)
  });
  const common = {
    campaign_id: session.id,
    zone_id: zone.zone_id,
    client_recorded_at: new Date().toISOString(),
    point,
    address: '200 Main Street',
    building_feature_id: 'osm-building-200',
    outcome: 'no_answer'
  };
  const first = await invoke(log, { ...common, idempotency_key: 'decision:unit-1a', unit_label: '  Unit 1A  ' });
  const second = await invoke(log, { ...common, idempotency_key: 'decision:unit-1b', unit_label: 'Unit 1B' });
  assert.equal(first.response.status, 200, JSON.stringify(first.result));
  assert.equal(second.response.status, 200, JSON.stringify(second.result));
  assert.notEqual(first.result.pin.pin_id, second.result.pin.pin_id);
  assert.deepEqual(state.pins.map((pin) => pin.normalized_unit_label).sort(), ['unit 1a', 'unit 1b']);

  const repeatUnit = await invoke(log, {
    ...common,
    idempotency_key: 'decision:unit-1a-repeat',
    unit_label: 'unit   1a',
    outcome: 'callback'
  });
  assert.equal(repeatUnit.response.status, 200, JSON.stringify(repeatUnit.result));
  assert.equal(repeatUnit.result.pin.pin_id, first.result.pin.pin_id);
  assert.equal(repeatUnit.result.pin.unit_label, 'unit 1a');
  assert.equal(state.pins.length, 2);
  assert.equal(state.events.length, 3);
});

test('same-key recovery completes a pending event without applying the pin twice', async () => {
  const state = makeState();
  const { saved } = await savePlan(state);
  const deployed = await deployPlan(state, saved, { idempotency_key: 'deploy:receipt-recovery' });
  assert.equal(deployed.response.status, 200, JSON.stringify(deployed.result));
  const session = state.sessions[0];
  const rep = state.users.find((user) => user.id === 'auth_rep_1');
  const zone = session.zones.find((candidate) => candidate.assigned_team_member_id === 'tm_1');
  const unit = session.work_units.find((candidate) => zone.work_unit_ids.includes(candidate.id));
  const segment = unit.segments[0];
  const point = { lat: (segment.start.lat + segment.end.lat) / 2, lng: (segment.start.lng + segment.end.lng) / 2 };
  const log = loadHandler('base44/functions/canvasLogHouseDecision/entry.ts', {
    base44: makeBase44(rep, state)
  });
  const request = {
    campaign_id: session.id,
    zone_id: zone.zone_id,
    idempotency_key: 'decision:recover-receipt',
    client_recorded_at: new Date().toISOString(),
    point,
    address: '300 Main Street',
    outcome: 'appointment'
  };
  state.failEventCommitOnce = true;
  const interrupted = await invoke(log, request);
  assert.equal(interrupted.response.status, 503);
  assert.equal(state.pins.length, 1);
  assert.equal(state.pins[0].version, 1);
  assert.equal(state.events[0].write_status, 'pending');

  const recovered = await invoke(log, request);
  assert.equal(recovered.response.status, 200, JSON.stringify(recovered.result));
  assert.equal(state.pins.length, 1);
  assert.equal(state.pins[0].version, 1);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].write_status, 'committed');
});

test('twenty independent Canvas zones accept concurrent decisions without a campaign-wide lock', async () => {
  const count = 20;
  const state = makeState();
  state.members = Array.from({ length: count }, (_, index) => ({
    id: `tm_${index + 1}`, name: `Rep ${index + 1}`, email: `parallel${index + 1}@example.com`,
    user_id: `parallel_auth_${index + 1}`, role: 'rep', status: 'active', manager_id: 'manager_1',
  }));
  state.users = [managerUser(), ...state.members.map((member) => ({
    id: member.user_id, email: member.email, role: 'user', app_role: 'rep', team_manager_id: 'manager_1',
  }))];
  const { plan, network } = parallelZonePlan(count);
  const { saved } = await savePlan(state, plan);
  const deployed = await deployPlan(state, saved, { idempotency_key: 'deploy:parallel-zones', network });
  assert.equal(deployed.response.status, 200, JSON.stringify(deployed.result));
  assert.equal(state.decisionCampaignStates.length, 1);
  assert.equal(state.decisionZoneStates.length, count);
  const session = state.sessions[0];
  const log = loadHandler('base44/functions/canvasLogHouseDecision/entry.ts', { base44: makeBase44(managerUser(), state) });
  const requests = session.zones.map((zone, index) => {
    const unit = session.work_units.find((candidate) => zone.work_unit_ids.includes(candidate.id));
    const segment = unit.segments[0];
    return {
      campaign_id: session.id,
      zone_id: zone.zone_id,
      street_unit_id: unit.id,
      idempotency_key: `decision:parallel:${String(index + 1).padStart(2, '0')}`,
      client_recorded_at: new Date().toISOString(),
      point: { lat: (segment.start.lat + segment.end.lat) / 2, lng: (segment.start.lng + segment.end.lng) / 2 },
      outcome: 'no_answer',
      address: `${index + 1} Parallel Street`,
    };
  });
  const results = await Promise.all(requests.map((request) => invoke(log, request)));
  assert.deepEqual(results.map((result) => result.response.status), Array(count).fill(200), results.map((result) => result.result));
  assert.equal(state.events.filter((event) => event.write_status === 'committed').length, count);
  assert.equal(state.pins.length, count);
  assert.ok(state.decisionZoneStates.every((zoneState) => zoneState.lease_token === undefined));
  assert.equal(session.canvas_field_write_lock_token, undefined);
});

test('same-pin concurrent retries remain CAS-safe and idempotent inside one zone', async () => {
  const state = makeState();
  const { saved } = await savePlan(state);
  const deployed = await deployPlan(state, saved, { idempotency_key: 'deploy:same-pin-concurrency' });
  assert.equal(deployed.response.status, 200, JSON.stringify(deployed.result));
  const session = state.sessions[0];
  const zone = session.zones[0];
  const unit = session.work_units.find((candidate) => zone.work_unit_ids.includes(candidate.id));
  const segment = unit.segments[0];
  const request = {
    campaign_id: session.id,
    zone_id: zone.zone_id,
    street_unit_id: unit.id,
    idempotency_key: 'decision:same-pin-race',
    client_recorded_at: new Date().toISOString(),
    point: { lat: (segment.start.lat + segment.end.lat) / 2, lng: (segment.start.lng + segment.end.lng) / 2 },
    outcome: 'callback',
    address: '42 Race Street',
  };
  const base44 = makeBase44(managerUser(), state);
  const originalZoneUpdate = base44.asServiceRole.entities.CanvasDecisionZoneState.updateMany;
  let leaseArrivals = 0;
  let releaseFirstLeaseAttempt;
  const secondLeaseArrived = new Promise((resolve) => { releaseFirstLeaseAttempt = resolve; });
  base44.asServiceRole.entities.CanvasDecisionZoneState.updateMany = async (...args) => {
    if (args[1]?.$set?.lease_token) {
      leaseArrivals += 1;
      if (leaseArrivals === 1) await secondLeaseArrived;
      else if (leaseArrivals === 2) releaseFirstLeaseAttempt();
    }
    return originalZoneUpdate(...args);
  };
  const log = loadHandler('base44/functions/canvasLogHouseDecision/entry.ts', { base44 });
  const raced = await Promise.all([invoke(log, request), invoke(log, request)]);
  assert.deepEqual(raced.map((result) => result.response.status).sort(), [200, 409]);
  assert.equal(raced.find((result) => result.response.status === 409).result.error, 'zone_decision_write_in_progress');
  const retry = await invoke(log, request);
  assert.equal(retry.response.status, 200, JSON.stringify(retry.result));
  assert.equal(retry.result.idempotent, true);
  assert.equal(state.pins.length, 1);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].write_status, 'committed');
});

test('close fences new decisions, waits an active zone lease, and resumes idempotently', async () => {
  const state = makeState();
  const { saved } = await savePlan(state);
  const deployed = await deployPlan(state, saved, { idempotency_key: 'deploy:close-fence' });
  assert.equal(deployed.response.status, 200, JSON.stringify(deployed.result));
  const session = state.sessions[0];
  const leasedZoneState = state.decisionZoneStates[0];
  Object.assign(leasedZoneState, {
    lease_token: 'simulated-active-write',
    lease_actor_user_id: 'auth_rep_1',
    lease_acquired_at: new Date().toISOString(),
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  const close = loadHandler('base44/functions/canvasCloseCampaign/entry.ts', { base44: makeBase44(managerUser(), state) });
  const closeRequest = { session_id: session.id, action: 'complete', expected_version: session.version, idempotency_key: 'close:fenced-campaign' };
  const draining = await invoke(close, closeRequest);
  assert.equal(draining.response.status, 409, JSON.stringify(draining.result));
  assert.equal(draining.result.error, 'campaign_decisions_draining');
  assert.equal(state.decisionCampaignStates[0].state, 'draining');
  assert.equal(session.status, 'deployed');

  const otherZone = session.zones[1];
  const otherUnit = session.work_units.find((candidate) => otherZone.work_unit_ids.includes(candidate.id));
  const otherSegment = otherUnit.segments[0];
  const log = loadHandler('base44/functions/canvasLogHouseDecision/entry.ts', { base44: makeBase44(managerUser(), state) });
  const rejected = await invoke(log, {
    campaign_id: session.id, zone_id: otherZone.zone_id, street_unit_id: otherUnit.id,
    idempotency_key: 'decision:after-close-fence', client_recorded_at: new Date().toISOString(),
    point: { lat: (otherSegment.start.lat + otherSegment.end.lat) / 2, lng: (otherSegment.start.lng + otherSegment.end.lng) / 2 }, outcome: 'no_answer',
  });
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.result.error, 'campaign_not_active');

  delete leasedZoneState.lease_token;
  delete leasedZoneState.lease_actor_user_id;
  delete leasedZoneState.lease_acquired_at;
  delete leasedZoneState.lease_expires_at;
  const completed = await invoke(close, closeRequest);
  assert.equal(completed.response.status, 200, JSON.stringify(completed.result));
  assert.equal(completed.result.status, 'completed');
  assert.equal(state.decisionCampaignStates[0].state, 'completed');
  const repeated = await invoke(close, closeRequest);
  assert.equal(repeated.response.status, 200, JSON.stringify(repeated.result));
  assert.equal(repeated.result.idempotent, true);
});

test('a reloaded close client adopts the signed same-action drain key but cannot change the action', async () => {
  const state = makeState();
  const { saved } = await savePlan(state);
  const deployed = await deployPlan(state, saved, { idempotency_key: 'deploy:close-reload' });
  assert.equal(deployed.response.status, 200, JSON.stringify(deployed.result));
  const session = state.sessions[0];
  const leasedZoneState = state.decisionZoneStates[0];
  Object.assign(leasedZoneState, {
    lease_token: 'simulated-reload-write',
    lease_actor_user_id: 'auth_rep_1',
    lease_acquired_at: new Date().toISOString(),
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  const originalVersion = session.version;
  const firstHandler = loadHandler('base44/functions/canvasCloseCampaign/entry.ts', { base44: makeBase44(managerUser(), state) });
  const first = await invoke(firstHandler, {
    session_id: session.id, action: 'complete', expected_version: originalVersion, idempotency_key: 'close:original-drain-key'
  });
  assert.equal(first.response.status, 409, JSON.stringify(first.result));
  assert.equal(first.result.error, 'campaign_decisions_draining');
  assert.equal(state.decisionCampaignStates[0].transition_idempotency_key, 'close:original-drain-key');

  const conflicting = await invoke(firstHandler, {
    session_id: session.id, action: 'recall', expected_version: originalVersion, idempotency_key: 'close:conflicting-action'
  });
  assert.equal(conflicting.response.status, 409, JSON.stringify(conflicting.result));
  assert.equal(conflicting.result.error, 'campaign_transition_in_progress');

  for (const field of ['lease_token', 'lease_actor_user_id', 'lease_acquired_at', 'lease_expires_at']) delete leasedZoneState[field];
  const reloadedHandler = loadHandler('base44/functions/canvasCloseCampaign/entry.ts', { base44: makeBase44(managerUser(), state) });
  const recovered = await invoke(reloadedHandler, {
    session_id: session.id, action: 'complete', expected_version: originalVersion, idempotency_key: 'close:new-client-key'
  });
  assert.equal(recovered.response.status, 200, JSON.stringify(recovered.result));
  assert.equal(session.status, 'completed');
  assert.equal(session.close_idempotency_key, 'close:original-drain-key');
  assert.equal(state.decisionCampaignStates[0].transition_idempotency_key, 'close:original-drain-key');
  assert.equal(state.decisionCampaignStates[0].state, 'completed');

  const afterCommitReload = loadHandler('base44/functions/canvasCloseCampaign/entry.ts', { base44: makeBase44(managerUser(), state) });
  const idempotent = await invoke(afterCommitReload, {
    session_id: session.id, action: 'complete', expected_version: session.version, idempotency_key: 'close:third-client-key'
  });
  assert.equal(idempotent.response.status, 200, JSON.stringify(idempotent.result));
  assert.equal(idempotent.result.idempotent, true);
  assert.equal(session.close_idempotency_key, 'close:original-drain-key');
});

test('decision-state lookups are tenant scoped even when another tenant reuses a campaign identity', async () => {
  const state = makeState();
  const { saved } = await savePlan(state);
  const deployed = await deployPlan(state, saved, { idempotency_key: 'deploy:tenant-decision-state' });
  assert.equal(deployed.response.status, 200, JSON.stringify(deployed.result));
  const session = state.sessions[0];
  state.decisionCampaignStates.push({
    ...structuredClone(state.decisionCampaignStates[0]), id: 'foreign-decision-gate', manager_id: 'manager_other', state_signature: 'forged-foreign-signature',
  });
  const zone = session.zones[0];
  const unit = session.work_units.find((candidate) => zone.work_unit_ids.includes(candidate.id));
  const segment = unit.segments[0];
  const request = {
    campaign_id: session.id, zone_id: zone.zone_id, street_unit_id: unit.id,
    idempotency_key: 'decision:tenant-scoped-state', client_recorded_at: new Date().toISOString(),
    point: { lat: (segment.start.lat + segment.end.lat) / 2, lng: (segment.start.lng + segment.end.lng) / 2 }, outcome: 'sale',
  };
  const managerLog = loadHandler('base44/functions/canvasLogHouseDecision/entry.ts', { base44: makeBase44(managerUser(), state) });
  const accepted = await invoke(managerLog, request);
  assert.equal(accepted.response.status, 200, JSON.stringify(accepted.result));
  const otherManager = { id: 'manager_other', email: 'other-manager@example.com', role: 'admin', app_role: 'manager' };
  const foreignLog = loadHandler('base44/functions/canvasLogHouseDecision/entry.ts', { base44: makeBase44(otherManager, state) });
  const forbidden = await invoke(foreignLog, { ...request, idempotency_key: 'decision:foreign-manager' });
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.result.error, 'forbidden');
});

test('manager can reopen a saved draft with its exact replay and assignment metadata', async () => {
  const state = makeState();
  const plan = productionPlan({ divisionMode: 'street_workload_target', targetWorkload: 2000 });
  const { saved } = await savePlan(state, plan);
  const map = loadHandler('base44/functions/canvasGetCampaignMap/entry.ts', {
    base44: makeBase44(managerUser(), state)
  });
  const result = await invoke(map, { campaign_id: saved.result.session_id });
  assert.equal(result.response.status, 200, JSON.stringify(result.result));
  assert.equal(result.result.campaign.status, 'draft');
  assert.equal(result.result.campaign.algorithm_version, plan.algorithm_version);
  assert.equal(result.result.campaign.data_version, plan.data_version);
  assert.equal(result.result.campaign.area_count, plan.zones.length);
  assert.equal(result.result.campaign.rep_count, 2);
  assert.deepEqual(result.result.campaign.selected_team_member_ids, ['tm_1', 'tm_2']);
  assert.equal(result.result.campaign.qa.deployable, true);
  assert.equal(result.result.campaign.plan_hash, saved.result.plan_hash);
});

test('replanned drafts update the same session with an incremented optimistic version', async () => {
  const state = makeState();
  const base44 = makeBase44(managerUser(), state);
  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44 });
  const first = await invoke(save, productionPlan());
  assert.equal(first.response.status, 200, JSON.stringify(first.result));
  const replanned = productionPlan({ divisionMode: 'area_count' });
  const second = await invoke(save, {
    ...replanned,
    session_id: first.result.session_id,
    expected_version: first.result.version,
  });
  assert.equal(second.response.status, 200, JSON.stringify(second.result));
  assert.equal(second.result.session_id, first.result.session_id);
  assert.equal(second.result.version, first.result.version + 1);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].id, first.result.session_id);
});

test('manager map is global while rep map never exposes another rep zone or pin', async () => {
  const state = makeState();
  const { saved } = await savePlan(state);
  const deployed = await deployPlan(state, saved, { idempotency_key: 'deploy:map-scope' });
  assert.equal(deployed.response.status, 200);
  const session = state.sessions[0];
  const now = new Date().toISOString();
  state.pins.push(
    { id: 'pin_a', manager_id: 'manager_1', campaign_id: session.id, zone_id: session.zones[0].zone_id, lat: 35, lng: -82, latest_outcome: 'sale', version: 1, last_event_at: now },
    { id: 'pin_b', manager_id: 'manager_1', campaign_id: session.id, zone_id: session.zones[1].zone_id, lat: 35, lng: -81.995, latest_outcome: 'no_answer', version: 1, last_event_at: now }
  );
  const managerMap = loadHandler('base44/functions/canvasGetCampaignMap/entry.ts', { base44: makeBase44(managerUser(), state) });
  const managerResult = await invoke(managerMap, { campaign_id: session.id });
  assert.equal(managerResult.response.status, 200, JSON.stringify(managerResult.result));
  assert.equal(managerResult.result.access_scope, 'manager_global');
  assert.equal(managerResult.result.campaign.zones.length, 2);
  assert.equal(managerResult.result.pins.length, 2);
  assert.deepEqual({ ...managerResult.result.outcome_counts }, { sale: 1, no_answer: 1 });

  const rep = state.users.find((user) => user.id === 'auth_rep_1');
  const repMap = loadHandler('base44/functions/canvasGetCampaignMap/entry.ts', { base44: makeBase44(rep, state) });
  const repResult = await invoke(repMap, { campaign_id: session.id });
  assert.equal(repResult.response.status, 200, JSON.stringify(repResult.result));
  assert.equal(repResult.result.access_scope, 'rep_assigned_zones');
  assert.equal(repResult.result.campaign.zones.length, 1);
  assert.equal(repResult.result.pins.length, 1);
  assert.equal(repResult.result.pins[0].zone_id, repResult.result.campaign.zones[0].zone_id);
});

test('rep map pagination is scoped to visible zones before campaign-wide caps', async () => {
  const state = makeState();
  const { saved } = await savePlan(state);
  const deployed = await deployPlan(state, saved, { idempotency_key: 'deploy:rep-zone-pagination' });
  assert.equal(deployed.response.status, 200, JSON.stringify(deployed.result));
  const session = state.sessions[0];
  const ownZone = session.zones.find((zone) => zone.assigned_team_member_id === 'tm_1');
  const otherZone = session.zones.find((zone) => zone.zone_id !== ownZone.zone_id);
  for (let index = 0; index < 10000; index += 1) {
    state.pins.push({
      id: `pin_other_${index}`,
      manager_id: 'manager_1',
      campaign_id: session.id,
      zone_id: otherZone.zone_id,
      lat: 35,
      lng: -82,
      latest_outcome: 'no_answer',
      version: 1,
      last_event_at: `2026-07-18T12:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`
    });
  }
  state.pins.push({
    id: 'pin_own_older', manager_id: 'manager_1', campaign_id: session.id,
    zone_id: ownZone.zone_id, lat: 35, lng: -82, latest_outcome: 'callback',
    version: 1, last_event_at: '2020-01-01T00:00:00.000Z'
  });
  for (let index = 0; index < 20000; index += 1) {
    state.events.push({
      id: `event_other_${index}`,
      manager_id: 'manager_1',
      campaign_id: session.id,
      zone_id: otherZone.zone_id,
      write_status: 'committed',
      outcome: 'no_answer',
      server_recorded_at: `2026-07-18T13:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`
    });
  }
  state.events.push({
    id: 'event_own_older', pin_id: 'pin_own_older', manager_id: 'manager_1',
    campaign_id: session.id, zone_id: ownZone.zone_id, write_status: 'committed',
    outcome: 'callback', server_recorded_at: '2020-01-01T00:00:00.000Z'
  });

  const rep = state.users.find((user) => user.id === 'auth_rep_1');
  const repMap = loadHandler('base44/functions/canvasGetCampaignMap/entry.ts', { base44: makeBase44(rep, state) });
  const result = await invoke(repMap, { campaign_id: session.id, include_events: true });
  assert.equal(result.response.status, 200, JSON.stringify(result.result));
  assert.deepEqual(result.result.pins.map((pin) => pin.pin_id), ['pin_own_older']);
  assert.deepEqual(result.result.events.map((event) => event.event_id), ['event_own_older']);
  assert.deepEqual({ ...result.result.truncated }, { pins: false, events: false });
});

test('old do-not-knock pins remain complete beyond the bounded general-history window', async () => {
  const state = makeState();
  const { saved } = await savePlan(state);
  const deployed = await deployPlan(state, saved, { idempotency_key: 'deploy:dnc-complete' });
  assert.equal(deployed.response.status, 200, JSON.stringify(deployed.result));
  const session = state.sessions[0];
  const ownZone = session.zones.find((zone) => zone.assigned_team_member_id === 'tm_1');
  state.pins.push(
    { id: 'pin_recent_1', manager_id: 'manager_1', campaign_id: session.id, zone_id: ownZone.zone_id, lat: 35, lng: -82, latest_outcome: 'callback', version: 1, last_event_at: '2026-07-18T12:02:00.000Z' },
    { id: 'pin_recent_2', manager_id: 'manager_1', campaign_id: session.id, zone_id: ownZone.zone_id, lat: 35, lng: -82, latest_outcome: 'sale', version: 1, last_event_at: '2026-07-18T12:01:00.000Z' },
    { id: 'pin_old_dnc', manager_id: 'manager_1', campaign_id: session.id, zone_id: ownZone.zone_id, lat: 35, lng: -82, latest_outcome: 'do_not_knock', version: 1, last_event_at: '2020-01-01T00:00:00.000Z' }
  );
  const rep = state.users.find((user) => user.id === 'auth_rep_1');
  const map = loadHandler('base44/functions/canvasGetCampaignMap/entry.ts', {
    base44: makeBase44(rep, state),
    sourceTransform: (source) => source.replace('var MAX_PINS = 1e4;', 'var MAX_PINS = 2;')
  });
  const result = await invoke(map, { campaign_id: session.id });
  assert.equal(result.response.status, 200, JSON.stringify(result.result));
  assert.equal(result.result.truncated.pins, true);
  assert.equal(result.result.dnc_safety.complete, true);
  assert.equal(result.result.dnc_safety.pin_count, 1);
  assert.ok(result.result.pins.some((pin) => pin.pin_id === 'pin_old_dnc'));
});

test('campaign map fails closed instead of returning a partial do-not-knock list', async () => {
  const state = makeState();
  const { saved } = await savePlan(state);
  const deployed = await deployPlan(state, saved, { idempotency_key: 'deploy:dnc-ceiling' });
  assert.equal(deployed.response.status, 200, JSON.stringify(deployed.result));
  const session = state.sessions[0];
  const ownZone = session.zones.find((zone) => zone.assigned_team_member_id === 'tm_1');
  for (let index = 0; index < 3; index += 1) {
    state.pins.push({
      id: `pin_dnc_${index}`, manager_id: 'manager_1', campaign_id: session.id,
      zone_id: ownZone.zone_id, lat: 35, lng: -82, latest_outcome: 'do_not_knock',
      version: 1, last_event_at: `2026-07-18T12:0${index}:00.000Z`
    });
  }
  const rep = state.users.find((user) => user.id === 'auth_rep_1');
  const map = loadHandler('base44/functions/canvasGetCampaignMap/entry.ts', {
    base44: makeBase44(rep, state),
    sourceTransform: (source) => source.replace('var MAX_DNC_PINS = 2e4;', 'var MAX_DNC_PINS = 2;')
  });
  const result = await invoke(map, { campaign_id: session.id });
  assert.equal(result.response.status, 503);
  assert.equal(result.result.error, 'dnc_safety_limit_exceeded');
});

test('overlap replacement is explicit and manager list derives superseded status', async () => {
  const state = makeState();
  const first = await savePlan(state);
  const deployedFirst = await deployPlan(state, first.saved, { idempotency_key: 'deploy:first' });
  assert.equal(deployedFirst.response.status, 200);
  const second = await savePlan(state);
  const conflict = await deployPlan(state, second.saved, { idempotency_key: 'deploy:second' });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.result.error, 'canvas_deployment_overlap');
  assert.deepEqual([...conflict.result.details.required_supersede_session_ids], [first.saved.result.session_id]);
  const replaced = await deployPlan(state, second.saved, {
    idempotency_key: 'deploy:second',
    supersede_session_ids: [first.saved.result.session_id]
  });
  assert.equal(replaced.response.status, 200, JSON.stringify(replaced.result));

  const list = loadHandler('base44/functions/canvasListCampaigns/entry.ts', { base44: makeBase44(managerUser(), state) });
  const listed = await invoke(list, {});
  assert.equal(listed.response.status, 200);
  const predecessor = listed.result.campaigns.find((campaign) => campaign.session_id === first.saved.result.session_id);
  assert.equal(predecessor.status, 'superseded');
  assert.equal(predecessor.stored_status, 'deployed');
  assert.equal(predecessor.superseded_by_session_id, second.saved.result.session_id);

  const directState = state.decisionCampaignStates.find((item) => item.campaign_id === first.saved.result.session_id);
  assert.equal(directState.state, 'superseded');
  assert.equal(directState.superseded_by_campaign_id, second.saved.result.session_id);
  const oldSession = state.sessions.find((item) => item.id === first.saved.result.session_id);
  const oldZone = oldSession.zones[0];
  const oldUnit = oldSession.work_units.find((unit) => oldZone.work_unit_ids.includes(unit.id));
  const oldSegment = oldUnit.segments[0];
  const noScanBase44 = makeBase44(managerUser(), state);
  noScanBase44.asServiceRole.entities.CanvasSession.filter = async () => { throw new Error('decision reads must not scan lifecycle history'); };
  const log = loadHandler('base44/functions/canvasLogHouseDecision/entry.ts', { base44: noScanBase44 });
  const rejectedDecision = await invoke(log, {
    campaign_id: oldSession.id, zone_id: oldZone.zone_id, street_unit_id: oldUnit.id,
    idempotency_key: 'decision:direct-supersession', client_recorded_at: new Date().toISOString(),
    point: { lat: (oldSegment.start.lat + oldSegment.end.lat) / 2, lng: (oldSegment.start.lng + oldSegment.end.lng) / 2 }, outcome: 'no_answer',
  });
  assert.equal(rejectedDecision.response.status, 409, JSON.stringify(rejectedDecision.result));
  assert.equal(rejectedDecision.result.error, 'campaign_superseded');
  const map = loadHandler('base44/functions/canvasGetCampaignMap/entry.ts', { base44: noScanBase44 });
  const oldMap = await invoke(map, { campaign_id: oldSession.id });
  assert.equal(oldMap.response.status, 200, JSON.stringify(oldMap.result));
  assert.equal(oldMap.result.campaign.status, 'superseded');
  assert.equal(oldMap.result.campaign.superseded_by_session_id, second.saved.result.session_id);
});

test('supersession resumes across reload keys and replays the exact signed predecessor transition after commit', async () => {
  const state = makeState();
  const first = await savePlan(state);
  const firstDeploy = await deployPlan(state, first.saved, { idempotency_key: 'deploy:predecessor' });
  assert.equal(firstDeploy.response.status, 200, JSON.stringify(firstDeploy.result));
  const predecessor = state.sessions.find((session) => session.id === first.saved.result.session_id);
  const second = await savePlan(state);
  const supersedeIds = [predecessor.id];

  state.failDeploymentCommitOnce = true;
  const interruptedBeforeCommit = await deployPlan(state, second.saved, {
    idempotency_key: 'deploy:successor-first-key', supersede_session_ids: supersedeIds
  });
  assert.equal(interruptedBeforeCommit.response.status, 409, JSON.stringify(interruptedBeforeCommit.result));
  assert.equal(state.sessions.find((session) => session.id === second.saved.result.session_id).status, 'draft');
  const predecessorGate = state.decisionCampaignStates.find((item) => item.campaign_id === predecessor.id);
  assert.equal(predecessorGate.state, 'draining');
  const durableTransitionKey = predecessorGate.transition_idempotency_key;

  state.failSupersessionFinalizeOnce = true;
  const committedWithoutFinalize = await deployPlan(state, second.saved, {
    idempotency_key: 'deploy:successor-reloaded-key', supersede_session_ids: supersedeIds
  });
  assert.equal(committedWithoutFinalize.response.status, 409, JSON.stringify(committedWithoutFinalize.result));
  const successor = state.sessions.find((session) => session.id === second.saved.result.session_id);
  assert.equal(successor.status, 'deployed', 'the signed successor commit completed before the simulated finalize failure');
  assert.equal(predecessorGate.state, 'draining');
  assert.deepEqual(successor.deployment_qa.supersession_transitions, [{
    predecessor_session_id: predecessor.id,
    transition_idempotency_key: durableTransitionKey,
  }]);
  assert.equal(await verifyCanvasLifecycleSession(SIGNING_SECRET, successor, 'active'), true);

  const recovered = await deployPlan(state, second.saved, { idempotency_key: 'deploy:successor-third-key' });
  assert.equal(recovered.response.status, 200, JSON.stringify(recovered.result));
  assert.equal(recovered.result.idempotent, true);
  assert.equal(successor.deployment_idempotency_key, 'deploy:successor-reloaded-key');
  assert.equal(predecessorGate.state, 'superseded');
  assert.equal(predecessorGate.transition_idempotency_key, durableTransitionKey);
  assert.equal(predecessorGate.superseded_by_campaign_id, successor.id);
});

test('missing signing configuration hides active records but still returns resumable drafts', async () => {
  const state = makeState();
  const first = await savePlan(state);
  const deployed = await deployPlan(state, first.saved, { idempotency_key: 'deploy:signing-missing-list' });
  assert.equal(deployed.response.status, 200, JSON.stringify(deployed.result));
  const second = await savePlan(state);
  const list = loadHandler('base44/functions/canvasListCampaigns/entry.ts', {
    base44: makeBase44(managerUser(), state),
    env: {},
  });
  const listed = await invoke(list, {});
  assert.equal(listed.response.status, 200, JSON.stringify(listed.result));
  assert.equal(listed.result.signing_configured, false);
  assert.equal(listed.result.rejected_campaigns, 1);
  assert.deepEqual(listed.result.campaigns.map((campaign) => campaign.session_id), [second.saved.result.session_id]);
  assert.equal(listed.result.campaigns[0].stored_status, 'draft');
});

test('exact user_id binding prevents email-only or relinked assignment access', async () => {
  const state = makeState();
  const { saved } = await savePlan(state);
  const deployed = await deployPlan(state, saved, { idempotency_key: 'deploy:binding' });
  assert.equal(deployed.response.status, 200);
  const member = state.members.find((candidate) => candidate.id === 'tm_1');
  member.user_id = null;
  const rep = state.users.find((user) => user.id === 'auth_rep_1');
  const assignments = loadHandler('base44/functions/canvasGetMyAssignments/entry.ts', { base44: makeBase44(rep, state) });
  const result = await invoke(assignments, {});
  assert.equal(result.response.status, 403);
  assert.equal(result.result.error, 'team_membership_required');
});

test('service-role writes remain downstream of explicit tenant and assignment checks', () => {
  const save = readSource('base44/functions/canvasSaveDraft/entry.ts');
  const deploy = readSource('base44/functions/canvasDeployCampaign/entry.ts');
  const log = readSource('base44/functions/canvasLogHouseDecision/entry.ts');
  const map = readSource('base44/functions/canvasGetCampaignMap/entry.ts');
  assert.ok(save.indexOf("existing.manager_id || '') !== String(user.id") < save.indexOf('asServiceRole.entities.CanvasSession.updateMany'));
  assert.ok(deploy.lastIndexOf('session.manager_id !== user.id') < deploy.lastIndexOf('lease = await acquireManagerLease'));
  assert.ok(log.indexOf("session.manager_id || '') !== String(expectedManagerId") < log.indexOf('acquireZoneDecisionLease(base44, session'));
  assert.match(log, /nearest\.zone_id !== requestedZoneId/);
  assert.match(log, /CanvasDecisionZoneState\.updateMany/);
  assert.match(map, /visibleZoneIds\.has\(String\(pin\.zone_id\)\)/);
  assert.doesNotMatch(log, /MasterProperty|SavedRoute|Precision|DATABASE_URL/);
});
