import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'vite';
import { QueryClient } from '@tanstack/react-query';
import { toast as appToast } from 'sonner';

let vite, persist, optimize, toast;
const originalToasts = {};
const messages = [];
before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
    persist = (await vite.ssrLoadModule('/src/lib/routeOptimizePersistence.js')).persistOptimizedRoute;
    optimize = (await vite.ssrLoadModule('/src/lib/reoptimizeRouteAction.js')).reoptimizeRoute;
    toast = appToast;
    for (const type of ['loading', 'success', 'error', 'info', 'warning']) {
        originalToasts[type] = toast[type];
        toast[type] = message => { messages.push({ type, message }); };
    }
});
after(async () => {
    Object.assign(toast, originalToasts);
    await vite?.close();
});

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/troutman-neighborhood-311-317.json', import.meta.url)));
const properties = fixture.properties.slice(1, -1);
const hash = property => property.address_hash;
const originalHashes = properties.map(hash);
const candidate = fixture.desiredOrder.map(stop => properties.find(property => property.stop === stop));
const candidateHashes = candidate.map(hash);
const route = { id: 'troutman', property_hashes: originalHashes, properties, allProperties: properties,
    route_origin_mode: 'none', metrics: { distance: 10, house_count: properties.length } };
const update = { property_hashes: candidateHashes, metrics: { distance: 8, house_count: properties.length },
    metadata: {}, route_origin_mode: 'none', start_location: null, end_location: null };
const client = response => ({ entities: { SavedRoute: { update: async () => response } } });

test('confirmed optimization updates map, checklist and every cached route order before success', async () => {
    messages.length = 0;
    const queries = new QueryClient();
    const keys = [['savedRoutes', 'manager'], ['myRoutes', 'rep'], ['savedRouteMapProperties', 'manager'], ['routeMap', 'email', route.id]];
    keys.forEach((key, i) => queries.setQueryData(key, i === 3 ? route : [route, { id: 'other' }]));
    let active = route;
    let written;
    const api = { functions: { invoke: async (name, payload) => {
        assert.equal(name, 'optimizeRouteRoadMatrix');
        assert.equal(payload.start_location, undefined);
        assert.equal(payload.end_location, undefined);
        return { data: { success: true, selected: 'road_aware', order: candidateHashes,
            routing_metadata: { input_measured: 10, winning_route_distance: 8, duration_improvement: 1,
                road_network_used: true, neighborhood_excursion_review: { applied: true,
                    local_driving_review: { applied: true, validation: 'overlapping_boundary_legs', localMilesSaved: 2 } } } } };
    } }, entities: { SavedRoute: { update: async (id, body) => {
        assert.equal(id, route.id);
        written = body;
        assert.equal(messages.some(message => message.type === 'success'), false);
        return { ...route, ...body, updated_date: '2026-10-14T20:00:00Z' };
    } } } };
    await optimize(route, { mode: 'route_only' }, { client: api, queryClient: queries,
        // Even an out-of-date click-time selection must use today's selection.
        activeRoute: null, setActiveRoute: updater => { active = updater(active); } });
    assert.deepEqual(written.property_hashes, candidateHashes);
    assert.deepEqual(active.properties.map(hash), candidateHashes);
    assert.deepEqual(active.allProperties.map(hash), candidateHashes);
    assert.deepEqual(active.property_hashes, candidateHashes);
    assert.equal(active.updated_date, '2026-10-14T20:00:00Z');
    assert.equal(active.totalDistance, 8);
    for (const key of keys) {
        const data = queries.getQueryData(key);
        const reopened = Array.isArray(data) ? data[0] : data;
        assert.deepEqual(reopened.property_hashes, candidateHashes);
        assert.deepEqual(reopened.properties.map(hash), candidateHashes);
        assert.deepEqual(reopened.allProperties.map(hash), candidateHashes);
        if (Array.isArray(data)) assert.equal(data[1].id, 'other');
    }
    const completion = messages.find(message => message.type === 'warning');
    assert.match(completion.message, /stops reordered/);
    assert.match(completion.message, /Verified neighborhood savings/);
    assert.match(completion.message, /still need checking/);
    assert.equal(messages.some(message => message.type === 'error'), false);
    queries.clear();
});

test('a rejected or mismatched save cannot publish a new map order or success', async () => {
    for (const response of [route, { ...route, property_hashes: candidateHashes.slice(1) }]) {
        let changed = false;
        const queries = new QueryClient();
        queries.setQueryData(['savedRoutes'], [route]);
        await assert.rejects(persist({ route, update, properties: candidate, client: client(response), queryClient: queries,
            setActiveRoute: () => { changed = true; } }), /did not keep the optimized stop order/);
        assert.equal(changed, false);
        assert.deepEqual(queries.getQueryData(['savedRoutes'])[0].property_hashes, originalHashes);
        queries.clear();
    }
    await assert.rejects(persist({ route, update, properties: candidate,
        client: { entities: { SavedRoute: { update: async () => { throw new Error('offline'); } } } },
        setActiveRoute: () => assert.fail('unsaved order must not appear') }), /offline/);
});

test('an acknowledgement without a manifest requires a confirmed read of the saved order', async () => {
    let reads = 0;
    const api = { entities: { SavedRoute: { update: async () => ({ id: route.id }), get: async id => {
        assert.equal(id, route.id); reads++;
        return { ...route, ...update };
    } } } };
    const saved = await persist({ route, update, properties: candidate, client: api });
    assert.equal(reads, 1);
    assert.deepEqual(saved.property_hashes, candidateHashes);
});

test('a route selected or closed while optimizing is never replaced by the completed route', async () => {
    for (const selection of [null, { id: 'other', properties: [] }]) {
        let active = selection;
        await persist({ route, update, properties: candidate, client: client({ ...route, ...update }),
            setActiveRoute: updater => { active = updater(active); } });
        assert.equal(active, selection);
    }
});

test('route-only clears stale personal trip bounds in cached routes as well as the active map', async () => {
    const home = { lat: 35, lng: -80 };
    const anchored = { ...route, route_origin_mode: 'home_round_trip', routeOriginMode: 'home_round_trip',
        startLocation: home, endLocation: home };
    const queries = new QueryClient();
    queries.setQueryData(['savedRoutes'], [anchored]);
    let active = anchored;
    await persist({ route: anchored, update, properties: candidate, client: client({ ...route, ...update }),
        queryClient: queries, setActiveRoute: updater => { active = updater(active); } });
    for (const result of [active, queries.getQueryData(['savedRoutes'])[0]]) {
        assert.equal(result.routeOriginMode, 'none');
        assert.equal(result.startLocation, null);
        assert.equal(result.endLocation, null);
    }
    queries.clear();
});

test('an older hydration finishing after save cannot restore the previous cached order', async () => {
    const queries = new QueryClient();
    const key = ['savedRouteMapProperties', 'manager'];
    queries.setQueryData(key, [route]);
    let finishOldRequest;
    const pending = queries.fetchQuery({ queryKey: key, queryFn: () => new Promise(resolve => { finishOldRequest = resolve; }) });
    const cancelled = pending.catch(() => null);
    await persist({ route, update, properties: candidate, client: client({ ...route, ...update }), queryClient: queries });
    finishOldRequest([route]);
    await cancelled;
    assert.deepEqual(queries.getQueryData(key)[0].property_hashes, candidateHashes);
    queries.clear();
});

test('the Optimize action reports a mismatched save as failure without changing the visible route', async () => {
    messages.length = 0;
    let active = route;
    const api = client(route);
    api.functions = { invoke: async () => ({ data: { success: true, selected: 'road_aware', order: candidateHashes,
        routing_metadata: { input_measured: 10, winning_route_distance: 8 } } }) };
    await optimize(route, { mode: 'route_only' }, { client: api, setActiveRoute: updater => { active = updater(active); } });
    assert.equal(active, route);
    assert.equal(messages.some(message => message.type === 'success'), false);
    assert.match(messages.find(message => message.type === 'error').message, /did not keep the optimized stop order/);
});

test('a backend returning the same order with old savings reports an unchanged route', async () => {
    messages.length = 0;
    const verified = { ...route, metadata: { routing: { road_aware: true, fallback: false } } };
    const api = { functions: { invoke: async () => ({ data: { success: true, selected: 'road_aware', order: originalHashes,
        routing_metadata: { input_measured: 10, winning_route_distance: 10, neighborhood_excursion_review: {
            applied: true, local_driving_review: { applied: true, validation: 'overlapping_boundary_legs', localMilesSaved: 24.32 },
    } } } }) }, entities: { SavedRoute: { update: async (_id, body) => {
        assert.equal('property_hashes' in body, false, 'an unchanged stop manifest must not be rewritten');
        return { ...verified, ...body };
    } } } };
    await optimize(verified, { mode: 'route_only' }, { client: api });
    assert.equal(messages.some(message => message.type === 'success'), false);
    assert.match(messages.find(message => message.type === 'info').message, /route was kept unchanged/);
    assert.equal(messages.some(message => /24\.32|improvements applied/.test(message.message)), false);
});

test('a map display filter does not omit stops from route-only optimization', async () => {
    messages.length = 0;
    const filtered = { ...route, properties: properties.slice(0, 1) };
    let active = route;
    const api = client({ ...route, ...update });
    api.functions = { invoke: async (_name, payload) => {
        assert.deepEqual(payload.properties.map(hash), originalHashes);
        return { data: { success: true, selected: 'road_aware', order: candidateHashes,
            routing_metadata: { input_measured: 10, winning_route_distance: 8 } } };
    } };
    await optimize(filtered, { mode: 'route_only' }, { client: api, setActiveRoute: updater => { active = updater(active); } });
    assert.deepEqual(active.properties.map(hash), candidateHashes);
    assert.equal(messages.some(message => message.type === 'error'), false);
});
