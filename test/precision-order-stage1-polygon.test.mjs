// MODEL 1 / PR A — Stage 1 characterization: canonical polygon identity.
//
// Traces one drawn ring through: submitted request -> server normalization ->
// centroid/area/FIPS -> polygon_hash -> persisted FetchJob.polygon, on both
// start paths plus previewBatchDataArea.
// See docs/precision/pr-a-model-1/audit/STAGE_1_AUDIT.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDIT_USER,
  DEFAULT_FIPS_RESPONSE,
  PATHS,
  START_PATHS,
  SQUARE_MILE_POLYGON,
  TRIANGLE_POLYGON,
  Trace,
  callHandler,
  loadPrecisionHandler,
  makeBase44,
  makeStripe,
  orderBody,
  runStartPath
} from './helpers/precisionOrderHarness.mjs';

/** Recomputes the production polygon hash independently of the handlers. */
async function referencePolygonHash(points) {
  const normalized = points.map((p) => [Number(Number(p.lat).toFixed(6)), Number(Number(p.lng).toFixed(6))]);
  const bytes = new TextEncoder().encode(JSON.stringify(normalized));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/* ---------------------------------------------- AR-S1-01 accept / reject */

const SHAPE_CASES = [
  { id: 'valid-triangle', polygon: TRIANGLE_POLYGON, accepted: true, points: 3 },
  { id: 'square-mile', polygon: SQUARE_MILE_POLYGON, accepted: true, points: 4 },
  {
    id: 'closed-ring-duplicate-final-point',
    polygon: [...SQUARE_MILE_POLYGON, SQUARE_MILE_POLYGON[0]],
    accepted: true,
    points: 5
  },
  {
    id: 'duplicate-interior-point',
    polygon: [SQUARE_MILE_POLYGON[0], SQUARE_MILE_POLYGON[1], SQUARE_MILE_POLYGON[1], SQUARE_MILE_POLYGON[2]],
    accepted: true,
    points: 4
  },
  {
    id: 'string-coordinates',
    polygon: SQUARE_MILE_POLYGON.map((p) => ({ lat: String(p.lat), lng: String(p.lng) })),
    accepted: true,
    points: 4
  },
  {
    id: 'reversed-point-sequence',
    polygon: [...SQUARE_MILE_POLYGON].reverse(),
    accepted: true,
    points: 4
  },
  {
    id: 'self-intersecting-bowtie',
    polygon: [
      { lat: 33.86, lng: -83.40 },
      { lat: 33.87, lng: -83.38 },
      { lat: 33.86, lng: -83.38 },
      { lat: 33.87, lng: -83.40 }
    ],
    accepted: true,
    points: 4
  },
  {
    id: 'very-small-polygon',
    polygon: [
      { lat: 33.8600000, lng: -83.4000000 },
      { lat: 33.8600010, lng: -83.4000000 },
      { lat: 33.8600010, lng: -83.3999990 }
    ],
    accepted: true,
    points: 3
  },
  // UPDATED BY PR A (ADJ-M2-002, Model 1 F-PRA-008/F-PRA-012). These were
  // accepted and persisted before PR A; vertices are now range-validated with
  // the same bounds `normalizeRoutePoint` already applied to route bounds.
  {
    id: 'out-of-range-latitude-200',
    polygon: [{ lat: 200, lng: -83.40 }, { lat: 33.86, lng: -83.38 }, { lat: 33.87, lng: -83.39 }],
    accepted: false,
    points: 3,
    note: 'latitude is now range-validated'
  },
  {
    id: 'out-of-range-longitude-400',
    polygon: [{ lat: 33.86, lng: 400 }, { lat: 33.86, lng: -83.38 }, { lat: 33.87, lng: -83.39 }],
    accepted: false,
    points: 3,
    note: 'longitude is now range-validated'
  },
  {
    id: 'missing-coordinate-drops-the-point',
    polygon: [{ lat: 33.86 }, { lat: 33.86, lng: -83.38 }, { lat: 33.87, lng: -83.39 }],
    accepted: false,
    points: 2,
    note: 'a malformed vertex is silently dropped, then <3 fails the count check'
  },
  {
    id: 'non-numeric-coordinate-drops-the-point',
    polygon: [{ lat: 'north', lng: 'west' }, { lat: 33.86, lng: -83.38 }, { lat: 33.87, lng: -83.39 }],
    accepted: false,
    points: 2
  },
  { id: 'two-points', polygon: TRIANGLE_POLYGON.slice(0, 2), accepted: false, points: 2 },
  { id: 'empty', polygon: [], accepted: false, points: 0 },
  { id: 'not-an-array', polygon: 'polygon', accepted: false, points: 0 }
];

for (const shape of SHAPE_CASES) {
  test(`AR-S1-01 [${shape.id}] is handled identically by both start paths`, async () => {
    const outcomes = {};
    for (const [name, path] of START_PATHS) {
      const result = await runStartPath(path, { body: orderBody({ polygon: shape.polygon }) });
      outcomes[name] = {
        status: result.status,
        persistedPointCount: result.createdJob ? result.createdJob.polygon.length : null
      };
    }
    assert.deepEqual(outcomes.startBatchDataPull, outcomes.fetchAreaProperties,
      `${shape.id}: both start paths must agree`);

    if (shape.accepted) {
      assert.equal(outcomes.startBatchDataPull.status, 200, shape.note || shape.id);
      assert.equal(outcomes.startBatchDataPull.persistedPointCount, shape.points,
        `${shape.id}: every surviving vertex is persisted verbatim — no closure, dedupe or rewinding`);
    } else {
      assert.equal(outcomes.startBatchDataPull.status, 400, shape.note || shape.id);
      assert.equal(outcomes.startBatchDataPull.persistedPointCount, null);
    }
  });
}

/* ------------------------------------------------ AR-S1-02 hash identity */

test('AR-S1-02 polygon_hash is order-sensitive, closure-sensitive and 6-dp rounded', async () => {
  const open = SQUARE_MILE_POLYGON;
  const closed = [...SQUARE_MILE_POLYGON, SQUARE_MILE_POLYGON[0]];
  const reversed = [...SQUARE_MILE_POLYGON].reverse();
  const sevenDp = SQUARE_MILE_POLYGON.map((p) => ({ lat: p.lat + 0.00000004, lng: p.lng }));

  const hashes = {};
  for (const [label, polygon] of [['open', open], ['closed', closed], ['reversed', reversed], ['sevenDp', sevenDp]]) {
    const result = await runStartPath(PATHS.startBatchDataPull, { body: orderBody({ polygon }) });
    assert.equal(result.status, 200);
    hashes[label] = result.createdJob.polygon_hash;
    assert.equal(hashes[label], await referencePolygonHash(polygon),
      `${label}: production hash matches the documented algorithm`);
  }

  assert.notEqual(hashes.open, hashes.closed,
    'the same geometry drawn open vs closed produces DIFFERENT identities');
  assert.notEqual(hashes.open, hashes.reversed,
    'reversing the winding produces a DIFFERENT identity for the same geometry');
  assert.equal(hashes.open, hashes.sevenDp,
    'a 7th-decimal difference is absorbed by the 6-dp rounding');
});

test('AR-S1-03 both start paths and previewBatchDataArea derive the identical hash', async () => {
  const polygon = SQUARE_MILE_POLYGON;
  const expected = await referencePolygonHash(polygon);

  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, { body: orderBody({ polygon }) });
    assert.equal(result.createdJob.polygon_hash, expected, `${name} hash`);
  }

  const trace = new Trace();
  const base44 = makeBase44({
    trace,
    user: AUDIT_USER,
    invokeHandlers: {
      getPrecisionUsage: async () => ({
        data: {
          success: true, complete: true, version: 2, limit: 50, used: 0, reserved: 0,
          meter_used: 0, remaining: 50, lifetime_used: 0, paid_access: false
        }
      })
    }
  });
  const { handler } = loadPrecisionHandler(PATHS.previewBatchDataArea, {
    trace, base44, stripeApi: makeStripe(trace, {})
  });
  const preview = await callHandler(handler, { polygon, requested_properties: 25 });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.polygon_hash, expected, 'preview hash');
});

/* --------------------------------------- AR-S1-04 derived geometry fields */

test('AR-S1-04 centroid is the vertex mean, so closure shifts it and moves the FIPS lookup point', async () => {
  const open = SQUARE_MILE_POLYGON;
  const closed = [...SQUARE_MILE_POLYGON, SQUARE_MILE_POLYGON[0]];

  const results = {};
  for (const [label, polygon] of [['open', open], ['closed', closed]]) {
    const result = await runStartPath(PATHS.startBatchDataPull, { body: orderBody({ polygon }) });
    const fipsCall = result.trace.externalFetches.find((event) => event.detail.host === 'geo.fcc.gov');
    results[label] = {
      latitude: result.createdJob.latitude,
      longitude: result.createdJob.longitude,
      area: result.createdJob.area_sq_mi,
      fipsUrl: fipsCall.detail.url
    };
  }

  assert.notEqual(results.open.latitude, results.closed.latitude,
    'duplicating the first vertex changes the persisted centroid');
  assert.notEqual(results.open.fipsUrl, results.closed.fipsUrl,
    'and therefore changes the coordinate sent to the county resolver');
  assert.equal(results.open.area, results.closed.area,
    'the shoelace area is unaffected because the ring is closed implicitly');
});

test('AR-S1-05 area, radius and area_sq_mi rounding are stable and shared by both paths', async () => {
  const observations = {};
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, { body: orderBody({ polygon: SQUARE_MILE_POLYGON }) });
    observations[name] = {
      area_sq_mi: result.createdJob.area_sq_mi,
      radius: result.createdJob.radius,
      latitude: result.createdJob.latitude,
      longitude: result.createdJob.longitude
    };
  }
  assert.deepEqual(observations.startBatchDataPull, observations.fetchAreaProperties);
  assert.equal(observations.startBatchDataPull.area_sq_mi, 1,
    'the reference square-mile polygon measures 1.00 sq mi after 2-dp rounding');

  // `radius` is sqrt(area/pi) computed from the UNROUNDED area, while
  // `area_sq_mi` is the 2-dp rounded value. They therefore disagree slightly,
  // and `area_sq_mi` cannot be used to reconstruct `radius`.
  const { radius, area_sq_mi: rounded } = observations.startBatchDataPull;
  const impliedArea = radius * radius * Math.PI;
  assert.notEqual(radius, Math.sqrt(rounded / Math.PI),
    'radius is NOT derived from the rounded area_sq_mi');
  assert.equal(Number(impliedArea.toFixed(2)), rounded,
    'radius encodes the unrounded area, which rounds to the persisted area_sq_mi');
});

/* -------------------------------------- AR-S1-06 lat/lng swap is undetected */

test('AR-S1-06 a latitude/longitude swap is accepted and only fails if the county resolver rejects it', async () => {
  const swapped = SQUARE_MILE_POLYGON.map((p) => ({ lat: p.lng, lng: p.lat }));

  // With a resolver that still answers, the swapped ring is fully accepted.
  const permissive = await runStartPath(PATHS.startBatchDataPull, { body: orderBody({ polygon: swapped }) });
  assert.equal(permissive.status, 200,
    'no geometry-plausibility check rejects a swapped ring');
  assert.equal(permissive.createdJob.latitude < 0, true, 'the swapped centroid is persisted verbatim');

  // The ONLY guard is the FIPS lookup returning no county.
  const strict = await runStartPath(PATHS.startBatchDataPull, {
    body: orderBody({ polygon: swapped }),
    fetchResponder: async () => new Response(JSON.stringify({ County: {}, State: {} }), {
      status: 200, headers: { 'content-type': 'application/json' }
    })
  });
  assert.equal(strict.status, 400);
  assert.match(strict.body.error, /Could not resolve county\/FIPS/);
});

/* ------------------------------------- AR-S1-07 county resolution is a gate */

test('AR-S1-07 the county resolver runs OUTSIDE the usage lock and before any reservation', async () => {
  const result = await runStartPath(PATHS.startBatchDataPull, { body: orderBody() });
  const events = result.trace.events;
  const fipsIndex = events.findIndex((event) => event.channel === 'fetch' && event.detail.host === 'geo.fcc.gov');
  const lockIndex = events.findIndex((event) => event.channel === 'lock' && event.name === 'db.connect');
  const createIndex = events.findIndex((event) => event.name === 'FetchJob.create');

  assert.ok(fipsIndex >= 0 && lockIndex >= 0 && createIndex >= 0);
  assert.ok(fipsIndex < lockIndex, 'FIPS is resolved before the usage lock is acquired');
  assert.ok(lockIndex < createIndex, 'the FetchJob is created inside the lock');
  assert.equal(
    result.trace.externalFetches.filter((event) => event.detail.host === 'geo.fcc.gov').length,
    1,
    'exactly one county lookup per start'
  );
  assert.equal(result.createdJob.fips_code, DEFAULT_FIPS_RESPONSE.County.FIPS);
});

/* ------------------------------- AR-S1-08 persisted polygon round-trips exactly */

test('AR-S1-08 the persisted FetchJob.polygon is the numeric normalization of the submitted ring', async () => {
  const stringPolygon = SQUARE_MILE_POLYGON.map((p) => ({ lat: String(p.lat), lng: String(p.lng), extra: 'ignored' }));
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, { body: orderBody({ polygon: stringPolygon }) });
    assert.equal(result.status, 200);
    assert.deepEqual(
      result.createdJob.polygon,
      SQUARE_MILE_POLYGON.map((p) => ({ lat: p.lat, lng: p.lng })),
      `${name}: strings are coerced to numbers and unknown vertex keys are dropped`
    );
  }
});
