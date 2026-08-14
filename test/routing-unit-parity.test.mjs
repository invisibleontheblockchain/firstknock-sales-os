// Stage 1 parity gate.
//
// Stage 1 collapses four independent street-block / pocket definitions onto the
// shared model in base44/shared/routingUnits.js. This test is the guard rail for
// that migration: it re-derives every path's block partition and route order
// from the real frozen fixtures and compares them against the committed
// baseline, so any route change during the rewiring has to be deliberate.
//
// Regenerate the baseline (only with a reviewed reason) with:
//   node scripts/capture-stage1-baseline.mjs --write

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { BASELINE_PATH, captureBaseline } from '../scripts/capture-stage1-baseline.mjs';

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

test('PARITY-01 block partitions and route orders match the frozen baseline', async () => {
    const captured = await captureBaseline();
    Object.entries(baseline.fixtures).forEach(([name, expected]) => {
        const actual = captured.fixtures[name];
        assert.ok(actual, `fixture ${name} disappeared from the capture`);
        assert.deepEqual(actual.blocks, expected.blocks, `${name}: street-block partition drifted`);
        assert.deepEqual(actual.sweepOrder, expected.sweepOrder, `${name}: sweep door order drifted`);
        assert.deepEqual(actual.backendRoutes, expected.backendRoutes, `${name}: generated routes drifted`);
        assert.deepEqual(actual.routingUnits, expected.routingUnits, `${name}: routing units drifted`);
    });
});

test('PARITY-02 the shared model already agrees with the frontend sweep, and the divergence still to be closed is recorded', () => {
    // Criterion 1 evidence, per fixture: the shared model and the shipped
    // frontend street sweep produce the SAME blocks door for door, so pointing
    // the sweep at the shared model is behaviour-neutral on real routes.
    Object.entries(baseline.fixtures).forEach(([name, fixture]) => {
        assert.deepEqual(
            fixture.blocks.frontendSweep,
            fixture.blocks.shared,
            `${name}: frontend sweep must already match the shared block definition`
        );
    });

    // The cost-only road context still groups doors its own way: it has no
    // spatial gap split, so doors on one street name that are far apart stay
    // welded into one block. These are the exact groups Stage 1 has to converge,
    // pinned so the number cannot quietly grow.
    const costOnlyDivergence = Object.fromEntries(
        Object.entries(baseline.fixtures).map(([name, fixture]) => [
            name,
            fixture.blocks.shared.filter((group) => !fixture.blocks.costOnly.includes(group)).length
        ])
    );
    assert.deepEqual(costOnlyDivergence, {
        mesquite58: 4,
        charlotte95: 0,
        anderson183: 6
    });
});

test('PARITY-03 every fixture door lands in exactly one block in every definition', () => {
    Object.entries(baseline.fixtures).forEach(([name, fixture]) => {
        Object.entries(fixture.blocks).forEach(([definition, groups]) => {
            const doorIds = groups.flatMap((group) => group.split(','));
            assert.equal(
                doorIds.length,
                fixture.doorCount,
                `${name}/${definition}: block partition lost or duplicated doors`
            );
            assert.equal(
                new Set(doorIds).size,
                fixture.doorCount,
                `${name}/${definition}: a door appears in more than one block`
            );
        });
    });
});