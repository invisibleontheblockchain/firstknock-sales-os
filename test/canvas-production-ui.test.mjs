import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  assignCanvasZonesRoundRobin,
  buildCanvasDraftPayload,
  formatCanvasOverlapConfirmation,
  getCanvasPlannerFailureMessage,
  getCanvasTeamMemberEligibility,
  isCanvasPlanDeployable,
  isVerifiedCanvasPlannerResult,
  reconcileCanvasPlanWithEligibleTeam,
  restoreCanvasDraftPlan,
  validateCanvasBoundary,
} from '../src/components/canvas/canvasPlannerUtils.js';
import { canvasZoneLoggedCount } from '../src/components/canvas/canvasOutcomeUtils.js';
import { planCanvasTerritories } from '../src/components/logic/canvasStreetTerritoryPlanner.js';

const linkedRep = (id, overrides = {}) => ({
  id,
  name: `Rep ${id}`,
  role: 'rep',
  status: 'active',
  user_id: `user_${id}`,
  ...overrides,
});

const polygon = [
  { lat: 35.999, lng: -80.011 },
  { lat: 35.999, lng: -79.989 },
  { lat: 36.011, lng: -79.989 },
  { lat: 36.011, lng: -80.011 },
];

const roadNetwork = {
  elements: [
    { type: 'node', id: 1, lat: 36, lon: -80.01 },
    { type: 'node', id: 2, lat: 36, lon: -80 },
    { type: 'node', id: 3, lat: 36, lon: -79.99 },
    { type: 'way', id: 10, nodes: [1, 2, 3], tags: { highway: 'residential', name: 'Main Street' } },
  ],
};

function assignedPlan({ divisionMode = 'selected_reps' } = {}) {
  const result = planCanvasTerritories({
    polygon,
    roadNetwork,
    ...(divisionMode === 'selected_reps'
      ? { selected_team_member_ids: ['rep_1'] }
      : { requested_zone_count: 1 }),
  });
  return {
    ...result,
    zones: assignCanvasZonesRoundRobin(result.zones, ['rep_1'], [linkedRep('rep_1')]),
  };
}

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
    const client = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    await assert.rejects(client.deployCanvasCampaign({
      sessionId: 'session_replacement',
      expectedVersion: 1,
      idempotencyKey: 'deploy:replacement',
    }), (error) => {
      assert.equal(error.code, 'canvas_deployment_overlap');
      assert.equal(error.status, 409);
      assert.deepEqual(error.details.details.required_supersede_session_ids, ['session_existing']);
      return true;
    });
  } finally {
    delete globalThis.__canvasBase44Test;
  }
});

test('Canvas client sends the territory pin and shared campaign map contracts', async () => {
  const calls = [];
  const source = readFileSync(new URL('../src/components/canvas/canvasProductionClient.js', import.meta.url), 'utf8')
    .replace(/^import \{ base44 \} from ['"]@\/api\/base44Client['"];?$/m, 'const base44 = globalThis.__canvasBase44Test;');
  globalThis.__canvasBase44Test = {
    functions: {
      invoke: async (name, payload) => {
        calls.push({ name, payload });
        return { data: { success: true, campaign: { campaign_id: 'campaign_1' }, pins: [], pin: { pin_id: 'pin_1' }, event: {} } };
      },
    },
  };

  try {
    const client = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#contracts`);
    await client.getCanvasCampaignMap({ campaignId: 'campaign_1', includeEvents: true });
    await client.logCanvasHouseDecision({
      campaignId: 'campaign_1',
      zoneId: 'zone_1',
      idempotencyKey: 'decision_1',
      point: { lat: 36, lng: -80 },
      outcome: 'appointment',
      note: 'Call tomorrow',
      unitLabel: '4B',
    });

    assert.deepEqual(calls[0], {
      name: 'canvasGetCampaignMap',
      payload: { campaign_id: 'campaign_1', include_events: true },
    });
    assert.equal(calls[1].name, 'canvasLogHouseDecision');
    assert.equal(calls[1].payload.campaign_id, 'campaign_1');
    assert.equal(calls[1].payload.zone_id, 'zone_1');
    assert.equal(calls[1].payload.outcome, 'appointment');
    assert.equal(calls[1].payload.note, 'Call tomorrow');
    assert.equal(calls[1].payload.unit_label, '4B');
  } finally {
    delete globalThis.__canvasBase44Test;
  }
});

test('Canvas road cache is time-bounded, refreshable, and uses current Overpass fallbacks', async () => {
  const source = readFileSync(new URL('../src/components/logic/overpassRoadNetwork.jsx', import.meta.url), 'utf8');
  assert.match(source, /overpass\.private\.coffee/);
  assert.doesNotMatch(source, /overpass\.kumi\.systems/);
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
    const roads = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    const boundary = [{ lat: 33, lng: -112 }, { lat: 33.01, lng: -112 }, { lat: 33, lng: -111.99 }];
    await roads.fetchOverpassRoadNetwork(boundary);
    await roads.fetchOverpassRoadNetwork(boundary);
    assert.equal(fetchCount, 1);
    await roads.fetchOverpassRoadNetwork(boundary, { bypassCache: true });
    assert.equal(fetchCount, 2);
  } finally {
    globalThis.sessionStorage = originalSessionStorage;
    globalThis.fetch = originalFetch;
  }
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

test('Canvas preserves actionable structured planner failures', () => {
  assert.equal(getCanvasPlannerFailureMessage({
    ok: false,
    code: 'TOO_MANY_ZONES_FOR_WORK_UNITS',
    message: 'Choose no more than 3 territories for these indivisible street units.',
  }), 'Choose no more than 3 territories for these indivisible street units.');
});

test('Canvas overlap confirmation is territory-first and names destructive replacements', () => {
  const message = formatCanvasOverlapConfirmation({
    required_supersede_session_ids: ['session_1'],
    conflicts: [{ session_name: 'Friday North Team', work_unit_id_count: 5, zone_count: 2 }],
  });
  assert.match(message, /Friday North Team: 5 overlapping street units across 2 territories/);
  assert.match(message, /removes each entire conflicting campaign from every rep/);
  assert.doesNotMatch(message, /homes/);
});

test('Canvas rejects a self-crossing freehand boundary before street loading', () => {
  const result = validateCanvasBoundary([
    { lat: 33, lng: -112 },
    { lat: 33.01, lng: -111.99 },
    { lat: 33.01, lng: -112 },
    { lat: 33, lng: -111.99 },
  ]);
  assert.equal(result.valid, false);
  assert.equal(result.code, 'SELF_INTERSECTING_POLYGON');
});

test('Canvas rejects more than 800 freehand points before topology work', () => {
  const detailedBoundary = Array.from({ length: 801 }, (_, index) => {
    const angle = index / 801 * Math.PI * 2;
    return { lat: 33 + Math.sin(angle) * 0.01, lng: -112 + Math.cos(angle) * 0.01 };
  });
  const result = validateCanvasBoundary(detailedBoundary);
  assert.equal(result.valid, false);
  assert.equal(result.code, 'POLYGON_POINT_LIMIT_EXCEEDED');
  assert.match(result.message, /up to 800 points/);
});

test('Canvas rejects areas over 300 square miles before loading streets', () => {
  const result = validateCanvasBoundary([
    { lat: 33, lng: -112 },
    { lat: 33, lng: -111.6 },
    { lat: 33.4, lng: -111.6 },
    { lat: 33.4, lng: -112 },
  ]);
  assert.equal(result.valid, false);
  assert.equal(result.code, 'CANVAS_AREA_TOO_LARGE');
  assert.ok(result.areaSqMiles > 300);
  assert.match(result.message, /300 sq mi or less before loading streets/);
});

test('Canvas assignment stores TeamMember IDs and display labels separately', () => {
  const zones = assignCanvasZonesRoundRobin(
    [{ zone_id: 'zone_1' }, { zone_id: 'zone_2' }, { zone_id: 'zone_3' }],
    ['rep_1', 'rep_2'],
    [linkedRep('rep_1'), linkedRep('rep_2')]
  );
  assert.deepEqual(zones.map((zone) => zone.assigned_team_member_id), ['rep_1', 'rep_2', 'rep_1']);
  assert.equal(zones[0].assigned_to_name, 'Rep rep_1');
});

test('Canvas roster churn clears invalid assignments and regenerates only selected-rep splits', () => {
  const result = reconcileCanvasPlanWithEligibleTeam({
    division_mode: 'selected_reps',
    selected_team_member_ids: ['rep_1', 'rep_2'],
    zones: [
      { zone_id: 'zone_1', assigned_team_member_id: 'rep_1' },
      { zone_id: 'zone_2', assigned_team_member_id: 'rep_2' },
    ],
    qa: { deployable: true, warnings: [] },
  }, [linkedRep('rep_1'), linkedRep('rep_2', { status: 'inactive' })]);
  assert.equal(result.changed, true);
  assert.equal(result.requiresRegeneration, true);
  assert.deepEqual(result.removedSelectedIds, ['rep_2']);
  assert.equal(result.plan.zones[1].assigned_team_member_id, null);
});

test('manager zone progress reads total_pins and never returns NaN', () => {
  assert.equal(canvasZoneLoggedCount({ total_pins: 7, outcomes: { sale: 2, no_answer: 5 } }), 7);
  assert.equal(canvasZoneLoggedCount({ outcomes: { sale: 2, no_answer: 3 } }), 5);
  assert.equal(canvasZoneLoggedCount({ total_pins: 'not-a-number', outcomes: {} }), 0);
  assert.equal(canvasZoneLoggedCount(undefined), 0);
});

test('saved Canvas drafts restore exact planning and assignment identity', () => {
  const restored = restoreCanvasDraftPlan({
    campaign_id: 'draft_1',
    stored_status: 'draft',
    territory_model: 'street_territory_v1',
    planning_method: 'street_workload',
    assignment_basis: 'street_work_unit_ids',
    workload_basis: 'street_length',
    division_mode: 'selected_reps',
    selected_team_member_ids: ['rep_1'],
    algorithm_version: 'canvas-street-territory-v3',
    data_version: 'canvas-territory:abc',
    zones: [{ zone_id: 'zone_1', zone_number: 1, assigned_team_member_id: 'rep_1', work_unit_ids: ['unit_1'] }],
    work_units: [{ id: 'unit_1', segments: [] }],
    qa: {
      deployable: true,
      street_coverage_complete: true,
      no_duplicate_work_units: true,
      no_missing_work_units: true,
      connected_zones: true,
      atomic_work_units: true,
      protected_units_intact: true,
      cul_de_sac_splits: 0,
      data_quality_status: 'verified',
      warnings: [],
    },
  }, [linkedRep('rep_1')]);
  assert.equal(restored.division_mode, 'selected_reps');
  assert.deepEqual(restored.selected_team_member_ids, ['rep_1']);
  assert.equal(restored.zones[0].assigned_team_member_id, 'rep_1');
  assert.equal(restored.zones[0].assigned_to_name, 'Rep rep_1');
  assert.equal(restored.algorithm_version, 'canvas-street-territory-v3');
  assert.equal(restored.data_version, 'canvas-territory:abc');
  assert.equal(isCanvasPlanDeployable(restored), true);
});

test('territory planner requires streets but no preloaded house inventory', () => {
  const result = planCanvasTerritories({ polygon, roadNetwork, selected_team_member_ids: ['rep_1'] });
  assert.equal(result.ok, true);
  assert.equal(result.planning_method, 'street_workload');
  assert.equal(result.assignment_basis, 'street_work_unit_ids');
  assert.equal(result.division_mode, 'selected_reps');
  assert.equal(result.zones.length, 1);
  assert.deepEqual(result.doors, []);
  assert.deepEqual(result.door_candidates, []);
  assert.equal(result.zones[0].estimated_doors, null);
  assert.ok(result.zones[0].street_length_meters > 0);
  assert.equal(isVerifiedCanvasPlannerResult(result), true);
});

test('fixed territory count remains an honest area-count choice balanced by street workload', () => {
  const result = planCanvasTerritories({ polygon, roadNetwork, requested_zone_count: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.division_mode, 'area_count');
  assert.equal(result.area_count, 1);
  assert.equal(result.workload_basis, 'street_length');
});

test('workload-size planning calculates territory count from approximate street workload', () => {
  const result = planCanvasTerritories({
    polygon,
    roadNetwork,
    target_street_workload_meters_per_area: 5000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.division_mode, 'street_workload_target');
  assert.ok(result.area_count >= 1);
});

test('deployability is based on exact street-work-unit ownership, not doors', () => {
  const plan = assignedPlan();
  assert.equal(isCanvasPlanDeployable(plan), true);
  assert.equal(isCanvasPlanDeployable({ ...plan, data_version: null }), false);
  assert.equal(isCanvasPlanDeployable({ ...plan, zones: [{ ...plan.zones[0], assigned_team_member_id: null }] }), false);
  assert.equal(isCanvasPlanDeployable({ ...plan, qa: { ...plan.qa, protected_units_intact: false } }), false);
  assert.equal(isCanvasPlanDeployable({ ...plan, work_units: [] }), false);
});

test('draft payload carries canonical territory geometry and no house-analysis dependency', () => {
  const plan = assignedPlan();
  const payload = buildCanvasDraftPayload({
    sessionId: 'session_1',
    expectedVersion: 2,
    sessionName: 'North Team',
    polygon,
    plan,
  });
  assert.equal(payload.session_id, 'session_1');
  assert.equal(payload.expected_version, 2);
  assert.equal(payload.territory_model, 'street_territory_v1');
  assert.equal(payload.planning_method, 'street_workload');
  assert.equal(payload.assignment_basis, 'street_work_unit_ids');
  assert.equal(payload.division_mode, 'selected_reps');
  assert.equal(payload.workload_basis, 'street_length');
  assert.equal(payload.target_workload, null);
  assert.deepEqual(payload.selected_team_member_ids, ['rep_1']);
  assert.ok(payload.work_units.length > 0);
  assert.ok(payload.zones[0].work_unit_ids.length > 0);
  assert.equal('doors' in payload, false);
  assert.equal('analysis_id' in payload, false);
  assert.equal('target_homes' in payload, false);
});

test('renaming a Canvas draft clears a pending deployment retry', () => {
  const source = readFileSync(new URL('../src/components/map/CanvasBuilderSettings.jsx', import.meta.url), 'utf8');
  assert.match(source, /const changeSessionName = \(value\) => \{[\s\S]*?setSessionName\(value\);[\s\S]*?deploymentAttemptRef\.current = null;/);
});

test('mobile Canvas collapses so managers can inspect the generated map', () => {
  const source = readFileSync(new URL('../src/components/map/CanvasBuilderSettings.jsx', import.meta.url), 'utf8');
  assert.match(source, /mobileCollapsed \? 'h-16' : 'h-\[82dvh\]/);
  assert.match(source, /Collapse to inspect map/);
  assert.match(source, /aria-expanded=\{!mobileCollapsed\}/);
});

test('manager has lifecycle controls and a polling shared outcome map', () => {
  const client = readFileSync(new URL('../src/components/canvas/canvasProductionClient.js', import.meta.url), 'utf8');
  const builder = readFileSync(new URL('../src/components/map/CanvasBuilderSettings.jsx', import.meta.url), 'utf8');
  const field = readFileSync(new URL('../src/components/rep/CanvasFieldView.jsx', import.meta.url), 'utf8');
  assert.match(client, /invokeProductionFunction\('canvasCloseCampaign'/);
  assert.match(client, /invokeProductionFunction\('canvasGetCampaignMap'/);
  assert.match(builder, /closeCampaign\('complete'\)/);
  assert.match(builder, /closeCampaign\('recall'\)/);
  assert.match(builder, /Shared campaign map/);
  assert.match(builder, /CAMPAIGN_REFRESH_MS/);
  assert.match(builder, /last verified map remains visible/);
  assert.match(builder, /Start another area/);
  assert.match(builder, /startAnotherArea/);
  assert.match(builder, /Saved Canvas drafts/);
  assert.match(builder, /resumeDraft/);
  assert.match(builder, /onResumeBoundary\(boundary\.points\)/);
  assert.match(builder, /canvasZoneLoggedCount\(value\)/);
  assert.match(builder, /All do-not-knock pins are still loaded/);
  assert.doesNotMatch(builder, /visible totals and newest records may be incomplete/);
  assert.match(field, /result\.dnc_safety\?\.complete !== true/);
  assert.match(field, /All do-not-knock pins are still loaded/);
});

test('Canvas exposes rep-count, approximate workload-size, and advanced fixed-count planning', () => {
  const builder = readFileSync(new URL('../src/components/map/CanvasBuilderSettings.jsx', import.meta.url), 'utf8');
  assert.match(builder, /title="Selected reps"/);
  assert.match(builder, /title="Workload size"/);
  assert.match(builder, /target_street_workload_meters_per_area: targetWorkloadMeters/);
  assert.match(builder, /class-weighted, knockable street distance—not home counts/);
  assert.match(builder, /Advanced · choose an exact number of territories/);
  assert.match(builder, /Shortest/);
  assert.match(builder, /Max deviation/);
});

test('Canvas touch and pen drawing commits on release without changing Precision confirmation behavior', () => {
  const drawTool = readFileSync(new URL('../src/components/map/MapDrawTool.jsx', import.meta.url), 'utf8');
  const home = readFileSync(new URL('../src/pages/Home.jsx', import.meta.url), 'utf8');
  const toolbar = readFileSync(new URL('../src/components/map/MapToolbar.jsx', import.meta.url), 'utf8');
  assert.match(drawTool, /confirmOnRelease = false/);
  assert.match(home, /confirmOnRelease=\{routeMode === 'canvas'\}/);
  assert.match(drawTool, /const onPointerUp = [\s\S]*?finishDrawing\(confirmOnRelease\)/);
  assert.match(drawTool, /const onPointerCancel = [\s\S]*?finishDrawing\(false\)/);
  assert.match(drawTool, /const onTouchEnd = [\s\S]*?finishDrawing\(confirmOnRelease\)/);
  assert.match(drawTool, /const onTouchCancel = [\s\S]*?finishDrawing\(false\)/);
  assert.match(toolbar, /drawingMode = false/);
  assert.match(toolbar, /!drawingMode && \([\s\S]*?onClick=\{\(\) => setShowCompare\(true\)\}/);
  assert.match(toolbar, /routeMode === 'canvas' && mode === 'generate' && !activeRoute \? !drawingMode &&/);
});

test('Canvas without linked reps defaults to a previewable workload plan and explains deployment recovery', () => {
  const builder = readFileSync(new URL('../src/components/map/CanvasBuilderSettings.jsx', import.meta.url), 'utf8');
  assert.match(builder, /initialRosterModeResolvedRef/);
  assert.match(builder, /activeTeamMembers, teamMembersReady, teamExclusions/);
  assert.match(builder, /campaignIndexError, campaignSigningUnavailable, refreshCampaignIndex/);
  assert.match(builder, /!activeTeamMembers\.length && divisionBasis === 'selected_reps' && !plan && !deployed/);
  assert.match(builder, /setDivisionBasis\('street_workload_target'\)/);
  assert.match(builder, /Plan now, assign reps later/);
  assert.match(builder, /have each rep sign in and redeem your invite code/);
  assert.match(builder, /Manage reps and invites/);
  assert.match(builder, /to=\{createPageUrl\('AdminTeam'\)\} target="_blank" rel="noopener noreferrer"/);
  assert.match(builder, /Canvas deployment security needs setup/);
  assert.match(builder, /You can still draw, load streets, generate territories, and save a draft/);
});

test('Canvas renders authoritative street ownership instead of filled territory surfaces', () => {
  const zones = readFileSync(new URL('../src/components/map/CanvasZoneLayers.jsx', import.meta.url), 'utf8');
  const field = readFileSync(new URL('../src/components/rep/CanvasFieldView.jsx', import.meta.url), 'utf8');
  assert.match(zones, /canvasZoneStreetSegments/);
  assert.match(zones, /<Polyline/);
  assert.doesNotMatch(zones, /<Polygon|fillOpacity/);
  assert.match(field, /your colored street territory/);
  assert.match(field, /campaignBoundary/);
  assert.match(field, /attributionControl/);
  assert.match(field, /OpenStreetMap contributors/);
  assert.match(field, /Tiles &copy; Esri/);
});

test('Canvas field decisions use an isolated durable queue and never report a failed write as synced', () => {
  const queue = readFileSync(new URL('../src/components/canvas/canvasDecisionQueue.js', import.meta.url), 'utf8');
  const field = readFileSync(new URL('../src/components/rep/CanvasFieldView.jsx', import.meta.url), 'utf8');
  assert.match(queue, /firstknock-canvas/);
  assert.match(queue, /canvas_decision_queue_v2/);
  assert.doesNotMatch(queue, /Precision|SavedRoute|Property/);
  assert.match(queue, /actorUserId/);
  assert.match(queue, /assignedTeamMemberId/);
  assert.match(queue, /actorScope/);
  assert.match(field, /await queueCanvasDecision\(decision\)/);
  assert.match(field, /await acknowledgeCanvasDecision\(decision\)/);
  assert.match(field, /pending on this device and is not shared yet/);
  assert.match(field, /window\.addEventListener\('online', refresh\)/);
  assert.match(field, /if \(decision\.syncState === 'needs_attention'\) continue/);
  assert.match(field, /if \(!terminalDecisionError\(error\)\) break/);
  assert.match(field, /Retry exact decision/);
  assert.match(field, /Choose new location/);
  assert.match(field, /Discard pending/);
  assert.match(field, /Unit \/ apartment/);
  assert.match(field, /dnc_safety_limit_exceeded/);
  assert.match(field, /dnc_safety_integrity_failed/);
  assert.match(field, /Field work locked for do-not-knock safety/);
  assert.match(field, /result\.dnc_safety\?\.complete !== true/);
  assert.match(field, /setPins\(\[\]\)/);
  assert.match(field, /dncSafetyComplete && <MapTapCapture/);
  assert.match(field, /if \(!dncSafetyComplete\) return toast\.error\('House logging is locked/);
  assert.match(field, /if \(safetyVerified\) retryPendingDecisions\(\{ safetyVerified: true \}\)/);
});
