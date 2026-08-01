// Anderson 183-property acceptance gate.
//
// Reference values measured on one complete, chunk-assembled OSRM driving matrix
// (183 points, 16 blocks, 0 unresolved cells):
//
//   existing saved route      449.0 min / 144.092 mi
//   shipped replacement       454.6 min / 143.670 mi  <- must always be rejected
//   distance-priced sweep     445.2 min / 144.603 mi  <- the honest winner
//
// The replacement was 0.422 mi shorter and 5.6 min slower. It shipped because the
// route skipped the road matrix, not because the comparison preferred it — these
// tests hold the comparison itself to that verdict.

import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRouteCandidates, selectBestRouteCandidate } from '../base44/shared/routeCandidateSelection.js';

const CURRENT = { type: 'current', is_current: true, fingerprint: 'anderson_current', duration: 449.0, distance: 144.092, order: ['a'] };
const SHIPPED = { type: 'road_aware', fingerprint: 'anderson_shipped', duration: 454.6, distance: 143.670, order: ['a'] };
const CHALLENGER = { type: 'road_aware', fingerprint: 'anderson_challenger', duration: 445.2, distance: 144.603, order: ['a'] };

test('AND-01 the 454.6-minute replacement never beats the 449.0-minute saved route', () => {
    assert.ok(compareRouteCandidates(CURRENT, SHIPPED) < 0);
    assert.equal(selectBestRouteCandidate([SHIPPED, CURRENT]).is_current, true);
});

test('AND-02 a shorter-mileage but slower candidate loses — distance never overrides duration', () => {
    assert.ok(SHIPPED.distance < CURRENT.distance);
    assert.equal(selectBestRouteCandidate([CURRENT, SHIPPED]).fingerprint, CURRENT.fingerprint);
});

test('AND-03 the 445.2-minute challenger wins even though it drives more miles', () => {
    const winner = selectBestRouteCandidate([CURRENT, SHIPPED, CHALLENGER]);
    assert.equal(winner.fingerprint, CHALLENGER.fingerprint);
    assert.ok(winner.duration < CURRENT.duration);
    assert.ok(winner.distance > CURRENT.distance);
});

test('AND-04 the winner is the same whichever order the candidates arrive in', () => {
    [[CURRENT, SHIPPED, CHALLENGER], [CHALLENGER, CURRENT, SHIPPED], [SHIPPED, CHALLENGER, CURRENT]]
        .forEach((candidates) => {
            assert.equal(selectBestRouteCandidate(candidates).fingerprint, CHALLENGER.fingerprint);
        });
});

test('AND-05 re-optimizing the winner is idempotent', () => {
    const saved = { ...CHALLENGER, type: 'current', is_current: true };
    const winner = selectBestRouteCandidate([saved, { ...CHALLENGER, is_current: false }, CURRENT, SHIPPED]);
    assert.equal(winner.is_current, true);
    assert.equal(winner.fingerprint, CHALLENGER.fingerprint);
});