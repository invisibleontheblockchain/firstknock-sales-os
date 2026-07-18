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
const way = (id, nodes, name, highway = 'residential') => ({ type: 'way', id, nodes, tags: { highway, name } });
const estimate = (id, lat, lng, streetName, weight = 1) => ({ id, lat, lng, streetName, weight });

function fixture({ withEstimates = false } = {}) {
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
    ...(withEstimates ? {
      door_candidates: [
        estimate('main-left', 35.00005, -82.006, 'Main Street'),
        estimate('main-right', 35.00005, -81.994, 'Main St'),
        estimate('loop-stem', 35.002, -81.99995, 'Loop Court'),
        estimate('loop-west', 35.006, -82.0009, 'Loop Ct'),
        estimate('loop-east', 35.006, -81.9991, 'Loop Court'),
      ],
    } : {}),
    area_count: 2,
    max_snap_distance_meters: 100,
  };
}

function unitOwnership(result) {
  return Object.fromEntries(result.zones
    .flatMap((zone) => zone.work_unit_ids.map((unitId) => [unitId, zone.zone_id]))
    .sort(([left], [right]) => left.localeCompare(right)));
}

function distanceToSegmentDegrees(point, start, end) {
  const deltaLng = end.lng - start.lng;
  const deltaLat = end.lat - start.lat;
  const lengthSquared = deltaLng * deltaLng + deltaLat * deltaLat;
  const position = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
    ((point.lng - start.lng) * deltaLng + (point.lat - start.lat) * deltaLat) / lengthSquared));
  return Math.hypot(
    point.lng - (start.lng + position * deltaLng),
    point.lat - (start.lat + position * deltaLat),
  );
}

function disconnectedFixture(areaCount) {
  return {
    polygon,
    roadNetwork: {
      elements: [
        node(101, 35.002, -82.008),
        node(102, 35.002, -82.003),
        node(201, 35.007, -81.997),
        node(202, 35.007, -81.992),
        way(1001, [101, 102], 'West Street'),
        way(2001, [201, 202], 'East Street'),
      ],
    },
    area_count: areaCount,
  };
}

test('creates road-only connected territories with exact exclusive street-unit coverage', () => {
  const result = planCanvasTerritories(fixture());

  assert.equal(result.ok, true);
  assert.equal(result.deployable, true);
  assert.equal(result.planning_method, 'street_workload');
  assert.equal(result.assignment_basis, 'street_work_unit_ids');
  assert.equal(result.ownership_geometry, 'clipped_street_segments');
  assert.equal(result.workload_basis, 'street_length');
  assert.equal(result.zones.length, 2);
  assert.equal(result.qa.street_coverage_complete, true);
  assert.equal(result.qa.exclusive_work_unit_coverage, true);
  assert.equal(result.qa.no_duplicate_work_units, true);
  assert.equal(result.qa.no_missing_work_units, true);
  assert.equal(result.qa.connected_zones, true);
  assert.equal(result.qa.atomic_work_units, true);
  assert.equal(result.qa.protected_units_intact, true);
  assert.equal(result.qa.display_geometry_complete, true);
  assert.equal(result.qa.cul_de_sac_splits, 0);
  assert.equal(Object.keys(unitOwnership(result)).length, result.work_units.length);
  assert.deepEqual(result.doors, []);
  assert.deepEqual(result.door_candidates, []);
  assert.ok(result.zones.every((zone) => zone.geometry.length >= 3 && zone.work_unit_ids.length >= 1));
  assert.ok(result.zones.every((zone) => zone.geometry_role === 'display_only'));
  assert.ok(result.zones.every((zone) => zone.street_segments.length >= 1 && zone.street_length_meters > 0));
  assert.ok(result.zones.every((zone) => zone.street_segments.some((segment) => (
    distanceToSegmentDegrees(zone.drop_point, segment.start, segment.end) < 1e-10
  ))));
  assert.equal(result.qa.assigned_street_length_meters, result.qa.total_street_length_meters);
});

test('keeps every lollipop cul-de-sac edge in one protected atomic work unit and one zone', () => {
  const result = planCanvasTerritories(fixture());
  const protectedUnit = result.work_units.find((unit) => unit.protected);
  const owner = result.zones.find((zone) => zone.work_unit_ids.includes(protectedUnit.id));

  assert.ok(protectedUnit);
  assert.equal(protectedUnit.edgeIds.length, 5);
  assert.equal(owner.street_segments.filter((segment) => segment.work_unit_id === protectedUnit.id).length, 5);
  assert.equal(result.qa.cul_de_sac_splits, 0);
});

test('uses one area per selected rep and rejects a conflicting explicit count', () => {
  const selected = planCanvasTerritories({
    ...fixture(),
    area_count: undefined,
    selected_team_member_ids: ['rep-b', 'rep-a'],
    requested_zone_count: 2,
  });
  const mismatch = planCanvasTerritories({
    ...fixture(),
    area_count: undefined,
    selected_team_member_ids: ['rep-a', 'rep-b'],
    requested_zone_count: 3,
  });

  assert.equal(selected.ok, true);
  assert.equal(selected.division_mode, 'selected_reps');
  assert.deepEqual(selected.selected_team_member_ids, ['rep-a', 'rep-b']);
  assert.equal(selected.area_count, 2);
  assert.deepEqual(
    { ok: mismatch.ok, status: mismatch.status, code: mismatch.code },
    { ok: false, status: 'blocked', code: 'AREA_COUNT_REP_MISMATCH' },
  );
});

test('is deterministic when roads and optional estimates arrive in another order', () => {
  const original = fixture({ withEstimates: true });
  const reordered = {
    ...original,
    door_candidates: [...original.door_candidates].reverse(),
    roadNetwork: {
      elements: [...original.roadNetwork.elements].reverse().map((element) => (
        element.type === 'way' ? { ...element, nodes: [...element.nodes].reverse() } : element
      )),
    },
  };

  const first = planCanvasTerritories(original);
  const second = planCanvasTerritories(reordered);
  assert.deepEqual(unitOwnership(second), unitOwnership(first));
  assert.equal(second.data_version, first.data_version);
  assert.deepEqual(second.door_candidates, first.door_candidates);
  assert.deepEqual(
    Object.fromEntries(second.zones.map((zone) => [zone.zone_id, zone.color]).sort()),
    Object.fromEntries(first.zones.map((zone) => [zone.zone_id, zone.color]).sort()),
  );
});

test('reports exact safe min/max counts for disconnected road components', () => {
  const tooFew = planCanvasTerritories(disconnectedFixture(1));
  const exact = planCanvasTerritories(disconnectedFixture(2));
  const tooMany = planCanvasTerritories(disconnectedFixture(3));

  assert.deepEqual(
    { ok: tooFew.ok, status: tooFew.status, code: tooFew.code },
    { ok: false, status: 'infeasible', code: 'TOO_FEW_ZONES_FOR_COMPONENTS' },
  );
  assert.deepEqual(tooFew.details, { minimum_zone_count: 2, maximum_zone_count: 2 });
  assert.equal(exact.ok, true);
  assert.equal(exact.qa.disconnected_component_count, 2);
  assert.equal(exact.zones.every((zone) => zone.work_unit_ids.length === 1), true);
  assert.deepEqual(
    { ok: tooMany.ok, status: tooMany.status, code: tooMany.code },
    { ok: false, status: 'infeasible', code: 'TOO_MANY_ZONES_FOR_WORK_UNITS' },
  );
  assert.deepEqual(tooMany.details, {
    requested_zone_count: 3,
    minimum_zone_count: 2,
    maximum_zone_count: 2,
    production_zone_limit: 250,
  });
});

test('derives workload-size areas from class-weighted street meters and enforces the 250-area cap', () => {
  const baseline = planCanvasTerritories({ ...fixture(), area_count: 1 });
  const target = Number((baseline.qa.class_weighted_street_workload_meters / 2 + 0.01).toFixed(2));
  const byTarget = planCanvasTerritories({
    ...fixture(),
    area_count: undefined,
    target_workload_meters_per_area: target,
  });
  const byTargetWithEstimates = planCanvasTerritories({
    ...fixture({ withEstimates: true }),
    area_count: undefined,
    target_workload_meters_per_area: target,
  });
  const overLimit = planCanvasTerritories({
    ...fixture(),
    area_count: undefined,
    target_street_workload_meters_per_area: 0.001,
  });

  assert.equal(byTarget.ok, true);
  assert.equal(byTarget.division_mode, 'street_workload_target');
  assert.equal(byTarget.area_count, 2);
  assert.equal(byTarget.target_street_workload_meters_per_area, target);
  assert.equal(byTarget.target_street_workload_meters, target);
  assert.equal(byTargetWithEstimates.area_count, byTarget.area_count);
  assert.deepEqual(
    { ok: overLimit.ok, status: overLimit.status, code: overLimit.code },
    { ok: false, status: 'infeasible', code: 'CANVAS_ZONE_LIMIT_EXCEEDED' },
  );
  assert.equal(overLimit.details.production_zone_limit, 250);
  assert.ok(overLimit.details.requested_zone_count > 250);
});

test('reuses the palette only across nonadjacent territories when there are more than eight areas', () => {
  const elements = [];
  const gridNodeId = (row, column) => 100 + row * 10 + column;
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      elements.push(node(gridNodeId(row, column), 35.001 + row * 0.002, -82.009 + column * 0.004));
    }
  }
  for (let row = 0; row < 4; row += 1) {
    elements.push(way(1000 + row, Array.from({ length: 4 }, (_, column) => gridNodeId(row, column)), `Row ${row}`));
  }
  for (let column = 0; column < 4; column += 1) {
    elements.push(way(2000 + column, Array.from({ length: 4 }, (_, row) => gridNodeId(row, column)), `Column ${column}`));
  }
  const result = planCanvasTerritories({ polygon, roadNetwork: { elements }, area_count: 9 });
  const zoneByUnitId = new Map(result.zones.flatMap((zone) => zone.work_unit_ids.map((unitId) => [unitId, zone])));

  assert.equal(result.ok, true);
  assert.equal(result.zones.length, 9);
  assert.ok(new Set(result.zones.map((zone) => zone.color)).size < result.zones.length);
  result.work_units.forEach((unit) => unit.neighborIds.forEach((neighborId) => {
    const zone = zoneByUnitId.get(unit.id);
    const neighborZone = zoneByUnitId.get(neighborId);
    if (zone.zone_id !== neighborZone.zone_id) assert.notEqual(zone.color, neighborZone.color);
  }));
  assert.equal(result.qa.adjacent_zone_color_conflicts, 0);
});

test('uses optional door estimates only as workload tuning, never as assignment identity', () => {
  const result = planCanvasTerritories(fixture({ withEstimates: true }));

  assert.equal(result.ok, true);
  assert.equal(result.assignment_basis, 'street_work_unit_ids');
  assert.equal(result.workload_basis, 'street_length_plus_estimated_doors');
  assert.equal(result.door_candidates.length, 5);
  assert.equal(result.qa.estimated_doors, 5);
  assert.deepEqual(result.doors, []);
  assert.ok(result.door_candidates.every((candidate) => candidate.work_unit_id && candidate.zone_id));
  assert.ok(result.zones.every((zone) => zone.estimated_doors !== null));
});

test('ignores unusable optional estimates and still plans the road territory', () => {
  const input = fixture();
  input.door_candidates = [estimate('between-roads', 35, -82, '')];
  input.roadNetwork.elements.push(
    node(20, 35.0002, -82.011),
    node(21, 35.0002, -81.989),
    way(500, [20, 21], 'Parallel Street'),
  );
  const result = planCanvasTerritories(input);

  assert.equal(result.ok, true);
  assert.equal(result.workload_basis, 'street_length');
  assert.deepEqual(result.door_candidates, []);
  assert.ok(result.warnings.some((warning) => warning.includes('Optional door estimates were ignored')));
});

test('downweights long arterials in the class-weighted balancing metric', () => {
  const input = fixture();
  input.roadNetwork.elements = input.roadNetwork.elements.map((element) => (
    element.type === 'way' && element.id === 100
      ? { ...element, tags: { ...element.tags, highway: 'primary' } }
      : element
  ));
  const result = planCanvasTerritories(input);
  const arterialSegments = result.work_units
    .flatMap((unit) => unit.segments)
    .filter((segment) => segment.highwayTypes.includes('primary'));

  assert.equal(result.ok, true);
  assert.ok(arterialSegments.length > 0);
  assert.ok(arterialSegments.every((segment) => segment.workloadWeight === 0.05));
  assert.ok(result.qa.class_weighted_street_workload_meters < result.qa.total_street_length_meters);
});

test('clips street display geometry to the freehand boundary', () => {
  const input = fixture();
  input.roadNetwork.elements = input.roadNetwork.elements.map((element) => {
    if (element.type !== 'node' || ![1, 3].includes(element.id)) return element;
    return element.id === 1 ? { ...element, lon: -82.02 } : { ...element, lon: -81.98 };
  });
  const result = planCanvasTerritories(input);

  assert.equal(result.ok, true);
  const vertices = result.zones.flatMap((zone) => zone.parts.flat());
  assert.ok(vertices.length > 0);
  assert.ok(vertices.every((point) => point.lng >= -82.0110001 && point.lng <= -81.9889999));
  assert.ok(vertices.every((point) => point.lat >= 34.9989999 && point.lat <= 35.0110001));
});

test('data version changes with geography or optional weights, not input ordering', () => {
  const original = fixture({ withEstimates: true });
  const movedEstimate = fixture({ withEstimates: true });
  movedEstimate.door_candidates[0] = {
    ...movedEstimate.door_candidates[0],
    lat: movedEstimate.door_candidates[0].lat + 0.00001,
  };
  const changedRoad = fixture({ withEstimates: true });
  changedRoad.roadNetwork.elements = changedRoad.roadNetwork.elements.map((element) => (
    element.type === 'node' && element.id === 1 ? { ...element, lat: element.lat + 0.00001 } : element
  ));

  const first = planCanvasTerritories(original);
  const second = planCanvasTerritories(movedEstimate);
  const third = planCanvasTerritories(changedRoad);
  assert.notEqual(second.data_version, first.data_version);
  assert.notEqual(third.data_version, first.data_version);
});

test('hashes and authorizes only clipped road geography, not long outside tails', () => {
  const narrowPolygon = [
    { lat: 35, lng: -82 },
    { lat: 35, lng: -81.998 },
    { lat: 35.002, lng: -81.998 },
    { lat: 35.002, lng: -82 },
  ];
  const crossing = (west, east) => ({
    polygon: narrowPolygon,
    roadNetwork: {
      elements: [
        node(9301, 35.001, west),
        node(9302, 35.001, east),
        way(9303, [9301, 9302], 'Long Crossing'),
      ],
    },
    area_count: 1,
  });
  const first = planCanvasTerritories(crossing(-82.1, -81.9));
  const extended = planCanvasTerritories(crossing(-82.2, -81.8));

  assert.equal(first.ok, true);
  assert.equal(extended.ok, true);
  assert.equal(first.data_version, extended.data_version);
  assert.ok(first.qa.total_street_length_meters > 175);
  assert.ok(first.qa.total_street_length_meters < 190);
  assert.equal(first.qa.total_street_length_meters, first.qa.assigned_street_length_meters);
  assert.ok(first.zones[0].street_segments.every((segment) => (
    segment.start.lng >= -82.0000000001
      && segment.start.lng <= -81.9979999999
      && segment.end.lng >= -82.0000000001
      && segment.end.lng <= -81.9979999999
  )));
});
