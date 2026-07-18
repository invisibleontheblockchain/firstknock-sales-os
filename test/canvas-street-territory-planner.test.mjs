import assert from 'node:assert/strict';
import test from 'node:test';

import { planCanvasTerritories } from '../src/components/logic/canvasStreetTerritoryPlanner.js';

const polygon = [
  { lat: 34.999, lng: -82.011 },
  { lat: 34.999, lng: -81.989 },
  { lat: 35.011, lng: -81.989 },
  { lat: 35.011, lng: -82.011 },
];

const node = (id, lat, lon, tags = {}) => ({ type: 'node', id, lat, lon, tags });
const way = (id, nodes, name) => ({ type: 'way', id, nodes, tags: { highway: 'residential', name } });
const opportunity = (id, lat, lng, streetName) => ({ id, stable_door_id: id, lat, lng, streetName });

function fixture() {
  return {
    polygon,
    roadNetwork: {
      elements: [
        node(1, 35, -82.011),
        node(2, 35, -82),
        node(3, 35, -81.989),
        node(4, 35.004, -82),
        node(5, 35.006, -82.001),
        node(6, 35.008, -82, { highway: 'turning_circle' }),
        node(7, 35.006, -81.999),
        way(100, [1, 2, 3], 'Main Street'),
        way(300, [2, 4], 'Loop Court'),
        way(301, [4, 5, 6, 7, 4], 'Loop Court'),
      ],
    },
    opportunities: [
      opportunity('main-left', 35.00005, -82.006, 'Main Street'),
      opportunity('main-right', 35.00005, -81.994, 'Main St'),
      opportunity('loop-stem', 35.002, -81.99995, 'Loop Court'),
      opportunity('loop-west', 35.006, -82.0009, 'Loop Ct'),
      opportunity('loop-east', 35.006, -81.9991, 'Loop Court'),
    ],
    workload_basis: 'homes_per_area',
    target_homes_per_area: 3,
    analysis_id: 'analysis-owned-1',
    max_snap_distance_meters: 100,
  };
}

function doorOwnership(result) {
  return Object.fromEntries(result.zones.flatMap((zone) => zone.stable_door_ids.map((doorId) => [doorId, zone.zone_id])).sort(([left], [right]) => left.localeCompare(right)));
}

test('creates the requested connected street-work-unit areas with exact stable-door coverage', () => {
  const result = planCanvasTerritories(fixture());

  assert.equal(result.ok, true);
  assert.equal(result.deployable, true);
  assert.ok(['ready', 'degraded'].includes(result.status));
  assert.equal(result.planning_method, 'street_work_units');
  assert.equal(result.assignment_basis, 'stable_door_ids');
  assert.equal(result.zones.length, 2);
  assert.equal(result.qa.coverage_complete, true);
  assert.equal(result.qa.no_duplicate_doors, true);
  assert.equal(result.qa.no_missing_doors, true);
  assert.equal(result.qa.connected_zones, true);
  assert.equal(result.qa.atomic_work_units, true);
  assert.equal(result.qa.protected_units_intact, true);
  assert.equal(result.qa.cul_de_sac_splits, 0);
  assert.deepEqual(Object.keys(doorOwnership(result)), ['loop-east', 'loop-stem', 'loop-west', 'main-left', 'main-right']);
  assert.ok(result.zones.every((zone) => zone.geometry.length >= 3 && zone.work_unit_ids.length >= 1));
  assert.ok(result.doors.every((door) => door.work_unit_id && door.zone_id));
});

test('keeps the lollipop cul-de-sac homes together even when that makes the workload uneven', () => {
  const result = planCanvasTerritories(fixture());
  const ownership = doorOwnership(result);

  assert.equal(ownership['loop-stem'], ownership['loop-west']);
  assert.equal(ownership['loop-stem'], ownership['loop-east']);
  assert.equal(result.qa.cul_de_sac_splits, 0);
});

test('is deterministic when roads and opportunities arrive in another order', () => {
  const original = fixture();
  const reordered = {
    ...original,
    opportunities: [...original.opportunities].reverse(),
    roadNetwork: {
      elements: [...original.roadNetwork.elements].reverse().map((element) => (
        element.type === 'way' ? { ...element, nodes: [...element.nodes].reverse() } : element
      )),
    },
  };

  const first = planCanvasTerritories(original);
  const second = planCanvasTerritories(reordered);
  assert.deepEqual(doorOwnership(second), doorOwnership(first));
  assert.equal(second.data_version, first.data_version);
});

test('returns typed infeasible and blocked states instead of geometry fallbacks', () => {
  const tooMany = planCanvasTerritories({ ...fixture(), requested_zone_count: 4 });
  const noRoads = planCanvasTerritories({ ...fixture(), roadNetwork: { elements: [] } });

  assert.deepEqual(
    { ok: tooMany.ok, deployable: tooMany.deployable, status: tooMany.status, code: tooMany.code },
    { ok: false, deployable: false, status: 'infeasible', code: 'TOO_MANY_ZONES_FOR_WORK_UNITS' },
  );
  assert.deepEqual(
    { ok: noRoads.ok, deployable: noRoads.deployable, status: noRoads.status, code: noRoads.code },
    { ok: false, deployable: false, status: 'blocked', code: 'ROAD_NETWORK_REQUIRED' },
  );
});

test('blocks malformed homes instead of silently shrinking the QA universe', () => {
  const result = planCanvasTerritories({
    ...fixture(),
    opportunities: [...fixture().opportunities, { id: 'broken-home', lat: null, lng: -82 }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.deployable, false);
  assert.equal(result.code, 'INVALID_DOOR_INPUT');
  assert.deepEqual(result.details.invalid_indexes, [5]);
});

test('clips street display geometry to the freehand boundary', () => {
  const input = fixture();
  input.roadNetwork.elements = input.roadNetwork.elements.map((element) => {
    if (element.type !== 'node' || ![1, 3].includes(element.id)) return element;
    return element.id === 1 ? { ...element, lon: -82.02 } : { ...element, lon: -81.98 };
  });
  input.max_snap_distance_meters = 500;
  const result = planCanvasTerritories(input);

  assert.equal(result.ok, true);
  const vertices = result.zones.flatMap((zone) => zone.parts.flat());
  assert.ok(vertices.length > 0);
  assert.ok(vertices.every((point) => point.lng >= -82.0110001 && point.lng <= -81.9889999));
  assert.ok(vertices.every((point) => point.lat >= 34.9989999 && point.lat <= 35.0110001));
});

test('data version changes when geography or topology changes under the same IDs', () => {
  const original = fixture();
  const movedDoor = fixture();
  movedDoor.opportunities[0] = { ...movedDoor.opportunities[0], lat: movedDoor.opportunities[0].lat + 0.00001 };
  const changedRoad = fixture();
  changedRoad.roadNetwork.elements = changedRoad.roadNetwork.elements.map((element) => (
    element.type === 'node' && element.id === 1 ? { ...element, lat: element.lat + 0.00001 } : element
  ));

  const first = planCanvasTerritories(original);
  const second = planCanvasTerritories(movedDoor);
  const third = planCanvasTerritories(changedRoad);
  assert.notEqual(second.data_version, first.data_version);
  assert.notEqual(third.data_version, first.data_version);
});
