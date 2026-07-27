// Stage 1 — Precision polygons must be SIMPLE rings.
//
// PROVEN DEFECT
// -------------
// A production freehand pull failed with an opaque provider 500:
//
//     search_phase_execution_exception / query_shard_exception
//     failed to create query: Self-intersection at or near point
//     [-93.60393530987416, 42.02950098710155]
//
// BatchData's geometry engine rejects a crossing boundary BEFORE running any
// property search. The request never reached enrichment, so such a failure says
// nothing about the Stage 6–9 provider-contract work.
//
// `normalizePrecisionPolygon` validated coordinate presence, numeric type,
// latitude/longitude range and a minimum point count — but not topology. Worse,
// `precision-order-safety.test.mjs` explicitly listed a bow-tie under
// "unusual-but-legal polygons" and REQUIRED it to succeed. That contract was
// asserted without provider evidence and is contradicted by the provider.
//
// The polygon is never auto-repaired. No reordering, untangling, hull-fitting
// or point removal: any of those would silently change the area the user drew.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PATHS,
  START_PATHS,
  orderBody,
  runStartPath
} from './helpers/precisionOrderHarness.mjs';
import {
  findPolygonSelfIntersection,
  normalizePrecisionPolygon
} from '../base44/functions/_shared/precisionOrderSafety.js';

/* ── Valid geometry: every one of these must still be accepted ── */

const RECTANGLE = [
  { lat: 42.028, lng: -93.606 },
  { lat: 42.031, lng: -93.606 },
  { lat: 42.031, lng: -93.601 },
  { lat: 42.028, lng: -93.601 }
];

/** An L-shape: concave, but simple. */
const CONCAVE = [
  { lat: 42.028, lng: -93.606 },
  { lat: 42.032, lng: -93.606 },
  { lat: 42.032, lng: -93.604 },
  { lat: 42.030, lng: -93.604 },
  { lat: 42.030, lng: -93.601 },
  { lat: 42.028, lng: -93.601 }
];

const VALID = [
  ['simple rectangle', RECTANGLE],
  ['concave L-shape', CONCAVE],
  ['clockwise winding', RECTANGLE],
  ['counter-clockwise winding', [...RECTANGLE].reverse()],
  ['explicitly closed ring', [...RECTANGLE, RECTANGLE[0]]],
  ['triangle', [{ lat: 42.028, lng: -93.606 }, { lat: 42.031, lng: -93.604 }, { lat: 42.028, lng: -93.601 }]],
  ['consecutive duplicate vertex', [RECTANGLE[0], RECTANGLE[1], RECTANGLE[1], RECTANGLE[2], RECTANGLE[3]]]
];

/* ── Invalid geometry: every one of these must be rejected ── */

const INVALID = [
  // Classic bow-tie: edge 0-1 crosses edge 2-3.
  ['bow-tie', [
    { lat: 33.86, lng: -83.4 }, { lat: 33.87, lng: -83.38 },
    { lat: 33.86, lng: -83.38 }, { lat: 33.87, lng: -83.4 }
  ]],
  // Simple until the implied closing edge, which cuts back through the shape.
  ['crossing only on the implied closing edge', [
    { lat: 42.028, lng: -93.606 }, { lat: 42.032, lng: -93.606 },
    { lat: 42.030, lng: -93.601 }, { lat: 42.034, lng: -93.603 }
  ]],
  // Non-adjacent vertices occupying the same point — a pinch.
  ['non-adjacent shared endpoint', [
    { lat: 42.028, lng: -93.606 }, { lat: 42.032, lng: -93.604 },
    { lat: 42.028, lng: -93.601 }, { lat: 42.032, lng: -93.604 },
    { lat: 42.026, lng: -93.603 }
  ]],
  // Non-adjacent collinear edges lying on top of one another.
  ['overlapping collinear edges', [
    { lat: 42.028, lng: -93.606 }, { lat: 42.028, lng: -93.600 },
    { lat: 42.030, lng: -93.600 }, { lat: 42.028, lng: -93.604 },
    { lat: 42.028, lng: -93.602 }, { lat: 42.026, lng: -93.603 }
  ]]
];

/* ══════════════ 1. The validator itself ══════════════ */

test('POLYSIMP-01 every valid polygon is accepted, geometry untouched', () => {
  for (const [label, polygon] of VALID) {
    assert.equal(findPolygonSelfIntersection(polygon), null, `${label} must be simple`);

    const result = normalizePrecisionPolygon(polygon);
    assert.equal(result.ok, true, `${label} must be accepted`);

    // No reordering, no dedupe, no closure change — the caller's ring survives.
    assert.equal(result.points.length, polygon.length, `${label}: point count must not change`);
    assert.deepEqual(
      result.points.map((p) => [p.lat, p.lng]),
      polygon.map((p) => [Number(p.lat), Number(p.lng)]),
      `${label}: coordinates and order must be preserved exactly`
    );
  }
});

test('POLYSIMP-02 every self-intersecting polygon is rejected', () => {
  for (const [label, polygon] of INVALID) {
    assert.notEqual(findPolygonSelfIntersection(polygon), null, `${label} must be detected`);

    const result = normalizePrecisionPolygon(polygon);
    assert.equal(result.ok, false, `${label} must be rejected`);
    assert.equal(result.code, 'self_intersecting_polygon', `${label}: wrong error code`);
    assert.match(result.message, /crosses itself/i);
  }
});

test('POLYSIMP-03 adjacent edges sharing their normal endpoint are not a crossing', () => {
  // Every consecutive pair in a simple ring shares a vertex by construction,
  // including the last-to-first pair. None of that is self-intersection.
  for (const [label, polygon] of VALID) {
    assert.equal(findPolygonSelfIntersection(polygon), null, `${label} must not trip on adjacency`);
  }
});

test('POLYSIMP-04 the reported intersection point is near the real crossing', () => {
  const [, bowTie] = INVALID[0];
  const intersection = findPolygonSelfIntersection(bowTie);

  // The bow-tie above crosses at roughly (33.865, -83.39).
  assert.ok(Math.abs(intersection.lat - 33.865) < 0.01, `lat ${intersection.lat} off`);
  assert.ok(Math.abs(intersection.lng - -83.39) < 0.01, `lng ${intersection.lng} off`);
});

test('POLYSIMP-05 a triangle can never self-intersect', () => {
  assert.equal(findPolygonSelfIntersection([
    { lat: 0, lng: 0 }, { lat: 1, lng: 0 }, { lat: 0, lng: 1 }
  ]), null);
});

/* ══════════════ 2. Both start paths, same contract ══════════════ */

test('POLYSIMP-06 both start endpoints reject a crossing polygon with the same 400', async () => {
  const [, bowTie] = INVALID[0];

  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, { body: orderBody({ polygon: bowTie }) });

    assert.equal(result.status, 400, `${name} must reject with 400`);
    assert.equal(result.body.error, 'self_intersecting_polygon', `${name}: wrong error code`);
    assert.match(result.body.message, /crosses itself/i, `${name}: message must be actionable`);

    // The raw provider exception must never reach the user.
    const serialized = JSON.stringify(result.body);
    for (const leak of ['search_phase_execution_exception', 'query_shard_exception', 'shard']) {
      assert.equal(serialized.includes(leak), false, `${name} must not leak "${leak}"`);
    }
  }
});

test('POLYSIMP-07 no FetchJob or reservation is created for a crossing polygon', async () => {
  const [, bowTie] = INVALID[0];

  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, { body: orderBody({ polygon: bowTie }) });

    assert.equal(result.status, 400, `${name} must reject`);
    assert.equal(result.createdJob, null, `${name} must not create a FetchJob`);
  }
});

test('POLYSIMP-08 a valid polygon still starts a pull normally', async () => {
  const result = await runStartPath(PATHS.startBatchDataPull, {
    body: orderBody({ polygon: RECTANGLE })
  });

  assert.equal(result.status, 200, 'a simple polygon must still be accepted');
  assert.ok(result.createdJob, 'and must still create a FetchJob');
});

/* ══════════════ 3. Existing geometry semantics are unchanged ══════════════ */

test('POLYSIMP-09 accepted polygons keep their hash, order and closure behaviour', async () => {
  // A crossing check must not perturb identity for polygons that were already
  // valid — otherwise every in-flight job would look like a different order.
  const first = await runStartPath(PATHS.startBatchDataPull, { body: orderBody({ polygon: RECTANGLE }) });
  const second = await runStartPath(PATHS.startBatchDataPull, { body: orderBody({ polygon: RECTANGLE }) });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(
    first.createdJob.polygon_hash, second.createdJob.polygon_hash,
    'the same polygon must still hash identically'
  );
  assert.deepEqual(
    first.createdJob.polygon.map((p) => [p.lat, p.lng]),
    RECTANGLE.map((p) => [p.lat, p.lng]),
    'stored geometry must be byte-identical to what was submitted'
  );
});

test('POLYSIMP-10 winding order is preserved, not normalized', async () => {
  const reversed = [...RECTANGLE].reverse();
  const result = await runStartPath(PATHS.startBatchDataPull, { body: orderBody({ polygon: reversed }) });

  assert.equal(result.status, 200);
  assert.deepEqual(
    result.createdJob.polygon.map((p) => [p.lat, p.lng]),
    reversed.map((p) => [p.lat, p.lng]),
    'the polygon must not be rewound or reordered'
  );
});

/* ══════ 4. Defense in depth: the processor fails before the network ══════ */
//
// A job stored before this validation existed can still carry a crossing
// polygon. The processor must refuse it while building the request, so the
// provider is never called and the user never sees a raw 500.

test('POLYSIMP-11 the processor refuses a crossing polygon without calling the provider', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const vm = (await import('node:vm')).default;
  const ts = (await import('typescript')).default;

  const path = 'base44/functions/processFetchChunk/entry.ts';
  const source = readFileSync(resolve(process.cwd(), path), 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: path
  });

  // Supply the shared validator the way the real import does, then capture the
  // request builder. `fetch` throws if reached at all.
  let providerCalls = 0;
  let collected = null;
  vm.runInNewContext(`${transpiled.outputText.replace(/^import .*;\s*$/gm, '')}
;__collect({ buildBatchDataRequest });`, {
    __collect: (value) => { collected = value; },
    findPolygonSelfIntersection,
    Deno: { env: { get: () => undefined }, serve: () => {} },
    createClientFromRequest: () => ({}),
    neon: () => (() => {}),
    Request, Response, TextEncoder, TextDecoder, URL,
    crypto: globalThis.crypto,
    fetch: async () => { providerCalls += 1; throw new Error('provider must not be called'); },
    setTimeout, clearTimeout, AbortController,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    JSON, Number, String, Boolean, Array, Object, Set, Map, Math, Date, Error,
    Promise, Uint8Array, isNaN, isFinite, parseInt, parseFloat
  }, { filename: path });

  const buildBatchDataRequest = collected.buildBatchDataRequest;
  const [, bowTie] = INVALID[0];

  assert.throws(
    () => buildBatchDataRequest(
      { polygon: bowTie, latitude: 33.865, longitude: -83.39, sold_months: 12, dry_run_metadata: { filters: {} } },
      0, 100, 'strict_polygon'
    ),
    /crosses itself/i,
    'building a polygon request over a crossing boundary must fail'
  );
  assert.equal(providerCalls, 0, 'the provider must never be contacted');

  // And a valid polygon still builds normally.
  const ok = buildBatchDataRequest(
    { polygon: RECTANGLE, latitude: 42.03, longitude: -93.603, sold_months: 12, dry_run_metadata: { filters: {} } },
    0, 100, 'strict_polygon'
  );
  assert.ok(ok.searchCriteria.address.geoLocationPolygon.geoPoints.length >= RECTANGLE.length);
  assert.equal(providerCalls, 0);
});
