import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

import {
  hasUnsettledPrecisionReservation,
  normalizePrecisionUsageResponse
} from '../src/lib/precisionUsage.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');
const endpointPath = 'base44/functions/getPrecisionUsage/entry.ts';
const controlPlanePath = 'base44/functions/_shared/precisionActiveJobCriteria.js';

function loadHandler({ base44, stripeApi }) {
  const transpiled = ts.transpileModule(readSource(endpointPath), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: endpointPath,
    reportDiagnostics: true
  });
  const errors = (transpiled.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], 'getPrecisionUsage contains TypeScript syntax errors');

  let handler;
  class FakeStripe {
    constructor() { return stripeApi; }
  }
  class FakeClient {
    async connect() {}
    async query(sql) {
      if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ claimed: true }] };
      return { rows: [] };
    }
    async end() {}
  }
  const sharedExecutable = readSource(controlPlanePath).replace(/^export\s+/gm, '');
  const executable = `${sharedExecutable}\n${transpiled.outputText.replace(/^import .*;\s*$/gm, '')}`;
  vm.runInNewContext(executable, {
    console,
    createClientFromRequest: () => base44,
    Deno: {
      env: {
        get: (key) => {
          if (key === 'STRIPE_SECRET_KEY') return 'sk_test';
          if (key === 'DATABASE_URL') return 'postgres://test';
          return null;
        }
      },
      serve: (registeredHandler) => { handler = registeredHandler; }
    },
    Stripe: FakeStripe,
    Client: FakeClient,
    Request,
    Response,
    TextEncoder,
    crypto: globalThis.crypto
  }, { filename: endpointPath });
  return handler;
}

function paidSubscription({
  id = 'sub_paid',
  userId = 'user_1',
  periodStart = Math.floor(Date.now() / 1000) - 60,
  periodEnd = periodStart + 30 * 24 * 60 * 60,
  status = 'active',
  invoiceStatus = 'paid',
  amountPaid = 9900,
  amountCents = 9900
} = {}) {
  return {
    id,
    status,
    trial_end: null,
    current_period_start: periodStart,
    current_period_end: periodEnd,
    metadata: { base44_user_id: userId, subscription_tier: 'precision' },
    items: { data: [{ price: { unit_amount: amountCents } }] },
    latest_invoice: {
      id: `in_${id}`,
      subscription: id,
      status: invoiceStatus,
      amount_paid: amountPaid,
      period_start: periodStart,
      period_end: periodEnd,
      lines: { data: [{ subscription: id, period: { start: periodStart, end: periodEnd } }] }
    }
  };
}

function makeBase44(user, initialJobs) {
  const jobs = initialJobs.map((job) => ({ ...job }));
  const jobUpdates = [];
  const userUpdates = [];
  const matches = (job, filter) => Object.entries(filter).every(([key, value]) => job[key] === value);
  const filterJobs = async (filter, _sort, limit = 500, skip = 0) => jobs.filter((job) => matches(job, filter)).slice(skip, skip + limit);

  return {
    jobs,
    jobUpdates,
    userUpdates,
    client: {
      auth: { me: async () => user },
      asServiceRole: {
        entities: {
          FetchJob: {
            filter: filterJobs,
            update: async (id, updates) => {
              const job = jobs.find((candidate) => candidate.id === id);
              Object.assign(job, updates);
              jobUpdates.push({ id, updates });
            }
          },
          User: {
            update: async (id, updates) => userUpdates.push({ id, updates })
          }
        }
      }
    }
  };
}

async function invoke({ user, jobs, subscription, searchSubscriptions = [] }) {
  const base44 = makeBase44(user, jobs);
  const stripeApi = {
    subscriptions: {
      retrieve: async () => subscription,
      search: async () => ({ data: searchSubscriptions })
    }
  };
  const handler = loadHandler({ base44: base44.client, stripeApi });
  const response = await handler(new Request('https://app.example.com/getPrecisionUsage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  }));
  return { response, result: await response.json(), base44 };
}

function completedJob({ id, created, count, kind, periodStart, userId = 'user_1' }) {
  return {
    id,
    status: 'completed',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    user_email: 'austenwaugh@gmail.com',
    precision_usage_user_id: userId,
    ...(kind ? { precision_usage_kind: kind } : {}),
    ...(periodStart ? { precision_usage_period_start: periodStart } : {}),
    created_date: created,
    started_at: created,
    completed_at: created,
    total_expected: count,
    ...(kind ? {
      precision_usage_reserved: 0,
      precision_usage_count: count,
      precision_usage_recorded_at: created
    } : {}),
    dry_run_metadata: { batchdata_summary: { active: count } }
  };
}

test('50 trial properties remain credited and payment starts the paid meter at 0 / 1,000', async () => {
  const subscription = paidSubscription();
  const periodStartIso = new Date(subscription.current_period_start * 1000).toISOString();
  const user = { id: 'user_1', email: 'austenwaugh@gmail.com', subscription_id: subscription.id };
  const trialJob = completedJob({
    id: 'job_trial',
    created: new Date((subscription.current_period_start - 3600) * 1000).toISOString(),
    count: 50
  });

  const { response, result, base44 } = await invoke({ user, jobs: [trialJob], subscription });
  assert.equal(response.status, 200);
  assert.equal(result.kind, 'paid');
  assert.equal(result.used, 0);
  assert.equal(result.reserved, 0);
  assert.equal(result.remaining, 1000);
  assert.equal(result.trial_used, 50);
  assert.equal(result.lifetime_used, 50);
  assert.equal(result.period_start, periodStartIso);
  assert.equal(base44.jobUpdates[0].updates.precision_usage_kind, 'trial');
  assert.equal(base44.userUpdates[0].updates.precision_trial_properties_credited, 50);
});

test('legacy reconciliation normalizes malformed completion time before writing settlement evidence', async () => {
  const subscription = paidSubscription();
  const user = { id: 'user_1', email: 'austenwaugh@gmail.com', subscription_id: subscription.id };
  const legacy = completedJob({
    id: 'legacy_bad_completed_at',
    created: new Date((subscription.current_period_start - 3600) * 1000).toISOString(),
    count: 25,
  });
  legacy.completed_at = 'not-a-timestamp';

  const { response, base44 } = await invoke({ user, jobs: [legacy], subscription });
  assert.equal(response.status, 200);
  assert.equal(base44.jobUpdates.length, 1);
  const recordedAt = base44.jobUpdates[0].updates.precision_usage_recorded_at;
  assert.equal(Number.isFinite(new Date(recordedAt).getTime()), true);
  assert.notEqual(recordedAt, legacy.completed_at);
});

test('legacy reconciliation fails closed on email-only ownership evidence', async () => {
  const subscription = paidSubscription();
  const user = { id: 'user_1', email: 'austenwaugh@gmail.com', subscription_id: subscription.id };
  const emailOnly = completedJob({
    id: 'legacy_email_only',
    created: new Date((subscription.current_period_start - 3600) * 1000).toISOString(),
    count: 25,
  });
  delete emailOnly.precision_usage_user_id;

  const { response, result, base44 } = await invoke({
    user,
    jobs: [emailOnly],
    subscription,
  });
  assert.equal(response.status, 409);
  assert.equal(result.complete, false);
  assert.equal(result.error, 'legacy_precision_ownership_unverifiable');
  assert.equal(base44.jobUpdates.length, 0);
  assert.equal(emailOnly.precision_usage_user_id, undefined);
});

test('the first paid 50-property fetch changes the paid meter to 50 / 1,000', async () => {
  const subscription = paidSubscription();
  const periodStartIso = new Date(subscription.current_period_start * 1000).toISOString();
  const before = new Date((subscription.current_period_start - 3600) * 1000).toISOString();
  const during = new Date((subscription.current_period_start + 10) * 1000).toISOString();
  const user = { id: 'user_1', email: 'austenwaugh@gmail.com', subscription_id: subscription.id };
  const jobs = [
    completedJob({ id: 'trial', created: before, count: 50, kind: 'trial' }),
    completedJob({ id: 'paid', created: during, count: 50, kind: 'paid', periodStart: periodStartIso })
  ];

  const { result } = await invoke({ user, jobs, subscription });
  assert.equal(result.used, 50);
  assert.equal(result.meter_used, 50);
  assert.equal(result.remaining, 950);
  assert.equal(result.lifetime_used, 100);
});

test('a pending paid fetch reserves capacity until it settles to delivered usage', async () => {
  const subscription = paidSubscription();
  const periodStartIso = new Date(subscription.current_period_start * 1000).toISOString();
  const user = { id: 'user_1', email: 'austenwaugh@gmail.com', subscription_id: subscription.id };
  const pending = {
    id: 'pending',
    status: 'running',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    user_email: user.email,
    precision_usage_user_id: user.id,
    precision_usage_kind: 'paid',
    precision_usage_period_start: periodStartIso,
    precision_usage_reserved: 50,
    precision_usage_count: 0
  };

  const { result } = await invoke({ user, jobs: [pending], subscription });
  assert.equal(result.used, 0);
  assert.equal(result.reserved, 50);
  assert.equal(result.meter_used, 50);
  assert.equal(result.remaining, 950);
});

test('running cancellation and email-only legacy terminal jobs fail closed', async () => {
  const subscription = paidSubscription();
  const periodStartIso = new Date(subscription.current_period_start * 1000).toISOString();
  const user = { id: 'user_1', email: 'austenwaugh@gmail.com', subscription_id: subscription.id };
  const jobs = [
    {
      id: 'cancelling_paid',
      status: 'cancelled',
      provider: 'batchdata',
      mode_tag: 'PRECISION_TARGET',
      user_email: user.email,
      precision_usage_user_id: user.id,
      precision_usage_kind: 'paid',
      precision_usage_period_start: periodStartIso,
      precision_usage_reserved: 50,
      precision_usage_count: 0,
      precision_cancel_requested_at: new Date().toISOString()
    },
    {
      id: 'legacy_cancelled',
      status: 'cancelled',
      provider: 'batchdata',
      mode_tag: 'PRECISION_TARGET',
      user_email: user.email,
      precision_usage_kind: 'paid',
      total_expected: 1000,
      created_date: new Date((subscription.current_period_start + 10) * 1000).toISOString()
    },
    {
      id: 'legacy_failed',
      status: 'failed',
      provider: 'batchdata',
      mode_tag: 'PRECISION_TARGET',
      user_email: user.email,
      precision_usage_kind: 'paid',
      total_expected: 1000,
      created_date: new Date((subscription.current_period_start + 20) * 1000).toISOString()
    }
  ];

  const { response, result } = await invoke({ user, jobs, subscription });
  assert.equal(response.status, 409);
  assert.equal(result.complete, false);
  assert.equal(result.error, 'legacy_precision_ownership_unverifiable');
});

test('usage fails closed when a zero reservation was written without complete settlement evidence', async () => {
  const subscription = paidSubscription();
  const periodStartIso = new Date(subscription.current_period_start * 1000).toISOString();
  const user = { id: 'user_1', email: 'austenwaugh@gmail.com', subscription_id: subscription.id };
  const partial = {
    id: 'partial_settlement',
    status: 'failed',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    user_email: user.email,
    precision_usage_user_id: user.id,
    precision_usage_kind: 'paid',
    precision_usage_period_start: periodStartIso,
    precision_usage_reserved: 0,
    precision_usage_count: 0,
    precision_usage_recorded_at: null
  };

  const { response, result } = await invoke({ user, jobs: [partial], subscription });
  assert.equal(response.status, 503);
  assert.equal(result.complete, false);
  assert.equal(result.error, 'precision_usage_unavailable');
});

test('renewal uses the new paid period while the trial remains consumed', async () => {
  const priorStart = Math.floor(Date.now() / 1000) - 31 * 24 * 60 * 60;
  const subscription = paidSubscription();
  const priorStartIso = new Date(priorStart * 1000).toISOString();
  const trialDate = new Date((priorStart - 3600) * 1000).toISOString();
  const priorPaidDate = new Date((priorStart + 60) * 1000).toISOString();
  const user = { id: 'user_1', email: 'austenwaugh@gmail.com', subscription_id: subscription.id };
  const jobs = [
    completedJob({ id: 'trial', created: trialDate, count: 50, kind: 'trial' }),
    completedJob({ id: 'old_paid', created: priorPaidDate, count: 1000, kind: 'paid', periodStart: priorStartIso })
  ];

  const { result } = await invoke({ user, jobs, subscription });
  assert.equal(result.kind, 'paid');
  assert.equal(result.used, 0);
  assert.equal(result.remaining, 1000);
  assert.equal(result.trial_used, 50);
  assert.equal(result.trial_remaining, 0);
});

test('failed or incomplete payment never activates the paid allowance', async () => {
  const subscription = paidSubscription({ status: 'incomplete', invoiceStatus: 'open', amountPaid: 0 });
  const user = {
    id: 'user_1',
    email: 'austenwaugh@gmail.com',
    subscription_id: subscription.id,
    subscription_status: 'active',
    subscription_tier: 'precision',
    subscription_paid_confirmed: true,
    is_owner: true
  };
  const trial = completedJob({ id: 'trial', created: new Date().toISOString(), count: 50, kind: 'trial' });

  const { result } = await invoke({ user, jobs: [trial], subscription });
  assert.equal(result.kind, 'trial');
  assert.equal(result.paid_access, false);
  assert.equal(result.limit, 50);
  assert.equal(result.remaining, 0);
});

test('a paid subscription is discovered by immutable Stripe metadata when local webhook caches are missing', async () => {
  const subscription = paidSubscription();
  const user = { id: 'user_1', email: 'austenwaugh@gmail.com' };

  const { response, result } = await invoke({
    user,
    jobs: [],
    subscription,
    searchSubscriptions: [subscription]
  });

  assert.equal(response.status, 200);
  assert.equal(result.kind, 'paid');
  assert.equal(result.paid_access, true);
  assert.equal(result.used, 0);
  assert.equal(result.remaining, 1000);
});

test('a subscription owned by another Stripe user cannot be borrowed through client-writable fields', async () => {
  const subscription = paidSubscription({ userId: 'different_user' });
  const user = {
    id: 'user_1',
    email: 'austenwaugh@gmail.com',
    subscription_id: subscription.id,
    subscription_status: 'active',
    subscription_paid_confirmed: true,
    precision_usage_period_start: '2099-01-01T00:00:00.000Z',
    is_owner: true,
    app_role: 'admin',
    role: 'admin'
  };

  const { result } = await invoke({ user, jobs: [], subscription });
  assert.equal(result.kind, 'trial');
  assert.equal(result.paid_access, false);
  assert.equal(result.limit, 50);
});

test('route deletion, merging, CSV imports, and cancellation cannot change the FetchJob ledger', () => {
  const source = readSource(endpointPath);
  assert.doesNotMatch(source, /SavedRoute/);
  assert.match(source, /loadUserPrecisionJobs/);
  assert.match(source, /reconcileLegacyPrecisionJobs/);
  const cancellation = readSource('base44/functions/stripeWebhook/entry.ts');
  assert.doesNotMatch(cancellation, /SavedRoute\.(delete|update)/);
});

test('frontend validation fails closed on partial or inconsistent usage snapshots', () => {
  assert.throws(() => normalizePrecisionUsageResponse({ success: false, complete: false }), /unavailable/i);
  assert.throws(() => normalizePrecisionUsageResponse({
    success: true,
    complete: true,
    version: 2,
    limit: 1000,
    used: 50,
    reserved: 0,
    meter_used: 0,
    remaining: 1000,
    lifetime_used: 100,
    trial_used: 50,
    trial_remaining: 0
  }), /inconsistent/i);
});

const completeUsageSnapshot = (overrides = {}) => ({
  success: true,
  complete: true,
  version: 2,
  kind: 'paid',
  paid_access: true,
  pro_access: false,
  limit: 1000,
  used: 50,
  reserved: 0,
  meter_used: 50,
  remaining: 950,
  lifetime_used: 100,
  trial_used: 50,
  trial_remaining: 0,
  percent: 5,
  start_available: true,
  start_blocker_code: null,
  start_blocker_job_ids: [],
  unsettled_reservation_count: 0,
  unsettled_job_ids: [],
  ...overrides
});

test('frontend rejects coerced or fractional authoritative usage evidence', () => {
  const wholeNumberFields = [
    'limit',
    'used',
    'reserved',
    'meter_used',
    'remaining',
    'lifetime_used',
    'trial_used',
    'trial_remaining',
    'percent',
  ];
  for (const field of wholeNumberFields) {
    for (const malformed of ['50', true, 50.5]) {
      assert.throws(
        () => normalizePrecisionUsageResponse(completeUsageSnapshot({
          [field]: malformed,
        })),
        new RegExp(`invalid ${field}`, 'i'),
        `${field}:${String(malformed)}`
      );
    }
  }
  for (const malformedVersion of ['2', true, 2.5, undefined]) {
    assert.throws(
      () => normalizePrecisionUsageResponse(completeUsageSnapshot({
        version: malformedVersion,
      })),
      /invalid version/i,
      `version:${String(malformedVersion)}`
    );
  }
  assert.throws(
    () => normalizePrecisionUsageResponse(completeUsageSnapshot({ percent: 6 })),
    /inconsistent allowance percentage/i
  );
});

test('frontend normalizes all-period start availability and unsettled reservation evidence', () => {
  const available = normalizePrecisionUsageResponse(completeUsageSnapshot());
  assert.equal(available.startAvailable, true);
  assert.equal(available.unsettledReservationCount, 0);
  assert.deepEqual(available.unsettledJobIds, []);
  assert.equal(hasUnsettledPrecisionReservation(available), false);

  const blocked = normalizePrecisionUsageResponse(completeUsageSnapshot({
    start_available: false,
    start_blocker_code: 'precision_reservation_unsettled',
    start_blocker_job_ids: ['old_unsettled'],
    unsettled_reservation_count: 1,
    unsettled_job_ids: ['old_unsettled']
  }));
  assert.equal(blocked.startAvailable, false);
  assert.equal(blocked.startBlockerCode, 'precision_reservation_unsettled');
  assert.deepEqual(blocked.startBlockerJobIds, ['old_unsettled']);
  assert.equal(blocked.unsettledReservationCount, 1);
  assert.deepEqual(blocked.unsettledJobIds, ['old_unsettled']);
  assert.equal(hasUnsettledPrecisionReservation(blocked), true);

  for (const [startBlockerCode, startBlockerJobIds] of [
    ['precision_job_active', ['active_job']],
    ['multiple_active_precision_jobs', ['active_job_1', 'active_job_2']],
    ['precision_provider_outcome_unverifiable', ['ambiguous_job']]
  ]) {
    const controlBlocked = normalizePrecisionUsageResponse(completeUsageSnapshot({
      start_available: false,
      start_blocker_code: startBlockerCode,
      start_blocker_job_ids: startBlockerJobIds
    }));
    assert.equal(controlBlocked.startAvailable, false);
    assert.equal(controlBlocked.startBlockerCode, startBlockerCode);
    assert.deepEqual(controlBlocked.startBlockerJobIds, startBlockerJobIds);
    assert.equal(hasUnsettledPrecisionReservation(controlBlocked), false);
  }

  const exhausted = normalizePrecisionUsageResponse(completeUsageSnapshot({
    used: 1000,
    meter_used: 1000,
    remaining: 0,
    percent: 100,
    start_available: false
  }));
  assert.equal(exhausted.startBlockerCode, null);
  assert.equal(exhausted.startAvailable, false);
});

test('frontend fails closed when reservation evidence or start availability is malformed or inconsistent', () => {
  assert.throws(() => normalizePrecisionUsageResponse(completeUsageSnapshot({
    start_available: 'true'
  })), /invalid start_available/i);
  assert.throws(() => normalizePrecisionUsageResponse(completeUsageSnapshot({
    unsettled_reservation_count: '0'
  })), /invalid unsettled_reservation_count/i);
  assert.throws(() => normalizePrecisionUsageResponse(completeUsageSnapshot({
    unsettled_reservation_count: 1,
    unsettled_job_ids: []
  })), /inconsistent unsettled reservation/i);
  assert.throws(() => normalizePrecisionUsageResponse(completeUsageSnapshot({
    unsettled_job_ids: ['duplicate', 'duplicate'],
    unsettled_reservation_count: 2,
    start_available: false,
    start_blocker_code: 'precision_reservation_unsettled',
    start_blocker_job_ids: ['duplicate', 'duplicate']
  })), /invalid unsettled_job_ids/i);
  assert.throws(() => normalizePrecisionUsageResponse(completeUsageSnapshot({
    start_available: false
  })), /inconsistent start availability/i);
  assert.throws(() => normalizePrecisionUsageResponse(completeUsageSnapshot({
    start_available: true,
    start_blocker_code: 'precision_reservation_unsettled',
    start_blocker_job_ids: ['old_unsettled'],
    unsettled_reservation_count: 1,
    unsettled_job_ids: ['old_unsettled']
  })), /inconsistent start availability/i);
  assert.throws(() => normalizePrecisionUsageResponse(completeUsageSnapshot({
    start_available: false,
    start_blocker_code: 'unknown_blocker',
    start_blocker_job_ids: ['job_1']
  })), /invalid start_blocker_code/i);
  assert.throws(() => normalizePrecisionUsageResponse(completeUsageSnapshot({
    start_available: false,
    start_blocker_code: 'precision_job_active',
    start_blocker_job_ids: []
  })), /inconsistent start blocker/i);
  assert.throws(() => normalizePrecisionUsageResponse(completeUsageSnapshot({
    start_available: false,
    start_blocker_code: 'multiple_active_precision_jobs',
    start_blocker_job_ids: ['job_1']
  })), /inconsistent multiple-active blocker/i);
});
