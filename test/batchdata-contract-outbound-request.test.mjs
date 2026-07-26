import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Outbound BatchData contract tests.
//
// The exact request the user selected must be the exact request BatchData
// receives. Every JSON path this builder emits is checked against the real
// captured requests in test/fixtures/batchdata/requests/ so a speculative field
// cannot be introduced on assumption alone.

const FIXTURES = 'test/fixtures/batchdata';
const readFixture = rel => JSON.parse(fs.readFileSync(`${FIXTURES}/${rel}`, 'utf8'));

const manifest = readFixture('manifest.json');
const capturedRequests = manifest.fixtures
    .filter(entry => entry.source_type === 'real_provider_request_capture' || entry.source_type === 'provider_supplied_example')
    .map(entry => readFixture(entry.request_fixture));

function loadRequestBuilder() {
    const source = fs.readFileSync('base44/functions/processFetchChunk/entry.ts', 'utf8')
        .replace(/^import .*;\s*$/gm, '');
    const sandbox = { Deno: { env: { get: () => null }, serve: () => {} }, console, setTimeout, clearTimeout };
    vm.runInNewContext(
        `${source}\nglobalThis.__buildBatchDataRequest = buildBatchDataRequest;`,
        sandbox,
        { filename: 'processFetchChunk/entry.ts' }
    );
    return sandbox.__buildBatchDataRequest;
}

const buildBatchDataRequest = loadRequestBuilder();

// The builder runs inside a vm realm, so its objects carry a different Object
// prototype. Compare serialized shape, which is what BatchData receives anyway.
const plain = value => JSON.parse(JSON.stringify(value));

// Collect every leaf path in an object. Array indices collapse to [] so that a
// 48-point polygon and a 4-point polygon produce the same path set.
function leafPaths(value, prefix = '', out = new Set()) {
    if (Array.isArray(value)) {
        for (const item of value) leafPaths(item, `${prefix}[]`, out);
        if (value.length === 0) out.add(prefix);
        return out;
    }
    if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
            leafPaths(child, prefix ? `${prefix}.${key}` : key, out);
        }
        return out;
    }
    out.add(prefix);
    return out;
}

const CAPTURED_PATHS = new Set();
for (const request of capturedRequests) {
    for (const path of leafPaths(request)) CAPTURED_PATHS.add(path);
}

// Paths this builder emits that are not literally present in a captured request.
// Each is the documented sibling of a captured path inside the same provider
// object, and each exists to carry a bound the user explicitly selected. They
// are enumerated here so that adding a genuinely new speculative field fails.
const SIBLING_INFERRED_PATHS = new Map([
    [
        'searchCriteria.intel.lastSoldDate.maxDate',
        'Sibling of the captured searchCriteria.intel.lastSoldDate.minDate (fixture BD-E01-broad-7day, BD-E05-provider-example). Carries the newest-sale bound of a custom range; omitting it would drop a bound the user chose.'
    ],
    [
        'searchCriteria.valuation.estimatedValue.max',
        'Sibling of the captured searchCriteria.valuation.estimatedValue.min (fixture BD-E01-strict-r2-minvalue). Carries the user maximum home value.'
    ]
]);

const POLYGON = [
    { lat: 34.80, lng: -82.40 },
    { lat: 34.90, lng: -82.40 },
    { lat: 34.90, lng: -82.30 },
    { lat: 34.80, lng: -82.30 }
];
const JOB_CREATED = '2026-06-30T18:00:00.000Z';

function precisionJob(overrides = {}) {
    const { filters, ...rest } = overrides;
    return {
        id: 'job-contract-1',
        polygon: POLYGON,
        created_date: JOB_CREATED,
        sold_months: 0.25,
        mode_tag: 'PRECISION_TARGET',
        precision_usage_user_id: 'user-1',
        ...rest,
        dry_run_metadata: {
            filters: { min_price: 100000, max_price: null, ...(filters || {}) },
            ...(overrides.dry_run_metadata || {})
        }
    };
}

test('every outbound path is either captured from a real request or an enumerated sibling', () => {
    const scenarios = [
        precisionJob(),
        precisionJob({ filters: { min_price: 75000, max_price: 400000 } }),
        precisionJob({
            sold_months: 12,
            dry_run_metadata: {
                filters: { min_price: 100000 },
                ownership_range_mode: 'custom',
                ownership_range_days: { min: 1, max: 365 }
            }
        })
    ];

    for (const job of scenarios) {
        const request = buildBatchDataRequest(job, 0, 100, 'broad_polygon');
        for (const path of leafPaths(request)) {
            const known = CAPTURED_PATHS.has(path) || SIBLING_INFERRED_PATHS.has(path);
            assert.ok(
                known,
                `Outbound path "${path}" appears in no real captured BatchData request and is not an enumerated sibling. ` +
                'Add a real capture proving it, or remove the field.'
            );
        }
    }
});

test('options.datasets is never sent — real A/B evidence OBS-02 shows it suppresses intel/sale', () => {
    // Evidence: responses/observed-response-assertions.json OBS-02. A live
    // no-write probe on one polygon returned active=0 with datasets scoped and
    // active>0 with scoping omitted, because the response dropped intel/sale.
    // intel is not a member of basic|listing|deed|owner, so NO datasets array
    // can include the field this request filters on.
    for (const mode of ['broad_polygon', 'strict_polygon', 'centroid_fallback']) {
        const request = buildBatchDataRequest(precisionJob(), 0, 100, mode);
        assert.ok(!('datasets' in request.options), `${mode} must not send options.datasets`);
    }

    const assertions = readFixture('responses/observed-response-assertions.json');
    const obs02 = assertions.assertions.find(entry => entry.id === 'OBS-02');
    assert.ok(obs02, 'OBS-02 must remain in the evidence file that justifies this test');
    assert.match(obs02.fact, /omitted the intel and sale objects/);
});

test('options.take never exceeds the provider limit of 100 (evidence OBS-03)', () => {
    for (const requestedTake of [1, 50, 100, 500, 5000, Number.NaN]) {
        const request = buildBatchDataRequest(precisionJob(), 0, requestedTake, 'broad_polygon');
        assert.ok(request.options.take >= 1 && request.options.take <= 100, `take ${request.options.take} out of range`);
    }
});

test('pagination sends the exact requested skip and take', () => {
    for (const skip of [0, 100, 200, 900]) {
        const request = buildBatchDataRequest(precisionJob(), skip, 100, 'broad_polygon');
        assert.equal(request.options.skip, skip);
        assert.equal(request.options.take, 100);
    }
});

test('polygon is closed and lat/lng are not reversed', () => {
    const request = buildBatchDataRequest(precisionJob(), 0, 100, 'broad_polygon');
    const points = request.searchCriteria.address.geoLocationPolygon.geoPoints;

    assert.equal(points.length, POLYGON.length + 1, 'polygon must be explicitly closed');
    assert.deepEqual(points[0], points[points.length - 1], 'first and last point must match');

    points.slice(0, -1).forEach((point, index) => {
        assert.equal(point.latitude, POLYGON[index].lat, `point ${index} latitude must come from lat`);
        assert.equal(point.longitude, POLYGON[index].lng, `point ${index} longitude must come from lng`);
    });

    // Reversal guard: these ranges are disjoint, so a swap cannot pass.
    for (const point of points) {
        assert.ok(point.latitude > 0 && point.latitude < 90, 'latitude out of range — coordinates reversed?');
        assert.ok(point.longitude < 0 && point.longitude > -180, 'longitude out of range — coordinates reversed?');
    }
});

test('quick fixed-count range sends only the minDate bound', () => {
    const request = buildBatchDataRequest(precisionJob(), 0, 100, 'broad_polygon');
    // sold_months 0.25 anchored at 2026-06-30 -> the captured 7-day window.
    assert.deepEqual(plain(request.searchCriteria.intel.lastSoldDate), { minDate: '2026-06-23' });
    assert.match(request.searchCriteria.intel.lastSoldDate.minDate, /^\d{4}-\d{2}-\d{2}$/);
});

test('custom 1-365 day range sends both bounds, oldest to minDate and newest to maxDate', () => {
    const job = precisionJob({
        sold_months: 12,
        dry_run_metadata: {
            filters: { min_price: 100000 },
            ownership_range_mode: 'custom',
            ownership_range_days: { min: 30, max: 365 }
        }
    });
    const range = buildBatchDataRequest(job, 0, 100, 'broad_polygon').searchCriteria.intel.lastSoldDate;

    assert.equal(range.minDate, '2025-06-30', 'minDate must be the OLDEST allowed sale date (max days ago)');
    assert.equal(range.maxDate, '2026-05-31', 'maxDate must be the NEWEST allowed sale date (min days ago)');
    assert.ok(range.minDate < range.maxDate, 'date bounds must not be inverted');
});

test('explicit and default minimum value both reach searchCriteria.valuation.estimatedValue.min', () => {
    const explicit = buildBatchDataRequest(precisionJob({ filters: { min_price: 75000 } }), 0, 100, 'broad_polygon');
    assert.deepEqual(plain(explicit.searchCriteria.valuation.estimatedValue), { min: 75000 });

    const defaulted = buildBatchDataRequest(precisionJob(), 0, 100, 'broad_polygon');
    assert.deepEqual(plain(defaulted.searchCriteria.valuation.estimatedValue), { min: 100000 });
});

test('maximum value reaches estimatedValue.max and is omitted when unset', () => {
    const bounded = buildBatchDataRequest(precisionJob({ filters: { min_price: 75000, max_price: 400000 } }), 0, 100, 'broad_polygon');
    assert.deepEqual(plain(bounded.searchCriteria.valuation.estimatedValue), { min: 75000, max: 400000 });

    const unbounded = buildBatchDataRequest(precisionJob({ filters: { min_price: 75000, max_price: null } }), 0, 100, 'broad_polygon');
    assert.ok(!('max' in unbounded.searchCriteria.valuation.estimatedValue));
});

test('max_available and fixed count modes send an identical provider request', () => {
    // Count mode governs how many pages FirstKnock consumes. It is not a
    // provider search criterion and must never change the request body.
    const fixed = buildBatchDataRequest(
        precisionJob({ dry_run_metadata: { filters: { min_price: 100000 }, count_mode: 'fixed', requested_properties: 10 } }),
        0, 100, 'broad_polygon'
    );
    const maxAvailable = buildBatchDataRequest(
        precisionJob({ dry_run_metadata: { filters: { min_price: 100000 }, count_mode: 'max_available', requested_properties: 1000 } }),
        0, 100, 'broad_polygon'
    );
    assert.deepEqual(fixed, maxAvailable);
});

test('Fill Gaps, Max Since Last, and browser allowances never leak into provider criteria', () => {
    const base = buildBatchDataRequest(precisionJob(), 0, 100, 'broad_polygon');

    const repullVariants = [
        { repull_mode: 'fill_gaps', previous_pull_date: '2026-06-01T00:00:00.000Z' },
        { repull_mode: 'max_since_last', previous_pull_date: '2026-06-01T00:00:00.000Z' },
        { repull_mode: 'new_area', force_full_refresh: true, include_unresolved_followups: true },
        { route_bounds: { enabled: true, mode: 'home_round_trip' }, route_filters: { propertyTypes: ['Single Family'] } },
        { free_property_cap: 25, paid_property_limit: 1000, precision_usage_reserved: 10 }
    ];

    for (const extra of repullVariants) {
        const request = buildBatchDataRequest(
            precisionJob({ dry_run_metadata: { filters: { min_price: 100000 }, ...extra } }),
            0, 100, 'broad_polygon'
        );
        assert.deepEqual(request, base, `repull/allowance metadata ${JSON.stringify(extra)} changed the provider request`);
    }
});

test('no MLS-era field appears anywhere in the outbound request', () => {
    const serialized = JSON.stringify(buildBatchDataRequest(
        precisionJob({ include_mls: true, dry_run_metadata: { filters: { min_price: 100000 }, include_mls: true } }),
        0, 100, 'broad_polygon'
    ));

    for (const term of ['include_mls', 'mls', 'listing', 'statusCategory', 'soldPrice']) {
        assert.ok(!serialized.toLowerCase().includes(term.toLowerCase()), `outbound request must not mention ${term}`);
    }
});

test('the enumerated sibling-inferred paths stay small and justified', () => {
    // A growing list here means speculative fields are being normalised in.
    assert.ok(SIBLING_INFERRED_PATHS.size <= 2, 'new inferred outbound paths need a real capture, not another entry');
    for (const [path, justification] of SIBLING_INFERRED_PATHS) {
        assert.ok(justification.includes('captured'), `${path} justification must cite a capture`);
    }
});
