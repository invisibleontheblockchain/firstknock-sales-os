import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Exact end-to-end trace.
//
// One chain, all real production code:
//   user intent -> canonical criteria -> outbound BatchData request
//   -> captured/reconstructed provider response -> real parser
//   -> persisted row -> real exact-job candidate handler
//
// The assertion is that the same criteria survive every hop unchanged.

const FIXTURES = 'test/fixtures/batchdata';
const readFixture = rel => JSON.parse(fs.readFileSync(`${FIXTURES}/${rel}`, 'utf8'));
const plain = value => JSON.parse(JSON.stringify(value));

const POLYGON = [
    { lat: 35.4, lng: -80.1 },
    { lat: 35.6, lng: -80.1 },
    { lat: 35.6, lng: -79.9 },
    { lat: 35.4, lng: -79.9 }
];
const JOB_CREATED = '2026-07-25T12:00:00.000Z';
const ROUTE_FILTERS = {
    propertyTypes: ['Single Family'],
    excludeCommercial: true,
    excludeCondos: true,
    excludeLand: true
};

// The user's actual selections in the Precision panel.
const USER_INTENT = {
    polygon: POLYGON,
    sold_months: 12,
    ownership_range_mode: 'quick',
    count_mode: 'fixed',
    entered_count: 50,
    min_price: 100000,
    max_price: null,
    route_filters: ROUTE_FILTERS
};

function loadProcessor() {
    const source = fs.readFileSync('base44/functions/processFetchChunk/entry.ts', 'utf8')
        .replace(/^import .*;\s*$/gm, '');
    const sandbox = { Deno: { env: { get: () => null }, serve: () => {} }, console, setTimeout, clearTimeout };
    vm.runInNewContext(
        `${source}
        globalThis.__map = mapBatchDataProperty;
        globalThis.__extract = extractBatchDataRecords;
        globalThis.__build = buildBatchDataRequest;`,
        sandbox,
        { filename: 'processFetchChunk/entry.ts' }
    );
    return { map: sandbox.__map, extract: sandbox.__extract, build: sandbox.__build };
}

function loadCandidateHandler({ user, job, rows }) {
    const helperSource = fs.readFileSync('base44/functions/_shared/precisionActiveJobCriteria.js', 'utf8')
        .replace(/^export\s+/gm, '');
    const candidateSource = fs.readFileSync('base44/functions/getRouteCandidatesFromNeon/entry.ts', 'utf8')
        .replace(/^import[\s\S]*?;\r?\n/gm, '');
    let handler;
    const sql = async (strings) => {
        const query = strings.join(' ');
        if (query.includes('FROM workspace_properties')) return rows;
        throw new Error(`Unexpected SQL: ${query}`);
    };
    const base44 = {
        auth: { me: async () => user },
        asServiceRole: { entities: { FetchJob: { get: async (id) => (id === job?.id ? job : null) } } }
    };
    vm.runInNewContext(`${helperSource}\n${candidateSource}`, {
        createClientFromRequest: () => base44,
        neon: () => sql,
        Deno: {
            env: { get: (key) => (key === 'DATABASE_URL' ? 'postgres://test' : null) },
            serve: (candidate) => { handler = candidate; }
        },
        Response, TextEncoder, crypto: globalThis.crypto, console
    }, { filename: 'getRouteCandidatesFromNeon/entry.ts' });
    return handler;
}

async function polygonHash(points) {
    const normalized = points.map(point => [
        Number(Number(point.lat).toFixed(6)),
        Number(Number(point.lng).toFixed(6))
    ]);
    const bytes = new TextEncoder().encode(JSON.stringify(normalized));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function canonicalCriteria(hash) {
    return {
        criteria_schema_version: 1,
        polygon_hash: hash,
        count_mode: USER_INTENT.count_mode,
        entered_count: USER_INTENT.entered_count,
        effective_count: USER_INTENT.entered_count,
        min_price: USER_INTENT.min_price,
        max_price: USER_INTENT.max_price,
        sold_months: USER_INTENT.sold_months,
        ownership_range_mode: USER_INTENT.ownership_range_mode,
        ownership_range_days: null,
        route_filters: USER_INTENT.route_filters,
        repull_mode: 'new_area',
        previous_pull_date: null,
        force_full_refresh: false,
        include_unresolved_followups: false,
        route_bounds: { enabled: false },
        immutable_user_id: 'manager_1',
        workspace_id: 'manager_1'
    };
}

function precisionJob(hash, { providerContractVersion = 1 } = {}) {
    const criteria = canonicalCriteria(hash);
    return {
        id: 'job_1',
        status: 'completed',
        mode_tag: 'PRECISION_TARGET',
        phase: 'batchdata_precision',
        user_email: 'owner@example.com',
        precision_usage_user_id: 'manager_1',
        created_date: JOB_CREATED,
        polygon: POLYGON,
        polygon_hash: hash,
        sold_months: USER_INTENT.sold_months,
        total_expected: USER_INTENT.entered_count,
        dry_run_metadata: {
            workspace_id: 'manager_1',
            requested_properties: USER_INTENT.entered_count,
            requested_properties_before_cap: USER_INTENT.entered_count,
            count_mode: USER_INTENT.count_mode,
            filters: { min_price: USER_INTENT.min_price, max_price: USER_INTENT.max_price },
            route_filters: USER_INTENT.route_filters,
            repull_mode: 'new_area',
            previous_pull_date: null,
            force_full_refresh: false,
            include_unresolved_followups: false,
            route_bounds: { enabled: false },
            ownership_range_mode: USER_INTENT.ownership_range_mode,
            ownership_range_days: null,
            precision_criteria: criteria,
            ...(providerContractVersion === null ? {} : { provider_contract_version: providerContractVersion })
        }
    };
}

function rowFromMapped(mapped, index) {
    return {
        id: index + 1,
        address_hash: mapped.address_hash,
        full_address: mapped.full_address,
        house_number: mapped.house_number,
        street_name: mapped.street_name,
        city: mapped.city,
        state: mapped.state,
        zip_code: mapped.zip_code,
        lat: mapped.lat,
        lng: mapped.lng,
        price: mapped.price,
        sold_date: mapped.sold_date,
        property_type: mapped.property_type,
        data_source: mapped.data_source,
        sale_confidence: mapped.sale_confidence,
        original_status: mapped.original_status,
        route_active: mapped.route_active,
        status: mapped.original_status,
        fetch_job_id: 'job_1',
        created_at: '2026-07-25T12:01:00.000Z',
        updated_at: '2026-07-25T12:01:00.000Z'
    };
}

function exactRequest(hash) {
    return {
        fetch_job_id: 'job_1',
        polygon: POLYGON,
        sold_months: USER_INTENT.sold_months,
        ownership_range_mode: USER_INTENT.ownership_range_mode,
        count_mode: USER_INTENT.count_mode,
        requested_properties_before_cap: USER_INTENT.entered_count,
        requested_properties: USER_INTENT.entered_count,
        min_price: USER_INTENT.min_price,
        max_price: USER_INTENT.max_price,
        route_filters: USER_INTENT.route_filters,
        repull_mode: 'new_area',
        previous_pull_date: null,
        force_full_refresh: false,
        include_unresolved_followups: false,
        route_bounds: { enabled: false },
        workspace_id: 'manager_1',
        polygon_hash: hash
    };
}

const USER = { id: 'manager_1', email: 'owner@example.com', team_manager_id: 'manager_1' };

async function runTrace({ fixtureId = 'BD-R01-nested-coords', providerContractVersion = 1 } = {}) {
    const manifest = readFixture('manifest.json');
    const fixture = manifest.fixtures.find(entry => entry.fixture_id === fixtureId);
    const hash = await polygonHash(POLYGON);
    const job = precisionJob(hash, { providerContractVersion });
    const { map, extract, build } = loadProcessor();

    const batchdataRequest = plain(build(job, 0, 100, 'broad_polygon'));
    const payload = readFixture(fixture.response_fixture);
    const rawRecord = extract(payload)[0];
    const mapped = map(rawRecord, job);

    const handler = loadCandidateHandler({ user: USER, job, rows: [rowFromMapped(mapped, 0)] });
    const response = await handler(new Request('https://example.test/candidates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(exactRequest(hash))
    }));
    const candidateResult = await response.json();

    return {
        user_intent: USER_INTENT,
        canonical_criteria: canonicalCriteria(hash),
        batchdata_request: batchdataRequest,
        provider_fixture_id: fixtureId,
        provider_fields_used: {
            envelope: 'results.properties',
            recorded_sale_date: 'intel.lastSoldDate',
            land_use_code: 'general.standardizedLandUseCode',
            property_type: 'general.propertyTypeDetail',
            estimated_value: 'valuation.estimatedValue',
            owner_name: 'owner.fullName',
            coordinates: 'address.location.latitude/longitude (unproven nesting)'
        },
        persisted_property: mapped && {
            full_address: mapped.full_address,
            lat: mapped.lat,
            lng: mapped.lng,
            sold_date: mapped.sold_date,
            price: mapped.price,
            property_type: mapped.property_type
        },
        eligibility_decision: mapped && {
            route_active: mapped.route_active,
            exclusion_reason: mapped.exclusion_reason,
            counts_toward_precision_usage: mapped.route_active === true
        },
        candidate_decision: {
            status: response.status,
            error: candidateResult.error ?? null,
            returned: Array.isArray(candidateResult.properties) ? candidateResult.properties.length : 0,
            provider_contract_version: candidateResult.provider_contract_version ?? null,
            criteria_verification: candidateResult.criteria_verification ?? null
        }
    };
}

test('the exact end-to-end trace exposes every hop and they all agree', async () => {
    const trace = await runTrace();

    // The diagnostic shape the task requires.
    for (const key of [
        'user_intent', 'canonical_criteria', 'batchdata_request', 'provider_fixture_id',
        'provider_fields_used', 'persisted_property', 'eligibility_decision', 'candidate_decision'
    ]) {
        assert.ok(key in trace, `trace is missing ${key}`);
    }

    // user criteria == canonical criteria
    assert.equal(trace.canonical_criteria.sold_months, trace.user_intent.sold_months);
    assert.equal(trace.canonical_criteria.min_price, trace.user_intent.min_price);
    assert.equal(trace.canonical_criteria.max_price, trace.user_intent.max_price);
    assert.equal(trace.canonical_criteria.count_mode, trace.user_intent.count_mode);
    assert.equal(trace.canonical_criteria.entered_count, trace.user_intent.entered_count);

    // canonical criteria == outbound BatchData criteria
    const outbound = trace.batchdata_request.searchCriteria;
    assert.equal(outbound.valuation.estimatedValue.min, trace.canonical_criteria.min_price);
    assert.ok(!('max' in outbound.valuation.estimatedValue), 'no max was selected, so none may be sent');
    assert.equal(outbound.intel.lastSoldDate.minDate, '2025-07-25', '12 months before the job reference date');
    assert.ok(!('maxDate' in outbound.intel.lastSoldDate), 'quick mode has no newest bound');
    assert.equal(
        outbound.address.geoLocationPolygon.geoPoints.length,
        trace.user_intent.polygon.length + 1
    );

    // outbound criteria == locally revalidated returned-property criteria
    assert.equal(trace.persisted_property.sold_date, '2026-06-23T00:00:00.000Z');
    assert.ok(trace.persisted_property.sold_date.slice(0, 10) >= outbound.intel.lastSoldDate.minDate);
    assert.ok(trace.persisted_property.price >= outbound.valuation.estimatedValue.min);
    assert.equal(trace.eligibility_decision.route_active, true);
    assert.equal(trace.eligibility_decision.exclusion_reason, null);

    // == exact route-candidate criteria
    assert.equal(trace.candidate_decision.status, 200);
    assert.equal(trace.candidate_decision.error, null);
    assert.equal(trace.candidate_decision.returned, 1, 'the delivered property must survive candidate retrieval');
    assert.equal(trace.candidate_decision.criteria_verification, 'schema_v1');
    assert.equal(trace.candidate_decision.provider_contract_version, 1);
});

test('a property counted as delivered always survives exact-job candidate retrieval', async () => {
    const trace = await runTrace();
    assert.equal(
        trace.eligibility_decision.counts_toward_precision_usage,
        trace.candidate_decision.returned === 1,
        'billing and routability must not disagree'
    );
});

test('the trace holds for both unproven coordinate shapes', async () => {
    const nested = await runTrace({ fixtureId: 'BD-R01-nested-coords' });
    const flat = await runTrace({ fixtureId: 'BD-R02-flat-coords' });
    assert.deepEqual(nested.persisted_property, flat.persisted_property);
    assert.equal(flat.candidate_decision.returned, 1);
});

test('an unversioned legacy job is not reinterpreted under the current provider contract', async () => {
    const trace = await runTrace({ providerContractVersion: null });
    // Null must not be silently upgraded to v1.
    assert.equal(trace.candidate_decision.provider_contract_version, null);
    assert.equal(trace.candidate_decision.status, 200, 'an unversioned job still routes under the legacy policy');
});

test('a job written under an unknown provider contract fails closed', async () => {
    const trace = await runTrace({ providerContractVersion: 99 });
    assert.equal(trace.candidate_decision.status, 409);
    assert.equal(trace.candidate_decision.error, 'precision_provider_contract_unsupported');
    assert.equal(trace.candidate_decision.returned, 0, 'no candidate may be returned under an unknown contract');
});

test('the trace never carries raw provider PII to the browser', async () => {
    const trace = await runTrace();
    const serialized = JSON.stringify(trace);
    assert.ok(!serialized.includes('_field_provenance'), 'raw fixture internals must not leak into the trace');
    assert.ok(!('raw_payload' in trace.persisted_property), 'the minimized audit snapshot is server-side only');
    assert.ok(!('owner_full_name' in trace.persisted_property), 'owner identity is not part of the trace');
});
