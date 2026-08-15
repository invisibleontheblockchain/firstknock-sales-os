import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import {
  buildRequestedPrecisionCriteria,
  precisionPolygonHash,
} from '../base44/functions/_shared/precisionActiveJobCriteria.js';

const endpointPaths = [
  'base44/functions/fetchAreaProperties/entry.ts',
  'base44/functions/startBatchDataPull/entry.ts',
];
const sharedPath = 'base44/functions/_shared/precisionActiveJobCriteria.js';
const normalPolygon = [
  { lat: 33.4, lng: -112.2 },
  { lat: 33.6, lng: -112.2 },
  { lat: 33.6, lng: -112.0 },
];
const oversizedPolygon = [
  { lat: 25, lng: -125 },
  { lat: 49, lng: -125 },
  { lat: 49, lng: -67 },
  { lat: 25, lng: -67 },
];
const routeFilters = {
  propertyTypes: ['Single Family'],
  excludeCommercial: true,
  excludeCondos: true,
  excludeLand: true,
};

function paidSubscription({
  userId = 'user_1',
  id = 'sub_paid',
  status = 'active',
  amountPaid = 9900,
  invoiceStatus = 'paid',
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
    status,
    trial_end: status === 'trialing' ? now + 86400 : null,
    current_period_start: now - 60,
    current_period_end: now + 30 * 86400,
    metadata: { base44_user_id: userId },
    items: { data: [{ price: { unit_amount: 9900 } }] },
    latest_invoice: status === 'trialing' ? null : {
      id: `in_${id}`,
      subscription: id,
      status: invoiceStatus,
      amount_paid: amountPaid,
      period_start: now - 60,
      period_end: now + 30 * 86400,
      lines: {
        data: [{
          subscription: id,
          period: { start: now - 60, end: now + 30 * 86400 },
        }],
      },
    },
  };
}

function requestBody(overrides = {}) {
  return {
    polygon: normalPolygon,
    count_mode: 'fixed',
    requested_properties: 50,
    min_price: 100000,
    max_price: null,
    sold_months: 12,
    ownership_range_mode: 'quick',
    route_filters: routeFilters,
    route_bounds: { enabled: false },
    repull_mode: 'new_area',
    previous_pull_date: null,
    force_full_refresh: false,
    include_unresolved_followups: false,
    ...overrides,
  };
}

async function activeJob({
  id = 'active_1',
  status = 'running',
  userId = 'user_1',
  workspaceId = 'user_1',
  countMode = 'fixed',
  enteredCount = 50,
  effectiveCount = 50,
  createdDate = '2026-07-25T12:00:00.000Z',
} = {}) {
  const hash = await precisionPolygonHash(normalPolygon);
  const criteria = buildRequestedPrecisionCriteria({
    polygon_hash: hash,
    count_mode: countMode,
    entered_count: enteredCount,
    effective_count: effectiveCount,
    min_price: 100000,
    max_price: null,
    sold_months: 12,
    ownership_range_mode: 'quick',
    ownership_range_days: null,
    route_filters: routeFilters,
    repull_mode: 'new_area',
    previous_pull_date: null,
    force_full_refresh: false,
    include_unresolved_followups: false,
    route_bounds: { enabled: false },
    immutable_user_id: userId,
    workspace_id: workspaceId,
  });
  return {
    id,
    status,
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    include_mls: false,
    precision_usage_user_id: userId,
    user_email: 'owner@example.com',
    precision_usage_kind: 'paid',
    precision_usage_reserved: effectiveCount,
    precision_usage_count: 0,
    created_date: createdDate,
    started_at: createdDate,
    polygon: normalPolygon,
    polygon_hash: hash,
    total_expected: effectiveCount,
    dry_run_metadata: {
      criteria_reference_at: createdDate,
      workspace_id: workspaceId,
      precision_criteria: criteria,
    },
  };
}

function settledPaidUsage(subscription, count) {
  return {
    id: `used_${count}`,
    status: 'completed',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    precision_usage_user_id: 'user_1',
    user_email: 'owner@example.com',
    precision_usage_kind: 'paid',
    precision_usage_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
    precision_usage_reserved: 0,
    precision_usage_count: count,
    precision_usage_recorded_at: new Date().toISOString(),
    created_date: new Date().toISOString(),
  };
}

function makeHarness(path, {
  user = {
    id: 'user_1',
    email: 'owner@example.com',
    subscription_id: 'sub_paid',
  },
  subscription = paidSubscription(),
  jobs: initialJobs = [],
  routes = [],
  betaAccessGrants = null,
  createError = null,
  processorError = null,
  stripeError = null,
  stripeRetrieveError = null,
  stripeListError = null,
  stripeSearchError = null,
  fccError = null,
  fccStatus = 200,
  fccPayload = null,
} = {}) {
  const jobs = structuredClone(initialJobs);
  const events = [];
  const matches = (record, filter) =>
    Object.entries(filter).every(([key, value]) => record[key] === value);
  const filterJobs = async (filter, _sort, limit = 500, skip = 0) =>
    jobs.filter(job => matches(job, filter)).slice(skip, skip + limit);
  const base44 = {
    auth: { me: async () => user },
    asServiceRole: {
      entities: {
        SavedRoute: {
          filter: async (filter, _sort, limit = 500, skip = 0) =>
            routes.filter(route => matches(route, filter)).slice(skip, skip + limit),
        },
        FetchJob: {
          filter: filterJobs,
          get: async id => jobs.find(job => job.id === id) || null,
          create: async payload => {
            events.push({ type: 'job:create', payload });
            if (createError) throw createError;
            const job = { id: `created_${jobs.length + 1}`, ...payload };
            jobs.push(job);
            return job;
          },
        },
      },
      functions: {
        invoke: async (name, body) => {
          events.push({ type: 'processor:invoke', name, body });
          if (processorError) throw processorError;
          return { data: { accepted: true } };
        },
      },
    },
  };

  class FakeStripe {
    constructor() {
      return {
        subscriptions: {
          retrieve: async () => {
            events.push({ type: 'stripe:retrieve' });
            if (stripeRetrieveError || stripeError) throw stripeRetrieveError || stripeError;
            return subscription;
          },
          list: async () => {
            events.push({ type: 'stripe:list' });
            if (stripeListError || stripeError) throw stripeListError || stripeError;
            return { data: subscription ? [subscription] : [] };
          },
          search: async () => {
            events.push({ type: 'stripe:search' });
            if (stripeSearchError || stripeError) throw stripeSearchError || stripeError;
            return { data: subscription ? [subscription] : [] };
          },
        },
      };
    }
  }
  class FakeClient {
    async connect() { events.push({ type: 'db:connect' }); }
    async query(sql) {
      if (sql.includes('pg_try_advisory_xact_lock')) {
        events.push({ type: 'db:locked' });
        return { rows: [{ claimed: true }] };
      }
      return { rows: [] };
    }
    async end() { events.push({ type: 'db:end' }); }
  }

  const transpiled = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: path,
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error
  );
  assert.deepEqual(errors, [], path);
  const shared = readFileSync(sharedPath, 'utf8').replace(/^export\s+/gm, '');
  const endpoint = transpiled.outputText.replace(/^import .*;\s*$/gm, '');
  let handler;
  vm.runInNewContext(`${shared}\n${endpoint}`, {
    console,
    createClientFromRequest: () => base44,
    Stripe: FakeStripe,
    Client: FakeClient,
    Deno: {
      env: {
        get: key => {
          if (key === 'STRIPE_SECRET_KEY') return 'sk_test';
          if (key === 'DATABASE_URL') return 'postgres://test';
          if (key === 'BETA_ACCESS_GRANTS') return betaAccessGrants;
          return null;
        },
      },
      serve: callback => { handler = callback; },
    },
    Request,
    Response,
    TextEncoder,
    crypto: globalThis.crypto,
    fetch: async () => {
      events.push({ type: 'fcc:lookup' });
      if (fccError) throw fccError;
      return new Response(JSON.stringify(fccPayload || {
        County: { FIPS: '04013', name: 'Maricopa' },
        State: { code: 'AZ', name: 'Arizona' },
      }), {
        status: fccStatus,
        headers: { 'content-type': 'application/json' },
      });
    },
    setTimeout,
    clearTimeout,
  }, { filename: path });
  return { handler, events, jobs };
}

async function invokePath(path, config, body) {
  const harness = makeHarness(path, config);
  const response = await harness.handler(new Request('https://app.example.com/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return {
    path,
    response,
    result: await response.json(),
    events: harness.events,
    jobs: harness.jobs,
  };
}

async function invokeBoth(config, body) {
  const results = [];
  for (const path of endpointPaths) {
    results.push(await invokePath(path, config, body));
  }
  return results;
}

function mutationEvents(result) {
  return result.events.filter(event =>
    event.type === 'job:create' || event.type === 'processor:invoke'
  );
}

function blockedDecisionSideEffects(result) {
  return result.events.filter(event =>
    [
      'fcc:lookup',
      'stripe:retrieve',
      'stripe:list',
      'stripe:search',
      'job:create',
      'processor:invoke',
    ].includes(event.type)
  );
}

test('both adapters preserve equivalent free, trial, paid and dynamic beta/grant entitlement decisions', async () => {
  const freeUser = { id: 'user_1', email: 'owner@example.com' };
  for (const result of await invokeBoth(
    { user: freeUser, subscription: null },
    requestBody({ requested_properties: 50 })
  )) {
    assert.equal(result.response.status, 200, result.path);
    assert.equal(result.result.requested_properties, 50, result.path);
    assert.equal(result.jobs.at(-1).precision_usage_kind, 'trial', result.path);
  }

  const trialSubscription = paidSubscription({ status: 'trialing', id: 'sub_trial' });
  const trialUser = {
    id: 'user_1',
    email: 'owner@example.com',
    subscription_id: trialSubscription.id,
  };
  for (const result of await invokeBoth(
    { user: trialUser, subscription: trialSubscription },
    requestBody({
      requested_properties: 50,
      ownership_range_mode: 'custom',
      ownership_min_days: 59,
      ownership_max_days: 365,
    })
  )) {
    assert.equal(result.response.status, 200, result.path);
    assert.equal(result.jobs.at(-1).precision_usage_kind, 'trial', result.path);
    assert.equal(result.result.ownership_range_mode, 'custom', result.path);
  }

  const paid = paidSubscription();
  for (const result of await invokeBoth(
    { subscription: paid },
    requestBody({ requested_properties: 1000 })
  )) {
    assert.equal(result.response.status, 200, result.path);
    assert.equal(result.result.requested_properties, 1000, result.path);
    assert.equal(result.jobs.at(-1).precision_usage_kind, 'paid', result.path);
  }

  const grantNow = Date.now();
  const grants = JSON.stringify({
    version: 1,
    grants: {
      user_granted: {
        status: 'active',
        grant_id: 'grant_700',
        precision_limit: 700,
        canvas_seats: 2,
        starts_at: new Date(grantNow - 86400_000).toISOString(),
        ends_at: new Date(grantNow + 365 * 86400_000).toISOString(),
      },
    },
  });
  const grantedUser = { id: 'user_granted', email: 'granted@example.com' };
  for (const result of await invokeBoth(
    {
      user: grantedUser,
      subscription: null,
      betaAccessGrants: grants,
    },
    requestBody({ count_mode: 'max_available', requested_properties: undefined })
  )) {
    assert.equal(result.response.status, 200, result.path);
    assert.equal(result.result.requested_properties, 700, result.path);
    assert.equal(result.jobs.at(-1).precision_subscription_id, 'grant_700', result.path);
    assert.equal(result.jobs.at(-1).precision_usage_kind, 'paid', result.path);
  }
});

test('both adapters keep dry runs non-mutating and share the no-area-cap polygon policy', async () => {
  const body = requestBody({
    dry_run: true,
    polygon: oversizedPolygon,
    requested_properties: 50,
  });
  for (const result of await invokeBoth(
    { user: { id: 'user_1', email: 'owner@example.com' }, subscription: null },
    body
  )) {
    assert.equal(result.response.status, 200, result.path);
    assert.ok(result.result.area_sq_mi > 1000000, result.path);
    assert.equal(mutationEvents(result).length, 0, result.path);
    assert.equal(result.jobs.length, 0, result.path);
  }
});

test('both adapters apply fixed caps and locked Max Available without trusting allowance_estimate', async () => {
  for (const result of await invokeBoth(
    {
      user: { id: 'free_user', email: 'free@example.com' },
      subscription: null,
    },
    requestBody({ requested_properties: 1000 })
  )) {
    assert.equal(result.response.status, 200, result.path);
    assert.equal(result.result.requested_properties_before_cap, 1000, result.path);
    assert.equal(result.result.requested_properties, 50, result.path);
    assert.equal(result.result.entered_count, 1000, result.path);
    assert.equal(result.result.effective_count, 50, result.path);
    assert.equal(result.jobs.at(-1).dry_run_metadata.precision_criteria.entered_count, 1000, result.path);
    assert.equal(result.jobs.at(-1).dry_run_metadata.precision_criteria.effective_count, 50, result.path);
    assert.equal(Object.hasOwn(result.jobs.at(-1).dry_run_metadata, 'processor_token'), false, result.path);
    assert.match(result.jobs.at(-1).dry_run_metadata.processor_token_hash, /^[a-f0-9]{64}$/, result.path);
  }

  const paid = paidSubscription();
  const used = settledPaidUsage(paid, 161);
  for (const result of await invokeBoth(
    { subscription: paid, jobs: [used] },
    requestBody({ requested_properties: 1000 })
  )) {
    assert.equal(result.response.status, 200, result.path);
    assert.equal(result.result.requested_properties_before_cap, 1000, result.path);
    assert.equal(result.result.requested_properties, 839, result.path);
    assert.equal(result.jobs.at(-1).dry_run_metadata.precision_criteria.entered_count, 1000, result.path);
    assert.equal(result.jobs.at(-1).dry_run_metadata.precision_criteria.effective_count, 839, result.path);
  }

  for (const result of await invokeBoth(
    { subscription: paid },
    requestBody({
      count_mode: 'max_available',
      requested_properties: undefined,
      allowance_estimate: 12,
    })
  )) {
    assert.equal(result.response.status, 200, result.path);
    assert.equal(result.result.requested_properties, 1000, result.path);
    assert.equal(result.result.requested_properties_before_cap, 1000, result.path);
    assert.equal(result.jobs.at(-1).dry_run_metadata.precision_criteria.count_mode, 'max_available', result.path);
  }
});

test('both adapters normalize quick/custom ownership identically and reject malformed requests', async () => {
  const paid = paidSubscription();
  for (const ownership of [
    {
      body: requestBody({ ownership_range_mode: 'quick', sold_months: 12 }),
      expectedMode: 'quick',
      expectedRange: null,
    },
    {
      body: requestBody({
        ownership_range_mode: 'custom',
        ownership_min_days: 59,
        ownership_max_days: 365,
      }),
      expectedMode: 'custom',
      expectedRange: { min: 59, max: 365 },
    },
  ]) {
    for (const result of await invokeBoth({ subscription: paid }, ownership.body)) {
      assert.equal(result.response.status, 200, result.path);
      assert.equal(result.result.ownership_range_mode, ownership.expectedMode, result.path);
      assert.deepEqual(
        JSON.parse(JSON.stringify(result.result.ownership_range_days)),
        ownership.expectedRange,
        result.path
      );
    }
  }

  const malformedBodies = [
    requestBody({ polygon: [{ lat: 1, lng: 1 }, { lat: 1, lng: 1 }, { lat: 1, lng: 1 }] }),
    requestBody({ requested_properties: { value: 50 } }),
    requestBody({ max_price: 50000 }),
    requestBody({
      ownership_range_mode: 'custom',
      ownership_min_days: 365,
      ownership_max_days: 59,
    }),
    requestBody({
      route_bounds: {
        enabled: true,
        mode: 'home_round_trip',
        start_location: { lat: 999, lng: 0 },
        end_location: { lat: 0, lng: 0 },
      },
    }),
  ];
  for (const body of malformedBodies) {
    for (const result of await invokeBoth({ subscription: paid }, body)) {
      assert.equal(result.response.status, 400, `${result.path}: ${JSON.stringify(body)}`);
      assert.equal(mutationEvents(result).length, 0, result.path);
    }
  }
});

test('both adapters reject null and array JSON bodies as structured 400 errors', async () => {
  const paid = paidSubscription();
  for (const body of [null, [], ['not', 'an', 'object']]) {
    for (const result of await invokeBoth({ subscription: paid }, body)) {
      assert.equal(result.response.status, 400, result.path);
      assert.equal(result.result.error, 'invalid_precision_request_body', result.path);
      assert.equal(mutationEvents(result).length, 0, result.path);
    }
  }
});

test('both adapters resume one exact active job, expose multiple conflicts, and never mutate either case', async () => {
  const paid = paidSubscription();
  const one = await activeJob();
  for (const result of await invokeBoth(
    { subscription: paid, jobs: [one] },
    requestBody()
  )) {
    assert.equal(result.response.status, 200, result.path);
    assert.equal(result.result.status, 'already_running', result.path);
    assert.equal(result.result.job_id, one.id, result.path);
    assert.equal(mutationEvents(result).length, 0, result.path);
    assert.equal(blockedDecisionSideEffects(result).length, 0, result.path);
  }

  const two = await activeJob({
    id: 'active_2',
    status: 'pending',
    createdDate: '2026-07-25T12:01:00.000Z',
  });
  for (const result of await invokeBoth(
    { subscription: paid, jobs: [one, two] },
    requestBody()
  )) {
    assert.equal(result.response.status, 409, result.path);
    assert.equal(result.result.error, 'multiple_active_precision_jobs', result.path);
    assert.equal(result.result.jobs.length, 2, result.path);
    assert.equal(mutationEvents(result).length, 0, result.path);
    assert.equal(blockedDecisionSideEffects(result).length, 0, result.path);
  }
});

test('single-active resume requires a positive reservation matching canonical effective count', async () => {
  const paid = paidSubscription();
  const canonical = await activeJob();

  const legacyFallback = structuredClone(canonical);
  delete legacyFallback.precision_usage_reserved;
  for (const result of await invokeBoth(
    { subscription: paid, jobs: [legacyFallback] },
    requestBody()
  )) {
    assert.equal(result.response.status, 200, result.path);
    assert.equal(result.result.status, 'already_running', result.path);
  }

  for (const reservation of [0, null, false, 25, '50']) {
    const unverifiable = {
      ...structuredClone(canonical),
      id: `active_reservation_${String(reservation)}`,
      precision_usage_reserved: reservation,
    };
    for (const result of await invokeBoth(
      { subscription: paid, jobs: [unverifiable] },
      requestBody()
    )) {
      assert.equal(result.response.status, 409, result.path);
      assert.equal(result.result.error, 'precision_reservation_unsettled', result.path);
      assert.equal(mutationEvents(result).length, 0, result.path);
      assert.equal(blockedDecisionSideEffects(result).length, 0, result.path);
    }
  }
});

test('both adapters allow a settled failed predecessor but block every age of unsettled reservation', async () => {
  const paid = paidSubscription();
  const settledFailure = {
    id: 'failed_settled',
    status: 'failed',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    precision_usage_user_id: 'user_1',
    user_email: 'owner@example.com',
    precision_usage_kind: 'paid',
    precision_usage_period_start: new Date(paid.current_period_start * 1000).toISOString(),
    precision_usage_reserved: 0,
    precision_usage_count: 0,
    precision_usage_recorded_at: new Date().toISOString(),
  };
  for (const result of await invokeBoth(
    { subscription: paid, jobs: [settledFailure] },
    requestBody()
  )) {
    assert.equal(result.response.status, 200, result.path);
    assert.equal(result.result.status, 'started', result.path);
  }

  for (const createdDate of [
    new Date().toISOString(),
    '2020-01-01T00:00:00.000Z',
  ]) {
    const unsettled = {
      ...settledFailure,
      id: `failed_unsettled_${createdDate}`,
      created_date: createdDate,
      precision_usage_reserved: 25,
      precision_usage_recorded_at: null,
    };
    for (const result of await invokeBoth(
      { subscription: paid, jobs: [unsettled] },
      requestBody()
    )) {
      assert.equal(result.response.status, 409, result.path);
      assert.equal(result.result.error, 'precision_reservation_unsettled', result.path);
      assert.equal(mutationEvents(result).length, 0, result.path);
    }
  }

  const partialSettlementVariants = [
    { precision_usage_recorded_at: null },
    { precision_usage_count: null },
    { precision_usage_reserved: undefined },
  ];
  for (const [index, overrides] of partialSettlementVariants.entries()) {
    const partial = {
      ...settledFailure,
      id: `failed_partial_settlement_${index}`,
      ...overrides,
    };
    if (overrides.precision_usage_reserved === undefined) {
      delete partial.precision_usage_reserved;
    }
    for (const result of await invokeBoth(
      { subscription: paid, jobs: [partial] },
      requestBody()
    )) {
      assert.equal(result.response.status, 409, result.path);
      assert.equal(result.result.error, 'precision_reservation_unsettled', result.path);
      assert.equal(blockedDecisionSideEffects(result).length, 0, result.path);
    }
  }
});

test('both adapters make the same server-authoritative retry decision', async () => {
  const paid = paidSubscription();
  const source = await activeJob({
    id: 'failed_retry_source',
    status: 'failed',
    enteredCount: 1000,
    effectiveCount: 1000,
  });
  Object.assign(source, {
    precision_usage_reserved: 0,
    precision_usage_count: 0,
    precision_usage_recorded_at: '2026-07-25T12:05:00.000Z',
    completed_at: '2026-07-25T12:05:00.000Z',
    total_inserted: 0,
    total_existed: 0,
  });

  for (const result of await invokeBoth(
    { subscription: paid, jobs: [source] },
    { retry_fetch_job_id: source.id }
  )) {
    assert.equal(result.response.status, 200, result.path);
    assert.equal(result.result.status, 'started', result.path);
    const created = result.jobs.at(-1);
    assert.equal(created.source_fetch_job_id, source.id, result.path);
    assert.equal(created.root_fetch_job_id, source.id, result.path);
    assert.equal(created.attempt_number, 2, result.path);
    assert.equal(created.dry_run_metadata.precision_criteria.entered_count, 1000, result.path);
  }
});

test('both adapters fail closed on persistence errors and leave processor-handoff failures for watchdog recovery', async () => {
  const paid = paidSubscription();
  for (const result of await invokeBoth(
    {
      subscription: paid,
      createError: new Error('persistence unavailable'),
    },
    requestBody()
  )) {
    assert.equal(result.response.status, 500, result.path);
    assert.equal(result.result.error, 'precision_start_failed', result.path);
    assert.equal(
      result.events.some(event => event.type === 'processor:invoke'),
      false,
      result.path
    );
  }

  for (const result of await invokeBoth(
    {
      subscription: paid,
      processorError: new Error('processor handoff unavailable'),
    },
    requestBody()
  )) {
    assert.equal(result.response.status, 200, result.path);
    assert.equal(result.result.status, 'started', result.path);
    assert.equal(
      result.events.filter(event => event.type === 'job:create').length,
      1,
      result.path
    );
    assert.equal(
      result.events.filter(event => event.type === 'processor:invoke').length,
      1,
      result.path
    );
    assert.equal(result.jobs.at(-1).status, 'pending', result.path);
  }
});

test('both adapters fail closed on entitlement and FCC outages before creation or processor handoff', async () => {
  const paid = paidSubscription();
  const stripeOutages = [
    {
      label: 'direct subscription retrieve',
      config: {
        user: {
          id: 'user_1',
          email: 'owner@example.com',
          subscription_id: paid.id,
        },
        subscription: paid,
        stripeRetrieveError: new Error('Stripe retrieve unavailable'),
      },
      expectedEvent: 'stripe:retrieve',
    },
    {
      label: 'customer subscription list',
      config: {
        user: {
          id: 'user_1',
          email: 'owner@example.com',
          stripe_customer_id: 'cus_owned',
        },
        subscription: paid,
        stripeListError: new Error('Stripe list unavailable'),
      },
      expectedEvent: 'stripe:list',
    },
    {
      label: 'immutable metadata search',
      config: {
        user: {
          id: 'user_1',
          email: 'owner@example.com',
        },
        subscription: null,
        stripeSearchError: new Error('Stripe search unavailable'),
      },
      expectedEvent: 'stripe:search',
    },
  ];
  for (const outage of stripeOutages) {
    for (const result of await invokeBoth(outage.config, requestBody())) {
      assert.equal(result.response.status, 503, `${result.path}: ${outage.label}`);
      assert.equal(
        result.result.error,
        'precision_entitlement_unavailable',
        `${result.path}: ${outage.label}`
      );
      assert.equal(mutationEvents(result).length, 0, `${result.path}: ${outage.label}`);
      assert.equal(
        result.events.some(event => event.type === outage.expectedEvent),
        true,
        `${result.path}: ${outage.label}`
      );
      assert.equal(
        result.events.some(event => event.type === 'fcc:lookup'),
        false,
        `${result.path}: ${outage.label}`
      );
    }
  }

  for (const outage of [
    { fccError: new Error('FCC unavailable'), expected: 'precision_county_lookup_unavailable', status: 503 },
    { fccStatus: 429, expected: 'precision_county_lookup_unavailable', status: 503 },
    { fccStatus: 503, expected: 'precision_county_lookup_unavailable', status: 503 },
    {
      fccStatus: 200,
      fccPayload: { County: { FIPS: null }, State: { code: 'AZ' } },
      expected: 'precision_county_unresolved',
      status: 400,
    },
  ]) {
    for (const result of await invokeBoth(
      {
        subscription: paid,
        ...outage,
      },
      requestBody()
    )) {
      assert.equal(result.response.status, outage.status, result.path);
      assert.equal(result.result.error, outage.expected, result.path);
      assert.equal(mutationEvents(result).length, 0, result.path);
      assert.equal(result.events.some(event => event.type === 'fcc:lookup'), true, result.path);
    }
  }
});
