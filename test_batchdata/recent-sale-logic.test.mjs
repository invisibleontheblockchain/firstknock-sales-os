import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BATCHDATA_PAGE_LIMIT,
    BATCHDATA_SEARCH_DATASETS,
    DEFAULT_PRECISION_MIN_HOME_VALUE,
    applyBatchDataQualificationFilters,
    applyRecentSaleSearchFilter,
    clampBatchDataTake,
    closedDayWindow,
    hasAddressUnitMarker,
    hasExplicitSingleFamilyMetadata,
    isBlockedListingStatus,
    isPurchaseMortgage,
    isSaleDateWithinWindow,
    qualifiesEstimatedValueRange,
    resolveProviderRecentSaleProof,
    resolveSingleFamilyMetadata,
    selectRecentSaleEvidence,
    unwrapBatchDataProperty
} from '../base44/functions/processFetchChunk/recentSaleLogic.js';


test('uses documented sale.lastSaleDate as the provider search filter', () => {
    const criteria = { address: { city: { equals: 'Austin' } } };
    applyRecentSaleSearchFilter(criteria, '2026-04-10');
    assert.deepEqual(criteria.sale, { lastSaleDate: { minDate: '2026-04-10' } });
    assert.equal(criteria.intel, undefined);
});

test('supports independent Intel and Sale discovery predicates without intersecting them', () => {
    const intelCriteria = {};
    const saleCriteria = {};
    applyRecentSaleSearchFilter(intelCriteria, '2026-07-01', 'intel');
    applyRecentSaleSearchFilter(saleCriteria, '2026-07-01', 'sale');
    assert.deepEqual(intelCriteria, { intel: { lastSoldDate: { minDate: '2026-07-01' } } });
    assert.deepEqual(saleCriteria, { sale: { lastSaleDate: { minDate: '2026-07-01' } } });
    assert.throws(() => applyRecentSaleSearchFilter({}, '2026-07-01', 'unknown'), /Unsupported/);
    const bounded = {};
    applyRecentSaleSearchFilter(bounded, '2026-07-01', 'intel', '2026-07-08');
    assert.deepEqual(bounded.intel, { lastSoldDate: { minDate: '2026-07-01', maxDate: '2026-07-08' } });
});

test('maps one-day and fourteen-day products to completed calendar days only', () => {
    assert.deepEqual(closedDayWindow('2026-07-09', 1), {
        minDate: '2026-07-08',
        maxDate: '2026-07-08'
    });
    assert.deepEqual(closedDayWindow('2026-07-09', 14), {
        minDate: '2026-06-25',
        maxDate: '2026-07-08'
    });
});

test('maps documented SFR, estimated-value, and listing predicates independently', () => {
    const criteria = {};
    applyBatchDataQualificationFilters(criteria, {
        minEstimatedValue: 125000,
        maxEstimatedValue: 600000
    });
    assert.deepEqual(criteria.general, { standardizedLandUseCode: { equals: 'R2' } });
    assert.deepEqual(criteria.valuation, { estimatedValue: { min: 125000, max: 600000 } });
    assert.deepEqual(criteria.listing, { statusCategory: { notInList: ['Active', 'Pending'] } });
    assert.deepEqual(BATCHDATA_SEARCH_DATASETS, ['basic']);
});

test('keeps the $100k estimated-home-value floor and accepts explicit provider range proof', () => {
    assert.equal(DEFAULT_PRECISION_MIN_HOME_VALUE, 100000);
    assert.equal(qualifiesEstimatedValueRange(99999), false);
    assert.equal(qualifiesEstimatedValueRange(100000), true);
    assert.equal(qualifiesEstimatedValueRange(null), false);
    assert.equal(qualifiesEstimatedValueRange(null, { providerEstimatedValueMin: 100000 }), true);
    assert.equal(qualifiesEstimatedValueRange(90000, { providerEstimatedValueMin: 100000 }), false);
    assert.equal(qualifiesEstimatedValueRange(null, {
        minEstimatedValue: 100000,
        maxEstimatedValue: 400000,
        providerEstimatedValueMin: 100000,
        providerEstimatedValueMax: 400000
    }), true);
    assert.equal(qualifiesEstimatedValueRange(null, {
        minEstimatedValue: 100000,
        maxEstimatedValue: 400000,
        providerEstimatedValueMin: 100000
    }), false);
});

test('does not let an older fallback date erase an accepted recent-sale predicate', () => {
    assert.deepEqual(resolveProviderRecentSaleProof({
        matchedSources: ['intel'],
        returnedSaleDateSource: 'openLien.mortgages[].recordingDate',
        hasReturnedSaleDate: true,
        returnedSaleDateInWindow: false,
        providerWindowProven: true
    }), {
        accepted: true,
        acceptedSources: ['intel'],
        conflictingSources: []
    });

    assert.deepEqual(resolveProviderRecentSaleProof({
        matchedSources: ['intel'],
        returnedSaleDateSource: 'intel.lastSoldDate',
        hasReturnedSaleDate: true,
        returnedSaleDateInWindow: false,
        providerWindowProven: true
    }), {
        accepted: false,
        acceptedSources: [],
        conflictingSources: ['intel']
    });

    assert.deepEqual(resolveProviderRecentSaleProof({
        matchedSources: ['intel', 'sale'],
        returnedSaleDateSource: 'intel.lastSoldDate',
        hasReturnedSaleDate: true,
        returnedSaleDateInWindow: false,
        providerWindowProven: true
    }), {
        accepted: true,
        acceptedSources: ['sale'],
        conflictingSources: ['intel']
    });
});

test('never sends a BatchData page larger than the live 100-record contract', () => {
    assert.equal(BATCHDATA_PAGE_LIMIT, 100);
    assert.equal(clampBatchDataTake(500), 100);
    assert.equal(clampBatchDataTake(100), 100);
    assert.equal(clampBatchDataTake(0), 0);
});

test('authoritative sale evidence wins over a newer refinance recording', () => {
    const evidence = selectRecentSaleEvidence({
        intel: { lastSoldDate: '2026-04-12T00:00:00.000Z' },
        quickLists: { recentlySold: true },
        openLien: {
            mortgages: [{
                recordingDate: '2026-06-30T00:00:00.000Z',
                transactionType: 'Refi loans and 2nd trust deeds',
                transactionTypeCode: 'G'
            }]
        }
    });
    assert.equal(evidence.saleDate, '2026-04-12');
    assert.equal(evidence.saleDateSource, 'intel.lastSoldDate');
    assert.equal(evidence.saleDateConfidence, 'high');
});

test('accepts a recent purchase mortgage only as medium-confidence fallback evidence', () => {
    const evidence = selectRecentSaleEvidence({
        quickLists: { recentlySold: true },
        sale: { lastSale: { mortgages: [{ recordingDate: '2026-06-03T00:00:00.000Z' }] } },
        openLien: {
            mortgages: [{
                recordingDate: '2026-06-03T00:00:00.000Z',
                transactionType: 'Arms-length residential transactions (purchase/resales)',
                transactionTypeCode: 'B'
            }]
        }
    });
    assert.equal(evidence.saleDate, '2026-06-03');
    assert.equal(evidence.saleDateConfidence, 'medium');
    assert.equal(evidence.purchaseMortgageEvidence, true);
});

test('uses a newer qualified purchase when an authoritative sale field is stale', () => {
    const evidence = selectRecentSaleEvidence({
        intel: { lastSoldDate: '2024-01-01' },
        quickLists: { recentlySold: true },
        openLien: {
            mortgages: [{
                recordingDate: '2026-06-03',
                transactionType: 'Purchase resale',
                transactionTypeCode: 'B'
            }]
        }
    });
    assert.equal(evidence.saleDate, '2026-06-03');
    assert.equal(evidence.saleDateConfidence, 'medium');
    assert.equal(evidence.purchaseMortgageEvidence, true);
});

test('rejects refinance-only and unqualified open-lien dates as sale evidence', () => {
    const property = {
        quickLists: { recentlySold: true },
        openLien: {
            firstLoanRecordingDate: '2026-06-20T00:00:00.000Z',
            mortgages: [{
                recordingDate: '2026-06-20T00:00:00.000Z',
                transactionType: 'Refi loans and 2nd trust deeds',
                transactionTypeCode: 'G'
            }]
        }
    };
    assert.equal(isPurchaseMortgage(property.openLien.mortgages[0]), false);
    assert.equal(selectRecentSaleEvidence(property).saleDate, null);
});

test('selects the newest qualified sale field instead of fixed field order', () => {
    const evidence = selectRecentSaleEvidence({
        intel: { lastSoldDate: '2025-12-01' },
        sale: { lastSaleDate: '2026-05-15' }
    });
    assert.equal(evidence.saleDate, '2026-05-15');
    assert.equal(evidence.saleDateSource, 'sale.lastSaleDate');
    assert.equal(evidence.saleDateConfidence, 'high');
});

test('does not treat generic transfers or quitclaim recordings as sales', () => {
    assert.equal(selectRecentSaleEvidence({
        intel: { lastTransferDate: '2026-06-01' }
    }).saleDate, null);
    assert.equal(selectRecentSaleEvidence({
        deedHistory: [{
            saleDate: '2026-06-01',
            recordingDate: '2026-06-03',
            deedType: 'Quit Claim Deed'
        }]
    }).saleDate, null);
});

test('accepts a deed event only when sale consideration or transaction evidence is present', () => {
    const evidence = selectRecentSaleEvidence({
        deedHistory: [{
            saleDate: '2026-06-01',
            recordingDate: '2026-06-03',
            deedType: 'Warranty Deed',
            consideration: 325000
        }]
    });
    assert.equal(evidence.saleDate, '2026-06-01');
    assert.equal(evidence.saleDateSource, 'deedHistory[0].saleDate');
    assert.equal(evidence.saleDateConfidence, 'high');
});

test('supports a qualified transaction-only sale shape without trusting generic transactions', () => {
    const evidence = selectRecentSaleEvidence({
        transaction: {
            saleDate: '2026-05-20',
            transactionType: 'Arms-length sale',
            salePrice: 275000
        }
    });
    assert.equal(evidence.saleDate, '2026-05-20');
    assert.equal(evidence.saleDateSource, 'transaction.saleDate');
    assert.equal(selectRecentSaleEvidence({
        transaction: { recordingDate: '2026-05-22', transactionType: 'Transfer' }
    }).saleDate, null);
});

test('does not let an empty sale object hide populated lastSale evidence', () => {
    const evidence = selectRecentSaleEvidence({
        sale: {},
        lastSale: {
            saleDate: '2026-06-18',
            transactionType: 'Arms-length sale',
            salePrice: 310000
        }
    });
    assert.equal(evidence.saleDate, '2026-06-18');
    assert.equal(evidence.saleDateSource, 'lastSale.saleDate');
});

test('falls back to a qualified recording date when a supplied sale date is malformed', () => {
    const evidence = selectRecentSaleEvidence({
        deedHistory: [{
            saleDate: 'not-a-date',
            recordingDate: '2026-06-21',
            deedType: 'Warranty Sale Deed',
            consideration: 285000
        }]
    });
    assert.equal(evidence.saleDate, '2026-06-21');
    assert.equal(evidence.saleDateSource, 'deedHistory[0].recordingDate');
});

test('rejects future sale dates and enforces both sides of the requested window', () => {
    const evidence = selectRecentSaleEvidence({
        intel: { lastSoldDate: '2026-06-20' },
        sale: { lastSaleDate: '2026-08-01' }
    }, { maxDate: '2026-07-09' });
    assert.equal(evidence.saleDate, '2026-06-20');
    assert.equal(isSaleDateWithinWindow('2026-06-20', '2026-04-10', '2026-07-09'), true);
    assert.equal(isSaleDateWithinWindow('2026-08-01', '2026-04-10', '2026-07-09'), false);
    assert.equal(isSaleDateWithinWindow('2026-01-01', '2026-04-10', '2026-07-09'), false);
});

test('requires explicit SFR metadata instead of accepting vague or unverified residential labels', () => {
    assert.equal(hasExplicitSingleFamilyMetadata('R2', null), true);
    assert.equal(hasExplicitSingleFamilyMetadata(null, 'Single Family Residential'), true);
    assert.equal(hasExplicitSingleFamilyMetadata(null, 'SingleFamily'), true);
    assert.equal(hasExplicitSingleFamilyMetadata(null, 'SingleFamilyResidence'), true);
    assert.equal(hasExplicitSingleFamilyMetadata(null, 'Detached Residential'), true);
    assert.equal(hasExplicitSingleFamilyMetadata(null, 'DetachedResidential'), true);
    assert.equal(hasExplicitSingleFamilyMetadata(null, 'Residential Detached Dwelling'), true);
    assert.equal(hasExplicitSingleFamilyMetadata(null, 'ResidentialDetachedDwelling'), true);
    assert.equal(hasExplicitSingleFamilyMetadata(null, 'Residential'), false);
    assert.equal(hasExplicitSingleFamilyMetadata(null, 'Single Family (Unverified)'), false);
    assert.equal(hasExplicitSingleFamilyMetadata(null, 'Semi-Detached Residential'), false);
    assert.equal(hasExplicitSingleFamilyMetadata(null, 'Single Family Attached'), false);
    assert.equal(hasExplicitSingleFamilyMetadata('R2', 'Condominium'), false);
    assert.equal(hasExplicitSingleFamilyMetadata('R2', 'Manufactured Home'), false);
    assert.equal(hasExplicitSingleFamilyMetadata('R2', 'Mixed-Use Residential'), false);
    assert.equal(hasExplicitSingleFamilyMetadata(null, 'Townhome'), false);
    assert.equal(hasAddressUnitMarker('123 Main St Unit 4'), true);
    assert.equal(hasAddressUnitMarker('123 Unit Circle Rd'), false);
    assert.equal(hasAddressUnitMarker('123 Main St Ste 200'), true);
    assert.equal(hasAddressUnitMarker('123 Main St Ste B'), true);
    assert.equal(hasAddressUnitMarker('123 Ste Genevieve Dr'), false);
    assert.equal(hasAddressUnitMarker('123 Main St'), false);
});

test('aggregates type candidates and canonicalizes vague R2 labels for stable routing', () => {
    const r2 = resolveSingleFamilyMetadata('R2', ['Residential']);
    assert.equal(r2.hasExplicitSingleFamilyEvidence, true);
    assert.equal(r2.propertyType, 'Single Family');
    assert.equal(hasExplicitSingleFamilyMetadata(null, r2.propertyType), true);

    const laterExplicitType = resolveSingleFamilyMetadata(null, ['Residential', 'SingleFamily']);
    assert.equal(laterExplicitType.hasExplicitSingleFamilyEvidence, true);
    assert.equal(laterExplicitType.propertyType, 'SingleFamily');

    const conflictingType = resolveSingleFamilyMetadata('R2', ['Residential', 'Townhome']);
    assert.equal(conflictingType.hasExplicitSingleFamilyEvidence, false);
    assert.equal(conflictingType.propertyType, 'Townhome');

    const manufacturedConflict = resolveSingleFamilyMetadata('R2', ['Residential', 'Manufactured Housing']);
    assert.equal(manufacturedConflict.hasExplicitSingleFamilyEvidence, false);
    assert.equal(manufacturedConflict.propertyType, 'Manufactured Housing');
});

test('unwraps the same nested BatchData property shapes used by diagnostics', () => {
    const property = { id: 'property-1' };
    assert.equal(unwrapBatchDataProperty({ property }), property);
    assert.equal(unwrapBatchDataProperty({ result: { property } }), property);
    assert.equal(unwrapBatchDataProperty({ results: { property } }), property);
    assert.equal(unwrapBatchDataProperty({ data: { property } }), property);
    assert.equal(unwrapBatchDataProperty({ response: { property } }), property);
});

test('blocks active and pending listings from recently-sold knocking routes', () => {
    assert.equal(isBlockedListingStatus('Active'), true);
    assert.equal(isBlockedListingStatus('For Sale'), true);
    assert.equal(isBlockedListingStatus('Contingent'), true);
    assert.equal(isBlockedListingStatus('Not For Sale'), false);
    assert.equal(isBlockedListingStatus('Not Currently For Sale'), false);
    assert.equal(isBlockedListingStatus('Pending'), true);
    assert.equal(isBlockedListingStatus('Inactive'), false);
    assert.equal(isBlockedListingStatus('Closed / Sold'), false);
    assert.equal(isBlockedListingStatus(''), false);
});
