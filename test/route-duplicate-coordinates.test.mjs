/**
 * DUPCOORD — properties that SHARE one map coordinate must stay separate stops.
 *
 * The matrix accessor resolves a point to its matrix row by coordinate, so an
 * apartment stack, a duplex, two customer records at one address, or several
 * parcels snapped to a building centroid all collapse onto ONE matrix index. That
 * is correct for pricing — the driving cost between two doors at the same
 * coordinate really is the self-cost — but it must never collapse the ROUTE:
 * every unit is its own knock and has to appear in the order exactly once.
 *
 * Route membership is keyed on address_hash, never on coordinates, and these
 * tests pin that separation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatrixMetricFns } from '../base44/shared/roadMatrix.js';
import { roadAwareStreetSweep } from '../base44/shared/roadAwareStreetSweep.js';

// Three units in one building, a duplex sharing a parcel centroid, and two
// ordinary single-family doors down the same street.
const PROPERTIES = [
    { address_hash: 'apt-101', house_number: 100, street_name: 'Cedar St', unit_label: '101', lat: 35.2270, lng: -80.8430 },
    { address_hash: 'apt-102', house_number: 100, street_name: 'Cedar St', unit_label: '102', lat: 35.2270, lng: -80.8430 },
    { address_hash: 'apt-103', house_number: 100, street_name: 'Cedar St', unit_label: '103', lat: 35.2270, lng: -80.8430 },
    { address_hash: 'duplex-a', house_number: 104, street_name: 'Cedar St', unit_label: 'A', lat: 35.2274, lng: -80.8431 },
    { address_hash: 'duplex-b', house_number: 104, street_name: 'Cedar St', unit_label: 'B', lat: 35.2274, lng: -80.8431 },
    { address_hash: 'sfh-108', house_number: 108, street_name: 'Cedar St', lat: 35.2281, lng: -80.8433 },
    { address_hash: 'sfh-112', house_number: 112, street_name: 'Cedar St', lat: 35.2288, lng: -80.8436 }
];

/** Symmetric matrix where same-coordinate rows are genuinely zero-cost. */
function buildMatrix(points) {
    const rows = points.map((from) => points.map((to) => {
        const sameSpot = from.lat === to.lat && from.lng === to.lng;
        if (sameSpot) return 0;
        return Math.round(
            Math.hypot((from.lat - to.lat) * 364000, (from.lng - to.lng) * 288000)
        );
    }));
    return { distances: rows, durations: rows.map(row => row.map(meters => meters / 800)) };
}

function metricsFor(points) {
    return createMatrixMetricFns(points, buildMatrix(points));
}

test('DUPCOORD-01 every unit sharing a coordinate remains its own stop', () => {
    const metrics = metricsFor(PROPERTIES);
    const order = roadAwareStreetSweep(PROPERTIES, {
        distanceBetween: metrics.durationBetween
    });

    assert.equal(order.length, PROPERTIES.length, 'no unit may be dropped');
    assert.deepEqual(
        [...new Set(order.map(door => door.address_hash))].sort(),
        PROPERTIES.map(door => door.address_hash).sort(),
        'every address_hash must appear exactly once'
    );
    for (const hash of ['apt-101', 'apt-102', 'apt-103', 'duplex-a', 'duplex-b']) {
        assert.equal(
            order.filter(door => door.address_hash === hash).length,
            1,
            `${hash} must be knocked exactly once`
        );
    }
});

test('DUPCOORD-02 same-coordinate legs price as zero, never as unresolved', () => {
    const metrics = metricsFor(PROPERTIES);
    const [unitOne, unitTwo] = PROPERTIES;

    // A collapsed index must still return a finite cost. If it returned null the
    // candidate would be unpriceable and the whole route would fall back.
    assert.equal(metrics.durationBetween(unitOne, unitTwo), 0);
    assert.equal(metrics.distanceBetween(unitTwo, unitOne), 0);
    assert.ok(metrics.distanceBetween(unitOne, PROPERTIES[5]) > 0, 'distinct doors keep a real cost');
    assert.equal(metrics.unresolved.count, 0, 'shared coordinates must not count as unresolved legs');
});

test('DUPCOORD-03 units at one coordinate are visited back to back', () => {
    const metrics = metricsFor(PROPERTIES);
    const order = roadAwareStreetSweep(PROPERTIES, {
        distanceBetween: metrics.durationBetween
    });
    const positions = (hashes) => hashes
        .map(hash => order.findIndex(door => door.address_hash === hash))
        .sort((first, second) => first - second);

    // Zero-cost neighbours should never be split across the route: walking away
    // from a building and returning to it later is the regression to catch.
    for (const stack of [['apt-101', 'apt-102', 'apt-103'], ['duplex-a', 'duplex-b']]) {
        const indexes = positions(stack);
        assert.equal(
            indexes[indexes.length - 1] - indexes[0],
            stack.length - 1,
            `${stack.join('/')} must be consecutive stops, got ${JSON.stringify(indexes)}`
        );
    }
});

test('DUPCOORD-04 the order is deterministic regardless of input order', () => {
    const metrics = metricsFor(PROPERTIES);
    const options = { distanceBetween: metrics.durationBetween };
    const baseline = roadAwareStreetSweep(PROPERTIES, options)
        .map(door => door.address_hash).join('>');

    for (const variant of [[...PROPERTIES].reverse(), [...PROPERTIES].sort((a, b) => (a.address_hash > b.address_hash ? -1 : 1))]) {
        assert.equal(
            roadAwareStreetSweep(variant, options).map(door => door.address_hash).join('>'),
            baseline,
            'shared coordinates must not make the result depend on input order'
        );
    }
});