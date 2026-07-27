// MODEL 1 / PR A — Stage 0 characterization: identity, workspace, entitlement,
// allowance. Drives the real `startBatchDataPull` and `fetchAreaProperties`
// handlers. Every assertion below records CURRENT behaviour on `main`; a
// failure here means production behaviour changed, not that production is
// wrong. See docs/precision/pr-a-model-1/audit/STAGE_0_AUDIT.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDIT_USER,
  FIXED_NOW_MS,
  PATHS,
  START_PATHS,
  activeFetchJob,
  orderBody,
  paidSubscription,
  runStartPath,
  settledFetchJob,
  trialingSubscription
} from './helpers/precisionOrderHarness.mjs';

const FREE_CAP = 50;
const PAID_CAP = 1000;

/* ------------------------------------------------ AR-S0-01 authority source */

test('AR-S0-01 both start paths authenticate through base44.auth.me and never trust a body-supplied identity', async () => {
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, {
      user: AUDIT_USER,
      body: orderBody({
        user_email: 'attacker@example.com',
        precision_usage_user_id: 'user_immutable_victim',
        user_id: 'user_immutable_victim'
      })
    });
    assert.equal(result.status, 200, `${name} should still start`);
    assert.equal(result.createdJob.precision_usage_user_id, AUDIT_USER.id,
      `${name} must persist the authenticated subject, not the body value`);
    assert.equal(result.createdJob.user_email, AUDIT_USER.email,
      `${name} must persist the authenticated email, not the body value`);
    const authEvents = result.trace.named('auth', 'auth.me');
    assert.equal(authEvents.length, 1, `${name} resolves the actor exactly once`);
  }
});

test('AR-S0-02 an unauthenticated request is rejected 401 before any read or write', async () => {
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, { user: null });
    assert.equal(result.status, 401, `${name} rejects an anonymous caller`);
    assert.deepEqual(result.trace.writes, [], `${name} writes nothing when unauthenticated`);
    assert.deepEqual(result.trace.stripeCalls, [], `${name} contacts no billing API when unauthenticated`);
  }
});

/* --------------------------------------- AR-S0-03 email is a usage authority */

test('AR-S0-03 allowance aggregation reads FetchJobs by BOTH immutable id and email', async () => {
  // Documents that `user_email` is a live authority input for settled usage:
  // a job that carries only the email (no precision_usage_user_id) is counted.
  for (const [name, path] of START_PATHS) {
    const emailOnlyJob = settledFetchJob({ id: 'job_email_only', count: 40 });
    delete emailOnlyJob.precision_usage_user_id;

    const result = await runStartPath(path, {
      body: orderBody({ requested_properties: 50 }),
      fetchJobs: [emailOnlyJob]
    });

    const jobFilters = result.trace.reads
      .filter((event) => event.name.startsWith('FetchJob'))
      .map((event) => event.detail.filter_keys.join(','));
    assert.ok(jobFilters.includes('precision_usage_user_id'),
      `${name} queries FetchJobs by immutable subject`);
    assert.ok(jobFilters.includes('user_email'),
      `${name} ALSO queries FetchJobs by email — email is an authority input`);

    assert.equal(result.status, 200);
    assert.equal(result.createdJob.precision_usage_reserved, FREE_CAP - 40,
      `${name} counted the email-only job against the free allowance`);
  }
});

// UPDATED BY PR A (ADJ-M2-001, Model 1 F-PRA-003). Before PR A this job WAS
// counted, so the user could reserve only 5 of 50. Cross-subject attribution is
// now prevented; the email query still runs but its rows are ownership-filtered.
test('AR-S0-04 a FetchJob owned by a different immutable subject is NOT counted', async () => {
  for (const [name, path] of START_PATHS) {
    const foreignSubjectJob = settledFetchJob({ id: 'job_foreign_subject', count: 45 });
    foreignSubjectJob.precision_usage_user_id = 'user_immutable_someone_else';

    const result = await runStartPath(path, {
      body: orderBody({ requested_properties: 50 }),
      fetchJobs: [foreignSubjectJob]
    });

    assert.equal(result.status, 200);
    assert.equal(result.createdJob.precision_usage_reserved, 50,
      `${name}: another subject's usage no longer consumes this user's allowance`);
  }
});

/* --------------------------------------------- AR-S0-05 entitlement matrix */

const ENTITLEMENT_CASES = [
  {
    id: 'free-no-stripe-evidence',
    subscriptions: [],
    expected: { paidAccess: false, proAccess: false, limit: FREE_CAP }
  },
  {
    id: 'trialing-99',
    subscriptions: [trialingSubscription({})],
    expected: { paidAccess: false, proAccess: true, limit: FREE_CAP }
  },
  {
    id: 'paid-active-with-paid-invoice',
    subscriptions: [paidSubscription({})],
    expected: { paidAccess: true, proAccess: true, limit: PAID_CAP }
  },
  {
    id: 'paid-but-subscription-belongs-to-another-subject',
    subscriptions: [paidSubscription({ userId: 'user_immutable_other' })],
    expected: { paidAccess: false, proAccess: false, limit: FREE_CAP }
  },
  {
    id: 'paid-but-below-price-floor',
    subscriptions: [paidSubscription({ amount: 4900 })],
    expected: { paidAccess: false, proAccess: false, limit: FREE_CAP }
  },
  {
    id: 'canceled-subscription',
    subscriptions: [paidSubscription({ status: 'canceled' })],
    expected: { paidAccess: false, proAccess: false, limit: FREE_CAP }
  }
];

for (const entitlementCase of ENTITLEMENT_CASES) {
  test(`AR-S0-05 [${entitlementCase.id}] resolves identically on both start paths`, async () => {
    const observations = {};
    for (const [name, path] of START_PATHS) {
      const result = await runStartPath(path, {
        user: { ...AUDIT_USER, stripe_customer_id: 'cus_1' },
        body: orderBody({ requested_properties: 40, sold_months: 3 }),
        subscriptions: entitlementCase.subscriptions.map((sub) => ({ ...sub, __customer: 'cus_1' }))
      });
      assert.equal(result.status, 200, `${name} ${entitlementCase.id} should start`);
      observations[name] = {
        paidAccess: result.body.paid_property_limit !== null,
        usageKind: result.createdJob.precision_usage_kind,
        limit: result.body.paid_property_limit ?? FREE_CAP,
        reserved: result.createdJob.precision_usage_reserved
      };
    }
    assert.equal(observations.startBatchDataPull.paidAccess, entitlementCase.expected.paidAccess);
    assert.equal(observations.fetchAreaProperties.paidAccess, entitlementCase.expected.paidAccess);
    assert.deepEqual(observations.startBatchDataPull, observations.fetchAreaProperties,
      `${entitlementCase.id}: the two start paths must agree on entitlement`);
    assert.equal(observations.startBatchDataPull.limit, entitlementCase.expected.limit);
  });
}

/* ------------------------------------ AR-S0-06 beta grant path is asymmetric */

test('AR-S0-06 PARITY BREAK: startBatchDataPull grants beta entitlement by EMAIL; fetchAreaProperties does not', async () => {
  const betaUser = { id: 'user_immutable_bay', email: 'baysecurity@gmail.com', role: 'user' };
  const body = orderBody({ requested_properties: 900, sold_months: 3 });

  const viaStart = await runStartPath(PATHS.startBatchDataPull, { user: betaUser, body });
  const viaFetchArea = await runStartPath(PATHS.fetchAreaProperties, { user: betaUser, body });

  // startBatchDataPull: hard-coded email grant => paid capacity, 1000 limit.
  assert.equal(viaStart.status, 200);
  assert.equal(viaStart.createdJob.precision_usage_kind, 'paid');
  assert.equal(viaStart.createdJob.precision_usage_reserved, 900);
  assert.equal(viaStart.createdJob.precision_subscription_id, 'system_admin_grant');
  assert.deepEqual(viaStart.trace.stripeCalls, [],
    'the email grant short-circuits before Stripe is contacted at all');

  // fetchAreaProperties: no beta path => free plan => 403 above the free cap.
  assert.equal(viaFetchArea.status, 403);
  assert.equal(viaFetchArea.body.error, 'paid_precision_required');
  assert.equal(viaFetchArea.createdJob, null);
});

test('AR-S0-07 BETA_ACCESS_GRANTS is keyed on the immutable id and rejects an expired grant', async () => {
  const grantUser = { id: 'user_immutable_beta', email: 'beta@example.com', role: 'user' };
  const body = orderBody({ requested_properties: 200, sold_months: 3 });

  const activeGrant = JSON.stringify({
    version: 1,
    grants: {
      user_immutable_beta: {
        status: 'active',
        grant_id: 'grant_1',
        precision_limit: 300,
        canvas_seats: 5,
        starts_at: '2026-01-01T00:00:00.000Z',
        ends_at: '2027-01-01T00:00:00.000Z'
      }
    }
  });
  const expiredGrant = activeGrant.replace('2027-01-01', '2026-02-01');
  const malformedGrant = '{ not json';

  const accepted = await runStartPath(PATHS.startBatchDataPull, {
    user: grantUser, body, env: { BETA_ACCESS_GRANTS: activeGrant }
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.createdJob.precision_usage_reserved, 200);
  assert.equal(accepted.createdJob.precision_subscription_id, 'grant_1');

  for (const [label, raw] of [['expired', expiredGrant], ['malformed', malformedGrant]]) {
    const rejected = await runStartPath(PATHS.startBatchDataPull, {
      user: grantUser, body, env: { BETA_ACCESS_GRANTS: raw }
    });
    assert.equal(rejected.status, 403, `${label} grant must not confer paid capacity`);
    assert.equal(rejected.body.error, 'paid_precision_required');
  }

  // The grant is keyed on the immutable id, so a matching email does not help.
  const wrongSubject = await runStartPath(PATHS.startBatchDataPull, {
    user: { id: 'user_immutable_impostor', email: 'beta@example.com', role: 'user' },
    body,
    env: { BETA_ACCESS_GRANTS: activeGrant }
  });
  assert.equal(wrongSubject.status, 403, 'a grant cannot be claimed by another immutable subject');
});

/* ------------------------------------------- AR-S0-08 allowance arithmetic */

test('AR-S0-08 settled usage, open reservations and remaining allowance agree across both paths', async () => {
  const world = [
    settledFetchJob({ id: 'job_settled_a', count: 12 }),
    settledFetchJob({ id: 'job_settled_b', count: 8 })
  ];
  const observations = {};
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, {
      body: orderBody({ requested_properties: 50 }),
      fetchJobs: world.map((job) => ({ ...job }))
    });
    assert.equal(result.status, 200);
    observations[name] = {
      reserved: result.createdJob.precision_usage_reserved,
      free_remaining_after: result.body.free_properties_remaining
    };
  }
  assert.deepEqual(observations.startBatchDataPull, observations.fetchAreaProperties);
  assert.equal(observations.startBatchDataPull.reserved, FREE_CAP - 20,
    'remaining = free cap minus settled usage');
});

test('AR-S0-09 an exhausted free allowance fails closed with paid_precision_required on both paths', async () => {
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, {
      body: orderBody({ requested_properties: 10 }),
      fetchJobs: [settledFetchJob({ id: 'job_full', count: FREE_CAP })]
    });
    assert.equal(result.status, 403, `${name} blocks an exhausted free account`);
    assert.equal(result.body.error, 'paid_precision_required');
    assert.equal(result.createdJob, null, `${name} created no FetchJob`);
  }
});

test('AR-S0-10 a paid account at its cycle limit fails closed with precision_allowance_exhausted', async () => {
  // The subscription period start must match the job's persisted period start
  // to within 1s, which is the `matchesPaid` rule in getPrecisionAllowance.
  const periodStartSeconds = Math.floor(FIXED_NOW_MS / 1000) - 5 * 24 * 3600;
  for (const [name, path] of START_PATHS) {
    const settled = settledFetchJob({ id: 'job_paid_full', count: PAID_CAP, kind: 'paid' });
    settled.precision_usage_period_start = new Date(periodStartSeconds * 1000).toISOString();
    const result = await runStartPath(path, {
      user: { ...AUDIT_USER, stripe_customer_id: 'cus_1' },
      body: orderBody({ requested_properties: 100 }),
      subscriptions: [paidSubscription({})],
      fetchJobs: [settled]
    });
    assert.equal(result.status, 403, `${name} blocks an exhausted paid cycle`);
    assert.equal(result.body.error, 'precision_allowance_exhausted');
    assert.equal(result.createdJob, null);
  }
});

/* ------------------------ AR-S0-11 open reservation is only honoured by one path */

test('AR-S0-11 PARITY BREAK: startBatchDataPull releases a >10-minute-old reservation, fetchAreaProperties does not', async () => {
  const fortyFiveMinutesAgo = new Date(FIXED_NOW_MS - 45 * 60 * 1000).toISOString();
  const staleReservation = activeFetchJob({
    id: 'job_stale_reservation',
    status: 'pending',
    precision_usage_reserved: 40,
    created_date: fortyFiveMinutesAgo,
    started_at: fortyFiveMinutesAgo,
    // custom mode so both paths supersede rather than resume, isolating the
    // reservation-ageing behaviour from the active-job decision.
    dry_run_metadata: { ownership_range_mode: 'custom', ownership_range_days: { min: 1, max: 30 } }
  });

  const body = orderBody({
    requested_properties: 50,
    ownership_range_mode: 'custom',
    ownership_min_days: 10,
    ownership_max_days: 200,
    sold_months: 3
  });

  const viaStart = await runStartPath(PATHS.startBatchDataPull, {
    user: { ...AUDIT_USER, stripe_customer_id: 'cus_1' },
    subscriptions: [trialingSubscription({})],
    body,
    fetchJobs: [{ ...staleReservation }]
  });
  const viaFetchArea = await runStartPath(PATHS.fetchAreaProperties, {
    user: { ...AUDIT_USER, stripe_customer_id: 'cus_1' },
    subscriptions: [trialingSubscription({})],
    body,
    fetchJobs: [{ ...staleReservation }]
  });

  assert.equal(viaStart.status, 200);
  assert.equal(viaStart.createdJob.precision_usage_reserved, FREE_CAP,
    'startBatchDataPull treats a >10min reservation as released (jobUsage staleness rule)');

  assert.equal(viaFetchArea.status, 409,
    'fetchAreaProperties has no staleness rule and refuses the custom-range conflict');
  assert.equal(viaFetchArea.body.error, 'active_job_criteria_conflict');
});

/* ------------------------------------------ AR-S0-12 no workspace concept */

// UPDATED BY PR A (ADJ-M2-007, Model 1 F-PRA-004). A server-derived workspace
// is now persisted; a body-supplied one is still ignored.
test('AR-S0-12 both start paths persist a SERVER-DERIVED workspace identity', async () => {
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, {
      body: orderBody({ workspace_id: 'workspace_attacker' })
    });
    assert.equal(result.status, 200);
    assert.equal(result.createdJob.dry_run_metadata.workspace_id, AUDIT_USER.id, name);
    assert.ok(!JSON.stringify(result.createdJob).includes('workspace_attacker'),
      `${name}: a client-supplied workspace is never trusted`);
  }
});

/* --------------------------------- AR-S0-13 duplicated entitlement evidence */

test('AR-S0-13 each start creates the Stripe client twice and re-resolves entitlement inside the lock', async () => {
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, {
      user: { ...AUDIT_USER, stripe_customer_id: 'cus_1' },
      subscriptions: [paidSubscription({})],
      body: orderBody({ requested_properties: 10 })
    });
    assert.equal(result.status, 200);
    const constructs = result.trace.named('stripe', 'client.construct');
    assert.equal(constructs.length, 2,
      `${name}: entitlement is resolved once before the lock and once inside it`);
    const lists = result.trace.named('stripe', 'subscriptions.list');
    assert.equal(lists.length, 2, `${name}: the subscription list is fetched twice per start`);

    // Allowance is likewise recomputed, so the FetchJob table is scanned twice.
    // UPDATED BY PR A (ADJ-M2-005): the active-job lookup now issues 4 further
    // service-role queries (running/pending x immutable id/email) so ownership
    // can be verified by subject instead of trusting an email-keyed page.
    const jobScans = result.trace.reads.filter((event) =>
      event.name === 'FetchJob(serviceRole).filter');
    assert.equal(jobScans.length, 8,
      `${name}: 2 allowance passes x 2 queries, plus 4 ownership-scoped active-job queries`);
  }
});

/* ----------------------------------- AR-S0-14 role does not widen authority */

test('AR-S0-14 an admin role grants no extra Precision capacity on either path', async () => {
  for (const [name, path] of START_PATHS) {
    const result = await runStartPath(path, {
      user: { ...AUDIT_USER, role: 'admin' },
      body: orderBody({ requested_properties: 200 })
    });
    assert.equal(result.status, 403, `${name} treats an admin as a free account`);
    assert.equal(result.body.error, 'paid_precision_required');
  }
});
