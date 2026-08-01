/**
 * BUDGET — the solver's refinement cost must be bounded by a deterministic step
 * budget, not by a block-count threshold.
 *
 * The regression this guards: refinement used to run below 120 street blocks and
 * be skipped entirely above it, so Charlotte 95 cost ~16.9s per sweep while
 * Anderson 183 skipped refinement at 36ms. A 95-door route could therefore take
 * far longer than a 183-door route, and large routes silently lost refinement.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createMatrixMetricFns } from '../base44/shared/roadMatrix.js';
import {
    roadAwareStreetSweep,
    REFINEMENT_STEP_BUDGET,
    SCREENING_STEP_BUDGET
} from '../base44/shared/roadAwareStreetSweep.js';

function loadFixture(name) {
    const fixture = JSON.parse(
        fs.readFileSync(new URL(`./fixtures/road-matrix-${name}.json`, import.meta.url), 'utf8')
    );
    return {
        fixture,
        metrics: createMatrixMetricFns(fixture.properties, {
            distances: fixture.distances_miles,
            durations: fixture.durations_minutes
        })
    };
}

function canonical(properties) {
    return [...properties].sort((first, second) => (
        String(first.address_hash) < String(second.address_hash) ? -1 : 1
    ));
}

function fingerprint(order) {
    return order.map(door => door.address_hash).join('>');
}

test('BUDGET-01 the source carries no block-count refinement cliff', () => {
    const source = fs.readFileSync(
        new URL('../base44/shared/roadAwareStreetSweep.js', import.meta.url),
        'utf8'
    );
    assert.ok(
        !/ordered\.length\s*>\s*120/.test(source),
        'the 120-block refinement threshold must not come back'
    );
    assert.ok(Number.isFinite(REFINEMENT_STEP_BUDGET) && REFINEMENT_STEP_BUDGET > 0);
    assert.ok(Number.isFinite(SCREENING_STEP_BUDGET) && SCREENING_STEP_BUDGET > 0);
});

test('BUDGET-02 a large route is still refined, and a starved budget still returns every door', () => {
    const { fixture, metrics } = loadFixture('anderson183');
    const doors = canonical(fixture.properties);

    // A route far past the old 120-block threshold must now be refined at all:
    // a starved budget and the production budget must not agree by default.
    const starved = roadAwareStreetSweep(doors, {
        distanceBetween: metrics.durationBetween,
        refinementStepBudget: 1
    });
    const refined = roadAwareStreetSweep(doors, {
        distanceBetween: metrics.durationBetween
    });

    for (const order of [starved, refined]) {
        assert.equal(order.length, fixture.point_count, 'every door must survive refinement');
        assert.equal(
            new Set(order.map(door => door.address_hash)).size,
            fixture.point_count,
            'no door may be duplicated or dropped'
        );
    }
    assert.notEqual(
        fingerprint(starved),
        fingerprint(refined),
        'refinement must actually run on a route above the old 120-block cliff'
    );
});

test('BUDGET-03 the same budget always spends itself the same way', () => {
    const { fixture, metrics } = loadFixture('mesquite58');
    const doors = canonical(fixture.properties);
    const options = { distanceBetween: metrics.durationBetween, refinementStepBudget: 90_000 };

    const baseline = fingerprint(roadAwareStreetSweep(doors, options));
    for (let run = 0; run < 3; run++) {
        assert.equal(
            fingerprint(roadAwareStreetSweep([...doors].reverse(), options)),
            baseline,
            `budgeted run ${run} drifted — budget consumption must not depend on input order`
        );
    }
});

test('BUDGET-04 runtime no longer inverts with door count', () => {
    const timings = ['mesquite58', 'charlotte95', 'anderson183'].map((name) => {
        const { fixture, metrics } = loadFixture(name);
        const doors = canonical(fixture.properties);
        const startedAt = Date.now();
        roadAwareStreetSweep(doors, {
            distanceBetween: metrics.durationBetween,
            refinementStepBudget: 200_000
        });
        return { name, doors: fixture.point_count, ms: Date.now() - startedAt };
    });

    // Under one shared step budget no fixture may cost an order of magnitude
    // more than another — that ratio is exactly what the cliff produced.
    const slowest = Math.max(...timings.map(entry => entry.ms));
    const fastest = Math.min(...timings.map(entry => entry.ms));
    assert.ok(
        slowest <= Math.max(fastest, 50) * 10,
        `solver cost must stay within one order of magnitude across sizes: ${JSON.stringify(timings)}`
    );
});