import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from 'vite';

let vite;
let buildOptimizedSplitPlan;
let buildSplitRouteRecords;
let splitRouteCode;

before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  ({
    buildOptimizedSplitPlan,
    buildSplitRouteRecords,
    splitRouteCode,
  } = await vite.ssrLoadModule('/src/components/routes/splitRouteUtils.jsx'));
});

after(async () => {
  await vite?.close();
});

function property(index, overrides = {}) {
  const subdivisionIndex = Math.floor(index / 24);
  const streetIndex = Math.floor(index / 6);
  return {
    id: `home-${index}`,
    address_hash: `home-${index}`,
    street_name: `Street ${streetIndex}`,
    house_number: 100 + index,
    subdivision_name: `Neighborhood ${subdivisionIndex}`,
    city: 'Charlotte',
    state: 'NC',
    zip_code: '28201',
    lat: 35.2 + subdivisionIndex * 0.02 + (index % 6) * 0.0003,
    lng: -80.9 + streetIndex * 0.002 + (index % 6) * 0.0002,
    effective_status: 'ELIGIBLE',
    ...overrides,
  };
}

function savedRoute(properties, overrides = {}) {
  return {
    id: 'source-route',
    name: 'Charlotte Precision Route 1',
    route_mode: 'precision',
    status: 'ACTIVE',
    manager_id: 'manager-1',
    property_hashes: properties.map((home) => home.address_hash),
    allProperties: properties,
    properties,
    metrics: { distance: 99, house_count: properties.length, score: 87 },
    ...overrides,
  };
}

function flattenedHashes(plan) {
  return plan.routes.flatMap((route) => route.propertyHashes);
}

test('186 homes with a maximum of 25 become eight balanced routes', () => {
  const homes = Array.from({ length: 186 }, (_, index) => property(index));
  const plan = buildOptimizedSplitPlan({
    route: savedRoute(homes),
    sizingMode: 'max_homes',
    value: 25,
  });

  assert.equal(plan.routeCount, 8);
  assert.deepEqual(
    plan.routes.map((route) => route.houseCount).sort((left, right) => left - right),
    [23, 23, 23, 23, 23, 23, 24, 24],
  );
  assert.ok(plan.routes.every((route) => route.houseCount <= 25));
  assert.deepEqual(flattenedHashes(plan).sort(), homes.map((home) => home.address_hash).sort());
  assert.equal(new Set(flattenedHashes(plan)).size, homes.length);
});

test('route-count mode creates the exact requested number with balanced sizes', () => {
  const homes = Array.from({ length: 10 }, (_, index) => property(index));
  const plan = buildOptimizedSplitPlan({
    route: savedRoute(homes),
    sizingMode: 'route_count',
    value: 3,
  });

  assert.equal(plan.routeCount, 3);
  assert.deepEqual(
    plan.routes.map((route) => route.houseCount).sort((left, right) => right - left),
    [4, 3, 3],
  );
});

test('alternating input is regrouped geographically before it is divided', () => {
  const west = Array.from({ length: 6 }, (_, index) => property(index, {
    id: `west-${index}`,
    address_hash: `west-${index}`,
    subdivision_name: 'West Charlotte',
    street_name: 'West Loop',
    lat: 35.2 + index * 0.0002,
    lng: -80.95 + index * 0.0002,
  }));
  const east = Array.from({ length: 6 }, (_, index) => property(index + 20, {
    id: `east-${index}`,
    address_hash: `east-${index}`,
    subdivision_name: 'East Charlotte',
    street_name: 'East Loop',
    lat: 35.2 + index * 0.0002,
    lng: -80.75 + index * 0.0002,
  }));
  const alternating = west.flatMap((home, index) => [home, east[index]]);
  const plan = buildOptimizedSplitPlan({
    route: savedRoute(alternating),
    sizingMode: 'route_count',
    value: 2,
  });

  const subdivisionsByRoute = plan.routes.map((route) => [
    ...new Set(route.stops.map((home) => home.subdivision_name)),
  ]);
  assert.ok(subdivisionsByRoute.every((subdivisions) => subdivisions.length === 1));
  assert.deepEqual(subdivisionsByRoute.flat().sort(), ['East Charlotte', 'West Charlotte']);
});

test('saved terminal members and duplicate street addresses remain exact-once members', () => {
  const statuses = ['ELIGIBLE', 'HARD_NO', 'DO_NOT_KNOCK', 'COOLDOWN', 'ELIGIBLE'];
  const homes = statuses.map((status, index) => property(index, {
    id: `member-${index}`,
    address_hash: `member-${index}`,
    street_name: 'Main Street',
    house_number: index === 4 ? 100 : 100 + index,
    effective_status: status,
    lat: String(35.2 + index * 0.0002),
    lng: String(-80.8 + index * 0.0002),
  }));
  const plan = buildOptimizedSplitPlan({
    route: savedRoute(homes),
    sizingMode: 'route_count',
    value: 2,
  });

  assert.deepEqual(flattenedHashes(plan).sort(), homes.map((home) => home.address_hash).sort());
});

test('child records use route names, real metrics, safe metadata, and pending dispatch state', () => {
  const homes = Array.from({ length: 186 }, (_, index) => property(index));
  const route = savedRoute(homes, {
    metadata: {
      keep_me: 'source context',
      route_bounds: { enabled: true },
      road_geometry: [[35.2, -80.8], [35.3, -80.7]],
      routing: { property_order_fingerprint: 'stale-parent-order' },
    },
  });
  const plan = buildOptimizedSplitPlan({ route, sizingMode: 'max_homes', value: 25 });
  const records = buildSplitRouteRecords({
    route,
    plan,
    managerId: 'manager-1',
    createdAt: '2026-08-05T12:00:00.000Z',
  });

  assert.deepEqual(records.map((record) => record.name), [
    'Charlotte Precision Route 1A',
    'Charlotte Precision Route 1B',
    'Charlotte Precision Route 1C',
    'Charlotte Precision Route 1D',
    'Charlotte Precision Route 1E',
    'Charlotte Precision Route 1F',
    'Charlotte Precision Route 1G',
    'Charlotte Precision Route 1H',
  ]);
  records.forEach((record, index) => {
    assert.equal(record.status, 'PENDING');
    assert.equal(record.assigned_to, null);
    assert.equal(record.assigned_to_name, null);
    assert.equal(record.batch_date, null);
    assert.equal(record.parent_route_id, route.id);
    assert.equal(record.batch_number, index + 1);
    assert.equal(record.batch_total, records.length);
    assert.ok(record.metrics.distance > 0);
    assert.equal(record.metadata.keep_me, 'source context');
    assert.equal(record.metadata.route_bounds, undefined);
    assert.equal(record.metadata.road_geometry, undefined);
    assert.notEqual(record.metadata.routing?.property_order_fingerprint, 'stale-parent-order');
    assert.equal(record.metadata.split_source.created_at, '2026-08-05T12:00:00.000Z');
    assert.doesNotMatch(record.name, /batch|aug|2026/i);
  });
});

test('incomplete route hydration fails closed instead of dropping homes', () => {
  const homes = Array.from({ length: 5 }, (_, index) => property(index));
  const route = savedRoute(homes);
  route.properties = homes.slice(0, 4);
  route.allProperties = homes.slice(0, 4);

  assert.throws(
    () => buildOptimizedSplitPlan({ route, sizingMode: 'route_count', value: 2 }),
    /1 of 5 route homes are not loaded/,
  );
});

test('route codes stay intuitive beyond twenty-six routes', () => {
  assert.equal(splitRouteCode(0, 26), 'A');
  assert.equal(splitRouteCode(25, 26), 'Z');
  assert.equal(splitRouteCode(0, 27), '01');
  assert.equal(splitRouteCode(26, 27), '27');
});
