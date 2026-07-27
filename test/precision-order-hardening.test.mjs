// MODEL 2 / PR A — hardening contract tests.
//
// Every test here FAILED against unmodified origin/main@03adf5cd before the
// corresponding change was implemented. Each names the Model 1 finding it
// derives from and the Model 2 adjudication that accepted it.
//
// Model 1's characterization suite (test/precision-order-stage*.test.mjs)
// pins CURRENT behaviour. This file pins the HARDENED contract. Where the two
// disagree, the characterization test was updated and the change is recorded
// in docs/precision/pr-a/CHANGE_LEDGER.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDIT_USER,
  FIXED_NOW_MS,
  PATHS,
  START_PATHS,
  SQUARE_MILE_POLYGON,
  activeFetchJob,
  orderBody,
  paidSubscription,
  runStartPath,
  settledFetchJob
} from './helpers/precisionOrderHarness.mjs';

const FREE_CAP = 50;
const paidUser = { ...AUDIT_USER, stripe_customer_id: 'cus_1' };

/* ══════════════════ Stage 0 — ADJ-M2-001 / F-PRA-003 ══════════════════
 * Cross-subject allowance attribution.
 * Before: getPrecisionJobs unioned {precision_usage_user_id} with {user_email},
 * so a job owned by a DIFFERENT immutable subject was charged to this user.
 * After: email is a fallback for rows that have no immutable subject only.
 */

test('ADJ-M2-001 a settled job owned by another immutable subject is NOT charged to this user', async () => {
  for (const [name, path] of START_PATHS) {
    const foreign = settledFetchJob({ id: 'job_foreign_subject', count: 45 });
    foreign.precision_usage_user_id = 'user_immutable_someone_else';

    const result = await runStartPath(path, {
      body: orderBody({ requested_properties: 50 }),
      fetchJobs: [foreign]
    });

    assert.equal(result.status, 200, name);
    assert.equal(result.createdJob.precision_usage_reserved, FREE_CAP,
      `${name}: another subject's usage must not consume this user's allowance`);
  }
});

test('ADJ-M2-001 a legacy row with NO immutable subject is still attributed by email', async () => {
  for (const [name, path] of START_PATHS) {
    const legacy = settledFetchJob({ id: 'job_legacy_email_only', count: 40 });
    delete legacy.precision_usage_user_id;

    const result = await runStartPath(path, {
      body: orderBody({ requested_properties: 50 }),
      fetchJobs: [legacy]
    });

    assert.equal(result.status, 200, name);
    assert.equal(result.createdJob.precision_usage_reserved, FREE_CAP - 40,
      `${name}: legacy email-only rows must still count, or usage would be under-billed`);
  }
});

test('ADJ-M2-001 the ownership predicate itself is case- and whitespace-tolerant', async () => {
  // Scope note: the FetchJob *query* is an exact-match filter, so a row whose
  // stored email differs in case is never fetched in the first place. What this
  // pins is the ownership DECISION applied to rows that are fetched, which is
  // where a naive `===` would wrongly disown a legacy row.
  const { loadSharedOrderContract } = await import('./helpers/precisionOrderHarness.mjs');
  const { precisionJobBelongsToSubject } = loadSharedOrderContract();

  const legacyRow = { user_email: '  REP@Example.COM ' };
  assert.equal(precisionJobBelongsToSubject(legacyRow, AUDIT_USER), true);

  const foreignRow = { precision_usage_user_id: 'user_immutable_other', user_email: AUDIT_USER.email };
  assert.equal(precisionJobBelongsToSubject(foreignRow, AUDIT_USER), false,
    'an immutable subject always wins over a matching email');

  const ownRow = { precision_usage_user_id: AUDIT_USER.id, user_email: 'someone-else@example.com' };
  assert.equal(precisionJobBelongsToSubject(ownRow, AUDIT_USER), true,
    'and a changed email does not disown a job with a matching immutable subject');
});

/* ══════════════════ Stage 1 — ADJ-M2-002 / F-PRA-008, F-PRA-012 ══════════════════
 * Polygon vertices were not range-validated. `normalizeRoutePoint` in the same
 * file already enforces the bounds; polygon vertices did not.
 */

const OUT_OF_RANGE_POLYGONS = [
  ['latitude above 90', [{ lat: 200, lng: -83.40 }, { lat: 33.86, lng: -83.38 }, { lat: 33.87, lng: -83.39 }]],
  ['latitude below -90', [{ lat: -91, lng: -83.40 }, { lat: 33.86, lng: -83.38 }, { lat: 33.87, lng: -83.39 }]],
  ['longitude above 180', [{ lat: 33.86, lng: 400 }, { lat: 33.86, lng: -83.38 }, { lat: 33.87, lng: -83.39 }]],
  ['longitude below -180', [{ lat: 33.86, lng: -181 }, { lat: 33.86, lng: -83.38 }, { lat: 33.87, lng: -83.39 }]]
];

for (const [label, polygon] of OUT_OF_RANGE_POLYGONS) {
  test(`ADJ-M2-002 [${label}] is rejected with invalid_polygon_point on both paths`, async () => {
    for (const [name, path] of START_PATHS) {
      const result = await runStartPath(path, { body: orderBody({ polygon }) });
      assert.equal(result.status, 400, `${name}: ${label}`);
      assert.equal(result.body.error, 'invalid_polygon_point', `${name}: ${label}`);
      assert.equal(result.createdJob, null);
    }
  });
}

test('ADJ-M2-002 a malformed vertex is reported, not silently dropped', async () => {
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, {
      body: orderBody({
        polygon: [
          { lat: 33.860, lng: -83.400 },
          { lat: 33.860 },
          { lat: 33.870, lng: -83.390 },
          { lat: 33.874, lng: -83.382 }
        ]
      })
    });
    assert.equal(result.status, 400, `${name}: a 4-point ring with one bad vertex must not become a 3-point ring`);
    assert.equal(result.body.error, 'invalid_polygon_point');
  }
});

test('ADJ-M2-002 every valid polygon accepted before is still accepted, byte-identically', async () => {
  // Guards against the validation being too aggressive. These shapes are all
  // odd but legal, and Model 1 proved they were accepted on main.
  const stillValid = [
    ['closed ring', [...SQUARE_MILE_POLYGON, SQUARE_MILE_POLYGON[0]]],
    ['duplicate interior point', [SQUARE_MILE_POLYGON[0], SQUARE_MILE_POLYGON[1], SQUARE_MILE_POLYGON[1], SQUARE_MILE_POLYGON[2]]],
    ['reversed winding', [...SQUARE_MILE_POLYGON].reverse()],
    ['string coordinates', SQUARE_MILE_POLYGON.map((p) => ({ lat: String(p.lat), lng: String(p.lng) }))],
    ['self-intersecting', [{ lat: 33.86, lng: -83.40 }, { lat: 33.87, lng: -83.38 }, { lat: 33.86, lng: -83.38 }, { lat: 33.87, lng: -83.40 }]],
    ['boundary latitude 90', [{ lat: 90, lng: 0 }, { lat: 89, lng: 1 }, { lat: 89, lng: -1 }]],
    ['boundary longitude -180', [{ lat: 33.86, lng: -180 }, { lat: 33.87, lng: -179 }, { lat: 33.88, lng: -179.5 }]]
  ];
  for (const [label, polygon] of stillValid) {
    const result = await runStartPath(PATHS.startBatchDataPull, { body: orderBody({ polygon }) });
    assert.equal(result.status, 200, `${label} must remain accepted`);
    assert.equal(result.createdJob.polygon.length, polygon.length, `${label}: every vertex preserved`);
  }
});

/* ══════════════════ Stage 2 — ADJ-M2-003 / F-PRA-016, F-PRA-017 ══════════════════
 * Invalid counts silently meant "max available"; decimals were reserved as-is.
 */

const INVALID_COUNTS = [
  ['zero', 0],
  ['negative', -5],
  ['fractional', 25.7],
  ['non-numeric string', 'twenty'],
  ['boolean', true],
  ['object', { count: 5 }]
];

for (const [label, value] of INVALID_COUNTS) {
  test(`ADJ-M2-003 [${label}] requested_properties is rejected, not reinterpreted`, async () => {
    for (const [name, path] of START_PATHS) {
      const result = await runStartPath(path, { body: orderBody({ requested_properties: value }) });
      assert.equal(result.status, 400, `${name}: ${label}`);
      assert.equal(result.body.error, 'invalid_requested_properties', `${name}: ${label}`);
      assert.equal(result.createdJob, null);
    }
  });
}

test('ADJ-M2-003 an OMITTED count is still valid and means "the plan maximum"', async () => {
  // Distinguishing absent from invalid is the point: absent is a real client
  // shape (Max Available), 0 and "twenty" are not.
  for (const [name, path] of START_PATHS) {
    const body = orderBody();
    delete body.requested_properties;
    const result = await runStartPath(path, { body });
    assert.equal(result.status, 200, name);
    assert.equal(result.createdJob.precision_usage_reserved, FREE_CAP);
  }
});

test('ADJ-M2-003 an integral count is unaffected', async () => {
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, { body: orderBody({ requested_properties: 25 }) });
    assert.equal(result.status, 200, name);
    assert.equal(result.createdJob.precision_usage_reserved, 25);
    assert.equal(Number.isInteger(result.createdJob.precision_usage_reserved), true);
  }
});

/* ══════════════════ Stage 2 — ADJ-M2-004 / F-PRA-018 ══════════════════
 * Max Available was resolved in the browser and never recomputed under the
 * lock, so it under-delivered whenever the allowance grew after the read.
 */

test('ADJ-M2-004 max_available reserves the LOCKED remaining allowance, ignoring the stale browser number', async () => {
  const result = await runStartPath(PATHS.startBatchDataPull, {
    user: paidUser,
    subscriptions: [paidSubscription({})],
    body: orderBody({ requested_properties: 400, count_mode: 'max_available' })
  });
  assert.equal(result.status, 200);
  assert.equal(result.createdJob.precision_usage_reserved, 1000,
    'the server had 1000 available; the browser said 400; the server is authoritative');
  assert.equal(result.createdJob.dry_run_metadata.count_mode, 'max_available');
});

test('ADJ-M2-004 max_available still cannot exceed the locked allowance', async () => {
  const result = await runStartPath(PATHS.startBatchDataPull, {
    body: orderBody({ requested_properties: 50, count_mode: 'max_available' }),
    fetchJobs: [settledFetchJob({ id: 'job_consumed', count: 35 })]
  });
  assert.equal(result.status, 200);
  assert.equal(result.createdJob.precision_usage_reserved, 15);
});

test('ADJ-M2-004 max_available records the locked allowance as the entered count', async () => {
  const result = await runStartPath(PATHS.startBatchDataPull, {
    body: orderBody({ requested_properties: 10, count_mode: 'max_available' })
  });
  // entered_count must equal effective_count for max_available: the user asked
  // for "everything", and everything is what the lock said.
  assert.equal(result.createdJob.dry_run_metadata.requested_properties_before_cap, FREE_CAP);
  assert.equal(result.createdJob.precision_usage_reserved, FREE_CAP);
  assert.equal(result.createdJob.dry_run_metadata.limited_by_free_home_cap, false,
    'max_available is never "capped" — the allowance IS the request');
});

test('ADJ-M2-004 fixed mode is unchanged by the max_available fix', async () => {
  const result = await runStartPath(PATHS.startBatchDataPull, {
    body: orderBody({ requested_properties: 45, count_mode: 'fixed' }),
    fetchJobs: [settledFetchJob({ id: 'job_prior', count: 30 })]
  });
  assert.equal(result.createdJob.dry_run_metadata.requested_properties_before_cap, 45);
  assert.equal(result.createdJob.precision_usage_reserved, 20);
  assert.equal(result.createdJob.dry_run_metadata.limited_by_free_home_cap, true);
});

/* ══════════════════ Stage 4 — ADJ-M2-005 / F-PRA-036 ══════════════════
 * An active job with unrelated criteria was resumed as if it were the order.
 */

test('ADJ-M2-005 an active job with different criteria returns 409, not a silent resume', async () => {
  const conflicting = activeFetchJob({
    id: 'job_unrelated',
    precision_usage_reserved: 1,
    total_expected: 1,
    sold_months: 12,
    dry_run_metadata: {
      requested_properties: 5,
      requested_properties_before_cap: 5,
      count_mode: 'fixed',
      filters: { min_price: 500000, max_price: 900000 },
      ownership_range_mode: 'quick',
      ownership_range_days: null,
      route_bounds: { enabled: false }
    }
  });

  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, {
      body: orderBody({ requested_properties: 40, sold_months: 3 }),
      fetchJobs: [{ ...conflicting }]
    });
    assert.equal(result.status, 409, `${name}: a different order must not be silently replaced`);
    assert.equal(result.body.error, 'active_job_criteria_conflict');
    assert.equal(result.body.active_job_outcome, 'one_conflict');
    assert.equal(result.body.active_job_id, 'job_unrelated');
    assert.ok(Array.isArray(result.body.mismatched_fields) && result.body.mismatched_fields.length > 0,
      `${name}: the response must name what differs`);
    assert.equal(result.createdJob, null, `${name}: nothing is created`);
    assert.deepEqual(result.trace.writes, [], `${name}: and nothing is mutated`);
  }
});

test('ADJ-M2-005 an EXACT-match active job is still resumed', async () => {
  // The active job is built with the SAME minimum-value default the path under
  // test applies, because the two start paths still disagree on that default
  // (Model 1 F-PRA-020, unresolved PRODUCT_DECISION owned by PR #66). See
  // ADJ-M2-005b for the cross-path consequence that disagreement now has.
  const pathMinPrice = { startBatchDataPull: null, fetchAreaProperties: 100000 };

  for (const [name, path] of START_PATHS) {
    const active = activeFetchJob({ id: 'job_identical', precision_usage_reserved: 1, total_expected: 1 });
    active.dry_run_metadata.filters = { min_price: pathMinPrice[name], max_price: null };

    const result = await runStartPath(path, {
      body: orderBody({ requested_properties: 25 }),
      fetchJobs: [active]
    });
    assert.equal(result.status, 200, name);
    assert.equal(result.body.status, 'already_running');
    assert.equal(result.body.active_job_outcome, 'one_exact_match');
    assert.equal(result.body.job_id, 'job_identical');
    assert.equal(result.createdJob, null);
  }
});

test('ADJ-M2-005b NEW FINDING: the unresolved min_price divergence now surfaces as an explicit cross-path conflict', async () => {
  // A job started by startBatchDataPull (min_price null) and then re-submitted
  // through fetchAreaProperties (min_price defaults to 100000) is a genuinely
  // different order. Before PR A this silently resumed with the WRONG criteria;
  // now it fails closed and names the field. This is a visible behaviour change
  // and it does NOT resolve the underlying product decision.
  const startedByOtherPath = activeFetchJob({ id: 'job_started_elsewhere', precision_usage_reserved: 1, total_expected: 1 });
  startedByOtherPath.dry_run_metadata.filters = { min_price: null, max_price: null };

  const result = await runStartPath(PATHS.fetchAreaProperties, {
    body: orderBody({ requested_properties: 25 }),
    fetchJobs: [startedByOtherPath]
  });

  assert.equal(result.status, 409);
  assert.deepEqual(result.body.mismatched_fields, ['min_price'],
    'the conflict is reported precisely, not as a generic failure');
  assert.equal(result.createdJob, null);
});

test('ADJ-M2-005 zero active jobs reports the outcome explicitly and proceeds', async () => {
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, { body: orderBody() });
    assert.equal(result.status, 200, name);
    assert.equal(result.body.active_job_outcome, 'zero');
    assert.equal(result.createdJobs.length, 1);
  }
});

test('ADJ-M2-005 multiple active jobs are reported, never silently reduced to one', async () => {
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, {
      body: orderBody({ requested_properties: 20 }),
      fetchJobs: [
        activeFetchJob({ id: 'job_a', precision_usage_reserved: 1, total_expected: 1 }),
        activeFetchJob({ id: 'job_b', precision_usage_reserved: 1, total_expected: 1, created_date: new Date(FIXED_NOW_MS - 10_000).toISOString() })
      ]
    });
    assert.equal(result.status, 409, name);
    assert.equal(result.body.active_job_outcome, 'multiple_active');
    assert.equal(result.body.active_job_count, 2);
    assert.equal(result.createdJob, null);
  }
});

test('ADJ-M2-005 an active job owned by another immutable subject does not block this user', async () => {
  for (const [name, path] of START_PATHS) {
    const foreign = activeFetchJob({
      id: 'job_foreign',
      precision_usage_user_id: 'user_immutable_other',
      precision_usage_reserved: 1,
      total_expected: 1
    });
    const result = await runStartPath(path, { body: orderBody(), fetchJobs: [foreign] });
    assert.equal(result.status, 200, `${name}: ownership is re-verified by immutable subject`);
    assert.equal(result.body.active_job_outcome, 'zero');
    assert.equal(result.createdJobs.length, 1);
  }
});

/* ══════════════════ Stage 4 — ADJ-M2-006 / F-PRA-039 ══════════════════
 * An unverified client flag destroyed a healthy server-owned job.
 */

test('ADJ-M2-006 force_full_refresh no longer authorises destroying a healthy active job', async () => {
  const healthy = activeFetchJob({ id: 'job_healthy', progress_pct: 5, precision_usage_reserved: 1, total_expected: 1 });
  const result = await runStartPath(PATHS.startBatchDataPull, {
    body: orderBody({ force_full_refresh: true }),
    fetchJobs: [{ ...healthy }]
  });
  assert.deepEqual(result.trace.writes.filter((e) => e.name === 'FetchJob.update'), [],
    'a client-supplied flag is not authority to cancel a server job');
  assert.equal(result.status, 200);
  assert.equal(result.body.active_job_outcome, 'one_exact_match',
    'the identical criteria still resume; only the destruction is gone');
});

/* ══════════════════ Stage 4 — ADJ-M2-007 / F-PRA-004, F-PRA-046 ══════════════════
 * The canonical FetchJob carried no workspace, no versions and no criteria
 * snapshot, so PR #66 had to reconstruct every field.
 */

test('ADJ-M2-007 every canonical FetchJob carries a server-derived workspace and both versions', async () => {
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, { body: orderBody({ requested_properties: 25 }) });
    assert.equal(result.status, 200, name);
    const metadata = result.createdJob.dry_run_metadata;

    assert.equal(metadata.workspace_id, AUDIT_USER.id, `${name}: workspace is server-derived`);
    assert.equal(metadata.criteria_schema_version, 1, name);
    assert.equal(metadata.provider_contract_version, 1, name);
  }
});

test('ADJ-M2-007 a criteria snapshot is published when the order can satisfy schema v1', async () => {
  // An explicit minimum value satisfies the downstream schema-v1 rules, so the
  // snapshot is published and no reconstruction is needed at all.
  const result = await runStartPath(PATHS.startBatchDataPull, {
    body: orderBody({ requested_properties: 25, min_price: 150000 })
  });
  const criteria = result.createdJob.dry_run_metadata.precision_criteria;
  assert.ok(criteria && typeof criteria === 'object', 'a criteria snapshot is persisted');
  assert.equal(criteria.criteria_schema_version, 1);
  assert.equal(criteria.immutable_user_id, AUDIT_USER.id);
  assert.equal(criteria.workspace_id, AUDIT_USER.id);
  assert.equal(criteria.polygon_hash, result.createdJob.polygon_hash);
  assert.equal(criteria.count_mode, 'fixed');
  assert.equal(criteria.entered_count, 25);
  assert.equal(criteria.effective_count, 25);
  assert.equal(criteria.min_price, 150000);
  assert.equal(criteria.sold_months, 3);
  assert.equal(criteria.ownership_range_mode, 'quick');
  assert.equal(criteria.repull_mode, 'new_area');
  assert.deepEqual(criteria.route_bounds, { enabled: false });
});

test('ADJ-M2-007 the snapshot is WITHHELD, with a reason, when the order carries no price floor', async () => {
  // NEW MODEL 2 FINDING. PR #66's schema-v1 validator requires min_price > 0,
  // while its legacy path accepts null as "no floor". Publishing a snapshot the
  // v1 validator cannot accept would flip an accepted job into a rejected one,
  // so the snapshot is withheld and the reason is recorded on the job.
  const result = await runStartPath(PATHS.startBatchDataPull, {
    body: orderBody({ requested_properties: 25, min_price: null })
  });
  const metadata = result.createdJob.dry_run_metadata;
  assert.equal(metadata.precision_criteria, undefined);
  assert.deepEqual(metadata.precision_criteria_withheld, ['min_price']);
  // The workspace and versions are still persisted, so the record needs strictly
  // less reconstruction than before PR A even on the legacy path.
  assert.equal(metadata.workspace_id, AUDIT_USER.id);
  assert.equal(metadata.criteria_schema_version, 1);
});

test('ADJ-M2-007 workspace_id is NEVER taken from the request body', async () => {
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, {
      body: orderBody({ workspace_id: 'workspace_attacker' })
    });
    assert.equal(result.createdJob.dry_run_metadata.workspace_id, AUDIT_USER.id, name);
  }
});

test('ADJ-M2-007 a rep under a manager records the manager workspace, but usage stays on the rep', async () => {
  const rep = { id: 'user_immutable_rep', email: 'rep2@example.com', team_manager_id: 'user_immutable_manager' };
  const result = await runStartPath(PATHS.startBatchDataPull, { user: rep, body: orderBody({ requested_properties: 10 }) });
  assert.equal(result.createdJob.dry_run_metadata.workspace_id, 'user_immutable_manager',
    'workspace scope follows the manager, matching PR #66 precisionWorkspaceIdentity');
  assert.equal(result.createdJob.precision_usage_user_id, 'user_immutable_rep',
    'but the usage subject is still the rep — this change does not move billing');
});

test('ADJ-M2-007 the persisted criteria snapshot round-trips the full custom window', async () => {
  const result = await runStartPath(PATHS.startBatchDataPull, {
    user: paidUser,
    subscriptions: [paidSubscription({})],
    body: orderBody({
      requested_properties: 20,
      min_price: 200000,
      ownership_range_mode: 'custom',
      ownership_min_days: 59,
      ownership_max_days: 365
    })
  });
  const criteria = result.createdJob.dry_run_metadata.precision_criteria;
  assert.deepEqual(criteria.ownership_range_days, { min: 59, max: 365 },
    'the window minimum is first-class in the snapshot, not only derivable from sold_months');
  assert.equal(criteria.sold_months, 12);
  assert.equal(criteria.min_price, 200000);
});

/* ══════════════════ Stage 3 — ADJ-M2-008 / F-PRA-031 ══════════════════
 * A provider transport failure failed the whole Preview with a 500.
 */

test('ADJ-M2-008 a provider transport failure degrades Preview instead of failing it', async () => {
  const { Trace, callHandler, loadPrecisionHandler, makeBase44, makeStripe } =
    await import('./helpers/precisionOrderHarness.mjs');

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
    trace,
    base44,
    stripeApi: makeStripe(trace, {}),
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

  const result = await callHandler(handler, {
    polygon: SQUARE_MILE_POLYGON.map((p) => ({ ...p })),
    requested_properties: 40,
    sandbox: true,
    sandbox_probe: true
  });

  assert.equal(result.status, 200, 'the area estimate is still useful without the probe');
  assert.equal(result.body.sandbox_probe, null);
  assert.equal(result.body.sandbox_probe_error, 'provider_unreachable');
  assert.equal(result.body.area_sq_mi, 1);
});
