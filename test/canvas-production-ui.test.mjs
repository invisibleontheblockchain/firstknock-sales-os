import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  assignCanvasZonesRoundRobin,
  buildCanvasDraftPayload,
  formatCanvasOverlapConfirmation,
  getCanvasCrewAssignmentStatus,
  getCanvasPlanComplexityStatus,
  getCanvasPlannerFailureMessage,
  getCanvasTeamMemberEligibility,
  getCanvasWorkloadDeviation,
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

test('Canvas preserves one territory per selected rep at 2, 20, and 200 reps', () => {
  for (const count of [2, 20, 200]) {
    const repIds = Array.from({ length: count }, (_, index) => `rep_${index + 1}`);
    const zones = Array.from({ length: count }, (_, index) => ({ zone_id: `zone_${index + 1}` }));
    const assigned = assignCanvasZonesRoundRobin(zones, repIds, repIds.map((id) => linkedRep(id)));
    assert.equal(assigned.length, count);
    assert.deepEqual(assigned.map((zone) => zone.assigned_team_member_id), repIds);
    assert.equal(new Set(assigned.map((zone) => zone.assigned_team_member_id)).size, count);
  }
});

test('headcount assignment requires one distinct selected rep per territory', () => {
  const zones = [
    { zone_id: 'zone_1', assigned_team_member_id: 'rep_1' },
    { zone_id: 'zone_2', assigned_team_member_id: 'rep_1' },
  ];
  const duplicate = getCanvasCrewAssignmentStatus({ division_mode: 'area_count', zones }, ['rep_1', 'rep_2']);
  assert.equal(duplicate.valid, false);
  assert.match(duplicate.message, /exactly one territory/);

  const oneEach = getCanvasCrewAssignmentStatus({
    division_mode: 'area_count',
    zones: [zones[0], { ...zones[1], assigned_team_member_id: 'rep_2' }],
  }, ['rep_1', 'rep_2']);
  assert.equal(oneEach.valid, true);

  const extraSelection = getCanvasCrewAssignmentStatus({
    division_mode: 'area_count',
    zones: [zones[0], { ...zones[1], assigned_team_member_id: 'rep_2' }],
  }, ['rep_1', 'rep_2', 'rep_3']);
  assert.equal(extraSelection.valid, false);
  assert.match(extraSelection.message, /exactly 2 reps/);
});

test('workload packs may repeat reps but cannot silently omit a selected rep', () => {
  const zones = [
    { zone_id: 'zone_1', assigned_team_member_id: 'rep_1' },
    { zone_id: 'zone_2', assigned_team_member_id: 'rep_1' },
  ];
  assert.equal(getCanvasCrewAssignmentStatus({ division_mode: 'street_workload_target', zones }, ['rep_1']).valid, true);
  const omitted = getCanvasCrewAssignmentStatus({ division_mode: 'street_workload_target', zones }, ['rep_1', 'rep_2']);
  assert.equal(omitted.valid, false);
  assert.match(omitted.message, /Every selected rep must receive work/);
});

test('workload deviation is recomputed from zones and fails closed when unavailable', () => {
  const recomputed = getCanvasWorkloadDeviation({
    qa: { max_workload_deviation_percent: 'not-a-number' },
    zones: [{ workload_score: 100 }, { workload_score: 300 }],
  });
  assert.equal(recomputed.verified, true);
  assert.equal(recomputed.value, 50);
  assert.equal(recomputed.source, 'zone_workload_scores');

  const unavailable = getCanvasWorkloadDeviation({
    qa: { max_workload_deviation_percent: 'not-a-number' },
    zones: [{ workload_score: null }],
  });
  assert.equal(unavailable.verified, false);
  assert.equal(unavailable.value, null);
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

test('Canvas leads with crew intent and keeps approximate street sizing advanced', () => {
  const builder = readFileSync(new URL('../src/components/map/CanvasBuilderSettings.jsx', import.meta.url), 'utf8');
  assert.match(builder, /label="Choose who is working"/);
  assert.match(builder, /title="Choose reps"/);
  assert.match(builder, /title="Enter headcount"/);
  assert.match(builder, /How many people are working this area\?/);
  assert.match(builder, /one connected territory per person/);
  assert.match(builder, /colored map preview updates automatically/);
  assert.match(builder, /window\.setTimeout\(\(\) => \{[\s\S]*?generatePlan\(\{ quiet: true \}\)[\s\S]*?\}, 600\)/);
  assert.match(builder, /divisionBasis !== 'area_count'/);
  assert.match(builder, /!plan \|\| !planStaleReason/);
  assert.match(builder, /lastAttemptedPreviewRevisionRef/);
  assert.match(builder, /livePreviewTimerRef/);
  assert.match(builder, /window\.clearTimeout\(livePreviewTimerRef\.current\)/);
  assert.match(builder, /plannerAbortRef\.current\?\.abort\(\)/);
  assert.match(builder, /toast\.dismiss\(toastId\)/);
  assert.match(builder, /const sendable = deployable\s*&& !planStaleReason/);
  assert.match(builder, /if \(planStaleReason\) return toast\.error\('The territory preview is out of date\./);
  assert.match(builder, /target_street_workload_meters_per_area: requestSnapshot\.targetWorkloadMeters/);
  assert.match(builder, /create standard-size work packs/);
  assert.match(builder, /Target street coverage per territory \(miles\)/);
  assert.match(builder, /not a door count or promised walking time/);
  assert.match(builder, /value="Balanced streets"/);
  assert.match(builder, /Weighted range/);
  assert.match(builder, /Maximum deviation/);
  assert.match(builder, /Quality details/);
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

test('Canvas without linked reps defaults to a previewable headcount plan and explains deployment recovery', () => {
  const builder = readFileSync(new URL('../src/components/map/CanvasBuilderSettings.jsx', import.meta.url), 'utf8');
  assert.match(builder, /initialRosterModeResolvedRef/);
  assert.match(builder, /activeTeamMembers, teamMembersReady, teamExclusions/);
  assert.match(builder, /campaignIndexError, campaignSigningUnavailable, refreshCampaignIndex/);
  assert.match(builder, /!activeTeamMembers\.length && divisionBasis === 'selected_reps' && !plan && !deployed/);
  assert.match(builder, /setDivisionBasis\('area_count'\)/);
  assert.match(builder, /Plan now, assign reps later/);
  assert.match(builder, /Enter your crew size and build the territory preview now/);
  assert.match(builder, /have each rep sign in and redeem your invite code/);
  assert.match(builder, /Manage reps/);
  assert.match(builder, /Refresh roster/);
  assert.match(builder, /to=\{createPageUrl\('AdminTeam'\)\} target="_blank" rel="noopener noreferrer"/);
  assert.match(builder, /Canvas deployment security needs setup/);
  assert.match(builder, /You can still draw, load streets, generate territories, and save a draft/);
});

test('Canvas complexity guard matches the exact save and deploy boundary', () => {
  const allowed = getCanvasPlanComplexityStatus({
    zones: Array.from({ length: 250 }, () => ({})),
    work_units: Array.from({ length: 720 }, () => ({})),
  });
  const rejectedProduct = getCanvasPlanComplexityStatus({
    zones: Array.from({ length: 250 }, () => ({})),
    work_units: Array.from({ length: 721 }, () => ({})),
  });
  const rejectedUnits = getCanvasPlanComplexityStatus({
    zones: [{}],
    work_units: Array.from({ length: 2_001 }, () => ({})),
  });
  const rejectedSegments = getCanvasPlanComplexityStatus({
    zones: [{}],
    work_units: [{ segments: Array.from({ length: 50_001 }, () => ({})) }],
  });
  assert.equal(allowed.complexity, 180_000);
  assert.equal(allowed.supported, true);
  assert.equal(rejectedProduct.complexity, 180_250);
  assert.equal(rejectedProduct.supported, false);
  assert.equal(rejectedUnits.supported, false);
  assert.equal(rejectedSegments.segmentCount, 50_001);
  assert.equal(rejectedSegments.supported, false);
});

test('Canvas guards every visible unsaved-plan exit and keeps saved draft identity across replanning', () => {
  const builder = readFileSync(new URL('../src/components/map/CanvasBuilderSettings.jsx', import.meta.url), 'utf8');
  const toolbar = readFileSync(new URL('../src/components/map/MapToolbar.jsx', import.meta.url), 'utf8');
  const settings = readFileSync(new URL('../src/components/map/MapSettingsPanel.jsx', import.meta.url), 'utf8');
  const home = readFileSync(new URL('../src/pages/Home.jsx', import.meta.url), 'utf8');
  const layout = readFileSync(new URL('../src/Layout.jsx', import.meta.url), 'utf8');
  assert.match(builder, /confirmDiscardUnsaved\('Closing the planner'\)/);
  assert.match(builder, /confirmDiscardUnsaved\('Redrawing the work area'\)/);
  assert.match(builder, /confirmDiscardUnsaved\('Clearing the work area'\)/);
  assert.match(builder, /confirmDiscardUnsaved\('Opening this saved draft'\)/);
  assert.match(builder, /window\.addEventListener\('beforeunload'/);
  assert.match(toolbar, /allowCanvasDiscard\('Opening Live View'\)/);
  assert.match(home, /requestRouteModeChange/);
  assert.match(home, /fk-canvas-draft-dirty-changed/);
  assert.match(settings, /setRouteMode\?\.\(v\) === false/);
  assert.match(layout, /window\.addEventListener\('fk-canvas-draft-dirty-changed'/);
  assert.match(layout, /onClickCapture=\{guardCanvasNavigationCapture\}/);
  assert.match(layout, /targetUrl\.pathname === currentUrl\.pathname && targetUrl\.search === currentUrl\.search/);
  assert.match(layout, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);/);
  assert.match(layout, /if \(!confirmCanvasNavigation\('Logging out'\)\) return/);
  const generationStart = builder.indexOf('const generatePlan = async');
  const generationEnd = builder.indexOf('const autoAssign =', generationStart);
  assert.ok(generationStart >= 0 && generationEnd > generationStart);
  assert.doesNotMatch(builder.slice(generationStart, generationEnd), /setServerSession\(null\)/);
});

test('flexible drafts preserve the manager-selected crew instead of silently dropping extras', () => {
  const plan = {
    ...assignedPlan({ divisionMode: 'area_count' }),
    division_mode: 'area_count',
    division_basis: 'area_count',
    selected_team_member_ids: ['rep_1', 'rep_2'],
  };
  const payload = buildCanvasDraftPayload({ sessionName: 'Crew intent', polygon, plan });
  assert.deepEqual(payload.selected_team_member_ids, ['rep_1', 'rep_2']);

  const restored = restoreCanvasDraftPlan({
    ...payload,
    campaign_id: 'draft_flexible',
    stored_status: 'draft',
    qa: { ...payload.qa, warnings: [] },
  }, [linkedRep('rep_1'), linkedRep('rep_2')]);
  assert.deepEqual(restored.selected_team_member_ids, ['rep_1', 'rep_2']);
});

test('large Canvas rosters use explicit searchable bulk selection and never silently assign roster order', () => {
  const builder = readFileSync(new URL('../src/components/map/CanvasBuilderSettings.jsx', import.meta.url), 'utf8');
  assert.match(builder, /placeholder="Search reps"/);
  assert.match(builder, /Select all active/);
  assert.match(builder, /replaceTeamMemberSelection/);
  assert.match(builder, /const assignmentPool = selectedTeamMemberIds/);
  assert.doesNotMatch(builder, /const assignmentPool = divisionBasis === 'selected_reps' \? selectedTeamMemberIds : activeTeamMembers\.map/);
  assert.match(builder, /assignmentPool\.length > zones\.length/);
  assert.match(builder, /Choose at most \$\{zones\.length\} reps/);
  assert.match(builder, /clearFlexibleAssignments/);
  assert.match(builder, /map-first review for large teams/);
});

test('Canvas makes materially uneven but street-safe plans an explicit manager decision', () => {
  const builder = readFileSync(new URL('../src/components/map/CanvasBuilderSettings.jsx', import.meta.url), 'utf8');
  assert.match(builder, /workloadDeviationStatus\.verified[\s\S]*?workloadDeviationStatus\.value > 25[\s\S]*?!workloadExceptionAccepted/);
  assert.match(builder, /I reviewed and accept this uneven split/);
  assert.match(builder, /role="checkbox" aria-checked=\{workloadExceptionAccepted\}/);
  assert.match(builder, /if \(workloadExceptionNeedsAcceptance\) return toast\.error/);
  assert.match(builder, /disabled=\{!sendable \|\| mutationsLocked\}/);
  assert.match(builder, /natural street units intact instead of cutting a cul-de-sac/);
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
