// Model 1 / PR A read-only diagnostic harness.
//
// Loads the REAL production Base44 handlers for the Precision order -> FetchJob
// pipeline (Stages 0-4) into a `vm` sandbox and records every authority read,
// persistence write, external call and provider interaction they perform.
//
// This file adds NO production behaviour. It only observes. Every value the
// tests assert on comes from executing `base44/functions/*/entry.ts` verbatim.
//
// Determinism contract:
//   - Date/Date.now are frozen to a caller-supplied instant.
//   - crypto.randomUUID is a counter, crypto.subtle is the real WebCrypto.
//   - Every outbound `fetch` is served by a recording stub; no network access.
//   - Stripe is a recording stub; no billing API is contacted.
//
// See docs/precision/pr-a-model-1/EVIDENCE_REGISTER.md for how the artefacts
// produced here are classified.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const testDir = dirname(fileURLToPath(import.meta.url));
export const rootDir = resolve(testDir, '..', '..');

export const PATHS = {
  startBatchDataPull: 'base44/functions/startBatchDataPull/entry.ts',
  fetchAreaProperties: 'base44/functions/fetchAreaProperties/entry.ts',
  previewBatchDataArea: 'base44/functions/previewBatchDataArea/entry.ts',
  getPrecisionUsage: 'base44/functions/getPrecisionUsage/entry.ts'
};

/** Both server paths that can create a canonical Precision FetchJob. */
export const START_PATHS = [
  ['startBatchDataPull', PATHS.startBatchDataPull],
  ['fetchAreaProperties', PATHS.fetchAreaProperties]
];

export const FIXED_NOW_ISO = '2026-07-26T12:00:00.000Z';
export const FIXED_NOW_MS = Date.parse(FIXED_NOW_ISO);

export function readSource(path) {
  return readFileSync(resolve(rootDir, path), 'utf8');
}

/**
 * The sandbox strips `import` statements, so anything a production handler
 * imports must be supplied as a global. This evaluates the REAL shared module
 * (`base44/functions/_shared/precisionOrderContract.js`) and exposes its
 * exports — it is not a reimplementation, and a change to the shared module is
 * therefore visible to every test that drives a handler.
 */
let sharedContractCache = null;
export function loadSharedOrderContract() {
  if (sharedContractCache) return sharedContractCache;
  const source = readSource('base44/functions/_shared/precisionOrderContract.js');
  const names = [
    ...[...source.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]),
    ...[...source.matchAll(/^export const (\w+)/gm)].map((m) => m[1])
  ];
  assert.ok(names.length > 0, 'the shared order contract exposes no exports');
  let collected = null;
  vm.runInNewContext(
    `${source.replace(/^export /gm, '')}\n;__collect({ ${names.join(', ')} });`,
    {
      __collect: (value) => { collected = value; },
      JSON, Number, String, Boolean, Array, Object, Set, Map, Math, Date, Error, console
    },
    { filename: 'base44/functions/_shared/precisionOrderContract.js' }
  );
  assert.ok(collected, 'the shared order contract did not expose its bindings');
  sharedContractCache = collected;
  return collected;
}

/**
 * Objects built inside the vm sandbox carry that realm's prototypes, which
 * makes `assert.deepStrictEqual` fail against host-side literals. Everything
 * crossing back out of the sandbox is re-hydrated as plain host JSON so tests
 * and fixtures compare structurally.
 */
export function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/* ------------------------------------------------------------------ trace */

export class Trace {
  constructor() {
    this.events = [];
  }

  record(channel, name, detail = {}) {
    this.events.push({ seq: this.events.length, channel, name, detail });
  }

  of(channel) {
    return this.events.filter((event) => event.channel === channel);
  }

  named(channel, name) {
    return this.events.filter((event) => event.channel === channel && event.name === name);
  }

  /** Entity reads, in order, as `Entity.filter({...})` style descriptors. */
  get reads() {
    return this.of('entity_read');
  }

  get writes() {
    return this.of('entity_write');
  }

  get externalFetches() {
    return this.of('fetch');
  }

  get stripeCalls() {
    return this.of('stripe');
  }

  get locks() {
    return this.of('lock');
  }

  get invocations() {
    return this.of('invoke');
  }

  /** Every FetchJob create payload the handler persisted, in order. */
  get createdFetchJobs() {
    return this.writes
      .filter((event) => event.name === 'FetchJob.create')
      .map((event) => plain(event.detail.payload));
  }

  summary() {
    return this.events.map((event) => `${event.channel}:${event.name}`);
  }
}

/* -------------------------------------------------------- fake persistence */

function toList(value) {
  return Array.isArray(value) ? value : (value?.items || []);
}

function matches(record, filter) {
  return Object.entries(filter || {}).every(([key, expected]) => {
    if (expected === undefined) return true;
    return String(record?.[key] ?? '') === String(expected ?? '');
  });
}

/**
 * In-memory stand-in for the Base44 entity store. Records every read and write
 * so a test can prove *which* authority field a handler actually queried on.
 */
export class FakeEntityStore {
  constructor(trace, { name, rows = [], serviceRole = false, onCreate = null }) {
    this.trace = trace;
    this.name = name;
    this.rows = rows;
    this.serviceRole = serviceRole;
    this.onCreate = onCreate;
    this.createSeq = 0;
  }

  #tag() {
    return this.serviceRole ? `${this.name}(serviceRole)` : this.name;
  }

  async filter(filter, sort = null, limit = null, skip = 0) {
    this.trace.record('entity_read', `${this.#tag()}.filter`, {
      filter,
      sort,
      limit,
      skip,
      filter_keys: Object.keys(filter || {})
    });
    const matched = this.rows.filter((row) => matches(row, filter));
    const sliced = matched.slice(skip, limit === null ? undefined : skip + limit);
    return sliced;
  }

  async get(id) {
    this.trace.record('entity_read', `${this.#tag()}.get`, { id });
    return this.rows.find((row) => String(row.id) === String(id)) || null;
  }

  async create(payload) {
    this.createSeq += 1;
    const record = { id: `${this.name.toLowerCase()}_created_${this.createSeq}`, ...payload };
    this.trace.record('entity_write', `${this.name}.create`, { payload: record });
    this.rows.push(record);
    if (this.onCreate) this.onCreate(record);
    return record;
  }

  async update(id, patch) {
    this.trace.record('entity_write', `${this.name}.update`, { id, patch });
    const row = this.rows.find((entry) => String(entry.id) === String(id));
    if (row) Object.assign(row, patch);
    return row || { id, ...patch };
  }
}

/**
 * Builds a base44 client double. `entities` are shared between the plain and
 * `asServiceRole` views so a handler cannot "read as user, write as service"
 * against two different datasets — matching the real backing store.
 */
export function makeBase44({
  trace,
  user,
  fetchJobs = [],
  savedRoutes = [],
  users = [],
  invokeHandlers = {},
  onFetchJobCreate = null
}) {
  const fetchJobRows = fetchJobs.map((row) => ({ ...row }));
  const savedRouteRows = savedRoutes.map((row) => ({ ...row }));
  const userRows = users.map((row) => ({ ...row }));

  const make = (serviceRole) => ({
    FetchJob: new FakeEntityStore(trace, { name: 'FetchJob', rows: fetchJobRows, serviceRole, onCreate: onFetchJobCreate }),
    SavedRoute: new FakeEntityStore(trace, { name: 'SavedRoute', rows: savedRouteRows, serviceRole }),
    User: new FakeEntityStore(trace, { name: 'User', rows: userRows, serviceRole })
  });

  const invoke = async (name, payload) => {
    trace.record('invoke', name, { payload });
    const handler = invokeHandlers[name];
    if (!handler) throw new Error(`unstubbed function invoke: ${name}`);
    return handler(payload);
  };

  return {
    auth: { me: async () => {
      trace.record('auth', 'auth.me', { returned_user_id: user?.id ?? null, returned_email: user?.email ?? null });
      return user;
    } },
    entities: make(false),
    functions: { invoke },
    asServiceRole: {
      entities: make(true),
      functions: { invoke }
    },
    __rows: { fetchJobRows, savedRouteRows, userRows }
  };
}

/* ------------------------------------------------------------ stripe stub */

export function makeStripe(trace, { subscriptions = [], search = true, searchResults = null } = {}) {
  const byId = new Map(subscriptions.map((sub) => [sub.id, sub]));
  const api = {
    subscriptions: {
      retrieve: async (id) => {
        trace.record('stripe', 'subscriptions.retrieve', { id });
        const found = byId.get(id);
        if (!found) {
          const error = new Error('No such subscription');
          error.code = 'resource_missing';
          throw error;
        }
        return found;
      },
      list: async (params) => {
        trace.record('stripe', 'subscriptions.list', { params });
        return { data: subscriptions.filter((sub) => !params?.customer || sub.__customer === params.customer) };
      }
    }
  };
  if (search) {
    api.subscriptions.search = async (params) => {
      trace.record('stripe', 'subscriptions.search', { params });
      return { data: searchResults ?? [] };
    };
  }
  return api;
}

/** Active $99 Precision subscription with a paid invoice covering the period. */
export function paidSubscription({
  userId = 'user_immutable_1',
  id = 'sub_paid',
  customer = 'cus_1',
  periodStart = Math.floor(FIXED_NOW_MS / 1000) - 5 * 24 * 3600,
  periodEnd = Math.floor(FIXED_NOW_MS / 1000) + 25 * 24 * 3600,
  status = 'active',
  amount = 9900
} = {}) {
  return {
    id,
    __customer: customer,
    status,
    trial_end: null,
    current_period_start: periodStart,
    current_period_end: periodEnd,
    metadata: { base44_user_id: userId },
    items: { data: [{ price: { unit_amount: amount } }] },
    latest_invoice: {
      id: `in_${id}`,
      subscription: id,
      status: 'paid',
      amount_paid: amount,
      period_start: periodStart,
      period_end: periodEnd,
      lines: { data: [{ subscription: id, period: { start: periodStart, end: periodEnd } }] }
    }
  };
}

/** Trialing $99 Precision subscription (proAccess true, paidAccess false). */
export function trialingSubscription({
  userId = 'user_immutable_1',
  id = 'sub_trial',
  customer = 'cus_1',
  amount = 9900
} = {}) {
  return {
    id,
    __customer: customer,
    status: 'trialing',
    trial_end: Math.floor(FIXED_NOW_MS / 1000) + 7 * 24 * 3600,
    current_period_start: Math.floor(FIXED_NOW_MS / 1000) - 3 * 24 * 3600,
    current_period_end: Math.floor(FIXED_NOW_MS / 1000) + 7 * 24 * 3600,
    metadata: { base44_user_id: userId },
    items: { data: [{ price: { unit_amount: amount } }] },
    latest_invoice: null
  };
}

/* --------------------------------------------------------------- sandbox */

function frozenDateClass(nowMs) {
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(nowMs);
      else super(...args);
    }
    static now() {
      return nowMs;
    }
    static parse(...args) {
      return RealDate.parse(...args);
    }
    static UTC(...args) {
      return RealDate.UTC(...args);
    }
  }
  return FrozenDate;
}

function deterministicCrypto(trace) {
  let seq = 0;
  return {
    subtle: globalThis.crypto.subtle,
    getRandomValues: (array) => globalThis.crypto.getRandomValues(array),
    randomUUID: () => {
      seq += 1;
      const id = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
      trace.record('crypto', 'randomUUID', { value: id });
      return id;
    }
  };
}

export const DEFAULT_FIPS_RESPONSE = {
  County: { FIPS: '13221', name: 'Oconee' },
  State: { code: 'GA', name: 'Georgia' }
};

/**
 * Transpiles and evaluates one production entry.ts, returning its Deno.serve
 * handler plus the trace recorder wired into every side-effecting capability.
 */
export function loadPrecisionHandler(path, {
  trace = new Trace(),
  base44,
  stripeApi = {},
  env = {},
  nowMs = FIXED_NOW_MS,
  fetchResponder = null,
  lockImpl = null
} = {}) {
  const source = readSource(path);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: path,
    reportDiagnostics: true
  });
  const errors = (transpiled.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')), [], `${path} has TypeScript errors`);

  // Named imports from `npm:` specifiers are supplied as sandbox globals, the
  // same technique the repository's existing precision suites already use.
  const executable = transpiled.outputText.replace(/^import .*;\s*$/gm, '');

  let handler = null;

  class SandboxStripe {
    constructor(secret) {
      trace.record('stripe', 'client.construct', { secret_present: Boolean(secret) });
      return stripeApi;
    }
  }

  class DefaultNeonClient {
    async connect() {
      trace.record('lock', 'db.connect', {});
    }
    async query(sql, params) {
      trace.record('lock', 'db.query', { sql, params });
      return { rows: [] };
    }
    async end() {
      trace.record('lock', 'db.end', {});
    }
  }

  const envDefaults = {
    STRIPE_SECRET_KEY: 'sk_test_model1_audit',
    DATABASE_URL: 'postgres://audit/harness'
  };

  const sandboxFetch = async (url, init) => {
    trace.record('fetch', 'outbound', {
      url: String(url),
      method: init?.method || 'GET',
      body: init?.body ? String(init.body) : null,
      host: (() => { try { return new URL(String(url)).host; } catch { return null; } })()
    });
    if (fetchResponder) return fetchResponder(String(url), init);
    return new Response(JSON.stringify(DEFAULT_FIPS_RESPONSE), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  vm.runInNewContext(executable, {
    ...loadSharedOrderContract(),
    console: { log: () => {}, warn: () => {}, error: () => {} },
    createClientFromRequest: () => base44,
    Deno: {
      env: {
        get: (key) => (Object.prototype.hasOwnProperty.call(env, key) ? env[key] : envDefaults[key])
      },
      serve: (registered) => { handler = registered; }
    },
    Stripe: SandboxStripe,
    Client: lockImpl || DefaultNeonClient,
    Request,
    Response,
    TextEncoder,
    TextDecoder,
    URL,
    crypto: deterministicCrypto(trace),
    Date: frozenDateClass(nowMs),
    fetch: sandboxFetch,
    setTimeout,
    clearTimeout,
    Promise,
    Math,
    JSON,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    Error,
    Uint8Array,
    isNaN,
    isFinite
  }, { filename: path });

  assert.ok(handler, `${path} did not register a Deno.serve handler`);
  return { handler, trace };
}

/** Executes a loaded handler against a JSON body and returns parsed output. */
export async function callHandler(handler, body) {
  const response = await handler(new Request('https://audit.local/precision', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }));
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { __unparsed: text }; }
  return { status: response.status, body: json };
}

/* ------------------------------------------------------- scenario builder */

export const AUDIT_USER = Object.freeze({
  id: 'user_immutable_1',
  email: 'rep@example.com',
  role: 'user'
});

/** ~1 sq mi square in Oconee County, GA. Open ring (no duplicated final point). */
export const SQUARE_MILE_POLYGON = Object.freeze([
  { lat: 33.860000, lng: -83.400000 },
  { lat: 33.860000, lng: -83.382500 },
  { lat: 33.874500, lng: -83.382500 },
  { lat: 33.874500, lng: -83.400000 }
]);

export const TRIANGLE_POLYGON = Object.freeze([
  { lat: 33.860000, lng: -83.400000 },
  { lat: 33.860000, lng: -83.390000 },
  { lat: 33.870000, lng: -83.395000 }
]);

/** Canonical order body as the browser actually assembles it (TerritoryPrompt). */
export function orderBody(overrides = {}) {
  return {
    polygon: SQUARE_MILE_POLYGON.map((point) => ({ ...point })),
    requested_properties: 25,
    count_mode: 'fixed',
    sold_months: 3,
    ownership_range_mode: 'quick',
    min_price: null,
    max_price: null,
    route_filters: {
      propertyTypes: ['Single Family'],
      excludeCommercial: true,
      excludeCondos: true,
      excludeLand: true
    },
    route_bounds: { enabled: false },
    force_full_refresh: false,
    include_unresolved_followups: false,
    repull_mode: 'new_area',
    previous_pull_date: null,
    ...overrides
  };
}

/** A pending Precision FetchJob shaped the way both start paths persist one. */
export function activeFetchJob(overrides = {}) {
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
    ...(overrides.dry_run_metadata || {})
  };
  const job = {
    id: 'job_active_1',
    status: 'running',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    phase: 'batchdata_precision',
    user_email: AUDIT_USER.email,
    precision_usage_user_id: AUDIT_USER.id,
    precision_usage_kind: 'trial',
    precision_usage_reserved: 25,
    precision_usage_count: 0,
    sold_months: 3,
    polygon: SQUARE_MILE_POLYGON.map((point) => ({ ...point })),
    total_expected: 25,
    progress_pct: 10,
    created_date: new Date(FIXED_NOW_MS - 30 * 1000).toISOString(),
    started_at: new Date(FIXED_NOW_MS - 30 * 1000).toISOString(),
    ...overrides
  };
  job.dry_run_metadata = metadata;
  return job;
}

/** A settled Precision FetchJob that consumed `count` of the allowance. */
export function settledFetchJob({ id = 'job_settled_1', count = 10, kind = 'trial', ...rest } = {}) {
  return {
    id,
    status: 'completed',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    user_email: AUDIT_USER.email,
    precision_usage_user_id: AUDIT_USER.id,
    precision_usage_kind: kind,
    precision_usage_reserved: 0,
    precision_usage_count: count,
    precision_usage_recorded_at: new Date(FIXED_NOW_MS - 3600 * 1000).toISOString(),
    created_date: new Date(FIXED_NOW_MS - 3600 * 1000).toISOString(),
    started_at: new Date(FIXED_NOW_MS - 3600 * 1000).toISOString(),
    ...rest
  };
}

/**
 * A Neon `Client` stand-in that makes `pg_advisory_xact_lock` actually
 * serialize, so two concurrent starts interleave the way production does:
 * whoever acquires first runs its whole critical section before the other
 * observes any state.
 */
export function makeSerializingLockFactory(trace) {
  const held = new Map();
  return class SerializingClient {
    constructor() {
      this.key = null;
      this.release = null;
    }

    async connect() {
      trace.record('lock', 'db.connect', {});
    }

    async query(sql, params) {
      trace.record('lock', 'db.query', { sql, params });
      if (!String(sql).includes('pg_advisory_xact_lock')) return { rows: [] };
      this.key = String(params?.[0] ?? '');
      const previous = held.get(this.key) || Promise.resolve();
      let releaseFn;
      const next = new Promise((resolve) => { releaseFn = resolve; });
      held.set(this.key, previous.then(() => next));
      this.release = releaseFn;
      await previous;
      trace.record('lock', 'acquired', { key: this.key });
      return { rows: [] };
    }

    async end() {
      trace.record('lock', 'db.end', { key: this.key });
      if (this.release) this.release();
    }
  };
}

/**
 * Runs two start requests concurrently against ONE shared entity store and one
 * shared advisory lock, mirroring two tabs / two devices for the same subject.
 */
export async function runConcurrentStarts({
  paths,
  bodies,
  user = AUDIT_USER,
  fetchJobs = [],
  savedRoutes = [],
  subscriptions = [],
  env = {},
  nowMs = FIXED_NOW_MS
}) {
  const trace = new Trace();
  const base44 = makeBase44({
    trace,
    user,
    fetchJobs,
    savedRoutes,
    invokeHandlers: { processFetchChunk: async () => ({ ok: true }) }
  });
  const stripeApi = makeStripe(trace, { subscriptions });
  const LockImpl = makeSerializingLockFactory(trace);

  const handlers = paths.map((path) =>
    loadPrecisionHandler(path, { trace, base44, stripeApi, env, nowMs, lockImpl: LockImpl }).handler);

  const responses = await Promise.all(handlers.map((handler, index) => callHandler(handler, bodies[index])));
  return {
    responses,
    trace,
    base44,
    createdJobs: trace.createdFetchJobs,
    fetchJobRows: plain(base44.__rows.fetchJobRows)
  };
}

/**
 * One-call convenience: build the world, load a start path, submit an order,
 * and hand back the response plus the full trace and any persisted FetchJob.
 */
export async function runStartPath(path, {
  user = AUDIT_USER,
  body = orderBody(),
  fetchJobs = [],
  savedRoutes = [],
  subscriptions = [],
  env = {},
  nowMs = FIXED_NOW_MS,
  fetchResponder = null,
  stripeSearch = true,
  invokeHandlers = { processFetchChunk: async () => ({ ok: true }) }
} = {}) {
  const trace = new Trace();
  const base44 = makeBase44({ trace, user, fetchJobs, savedRoutes, invokeHandlers });
  const stripeApi = makeStripe(trace, { subscriptions, search: stripeSearch });
  const { handler } = loadPrecisionHandler(path, { trace, base44, stripeApi, env, nowMs, fetchResponder });
  const result = await callHandler(handler, body);
  return {
    ...result,
    submittedBody: plain(body),
    trace,
    base44,
    createdJob: trace.createdFetchJobs[0] || null,
    createdJobs: trace.createdFetchJobs
  };
}
