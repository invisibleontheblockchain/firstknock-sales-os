import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { reviewLocalDrivingNeighborhoods } from '../base44/shared/localDrivingNeighborhoods.js';
import { describeAppliedRoadOptimization } from '../src/lib/routeOptimizationOutcome.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/troutman-area-305-317.json', import.meta.url), 'utf8'));
const expected = fixture.measurements.after.order;
const input = fixture.stops.map(p => ({ ...p, locked: [304, 305, 318, 319].includes(p.stop) }));
const key = sequence => sequence.map(p => p.stop).join(',');
function recordedContext({ changedBoundary = false, worseDrive = false } = {}) {
    const index = p => fixture.matrix.order.indexOf(p.stop);
    return {
        accessFor: p => p.routing_access,
        optimizationCostBetween: (a, b) => fixture.matrix.durations[index(a)][index(b)],
        distanceBetween: (a, b) => fixture.matrix.distances[index(a)][index(b)],
        async routeSequence(sequence) {
            const after = key(sequence) === expected.join(',');
            const before = key(sequence) === fixture.measurements.before.order.join(',');
            if (!after && !before) throw new Error('Continuous drive is not present in the frozen road evidence.');
            const result = structuredClone(after ? fixture.measurements.after : fixture.measurements.before);
            if (after && changedBoundary) result.directedLegs[0].pathKey += ':different-arrival';
            if (after && worseDrive) result.driveSeconds = fixture.measurements.before.driveSeconds + 1;
            return result;
        },
    };
}
const options = settings => ({ mailCarrierMode: true, maxAreaWindowStops: 12, maxLocalWindows: 1,
    baselineOrder: input, createLocalDrivingContext: async () => recordedContext(settings) });

test('the full driving review moves Troutman upper and middle areas before the lower area with fixed entry and exit', async () => {
    const result = await reviewLocalDrivingNeighborhoods(input, options());
    assert.deepEqual(result.properties.map(p => p.stop), expected);
    assert.equal(result.diagnostics.areaReview.checked, 1);
    assert.equal(result.diagnostics.areaReview.repaired, 1);
    assert.equal(result.diagnostics.validation, 'whole_route');
    assert.equal(result.diagnostics.applied, true);
    assert.ok(Math.abs(result.diagnostics.localMilesSaved - 1.03831147140678) < 1e-6);
    assert.ok(Math.abs(result.diagnostics.localSecondsSaved - 163.3) < 1e-6);
    assert.equal(result.measurement.driveSeconds, fixture.measurements.after.driveSeconds);
    assert.deepEqual(new Set(result.properties), new Set(input));
    for (const stop of [304, 305, 318, 319]) assert.equal(result.properties.findIndex(p => p.stop === stop), input.findIndex(p => p.stop === stop));
});

test('a better pairwise area proposal cannot change the route when the continuous drive or arrival path fails', async () => {
    for (const settings of [{ changedBoundary: true }, { worseDrive: true }]) {
        const result = await reviewLocalDrivingNeighborhoods(input, options(settings));
        assert.equal(result.properties, input);
        assert.equal(result.diagnostics.applied, false);
        assert.equal(result.diagnostics.areaReview.repaired, 0);
    }
});

test('the same validated area order is stable on a repeated review', async () => {
    const byStop = new Map(input.map(p => [p.stop, p]));
    const sorted = expected.map(stop => byStop.get(stop));
    const result = await reviewLocalDrivingNeighborhoods(sorted, { ...options(), baselineOrder: sorted });
    assert.equal(result.properties, sorted);
    assert.equal(result.diagnostics.applied, false);
});

test('adding an area window retains the existing twelve-stop door search for a branch inside one street run', async () => {
    const stops = Array.from({ length: 16 }, (_, i) => ({ id: String(i), lat: 35 + i / 100000, lng: -80,
        street_name: i < 8 ? 'First Branch' : 'Second Branch', locked: i < 2 || i > 13 }));
    const desired = [...stops];
    [desired[3], desired[4]] = [desired[4], desired[3]];
    const edges = new Set(desired.slice(1).map((p, i) => `${desired[i].id}>${p.id}`));
    const duration = (a, b) => edges.has(`${a.id}>${b.id}`) ? 1 : 60;
    const context = {
        accessFor: () => null,
        optimizationCostBetween: duration, distanceBetween: (a, b) => duration(a, b) / 1000,
        async routeSequence(sequence) {
            const directedLegs = sequence.slice(1).map((p, i) => ({ from: sequence[i].id, to: p.id,
                pathKey: `${sequence[i].id}>${p.id}`, driveSeconds: duration(sequence[i], p),
                distanceMiles: duration(sequence[i], p) / 1000 }));
            return { driveSeconds: directedLegs.reduce((s, leg) => s + leg.driveSeconds, 0),
                distanceMiles: directedLegs.reduce((s, leg) => s + leg.distanceMiles, 0), directedLegs };
        },
    };
    const result = await reviewLocalDrivingNeighborhoods(stops, { maxLocalStops: 12, maxAreaWindowStops: 12,
        maxLocalWindows: 1, createLocalDrivingContext: async () => context });
    assert.equal(result.diagnostics.areaReview.checked, 1);
    assert.equal(result.diagnostics.applied, true);
    assert.deepEqual(result.properties, desired);
});

test('applied area repairs identify neighborhood order and remaining verification in the product message', () => {
    const review = { applied: true, validation: 'whole_route', areaReview: { repaired: 1 },
        streetSideService: { mode: 'mail_carrier_right_curb', unknownStops: 0 } };
    const meta = { neighborhood_excursion_review: { local_driving_review: review } };
    assert.equal(describeAppliedRoadOptimization(meta).tone, 'success');
    assert.match(describeAppliedRoadOptimization(meta).message, /Neighborhood order improved/);
    review.streetSideService.unknownStops = 7;
    assert.equal(describeAppliedRoadOptimization(meta).tone, 'warning');
    assert.match(describeAppliedRoadOptimization(meta).message, /Some stops still need checking/);
});
