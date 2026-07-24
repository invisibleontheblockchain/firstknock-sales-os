import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createServer } from 'vite';

let vite;
let generateOptimizedRoutes;
let optimizeRouteByDistance;
let optimizeRouteByStreetSweep;

before(async () => {
    vite = await createServer({
        server: { middlewareMode: true },
        appType: 'custom',
        logLevel: 'silent',
    });
    const optimizer = await vite.ssrLoadModule('/src/components/logic/routeOptimizer.jsx');
    ({
        generateOptimizedRoutes,
        optimizeRouteByDistance,
        optimizeRouteByStreetSweep,
    } = optimizer);
});

after(async () => {
    await vite?.close();
});

function property(id, street, houseNumber, lng, lat = 33.45) {
    return {
        id,
        address_hash: id,
        street_name: street,
        house_number: houseNumber,
        city: 'Phoenix',
        zip_code: '85001',
        lat,
        lng,
        effective_status: 'ELIGIBLE',
        price: 350000,
    };
}

function streetRuns(properties) {
    return properties
        .map(({ street_name: street }) => street)
        .filter((street, index, streets) => index === 0 || street !== streets[index - 1]);
}

function assertEveryStreetIsContiguous(properties) {
    const runs = streetRuns(properties);
    assert.equal(
        new Set(runs).size,
        runs.length,
        `a street was revisited after leaving it: ${runs.join(' -> ')}`,
    );
}

function assertSameDoors(actual, expected) {
    assert.deepEqual(
        actual.map(({ id }) => id).sort(),
        expected.map(({ id }) => id).sort(),
    );
}

const reportedLoopFixture = [
    property('A1', 'Alpha St', 101, -112.010),
    property('A2', 'Alpha St', 103, -112.008),
    property('A3', 'Alpha St', 105, -112.006),
    property('A4', 'Alpha St', 102, -112.004),
    property('A5', 'Alpha St', 104, -112.002),
    property('A6', 'Alpha St', 106, -112.000),
    property('B1', 'Beta St', 201, -112.005, 33.45001),
];

test('street sweep prevents the reported Alpha -> Beta -> Alpha loop', () => {
    const start = { lat: 33.45, lng: -112.011 };

    const pointwise = optimizeRouteByDistance(reportedLoopFixture, start);
    assert.deepEqual(streetRuns(pointwise), ['Alpha St', 'Beta St', 'Alpha St']);

    const swept = optimizeRouteByStreetSweep(reportedLoopFixture, start);
    assertEveryStreetIsContiguous(swept);
    assertSameDoors(swept, reportedLoopFixture);
    assert.deepEqual(streetRuns(swept), ['Alpha St', 'Beta St']);
});

test('generated routes keep street blocks intact after scoring and bounded optimization', () => {
    const start = { lat: 33.45, lng: -112.011 };
    const end = { lat: 33.45, lng: -111.999 };
    const routes = generateOptimizedRoutes(
        reportedLoopFixture,
        50,
        start,
        [],
        {
            routeOriginMode: 'current_to_home',
            endLocation: end,
        },
    );

    assert.equal(routes.length, 1);
    assertEveryStreetIsContiguous(routes[0].properties);
    assertSameDoors(routes[0].properties, reportedLoopFixture);
});

test('a fixed start and finish select the best orientation of one complete street sweep', () => {
    const doors = [
        property('A101', 'Alpha St', 101, 1, 0),
        property('A103', 'Alpha St', 103, 2, 0),
        property('A102', 'Alpha St', 102, 1.2, 0),
    ];

    const optimized = optimizeRouteByStreetSweep(
        doors,
        { lat: 0, lng: 0 },
        { lat: 0, lng: 3 },
    );

    assert.deepEqual(optimized.map(({ id }) => id), ['A101', 'A103', 'A102']);
    assertEveryStreetIsContiguous(optimized);
    assertSameDoors(optimized, doors);
});

test('a geographically wide street remains one block instead of being split by clustering', () => {
    const alpha = Array.from({ length: 30 }, (_, index) => property(
        `A${index}`,
        'Longview Ave',
        101 + index,
        -112.08 + index * 0.006,
        33.45 + (index % 2) * 0.00001,
    ));
    const beta = [
        property('B1', 'Crosscut Rd', 201, -112.075, 33.45002),
        property('B2', 'Crosscut Rd', 203, -112.025, 33.45002),
        property('B3', 'Crosscut Rd', 205, -111.975, 33.45002),
        property('B4', 'Crosscut Rd', 207, -111.925, 33.45002),
    ];
    const doors = [...alpha, ...beta];

    const optimized = optimizeRouteByStreetSweep(
        doors,
        { lat: 33.45, lng: -112.09 },
        { lat: 33.45, lng: -111.90 },
    );

    assertEveryStreetIsContiguous(optimized);
    assertSameDoors(optimized, doors);
    assert.equal(streetRuns(optimized).filter((street) => street === 'Longview Ave').length, 1);
});

test('Home uses street-sweep optimization for saved and re-optimized routes', async () => {
    const source = await readFile(
        new URL('../src/pages/Home.jsx', import.meta.url),
        'utf8',
    );

    assert.match(
        source,
        /import\s*\{\s*generateOptimizedRoutes,\s*optimizeRouteByStreetSweep\s*\}/,
    );
    assert.doesNotMatch(source, /optimizeRouteByDistance/);
    assert.match(
        source,
        /const optimized = optimizeRouteByStreetSweep\(routeProperties, start, end\);/,
    );
    assert.match(
        source,
        /optimizeRouteByStreetSweep\(route\.properties \|\| \[\], null, null\)/,
    );
});
