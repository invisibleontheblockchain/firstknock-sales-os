import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

let vite;
let createRouteRoadContext;
let generateOptimizedRoutes;

before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  ({ createRouteRoadContext } = await vite.ssrLoadModule('/src/components/logic/routeRoadContext.js'));
  ({ generateOptimizedRoutes } = await vite.ssrLoadModule('/src/components/logic/routeOptimizer.jsx'));
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

/**
 * An arterial with cul-de-sac courts hanging off it. Each court is reachable
 * only through its own bridge edge, so a rep who enters one must finish it.
 */
function culDeSacNeighborhood(courtCount, doorCount) {
  const elements = [];
  for (let index = 0; index <= courtCount; index += 1) {
    elements.push(node(`arterial-${index}`, 35, -82 + index * 0.002));
  }
  for (let index = 0; index < courtCount; index += 1) {
    elements.push(way(
      `arterial-way-${index}`,
      [`arterial-${index}`, `arterial-${index + 1}`],
      'Test Arterial',
      'secondary',
    ));
    elements.push(node(`court-end-${index}`, 35.004, -82 + index * 0.002));
    elements.push(way(
      `court-way-${index}`,
      [`arterial-${index}`, `court-end-${index}`],
      `Court ${index}`,
    ));
  }

  const doors = Array.from({ length: doorCount }, (_, index) => {
    const court = index % courtCount;
    const depth = Math.floor(index / courtCount);
    return {
      id: `door-${index}`,
      address_hash: `door-${index}`,
      street_name: `Court ${court}`,
      house_number: index + 1,
      city: 'Testville',
      state: 'AZ',
      zip_code: '85001',
      lat: 35.0005 + (depth % 40) * 0.00008,
      lng: -82 + court * 0.002,
      effective_status: 'ELIGIBLE',
      price: 350000,
    };
  });

  return { doors, roadNetwork: { elements } };
}

/**
 * Two single-entrance pockets, each holding several differently named streets,
 * interleaved in space so that ordering by distance alone bounces between them.
 * Street names and subdivision labels cannot hold these together — only the
 * road graph can, which is what makes the atomicity assertion non-vacuous.
 */
function interleavedPocketNeighborhood(streetsPerPocket, doorCount) {
  const elements = [
    node('art-0', 35, -82),
    node('art-1', 35, -81.998),
    node('art-2', 35, -81.996),
    way('art-a', ['art-0', 'art-1'], 'Test Arterial', 'secondary'),
    way('art-b', ['art-1', 'art-2'], 'Test Arterial', 'secondary'),
  ];
  const pockets = [
    { id: 'A', entrance: 'art-0', spineLat: 35.004, lngBase: -82, lngStep: 0.004 },
    { id: 'B', entrance: 'art-1', spineLat: 35.008, lngBase: -81.998, lngStep: 0.004 },
  ];
  const streetNames = [];
  pockets.forEach((pocket) => {
    // One bridge edge from the arterial into the pocket spine.
    elements.push(node(`${pocket.id}-spine-0`, pocket.spineLat, pocket.lngBase));
    elements.push(way(
      `${pocket.id}-gate`,
      [pocket.entrance, `${pocket.id}-spine-0`],
      `${pocket.id} Gateway`,
    ));
    for (let index = 0; index < streetsPerPocket; index += 1) {
      const lng = pocket.lngBase + index * pocket.lngStep;
      elements.push(node(`${pocket.id}-spine-${index + 1}`, pocket.spineLat, lng + pocket.lngStep));
      elements.push(way(
        `${pocket.id}-spine-way-${index}`,
        [`${pocket.id}-spine-${index}`, `${pocket.id}-spine-${index + 1}`],
        `${pocket.id} Spine`,
      ));
      elements.push(node(`${pocket.id}-branch-${index}`, pocket.spineLat - 0.002, lng));
      elements.push(way(
        `${pocket.id}-branch-way-${index}`,
        [`${pocket.id}-spine-${index}`, `${pocket.id}-branch-${index}`],
        `${pocket.id} Street ${index}`,
      ));
      streetNames.push({
        pocket: pocket.id,
        name: `${pocket.id} Street ${index}`,
        lng,
        spineLat: pocket.spineLat,
      });
    }
  });

  const doors = Array.from({ length: doorCount }, (_, index) => {
    const street = streetNames[index % streetNames.length];
    const depth = Math.floor(index / streetNames.length);
    return {
      id: `door-${index}`,
      address_hash: `door-${index}`,
      street_name: street.name,
      house_number: index + 1,
      city: 'Testville',
      state: 'AZ',
      zip_code: '85001',
      lat: street.spineLat - 0.0002 - (depth % 20) * 0.00008,
      lng: street.lng,
      effective_status: 'ELIGIBLE',
      price: 350000,
    };
  });

  return { doors, roadNetwork: { elements } };
}

/** Every access unit must occupy one unbroken run of the route. */
function reenteredUnits(properties, context) {
  const runs = properties
    .map(property => context.accessGroupKey(property))
    .filter((key, index, keys) => index === 0 || key !== keys[index - 1]);
  const seen = new Set();
  const reentered = new Set();
  runs.forEach((key) => {
    if (seen.has(key)) reentered.add(key);
    seen.add(key);
  });
  return [...reentered];
}

test('1,000 doors keep road-derived pockets and enter each unit exactly once', async () => {
  const { doors, roadNetwork } = interleavedPocketNeighborhood(6, 1000);
  const context = await createRouteRoadContext(doors, {
    fetchRoadNetwork: async () => roadNetwork,
  });

  assert.equal(context.roadAware, true);
  assert.equal(context.mode, 'cost-only', '1,000 doors ration door-level routing');
  assert.ok(
    context.diagnostics.accessTopology.protectedAccessGroupCount >= 2,
    'dead-end detection must run above the door cap, not only below it',
  );
  const pocketKeys = new Set(doors.map(door => context.accessGroupKey(door)));
  assert.ok(pocketKeys.size >= 2, 'each court must resolve to its own access pocket');

  const [route] = generateOptimizedRoutes(doors, 2000, null, [], { routingContext: context });
  assert.equal(route.properties.length, doors.length);
  assert.deepEqual(
    reenteredUnits(route.properties, context),
    [],
    'a protected unit was left and re-entered later',
  );
});

test('a dead-end unit is priced as out-and-back, not as a through street', async () => {
  const { doors, roadNetwork } = culDeSacNeighborhood(3, 60);
  const context = await createRouteRoadContext(doors, {
    fetchRoadNetwork: async () => roadNetwork,
  });

  assert.equal(context.mode, 'full');
  const [route] = generateOptimizedRoutes(doors, 100, null, [], { routingContext: context });
  assert.deepEqual(reenteredUnits(route.properties, context), []);
});