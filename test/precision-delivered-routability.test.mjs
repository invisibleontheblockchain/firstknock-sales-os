import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// A property may count toward FetchJob.precision_usage_count only when the same
// property is eligible for the exact-job candidate set used to build the route.
// These tests exercise the real processor mapper and the real candidate handler
// so the two sides cannot drift apart again.

const POLYGON = [
    { lat: 33.40, lng: -112.20 },
    { lat: 33.60, lng: -112.20 },
    { lat: 33.60, lng: -112.00 },
    { lat: 33.40, lng: -112.00 }
];
const JOB_CREATED = '2026-07-25T12:00:00.000Z';
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

function loadBatchDataMapper() {
    const source = fs.readFileSync('base44/functions/processFetchChunk/entry.ts', 'utf8')
        .replace(/^import .*;\s*$/gm, '');
    const sandbox = {
        Deno: { env: { get: () => null }, serve: () => {} },
        console,
        setTimeout,
        clearTimeout
    };
    vm.runInNewContext(
        `${source}\nglobalThis.__mapBatchDataProperty = mapBatchDataProperty;`,
        sandbox,
        { filename: 'processFetchChunk/entry.ts' }
    );
    return sandbox.__mapBatchDataProperty;
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
        asServiceRole: {
            entities: { FetchJob: { get: async (id) => (id === job?.id ? job : null) } }
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
    return handler;
}

function precisionJob(hash, overrides = {}) {
    const metadataOverrides = overrides.dry_run_metadata || {};
    const metadata = {
        workspace_id: 'manager_1',
        requested_properties: 50,
        requested_properties_before_cap: 50,
        count_mode: 'fixed',
        filters: { min_price: 100000, max_price: null },
        route_filters: ROUTE_FILTERS,
        repull_mode: 'new_area',
        previous_pull_date: null,
        force_full_refresh: false,
        include_unresolved_followups: false,
        route_bounds: { enabled: false },
        ownership_range_mode: 'quick',
        ownership_range_days: null,
        ...metadataOverrides
    };
    metadata.precision_criteria = {
        criteria_schema_version: 1,
        polygon_hash: hash,
        count_mode: metadata.count_mode,
        entered_count: metadata.requested_properties_before_cap,
        effective_count: metadata.requested_properties,
        min_price: metadata.filters?.min_price ?? null,
        max_price: metadata.filters?.max_price ?? null,
        sold_months: 12,
        ownership_range_mode: metadata.ownership_range_mode,
        ownership_range_days: metadata.ownership_range_days,
        route_filters: metadata.route_filters,
        repull_mode: metadata.repull_mode,
        previous_pull_date: metadata.previous_pull_date,
        force_full_refresh: metadata.force_full_refresh,
        include_unresolved_followups: metadata.include_unresolved_followups,
        route_bounds: metadata.route_bounds,
        immutable_user_id: 'manager_1',
        workspace_id: metadata.workspace_id,
        ...(metadataOverrides.precision_criteria || {})
    };
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
        sold_months: 12,
        total_expected: 50,
        ...overrides,
        dry_run_metadata: metadata
    };
}

function providerRecord(overrides = {}) {
    const { general, intel, valuation, ...rest } = overrides;
    return {
        property: {
            address: {
                street: '100 Test Ave',
                city: 'Phoenix',
                state: 'AZ',
                zip: '85001',
                location: { latitude: 33.4484, longitude: -112.074 }
            },
            intel: { lastSoldDate: '2026-07-01', ...(intel || {}) },
            general: {
                standardizedLandUseCode: 'R2',
                propertyTypeDetail: 'Single Family',
                ...(general || {})
            },
            valuation: { estimatedValue: 250000, ...(valuation || {}) },
            ...rest
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

function exactRequest(overrides = {}) {
    return {
        fetch_job_id: 'job_1',
        polygon: POLYGON,
        sold_months: 12,
        ownership_range_mode: 'quick',
        count_mode: 'fixed',
        requested_properties_before_cap: 50,
        requested_properties: 50,
        min_price: 100000,
        max_price: null,
        route_filters: ROUTE_FILTERS,
        repull_mode: 'new_area',
        previous_pull_date: null,
        force_full_refresh: false,
        include_unresolved_followups: false,
        route_bounds: { enabled: false },
        workspace_id: 'manager_1',
        ...overrides
    };
}

test('a Precision record with no recorded sale date is never delivered as route-active', async () => {
    const hash = await polygonHash(POLYGON);
    const mapBatchDataProperty = loadBatchDataMapper();

    const mapped = mapBatchDataProperty(
        providerRecord({ intel: { lastSoldDate: null }, listing: {}, sale: {} }),
        precisionJob(hash)
    );

    assert.equal(mapped.sold_date, null);
    assert.equal(mapped.route_active, false);
    assert.equal(mapped.original_status, 'REJECTED');
    assert.equal(mapped.exclusion_reason, 'missing_recorded_sale_date');
});

test('a Precision record sold outside the persisted window is never delivered as route-active', async () => {
    const hash = await polygonHash(POLYGON);
    const mapBatchDataProperty = loadBatchDataMapper();

    const mapped = mapBatchDataProperty(
        providerRecord({ intel: { lastSoldDate: '2024-01-15' } }),
        precisionJob(hash)
    );

    assert.equal(mapped.route_active, false);
    assert.equal(mapped.exclusion_reason, 'recorded_sale_outside_window');
});

test('a Precision record with no provable value cannot satisfy a positive minimum price', async () => {
    const hash = await polygonHash(POLYGON);
    const mapBatchDataProperty = loadBatchDataMapper();

    const mapped = mapBatchDataProperty(
        providerRecord({ valuation: { estimatedValue: null } }),
        precisionJob(hash)
    );

    assert.equal(mapped.price, null);
    assert.equal(mapped.route_active, false);
    assert.equal(mapped.exclusion_reason, 'unprovable_minimum_value');
});

test('a Precision record with no provider property type is not treated as single family', async () => {
    const hash = await polygonHash(POLYGON);
    const mapBatchDataProperty = loadBatchDataMapper();

    const mapped = mapBatchDataProperty(
        providerRecord({ general: { propertyTypeDetail: null, standardizedLandUseCode: null } }),
        precisionJob(hash)
    );

    assert.equal(mapped.route_active, false);
    assert.equal(mapped.exclusion_reason, 'unprovable_property_type');
});

test('a fully provable Precision record stays delivered and routeable', async () => {
    const hash = await polygonHash(POLYGON);
    const mapBatchDataProperty = loadBatchDataMapper();

    const mapped = mapBatchDataProperty(providerRecord(), precisionJob(hash));

    assert.equal(mapped.route_active, true);
    assert.equal(mapped.original_status, 'BATCHDATA_CONFIRMED');
    assert.equal(mapped.sale_confidence, 'verified');
    assert.equal(mapped.exclusion_reason, null);
    const rawPayload = JSON.parse(mapped.raw_payload);
    assert.equal(rawPayload.precision_eligibility.route_active, true);
    assert.equal(rawPayload.precision_eligibility.exclusion_reason, null);
});

test('every delivered Precision property survives the exact-job candidate query', async () => {
    const hash = await polygonHash(POLYGON);
    const mapBatchDataProperty = loadBatchDataMapper();
    const job = precisionJob(hash);

    const records = [
        providerRecord(),
        providerRecord({ address: undefined, intel: { lastSoldDate: null }, listing: {}, sale: {} }),
        providerRecord({ intel: { lastSoldDate: '2023-05-05' } }),
        providerRecord({ valuation: { estimatedValue: null } }),
        providerRecord({ general: { propertyTypeDetail: null, standardizedLandUseCode: null } })
    ];
    const mapped = records
        .map((record, index) => {
            const result = mapBatchDataProperty(record, job);
            if (!result) return null;
            // Distinct address hashes so the candidate set cannot dedupe them away.
            return { ...result, address_hash: `hash_${index}` };
        })
        .filter(Boolean);

    // countPersistedPrecisionProperties() settles precision_usage_count from
    // exactly this predicate: workspace_properties rows with route_active TRUE.
    const delivered = mapped.filter(property => property.route_active === true);
    assert.ok(delivered.length > 0, 'expected at least one delivered property');

    const handler = loadCandidateHandler({
        user: { id: 'manager_1', email: 'owner@example.com', role: 'user' },
        job,
        rows: delivered.map(rowFromMapped)
    });
    const response = await handler({ json: async () => exactRequest() });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.excluded_outside_exact_job_window, 0);
    assert.equal(
        result.count,
        delivered.length,
        'precision_usage_count must equal the routeable exact-job candidate count'
    );
});

test('non-Precision pulls keep their existing lenient mapping behavior', async () => {
    const mapBatchDataProperty = loadBatchDataMapper();
    const legacyZipJob = {
        id: 'zip_job',
        polygon: POLYGON,
        sold_months: 12,
        created_date: JOB_CREATED,
        dry_run_metadata: {}
    };

    const mapped = mapBatchDataProperty(
        providerRecord({ valuation: { estimatedValue: null } }),
        legacyZipJob
    );

    assert.equal(mapped.route_active, true);
    assert.equal(mapped.exclusion_reason, null);
});
