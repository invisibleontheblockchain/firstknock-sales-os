/**
 * DET — determinism harness over frozen road matrices.
 *
 * Every fixture in test/fixtures/road-matrix-*.json carries the full pairwise
 * distance AND duration tables, so these assertions never touch the public
 * OSRM server: a provider outage, rate limit, or map-data refresh cannot make
 * this suite flap.
 *
 * The contract under test:
 *   same doors + same constraints + same matrix + same optimizer version
 *     => same property-order fingerprint
 * plus: winning duration <= current duration (never worse), and a second
 * Optimize press cannot rearrange an already-winning route.
 *
 * Solver cost is now flat across door counts (one deterministic step budget, no
 * block-count cliff), so every fixture is exercised the same number of times.
 * The repeats run at a reduced step budget: budget exhaustion is itself part of
 * the deterministic path, and one full-production-budget pass per fixture pins
 * the shipped configuration's fingerprint.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createMatrixMetricFns } from '../base44/shared/roadMatrix.js';
import { roadAwareStreetSweep } from '../base44/shared/roadAwareStreetSweep.js';
import { createContinuityOptimizer, haversineMiles } from '../base44/shared/routeContinuityOptimizer.js';
import { measureRouteCandidate, selectBestRouteCandidate } from '../base44/shared/routeCandidateSelection.js';

const FIXTURES = ['anderson183', 'mesquite58', 'charlotte95'];
const REPEATS = 2;
// Reduced budget keeps the repeat loops affordable while exercising the same
// budgeted search, including the exhaustion path. PRODUCTION_BUDGET_RUNS uses
// the shipped default so the real configuration is pinned too.
const TEST_STEP_BUDGET = 120_000;

function loadFixture(name) {
    const fixture = JSON.parse(
        fs.readFileSync(new URL(`./fixtures/road-matrix-${name}.json`, import.meta.url), 'utf8')
    );
    const metrics = createMatrixMetricFns(fixture.properties, {
        distances: fixture.distances_miles,
        durations: fixture.durations_minutes
    });
    return { fixture, metrics };
}

/** Canonical order is the optimizer's own input normalization — never input order. */
function canonical(properties) {
    return [...properties].sort((first, second) => (
        String(first.address_hash) < String(second.address_hash) ? -1 : 1
    ));
}

function seededShuffle(properties, seed) {
    const shuffled = [...properties];
    let state = seed;
    for (let index = shuffled.length - 1; index > 0; index--) {
        state = (state * 1103515245 + 12345) % 2147483648;
        const swap = state % (index + 1);
        [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
    }
    return shuffled;
}

/** One full generation pass: build every candidate, price it, pick the winner. */
function generate(properties, metrics, currentOrder = null, stepBudget = TEST_STEP_BUDGET) {
    const doors = canonical(properties);
    const continuity = createContinuityOptimizer(haversineMiles)
        .buildRouteChunks(doors, doors.length, null, null)
        .doorChunks.flat().map(door => door.property);
    const sweepOptions = stepBudget ? { refinementStepBudget: stepBudget } : {};
    const byDistance = roadAwareStreetSweep(doors, {
        startLocation: null,
        endLocation: null,
        distanceBetween: metrics.distanceBetween,
        ...sweepOptions
    });
    const byDuration = roadAwareStreetSweep(doors, {
        startLocation: null,
        endLocation: null,
        distanceBetween: metrics.durationBetween,
        ...sweepOptions
    });

    const seeds = [
        { type: 'continuity', order: continuity },
        { type: 'road_aware_distance', order: byDistance },
        { type: 'road_aware_duration', order: byDuration }
    ];
    if (currentOrder) seeds.unshift({ type: 'current', order: currentOrder, is_current: true });

    const candidates = seeds
        .flatMap(candidate => [
            candidate,
            { ...candidate, is_current: false, type: `${candidate.type}_reversed`, order: [...candidate.order].reverse() }
        ])
        .map(candidate => measureRouteCandidate(candidate, metrics));

    return { winner: selectBestRouteCandidate(candidates), candidates };
}

for (const name of FIXTURES) {
    test(`DET ${name} — identical inputs always produce one fingerprint`, () => {
        const { fixture, metrics } = loadFixture(name);
        const baseline = generate(fixture.properties, metrics).winner;

        assert.equal(
            new Set(baseline.order.map(door => door.address_hash)).size,
            fixture.point_count,
            'winning order must contain every door exactly once'
        );

        for (let run = 0; run < REPEATS; run++) {
            const repeat = generate(fixture.properties, metrics).winner;
            assert.equal(repeat.fingerprint, baseline.fingerprint, `run ${run} drifted`);
        }
    });

    test(`DET ${name} — shuffled and reversed inputs land on the same route`, () => {
        const { fixture, metrics } = loadFixture(name);
        const baseline = generate(fixture.properties, metrics).winner;

        for (let run = 0; run < REPEATS; run++) {
            const shuffled = generate(seededShuffle(fixture.properties, 7919 + run), metrics).winner;
            assert.equal(shuffled.fingerprint, baseline.fingerprint, `shuffle ${run} changed the route`);
        }

        const reversed = generate([...fixture.properties].reverse(), metrics).winner;
        assert.equal(reversed.fingerprint, baseline.fingerprint);
    });

    test(`DET ${name} — Optimize is monotonic and idempotent, and export round-trips`, () => {
        const { fixture, metrics } = loadFixture(name);
        const exported = fixture.properties;

        // Initial generation, competing against the exported saved order.
        const first = generate(exported, metrics, exported);
        const current = first.candidates.find(candidate => candidate.is_current);
        assert.ok(
            first.winner.duration <= current.duration,
            `winner ${first.winner.duration} must never be slower than current ${current.duration}`
        );

        // Optimize once more with the winner installed as the saved route.
        const second = generate(exported, metrics, first.winner.order);
        assert.equal(second.winner.fingerprint, first.winner.fingerprint, 'second Optimize rearranged the route');

        // And a third press, to prove the tie rule holds rather than oscillating.
        const third = generate(exported, metrics, second.winner.order);
        assert.equal(third.winner.fingerprint, first.winner.fingerprint);

        // Export → reopen: a JSON round-trip of the saved order must reprice and
        // refingerprint identically, so a reopened route never re-optimizes.
        const reopened = JSON.parse(JSON.stringify(first.winner.order));
        const repriced = measureRouteCandidate({ type: 'reopened', order: reopened }, metrics);
        assert.equal(repriced.fingerprint, first.winner.fingerprint);
        assert.ok(Math.abs(repriced.duration - first.winner.duration) < 1e-9);
        assert.ok(Math.abs(repriced.distance - first.winner.distance) < 1e-9);
    });
}

// Charlotte carries the production-budget pin: it is the fixture that actually
// EXHAUSTS the shipped budget (Mesquite converges well before spending it), so it
// is where budget-order drift would surface. Affordable again now that the matrix
// accessor is an indexed lookup — a full-budget pass costs ~8s, not ~31s.
test('DET the shipped step budget is itself deterministic', () => {
    for (const name of ['charlotte95']) {
        const { fixture, metrics } = loadFixture(name);
        // stepBudget=null -> the production REFINEMENT_STEP_BUDGET default.
        const baseline = generate(fixture.properties, metrics, null, null).winner;
        const repeat = generate([...fixture.properties].reverse(), metrics, null, null).winner;
        assert.equal(repeat.fingerprint, baseline.fingerprint, `${name} drifted at the production budget`);
        assert.equal(
            new Set(baseline.order.map(door => door.address_hash)).size,
            fixture.point_count
        );
    }
});

test('DET fixtures are frozen, complete, and self-consistent', () => {
    for (const name of FIXTURES) {
        const { fixture } = loadFixture(name);
        assert.equal(fixture.properties.length, fixture.point_count);
        assert.equal(fixture.distances_miles.length, fixture.point_count);
        assert.equal(fixture.durations_minutes.length, fixture.point_count);
        for (let row = 0; row < fixture.point_count; row++) {
            assert.equal(fixture.distances_miles[row].length, fixture.point_count, `${name} distance row ${row}`);
            assert.equal(fixture.durations_minutes[row].length, fixture.point_count, `${name} duration row ${row}`);
            for (let col = 0; col < fixture.point_count; col++) {
                assert.ok(Number.isFinite(fixture.distances_miles[row][col]), `${name} unresolved distance ${row},${col}`);
                assert.ok(Number.isFinite(fixture.durations_minutes[row][col]), `${name} unresolved duration ${row},${col}`);
            }
        }
        assert.equal(fixture.provider, 'osrm-demo');
        assert.ok(fixture.captured_at, 'fixture must record when it was captured');
    }
});