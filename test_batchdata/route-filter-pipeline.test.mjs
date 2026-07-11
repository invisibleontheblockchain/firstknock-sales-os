import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';


const bundleDir = await mkdtemp(path.join(tmpdir(), 'firstknock-route-filter-test-'));
const bundlePath = path.join(bundleDir, 'routeFilterPipeline.mjs');
await build({
    entryPoints: [path.resolve('src/components/logic/routeFilterPipeline.jsx')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    logLevel: 'silent'
});
const { applyRouteFilters, routeCalendarDate } = await import(pathToFileURL(bundlePath).href);


test.after(async () => {
    await rm(bundleDir, { recursive: true, force: true });
});


const routeConfig = {
    propertyTypes: ['Single Family'],
    excludeAssigned: false,
    includeUnverifiedSales: false,
    excludePreviouslyKnocked: false,
    includeCallbacks: true
};


function localDateDaysAgo(days) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - days);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}


function property(overrides = {}) {
    return {
        id: 'property',
        address_hash: 'property-hash',
        lat: 33.45,
        lng: -112.07,
        zip_code: '85001',
        property_type: 'Single Family',
        route_active: true,
        data_source: 'rentcast',
        original_status: 'SOLD',
        effective_status: 'ELIGIBLE',
        sale_type: 'Deed',
        sale_confidence: 'high',
        sold_date: new Date().toISOString(),
        price: 250000,
        // The fixture's price is an explicitly returned estimated home value.
        // Unmarked legacy BatchData prices remain intentionally ambiguous in
        // production because they may be sale consideration or listing price.
        provider_estimated_value_observed: true,
        provider_listing_status_categories_excluded: ['Active', 'Pending'],
        ...overrides
    };
}


function run(initialSet, soldDateFilter = 'all', routeConfigOverrides = {}) {
    return applyRouteFilters({
        initialSet,
        drawnPolygon: null,
        zipCodeFilter: '',
        territoryZipCodes: [],
        soldDateFilter,
        routeConfig: { ...routeConfig, ...routeConfigOverrides },
        lastPullMode: null,
        logsByAddress: new Map(),
        assignedHashes: new Set()
    });
}


function runInPolygon(initialSet, drawnPolygon) {
    return applyRouteFilters({
        initialSet,
        drawnPolygon,
        zipCodeFilter: '',
        territoryZipCodes: [],
        soldDateFilter: 'all',
        routeConfig,
        lastPullMode: null,
        logsByAddress: new Map(),
        assignedHashes: new Set()
    });
}


test('promotes deed-matched heuristic MLS candidates before the hard MLS gate', () => {
    const hash = 'shared-address';
    const result = run([
        property({ id: 'deed', address_hash: hash, sale_type: 'deed', original_status: 'SOLD', sale_confidence: 'high' }),
        property({ id: 'mls', address_hash: hash, sale_type: 'MLS', original_status: 'HEURISTIC_SOLD', sale_confidence: 'low' })
    ]);
    assert.equal(result.error, null);
    const promoted = result.workingSet.find(candidate => candidate.id === 'mls');
    assert.ok(promoted);
    assert.equal(promoted.original_status, 'DEED_CONFIRMED');
    assert.equal(promoted.sale_confidence, 'verified');
});


test('preserves the encoded calendar day for UTC-midnight provider timestamps', () => {
    assert.equal(routeCalendarDate('2026-07-02T00:00:00.000Z'), '2026-07-02');
});


test('uses the same small polygon-edge tolerance as backend ingestion', () => {
    const polygon = [
        { lat: 33.44, lng: -112.08 },
        { lat: 33.44, lng: -112.06 },
        { lat: 33.46, lng: -112.06 },
        { lat: 33.46, lng: -112.08 }
    ];
    const nearEdge = runInPolygon([
        property({ lat: 33.45, lng: -112.080004 })
    ], polygon);
    const outsideTolerance = runInPolygon([
        property({ lat: 33.45, lng: -112.08002 })
    ], polygon);
    assert.equal(nearEdge.workingSet.length, 1);
    assert.equal(outsideTolerance.workingSet.length, 0);
});


test('includes a sale on the exact selected-window cutoff day', () => {
    const cutoffDate = localDateDaysAgo(7);
    const result = run([
        property({ sold_date: `${cutoffDate}T00:00:00.000Z` })
    ], 0.25);
    assert.equal(result.error, null);
    assert.equal(result.workingSet.length, 1);
});


test('uses the original FetchJob cutoff when an exact-job route is built later', () => {
    const originalCutoff = localDateDaysAgo(8);
    const result = run([
        property({ sold_date: `${originalCutoff}T00:00:00.000Z` })
    ], 0.25, { soldMinDateOverride: originalCutoff });
    assert.equal(result.error, null);
    assert.equal(result.workingSet.length, 1);
});


test('rechecks the selected sale window for BatchData records at the final route boundary', () => {
    const result = run([
        property({
            data_source: 'batchdata',
            original_status: 'BATCHDATA_CONFIRMED',
            sale_type: 'BatchData',
            sale_confidence: 'verified',
            sold_date: `${localDateDaysAgo(15)}T00:00:00.000Z`
        })
    ], 0.25);
    assert.equal(result.workingSet.length, 0);
});


test('accepts missing exact dates only when BatchData predicate provenance proves the selected window', () => {
    const providerWindowCandidate = property({
        data_source: 'batchdata',
        original_status: 'BATCHDATA_CONFIRMED',
        sale_type: 'BatchData',
        sale_confidence: 'verified',
        sold_date: undefined,
        provider_recent_sale_min_date: localDateDaysAgo(14),
        provider_recent_sale_max_date: localDateDaysAgo(0),
        provider_recent_sale_sources: ['intel', 'sale']
    });
    const sameWindow = run([providerWindowCandidate], 0.5);
    const narrowerWindow = run([providerWindowCandidate], 0.25);
    const missingSource = run([{ ...providerWindowCandidate, provider_recent_sale_sources: [] }], 0.5);

    assert.equal(sameWindow.workingSet.length, 1);
    assert.equal(narrowerWindow.workingSet.length, 0);
    assert.equal(missingSource.workingSet.length, 0);
});


test('does not let a stale legacy sold date override the current lean Search window proof', () => {
    const result = run([
        property({
            data_source: 'rentcast',
            workspace_status: 'BATCHDATA_CONFIRMED',
            sold_date: `${localDateDaysAgo(365)}T00:00:00.000Z`,
            provider_exact_sale_date_observed: false,
            provider_recent_sale_min_date: localDateDaysAgo(14),
            provider_recent_sale_max_date: localDateDaysAgo(0),
            provider_recent_sale_sources: ['intel'],
            provider_estimated_value_observed: false,
            provider_estimated_value_min: 100000
        })
    ], 0.5);
    assert.equal(result.workingSet.length, 1);
});


test('does not let a BatchData source label bypass rejection or workspace deactivation', () => {
    const rejected = run([
        property({
            data_source: 'batchdata',
            original_status: 'REJECTED',
            sale_type: 'BatchData',
            sale_confidence: 'REJECTED'
        })
    ]);
    const deactivated = run([
        property({
            data_source: 'batchdata',
            original_status: 'BATCHDATA_CONFIRMED',
            sale_type: 'BatchData',
            sale_confidence: 'verified',
            route_active: false
        })
    ]);
    assert.equal(rejected.workingSet.length, 0);
    assert.equal(deactivated.workingSet.length, 0);
});


test('requires auditable current-listing exclusion for lean BatchData route candidates', () => {
    const safeByPredicate = run([
        property({ data_source: 'batchdata', original_status: 'BATCHDATA_CONFIRMED' })
    ]);
    const missingEvidence = run([
        property({
            data_source: 'batchdata',
            original_status: 'BATCHDATA_CONFIRMED',
            provider_listing_status_categories_excluded: []
        })
    ]);
    const explicitlyActive = run([
        property({
            data_source: 'batchdata',
            original_status: 'BATCHDATA_CONFIRMED',
            listing_status: 'Active'
        })
    ]);
    assert.equal(safeByPredicate.workingSet.length, 1);
    assert.equal(missingEvidence.workingSet.length, 0);
    assert.equal(explicitlyActive.workingSet.length, 0);
});


test('preserves Intel-only BatchData provenance when the global row came from MLS', () => {
    const result = run([
        property({
            data_source: 'rentcast',
            original_status: 'HEURISTIC_SOLD',
            workspace_status: 'BATCHDATA_CANDIDATE',
            sale_type: 'MLS',
            sale_confidence: 'low'
        })
    ]);
    assert.equal(result.workingSet.length, 1);
});


test('ignores stale global listing status only when the current Basic payload omitted status', () => {
    const currentPredicateProof = run([
        property({
            data_source: 'batchdata',
            original_status: 'BATCHDATA_CONFIRMED',
            listing_status: 'Active',
            provider_listing_status_observed: false
        })
    ]);
    const currentActiveStatus = run([
        property({
            data_source: 'batchdata',
            original_status: 'BATCHDATA_CONFIRMED',
            listing_status: 'Active',
            provider_listing_status_observed: true
        })
    ]);
    assert.equal(currentPredicateProof.workingSet.length, 1);
    assert.equal(currentActiveStatus.workingSet.length, 0);
});


test('uses workspace status before legacy global property status', () => {
    const workspaceActive = run([
        property({
            data_source: 'batchdata',
            original_status: 'REJECTED',
            status: 'Active',
            workspace_status: 'BATCHDATA_CONFIRMED',
            sale_type: 'BatchData',
            sale_confidence: 'REJECTED'
        })
    ]);
    const workspaceRejected = run([
        property({
            original_status: 'SOLD',
            workspace_status: 'REJECTED',
            sale_confidence: 'high'
        })
    ]);
    assert.equal(workspaceActive.workingSet.length, 1);
    assert.equal(workspaceRejected.workingSet.length, 0);
});


test('explicit unresolved re-inclusion bypasses assigned and previously-knocked gates', () => {
    const candidate = property({ address_hash: 'follow-up-hash', effective_status: 'NO_ANSWER' });
    const logsByAddress = new Map([
        ['follow-up-hash', [{ address_hash: 'follow-up-hash', parsed_status: 'NO_ANSWER', created_date: new Date().toISOString() }]]
    ]);
    const result = applyRouteFilters({
        initialSet: [candidate],
        drawnPolygon: null,
        zipCodeFilter: '',
        territoryZipCodes: [],
        soldDateFilter: 'all',
        routeConfig: {
            ...routeConfig,
            excludeAssigned: true,
            excludePreviouslyKnocked: true,
            reincludedHashes: new Set(['follow-up-hash'])
        },
        lastPullMode: null,
        logsByAddress,
        assignedHashes: new Set(['follow-up-hash'])
    });
    assert.equal(result.error, null);
    assert.equal(result.workingSet.length, 1);
});


test('includes a verified MLS sale on the exact 30-day cutoff day', () => {
    const cutoffDate = localDateDaysAgo(30);
    const result = run([
        property({
            sold_date: `${cutoffDate}T00:00:00.000Z`,
            sale_type: 'MLS',
            original_status: 'DEED_CONFIRMED',
            sale_confidence: 'verified'
        })
    ]);
    assert.equal(result.error, null);
    assert.equal(result.workingSet.length, 1);
});


test('requires explicit SFR evidence at the final route gate', () => {
    for (const propertyType of ['', 'Residential', 'Unknown Residential Type (Unverified)', 'R1', 'Townhome', 'Semi-Detached Residential', 'Single Family Attached', 'Mobile Home', 'Manufactured Housing', 'Mixed-Use Residential']) {
        const result = run([property({ property_type: propertyType })]);
        assert.equal(result.workingSet.length, 0, `${propertyType || '<blank>'} should not pass the SFR gate`);
    }
});


test('accepts canonical and provider-style explicit SFR labels at the final route gate', () => {
    for (const propertyType of ['Single Family', 'SingleFamily', 'SingleFamilyResidence', 'Detached Residential', 'Residential Detached Dwelling', 'ResidentialDetachedDwelling']) {
        const result = run([property({ property_type: propertyType })]);
        assert.equal(result.error, null, `${propertyType} should pass the SFR gate`);
        assert.equal(result.workingSet.length, 1);
    }
});


test('always enforces the $100k estimated-home-value floor', () => {
    const result = run([
        property({ id: 'below', address_hash: 'below', price: 99999 }),
        property({ id: 'at-floor', address_hash: 'at-floor', price: 100000 }),
        property({ id: 'above', address_hash: 'above', price: 175000 })
    ]);
    assert.deepEqual(result.workingSet.map(candidate => candidate.id), ['at-floor', 'above']);
});


test('preserves a higher user-entered estimated-home-value minimum', () => {
    const result = run([
        property({ id: 'default-only', address_hash: 'default-only', price: 149999 }),
        property({ id: 'higher-floor', address_hash: 'higher-floor', price: 150000 })
    ], 'all', { minPrice: 150000 });
    assert.deepEqual(result.workingSet.map(candidate => candidate.id), ['higher-floor']);
});


test('does not use sale consideration or listing price as estimated-home-value evidence', () => {
    const result = run([
        property({
            price: undefined,
            sale_price: 450000,
            listing: { price: 500000 },
            raw_metadata: { price: 600000 }
        })
    ]);
    assert.equal(result.workingSet.length, 0);
});


test('accepts an auditable provider valuation floor only when it proves the effective route bound', () => {
    const defaultFloor = run([
        property({ price: undefined, provider_estimated_value_min: 100000 })
    ]);
    const insufficientForHigherUserMinimum = run([
        property({ price: undefined, provider_estimated_value_min: 100000 })
    ], 'all', { minPrice: 150000 });
    const sufficientForHigherUserMinimum = run([
        property({ price: undefined, provider_estimated_value_min: 150000 })
    ], 'all', { minPrice: 150000 });

    assert.equal(defaultFloor.workingSet.length, 1);
    assert.equal(insufficientForHigherUserMinimum.workingSet.length, 0);
    assert.equal(sufficientForHigherUserMinimum.workingSet.length, 1);
});


test('known estimated value wins over contradictory provider-minimum provenance', () => {
    const result = run([
        property({ price: 90000, provider_estimated_value_min: 100000 })
    ]);
    assert.equal(result.workingSet.length, 0);
});


test('ignores a legacy canonical price when the current Basic response observed no estimate', () => {
    const result = run([
        property({
            price: 75000,
            provider_estimated_value_observed: false,
            provider_estimated_value_min: 100000
        })
    ]);
    assert.equal(result.workingSet.length, 1);
});


test('does not treat an unmarked legacy BatchData price as estimated home value', () => {
    const result = run([
        property({
            data_source: 'batchdata',
            original_status: 'BATCHDATA_CONFIRMED',
            price: 250000,
            provider_estimated_value_observed: undefined,
            provider_estimated_value_min: undefined
        })
    ]);
    assert.equal(result.workingSet.length, 0);
});


test('requires provider maximum provenance when an exact value is missing and a maximum is configured', () => {
    const missingMaximumProof = run([
        property({ price: undefined, provider_estimated_value_min: 100000 })
    ], 'all', { maxPrice: 300000 });
    const boundedByProvider = run([
        property({
            price: undefined,
            provider_estimated_value_min: 100000,
            provider_estimated_value_max: 300000
        })
    ], 'all', { maxPrice: 300000 });

    assert.equal(missingMaximumProof.workingSet.length, 0);
    assert.equal(boundedByProvider.workingSet.length, 1);
});
