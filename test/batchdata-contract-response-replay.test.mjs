import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Response-side BatchData contract tests.
//
// Fixtures under test/fixtures/batchdata/responses/ are replayed through the
// real production parser. Fixtures labelled `reconstructed_response` are built
// only from cited entries in observed-response-assertions.json; fixtures
// labelled `synthetic_failure_safety` are invented and prove fail-closed
// behaviour only. Neither may be cited as provider-contract evidence.

const FIXTURES = 'test/fixtures/batchdata';
const readFixture = rel => JSON.parse(fs.readFileSync(`${FIXTURES}/${rel}`, 'utf8'));

const manifest = readFixture('manifest.json');
const assertions = readFixture('responses/observed-response-assertions.json');
const synthetic = readFixture('responses/synthetic-failure-safety-cases.json');

// Polygon contains the fixture coordinate (35.5, -80.0).
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

function loadProcessorFunctions() {
    const source = fs.readFileSync('base44/functions/processFetchChunk/entry.ts', 'utf8')
        .replace(/^import .*;\s*$/gm, '');
    const sandbox = { Deno: { env: { get: () => null }, serve: () => {} }, console, setTimeout, clearTimeout };
    vm.runInNewContext(
        `${source}
        globalThis.__map = mapBatchDataProperty;
        globalThis.__extract = extractBatchDataRecords;
        globalThis.__total = extractBatchDataTotal;`,
        sandbox,
        { filename: 'processFetchChunk/entry.ts' }
    );
    return { map: sandbox.__map, extract: sandbox.__extract, total: sandbox.__total };
}

const { map: mapBatchDataProperty, extract: extractBatchDataRecords, total: extractBatchDataTotal } = loadProcessorFunctions();

async function polygonHash(points) {
    const normalized = points.map(point => [
        Number(Number(point.lat).toFixed(6)),
        Number(Number(point.lng).toFixed(6))
    ]);
    const bytes = new TextEncoder().encode(JSON.stringify(normalized));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function precisionJob(hash) {
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
        ownership_range_days: null
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
        dry_run_metadata: metadata
    };
}

const RECONSTRUCTED = manifest.fixtures.filter(entry => entry.source_type === 'reconstructed_response');

// ── Replay of reconstructed real-field fixtures ──────────────────────────────

for (const fixture of RECONSTRUCTED) {
    test(`replay ${fixture.fixture_id}: parses only evidence-backed fields into a routeable row`, async () => {
        const hash = await polygonHash(POLYGON);
        const job = precisionJob(hash);
        const payload = readFixture(fixture.response_fixture);

        const records = extractBatchDataRecords(payload);
        assert.equal(records.length, 1, 'results.properties must yield exactly one record');

        const mapped = mapBatchDataProperty(records[0], job);
        const expected = readFixture(fixture.expected_fixture);

        for (const [field, value] of Object.entries(expected)) {
            assert.deepEqual(mapped[field], value, `${fixture.fixture_id} field ${field}`);
        }

        // The recorded-sale date must come from intel.lastSoldDate (OBS-01),
        // preserved as the provider's own ISO-8601 UTC instant.
        assert.equal(mapped.sold_date, '2026-06-23T00:00:00.000Z');

        const rawPayload = JSON.parse(mapped.raw_payload);
        assert.equal(rawPayload.provider, 'batchdata');
        assert.equal(rawPayload.precision_eligibility.route_active, true);
        assert.equal(rawPayload.precision_eligibility.exclusion_reason, null);
        assert.equal(rawPayload.property.standardized_land_use_code, 'R2');
    });
}

test('both unproven coordinate shapes parse to the same coordinates', async () => {
    const hash = await polygonHash(POLYGON);
    const job = precisionJob(hash);

    const results = RECONSTRUCTED.map(fixture => {
        const record = extractBatchDataRecords(readFixture(fixture.response_fixture))[0];
        return mapBatchDataProperty(record, job);
    });

    assert.equal(results.length, 2, 'both the nested and flat coordinate fixtures must exist');
    for (const mapped of results) {
        assert.equal(mapped.lat, 35.5);
        assert.equal(mapped.lng, -80.0);
    }
    assert.equal(results[0].address_hash, results[1].address_hash);

    // Guard the recorded evidence gap: if either alias is deleted, this fails.
    const gap = assertions.unproven_paths_requiring_authorized_capture
        .find(entry => entry.path.includes('address.location.latitude'));
    assert.equal(gap.status, 'unproven');
});

// ── Envelope handling ────────────────────────────────────────────────────────

test('only results.properties is treated as the record envelope', () => {
    const nested = readFixture('responses/precision-polygon-intel-r2.nested-coords.reconstructed.json');
    assert.equal(extractBatchDataRecords(nested).length, 1);

    for (const { case_id, payload } of synthetic.unsupported_envelopes.cases) {
        assert.equal(
            extractBatchDataRecords(payload).length,
            0,
            `${case_id}: an unrecognised envelope must yield zero records, never a fabricated single row`
        );
    }
});

test('an absent record total is reported as unknown rather than zero (synthetic failure safety)', () => {
    const nested = readFixture('responses/precision-polygon-intel-r2.nested-coords.reconstructed.json');
    // No capture proves any totalRecordCount path, so absence is the tested case.
    assert.equal(extractBatchDataTotal(nested), null);
    assert.equal(extractBatchDataTotal({}), null);
    assert.equal(extractBatchDataTotal(null), null);
});

// ── No-guessing tests (synthetic failure safety) ─────────────────────────────

for (const testCase of synthetic.cases) {
    test(`synthetic failure safety ${testCase.case_id}: ${testCase.intent}`, async () => {
        const hash = await polygonHash(POLYGON);
        const mapped = mapBatchDataProperty({ property: testCase.property }, precisionJob(hash));

        if (Object.prototype.hasOwnProperty.call(testCase.expect, 'mapped') && testCase.expect.mapped === null) {
            assert.equal(mapped, null, 'record outside the requested polygon must be dropped entirely');
            return;
        }

        for (const [field, value] of Object.entries(testCase.expect)) {
            assert.deepEqual(mapped[field], value, `${testCase.case_id} field ${field}`);
        }
    });
}

test('a missing property type is not rescued by the land-use code alone', async () => {
    // Regression guard for the removed `providerPropertyType || "Single Family"`
    // default. R2 is proven "residential" (OBS-01) but is NOT proven to mean
    // single-family, so it cannot stand in for a missing propertyTypeDetail.
    const hash = await polygonHash(POLYGON);
    const mapped = mapBatchDataProperty({
        property: {
            address: { street: '1010 Redacted St', city: 'REDACTED_CITY_001', state: 'NC', zip: '27000', location: { latitude: 35.5, longitude: -80.0 } },
            intel: { lastSoldDate: '2026-06-23T00:00:00.000Z' },
            general: { standardizedLandUseCode: 'R2' },
            valuation: { estimatedValue: 325000 }
        }
    }, precisionJob(hash));

    assert.equal(mapped.property_type, null, 'must not fabricate a provider property type');
    assert.equal(mapped.route_active, false);
    assert.equal(mapped.exclusion_reason, 'unprovable_property_type');
});

test('MLS listing evidence cannot make a row eligible on any axis', async () => {
    const hash = await polygonHash(POLYGON);
    const mapped = mapBatchDataProperty({
        property: {
            address: { street: '1011 Redacted St', city: 'REDACTED_CITY_001', state: 'NC', zip: '27000', location: { latitude: 35.5, longitude: -80.0 } },
            general: { standardizedLandUseCode: 'R2', propertyTypeDetail: 'Single Family' },
            listing: { status: 'Sold', soldDate: '2026-06-23T00:00:00.000Z', soldPrice: 310000, price: 900000, listPrice: 900000 }
        }
    }, precisionJob(hash));

    assert.equal(mapped.sold_date, null, 'listing.soldDate must not become the ownership-transfer date');
    assert.equal(mapped.price, null, 'listing price must not become the estimated property value');
    assert.equal(mapped.route_active, false);
    assert.equal(mapped.exclusion_reason, 'missing_recorded_sale_date');
});

// ── Fixture-corpus integrity ─────────────────────────────────────────────────

test('the fixture corpus is not purely synthetic and every entry is classified', () => {
    const byType = new Map();
    for (const fixture of manifest.fixtures) {
        assert.ok(
            manifest.source_type_definitions[fixture.source_type],
            `fixture ${fixture.fixture_id} has an undefined source_type`
        );
        byType.set(fixture.source_type, (byType.get(fixture.source_type) || 0) + 1);
    }

    assert.ok((byType.get('real_provider_request_capture') || 0) >= 3, 'real captured requests are required');
    assert.ok((byType.get('observed_response_assertion') || 0) >= 1, 'observed response evidence is required');
    assert.ok(manifest.evidence_gaps.length > 0, 'evidence gaps must stay declared, not quietly closed');
});

test('reconstructed fixtures are never labelled as raw provider captures', () => {
    for (const fixture of RECONSTRUCTED) {
        const body = readFixture(fixture.response_fixture);
        assert.equal(body._source_type, 'reconstructed_response');
        assert.match(body._warning, /NOT a raw provider capture/);
        assert.ok(fixture.not_trusted_for.includes('establishing the provider contract'));
    }
    assert.equal(synthetic._source_type, 'synthetic_failure_safety');
});

test('redacted fixtures preserve raw hierarchy and data types', () => {
    const body = readFixture('responses/precision-polygon-intel-r2.nested-coords.reconstructed.json');
    const property = body.results.properties[0];

    assert.equal(typeof property.address, 'object');
    assert.equal(typeof property.address.location.latitude, 'number');
    assert.equal(typeof property.address.location.longitude, 'number');
    assert.equal(typeof property.address.zip, 'string', 'ZIP must stay a string, not become a number');
    assert.equal(typeof property.intel.lastSoldDate, 'string');
    assert.equal(typeof property.valuation.estimatedValue, 'number');
    assert.equal(typeof property.owner.ownerOccupied, 'boolean');
    assert.match(property.address.street, /^\d+\s+/, 'redaction must preserve the house-number split the parser relies on');
});
