import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createVehicleRoutingContext, finalizeVehicleRoute, vehicleWaypoint } from '../base44/shared/vehicleRouting.js';
import { createRoadNetworkRoutingContext } from '../base44/shared/roadNetworkRouting.js';
import { chooseStreetVariants, streetSideVariants, STREET_SIDE_POLICY, crossingPreferenceMeters } from '../base44/shared/streetSideRouting.js';
import { routePropertyOrderFingerprint } from '../base44/shared/routeFingerprint.js';

let vite, optimizer, service;
before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
    optimizer = await vite.ssrLoadModule('/src/components/logic/routeOptimizer.jsx');
    service = await vite.ssrLoadModule('/src/components/logic/routeRoadContext.js');
});
after(async () => { await vite?.close(); });
const stop = (id, position, side = 'right') => ({ id, address_hash: id, street_name: 'Test Drive',
    house_number: 100, lat: 33.45 + (side === 'right' ? -0.00008 : 0.00008), lng: -112.01 + position / 10000,
    routing_access: { confidence: 'high', chainKey: 'road', positionMeters: position, side,
        serviceBearing: side === 'right' ? 90 : 270, point: { lat: 33.45, lng: -112.01 + position / 10000 } } });
const accessContext = { accessFor: stop => stop.routing_access, streetSegmentKey: () => 'road', diagnostics: {} };
const six = [stop('173', 10), stop('174', 20), stop('175', 30, 'left'), stop('176', 40, 'left'), stop('177', 50), stop('178', 0, 'left')];
const candidate = [six[0], six[1], six[4], six[3], six[2], six[5]];

// Synthetic divided road: eastbound curb and westbound curb are connected only
// at positions 0 and 100. Engine costs include the legal crossover travel.
function engine(options = {}) {
    const calls = [];
    const fetchImpl = async input => {
        const url = new URL(input); calls.push(url);
        if (options.fail) return { ok: false, status: 503 };
        const coordinates = url.pathname.split('/').at(-1).split(';').map(pair => pair.split(',').map(Number));
        const waypoints = coordinates.map(location => ({ location }));
        const bearings = url.searchParams.get('bearings').split(';');
        const phase = i => {
            const position = (coordinates[i][0] + 112.01) * 10000;
            return bearings[i].startsWith('270,') ? 200 - position : position;
        };
        const meters = (a, b) => (phase(b) - phase(a) + 200) % 200;
        let data;
        if (url.pathname.includes('/table/')) {
            const sources = url.searchParams.get('sources').split(';').map(Number);
            const destinations = url.searchParams.get('destinations').split(';').map(Number);
            data = { code: 'Ok', sources: sources.map(i => waypoints[i]), destinations: destinations.map(i => waypoints[i]),
                durations: sources.map(a => destinations.map(b => options.unreachable && a !== b ? null : meters(a, b) / 10)),
                distances: sources.map(a => destinations.map(b => options.unreachable && a !== b ? null : meters(a, b))) };
        } else {
            const distance = coordinates.slice(1).reduce((sum, _, i) => sum + meters(i, i + 1), 0);
            data = { code: 'Ok', waypoints, routes: [{ duration: options.routeDuration?.(coordinates, bearings) ?? distance / 10,
                distance, geometry: { coordinates: options.routeGeometry?.(coordinates) || coordinates }, legs: [{ steps: [{ maneuver: { modifier: 'uturn' } }] }] }] };
            if (options.badSnap) data.waypoints[0] = { location: [-110, 32] };
            if (options.badGeometry) data.routes[0].geometry.coordinates = [[NaN, 33]];
        }
        return { ok: true, json: async () => data };
    };
    return { fetchImpl, calls };
}
const context = (stops, mock, options = {}) => createVehicleRoutingContext(stops, accessContext, { vehicleFetch: mock.fetchImpl, ...options });

test('synthetic six-house driving comparison keeps 173/178 fixed and takes the legal return pass', async t => {
    const mock = engine(); const ctx = await context(six, mock);
    const middle = six.slice(1, -1);
    // Exercise the frozen directed variant selector independently of main's
    // walking sweep. Production beta disables curb inference; these supplied,
    // trusted accesses test the provider's direction support.
    const variants = streetSideVariants(middle, middle, accessContext.accessFor);
    const selected = chooseStreetVariants([{ variants }], six[0], six[5], ctx.distanceBetween, p => Boolean(p));
    const optimized = variants[selected.orientations[0]];
    assert.deepEqual(optimized.map(p => p.id), ['174', '177', '176', '175']);
    const measured = await finalizeVehicleRoute([six[0], ...optimized, six[5]], ctx, {}, six);
    const baseline = await ctx.routeSequence(six);
    assert.equal(measured.properties[0].id, '173');
    assert.equal(measured.properties.at(-1).id, '178');
    assert.ok(measured.driveSeconds < baseline.driveSeconds);
    assert.ok(measured.walkingAccessSeconds > 0);
    assert.equal(measured.objectiveSeconds, measured.driveSeconds + measured.walkingAccessSeconds + measured.parkingSeconds);
    const bounds = { startLocation: { lat: 33.45, lng: -112.01 }, endLocation: { lat: 33.45, lng: -112.0099 } };
    const bounded = await context(six, mock, bounds);
    const boundedResult = await finalizeVehicleRoute(candidate, bounded, bounds, six);
    assert.deepEqual(boundedResult.properties.map(p => p.id), candidate.map(p => p.id));
    assert.ok(boundedResult.distanceMiles > measured.distanceMiles);
    t.diagnostic(`Synthetic legal crossovers: baseline ${baseline.driveSeconds.toFixed(1)} s, candidate ${measured.driveSeconds.toFixed(1)} s; access ${measured.walkingAccessSeconds.toFixed(1)} s. Not Hunters Hill measurements.`);
});

test('table and final geometry use identical curb directions, without a fabricated origin heading', async () => {
    const origin = { lat: 33.45, lng: -112.0105 };
    const mock = engine(); const ctx = await context(six, mock, { startLocation: origin });
    await ctx.routeSequence(candidate, { startLocation: origin });
    const table = mock.calls[0], route = mock.calls.at(-1);
    assert.equal(route.searchParams.get('continue_straight'), 'true');
    assert.equal(route.searchParams.get('approaches').split(';')[0], 'unrestricted');
    assert.equal(route.searchParams.get('bearings').split(';')[0], '');
    for (const property of six) {
        const point = vehicleWaypoint(property, accessContext.accessFor);
        assert.ok(table.searchParams.get('bearings').split(';').includes(point.bearing));
        assert.ok(route.searchParams.get('bearings').split(';').includes(point.bearing));
        assert.deepEqual(property.routing_access.point.lat, 33.45);
    }
    assert.equal(table.searchParams.has('fallback_speed'), false);
});

test('unreachable directed transitions stay infinite and cannot masquerade as road geometry', async () => {
    const ctx = await context(six, engine({ unreachable: true }));
    assert.equal(ctx.optimizationCostBetween(six[0], six[1]), Infinity);
    assert.throws(() => chooseStreetVariants([{ variants: [six] }], null, null, ctx.optimizationCostBetween, Boolean), /No complete route/);
});

test('final continuous road objective rejects a table candidate when a legal turnaround makes it slower', async () => {
    const mock = engine({ routeDuration: (_, bearings) => bearings.slice(0, 3).every(b => b.startsWith('90,')) ? 120 : 80 });
    const ctx = await context(six, mock);
    const result = await finalizeVehicleRoute(candidate, ctx, {}, six);
    assert.deepEqual(result.properties.map(p => p.id), six.map(p => p.id));
    assert.equal(result.driveSeconds, 80);
});

test('provider failure, invalid geometry, wrong-road snap and membership changes never yield a saveable result', async () => {
    await assert.rejects(context(six, engine({ fail: true })), /Vehicle routing failed/);
    for (const settings of [{ badSnap: true }, { badGeometry: true }, { routeDuration: () => -1 }]) {
        const ctx = await context(six, engine(settings));
        await assert.rejects(finalizeVehicleRoute(candidate, ctx), /snapped|incomplete route/);
    }
    const ctx = await context(six, engine());
    await assert.rejects(finalizeVehicleRoute(candidate.slice(1), ctx, {}, six), /membership/);
});

test('cancelled routing requests stop before issuing a matrix or saving a result', async () => {
    const controller = new AbortController(), mock = engine();
    controller.abort(new Error('Route selection changed'));
    await assert.rejects(context(six, mock, { signal: controller.signal }), /Route selection changed/);
    assert.equal(mock.calls.length, 0);
});

test('parking/access assumptions affect total time; OSRM turnaround travel is counted once', async () => {
    const ctx = await context(six, engine(), { servicePolicy: { parkingSecondsPerStop: 15 } });
    const result = await ctx.routeSequence(candidate);
    assert.equal(result.parkingSeconds, 90);
    assert.equal(result.estimatedTurnarounds, 1);
    assert.equal(result.objectiveSeconds, result.driveSeconds + result.walkingAccessSeconds + 90);
});

test('uncertain corners use unrestricted service rather than invented curb bearings', () => {
    const unknown = { ...six[0], routing_access: { ...six[0].routing_access, confidence: 'low' } };
    assert.equal(vehicleWaypoint(unknown, accessContext.accessFor).approach, 'unrestricted');
    assert.equal(vehicleWaypoint(unknown, accessContext.accessFor).bearing, '');
    const network = { elements: [{ type: 'node', id: 1, lat: 33.45, lon: -112.01 },
        { type: 'node', id: 2, lat: 33.45, lon: -112 },
        { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'residential', name: 'Test Drive', oneway: 'yes' } }] };
    const road = createRoadNetworkRoutingContext({ roadNetwork: network, travelMode: 'driving' });
    assert.equal(road.accessFor(six[1]).serviceBearing, 90);
    assert.equal(road.accessFor(six[2]).serviceBearing, 270);
    assert.equal(road.accessFor(six[5]).confidence, 'low');
});

test('a necessary cul-de-sac reversal away from service waypoints remains in the full driving path', async () => {
    const head = stop('outbound', 60), tail = stop('return', 40, 'left');
    const turningPoint = [-112, 33.45];
    const mock = engine({ routeGeometry: coordinates => [coordinates[0], turningPoint, coordinates[1]] });
    const ctx = await context([head, tail], mock);
    const result = await ctx.routeSequence([head, tail]);
    assert.equal(mock.calls.at(-1).searchParams.get('continue_straight'), 'true');
    assert.deepEqual(result.geometry[1], { lat: turningPoint[1], lng: turningPoint[0] });
    assert.equal(result.estimatedTurnarounds, 1);
    assert.equal(result.driveSeconds, ctx.optimizationCostBetween(head, tail));
});

test('infeasible reversed street candidates do not discard a feasible directed order', async () => {
    const stops = [stop('a', 10), stop('b', 20), stop('c', 30)].map((p, i) => ({ ...p, street_name: `Street ${i}` }));
    const base = await context(stops, engine());
    const ctx = { ...base, streetSegmentKey: p => p.street_name, optimizationCostBetween: (a, b) => {
        const distance = b.routing_access.positionMeters - a.routing_access.positionMeters;
        return distance > 0 ? distance : Infinity;
    } };
    const result = optimizer.optimizeRouteByStreetSweep(stops, null, null, ctx);
    assert.deepEqual(result.map(p => p.id), ['a', 'b', 'c']);
});

test('parallel competing frontage stays uncertain until a known access point disambiguates it', () => {
    const elements = [
        { type: 'node', id: 1, lat: 33.45, lon: -112.01 }, { type: 'node', id: 2, lat: 33.45, lon: -112 },
        { type: 'node', id: 3, lat: 33.4506, lon: -112.01 }, { type: 'node', id: 4, lat: 33.4506, lon: -112 },
        { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'residential', name: 'Test Drive' } },
        { type: 'way', id: 11, nodes: [3, 4], tags: { highway: 'residential', name: 'Back Road' } },
    ];
    const property = { ...six[1], lat: 33.4503, routing_access: undefined };
    const road = createRoadNetworkRoutingContext({ roadNetwork: { elements }, travelMode: 'driving' });
    assert.equal(road.accessFor(property).confidence, 'low');
    const known = { ...property, routing_access: { point: { lat: 33.45, lng: property.lng } } };
    assert.equal(road.accessFor(known).confidence, 'high');
});

test('route caches are isolated by provider/context and preserve reverse directed costs', async () => {
    const a = engine({ routeDuration: () => 100 }), b = engine({ routeDuration: () => 200 });
    const ca = await context(six, a), cb = await context(six, b);
    assert.equal((await ca.routeSequence(candidate)).driveSeconds, 100);
    assert.equal((await ca.routeSequence(candidate)).driveSeconds, 100);
    assert.equal(a.calls.filter(url => url.pathname.includes('/route/')).length, 1);
    assert.equal((await cb.routeSequence(candidate)).driveSeconds, 200);
    assert.notEqual(ca.optimizationCostBetween(six[0], six[1]), ca.optimizationCostBetween(six[1], six[0]));
});

test('map handoff defaults to driving while retaining the supplied stop order', async () => {
    const navigation = await vite.ssrLoadModule('/src/components/logic/navigation.jsx');
    const plan = navigation.getRouteNavigationPlan(candidate, 'google', { environment: { isMobileWeb: false },
        routingMetadata: { road_aware_routing_beta: true } });
    assert.equal(new URL(plan.batches[0].url).searchParams.get('travelmode'), 'driving');
    assert.deepEqual(plan.batches.flatMap(batch => batch.stops.map(p => p.id)), candidate.map(p => p.id));
});
