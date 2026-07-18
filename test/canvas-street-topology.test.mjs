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
const way = (id, nodes, name, highway = 'residential') => ({
  type: 'way',
  id,
  nodes,
  tags: { highway, name },
});
const candidate = (id, lat, lng, streetName) => ({ id, lat, lng, streetName });

function degreeOneFixture({ includeCandidates = true } = {}) {
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
    candidates: includeCandidates ? [
      candidate('main-left', 35.00005, -82.006, 'Main St'),
      candidate('main-right', 35.00005, -81.994, 'Main Street'),
      candidate('court-stem', 35.002, -81.99995, 'Cold Ct'),
      candidate('court-end', 35.006, -82.00005, 'Cold Court'),
    ] : undefined,
    maxSnapDistanceMeters: 100,
  };
}

function lollipopFixture({ includeCandidates = true } = {}) {
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
    candidates: includeCandidates ? [
      candidate('main-left', 35.00005, -82.006, 'Main Street'),
      candidate('main-right', 35.00005, -81.994, 'Main St'),
      candidate('loop-stem', 35.002, -81.99995, 'Loop Court'),
      candidate('loop-west', 35.006, -82.0009, 'Loop Ct'),
      candidate('loop-east', 35.006, -81.9991, 'Loop Court'),
    ] : undefined,
    maxSnapDistanceMeters: 100,
  };
}

function parallelRoadFixture({ candidateLatitude = 35.0001, streetName = '' } = {}) {
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
    candidates: [candidate('between-roads', candidateLatitude, -82, streetName)],
    maxSnapDistanceMeters: 100,
  };
}

function allCoveredEdgeIds(result) {
  return result.workUnits.flatMap((unit) => unit.edgeIds).sort();
}

test('builds deterministic road-only work units with measurable street workload', () => {
  const result = buildCanvasStreetWorkUnits(degreeOneFixture({ includeCandidates: false }));

  assert.equal(result.ok, true);
  assert.deepEqual(result.candidateSnaps, []);
  assert.ok(result.workUnits.every((unit) => unit.streetLengthMeters > 0));
  assert.ok(result.workUnits.every((unit) => unit.classWeightedLengthMeters > 0));
  assert.equal(result.diagnostics.totalStreetLengthMeters > 0, true);
});

test('contracts a degree-1 cul-de-sac from terminal to throat into one protected unit', () => {
  const result = buildCanvasStreetWorkUnits(degreeOneFixture());

  assert.equal(result.ok, true);
  const protectedUnits = result.workUnits.filter((unit) => unit.protected);
  assert.equal(protectedUnits.length, 1);
  assert.equal(protectedUnits[0].kind, 'terminal_to_throat_branch');
  assert.deepEqual(protectedUnits[0].edgeIds, [edgeIdFor(2, 4), edgeIdFor(4, 5)].sort());
  assert.deepEqual(protectedUnits[0].candidateIds, ['court-end', 'court-stem']);
  assert.deepEqual(protectedUnits[0].throatNodeIds, ['2']);
});

test('does not mistake a real cul-de-sac terminal about 20m inside the boundary for an exit', () => {
  const fixture = degreeOneFixture({ includeCandidates: false });
  fixture.polygon = [
    { lat: 34.999, lng: -82.011 },
    { lat: 34.999, lng: -81.989 },
    { lat: 35.00818, lng: -81.989 },
    { lat: 35.00818, lng: -82.011 },
  ];
  const result = buildCanvasStreetWorkUnits(fixture);
  const protectedUnit = result.workUnits.find((unit) => unit.protected);

  assert.equal(result.ok, true);
  assert.ok(protectedUnit);
  assert.deepEqual(protectedUnit.edgeIds, [edgeIdFor(2, 4), edgeIdFor(4, 5)].sort());
  assert.deepEqual(protectedUnit.terminalNodeIds, ['5']);
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
  assert.deepEqual(protectedUnits[0].candidateIds, ['loop-east', 'loop-stem', 'loop-west']);
  assert.deepEqual(protectedUnits[0].throatNodeIds, ['2']);
});

test('covers every eligible road edge exactly once across atomic work units', () => {
  const result = buildCanvasStreetWorkUnits(lollipopFixture({ includeCandidates: false }));
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

test('is deterministic when OSM elements, way direction, and estimates arrive in another order', () => {
  const fixture = lollipopFixture();
  const reordered = {
    ...fixture,
    candidates: [...fixture.candidates].reverse(),
    roadNetwork: {
      elements: [...fixture.roadNetwork.elements].reverse().map((element) => (
        element.type === 'way' ? { ...element, nodes: [...element.nodes].reverse() } : element
      )),
    },
  };

  assert.deepEqual(buildCanvasStreetWorkUnits(reordered), buildCanvasStreetWorkUnits(fixture));
});

test('downweights arterials so they do not dominate residential knocking workload', () => {
  const fixture = degreeOneFixture({ includeCandidates: false });
  fixture.roadNetwork.elements = fixture.roadNetwork.elements.map((element) => (
    element.type === 'way' && element.id === 100
      ? { ...element, tags: { ...element.tags, highway: 'primary' } }
      : element
  ));
  const result = buildCanvasStreetWorkUnits(fixture);
  const arterial = result.workUnits.find((unit) => unit.streetNames.includes('Main Street'));
  const residential = result.workUnits.find((unit) => unit.streetNames.includes('Cold Court'));

  assert.equal(result.ok, true);
  assert.ok(arterial.classWeightedLengthMeters < arterial.streetLengthMeters * 0.06);
  assert.equal(residential.classWeightedLengthMeters, residential.streetLengthMeters);
});

test('returns typed blocking results for missing and malformed road data without requiring doors', () => {
  const fixture = degreeOneFixture({ includeCandidates: false });
  const missing = buildCanvasStreetWorkUnits({ ...fixture, roadNetwork: { elements: [] } });
  const malformed = buildCanvasStreetWorkUnits({
    ...fixture,
    roadNetwork: { elements: [node(1, 35, -82), way(100, [1, 999], 'Broken Street')] },
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

test('returns typed ambiguity for optional estimates across distinct work units', () => {
  const result = buildCanvasStreetWorkUnits(parallelRoadFixture());

  assert.equal(result.ok, false);
  assert.equal(result.code, 'AMBIGUOUS_CANDIDATE_SNAPS');
  assert.deepEqual(result.details.ambiguousCandidateIds, ['between-roads']);
  assert.notEqual(result.details.ambiguousSnaps[0].nearest.workUnitId, result.details.ambiguousSnaps[0].competing.workUnitId);
  assert.equal(result.details.ambiguousSnaps[0].distanceGapMeters, 0);
});

test('uses a unique matched street name to resolve otherwise ambiguous estimate proximity', () => {
  const result = buildCanvasStreetWorkUnits(parallelRoadFixture({ streetName: 'North St' }));

  assert.equal(result.ok, true);
  const snap = result.candidateSnaps.find((item) => item.candidateId === 'between-roads');
  const selectedUnit = result.workUnits.find((unit) => unit.id === snap.workUnitId);
  assert.deepEqual(selectedUnit.streetNames, ['North Street']);
});

test('applies finite tunable ambiguity thresholds and rejects invalid threshold values', () => {
  const fixture = parallelRoadFixture({ candidateLatitude: 35.00009 });
  const defaultResult = buildCanvasStreetWorkUnits(fixture);
  const strictGapResult = buildCanvasStreetWorkUnits({ ...fixture, roadSnapAmbiguityMeters: 1 });
  const invalidResult = buildCanvasStreetWorkUnits({ ...fixture, roadSnapAmbiguityRatio: Number.POSITIVE_INFINITY });

  assert.equal(defaultResult.code, 'AMBIGUOUS_CANDIDATE_SNAPS');
  assert.equal(strictGapResult.ok, true);
  assert.deepEqual(
    { ok: invalidResult.ok, status: invalidResult.status, code: invalidResult.code },
    { ok: false, status: 'blocked', code: 'INVALID_TOPOLOGY_OPTIONS' },
  );
});

test('clips a very long crossing edge before length, workload, and work-unit creation', () => {
  const narrowPolygon = [
    { lat: 35, lng: -82 },
    { lat: 35, lng: -81.998 },
    { lat: 35.002, lng: -81.998 },
    { lat: 35.002, lng: -82 },
  ];
  const result = buildCanvasStreetWorkUnits({
    polygon: narrowPolygon,
    roadNetwork: {
      elements: [
        node(9001, 35.001, -82.1),
        node(9002, 35.001, -81.9),
        way(9003, [9001, 9002], 'Crossing Street'),
      ],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.roadEdgeCount, 1);
  assert.equal(result.diagnostics.clippedFragmentCount, 1);
  assert.ok(result.diagnostics.totalStreetLengthMeters > 175);
  assert.ok(result.diagnostics.totalStreetLengthMeters < 190);
  const segment = result.workUnits[0].segments[0];
  assert.ok(segment.start.lng >= -82.0000000001 && segment.start.lng <= -81.9979999999);
  assert.ok(segment.end.lng >= -82.0000000001 && segment.end.lng <= -81.9979999999);
  assert.ok(segment.start.id.startsWith('clip-node:'));
  assert.ok(segment.end.id.startsWith('clip-node:'));
});

test('splits one source edge into every in-boundary interval of a concave polygon', () => {
  const concavePolygon = [
    { lat: 35, lng: -82 },
    { lat: 35, lng: -81.996 },
    { lat: 35.004, lng: -81.996 },
    { lat: 35.004, lng: -81.997 },
    { lat: 35.001, lng: -81.997 },
    { lat: 35.001, lng: -81.999 },
    { lat: 35.004, lng: -81.999 },
    { lat: 35.004, lng: -82 },
  ];
  const result = buildCanvasStreetWorkUnits({
    polygon: concavePolygon,
    roadNetwork: {
      elements: [
        node(9101, 35.002, -82.001),
        node(9102, 35.002, -81.995),
        way(9103, [9101, 9102], 'Concave Crossing'),
      ],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.clippedFragmentCount, 2);
  assert.equal(result.diagnostics.roadEdgeCount, 2);
  assert.equal(result.diagnostics.componentCount, 2);
  const intervals = result.workUnits.flatMap((unit) => unit.segments).map((segment) => [
    Math.min(segment.start.lng, segment.end.lng),
    Math.max(segment.start.lng, segment.end.lng),
  ]).sort((left, right) => left[0] - right[0]);
  assert.deepEqual(intervals.map((interval) => interval.map((value) => Number(value.toFixed(6)))), [
    [-82, -81.999],
    [-81.997, -81.996],
  ]);
  const summedLength = result.workUnits.flatMap((unit) => unit.segments)
    .reduce((sum, segment) => sum + segment.lengthMeters, 0);
  assert.equal(Number(summedLength.toFixed(2)), result.diagnostics.totalStreetLengthMeters);
});

test('retains only the overlapping portion of a boundary-collinear road', () => {
  const narrowPolygon = [
    { lat: 35, lng: -82 },
    { lat: 35, lng: -81.998 },
    { lat: 35.002, lng: -81.998 },
    { lat: 35.002, lng: -82 },
  ];
  const result = buildCanvasStreetWorkUnits({
    polygon: narrowPolygon,
    roadNetwork: {
      elements: [
        node(9201, 35, -82.1),
        node(9202, 35, -81.9),
        way(9203, [9201, 9202], 'Boundary Road'),
      ],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.clippedFragmentCount, 1);
  assert.ok(result.diagnostics.totalStreetLengthMeters > 175);
  assert.ok(result.diagnostics.totalStreetLengthMeters < 190);
});

test('blocks a bow-tie Canvas boundary with a typed self-intersection result', () => {
  const result = buildCanvasStreetWorkUnits({
    ...degreeOneFixture({ includeCandidates: false }),
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
