import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');
const livePaths = [
  'base44/functions/fetchAreaProperties/entry.ts',
  'base44/functions/startBatchDataPull/entry.ts'
];
const previewPath = 'base44/functions/previewBatchDataArea/entry.ts';

function loadHandler(path, { base44, stripeApi = {}, ClientImpl = null, env = {} }) {
  const transpiled = ts.transpileModule(readSource(path), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: path,
    reportDiagnostics: true
  });
  const errors = (transpiled.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], `${path} contains TypeScript syntax errors`);

  let handler;
  class FakeStripe { constructor() { return stripeApi; } }
  class DefaultClient {
    async connect() {}
    async query() { return { rows: [] }; }
    async end() {}
  }
  const executable = transpiled.outputText.replace(/^import .*;\s*$/gm, '');
  vm.runInNewContext(executable, {
    console,
    createClientFromRequest: () => base44,
    Deno: {
      env: {
        get: (key) => {
          if (Object.prototype.hasOwnProperty.call(env, key)) {
            return typeof env[key] === 'function' ? env[key]() : env[key];
          }
          if (key === 'STRIPE_SECRET_KEY') return 'sk_test';
          if (key === 'DATABASE_URL') return 'test_value';
          return undefined;
        }
      },
      serve: (registeredHandler) => { handler = registeredHandler; }
    },
    Stripe: FakeStripe,
    Client: ClientImpl || DefaultClient,
    Request,
    Response,
    TextEncoder,
    crypto: globalThis.crypto,
    fetch: async () => new Response(JSON.stringify({
      County: { FIPS: '04013', name: 'Maricopa' },
      State: { code: 'AZ', name: 'Arizona' }
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    setTimeout,
    clearTimeout
  }, { filename: path });
  return handler;
}

function paidSubscription({
  userId = 'user_1',
  id = 'sub_paid',
  invoiceId = 'in_current',
  status = 'active',
  invoiceStatus = 'paid',
  amountPaid = 9900,
  periodStart = Math.floor(Date.now() / 1000) - 60,
  periodEnd = periodStart + 30 * 24 * 60 * 60
} = {}) {
  return {
    id,
    status,
    trial_end: null,
    current_period_start: periodStart,
    current_period_end: periodEnd,
    metadata: { base44_user_id: userId, subscription_tier: 'precision' },
    items: { data: [{ price: { unit_amount: 9900 } }] },
    latest_invoice: {
      id: invoiceId,
      subscription: id,
      status: invoiceStatus,
      amount_paid: amountPaid,
      period_start: periodStart,
      period_end: periodEnd,
      lines: { data: [{ subscription: id, period: { start: periodStart, end: periodEnd } }] }
    }
  };
}

function hashes(prefix, count) {
  return Array.from({ length: count }, (_, index) => `${prefix}_${index + 1}`);
}

function makeBase44({ user, jobs, routes, usageSnapshot, createdJobs = [], events = [] }) {
  const matches = (record, filter) => Object.entries(filter).every(([key, value]) => record[key] === value);
  const page = (records, filter, limit = 500, skip = 0) => records.filter((record) => matches(record, filter)).slice(skip, skip + limit);
  const fetchJobFilter = async (filter, _sort, limit, skip) => page(jobs, filter, limit, skip);
  return {
    auth: { me: async () => user },
    entities: {
      FetchJob: { filter: fetchJobFilter }
    },
    functions: {
      invoke: async (name) => {
        assert.equal(name, 'getPrecisionUsage');
        return { data: usageSnapshot };
      }
    },
    asServiceRole: {
      entities: {
        SavedRoute: { filter: async (filter, _sort, limit, skip) => page(routes, filter, limit, skip) },
        FetchJob: {
          filter: fetchJobFilter,
          create: async (payload) => {
            const job = { id: `created_${createdJobs.length + 1}`, ...payload };
            createdJobs.push(job);
            jobs.push(job);
            events.push('job:create');
            return job;
          }
        }
      },
      functions: {
        invoke: async () => ({ data: { accepted: true } })
      }
    }
  };
}

function requestBody(requestedProperties = 1000) {
  return {
    dry_run: true,
    polygon: [
      { lat: 33.44, lng: -112.08 },
      { lat: 33.45, lng: -112.08 },
      { lat: 33.45, lng: -112.07 }
    ],
    requested_properties: requestedProperties,
    sold_months: 12
  };
}

function startRequestBody(requestedProperties = 100) {
  const body = requestBody(requestedProperties);
  delete body.dry_run;
  return body;
}

async function invokeStartWithEntitlementSequence(path, { user, subscriptions, requested = 100 }) {
  const jobs = [];
  const createdJobs = [];
  const events = [];
  let retrieveIndex = 0;
  const stripeApi = {
    subscriptions: {
      retrieve: async () => {
        const subscription = subscriptions[Math.min(retrieveIndex, subscriptions.length - 1)];
        retrieveIndex += 1;
        events.push(`stripe:${subscription.latest_invoice.id}`);
        return subscription;
      }
    }
  };
  class TestClient {
    async connect() { events.push('db:connect'); }
    async query(sql) {
      if (sql.includes('pg_advisory_xact_lock')) events.push('db:locked');
      return { rows: [] };
    }
    async end() { events.push('db:end'); }
  }
  const base44 = makeBase44({ user, jobs, routes: [], usageSnapshot: null, createdJobs, events });
  const handler = loadHandler(path, { base44, stripeApi, ClientImpl: TestClient });
  const response = await handler(new Request('https://app.example.com/function', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(startRequestBody(requested))
  }));
  return { response, result: await response.json(), createdJobs, events, retrieveIndex };
}

async function invokeStartWithBetaSequence(path, { user, grants, jobs = [], requested = 100, stripeSecret = 'sk_test' }) {
  const createdJobs = [];
  const events = [];
  let betaReadCount = 0;
  class TestClient {
    async connect() { events.push('db:connect'); }
    async query(sql) {
      if (sql.includes('pg_advisory_xact_lock')) events.push('db:locked');
      return { rows: [] };
    }
    async end() { events.push('db:end'); }
  }
  const base44 = makeBase44({ user, jobs, routes: [], usageSnapshot: null, createdJobs, events });
  const handler = loadHandler(path, {
    base44,
    stripeApi: { subscriptions: {} },
    ClientImpl: TestClient,
    env: {
      STRIPE_SECRET_KEY: stripeSecret,
      BETA_ACCESS_GRANTS: () => {
        const secret = grants[Math.min(betaReadCount, grants.length - 1)];
        betaReadCount += 1;
        events.push(`beta:${betaReadCount}`);
        return secret;
      }
    }
  });
  const response = await handler(new Request('https://app.example.com/function', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(startRequestBody(requested))
  }));
  return { response, result: await response.json(), createdJobs, events, betaReadCount };
}

async function invokeLive(path, { user, jobs, routes, subscription, requested = 1000, env = {}, body = null }) {
  const base44 = makeBase44({ user, jobs, routes, usageSnapshot: null });
  const handler = loadHandler(path, {
    base44,
    stripeApi: { subscriptions: { retrieve: async () => subscription } },
    env
  });
  const response = await handler(new Request('https://app.example.com/function', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || requestBody(requested))
  }));
  return { response, result: await response.json() };
}

async function invokePreview({ user, routes, usageSnapshot, requested = 1000 }) {
  const base44 = makeBase44({ user, jobs: [], routes, usageSnapshot });
  const handler = loadHandler(previewPath, { base44 });
  const response = await handler(new Request('https://app.example.com/function', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody(requested))
  }));
  return { response, result: await response.json() };
}

function settledJob({
  id,
  kind,
  count,
  periodStart,
  periodEnd,
  subscriptionId,
  created,
  userId = 'user_1',
  userEmail = 'austenwaugh@gmail.com'
}) {
  return {
    id,
    status: 'completed',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    user_email: userEmail,
    precision_usage_user_id: userId,
    precision_usage_kind: kind,
    ...(subscriptionId ? { precision_subscription_id: subscriptionId } : {}),
    ...(periodStart ? { precision_usage_period_start: periodStart } : {}),
    ...(periodEnd ? { precision_usage_period_end: periodEnd } : {}),
    precision_usage_reserved: 0,
    precision_usage_count: count,
    precision_usage_recorded_at: created,
    created_date: created,
    started_at: created
  };
}

function betaGrantSecret({
  userId = 'beta_user_1',
  grantId = 'beta_grant_1',
  status = 'active',
  precisionLimit = 1000,
  startsAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  endsAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  canvasSeats = 1
} = {}) {
  return JSON.stringify({
    version: 1,
    grants: {
      [userId]: {
        grant_id: grantId,
        status,
        precision_limit: precisionLimit,
        starts_at: startsAt,
        ends_at: endsAt,
        canvas_seats: canvasSeats
      }
    }
  });
}

test('all Precision endpoints cap a paid request at the current-period FetchJob remainder', async () => {
  const subscription = paidSubscription();
  const periodStart = new Date(subscription.current_period_start * 1000).toISOString();
  const user = { id: 'user_1', email: 'austenwaugh@gmail.com', subscription_id: subscription.id };
  const routes = [
    { id: 'trial_route', manager_id: user.id, created_by: user.email, route_mode: 'precision', property_hashes: hashes('trial', 50) },
    { id: 'paid_route', manager_id: user.id, created_by: user.email, route_mode: 'precision', property_hashes: hashes('paid', 50) }
  ];
  const jobs = [
    settledJob({ id: 'trial', kind: 'trial', count: 50, created: new Date((subscription.current_period_start - 3600) * 1000).toISOString() }),
    settledJob({ id: 'paid', kind: 'paid', count: 50, periodStart, created: new Date((subscription.current_period_start + 10) * 1000).toISOString() })
  ];

  for (const path of livePaths) {
    const { response, result } = await invokeLive(path, { user, jobs, routes, subscription });
    assert.equal(response.status, 200, path);
    assert.equal(result.requested_properties, 950, path);
    assert.equal(result.paid_properties_used, 50, path);
    assert.equal(result.paid_properties_remaining, 950, path);
    assert.equal(result.paid_property_limit, 1000, path);
    assert.equal(result.excluded_route_home_count, 100, 'saved trial and paid routes remain excluded from reacquisition');
  }

  const preview = await invokePreview({
    user,
    routes,
    usageSnapshot: {
      success: true,
      complete: true,
      version: 2,
      paid_access: true,
      limit: 1000,
      used: 50,
      reserved: 0,
      meter_used: 50,
      remaining: 950,
      lifetime_used: 100,
      period_start: periodStart
    }
  });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.result.requested_properties, 950);
  assert.equal(preview.result.paid_properties_used, 50);
});

test('renewal resets paid usage to zero without restoring the consumed trial', async () => {
  const subscription = paidSubscription();
  const priorPeriod = new Date((subscription.current_period_start - 31 * 24 * 60 * 60) * 1000).toISOString();
  const user = { id: 'user_1', email: 'austenwaugh@gmail.com', subscription_id: subscription.id };
  const jobs = [
    settledJob({ id: 'trial', kind: 'trial', count: 50, created: '2026-06-01T00:00:00.000Z' }),
    settledJob({ id: 'prior_paid', kind: 'paid', count: 1000, periodStart: priorPeriod, created: '2026-06-15T00:00:00.000Z' })
  ];

  for (const path of livePaths) {
    const { response, result } = await invokeLive(path, { user, jobs, routes: [], subscription });
    assert.equal(response.status, 200, path);
    assert.equal(result.requested_properties, 1000, path);
    assert.equal(result.paid_properties_used, 0, path);
    assert.equal(result.paid_properties_remaining, 1000, path);
  }
});

test('incomplete payment and spoofed local flags never grant the paid cap', async () => {
  const subscription = paidSubscription({ status: 'incomplete', invoiceStatus: 'open', amountPaid: 0 });
  const user = {
    id: 'user_1',
    email: 'austenwaugh@gmail.com',
    subscription_id: subscription.id,
    subscription_status: 'active',
    subscription_tier: 'precision',
    subscription_paid_confirmed: true,
    precision_usage_period_start: '2099-01-01T00:00:00.000Z',
    is_owner: true
  };
  const jobs = [settledJob({ id: 'trial', kind: 'trial', count: 50, created: '2026-07-13T00:00:00.000Z' })];

  for (const path of livePaths) {
    const { response, result } = await invokeLive(path, { user, jobs, routes: [], subscription });
    assert.equal(response.status, 403, path);
    assert.equal(result.error, 'paid_precision_required', path);
  }

  const preview = await invokePreview({
    user,
    routes: [],
    usageSnapshot: {
      success: true,
      complete: true,
      version: 2,
      paid_access: false,
      limit: 50,
      used: 50,
      reserved: 0,
      meter_used: 50,
      remaining: 0,
      lifetime_used: 50,
      period_start: null
    }
  });
  assert.equal(preview.response.status, 200);
  assert.equal(preview.result.account_type, 'free');
  assert.equal(preview.result.max_allowed_properties, 0);
  assert.equal(preview.result.paid_property_limit, null);
});

test('both live start paths use the same account advisory lock and service-owned reservation fields', () => {
  for (const path of livePaths) {
    const source = readSource(path);
    assert.match(source, /pg_advisory_xact_lock/);
    assert.match(source, /precision_usage_user_id:\s*user\.id/);
    assert.match(source, /precision_usage_reserved:\s*reservedProperties/);
    assert.match(source, /const lockedEntitlement = await resolvePrecisionEntitlement\(user\);[\s\S]*const lockedAllowance = await getPrecisionAllowance\(base44, user, lockedEntitlement\);/);
    assert.match(source, /precision_usage_kind:\s*lockedEntitlement\.kind/);
    assert.doesNotMatch(source, /subscription_paid_confirmed\s*===\s*true/);
    assert.doesNotMatch(source, /user\?\.is_owner/);
  }
});

test('both start paths refresh entitlement after acquiring the account lock and stamp the refreshed billing period', async () => {
  const now = Math.floor(Date.now() / 1000);
  const preflight = paidSubscription({
    periodStart: now - 3600,
    periodEnd: now + 30 * 24 * 60 * 60,
    invoiceId: 'in_preflight'
  });
  const locked = paidSubscription({
    periodStart: now - 60,
    periodEnd: now + 31 * 24 * 60 * 60,
    invoiceId: 'in_locked'
  });
  const user = { id: 'user_1', email: 'austenwaugh@gmail.com', subscription_id: preflight.id };

  for (const path of livePaths) {
    const { response, result, createdJobs, events, retrieveIndex } = await invokeStartWithEntitlementSequence(path, {
      user,
      subscriptions: [preflight, locked]
    });
    assert.equal(response.status, 200, path);
    assert.equal(retrieveIndex, 2, `${path} must resolve Stripe once before and once inside the lock`);
    assert.deepEqual(events.filter((event) => event === 'db:locked' || event.startsWith('stripe:') || event === 'job:create'), [
      'stripe:in_preflight',
      'db:locked',
      'stripe:in_locked',
      'job:create'
    ], path);
    assert.equal(createdJobs.length, 1, path);
    assert.equal(createdJobs[0].precision_invoice_id, 'in_locked', path);
    assert.equal(createdJobs[0].precision_usage_period_start, new Date(locked.current_period_start * 1000).toISOString(), path);
    assert.equal(result.precision_usage_period_start, new Date(locked.current_period_start * 1000).toISOString(), path);
  }
});

test('both start paths reject paid-only criteria when the locked entitlement loses paid access', async () => {
  const preflight = paidSubscription();
  const locked = paidSubscription({ status: 'incomplete', invoiceStatus: 'open', amountPaid: 0, invoiceId: 'in_incomplete' });
  const user = { id: 'user_1', email: 'austenwaugh@gmail.com', subscription_id: preflight.id };

  for (const path of livePaths) {
    const { response, result, createdJobs, events, retrieveIndex } = await invokeStartWithEntitlementSequence(path, {
      user,
      subscriptions: [preflight, locked],
      requested: 100
    });
    assert.equal(response.status, 403, path);
    assert.equal(result.error, 'paid_precision_required', path);
    assert.equal(retrieveIndex, 2, path);
    assert.equal(createdJobs.length, 0, path);
    assert.deepEqual(events.filter((event) => event === 'db:locked' || event.startsWith('stripe:') || event === 'job:create'), [
      'stripe:in_current',
      'db:locked',
      'stripe:in_incomplete'
    ], path);
  }
});

test('beta grants expose only the exact remaining fixed allowance in both dry-run paths', async () => {
  const user = { id: 'beta_user_1', email: 'devinfgalligan@gmail.com' };
  const grantId = 'beta_devin_2026';
  const periodStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const grantSecret = betaGrantSecret({
    userId: user.id,
    grantId,
    precisionLimit: 875,
    startsAt: periodStart,
    endsAt: periodEnd,
    canvasSeats: 2
  });
  const commonJob = {
    kind: 'paid',
    periodStart,
    periodEnd,
    subscriptionId: grantId,
    userId: user.id,
    userEmail: user.email,
    created: new Date().toISOString()
  };
  const matchingReservation = settledJob({ id: 'matching_reserved', count: 0, ...commonJob });
  matchingReservation.status = 'pending';
  matchingReservation.precision_usage_reserved = 125;
  delete matchingReservation.precision_usage_recorded_at;
  const wrongPeriodEnd = new Date(new Date(periodEnd).getTime() + 24 * 60 * 60 * 1000).toISOString();
  const jobs = [
    settledJob({ id: 'matching_used', count: 325, ...commonJob }),
    matchingReservation,
    settledJob({ id: 'other_grant', count: 400, ...commonJob, subscriptionId: 'beta_someone_else' }),
    settledJob({ id: 'changed_window', count: 500, ...commonJob, periodEnd: wrongPeriodEnd }),
    settledJob({ id: 'prior_trial', kind: 'trial', count: 50, userId: user.id, userEmail: user.email, created: new Date().toISOString() })
  ];
  const premiumBody = requestBody(1000);
  premiumBody.sold_months = 1;

  for (const path of livePaths) {
    const { response, result } = await invokeLive(path, {
      user,
      jobs,
      routes: [],
      requested: 1000,
      body: premiumBody,
      env: { BETA_ACCESS_GRANTS: grantSecret, STRIPE_SECRET_KEY: undefined }
    });
    assert.equal(response.status, 200, path);
    assert.equal(result.requested_properties, 425, path);
    assert.equal(result.paid_properties_used, 450, path);
    assert.equal(result.paid_properties_reserved, 125, path);
    assert.equal(result.paid_properties_remaining, 425, path);
    assert.equal(result.paid_property_limit, 875, path);
    assert.equal(result.precision_usage_period_start, periodStart, path);
  }
});

test('beta live starts recheck the grant under lock and stamp the exact paid meter identity', async () => {
  const user = { id: 'beta_user_1', email: 'devinfgalligan@gmail.com' };
  const grantId = 'beta_devin_2026';
  const periodStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const grantSecret = betaGrantSecret({ userId: user.id, grantId, startsAt: periodStart, endsAt: periodEnd });

  for (const path of livePaths) {
    const { response, result, createdJobs, events, betaReadCount } = await invokeStartWithBetaSequence(path, {
      user,
      grants: [grantSecret],
      requested: 1000,
      stripeSecret: undefined
    });
    assert.equal(response.status, 200, path);
    assert.equal(betaReadCount, 2, `${path} must resolve beta access before and after taking the lock`);
    assert.deepEqual(events.filter((event) => event.startsWith('beta:') || event === 'db:locked' || event === 'job:create'), [
      'beta:1',
      'db:locked',
      'beta:2',
      'job:create'
    ], path);
    assert.equal(createdJobs.length, 1, path);
    assert.equal(createdJobs[0].precision_usage_kind, 'paid', path);
    assert.equal(createdJobs[0].precision_subscription_id, grantId, path);
    assert.equal(createdJobs[0].precision_usage_period_start, periodStart, path);
    assert.equal(createdJobs[0].precision_usage_period_end, periodEnd, path);
    assert.equal(Object.prototype.hasOwnProperty.call(createdJobs[0], 'precision_invoice_id'), false, path);
    assert.equal(createdJobs[0].precision_usage_reserved, 1000, path);
    assert.equal(createdJobs[0].dry_run_metadata.paid_property_limit, 1000, path);
    assert.equal(result.requested_properties, 1000, path);
    assert.equal(result.paid_property_limit, 1000, path);
    assert.equal(result.precision_usage_period_start, periodStart, path);
  }
});

test('beta live starts fail if the immutable grant expires before the lock recheck', async () => {
  const user = { id: 'beta_user_1', email: 'devinfgalligan@gmail.com' };
  const activeSecret = betaGrantSecret({ userId: user.id });
  const expiredSecret = betaGrantSecret({
    userId: user.id,
    startsAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    endsAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
  });

  for (const path of livePaths) {
    const { response, result, createdJobs, betaReadCount } = await invokeStartWithBetaSequence(path, {
      user,
      grants: [activeSecret, expiredSecret],
      requested: 100
    });
    assert.equal(response.status, 403, path);
    assert.equal(result.error, 'paid_precision_required', path);
    assert.equal(betaReadCount, 2, path);
    assert.equal(createdJobs.length, 0, path);
  }
});

test('wrong immutable IDs, expired windows, and malformed beta secrets fail closed', async () => {
  const user = { id: 'beta_user_1', email: 'devinfgalligan@gmail.com' };
  const deniedSecrets = [
    betaGrantSecret({ userId: user.email }),
    betaGrantSecret({
      userId: user.id,
      startsAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      endsAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
    }),
    '{not-json',
    betaGrantSecret({ userId: user.id, precisionLimit: '1000' }),
    betaGrantSecret({ userId: user.id, precisionLimit: 1001 }),
    betaGrantSecret({ userId: user.id, canvasSeats: '1' }),
    betaGrantSecret({ userId: user.id, canvasSeats: 101 })
  ];

  for (const path of livePaths) {
    for (const secret of deniedSecrets) {
      const { response, result } = await invokeLive(path, {
        user,
        jobs: [],
        routes: [],
        requested: 100,
        env: { BETA_ACCESS_GRANTS: secret }
      });
      assert.equal(response.status, 403, path);
      assert.equal(result.error, 'paid_precision_required', path);
    }
  }
});
