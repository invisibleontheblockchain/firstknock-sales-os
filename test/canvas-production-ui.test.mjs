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

test('Canvas road loading is identifiable, abortable, typed, cached, and uses current Overpass fallbacks', async () => {
  const source = readFileSync(new URL('../src/components/logic/overpassRoadNetwork.jsx', import.meta.url), 'utf8');
  assert.match(source, /overpass\.private\.coffee/);
  assert.match(source, /maps\.mail\.ru/);
  assert.doesNotMatch(source, /overpass\.kumi\.systems/);
  const originalSessionStorage = globalThis.sessionStorage;
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  const originalConsoleWarn = console.warn;
  const stored = new Map();
  let fetchCount = 0;
  const requests = [];
  globalThis.sessionStorage = {
    getItem: (key) => stored.get(key) || null,
    setItem: (key, value) => stored.set(key, value),
    removeItem: (key) => stored.delete(key),
  };
  globalThis.location = { origin: 'https://firstknock.online' };
  console.warn = () => {};
  globalThis.fetch = async (url, init) => {
    fetchCount += 1;
    requests.push({ url, init });
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
    assert.equal(requests[0].url, 'https://overpass-api.de/api/interpreter');
    assert.equal(requests[0].init.referrer, 'https://firstknock.online/');
    assert.equal(requests[0].init.referrerPolicy, 'strict-origin-when-cross-origin');
    assert.equal(requests[0].init.credentials, 'omit');
    assert.equal(requests[0].init.headers.Accept, 'application/json');
    const surfaceOnlyQuery = new URLSearchParams(requests[0].init.body).get('data');
    assert.match(surfaceOnlyQuery, /\["bridge"!="yes"\]\["tunnel"!="yes"\]/);

    await roads.fetchOverpassRoadNetwork(boundary, { includeGradeSeparated: true });
    await roads.fetchOverpassRoadNetwork(boundary, { includeGradeSeparated: true });
    assert.equal(fetchCount, 3, 'grade-aware routing must use its own cache entry');
    const allGradesQuery = new URLSearchParams(requests[2].init.body).get('data');
    assert.doesNotMatch(allGradesQuery, /\["bridge"!="yes"\]|\["tunnel"!="yes"\]/);

    const constrainedBoundary = [{ lat: 33.1, lng: -112 }, { lat: 33.11, lng: -112 }, { lat: 33.1, lng: -111.99 }];
    globalThis.fetch = async (url, init) => {
      fetchCount += 1;
      requests.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          elements: fetchCount % 2 === 0
            ? [{ type: 'node', id: 20 }, { type: 'node', id: 21 }]
            : [{ type: 'node', id: 22 }],
        }),
      };
    };
    const beforeBudgetedCacheFetches = fetchCount;
    await roads.fetchOverpassRoadNetwork(constrainedBoundary);
    await roads.fetchOverpassRoadNetwork(constrainedBoundary, { maxElements: 1 });
    assert.equal(
      fetchCount,
      beforeBudgetedCacheFetches + 2,
      'a stricter caller must not reuse a cached road graph above its element budget',
    );

    const emptyBoundary = [{ lat: 34, lng: -112 }, { lat: 34.01, lng: -112 }, { lat: 34, lng: -111.99 }];
    const fallbackRequests = [];
    globalThis.fetch = async (url, init) => {
      fallbackRequests.push({ url, init });
      if (url.includes('overpass-api.de')) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ elements: [] }) };
    };
    const empty = await roads.fetchOverpassRoadNetwork(emptyBoundary);
    assert.deepEqual(empty.elements, []);
    assert.equal(empty._canvas.status, 'empty');
    assert.equal(empty._canvas.source, 'maps.mail.ru');
    assert.deepEqual(fallbackRequests.map(({ url }) => url), [
      'https://overpass-api.de/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    ]);
    await roads.fetchOverpassRoadNetwork(emptyBoundary);
    assert.equal(fallbackRequests.length, 2, 'a complete empty response should be cached rather than retried as a service failure');

    const retryEmptyBoundary = [{ lat: 34.1, lng: -112 }, { lat: 34.11, lng: -112 }, { lat: 34.1, lng: -111.99 }];
    await roads.fetchOverpassRoadNetwork(retryEmptyBoundary, { cacheEmptyResults: false });
    await roads.fetchOverpassRoadNetwork(retryEmptyBoundary, { cacheEmptyResults: false });
    assert.equal(
      fallbackRequests.length,
      6,
      'route callers must be able to retry a transient empty road response',
    );

    const abortController = new AbortController();
    abortController.abort();
    await assert.rejects(
      roads.fetchOverpassRoadNetwork([
        { lat: 35, lng: -112 },
        { lat: 35.01, lng: -112 },
        { lat: 35, lng: -111.99 },
      ], { signal: abortController.signal }),
      (error) => error?.name === 'CanvasRoadNetworkError' && error?.code === 'CANVAS_ROAD_NETWORK_ABORTED',
    );

    const inFlightAbortController = new AbortController();
    globalThis.fetch = async (_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    const inFlightRequest = roads.fetchOverpassRoadNetwork([
      { lat: 35.1, lng: -112 },
      { lat: 35.11, lng: -112 },
      { lat: 35.1, lng: -111.99 },
    ], { signal: inFlightAbortController.signal });
    inFlightAbortController.abort();
    await assert.rejects(
      inFlightRequest,
      (error) => error?.name === 'CanvasRoadNetworkError' && error?.code === 'CANVAS_ROAD_NETWORK_ABORTED',
    );

    globalThis.fetch = async (_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    const overallStartedAt = Date.now();
    await assert.rejects(
      roads.fetchOverpassRoadNetwork([
        { lat: 35.2, lng: -112 },
        { lat: 35.21, lng: -112 },
        { lat: 35.2, lng: -111.99 },
      ], { overallTimeoutMs: 1000 }),
      (error) => error?.name === 'CanvasRoadNetworkError'
        && error?.code === 'CANVAS_ROAD_NETWORK_TIMEOUT',
    );
    assert.ok(
      Date.now() - overallStartedAt < 3000,
      'the overall timeout must bound a non-tiled request across all endpoint fallbacks',
    );

    const failedEndpoints = [];
    globalThis.fetch = async (url) => {
      failedEndpoints.push(url);
      return { ok: false, status: 503, json: async () => ({}) };
    };
    await assert.rejects(
      roads.fetchOverpassRoadNetwork([
        { lat: 36, lng: -112 },
        { lat: 36.01, lng: -112 },
        { lat: 36, lng: -111.99 },
      ]),
      (error) => error?.name === 'CanvasRoadNetworkError'
        && error?.code === 'CANVAS_ROAD_NETWORK_UNAVAILABLE'
        && error?.failures?.length === 3
        && error.failures.every((failure) => failure.code === 'CANVAS_ROAD_NETWORK_SERVICE_BUSY'),
    );
    assert.equal(failedEndpoints.length, 3);
  } finally {
    globalThis.sessionStorage = originalSessionStorage;
    globalThis.fetch = originalFetch;
    console.warn = originalConsoleWarn;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});

test('large Canvas boundaries load complete deduplicated street tiles with progress', async () => {
  const source = readFileSync(new URL('../src/components/logic/overpassRoadNetwork.jsx', import.meta.url), 'utf8');
  const originalSessionStorage = globalThis.sessionStorage;
  const originalFetch = globalThis.fetch;
  const stored = new Map();
  const queries = [];
  const progress = [];
  let requestId = 0;
  globalThis.sessionStorage = {
    getItem: (key) => stored.get(key) || null,
    setItem: (key, value) => stored.set(key, value),
    removeItem: (key) => stored.delete(key),
  };
  globalThis.fetch = async (_url, request) => {
    requestId += 1;
    queries.push(String(request.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        elements: [
          { type: 'node', id: 1, lat: 33, lon: -112 },
          { type: 'node', id: requestId + 1, lat: 33.01, lon: -111.99 },
        ],
      }),
    };
  };
  try {
    const roads = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#tiled`);
    const boundary = [
      { lat: 33, lng: -112 },
      { lat: 33, lng: -111.88 },
      { lat: 33.12, lng: -111.88 },
      { lat: 33.12, lng: -112 },
    ];
    const result = await roads.fetchOverpassRoadNetwork(boundary, { onProgress: (value) => progress.push(value) });
    assert.ok(queries.length > 1);
    assert.ok(queries.every((query) => query.includes('%28') && !query.includes('poly%3A')));
    assert.equal(result._canvas.tiled, true);
    assert.equal(result._canvas.tile_count, queries.length);
    assert.equal(result.elements.filter((element) => element.id === 1).length, 1);
    assert.equal(progress.at(-1).completed, progress.at(-1).total);
    const aborted = new AbortController();
    aborted.abort();
    const queryCountBeforeAbort = queries.length;
    await assert.rejects(
      roads.fetchOverpassRoadNetwork(
        boundary.map((point) => ({ ...point, lat: point.lat + 2 })),
        { signal: aborted.signal },
      ),
      (error) => error?.code === 'CANVAS_ROAD_NETWORK_ABORTED',
    );
    assert.equal(
      queries.length,
      queryCountBeforeAbort,
      'an already-aborted tiled request must not contact a road endpoint',
    );
    await assert.rejects(
      roads.fetchOverpassRoadNetwork(boundary.map((point) => ({ ...point, lat: point.lat + 1 })), {
        maxTotalBytes: 250,
      }),
      (error) => error?.code === 'CANVAS_ROAD_NETWORK_TOO_COMPLEX',
    );
    assert.match(source, /cumulativeBytes > maxTotalBytes/);
    assert.match(source, /batchController\.abort\(\)/);
    assert.match(source, /DEFAULT_OVERALL_TIMEOUT_MS/);
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

test('Canvas accepts broad plans through 1,000 square miles and rejects larger boundaries', () => {
  const boundaryForArea = (areaSqMiles) => {
    const sideMiles = Math.sqrt(areaSqMiles);
    const latitudeSpan = sideMiles / 69;
    const longitudeSpan = sideMiles / (69 * Math.cos(33 * Math.PI / 180));
    return [
      { lat: 33, lng: -112 },
      { lat: 33, lng: -112 + longitudeSpan },
      { lat: 33 + latitudeSpan, lng: -112 + longitudeSpan },
      { lat: 33 + latitudeSpan, lng: -112 },
    ];
  };
  for (const area of [50, 200, 999]) {
    const supported = validateCanvasBoundary(boundaryForArea(area));
    assert.equal(supported.valid, true, `${area} sq mi should be accepted`);
  }
  const result = validateCanvasBoundary(boundaryForArea(1_100));
  assert.equal(result.valid, false);
  assert.equal(result.code, 'CANVAS_AREA_TOO_LARGE');
  assert.ok(result.areaSqMiles > 1_000);
  assert.match(result.message, /1,000 sq mi or less before loading streets/);
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

test('area-count assignment may repeat reps but must cover the exact selected roster', () => {
  const zones = [
    { zone_id: 'zone_1', assigned_team_member_id: 'rep_1' },
    { zone_id: 'zone_2', assigned_team_member_id: 'rep_1' },
    { zone_id: 'zone_3', assigned_team_member_id: 'rep_2' },
  ];
  const repeated = getCanvasCrewAssignmentStatus({ division_mode: 'area_count', zones }, ['rep_1', 'rep_2']);
  assert.equal(repeated.valid, true);
  assert.equal(repeated.oneToOne, false);

  const omittedSelection = getCanvasCrewAssignmentStatus({
    division_mode: 'area_count',
    zones: zones.map((zone) => ({ ...zone, assigned_team_member_id: 'rep_1' })),
  }, ['rep_1', 'rep_2']);
  assert.equal(omittedSelection.valid, false);
  assert.match(omittedSelection.message, /Every selected rep must receive work/);
});

test('selected-rep assignment remains strictly one territory per selected rep', () => {
  const repeated = getCanvasCrewAssignmentStatus({
    division_mode: 'selected_reps',
    zones: [
      { zone_id: 'zone_1', assigned_team_member_id: 'rep_1' },
      { zone_id: 'zone_2', assigned_team_member_id: 'rep_1' },
    ],
  }, ['rep_1']);
  assert.equal(repeated.valid, false);
  assert.match(repeated.message, /exactly 2 reps/);

  const oneEach = getCanvasCrewAssignmentStatus({
    division_mode: 'selected_reps',
    zones: [
      { zone_id: 'zone_1', assigned_team_member_id: 'rep_1' },
      { zone_id: 'zone_2', assigned_team_member_id: 'rep_2' },
    ],
  }, ['rep_1', 'rep_2']);
  assert.equal(oneEach.valid, true);
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
  const workspace = readFileSync(new URL('../src/components/map/CanvasPlannerWorkspace.jsx', import.meta.url), 'utf8');
  const field = readFileSync(new URL('../src/components/rep/CanvasFieldView.jsx', import.meta.url), 'utf8');
  assert.match(client, /invokeProductionFunction\('canvasCloseCampaign'/);
  assert.match(client, /invokeProductionFunction\('canvasGetCampaignMap'/);
  assert.match(builder, /closeCampaign\('complete'\)/);
  assert.match(builder, /closeCampaign\('recall'\)/);
  assert.match(workspace, /Shared campaign map/);
  assert.match(builder, /CAMPAIGN_REFRESH_MS/);
  assert.match(builder, /last verified map remains visible/);
  assert.match(workspace, /Create another area plan/);
  assert.match(builder, /startAnotherArea/);
  assert.match(workspace, /Saved area plans/);
  assert.match(builder, /resumeDraft/);
  assert.match(builder, /onResumeBoundary\(boundary\.points\)/);
  assert.match(builder, /canvasZoneLoggedCount\(value\)/);
  assert.match(builder, /All do-not-knock pins are still loaded/);
  assert.doesNotMatch(builder, /visible totals and newest records may be incomplete/);
  assert.match(field, /result\.dnc_safety\?\.complete !== true/);
  assert.match(field, /All do-not-knock pins are still loaded/);
});

test('Canvas builder asks only for subdivision count and keeps assignment in the Areas workspace', () => {
  const builder = readFileSync(new URL('../src/components/map/CanvasBuilderSettings.jsx', import.meta.url), 'utf8');
  const workspace = readFileSync(new URL('../src/components/map/CanvasPlannerWorkspace.jsx', import.meta.url), 'utf8');
  assert.match(builder, /useState\('area_count'\)/);
  assert.match(workspace, /Choose the number of areas/);
  assert.match(workspace, /Number of areas/);
  assert.match(workspace, /only the subdivision count/);
  assert.match(workspace, /No rep is assigned and nothing is sent from the builder/);
  assert.match(workspace, /AREAS & ASSIGNMENTS/);
  assert.match(workspace, /One rep may hold more than one area/);
  assert.doesNotMatch(workspace, /How many people are working this area|Enter headcount|Choose who is working|standard-size work packs/);
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
  assert.match(workspace, /Equal land reference/);
  assert.match(workspace, /balances eligible street workload/);
  assert.match(workspace, /max workload deviation/);
});

test('Canvas keeps owner-scoped previews safe, shows planner feedback, and fits successful plans', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const builder = readFileSync(new URL('../src/components/map/CanvasBuilderSettings.jsx', import.meta.url), 'utf8');
  const home = readFileSync(new URL('../src/pages/Home.jsx', import.meta.url), 'utf8');
  const managerLayers = readFileSync(new URL('../src/components/map/ManagerMapLayers.jsx', import.meta.url), 'utf8');
  const workspace = readFileSync(new URL('../src/components/map/CanvasPlannerWorkspace.jsx', import.meta.url), 'utf8');
  const overlay = readFileSync(new URL('../src/components/map/CanvasZoneOverlay.jsx', import.meta.url), 'utf8');
  assert.match(app, /Toaster as SonnerToaster/);
  assert.match(app, /<SonnerToaster richColors closeButton \/>/);
  assert.match(builder, /setPlanGenerationError\(\{[\s\S]*?code:[\s\S]*?message:[\s\S]*?details:/);
  assert.match(workspace, /function PlannerFailureNotice/);
  assert.match(workspace, /role="alert"/);
  assert.match(workspace, /PlannerFailureNotice failure=\{planGenerationError\}/);
  assert.match(builder, /fitNextPreviewRef\.current = true;\s*setPlan\(nextPlan\)/);
  assert.match(builder, /const fitPreview = fitNextPreviewRef\.current && zones\.length > 0;[\s\S]*?publishZonePreview\(zones,[\s\S]*?fitPreview/);
  assert.doesNotMatch(builder, /publishZonePreview\(nextPlan\.zones/);
  assert.match(home, /const \[canvasZonePreview, setCanvasZonePreview\] = useState\(\{ zones: \[\], workUnits: \[\] \}\)/);
  assert.match(home, /canvasZonePreview=\{canvasZonePreview\}/);
  assert.match(home, /onCanvasPreviewChange=\{setCanvasZonePreview\}/);
  assert.match(managerLayers, /<CanvasZoneOverlay routeMode=\{routeMode\} preview=\{canvasZonePreview\} \/>/);
  assert.match(overlay, /CanvasZoneOverlay\(\{ routeMode = 'precision', preview = \{\} \}\)/);
  assert.doesNotMatch(overlay, /latestCanvasSnapshot/);
  assert.match(overlay, /event\.detail\?\.fitPreview !== true/);
  assert.match(overlay, /if \(fitFrameRef\.current !== null\) \{\s*window\.cancelAnimationFrame\(fitFrameRef\.current\);\s*fitFrameRef\.current = null/);
  assert.match(overlay, /return \(\) => \{[\s\S]*?removeEventListener\('fk-canvas-zones-updated'[\s\S]*?window\.cancelAnimationFrame\(fitFrameRef\.current\)[\s\S]*?fitFrameRef\.current = null/);
  assert.match(overlay, /if \(routeModeRef\.current !== 'canvas'\) return/);
  assert.match(overlay, /routeMode === 'canvas' && routeModeRef\.current !== 'canvas'\) map\.stop\(\)/);
  assert.match(overlay, /map\.fitBounds\(points/);
});

test('Canvas preview gates the exact UTF-8 draft payload before accepting or publishing it', () => {
  const builder = readFileSync(new URL('../src/components/map/CanvasBuilderSettings.jsx', import.meta.url), 'utf8');
  const workspace = readFileSync(new URL('../src/components/map/CanvasPlannerWorkspace.jsx', import.meta.url), 'utf8');
  const helperMatch = builder.match(/function canvasDraftPayloadBytes\(payload\) \{\s*return new TextEncoder\(\)\.encode\(JSON\.stringify\(payload\)\)\.byteLength;\s*\}/);
  assert.ok(helperMatch);
  const measureDraftBytes = Function('TextEncoder', `${helperMatch[0]}; return canvasDraftPayloadBytes;`)(TextEncoder);
  const multibytePayload = { session_name: 'Puertas 🚪 · 漢字 · café' };
  const serializedPayload = JSON.stringify(multibytePayload);
  const expectedUtf8Bytes = new TextEncoder().encode(serializedPayload).byteLength;
  assert.equal(measureDraftBytes(multibytePayload), expectedUtf8Bytes);
  assert.ok(expectedUtf8Bytes > serializedPayload.length);

  const generationStart = builder.indexOf('const generatePlan = async');
  const payloadSizeIndex = builder.indexOf('const previewPayloadBytes = canvasDraftPayloadBytes(buildCanvasDraftPayload({', generationStart);
  const sizeGateIndex = builder.indexOf('if (previewPayloadBytes > MAX_CANVAS_PREVIEW_JSON_BYTES)', payloadSizeIndex);
  const typedErrorIndex = builder.indexOf("error.code = 'CANVAS_DRAFT_TOO_LARGE'", sizeGateIndex);
  const acceptPlanIndex = builder.indexOf('setPlan(nextPlan)', typedErrorIndex);
  assert.ok(generationStart >= 0 && payloadSizeIndex > generationStart);
  assert.ok(sizeGateIndex > payloadSizeIndex && typedErrorIndex > sizeGateIndex);
  assert.ok(acceptPlanIndex > typedErrorIndex);
  assert.match(builder.slice(sizeGateIndex, acceptPlanIndex), /serialized_byte_count: previewPayloadBytes/);
  assert.match(builder.slice(sizeGateIndex, acceptPlanIndex), /maximum_serialized_byte_count: MAX_CANVAS_PREVIEW_JSON_BYTES/);
  assert.match(builder, /CANVAS_DRAFT_METADATA_RESERVE_BYTES = 200_000/);
  assert.match(workspace, /maxLength=\{200\}/);
});

test('Canvas exposes explicit quarantine recovery only in the Areas workspace', () => {
  const builder = readFileSync(new URL('../src/components/map/CanvasBuilderSettings.jsx', import.meta.url), 'utf8');
  const workspace = readFileSync(new URL('../src/components/map/CanvasPlannerWorkspace.jsx', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../src/components/canvas/canvasProductionClient.js', import.meta.url), 'utf8');
  assert.match(client, /canvasQuarantineInvalidCampaigns/);
  assert.match(client, /QUARANTINE_INVALID_CANVAS_RECORDS/);
  assert.match(builder, /window\.confirm\(`Quarantine/);
  assert.match(builder, /Signed records are never changed/);
  assert.match(builder, /quarantinable_campaigns/);
  assert.match(workspace, /Quarantine \{quarantinableCampaignCount\} unsigned legacy record/);
  assert.match(workspace, /rotated signing key can never remove a previously valid campaign/);
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

test('Canvas planning never requires linked reps and the assignment workspace explains recovery', () => {
  const builder = readFileSync(new URL('../src/components/map/CanvasBuilderSettings.jsx', import.meta.url), 'utf8');
  const workspace = readFileSync(new URL('../src/components/map/CanvasPlannerWorkspace.jsx', import.meta.url), 'utf8');
  assert.match(builder, /const \[divisionBasis, setDivisionBasis\] = useState\('area_count'\)/);
  assert.match(builder, /selected_team_member_ids: divisionBasis === 'selected_reps'[\s\S]*?: \[\]/);
  assert.match(workspace, /No eligible reps yet/);
  assert.match(workspace, /area plan is safe to keep unassigned/);
  assert.match(workspace, /Manage reps/);
  assert.match(workspace, /to=\{createPageUrl\('AdminTeam'\)\} target="_blank" rel="noopener noreferrer"/);
  assert.match(workspace, /Sending is temporarily disabled/);
  assert.match(workspace, /Area planning and saving still work/);
});

test('Canvas complexity guard matches the exact save and deploy boundary', () => {
  const allowed = getCanvasPlanComplexityStatus({
    zones: Array.from({ length: 250 }, () => ({})),
    work_units: Array.from({ length: 8_000 }, () => ({})),
  });
  const rejectedProduct = getCanvasPlanComplexityStatus({
    zones: Array.from({ length: 250 }, () => ({})),
    work_units: Array.from({ length: 8_001 }, () => ({})),
  });
  const rejectedUnits = getCanvasPlanComplexityStatus({
    zones: [{}],
    work_units: Array.from({ length: 20_001 }, () => ({})),
  });
  const rejectedSegments = getCanvasPlanComplexityStatus({
    zones: [{}],
    work_units: [{ segments: Array.from({ length: 50_001 }, () => ({})) }],
  });
  assert.equal(allowed.complexity, 2_000_000);
  assert.equal(allowed.supported, true);
  assert.equal(rejectedProduct.complexity, 2_000_250);
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
  assert.match(builder, /const hasUnsavedCanvasWork = !deployed && \(plan/);
  assert.match(builder, /polygon\.length > 0/);
  assert.match(builder, /onDraftDirtyChange\?\.\(hasUnsavedCanvasWork\)/);
  assert.doesNotMatch(toolbar, /Opening Live View|LIVE VIEW|FOCUS MODE|fk_canvasFocusMode|fk-canvas-focus-mode-changed/);
  assert.match(toolbar, /fk-canvas-planner-view-requested/);
  assert.match(toolbar, /detail: \{ view, startNew: view === 'new_area' \}/);
  assert.match(toolbar, /openCanvasPlannerView\('new_area'\)/);
  assert.match(toolbar, /openCanvasPlannerView\('areas'\)/);
  assert.match(builder, /event\.detail\?\.startNew === true/);
  assert.match(builder, /startAnotherAreaRef\.current\?\.\(\)/);
  assert.match(home, /requestRouteModeChange/);
  assert.match(home, /fk-canvas-draft-dirty-changed/);
  assert.match(settings, /setRouteMode\?\.\(v\) === false/);
  assert.match(layout, /window\.addEventListener\('fk-canvas-draft-dirty-changed'/);
  assert.match(layout, /onClickCapture=\{guardCanvasNavigationCapture\}/);
  assert.match(layout, /window\.addEventListener\('popstate', guardCanvasHistoryNavigation, true\)/);
  assert.match(layout, /window\.history\.go\(protectedEntry\.index - nextIndex\)/);
  assert.match(layout, /event\.stopImmediatePropagation\(\)/);
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
  const workspace = readFileSync(new URL('../src/components/map/CanvasPlannerWorkspace.jsx', import.meta.url), 'utf8');
  assert.match(workspace, /placeholder="Search reps"/);
  assert.match(workspace, /Select shown/);
  assert.match(workspace, /replaceSelection/);
  assert.match(builder, /const assignmentPool = selectedTeamMemberIds/);
  assert.doesNotMatch(builder, /const assignmentPool = divisionBasis === 'selected_reps' \? selectedTeamMemberIds : activeTeamMembers\.map/);
  assert.match(builder, /assignmentPool\.length > zones\.length/);
  assert.match(builder, /Choose at most \$\{zones\.length\} reps/);
  assert.match(builder, /reconcileFlexibleAssignments/);
  assert.match(builder, /assignedId && !allowed\.has\(assignedId\)/);
  assert.match(workspace, /overflow-y-auto/);
});

test('Canvas makes materially uneven but street-safe plans an explicit manager decision', () => {
  const builder = readFileSync(new URL('../src/components/map/CanvasBuilderSettings.jsx', import.meta.url), 'utf8');
  const workspace = readFileSync(new URL('../src/components/map/CanvasPlannerWorkspace.jsx', import.meta.url), 'utf8');
  assert.match(builder, /workloadDeviationStatus\.verified[\s\S]*?workloadDeviationStatus\.value > 25[\s\S]*?!workloadExceptionAccepted/);
  assert.match(workspace, /I reviewed and accept this uneven split/);
  assert.match(workspace, /role="checkbox" aria-checked=\{workloadExceptionAccepted\}/);
  assert.match(builder, /if \(workloadExceptionNeedsAcceptance\) return toast\.error/);
  assert.match(builder, /disabled=\{!sendable \|\| mutationsLocked\}/);
  assert.match(workspace, /natural street units intact instead of cutting a cul-de-sac/);
});

test('Canvas renders authoritative street ownership instead of filled territory surfaces', () => {
  const zones = readFileSync(new URL('../src/components/map/CanvasZoneLayers.jsx', import.meta.url), 'utf8');
  const field = readFileSync(new URL('../src/components/rep/CanvasFieldView.jsx', import.meta.url), 'utf8');
  const attribution = readFileSync(new URL('../src/components/map/mapAttribution.js', import.meta.url), 'utf8');
  assert.match(zones, /canvasZoneStreetSegments/);
  assert.match(zones, /<Polyline/);
  assert.doesNotMatch(zones, /<Polygon|fillOpacity/);
  assert.match(zones, /const color = zone\.color \|\| \(assigned \? ASSIGNED_COLOR : UNASSIGNED_COLOR\)/);
  assert.doesNotMatch(zones, /focusMode|fk_canvasFocusMode|fk-canvas-focus-mode-changed/);
  assert.match(field, /your colored street territory/);
  assert.match(field, /campaignBoundary/);
  assert.match(field, /attributionControl=\{false\}/);
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
