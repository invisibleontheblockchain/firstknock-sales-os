import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

import {
  buildRequestedPrecisionCriteria,
  comparePrecisionCriteria,
  findActivePrecisionJob,
  resolveActivePrecisionJobs
} from '../base44/functions/_shared/precisionActiveJobCriteria.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');
const livePaths = [
  'base44/functions/fetchAreaProperties/entry.ts',
  'base44/functions/startBatchDataPull/entry.ts'
];
const sharedPath = 'base44/functions/_shared/precisionActiveJobCriteria.js';
const DEFAULT_ROUTE_FILTERS = {
  propertyTypes: ['Single Family'],
  excludeCommercial: true,
  excludeCondos: true,
  excludeLand: true
};
const POLYGON_A = [
  { lat: 33.44, lng: -112.08 },
  { lat: 33.45, lng: -112.08 },
  { lat: 33.45, lng: -112.07 }
];
const POLYGON_B = [
  { lat: 33.47, lng: -112.04 },
  { lat: 33.48, lng: -112.04 },
  { lat: 33.48, lng: -112.03 }
];

async function polygonHash(points) {
  const normalized = points.map(point => [
    Number(Number(point.lat).toFixed(6)),
    Number(Number(point.lng).toFixed(6))
  ]);
  const bytes = new TextEncoder().encode(JSON.stringify(normalized));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

function paidSubscription({
  userId = 'user_1',
  id = 'sub_paid',
  periodStart = Math.floor(Date.now() / 1000) - 60,
  periodEnd = periodStart + 30 * 24 * 60 * 60
} = {}) {
  return {
    id,
    status: 'active',
    trial_end: null,
    current_period_start: periodStart,
    current_period_end: periodEnd,
    metadata: { base44_user_id: userId, subscription_tier: 'precision' },
    items: { data: [{ price: { unit_amount: 9900 } }] },
    latest_invoice: {
      id: 'in_current',
      subscription: id,
      status: 'paid',
      amount_paid: 9900,
      period_start: periodStart,
      period_end: periodEnd,
      lines: {
        data: [{
          subscription: id,
          period: { start: periodStart, end: periodEnd }
        }]
      }
    }
  };
}

function transpile(path) {
  const result = ts.transpileModule(readSource(path), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: path,
    reportDiagnostics: true
  });
  const errors = (result.diagnostics || []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], `${path} contains TypeScript syntax errors`);
  return result.outputText;
}

function loadHandler(path, { base44, subscription }) {
  let handler;
  class FakeStripe {
    constructor() {
      return {
        subscriptions: {
          retrieve: async () => subscription
        }
      };
    }
  }
  class FakeClient {
    async connect() {}
    async query(sql) {
      if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ claimed: true }] };
      return { rows: [] };
    }
    async end() {}
  }
  const sharedExecutable = transpile(sharedPath).replace(/^export\s+/gm, '');
  const functionExecutable = transpile(path).replace(/^import .*;\s*$/gm, '');
  vm.runInNewContext(`${sharedExecutable}\n${functionExecutable}`, {
    console,
    createClientFromRequest: () => base44,
    Deno: {
      env: {
        get: key => {
          if (key === 'STRIPE_SECRET_KEY') return 'sk_test';
          if (key === 'DATABASE_URL') return 'postgres://test';
          return 'test_value';
        }
      },
      serve: registeredHandler => { handler = registeredHandler; }
    },
    Stripe: FakeStripe,
    Client: FakeClient,
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

function makeBase44({ user, jobs, events }) {
  const matches = (record, filter) => Object.entries(filter).every(([key, value]) => record[key] === value);
  const filterJobs = async (filter, _sort, limit = 500, skip = 0) =>
    jobs.filter(record => matches(record, filter)).slice(skip, skip + limit);
  return {
    auth: { me: async () => user },
    entities: {
      FetchJob: { filter: filterJobs }
    },
    asServiceRole: {
      entities: {
        SavedRoute: { filter: async () => [] },
        FetchJob: {
          filter: filterJobs,
          update: async (id, payload) => {
            events.push({ type: 'job:update', id, payload });
            const job = jobs.find(record => record.id === id);
            if (job) Object.assign(job, payload);
            return job;
          },
          create: async payload => {
            events.push({ type: 'job:create', payload });
            const job = { id: `created_${jobs.length + 1}`, ...payload };
            jobs.push(job);
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

function requestFor({
  polygon = POLYGON_A,
  requestedProperties = 839,
  countMode = 'max_available',
  minPrice = 100000,
  maxPrice = null,
  soldMonths = 12,
  ownershipMode = 'custom',
  ownershipMinDays = 59,
  ownershipMaxDays = 365,
  routeFilters = DEFAULT_ROUTE_FILTERS,
  routeBounds = { enabled: false },
  repullMode = 'new_area',
  previousPullDate = null,
  forceFullRefresh = false,
  includeUnresolvedFollowups = false,
  dryRun = false
} = {}) {
  return {
    polygon,
    requested_properties: requestedProperties,
    count_mode: countMode,
    min_price: minPrice,
    max_price: maxPrice,
    sold_months: soldMonths,
    ownership_range_mode: ownershipMode,
    ...(ownershipMode === 'custom' ? {
      ownership_min_days: ownershipMinDays,
      ownership_max_days: ownershipMaxDays
    } : {}),
    route_filters: routeFilters,
    route_bounds: routeBounds,
    repull_mode: repullMode,
    previous_pull_date: previousPullDate,
    force_full_refresh: forceFullRefresh,
    include_unresolved_followups: includeUnresolvedFollowups,
    ...(dryRun ? { dry_run: true } : {})
  };
}

async function makeActiveJob({ subscription, user, polygon = POLYGON_A } = {}) {
  const hash = await polygonHash(polygon);
  const criteria = buildRequestedPrecisionCriteria({
    polygon_hash: hash,
    count_mode: 'max_available',
    entered_count: 839,
    effective_count: 839,
    min_price: 100000,
    max_price: null,
    sold_months: 12,
    ownership_range_mode: 'custom',
    ownership_range_days: { min: 59, max: 365 },
    route_filters: DEFAULT_ROUTE_FILTERS,
    repull_mode: 'new_area',
    previous_pull_date: null,
    force_full_refresh: false,
    include_unresolved_followups: false,
    route_bounds: { enabled: false },
    immutable_user_id: user.id,
    workspace_id: user.id
  });
  return {
    id: 'active_839_job',
    status: 'running',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    include_mls: false,
    user_email: user.email,
    precision_usage_user_id: user.id,
    precision_usage_kind: 'paid',
    precision_subscription_id: subscription.id,
    precision_usage_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
    precision_usage_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
    precision_usage_reserved: 839,
    precision_usage_count: 0,
    created_date: new Date().toISOString(),
    started_at: new Date().toISOString(),
    polygon,
    polygon_hash: hash,
    sold_months: 12,
    total_expected: 839,
    pull_mode: 'new_area',
    dry_run_metadata: {
      criteria_reference_at: new Date().toISOString(),
      requested_properties: 839,
      requested_properties_before_cap: 839,
      count_mode: 'max_available',
      filters: { min_price: 100000, max_price: null },
      route_filters: DEFAULT_ROUTE_FILTERS,
      route_bounds: { enabled: false },
      ownership_range_mode: 'custom',
      ownership_range_days: { min: 59, max: 365 },
      repull_mode: 'new_area',
      previous_pull_date: null,
      force_full_refresh: false,
      include_unresolved_followups: false,
      workspace_id: user.id,
      precision_criteria: criteria
    }
  };
}

async function invoke(path, { body, activeJob = null } = {}) {
  const subscription = paidSubscription();
  const user = {
    id: 'user_1',
    email: 'owner@example.com',
    subscription_id: subscription.id
  };
  const events = [];
  const jobs = activeJob ? [activeJob] : [];
  const base44 = makeBase44({ user, jobs, events });
  const handler = loadHandler(path, { base44, subscription });
  const response = await handler(new Request('https://app.example.com/function', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }));
  return { response, result: await response.json(), events, subscription, user };
}

test('all material Precision criteria participate in exact compatibility', () => {
  const base = buildRequestedPrecisionCriteria({
    polygon_hash: 'polygon-a',
    count_mode: 'fixed',
    entered_count: 50,
    effective_count: 50,
    min_price: 100000,
    max_price: null,
    sold_months: 12,
    ownership_range_mode: 'custom',
    ownership_range_days: { min: 1, max: 365 },
    route_filters: DEFAULT_ROUTE_FILTERS,
    repull_mode: 'new_area',
    previous_pull_date: null,
    force_full_refresh: false,
    include_unresolved_followups: false,
    route_bounds: { enabled: false },
    immutable_user_id: 'user-1',
    workspace_id: 'workspace-1'
  });
  const mutations = {
    polygon_hash: { polygon_hash: 'polygon-b' },
    count_mode: { count_mode: 'max_available' },
    entered_count: { entered_count: 51 },
    effective_count: { effective_count: 49 },
    min_price: { min_price: 75000 },
    max_price: { max_price: 500000 },
    sold_months: { sold_months: 6 },
    ownership_range_mode: {
      ownership_range_mode: 'quick',
      ownership_range_days: null
    },
    ownership_range_days: {
      ownership_range_days: { min: 59, max: 365 }
    },
    route_filters: {
      route_filters: { ...DEFAULT_ROUTE_FILTERS, excludeCommercial: false }
    },
    repull_mode: { repull_mode: 'fill_gaps' },
    previous_pull_date: { previous_pull_date: '2026-07-01T00:00:00.000Z' },
    force_full_refresh: { force_full_refresh: true },
    include_unresolved_followups: { include_unresolved_followups: true },
    route_bounds: {
      route_bounds: {
        enabled: true,
        mode: 'home_round_trip',
        start_location: { lat: 33.4, lng: -112.1 },
        end_location: { lat: 33.4, lng: -112.1 }
      }
    },
    immutable_user_id: { immutable_user_id: 'user-2' },
    workspace_id: { workspace_id: 'workspace-2' }
  };

  assert.deepEqual(comparePrecisionCriteria(base, base), {
    matches: true,
    mismatched_fields: []
  });
  for (const [expectedField, mutation] of Object.entries(mutations)) {
    const changed = expectedField === 'route_filters'
      ? { ...base, ...mutation }
      : buildRequestedPrecisionCriteria({ ...base, ...mutation });
    const comparison = comparePrecisionCriteria(base, changed);
    assert.equal(comparison.matches, false, expectedField);
    assert.ok(comparison.mismatched_fields.includes(expectedField), expectedField);
  }
});

test('active-job lookup rejects email collisions and reports every immutable-user conflict', async () => {
  const user = { id: 'user_1', email: 'current@example.com' };
  const jobs = [
    {
      id: 'foreign_same_email',
      status: 'running',
      provider: 'batchdata',
      mode_tag: 'PRECISION_TARGET',
      precision_usage_user_id: 'user_2',
      user_email: user.email,
      created_date: '2026-07-25T03:00:00.000Z'
    },
    {
      id: 'own_old_email',
      status: 'running',
      provider: 'batchdata',
      mode_tag: 'PRECISION_TARGET',
      precision_usage_user_id: user.id,
      user_email: 'old@example.com',
      created_date: '2026-07-25T01:00:00.000Z'
    },
    {
      id: 'own_newest',
      status: 'pending',
      provider: 'batchdata',
      mode_tag: 'PRECISION_TARGET',
      precision_usage_user_id: user.id,
      user_email: 'older@example.com',
      created_date: '2026-07-25T02:00:00.000Z'
    }
  ];
  const base44 = makeBase44({ user, jobs, events: [] });
  const resolution = await resolveActivePrecisionJobs(base44, user);
  assert.equal(resolution.state, 'multiple');
  assert.deepEqual(resolution.jobs.map(job => job.id), ['own_newest', 'own_old_email']);
  await assert.rejects(
    () => findActivePrecisionJob(base44, user),
    error => error.code === 'multiple_active_precision_jobs' && error.status === 409
  );
});

test('the historical-shaped active job conflicts with a new fixed request on both start paths', async () => {
  const subscription = paidSubscription();
  const user = { id: 'user_1', email: 'owner@example.com', subscription_id: subscription.id };
  const activeJob = await makeActiveJob({ subscription, user });
  const request = requestFor({
    polygon: POLYGON_B,
    requestedProperties: 50,
    countMode: 'fixed',
    minPrice: 75000,
    ownershipMinDays: 1,
    ownershipMaxDays: 365
  });

  for (const path of livePaths) {
    const { response, result, events } = await invoke(path, {
      body: request,
      activeJob: structuredClone(activeJob)
    });
    assert.equal(response.status, 409, path);
    assert.equal(result.error, 'active_job_criteria_conflict', path);
    for (const field of [
      'polygon_hash',
      'count_mode',
      'entered_count',
      'effective_count',
      'min_price',
      'ownership_range_days'
    ]) {
      assert.ok(result.mismatched_fields.includes(field), `${path}: ${field}`);
    }
    assert.equal(result.active_criteria.effective_count, 839, path);
    assert.equal(result.active_criteria.min_price, 100000, path);
    assert.deepEqual(result.active_criteria.ownership_range_days, { min: 59, max: 365 }, path);
    assert.equal(result.requested_criteria.effective_count, 50, path);
    assert.equal(result.requested_criteria.min_price, 75000, path);
    assert.deepEqual(result.requested_criteria.ownership_range_days, { min: 1, max: 365 }, path);
    assert.deepEqual(events, [], `${path} must not cancel, supersede, or create a job`);
  }
});

test('both start paths find an active job after the owning user email changes', async () => {
  const subscription = paidSubscription();
  const user = { id: 'user_1', email: 'owner@example.com', subscription_id: subscription.id };
  const activeJob = await makeActiveJob({ subscription, user });
  activeJob.user_email = 'previous-address@example.com';

  for (const path of livePaths) {
    const { response, result, events } = await invoke(path, {
      body: requestFor(),
      activeJob: structuredClone(activeJob)
    });
    assert.equal(response.status, 200, path);
    assert.equal(result.status, 'already_running', path);
    assert.equal(result.job_id, activeJob.id, path);
    assert.deepEqual(events, [], path);
  }
});

test('only an exactly matching active request returns already_running', async () => {
  const subscription = paidSubscription();
  const user = { id: 'user_1', email: 'owner@example.com', subscription_id: subscription.id };
  const activeJob = await makeActiveJob({ subscription, user });
  const request = requestFor();

  for (const path of livePaths) {
    const { response, result, events } = await invoke(path, {
      body: request,
      activeJob: structuredClone(activeJob)
    });
    assert.equal(response.status, 200, path);
    assert.equal(result.status, 'already_running', path);
    assert.equal(result.criteria_match, 'exact', path);
    assert.equal(result.job_id, activeJob.id, path);
    assert.equal(result.requested_properties, 839, path);
    assert.equal(result.requested_properties_before_cap, 839, path);
    assert.equal(result.repull_mode, 'new_area', path);
    assert.equal(result.force_full_refresh, false, path);
    assert.equal(result.include_unresolved_followups, false, path);
    assert.equal(result.workspace_id, user.id, path);
    assert.deepEqual(events, [], `${path} must not mutate an exactly matching job`);
  }
});

test('new jobs persist the normalized Phase 1 request snapshot on both start paths', async () => {
  const previousPullDate = '2026-07-01T12:34:56.000Z';
  const routeBounds = {
    enabled: true,
    mode: 'home_round_trip',
    startLocation: { lat: 33.43, lng: -112.09 },
    endLocation: { lat: 33.43, lng: -112.09 }
  };
  const request = requestFor({
    requestedProperties: 20,
    countMode: 'fixed',
    minPrice: 75000,
    maxPrice: 500000,
    ownershipMinDays: 1,
    ownershipMaxDays: 365,
    routeBounds,
    repullMode: 'fill_gaps',
    previousPullDate,
    forceFullRefresh: true,
    includeUnresolvedFollowups: true
  });

  for (const path of livePaths) {
    const { response, result, events } = await invoke(path, { body: request });
    assert.equal(response.status, 200, path);
    assert.equal(result.status, 'started', path);
    const createEvent = events.find(event => event.type === 'job:create');
    assert.ok(createEvent, path);
    const snapshot = JSON.parse(JSON.stringify(createEvent.payload.dry_run_metadata.precision_criteria));
    assert.equal(snapshot.criteria_schema_version, 1, path);
    assert.equal(snapshot.count_mode, 'fixed', path);
    assert.equal(snapshot.entered_count, 20, path);
    assert.equal(snapshot.effective_count, 20, path);
    assert.equal(snapshot.min_price, 75000, path);
    assert.equal(snapshot.max_price, 500000, path);
    assert.deepEqual(snapshot.ownership_range_days, { min: 1, max: 365 }, path);
    assert.equal(snapshot.repull_mode, 'fill_gaps', path);
    assert.equal(snapshot.previous_pull_date, previousPullDate, path);
    assert.equal(snapshot.force_full_refresh, true, path);
    assert.equal(snapshot.include_unresolved_followups, true, path);
    assert.equal(snapshot.immutable_user_id, 'user_1', path);
    assert.equal(snapshot.workspace_id, 'user_1', path);
    assert.deepEqual(snapshot.route_bounds, {
      enabled: true,
      mode: 'home_round_trip',
      start_location: { lat: 33.43, lng: -112.09 },
      end_location: { lat: 33.43, lng: -112.09 }
    }, path);
  }
});

test('missing minimum defaults to $100,000 while malformed explicit prices fail closed', async () => {
  for (const path of livePaths) {
    const missingMinimum = requestFor({
      requestedProperties: 20,
      countMode: 'fixed',
      ownershipMode: 'quick',
      dryRun: true
    });
    delete missingMinimum.min_price;
    const missing = await invoke(path, { body: missingMinimum });
    assert.equal(missing.response.status, 200, path);
    assert.equal(missing.result.filters.min_price, 100000, path);

    const intentional = await invoke(path, {
      body: requestFor({
        requestedProperties: 20,
        countMode: 'fixed',
        minPrice: 75000,
        ownershipMode: 'quick',
        dryRun: true
      })
    });
    assert.equal(intentional.response.status, 200, path);
    assert.equal(intentional.result.filters.min_price, 75000, path);

    for (const invalidValue of ['not-a-number', 0, -1, true, [100000], { value: 100000 }]) {
      const invalid = await invoke(path, {
        body: requestFor({
          requestedProperties: 20,
          countMode: 'fixed',
          minPrice: invalidValue,
          ownershipMode: 'quick',
          dryRun: true
        })
      });
      assert.equal(invalid.response.status, 400, `${path}: ${invalidValue}`);
      assert.equal(invalid.result.error, 'invalid_min_price', `${path}: ${invalidValue}`);
    }

    const invalidMaximum = await invoke(path, {
      body: requestFor({
        requestedProperties: 20,
        countMode: 'fixed',
        minPrice: 75000,
        maxPrice: { value: 500000 },
        ownershipMode: 'quick',
        dryRun: true
      })
    });
    assert.equal(invalidMaximum.response.status, 400, path);
    assert.equal(invalidMaximum.result.error, 'invalid_max_price', path);
  }
});
