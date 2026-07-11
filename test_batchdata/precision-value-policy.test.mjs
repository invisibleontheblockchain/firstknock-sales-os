import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_PRECISION_MIN_HOME_VALUE,
    maxRecallSearchRecordCeiling,
    normalizePrecisionHomeValueRange,
    priorRouteMayShareCurrentSaleEvent
} from '../base44/functions/startBatchDataPull/valuePolicy.js';


test('defaults omitted, blank, zero, and lower minimums to the $100k Precision floor', () => {
    for (const input of [undefined, null, '', 0, 50000, '99999']) {
        const result = normalizePrecisionHomeValueRange(input, null);
        assert.equal(result.minimum, DEFAULT_PRECISION_MIN_HOME_VALUE);
        assert.equal(result.valid, true);
    }
});

test('reports the implemented dual-source review ceiling instead of only requested stops', () => {
    assert.deepEqual(maxRecallSearchRecordCeiling(50), {
        dateSources: 2,
        maxReviewedPerSource: 2500,
        countProbeRecords: 0,
        totalRecordCeiling: 5000
    });
    assert.deepEqual(maxRecallSearchRecordCeiling(1000), {
        dateSources: 2,
        maxReviewedPerSource: 5000,
        countProbeRecords: 2,
        totalRecordCeiling: 10002
    });
});

test('releases a prior-route address when that route predates the entire current sale window', () => {
    assert.equal(priorRouteMayShareCurrentSaleEvent('2026-06-20', '2026-06-25'), false);
    assert.equal(priorRouteMayShareCurrentSaleEvent('2026-06-25', '2026-06-25'), true);
    assert.equal(priorRouteMayShareCurrentSaleEvent(null, '2026-06-25'), true);
});


test('preserves a user-entered minimum above the Precision floor', () => {
    const result = normalizePrecisionHomeValueRange('250000', '500000');
    assert.deepEqual(result, {
        minimum: 250000,
        maximum: 500000,
        valid: true
    });
});


test('rejects a maximum below the effective minimum', () => {
    assert.equal(normalizePrecisionHomeValueRange(null, 90000).valid, false);
    assert.equal(normalizePrecisionHomeValueRange(250000, 200000).valid, false);
});
