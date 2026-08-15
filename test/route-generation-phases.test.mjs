// The progress checklist must track REAL work, so every status string the
// generation flow reports has to land on the phase that work belongs to. A
// mis-mapped status would show the customer a phase that is not running, which is
// the fake-progress behavior this replaced.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    ROUTE_GENERATION_PHASES,
    phaseFromStage,
    phasePosition
} from '../src/components/routes/routeGenerationPhases.js';

test('PHASE-01 every status the generation reports maps to the phase doing that work', () => {
    assert.equal(phaseFromStage('Preparing data...'), 'prepare');
    assert.equal(phaseFromStage('Filtering 12,480 properties...'), 'prepare');
    assert.equal(phaseFromStage('Optimizing 1,000 doors — ~2s'), 'optimize');
    assert.equal(phaseFromStage('Reordering 1,000 doors...'), 'optimize');
    assert.equal(phaseFromStage('Verifying real road mileage...'), 'verify');
    assert.equal(phaseFromStage('Verifying route 2 of 4 on real roads...'), 'verify');
    assert.equal(phaseFromStage('Saving 4 routes...'), 'save');
});

test('PHASE-02 phases are ordered and an unknown status never skips ahead', () => {
    const order = ROUTE_GENERATION_PHASES.map((phase) => phase.id);
    assert.deepEqual(order, ['prepare', 'optimize', 'verify', 'save']);
    assert.equal(phasePosition('save'), 3);
    assert.equal(phasePosition('something-else'), 0);
    assert.equal(phaseFromStage(null), 'prepare');
});

test('PHASE-03 no phase label exposes internal engine jargon', () => {
    const forbidden = /matrix|matrices|osrm|haversine|aerial|hierarchy|cluster|seam|hotspot/i;
    ROUTE_GENERATION_PHASES.forEach((phase) => {
        assert.ok(!forbidden.test(phase.label), `phase label leaks internals: ${phase.label}`);
    });
});

test('PHASE-04 the road pass still reports a status this mapping recognizes', () => {
    const source = readFileSync(new URL('../src/lib/roadMatrixRouteGeneration.js', import.meta.url), 'utf8');
    const reported = [...source.matchAll(/onStage\?\.\(\s*[`'"]([^`'"]+)/g)].map((match) => match[1]);
    assert.ok(reported.length > 0, 'the road pass must report progress');
    reported.forEach((stage) => assert.equal(phaseFromStage(stage), 'verify', `unmapped status: ${stage}`));
});