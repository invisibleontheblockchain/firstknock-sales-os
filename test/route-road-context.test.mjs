import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

let vite;
let buildPersistedRoadRoutingMetadata;
let buildRoadRouteGeometry;
let calculateRoadAwareRouteMiles;
let createRouteRoadContext;
let generateOptimizedRoutes;
let routePropertyOrderFingerprint;

before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  ({
    buildPersistedRoadRoutingMetadata,
    buildRoadRouteGeometry,
    calculateRoadAwareRouteMiles,
    createRouteRoadContext,
    routePropertyOrderFingerprint,
  } = await vite.ssrLoadModule('/src/components/logic/routeRoadContext.js'));
  ({
    generateOptimizedRoutes,
  } = await vite.ssrLoadModule('/src/components/logic/routeOptimizer.jsx'));
});

after(async () => {
  await vite?.close();
});

const node = (id, lat, lon, tags = {}) => ({ type: 'node', id, lat, lon, tags });
const way = (id, nodes, name, highway = 'residential') => ({
  type: 'way',
  id,
  nodes,
  tags: { highway, name },
});
const property = (id, streetName, lat, lng, subdivisionName = null) => ({
  id,
  address_hash: id,
  street_name: streetName,
  subdivision_name: subdivisionName,
  city: 'Testville',
  state: 'AZ',
  zip_code: '85001',
  lat,
  lng,
});

function terminalPocketRoadNetwork() {
  return {
    elements: [
      node(1, 35, -82.05),
      node(2, 35, -82.005),
      node(3, 35, -81.995),
      node(4, 35, -81.95),
      node(10, 35.003, -82.005),
      node(11, 35.006, -82.005, { noexit: 'yes' }),
      node(20, 35.003, -81.995),
      node(21, 35.006, -81.995, { noexit: 'yes' }),
      way(100, [1, 2, 3, 4], 'Main Road', 'primary'),
      way(200, [2, 10], 'Gateway Way'),
      way(201, [10, 11], 'Interior Loop'),
      way(300, [3, 20, 21], 'Separate Court'),
    ],
  };
}

function disconnectedRoadNetwork() {
  return {
    elements: [
      node(500, 35, -82),
      node(501, 35, -81.999),
      node(600, 35, -81.99),
      node(601, 35, -81.989),
      way(5000, [500, 501], 'West Street'),
      way(6000, [600, 601], 'East Street'),
    ],
  };
}

function largeCostOnlyFixture() {
  const doors = Array.from({ length: 501 }, (_, index) => {
    const onOak = index < 251;
    const offset = (index % 200) * 0.00002;
    return {
      ...property(
      `large-${index}`,
      onOak ? (index % 2 ? 'Oak Drive' : 'Oak Dr') : 'Pine Lane',
      onOak ? 35 : 35.004,
      -82 + offset,
      onOak ? 'Shared Oaks' : 'Pine Place',
      ),
      house_number: index + 1,
    };
  });
  const roadNetwork = {
    elements: [
      node(1000, 35, -82),
      node(1001, 35, -81.995),
      node(1002, 35.004, -81.995),
      node(1003, 35.004, -82),
      way(100, [1000, 1001], 'Oak Drive'),
      way(101, [1001, 1002], 'Connector Road'),
      way(102, [1002, 1003], 'Pine Lane'),
    ],
  };
  return { doors, roadNetwork };
}

function manyBlockCostOnlyFixture(blockCount = 41) {
  const elements = [];
  for (let index = 0; index <= blockCount; index += 1) {
    elements.push(node(`chain-node-${index}`, 35, -82 + index * 0.0001));
  }
  for (let index = 0; index < blockCount; index += 1) {
    elements.push(way(
      `chain-way-${index}`,
      [`chain-node-${index}`, `chain-node-${index + 1}`],
      `Block ${index} Street`,
    ));
  }
  const doors = Array.from({ length: 501 }, (_, index) => {
    const block = index % blockCount;
    return {
      ...property(
        `chain-door-${index}`,
        `Block ${block} St`,
        35,
        -82 + (block + 0.5) * 0.0001,
      ),
      house_number: index + 1,
      effective_status: 'ELIGIBLE',
      price: 350000,
    };
  });
  return { doors, roadNetwork: { elements } };
}

test('derives distinct terminal access pockets from real road topology', async () => {
  const doors = [
    property('A-entry', 'Gateway Way', 35.002, -82.005),
    property('A-deep', 'Interior Loop', 35.005, -82.005),
    property('B-dead', 'Separate Court', 35.004, -81.995),
  ];
  const context = await createRouteRoadContext(doors, {
    fetchRoadNetwork: async () => terminalPocketRoadNetwork(),
  });

  assert.equal(context.roadAware, true);
  assert.equal(context.source, 'osm-road-network');
  assert.ok(context.accessGroupKey(doors[0]));
  assert.equal(context.accessGroupKey(doors[0]), context.accessGroupKey(doors[1]));
  assert.notEqual(context.accessGroupKey(doors[0]), context.accessGroupKey(doors[2]));
  assert.ok(context.distanceBetween(doors[0], doors[1]) > 0);
  assert.ok(context.diagnostics.accessTopology.protectedAccessGroupCount >= 2);
});

test('full routing fails closed when even one route property cannot snap', async () => {
  const doors = [
    property('near-road', 'Test Street', 35.0005, -82),
    property('far-from-road', 'Remote Lane', 35.02, -82),
  ];
  const context = await createRouteRoadContext(doors, {
    fetchRoadNetwork: async () => ({
      elements: [
        node(700, 35, -82),
        node(701, 35.001, -82),
        way(7000, [700, 701], 'Test Street'),
      ],
    }),
  });

  assert.equal(context.roadAware, false);
  assert.equal(context.diagnostics.reason, 'INCOMPLETE_SNAPPED_ROUTE_PROPERTIES');
  assert.equal(context.diagnostics.snappedPropertyCount, 1);
  assert.equal(context.diagnostics.propertyPointCount, 2);
});

test('keeps provider subdivision continuity when the road service is unavailable', async () => {
  const doors = [
    property('A1', 'Oak Drive', 35, -82, 'Oaks of Testville'),
    property('A2', 'Oak Lane', 35.001, -82, 'Oaks of Testville'),
    property('B1', 'Other Court', 35.0005, -81.999, 'Other Place'),
  ];
  const context = await createRouteRoadContext(doors, {
    fetchRoadNetwork: async () => {
      const error = new Error('offline');
      error.code = 'TEST_OFFLINE';
      throw error;
    },
  });

  assert.equal(context.roadAware, false);
  assert.equal(context.status, 'area-only');
  assert.equal(context.accessGroupKey(doors[0]), context.accessGroupKey(doors[1]));
  assert.notEqual(context.accessGroupKey(doors[0]), context.accessGroupKey(doors[2]));
  assert.equal(context.diagnostics.errorCode, 'TEST_OFFLINE');
});

test('builds auditable road geometry and bounded persisted diagnostics', async () => {
  const doors = [
    property('A-entry', 'Gateway Way', 35.002, -82.005),
    property('A-deep', 'Interior Loop', 35.005, -82.005),
  ];
  const context = await createRouteRoadContext(doors, {
    fetchRoadNetwork: async () => terminalPocketRoadNetwork(),
  });
  const geometry = buildRoadRouteGeometry(doors, context);
  const metadata = buildPersistedRoadRoutingMetadata(context, geometry, doors);

  assert.ok(geometry.length > 2);
  assert.equal(metadata.routing.road_aware, true);
  assert.equal(metadata.routing.engine, 'osm-road-network');
  assert.deepEqual(metadata.road_geometry, geometry);
  assert.equal(
    metadata.routing.property_order_fingerprint,
    routePropertyOrderFingerprint(doors),
  );
  assert.equal(
    metadata.routing.property_order_fingerprint,
    routePropertyOrderFingerprint(doors.map(({ address_hash }) => address_hash)),
  );
  assert.notEqual(
    metadata.routing.property_order_fingerprint,
    routePropertyOrderFingerprint([...doors].reverse()),
  );
  assert.notEqual(
    metadata.routing.property_order_fingerprint,
    routePropertyOrderFingerprint(doors.slice(0, 1)),
  );
  assert.equal('polygon' in metadata.routing, false);
});

test('audits external-bound fallbacks separately without rejecting the full context', async () => {
  const doors = [
    property('A-entry', 'Gateway Way', 35.002, -82.005),
    property('A-deep', 'Interior Loop', 35.005, -82.005),
  ];
  const externalStart = { lat: 35.1, lng: -82.2 };
  const context = await createRouteRoadContext(doors, {
    startLocation: externalStart,
    fetchRoadNetwork: async () => terminalPocketRoadNetwork(),
  });

  assert.equal(context.roadAware, true);
  assert.equal(context.mode, 'full');
  assert.equal(context.status, 'degraded');
  assert.equal(context.diagnostics.validPropertyManifestCount, 2);
  assert.equal(context.diagnostics.roadCostClassification, 'valid-property-manifest');

  assert.ok(
    context.distanceBetween({ ...doors[0] }, { ...doors[1] }) > 0,
    'property clones must still be classified through the valid property manifest',
  );
  const externalLeg = context.routeBetween(externalStart, doors[0]);
  assert.equal(externalLeg.usedFallback, true);
  assert.equal(externalLeg.reason, 'UNSNAPPED_POINT');
  assert.ok(Number.isFinite(externalLeg.distanceMiles));

  assert.equal(context.diagnostics.roadCostQueryCount, 2);
  assert.equal(context.diagnostics.roadCostFallbackCount, 1);
  assert.equal(context.diagnostics.doorToDoorRoadCostQueryCount, 1);
  assert.equal(context.diagnostics.doorToDoorRoadCostFallbackCount, 0);
  assert.deepEqual(context.diagnostics.doorToDoorRoadCostFallbackReasons, {});
  assert.equal(context.diagnostics.externalBoundRoadCostQueryCount, 1);
  assert.equal(context.diagnostics.externalBoundRoadCostFallbackCount, 1);
  assert.deepEqual(
    context.diagnostics.externalBoundRoadCostFallbackReasons,
    { UNSNAPPED_POINT: 1 },
  );
  assert.deepEqual(context.diagnostics.roadCostFallbackReasons, { UNSNAPPED_POINT: 1 });

  const metadata = buildPersistedRoadRoutingMetadata(context, null, doors);
  assert.equal(metadata.routing.road_cost_query_count, 2);
  assert.equal(metadata.routing.road_cost_fallback_count, 1);
  assert.equal(metadata.routing.door_to_door_road_cost_query_count, 1);
  assert.equal(metadata.routing.door_to_door_road_cost_fallback_count, 0);
  assert.equal(metadata.routing.external_bound_road_cost_query_count, 1);
  assert.equal(metadata.routing.external_bound_road_cost_fallback_count, 1);
});

test('audits disconnected property-to-property fallbacks as door-to-door failures', async () => {
  const doors = [
    property('west-door', 'West Street', 35, -81.9995),
    property('east-door', 'East Street', 35, -81.9895),
  ];
  const context = await createRouteRoadContext(doors, {
    fetchRoadNetwork: async () => disconnectedRoadNetwork(),
  });

  const route = context.routeBetween({ ...doors[0] }, { ...doors[1] });
  assert.equal(route.usedFallback, true);
  assert.equal(route.reason, 'DISCONNECTED_ROAD_COMPONENTS');
  assert.equal(context.diagnostics.roadCostQueryCount, 1);
  assert.equal(context.diagnostics.roadCostFallbackCount, 1);
  assert.equal(context.diagnostics.doorToDoorRoadCostQueryCount, 1);
  assert.equal(context.diagnostics.doorToDoorRoadCostFallbackCount, 1);
  assert.deepEqual(
    context.diagnostics.doorToDoorRoadCostFallbackReasons,
    { DISCONNECTED_ROAD_COMPONENTS: 1 },
  );
  assert.equal(context.diagnostics.externalBoundRoadCostQueryCount, 0);
  assert.equal(context.diagnostics.externalBoundRoadCostFallbackCount, 0);
  assert.deepEqual(context.diagnostics.externalBoundRoadCostFallbackReasons, {});

  const metadata = buildPersistedRoadRoutingMetadata(context, null, doors);
  assert.equal(metadata.routing.road_cost_query_count, 1);
  assert.equal(metadata.routing.road_cost_fallback_count, 1);
  assert.equal(metadata.routing.door_to_door_road_cost_query_count, 1);
  assert.equal(metadata.routing.door_to_door_road_cost_fallback_count, 1);
  assert.equal(metadata.routing.external_bound_road_cost_query_count, 0);
  assert.equal(metadata.routing.external_bound_road_cost_fallback_count, 0);
});

test('501-5000 doors use bounded block-level road costs without eager door routing', async () => {
  const { doors, roadNetwork } = largeCostOnlyFixture();
  const context = await createRouteRoadContext(doors, {
    fetchRoadNetwork: async () => roadNetwork,
  });

  assert.equal(context.roadAware, true);
  assert.equal(context.costOnly, true);
  assert.equal(context.mode, 'cost-only');
  assert.equal(context.source, 'osm-road-network-cost-only');
  assert.equal(context.diagnostics.requestedMode, 'cost-only');
  assert.equal(context.diagnostics.originalPointCount, 501);
  assert.equal(context.diagnostics.representativeBlockCount, 2);
  assert.equal(context.diagnostics.representativePointCount, 2);
  assert.equal(
    context.diagnostics.suppliedPointCount,
    2,
    'only one representative per canonical street block should be pre-snapped',
  );
  assert.equal(context.streetSegmentKey(doors[0]), context.streetSegmentKey(doors[1]));
  assert.notEqual(context.streetSegmentKey(doors[0]), context.streetSegmentKey(doors.at(-1)));
  assert.equal(context.accessGroupKey(doors[0]), context.accessGroupKey(doors[1]));
  assert.notEqual(context.accessGroupKey(doors[0]), context.accessGroupKey(doors.at(-1)));
  assert.ok(context.distanceBetween(doors[0], doors.at(-1)) > 0);
  assert.equal(context.diagnostics.roadCostQueryCount, 1);
  assert.equal(context.diagnostics.roadCostFallbackCount, 0);
  assert.equal(context.diagnostics.blockToBlockRoadCostQueryCount, 1);
  assert.equal(context.diagnostics.blockToBlockRoadCostFallbackCount, 0);
  assert.equal(context.diagnostics.externalBoundRoadCostQueryCount, 0);
  assert.equal(context.diagnostics.externalBoundRoadCostFallbackCount, 0);
  assert.equal(context.routeBetween, undefined);
  assert.equal(buildRoadRouteGeometry(doors, context), null);
  assert.equal(calculateRoadAwareRouteMiles(doors, context), null);

  const routes = generateOptimizedRoutes(
    doors.map(door => ({
      ...door,
      effective_status: 'ELIGIBLE',
      price: 350000,
    })),
    10000,
    null,
    [],
    { routingContext: context },
  );
  const generatedDoors = routes.flatMap(route => route.properties);
  assert.equal(generatedDoors.length, doors.length);
  assert.equal(new Set(generatedDoors.map(door => door.id)).size, doors.length);
  assert.ok(
    context.diagnostics.roadCostQueryCount < 30,
    'road queries should scale with street blocks, not 501 doors',
  );

  const metadata = buildPersistedRoadRoutingMetadata(context, null, generatedDoors);
  assert.equal(metadata.routing.mode, 'cost-only');
  assert.equal(metadata.routing.cost_only, true);
  assert.equal(metadata.routing.distance_estimate, 'aerial-door-path');
  assert.equal(metadata.routing.input_point_count, 501);
  assert.equal(metadata.routing.representative_block_count, 2);
  assert.equal(metadata.routing.representative_point_count, 2);
  assert.equal(metadata.routing.road_cost_fallback_count, 0);
  assert.equal(metadata.routing.block_to_block_road_cost_query_count > 0, true);
  assert.equal(metadata.routing.block_to_block_road_cost_fallback_count, 0);
  assert.equal('road_geometry' in metadata, false);
});

test('large-route safety limits and road fallbacks are explicit and auditable', async () => {
  const doors = Array.from({ length: 501 }, (_, index) => property(
    `unique-${index}`,
    `Unique Street ${index}`,
    35 + index * 0.000001,
    -82,
  ));
  let fetchCalls = 0;
  const limited = await createRouteRoadContext(doors, {
    maxCostOnlyBlocks: 300,
    fetchRoadNetwork: async () => {
      fetchCalls += 1;
      return terminalPocketRoadNetwork();
    },
  });

  assert.equal(limited.roadAware, false);
  assert.equal(limited.diagnostics.requestedMode, 'cost-only');
  assert.equal(limited.diagnostics.reason, 'COST_ONLY_BLOCK_LIMIT_EXCEEDED');
  assert.equal(limited.diagnostics.representativeBlockCount, 501);
  assert.equal(fetchCalls, 0, 'an unsafe block count must fail before a road request');

  const { doors: routableDoors, roadNetwork } = largeCostOnlyFixture();
  const partialCoverage = await createRouteRoadContext(routableDoors, {
    fetchRoadNetwork: async () => ({
      elements: roadNetwork.elements.filter((element) => (
        [1000, 1001, 100].includes(element.id)
      )),
    }),
  });
  assert.equal(partialCoverage.roadAware, false);
  assert.equal(
    partialCoverage.diagnostics.reason,
    'INCOMPLETE_SNAPPED_COST_BLOCKS',
  );
  assert.equal(partialCoverage.diagnostics.snappedRepresentativeCount, 1);
  assert.equal(partialCoverage.diagnostics.representativePointCount, 2);

  const disconnected = await createRouteRoadContext(routableDoors, {
    fetchRoadNetwork: async () => ({
      elements: roadNetwork.elements.filter(element => element.id !== 101),
    }),
  });
  assert.ok(disconnected.distanceBetween(routableDoors[0], routableDoors.at(-1)) > 0);
  assert.equal(disconnected.diagnostics.roadCostFallbackCount, 1);
  assert.equal(disconnected.diagnostics.blockToBlockRoadCostFallbackCount, 1);
  assert.equal(disconnected.diagnostics.externalBoundRoadCostFallbackCount, 0);
  assert.deepEqual(
    disconnected.diagnostics.roadCostFallbackReasons,
    { DISCONNECTED_ROAD_COMPONENTS: 1 },
  );
  assert.deepEqual(
    disconnected.diagnostics.blockToBlockRoadCostFallbackReasons,
    { DISCONNECTED_ROAD_COMPONENTS: 1 },
  );
  const metadata = buildPersistedRoadRoutingMetadata(disconnected);
  assert.equal(metadata.routing.road_cost_fallback_count, 1);
  assert.equal(metadata.routing.block_to_block_road_cost_fallback_count, 1);
});

test('cost-only refinement stays bounded as the number of street blocks grows', async () => {
  const { doors, roadNetwork } = manyBlockCostOnlyFixture();
  const context = await createRouteRoadContext(doors, {
    fetchRoadNetwork: async () => roadNetwork,
  });
  const routes = generateOptimizedRoutes(
    doors,
    10000,
    null,
    [],
    { routingContext: context },
  );

  assert.equal(context.diagnostics.representativeBlockCount, 41);
  assert.equal(routes.flatMap(route => route.properties).length, doors.length);
  assert.ok(
    context.diagnostics.roadCostQueryCount < 10000,
    `road-cost lookup count was not bounded: ${context.diagnostics.roadCostQueryCount}`,
  );
  assert.ok(context.diagnostics.dijkstraRunCount <= 41);
});
