import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { optimizeImportedRoute, importOptimizationMessage } from '../src/components/import/optimizeImportedRoute.js';
import { savePropertyImport } from '../src/components/import/savePropertyImport.js';
import { calculateRouteDistanceMiles } from '../base44/shared/routeBounds.js';

const user = { id: 'manager', email: 'manager@example.com', home_base: { lat: 28, lng: -82 } };
const stop = (key, lng) => ({ address_hash: key, address: `${key} Main St`, city: 'Tampa', state: 'FL', zip_code: '33605', lat: 28, lng });
const properties = [stop('a', -82), stop('b', -81.98), stop('c', -81.99)];
const route = { id: 'route', name: 'Tampa', manager_id: user.id, assigned_to: 'rep', assigned_to_name: 'Alex', status: 'IN_PROGRESS', property_hashes: ['legacy-a', 'b'], route_origin_mode: 'none', metadata: { campaign: 'October', source: 'csv_import', road_geometry: { stale: true }, winning_route_distance: 5, matrix_block_count: 4, selected_candidate_type: 'road_aware', road_network_used: true, road_verification: { verified: true }, routing: { road_aware: true } }, metrics: { score: 82, distance: 5 } };
const args = overrides => ({ route, properties, hashes: ['legacy-a', 'b', 'c'], client: {}, user, ...overrides });

function mockClient(initialRoute = route) {
  let current = structuredClone(initialRoute);
  const updates = [];
  return {
    updates, setRoute: value => { current = value; },
    client: { entities: {
      SavedRoute: { get: async () => structuredClone(current), update: async (_id, payload) => { updates.push(payload); current = { ...current, ...payload }; return current; } },
      MasterProperty: { filter: async () => [], bulkCreate: async batch => batch },
    } },
  };
}
const batch = { properties: [properties[2]], fileName: 'second.csv' };

// The second upload must interleave the new stop with the first file's stops.
test('full merged optimization interleaves new stops and preserves legacy manifest keys and history', async () => {
  const mock = mockClient();
  const existing = [{ ...properties[0], legacy_hash: 'legacy-a', original_status: 'SOLD' }, properties[1]];
  const progress = [];
  let optimizedKeys;
  const result = await savePropertyImport(batch, {
    client: mock.client, user, routeId: route.id, loadRouteProperties: async () => existing,
    optimize: stops => { optimizedKeys = stops.map(p => p.address_hash); return [stops[0], stops[2], stops[1]]; },
    onProgress: message => progress.push(message),
  });
  assert.deepEqual(optimizedKeys, ['legacy-a', 'b', 'c']);
  assert.deepEqual(result.route.property_hashes, ['legacy-a', 'c', 'b']);
  assert.equal(result.optimization.status, 'improved');
  assert.equal(result.route.metrics.house_count, 3);
  assert.equal(result.route.metrics.score, 82);
  for (const key of ['name', 'assigned_to', 'assigned_to_name', 'status', 'route_origin_mode']) assert.equal(result.route[key], route[key]);
  assert.equal(existing[0].original_status, 'SOLD');
  assert.equal(existing[0].address_hash, 'a');
  assert.equal(result.route.metadata.campaign, 'October');
  assert.equal(result.route.metadata.source, 'csv_import');
  assert.equal(result.route.metadata.road_geometry, undefined);
  for (const key of ['winning_route_distance', 'matrix_block_count', 'selected_candidate_type']) assert.equal(result.route.metadata[key], undefined);
  assert.equal(result.route.metadata.road_network_used, false);
  assert.equal(result.route.metadata.routing.distance_estimate, 'straight_line');
  assert.equal(mock.updates.length, 1);
  assert.ok(progress.includes('Checking optimization for all 3 stops...'));
});

test('default full-route solver finds a shorter complete order', async () => {
  const result = await optimizeImportedRoute(args());
  assert.deepEqual(result.hashes, ['legacy-a', 'c', 'b']);
  assert.ok(result.distance < calculateRouteDistanceMiles(properties));
});

test('ties and worse candidate orders keep the combined baseline', async () => {
  for (const candidate of [stops => [...stops].reverse(), stops => [stops[1], stops[0], stops[2]]]) {
    const result = await optimizeImportedRoute(args({ optimizeLocal: candidate }));
    assert.equal(result.status, 'unchanged');
    assert.deepEqual(result.hashes, ['legacy-a', 'b', 'c']);
  }
});

test('malformed optimization, duplicate, missing or foreign stops never discard imported stops', async () => {
  for (const optimizeLocal of [() => [], stops => [stops[0], stops[0], stops[2]], stops => [stops[0], stops[1], stop('foreign', -82)], () => { throw new Error('offline'); }]) {
    const result = await optimizeImportedRoute(args({ optimizeLocal }));
    assert.equal(result.status, 'unavailable');
    assert.deepEqual(result.hashes, ['legacy-a', 'b', 'c']);
  }
});

test('fixed start and finish price both orders with the same anchors', async () => {
  const bounded = { ...route, route_origin_mode: 'custom_bounds', start_location: { lat: 28, lng: -81.98 }, end_location: { lat: 28, lng: -81.99 } };
  const result = await optimizeImportedRoute(args({ route: bounded, optimizeLocal: (stops, start, end) => {
    assert.deepEqual(start, bounded.start_location); assert.deepEqual(end, bounded.end_location);
    return [stops[1], stops[0], stops[2]];
  } }));
  assert.equal(result.status, 'improved');
  assert.equal(result.distance, calculateRouteDistanceMiles([properties[1], properties[0], properties[2]], { startLocation: bounded.start_location, endLocation: bounded.end_location }));
});

test('assigned rep home is resolved instead of using the manager home and never persisted', async () => {
  const home = { lat: 28, lng: -81.98 };
  const result = await optimizeImportedRoute(args({ route: { ...route, route_origin_mode: 'home_round_trip' }, client: { functions: { invoke: async (name, payload) => {
    assert.equal(name, 'getRouteHomeBase'); assert.deepEqual(payload, { route_id: route.id }); return { data: { home_base: home } };
  } } }, optimizeLocal: (stops, start, end) => { assert.deepEqual(start, home); assert.deepEqual(end, home); return stops; } }));
  assert.equal(result.status, 'unchanged');
  assert.equal(JSON.stringify(result.metadata).includes('-81.98'), false);
});

test('private anchor is resolved in memory, and unavailable personal starts keep the imported order', async () => {
  const anchor = { lat: 28, lng: -82.01 };
  const anchored = await optimizeImportedRoute(args({ route: { ...route, route_origin_mode: 'anchor_round_trip' }, client: { functions: { invoke: async (name, payload) => {
    assert.equal(name, 'manageRepAnchors'); assert.equal(payload.action, 'get_route'); return { data: { anchor } };
  } } }, optimizeLocal: (stops, start, end) => { assert.deepEqual(start, anchor); assert.deepEqual(end, anchor); return stops; } }));
  assert.equal(anchored.status, 'unchanged');
  assert.equal(JSON.stringify(anchored.metadata).includes('-82.01'), false);
  for (const mode of ['home_round_trip', 'anchor_round_trip', 'car_round_trip', 'current_to_home']) {
    const result = await optimizeImportedRoute(args({ route: { ...route, route_origin_mode: mode }, optimizeLocal: () => assert.fail('must not optimize without anchors') }));
    assert.equal(result.status, 'unavailable'); assert.equal(result.distance, calculateRouteDistanceMiles(properties));
    assert.equal(result.metadata.routing.distance_scope, 'between_stops');
    assert.deepEqual(result.hashes, ['legacy-a', 'b', 'c']);
  }
});

test('road optimizer receives all stops and measured improvement is adopted once', async () => {
  const result = await optimizeImportedRoute(args({ optimizeLocal: () => assert.fail('road result wins'), optimizeRoad: async (stops, bounds) => {
    assert.deepEqual(stops.map(p => p.address_hash), ['legacy-a', 'b', 'c']);
    assert.equal(bounds.start, null); assert.equal(bounds.end, null);
    return { order: [stops[1], stops[2], stops[0]], objective: { applyCandidate: true, appliedDistance: 1.25, estimatedSavings: 0.75 }, routingMetadata: { routing: { road_aware: true, distance_estimate: 'road' } } };
  } }));
  assert.deepEqual(result.hashes, ['b', 'c', 'legacy-a']);
  assert.equal(result.distance, 1.25); assert.equal(result.metadata.road_verification.verified, true);
  assert.equal(result.metadata.road_verification.measured_road_miles, 1.25);
  assert.match(importOptimizationMessage(result), /road distances/);
});

test('road-confirmed merged order is kept with its fresh measurement', async () => {
  const result = await optimizeImportedRoute(args({ optimizeLocal: () => assert.fail('cannot replace road-confirmed order'), optimizeRoad: async (_stops, options) => {
    options.onOutcome('current_order_measured_best', { distanceMiles: 2.75, routingMetadata: { routing: { road_aware: true, distance_estimate: 'road' } } }); return null;
  } }));
  assert.deepEqual(result.hashes, ['legacy-a', 'b', 'c']);
  assert.equal(result.status, 'unchanged'); assert.equal(result.distance, 2.75);
  assert.equal(result.metadata.road_verification.verdict, 'road_confirmed_current');
});

test('road outage or malformed road order uses an honest estimated-distance fallback', async () => {
  for (const optimizeRoad of [async () => { throw new Error('timeout'); }, async stops => ({ order: [stops[0]], objective: { applyCandidate: true, appliedDistance: 0 } })]) {
    const result = await optimizeImportedRoute(args({ optimizeRoad }));
    assert.deepEqual(result.hashes, ['legacy-a', 'c', 'b']);
    assert.equal(result.metadata.road_verification.verified, false);
    assert.match(importOptimizationMessage(result), /estimated distances/);
  }
});

test('road measurements never persist echoed personal trip coordinates', async () => {
  const home = { lat: 28, lng: -81.98765 };
  for (const confirmed of [true, false]) {
    const result = await optimizeImportedRoute(args({ route: { ...route, assigned_to: user.id, route_origin_mode: 'home_round_trip' }, user: { ...user, home_base: home }, optimizeRoad: async (stops, options) => {
      assert.deepEqual(options.start, home); assert.deepEqual(options.end, home);
      const routingMetadata = { start_constraint: home, end_constraint: home, routing: { distance_estimate: 'road' } };
      if (confirmed) { options.onOutcome('current_order_measured_best', { distanceMiles: 2, routingMetadata }); return null; }
      return { order: [stops[0], stops[2], stops[1]], objective: { applyCandidate: true, appliedDistance: 1.5, estimatedSavings: 0.5 }, routingMetadata };
    } }));
    assert.equal(result.metadata.road_verification.verified, true);
    assert.equal(result.metadata.start_constraint, undefined); assert.equal(result.metadata.end_constraint, undefined);
    assert.equal(JSON.stringify(result.metadata).includes('-81.98765'), false);
  }
});

test('a route changed during optimization is never overwritten', async () => {
  for (const change of [{ property_hashes: ['legacy-a', 'b', 'other'] }, { assigned_to: 'different-rep' }, { start_location: { lat: 28, lng: -81 } }]) {
    const mock = mockClient();
    await assert.rejects(savePropertyImport(batch, { client: mock.client, user, routeId: route.id, loadRouteProperties: async () => [{ ...properties[0], legacy_hash: 'legacy-a' }, properties[1]], optimize: stops => { mock.setRoute({ ...route, ...change }); return stops; } }), /changed during/);
    assert.equal(mock.updates.length, 0);
  }
});

test('all-duplicate imports never run optimization or write a route', async () => {
  const mock = mockClient();
  const result = await savePropertyImport({ ...batch, properties: [properties[0]] }, { client: mock.client, user, routeId: route.id, loadRouteProperties: async () => [{ ...properties[0], legacy_hash: 'legacy-a' }, properties[1]], optimizeRoad: () => assert.fail('no additions'), optimize: () => assert.fail('no additions') });
  assert.equal(result.added, 0); assert.equal(mock.updates.length, 0);
});

const roadSource = fs.readFileSync(new URL('../src/lib/roadMatrixOptimize.js', import.meta.url), 'utf8').replace(/^import .*;$/m, '').replace(/export /g, '');
const roadModule = new Function('base44', `${roadSource}; return { tryRoadMatrixOptimize };`);
test('shared road helper exposes a confirmed measurement without changing its existing null return', async () => {
  for (const input_measured of [3.25, null, undefined, '']) {
    const { tryRoadMatrixOptimize } = roadModule({ functions: { invoke: async () => ({ data: { success: true, selected: 'current', routing_metadata: { input_measured, road_network_used: true } } }) } });
    let outcome;
    const result = await tryRoadMatrixOptimize(properties, { deadlineMs: 100, onOutcome: (reason, measurement) => { outcome = { reason, measurement }; } });
    assert.equal(result, null);
    if (input_measured === 3.25) {
      assert.equal(outcome.reason, 'current_order_measured_best'); assert.equal(outcome.measurement.distanceMiles, 3.25);
      assert.equal(outcome.measurement.routingMetadata.routing.road_aware, true);
    } else { assert.equal(outcome.reason, 'backend_returned_no_measurement'); }
  }
});

test('shared road helper never accepts a missing measurement as zero miles', async () => {
  for (const winning_route_distance of [null, undefined, '', -1]) {
    const { tryRoadMatrixOptimize } = roadModule({ functions: { invoke: async () => ({ data: { success: true, selected: 'road_aware', order: ['a', 'c', 'b'], routing_metadata: { winning_route_distance, input_measured: 3 } } }) } });
    let reason;
    assert.equal(await tryRoadMatrixOptimize(properties, { deadlineMs: 100, onOutcome: value => { reason = value; } }), null);
    assert.equal(reason, 'backend_returned_no_measurement');
  }
});
