// Hotspot repair must be judged on an independent measurement of the drive, must
// preserve exact-once, and must refuse to act when it cannot measure.

import assert from 'node:assert/strict';
import test from 'node:test';

import { repairWorstTransitions } from '../base44/shared/roadHotspotRepair.js';

const key = (point) => `${Number(point.lat).toFixed(6)},${Number(point.lng).toFixed(6)}`;

/** Cheap along a street, expensive to cross between streets. */
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

/** Stand-in for OSRM /route: the same network, measured leg by leg. */
const fakeMeasure = async (order) => {
    if (order.length < 2) return { ok: false, error: 'too short' };
    const legMiles = order.slice(1).map((point, index) => roadDistance(order[index], point));
    const { summarizeLegMiles } = await import('../base44/shared/roadLegDistribution.js');
    return {
        ok: true,
        legMiles,
        totalMiles: legMiles.reduce((total, miles) => total + miles, 0),
        longestLegMiles: Math.max(...legMiles),
        longestLegIndex: legMiles.indexOf(Math.max(...legMiles)),
        legDistribution: summarizeLegMiles(legMiles),
        geometry: [],
        requestCount: 1
    };
};

/** Two streets interleaved in the middle of the order, where no seam exists. */
function orderWithMidRouteHotspot() {
    const doors = [];
    for (let step = 0; step < 8; step += 1) doors.push({ lat: 35, lng: -80 + step * 0.001 });
    for (let step = 0; step < 8; step += 1) {
        doors.push({ lat: 36, lng: -80 + step * 0.001 });
        doors.push({ lat: 35, lng: -79.99 + step * 0.001 });
    }
    for (let step = 0; step < 8; step += 1) doors.push({ lat: 36, lng: -79.99 + step * 0.001 });
    return doors;
}

const total = async (order) => (await fakeMeasure(order)).totalMiles;

test('a mid-window hotspot is found and repaired on measured miles', async () => {
    const order = orderWithMidRouteHotspot();
    const before = await total(order);
    const result = await repairWorstTransitions(order, {
        measurePath: fakeMeasure,
        fetchMatrix: fakeMatrix
    });
    assert.equal(result.telemetry.hotspot_rounds_accepted, 1);
    assert.ok(result.telemetry.hotspot_miles_saved > 0);
    assert.ok(await total(result.order) < before, 'the drive must get shorter');
});

test('repair preserves exact-once membership', async () => {
    const order = orderWithMidRouteHotspot();
    const result = await repairWorstTransitions(order, {
        measurePath: fakeMeasure,
        fetchMatrix: fakeMatrix
    });
    assert.equal(result.order.length, order.length);
    assert.deepEqual(result.order.map(key).sort(), order.map(key).sort());
});

test('an unmeasurable baseline skips the layer instead of repairing blind', async () => {
    const order = orderWithMidRouteHotspot();
    const result = await repairWorstTransitions(order, {
        measurePath: async () => ({ ok: false, error: 'OSRM down' }),
        fetchMatrix: fakeMatrix
    });
    assert.match(result.telemetry.hotspot_skipped_reason, /baseline_unmeasured/);
    assert.equal(result.telemetry.hotspot_candidates_examined, 0);
    assert.deepEqual(result.order.map(key), order.map(key));
});

test('a round is dropped when re-measurement does not confirm the gain', async () => {
    const order = orderWithMidRouteHotspot();
    let call = 0;
    // First measurement establishes the baseline; the verification claims the
    // route got longer, so the repair must be discarded despite local gains.
    const lyingMeasure = async (candidate) => {
        call += 1;
        const measured = await fakeMeasure(candidate);
        return call === 1 ? measured : { ...measured, totalMiles: measured.totalMiles + 100 };
    };
    const result = await repairWorstTransitions(order, {
        measurePath: lyingMeasure,
        fetchMatrix: fakeMatrix
    });
    assert.equal(result.telemetry.hotspot_rounds_accepted, 0);
    assert.equal(result.telemetry.hotspot_miles_saved, 0);
    assert.deepEqual(result.order.map(key), order.map(key), 'unverified gains are not applied');
});

test('a route with nothing worth repairing is returned untouched', async () => {
    const clean = Array.from({ length: 20 }, (_, step) => ({ lat: 35, lng: -80 + step * 0.001 }));
    const result = await repairWorstTransitions(clean, {
        measurePath: fakeMeasure,
        fetchMatrix: fakeMatrix
    });
    assert.equal(result.telemetry.hotspot_rounds_accepted, 0);
    assert.deepEqual(result.order.map(key), clean.map(key));
});

test('a too-short route is skipped explicitly', async () => {
    const result = await repairWorstTransitions([{ lat: 35, lng: -80 }, { lat: 35, lng: -79 }], {
        measurePath: fakeMeasure,
        fetchMatrix: fakeMatrix
    });
    assert.equal(result.telemetry.hotspot_skipped_reason, 'route_too_short');
});