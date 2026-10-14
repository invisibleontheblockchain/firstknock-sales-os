import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { buildDrivingAreaDoorCandidates, MAX_DRIVING_AREA_DOOR_SEARCH_STOPS } from '../base44/shared/drivingAreaDoorSearch.js';

const door = position => ({ id: `door-${position}`, position, street_name: `Branch ${Math.floor(position / 4)}` });
const lineContext = () => ({
    optimizationCostBetween: (a, b) => b.position >= a.position ? b.position - a.position : (a.position - b.position) * 7,
    distanceBetween: (a, b) => Math.abs(b.position - a.position) / 100,
});
const identity = stop => stop.id || stop.address_hash;
const measured = (order, context, start, end) => {
    const path = [start, ...order, end].filter(Boolean);
    return path.slice(1).reduce((cost, stop, i) => ({ seconds: cost.seconds + context.optimizationCostBetween(path[i], stop),
        miles: cost.miles + context.distanceBetween(path[i], stop) }), { seconds: 0, miles: 0 });
};
const shuffled = count => {
    const items = Array.from({ length: count }, (_, i) => door(i + 1));
    return [...items.filter((_, i) => i % 3 === 0), ...items.filter((_, i) => i % 3 === 2).reverse(), ...items.filter((_, i) => i % 3 === 1)];
};

test('bounded area search removes directed branch backtracking across more than twelve doors', () => {
    const stops = shuffled(33), context = lineContext(), start = door(0), end = door(34);
    const before = structuredClone(stops);
    const candidates = buildDrivingAreaDoorCandidates(stops, context, start, end);
    assert.ok(candidates.length > 0);
    assert.ok(candidates[0].seconds <= 34.1);
    assert.ok(candidates[0].seconds < measured(stops, context, start, end).seconds / 3);
    for (const candidate of candidates) {
        assert.deepEqual([...candidate.order.map(identity)].sort(), [...stops.map(identity)].sort());
        assert.equal(new Set(candidate.order).size, 33);
        assert.notDeepEqual(candidate.order, stops, 'unchanged incumbent is not returned as a new candidate');
        assert.deepEqual({ seconds: candidate.seconds, miles: candidate.miles }, measured(candidate.order, context, start, end));
        assert.equal(candidate.source, 'directed_area_door_search');
    }
    assert.deepEqual(stops, before);
});

test('asymmetric reversals are priced with every directed internal edge', () => {
    const stops = [8, 1, 7, 2, 6, 3, 5, 4].map(door), start = door(0), end = door(9), context = lineContext();
    const candidates = buildDrivingAreaDoorCandidates(stops, context, start, end);
    assert.ok(candidates.length);
    for (const candidate of candidates) {
        const expected = measured(candidate.order, context, start, end);
        assert.equal(candidate.seconds, expected.seconds);
        assert.equal(candidate.miles, expected.miles);
    }
    const forward = Array.from({ length: 8 }, (_, i) => door(i + 1));
    assert.notEqual(measured(forward, context, start, end).seconds, measured([...forward].reverse(), context, start, end).seconds);
});

for (const [label, lock] of [
    ['explicit lock IDs', (stops, options) => { options.lockedStopIds = [stops[3].id]; }],
    ['order_locked field', stops => { stops[3].order_locked = true; }],
    ['locked field', stops => { stops[3].locked = true; }],
    ['unresolved access', stops => { stops[3].routing_access = { resolution_status: 'unresolved' }; }],
]) test(`area refinement preserves exact indices for ${label}`, () => {
    const stops = shuffled(14), options = {}, context = lineContext(); lock(stops, options);
    const fixed = stops[3];
    const candidates = buildDrivingAreaDoorCandidates(stops, context, door(0), door(15), options);
    assert.ok(candidates.length);
    for (const candidate of candidates) {
        assert.equal(candidate.order[3], fixed);
        assert.deepEqual([...candidate.order.map(identity)].sort(), [...stops.map(identity)].sort());
    }
});

test('multiple locks and unresolved stops stay fixed while movable doors improve', () => {
    const stops = shuffled(12), context = lineContext();
    stops[2].locked = true; stops[6].order_locked = true;
    stops[9].routing_access = { resolution_status: 'unresolved' };
    const candidates = buildDrivingAreaDoorCandidates(stops, context, door(0), door(13));
    assert.ok(candidates.length);
    assert.ok(candidates[0].seconds < measured(stops, context, door(0), door(13)).seconds);
    for (const candidate of candidates) for (const index of [2, 6, 9]) assert.equal(candidate.order[index], stops[index]);
});

test('fully locked or single-movable areas have no invented candidate', () => {
    const stops = shuffled(8).map(stop => ({ ...stop, locked: true }));
    assert.deepEqual(buildDrivingAreaDoorCandidates(stops, lineContext()), []);
    delete stops[3].locked;
    assert.deepEqual(buildDrivingAreaDoorCandidates(stops, lineContext()), []);
});

for (const invalid of [Infinity, NaN, -1, '10', null]) test(`missing or invalid directed costs (${String(invalid)}) never become aerial estimates`, () => {
    const stops = shuffled(6), context = lineContext(), affected = stops[2];
    const original = context.optimizationCostBetween;
    context.optimizationCostBetween = (a, b) => a === affected || b === affected ? invalid : original(a, b);
    assert.deepEqual(buildDrivingAreaDoorCandidates(stops, context, door(0), door(7)), []);
});

test('missing directed distance evidence prevents a priced candidate even when durations exist', () => {
    const stops = shuffled(6), context = lineContext(), affected = stops[1];
    const original = context.distanceBetween;
    context.distanceBetween = (a, b) => a === affected || b === affected ? Infinity : original(a, b);
    assert.deepEqual(buildDrivingAreaDoorCandidates(stops, context, door(0), door(7)), []);
});

test('an omitted start or end means an open tour without synthetic endpoint cost', () => {
    const stops = shuffled(9), context = lineContext();
    for (const [start, end] of [[null, null], [door(0), null], [null, door(10)]]) {
        const candidates = buildDrivingAreaDoorCandidates(stops, context, start, end);
        assert.ok(candidates.length);
        for (const candidate of candidates) assert.deepEqual({ seconds: candidate.seconds, miles: candidate.miles },
            measured(candidate.order, context, start, end));
    }
});

test('finished candidates are filtered before the cap so a valid alternate is not hidden', () => {
    const stops = [1, 4, 2, 5, 3, 6].map(door), context = lineContext();
    const byPosition = new Map(stops.map(stop => [stop.position, stop]));
    const supplied = [3, 1, 2, 4, 5, 6].map(position => byPosition.get(position));
    const candidates = buildDrivingAreaDoorCandidates(stops, context, door(0), door(7), {
        maxCandidates: 1, seedOrders: [supplied], acceptOrder: order => order[0].position === 3,
    });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].order[0].position, 3);
    assert.ok(candidates[0].seconds > 7, 'caller constraint intentionally keeps a slower valid alternate');
    assert.deepEqual(buildDrivingAreaDoorCandidates(stops, context, door(0), door(7), { acceptOrder: () => false }), []);
});

test('invalid external seed orders cannot change membership or move a locked door', () => {
    const stops = shuffled(10), original = structuredClone(stops), context = lineContext(); stops[4].locked = true;
    const candidates = buildDrivingAreaDoorCandidates(stops, context, door(0), door(11), { seedOrders: [
        [...stops.slice(1), stops[1]], [...stops].reverse(), [...stops, door(100)], stops.slice(1),
    ] });
    assert.ok(candidates.length);
    for (const candidate of candidates) {
        assert.equal(candidate.order[4], stops[4]);
        assert.deepEqual([...candidate.order.map(identity)].sort(), [...original.map(identity)].sort());
    }
});

test('stable input and directed evidence produce identical deterministic candidates', () => {
    const stops = shuffled(22), context = lineContext();
    const first = buildDrivingAreaDoorCandidates(stops, context, door(0), door(23));
    const second = buildDrivingAreaDoorCandidates(stops, context, door(0), door(23));
    assert.deepEqual(first, second);
    assert.equal(new Set(first.map(candidate => JSON.stringify(candidate.order.map(identity)))).size, first.length);
});

test('evaluation quotas bound work for a forty-door search', () => {
    const stops = shuffled(40), context = lineContext(), started = performance.now();
    const candidates = buildDrivingAreaDoorCandidates(stops, context, door(0), door(41), { maxEvaluations: 12000, maxCandidates: 3 });
    assert.ok(candidates.length > 0 && candidates.length <= 3);
    assert.ok(candidates.every(candidate => candidate.searchEvaluations <= 12000));
    assert.ok(performance.now() - started < 1500, 'bounded candidate generation must not become an unbounded route solver');
});

test('search accepts address hashes and legacy IDs while rejecting ambiguous identities', () => {
    const stops = shuffled(7).map((stop, i) => ({ ...stop, address_hash: i % 2 ? stop.id : undefined,
        legacy_hash: i % 2 ? undefined : stop.id, id: undefined }));
    assert.ok(buildDrivingAreaDoorCandidates(stops, lineContext(), door(0), door(8)).length);
    stops[1] = { ...stops[1], address_hash: stops[0].legacy_hash };
    assert.deepEqual(buildDrivingAreaDoorCandidates(stops, lineContext(), door(0), door(8)), []);
});

test('only supported area sizes and a real directed road context are searchable', () => {
    assert.equal(MAX_DRIVING_AREA_DOOR_SEARCH_STOPS, 40);
    for (const stops of [null, [], shuffled(2), shuffled(41)]) assert.deepEqual(buildDrivingAreaDoorCandidates(stops, lineContext()), []);
    assert.deepEqual(buildDrivingAreaDoorCandidates(shuffled(5), {}), []);
    assert.deepEqual(buildDrivingAreaDoorCandidates(shuffled(5).map(stop => ({ ...stop, id: undefined })), lineContext()), []);
});
