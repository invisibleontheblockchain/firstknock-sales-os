import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyRouteStopRemoval,
    buildRouteStopRemovalUpdate,
    getRouteStopRemovalContinuation,
    removeSavedRouteStop,
    routeContainsProperty,
} from '../src/lib/routeStopRemoval.js';
import { hydrateRouteWithLookup, orderRouteProperties } from '../src/components/logic/routeHydrationCore.js';
import { calculateRouteDistanceMiles } from '../base44/shared/routeBounds.js';

const a = { id: 'id-a', address_hash: 'a', lat: 33.4, lng: -112.1 };
const outlier = { id: 'id-b', address_hash: 'b', legacy_hash: 'old-b', lat: 34.8, lng: -112.8 };
const c = { id: 'id-c', address_hash: 'c', lat: 33.41, lng: -112.11 };
const route = {
    id: 'route-1', name: 'Uploaded addresses', status: 'ACTIVE', assigned_to: 'rep-1',
    property_hashes: ['a', 'b', 'c'], properties: [a, outlier, c], allProperties: [a, outlier, c],
    metrics: { distance: 250, house_count: 3, score: 8 },
    metadata: { keep: 'import info', road_geometry: [a, outlier, c], road_geometry_segments: [{ points: [a, outlier] }],
        routing: { property_order_fingerprint: 'stale', road_aware_routing_beta: true },
        road_network_used: true, road_verification: { verdict: 'road_adopted', verified: true } },
};

test('removing an outlier keeps stop order and score, recalculates distance and clears old road geometry', () => {
    const original = structuredClone(route);
    const update = buildRouteStopRemovalUpdate(route, outlier, route.properties);
    assert.deepEqual(update.property_hashes, ['a', 'c']);
    assert.equal(update.metrics.house_count, 2);
    assert.equal(update.metrics.score, 8);
    assert.equal(update.metrics.distance, Math.round(calculateRouteDistanceMiles([a, c]) * 100) / 100);
    assert.equal(update.metadata.keep, 'import info');
    assert.equal(update.metadata.road_geometry, undefined);
    assert.equal(update.metadata.road_geometry_segments, undefined);
    assert.equal(update.metadata.routing, undefined);
    assert.equal(update.metadata.road_verification.verified, false);
    assert.deepEqual(route, original);
});

test('persists only this route and uses the current server manifest even with a filtered or stale local list', async () => {
    const server = { ...route, property_hashes: ['c', 'b', 'a', 'new-stop'] };
    const writes = [];
    const entities = { SavedRoute: {
        get: async id => { assert.equal(id, route.id); return server; },
        update: async (id, update) => { writes.push({ id, update }); return { id, ...update }; },
    } };
    const { savedRoute: result } = await removeSavedRouteStop({ route: { ...route, properties: [outlier], allProperties: [] }, property: outlier, entities });
    assert.deepEqual(result.property_hashes, ['c', 'a', 'new-stop']);
    assert.equal(result.assigned_to, 'rep-1');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].id, route.id);
    assert.deepEqual(Object.keys(writes[0].update).sort(), ['metadata', 'metrics', 'property_hashes']);
    assert.equal(result.metrics.distance, undefined, 'never retain an old estimate when remaining coordinates are unknown');
    assert.deepEqual(server.property_hashes, ['c', 'b', 'a', 'new-stop']);
});

test('legacy identities and duplicate entries for the removed stop cannot remain on the route', () => {
    const legacy = { ...route, property_hashes: ['a', 'old-b', 'b', 'b', 'id-b', 'c'] };
    assert.equal(routeContainsProperty(legacy, outlier), true);
    assert.deepEqual(buildRouteStopRemovalUpdate(legacy, outlier, route.properties).property_hashes, ['a', 'c']);
});

test('removing the final stop leaves an empty route and clears every in-memory pin', () => {
    const last = { ...route, property_hashes: ['b'], properties: [outlier], allProperties: [outlier],
        start_location: a, end_location: c };
    const update = buildRouteStopRemovalUpdate(last, outlier, [outlier]);
    assert.equal(update.metrics.distance, 0);
    const applied = applyRouteStopRemoval(last, { id: last.id, ...update });
    assert.deepEqual(applied.properties, []);
    assert.deepEqual(applied.allProperties, []);
    assert.equal(applied.houseCount, 0);
    assert.deepEqual(orderRouteProperties({ ...last, ...update }).properties, []);
});

test('rehydrating an empty saved manifest cannot bring back a removed stop from cache', async () => {
    const empty = await hydrateRouteWithLookup({ ...route, property_hashes: [] }, async () => {
        assert.fail('An empty manifest must not fetch properties');
    });
    assert.deepEqual(empty.properties, []);
    assert.deepEqual(empty.allProperties, []);
    assert.equal(empty.houseCount, 0);
    assert.equal(orderRouteProperties({ properties: [a] }).properties[0], a, 'unsaved routes without manifests keep their stops');
});

test('the map keeps only manifest stops in server order and a display filter remains a subset', () => {
    const applied = applyRouteStopRemoval({ ...route, properties: [a, outlier] }, {
        id: route.id, ...buildRouteStopRemovalUpdate({ ...route, property_hashes: ['c', 'b', 'a'] }, outlier, route.properties),
    });
    assert.deepEqual(applied.properties, [a]);
    assert.deepEqual(applied.allProperties, [c, a]);
    assert.equal(applied.houseCount, 2);
});

test('missing membership, unsaved and archived routes never write', async () => {
    let writes = 0;
    const entities = { SavedRoute: {
        get: async () => ({ ...route, status: 'ARCHIVED' }),
        update: async () => { writes++; },
    } };
    await assert.rejects(removeSavedRouteStop({ route, property: outlier, entities }), /read-only/);
    await assert.rejects(removeSavedRouteStop({ route: { ...route, isSaved: false }, property: outlier, entities }), /Save this route/);
    entities.SavedRoute.get = async () => ({ ...route, property_hashes: ['a', 'c'] });
    await assert.rejects(removeSavedRouteStop({ route, property: outlier, entities }), /no longer/);
    assert.equal(writes, 0);
});

test('a failed save propagates without changing the current route or its properties', async () => {
    const original = structuredClone(route);
    const entities = { SavedRoute: {
        get: async () => route,
        update: async () => { throw new Error('offline'); },
    } };
    await assert.rejects(removeSavedRouteStop({ route, property: outlier, entities }), /offline/);
    assert.deepEqual(route, original);
});

test('confirmed removal advances from 101 to 102 and connects 100 directly to 102', async () => {
    const before = { ...route, property_hashes: ['100', '101', '102'], properties: [
        { ...a, address_hash: '100' }, { ...outlier, address_hash: '101' }, { ...c, address_hash: '102' },
    ], allProperties: [] };
    let writes = 0;
    const result = await removeSavedRouteStop({ route: before, property: before.properties[1], entities: { SavedRoute: {
        get: async () => before,
        update: async (_id, update) => { writes++; return { id: before.id, ...update }; },
    } } });
    const after = applyRouteStopRemoval(before, result.savedRoute);
    assert.equal(writes, 1);
    assert.deepEqual(after.property_hashes, ['100', '102']);
    assert.deepEqual(after.properties.map(stop => stop.address_hash), ['100', '102']);
    assert.deepEqual(after.allProperties.map(stop => stop.address_hash), ['100', '102']);
    assert.equal(result.nextStop.property.address_hash, '102');
    assert.equal(result.nextStop.index, 1, 'the next stop takes the removed stop’s position');
});

test('continuation uses the latest server order and resolves legacy next-stop hashes', async () => {
    const server = { ...route, property_hashes: ['b', 'old-c', 'a'] };
    const result = await removeSavedRouteStop({ route: { ...route, properties: [a, outlier, { ...c, legacy_hash: 'old-c' }] },
        property: outlier, entities: { SavedRoute: { get: async () => server,
            update: async (_id, update) => ({ id: server.id, ...update }),
        } } });
    assert.equal(result.nextStop.hash, 'old-c');
    assert.equal(result.nextStop.property.address_hash, 'c');
    assert.equal(result.nextStop.index, 0);
});

test('removing the final stop finishes instead of reopening an earlier stop', () => {
    assert.equal(getRouteStopRemovalContinuation(route, c, { property_hashes: ['a', 'b'] }, route.properties), null);
    assert.equal(getRouteStopRemovalContinuation({ ...route, property_hashes: ['b'] }, outlier, { property_hashes: [] }, [outlier]), null);
});
