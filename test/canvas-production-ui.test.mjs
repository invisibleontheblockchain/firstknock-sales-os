import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  assignCanvasZonesRoundRobin,
  attachStableDoorsToCanvasZones,
  buildCanvasDraftPayload,
  formatCanvasOverlapConfirmation,
  getCanvasSplitTarget,
  getCanvasTeamMemberEligibility,
  getCanvasGenerationBlockers,
  getCanvasPlannerFailureMessage,
  isCanvasPlanDeployable,
  isVerifiedCanvasPlannerResult,
  normalizeCanvasPlannerResult,
  reconcileCanvasPlanWithEligibleTeam,
  validateCanvasBoundary,
} from '../src/components/canvas/canvasPlannerUtils.js';
import { planCanvasTerritories } from '../src/components/logic/canvasStreetTerritoryPlanner.js';

test('Canvas client preserves rejected deployment conflict details for explicit supersession', async () => {
  const source = readFileSync(new URL('../src/components/canvas/canvasProductionClient.js', import.meta.url), 'utf8')
    .replace(/^import \{ base44 \} from ['"]@\/api\/base44Client['"];?$/m, 'const base44 = globalThis.__canvasBase44Test;');
  globalThis.__canvasBase44Test = {
    functions: {
      invoke: async () => {
        const error = new Error('Request failed with status code 409');
        error.response = {
          status: 409,
          data: {
            error: 'canvas_deployment_overlap',
            message: 'This area overlaps an active Canvas campaign.',
            details: { required_supersede_session_ids: ['session_existing'] },
          },
        };
        throw error;
      },
    },
  };

  try {
    const encoded = Buffer.from(source).toString('base64');
    const client = await import(`data:text/javascript;base64,${encoded}`);
    await assert.rejects(client.deployCanvasCampaign({
      sessionId: 'session_replacement',
      expectedVersion: 1,
      idempotencyKey: 'deploy:replacement',
    }), (error) => {
      assert.equal(error.code, 'canvas_deployment_overlap');
      assert.equal(error.status, 409);
      assert.equal(error.message, 'This area overlaps an active Canvas campaign.');
      assert.deepEqual(error.details.details.required_supersede_session_ids, ['session_existing']);
      return true;
    });
  } finally {
    delete globalThis.__canvasBase44Test;
  }
});

test('Canvas road cache is time-bounded and can be force-refreshed after server topology drift', async () => {
  const source = readFileSync(new URL('../src/components/logic/overpassRoadNetwork.jsx', import.meta.url), 'utf8');
  const originalSessionStorage = globalThis.sessionStorage;
  const originalFetch = globalThis.fetch;
  const stored = new Map();
  let fetchCount = 0;
  globalThis.sessionStorage = {
    getItem: (key) => stored.get(key) || null,
    setItem: (key, value) => stored.set(key, value),
    removeItem: (key) => stored.delete(key),
  };
  globalThis.fetch = async () => {
    fetchCount += 1;
    return { ok: true, json: async () => ({ elements: [{ type: 'node', id: fetchCount, lat: 33, lon: -112 }] }) };
  };

  try {
    const encoded = Buffer.from(source).toString('base64');
    const roads = await import(`data:text/javascript;base64,${encoded}`);
    const polygon = [{ lat: 33, lng: -112 }, { lat: 33.01, lng: -112 }, { lat: 33, lng: -111.99 }];
    const key = roads.getRoadNetworkCacheKey(polygon);
    stored.set(key, JSON.stringify({ elements: [{ type: 'node', id: 'legacy' }] }));

    const first = await roads.fetchOverpassRoadNetwork(polygon);
    assert.equal(fetchCount, 1);
    assert.equal(first.elements[0].id, 1);
    const second = await roads.fetchOverpassRoadNetwork(polygon);
    assert.equal(fetchCount, 1);
    assert.equal(second.elements[0].id, 1);
    await roads.fetchOverpassRoadNetwork(polygon, { bypassCache: true });
    assert.equal(fetchCount, 2);
    roads.clearOverpassRoadNetworkCache(polygon);
    assert.equal(stored.has(key), false);
  } finally {
    globalThis.sessionStorage = originalSessionStorage;
    globalThis.fetch = originalFetch;
  }
});

const linkedRep = (id, overrides = {}) => ({
  id,
  name: `Rep ${id}`,
  role: 'rep',
  status: 'active',
  user_id: `user_${id}`,
  ...overrides,
});

test('Canvas roster eligibility only permits active linked reps', () => {
  const result = getCanvasTeamMemberEligibility([
    linkedRep('eligible'),
    linkedRep('unlinked', { user_id: null }),
    linkedRep('manager', { role: 'manager' }),
    linkedRep('inactive', { status: 'inactive' }),
  ]);

  assert.deepEqual(result.eligible.map((member) => member.id), ['eligible']);
  assert.equal(result.excluded.unlinked, 1);
  assert.equal(result.excluded.non_rep, 1);
  assert.equal(result.excluded.inactive, 1);
});

test('Canvas split target supports selected reps and homes per area', () => {
  assert.deepEqual(getCanvasSplitTarget({
    splitBasis: 'selected_reps',
    selectedTeamMemberIds: ['rep_1', 'rep_2'],
    totalHomes: 181,
  }), {
    requestedZoneCount: 2,
    targetHomesPerArea: 91,
    basisLabel: '2 selected reps',
  });
  assert.equal(getCanvasSplitTarget({ splitBasis: 'homes_per_area', homesPerArea: 75, totalHomes: 181 }).requestedZoneCount, 3);
});

test('Canvas preserves actionable structured planner failures', () => {
  assert.equal(getCanvasPlannerFailureMessage({
    ok: false,
    code: 'ZONE_COUNT_EXCEEDS_WORK_UNITS',
    message: 'Choose no more than 3 reps for the 3 indivisible street units in this area.',
  }), 'Choose no more than 3 reps for the 3 indivisible street units in this area.');
  assert.equal(getCanvasPlannerFailureMessage({ ok: true, message: 'unused' }), '');
});

test('Canvas overlap confirmation names every destructive campaign replacement', () => {
  const message = formatCanvasOverlapConfirmation({
    required_supersede_session_ids: ['session_1', 'session_2'],
    conflicts: [
      { session_name: 'Friday North Team', stable_door_id_count: 34, work_unit_id_count: 5 },
      { session_name: 'Saturday South Team', stable_door_id_count: 12, work_unit_id_count: 2 },
    ],
  });
  assert.match(message, /Friday North Team: 34 overlapping homes, 5 street units/);
  assert.match(message, /Saturday South Team: 12 overlapping homes, 2 street units/);
  assert.match(message, /removes each entire conflicting campaign from every rep/);
});

test('Canvas rejects a self-crossing freehand boundary before analysis', () => {
  const result = validateCanvasBoundary([
    { lat: 33, lng: -112 },
    { lat: 33.01, lng: -111.99 },
    { lat: 33.01, lng: -112 },
    { lat: 33, lng: -111.99 },
  ]);
  assert.equal(result.valid, false);
  assert.equal(result.code, 'SELF_INTERSECTING_POLYGON');
  assert.match(result.message, /crosses or touches itself/);
});

test('Canvas blocks a homes-per-area request above the server campaign limit', () => {
  const blockers = getCanvasGenerationBlockers({
    polygon: [{ lat: 1, lng: 1 }, { lat: 1, lng: 2 }, { lat: 2, lng: 1 }],
    splitBasis: 'homes_per_area',
    homesPerArea: 1,
    analysis: {
      analysisId: 'analysis_1',
      totalOpportunities: 251,
      opportunities: Array.from({ length: 251 }, (_, index) => ({ id: `door_${index}`, lat: 1.1, lng: 1.1 })),
    },
    roadFetchStatus: 'ready',
  });

  assert.ok(blockers.some((message) => message.includes('at most 250 areas')));
});

test('Canvas assignment stores TeamMember IDs and display names separately', () => {
  const zones = assignCanvasZonesRoundRobin(
    [{ zone_id: 'zone_1' }, { zone_id: 'zone_2' }, { zone_id: 'zone_3' }],
    ['rep_1', 'rep_2'],
    [linkedRep('rep_1'), linkedRep('rep_2')]
  );

  assert.deepEqual(zones.map((zone) => zone.assigned_team_member_id), ['rep_1', 'rep_2', 'rep_1']);
  assert.deepEqual(zones[0].assignments, ['rep_1']);
  assert.equal(zones[0].assigned_to_name, 'Rep rep_1');
});

test('Canvas roster churn clears ineligible assignments and invalidates selected-rep plans', () => {
  const result = reconcileCanvasPlanWithEligibleTeam({
    workload_basis: 'selected_reps',
    selected_team_member_ids: ['rep_1', 'rep_2'],
    zones: [
      { zone_id: 'zone_1', assigned_team_member_id: 'rep_1' },
      { zone_id: 'zone_2', assigned_team_member_id: 'rep_2', assignments: ['rep_2'] },
    ],
    qa: { deployable: true, warnings: [] },
  }, [linkedRep('rep_1'), linkedRep('rep_2', { status: 'inactive' })]);

  assert.equal(result.changed, true);
  assert.equal(result.requiresRegeneration, true);
  assert.deepEqual(result.removedSelectedIds, ['rep_2']);
  assert.deepEqual(result.clearedZoneIds, ['zone_2']);
  assert.deepEqual(result.plan.selected_team_member_ids, ['rep_1']);
  assert.equal(result.plan.zones[1].assigned_team_member_id, null);
  assert.equal(result.plan.qa.deployable, false);
});

test('renaming a Canvas draft clears a pending deployment retry before it can reuse the saved revision', () => {
  const source = readFileSync(new URL('../src/components/map/CanvasBuilderSettings.jsx', import.meta.url), 'utf8');
  assert.match(source, /const changeSessionName = \(value\) => \{[\s\S]*?setSessionName\(value\);[\s\S]*?deploymentAttemptRef\.current = null;/);
  assert.match(source, /onChange=\{\(event\) => changeSessionName\(event\.target\.value\)\}/);
});

test('mobile Canvas can collapse so the manager can inspect the generated map', () => {
  const source = readFileSync(new URL('../src/components/map/CanvasBuilderSettings.jsx', import.meta.url), 'utf8');
  assert.match(source, /mobileCollapsed \? 'h-16' : 'h-\[82dvh\]/);
  assert.match(source, /Collapse to inspect map/);
  assert.match(source, /aria-expanded=\{!mobileCollapsed\}/);
});

test('manager can complete or recall a deployed Canvas campaign with an idempotent close request', () => {
  const client = readFileSync(new URL('../src/components/canvas/canvasProductionClient.js', import.meta.url), 'utf8');
  const builder = readFileSync(new URL('../src/components/map/CanvasBuilderSettings.jsx', import.meta.url), 'utf8');
  assert.match(client, /invokeProductionFunction\('canvasCloseCampaign'/);
  assert.match(client, /invokeProductionFunction\('canvasListCampaigns'/);
  assert.match(client, /expected_version: expectedVersion/);
  assert.match(builder, /closeCampaign\('complete'\)/);
  assert.match(builder, /closeCampaign\('recall'\)/);
  assert.match(builder, /closeAttemptRef\.current = attempt/);
  assert.match(builder, /Other active Canvas campaigns/);
});

test('stable homes are attached exactly once across multipart areas', () => {
  const result = attachStableDoorsToCanvasZones([
    {
      zone_id: 'zone_1',
      parts: [[
        { lat: 1, lng: 1 }, { lat: 1, lng: 2 }, { lat: 0, lng: 2 }, { lat: 0, lng: 1 },
      ]],
    },
    {
      zone_id: 'zone_2',
      geometry: [
        { lat: 1, lng: 2 }, { lat: 1, lng: 3 }, { lat: 0, lng: 3 }, { lat: 0, lng: 2 },
      ],
    },
  ], [
    { id: 'door_1', lat: 0.5, lng: 1.5 },
    { id: 'door_2', lat: 0.5, lng: 2.5 },
  ]);

  assert.deepEqual(result.zones.map((zone) => zone.stable_door_ids), [['door_1'], ['door_2']]);
  assert.deepEqual(result.doors.map((door) => door.zone_id), ['zone_1', 'zone_2']);
  assert.deepEqual(result.missingDoorIds, []);
});

const deployablePlan = {
  planning_method: 'street_work_units',
  assignment_basis: 'stable_door_ids',
  workload_basis: 'selected_reps',
  selected_team_member_ids: ['rep_1'],
  algorithm_version: 'street_topology_v1',
  data_version: 'osm:2026-07-17T00:00:00Z',
  doors: [
    { stable_door_id: 'door_1', lat: 33, lng: -112, work_unit_id: 'unit_1', zone_id: 'zone_1' },
  ],
  zones: [
    {
      zone_id: 'zone_1',
      zone_number: 1,
      geometry: [{ lat: 33, lng: -112 }, { lat: 33.1, lng: -112 }, { lat: 33, lng: -111.9 }],
      stable_door_ids: ['door_1'],
      work_unit_ids: ['unit_1'],
      assigned_team_member_id: 'rep_1',
    },
  ],
  qa: {
    deployable: true,
    coverage_complete: true,
    no_duplicate_doors: true,
    no_missing_doors: true,
    connected_zones: true,
    atomic_work_units: true,
    cul_de_sac_splits: 0,
    protected_units_intact: true,
    data_quality_status: 'verified',
  },
};

test('deployability requires strict QA, assignments, and versioned planner data', () => {
  assert.equal(isCanvasPlanDeployable(deployablePlan), true);
  assert.equal(isCanvasPlanDeployable({ ...deployablePlan, data_version: null }), false);
  assert.equal(isCanvasPlanDeployable({ ...deployablePlan, zones: [{ ...deployablePlan.zones[0], assigned_team_member_id: null }] }), false);
  assert.equal(isCanvasPlanDeployable({ ...deployablePlan, qa: { ...deployablePlan.qa, protected_units_intact: false } }), false);
  assert.equal(isCanvasPlanDeployable({ ...deployablePlan, zones: [{ ...deployablePlan.zones[0], assigned_team_member_id: 'rep_2' }] }), false);
  assert.equal(isCanvasPlanDeployable({
    ...deployablePlan,
    selected_team_member_ids: ['rep_1', 'rep_2'],
    zones: [deployablePlan.zones[0], { ...deployablePlan.zones[0], zone_id: 'zone_2', assigned_team_member_id: 'rep_1' }],
  }), false);
});

test('draft payload uses canonical production contract and preserves multipart geometry', () => {
  const payload = buildCanvasDraftPayload({
    sessionId: 'session_1',
    expectedVersion: 2,
    sessionName: 'North Team',
    polygon: deployablePlan.zones[0].geometry,
    analysisId: 'analysis_1',
    plan: { ...deployablePlan, zones: [{ ...deployablePlan.zones[0], parts: [deployablePlan.zones[0].geometry] }] },
  });

  assert.equal(payload.session_id, 'session_1');
  assert.equal(payload.expected_version, 2);
  assert.equal(payload.planning_method, 'street_work_units');
  assert.equal(payload.assignment_basis, 'stable_door_ids');
  assert.equal(payload.workload_basis, 'selected_reps');
  assert.deepEqual(payload.selected_team_member_ids, ['rep_1']);
  assert.equal(payload.analysis_id, 'analysis_1');
  assert.equal(payload.qa.deployable, true);
  assert.deepEqual(payload.zones[0].parts, [deployablePlan.zones[0].geometry]);
  assert.equal('split_basis' in payload, false);
});

test('planner imbalance uses stable door counts when estimates are absent', () => {
  const normalized = normalizeCanvasPlannerResult({
    planning_method: 'street_work_units',
    road_aligned: true,
    culdesac_integrity: true,
    algorithm_version: 'street_topology_v1',
    data_version: 'osm:v1',
    zones: [
      { geometry: deployablePlan.zones[0].geometry, stable_door_ids: ['a', 'b', 'c'] },
      { geometry: deployablePlan.zones[0].geometry, stable_door_ids: ['d'] },
    ],
  }, { requestedZoneCount: 2, roadFetchStatus: 'ready' });

  assert.equal(normalized.maxImbalancePercent, 50);
});

test('the real street planner satisfies the manager verification contract', () => {
  const polygon = [
    { lat: 35.999, lng: -80.011 },
    { lat: 35.999, lng: -79.989 },
    { lat: 36.011, lng: -79.989 },
    { lat: 36.011, lng: -80.011 },
  ];
  const result = planCanvasTerritories({
    polygon,
    roadNetwork: {
      elements: [
        { type: 'node', id: 1, lat: 36, lon: -80.01 },
        { type: 'node', id: 2, lat: 36, lon: -80 },
        { type: 'node', id: 3, lat: 36, lon: -79.99 },
        { type: 'way', id: 10, nodes: [1, 2, 3], tags: { highway: 'residential', name: 'Main Street' } },
      ],
    },
    opportunities: [
      { id: 'door_1', lat: 36.00005, lng: -80.005 },
      { id: 'door_2', lat: 36.00005, lng: -79.995 },
    ],
    workload_basis: 'selected_reps',
    selected_team_member_ids: ['rep_1'],
    requested_zone_count: 1,
    analysis_id: 'analysis_1',
    max_snap_distance_meters: 100,
  });

  assert.equal(result.planning_method, 'street_work_units');
  assert.equal(isVerifiedCanvasPlannerResult(result), true);
});
