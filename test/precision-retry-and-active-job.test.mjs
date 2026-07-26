import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

// A retry must restate every material criterion from the failed job, using the
// originally entered count rather than the capped effective count, and a user
// blocked by an owned active job must have an explicit server-verified remedy.

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');
const territory = readSource('src/components/map/TerritoryPrompt.jsx');

const POLYGON = [
    { lat: 33.44, lng: -112.08 },
    { lat: 33.45, lng: -112.08 },
    { lat: 33.45, lng: -112.07 }
];
const ROUTE_FILTERS = {
    propertyTypes: ['Single Family'],
    excludeCommercial: true,
    excludeCondos: true,
    excludeLand: true
};

function extractFunction(source, name) {
    const start = source.indexOf(`function ${name}`);
    assert.notEqual(start, -1, `missing function ${name}`);
    const openingBrace = source.indexOf('{', start);
    let depth = 0;
    for (let index = openingBrace; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(start, index + 1);
        }
    }
    throw new Error(`unterminated function ${name}`);
}

function loadTerritoryHelpers(names) {
    const defaultsStart = territory.indexOf('const DEFAULT_PRECISION_PROPERTY_COUNT');
    const defaultsEnd = territory.indexOf('function formatWholeNumber');
    assert.ok(defaultsStart >= 0 && defaultsEnd > defaultsStart);
    const context = {};
    vm.createContext(context);
    vm.runInContext(`
        ${territory.slice(defaultsStart, defaultsEnd)}
        ${extractFunction(territory, 'normalizeOwnershipRangeDays')}
        ${extractFunction(territory, 'defaultSoldMonthsForUser')}
        ${extractFunction(territory, 'normalizeRouteFilters')}
        ${extractFunction(territory, 'normalizeRouteBounds')}
        ${names.map(name => extractFunction(territory, name)).join('\n')}
        ${names.map(name => `this.${name} = ${name};`).join('\n')}
    `, context);
    return context;
}

// Values cross a vm realm boundary, so compare structure rather than prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));

function failedJob(overrides = {}) {
    const metadataOverrides = overrides.dry_run_metadata || {};
    return {
        id: 'failed_job_1',
        status: 'failed',
        latitude: 33.445,
        longitude: -112.075,
        radius: 1.2,
        polygon: POLYGON,
        sold_months: 12,
        include_mls: false,
        force_full_refresh: true,
        progress_pct: 42,
        total_expected: 839,
        ...overrides,
        dry_run_metadata: {
            requested_properties: 839,
            requested_properties_before_cap: 1000,
            count_mode: 'fixed',
            filters: { min_price: 100000, max_price: 750000 },
            route_filters: ROUTE_FILTERS,
            route_bounds: { enabled: false },
            ownership_range_mode: 'custom',
            ownership_range_days: { min: 59, max: 365 },
            repull_mode: 'fill_gaps',
            previous_pull_date: '2026-06-01T00:00:00.000Z',
            force_full_refresh: true,
            include_unresolved_followups: true,
            ...metadataOverrides
        }
    };
}

test('a capped retry restates the originally entered count, not the capped effective count', () => {
    const { buildPrecisionRetryRequest } = loadTerritoryHelpers(['buildPrecisionRetryRequest']);

    const request = plain(buildPrecisionRetryRequest(failedJob(), { fallbackSoldMonths: 12 }));

    assert.equal(request.requested_properties, 1000);
    assert.notEqual(request.requested_properties, 839);
});

test('a retry that was never capped keeps its single entered count', () => {
    const { buildPrecisionRetryRequest } = loadTerritoryHelpers(['buildPrecisionRetryRequest']);

    const request = plain(buildPrecisionRetryRequest(
        failedJob({ dry_run_metadata: { requested_properties: 50, requested_properties_before_cap: 50 } }),
        { fallbackSoldMonths: 12 }
    ));

    assert.equal(request.requested_properties, 50);
});

test('a retry carries every material criterion from the failed job', () => {
    const { buildPrecisionRetryRequest } = loadTerritoryHelpers(['buildPrecisionRetryRequest']);

    const request = plain(buildPrecisionRetryRequest(failedJob(), { fallbackSoldMonths: 6 }));

    assert.deepEqual(request.polygon, POLYGON);
    assert.equal(request.sold_months, 12);
    assert.equal(request.count_mode, 'fixed');
    assert.equal(request.min_price, 100000);
    assert.equal(request.max_price, 750000);
    assert.equal(request.ownership_range_mode, 'custom');
    assert.equal(request.ownership_min_days, 59);
    assert.equal(request.ownership_max_days, 365);
    assert.deepEqual(request.route_filters, ROUTE_FILTERS);
    assert.deepEqual(request.route_bounds, { enabled: false });
    assert.equal(request.repull_mode, 'fill_gaps');
    assert.equal(request.previous_pull_date, '2026-06-01T00:00:00.000Z');
    assert.equal(request.force_full_refresh, true);
    assert.equal(request.include_unresolved_followups, true);
});

test('a retry prefers canonical persisted criteria over loose legacy metadata', () => {
    const { buildPrecisionRetryRequest } = loadTerritoryHelpers(['buildPrecisionRetryRequest']);
    const job = failedJob({
        dry_run_metadata: {
            repull_mode: 'stale_value',
            precision_criteria: {
                criteria_schema_version: 1,
                count_mode: 'max_available',
                entered_count: 1000,
                effective_count: 839,
                min_price: 125000,
                max_price: null,
                sold_months: 9,
                ownership_range_mode: 'quick',
                ownership_range_days: null,
                route_filters: ROUTE_FILTERS,
                repull_mode: 'max_since_last',
                previous_pull_date: '2026-05-02T00:00:00.000Z',
                force_full_refresh: false,
                include_unresolved_followups: false,
                route_bounds: { enabled: false }
            }
        }
    });

    const request = plain(buildPrecisionRetryRequest(job, { fallbackSoldMonths: 12 }));

    assert.equal(request.count_mode, 'max_available');
    assert.equal(request.requested_properties, 1000);
    assert.equal(request.min_price, 125000);
    assert.equal(request.max_price, null);
    assert.equal(request.sold_months, 9);
    assert.equal(request.ownership_range_mode, 'quick');
    assert.equal(request.repull_mode, 'max_since_last');
    assert.equal(request.previous_pull_date, '2026-05-02T00:00:00.000Z');
    assert.equal(request.force_full_refresh, false);
    assert.equal(request.include_unresolved_followups, false);
});

test('a retry never sends client-supplied identity or workspace evidence', () => {
    const { buildPrecisionRetryRequest } = loadTerritoryHelpers(['buildPrecisionRetryRequest']);

    const request = plain(buildPrecisionRetryRequest(failedJob(), { fallbackSoldMonths: 12 }));

    for (const forbidden of ['user_email', 'user_id', 'immutable_user_id', 'workspace_id', 'precision_usage_user_id']) {
        assert.equal(
            Object.prototype.hasOwnProperty.call(request, forbidden),
            false,
            `retry request must not carry ${forbidden}`
        );
    }
});

test('retry copy does not promise checkpoint continuation', () => {
    assert.equal(/resumes from the saved job/i.test(territory), false);
    assert.equal(/Retrying incomplete import from last checkpoint/i.test(territory), false);
    assert.match(territory, /Starting a new attempt using the verified original criteria/);
});

// ── Finding 6: explicit, server-verified active-job remediation ──────────────

function paidSubscription({ userId = 'user_1', id = 'sub_paid' } = {}) {
    const periodStart = Math.floor(Date.now() / 1000) - 60;
    const periodEnd = periodStart + 30 * 24 * 60 * 60;
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
            lines: { data: [{ subscription: id, period: { start: periodStart, end: periodEnd } }] }
        }
    };
}

function transpile(path) {
    const result = ts.transpileModule(readSource(path), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        fileName: path
    });
    return result.outputText;
}

function loadStartHandler(path, { base44, subscription }) {
    let handler;
    class FakeStripe {
        constructor() {
            return { subscriptions: { retrieve: async () => subscription } };
        }
    }
    class FakeClient {
        async connect() {}
        async query() { return { rows: [] }; }
        async end() {}
    }
    const shared = transpile('base44/functions/_shared/precisionActiveJobCriteria.js').replace(/^export\s+/gm, '');
    const functionSource = transpile(path).replace(/^import .*;\s*$/gm, '');
    vm.runInNewContext(`${shared}\n${functionSource}`, {
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
            serve: registered => { handler = registered; }
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

const POLYGON_HASH = await polygonHash(POLYGON);

function conflictingActiveJob(user, subscription) {
    return {
        id: 'active_other_device_job',
        status: 'running',
        provider: 'batchdata',
        mode_tag: 'PRECISION_TARGET',
        user_email: user.email,
        precision_usage_user_id: user.id,
        precision_usage_kind: 'paid',
        precision_subscription_id: subscription.id,
        precision_usage_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
        precision_usage_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
        precision_usage_reserved: 40,
        precision_usage_count: 0,
        created_date: '2026-07-26T01:00:00.000Z',
        started_at: '2026-07-26T01:00:00.000Z',
        progress_pct: 17,
        polygon: POLYGON,
        polygon_hash: POLYGON_HASH,
        sold_months: 6,
        total_expected: 40,
        pull_mode: 'new_area',
        dry_run_metadata: {
            requested_properties: 40,
            requested_properties_before_cap: 40,
            count_mode: 'fixed',
            filters: { min_price: 100000, max_price: null },
            route_filters: ROUTE_FILTERS,
            route_bounds: { enabled: false },
            ownership_range_mode: 'quick',
            ownership_range_days: null,
            repull_mode: 'new_area',
            previous_pull_date: null,
            force_full_refresh: false,
            include_unresolved_followups: false,
            workspace_id: user.id
        }
    };
}

async function invokeStart(path, body, activeJob) {
    const subscription = paidSubscription();
    const user = { id: 'user_1', email: 'owner@example.com', subscription_id: subscription.id };
    const jobs = activeJob ? [activeJob(user, subscription)] : [];
    const matches = (record, filter) => Object.entries(filter).every(([key, value]) => record[key] === value);
    const filterJobs = async (filter, _sort, limit = 500, skip = 0) =>
        jobs.filter(record => matches(record, filter)).slice(skip, skip + limit);
    const events = [];
    const base44 = {
        auth: { me: async () => user },
        entities: { FetchJob: { filter: filterJobs } },
        asServiceRole: {
            entities: {
                SavedRoute: { filter: async () => [] },
                FetchJob: {
                    filter: filterJobs,
                    get: async id => jobs.find(job => job.id === id) || null,
                    update: async (id, payload) => { events.push({ type: 'job:update', id, payload }); },
                    create: async payload => { events.push({ type: 'job:create', payload }); return { id: 'new_job', ...payload }; }
                }
            },
            functions: { invoke: async () => ({ data: { accepted: true } }) }
        }
    };
    const handler = loadStartHandler(path, { base44, subscription });
    const response = await handler(new Request('https://app.example.com/function', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    }));
    return { response, result: await response.json(), events };
}

function startBody(overrides = {}) {
    return {
        polygon: POLYGON,
        requested_properties: 300,
        count_mode: 'fixed',
        sold_months: 12,
        ownership_range_mode: 'quick',
        min_price: 100000,
        max_price: null,
        route_filters: ROUTE_FILTERS,
        route_bounds: { enabled: false },
        repull_mode: 'new_area',
        previous_pull_date: null,
        force_full_refresh: false,
        include_unresolved_followups: false,
        ...overrides
    };
}

for (const path of [
    'base44/functions/startBatchDataPull/entry.ts',
    'base44/functions/fetchAreaProperties/entry.ts'
]) {
    test(`${path} returns a verified remediable active job on criteria conflict`, async () => {
        const { response, result, events } = await invokeStart(path, startBody(), conflictingActiveJob);

        assert.equal(response.status, 409);
        assert.equal(result.error, 'active_job_criteria_conflict');
        assert.equal(result.active_job_id, 'active_other_device_job');
        assert.ok(result.active_job, 'expected a verified active_job block');
        assert.equal(result.active_job.id, 'active_other_device_job');
        assert.equal(result.active_job.status, 'running');
        assert.equal(result.active_job.progress_pct, 17);
        assert.equal(result.active_job.started_at, '2026-07-26T01:00:00.000Z');
        assert.equal(result.active_job.criteria_match, false);
        assert.equal(result.active_job.cancellation_allowed, true);
        assert.ok(result.active_job.criteria_summary, 'expected a criteria summary');
        assert.equal(result.active_job.criteria_summary.sold_months, 6);
        assert.equal(result.active_job.criteria_summary.effective_count, 40);
        // The blocked request must not cancel, release, or mutate the active job.
        assert.deepEqual(events, []);
    });
}

test('an exact-match active job is reported as trackable rather than remediable', async () => {
    const { response, result, events } = await invokeStart(
        'base44/functions/startBatchDataPull/entry.ts',
        startBody({ requested_properties: 40, sold_months: 6 }),
        conflictingActiveJob
    );

    assert.equal(response.status, 200);
    assert.equal(result.status, 'already_running');
    assert.equal(result.criteria_match, 'exact');
    assert.equal(result.active_job.criteria_match, true);
    assert.equal(result.active_job.id, 'active_other_device_job');
    assert.deepEqual(events, []);
});

test('the client offers an explicit confirmed cancel for a verified blocking job', () => {
    const { precisionActiveJobRemediation } = loadTerritoryHelpers(['precisionActiveJobRemediation']);

    const remediable = precisionActiveJobRemediation({
        code: 'active_job_criteria_conflict',
        status: 409,
        payload: {
            active_job_id: 'active_other_device_job',
            active_job: {
                id: 'active_other_device_job',
                status: 'running',
                progress_pct: 17,
                criteria_match: false,
                cancellation_allowed: true
            }
        }
    });

    assert.equal(remediable.jobId, 'active_other_device_job');
    assert.equal(remediable.canCancel, true);
    assert.equal(remediable.canWait, true);

    // Without server-verified evidence the client must not offer cancellation.
    const unverified = precisionActiveJobRemediation({
        code: 'active_job_criteria_conflict',
        status: 409,
        payload: { active_job_id: 'active_other_device_job' }
    });
    assert.equal(unverified.canCancel, false);
    assert.equal(unverified.jobId, null);

    const forbidden = precisionActiveJobRemediation({
        code: 'active_job_criteria_conflict',
        status: 409,
        payload: {
            active_job: { id: 'job_x', status: 'running', criteria_match: false, cancellation_allowed: false }
        }
    });
    assert.equal(forbidden.canCancel, false);
});

test('cancelling a blocking job still requires explicit confirmation and never happens automatically', () => {
    const cancelBlock = territory.slice(
        territory.indexOf('const handleCancelBlockingJob'),
        territory.indexOf('const handleCancelBlockingJob') + 1400
    );
    assert.match(cancelBlock, /confirm\(/);
    assert.match(cancelBlock, /cancelFetchJob/);
    // No code path may cancel a job merely because it looks old.
    assert.equal(/isStale|ageMs\s*>/.test(territory), false);
});

test('cancelFetchJob refuses a job owned by another immutable user', async () => {
    const source = transpile('base44/functions/cancelFetchJob/entry.ts').replace(/^import .*;\s*$/gm, '');
    const updates = [];
    let handler;
    const job = {
        id: 'active_other_device_job',
        status: 'running',
        precision_usage_user_id: 'user_1',
        user_email: 'owner@example.com'
    };
    const base44 = {
        auth: { me: async () => ({ id: 'intruder_9', email: 'owner@example.com', role: 'admin' }) },
        asServiceRole: {
            entities: {
                FetchJob: {
                    filter: async () => [job],
                    get: async () => job,
                    update: async (id, payload) => { updates.push({ id, payload }); }
                }
            },
            functions: { invoke: async () => ({ data: {} }) }
        }
    };
    vm.runInNewContext(source, {
        console,
        createClientFromRequest: () => base44,
        Deno: { env: { get: () => 'test' }, serve: registered => { handler = registered; } },
        Request,
        Response,
        setTimeout,
        clearTimeout
    }, { filename: 'cancelFetchJob/entry.ts' });

    const response = await handler(new Request('https://app.example.com/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ job_id: 'active_other_device_job' })
    }));

    assert.equal(response.status, 403);
    assert.deepEqual(updates, []);
});
