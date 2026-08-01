import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createServer } from 'vite';

// Verified Mesquite TX regression: the production optimizer built good street
// blocks but a single greedy start stranded an expensive group of blocks at the
// end of the route. Road distances and durations are baked into the fixture, so
// this test is offline, deterministic, and measures real driving rather than
// straight-line distance. The winning order is deliberately NOT hardcoded — the
// current production order is the baseline and the optimizer must beat it.

let vite;
let optimizeRouteByStreetSweep;
let fixture;

before(async () => {
    vite = await createServer({
        server: { middlewareMode: true },
        appType: 'custom',
        logLevel: 'silent',
    });
    ({ optimizeRouteByStreetSweep } = await vite.ssrLoadModule(
        '/src/components/logic/routeOptimizer.jsx',
    ));
    fixture = JSON.parse(await readFile(
        new URL('./fixtures/mesquite-route-58.json', import.meta.url),
        'utf8',
    ));
});

after(async () => {
    await vite?.close();
});

function matrixRoutingContext() {
    const indexByHash = new Map(fixture.properties.map((property, index) => [
        property.address_hash,
        index,
    ]));
    const indexOf = (point) => indexByHash.get(point?.address_hash);
    return {
        distanceBetween: (first, second) => {
            const from = indexOf(first);
            const to = indexOf(second);
            assert.ok(
                Number.isInteger(from) && Number.isInteger(to),
                'the fixture matrix must cover every routed point',
            );
            return fixture.road.distances[from][to];
        },
        durationBetween: (first, second) => (
            fixture.road.durationsMinutes[indexOf(first)][indexOf(second)]
        ),
    };
}

function measure(order) {
    const context = matrixRoutingContext();
    const legs = [];
    const durations = [];
    for (let index = 0; index < order.length - 1; index++) {
        legs.push(context.distanceBetween(order[index], order[index + 1]));
        durations.push(context.durationBetween(order[index], order[index + 1]));
    }
    const streets = order.map(({ street_name: street }) => street.toUpperCase());
    const transitions = streets.filter((street, index) => index > 0 && street !== streets[index - 1]).length;
    const lastSeen = new Map();
    let reentries = 0;
    streets.forEach((street, index) => {
        const previous = lastSeen.get(street);
        if (previous !== undefined && previous !== index - 1) reentries += 1;
        lastSeen.set(street, index);
    });
    const sum = values => values.reduce((total, value) => total + value, 0);
    return {
        roadMiles: sum(legs),
        driveMinutes: sum(durations),
        finalFourteenMiles: sum(legs.slice(-14)),
        longestLegMiles: Math.max(...legs),
        transitions,
        reentries,
    };
}

function byHash(hashes) {
    return hashes.map((hash) => {
        const property = fixture.properties.find(candidate => candidate.address_hash === hash);
        assert.ok(property, `fixture is missing ${hash}`);
        return property;
    });
}

function optimize(properties) {
    return optimizeRouteByStreetSweep(properties, null, null, matrixRoutingContext());
}

test('every Mesquite door is routed exactly once', () => {
    const optimized = optimize(fixture.properties);

    assert.equal(optimized.length, fixture.properties.length);
    assert.deepEqual(
        optimized.map(({ address_hash: hash }) => hash).sort(),
        fixture.properties.map(({ address_hash: hash }) => hash).sort(),
    );
});

test('Mesquite ordering is deterministic regardless of input order', () => {
    const shuffled = [...fixture.properties].sort((first, second) => (
        first.address_hash < second.address_hash ? 1 : -1
    ));

    const first = optimize(fixture.properties).map(({ address_hash: hash }) => hash);
    const second = optimize(fixture.properties).map(({ address_hash: hash }) => hash);
    const third = optimize(shuffled).map(({ address_hash: hash }) => hash);

    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
});

test('Mesquite ordering beats the production route on real road travel', () => {
    const baseline = measure(byHash(fixture.orders.production));
    const improved = measure(optimize(fixture.properties));

    assert.ok(
        improved.roadMiles < baseline.roadMiles,
        `road distance regressed: ${improved.roadMiles.toFixed(3)} mi vs baseline ${baseline.roadMiles.toFixed(3)} mi`,
    );
    assert.ok(
        improved.driveMinutes < baseline.driveMinutes,
        `drive time regressed: ${improved.driveMinutes.toFixed(1)} min vs baseline ${baseline.driveMinutes.toFixed(1)} min`,
    );
});

test('Mesquite ordering repairs the stranded final stretch', () => {
    const baseline = measure(byHash(fixture.orders.production));
    const improved = measure(optimize(fixture.properties));

    assert.ok(
        improved.finalFourteenMiles < baseline.finalFourteenMiles,
        `final 14 legs regressed: ${improved.finalFourteenMiles.toFixed(3)} mi vs baseline ${baseline.finalFourteenMiles.toFixed(3)} mi`,
    );
    assert.ok(
        improved.longestLegMiles <= baseline.longestLegMiles + 0.001,
        `longest road leg regressed: ${improved.longestLegMiles.toFixed(3)} mi vs baseline ${baseline.longestLegMiles.toFixed(3)} mi`,
    );
});

test('Mesquite ordering keeps the production route street continuity', () => {
    const baseline = measure(byHash(fixture.orders.production));
    const improved = measure(optimize(fixture.properties));

    assert.ok(
        improved.transitions <= baseline.transitions,
        `street transitions regressed: ${improved.transitions} vs baseline ${baseline.transitions}`,
    );
    assert.ok(
        improved.reentries <= baseline.reentries,
        `street reentries regressed: ${improved.reentries} vs baseline ${baseline.reentries}`,
    );
});