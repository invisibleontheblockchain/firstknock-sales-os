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

test('SEL-06 unmeasurable candidates lose to measured ones and never win alone', () => {
    const unmeasurable = measure({ type: 'road_aware', order: [A, door('Z', 1, 1), C] });
    assert.equal(unmeasurable.distance, null);
    const current = measure({ type: 'current', order: [A, B, C], is_current: true });
    assert.equal(selectBestRouteCandidate([unmeasurable, current]).is_current, true);
    assert.equal(selectBestRouteCandidate([unmeasurable]), null);
});