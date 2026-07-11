import test from 'node:test';
import assert from 'node:assert/strict';

import {
    allowsAssignedRouteForCurrentJob,
    planPropertyMerge,
    protectsAssignedRouteFetchJob
} from '../base44/functions/processFetchChunk/propertyMergeLogic.js';

function existing(overrides = {}) {
    return {
        sold_date: '2026-06-01T00:00:00.000Z',
        sale_confidence: 'verified',
        original_status: 'BATCHDATA_CONFIRMED',
        data_source: 'legacy_source',
        sale_type: 'Legacy',
        property_type: 'Single Family',
        ...overrides
    };
}

function incoming(overrides = {}) {
    return {
        sale_confidence: 'medium',
        original_status: 'BATCHDATA_CANDIDATE',
        data_source: 'batchdata',
        sale_type: 'BatchData',
        property_type: 'Single Family',
        ...overrides
    };
}

test('assigned-route pointer protection follows the explicit include-assigned policy', () => {
    assert.equal(protectsAssignedRouteFetchJob(undefined), true);
    assert.equal(protectsAssignedRouteFetchJob({ excludeAssigned: true }), true);
    assert.equal(protectsAssignedRouteFetchJob({ excludeAssigned: false }), false);
    assert.equal(allowsAssignedRouteForCurrentJob({ excludeAssigned: false }, {}, 'A|1'), true);
    assert.equal(allowsAssignedRouteForCurrentJob({ excludeAssigned: true }, {}, 'A|1'), false);
    assert.equal(allowsAssignedRouteForCurrentJob(
        { excludeAssigned: true },
        { unresolved_followup_hashes_included: ['A|1'] },
        'A|1'
    ), true);
    assert.equal(allowsAssignedRouteForCurrentJob(
        { excludeAssigned: true },
        { event_released_prior_route_hashes: ['A|1'] },
        'A|1'
    ), true);
});

test('a newer sale replaces the complete event bundle even at lower confidence', () => {
    const result = planPropertyMerge({
        existing: existing(),
        incoming: incoming(),
        soldDate: '2026-07-08T00:00:00.000Z',
        existingExplicitSfr: true,
        incomingExplicitSfr: true
    });

    assert.equal(result.shouldUpdate, true);
    assert.equal(result.replaceSaleEvent, true);
    assert.equal(result.replaceOwnershipEvent, true);
    assert.equal(result.protectedSaleConfidence, 'medium');
    assert.equal(result.protectedDataSource, 'batchdata');
    assert.equal(result.protectedSaleType, 'BatchData');
    assert.equal(result.protectedOriginalStatus, 'BATCHDATA_CANDIDATE');
    assert.equal(result.soldDateForUpdate, '2026-07-08T00:00:00.000Z');
});

test('an older record can fill missing metadata without overwriting the current event', () => {
    const result = planPropertyMerge({
        existing: existing({ beds: null, price: 250000 }),
        incoming: incoming({ provider_recent_sale_window_proven: true, beds: 4, price: 300000 }),
        soldDate: '2026-05-01T00:00:00.000Z',
        existingExplicitSfr: true,
        incomingExplicitSfr: true
    });

    assert.equal(result.shouldUpdate, true);
    assert.equal(result.replaceSaleEvent, false);
    assert.equal(result.protectedSaleConfidence, 'verified');
    assert.equal(result.protectedDataSource, 'legacy_source');
    assert.equal(result.soldDateForUpdate, null);
});

test('job-scoped provider proof alone does not churn the canonical row', () => {
    const result = planPropertyMerge({
        existing: existing({ beds: 4, price: 250000 }),
        incoming: incoming({
            provider_recent_sale_window_proven: true,
            metadata_completeness: { provider_recent_sale_min_date: '2026-05-01' },
            beds: 4,
            price: 300000
        }),
        soldDate: null,
        existingExplicitSfr: true,
        incomingExplicitSfr: true
    });

    assert.equal(result.replaceSaleEvent, false);
    assert.equal(result.hasNewMetadata, false);
    assert.equal(result.shouldUpdate, false);
});

test('lean provider proof replaces a canonical event proven older than the current window', () => {
    const result = planPropertyMerge({
        existing: existing({ sold_date: '2026-05-01T00:00:00.000Z', owner_full_name: 'Prior Owner' }),
        incoming: incoming({
            owner_full_name: null,
            provider_recent_sale_window_proven: true,
            metadata_completeness: { provider_recent_sale_min_date: '2026-07-01' }
        }),
        soldDate: null,
        existingExplicitSfr: true,
        incomingExplicitSfr: true
    });

    assert.equal(result.providerProvesNewerEvent, true);
    assert.equal(result.replaceSaleEvent, true);
    assert.equal(result.replaceOwnershipEvent, true);
    assert.equal(result.soldDateForUpdate, null);
});

test('stronger evidence for the same sale replaces the event bundle', () => {
    const result = planPropertyMerge({
        existing: existing({ sale_confidence: 'medium' }),
        incoming: incoming({ sale_confidence: 'verified' }),
        soldDate: '2026-06-01T00:00:00.000Z',
        existingExplicitSfr: true,
        incomingExplicitSfr: true
    });

    assert.equal(result.replaceSaleEvent, true);
    assert.equal(result.replaceOwnershipEvent, false);
    assert.equal(result.protectedSaleConfidence, 'verified');
});

test('a newer ownership event clears a prior owner when the provider omits the new owner', () => {
    const result = planPropertyMerge({
        existing: existing({ owner_full_name: 'Prior Owner' }),
        incoming: incoming({ owner_full_name: null }),
        soldDate: '2026-07-08T00:00:00.000Z',
        existingExplicitSfr: true,
        incomingExplicitSfr: true
    });

    assert.equal(result.replaceOwnershipEvent, true);
    assert.equal(result.shouldUpdate, true);
});

test('replacing a rejected event can intentionally clear its stale sold date', () => {
    const result = planPropertyMerge({
        existing: existing({ original_status: 'REJECTED' }),
        incoming: incoming({ provider_recent_sale_window_proven: true }),
        soldDate: null,
        existingExplicitSfr: true,
        incomingExplicitSfr: true
    });

    assert.equal(result.replaceSaleEvent, true);
    assert.equal(result.replaceOwnershipEvent, true);
    assert.equal(result.soldDateForUpdate, null);
    assert.equal(result.protectedOriginalStatus, 'BATCHDATA_CANDIDATE');
});

test('single-family classification improves but never regresses', () => {
    const improvement = planPropertyMerge({
        existing: existing({ property_type: 'Unknown' }),
        incoming: incoming({ property_type: 'Single Family' }),
        soldDate: null,
        existingExplicitSfr: false,
        incomingExplicitSfr: true
    });
    assert.equal(improvement.classificationImproves, true);
    assert.equal(improvement.shouldUpdate, true);
    assert.equal(improvement.protectedPropertyType, 'Single Family');

    const protectedType = planPropertyMerge({
        existing: existing({ property_type: 'Single Family' }),
        incoming: incoming({ property_type: 'Unknown' }),
        soldDate: null,
        existingExplicitSfr: true,
        incomingExplicitSfr: false
    });
    assert.equal(protectedType.protectedPropertyType, 'Single Family');
});
