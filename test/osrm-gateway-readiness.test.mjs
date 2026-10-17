import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { fetchRoadCostRows, fetchRoadMatrix, ROAD_MATCH_MAX_RADIUS_METERS } from '../base44/shared/roadMatrix.js';
import { measureRoadPath, ROUTE_CHUNK_POINTS, ROUTE_MATCH_RADIUS_METERS } from '../base44/shared/roadPathMeasure.js';
import { completeServerRoadAwareRoutes } from '../base44/shared/roadAwareBetaServer.js';

const ENGINE = 'https://roads.test';
const originalFetch = globalThis.fetch;
const charlotte = JSON.parse(fs.readFileSync(new URL('./fixtures/charlotte-route-1i-barrier-1000.json', import.meta.url), 'utf8'));
const charlotteDoors = charlotte.doors;
// Doors measured farther than 100 m from any road on the real gateway.
const FAR_DOORS = [74, 155, 233, 417, 448, 449, 459, 589, 850, 996, 999];

const point = (i) => ({ lat: 35 + i / 1000, lng: -81 + i / 1000 });

/** A table engine that requires per-coordinate radiuses and answers a full table. */
function tableEngine() {
    const urls = [];
    globalThis.fetch = async (url) => {
        const parsed = new URL(String(url));
        urls.push(parsed);
        const coordinates = parsed.pathname.split('/').at(-1).split(';');
        const radiuses = parsed.searchParams.get('radiuses')?.split(';');
        if (!radiuses || radiuses.length !== coordinates.length) {
            // What OSRM does without radiuses is snap at any distance; the test
            // engine refuses instead, so a missing radius cannot pass silently.
            return Response.json({ code: 'InvalidOptions' }, { status: 400 });
        }
        const sources = (parsed.searchParams.get('sources') || '').split(';').map(Number);
        const destinations = (parsed.searchParams.get('destinations') || '').split(';').map(Number);
        const distances = sources.map((a) => destinations.map((b) => Math.abs(a - b) * 100));
        return Response.json({ code: 'Ok', distances, durations: distances });
    };
    return urls;
}

test('every table request names a radius for every coordinate', async () => {
    const urls = tableEngine();
    try {
        await fetchRoadMatrix(Array.from({ length: 140 }, (_, i) => point(i)), { baseUrl: ENGINE });
        await fetchRoadCostRows(Array.from({ length: 60 }, (_, i) => point(i)), [point(500), point(501)], { baseUrl: ENGINE });
        assert.ok(urls.length > 3);
        for (const url of urls) {
            const coordinates = url.pathname.split('/').at(-1).split(';');
            const radiuses = url.searchParams.get('radiuses').split(';');
            assert.equal(radiuses.length, coordinates.length);
            assert.ok(radiuses.every((radius) => Number(radius) === ROAD_MATCH_MAX_RADIUS_METERS));
        }
    } finally { globalThis.fetch = originalFetch; }
});

test('an out-of-coverage stop fails the table instead of snapping 1,650 km away', async () => {
    globalThis.fetch = async () => Response.json({ code: 'NoSegment', message: 'Could not find a matching segment for coordinate 1' }, { status: 400 });
    try {
        const puertoRico = { lat: 18.4655, lng: -66.1057 };
        await assert.rejects(fetchRoadMatrix([point(0), puertoRico], { baseUrl: ENGINE }), { code: 'NoSegment' });
    } finally { globalThis.fetch = originalFetch; }
});

test('no engine configured means no request at all', async () => {
    let fetched = false;
    globalThis.fetch = async () => { fetched = true; return Response.json({ code: 'Ok' }); };
    try {
        await assert.rejects(fetchRoadMatrix([point(0), point(1)], {}), { code: 'ROAD_PROVIDER_NOT_CONFIGURED' });
        const measured = await measureRoadPath([point(0), point(1)], {});
        assert.equal(measured.ok, false);
        assert.equal(measured.code, 'ROAD_PROVIDER_NOT_CONFIGURED');
        assert.equal(fetched, false);
    } finally { globalThis.fetch = originalFetch; }
});

/**
 * A /route engine that knows how far each stop is from its nearest road and
 * refuses (NoSegment, first offending coordinate) any radius that cannot reach it.
 */
function routeEngine(offRoadMeters) {
    const requests = [];
    const fetchJson = async (url) => {
        const parsed = new URL(url);
        const coordinates = parsed.pathname.split('/').at(-1).split(';');
        const radiuses = parsed.searchParams.get('radiuses').split(';').map(Number);
        requests.push({ coordinates, radiuses });
        assert.equal(radiuses.length, coordinates.length);
        assert.ok(coordinates.length <= ROUTE_CHUNK_POINTS);
        const blocked = coordinates.findIndex((coordinate, i) => (offRoadMeters.get(coordinate) || 0) > radiuses[i]);
        if (blocked >= 0) {
            throw Object.assign(new Error(`OSRM request failed with status 400 (NoSegment). Could not find a matching segment for coordinate ${blocked}`),
                { code: 'NoSegment', status: 400 });
        }
        return {
            code: 'Ok',
            routes: [{
                legs: coordinates.slice(1).map(() => ({ distance: 1609.344 })),
                geometry: { coordinates: coordinates.map((c) => c.split(',').map(Number)) }
            }]
        };
    };
    return { fetchJson, requests };
}

const key = (stop) => `${Number(stop.lng).toFixed(6)},${Number(stop.lat).toFixed(6)}`;

test('Charlotte 1,000 doors: the 11 doors beyond 100 m widen to 500 m and the route is still measured', async () => {
    assert.equal(charlotteDoors.length, 1000);
    const offRoad = new Map(FAR_DOORS.map((index) => [key(charlotteDoors[index]), 180]));
    const engine = routeEngine(offRoad);
    const measured = await measureRoadPath(charlotteDoors, { baseUrl: `${ENGINE}/charlotte-widen`, fetchJson: engine.fetchJson });
    assert.equal(measured.ok, true, measured.error);
    assert.deepEqual(measured.widenedStops, FAR_DOORS);
    assert.deepEqual(measured.unmatchedStops, []);
    assert.equal(measured.legMiles.length, 999);
    assert.ok(Math.abs(measured.totalMiles - 999) < 0.01);
    // 2 chunks + one escalation round per far door, never a per-door request storm.
    assert.ok(measured.requestCount <= 2 + FAR_DOORS.length, `${measured.requestCount} requests`);
    assert.equal(engine.requests[0].radiuses[0], ROUTE_MATCH_RADIUS_METERS);
});

test('a stop with no road within 500 m is reported unmatched without discarding the measurement', async () => {
    const doors = charlotteDoors.slice(0, 120);
    const offRoad = new Map([[key(doors[40]), 900], [key(doors[41]), 900], [key(doors[7]), 250]]);
    const engine = routeEngine(offRoad);
    const measured = await measureRoadPath(doors, { baseUrl: `${ENGINE}/unmatched`, fetchJson: engine.fetchJson });
    assert.equal(measured.ok, true, measured.error);
    assert.deepEqual(measured.unmatchedStops, [40, 41]);
    assert.deepEqual(measured.widenedStops, [7]);
    assert.equal(measured.legMiles.length, 119);
    // 39 -> 40 carries the 39 -> 42 bypass; 40 -> 41 and 41 -> 42 are bypassed.
    assert.deepEqual(measured.bypassedLegIndexes, [39, 40, 41]);
    assert.equal(measured.legMiles[40], 0);
    assert.equal(measured.legMiles[41], 0);
    assert.ok(measured.legMiles[39] > 0);
    const lastRequest = engine.requests.at(-1);
    assert.equal(lastRequest.coordinates.length, 118, 'unmatched stops are left out of the final request');

    // A second measurement of the same stops rediscovers nothing.
    const again = routeEngine(offRoad);
    await measureRoadPath([...doors].reverse(), { baseUrl: `${ENGINE}/unmatched`, fetchJson: again.fetchJson });
    assert.equal(again.requests.length, 1);
});

test('a non-matching failure still fails the measurement with its reason', async () => {
    const measured = await measureRoadPath([point(0), point(1), point(2)], { baseUrl: `${ENGINE}/down`,
        fetchJson: async () => { throw Object.assign(new Error('OSRM request failed with status 503.'), { status: 503 }); } });
    assert.equal(measured.ok, false);
    assert.match(measured.error, /503/);
});

test('route generation keeps every route when the road engine is unset or refusing', async () => {
    const doors = [
        { address_hash: 'a', street_name: 'Main St', lat: 27.95, lng: -82.46 },
        { address_hash: 'b', street_name: 'Oak St', lat: 27.951, lng: -82.459 },
        { address_hash: 'c', street_name: 'Main St', lat: 27.952, lng: -82.458 },
        { address_hash: 'd', street_name: 'Main St', lat: 27.953, lng: -82.457 }
    ];
    const routes = [{ name: 'Tampa', properties: doors, totalDistance: 3, metadata: {} }];
    const user = { id: 'manager', email: 'manager@example.com', role: 'admin' };
    const client = { asServiceRole: { entities: {} } };
    globalThis.fetch = async () => Response.json({ code: 'Unauthorized' }, { status: 401 });
    try {
        for (const secrets of [{}, { OSRM_BASE_URL: 'https://gateway.example', OSRM_GATEWAY_KEY: 'wrong' }]) {
            const completed = await completeServerRoadAwareRoutes(routes, { client, user, entryPoint: 'test',
                readSecret: (name) => secrets[name] || '' });
            assert.equal(completed.length, 1);
            assert.deepEqual(completed[0].properties.map((p) => p.address_hash).sort(), ['a', 'b', 'c', 'd']);
        }
    } finally { globalThis.fetch = originalFetch; }
});
