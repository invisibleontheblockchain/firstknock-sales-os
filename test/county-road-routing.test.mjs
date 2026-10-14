import test from 'node:test';
import assert from 'node:assert/strict';
import { createCountyRoadRoutingAdapter, validateCountyRoadNetwork } from '../base44/shared/countyRoadRouting.js';
import { haversineDistanceMiles } from '../base44/shared/routeBounds.js';
import { createVehicleRoutingContext } from '../base44/shared/vehicleRouting.js';

const meters = (a, b) => haversineDistanceMiles(a, b) * 1609.344;
const speed = 15 * 1609.344 / 3600;
const gateway = { lat: 35, lng: -81 }, bend = { lat: 35, lng: -80.999 }, end = { lat: 35.001, lng: -80.999 };
const network = { id: 'county-network', version: 'county-v1', segments: [
    { id: 'east', geometry: [gateway, bend], oneway: 'both' },
    { id: 'north', geometry: [bend, end], oneway: 'both' },
] };
const countyStop = (id, point, inputNetwork = network) => ({ id, address_hash: id, street_name: 'County Lane', ...point,
    routing_access: { resolution_status: 'resolved', confidence: 'medium', source: 'county-road-access', roadName: 'County Lane',
        point, county_road: { point, network: inputNetwork, gateway: { point: gateway, providerPoint: gateway, roadName: 'Public Road' } } } });
const first = countyStop('A', { lat: 35, lng: -80.9995 });
const second = countyStop('B', { lat: 35.0005, lng: -80.999 });
const normal = (id, lng) => ({ id, address_hash: id, lat: 35, lng, street_name: 'Public Road' });
const before = normal('before', -81.001), after = normal('after', -80.998);
const coord = p => `${p.lng},${p.lat}`;
const urlFor = (service, stops, options = {}) => {
    const url = new URL(`https://roads.test/${service}/v1/driving/${stops.map(coord).join(';')}`);
    for (const [key, value] of Object.entries(options)) url.searchParams.set(key, value);
    return url.toString();
};
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
const localBetween = meters(first, bend) + meters(bend, second);
const firstToGateway = meters(first, gateway);
const secondToGateway = meters(second, bend) + meters(bend, gateway);

function publicProvider({ roadName = 'Public Road', version = () => 'public-v1', unreachable = false } = {}) {
    const calls = [], responses = [];
    const fetchJson = async (value, options) => {
        const url = new URL(value);
        const points = url.pathname.split('/').at(-1).split(';').map(pair => pair.split(',').map(Number));
        calls.push({ url, options, points });
        const waypoints = points.map(location => ({ location, name: roadName, distance: 0, hint: 'public-only-hint' }));
        let data;
        if (url.pathname.includes('/nearest/')) data = { code: 'Ok', waypoints };
        else if (url.pathname.includes('/table/')) {
            const indices = parameter => !url.searchParams.has(parameter) ? points.map((_, i) => i)
                : url.searchParams.get(parameter).split(';').map(Number);
            const sources = indices('sources'), destinations = indices('destinations');
            data = { code: 'Ok', sources: sources.map(i => waypoints[i]), destinations: destinations.map(i => waypoints[i]),
                durations: sources.map(a => destinations.map(b => unreachable ? null : 100 + a * 10 + b)),
                distances: sources.map(a => destinations.map(b => unreachable ? null : 1000 + a * 100 + b * 10)) };
        } else {
            const legs = points.slice(1).map((p, i) => ({ duration: 100, distance: 1000,
                steps: [{ name: roadName, duration: 100, distance: 1000, mode: 'driving',
                    maneuver: { type: 'depart', modifier: 'uturn', location: points[i] },
                    geometry: { type: 'LineString', coordinates: [points[i], [(points[i][0] + p[0]) / 2, 35.00001], p] } },
                { name: roadName, duration: 0, distance: 0, mode: 'driving', maneuver: { type: 'arrive', location: p },
                    geometry: { type: 'LineString', coordinates: [p] } }] }));
            data = { code: 'Ok', waypoints, routes: [{ duration: legs.length * 100, distance: legs.length * 1000,
                legs, geometry: { type: 'LineString', coordinates: points } }] };
        }
        const dataVersion = version(calls.length);
        if (dataVersion) data.data_version = dataVersion;
        responses.push(data);
        return data;
    };
    return { calls, responses, fetchJson };
}

test('an empty county network delegates the exact public response and request options unchanged', async () => {
    const engine = publicProvider(), adapter = createCountyRoadRoutingAdapter([before, after], { fetchJson: engine.fetchJson });
    const options = { timeoutMs: 1234 }, url = urlFor('route', [before, after]);
    const result = await adapter.fetchJson(url, options);
    assert.equal(result, engine.responses[0]); assert.equal(engine.calls[0].options, options);
    assert.equal(engine.calls[0].url.toString(), url);
    assert.equal(adapter.stats().countyStopCount, 0);
});

test('same-component stops take the mapped county path directly and still verify their public gateway', async () => {
    const engine = publicProvider(), adapter = createCountyRoadRoutingAdapter([first, second], { fetchJson: engine.fetchJson, baseUrl: 'https://roads.test' });
    const result = await adapter.fetchJson(urlFor('route', [first, second], { steps: 'true', geometries: 'geojson', continue_straight: 'true' }));
    close(result.routes[0].distance, localBetween); close(result.routes[0].duration, localBetween / speed);
    assert.deepEqual(result.routes[0].geometry.coordinates, [[first.lng, first.lat], [bend.lng, bend.lat], [second.lng, second.lat]]);
    assert.equal(engine.calls.length, 1); assert.match(engine.calls[0].url.pathname, /\/nearest\//);
    assert.deepEqual(engine.calls[0].points, [[gateway.lng, gateway.lat]]);
    assert.equal(result.waypoints[0].name, 'County Lane'); assert.equal(result.waypoints[0].distance, 0);
    assert.equal(result.routes[0].legs[0].steps[0].maneuver.type, 'depart');
    assert.equal(result.routes[0].legs[0].steps.at(-1).maneuver.type, 'arrive');
    assert.ok(result.routes[0].legs[0].steps.every(step => step.driving_side === undefined));
    assert.equal(adapter.stats().localDurationIsEstimate, true); assert.equal(adapter.stats().localSpeedMph, 15);
});

test('mixed trips add each county connector once and preserve normal public turn constraints across county detours', async () => {
    const engine = publicProvider(), stops = [before, first, second, after];
    const adapter = createCountyRoadRoutingAdapter(stops, { fetchJson: engine.fetchJson });
    const result = await adapter.fetchJson(urlFor('route', stops, {
        steps: 'true', geometries: 'geojson', continue_straight: 'true', approaches: 'curb;curb;curb;curb',
        bearings: '90,45;12,45;34,45;270,45', radiuses: '100;100;100;100',
    }));
    const route = result.routes[0];
    close(route.distance, 2000 + firstToGateway + localBetween + secondToGateway);
    close(route.duration, 200 + (firstToGateway + localBetween + secondToGateway) / speed);
    assert.equal(route.legs.length, stops.length - 1);
    close(route.legs[0].distance, 1000 + firstToGateway);
    close(route.legs[1].distance, localBetween);
    close(route.legs[2].distance, 1000 + secondToGateway);
    assert.equal(engine.calls.length, 2);
    assert.ok(engine.calls.every(call => call.url.searchParams.get('continue_straight') === 'true'));
    assert.equal(engine.calls[0].url.searchParams.get('bearings'), '90,45;');
    assert.equal(engine.calls[1].url.searchParams.get('bearings'), ';270,45');
    assert.equal(engine.calls[0].url.searchParams.get('approaches'), 'curb;unrestricted');
    assert.equal(engine.calls[1].url.searchParams.get('approaches'), 'unrestricted;curb');
    assert.ok(route.legs[0].steps.some(step => step.name === 'Public Road' && step.maneuver.modifier === 'uturn'));
    assert.deepEqual(result.waypoints.map(p => p.location), stops.map(p => [p.lng, p.lat]));
    assert.ok(route.geometry.coordinates.every(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat)));
});

test('table subset indices use direct local paths or the correctly directed public cell plus county connectors', async () => {
    const engine = publicProvider(), stops = [before, first, second, after];
    const adapter = createCountyRoadRoutingAdapter(stops, { fetchJson: engine.fetchJson });
    const result = await adapter.fetchJson(urlFor('table', stops, { sources: '2;0', destinations: '1;3', annotations: 'duration,distance' }));
    close(result.distances[0][0], localBetween); close(result.durations[0][0], localBetween / speed);
    close(result.distances[0][1], 1230 + secondToGateway); close(result.durations[0][1], 123 + secondToGateway / speed);
    close(result.distances[1][0], 1010 + firstToGateway); close(result.durations[1][0], 101 + firstToGateway / speed);
    close(result.distances[1][1], 1030); close(result.durations[1][1], 103);
    assert.deepEqual(result.sources.map(p => p.location), [[second.lng, second.lat], [before.lng, before.lat]]);
    assert.deepEqual(result.destinations.map(p => p.location), [[first.lng, first.lat], [after.lng, after.lat]]);
    assert.equal(engine.calls[0].url.searchParams.get('sources'), '2;0');
    assert.equal(engine.calls[0].url.searchParams.get('destinations'), '1;3');
});

test('unreachable public table transitions stay unavailable while county-only directed transitions remain measurable', async () => {
    const engine = publicProvider({ unreachable: true }), adapter = createCountyRoadRoutingAdapter([before, first, second], { fetchJson: engine.fetchJson });
    const result = await adapter.fetchJson(urlFor('table', [before, first, second]));
    assert.equal(result.durations[0][1], null); assert.equal(result.distances[1][0], null);
    close(result.distances[1][2], localBetween); close(result.durations[2][1], localBetween / speed);
    assert.equal(result.distances[1][1], 0);
});

test('nearest validation checks the public gateway and returns the unchanged local service position', async () => {
    const engine = publicProvider(), adapter = createCountyRoadRoutingAdapter([first], { fetchJson: engine.fetchJson });
    const result = await adapter.fetchJson(urlFor('nearest', [first], { radiuses: '100', number: '3' }));
    assert.deepEqual(engine.calls[0].points, [[gateway.lng, gateway.lat]]);
    assert.deepEqual(result.waypoints[0].location, [first.lng, first.lat]);
    assert.equal(result.waypoints[0].name, 'County Lane'); assert.equal(result.waypoints[0].hint, undefined);
    const wrong = publicProvider({ roadName: 'Wrong Road' });
    const invalid = createCountyRoadRoutingAdapter([first], { fetchJson: wrong.fetchJson });
    await assert.rejects(invalid.fetchJson(urlFor('nearest', [first])), /different county gateway road/);
});

test('the same county graph identity accompanies county and normal-only responses and rejects public graph changes', async () => {
    const engine = publicProvider(), adapter = createCountyRoadRoutingAdapter([first, second], { fetchJson: engine.fetchJson });
    const local = await adapter.fetchJson(urlFor('nearest', [first]));
    const publicOnly = await adapter.fetchJson(urlFor('route', [before, after]));
    assert.equal(local.data_version, publicOnly.data_version);
    assert.match(local.data_version, /^public:public-v1\|county:/);
    const changed = publicProvider({ version: count => count === 1 ? 'public-v1' : 'public-v2' });
    const invalid = createCountyRoadRoutingAdapter([first], { fetchJson: changed.fetchJson });
    await invalid.fetchJson(urlFor('nearest', [first]));
    await assert.rejects(invalid.fetchJson(urlFor('route', [before, after])), /graph identity changed/);
});

test('an unversioned public provider is labeled explicitly and graph fingerprints ignore property or segment ordering', async () => {
    const engine = publicProvider({ version: () => null });
    const a = createCountyRoadRoutingAdapter([first, second], { fetchJson: engine.fetchJson });
    const reversed = { ...network, segments: [...network.segments].reverse() };
    const b = createCountyRoadRoutingAdapter([countyStop('B', second, reversed), countyStop('A', first, reversed)], { fetchJson: engine.fetchJson });
    assert.equal(a.stats().graphIdentity, b.stats().graphIdentity);
    assert.match((await a.fetchJson(urlFor('nearest', [first]))).data_version, /^public:unversioned\|county:/);
});

test('coordinate rounding within 0.2 meters still selects the county service graph', async () => {
    const precise = countyStop('precise', { lat: 35, lng: -80.99954321 });
    const rounded = { lat: 35, lng: Number(precise.lng.toFixed(6)) };
    const engine = publicProvider(), adapter = createCountyRoadRoutingAdapter([precise], { fetchJson: engine.fetchJson });
    const result = await adapter.fetchJson(urlFor('nearest', [rounded]));
    assert.deepEqual(engine.calls[0].points, [[gateway.lng, gateway.lat]]);
    assert.deepEqual(result.waypoints[0].location, [precise.lng, precise.lat]);
});

test('geometry crossings without a mapped vertex do not establish a county-road connection', () => {
    const crossing = { id: 'crossing', version: 'v1', segments: [
        { id: 'diagonal-a', oneway: 'both', geometry: [gateway, { lat: 35.001, lng: -80.999 }] },
        { id: 'diagonal-b', oneway: 'both', geometry: [{ lat: 35.001, lng: -81 }, { lat: 35, lng: -80.999 }] },
    ] };
    const stop = countyStop('separate', { lat: 35, lng: -80.999 }, crossing);
    assert.equal(validateCountyRoadNetwork(stop.routing_access.county_road), false);
    assert.throws(() => createCountyRoadRoutingAdapter([stop], { fetchJson: async () => assert.fail('must not call provider') }), /no connected arrival and departure/);
});

test('off-road points, unknown directions and a one-way dead end cannot be certified for both arrival and departure', () => {
    const offRoad = structuredClone(first.routing_access.county_road); offRoad.point.lat += 0.001;
    assert.equal(validateCountyRoadNetwork(offRoad), false);
    const oneWay = structuredClone(first.routing_access.county_road); oneWay.network.segments.forEach(s => s.oneway = 'forward');
    assert.equal(validateCountyRoadNetwork(oneWay), false);
    const unknown = structuredClone(first.routing_access.county_road); unknown.network.segments[0].oneway = 'unknown';
    assert.equal(validateCountyRoadNetwork(unknown), false);
});

test('the vehicle context verifies the composed route with exact ordered directed legs and complete step geometry', async () => {
    const engine = publicProvider(), stops = [before, first, second, after];
    const adapter = createCountyRoadRoutingAdapter(stops, { fetchJson: engine.fetchJson });
    const context = await createVehicleRoutingContext(stops, { accessFor: p => p.routing_access }, {
        routeOnly: true, requireDirectedLegs: true, vehicleBaseUrl: 'https://roads.test', vehicleFetch: adapter.vehicleFetch,
    });
    const result = await context.routeSequence(stops);
    assert.deepEqual(result.directedLegs.map(leg => [leg.from, leg.to]), [['before', 'A'], ['A', 'B'], ['B', 'after']]);
    close(result.distanceMiles * 1609.344, 2000 + firstToGateway + localBetween + secondToGateway);
    close(result.driveSeconds, 200 + (firstToGateway + localBetween + secondToGateway) / speed);
    assert.ok(result.directedLegs.every(leg => leg.pathKey && leg.geometry.length >= 2));
    assert.equal(result.estimatedTurnarounds, 2);
});

test('split public connector errors identify the original request coordinate without mutating the provider error', async () => {
    const middle = normal('middle', -80.997), engine = publicProvider();
    const original = Object.assign(new Error('NoSegment: Could not find a matching segment for coordinate 1.'), { code: 'NoSegment', status: 400 });
    let requests = 0;
    const adapter = createCountyRoadRoutingAdapter([before, first, after, middle], { fetchJson: async (...args) => {
        if (++requests === 2) throw original;
        return engine.fetchJson(...args);
    } });
    await assert.rejects(adapter.fetchJson(urlFor('route', [before, first, after, middle])), error => {
        assert.equal(error.code, 'NoSegment'); assert.equal(error.status, 400);
        assert.match(error.message, /coordinate 2/); assert.equal(error.cause, original);
        return true;
    });
    assert.match(original.message, /coordinate 1/);
});

test('unsuccessful public connector payloads preserve road-match errors and map their subrequest coordinate', async () => {
    const engine = publicProvider(); let requests = 0;
    const adapter = createCountyRoadRoutingAdapter([before, first, after], { fetchJson: (...args) => ++requests === 2
        ? Promise.resolve({ code: 'NoSegment', message: 'Could not find a matching segment for coordinate 1.' }) : engine.fetchJson(...args) });
    await assert.rejects(adapter.fetchJson(urlFor('route', [before, first, after])), error => error.code === 'NoSegment' && /coordinate 2/.test(error.message));
});

test('a verified physical junction connector contributes its length and geometry exactly once per public transition', async () => {
    const providerPoint = { lat: gateway.lat + 0.00005, lng: gateway.lng };
    const a = structuredClone(first), b = structuredClone(second);
    for (const p of [a, b]) p.routing_access.county_road.gateway.providerPoint = providerPoint;
    const engine = publicProvider(), adapter = createCountyRoadRoutingAdapter([before, a, b, after], { fetchJson: engine.fetchJson });
    const result = await adapter.fetchJson(urlFor('route', [before, a, b, after]));
    const connectorMeters = meters(gateway, providerPoint);
    close(result.routes[0].distance, 2000 + firstToGateway + localBetween + secondToGateway + 2 * connectorMeters);
    close(result.routes[0].duration, 200 + (firstToGateway + localBetween + secondToGateway + 2 * connectorMeters) / speed);
    close(result.routes[0].legs[1].distance, localBetween);
    const inPath = result.routes[0].legs[0].steps.flatMap(step => step.geometry.coordinates);
    assert.ok(inPath.some(([lng, lat]) => lng === providerPoint.lng && lat === providerPoint.lat));
    assert.ok(inPath.some(([lng, lat]) => lng === gateway.lng && lat === gateway.lat));
    assert.ok(engine.calls.every(call => call.points.some(([lng, lat]) => lng === providerPoint.lng && lat === providerPoint.lat)));
});

test('same-network version, gateway and source-geometry conflicts are rejected before requesting public roads', () => {
    const provider = async () => assert.fail('inconsistent county geometry must not reach the provider');
    for (const change of [
        p => { p.routing_access.county_road.network.version = 'changed'; },
        p => { p.routing_access.county_road.gateway.providerPoint.lat += 0.00001; },
        p => { p.routing_access.county_road.network.segments[0].geometry[1].lng += 0.00001; },
    ]) {
        const changed = structuredClone(second); change(changed);
        assert.throws(() => createCountyRoadRoutingAdapter([first, changed], { fetchJson: provider }), /identity.*changed/);
    }
});

test('the graph budget rejects excessive supplied vertices before quadratic clustering', () => {
    const large = structuredClone(first.routing_access.county_road);
    large.network.segments = [{ id: 'too-many', oneway: 'both', geometry: Array.from({ length: 5001 }, (_, i) => ({ lat: 35, lng: -81 + i / 1000000 })) }];
    assert.equal(validateCountyRoadNetwork(large), false);
    assert.throws(() => createCountyRoadRoutingAdapter([{ ...first, routing_access: { county_road: large } }], { fetchJson: async () => assert.fail('no public request') }), /geometry|budget/);
});

test('a legal one-way county loop preserves asymmetric directed local costs', async () => {
    const west = { lat: 35.001, lng: -81 };
    const loop = { id: 'oneway-loop', version: 'v1', segments: [{ id: 'loop', geometry: [gateway, bend, end, west, gateway], oneway: 'forward' }] };
    const a = countyStop('loop-A', first, loop), b = countyStop('loop-B', second, loop);
    assert.equal(validateCountyRoadNetwork(a.routing_access.county_road), true);
    const engine = publicProvider(), adapter = createCountyRoadRoutingAdapter([a, b], { fetchJson: engine.fetchJson });
    const result = await adapter.fetchJson(urlFor('table', [a, b]));
    close(result.distances[0][1], localBetween);
    close(result.distances[1][0], meters(second, end) + meters(end, west) + meters(west, gateway) + firstToGateway);
    assert.ok(result.distances[1][0] > result.distances[0][1]);
});

test('losing a previously reported public graph version cannot inherit a stale version', async () => {
    const engine = publicProvider({ version: count => count === 1 ? 'public-v1' : null });
    const adapter = createCountyRoadRoutingAdapter([first], { fetchJson: engine.fetchJson });
    await adapter.fetchJson(urlFor('nearest', [first]));
    await assert.rejects(adapter.fetchJson(urlFor('route', [before, after])), /graph identity changed/);
});

test('duration-only and distance-only tables preserve the requested metric and omit absent annotations', async () => {
    for (const metric of ['durations', 'distances']) {
        const engine = publicProvider(), absent = metric === 'durations' ? 'distances' : 'durations';
        const adapter = createCountyRoadRoutingAdapter([before, first, second], { fetchJson: async (...args) => {
            const data = await engine.fetchJson(...args); delete data[absent]; return data;
        } });
        const result = await adapter.fetchJson(urlFor('table', [before, first, second], { annotations: metric === 'durations' ? 'duration' : 'distance' }));
        assert.equal(result[absent], undefined);
        close(result[metric][0][1], metric === 'durations' ? 101 + firstToGateway / speed : 1010 + firstToGateway);
        close(result[metric][1][2], metric === 'durations' ? localBetween / speed : localBetween);
    }
});
