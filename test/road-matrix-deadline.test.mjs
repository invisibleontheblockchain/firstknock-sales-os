import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { toast } from 'sonner';

let vite, optimize, action;
const oldToasts = {};
before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
    optimize = (await vite.ssrLoadModule('/src/lib/roadMatrixOptimize.js')).tryRoadMatrixOptimize;
    action = (await vite.ssrLoadModule('/src/lib/reoptimizeRouteAction.js')).reoptimizeRoute;
    for (const tone of ['loading', 'success', 'warning', 'error', 'info']) {
        oldToasts[tone] = toast[tone]; toast[tone] = () => {};
    }
});
after(async () => { Object.assign(toast, oldToasts); await vite?.close(); });

const homes = count => Array.from({ length: count }, (_, i) => ({
    address_hash: `deadline-door-${i}`, lat: 35 + i / 100000, lng: -81,
}));
const api = invoke => ({ functions: { invoke } });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const useClock = t => t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.UTC(2026, 9, 15) });
function verifiedResult(properties, { complete = true, current = false } = {}) {
    const order = properties.map(p => p.address_hash);
    if (!current) [order[0], order[1]] = [order[1], order[0]];
    return { data: { success: true, selected: current ? 'current' : 'road_aware', order,
        routing_metadata: { input_measured: 449.796, winning_route_distance: 441.947,
            road_path_validated: true, road_matrix_source: 'test-driving-roads', road_matrix_version: 'v1',
            road_access_recovery: { inventory_complete: true, unresolved: [] },
            neighborhood_excursion_review: { local_driving_review: {
                validation: 'whole_route', applied: !current, skipped: [],
            } }, road_search_coverage: { version: 1, policy: 'deadline_test',
                completed_window_keys: ['1'.padStart(32, '0')], total_windows: complete ? 1 : 2,
                remaining_windows: complete ? 0 : 1, checked_this_pass: 1, progress_this_pass: 1,
                cycle_complete: complete },
        } } };
}

test('a 626-door verified response at 133 seconds is accepted and saved exactly once', async t => {
    useClock(t);
    const properties = homes(626), route = { id: 'large-deadline', properties, allProperties: properties,
        property_hashes: properties.map(p => p.address_hash), route_origin_mode: 'none',
        metrics: { distance: 449.796, house_count: 626 } };
    let calls = 0, saved = [], settled = false;
    const pending = action(route, { mode: 'route_only' }, { client: {
        functions: { invoke: () => { calls++; return new Promise(resolve => setTimeout(() => resolve(verifiedResult(properties)), 133136)); } },
        entities: { SavedRoute: { update: async (_id, patch) => { saved.push(patch); return { ...route, ...patch }; } } },
    } }).then(() => { settled = true; });
    await flush(); assert.equal(calls, 1);
    t.mock.timers.tick(120000); await flush();
    assert.equal(settled, false); assert.equal(saved.length, 0);
    t.mock.timers.tick(13136); await pending;
    assert.equal(saved.length, 1);
    assert.equal(saved[0].metrics.distance, 441.95, 'saved display distance keeps the existing two-decimal rounding');
    assert.equal(saved[0].property_hashes.length, 626);
    assert.equal(new Set(saved[0].property_hashes).size, 626);
    assert.equal(saved[0].metadata.road_verification.verified, true);
    t.mock.timers.tick(180000); await flush();
    assert.equal(saved.length, 1, 'the cleared deadline cannot cause a second save');
});

for (const [count, deadline] of [[2, 120000], [500, 120000], [501, 180000], [626, 180000]]) {
    test(`a hung ${count}-door request ends at its ${deadline / 1000}-second default`, async t => {
        useClock(t);
        let settled = false, reason;
        const pending = optimize(homes(count), { client: api(() => new Promise(() => {})),
            onOutcome: value => { reason = value; } }).then(result => { settled = true; return result; });
        t.mock.timers.tick(deadline - 1); await flush(); assert.equal(settled, false);
        t.mock.timers.tick(1);
        assert.equal(await pending, null); assert.equal(reason, 'deadline_exceeded');
    });
}

for (const [count, requested, effective] of [[626, 90000, 90000], [626, 999999, 180000], [500, 999999, 120000]]) {
    test(`${count}-door caller deadline ${requested}ms uses bounded ${effective}ms`, async t => {
        useClock(t);
        let settled = false;
        const pending = optimize(homes(count), { deadlineMs: requested, client: api(() => new Promise(() => {})) })
            .then(result => { settled = true; return result; });
        t.mock.timers.tick(effective - 1); await flush(); assert.equal(settled, false);
        t.mock.timers.tick(1); assert.equal(await pending, null);
    });
}

test('a late response after the 180-second deadline cannot save a route or duplicate its failure outcome', async t => {
    useClock(t);
    const properties = homes(626), route = { id: 'late-deadline', properties, allProperties: properties,
        property_hashes: properties.map(p => p.address_hash), route_origin_mode: 'none',
        metrics: { distance: 449.796, house_count: 626 } };
    const saved = [];
    const pending = action(route, { mode: 'route_only' }, { client: {
        functions: { invoke: () => new Promise(resolve => setTimeout(() => resolve(verifiedResult(properties)), 181000)) },
        entities: { SavedRoute: { update: async (_id, patch) => { saved.push(patch); return { ...route, ...patch }; } } },
    } });
    await flush(); t.mock.timers.tick(180000); await pending;
    assert.equal(saved.length, 1); assert.equal(saved[0].property_hashes, undefined);
    assert.equal(saved[0].metadata.last_optimization_attempt.route_changed, false);
    t.mock.timers.tick(1000); await flush();
    assert.equal(saved.length, 1); assert.equal(saved[0].metrics, undefined);
});

test('a 133-second first pass can continue within the remaining action budget', async t => {
    useClock(t);
    const properties = homes(626);
    let calls = 0;
    const pending = optimize(properties, { maxSearchPasses: 3, client: api((_name, payload) => {
        calls++;
        const result = verifiedResult(payload.properties, { complete: calls > 1, current: calls > 1 });
        if (calls > 1) result.data.routing_metadata.input_measured = 441.947;
        return new Promise(resolve => setTimeout(() => resolve(result), calls === 1 ? 133136 : 60000));
    }) });
    t.mock.timers.tick(133136); await flush();
    assert.equal(calls, 2, '166 seconds left can safely bound a continuation below its 180-second ceiling');
    t.mock.timers.tick(60000); const result = await pending;
    assert.equal(result.routingMetadata.road_search_coverage.remaining_windows, 0);
    assert.equal(result.routingMetadata.road_search_passes, 2);
});

test('large-route continuation retains the hard five-minute action ceiling', async t => {
    useClock(t);
    const properties = homes(626);
    let calls = 0, settled = false;
    const pending = optimize(properties, { maxSearchPasses: 3, totalDeadlineMs: 999999, client: api(() => {
        calls++;
        return calls === 1 ? new Promise(resolve => setTimeout(() => resolve(verifiedResult(properties, { complete: false })), 120000))
            : new Promise(() => {});
    }) }).then(result => { settled = true; return result; });
    t.mock.timers.tick(120000); await flush(); assert.equal(calls, 2);
    t.mock.timers.tick(179999); await flush(); assert.equal(settled, false);
    t.mock.timers.tick(1); const result = await pending;
    assert.equal(calls, 2); assert.equal(result.routingMetadata.road_search_stop_reason, 'deadline_exceeded');
    assert.equal(result.objective.appliedDistance, 441.947);
});

test('an explicitly shorter total action budget also bounds a large first request', async t => {
    useClock(t);
    let settled = false;
    const pending = optimize(homes(626), { totalDeadlineMs: 100000,
        client: api(() => new Promise(() => {})) }).then(result => { settled = true; return result; });
    t.mock.timers.tick(99999); await flush(); assert.equal(settled, false);
    t.mock.timers.tick(1); assert.equal(await pending, null);
});

const observedPassTimes = [75700, 60400, 61200];
function remainingSearchResult(properties, pass) {
    const result = verifiedResult(properties, { current: pass > 0 });
    const meta = result.data.routing_metadata;
    if (pass > 0) meta.input_measured = 441.947;
    const total = pass === 1 ? 122 : 121, remaining = [15, 5, 1, 0][pass];
    meta.road_search_coverage = { version: 1, policy: 'deadline_test', total_windows: total,
        remaining_windows: remaining, completed_window_keys: Array.from({ length: total - remaining },
            (_, i) => String(i + 1).padStart(32, '0')),
        checked_this_pass: 64, progress_this_pass: [64, 11, 3, 1][pass], cycle_complete: remaining === 0 };
    return result;
}
const deadlineRoute = properties => ({ id: 'remaining-search-deadline', properties, allProperties: properties,
    property_hashes: properties.map(property => property.address_hash), route_origin_mode: 'none',
    metrics: { distance: 449.796, house_count: properties.length } });

// The saved route as the mock last wrote it, readable by the background
// save-time check; no door has been knocked.
function savingClient(route, saved, invoke) {
    let latest = route;
    return { functions: { invoke }, entities: {
        SavedRoute: {
            update: async (_id, patch) => { saved.push(patch); latest = { ...latest, ...patch }; return latest; },
            get: async () => latest,
        },
        InteractionLog: { filter: async () => [] },
    } };
}

test('the observed 377-stop timings save pass 1 at once and finish the final check in the background', async t => {
    useClock(t);
    const properties = homes(377), route = deadlineRoute(properties), saved = [], requests = [];
    const pending = action(route, { mode: 'route_only' }, { client: savingClient(route, saved, (_name, payload) => {
        const pass = requests.length; requests.push(payload);
        return new Promise(resolve => setTimeout(() => resolve(remainingSearchResult(payload.properties, pass)),
            observedPassTimes[pass] ?? 61200));
    }) });
    await flush();
    t.mock.timers.tick(observedPassTimes[0]); await flush();
    const run = await pending;
    assert.equal(saved.length, 1, 'pass 1 is saved as soon as it is done');
    assert.equal(saved[0].metadata.road_search_passes, 1);
    assert.equal(saved[0].property_hashes.length, 377);
    assert.equal(new Set(saved[0].property_hashes).size, 377);
    assert.deepEqual([...saved[0].property_hashes].sort(), [...route.property_hashes].sort());
    for (const [index, duration] of observedPassTimes.slice(1).entries()) {
        t.mock.timers.tick(duration); await flush();
        assert.equal(requests.length, index + 3);
        assert.equal(saved.length, 1, 'background passes save nothing until the search ends');
    }
    assert.equal(requests[3].search_phase, 'remaining_neighborhoods');
    assert.equal(requests[3].search_coverage.remaining_windows, 1);
    assert.deepEqual(requests[3].comparison_order, route.property_hashes);
    t.mock.timers.tick(61200); await run.background;
    // Nothing shorter: the finished search is recorded on the untouched route, no reorder.
    assert.equal(saved.length, 2);
    assert.equal(saved[1].property_hashes, undefined);
    assert.equal(saved[1].metadata.road_search_coverage.remaining_windows, 0);
    assert.equal(saved[1].metadata.road_verification.verified, true);
    t.mock.timers.tick(300000); await flush();
    assert.equal(saved.length, 2);
});

test('a late fourth-pass response cannot cross the five-minute action deadline or save twice', async t => {
    useClock(t);
    const properties = homes(377), route = deadlineRoute(properties), saved = [];
    let calls = 0;
    const remainingBudget = 300000 - observedPassTimes.reduce((sum, duration) => sum + duration, 0);
    const pending = action(route, { mode: 'route_only' }, { client: savingClient(route, saved, (_name, payload) => {
        const pass = calls++;
        assert.equal(payload.search_continuation, pass ? `private-deadline-token-${pass - 1}` : undefined);
        return new Promise(resolve => setTimeout(() => {
            const result = remainingSearchResult(payload.properties, pass);
            result.data.search_continuation = `private-deadline-token-${pass}`;
            resolve(result);
        }, observedPassTimes[pass] ?? remainingBudget + 1000));
    }) });
    await flush();
    t.mock.timers.tick(observedPassTimes[0]); await flush();
    const run = await pending;
    assert.equal(saved.length, 1, 'pass 1 is saved as soon as it is done');
    let settled = false;
    run.background.then(() => { settled = true; });
    for (const duration of observedPassTimes.slice(1)) { t.mock.timers.tick(duration); await flush(); }
    assert.equal(calls, 4);
    t.mock.timers.tick(remainingBudget - 1); await flush();
    assert.equal(settled, false); assert.equal(saved.length, 1);
    t.mock.timers.tick(1); await run.background;
    // The deadline ends the search with the pass-1 order still best: its
    // coverage is recorded, the order is not touched.
    assert.equal(saved.length, 2);
    assert.equal(saved[1].property_hashes, undefined);
    assert.equal(saved[1].metadata.road_search_coverage.remaining_windows, 1);
    assert.doesNotMatch(JSON.stringify(saved), /private-deadline-token|search_continuation|searchContinuation/);
    const snapshot = structuredClone(saved);
    t.mock.timers.tick(1000); await flush();
    assert.equal(calls, 4);
    assert.deepEqual(saved, snapshot, 'a late response cannot alter the retained verified route');
});

test('a continuation is declined when less than its useful 60-second budget remains', async t => {
    useClock(t);
    let calls = 0;
    const pending = optimize(homes(377), { maxSearchPasses: 8, totalDeadlineMs: 250000,
        client: api((_name, payload) => {
            const pass = calls++;
            return new Promise(resolve => setTimeout(() => resolve(remainingSearchResult(payload.properties, pass)), observedPassTimes[pass]));
        }) });
    for (const duration of observedPassTimes) { t.mock.timers.tick(duration); await flush(); }
    const result = await pending;
    assert.equal(calls, 3, '52.7 seconds left does not start another provider request');
    assert.equal(result.routingMetadata.road_search_stop_reason, 'action_budget');
    assert.equal(result.routingMetadata.road_search_coverage.remaining_windows, 1);
    assert.equal(result.routingMetadata.road_path_validated, true);
});
