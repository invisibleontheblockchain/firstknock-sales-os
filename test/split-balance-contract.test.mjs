// The balance contract, tested directly.
//
// The defect these tests exist for: balance used to be enforced as an upper
// capacity during growth and checked for a lower bound only inside refinement, so
// Route 1I produced a 2-home route at K=50 and a 1-home route at K=100 while the
// report said zero relaxations. Every assertion below is about that class of
// dishonesty — bounds declared up front, in whole homes, violations counted in
// both directions.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    BALANCE_POLICIES,
    resolveBalanceBounds,
    evaluateBalance
} from '../base44/shared/splitBalanceContract.js';
import { buildLegacySweepMembership } from '../base44/shared/legacySweepCandidate.js';

const policy = (id) => BALANCE_POLICIES.find((entry) => entry.id === id);

test('BAL-01 bounds are whole homes and always satisfiable in whole homes', () => {
    // 1,000 homes over the full K curve, every policy.
    [2, 3, 5, 10, 20, 50, 100].forEach((routeCount) => {
        BALANCE_POLICIES.forEach((entry) => {
            const bounds = resolveBalanceBounds(1000, routeCount, entry);
            assert.equal(Number.isInteger(bounds.min_homes_allowed), true);
            assert.equal(Number.isInteger(bounds.max_homes_allowed), true);
            assert.ok(bounds.min_homes_allowed >= 1);
            assert.ok(bounds.min_homes_allowed <= bounds.max_homes_allowed);
            assert.equal(bounds.feasible, true);
            // An integer split must exist: K routes capped at the max can hold N,
            // and K routes at the min do not require more than N.
            assert.ok(bounds.max_homes_allowed * routeCount >= 1000);
            assert.ok(bounds.min_homes_allowed * routeCount <= 1000);
        });
    });
});

test('BAL-02 a fractional tolerance at high K never degenerates into permitting 1 home', () => {
    // Target 10 with a 6% tolerance is 0.6 of a house — the exact case where a
    // percentage stops meaning anything.
    const bounds = resolveBalanceBounds(1000, 100, policy('moderate'));
    assert.equal(bounds.target_homes_per_route, 10);
    assert.ok(bounds.min_homes_allowed >= 9, `floor collapsed to ${bounds.min_homes_allowed}`);
    assert.ok(bounds.max_homes_allowed <= 11);

    // Even with coarse atoms widening the eligibility band, the floor may never
    // fall below half the declared minimum.
    const withCoarseAtoms = resolveBalanceBounds(1000, 100, policy('moderate'), { largestAtomHomes: 10 });
    assert.ok(withCoarseAtoms.eligible_min_homes >= Math.ceil(withCoarseAtoms.min_homes_allowed / 2));
    assert.ok(withCoarseAtoms.eligible_min_homes > 1);
});

test('BAL-03 under-fill and over-fill are counted separately and both count as relaxations', () => {
    const bounds = resolveBalanceBounds(1000, 100, policy('moderate'));

    const balanced = evaluateBalance(new Array(100).fill(10), bounds);
    assert.equal(balanced.balance_valid, true);
    assert.equal(balanced.balance_relaxations, 0);

    // The exact pre-fix Route 1I shape: one 1-home route, one fat route.
    const skewed = evaluateBalance([1, 19, ...new Array(98).fill(10)], bounds);
    assert.equal(skewed.balance_valid, false);
    assert.equal(skewed.routes_below_min, 1);
    assert.equal(skewed.routes_above_max, 1);
    assert.equal(skewed.balance_relaxations, 2);
    assert.equal(skewed.worst_under_fill_homes, bounds.min_homes_allowed - 1);
    assert.equal(skewed.actual_min_homes, 1);
    assert.equal(skewed.balance_eligible, false, 'a 1-home route must never be an eligible finalist');
});

test('BAL-04 the atom-granularity band admits an indivisible-atom miss but nothing worse', () => {
    // 64 homes into 3 routes with 8-home blocks can only produce multiples of 8,
    // so the declared band around 21.3 is unreachable by arithmetic, not by choice.
    const bounds = resolveBalanceBounds(64, 3, policy('loose'), { largestAtomHomes: 8 });
    const achievable = evaluateBalance([24, 24, 16], bounds);
    assert.equal(achievable.balance_valid, false, 'it does miss the declared band');
    assert.equal(achievable.balance_eligible, true, 'and is still allowed to compete');
    assert.equal(evaluateBalance([48, 8, 8], bounds).balance_eligible, false);
});

test('BAL-05 the old sweep becomes a candidate: contiguous atom runs, exactly once, in band', () => {
    // Ten 4-home atoms in sweep order, split three ways.
    const atoms = Array.from({ length: 10 }, (_, index) => ({
        doorCount: 4,
        doors: Array.from({ length: 4 }, (__, house) => ({ address_hash: `a${index}-${house}` }))
    }));
    const sequenced = atoms.flatMap((atom) => atom.doors);
    const bounds = resolveBalanceBounds(40, 3, policy('loose'), { largestAtomHomes: 4 });

    const legacy = buildLegacySweepMembership(atoms, sequenced, 3, bounds);
    assert.equal(legacy.ok, true, legacy.code);
    assert.equal(legacy.members.length, 3);
    const assigned = legacy.members.flat();
    assert.equal(assigned.length, 10);
    assert.equal(new Set(assigned).size, 10, 'every atom exactly once');
    // Contiguous in sweep order — that is what makes this the old model's cut.
    legacy.members.forEach((run) => run.forEach((atomIndex, position) => {
        if (position > 0) assert.equal(atomIndex, run[position - 1] + 1);
    }));
    const homes = legacy.members.map((run) => run.length * 4);
    assert.ok(evaluateBalance(homes, bounds).balance_eligible, `sweep produced ${homes.join('/')}`);

    // An order that does not cover every atom is refused rather than patched.
    assert.equal(
        buildLegacySweepMembership(atoms, sequenced.slice(0, 8), 3, bounds).code,
        'LEGACY_SWEEP_ORDER_INCOMPLETE'
    );
});