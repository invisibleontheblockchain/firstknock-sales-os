// The "never worse, always the same answer" guarantees for route optimization.
//
// These assert the acceptance gate itself, independently of OSRM: the current
// route always competes, duration is the primary objective, distance is the
// tie-break, and the winner depends only on candidate CONTENT — never on the
// order candidates happen to arrive in.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    compareRouteCandidates,
    DURATION_TIE_TOLERANCE_MINUTES,
    measureRouteCandidate,
    selectBestRouteCandidate
} from '../base44/shared/routeCandidateSelection.js';

const door = (id, lat, lng) => ({ address_hash: id, lat, lng });
const A = door('A', 35.4, -80.6);
const B = door('B', 35.41, -80.61);
const C = door('C', 35.42, -80.62);

// Synthetic frozen matrix: A-B 1mi/2min, B-C 1mi/2min, A-C 5mi/10min.
const LEGS = {
    'A|B': [1, 2], 'B|A': [1, 2],
    'B|C': [1, 2], 'C|B': [1, 2],
    'A|C': [5, 10], 'C|A': [5, 10]
};
const metric = (slot) => (from, to) => {
    const leg = LEGS[`${from.address_hash}|${to.address_hash}`];
    return leg ? leg[slot] : null;
};
const matrix = { distanceBetween: metric(0), durationBetween: metric(1) };
const measure = (candidate) => measureRouteCandidate(candidate, matrix);

test('SEL-01 the shorter-duration candidate wins', () => {
    const good = measure({ type: 'road_aware', order: [A, B, C] });
    const bad = measure({ type: 'continuity', order: [A, C, B] });
    assert.equal(selectBestRouteCandidate([bad, good]).fingerprint, good.fingerprint);
    assert.ok(good.duration < bad.duration);
});

test('SEL-02 Optimize is monotonic — a worse candidate never replaces the current route', () => {
    const current = measure({ type: 'current', order: [A, B, C], is_current: true });
    const worse = measure({ type: 'road_aware', order: [B, A, C] });
    const worst = measure({ type: 'continuity', order: [A, C, B] });
    const winner = selectBestRouteCandidate([current, worse, worst]);
    assert.equal(winner.is_current, true);
    assert.equal(winner.fingerprint, current.fingerprint);
});

test('SEL-03 an exact tie keeps the current route (repeated Optimize is idempotent)', () => {
    const current = measure({ type: 'current', order: [A, B, C], is_current: true });
    const twin = measure({ type: 'road_aware', order: [A, B, C] });
    assert.equal(compareRouteCandidates(current, twin) < 0, true);
    assert.equal(selectBestRouteCandidate([twin, current]).is_current, true);
});

test('SEL-04 a within-tolerance duration difference falls through to distance', () => {
    const current = { type: 'current', order: [A, B, C], is_current: true, fingerprint: 'f1', duration: 10, distance: 4 };
    const rival = { type: 'road_aware', order: [A, C, B], fingerprint: 'f2', duration: 10 - (DURATION_TIE_TOLERANCE_MINUTES / 2), distance: 3 };
    assert.ok(compareRouteCandidates(rival, current) < 0);
    // Same tiny duration edge, but no distance gain: the current route holds.
    const flat = { ...rival, distance: 4 };
    assert.ok(compareRouteCandidates(current, flat) < 0);
});

test('SEL-05 the winner is independent of candidate arrival order', () => {
    const candidates = [
        measure({ type: 'current', order: [A, C, B], is_current: true }),
        measure({ type: 'continuity', order: [C, A, B] }),
        measure({ type: 'road_aware', order: [A, B, C] }),
        measure({ type: 'road_aware', order: [C, B, A] })
    ];
    const winner = selectBestRouteCandidate(candidates).fingerprint;
    const permutations = [
        [3, 2, 1, 0],
        [1, 3, 0, 2],
        [2, 0, 3, 1],
        [0, 3, 2, 1]
    ];
    permutations.forEach((permutation) => {
        const shuffled = permutation.map((index) => candidates[index]);
        assert.equal(selectBestRouteCandidate(shuffled).fingerprint, winner);
    });
});

test('SEL-07 the anchor legs are part of the score, so a route starts at the door nearest home', () => {
    // Home sits next to C. Door-to-door the two directions are identical
    // (1+1 miles each way), so before anchor legs were measured the saved order
    // won the tie and the rep drove past the whole territory to start at A.
    const H = door('H', 35.421, -80.621);
    const anchored = { 'H|A': [5, 10], 'A|H': [5, 10], 'H|C': [0.1, 0.2], 'C|H': [0.1, 0.2] };
    const anchoredMetric = (slot) => (from, to) => {
        const key = `${from.address_hash}|${to.address_hash}`;
        return (anchored[key] || LEGS[key] || [null, null])[slot];
    };
    const options = {
        distanceBetween: anchoredMetric(0),
        durationBetween: anchoredMetric(1),
        startLocation: H,
        endLocation: H
    };
    const current = measureRouteCandidate({ type: 'current', order: [A, B, C], is_current: true }, options);
    const fromHome = measureRouteCandidate({ type: 'road_aware', order: [C, B, A] }, options);
    // 5 + 1 + 1 + 0.1 vs 0.1 + 1 + 1 + 5 is a tie in TOTAL, but the doors alone
    // are also a tie — what matters is that both anchor legs are counted.
    assert.equal(current.distance, 7.1);
    assert.equal(fromHome.distance, 7.1);

    // One-way home start: only the drive out is anchored, and starting at the
    // near door is now measurably better.
    const oneWay = { ...options, endLocation: null };
    const outFromA = measureRouteCandidate({ type: 'current', order: [A, B, C], is_current: true }, oneWay);
    const outFromC = measureRouteCandidate({ type: 'road_aware', order: [C, B, A] }, oneWay);
    assert.equal(outFromA.distance, 7);
    assert.equal(outFromC.distance, 2.1);
    assert.equal(selectBestRouteCandidate([outFromA, outFromC]).fingerprint, outFromC.fingerprint);
});

test('SEL-09 a home round trip ties both directions, so the nearest door wins the start', () => {
    // Home sits beside C. Loop cost is identical either way, which is exactly the
    // tie that used to leave the route opening at the far door A.
    const H = door('H', 35.421, -80.621);
    const anchored = { 'H|A': [5, 10], 'A|H': [5, 10], 'H|C': [0.1, 0.2], 'C|H': [0.1, 0.2] };
    const anchoredMetric = (slot) => (from, to) => {
        const key = `${from.address_hash}|${to.address_hash}`;
        return (anchored[key] || LEGS[key] || [null, null])[slot];
    };
    const options = {
        distanceBetween: anchoredMetric(0),
        durationBetween: anchoredMetric(1),
        startLocation: H,
        endLocation: H
    };
    const startsFar = measureRouteCandidate({ type: 'current', order: [A, B, C], is_current: true }, options);
    const startsNear = measureRouteCandidate({ type: 'road_aware', order: [C, B, A] }, options);
    assert.equal(startsFar.distance, startsNear.distance);
    assert.equal(selectBestRouteCandidate([startsFar, startsNear]).fingerprint, startsNear.fingerprint);
    // Idempotent: once it starts near, re-optimizing keeps it.
    const nearIsCurrent = { ...startsNear, is_current: true };
    const farIsRival = { ...startsFar, is_current: false };
    assert.equal(selectBestRouteCandidate([farIsRival, nearIsCurrent]).fingerprint, nearIsCurrent.fingerprint);
});

test('SEL-10 the nearest-start tie-break never outvotes a real distance saving', () => {
    const far = { type: 'road_aware', order: [A, B], fingerprint: 'f1', duration: 10, distance: 3, startLeg: 5 };
    const nearButLonger = { type: 'road_aware', order: [B, A], fingerprint: 'f2', duration: 10, distance: 9, startLeg: 0.1 };
    assert.ok(compareRouteCandidates(far, nearButLonger) < 0);
});

test('SEL-08 an unpriceable anchor leg makes the candidate unmeasured, never partially scored', () => {
    const H = door('H', 1, 1);
    const candidate = measureRouteCandidate({ type: 'road_aware', order: [A, B, C] }, {
        distanceBetween: metric(0),
        durationBetween: metric(1),
        startLocation: H
    });
    assert.equal(candidate.distance, null);
});

test('SEL-06 unmeasurable candidates lose to measured ones and never win alone', () => {
    const unmeasurable = measure({ type: 'road_aware', order: [A, door('Z', 1, 1), C] });
    assert.equal(unmeasurable.distance, null);
    const current = measure({ type: 'current', order: [A, B, C], is_current: true });
    assert.equal(selectBestRouteCandidate([unmeasurable, current]).is_current, true);
    assert.equal(selectBestRouteCandidate([unmeasurable]), null);
});