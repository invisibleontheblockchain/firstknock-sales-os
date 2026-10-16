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

test('133 seconds used by a large pass leave too little budget for another full 180-second request', async t => {
    useClock(t);
    const properties = homes(626);
    let calls = 0;
    const pending = optimize(properties, { maxSearchPasses: 3, client: api(() => {
        calls++; return new Promise(resolve => setTimeout(() => resolve(verifiedResult(properties, { complete: false })), 133136));
    }) });
    t.mock.timers.tick(133136); const result = await pending;
    assert.equal(calls, 1);
    assert.equal(result.routingMetadata.road_search_coverage.remaining_windows, 1);
    assert.equal(result.routingMetadata.road_search_passes, 1);
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
