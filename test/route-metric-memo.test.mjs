import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoizedRouteMetrics } from '../base44/shared/routeMetricMemo.js';

test('distance and duration cache exact directed object pairs independently', () => {
    const a = { id: 'a' }, b = { id: 'b' };
    let distanceCalls = 0, durationCalls = 0;
    const metrics = createMemoizedRouteMetrics({
        distanceBetween(left, right) { distanceCalls++; return left === a && right === b ? 12.345678901 : 87.654321098; },
        durationBetween(left, right) { durationCalls++; return left === a && right === b ? 123.45678901 : 987.65432109; },
    });
    assert.equal(metrics.distanceBetween(a, b), 12.345678901);
    assert.equal(metrics.durationBetween(a, b), 123.45678901);
    assert.equal(metrics.distanceBetween(b, a), 87.654321098);
    assert.equal(metrics.durationBetween(b, a), 987.65432109);
    for (let i = 0; i < 100; i++) {
        assert.equal(metrics.distanceBetween(a, b), 12.345678901);
        assert.equal(metrics.durationBetween(a, b), 123.45678901);
        assert.equal(metrics.distanceBetween(b, a), 87.654321098);
        assert.equal(metrics.durationBetween(b, a), 987.65432109);
    }
    assert.equal(distanceCalls, 2);
    assert.equal(durationCalls, 2);
});

test('missing and non-finite results remain unchanged and are cached', () => {
    const a = {}, b = {};
    for (const value of [Infinity, -Infinity, NaN, null, undefined, 0, -1]) {
        let calls = 0;
        const { distanceBetween } = createMemoizedRouteMetrics({ distanceBetween: () => { calls++; return value; } });
        assert.ok(Object.is(distanceBetween(a, b), value));
        assert.ok(Object.is(distanceBetween(a, b), value));
        assert.equal(calls, 1);
    }
});

test('anchors and duplicate coordinates keep their actual point-reference identity', () => {
    const anchor = { lat: 35, lng: -80 }, door = { lat: 35, lng: -80 }, clone = { ...door };
    let calls = 0;
    const { distanceBetween } = createMemoizedRouteMetrics({ distanceBetween: () => ++calls });
    assert.equal(distanceBetween(anchor, door), 1);
    assert.equal(distanceBetween(anchor, clone), 2);
    assert.equal(distanceBetween(door, anchor), 3);
    assert.equal(distanceBetween(anchor, door), 1);
    assert.equal(distanceBetween(anchor, clone), 2);
    assert.equal(calls, 3);
});

test('request caches are isolated even when point objects and metric functions are reused', () => {
    const a = {}, b = {};
    let calls = 0;
    const original = { distanceBetween: () => ++calls };
    const first = createMemoizedRouteMetrics(original), second = createMemoizedRouteMetrics(original);
    assert.equal(first.distanceBetween(a, b), 1);
    assert.equal(second.distanceBetween(a, b), 2);
    assert.equal(first.distanceBetween(a, b), 1);
    assert.equal(second.distanceBetween(a, b), 2);
    assert.notEqual(first.distanceBetween, original.distanceBetween);
    assert.equal(original.durationBetween, undefined);
});

test('missing/non-object arguments and extra arguments preserve original callable behavior without caching', () => {
    const a = {}, b = {};
    const seen = [];
    const { distanceBetween } = createMemoizedRouteMetrics({ distanceBetween(...args) { seen.push(args); return seen.length; } });
    const cases = [[], [a], [a, null], [undefined, b], [a, 0], ['point', b], [a, b, 7]];
    for (const args of cases) {
        const first = distanceBetween(...args), second = distanceBetween(...args);
        assert.equal(second, first + 1);
        assert.deepEqual(seen.at(-1), args);
    }
    assert.equal(seen.length, cases.length * 2);
});

test('receiver behavior and thrown errors are preserved', () => {
    const a = {}, b = {}, firstOwner = { value: 11 }, secondOwner = { value: 22 };
    let calls = 0;
    const { distanceBetween } = createMemoizedRouteMetrics({ distanceBetween() { calls++; return this.value; } });
    assert.equal(distanceBetween.call(firstOwner, a, b), 11);
    assert.equal(distanceBetween.call(firstOwner, a, b), 11);
    assert.equal(distanceBetween.call(secondOwner, a, b), 22);
    assert.equal(calls, 2);
    let attempts = 0;
    const failing = createMemoizedRouteMetrics({ durationBetween() { attempts++; throw new Error('unavailable'); } });
    assert.throws(() => failing.durationBetween(a, b), /unavailable/);
    assert.throws(() => failing.durationBetween(a, b), /unavailable/);
    assert.equal(attempts, 2);
});

test('optional metric functions and other request metadata are retained', () => {
    const counts = { aerial: 0 };
    const metrics = createMemoizedRouteMetrics({ distanceBetween: null, unresolved: 4, aerialEvaluationCounts: counts });
    assert.equal(metrics.distanceBetween, null);
    assert.equal(metrics.durationBetween, undefined);
    assert.equal(metrics.unresolved, 4);
    assert.equal(metrics.aerialEvaluationCounts, counts);
});

test('cached distance and duration replay the exact existing evaluation-counter deltas', () => {
    const a = { block: 'a', street: 'first' }, b = { block: 'a', street: 'first' };
    const c = { block: 'a', street: 'second' }, d = { block: 'b', street: 'second' };
    const make = () => {
        const intraBlockLegCount = { count: 0 }, aerialEvaluationCounts = { sameStreetBlock: 0, crossStreetSameUnit: 0 };
        let calls = 0;
        const metric = multiplier => (left, right) => {
            calls++;
            if (left.block === right.block) {
                intraBlockLegCount.count++;
                aerialEvaluationCounts[left.street === right.street ? 'sameStreetBlock' : 'crossStreetSameUnit']++;
            }
            return left.block === right.block ? multiplier : multiplier * 10;
        };
        return { distanceBetween: metric(1), durationBetween: metric(2), intraBlockLegCount, aerialEvaluationCounts,
            calls: () => calls };
    };
    const plain = make(), original = make();
    const memo = createMemoizedRouteMetrics(original, { evaluationCounters: [
        { target: original.intraBlockLegCount, key: 'count' },
        { target: original.aerialEvaluationCounts, key: 'sameStreetBlock' },
        { target: original.aerialEvaluationCounts, key: 'crossStreetSameUnit' },
    ] });
    for (let i = 0; i < 20; i++) for (const [left, right] of [[a, b], [a, c], [a, d]]) {
        assert.equal(memo.distanceBetween(left, right), plain.distanceBetween(left, right));
        assert.equal(memo.durationBetween(left, right), plain.durationBetween(left, right));
    }
    assert.deepEqual(original.intraBlockLegCount, plain.intraBlockLegCount);
    assert.deepEqual(original.aerialEvaluationCounts, plain.aerialEvaluationCounts);
    assert.deepEqual(original.intraBlockLegCount, { count: 80 });
    assert.deepEqual(original.aerialEvaluationCounts, { sameStreetBlock: 40, crossStreetSameUnit: 40 });
    assert.equal(original.calls(), 6);
    assert.equal(plain.calls(), 120);
    // Replaying a delta still works when an existing consumer resets a counter.
    original.intraBlockLegCount.count = 0;
    memo.distanceBetween(a, b);
    assert.equal(original.intraBlockLegCount.count, 1);
});

test('uncached calls and exceptions retain their original counter effects', () => {
    const count = { value: 0 }, a = {}, b = {};
    const metrics = createMemoizedRouteMetrics({
        distanceBetween() { count.value++; return null; },
        durationBetween() { count.value++; throw new Error('unavailable'); },
    }, { evaluationCounters: [{ target: count, key: 'value' }] });
    assert.equal(metrics.distanceBetween(a, b), null);
    assert.equal(metrics.distanceBetween(a, b), null);
    assert.equal(count.value, 2);
    metrics.distanceBetween(null, b);
    metrics.distanceBetween(null, b);
    assert.equal(count.value, 4);
    assert.throws(() => metrics.durationBetween(a, b), /unavailable/);
    assert.throws(() => metrics.durationBetween(a, b), /unavailable/);
    assert.equal(count.value, 6);
});
