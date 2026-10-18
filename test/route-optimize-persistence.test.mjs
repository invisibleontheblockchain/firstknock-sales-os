import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'vite';
import { QueryClient } from '@tanstack/react-query';
import { toast as appToast } from 'sonner';

let vite, persist, optimize, toast;
const originalToasts = {};
const messages = [];

// Optimize saves onto the stored record (src/lib/mapRouteFields.js). In these
// tests the stored record is the route under test, so a stub client without
// SavedRoute.get answers with that route.
const withStoredRoute = run => (route, options, deps = {}) => {
    const entities = deps.client?.entities;
    if (!entities?.SavedRoute || entities.SavedRoute.get) return run(route, options, deps);
    const client = { ...deps.client, entities: { ...entities, SavedRoute: { ...entities.SavedRoute, get: async id => ({ ...route, id }) } } };
    return run(route, options, { ...deps, client });
};
before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
    persist = (await vite.ssrLoadModule('/src/lib/routeOptimizePersistence.js')).persistOptimizedRoute;
    optimize = withStoredRoute((await vite.ssrLoadModule('/src/lib/reoptimizeRouteAction.js')).reoptimizeRoute);
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
    // One plain success line; search coverage stays in the saved attempt.
    const completion = messages.find(message => message.type === 'success');
    assert.match(completion.message, /^Route optimized · \d+ stops reordered · ~2 mi shorter$/);
    assert.equal(messages.some(message => message.type === 'error' || message.type === 'warning'), false);
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
    assert.equal(messages.find(message => message.type === 'success').message, 'Route checked · already the shortest order found');
    assert.equal(messages.some(message => /24\.32|improvements applied|reordered/.test(message.message)), false);
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

test('a complete selected route optimizes without reading the territory inventory or loading other routes', async () => {
    messages.length = 0;
    let calls = 0, saved;
    const unrelatedInventory = new Proxy([], { get(target, key) {
        if (key === 'map' || key === Symbol.iterator) assert.fail('complete route must not scan territory homes');
        return Reflect.get(target, key);
    } });
    await optimize(route, { mode: 'route_only' }, {
        effectiveProperties: unrelatedInventory,
        hydrateRoute: () => assert.fail('complete route must not queue hydration'),
        client: { functions: { invoke: async (name, payload) => {
            calls++;
            assert.equal(name, 'optimizeRouteRoadMatrix');
            assert.deepEqual(payload.properties.map(hash), originalHashes);
            return { data: { success: true, selected: 'road_aware', order: candidateHashes,
                routing_metadata: { input_measured: 10, winning_route_distance: 8 } } };
        } }, entities: { SavedRoute: { update: async (_id, patch) => { saved = { ...route, ...patch }; return saved; } } } },
    });
    assert.equal(calls, 1);
    assert.deepEqual(saved.property_hashes, candidateHashes);
    assert.equal(messages.some(message => message.type === 'error'), false);
});

test('missing selected-route homes load on demand before Optimize without waiting for account history', async () => {
    messages.length = 0;
    const partial = { ...route, properties: properties.slice(0, 1), allProperties: [] };
    const requests = [];
    let saved;
    await optimize(partial, { mode: 'route_only' }, {
        user: { email: 'manager@example.test' },
        effectiveProperties: [],
        hydrateRoute: async (selected, email) => {
            requests.push('selected-route');
            assert.equal(email, 'manager@example.test');
            assert.equal(selected.id, route.id);
            assert.deepEqual(selected.property_hashes, originalHashes);
            return route;
        },
        client: { functions: { invoke: async (name, payload) => {
            requests.push(name);
            assert.deepEqual(payload.properties.map(hash), originalHashes);
            return { data: { success: true, selected: 'road_aware', order: candidateHashes,
                routing_metadata: { input_measured: 10, winning_route_distance: 8 } } };
        } }, entities: { SavedRoute: { update: async (_id, patch) => { saved = { ...route, ...patch }; return saved; } } } },
    });
    assert.deepEqual(requests, ['selected-route', 'optimizeRouteRoadMatrix']);
    assert.deepEqual(saved.property_hashes, candidateHashes);
});

test('an incomplete selected-route lookup cannot optimize or save a smaller route', async () => {
    messages.length = 0;
    const partial = { ...route, properties: properties.slice(0, 1), allProperties: [] };
    await optimize(partial, { mode: 'route_only' }, {
        hydrateRoute: async () => partial,
        client: { functions: { invoke: () => assert.fail('incomplete route cannot be optimized') },
            entities: { SavedRoute: { update: () => assert.fail('incomplete route cannot be saved') } } },
    });
    assert.ok(messages.some(message => message.type === 'error' && /route homes could not be loaded/.test(message.message)));
});

const fullReview = { applied: false, planned: 1, checked: 1, skipped: [], budgetExhausted: false, validation: 'whole_route' };
const recoveredAccess = { resolution_status: 'resolved', confidence: 'medium', source: 'address_geocode_recovery',
    point: { lat: properties[0].lat + 0.0002, lng: properties[0].lng + 0.0002 },
    displayPoint: { lat: properties[0].lat, lng: properties[0].lng }, roadName: properties[0].street_name,
    evidence: { propertyIdentity: hash(properties[0]) } };
const recovery = { status: 'recovered', attempted: 1, recovered: 1, reused: 0, inventory_complete: true, unresolved: [],
    access_overrides: { [hash(properties[0])]: recoveredAccess } };

test('a first-time explicit Optimize failure records a visible result without using a local reorder', async () => {
    messages.length = 0;
    const initial = { ...route, metadata: { source: 'batchdata_live' } };
    const queries = new QueryClient();
    queries.setQueryData(['savedRoutes'], [initial]);
    let active = initial, calls = 0, written;
    const api = { functions: { invoke: async (name, payload) => {
        calls++;
        assert.equal(name, 'optimizeRouteRoadMatrix');
        assert.deepEqual(payload.properties.map(hash), originalHashes);
        return { data: { success: false, error: 'Road provider unavailable' } };
    } }, entities: { SavedRoute: { update: async (id, body) => {
        assert.equal(id, route.id); written = body; return { ...initial, ...body };
    } } } };
    await optimize(initial, { mode: 'route_only' }, { client: api, queryClient: queries,
        setActiveRoute: updater => { active = updater(active); } });
    assert.equal(calls, 1);
    assert.equal('property_hashes' in written, false);
    assert.equal(written.metadata.source, 'batchdata_live');
    assert.equal(written.metadata.last_optimization_attempt.status, 'failed');
    assert.equal(written.metadata.last_optimization_attempt.route_changed, false);
    assert.match(written.metadata.last_optimization_attempt.message, /route was kept unchanged/);
    for (const result of [active, queries.getQueryData(['savedRoutes'])[0]]) {
        assert.deepEqual(result.property_hashes, originalHashes);
        assert.deepEqual(result.properties.map(hash), originalHashes);
        assert.equal(result.metadata.last_optimization_attempt.status, 'failed');
    }
    assert.equal(messages.some(message => message.type === 'success'), false);
    assert.match(messages.find(message => message.type === 'error').message, /kept unchanged/);
    queries.clear();
});

test('recovered road access is reused on the next invocation and retained after an unchanged route result', async () => {
    messages.length = 0;
    const cached = { ...route, metadata: { road_access_recovery: recovery } };
    let written, active = cached;
    const api = { functions: { invoke: async (_name, payload) => {
        const stop = payload.properties.find(property => hash(property) === hash(properties[0]));
        assert.deepEqual(stop.routing_access, recoveredAccess);
        assert.equal(stop.lat, properties[0].lat);
        assert.equal(stop.lng, properties[0].lng);
        return { data: { success: true, selected: 'current', order: originalHashes, routing_metadata: {
            input_measured: 10, matrix_tier: 'door', road_access_recovery: { ...recovery, recovered: 0, reused: 1 },
            neighborhood_excursion_review: { local_driving_review: fullReview },
        } } };
    } }, entities: { SavedRoute: { update: async (_id, body) => { written = body; return { ...cached, ...body }; } } } };
    await optimize(cached, { mode: 'route_only' }, { client: api, setActiveRoute: updater => { active = updater(active); } });
    assert.equal('property_hashes' in written, false);
    assert.equal(written.metadata.road_access_recovery.reused, 1);
    assert.deepEqual(written.metadata.road_access_recovery.access_overrides, recovery.access_overrides);
    assert.equal(written.metadata.last_optimization_attempt.status, 'no_improvement');
    assert.equal(written.metadata.last_optimization_attempt.route_changed, false);
    assert.deepEqual(active.property_hashes, originalHashes);
    assert.deepEqual(active.metadata.road_access_recovery.access_overrides[hash(properties[0])], recoveredAccess);
    assert.equal(active.properties[0].lat, properties[0].lat);
    assert.equal(active.properties[0].lng, properties[0].lng);
    assert.equal(properties[0].routing_access, undefined, 'the caller-owned display property is never mutated');
    assert.equal(messages.find(message => message.type === 'success').message, 'Route checked · already the shortest order found');
});

test('a recovered successful optimization replaces stale failures in saved routes and keeps property pins unchanged', async () => {
    messages.length = 0;
    const stale = { ...route, metadata: { road_access_recovery: { status: 'unresolved', unresolved: [{ property_id: hash(properties[0]) }] },
        last_optimization_attempt: { status: 'failed', message: 'Old failure', route_changed: false } } };
    const queries = new QueryClient();
    queries.setQueryData(['savedRouteMapProperties'], [stale]);
    let written, active = stale;
    const api = { functions: { invoke: async () => ({ data: { success: true, selected: 'road_aware', order: candidateHashes,
        routing_metadata: { road_network_used: true, input_measured: 10, winning_route_distance: 8,
            road_access_recovery: recovery, neighborhood_excursion_review: { local_driving_review: fullReview } },
    } }) }, entities: { SavedRoute: { update: async (_id, body) => { written = body; return { ...stale, ...body }; } } } };
    await optimize(stale, { mode: 'route_only' }, { client: api, queryClient: queries,
        setActiveRoute: updater => { active = updater(active); } });
    assert.deepEqual(written.property_hashes, candidateHashes);
    for (const result of [active, queries.getQueryData(['savedRouteMapProperties'])[0]]) {
        assert.equal(result.metadata.last_optimization_attempt.status, 'applied');
        assert.equal(result.metadata.last_optimization_attempt.route_changed, true);
        assert.equal(result.metadata.last_optimization_attempt.stops_reordered,
            candidateHashes.filter((value, index) => value !== originalHashes[index]).length);
        assert.match(result.metadata.last_optimization_attempt.message, /recovered automatically for 1 stop/);
        assert.doesNotMatch(result.metadata.last_optimization_attempt.message, /Old failure|unresolved|kept unchanged/);
        assert.deepEqual(result.metadata.road_access_recovery.unresolved, []);
        assert.deepEqual(result.metadata.road_access_recovery.access_overrides, recovery.access_overrides);
        for (const property of result.properties) {
            const original = properties.find(stop => hash(stop) === hash(property));
            assert.equal(property.lat, original.lat); assert.equal(property.lng, original.lng);
        }
    }
    assert.equal(messages.some(message => message.type === 'error'), false);
    // Recovery is in the saved attempt; the person sees the plain result.
    assert.match(messages.find(message => message.type === 'success').message, /^Route optimized · /);
    queries.clear();
});

test('an access-limited applied repair preserves the prior distance and never claims a whole-route measurement', async () => {
    messages.length = 0;
    const partialOrder = [...originalHashes];
    [partialOrder[1], partialOrder[2]] = [partialOrder[2], partialOrder[1]];
    const unresolved = { property_id: originalHashes.at(-1), stop_number: properties.length,
        address: `${properties.at(-1).house_number} ${properties.at(-1).street_name}`, reason: 'road_not_matched' };
    const accessReport = { ...recovery, status: 'partial', attempted: 2, inventory_complete: true,
        unverified_count: 0, unresolved: [unresolved] };
    let written, active = route;
    const api = { functions: { invoke: async () => ({ data: { success: true, selected: 'road_aware', order: partialOrder,
        routing_metadata: { strategy: 'access_guarded_neighborhood_repair', road_network_used: true,
            matrix_provider: 'test-driving-roads', road_matrix_version: 'v1', routing_profile: 'driving',
            road_path_validated: false, distance_estimate: 'unavailable', input_measured: null, winning_route_distance: null,
            road_access_recovery: accessReport, neighborhood_excursion_review: { local_driving_review: {
                ...fullReview, applied: true, validation: 'overlapping_boundary_legs', localMilesSaved: 1.25,
            } } },
    } }) }, entities: { SavedRoute: { update: async (_id, body) => { written = body; return { ...route, ...body }; } } } };
    await optimize(route, { mode: 'route_only' }, { client: api, setActiveRoute: updater => { active = updater(active); } });
    assert.deepEqual(written.property_hashes, partialOrder);
    assert.equal(written.property_hashes.at(-1), originalHashes.at(-1));
    assert.equal(written.metrics.distance, 10, 'local savings are not subtracted from a previous whole-trip estimate');
    assert.equal(active.totalDistance, 10);
    assert.equal(written.metadata.road_verification.verified, false);
    assert.equal(written.metadata.road_verification.measured_road_miles, null);
    assert.equal(written.metadata.road_path_validated, false);
    assert.equal(written.metadata.winning_route_distance, null);
    assert.equal(written.metadata.last_optimization_attempt.status, 'applied_partial');
    assert.equal(written.metadata.last_optimization_attempt.route_changed, true);
    assert.equal(written.metadata.last_optimization_attempt.stops_reordered, 2);
    assert.equal(written.metadata.last_optimization_attempt.road_access_recovery.unresolved[0].property_id, unresolved.property_id);
    // A stop without road access is a real problem: a warning that names it.
    const message = messages.find(entry => entry.type === 'warning').message;
    assert.match(message, /^Route optimized · 2 stops reordered · ~1\.3 mi shorter\./);
    assert.ok(message.includes(unresolved.address));
    assert.doesNotMatch(message, /8\.75|road-distance|estimat|unverified|incomplete/);
    assert.equal(messages.some(entry => entry.type === 'success' || entry.type === 'error'), false);
});

test('a failed optimization updates only its own route cache and does not persist personal anchors', async () => {
    messages.length = 0;
    const other = { id: 'different-route', property_hashes: ['different'], metadata: { keep: true } };
    const queries = new QueryClient();
    queries.setQueryData(['savedRoutes'], [route, other]);
    let active = other, written;
    const home = { lat: 33.456789, lng: -112.019876 };
    const api = { functions: { invoke: async (_name, payload) => {
        assert.equal(payload.start_location, undefined); assert.equal(payload.end_location, undefined);
        return { data: { success: false, routing_metadata: { start_constraint: home, end_constraint: home,
            road_access_recovery: { status: 'provider_unavailable', attempted: 0, recovered: 0,
                inventory_complete: false, unverified_count: properties.length, unresolved: [] } } } };
    } }, entities: { SavedRoute: { update: async (id, body) => { assert.equal(id, route.id);
        written = body; return { ...route, ...body }; } } } };
    await optimize(route, { mode: 'route_only' }, { client: api, user: { id: 'manager', home_base: home }, queryClient: queries,
        setActiveRoute: updater => { active = updater(active); } });
    assert.equal(active, other);
    assert.equal(queries.getQueryData(['savedRoutes'])[1], other);
    assert.equal(queries.getQueryData(['savedRoutes'])[0].metadata.last_optimization_attempt.status, 'road_provider_unavailable');
    assert.equal(written.metadata.last_optimization_attempt.route_changed, false);
    assert.doesNotMatch(JSON.stringify(written), /33\.456789|-112\.019876|start_constraint|end_constraint|home_base/);
    queries.clear();
});

test('a declined optimization preserves the active private trip session while refreshing only its result metadata', async () => {
    messages.length = 0;
    const start = { lat: 33.456789, lng: -112.019876 };
    const finish = { lat: 33.456123, lng: -112.019123 };
    const session = { ...route, routeOriginMode: 'private_anchor_round_trip', startLocation: start, endLocation: finish,
        totalDistance: 10, mapView: { zoom: 15 }, metadata: { keep: 'saved metadata' } };
    const queries = new QueryClient();
    queries.setQueryData(['routeMap', 'rep', route.id], session);
    queries.setQueryData(['savedRoutes'], [session]);
    let active = session, written;
    const api = { functions: { invoke: async (_name, payload) => {
        assert.equal(payload.start_location, undefined); assert.equal(payload.end_location, undefined);
        return { data: { success: false, routing_metadata: { start_constraint: start, end_constraint: finish,
            road_access_recovery: { status: 'provider_unavailable', attempted: 0, recovered: 0,
                inventory_complete: false, unverified_count: properties.length, unresolved: [] } } } };
    } }, entities: { SavedRoute: { update: async (_id, body) => {
        written = body;
        return { ...route, ...body, start_location: null, end_location: null, updated_date: '2026-10-14T22:00:00Z' };
    } } } };
    await optimize(session, { mode: 'route_only' }, { client: api, queryClient: queries,
        setActiveRoute: updater => { active = updater(active); } });
    for (const result of [active, queries.getQueryData(['routeMap', 'rep', route.id]), queries.getQueryData(['savedRoutes'])[0]]) {
        assert.equal(result.routeOriginMode, 'private_anchor_round_trip');
        assert.equal(result.startLocation, start);
        assert.equal(result.endLocation, finish);
        assert.equal(result.properties, session.properties);
        assert.equal(result.allProperties, session.allProperties);
        assert.equal(result.property_hashes, session.property_hashes);
        assert.equal(result.mapView, session.mapView);
        assert.equal(result.totalDistance, 10);
        assert.equal(result.metadata.keep, 'saved metadata');
        assert.equal(result.metadata.last_optimization_attempt.status, 'road_provider_unavailable');
        assert.equal(result.updated_date, '2026-10-14T22:00:00Z');
    }
    assert.deepEqual(Object.keys(written), ['metadata']);
    assert.doesNotMatch(JSON.stringify(written), /33\.456789|33\.456123|-112\.019876|-112\.019123|start_constraint|end_constraint|startLocation|endLocation/);
    assert.equal(messages.some(entry => entry.type === 'success'), false);
    queries.clear();
});
