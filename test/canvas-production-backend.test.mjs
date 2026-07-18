import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { polygon as geoJsonPolygon } from 'turf-helpers';
import intersectPolygons from 'turf-intersect';

import { planCanvasTerritories } from '../src/components/logic/canvasStreetTerritoryPlanner.js';
import { buildCanvasStreetWorkUnits } from '../src/components/logic/canvasStreetTopology.js';
import {
  canvasRepTeamMemberIds,
  canvasStoredPlanForHash,
  signCanvasLifecycle,
  verifyCanvasLifecycleSession
} from '../base44/functions/canvasDeployCampaign/canvasLifecycleSignature.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');
const TEST_SIGNING_SECRET = 'test-canvas-signing-secret-32-bytes-minimum';

function loadHandler(path, {
  base44,
  stripeApi = null,
  roadNetwork = serverRoadNetwork(),
  fetchImpl = null,
  deployLockState = new Set(),
  env = {
    STRIPE_SECRET_KEY: 'sk_test',
    CANVAS_DEPLOYMENT_SIGNING_SECRET: TEST_SIGNING_SECRET,
    DATABASE_URL: 'postgresql://canvas-test'
  }
}) {
  const transpiled = ts.transpileModule(readSource(path), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: path,
    reportDiagnostics: true
  });
  const errors = (transpiled.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], `${path} contains TypeScript syntax errors`);

  let handler;
  class FakeStripe {
    constructor() {
      if (!stripeApi) throw new Error('Stripe should not be constructed in this test.');
      return stripeApi;
    }
  }
  class FakeDatabaseClient {
    async connect() {}

    async query(statement, parameters = []) {
      if (statement === 'BEGIN') return { rows: [] };
      if (statement.includes('pg_try_advisory_xact_lock')) {
        const key = String(parameters[0]);
        if (deployLockState.has(key)) return { rows: [{ acquired: false }] };
        deployLockState.add(key);
        this.lockKey = key;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
        return { rows: [{ acquired: true }] };
      }
      if (statement === 'COMMIT' || statement === 'ROLLBACK') {
        if (this.lockKey) deployLockState.delete(this.lockKey);
        this.lockKey = null;
        return { rows: [] };
      }
      throw new Error(`Unexpected database statement: ${statement}`);
    }

    async end() {
      if (this.lockKey) deployLockState.delete(this.lockKey);
      this.lockKey = null;
    }
  }
  const topologyFetch = fetchImpl || (async () => new Response(JSON.stringify(roadNetwork), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  }));
  const executable = transpiled.outputText.replace(/^import .*;\s*$/gm, '');
  vm.runInNewContext(executable, {
    console,
    createClientFromRequest: () => base44,
    Client: FakeDatabaseClient,
    Stripe: FakeStripe,
    planCanvasTerritories,
    canvasRepTeamMemberIds,
    canvasStoredPlanForHash,
    signCanvasLifecycle,
    verifyCanvasLifecycleSession,
    crypto: webcrypto,
    TextEncoder,
    Request,
    Response,
    URL,
    URLSearchParams,
    AbortController,
    fetch: topologyFetch,
    setTimeout,
    clearTimeout,
    Deno: {
      env: { get: (key) => env[key] || null },
      serve: (registeredHandler) => { handler = registeredHandler; }
    }
  }, { filename: path });
  return handler;
}

const topologyPolygon = [
  { lat: 34.999, lng: -82.011 },
  { lat: 34.999, lng: -81.989 },
  { lat: 35.011, lng: -81.989 },
  { lat: 35.011, lng: -82.011 }
];

const roadNode = (id, lat, lon, tags = {}) => ({ type: 'node', id, lat, lon, tags });
const roadWay = (id, nodes, name) => ({ type: 'way', id, nodes, tags: { highway: 'residential', name } });

function serverRoadNetwork() {
  return {
    elements: [
      roadNode(1, 35, -82.011),
      roadNode(2, 35, -82),
      roadNode(3, 35, -81.989),
      roadNode(4, 35.004, -82),
      roadNode(5, 35.006, -82.001),
      roadNode(6, 35.008, -82, { highway: 'turning_circle' }),
      roadNode(7, 35.006, -81.999),
      roadWay(100, [1, 2, 3], 'Main Street'),
      roadWay(300, [2, 4], 'Loop Court'),
      roadWay(301, [4, 5, 6, 7, 4], 'Loop Court')
    ]
  };
}

function analysisDoors() {
  return [
    { id: 'building:1', stable_door_id: 'building:1', lat: 35.00005, lng: -82.006, streetName: 'Main Street' },
    { id: 'building:2', stable_door_id: 'building:2', lat: 35.00005, lng: -81.994, streetName: 'Main St' },
    { id: 'building:3', stable_door_id: 'building:3', lat: 35.002, lng: -81.99995, streetName: 'Loop Court' },
    { id: 'building:4', stable_door_id: 'building:4', lat: 35.006, lng: -82.0009, streetName: 'Loop Ct' },
    { id: 'building:5', stable_door_id: 'building:5', lat: 35.006, lng: -81.9991, streetName: 'Loop Court' }
  ];
}

function asItems(records, filter) {
  return records.filter((record) => Object.entries(filter || {}).every(([key, value]) => record[key] === value));
}

function makeState() {
  return {
    sessions: [],
    members: [
      { id: 'tm_1', name: 'Rep One', email: 'rep1@example.com', user_id: 'auth_rep_1', role: 'rep', status: 'active', manager_id: 'manager_1' },
      { id: 'tm_2', name: 'Rep Two', email: 'rep2@example.com', user_id: 'auth_rep_2', role: 'rep', status: 'active', manager_id: 'manager_1' },
      { id: 'tm_other', name: 'Other Rep', email: 'other@example.com', user_id: 'auth_other', role: 'rep', status: 'active', manager_id: 'manager_other' }
    ],
    users: [
      { id: 'auth_rep_1', email: 'rep1@example.com', team_manager_id: 'manager_1' },
      { id: 'auth_rep_2', email: 'rep2@example.com', team_manager_id: 'manager_1' },
      { id: 'auth_other', email: 'other@example.com', team_manager_id: 'manager_other' }
    ],
    analysis: {
      success: true,
      analysis: {
        id: 'analysis_1',
        manager_id: 'manager_1',
        total_opportunities: 5,
        polygon: topologyPolygon.map((point) => ({ ...point }))
      },
      opportunities: analysisDoors()
    },
    creates: [],
    updates: []
  };
}

function makeBase44(user, state) {
  return {
    auth: { me: async () => user },
    functions: {
      invoke: async (name, body) => {
        assert.equal(name, 'canvasGetAnalysis');
        assert.equal(body.analysisId, 'analysis_1');
        return { data: state.analysis };
      }
    },
    entities: {
      CanvasSession: {
        get: async (id) => {
          const session = state.sessions.find((candidate) => candidate.id === id);
          return session ? structuredClone(session) : null;
        },
        create: async (record) => {
          const saved = { id: `session_${state.sessions.length + 1}`, ...record };
          state.sessions.push(saved);
          state.creates.push(saved);
          return saved;
        },
        update: async (id, updates) => {
          const session = state.sessions.find((candidate) => candidate.id === id);
          if (!session) throw new Error('not found');
          Object.assign(session, updates);
          state.updates.push({ id, updates });
          return session;
        },
        filter: async (filter, _sort, limit, skip = 0) => asItems(state.sessions, filter).slice(skip, skip + limit)
      },
      TeamMember: {
        get: async (id) => state.members.find((member) => member.id === id) || null,
        filter: async (filter, _sort, limit) => asItems(state.members, filter).slice(0, limit)
      }
    },
    asServiceRole: {
      entities: {
        User: { get: async (id) => state.users.find((candidate) => candidate.id === id) || null },
        CanvasSession: {
          filter: async (filter, _sort, limit, skip = 0) => asItems(state.sessions, filter).slice(skip, skip + limit),
          create: async (record) => {
            const saved = { id: `session_${state.sessions.length + 1}`, ...record };
            state.sessions.push(saved);
            state.creates.push({ ...saved, service_role: true });
            return saved;
          },
          update: async (id, updates) => {
            const session = state.sessions.find((candidate) => candidate.id === id);
            if (!session) throw new Error('not found');
            Object.assign(session, updates);
            state.updates.push({ id, updates, service_role: true });
            return session;
          },
          updateMany: async (query, operation) => {
            const matches = state.sessions.filter((session) => Object.entries(query || {})
              .every(([key, value]) => session[key] === value));
            const updates = operation?.$set || operation || {};
            matches.forEach((session) => {
              Object.assign(session, updates);
              state.updates.push({ id: session.id, updates, service_role: true, guarded: true });
            });
            return { success: true, updated: matches.length, has_more: false };
          }
        }
      }
    }
  };
}

function managerUser(overrides = {}) {
  return {
    id: 'manager_1',
    email: 'manager@example.com',
    app_role: 'manager',
    role: 'user',
    subscription_tier: 'canvas',
    subscription_status: 'active',
    subscription_paid_confirmed: true,
    subscription_id: 'sub_canvas',
    ...overrides
  };
}

function validPlan() {
  const selectedTeamMemberIds = ['tm_1', 'tm_2'];
  const generated = planCanvasTerritories({
    polygon: topologyPolygon,
    roadNetwork: serverRoadNetwork(),
    doors: analysisDoors(),
    workload_basis: 'selected_reps',
    zoneCount: selectedTeamMemberIds.length,
    requested_zone_count: selectedTeamMemberIds.length,
    selected_team_member_ids: selectedTeamMemberIds,
    analysis_id: 'analysis_1'
  });
  assert.equal(generated.ok, true, JSON.stringify(generated));
  return {
    session_name: 'Canvas Topology Launch',
    polygon: topologyPolygon.map((point) => ({ ...point })),
    planning_method: generated.planning_method,
    assignment_basis: generated.assignment_basis,
    workload_basis: generated.workload_basis,
    selected_team_member_ids: selectedTeamMemberIds,
    target_homes: generated.doors.length,
    analysis_id: 'analysis_1',
    algorithm_version: generated.algorithm_version,
    data_version: generated.data_version,
    doors: generated.doors.map((door) => ({ ...door })),
    zones: generated.zones.map((zone, index) => ({
      ...zone,
      assigned_team_member_id: selectedTeamMemberIds[index]
    })),
    qa: { ...generated.qa }
  };
}

function liveCanvasStripe(userId = 'manager_1', seats = 2) {
  const periodStart = Math.floor(Date.now() / 1000) - 60;
  const subscription = {
    id: 'sub_canvas',
    status: 'active',
    current_period_start: periodStart,
    metadata: { base44_user_id: userId, subscription_tier: 'canvas' },
    items: {
      data: [{
        quantity: seats,
        price: { unit_amount: 1900, metadata: { subscription_tier: 'canvas' } }
      }]
    },
    latest_invoice: {
      id: 'in_canvas',
      status: 'paid',
      amount_paid: 1900 * seats,
      subscription: 'sub_canvas',
      period_start: periodStart,
      period_end: periodStart + 30 * 24 * 60 * 60,
      lines: { data: [] }
    }
  };
  return {
    subscriptions: {
      retrieve: async () => subscription,
      search: async () => ({ data: [subscription] }),
      list: async () => ({ data: [subscription] })
    },
    customers: { retrieve: async () => ({ id: 'cus_canvas', metadata: { base44_user_id: userId }, invoice_settings: {} }) }
  };
}

async function invoke(handler, body) {
  const response = await handler(new Request('https://firstknock.online/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }));
  return { response, result: await response.json() };
}

function evaluatePackagedTopologyModules() {
  const topologyExecutable = `${readSource('base44/functions/canvasDeployCampaign/canvasStreetTopology.js')
    .replace(/\bexport\s+/g, '')}\nglobalThis.__buildCanvasStreetWorkUnits = buildCanvasStreetWorkUnits;`;
  const topologyContext = {};
  vm.runInNewContext(topologyExecutable, topologyContext, { filename: 'packaged-canvasStreetTopology.js' });

  const plannerExecutable = `${readSource('base44/functions/canvasDeployCampaign/canvasStreetTerritoryPlanner.js')
    .replace(/^import .*;\s*$/gm, '')
    .replace(/\bexport\s+/g, '')}\nglobalThis.__planCanvasTerritories = planCanvasTerritories;`;
  const plannerContext = {
    buildCanvasStreetWorkUnits: topologyContext.__buildCanvasStreetWorkUnits,
    geoJsonPolygon,
    intersectPolygons
  };
  vm.runInNewContext(plannerExecutable, plannerContext, { filename: 'packaged-canvasStreetTerritoryPlanner.js' });
  return {
    buildCanvasStreetWorkUnits: topologyContext.__buildCanvasStreetWorkUnits,
    planCanvasTerritories: plannerContext.__planCanvasTerritories
  };
}

test('CanvasSession schema remains migration-safe while exposing production fields', () => {
  const schema = JSON.parse(readSource('base44/entities/CanvasSession.jsonc'));
  assert.deepEqual(schema.required, ['polygon', 'rep_count', 'zones', 'status']);
  assert.deepEqual(schema.properties.assignment_basis.enum, ['stable_door_ids', 'legacy_geometry']);
  assert.deepEqual(schema.properties.workload_basis.enum, ['selected_reps', 'homes_per_area']);
  assert.equal(schema.properties.selected_team_member_ids.items.type, 'string');
  assert.equal(schema.properties.deployment_qa.type, 'object');
  assert.equal(schema.properties.deployment_signature.type, 'string');
  assert.deepEqual(schema.properties.status.enum, ['draft', 'deployed', 'completed', 'recalled']);
  assert.deepEqual(schema.properties.lifecycle_state.enum, ['active', 'completed', 'recalled']);
  assert.deepEqual(schema.properties.close_action.enum, ['complete', 'recall']);
  assert.equal(schema.properties.lifecycle_evidence.type, 'object');
  assert.doesNotMatch(JSON.stringify(schema.rls.read), /team_manager_id|created_by/);
  assert.doesNotMatch(JSON.stringify(schema.rls.create), /manager_id/);
  assert.doesNotMatch(JSON.stringify(schema.rls.update), /manager_id/);
  assert.doesNotMatch(JSON.stringify(schema.rls.delete), /manager_id/);
});

test('Canvas opportunity rows preserve analysis provenance while exposing a cross-analysis stable door identity', () => {
  const setup = readSource('base44/functions/setupCanvasOpportunityTables/entry.ts');
  const analyze = readSource('base44/functions/canvasAnalyzeTerritory/entry.ts');
  const getAnalysis = readSource('base44/functions/canvasGetAnalysis/entry.ts');

  assert.match(setup, /ADD COLUMN IF NOT EXISTS stable_door_id TEXT/);
  assert.match(setup, /'building:' \|\| building_id::text/);
  assert.match(setup, /opportunities\(analysis_id, stable_door_id\)/);
  assert.match(analyze, /const opportunityRowId = `opp_\$\{analysisId\}_\$\{item\.building_id\}`/);
  assert.match(analyze, /const stableDoorId = stableDoorIdForBuilding\(item\.building_id\)/);
  assert.match(analyze, /INSERT INTO opportunities \(id, analysis_id, stable_door_id/);
  assert.match(getAnalysis, /id AS opportunity_row_id,\s*stable_door_id/);
  assert.match(getAnalysis, /id: item\.stable_door_id/);
});

test('function-local topology modules remain source and functionally identical to the frontend canonical planner', () => {
  const frontendTopology = readSource('src/components/logic/canvasStreetTopology.js');
  const packagedTopology = readSource('base44/functions/canvasDeployCampaign/canvasStreetTopology.js');
  assert.equal(packagedTopology, frontendTopology);

  const frontendPlanner = readSource('src/components/logic/canvasStreetTerritoryPlanner.js');
  const packagedPlanner = readSource('base44/functions/canvasDeployCampaign/canvasStreetTerritoryPlanner.js')
    .replace("from 'npm:turf-helpers@3.0.12'", "from 'turf-helpers'")
    .replace("from 'npm:turf-intersect@3.0.12'", "from 'turf-intersect'");
  assert.equal(packagedPlanner, frontendPlanner);

  const packaged = evaluatePackagedTopologyModules();
  const topologyInput = {
    polygon: topologyPolygon,
    roadNetwork: serverRoadNetwork(),
    doors: analysisDoors()
  };
  assert.deepEqual(
    JSON.parse(JSON.stringify(packaged.buildCanvasStreetWorkUnits(topologyInput))),
    buildCanvasStreetWorkUnits(topologyInput)
  );
  const plannerInput = {
    ...topologyInput,
    workload_basis: 'selected_reps',
    zoneCount: 2,
    requested_zone_count: 2,
    selected_team_member_ids: ['tm_1', 'tm_2'],
    analysis_id: 'analysis_1'
  };
  assert.deepEqual(
    JSON.parse(JSON.stringify(packaged.planCanvasTerritories(plannerInput))),
    planCanvasTerritories(plannerInput)
  );
});

test('deploy, rep reads, and close use byte-identical function-local lifecycle signing logic', () => {
  const deployCopy = readSource('base44/functions/canvasDeployCampaign/canvasLifecycleSignature.js');
  const repCopy = readSource('base44/functions/canvasGetMyAssignments/canvasLifecycleSignature.js');
  const closeCopy = readSource('base44/functions/canvasCloseCampaign/canvasLifecycleSignature.js');
  assert.equal(repCopy, deployCopy);
  assert.equal(closeCopy, deployCopy);
  assert.match(readSource('base44/functions/canvasDeployCampaign/entry.ts'), /from '\.\/canvasLifecycleSignature\.js'/);
  assert.match(readSource('base44/functions/canvasGetMyAssignments/entry.ts'), /from '\.\/canvasLifecycleSignature\.js'/);
  assert.match(readSource('base44/functions/canvasCloseCampaign/entry.ts'), /from '\.\/canvasLifecycleSignature\.js'/);
});

test('trusted save, live-entitled deploy, idempotent retry, and rep handoff work end to end', async () => {
  const state = makeState();
  const manager = managerUser();
  const managerBase44 = makeBase44(manager, state);
  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44: managerBase44 });
  const plan = validPlan();
  const saved = await invoke(save, plan);

  assert.equal(saved.response.status, 200);
  assert.equal(saved.result.status, 'draft');
  assert.equal(saved.result.qa.analysis_coverage_complete, true);
  assert.equal(saved.result.qa.work_units_intact, true);
  assert.match(saved.result.plan_hash, /^[a-f0-9]{64}$/);

  const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', {
    base44: managerBase44,
    stripeApi: liveCanvasStripe()
  });
  const deployed = await invoke(deploy, {
    session_id: saved.result.session_id,
    expected_version: saved.result.version,
    idempotency_key: 'deploy:launch-001'
  });
  assert.equal(deployed.response.status, 200);
  assert.equal(deployed.result.status, 'deployed');
  assert.equal(deployed.result.delivery_count, 2);
  assert.equal(state.sessions[0].lifecycle_state, 'active');
  assert.equal(state.sessions[0].deployment_qa.lifecycle_state, 'active');
  assert.equal(state.sessions[0].lifecycle_evidence.transition, 'deploy');
  assert.equal(state.sessions[0].deployment_plan_version, saved.result.version);
  assert.equal(await verifyCanvasLifecycleSession(TEST_SIGNING_SECRET, state.sessions[0], 'active'), true);
  assert.equal(state.sessions[0].deployment_qa.work_units_complete_and_exclusive, true);
  assert.equal(state.sessions[0].deployment_qa.server_topology_verified, true);
  assert.equal(state.sessions[0].deployment_qa.zone_display_geometry_verified, true);
  assert.equal(state.sessions[0].deployment_qa.connected_zones, true);
  assert.equal(state.sessions[0].deployment_qa.protected_units_intact, true);
  assert.equal(state.sessions[0].deployment_qa.cul_de_sac_splits, 0);
  assert.match(state.sessions[0].deployment_qa.road_snapshot_sha256, /^[a-f0-9]{64}$/);
  assert.match(state.sessions[0].deployment_qa.zone_display_sha256, /^[a-f0-9]{64}$/);

  const retried = await invoke(deploy, {
    session_id: saved.result.session_id,
    expected_version: saved.result.version,
    idempotency_key: 'deploy:launch-001'
  });
  assert.equal(retried.response.status, 200);
  assert.equal(retried.result.idempotent, true);

  const retryWithoutBilling = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', {
    base44: managerBase44,
    env: { CANVAS_DEPLOYMENT_SIGNING_SECRET: TEST_SIGNING_SECRET }
  });
  const committedRetry = await invoke(retryWithoutBilling, {
    session_id: saved.result.session_id,
    expected_version: saved.result.version,
    idempotency_key: 'deploy:launch-001'
  });
  assert.equal(committedRetry.response.status, 200);
  assert.equal(committedRetry.result.idempotent, true);

  const rep = { id: 'auth_rep_1', email: 'rep1@example.com', app_role: 'rep', team_manager_id: 'manager_1' };
  const repBase44 = makeBase44(rep, state);
  const getMine = loadHandler('base44/functions/canvasGetMyAssignments/entry.ts', { base44: repBase44 });
  const mine = await invoke(getMine, {});
  assert.equal(mine.response.status, 200);
  assert.equal(mine.result.team_member_id, 'tm_1');
  assert.equal(mine.result.assignments.length, 1);
  assert.equal(mine.result.assignments[0].zone.zone_id, plan.zones[0].zone_id);
  assert.deepEqual(
    mine.result.assignments[0].doors.map((door) => door.stable_door_id),
    plan.zones[0].stable_door_ids
  );
  assert.ok(plan.zones[1].stable_door_ids.every((doorId) => !JSON.stringify(mine.result).includes(doorId)));
  assert.doesNotMatch(JSON.stringify(mine.result), /entitlement_subscription_id|verified_team_member_ids|verified_team_member_bindings|superseded_session_ids/);

  state.sessions[0].doors[0].lat += 0.01;
  const tampered = await invoke(getMine, {});
  assert.equal(tampered.response.status, 409);
  assert.equal(tampered.result.error, 'deployment_signature_invalid');
});

test('manager can complete an active campaign with a signed, versioned, idempotent lifecycle transition', async () => {
  const state = makeState();
  const manager = managerUser();
  const base44 = makeBase44(manager, state);
  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44 });
  const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', {
    base44,
    stripeApi: liveCanvasStripe()
  });
  const saved = await invoke(save, validPlan());
  const deployed = await invoke(deploy, {
    session_id: saved.result.session_id,
    expected_version: saved.result.version,
    idempotency_key: 'deploy:lifecycle-complete'
  });
  assert.equal(deployed.response.status, 200);
  const activeSignature = state.sessions[0].deployment_signature;

  const close = loadHandler('base44/functions/canvasCloseCampaign/entry.ts', { base44 });
  const completed = await invoke(close, {
    session_id: saved.result.session_id,
    expected_version: deployed.result.version,
    idempotency_key: 'close:complete-001',
    action: 'complete'
  });
  assert.equal(completed.response.status, 200, JSON.stringify(completed.result));
  assert.equal(completed.result.idempotent, false);
  assert.equal(completed.result.status, 'completed');
  assert.equal(completed.result.lifecycle_state, 'completed');
  assert.equal(completed.result.version, deployed.result.version + 1);
  assert.equal(state.sessions[0].deployment_qa.lifecycle_state, 'completed');
  assert.equal(state.sessions[0].lifecycle_evidence.previous_signature, activeSignature);
  assert.equal(state.sessions[0].lifecycle_evidence.from_version, deployed.result.version);
  assert.equal(state.sessions[0].lifecycle_evidence.to_version, completed.result.version);
  assert.notEqual(state.sessions[0].deployment_signature, activeSignature);
  assert.equal(await verifyCanvasLifecycleSession(TEST_SIGNING_SECRET, state.sessions[0], 'completed'), true);

  const retried = await invoke(close, {
    session_id: saved.result.session_id,
    expected_version: deployed.result.version,
    idempotency_key: 'close:complete-001',
    action: 'complete'
  });
  assert.equal(retried.response.status, 200);
  assert.equal(retried.result.idempotent, true);
  assert.equal(retried.result.version, completed.result.version);

  const conflictingRetry = await invoke(close, {
    session_id: saved.result.session_id,
    expected_version: completed.result.version,
    idempotency_key: 'close:recall-conflict',
    action: 'recall'
  });
  assert.equal(conflictingRetry.response.status, 409);
  assert.equal(conflictingRetry.result.error, 'campaign_already_closed');

  const rep = { id: 'auth_rep_1', email: 'rep1@example.com', app_role: 'rep', team_manager_id: 'manager_1' };
  const getMine = loadHandler('base44/functions/canvasGetMyAssignments/entry.ts', { base44: makeBase44(rep, state) });
  const mine = await invoke(getMine, {});
  assert.equal(mine.response.status, 200);
  assert.deepEqual(mine.result.assignments, []);

  const resave = await invoke(save, {
    ...validPlan(),
    session_id: saved.result.session_id,
    expected_version: completed.result.version
  });
  assert.equal(resave.response.status, 409);
  assert.equal(resave.result.error, 'campaign_immutable');

  const redeploy = await invoke(deploy, {
    session_id: saved.result.session_id,
    expected_version: completed.result.version,
    idempotency_key: 'deploy:closed-reopen'
  });
  assert.equal(redeploy.response.status, 409);
  assert.equal(redeploy.result.error, 'campaign_closed');
});

test('close enforces manager ownership, action validation, active signature, and expected version', async () => {
  const draftState = makeState();
  const manager = managerUser();
  const managerBase44 = makeBase44(manager, draftState);
  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44: managerBase44 });
  const saved = await invoke(save, validPlan());
  const closeDraft = loadHandler('base44/functions/canvasCloseCampaign/entry.ts', { base44: managerBase44 });

  const invalidAction = await invoke(closeDraft, {
    session_id: saved.result.session_id,
    expected_version: saved.result.version,
    idempotency_key: 'close:invalid-action',
    action: 'pause'
  });
  assert.equal(invalidAction.response.status, 400);
  assert.equal(invalidAction.result.error, 'invalid_close_request');

  const draftClose = await invoke(closeDraft, {
    session_id: saved.result.session_id,
    expected_version: saved.result.version,
    idempotency_key: 'close:draft-not-active',
    action: 'recall'
  });
  assert.equal(draftClose.response.status, 409);
  assert.equal(draftClose.result.error, 'campaign_not_active');

  const repClose = loadHandler('base44/functions/canvasCloseCampaign/entry.ts', {
    base44: makeBase44({ id: 'auth_rep_1', email: 'rep1@example.com', app_role: 'rep' }, draftState)
  });
  const repRejected = await invoke(repClose, {
    session_id: saved.result.session_id,
    expected_version: saved.result.version,
    idempotency_key: 'close:rep-rejected',
    action: 'recall'
  });
  assert.equal(repRejected.response.status, 403);

  const otherManagerClose = loadHandler('base44/functions/canvasCloseCampaign/entry.ts', {
    base44: makeBase44(managerUser({ id: 'manager_other', email: 'other-manager@example.com' }), draftState)
  });
  const wrongOwner = await invoke(otherManagerClose, {
    session_id: saved.result.session_id,
    expected_version: saved.result.version,
    idempotency_key: 'close:wrong-owner',
    action: 'recall'
  });
  assert.equal(wrongOwner.response.status, 403);
  assert.equal(wrongOwner.result.error, 'forbidden');

  const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', {
    base44: managerBase44,
    stripeApi: liveCanvasStripe()
  });
  const deployed = await invoke(deploy, {
    session_id: saved.result.session_id,
    expected_version: saved.result.version,
    idempotency_key: 'deploy:close-security'
  });
  assert.equal(deployed.response.status, 200);

  const stale = await invoke(closeDraft, {
    session_id: saved.result.session_id,
    expected_version: deployed.result.version + 1,
    idempotency_key: 'close:stale-version',
    action: 'recall'
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.result.error, 'version_conflict');
  assert.equal(draftState.sessions[0].status, 'deployed');

  draftState.sessions[0].deployment_qa.lifecycle_state = 'recalled';
  const tampered = await invoke(closeDraft, {
    session_id: saved.result.session_id,
    expected_version: deployed.result.version,
    idempotency_key: 'close:tampered-active',
    action: 'recall'
  });
  assert.equal(tampered.response.status, 409);
  assert.equal(tampered.result.error, 'lifecycle_signature_invalid');
  assert.equal(draftState.sessions[0].status, 'deployed');
});

test('guarded close mutation permits only one competing lifecycle transition', async () => {
  const state = makeState();
  const manager = managerUser();
  const base44 = makeBase44(manager, state);
  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44 });
  const saved = await invoke(save, validPlan());
  const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', {
    base44,
    stripeApi: liveCanvasStripe()
  });
  const deployed = await invoke(deploy, {
    session_id: saved.result.session_id,
    expected_version: saved.result.version,
    idempotency_key: 'deploy:competing-close'
  });
  assert.equal(deployed.response.status, 200);
  const close = loadHandler('base44/functions/canvasCloseCampaign/entry.ts', { base44 });
  const [complete, recall] = await Promise.all([
    invoke(close, {
      session_id: saved.result.session_id,
      expected_version: deployed.result.version,
      idempotency_key: 'close:competing-complete',
      action: 'complete'
    }),
    invoke(close, {
      session_id: saved.result.session_id,
      expected_version: deployed.result.version,
      idempotency_key: 'close:competing-recall',
      action: 'recall'
    })
  ]);
  assert.deepEqual([complete.response.status, recall.response.status].sort(), [200, 409]);
  assert.equal(state.sessions[0].version, deployed.result.version + 1);
  assert.ok(['completed', 'recalled'].includes(state.sessions[0].status));
  assert.equal(
    await verifyCanvasLifecycleSession(TEST_SIGNING_SECRET, state.sessions[0], state.sessions[0].lifecycle_state),
    true
  );
});

test('manager deployment lock prevents two overlapping drafts from committing concurrently', async () => {
  const state = makeState();
  const manager = managerUser();
  const base44 = makeBase44(manager, state);
  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44 });
  const firstSaved = await invoke(save, { ...validPlan(), session_name: 'Concurrent area one' });
  const secondSaved = await invoke(save, { ...validPlan(), session_name: 'Concurrent area two' });
  const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', {
    base44,
    stripeApi: liveCanvasStripe()
  });
  const [first, second] = await Promise.all([
    invoke(deploy, {
      session_id: firstSaved.result.session_id,
      expected_version: firstSaved.result.version,
      idempotency_key: 'deploy:concurrent-first'
    }),
    invoke(deploy, {
      session_id: secondSaved.result.session_id,
      expected_version: secondSaved.result.version,
      idempotency_key: 'deploy:concurrent-second'
    })
  ]);
  assert.deepEqual([first.response.status, second.response.status].sort(), [200, 409]);
  const rejected = first.response.status === 409 ? first : second;
  assert.equal(rejected.result.error, 'canvas_deployment_in_progress');
  assert.equal(state.sessions.filter((session) => session.status === 'deployed').length, 1);
  assert.equal(state.sessions.filter((session) => session.status === 'draft').length, 1);

  const pending = state.sessions.find((session) => session.status === 'draft');
  const retry = await invoke(deploy, {
    session_id: pending.id,
    expected_version: pending.version,
    idempotency_key: 'deploy:concurrent-retry'
  });
  assert.equal(retry.response.status, 409);
  assert.equal(retry.result.error, 'canvas_deployment_overlap');
  assert.equal(state.sessions.filter((session) => session.status === 'deployed').length, 1);
});

test('recalling a replacement keeps its predecessor superseded and releases overlap for a new campaign', async () => {
  const state = makeState();
  const manager = managerUser();
  const base44 = makeBase44(manager, state);
  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44 });
  const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', {
    base44,
    stripeApi: liveCanvasStripe()
  });
  const close = loadHandler('base44/functions/canvasCloseCampaign/entry.ts', { base44 });

  const firstSaved = await invoke(save, validPlan());
  const firstDeployed = await invoke(deploy, {
    session_id: firstSaved.result.session_id,
    expected_version: firstSaved.result.version,
    idempotency_key: 'deploy:lifecycle-first'
  });
  assert.equal(firstDeployed.response.status, 200);

  const secondSaved = await invoke(save, { ...validPlan(), session_name: 'Replacement lifecycle campaign' });
  const secondDeployed = await invoke(deploy, {
    session_id: secondSaved.result.session_id,
    expected_version: secondSaved.result.version,
    idempotency_key: 'deploy:lifecycle-second',
    supersede_session_ids: [firstSaved.result.session_id]
  });
  assert.equal(secondDeployed.response.status, 200);

  const recalled = await invoke(close, {
    session_id: secondSaved.result.session_id,
    expected_version: secondDeployed.result.version,
    idempotency_key: 'close:recall-second',
    action: 'recall'
  });
  assert.equal(recalled.response.status, 200);
  assert.equal(recalled.result.status, 'recalled');
  assert.equal(await verifyCanvasLifecycleSession(TEST_SIGNING_SECRET, state.sessions[1], 'recalled'), true);

  const rep = { id: 'auth_rep_1', email: 'rep1@example.com', app_role: 'rep', team_manager_id: 'manager_1' };
  const getMine = loadHandler('base44/functions/canvasGetMyAssignments/entry.ts', { base44: makeBase44(rep, state) });
  const afterRecall = await invoke(getMine, {});
  assert.equal(afterRecall.response.status, 200);
  assert.deepEqual(afterRecall.result.assignments, []);
  assert.equal(afterRecall.result.superseded_deployments, 1);
  const predecessorById = await invoke(getMine, { session_id: firstSaved.result.session_id });
  assert.equal(predecessorById.response.status, 200);
  assert.deepEqual(predecessorById.result.assignments, []);

  const thirdSaved = await invoke(save, { ...validPlan(), session_name: 'Post-recall campaign' });
  const thirdDeployed = await invoke(deploy, {
    session_id: thirdSaved.result.session_id,
    expected_version: thirdSaved.result.version,
    idempotency_key: 'deploy:lifecycle-third'
  });
  assert.equal(thirdDeployed.response.status, 200, JSON.stringify(thirdDeployed.result));
  assert.deepEqual(thirdDeployed.result.superseded_session_ids, []);
});

test('an invalid successor fails rep and overlap authority closed instead of reviving its predecessor', async () => {
  const state = makeState();
  const manager = managerUser();
  const base44 = makeBase44(manager, state);
  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44 });
  const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', {
    base44,
    stripeApi: liveCanvasStripe()
  });
  const firstSaved = await invoke(save, validPlan());
  const firstDeployed = await invoke(deploy, {
    session_id: firstSaved.result.session_id,
    expected_version: firstSaved.result.version,
    idempotency_key: 'deploy:invalid-successor-first'
  });
  assert.equal(firstDeployed.response.status, 200);
  const secondSaved = await invoke(save, { ...validPlan(), session_name: 'Invalid successor' });
  const secondDeployed = await invoke(deploy, {
    session_id: secondSaved.result.session_id,
    expected_version: secondSaved.result.version,
    idempotency_key: 'deploy:invalid-successor-second',
    supersede_session_ids: [firstSaved.result.session_id]
  });
  assert.equal(secondDeployed.response.status, 200);
  const signature = state.sessions[1].deployment_signature;
  state.sessions[1].deployment_signature = `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`;

  const rep = { id: 'auth_rep_1', email: 'rep1@example.com', app_role: 'rep', team_manager_id: 'manager_1' };
  const getMine = loadHandler('base44/functions/canvasGetMyAssignments/entry.ts', { base44: makeBase44(rep, state) });
  const mine = await invoke(getMine, {});
  assert.equal(mine.response.status, 409);
  assert.equal(mine.result.error, 'deployment_signature_invalid');

  const thirdSaved = await invoke(save, { ...validPlan(), session_name: 'Blocked by invalid history' });
  const thirdDeploy = await invoke(deploy, {
    session_id: thirdSaved.result.session_id,
    expected_version: thirdSaved.result.version,
    idempotency_key: 'deploy:invalid-successor-third'
  });
  assert.equal(thirdDeploy.response.status, 409);
  assert.equal(thirdDeploy.result.error, 'canvas_lifecycle_integrity_failed');
  assert.equal(state.sessions[2].status, 'draft');
});

test('toggling a closed status cannot restore rep delivery or silently alter overlap authority', async () => {
  const state = makeState();
  const manager = managerUser();
  const base44 = makeBase44(manager, state);
  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44 });
  const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', {
    base44,
    stripeApi: liveCanvasStripe()
  });
  const saved = await invoke(save, validPlan());
  const deployed = await invoke(deploy, {
    session_id: saved.result.session_id,
    expected_version: saved.result.version,
    idempotency_key: 'deploy:toggle-test'
  });
  const close = loadHandler('base44/functions/canvasCloseCampaign/entry.ts', { base44 });
  const closed = await invoke(close, {
    session_id: saved.result.session_id,
    expected_version: deployed.result.version,
    idempotency_key: 'close:toggle-test',
    action: 'complete'
  });
  assert.equal(closed.response.status, 200);

  // Simulates a storage-layer status-only mutation. Normal manager entity RLS
  // no longer permits this write, and the lifecycle signature also rejects it.
  state.sessions[0].status = 'deployed';
  const rep = { id: 'auth_rep_1', email: 'rep1@example.com', app_role: 'rep', team_manager_id: 'manager_1' };
  const getMine = loadHandler('base44/functions/canvasGetMyAssignments/entry.ts', { base44: makeBase44(rep, state) });
  const mine = await invoke(getMine, {});
  assert.equal(mine.response.status, 409);
  assert.equal(mine.result.error, 'deployment_signature_invalid');

  const replacementSaved = await invoke(save, { ...validPlan(), session_name: 'Status-toggle replacement' });
  const replacementDeployed = await invoke(deploy, {
    session_id: replacementSaved.result.session_id,
    expected_version: replacementSaved.result.version,
    idempotency_key: 'deploy:toggle-replacement'
  });
  assert.equal(replacementDeployed.response.status, 409);
  assert.equal(replacementDeployed.result.error, 'canvas_lifecycle_integrity_failed');
  assert.equal(state.sessions[1].status, 'draft');
});

test('overlapping deployments require exact supersession confirmation and reps see only the signed replacement', async () => {
  const state = makeState();
  const manager = managerUser();
  const managerBase44 = makeBase44(manager, state);
  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44: managerBase44 });
  const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', {
    base44: managerBase44,
    stripeApi: liveCanvasStripe()
  });

  const firstSaved = await invoke(save, validPlan());
  const firstDeployed = await invoke(deploy, {
    session_id: firstSaved.result.session_id,
    expected_version: firstSaved.result.version,
    idempotency_key: 'deploy:overlap-first'
  });
  assert.equal(firstDeployed.response.status, 200);

  const replacementPlan = validPlan();
  replacementPlan.session_name = 'North Phoenix Replacement';
  const replacementSaved = await invoke(save, replacementPlan);
  const conflict = await invoke(deploy, {
    session_id: replacementSaved.result.session_id,
    expected_version: replacementSaved.result.version,
    idempotency_key: 'deploy:overlap-replacement'
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.result.error, 'canvas_deployment_overlap');
  assert.deepEqual(conflict.result.details.required_supersede_session_ids, [firstSaved.result.session_id]);
  assert.equal(conflict.result.details.conflicts[0].stable_door_id_count, 5);
  assert.equal(conflict.result.details.conflicts[0].work_unit_id_count, 3);

  const wrongConfirmation = await invoke(deploy, {
    session_id: replacementSaved.result.session_id,
    expected_version: replacementSaved.result.version,
    idempotency_key: 'deploy:overlap-replacement',
    supersede_session_ids: [firstSaved.result.session_id, 'session_not_conflicting']
  });
  assert.equal(wrongConfirmation.response.status, 409);
  assert.deepEqual(wrongConfirmation.result.details.unexpected_supersede_session_ids, ['session_not_conflicting']);

  const replacementDeployed = await invoke(deploy, {
    session_id: replacementSaved.result.session_id,
    expected_version: replacementSaved.result.version,
    idempotency_key: 'deploy:overlap-replacement',
    supersede_session_ids: [firstSaved.result.session_id]
  });
  assert.equal(replacementDeployed.response.status, 200);
  assert.deepEqual(replacementDeployed.result.superseded_session_ids, [firstSaved.result.session_id]);
  assert.deepEqual([...state.sessions[1].deployment_qa.superseded_session_ids], [firstSaved.result.session_id]);

  // Idempotency is keyed to the signed result; a retry need not re-submit the
  // overlap confirmation after the replacement has already committed.
  const retried = await invoke(deploy, {
    session_id: replacementSaved.result.session_id,
    expected_version: replacementSaved.result.version,
    idempotency_key: 'deploy:overlap-replacement'
  });
  assert.equal(retried.response.status, 200);
  assert.equal(retried.result.idempotent, true);
  assert.deepEqual(retried.result.superseded_session_ids, [firstSaved.result.session_id]);

  const rep = { id: 'auth_rep_1', email: 'rep1@example.com', app_role: 'rep', team_manager_id: 'manager_1' };
  const getMine = loadHandler('base44/functions/canvasGetMyAssignments/entry.ts', { base44: makeBase44(rep, state) });
  const mine = await invoke(getMine, {});
  assert.equal(mine.response.status, 200);
  assert.deepEqual(mine.result.assignments.map((assignment) => assignment.session_id), [replacementSaved.result.session_id]);
  assert.equal(mine.result.superseded_deployments, 1);
});

test('selected-reps deployment requires an explicit one-zone-per-selected-rep contract', async () => {
  const state = makeState();
  const manager = managerUser();
  const base44 = makeBase44(manager, state);
  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44 });

  const missingRosterPlan = validPlan();
  delete missingRosterPlan.selected_team_member_ids;
  const missingRoster = await invoke(save, missingRosterPlan);
  assert.equal(missingRoster.response.status, 400);
  assert.equal(missingRoster.result.error, 'selected_reps_required');

  const duplicateAssigneePlan = validPlan();
  duplicateAssigneePlan.zones[1].assigned_team_member_id = 'tm_1';
  const saved = await invoke(save, duplicateAssigneePlan);
  assert.equal(saved.response.status, 200);
  assert.equal(saved.result.qa.selected_reps_one_to_one, false);

  const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', {
    base44,
    stripeApi: liveCanvasStripe()
  });
  const rejected = await invoke(deploy, {
    session_id: saved.result.session_id,
    expected_version: saved.result.version,
    idempotency_key: 'deploy:selected-rep-contract'
  });
  assert.equal(rejected.response.status, 422);
  assert.equal(rejected.result.error, 'selected_rep_contract_failed');
});

test('street-aware drafts fail closed without a complete owned analysis door universe', async () => {
  const state = makeState();
  const base44 = makeBase44(managerUser(), state);
  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44 });

  const missingAnalysis = validPlan();
  delete missingAnalysis.analysis_id;
  const missing = await invoke(save, missingAnalysis);
  assert.equal(missing.response.status, 422);
  assert.equal(missing.result.error, 'analysis_required');

  const mismatchPlan = validPlan();
  mismatchPlan.doors[0].stable_door_id = 'fabricated_door';
  mismatchPlan.zones[0].stable_door_ids[0] = 'fabricated_door';
  const mismatch = await invoke(save, mismatchPlan);
  assert.equal(mismatch.response.status, 422);
  assert.equal(mismatch.result.error, 'analysis_door_mismatch');

  state.analysis.analysis.total_opportunities = 4;
  const truncated = await invoke(save, validPlan());
  assert.equal(truncated.response.status, 422);
  assert.equal(truncated.result.error, 'analysis_truncated');
});

test('deploy independently rejects a work unit split across rep zones', async () => {
  const state = makeState();
  const manager = managerUser();
  const base44 = makeBase44(manager, state);
  const plan = validPlan();
  const sourceZone = plan.zones.find((zone) => zone.stable_door_ids.length > 1 && zone.work_unit_ids.length === 1);
  const targetZone = plan.zones.find((zone) => zone.zone_id !== sourceZone.zone_id);
  const movedDoorId = sourceZone.stable_door_ids[0];
  plan.doors.find((door) => door.stable_door_id === movedDoorId).zone_id = targetZone.zone_id;
  sourceZone.stable_door_ids = sourceZone.stable_door_ids.filter((doorId) => doorId !== movedDoorId);
  targetZone.stable_door_ids = [...targetZone.stable_door_ids, movedDoorId];
  targetZone.work_unit_ids = [...targetZone.work_unit_ids, sourceZone.work_unit_ids[0]];

  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44 });
  const saved = await invoke(save, plan);
  assert.equal(saved.response.status, 200, JSON.stringify(saved.result));
  assert.equal(saved.result.qa.work_units_intact, false);

  const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', {
    base44,
    stripeApi: liveCanvasStripe()
  });
  const result = await invoke(deploy, {
    session_id: saved.result.session_id,
    expected_version: saved.result.version,
    idempotency_key: 'deploy:split-check'
  });
  assert.equal(result.response.status, 422);
  assert.equal(result.result.error, 'work_unit_integrity_failed');
  assert.equal(state.sessions[0].status, 'draft');
});

test('server topology recomputation rejects forged work-unit ownership despite passing client QA', async () => {
  const state = makeState();
  const base44 = makeBase44(managerUser(), state);
  const plan = validPlan();
  plan.zones.forEach((zone, index) => {
    const forgedUnitId = `forged-work-unit:${index + 1}`;
    zone.work_unit_ids = [forgedUnitId];
    const zoneDoorIds = new Set(zone.stable_door_ids);
    plan.doors.filter((door) => zoneDoorIds.has(door.stable_door_id))
      .forEach((door) => { door.work_unit_id = forgedUnitId; });
  });
  plan.qa.connected_zones = true;
  plan.qa.atomic_work_units = true;
  plan.qa.protected_units_intact = true;
  plan.qa.data_quality_status = 'verified';

  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44 });
  const saved = await invoke(save, plan);
  assert.equal(saved.response.status, 200, JSON.stringify(saved.result));
  assert.equal(saved.result.qa.deployable, true);

  const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', {
    base44,
    stripeApi: liveCanvasStripe()
  });
  const result = await invoke(deploy, {
    session_id: saved.result.session_id,
    expected_version: saved.result.version,
    idempotency_key: 'deploy:forged-work-units'
  });
  assert.equal(result.response.status, 422);
  assert.equal(result.result.error, 'server_work_unit_ownership_mismatch');
  assert.equal(state.sessions[0].status, 'draft');
  assert.equal(state.sessions[0].deployment_signature, null);
});

test('server topology recomputation rejects an internally consistent but nondeterministic zone partition', async () => {
  const state = makeState();
  const base44 = makeBase44(managerUser(), state);
  const plan = validPlan();
  const sourceZone = plan.zones.find((zone) => zone.work_unit_ids.length > 1);
  const destinationZone = plan.zones.find((zone) => zone.zone_id !== sourceZone.zone_id);
  const movedUnitId = sourceZone.work_unit_ids[0];
  const movedDoorIds = plan.doors
    .filter((door) => door.work_unit_id === movedUnitId)
    .map((door) => door.stable_door_id);
  sourceZone.work_unit_ids = sourceZone.work_unit_ids.filter((unitId) => unitId !== movedUnitId);
  sourceZone.stable_door_ids = sourceZone.stable_door_ids.filter((doorId) => !movedDoorIds.includes(doorId));
  destinationZone.work_unit_ids = [...destinationZone.work_unit_ids, movedUnitId];
  destinationZone.stable_door_ids = [...destinationZone.stable_door_ids, ...movedDoorIds];
  plan.doors.filter((door) => movedDoorIds.includes(door.stable_door_id))
    .forEach((door) => { door.zone_id = destinationZone.zone_id; });
  plan.qa.connected_zones = true;
  plan.qa.atomic_work_units = true;
  plan.qa.protected_units_intact = true;
  plan.qa.data_quality_status = 'verified';

  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44 });
  const saved = await invoke(save, plan);
  assert.equal(saved.response.status, 200, JSON.stringify(saved.result));
  assert.equal(saved.result.qa.deployable, true);

  const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', {
    base44,
    stripeApi: liveCanvasStripe()
  });
  const result = await invoke(deploy, {
    session_id: saved.result.session_id,
    expected_version: saved.result.version,
    idempotency_key: 'deploy:nondeterministic-partition'
  });
  assert.equal(result.response.status, 422);
  assert.equal(result.result.error, 'server_zone_topology_mismatch');
  assert.equal(state.sessions[0].status, 'draft');
});

test('server topology recomputation rejects altered zone geometry, parts, and drop points', async (t) => {
  const cases = [
    ['geometry', (plan) => { plan.zones[0].geometry[0].lat += 0.001; }],
    ['parts', (plan) => { plan.zones[0].parts[0][0].lng += 0.001; }],
    ['drop point', (plan) => { plan.zones[0].drop_point.lat += 0.001; }]
  ];
  for (const [label, mutate] of cases) {
    await t.test(label, async () => {
      const state = makeState();
      const base44 = makeBase44(managerUser(), state);
      const plan = validPlan();
      mutate(plan);
      const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44 });
      const saved = await invoke(save, plan);
      assert.equal(saved.response.status, 200, JSON.stringify(saved.result));
      assert.equal(saved.result.qa.deployable, true);

      const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', {
        base44,
        stripeApi: liveCanvasStripe()
      });
      const result = await invoke(deploy, {
        session_id: saved.result.session_id,
        expected_version: saved.result.version,
        idempotency_key: `deploy:tampered-${label.replace(' ', '-')}`
      });
      assert.equal(result.response.status, 422);
      assert.equal(result.result.error, 'server_zone_geometry_mismatch');
      assert.equal(state.sessions[0].status, 'draft');
      assert.equal(state.sessions[0].deployment_signature, null);
    });
  }
});

test('deploy fails closed without a server-owned OSM topology response', async () => {
  const state = makeState();
  const base44 = makeBase44(managerUser(), state);
  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44 });
  const saved = await invoke(save, validPlan());
  assert.equal(saved.response.status, 200);
  let topologyRequests = 0;
  const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', {
    base44,
    stripeApi: liveCanvasStripe(),
    fetchImpl: async () => {
      topologyRequests += 1;
      return new Response('overpass unavailable', { status: 503 });
    }
  });
  const result = await invoke(deploy, {
    session_id: saved.result.session_id,
    expected_version: saved.result.version,
    idempotency_key: 'deploy:no-server-osm'
  });
  assert.equal(topologyRequests, 2);
  assert.equal(result.response.status, 503);
  assert.equal(result.result.error, 'canvas_topology_source_unavailable');
  assert.equal(state.sessions[0].status, 'draft');
  assert.equal(state.sessions[0].deployment_signature, null);
});

test('save rejects duplicate stable doors and deploy fails closed when live billing is unavailable', async () => {
  const state = makeState();
  const manager = managerUser();
  const base44 = makeBase44(manager, state);
  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44 });
  const duplicatePlan = validPlan();
  duplicatePlan.doors[1].stable_door_id = duplicatePlan.doors[0].stable_door_id;
  const duplicate = await invoke(save, duplicatePlan);
  assert.equal(duplicate.response.status, 400);
  assert.equal(duplicate.result.error, 'duplicate_stable_door_id');

  const saved = await invoke(save, validPlan());
  assert.equal(saved.response.status, 200);
  const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', {
    base44,
    env: {}
  });
  const unavailable = await invoke(deploy, {
    session_id: saved.result.session_id,
    expected_version: saved.result.version,
    idempotency_key: 'deploy:no-billing'
  });
  assert.equal(unavailable.response.status, 503);
  assert.equal(unavailable.result.error, 'canvas_billing_unavailable');
  assert.equal(state.sessions[0].status, 'draft');
});

test('deploy rejects a roster row whose private auth user does not confirm the manager tenant', async () => {
  const state = makeState();
  const manager = managerUser();
  const base44 = makeBase44(manager, state);
  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44 });
  const saved = await invoke(save, validPlan());
  assert.equal(saved.response.status, 200);
  state.users.find((user) => user.id === 'auth_rep_2').team_manager_id = 'manager_other';

  const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', {
    base44,
    stripeApi: liveCanvasStripe()
  });
  const result = await invoke(deploy, {
    session_id: saved.result.session_id,
    expected_version: saved.result.version,
    idempotency_key: 'deploy:bad-team-link'
  });
  assert.equal(result.response.status, 422);
  assert.equal(result.result.error, 'unverified_team_link');
  assert.equal(state.sessions[0].status, 'draft');
});

test('signed rep bindings prevent a post-deploy TeamMember relink from transferring an assignment', async () => {
  const state = makeState();
  const manager = managerUser();
  const base44 = makeBase44(manager, state);
  const save = loadHandler('base44/functions/canvasSaveDraft/entry.ts', { base44 });
  const saved = await invoke(save, validPlan());
  const deploy = loadHandler('base44/functions/canvasDeployCampaign/entry.ts', {
    base44,
    stripeApi: liveCanvasStripe()
  });
  const deployed = await invoke(deploy, {
    session_id: saved.result.session_id,
    expected_version: saved.result.version,
    idempotency_key: 'deploy:signed-rep-binding'
  });
  assert.equal(deployed.response.status, 200);
  assert.deepEqual({ ...state.sessions[0].deployment_qa.verified_team_member_bindings[0] }, {
    team_member_id: 'tm_1',
    user_id: 'auth_rep_1',
    email: 'rep1@example.com'
  });

  const member = state.members.find((candidate) => candidate.id === 'tm_1');
  member.user_id = 'auth_rep_new';
  member.email = 'rep-new@example.com';
  state.users.push({ id: 'auth_rep_new', email: 'rep-new@example.com', team_manager_id: 'manager_1' });
  const newRep = { id: 'auth_rep_new', email: 'rep-new@example.com', app_role: 'rep', team_manager_id: 'manager_1' };
  const getNewRep = loadHandler('base44/functions/canvasGetMyAssignments/entry.ts', {
    base44: makeBase44(newRep, state)
  });
  const transferred = await invoke(getNewRep, {});
  assert.equal(transferred.response.status, 409);
  assert.equal(transferred.result.error, 'deployment_rep_binding_invalid');

  const oldRep = { id: 'auth_rep_1', email: 'rep1@example.com', app_role: 'rep', team_manager_id: 'manager_1' };
  const getOldRep = loadHandler('base44/functions/canvasGetMyAssignments/entry.ts', {
    base44: makeBase44(oldRep, state)
  });
  const stale = await invoke(getOldRep, {});
  assert.equal(stale.response.status, 403);
  assert.equal(stale.result.error, 'team_membership_required');
});

test('Canvas functions use service-role mutation only after caller-scoped ownership checks', () => {
  const save = readSource('base44/functions/canvasSaveDraft/entry.ts');
  assert.match(save, /asServiceRole\.entities\.CanvasSession\.updateMany/);
  assert.ok(save.indexOf('existing.manager_id !== user.id') < save.indexOf('asServiceRole.entities.CanvasSession.updateMany'));
  const assignments = readSource('base44/functions/canvasGetMyAssignments/entry.ts');
  assert.match(assignments, /resolveAuthenticatedTeamMember\(base44, user\)/);
  assert.match(assignments, /asServiceRole\.entities\.CanvasSession\.filter/);
  assert.ok(assignments.indexOf('resolveAuthenticatedTeamMember(base44, user)') < assignments.indexOf('asServiceRole.entities.CanvasSession.filter'));
  const deploy = readSource('base44/functions/canvasDeployCampaign/entry.ts');
  assert.match(deploy, /resolveCanvasEntitlement/);
  assert.match(deploy, /work_unit_integrity_failed/);
  assert.match(deploy, /plan_hash_mismatch/);
  assert.match(deploy, /asServiceRole\.entities\.User\.get/);
  assert.ok(deploy.lastIndexOf('session.manager_id !== user.id') < deploy.lastIndexOf('validateTeamMembers(base44'));
  assert.ok(deploy.lastIndexOf('session.manager_id !== user.id') < deploy.lastIndexOf('asServiceRole.entities.CanvasSession.updateMany'));
  const close = readSource('base44/functions/canvasCloseCampaign/entry.ts');
  assert.match(close, /asServiceRole\.entities\.CanvasSession\.updateMany/);
  assert.ok(close.indexOf("session.manager_id || '') !== String(user.id") < close.indexOf('asServiceRole.entities.CanvasSession.updateMany'));
  assert.doesNotMatch(deploy, /function isPrivileged[\s\S]{0,200}is_owner/);
  assert.doesNotMatch(save, /function hasDraftCanvasEntitlement[\s\S]{0,300}is_owner/);
});
