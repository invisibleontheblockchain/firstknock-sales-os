import test from 'node:test';
import assert from 'node:assert/strict';

import {
    calculateRouteDistanceMiles,
    haversineDistanceMiles,
    isValidRoutePoint,
    optimizeRouteWithBounds,
} from '../src/lib/routeBounds.js';

const stop = (id, lat, lng) => ({ id, lat, lng });

test('keeps the default route open and returns only the original doors', () => {
    const doors = [
        stop('a', 34, -82),
        stop('c', 34, -81.98),
        stop('b', 34, -81.99),
    ];
    const originalOrder = doors.map(({ id }) => id);

    const optimized = optimizeRouteWithBounds(doors);

    assert.deepEqual(optimized.map(({ id }) => id), ['a', 'b', 'c']);
    assert.deepEqual(doors.map(({ id }) => id), originalOrder);
    assert.equal(optimized.length, doors.length);
    assert.ok(calculateRouteDistanceMiles(optimized) > 0);
});

test('optimizes a home round trip without inserting home as a door', () => {
    const home = { lat: 34, lng: -82, address: 'Home' };
    const doors = [
        stop('east', 34, -81.98),
        stop('near', 34, -81.995),
        stop('north', 34.01, -82),
    ];

    const optimized = optimizeRouteWithBounds(doors, {
        startLocation: home,
        returnToStart: true,
    });
    const distance = calculateRouteDistanceMiles(optimized, {
        startLocation: home,
        returnToStart: true,
    });
    const expected = haversineDistanceMiles(home, optimized[0])
        + haversineDistanceMiles(optimized[0], optimized[1])
        + haversineDistanceMiles(optimized[1], optimized[2])
        + haversineDistanceMiles(optimized[2], home);

    assert.equal(optimized.length, doors.length);
    assert.ok(optimized.every((door) => door !== home));
    assert.ok(Math.abs(distance - expected) < 1e-9);
});

test('anchors a current-location start and a distinct home destination', () => {
    const currentLocation = { lat: 34, lng: -82.02 };
    const home = { lat: 34, lng: -81.97 };
    const doors = [
        stop('near-home', 34, -81.975),
        stop('middle', 34, -81.995),
        stop('near-current', 34, -82.015),
    ];

    const optimized = optimizeRouteWithBounds(doors, {
        startLocation: currentLocation,
        endLocation: home,
    });

    assert.deepEqual(optimized.map(({ id }) => id), ['near-current', 'middle', 'near-home']);
    assert.ok(calculateRouteDistanceMiles(optimized, {
        startLocation: currentLocation,
        endLocation: home,
    }) > calculateRouteDistanceMiles(optimized));
});

test('validates coordinates and rejects invalid doors or requested bounds', () => {
    assert.equal(isValidRoutePoint({ lat: 0, lng: 0 }), true);
    assert.equal(isValidRoutePoint({ lat: '34.5', lng: '-82.6' }), true);
    assert.equal(isValidRoutePoint({ lat: 91, lng: 0 }), false);
    assert.equal(isValidRoutePoint({ lat: 0, lng: -181 }), false);
    assert.equal(isValidRoutePoint({ lat: Number.NaN, lng: 0 }), false);
    assert.equal(isValidRoutePoint(null), false);

    assert.throws(
        () => optimizeRouteWithBounds([stop('valid', 34, -82)], { startLocation: { lat: 34 } }),
        /startLocation/,
    );
    assert.throws(
        () => optimizeRouteWithBounds([stop('invalid', 100, -82)]),
        /stops\[0\]/,
    );
    assert.throws(
        () => calculateRouteDistanceMiles([stop('valid', 34, -82)], { returnToStart: true }),
        /requires a valid startLocation/,
    );
});

test('fixed endpoint 2-opt improves an endpoint-aware route', () => {
    const startLocation = { lat: 0, lng: 0 };
    const endLocation = { lat: 0, lng: 5 };
    const doors = [
        stop('a', -2, 1),
        stop('b', -2, 2),
        stop('c', -2, 3),
        stop('d', -2, 4),
        stop('e', -1, 2),
    ];
    const nearestNeighborOnly = optimizeRouteWithBounds(doors, {
        startLocation,
        endLocation,
        max2OptPasses: 0,
    });
    const endpointAware = optimizeRouteWithBounds(doors, {
        startLocation,
        endLocation,
    });

    const baselineDistance = calculateRouteDistanceMiles(nearestNeighborOnly, { startLocation, endLocation });
    const optimizedDistance = calculateRouteDistanceMiles(endpointAware, { startLocation, endLocation });

    assert.ok(optimizedDistance < baselineDistance);
    assert.deepEqual(nearestNeighborOnly.map(({ id }) => id), ['a', 'b', 'c', 'e', 'd']);
    assert.deepEqual(endpointAware.map(({ id }) => id), ['a', 'b', 'e', 'c', 'd']);
    assert.equal(endpointAware[0].id, 'a');
    assert.equal(endpointAware.at(-1).id, 'd');
});

test('large bounded routes still reserve a final door near the fixed finish when 2-opt is capped', () => {
    const startLocation = { lat: 34, lng: -82.02 };
    const endLocation = { lat: 34, lng: -81.97 };
    const doors = Array.from({ length: 350 }, (_, index) => stop(
        `door-${index}`,
        34 + (index % 7) * 0.00001,
        -82.015 + index * 0.0001,
    ));

    const optimized = optimizeRouteWithBounds(doors, { startLocation, endLocation });
    const closestToFinish = [...doors].sort(
        (left, right) => haversineDistanceMiles(left, endLocation) - haversineDistanceMiles(right, endLocation),
    )[0];

    assert.equal(optimized.length, doors.length);
    assert.equal(optimized.at(-1).id, closestToFinish.id);
});
