// Seam repair must be incapable of making a route worse, losing a door, or
// repairing a boundary on a distance it could not measure.

import assert from 'node:assert/strict';
import test from 'node:test';

import { refineWindowSeams } from '../base44/shared/roadSeamRefinement.js';

const key = (point) => `${Number(point.lat).toFixed(6)},${Number(point.lng).toFixed(6)}`;

/**
 * A road network where one street is cheap to drive along and crossing between
 * the two streets is expensive — so a boundary that interleaves them is
 * repairable, and the repair is measurable.
 */
function roadDistance(from, to) {
    const sameStreet = Math.abs(Number(from.lat) - Number(to.lat)) < 1e-9;
    const along = Math.abs(Number(from.lng) - Number(to.lng)) * 50;
    return sameStreet ? along : along + 5;
}

const fakeMatrix = async (points) => ({
    distances: points.map((from) => points.map((to) => roadDistance(from, to))),
    durations: null,
    objective: 'distance_miles',
    snapped: points.length,
    source: 'test',
    blocks: 1,
    pointCount: points.length
});

/** Two parallel streets, deliberately interleaved across the boundary. */
function interleavedOrder() {
    const doors = [];
    for (let step = 0; step < 12; step += 1) {
        doors.push({ lat: 35, lng: -80 + step * 0.001, address: `${step} A St` });
        doors.push({ lat: 36, lng: -80 + step * 0.001, address: `${step} B St` });
    }
    return doors;
}

const pathCost = (order) => order.slice(1).reduce(
    (total, point, index) => total + roadDistance(order[index], point),
    0
);

test('seam repair never returns a longer route than it was given', async () => {
    const order = interleavedOrder();
    const before = pathCost(order);
    const result = await refineWindowSeams(order, [12], { fetchMatrix: fakeMatrix });
    assert.ok(pathCost(result.order) <= before + 1e-9, 'repair must not increase measured road cost');
    assert.equal(result.telemetry.seams_examined > 0, true);
});

test('seam repair improves an interleaved boundary and reports the miles', async () => {
    const order = interleavedOrder();
    const result = await refineWindowSeams(order, [12], { fetchMatrix: fakeMatrix });
    assert.equal(result.telemetry.seams_improved > 0, true);
    assert.ok(result.telemetry.seam_miles_saved > 0, 'an accepted repair must report saved miles');
    assert.ok(pathCost(result.order) < pathCost(order), 'accepted repair must shorten the route');
});

test('seam repair preserves exact-once membership', async () => {
    const order = interleavedOrder();
    const result = await refineWindowSeams(order, [12], { fetchMatrix: fakeMatrix });
    assert.equal(result.order.length, order.length);
    assert.deepEqual(
        result.order.map(key).sort(),
        order.map(key).sort(),
        'every door in, every door out, exactly once'
    );
});

test('an unresolvable seam matrix is skipped, never guessed', async () => {
    const order = interleavedOrder();
    const failing = async () => { throw new Error('OSRM unavailable'); };
    const result = await refineWindowSeams(order, [12], { fetchMatrix: failing });
    assert.equal(result.telemetry.seams_skipped_unresolved > 0, true);
    assert.equal(result.telemetry.seams_improved, 0);
    assert.deepEqual(result.order.map(key), order.map(key), 'order must be untouched');
});

test('a boundary with no available gain is rejected rather than churned', async () => {
    // Already street-separated: nothing for the repair to win.
    const clean = [
        ...Array.from({ length: 10 }, (_, step) => ({ lat: 35, lng: -80 + step * 0.001 })),
        ...Array.from({ length: 10 }, (_, step) => ({ lat: 36, lng: -80 + (9 - step) * 0.001 }))
    ];
    const result = await refineWindowSeams(clean, [10], { fetchMatrix: fakeMatrix });
    assert.equal(result.telemetry.seams_improved, 0);
    // One rejection per neighbourhood-width pass over this boundary.
    assert.equal(
        result.telemetry.seams_rejected_no_gain,
        result.telemetry.seam_passes.split(',').length
    );
    assert.deepEqual(result.order.map(key), clean.map(key));
});

test('passes are reported so the neighbourhood widths used are auditable', async () => {
    const result = await refineWindowSeams(interleavedOrder(), [12], { fetchMatrix: fakeMatrix });
    assert.equal(typeof result.telemetry.seam_passes, 'string');
    assert.ok(result.telemetry.seam_passes.length > 0);
});