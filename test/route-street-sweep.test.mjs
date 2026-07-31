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

function groupRuns(properties, getGroup) {
    return properties
        .map(getGroup)
        .filter((group, index, groups) => (
            group && (index === 0 || group !== groups[index - 1])
        ));
}

function assertAccessGroupsAreContiguous(properties) {
    const runs = groupRuns(properties, property => property.access);
    assert.equal(
        new Set(runs).size,
        runs.length,
        `an access group was exited and re-entered: ${runs.join(' -> ')}`,
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

    // Only one even-side door, so the street is walked straight through instead
    // of passing 102 on the way out and doubling back for it.
    assert.deepEqual(optimized.map(({ id }) => id), ['A101', 'A102', 'A103']);
    assertEveryStreetIsContiguous(optimized);
    assertSameDoors(optimized, doors);
});

test('a sparsely covered street is walked straight through without doubling back', () => {
    // Reported Anderson case: two odd doors deep in the neighborhood with a
    // single even door physically between them.
    const doors = [
        property('FAR_ODD', 'Fairmont Rd', 535, -82.617515, 34.510632),
        property('FAR_ODD_2', 'Fairmont Rd', 641, -82.620100, 34.512600),
        property('MIDDLE_EVEN', 'Fairmont Rd', 620, -82.618870, 34.511637),
    ];

    const optimized = optimizeRouteByStreetSweep(
        doors,
        { lat: 34.500619, lng: -82.611223 },
    );

    assert.deepEqual(
        optimized.map(({ id }) => id),
        ['FAR_ODD', 'MIDDLE_EVEN', 'FAR_ODD_2'],
    );
    assertSameDoors(optimized, doors);
});

test('a densely covered street still walks one side out and the other side back', () => {
    const doors = [
        property('O101', 'Dense St', 101, 0, 33.4500),
        property('O103', 'Dense St', 103, 0.0005, 33.4500),
        property('O105', 'Dense St', 105, 0.0010, 33.4500),
        property('E102', 'Dense St', 102, 0, 33.4520),
        property('E104', 'Dense St', 104, 0.0005, 33.4520),
        property('E106', 'Dense St', 106, 0.0010, 33.4520),
    ];

    const optimized = optimizeRouteByStreetSweep(doors, { lat: 33.45, lng: -0.001 });
    const houseNumbers = optimized.map(({ house_number: number }) => number);

    assert.ok(
        JSON.stringify(houseNumbers) === JSON.stringify([101, 103, 105, 106, 104, 102])
        || JSON.stringify(houseNumbers) === JSON.stringify([102, 104, 106, 105, 103, 101]),
        `expected a one-side-out, other-side-back sweep, got ${houseNumbers.join(', ')}`,
    );
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

test('canonical street suffixes do not collapse Oak Drive and Oak Lane together', () => {
    const doors = [
        property('DR1', 'Oak Drive', 101, -112.010),
        property('LN1', 'Oak Lane', 103, -112.009),
        property('DR2', 'Oak Dr.', 105, -112.008),
        property('LN2', 'Oak Ln', 107, -112.007),
    ];

    const optimized = optimizeRouteByStreetSweep(doors, { lat: 33.45, lng: -112.011 });
    const canonicalRuns = groupRuns(
        optimized,
        ({ street_name: street }) => street.replace(/\.$/, '').replace(/Drive$/i, 'Dr').replace(/Lane$/i, 'Ln'),
    );

    assert.deepEqual(new Set(canonicalRuns), new Set(['Oak Dr', 'Oak Ln']));
    assert.equal(canonicalRuns.length, 2);
    assertSameDoors(optimized, doors);
});

const accessRoutingContext = {
    streetSegmentKey: property => property.segment,
    accessGroupKey: property => property.access,
    distanceBetween: (first, second) => {
        if (Number.isFinite(first.networkPosition) && Number.isFinite(second.networkPosition)) {
            return Math.abs(first.networkPosition - second.networkPosition);
        }
        return Math.abs(first.lng - second.lng);
    },
};

function contextualProperty(
    id,
    street,
    houseNumber,
    lng,
    networkPosition,
    segment,
    access,
    zipCode = '85001',
) {
    return {
        ...property(id, street, houseNumber, lng),
        networkPosition,
        segment,
        access,
        zip_code: zipCode,
    };
}

const devinAccessFixture = [
    contextualProperty('ENTRY1', 'Gateway Way', 101, -112.00, 0.0, 'gateway', 'NEIGHBORHOOD_A'),
    contextualProperty('ENTRY2', 'Gateway Way', 103, -111.95, 0.1, 'gateway', 'NEIGHBORHOOD_A'),
    contextualProperty('DEAD1', 'Separate Court', 201, -111.00, 5.0, 'dead_end', 'DEAD_END_B'),
    contextualProperty('DEAD2', 'Separate Court', 203, -110.95, 5.1, 'dead_end', 'DEAD_END_B'),
    contextualProperty('DEEP1', 'Interior Loop', 301, -110.00, 0.2, 'interior', 'NEIGHBORHOOD_A'),
    contextualProperty('DEEP2', 'Interior Loop', 303, -109.95, 0.3, 'interior', 'NEIGHBORHOOD_A'),
];

test('shared access topology prevents the Devin-style enter, exit, and re-enter loop', () => {
    const start = { lat: 33.45, lng: -112.10, networkPosition: -0.1 };
    const end = { lat: 33.45, lng: -109.90, networkPosition: 5.2 };

    const aerialOnly = optimizeRouteByDistance(devinAccessFixture, start, end);
    assert.deepEqual(groupRuns(aerialOnly, door => door.access), [
        'NEIGHBORHOOD_A',
        'DEAD_END_B',
        'NEIGHBORHOOD_A',
    ]);

    const permutations = [
        devinAccessFixture,
        [...devinAccessFixture].reverse(),
        [...devinAccessFixture.slice(2), ...devinAccessFixture.slice(0, 2)],
        [
            devinAccessFixture[4],
            devinAccessFixture[0],
            devinAccessFixture[2],
            devinAccessFixture[5],
            devinAccessFixture[1],
            devinAccessFixture[3],
        ],
    ];
    let expectedOrder;
    permutations.forEach((doors) => {
        const optimized = optimizeRouteByStreetSweep(
            doors,
            start,
            end,
            accessRoutingContext,
        );
        assertAccessGroupsAreContiguous(optimized);
        assertEveryStreetIsContiguous(optimized);
        assertSameDoors(optimized, devinAccessFixture);
        expectedOrder ||= optimized.map(({ id }) => id);
        assert.deepEqual(optimized.map(({ id }) => id), expectedOrder);
    });
});

test('a context street segment stays whole across city or ZIP boundaries', () => {
    const doors = [
        contextualProperty('TRUNK1', 'Boundary Road', 101, 0, 0, 'road-segment-7', '', '85001'),
        contextualProperty('OTHER', 'Middle Court', 201, 1, 1, 'middle-segment', '', '85002'),
        contextualProperty('TRUNK2', 'Boundary Rd', 103, 2, 2, 'road-segment-7', '', '85003'),
    ];
    doors[2].city = 'Tempe';

    const optimized = optimizeRouteByStreetSweep(
        doors,
        { lat: 33.45, lng: -0.1, networkPosition: -0.1 },
        { lat: 33.45, lng: 2.1, networkPosition: 2.1 },
        accessRoutingContext,
    );
    const canonicalRuns = groupRuns(
        optimized,
        ({ street_name: street }) => street.replace(/Road$/i, 'Rd'),
    );

    assert.equal(canonicalRuns.filter(street => street === 'Boundary Rd').length, 1);
    assertSameDoors(optimized, doors);
});

test('initial generation chunks at access and street boundaries without dropping doors', () => {
    const additionalDoors = [
        contextualProperty('NEXT1', 'Next Street', 401, -109.00, 6.0, 'next', 'NEIGHBORHOOD_C'),
        contextualProperty('NEXT2', 'Next Street', 403, -108.95, 6.1, 'next', 'NEIGHBORHOOD_C'),
    ];
    const doors = [...devinAccessFixture, ...additionalDoors];
    const routes = generateOptimizedRoutes(
        doors,
        4,
        { lat: 33.45, lng: -112.1, networkPosition: -0.1 },
        [],
        {
            routeOriginMode: 'current_to_home',
            endLocation: { lat: 33.45, lng: -108.9, networkPosition: 6.2 },
            maxRouteDistance: 0.00001,
        },
        null,
        accessRoutingContext,
    );
    const generatedDoors = routes.flatMap(route => route.properties);

    assert.equal(routes.length, 2);
    assert.ok(routes.every(route => route.houseCount <= 4));
    assertSameDoors(generatedDoors, doors);
    assert.equal(new Set(generatedDoors.map(({ id }) => id)).size, doors.length);
    assert.equal(
        new Set(
            routes
                .filter(route => route.properties.some(door => door.access === 'NEIGHBORHOOD_A'))
                .map(route => route.id),
        ).size,
        1,
        'the four-door access group should remain in one generated route',
    );
});

test('initial, manager, and rep optimization keep whole streets contiguous', async () => {
    const homeSource = await readFile(
        new URL('../src/pages/Home.jsx', import.meta.url),
        'utf8',
    );
    const repSource = await readFile(
        new URL('../src/pages/RepHome.jsx', import.meta.url),
        'utf8',
    );
    const optimizerSource = await readFile(
        new URL('../src/components/logic/routeOptimizer.jsx', import.meta.url),
        'utf8',
    );

    assert.match(
        homeSource,
        /import\s*\{[\s\S]*?generateOptimizedRoutes,[\s\S]*?optimizeRouteByStreetSweep,[\s\S]*?\}\s*from '\.\.\/components\/logic\/routeOptimizer'/,
    );
    assert.doesNotMatch(homeSource, /optimizeRouteByDistance/);
    assert.match(
        homeSource,
        /const routingContext = createRouteContinuityContext\(routeProperties\);[\s\S]*const optimized = optimizeRouteByStreetSweep\(routeProperties, start, end, routingContext\);/,
    );
    assert.doesNotMatch(
        homeSource,
        /\bcreateRouteRoadContext\b/,
        'manager optimization must not wait on live road loading',
    );
    assert.match(
        homeSource,
        /function requireUsableRouteContext\(routingContext\)[\s\S]*\['full', 'cost-only', 'fallback'\][\s\S]*No routes were changed/,
    );
    assert.equal(
        (homeSource.match(/requireUsableRouteContext\(routingContext\);/g) || []).length,
        3,
        'initial generation, reorder, and manager Optimize must validate both road-aware and continuity contexts',
    );
    assert.doesNotMatch(
        homeSource,
        /Road-aware ordering is unavailable/,
        'temporary road-source failures must never disable route optimization',
    );
    assert.doesNotMatch(
        homeSource,
        /discloseRouteContinuityFallback|Live (?:street|road) data was unavailable|Every eligible home was preserved/,
        'intentional manager continuity must not show an unavailable-live-road warning',
    );
    assert.doesNotMatch(
        homeSource,
        /discloseLargeRouteContinuityFallback|Live road-network ordering is unavailable at this size/,
        'large-route synchronous continuity must not be presented as an unavailable-live-road warning',
    );
    assert.doesNotMatch(
        homeSource,
        /discloseRoadCostFallback|discloseExternalBoundRoadFallback|live road connections were incomplete/,
        'offline manager routing must not retain dormant live-road warning paths',
    );
    assert.match(
        homeSource,
        /buildPersistedRoadRoutingMetadata\(\s*routingContext,\s*null,\s*appliedHashes\s*\)[\s\S]*SavedRoute\.update\(route\.id, routeUpdate\)/,
    );
    assert.match(
        homeSource,
        /sourceGeometryMatchesSavedOrder[\s\S]*if \(!sourceGeometryMatchesSavedOrder\) \{[\s\S]*delete safeRouteMetadata\.road_geometry;[\s\S]*delete safeRouteMetadata\.routing;/,
    );
    assert.match(
        homeSource,
        /optimizeSuccessMessage[\s\S]*street-continuity estimate/,
    );
    assert.match(
        homeSource,
        /Re-optimize error:[\s\S]*e\?\.message \|\| 'Failed to re-optimize route\. The existing route was left unchanged\.'/,
    );
    assert.doesNotMatch(homeSource, /optimizeRouteByStreetSweep\(route\.properties \|\| \[\], null, null\)/);
    assert.match(
        optimizerSource,
        /function assertExactRouteMembership\(expectedProperties, routes\)[\s\S]*routedKeys\.length !== expectedKeys\.length[\s\S]*routedKeys\.some\(key => !expectedSet\.has\(key\)\)[\s\S]*assertExactRouteMembership\(eligible, routes\);/,
        'all client route sizes must fail before saving if a home is dropped or duplicated',
    );
    assert.match(repSource, /import \{ optimizeRouteByStreetSweep \} from '@\/components\/logic\/routeOptimizer'/);
    assert.match(
        repSource,
        /const routingContext = createRouteContinuityContext\(routeProperties\);[\s\S]*const optimized = optimizeRouteByStreetSweep\([\s\S]*routeProperties,[\s\S]*exactHomeBase,[\s\S]*exactHomeBase,[\s\S]*routingContext/,
    );
    assert.doesNotMatch(
        repSource,
        /\bcreateRouteRoadContext\b/,
        'rep optimization must not wait on live road loading',
    );
    assert.doesNotMatch(
        repSource,
        /discloseRouteContinuityFallback|Live (?:street|road) data was unavailable|Every eligible home was preserved/,
        'intentional rep continuity must not show an unavailable-live-road warning',
    );
    assert.match(
        repSource,
        /Home round trip optimized[\s\S]*street-continuity estimate/,
    );
    assert.match(
        repSource,
        /requireUsableRouteContext\(routingContext\);[\s\S]*buildPersistedRoadRoutingMetadata\(routingContext, null, propertyHashes\)[\s\S]*SavedRoute\.update\(routeToOptimize\.id, routeUpdate\)/,
    );
    assert.doesNotMatch(
        repSource,
        /discloseRoadCostFallback|discloseExternalBoundRoadFallback|live road connections were incomplete/,
        'offline rep routing must not retain dormant live-road warning paths',
    );
    assert.doesNotMatch(repSource, /optimizeRouteWithBounds/);
});