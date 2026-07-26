import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

// Completed jobs created before schema-v1 criteria existed must still be
// routeable when the server can prove the material criteria from immutable
// evidence, without silently upgrading their historical price semantics, and
// identity must always come from the authenticated actor rather than the body.

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');

const POLYGON = [
    { lat: 33.40, lng: -112.20 },
    { lat: 33.60, lng: -112.20 },
    { lat: 33.60, lng: -112.00 },
    { lat: 33.40, lng: -112.00 }
];
const ROUTE_FILTERS = {
    propertyTypes: ['Single Family'],
    excludeCommercial: true,
    excludeCondos: true,
    excludeLand: true
};

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

function loadCandidateHandler({
    user = { id: 'manager_1', email: 'owner@example.com', role: 'user' },
    job,
    rows = [propertyRow()]
} = {}) {
    const helperSource = readSource('base44/functions/_shared/precisionActiveJobCriteria.js')
        .replace(/^export\s+/gm, '');
    const candidateSource = readSource('base44/functions/getRouteCandidatesFromNeon/entry.ts')
        .replace(/^import[\s\S]*?;\r?\n/gm, '');
    let handler;
    const sqlCalls = [];
    const mutations = [];
    const sql = async (strings, ...values) => {
        const query = strings.join(' ');
        sqlCalls.push({ query, values });
        if (query.includes('FROM workspace_properties')) return rows;
        throw new Error(`Unexpected SQL: ${query}`);
    };
    const base44 = {
        auth: { me: async () => user },
        asServiceRole: {
            entities: {
                FetchJob: {
                    get: async (id) => (id === job?.id ? job : null),
                    update: async (id, payload) => { mutations.push({ id, payload }); },
                    create: async (payload) => { mutations.push({ create: payload }); return { id: 'x' }; }
                }
            },
            functions: { invoke: async (name, payload) => { mutations.push({ invoke: name, payload }); return { data: {} }; } }
        }
    };
    vm.runInNewContext(`${helperSource}\n${candidateSource}`, {
        createClientFromRequest: () => base44,
        neon: () => sql,
        Deno: {
            env: { get: (key) => (key === 'DATABASE_URL' ? 'postgres://test' : null) },
            serve: (candidate) => { handler = candidate; }
        },
        Response,
        TextEncoder,
        crypto: globalThis.crypto,
        console
    }, { filename: 'getRouteCandidatesFromNeon/entry.ts' });
    return { handler, sqlCalls, mutations };
}

// A completed job from before PR #66: no precision_criteria, no workspace_id,
// and min_price null, which historically meant "no price floor".
function legacyJob(overrides = {}) {
    const metadataOverrides = overrides.dry_run_metadata || {};
    return {
        id: 'legacy_job_1',
        status: 'completed',
        mode_tag: 'PRECISION_TARGET',
        user_email: 'owner@example.com',
        precision_usage_user_id: 'manager_1',
        created_date: '2026-05-01T12:00:00.000Z',
        polygon: POLYGON,
        polygon_hash: POLYGON_HASH,
        sold_months: 12,
        total_expected: 50,
        ...overrides,
        dry_run_metadata: {
            requested_properties: 50,
            requested_properties_before_cap: 50,
            filters: { min_price: null, max_price: null },
            ownership_range_mode: 'quick',
            ...metadataOverrides
        }
    };
}

function propertyRow(overrides = {}) {
    return {
        id: 1,
        address_hash: 'hash_1',
        full_address: '100 Test Ave, Phoenix, AZ 85001',
        house_number: 100,
        street_name: 'Test Ave',
        city: 'Phoenix',
        state: 'AZ',
        zip_code: '85001',
        lat: 33.4484,
        lng: -112.074,
        price: 84000,
        sold_date: '2026-04-20T00:00:00.000Z',
        property_type: 'Single Family',
        data_source: 'batchdata',
        sale_confidence: 'verified',
        original_status: 'BATCHDATA_CONFIRMED',
        route_active: true,
        status: 'BATCHDATA_CONFIRMED',
        fetch_job_id: 'legacy_job_1',
        created_at: '2026-05-01T12:01:00.000Z',
        updated_at: '2026-05-01T12:01:00.000Z',
        ...overrides
    };
}

// What Home.jsx sends for a legacy job: server-derived diagnostics, so
// count_mode and route_filters are absent and min_price is null.
function legacyRequest(overrides = {}) {
    return {
        fetch_job_id: 'legacy_job_1',
        polygon: POLYGON,
        sold_months: 12,
        ownership_range_mode: 'quick',
        count_mode: null,
        requested_properties_before_cap: 50,
        requested_properties: 50,
        min_price: null,
        max_price: null,
        route_filters: null,
        repull_mode: 'new_area',
        previous_pull_date: null,
        force_full_refresh: false,
        include_unresolved_followups: false,
        route_bounds: { enabled: false },
        workspace_id: 'manager_1',
        ...overrides
    };
}

const invoke = async (handler, body) => {
    const response = await handler({ json: async () => body });
    return { response, result: await response.json() };
};

test('a legacy completed job with provable evidence still generates routes', async () => {
    const { handler, mutations } = loadCandidateHandler({ job: legacyJob() });

    const { response, result } = await invoke(handler, legacyRequest());

    assert.equal(response.status, 200);
    assert.equal(result.criteria_verified, true);
    assert.equal(result.criteria_verification, 'legacy_reconstructed');
    assert.equal(result.count, 1);
    // Validation must never repull or spend allowance.
    assert.deepEqual(mutations, []);
});

test('legacy no-floor price semantics are preserved, not rewritten to $100,000', async () => {
    const { handler } = loadCandidateHandler({ job: legacyJob() });

    const { result } = await invoke(handler, legacyRequest());

    assert.equal(result.criteria_verification, 'legacy_reconstructed');
    assert.equal(result.min_price, null);
    // An $84,000 home stays routeable because the original pull had no floor.
    assert.equal(result.count, 1);
});

test('a legacy job cannot be reinterpreted with the modern $100,000 floor', async () => {
    const { handler, sqlCalls } = loadCandidateHandler({ job: legacyJob() });

    const { response, result } = await invoke(handler, legacyRequest({ min_price: 100000 }));

    assert.equal(response.status, 409);
    assert.equal(result.error, 'fetch_job_criteria_mismatch');
    assert.ok(result.mismatch_fields.includes('min_price'));
    assert.equal(sqlCalls.length, 0);
});

test('a legacy job without immutable subject evidence fails closed', async () => {
    const { handler, sqlCalls } = loadCandidateHandler({
        job: legacyJob({ precision_usage_user_id: null })
    });

    const { response, result } = await invoke(handler, legacyRequest());

    assert.equal(response.status, 409);
    assert.equal(result.error, 'legacy_precision_criteria_unverifiable');
    assert.ok(Array.isArray(result.invalid_fields));
    assert.ok(result.invalid_fields.includes('immutable_user_id'));
    assert.equal(sqlCalls.length, 0);
});

test('a legacy job without a usable polygon fails closed', async () => {
    const { handler, sqlCalls } = loadCandidateHandler({
        job: legacyJob({ polygon: [], polygon_hash: null })
    });

    const { response, result } = await invoke(handler, legacyRequest());

    assert.equal(response.status, 409);
    assert.equal(result.error, 'legacy_precision_criteria_unverifiable');
    assert.ok(result.invalid_fields.includes('polygon_hash'));
    assert.equal(sqlCalls.length, 0);
});

test('a legacy job predating requested_properties_before_cap still routes', async () => {
    const job = legacyJob();
    delete job.dry_run_metadata.requested_properties_before_cap;
    const { handler } = loadCandidateHandler({ job });

    // fetchJobStatus resolves the client's entered count through the same
    // fallback chain, so the two sides agree without guessing.
    const { response, result } = await invoke(handler, legacyRequest());

    assert.equal(response.status, 200);
    assert.equal(result.criteria_verification, 'legacy_reconstructed');
    assert.equal(result.count, 1);
});

test('a legacy job with no count evidence at all fails closed', async () => {
    const job = legacyJob({ total_expected: null });
    delete job.dry_run_metadata.requested_properties_before_cap;
    delete job.dry_run_metadata.requested_properties;
    const { handler, sqlCalls } = loadCandidateHandler({ job });

    const { response, result } = await invoke(handler, legacyRequest());

    assert.equal(response.status, 409);
    assert.equal(result.error, 'legacy_precision_criteria_unverifiable');
    assert.ok(result.invalid_fields.includes('entered_count'));
    assert.ok(result.invalid_fields.includes('effective_count'));
    assert.equal(sqlCalls.length, 0);
});

test('a legacy job without a provable sold window fails closed', async () => {
    const { handler, sqlCalls } = loadCandidateHandler({
        job: legacyJob({ sold_months: null })
    });

    const { response, result } = await invoke(handler, legacyRequest({ sold_months: null }));

    assert.equal(response.status, 409);
    assert.equal(result.error, 'legacy_precision_criteria_unverifiable');
    assert.ok(result.invalid_fields.includes('sold_months'));
    assert.equal(sqlCalls.length, 0);
});

test('a legacy job discloses which criteria could not be proven', async () => {
    const { handler } = loadCandidateHandler({ job: legacyJob() });

    const { result } = await invoke(handler, legacyRequest());

    assert.ok(Array.isArray(result.unverified_fields));
    assert.ok(result.unverified_fields.includes('route_filters'));
    assert.ok(result.unverified_fields.includes('count_mode'));
});

test('a legacy job in another workspace is rejected', async () => {
    const { handler, sqlCalls } = loadCandidateHandler({
        job: legacyJob({ dry_run_metadata: { workspace_id: 'other_manager' } })
    });

    const { response, result } = await invoke(handler, legacyRequest());

    assert.equal(response.status, 403);
    assert.equal(result.error, 'fetch_job_workspace_mismatch');
    assert.equal(sqlCalls.length, 0);
});

test('a schema-v1 job never takes the legacy path', async () => {
    const job = legacyJob();
    job.dry_run_metadata.precision_criteria = {
        criteria_schema_version: 1,
        polygon_hash: POLYGON_HASH,
        count_mode: 'fixed',
        entered_count: 50,
        effective_count: 50,
        min_price: null,
        max_price: null,
        sold_months: 12,
        ownership_range_mode: 'quick',
        ownership_range_days: null,
        route_filters: ROUTE_FILTERS,
        repull_mode: 'new_area',
        previous_pull_date: null,
        force_full_refresh: false,
        include_unresolved_followups: false,
        route_bounds: { enabled: false },
        immutable_user_id: 'manager_1',
        workspace_id: 'manager_1'
    };
    const { handler, sqlCalls } = loadCandidateHandler({ job });

    // Schema-v1 criteria must satisfy the strict validator, which requires a
    // positive minimum price. A null price is a canonical-record defect.
    const { response, result } = await invoke(handler, legacyRequest());

    assert.equal(response.status, 409);
    assert.equal(result.error, 'fetch_job_criteria_unverifiable');
    assert.ok(result.invalid_fields.includes('min_price'));
    assert.equal(sqlCalls.length, 0);
});

// ── Finding 7: identity and workspace must be server-derived ─────────────────

test('a spoofed workspace_id in the request body is rejected as an authorization failure', async () => {
    const { handler, sqlCalls } = loadCandidateHandler({ job: legacyJob() });

    const { response, result } = await invoke(handler, legacyRequest({ workspace_id: 'other_manager' }));

    assert.equal(response.status, 403);
    assert.equal(result.error, 'fetch_job_workspace_mismatch');
    assert.equal(sqlCalls.length, 0);
});

test('an omitted workspace_id still fails closed', async () => {
    const { handler, sqlCalls } = loadCandidateHandler({ job: legacyJob() });
    const body = legacyRequest();
    delete body.workspace_id;

    const { response, result } = await invoke(handler, body);

    assert.equal(response.status, 409);
    assert.ok(['fetch_job_criteria_mismatch', 'legacy_precision_criteria_unverifiable'].includes(result.error));
    assert.equal(sqlCalls.length, 0);
});

test('admin role alone cannot retarget another user through body.user_email', async () => {
    const { handler, sqlCalls } = loadCandidateHandler({
        user: { id: 'platform_admin', email: 'admin@example.com', role: 'admin' },
        job: legacyJob()
    });

    const { response, result } = await invoke(handler, legacyRequest({ user_email: 'owner@example.com' }));

    assert.equal(response.status, 403);
    assert.equal(result.error, 'fetch_job_owner_mismatch');
    assert.equal(sqlCalls.length, 0);
});

test('request criteria never inherit identity from the persisted record', () => {
    const source = readSource('base44/functions/getRouteCandidatesFromNeon/entry.ts');
    const start = source.indexOf('function requestCriteriaFromBody');
    assert.notEqual(start, -1);
    const body = source.slice(start, source.indexOf('\n}', start));
    assert.equal(
        /immutable_user_id:\s*persistedCriteria/.test(body),
        false,
        'identity must be server-derived, not copied from the persisted criteria'
    );
    assert.equal(
        /workspace_id:\s*body\./.test(body),
        false,
        'workspace identity must be server-derived, not taken from the request body'
    );
});

test('route generation rejects an unnamed or unknown verification mode', () => {
    const home = readSource('src/pages/Home.jsx');
    const start = home.indexOf('const verificationMode = data.criteria_verification;');
    assert.notEqual(start, -1, 'Home.jsx must read the verification mode');
    const guard = home.slice(start, start + 600);
    assert.match(guard, /\['schema_v1', 'legacy_reconstructed'\]\.includes\(verificationMode\)/);
    assert.match(guard, /data\.criteria_verified !== true/);
});

// ── Finding 5: the $100,000 default is explicit and disclosed ────────────────

function transpile(path) {
    const result = ts.transpileModule(readSource(path), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        fileName: path
    });
    return result.outputText;
}

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

async function invokeDryRun(path, body) {
    const subscription = paidSubscription();
    const user = { id: 'user_1', email: 'owner@example.com', subscription_id: subscription.id };
    let handler;
    class FakeStripe {
        constructor() { return { subscriptions: { retrieve: async () => subscription } }; }
    }
    class FakeClient {
        async connect() {}
        async query() { return { rows: [] }; }
        async end() {}
    }
    const base44 = {
        auth: { me: async () => user },
        entities: { FetchJob: { filter: async () => [] } },
        asServiceRole: {
            entities: {
                SavedRoute: { filter: async () => [] },
                FetchJob: { filter: async () => [], create: async () => ({ id: 'j' }), update: async () => {} }
            },
            functions: { invoke: async () => ({ data: {} }) }
        }
    };
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
    const response = await handler(new Request('https://app.example.com/function', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            polygon: POLYGON,
            requested_properties: 100,
            count_mode: 'fixed',
            sold_months: 12,
            ownership_range_mode: 'quick',
            route_filters: ROUTE_FILTERS,
            route_bounds: { enabled: false },
            dry_run: true,
            ...body
        })
    }));
    return { response, result: await response.json() };
}

for (const path of [
    'base44/functions/startBatchDataPull/entry.ts',
    'base44/functions/fetchAreaProperties/entry.ts'
]) {
    test(`${path} normalizes a missing minimum value to $100,000`, async () => {
        const { response, result } = await invokeDryRun(path, {});
        assert.equal(response.status, 200);
        assert.equal(result.filters.min_price, 100000);
    });

    test(`${path} normalizes a blank minimum value to $100,000`, async () => {
        const { response, result } = await invokeDryRun(path, { min_price: '' });
        assert.equal(response.status, 200);
        assert.equal(result.filters.min_price, 100000);
    });

    test(`${path} preserves an explicit $75,000 minimum`, async () => {
        const { response, result } = await invokeDryRun(path, { min_price: 75000 });
        assert.equal(response.status, 200);
        assert.equal(result.filters.min_price, 75000);
    });

    test(`${path} rejects a malformed minimum value`, async () => {
        const objectValue = await invokeDryRun(path, { min_price: { amount: 1 } });
        assert.equal(objectValue.response.status, 400);
        assert.equal(objectValue.result.error, 'invalid_min_price');

        const zeroValue = await invokeDryRun(path, { min_price: 0 });
        assert.equal(zeroValue.response.status, 400);
        assert.equal(zeroValue.result.error, 'invalid_min_price');
    });
}

test('the pull panel discloses the $100,000 default minimum value', () => {
    const panel = readSource('src/components/map/PrecisionPullPanel.jsx');
    assert.match(panel, /\$100,000/);
});
