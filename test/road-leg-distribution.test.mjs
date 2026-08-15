// The distribution is a description of a measured drive. It must never invent a
// number, and hotspot selection must rank purely on measured length.

import assert from 'node:assert/strict';
import test from 'node:test';

import { selectWorstLegIndexes, summarizeLegMiles } from '../base44/shared/roadLegDistribution.js';

test('percentiles and threshold counts describe the measured legs', () => {
    const legs = Array.from({ length: 100 }, (_, index) => index + 1);
    const summary = summarizeLegMiles(legs);
    assert.equal(summary.leg_count, 100);
    assert.equal(summary.p50_miles, 50);
    assert.equal(summary.p75_miles, 75);
    assert.equal(summary.p90_miles, 90);
    assert.equal(summary.p95_miles, 95);
    assert.equal(summary.p99_miles, 99);
    assert.equal(summary.longest_miles, 100);
    assert.equal(summary.legs_over_1_mi, 99);
    assert.equal(summary.legs_over_2_mi, 98);
    assert.equal(summary.legs_over_5_mi, 95);
    assert.equal(summary.top_10_longest_miles, 955);
    assert.deepEqual(summary.top_10_longest, [100, 99, 98, 97, 96, 95, 94, 93, 92, 91]);
});

test('the summary total equals the measured total', () => {
    const legs = [0.1, 0.25, 3.5, 0.4, 1.2];
    const summary = summarizeLegMiles(legs);
    assert.equal(summary.total_miles, 5.45);
    assert.equal(summary.mean_miles, 1.09);
});

test('no legs means no summary rather than a fabricated zero', () => {
    assert.equal(summarizeLegMiles([]), null);
    assert.equal(summarizeLegMiles(null), null);
});

test('unmeasurable legs are excluded, never counted as short', () => {
    const summary = summarizeLegMiles([1, NaN, 3, undefined]);
    assert.equal(summary.leg_count, 2);
    assert.equal(summary.total_miles, 4);
});

test('hotspot selection ranks by measured length, worst first', () => {
    const legs = [0.1, 4.2, 0.2, 9.9, 0.3, 1.1];
    assert.deepEqual(selectWorstLegIndexes(legs, { fraction: 1, maxCount: 3 }), [3, 1, 5]);
});

test('short legs are never selected — a repair there cannot pay for its request', () => {
    const legs = [0.05, 0.1, 0.2];
    assert.deepEqual(selectWorstLegIndexes(legs, { fraction: 1, maxCount: 10, minMiles: 0.25 }), []);
});

test('selection is bounded by both the fraction and the hard ceiling', () => {
    const legs = Array.from({ length: 1000 }, (_, index) => 1 + index * 0.01);
    assert.equal(selectWorstLegIndexes(legs, { fraction: 0.08, maxCount: 10 }).length, 10);
    assert.equal(selectWorstLegIndexes(legs, { fraction: 0.002, maxCount: 10 }).length, 2);
});