// MODEL 1 / PR A — Stage 4 characterization: the locked start decision,
// active-job resolution, reservation and canonical FetchJob creation.
//
// See docs/precision/pr-a-model-1/audit/STAGE_4_AUDIT.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDIT_USER,
  FIXED_NOW_MS,
  PATHS,
  SQUARE_MILE_POLYGON,
  START_PATHS,
  TRIANGLE_POLYGON,
  activeFetchJob,
  orderBody,
  paidSubscription,
  runConcurrentStarts,
  runStartPath,
  settledFetchJob,
  trialingSubscription
} from './helpers/precisionOrderHarness.mjs';

const FREE_CAP = 50;
const proWorld = {
  user: { ...AUDIT_USER, stripe_customer_id: 'cus_1' },
  subscriptions: [trialingSubscription({})]
};

/* ===================================================== ordering guarantees */

test('AR-S4-01 the start sequence is identical on both paths and is auditable end to end', async () => {
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, { body: orderBody() });
    assert.equal(result.status, 200);

    const order = result.trace.events
      .filter((event) => ['auth', 'lock', 'entity_write', 'invoke', 'fetch'].includes(event.channel))
      .map((event) => `${event.channel}:${event.name}`);

    const authIndex = order.indexOf('auth:auth.me');
    const fipsIndex = order.indexOf('fetch:outbound');
    const lockIndex = order.indexOf('lock:db.connect');
    const createIndex = order.indexOf('entity_write:FetchJob.create');
    const commitIndex = order.lastIndexOf('lock:db.query');
    const endIndex = order.indexOf('lock:db.end');
    const processorIndex = order.indexOf('invoke:processFetchChunk');

    assert.ok(authIndex < fipsIndex, `${name}: authenticate before the county lookup`);
    assert.ok(fipsIndex < lockIndex, `${name}: resolve the county before taking the lock`);
    assert.ok(lockIndex < createIndex, `${name}: create the FetchJob inside the lock`);
    assert.ok(createIndex < commitIndex, `${name}: the create precedes COMMIT`);
    assert.ok(endIndex < processorIndex,
      `${name}: the processor is invoked AFTER the lock connection closes`);
  }
});

test('AR-S4-02 exactly one reservation write occurs, fused into the FetchJob create', async () => {
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, { body: orderBody({ requested_properties: 20 }) });
    assert.equal(result.status, 200);

    const writes = result.trace.writes.map((event) => event.name);
    assert.deepEqual(writes, ['FetchJob.create'],
      `${name}: no separate reservation record and no second write`);
    assert.equal(result.createdJob.precision_usage_reserved, 20);
    assert.equal(result.createdJob.precision_usage_count, 0);
    assert.equal(result.createdJob.total_expected, 20);
    assert.equal(result.createdJob.estimated_record_count, 20);
    assert.equal(result.createdJob.status, 'pending');
  }
});

test('AR-S4-03 the advisory lock key is scoped to the immutable subject and shared by both paths', async () => {
  const keys = {};
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, { body: orderBody() });
    const lockQuery = result.trace.named('lock', 'db.query')
      .find((event) => String(event.detail.sql).includes('pg_advisory_xact_lock'));
    assert.ok(lockQuery, `${name} takes an advisory lock`);
    keys[name] = lockQuery.detail.params[0];
  }
  assert.equal(keys.startBatchDataPull, `precision-usage:${AUDIT_USER.id}`);
  assert.equal(keys.startBatchDataPull, keys.fetchAreaProperties,
    'both start paths contend on the same key, so they serialize against each other');
});

test('AR-S4-04 a failed processor invocation still leaves the reservation held', async () => {
  const result = await runStartPath(PATHS.startBatchDataPull, {
    body: orderBody({ requested_properties: 20 }),
    invokeHandlers: { processFetchChunk: async () => { throw new Error('processor cold start failed'); } }
  });
  assert.equal(result.status, 200, 'the start still reports success');
  assert.equal(result.body.status, 'started');
  assert.equal(result.createdJob.precision_usage_reserved, 20);
  assert.equal(result.createdJob.status, 'pending',
    'the job stays pending with 20 units reserved even though nothing will process it');
});

/* ================================================ active-job resolution */

test('AR-S4-05 zero active jobs: the order proceeds and creates exactly one FetchJob', async () => {
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, {
      body: orderBody(),
      fetchJobs: [settledFetchJob({ id: 'job_done', count: 5 })]
    });
    assert.equal(result.status, 200, name);
    assert.equal(result.createdJobs.length, 1);
  }
});


/** An active job holding a 1-unit reservation, so it blocks without exhausting. */
function lightActiveJob(overrides = {}) {
  return activeFetchJob({ precision_usage_reserved: 1, total_expected: 1, ...overrides });
}

test('AR-S4-07a several stuck active jobs exhaust the free allowance through reservations alone, and the 403 pre-empts the active-job decision', async () => {
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, {
      body: orderBody(),
      fetchJobs: [
        activeFetchJob({ id: 'job_running_a', precision_usage_reserved: 25 }),
        activeFetchJob({ id: 'job_running_b', precision_usage_reserved: 25 })
      ]
    });
    assert.equal(result.status, 403, `${name}: two 25-unit reservations consume the whole free cap`);
    assert.equal(result.body.error, 'paid_precision_required');
    assert.match(result.body.message, /already received its included 50/,
      `${name}: the user is told they are out of allowance, not that imports are stuck`);
    assert.equal(result.body.active_job_id, undefined,
      `${name}: no active-job remedy is offered, because the gate fires before the lock`);
    assert.deepEqual(result.trace.locks, [], `${name}: the usage lock is never even taken`);
  }
});


/* ------------------------------ custom-range divergence between paths */


test('AR-S4-11 a matching custom range with a DIFFERENT polygon is also treated as a conflict', async () => {
  const running = activeFetchJob({
    id: 'job_custom_same_range',
    polygon: TRIANGLE_POLYGON.map((p) => ({ ...p })),
    polygon_hash: null,
    dry_run_metadata: { ownership_range_mode: 'custom', ownership_range_days: { min: 60, max: 180 } }
  });
  const body = orderBody({
    polygon: SQUARE_MILE_POLYGON.map((p) => ({ ...p })),
    ownership_range_mode: 'custom',
    ownership_min_days: 60,
    ownership_max_days: 180
  });

  const viaFetchArea = await runStartPath(PATHS.fetchAreaProperties, {
    ...proWorld, body, fetchJobs: [{ ...running }]
  });
  assert.equal(viaFetchArea.status, 409, 'the polygon hash is part of the custom-range comparison');
});


/* --------------------------------- stale / forced cancellation divergence */


test('AR-S4-15 cancelling an active job never releases its reservation', async () => {
  const olderThanTwoMinutes = new Date(FIXED_NOW_MS - 5 * 60 * 1000).toISOString();
  const stale = activeFetchJob({
    id: 'job_stale_reserved',
    precision_usage_reserved: 30,
    created_date: olderThanTwoMinutes,
    started_at: olderThanTwoMinutes
  });

  const result = await runStartPath(PATHS.startBatchDataPull, {
    body: orderBody({ requested_properties: 50 }),
    fetchJobs: [{ ...stale }]
  });
  const cancel = result.trace.writes.find((event) => event.name === 'FetchJob.update');
  assert.equal(cancel.detail.patch.precision_usage_reserved, undefined,
    'the cancel patch does not zero the reservation');

  // The job was cancelled, yet its 30 units still count against the allowance,
  // so the replacement order can only reserve 20. The reservation is released
  // by nothing here — only by jobUsage()'s separate >10-minute staleness rule.
  assert.equal(result.createdJob.precision_usage_reserved, 20,
    'a cancelled job keeps holding its reservation for the same request');
  assert.equal(result.createdJob.dry_run_metadata.limited_by_free_home_cap, true,
    'and the user is silently capped by allowance the cancelled job still owns');
});

test('AR-S4-15b the same reservation IS ignored once the job passes the separate 10-minute staleness threshold', async () => {
  const olderThanTenMinutes = new Date(FIXED_NOW_MS - 15 * 60 * 1000).toISOString();
  const stale = activeFetchJob({
    id: 'job_very_stale',
    precision_usage_reserved: 30,
    created_date: olderThanTenMinutes,
    started_at: olderThanTenMinutes
  });
  const result = await runStartPath(PATHS.startBatchDataPull, {
    body: orderBody({ requested_properties: 50 }),
    fetchJobs: [{ ...stale }]
  });
  assert.equal(result.createdJob.precision_usage_reserved, FREE_CAP,
    'past 10 minutes the reservation stops counting — on startBatchDataPull only');
});

/* ===================================================== concurrency */

test('AR-S4-16 two concurrent identical Fixed Count starts: the lock serializes them and the second resumes the first', async () => {
  const result = await runConcurrentStarts({
    paths: [PATHS.startBatchDataPull, PATHS.startBatchDataPull],
    bodies: [orderBody({ requested_properties: 30 }), orderBody({ requested_properties: 30 })]
  });

  const started = result.responses.filter((response) => response.body.status === 'started');
  const resumed = result.responses.filter((response) => response.body.status === 'already_running');
  assert.equal(started.length, 1, 'exactly one order creates a job');
  assert.equal(resumed.length, 1, 'the other is told a pull is already running');
  assert.equal(result.createdJobs.length, 1, 'exactly one FetchJob is created');
  assert.equal(resumed[0].body.job_id, started[0].body.job_id);

  const acquisitions = result.trace.named('lock', 'acquired');
  assert.equal(acquisitions.length, 2, 'both starts acquired the lock, one after the other');
});


test('AR-S4-18 concurrent starts across the TWO different endpoints also serialize on the shared key', async () => {
  const result = await runConcurrentStarts({
    paths: [PATHS.startBatchDataPull, PATHS.fetchAreaProperties],
    bodies: [orderBody({ requested_properties: 30 }), orderBody({ requested_properties: 30 })]
  });
  assert.equal(result.createdJobs.length, 1,
    'a cross-endpoint race still produces exactly one FetchJob');
  assert.equal(result.trace.named('lock', 'acquired').length, 2);
});

test('AR-S4-19 a nearly exhausted allowance cannot be over-reserved by two concurrent Max Available starts', async () => {
  const result = await runConcurrentStarts({
    paths: [PATHS.startBatchDataPull, PATHS.startBatchDataPull],
    bodies: [
      orderBody({ requested_properties: 50, count_mode: 'max_available' }),
      orderBody({ requested_properties: 50, count_mode: 'max_available' })
    ],
    fetchJobs: [settledFetchJob({ id: 'job_prior', count: 45 })]
  });

  assert.equal(result.createdJobs.length, 1);
  const totalReserved = result.createdJobs.reduce((sum, job) => sum + job.precision_usage_reserved, 0);
  assert.equal(totalReserved, 5, 'only the 5 remaining units are reserved in total');
  assert.ok(45 + totalReserved <= FREE_CAP, 'the free cap is never exceeded');
});

test('AR-S4-20 with no submitted count, the entered count is the PLAN CAP for a free account, not the remaining allowance', async () => {
  const bodyWithoutCount = orderBody();
  delete bodyWithoutCount.requested_properties;

  const result = await runConcurrentStarts({
    paths: [PATHS.startBatchDataPull, PATHS.startBatchDataPull],
    bodies: [{ ...bodyWithoutCount }, { ...bodyWithoutCount }],
    fetchJobs: [settledFetchJob({ id: 'job_prior', count: 20 })]
  });

  assert.equal(result.createdJobs.length, 1);
  const job = result.createdJobs[0];
  // `maxProperties` is FREE_PROPERTY_CAP for an unpaid account, so the recorded
  // "entered count" is 50 even though only 30 units were ever available. The
  // persisted entered count therefore describes the plan, not the user.
  assert.equal(job.dry_run_metadata.requested_properties_before_cap, FREE_CAP);
  assert.equal(job.precision_usage_reserved, 30,
    'the effective count IS correctly re-derived from the locked allowance');
  assert.equal(job.dry_run_metadata.limited_by_free_home_cap, true,
    'and the job is marked as capped even though the user submitted no count at all');
});

test('AR-S4-20b for a PAID account the same fallback uses the pre-lock remaining allowance instead', async () => {
  const bodyWithoutCount = orderBody();
  delete bodyWithoutCount.requested_properties;
  const settled = settledFetchJob({ id: 'job_prior_paid', count: 600, kind: 'paid' });
  settled.precision_usage_period_start = new Date((Math.floor(FIXED_NOW_MS / 1000) - 5 * 24 * 3600) * 1000).toISOString();

  const result = await runStartPath(PATHS.startBatchDataPull, {
    user: { ...AUDIT_USER, stripe_customer_id: 'cus_1' },
    subscriptions: [paidSubscription({})],
    body: bodyWithoutCount,
    fetchJobs: [settled]
  });
  assert.equal(result.status, 200);
  assert.equal(result.createdJob.dry_run_metadata.requested_properties_before_cap, 400,
    'a paid account records the pre-lock remaining allowance as the entered count');
  assert.equal(result.createdJob.precision_usage_reserved, 400);
});

/* ======================================== canonical FetchJob composition */


test('AR-S4-24 the reservation is attributed to the locked entitlement, not the pre-lock one', async () => {
  const result = await runStartPath(PATHS.startBatchDataPull, {
    user: { ...AUDIT_USER, stripe_customer_id: 'cus_1' },
    subscriptions: [paidSubscription({})],
    body: orderBody({ requested_properties: 100 })
  });
  const job = result.createdJob;
  assert.equal(job.precision_usage_kind, 'paid');
  assert.equal(job.precision_subscription_id, 'sub_paid');
  assert.equal(job.precision_invoice_id, 'in_sub_paid');
  assert.ok(job.precision_usage_period_start);
  assert.ok(job.precision_usage_period_end);
  assert.equal(job.precision_usage_reserved, 100);
});

test('AR-S4-25 a dry run reserves nothing, creates nothing and takes no lock', async () => {
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, { body: orderBody({ dry_run: true }) });
    assert.equal(result.status, 200, name);
    assert.deepEqual(result.trace.writes, [], `${name}: no write`);
    assert.deepEqual(result.trace.locks, [], `${name}: no lock`);
    assert.deepEqual(result.trace.invocations, [], `${name}: no processor invocation`);
    assert.equal(result.body.requested_properties_before_cap, 25);
  }
});

test('AR-S4-26 self_test_force_free bypasses Stripe entirely — and only exists on one path', async () => {
  const result = await runStartPath(PATHS.startBatchDataPull, {
    body: orderBody({ dry_run: true, self_test_force_free: true })
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.trace.stripeCalls, [], 'no billing verification runs at all');
  assert.deepEqual(result.trace.reads, [], 'no allowance history is read either');
  assert.equal(result.body.free_properties_remaining, FREE_CAP);

  // The flag is inert on the other path, which still performs full verification.
  const other = await runStartPath(PATHS.fetchAreaProperties, {
    body: orderBody({ dry_run: true, self_test_force_free: true })
  });
  assert.ok(other.trace.stripeCalls.length > 0, 'fetchAreaProperties has no such bypass');
});

/* ═══════════════ SUPERSEDED BY PR A ═══════════════
 * These characterization tests pinned Stage 4 behaviour that PR A deliberately
 * changed. They are removed here rather than rewritten, because their value was
 * documenting the pre-PR-A defect — and that record is preserved intact on the
 * frozen Model 1 audit branch (audit/precision-order-control-model-1 @
 * 0c3fd666bfa0ba5b506503578d727d201c62fbdc).
 *
 * The post-PR-A contract for each is owned by test/precision-order-hardening.test.mjs:
 *
 *   AR-S4-06 -> ADJ-M2-005 (criteria-aware resume)
 *   AR-S4-07 -> ADJ-M2-005 (ownership-scoped, deterministic active-job lookup)
 *   AR-S4-08 -> ADJ-M2-005 (foreign-subject job no longer blocks)
 *   AR-S4-09 -> ADJ-M2-005 (explicit active-job outcomes)
 *   AR-S4-10 -> ADJ-M2-005 (one unified conflict response on both paths)
 *   AR-S4-12 -> ADJ-M2-005 (corrupt metadata no longer reaches ownershipFromJob)
 *   AR-S4-13 -> ADJ-M2-006 (auto-cancel scoped to conflicting stale jobs)
 *   AR-S4-14 -> ADJ-M2-006 (client flag is not cancellation authority)
 *   AR-S4-17 -> ADJ-M2-005 (the losing order is reported, not discarded)
 *   AR-S4-21 -> ADJ-M2-007 (schema + provider contract versions persisted)
 *   AR-S4-22 -> ADJ-M2-007 (canonical field set unified across paths)
 *   AR-S4-23 -> ADJ-M2-007 (pull_mode parity)
 *
 * Everything else in this file still pins behaviour PR A deliberately KEPT:
 * the single-write reservation, the shared advisory lock, the concurrency
 * guarantees, dry-run inertness and the start ordering.
 * ═══════════════════════════════════════════════════ */
