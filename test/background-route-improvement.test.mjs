import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { toast } from 'sonner';
import { routePropertyOrderFingerprint } from '../base44/shared/routeFingerprint.js';

let vite, background, generation;
const messages = [], oldToasts = {};
before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
    background = await vite.ssrLoadModule('/src/lib/backgroundRouteImprovement.js');
    generation = await vite.ssrLoadModule('/src/lib/roadOptimizeRoutes.js');
    for (const tone of ['loading', 'success', 'warning', 'error', 'info']) {
        oldToasts[tone] = toast[tone];
        toast[tone] = message => messages.push({ tone, message });
    }
});
after(async () => { Object.assign(toast, oldToasts); await vite?.close(); });

const stop = hash => ({ address_hash: hash, lat: 35, lng: -81 });
const result = (order, savings, applied = null) => ({ order: order.map(stop),
    objective: { applyCandidate: true, appliedDistance: applied, estimatedSavings: savings }, routingMetadata: {} });

test('a background order counts only when it saves measurably more than pass 1 against the same original', () => {
    const miles = background.backgroundImprovementMiles;
    assert.equal(miles(result(['A', 'B'], 1.4, 269.7), result(['B', 'A'], 4.3, 270.5)), 2.9,
        'fresh curb evidence can raise both totals; savings against the original decide');
    assert.equal(miles(result(['A', 'B'], 1.4), result(['B', 'A'], 1.43)), 0, 'under 0.05 mi is noise');
    assert.equal(miles(result(['A', 'B'], 1.4), result(['A', 'B'], 9)), 0, 'the same order is no change');
    assert.equal(miles(null, result(['B', 'A'], 0.6)), 0.6, 'pass 1 kept the original order');
    assert.equal(miles(result(['A', 'B'], 1), null), 0);
    assert.equal(miles(result(['A', 'B'], 1), { ...result(['B', 'A'], 5), objective: { applyCandidate: false, estimatedSavings: 5 } }), 0);
});

function savedRoutes(initial, logs = []) {
    let route = { ...initial };
    const updates = [];
    return {
        updates,
        set: patch => { route = { ...route, ...patch }; },
        client: { entities: {
            SavedRoute: { get: async () => route, update: async (_id, patch) => { updates.push(patch); route = { ...route, ...patch }; return route; } },
            InteractionLog: { filter: async () => logs },
        } },
    };
}
const saved = { id: 'r1', property_hashes: ['A', 'B', 'C'], status: 'ACTIVE', assigned_to: 'rep-1',
    start_location: null, end_location: null, route_origin_mode: 'none' };

test('a background improvement is saved only onto a route nobody touched since pass 1', async () => {
    const cases = [
        ['untouched', () => {}, true],
        ['reordered', store => store.set({ property_hashes: ['C', 'B', 'A'] }), false],
        ['stop removed', store => store.set({ property_hashes: ['A', 'B'] }), false],
        ['started', store => store.set({ status: 'IN_PROGRESS' }), false],
        ['completed', store => store.set({ status: 'COMPLETED' }), false],
        ['reassigned', store => store.set({ assigned_to: 'rep-2' }), false],
        ['bounds changed', store => store.set({ route_origin_mode: 'home_round_trip' }), false],
        ['deleted', store => { store.client.entities.SavedRoute.get = async () => null; }, false],
    ];
    for (const [label, change, expected] of cases) {
        const store = savedRoutes(saved);
        const snapshot = background.routeGuardSnapshot(saved, { run: background.claimRouteOptimization('r1') });
        change(store);
        let wrote = false;
        const outcome = await background.finishInBackground({ final: Promise.resolve({ result: result(['C', 'A', 'B'], 2) }),
            firstResult: result(['A', 'B', 'C'], 1), snapshot, client: store.client, save: async () => { wrote = true; } });
        assert.equal(wrote, expected, label);
        assert.equal(outcome.saved, expected, label);
    }
});

test('a door knocked since pass 1, or a newer Optimize click, discards the background improvement', async () => {
    const knocked = savedRoutes(saved, [{ created_date: new Date(Date.now() + 5000).toISOString() }]);
    let snapshot = background.routeGuardSnapshot(saved, { run: background.claimRouteOptimization('r1') });
    assert.deepEqual(await background.routeUnchangedSince(snapshot, knocked.client), { ok: false, reason: 'run' });
    const earlier = savedRoutes(saved, [{ created_date: new Date(Date.now() - 60000).toISOString() }]);
    assert.equal((await background.routeUnchangedSince(snapshot, earlier.client)).ok, true, 'a knock before pass 1 is not a change');
    snapshot = background.routeGuardSnapshot(saved, { run: background.claimRouteOptimization('r1') });
    background.claimRouteOptimization('r1');
    assert.deepEqual(await background.routeUnchangedSince(snapshot, savedRoutes(saved).client), { ok: false, reason: 'optimized_again' });
});

test('nothing shorter ends quietly, recording the finished search only on an untouched route', async () => {
    let recorded = 0;
    const store = savedRoutes(saved);
    const snapshot = background.routeGuardSnapshot(saved, { run: background.claimRouteOptimization('r1') });
    const outcome = await background.finishInBackground({ final: Promise.resolve({ result: result(['A', 'B', 'C'], 1) }),
        firstResult: result(['A', 'B', 'C'], 1), snapshot, client: store.client,
        save: async () => assert.fail('nothing to save'), quiet: async () => { recorded++; } });
    assert.equal(outcome.saved, false); assert.equal(recorded, 1);
    store.set({ status: 'IN_PROGRESS' });
    await background.finishInBackground({ final: Promise.resolve({ result: null }), firstResult: null, snapshot,
        client: store.client, save: async () => assert.fail('nothing to save'), quiet: async () => { recorded++; } });
    assert.equal(recorded, 1, 'a started route is not written at all');
    const failed = await background.finishInBackground({ final: Promise.reject(new Error('tab closed')), firstResult: null,
        snapshot, client: store.client, save: async () => assert.fail('nothing to save') });
    assert.deepEqual(failed, { saved: false, reason: 'search_failed' });
});

// Two passes: pass 1 reorders, pass 2 finds a further `secondSavings` mi,
// shaped like the backend's verified responses (see road-search-continuation).
function twoPassClient(store, { secondSavings = 2 } = {}) {
    const calls = [];
    let original = null;
    const comparison = (input, output, inputMiles, outputMiles) => ({ version: 1,
        service_objective: 'coherent_side_passes_then_driving_cost', graph_version: 'roads-2026',
        original_order_fingerprint: routePropertyOrderFingerprint(original), input_order_fingerprint: routePropertyOrderFingerprint(input),
        output_order_fingerprint: routePropertyOrderFingerprint(output), original_miles: 10, input_miles: inputMiles, output_miles: outputMiles,
        original_seconds: 600, input_seconds: inputMiles * 60, output_seconds: outputMiles * 60,
        original_pass_violations: 0, input_pass_violations: 0, output_pass_violations: 0 });
    return { calls, client: { ...store.client, auth: { me: async () => ({ id: 'owner' }) }, functions: { invoke: async (name, payload) => {
        if (name === 'roadAwareRoutingBeta') return { data: { enabled: false } };
        calls.push(payload);
        const hashes = payload.properties.map(p => p.address_hash);
        original ||= hashes;
        const pass = calls.length;
        const ledger = { version: 1, policy: 'test', completed_window_keys: Array.from({ length: pass }, (_, i) => String(i + 1).padStart(32, '0')),
            total_windows: 2, remaining_windows: 2 - pass, checked_this_pass: 1, progress_this_pass: 1, cycle_complete: pass === 2 };
        const order = pass === 1 ? [hashes[1], hashes[0], ...hashes.slice(2)] : [...hashes.slice(0, -2), hashes.at(-1), hashes.at(-2)];
        const miles = pass === 1 ? 9 : 9 - secondSavings;
        return { data: { success: true, selected: 'road_aware', order, search_continuation: `token-${pass}`, routing_metadata: {
            input_measured: pass === 1 ? 10 : 9, winning_route_distance: miles, duration_improvement: 1, road_path_validated: true,
            road_network_used: true, road_search_coverage: ledger,
            neighborhood_excursion_review: { local_driving_review: { validation: 'whole_route', applied: true, planned: 2, checked: 1, skipped: [] } },
            ...(pass === 2 ? { road_search_comparison: comparison(hashes, order, 9, miles) } : {}) } } };
    } } } };
}

test('generated routes return pass 1 for saving, then save a shorter order once the flow binds the saved record', async () => {
    messages.length = 0;
    const store = savedRoutes({ id: 'gen-1', status: 'PENDING', assigned_to: null, start_location: null, end_location: null,
        route_origin_mode: null, property_hashes: [] });
    const { calls, client } = twoPassClient(store);
    const routes = [{ name: 'North', properties: ['A', 'B', 'C', 'D'].map(stop) }];
    const out = await generation.optimizeRoutesOnRoads(routes, { client });
    assert.equal(calls.length >= 1, true);
    const firstOrder = out.routes[0].properties.map(p => p.address_hash);
    assert.deepEqual(firstOrder, ['B', 'A', 'C', 'D'], 'pass 1 is returned for the flow to save');
    // The flow saves, then binds (bindBetaGeneratedRoutes does this after every save).
    store.set({ property_hashes: firstOrder });
    background.bindSavedGeneratedRoutes([{ ...saved, id: 'gen-1', status: 'PENDING', assigned_to: null,
        route_origin_mode: null, property_hashes: firstOrder }]);
    const done = await out.backgroundDone;
    assert.equal(calls.length, 2);
    assert.deepEqual(done, { improved: 1, miles: 2 });
    assert.equal(store.updates.length, 1);
    assert.deepEqual(store.updates[0].property_hashes, ['B', 'A', 'D', 'C']);
    assert.equal(store.updates[0].metrics.distance, 7);
    assert.ok(messages.some(message => /Route improved by 2 mi while you worked/.test(message.message)));
});

test('a generated route that is never saved, or edited before the background ends, is left alone', async () => {
    const store = savedRoutes({ id: 'gen-2', status: 'PENDING', assigned_to: null, start_location: null, end_location: null,
        route_origin_mode: null, property_hashes: [] });
    const { client } = twoPassClient(store);
    const routes = [{ name: 'South', properties: ['E', 'F', 'G', 'H'].map(stop) }];
    const out = await generation.optimizeRoutesOnRoads(routes, { client });
    const firstOrder = out.routes[0].properties.map(p => p.address_hash);
    background.bindSavedGeneratedRoutes([{ ...saved, id: 'gen-2', status: 'PENDING', assigned_to: null,
        route_origin_mode: null, property_hashes: firstOrder }]);
    store.set({ property_hashes: [...firstOrder].reverse() });
    const done = await out.backgroundDone;
    assert.equal(done.improved, 0);
    assert.equal(store.updates.length, 0, 'the manager’s reorder stands');
});
