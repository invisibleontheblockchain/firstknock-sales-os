import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewNeighborhoodExcursions as review, reviewNeighborhoodExcursionsAsync, getNeighborhoodExcursionReview } from '../base44/shared/neighborhoodExcursions.js';
import { reviewFinalNeighborhoodRoute } from '../base44/shared/finalNeighborhoodReview.js';
import { createVehicleRoutingContext } from '../base44/shared/vehicleRouting.js';
import { evaluateCoreDrivingRoute } from '../base44/shared/coreDrivingPilot.js';

const stop = (id, pocket = 'A', street = id) => ({ id: String(id), address_hash: String(id), subdivision_name: pocket,
    street_name: `${street} St`, lat: 35, lng: -81 + Number(id) / 100000 });
const doors = [stop(93), stop(94, 'X'), stop(95), stop(96), stop(97, 'Y')];
const cost = (a, b) => a.id === b.id ? 0 : a.subdivision_name === b.subdivision_name ? 1
    : a.id === '94' || b.id === '94' ? 100 : 20;
const total = (order, metric = cost, start = null, end = null) => [start, ...order, end].filter(Boolean)
    .slice(1).reduce((s, b, i) => s + metric([start, ...order, end].filter(Boolean)[i], b), 0);
const options = { roadVerified: true, costBetween: cost };

test('93 → outside 94 → 95 is reviewed and relocated using the complete directed trip', () => {
    const result = review(doors, options);
    assert.ok(total(result.properties) < total(doors));
    assert.equal(result.diagnostics.secondsSaved, total(doors) - total(result.properties));
    assert.equal(result.diagnostics.remaining, 0);
    assert.equal(result.diagnostics.detected, 1);
    assert.deepEqual(new Set(result.properties), new Set(doors));
    assert.equal(getNeighborhoodExcursionReview(result.properties), result.diagnostics);
});

test('the current interruption survives when leaving and returning really is faster', () => {
    const cheap = (a, b) => a.id === b.id ? 0 : a.id === '94' || b.id === '94' ? 1 : 100;
    const result = review(doors, { ...options, costBetween: cheap });
    assert.equal(result.properties, doors);
    assert.equal(result.diagnostics.relocated, 0);
    assert.ok(result.diagnostics.evaluated > 0);
});

test('a multi-stop excursion moves together and does not reverse its internal road legs', () => {
    const input = [doors[0], doors[1], stop(941, 'X'), ...doors.slice(2)];
    const result = review(input, options);
    assert.ok(total(result.properties) < total(input));
    assert.equal(result.properties.indexOf(input[2]), result.properties.indexOf(input[1]) + 1);
    assert.deepEqual(new Set(result.properties), new Set(input));
});

test('directed costs and start/destination legs can select a different placement', () => {
    const start = stop(1, 'S'), end = stop(2, 'E');
    const directed = (a, b) => a === start && b.id === '94' ? 1000 : a.id === '94' && b === end ? 1000 : cost(a, b);
    const result = review(doors, { ...options, costBetween: directed, startLocation: start, endLocation: end });
    assert.notEqual(result.properties[0].id, '94');
    assert.notEqual(result.properties.at(-1).id, '94');
    assert.equal(result.diagnostics.secondsSaved, total(doors, directed, start, end) - total(result.properties, directed, start, end));
    assert.ok(result.diagnostics.secondsSaved > 0);
});

test('explicit locks, intervening locks and unresolved access keep their exact indices', () => {
    for (const index of [0, 1, 2, 4]) {
        const result = review(doors, { ...options, lockedStopIds: [doors[index].id] });
        assert.equal(result.properties[index], doors[index]);
    }
    for (const flag of [{ order_locked: true }, { locked: true }, { routing_access: { resolution_status: 'unresolved' } }]) {
        const input = doors.map((p, i) => i === 1 ? { ...p, ...flag } : p);
        assert.equal(review(input, options).properties, input);
    }
});

test('a street run stays atomic, and labels on road-disconnected neighborhoods are separated', () => {
    const input = [stop(93, 'A', 'Main'), stop(932, 'A', 'Main'), doors[1], stop(95, 'A', 'Main'), stop(96, 'A', 'Main')];
    const result = review(input, options);
    assert.equal(result.properties.indexOf(input[1]), result.properties.indexOf(input[0]) + 1);
    assert.equal(result.properties.indexOf(input[4]), result.properties.indexOf(input[3]) + 1);
    const disconnected = (a, b) => a.subdivision_name === 'A' && b.subdivision_name === 'A' && a !== b ? 700 : cost(a, b);
    assert.equal(review(doors, { ...options, costBetween: disconnected }).properties, doors);
});

test('missing road evidence, null/unreachable edges and missing street names cannot fabricate improvements', () => {
    const missing = review(doors);
    assert.equal(missing.properties, doors); assert.equal(missing.diagnostics.status, 'road_evidence_unavailable');
    for (const value of [null, Infinity, NaN, -1]) {
        const result = review(doors, { ...options, costBetween: () => value });
        assert.equal(result.properties, doors);
        assert.equal(result.diagnostics.status, 'partial_road_evidence');
    }
    const anonymous = doors.map(({ street_name, subdivision_name, ...p }) => ({ ...p, city: 'Phoenix' }));
    assert.equal(review(anonymous, options).diagnostics.detected, 0);
});

test('contiguity is an opt-in bounded tie preference', () => {
    const equal = () => 1;
    assert.equal(review(doors, { ...options, costBetween: equal }).properties, doors);
    const preferred = review(doors, { ...options, costBetween: equal, preferContiguousOnTie: true });
    assert.equal(preferred.diagnostics.remaining, 0);
    assert.equal(preferred.diagnostics.secondsSaved, 0);
});

test('membership errors are fatal and the deterministic budget limits search work', () => {
    assert.throws(() => review([...doors, doors[0]], options), /membership/);
    assert.throws(() => review(doors, { ...options, lockedStopIds: ['missing'] }), /Locked stop/);
    const big = Array.from({ length: 10000 }, (_, i) => stop(i, i % 2 ? 'X' : 'A'));
    const result = review(big, { ...options, maxEvaluations: 7 });
    assert.ok(result.diagnostics.evaluated <= 7); assert.equal(result.diagnostics.budgetExhausted, true);
    assert.equal(result.properties.length, big.length);
});

test('async sparse preparation produces the same result; provider failure preserves the original', async () => {
    let count = 0;
    const result = await reviewNeighborhoodExcursionsAsync(doors, { ...options, prepareCosts: async pairs => { count += pairs.length; } });
    assert.ok(count > 0); assert.deepEqual(result.properties, review(doors, options).properties);
    const failed = await reviewNeighborhoodExcursionsAsync(doors, { ...options, prepareCosts: async () => { throw new Error('Provider unavailable'); } });
    assert.equal(failed.properties, doors); assert.equal(failed.diagnostics.status, 'road_evidence_unavailable');
    await assert.rejects(reviewNeighborhoodExcursionsAsync(doors, { ...options, prepareCosts: async () => { throw new Error('graph identity changed'); } }), /graph identity/);
    await assert.rejects(reviewNeighborhoodExcursionsAsync(doors, { ...options, signal: AbortSignal.abort(new DOMException('Cancelled', 'AbortError')) }), /Cancelled/);
});

function provider({ slower = false, wrongSnap = false, unreachable = false, tied = false, badSeam = false } = {}) {
    const calls = [];
    const fetch = async input => {
        const url = new URL(input); calls.push(url);
        const coordinates = url.pathname.split('/').at(-1).split(';').map(p => p.split(',').map(Number));
        const items = coordinates.map(([lng, lat]) => ({ id: String(Math.round((lng + 81) * 100000)), lat, lng }));
        items.forEach(p => p.subdivision_name = doors.find(d => d.id === p.id)?.subdivision_name || 'Y');
        const snaps = coordinates.map(location => ({ location: wrongSnap ? [-80, 35] : location, name: 'Main St' }));
        const data = { code: 'Ok', data_version: 'graph-1' };
        if (url.pathname.includes('/table/')) {
            const sources = url.searchParams.get('sources').split(';').map(Number), targets = url.searchParams.get('destinations').split(';').map(Number);
            data.sources = sources.map(i => snaps[i]); data.destinations = targets.map(i => snaps[i]);
            data.durations = sources.map(a => targets.map(b => cost(items[a], items[b])));
            if (unreachable) data.durations = data.durations.map(row => row.map(v => v ? null : 0));
            data.distances = data.durations.map(row => row.map(s => s * 10));
        } else {
            const seconds = tied ? 250 : slower && items[1]?.id !== '94' ? 1000 : total(items);
            data.waypoints = snaps;
            const legs = items.slice(1).map((p, i) => ({ duration: cost(items[i], p), distance: cost(items[i], p) * 10,
                steps: [{ geometry: { coordinates: [coordinates[i], coordinates[i + 1]] } }] }));
            data.routes = [{ duration: seconds, distance: seconds * 10, geometry: { coordinates }, legs }];
            if (badSeam && coordinates.length < 500) {
                legs[0].duration += 5; legs[0].distance += 50;
                data.routes[0].duration += 5; data.routes[0].distance += 50;
            }
        }
        return Response.json(data);
    };
    return { fetch, calls };
}

test('final assembled review uses bounded sparse road tables and whole-route turn validation', async () => {
    const engine = provider();
    const result = await reviewFinalNeighborhoodRoute(doors, { vehicleFetch: engine.fetch });
    assert.equal(result.diagnostics.applied, true);
    assert.ok(result.measurement.driveSeconds < total(doors));
    assert.equal(engine.calls.filter(u => u.pathname.includes('/route/')).length, 2);
    assert.ok(engine.calls.every(u => u.pathname.split('/').at(-1).split(';').length <= 100));
    assert.ok(engine.calls.filter(u => u.pathname.includes('/route/')).every(u => u.searchParams.get('continue_straight') === 'true'));
    const slower = await reviewFinalNeighborhoodRoute(doors, { vehicleFetch: provider({ slower: true }).fetch });
    assert.equal(slower.properties, doors); assert.equal(slower.diagnostics.status, 'whole_route_guard_retained');
    const bad = await reviewFinalNeighborhoodRoute(doors, { vehicleFetch: provider({ wrongSnap: true }).fetch });
    assert.equal(bad.properties, doors); assert.equal(bad.diagnostics.status, 'road_evidence_unavailable');
    const tied = await reviewFinalNeighborhoodRoute(doors, { vehicleFetch: provider({ tied: true }).fetch });
    assert.equal(tied.properties, doors); assert.equal(tied.diagnostics.status, 'whole_route_guard_retained');
});

test('sparse contexts avoid all-door matrices, cache pairs and retain unreachable directions', async () => {
    const engine = provider();
    const context = await createVehicleRoutingContext(doors, { accessFor: () => null }, { sparseCosts: true, vehicleFetch: engine.fetch });
    assert.equal(engine.calls.length, 0);
    assert.equal(context.optimizationCostBetween(doors[0], doors[1]), Infinity);
    await context.prepareCosts([[doors[0], doors[1]]]);
    assert.equal(context.optimizationCostBetween(doors[0], doors[1]), 100);
    const count = engine.calls.length;
    await context.prepareCosts([[doors[0], doors[1]]]); assert.equal(engine.calls.length, count);
    const unreachable = await createVehicleRoutingContext(doors, { accessFor: () => null }, {
        sparseCosts: true, vehicleFetch: provider({ unreachable: true }).fetch });
    await unreachable.prepareCosts([[doors[0], doors[1]]]);
    assert.equal(unreachable.optimizationCostBetween(doors[0], doors[1]), Infinity);
});

test('shared driving pilot reviews a custom proposal before saving its final order', async () => {
    const result = await evaluateCoreDrivingRoute({ legacyOrder: doors, propose: () => doors,
        createContext: async () => ({ vehicleAware: true, optimizationCostBetween: cost,
            routeSequence: async order => ({ driveSeconds: total(order), distanceMiles: total(order) / 10,
                geometry: [{ lat: 35, lng: -81 }, { lat: 35, lng: -80.99 }] }) }) });
    assert.equal(result.selection, 'road_aware'); assert.equal(result.neighborhoodReview.remaining, 0);
});

test('the assembled review catches an excursion across the 500-stop window boundary', async () => {
    const filler = Array.from({ length: 600 }, (_, i) => stop(1000 + i, 'Y', 'Main'));
    const input = [...filler.slice(0, 498), ...doors.slice(0, 3), ...filler.slice(498)];
    const engine = provider();
    const result = await reviewFinalNeighborhoodRoute(input, { vehicleFetch: engine.fetch });
    assert.equal(result.diagnostics.applied, true);
    assert.deepEqual(new Set(result.properties), new Set(input));
    assert.equal(result.measurement.driveSeconds, total(result.properties));
    assert.ok(result.measurement.driveSeconds < total(input));
    const routes = engine.calls.filter(u => u.pathname.includes('/route/'));
    assert.ok(routes.length >= 4);
    assert.ok(routes.every(u => u.pathname.split('/').at(-1).split(';').length <= 500));
    const inconsistent = await reviewFinalNeighborhoodRoute(input, { vehicleFetch: provider({ badSeam: true }).fetch });
    assert.equal(inconsistent.properties, input);
    assert.match(inconsistent.diagnostics.reason, /turn continuity/);
});

test('resolved access roads are used for costs and a mismatched road name preserves the input', async () => {
    const input = doors.map(p => ({ ...p, routing_access: { resolution_status: 'resolved', confidence: 'high',
        point: { lat: p.lat, lng: p.lng }, roadName: 'Expected Road' } }));
    const result = await reviewFinalNeighborhoodRoute(input, { vehicleFetch: provider().fetch });
    assert.equal(result.properties, input);
    assert.match(result.diagnostics.reason, /different service road/);
});
