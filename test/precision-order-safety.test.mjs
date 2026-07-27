// Minimum necessary Precision order-control safety invariants.
//
// Every test here documents: the defect it prevents, whether it failed on
// current `main`, and the existing behaviour it protects.
//
// Deliberately NOT covered here, because the behaviour is deliberately
// unchanged: Fixed Count clamping, the minimum-value default divergence,
// stale-job cancellation and reservation lifecycle. See
// docs/precision/PR_A_DEFERRED_DECISIONS.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDIT_USER,
  FIXED_NOW_MS,
  PATHS,
  START_PATHS,
  SQUARE_MILE_POLYGON,
  TRIANGLE_POLYGON,
  Trace,
  activeFetchJob,
  callHandler,
  loadPrecisionHandler,
  loadSharedOrderSafety,
  makeBase44,
  makeStripe,
  orderBody,
  paidSubscription,
  runConcurrentStarts,
  runStartPath,
  settledFetchJob
} from './helpers/precisionOrderHarness.mjs';

const FREE_CAP = 50;
const paidUser = { ...AUDIT_USER, stripe_customer_id: 'cus_1' };

/**
 * A job created by the primary start path persists every order field, so its
 * order is provable and it can be exact-matched. This mirrors what
 * `startBatchDataPull` actually writes on `main`.
 */
function provableActiveJob(overrides = {}) {
  const metadata = {
    requested_properties: 25,
    requested_properties_before_cap: 25,
    count_mode: 'fixed',
    filters: { min_price: null, max_price: null },
    route_filters: {
      propertyTypes: ['Single Family'],
      excludeCommercial: true,
      excludeCondos: true,
      excludeLand: true
    },
    route_bounds: { enabled: false },
    ownership_range_mode: 'quick',
    ownership_range_days: null,
    repull_mode: 'new_area',
    previous_pull_date: null,
    ...(overrides.dry_run_metadata || {})
  };
  const job = activeFetchJob({ precision_usage_reserved: 1, total_expected: 1, ...overrides });
  job.dry_run_metadata = metadata;
  return job;
}

/* ════════════════ 5.1 Immutable usage ownership ════════════════
 * Defect prevented: a FetchJob owned by a DIFFERENT immutable subject that
 * merely shares an email consumed this user's allowance and blocked their pulls.
 * Failed on main: yes.
 * Protects: legacy email-only rows must still count, or usage is under-billed.
 */

test('OWN-01 a settled job owned by another immutable subject is not charged here', async () => {
  for (const [name, path] of START_PATHS) {
    const foreign = settledFetchJob({ id: 'job_foreign_subject', count: 45 });
    foreign.precision_usage_user_id = 'user_immutable_someone_else';

    const result = await runStartPath(path, {
      body: orderBody({ requested_properties: 50 }),
      fetchJobs: [foreign]
    });
    assert.equal(result.status, 200, name);
    assert.equal(result.createdJob.precision_usage_reserved, FREE_CAP, name);
  }
});

test('OWN-02 a legacy row with no immutable subject is still attributed by email', async () => {
  for (const [name, path] of START_PATHS) {
    const legacy = settledFetchJob({ id: 'job_legacy_email_only', count: 40 });
    delete legacy.precision_usage_user_id;

    const result = await runStartPath(path, {
      body: orderBody({ requested_properties: 50 }),
      fetchJobs: [legacy]
    });
    assert.equal(result.status, 200, name);
    assert.equal(result.createdJob.precision_usage_reserved, FREE_CAP - 40,
      `${name}: legacy usage must still count`);
  }
});

test('OWN-03 the ownership predicate prefers the immutable subject over any email', () => {
  const { precisionJobBelongsToSubject } = loadSharedOrderSafety();

  assert.equal(precisionJobBelongsToSubject({ user_email: '  REP@Example.COM ' }, AUDIT_USER), true,
    'a legacy row is matched case- and whitespace-insensitively');
  assert.equal(
    precisionJobBelongsToSubject(
      { precision_usage_user_id: 'user_immutable_other', user_email: AUDIT_USER.email }, AUDIT_USER),
    false,
    'a matching email never overrides a different immutable subject');
  assert.equal(
    precisionJobBelongsToSubject(
      { precision_usage_user_id: AUDIT_USER.id, user_email: 'changed@example.com' }, AUDIT_USER),
    true,
    'a changed email does not disown a job with a matching immutable subject');
});

test('OWN-04 a foreign immutable subject does not block the pull or get offered for resume', async () => {
  for (const [name, path] of START_PATHS) {
    const foreign = provableActiveJob({ id: 'job_foreign', precision_usage_user_id: 'user_immutable_other' });
    const result = await runStartPath(path, { body: orderBody(), fetchJobs: [foreign] });
    assert.equal(result.status, 200, name);
    assert.equal(result.body.active_job_outcome, 'zero', name);
    assert.equal(result.createdJobs.length, 1, name);
  }
});

/* ════════════════ 5.2 One Precision-job predicate ════════════════
 * Defect prevented: active-job discovery applied no Precision filter, so an
 * unrelated running ZIP/MLS job blocked a Precision pull and was offered for
 * resume. Failed on main: yes.
 */

test('JOB-01 an unrelated non-Precision job never enters Precision active-job resolution', async () => {
  for (const [name, path] of START_PATHS) {
    const unrelated = provableActiveJob({ id: 'job_zip_import' });
    unrelated.mode_tag = 'ZIP_IMPORT';
    unrelated.provider = 'rentcast';

    const result = await runStartPath(path, { body: orderBody(), fetchJobs: [unrelated] });
    assert.equal(result.status, 200, `${name}: a ZIP import must not block a Precision pull`);
    assert.equal(result.body.active_job_outcome, 'zero', name);
    assert.equal(result.createdJobs.length, 1, name);
  }
});

test('JOB-02 the predicate keeps legacy untagged batchdata rows in the Precision set', () => {
  const { isPrecisionJob } = loadSharedOrderSafety();
  assert.equal(isPrecisionJob({ id: 'a', mode_tag: 'PRECISION_TARGET' }), true);
  assert.equal(isPrecisionJob({ id: 'b', provider: 'batchdata' }), true, 'legacy untagged batchdata row');
  assert.equal(isPrecisionJob({ id: 'c' }), true, 'legacy row with neither field');
  assert.equal(isPrecisionJob({ id: 'd', mode_tag: 'ZIP_IMPORT' }), false);
  assert.equal(isPrecisionJob({ id: 'e', provider: 'rentcast' }), false);
  assert.equal(isPrecisionJob(null), false);
});

/* ════════════════ 5.3 Polygon input integrity ════════════════
 * Defect prevented: out-of-range coordinates were accepted, and a malformed
 * vertex was silently dropped — turning an N-point ring into a different
 * (N-1)-point ring. Failed on main: yes.
 * Protects: every currently accepted unusual-but-legal polygon.
 */

for (const [label, polygon] of [
  ['latitude above 90', [{ lat: 200, lng: -83.4 }, { lat: 33.86, lng: -83.38 }, { lat: 33.87, lng: -83.39 }]],
  ['latitude below -90', [{ lat: -91, lng: -83.4 }, { lat: 33.86, lng: -83.38 }, { lat: 33.87, lng: -83.39 }]],
  ['longitude above 180', [{ lat: 33.86, lng: 400 }, { lat: 33.86, lng: -83.38 }, { lat: 33.87, lng: -83.39 }]],
  ['longitude below -180', [{ lat: 33.86, lng: -181 }, { lat: 33.86, lng: -83.38 }, { lat: 33.87, lng: -83.39 }]],
  ['missing coordinate', [{ lat: 33.86 }, { lat: 33.86, lng: -83.38 }, { lat: 33.87, lng: -83.39 }, { lat: 33.88, lng: -83.4 }]],
  ['non-numeric coordinate', [{ lat: 'north', lng: 'west' }, { lat: 33.86, lng: -83.38 }, { lat: 33.87, lng: -83.39 }]]
]) {
  test(`POLY-01 [${label}] rejects the whole polygon`, async () => {
    for (const [name, path] of START_PATHS) {
      const result = await runStartPath(path, { body: orderBody({ polygon }) });
      assert.equal(result.status, 400, `${name}: ${label}`);
      assert.equal(result.body.error, 'invalid_polygon_point', `${name}: ${label}`);
      assert.equal(result.createdJob, null);
    }
  });
}

// NOTE: a self-intersecting ("bow-tie") polygon was previously listed here as
// unusual-but-legal. That was wrong, and was asserted without provider evidence.
// BatchData's geometry engine rejects a crossing boundary before running any
// search, so such a pull fails with an opaque provider 500 after a reservation
// has already been taken. The case now lives in
// test/precision-polygon-simplicity.test.mjs as a REJECTION case.
test('POLY-02 every unusual-but-legal polygon still succeeds, with geometry untouched', async () => {
  const stillValid = [
    ['closed ring', [...SQUARE_MILE_POLYGON, SQUARE_MILE_POLYGON[0]]],
    ['duplicate interior point', [SQUARE_MILE_POLYGON[0], SQUARE_MILE_POLYGON[1], SQUARE_MILE_POLYGON[1], SQUARE_MILE_POLYGON[2]]],
    ['reversed winding', [...SQUARE_MILE_POLYGON].reverse()],
    ['string coordinates', SQUARE_MILE_POLYGON.map((p) => ({ lat: String(p.lat), lng: String(p.lng) }))],
    ['boundary latitude 90', [{ lat: 90, lng: 0 }, { lat: 89, lng: 1 }, { lat: 89, lng: -1 }]],
    ['boundary longitude -180', [{ lat: 33.86, lng: -180 }, { lat: 33.87, lng: -179 }, { lat: 33.88, lng: -179.5 }]]
  ];
  for (const [label, polygon] of stillValid) {
    const result = await runStartPath(PATHS.startBatchDataPull, { body: orderBody({ polygon }) });
    assert.equal(result.status, 200, `${label} must remain accepted`);
    assert.equal(result.createdJob.polygon.length, polygon.length,
      `${label}: no reorder, dedupe, closure or rewinding`);
  }
});

test('POLY-03 the persisted polygon, hash, centroid and area are unchanged for a valid ring', async () => {
  const result = await runStartPath(PATHS.startBatchDataPull, { body: orderBody() });
  assert.deepEqual(result.createdJob.polygon, SQUARE_MILE_POLYGON.map((p) => ({ lat: p.lat, lng: p.lng })));
  assert.equal(result.createdJob.polygon_hash.length, 16);
  assert.equal(result.createdJob.area_sq_mi, 1);
  assert.equal(result.createdJob.latitude, 33.86725);
});

/* ════════════════ 5.4 Explicit count validation ════════════════
 * Defect prevented: 0/negative/fractional/non-numeric silently meant "max
 * available", and fractions produced fractional reservations.
 * Failed on main: yes.
 * Protects: absent values keep their established meaning.
 */

for (const [label, value] of [
  ['zero', 0], ['negative', -5], ['fraction', 25.7],
  ['non-numeric string', 'twenty'], ['boolean', true], ['object', { count: 5 }]
]) {
  test(`COUNT-01 [${label}] is rejected, not reinterpreted`, async () => {
    for (const [name, path] of START_PATHS) {
      const result = await runStartPath(path, { body: orderBody({ requested_properties: value }) });
      assert.equal(result.status, 400, `${name}: ${label}`);
      assert.equal(result.body.error, 'invalid_requested_properties', `${name}: ${label}`);
      assert.equal(result.createdJob, null);
    }
  });
}

for (const [label, mutate] of [
  ['undefined', (body) => { delete body.requested_properties; }],
  ['null', (body) => { body.requested_properties = null; }],
  ['empty form value', (body) => { body.requested_properties = ''; }]
]) {
  test(`COUNT-02 [absent: ${label}] keeps its established meaning`, async () => {
    for (const [name, path] of START_PATHS) {
      const body = orderBody();
      mutate(body);
      const result = await runStartPath(path, { body });
      assert.equal(result.status, 200, `${name}: ${label}`);
      assert.equal(result.createdJob.precision_usage_reserved, FREE_CAP, `${name}: ${label}`);
    }
  });
}

test('COUNT-03 a valid integer is honoured and capped exactly as before', async () => {
  for (const [name, path] of START_PATHS) {
    const plain = await runStartPath(path, { body: orderBody({ requested_properties: 25 }) });
    assert.equal(plain.createdJob.precision_usage_reserved, 25, name);

    const capped = await runStartPath(path, {
      body: orderBody({ requested_properties: 45 }),
      fetchJobs: [settledFetchJob({ id: 'job_prior', count: 30 })]
    });
    assert.equal(capped.createdJob.precision_usage_reserved, 20, `${name}: fixed capping unchanged`);
    assert.equal(capped.createdJob.dry_run_metadata.limited_by_free_home_cap, true, name);
    assert.equal(Number.isInteger(capped.createdJob.precision_usage_reserved), true);
  }
});

/* ════════════════ 5.5 Server-authoritative Max Available ════════════════
 * Defect prevented: the browser's number was the hard ceiling, so Max Available
 * silently under-delivered when the allowance had grown.
 * Failed on main: yes.
 * Protects: Fixed Count behaviour, and the allowance cap itself.
 */

test('MAX-01 a browser number BELOW the locked allowance does not cap the order', async () => {
  const result = await runStartPath(PATHS.startBatchDataPull, {
    user: paidUser,
    subscriptions: [paidSubscription({})],
    body: orderBody({ requested_properties: 400, count_mode: 'max_available' })
  });
  assert.equal(result.status, 200);
  assert.equal(result.createdJob.precision_usage_reserved, 1000,
    'the server had 1000 available; the stale browser number no longer wins');
});

test('MAX-02 a browser number ABOVE the locked allowance is still capped by the server', async () => {
  const result = await runStartPath(PATHS.startBatchDataPull, {
    body: orderBody({ requested_properties: 5000, count_mode: 'max_available' }),
    fetchJobs: [settledFetchJob({ id: 'job_consumed', count: 35 })]
  });
  assert.equal(result.status, 200);
  assert.equal(result.createdJob.precision_usage_reserved, 15);
});

test('MAX-03 partial remaining allowance resolves to exactly that remainder', async () => {
  const result = await runStartPath(PATHS.startBatchDataPull, {
    body: orderBody({ requested_properties: 50, count_mode: 'max_available' }),
    fetchJobs: [settledFetchJob({ id: 'job_prior', count: 20 })]
  });
  assert.equal(result.createdJob.precision_usage_reserved, 30);
  assert.equal(result.createdJob.dry_run_metadata.count_mode, 'max_available');
});

test('MAX-04 zero remaining allowance fails closed rather than reserving', async () => {
  const result = await runStartPath(PATHS.startBatchDataPull, {
    body: orderBody({ requested_properties: 50, count_mode: 'max_available' }),
    fetchJobs: [settledFetchJob({ id: 'job_full', count: FREE_CAP })]
  });
  assert.equal(result.status, 403);
  assert.equal(result.createdJob, null);
});

test('MAX-05 concurrent Max Available starts cannot over-reserve', async () => {
  const result = await runConcurrentStarts({
    paths: [PATHS.startBatchDataPull, PATHS.startBatchDataPull],
    bodies: [
      orderBody({ requested_properties: 50, count_mode: 'max_available' }),
      orderBody({ requested_properties: 50, count_mode: 'max_available' })
    ],
    fetchJobs: [settledFetchJob({ id: 'job_prior', count: 45 })]
  });
  assert.equal(result.createdJobs.length, 1, 'exactly one job is created');
  const reserved = result.createdJobs.reduce((sum, job) => sum + job.precision_usage_reserved, 0);
  assert.equal(reserved, 5, 'only the 5 remaining units are reserved');
  assert.ok(45 + reserved <= FREE_CAP, 'the free cap is never exceeded');
});

/* ════════════════ 5.6 Criteria-aware active-job resolution ════════════════
 * Defect prevented: an active job was resumed WITHOUT comparing criteria, and
 * its polygon/count/price replaced the user's actual order.
 * Failed on main: yes.
 */

test('ACTIVE-01 zero active jobs creates exactly one job', async () => {
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, {
      body: orderBody(),
      fetchJobs: [settledFetchJob({ id: 'job_done', count: 5 })]
    });
    assert.equal(result.status, 200, name);
    assert.equal(result.body.active_job_outcome, 'zero', name);
    assert.equal(result.createdJobs.length, 1, name);
  }
});

test('ACTIVE-02 an exact match resumes that job and creates nothing', async () => {
  // The active job is built with the minimum-value default the path under test
  // actually applies, because the two start paths still disagree on it. That
  // divergence is a deferred product decision, not something this PR resolves —
  // see ACTIVE-02b for the consequence it now has.
  const pathMinPrice = { startBatchDataPull: null, fetchAreaProperties: 100000 };

  for (const [name, path] of START_PATHS) {
    const active = provableActiveJob({ id: 'job_identical' });
    active.dry_run_metadata.filters = { min_price: pathMinPrice[name], max_price: null };

    const result = await runStartPath(path, {
      body: orderBody({ requested_properties: 25 }),
      fetchJobs: [active]
    });
    assert.equal(result.status, 200, name);
    assert.equal(result.body.active_job_outcome, 'one_exact_match', name);
    assert.equal(result.body.job_id, 'job_identical', name);
    assert.equal(result.createdJob, null, name);
    assert.deepEqual(result.trace.writes, [], `${name}: nothing is mutated`);
  }
});

test('ACTIVE-02b the unresolved minimum-value divergence now surfaces as an explicit conflict', async () => {
  // A job started by startBatchDataPull (no price floor) and resubmitted through
  // fetchAreaProperties (which defaults to $100,000) really is a different
  // order. Before this change it resumed silently with the WRONG criteria; it
  // now fails closed and names the field. This does NOT resolve the underlying
  // product decision — see docs/precision/PR_A_DEFERRED_DECISIONS.md.
  const startedElsewhere = provableActiveJob({ id: 'job_started_elsewhere' });
  startedElsewhere.dry_run_metadata.filters = { min_price: null, max_price: null };

  const result = await runStartPath(PATHS.fetchAreaProperties, {
    body: orderBody({ requested_properties: 25 }),
    fetchJobs: [startedElsewhere]
  });
  assert.equal(result.status, 409);
  assert.deepEqual(result.body.mismatched_fields, ['min_price']);
  assert.equal(result.createdJob, null);
  assert.deepEqual(result.trace.writes, []);
});

test('ACTIVE-03 a conflicting order returns 409 and mutates nothing', async () => {
  const conflicting = provableActiveJob({
    id: 'job_unrelated',
    polygon: TRIANGLE_POLYGON.map((p) => ({ ...p })),
    sold_months: 12,
    dry_run_metadata: {
      requested_properties: 5,
      count_mode: 'fixed',
      filters: { min_price: 500000, max_price: 900000 },
      route_filters: { propertyTypes: ['Single Family'], excludeCommercial: true, excludeCondos: true, excludeLand: true },
      route_bounds: { enabled: false },
      ownership_range_mode: 'quick',
      ownership_range_days: null,
      repull_mode: 'new_area'
    }
  });

  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, {
      body: orderBody({ requested_properties: 40, sold_months: 3 }),
      fetchJobs: [{ ...conflicting }]
    });
    assert.equal(result.status, 409, name);
    assert.equal(result.body.error, 'active_job_criteria_conflict', name);
    assert.equal(result.body.active_job_outcome, 'one_conflict', name);
    assert.ok(result.body.mismatched_fields.length > 0, `${name}: names what differs`);
    assert.equal(result.createdJob, null, name);
    assert.deepEqual(result.trace.writes, [], `${name}: nothing cancelled or created`);
  }
});

test('ACTIVE-04 multiple active jobs return 409 without selecting one', async () => {
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, {
      body: orderBody({ requested_properties: 25 }),
      fetchJobs: [
        provableActiveJob({ id: 'job_a' }),
        provableActiveJob({ id: 'job_b', created_date: new Date(FIXED_NOW_MS - 10_000).toISOString() })
      ]
    });
    assert.equal(result.status, 409, name);
    assert.equal(result.body.active_job_outcome, 'multiple_active', name);
    assert.equal(result.body.active_job_count, 2, name);
    assert.equal(result.createdJob, null, name);
    assert.deepEqual(result.trace.writes, [], `${name}: nothing is mutated`);
  }
});

test('ACTIVE-05 a legacy job whose order cannot be proven is never silently resumed', async () => {
  // A job created by the secondary start path never persisted repull_mode, so
  // whether it was a new-area pull or a refresh is unknowable. Missing fields
  // are NOT assumed to match.
  const legacy = provableActiveJob({ id: 'job_legacy' });
  delete legacy.dry_run_metadata.repull_mode;

  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, {
      body: orderBody({ requested_properties: 25 }),
      fetchJobs: [{ ...legacy, dry_run_metadata: { ...legacy.dry_run_metadata } }]
    });
    assert.equal(result.status, 409, name);
    assert.equal(result.body.error, 'legacy_active_job_unverifiable', name);
    assert.equal(result.body.active_job_outcome, 'one_unverifiable', name);
    assert.deepEqual(result.body.unprovable_fields, ['repull_mode'], name);
    assert.equal(result.createdJob, null, name);
    assert.deepEqual(result.trace.writes, [], `${name}: the legacy job is NOT auto-cancelled`);
  }
});

test('ACTIVE-06 an active job with no stored polygon_hash is still provable from its polygon', async () => {
  const legacy = provableActiveJob({ id: 'job_no_hash' });
  delete legacy.polygon_hash;

  const result = await runStartPath(PATHS.startBatchDataPull, {
    body: orderBody({ requested_properties: 25 }),
    fetchJobs: [legacy]
  });
  assert.equal(result.status, 200, 'the hash is recomputed rather than treated as unknown');
  assert.equal(result.body.active_job_outcome, 'one_exact_match');
});

/* ════════════════ 5.7 No client-authorized cancellation ════════════════
 * Defect prevented: a client-supplied force_full_refresh destroyed a healthy
 * server-owned job. Failed on main: yes.
 */

test('CANCEL-01 force_full_refresh cannot cancel a healthy active job', async () => {
  const healthy = provableActiveJob({ id: 'job_healthy', progress_pct: 5 });
  const result = await runStartPath(PATHS.startBatchDataPull, {
    body: orderBody({ requested_properties: 25, force_full_refresh: true }),
    fetchJobs: [{ ...healthy }]
  });
  assert.deepEqual(result.trace.writes.filter((e) => e.name === 'FetchJob.update'), [],
    'a client flag is not cancellation authority');
  assert.equal(result.status, 200);
  assert.equal(result.body.active_job_outcome, 'one_exact_match');
});

test('CANCEL-02 a STALE conflicting job is not auto-cancelled either', async () => {
  // Removed deliberately: cancellation and reservation lifecycle belong in a
  // focused follow-up, designed and tested together.
  const staleAt = new Date(FIXED_NOW_MS - 10 * 60 * 1000).toISOString();
  const stale = provableActiveJob({
    id: 'job_stale_conflict',
    progress_pct: 42,
    created_date: staleAt,
    started_at: staleAt,
    sold_months: 12
  });

  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, {
      body: orderBody({ requested_properties: 25, sold_months: 3, force_full_refresh: true }),
      fetchJobs: [{ ...stale, dry_run_metadata: { ...stale.dry_run_metadata } }]
    });
    assert.equal(result.status, 409, name);
    assert.deepEqual(result.trace.writes, [], `${name}: no cancellation, no reservation release`);
    assert.equal(result.createdJob, null, name);
  }
});

/* ════════════════ 5.8 Preview transport containment ════════════════
 * Defect prevented: a provider transport failure returned 500 and destroyed a
 * Preview whose local estimate was still valid. Failed on main: yes.
 */

function buildPreview({ env = {}, fetchResponder = null } = {}) {
  const trace = new Trace();
  const base44 = makeBase44({
    trace,
    user: AUDIT_USER,
    invokeHandlers: {
      getPrecisionUsage: async () => ({
        data: {
          success: true, complete: true, version: 2, limit: 50, used: 10, reserved: 0,
          meter_used: 10, remaining: 40, lifetime_used: 10, paid_access: false
        }
      })
    }
  });
  const { handler } = loadPrecisionHandler(PATHS.previewBatchDataArea, {
    trace, base44, stripeApi: makeStripe(trace, {}), env, fetchResponder
  });
  return { handler, trace };
}

const previewBody = () => ({
  polygon: SQUARE_MILE_POLYGON.map((p) => ({ ...p })),
  requested_properties: 40,
  sandbox: true,
  sandbox_probe: true
});

test('PREVIEW-01 a provider transport failure degrades instead of destroying the estimate', async () => {
  const { handler } = buildPreview({
    env: { BATCH_DATA_SANDBOX_KEY: 'sandbox_key_value' },
    fetchResponder: async (url) => {
      if (url.includes('geo.fcc.gov')) {
        return new Response(JSON.stringify({ County: { FIPS: '13221' }, State: { code: 'GA' } }), {
          status: 200, headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error('ECONNRESET');
    }
  });

  const result = await callHandler(handler, previewBody());
  assert.equal(result.status, 200, 'the local estimate survives');
  assert.equal(result.body.sandbox_probe, null);
  assert.equal(result.body.sandbox_probe_error, 'provider_unreachable');
  assert.equal(result.body.area_sq_mi, 1);
  assert.equal(result.body.county_resolution.fips_code, '13221');
});

test('PREVIEW-02 the probe never claims to have measured the area', async () => {
  const { handler } = buildPreview({
    env: { BATCH_DATA_SANDBOX_KEY: 'sandbox_key_value' },
    fetchResponder: async (url) => new Response(
      JSON.stringify(url.includes('geo.fcc.gov')
        ? { County: { FIPS: '13221' }, State: { code: 'GA' } }
        : { results: { properties: [] } }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  });
  const result = await callHandler(handler, previewBody());
  assert.equal(result.body.availability_measured, false);
  assert.equal(result.body.sandbox_probe.record_count, 0);
});

test('PREVIEW-03 no new provider call is introduced and the request shape is unchanged', async () => {
  const { handler, trace } = buildPreview({
    env: { BATCH_DATA_SANDBOX_KEY: 'sandbox_key_value' },
    fetchResponder: async (url) => new Response(
      JSON.stringify(url.includes('geo.fcc.gov')
        ? { County: { FIPS: '13221' }, State: { code: 'GA' } }
        : { results: { properties: [{}] } }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  });
  await callHandler(handler, previewBody());

  const providerCalls = trace.externalFetches.filter((e) => e.detail.host === 'api.batchdata.com');
  assert.equal(providerCalls.length, 1, 'still exactly one probe per Preview');
  assert.deepEqual(JSON.parse(providerCalls[0].detail.body), {
    searchCriteria: { query: '33.86725,-83.39125' },
    options: { datasets: ['basic'], limit: 5 }
  }, 'request shape, centroid query and dataset selection are unchanged');
});

/* ════════════════ Regression guards ════════════════
 * These protect behaviour that already works and must not change.
 */

test('KEEP-01 the Fixed Count happy path is unchanged end to end', async () => {
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, { body: orderBody({ requested_properties: 25 }) });
    assert.equal(result.status, 200, name);
    assert.equal(result.createdJob.precision_usage_reserved, 25, name);
    assert.equal(result.createdJob.dry_run_metadata.requested_properties_before_cap, 25, name);
    assert.equal(result.createdJob.dry_run_metadata.count_mode, 'fixed', name);
    assert.equal(result.createdJob.status, 'pending', name);
  }
});

test('KEEP-02 quick and custom sold-date ranges are unchanged', async () => {
  for (const [name, path] of START_PATHS) {
    const quick = await runStartPath(path, { body: orderBody({ sold_months: 6 }) });
    assert.equal(quick.createdJob.sold_months, 6, name);
    assert.equal(quick.createdJob.dry_run_metadata.ownership_range_mode, 'quick', name);

    const custom = await runStartPath(path, {
      user: paidUser,
      subscriptions: [paidSubscription({})],
      body: orderBody({ ownership_range_mode: 'custom', ownership_min_days: 59, ownership_max_days: 365 })
    });
    assert.equal(custom.createdJob.sold_months, 12, `${name}: derived from the maximum, unchanged`);
    assert.deepEqual(custom.createdJob.dry_run_metadata.ownership_range_days, { min: 59, max: 365 }, name);
  }
});

test('KEEP-03 route bounds are unchanged and still carry coordinates only', async () => {
  const result = await runStartPath(PATHS.startBatchDataPull, {
    body: orderBody({
      route_bounds: {
        enabled: true,
        mode: 'current_to_home',
        startLocation: { lat: 33.951, lng: -83.357, address: '123 Private Street' },
        endLocation: { lat: 33.9, lng: -83.4 }
      }
    })
  });
  assert.deepEqual(result.createdJob.dry_run_metadata.route_bounds, {
    enabled: true,
    mode: 'current_to_home',
    start_location: { lat: 33.951, lng: -83.357 },
    end_location: { lat: 33.9, lng: -83.4 }
  });
  assert.ok(!JSON.stringify(result.createdJob).includes('Private Street'));
});

test('KEEP-04 reservation and FetchJob remain one atomic write, processor invoked once', async () => {
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, { body: orderBody({ requested_properties: 20 }) });
    assert.deepEqual(result.trace.writes.map((e) => e.name), ['FetchJob.create'],
      `${name}: no separate reservation record and no second write`);
    assert.equal(result.trace.invocations.length, 1, `${name}: processor invoked exactly once`);
    assert.equal(result.createdJob.precision_usage_reserved, 20, name);
    assert.equal(result.createdJob.total_expected, 20, name);
  }
});

test('KEEP-05 the minimum-value default divergence is deliberately unchanged', async () => {
  // Documented, not fixed: resolving it is a product decision.
  const viaStart = await runStartPath(PATHS.startBatchDataPull, { body: orderBody({ min_price: null }) });
  const viaArea = await runStartPath(PATHS.fetchAreaProperties, { body: orderBody({ min_price: null }) });
  assert.equal(viaStart.createdJob.dry_run_metadata.filters.min_price, null);
  assert.equal(viaArea.createdJob.dry_run_metadata.filters.min_price, 100000);
});

test('KEEP-06 no criteria snapshot or schema-version claim is written', async () => {
  // The canonical PR A -> PR #66 snapshot is deferred until the minimum-value
  // contract is resolved. Nothing here may claim schema-v1 validity.
  for (const [name, path] of START_PATHS) {
    const metadata = (await runStartPath(path, { body: orderBody() })).createdJob.dry_run_metadata;
    assert.equal(metadata.precision_criteria, undefined, name);
    assert.equal(metadata.precision_criteria_withheld, undefined, name);
    assert.equal(metadata.criteria_schema_version, undefined, name);
    assert.equal(metadata.provider_contract_version, undefined, name);
  }
});
