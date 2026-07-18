import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCanvasStreetWorkUnits,
  canvasStreetTopologyInternals,
} from '../src/components/logic/canvasStreetTopology.js';

const { edgeIdFor } = canvasStreetTopologyInternals;

const polygon = [
  { lat: 34.999, lng: -82.011 },
  { lat: 34.999, lng: -81.989 },
  { lat: 35.011, lng: -81.989 },
  { lat: 35.011, lng: -82.011 },
];

const node = (id, lat, lon, tags = {}) => ({ type: 'node', id, lat, lon, tags });
const way = (id, nodes, name) => ({
  type: 'way',
  id,
  nodes,
  tags: { highway: 'residential', name },
});
const door = (id, lat, lng, streetName) => ({ id, lat, lng, streetName });

function degreeOneFixture() {
  return {
    polygon,
    roadNetwork: {
      elements: [
        node(1, 35, -82.011),
        node(2, 35, -82),
        node(3, 35, -81.989),
        node(4, 35.004, -82),
        node(5, 35.008, -82, { noexit: 'yes' }),
        way(100, [1, 2, 3], 'Main Street'),
        way(200, [2, 4, 5], 'Cold Court'),
      ],
    },
    doors: [
      door('main-left', 35.00005, -82.006, 'Main St'),
      door('main-right', 35.00005, -81.994, 'Main Street'),
      door('court-stem', 35.002, -81.99995, 'Cold Ct'),
      door('court-end', 35.006, -82.00005, 'Cold Court'),
    ],
    maxSnapDistanceMeters: 100,
  };
}

function lollipopFixture() {
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
    doors: [
      door('main-left', 35.00005, -82.006, 'Main Street'),
      door('main-right', 35.00005, -81.994, 'Main St'),
      door('loop-stem', 35.002, -81.99995, 'Loop Court'),
      door('loop-west', 35.006, -82.0009, 'Loop Ct'),
      door('loop-east', 35.006, -81.9991, 'Loop Court'),
    ],
    maxSnapDistanceMeters: 100,
  };
}

function parallelRoadFixture({ doorLatitude = 35.0001, streetName = '' } = {}) {
  return {
    polygon,
    roadNetwork: {
      elements: [
        node(10, 35, -82.011),
        node(11, 35, -81.989),
        node(20, 35.0002, -82.011),
        node(21, 35.0002, -81.989),
        way(400, [10, 11], 'South Street'),
        way(500, [20, 21], 'North Street'),
      ],
    },
    doors: [door('between-roads', doorLatitude, -82, streetName)],
    maxSnapDistanceMeters: 100,
  };
}

function allCoveredEdgeIds(result) {
  return result.workUnits.flatMap((unit) => unit.edgeIds).sort();
}

test('contracts a degree-1 cul-de-sac from terminal to throat into one protected unit', () => {
  const result = buildCanvasStreetWorkUnits(degreeOneFixture());

  assert.equal(result.ok, true);
  const protectedUnits = result.workUnits.filter((unit) => unit.protected);
  assert.equal(protectedUnits.length, 1);
  assert.equal(protectedUnits[0].kind, 'terminal_to_throat_branch');
  assert.deepEqual(protectedUnits[0].edgeIds, [edgeIdFor(2, 4), edgeIdFor(4, 5)].sort());
  assert.deepEqual(protectedUnits[0].doorIds, ['court-end', 'court-stem']);
  assert.deepEqual(protectedUnits[0].throatNodeIds, ['2']);
});

test('contracts a lollipop loop and its single throat bridge into one protected unit', () => {
  const result = buildCanvasStreetWorkUnits(lollipopFixture());

  assert.equal(result.ok, true);
  const protectedUnits = result.workUnits.filter((unit) => unit.protected);
  assert.equal(protectedUnits.length, 1);
  assert.deepEqual(protectedUnits[0].edgeIds, [
    edgeIdFor(2, 4),
    edgeIdFor(4, 5),
    edgeIdFor(5, 6),
    edgeIdFor(6, 7),
    edgeIdFor(7, 4),
  ].sort());
  assert.deepEqual(protectedUnits[0].doorIds, ['loop-east', 'loop-stem', 'loop-west']);
  assert.deepEqual(protectedUnits[0].throatNodeIds, ['2']);
});

test('covers every eligible road edge exactly once across atomic work units', () => {
  const fixture = lollipopFixture();
  const result = buildCanvasStreetWorkUnits(fixture);
  const expected = [
    edgeIdFor(1, 2),
    edgeIdFor(2, 3),
    edgeIdFor(2, 4),
    edgeIdFor(4, 5),
    edgeIdFor(5, 6),
    edgeIdFor(6, 7),
    edgeIdFor(7, 4),
  ].sort();

  assert.equal(result.ok, true);
  assert.deepEqual(allCoveredEdgeIds(result), expected);
  assert.equal(new Set(allCoveredEdgeIds(result)).size, expected.length);
});

test('is deterministic when OSM elements, way direction, and doors arrive in another order', () => {
  const fixture = lollipopFixture();
  const reordered = {
    ...fixture,
    doors: [...fixture.doors].reverse(),
    roadNetwork: {
      elements: [...fixture.roadNetwork.elements].reverse().map((element) => (
        element.type === 'way' ? { ...element, nodes: [...element.nodes].reverse() } : element
      )),
    },
  };

  assert.deepEqual(buildCanvasStreetWorkUnits(reordered), buildCanvasStreetWorkUnits(fixture));
});

test('returns typed blocking results for missing and malformed road data', () => {
  const fixture = degreeOneFixture();
  const missing = buildCanvasStreetWorkUnits({ ...fixture, roadNetwork: { elements: [] } });
  const malformed = buildCanvasStreetWorkUnits({
    ...fixture,
    roadNetwork: {
      elements: [
        node(1, 35, -82),
        way(100, [1, 999], 'Broken Street'),
      ],
    },
  });

  assert.deepEqual(
    { ok: missing.ok, status: missing.status, deployable: missing.deployable, code: missing.code },
    { ok: false, status: 'blocked', deployable: false, code: 'ROAD_NETWORK_REQUIRED' },
  );
  assert.deepEqual(
    { ok: malformed.ok, status: malformed.status, deployable: malformed.deployable, code: malformed.code },
    { ok: false, status: 'blocked', deployable: false, code: 'MALFORMED_ROAD_NETWORK' },
  );
});

test('blocks a spatial-only door snap that is materially ambiguous across distinct work units', () => {
  const result = buildCanvasStreetWorkUnits(parallelRoadFixture());

  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.deployable, false);
  assert.equal(result.code, 'AMBIGUOUS_DOOR_SNAPS');
  assert.deepEqual(result.details.ambiguousDoorIds, ['between-roads']);
  assert.equal(result.details.ambiguousSnaps.length, 1);
  assert.notEqual(
    result.details.ambiguousSnaps[0].nearest.workUnitId,
    result.details.ambiguousSnaps[0].competing.workUnitId,
  );
  assert.equal(result.details.ambiguousSnaps[0].distanceGapMeters, 0);
  assert.equal(result.details.ambiguousSnaps[0].distanceRatio, 1);
  assert.deepEqual(result.details.thresholds, {
    maxSnapDistanceMeters: 100,
    roadSnapAmbiguityMeters: 12,
    roadSnapAmbiguityRatio: 1.5,
  });
});

test('uses a unique matched street name to resolve otherwise ambiguous road proximity', () => {
  const result = buildCanvasStreetWorkUnits(parallelRoadFixture({ streetName: 'North St' }));

  assert.equal(result.ok, true);
  const snap = result.doorSnaps.find((candidate) => candidate.doorId === 'between-roads');
  const selectedUnit = result.workUnits.find((unit) => unit.id === snap.workUnitId);
  assert.deepEqual(selectedUnit.streetNames, ['North Street']);
});

test('applies finite tunable ambiguity thresholds and rejects invalid threshold values', () => {
  const fixture = parallelRoadFixture({ doorLatitude: 35.00009 });
  const defaultResult = buildCanvasStreetWorkUnits(fixture);
  const strictGapResult = buildCanvasStreetWorkUnits({ ...fixture, roadSnapAmbiguityMeters: 1 });
  const invalidResult = buildCanvasStreetWorkUnits({ ...fixture, roadSnapAmbiguityRatio: Number.POSITIVE_INFINITY });

  assert.equal(defaultResult.code, 'AMBIGUOUS_DOOR_SNAPS');
  assert.equal(strictGapResult.ok, true);
  assert.deepEqual(
    { ok: invalidResult.ok, status: invalidResult.status, code: invalidResult.code },
    { ok: false, status: 'blocked', code: 'INVALID_TOPOLOGY_OPTIONS' },
  );
});

test('ambiguous snap diagnostics are deterministic under reordered OSM input', () => {
  const fixture = parallelRoadFixture();
  const reordered = {
    ...fixture,
    roadNetwork: {
      elements: [...fixture.roadNetwork.elements].reverse().map((element) => (
        element.type === 'way' ? { ...element, nodes: [...element.nodes].reverse() } : element
      )),
    },
  };

  assert.deepEqual(buildCanvasStreetWorkUnits(reordered), buildCanvasStreetWorkUnits(fixture));
});

test('blocks a bow-tie Canvas boundary with a typed self-intersection result', () => {
  const result = buildCanvasStreetWorkUnits({
    ...degreeOneFixture(),
    polygon: [
      { lat: 34.999, lng: -82.011 },
      { lat: 35.011, lng: -81.989 },
      { lat: 34.999, lng: -81.989 },
      { lat: 35.011, lng: -82.011 },
    ],
  });

  assert.deepEqual(
    { ok: result.ok, status: result.status, deployable: result.deployable, code: result.code },
    { ok: false, status: 'blocked', deployable: false, code: 'SELF_INTERSECTING_POLYGON' },
  );
});
