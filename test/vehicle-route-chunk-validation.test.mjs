import test from 'node:test';
import assert from 'node:assert/strict';
import { createVehicleRoutingContext } from '../base44/shared/vehicleRouting.js';
import { haversineDistanceMiles } from '../base44/shared/routeBounds.js';

const METERS_PER_MILE = 1609.344;
const coordinate = stop => [stop.lng, stop.lat];
const samePoint = (a, b) => a[0] === b[0] && a[1] === b[1];
const deduplicateAdjacent = points => points.filter((p, i) => i === 0 || !samePoint(p, points[i - 1]));
const makeStops = count => Array.from({ length: count }, (_, i) => ({
    id: `stop-${i}`, lat: 35, lng: -81 + i / 10000,
}));

// The provider deliberately prices a request's free origin and terminal state
// differently from an intermediate waypoint. Only the real trip endpoints may
// contribute those costs to the assembled result. Responses also model OSRM's
// overview assembly, which omits each nonterminal leg's final vertex.
function provider(ordered, settings = {}) {
    const calls = [];
    const legPath = index => {
        let from = coordinate(ordered[index]);
        const to = coordinate(ordered[index + 1]);
        if (samePoint(from, to)) return [from, to];
        if (settings.trimmedStarts && index > 0) from = [from[0] + 0.000001, from[1]];
        const middle = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
        // A road can revisit a service point before its actual final arrival.
        // Searching the overview for the first matching coordinate loses this
        // distinction. Keep every nonadjacent occurrence in the expected path.
        return settings.loops ? [from, to, middle, to] : [from, middle, to];
    };
    const isStationary = index => samePoint(coordinate(ordered[index]), coordinate(ordered[index + 1]));
    const secondsFor = (index, position, legCount) => isStationary(index) ? 0 : settings.uniformCosts ? 10
        : position === 0 ? 30 : position === legCount - 1 ? 40 : 10;
    const turnaroundsFor = index => Number(!isStationary(index) && index % 11 === 0);
    const fetch = async input => {
        const url = new URL(input);
        assert.match(url.pathname, /\/route\/v1\/driving\//, 'route-only validation must not request a table');
        assert.equal(url.searchParams.get('continue_straight'), 'true');
        assert.equal(url.searchParams.get('steps'), 'true');
        const points = url.pathname.split('/').at(-1).split(';').map(value => value.split(',').map(Number));
        const start = ordered.findIndex((_, index) => points.every((p, j) => ordered[index + j]
            && samePoint(p, coordinate(ordered[index + j]))));
        assert.ok(start >= 0, 'provider request must retain a consecutive part of the submitted route');
        const requestIndex = calls.length;
        const legs = points.slice(1).map((_, i) => {
            const index = start + i;
            const path = legPath(index).map(p => [...p]);
            let duration = secondsFor(index, i, points.length - 1);
            let distance = duration * 10;
            // A genuine interior disagreement must survive the representation
            // fix and still prevent a route from being treated as continuous.
            if (requestIndex > 0 && i > 0 && i < points.length - 2) {
                if (settings.inconsistentInterior === 'time') duration += 1;
                if (settings.inconsistentInterior === 'distance') distance += 1;
                if (settings.inconsistentInterior === 'path') path[1][1] += 0.00001;
            }
            return { duration, distance, steps: [{
                geometry: { coordinates: path }, maneuver: { modifier: turnaroundsFor(index) ? 'uturn' : 'straight' },
            }] };
        });
        const paths = legs.map(leg => leg.steps[0].geometry.coordinates);
        const overview = deduplicateAdjacent(paths.flatMap((path, i) => i === paths.length - 1 ? path : path.slice(0, -1)));
        const data = {
            code: 'Ok', data_version: settings.changedGraph && requestIndex > 0 ? 'road-build-b' : 'road-build-a',
            waypoints: points.map(location => ({ location })),
            routes: [{ duration: legs.reduce((sum, leg) => sum + leg.duration, 0),
                distance: legs.reduce((sum, leg) => sum + leg.distance, 0), geometry: { coordinates: overview }, legs }],
        };
        calls.push({ url, start, points, data });
        return { ok: true, json: async () => data };
    };
    return {
        fetch, calls, legPath,
        expectedSeconds: () => ordered.slice(1).reduce((sum, _, i) => sum + secondsFor(i, i, ordered.length - 1), 0),
        expectedTurnarounds: () => ordered.slice(1).reduce((sum, _, i) => sum + turnaroundsFor(i), 0),
    };
}

async function measure(stops, settings = {}, bounds = {}, options = {}) {
    const ordered = [bounds.startLocation, ...stops, bounds.endLocation].filter(Boolean);
    const engine = provider(ordered, settings);
    const accessFor = options.accessFor || (() => null);
    const context = await createVehicleRoutingContext(stops, { accessFor }, {
        vehicleBaseUrl: 'https://roads.test', vehicleProfile: 'driving', vehicleFetch: engine.fetch,
        routeOnly: true, requireDirectedLegs: true, maxGeometryPoints: 100000,
        ...bounds, ...options,
    });
    return { ordered, engine, context, run: () => context.routeSequence(stops, bounds) };
}

function assertComplete(result, ordered, engine) {
    assert.deepEqual(result.directedLegs.map(leg => [leg.from, leg.to]),
        ordered.slice(1).map((stop, i) => [ordered[i].id, stop.id]),
        'every submitted consecutive directed leg must occur once and in order');
    assert.equal(result.driveSeconds, engine.expectedSeconds());
    assert.ok(Math.abs(result.distanceMiles - engine.expectedSeconds() * 10 / METERS_PER_MILE) < 1e-9);
    assert.equal(result.estimatedTurnarounds, engine.expectedTurnarounds());
    assert.equal(result.dataVersion, 'road-build-a');
    assert.ok(result.geometry.length >= 2);
    assert.ok(result.geometry.every(p => Number.isFinite(p.lat) && Number.isFinite(p.lng)));
    assert.ok(engine.calls.every(call => call.points.length >= 2 && call.points.length <= 100));
    assert.ok(engine.calls.length <= Math.ceil(ordered.length / 90), 'route requests must remain bounded and must stop at the final stop');
    assert.ok(engine.calls.every((call, i) => call.start + call.points.length < ordered.length || i === engine.calls.length - 1),
        'a request that reaches the final stop must be the final request');
    assert.equal(result.objectiveSeconds, result.driveSeconds + result.walkingAccessSeconds + result.parkingSeconds);
}

for (const count of [100, 101, 193, 194, 195, 196, 197, 316, 377]) {
    test(`long-route verification measures every interior leg once for ${count} ordered stops`, async () => {
        const stops = makeStops(count);
        const { run, ordered, engine } = await measure(stops);
        const result = await run();
        assertComplete(result, ordered, engine);
        assert.equal(result.parkingSeconds, 0);
    });
}

test('a matching directed road path remains usable when the next overview omits a shared endpoint', async () => {
    const { run, ordered, engine } = await measure(makeStops(316), { trimmedStarts: true, uniformCosts: true });
    const result = await run();
    assertComplete(result, ordered, engine);
    const prior = engine.calls[0].data.routes[0], next = engine.calls[1].data.routes[0];
    const terminalPoint = prior.geometry.coordinates.at(-1);
    assert.equal(next.geometry.coordinates.some(p => samePoint(p, terminalPoint)), false,
        'the fixture must reproduce the provider overview omission');
    const expected = deduplicateAdjacent(ordered.slice(1).flatMap((_, i) => engine.legPath(i)));
    assert.deepEqual(result.geometry.map(p => [p.lng, p.lat]), expected,
        'the displayed drive must retain the verified per-leg path despite overview trimming');
});

test('different stop IDs at the same snapped point retain their zero-length leg and do not break the seam', async () => {
    const stops = makeStops(316);
    Object.assign(stops[98], { lat: stops[97].lat, lng: stops[97].lng });
    Object.assign(stops[99], { lat: stops[97].lat, lng: stops[97].lng });
    const { run, ordered, engine } = await measure(stops, { uniformCosts: true });
    const result = await run();
    assertComplete(result, ordered, engine);
    const stationary = result.directedLegs.find(leg => leg.from === 'stop-97' && leg.to === 'stop-98');
    assert.equal(stationary.driveSeconds, 0);
    assert.equal(stationary.distanceMiles, 0);
    assert.equal(stationary.turnarounds, 0);
});

test('looping roads preserve the complete path instead of joining at an earlier visit to the seam coordinate', async () => {
    const { run, ordered, engine } = await measure(makeStops(197), { loops: true, uniformCosts: true });
    const result = await run();
    assertComplete(result, ordered, engine);
    const expected = deduplicateAdjacent(ordered.slice(1).flatMap((_, i) => engine.legPath(i)));
    assert.deepEqual(result.geometry.map(p => [p.lng, p.lat]), expected);
});

for (const inconsistentInterior of ['path', 'time', 'distance']) {
    test(`a real shared interior ${inconsistentInterior} disagreement rejects the assembled drive`, async () => {
        const { run } = await measure(makeStops(316), { inconsistentInterior });
        await assert.rejects(run(), /inconsistent turn continuity/);
    });
}

test('a road-graph change between successful chunks prevents a completed route measurement', async () => {
    const { run } = await measure(makeStops(316), { changedGraph: true });
    await assert.rejects(run(), /graph identity changed/);
});

test('personal start and destination retain their directed legs and heading while stop service time is counted once', async () => {
    const all = makeStops(197);
    const stops = all.slice(1, -1);
    const bounds = { startLocation: { ...all[0], vehicle_heading_degrees: 85 }, endLocation: all.at(-1) };
    const accessFor = stop => ({ confidence: 'low', point: { lat: stop.lat + 0.00001, lng: stop.lng } });
    const { run, ordered, engine } = await measure(stops, {}, bounds, {
        accessFor, servicePolicy: { parkingSecondsPerStop: 15, walkingMetersPerSecond: 1 },
    });
    const result = await run();
    assertComplete(result, ordered, engine);
    assert.equal(result.parkingSeconds, stops.length * 15);
    const walkingSeconds = stops.reduce((sum, stop) => sum + haversineDistanceMiles(stop, accessFor(stop).point) * METERS_PER_MILE * 2, 0);
    assert.ok(Math.abs(result.walkingAccessSeconds - walkingSeconds) < 1e-8);
    assert.equal(engine.calls[0].url.searchParams.get('bearings').split(';')[0], '85,45');
    assert.equal(engine.calls[0].url.searchParams.get('approaches').split(';')[0], 'unrestricted');
});
