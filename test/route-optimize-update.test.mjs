// Executable tests for the five correctness gaps a source-regex check missed.
//
// These drive the real pure helpers and assert the ACTUAL SavedRoute update
// payload, the ACTUAL identity decision and the ACTUAL objective comparison.
// A regex over a file cannot tell you whether a coordinate reaches the payload.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from 'vite';

let vite;
let update;

before(async () => {
  vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  update = await vite.ssrLoadModule('/src/lib/routeOptimizeUpdate.js');
});

after(async () => { await vite?.close(); });

const HOME = { lat: 42.0500, lng: -93.6500 };
const CAR = { lat: 42.0290, lng: -93.6040 };

const CAR_CAPTURE = { ...CAR, accuracy_m: 14, captured_at: '2026-07-27T18:00:00.000Z' };

/* ══════════ 1. Personal coordinates never reach SavedRoute ══════════ */

const payloadFor = (optimizeMode, carCapture = null) => update.buildRouteOptimizeUpdate({
  optimizeMode,
  order: ['a', 'b', 'c'],
  distanceMiles: 2.5,
  existingMetrics: { score: 9 },
  existingMetadata: { road_geometry: 'HUGE', keep: 'me' },
  routingMetadata: { road_routing: 'ok' },
  carCapture
});

test('PRIV-01 the Home payload contains no Home Base coordinate', () => {
  const payload = payloadFor('home_round_trip');

  assert.equal(payload.start_location, null);
  assert.equal(payload.end_location, null);
  assert.equal(payload.route_origin_mode, 'home_round_trip');

  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes('42.05'), false, 'no Home latitude anywhere in the payload');
  assert.equal(serialized.includes('-93.65'), false, 'no Home longitude anywhere in the payload');
});

test('PRIV-02 the Car payload contains no GPS coordinate, only provenance', () => {
  const payload = payloadFor('car_round_trip', CAR_CAPTURE);

  assert.equal(payload.start_location, null);
  assert.equal(payload.end_location, null);
  assert.equal(payload.route_origin_mode, 'car_round_trip');

  assert.deepEqual(payload.metadata.route_bounds, {
    enabled: true,
    mode: 'car_round_trip',
    start_source: 'gps_snapshot',
    accuracy_m: 14,
    captured_at: '2026-07-27T18:00:00.000Z'
  });

  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes('42.029'), false, 'no car latitude');
  assert.equal(serialized.includes('-93.604'), false, 'no car longitude');
});

test('PRIV-03 no mode leaks a lat/lng into the payload', () => {
  for (const [mode, capture] of [['route_only', null], ['home_round_trip', null], ['car_round_trip', CAR_CAPTURE]]) {
    const serialized = JSON.stringify(payloadFor(mode, capture));
    assert.equal(/"lat"\s*:/.test(serialized), false, `${mode} must not carry a lat key`);
    assert.equal(/"lng"\s*:/.test(serialized), false, `${mode} must not carry a lng key`);
  }
});

test('PRIV-04 unrelated metadata survives and road_geometry is still stripped', () => {
  const payload = payloadFor('route_only');
  assert.equal(payload.metadata.keep, 'me');
  assert.equal(payload.metadata.road_geometry, undefined);
  assert.equal(payload.metadata.road_routing, 'ok');
});

/* ══════════ 2. Assignee identity ══════════ */

const USER = { id: 'user-1', email: 'Rep@Example.com' };
const MEMBERS = [
  { id: 'tm-1', user_id: 'user-1', email: 'rep@example.com', name: 'Rep One' },
  { id: 'tm-2', user_id: 'user-2', email: 'other@example.com', name: 'Rep Two' },
  { id: 'tm-3', email: 'REP@example.com', name: 'Rep One by email only' }
];

test('IDENT-01 a route assigned by User id belongs to the acting user', () => {
  assert.equal(update.routeBelongsToActingUser({ assigned_to: 'user-1' }, USER, MEMBERS), true);
});

test('IDENT-02 a route assigned by TeamMember id linked via user_id belongs to them', () => {
  // This is the case a plain `assigned_to === user.id` comparison denies — and
  // it is exactly the rep this feature is built for.
  assert.equal(update.routeBelongsToActingUser({ assigned_to: 'tm-1' }, USER, MEMBERS), true);
});

test('IDENT-03 a TeamMember linked only by email still matches, case-insensitively', () => {
  assert.equal(update.routeBelongsToActingUser({ assigned_to: 'tm-3' }, USER, MEMBERS), true);
});

test('IDENT-04 another rep\'s route does not belong to the acting user', () => {
  assert.equal(update.routeBelongsToActingUser({ assigned_to: 'tm-2' }, USER, MEMBERS), false);
  assert.equal(update.routeBelongsToActingUser({ assigned_to: 'user-2' }, USER, MEMBERS), false);
});

test('IDENT-05 a manager viewing an assigned route is denied', () => {
  const manager = { id: 'mgr-1', email: 'manager@example.com' };
  assert.equal(update.routeBelongsToActingUser({ assigned_to: 'tm-1' }, manager, MEMBERS), false);
  assert.equal(update.routeBelongsToActingUser({ assigned_to: 'user-1' }, manager, MEMBERS), false);
});

test('IDENT-06 an unassigned route stays with the acting user', () => {
  assert.equal(update.routeBelongsToActingUser({ assigned_to: null }, USER, MEMBERS), true);
});

test('IDENT-07 an unknown assignee id is denied rather than assumed', () => {
  assert.equal(update.routeBelongsToActingUser({ assigned_to: 'ghost' }, USER, MEMBERS), false);
  assert.equal(update.routeBelongsToActingUser({ assigned_to: 'tm-1' }, null, MEMBERS), false);
});

/* ══════════ 3. Route always clears every external anchor ══════════ */

test('CLEAR-01 Route clears bounds from every previous mode', () => {
  // The old code only cleared when it recognized the previous mode, and its
  // allowlist omitted car_round_trip — so Car -> Route left the car behind.
  for (const previous of ['car_round_trip', 'home_round_trip', 'current_to_home', 'none', 'legacy_unknown']) {
    const payload = update.buildRouteOptimizeUpdate({
      optimizeMode: 'route_only',
      order: ['a', 'b'],
      distanceMiles: 1,
      existingMetadata: {
        route_bounds: { enabled: true, mode: previous },
        // a legacy route that still carried a stale point
        stale: true
      }
    });

    assert.equal(payload.start_location, null, `${previous}: start must be cleared`);
    assert.equal(payload.end_location, null, `${previous}: end must be cleared`);
    assert.equal(payload.route_origin_mode, 'none', `${previous}: mode must be none`);
    assert.deepEqual(payload.metadata.route_bounds, {
      enabled: false, cleared_reason: 'optimized_route_only'
    }, `${previous}: bounds must be explicitly disabled`);
  }
});

test('CLEAR-02 switching between anchored modes replaces the previous bounds', () => {
  const toCar = update.buildRouteOptimizeUpdate({
    optimizeMode: 'car_round_trip', order: ['a'], distanceMiles: 1,
    existingMetadata: { route_bounds: { enabled: true, mode: 'home_round_trip' } },
    carCapture: CAR_CAPTURE
  });
  assert.equal(toCar.metadata.route_bounds.mode, 'car_round_trip');

  const toHome = update.buildRouteOptimizeUpdate({
    optimizeMode: 'home_round_trip', order: ['a'], distanceMiles: 1,
    existingMetadata: { route_bounds: { enabled: true, mode: 'car_round_trip', accuracy_m: 14 } }
  });
  assert.equal(toHome.metadata.route_bounds.mode, 'home_round_trip');
  assert.equal(toHome.metadata.route_bounds.accuracy_m, undefined, 'stale car provenance must not survive');
});

/* ══════════ 4. Comparable, truthful savings ══════════ */

const miles = (a, b) => Math.hypot(a.lat - b.lat, a.lng - b.lng) * 69;
const stop = (lat, lng) => ({ lat, lng });

test('OBJ-01 savings are measured under ONE anchor, never across two', () => {
  // Same door order, only the anchor differs. A naive comparison of a stored
  // Home metric against a new Car metric would report the commute difference as
  // optimizer savings. Under one objective the saving is zero.
  const order = [stop(42.028, -93.606), stop(42.030, -93.604), stop(42.032, -93.602)];

  const result = update.compareRouteObjective({
    currentOrder: order,
    candidateOrder: order,
    start: CAR, end: CAR,
    distanceFn: miles
  });

  assert.equal(result.estimatedSavings, 0, 'no reordering means no savings, however close the car is');
  assert.equal(result.baselineDistance, result.candidateDistance);
});

test('OBJ-02 a genuinely better order reports a real saving', () => {
  const bad = [stop(42.028, -93.606), stop(42.032, -93.602), stop(42.030, -93.604)];
  const good = [stop(42.028, -93.606), stop(42.030, -93.604), stop(42.032, -93.602)];

  const result = update.compareRouteObjective({
    currentOrder: bad, candidateOrder: good, start: CAR, end: CAR, distanceFn: miles
  });

  assert.equal(result.applyCandidate, true);
  assert.ok(result.estimatedSavings > 0);
  assert.ok(Math.abs(result.estimatedSavings - (result.baselineDistance - result.candidateDistance)) < 1e-9,
    'savings must equal baseline minus applied under one objective');
});

test('OBJ-03 a worse candidate is not applied and claims no savings', () => {
  const good = [stop(42.028, -93.606), stop(42.030, -93.604), stop(42.032, -93.602)];
  const bad = [stop(42.028, -93.606), stop(42.032, -93.602), stop(42.030, -93.604)];

  const result = update.compareRouteObjective({
    currentOrder: good, candidateOrder: bad, start: CAR, end: CAR, distanceFn: miles
  });

  assert.equal(result.applyCandidate, false, 'the existing order must be kept');
  assert.equal(result.appliedDistance, result.baselineDistance);
  assert.equal(result.estimatedSavings, 0, 'never a negative or fabricated saving');
});

test('OBJ-04 the external legs are included on both sides', () => {
  const order = [stop(42.028, -93.606), stop(42.030, -93.604)];

  const unanchored = update.compareRouteObjective({
    currentOrder: order, candidateOrder: order, distanceFn: miles
  });
  const anchored = update.compareRouteObjective({
    currentOrder: order, candidateOrder: order, start: HOME, end: HOME, distanceFn: miles
  });

  assert.ok(anchored.baselineDistance > unanchored.baselineDistance,
    'anchored distance must include the outbound and return legs');
});

test('OBJ-05 success copy is mode-specific and honest when already optimal', () => {
  assert.match(update.optimizeSuccessMessage('route_only'), /Route order optimized/);
  assert.match(update.optimizeSuccessMessage('home_round_trip'), /Home round trip optimized/);
  assert.match(update.optimizeSuccessMessage('car_round_trip'), /finish back at your parked-car location/);
  assert.match(
    update.optimizeSuccessMessage('car_round_trip', { alreadyOptimal: true }),
    /already optimized/,
    'a no-op must say so rather than imply an improvement'
  );
});
