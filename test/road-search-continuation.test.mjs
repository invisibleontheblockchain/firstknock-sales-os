import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

let vite, optimize, action, normalize;
const messages = [], oldToasts = {};
before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
    const road = await vite.ssrLoadModule('/src/lib/roadMatrixOptimize.js');
    optimize = road.tryRoadMatrixOptimize;
    normalize = road.normalizeRoadSearchCoverage;
    action = (await vite.ssrLoadModule('/src/lib/reoptimizeRouteAction.js')).reoptimizeRoute;
    for (const tone of ['loading', 'success', 'warning', 'error', 'info']) {
        oldToasts[tone] = toast[tone];
        toast[tone] = message => messages.push({ tone, message });
    }
});
after(async () => { Object.assign(toast, oldToasts); await vite?.close(); });

const properties = ['A', 'B', 'C'].map((address_hash, i) => ({ address_hash, lat: 35, lng: -81 + i / 10000 }));
const hashes = properties.map(p => p.address_hash), candidate = ['B', 'A', 'C'];
const key = i => String(i).padStart(32, '0');
const coverage = (done = 1, total = 5) => ({ version: 1, policy: 'entry_branch_return_v6_short_cleanup',
    completed_window_keys: Array.from({ length: done }, (_, i) => key(i + 1)), total_windows: total,
    remaining_windows: total - done, checked_this_pass: 1, progress_this_pass: 1, cycle_complete: done === total });
function response({ ledger = coverage(), order = hashes, selected = 'current', meta = {}, success = true } = {}) {
    return { data: { success, selected, order, routing_metadata: { input_measured: 10, winning_route_distance: 8,
        duration_improvement: selected === 'current' ? 0 : 1, road_path_validated: true,
        neighborhood_excursion_review: { local_driving_review: { validation: 'whole_route', applied: selected !== 'current',
            planned: 5, checked: 1, budgetExhausted: true, skipped: [] } },
        road_search_coverage: ledger, ...meta } } };
}
const api = invoke => ({ functions: { invoke } });
const route = { id: 'route', properties, allProperties: properties, property_hashes: hashes,
    route_origin_mode: 'none', metrics: { distance: 10, house_count: 3 }, metadata: {} };

test('a verified no-op and improvement continue until the latest order has complete coverage', async () => {
    const requests = [], progress = [], start = { lat: 35.11111, lng: -81.22222 }, end = { lat: 35.33333, lng: -81.44444 };
    const result = await optimize(properties, { start, end, maxSearchPasses: 3, onProgress: value => progress.push(value),
        onOutcome: () => assert.fail('intermediate no-op must not finish the action'), client: api(async (_name, payload) => {
            requests.push(payload);
            return requests.length === 1 ? response() : requests.length === 2
                ? response({ ledger: coverage(2), order: candidate, selected: 'road_aware' })
                : response({ ledger: coverage(5), order: candidate, meta: { input_measured: 8 } });
        }) });
    assert.equal(requests.length, 3);
    assert.equal(requests[0].search_coverage, undefined);
    assert.deepEqual(requests[1].search_coverage, coverage());
    for (const [index, request] of requests.entries()) {
        assert.deepEqual(request.properties.map(p => p.address_hash), index < 2 ? hashes : candidate);
        assert.deepEqual(request.start_location, start);
        assert.deepEqual(request.end_location, end);
    }
    assert.deepEqual(result.order.map(p => p.address_hash), candidate);
    assert.equal(result.objective.appliedDistance, 8);
    assert.equal(result.objective.estimatedSavings, 2);
    assert.deepEqual(result.routingMetadata.road_search_coverage, coverage(5));
    assert.deepEqual(progress, [{ pass: 2, maxPasses: 3, remainingWindows: 4 },
        { pass: 3, maxPasses: 3, remainingWindows: 3 }]);
});

test('continuation stops at three passes and reports the remaining search honestly', async () => {
    let calls = 0, outcome;
    const result = await optimize(properties, { client: api(async () => response({ ledger: coverage(++calls) })),
        maxSearchPasses: 99, onOutcome: (reason, measurement) => { outcome = { reason, measurement }; } });
    assert.equal(result, null);
    assert.equal(calls, 3);
    assert.equal(outcome.reason, 'current_order_measured_best');
    assert.equal(outcome.measurement.routingMetadata.road_search_passes, 3);
    assert.equal(outcome.measurement.routingMetadata.road_search_coverage.remaining_windows, 2);
});

test('errors, incomplete path proof, invalid ledgers and exhausted progress never trigger another request', async () => {
    const cases = [
        { success: false }, { meta: { road_path_validated: false } }, { meta: { fallback: true } },
        { ledger: { ...coverage(), progress_this_pass: 0 } }, { ledger: coverage(5) },
        { ledger: { ...coverage(), completed_window_keys: ['private 35.123,-81.456'] } },
        { meta: { road_access_recovery: { unresolved: [{ property_id: 'C' }] } } },
        { meta: { neighborhood_excursion_review: { local_driving_review: { validation: 'overlapping_boundary_legs' } } } },
        { order: candidate },
        { selected: 'road_aware', order: ['B', 'A', 'A'] },
    ];
    for (const fixture of cases) {
        let calls = 0;
        await optimize(properties, { maxSearchPasses: 3, client: api(async () => { calls++; return response(fixture); }) });
        assert.equal(calls, 1, JSON.stringify(fixture));
    }
    let calls = 0, result;
    await optimize(properties, { maxSearchPasses: 3, searchCoverage: coverage(), client: api(async () => { calls++; throw new Error('offline'); }),
        onOutcome: (_reason, measurement) => { result = measurement; } });
    assert.equal(calls, 1);
    assert.equal(result.routingMetadata?.road_search_coverage, undefined, 'a failure cannot create returned search history');
});

test('the whole action has a deadline even when a backend promise never settles', async () => {
    let calls = 0, reason;
    await optimize(properties, { totalDeadlineMs: 5, deadlineMs: 1000,
        client: api(() => { calls++; return new Promise(() => {}); }), onOutcome: value => { reason = value; } });
    assert.equal(calls, 1);
    assert.equal(reason, 'deadline_exceeded');
});

test('shared road optimization stays one pass unless the explicit Optimize action opts in', async () => {
    let calls = 0;
    await optimize(properties, { client: api(async () => { calls++; return response(); }) });
    assert.equal(calls, 1);
});

test('a remaining budget smaller than a full request retains the last verified no-op and its progress', async () => {
    const realNow = Date.now;
    let now = realNow(), calls = 0, outcome;
    Date.now = () => now;
    try {
        await optimize(properties, { maxSearchPasses: 3, deadlineMs: 100, totalDeadlineMs: 150,
            client: api(async () => { calls++; now += 60; return response(); }),
            onOutcome: (reason, measurement) => { outcome = { reason, measurement }; } });
    } finally { Date.now = realNow; }
    assert.equal(calls, 1, '90ms left cannot safely accommodate another 100ms request');
    assert.equal(outcome.reason, 'current_order_measured_best');
    assert.equal(outcome.measurement.distanceMiles, 10);
    assert.deepEqual(outcome.measurement.routingMetadata.road_search_coverage, coverage());
});

test('a selected-current response with a different or malformed manifest cannot claim a complete unchanged check', async () => {
    for (const order of [candidate, ['A', 'A', 'C'], ['A', 'B'], ['A', 'B', 'unknown'], null]) {
        let reason, calls = 0;
        await optimize(properties, { maxSearchPasses: 3,
            client: api(async () => { calls++; return response({ order }); }), onOutcome: value => { reason = value; } });
        assert.equal(calls, 1);
        assert.equal(reason, 'order_failed_exact_once');
    }
    let reason, calls = 0;
    await optimize(properties, { maxSearchPasses: 3, client: api(async () => {
        calls++; const value = response(); delete value.data.order; return value;
    }), onOutcome: value => { reason = value; } });
    assert.equal(calls, 1, 'legacy measurements without a manifest must not auto-continue');
    assert.equal(reason, 'current_order_measured_best');
});

test('coverage rejects private/raw identifiers and strips unrelated fields before reuse', () => {
    const safe = coverage();
    assert.deepEqual(normalize({ ...safe, start_location: { lat: 35.123456, lng: -81.234567 }, raw_error: 'provider' }), safe);
    for (const invalid of [{ ...safe, completed_window_keys: [key(1), key(1)] },
        { ...safe, completed_window_keys: Array.from({ length: 8193 }, (_, i) => key(i + 1)) }, { ...safe, remaining_windows: 35.123456 },
        { ...safe, policy: 'https://provider/private' }, { ...safe, cycle_complete: true }]) {
        assert.equal(normalize(invalid), null);
    }
});

test('no-op then accepted continuation persists one verified order and reloads its coverage', async () => {
    messages.length = 0;
    const queries = new QueryClient();
    queries.setQueryData(['savedRoutes', 'manager'], [route]);
    queries.setQueryData(['routeMap', 'manager', route.id], route);
    let calls = 0, saved, writes = 0, active = route;
    const client = { functions: { invoke: async (_name, payload) => {
        calls++;
        assert.deepEqual(payload.properties.map(p => p.address_hash), calls < 3 ? hashes : candidate);
        if (calls === 1) return response();
        if (calls === 2) return response({ ledger: coverage(2), order: candidate, selected: 'road_aware' });
        assert.deepEqual(payload.search_coverage, calls === 3 ? coverage(2) : coverage(5));
        return response({ ledger: coverage(5), order: candidate, meta: { input_measured: 8 } });
    } }, entities: { SavedRoute: { update: async (_id, patch) => { writes++; saved = { ...(saved || route), ...patch }; return saved; } } } };
    await action(route, { mode: 'route_only' }, { client, queryClient: queries, setActiveRoute: updater => { active = updater(active); } });
    assert.equal(calls, 3);
    assert.equal(writes, 1, 'intermediate no-op must not publish a competing route update');
    assert.deepEqual(active.properties.map(p => p.address_hash), candidate);
    assert.deepEqual(queries.getQueryData(['savedRoutes', 'manager'])[0].property_hashes, candidate);
    assert.deepEqual(saved.metadata.road_search_coverage, coverage(5));
    assert.equal(saved.metadata.last_optimization_attempt.stops_reordered, 2);
    assert.equal(saved.metadata.last_optimization_attempt.status, 'applied');
    assert.doesNotMatch(saved.metadata.last_optimization_attempt.message, /checks remain/);
    assert.equal(saved.metrics.distance, 8);
    assert.ok(messages.some(value => /Saved ~2 estimated miles/.test(value.message)));
    assert.ok(messages.some(value => /remaining neighborhoods \(pass 2 of 3\)/.test(value.message)));
    const reopened = queries.getQueryData(['routeMap', 'manager', route.id]);
    await action(reopened, { mode: 'route_only' }, { client, setActiveRoute: updater => { active = updater(active); } });
    assert.equal(calls, 4);
    assert.deepEqual(saved.property_hashes, candidate);
    assert.equal(saved.metadata.last_optimization_attempt.route_changed, false);
    assert.equal(saved.metadata.last_optimization_attempt.route_verification_complete, true);
    assert.equal(saved.metadata.last_optimization_attempt.status, 'no_improvement');
    queries.clear();
});

test('an unchanged bounded action saves cumulative coverage and reports the three-pass limit', async () => {
    messages.length = 0;
    let calls = 0, patch;
    const client = { functions: { invoke: async () => response({ ledger: coverage(++calls) }) },
        entities: { SavedRoute: { update: async (_id, update) => { patch = update; return { ...route, ...update }; } } } };
    await action(route, { mode: 'route_only' }, { client });
    assert.equal(calls, 3);
    assert.equal(patch.property_hashes, undefined);
    assert.deepEqual(patch.metadata.road_search_coverage, coverage(3));
    const attempt = patch.metadata.last_optimization_attempt;
    assert.equal(attempt.route_changed, false);
    assert.equal(attempt.route_verification_complete, true);
    assert.equal(attempt.neighborhoods_checked, 3);
    assert.match(attempt.message, /2 of 5 checks remain after 3 passes/);
    assert.equal(messages.at(-1).tone, 'warning');
});

test('personal home, car and private anchors continue only in memory and never save anchor-derived coverage', async () => {
    const anchor = { lat: 35.123456, lng: -81.654321 };
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { geolocation: {
        getCurrentPosition: success => success({ coords: { latitude: anchor.lat, longitude: anchor.lng, accuracy: 5 } }),
    } } });
    try {
        for (const mode of ['home_round_trip', 'car_round_trip', 'anchor_round_trip']) {
            for (const applied of [false, true]) {
                let calls = 0, patch;
                const initial = { ...route, route_origin_mode: mode, metadata: { road_search_coverage: coverage(4) } };
                const client = { functions: { invoke: async (name, payload) => {
                    if (name === 'manageRepAnchors') return { data: { anchor } };
                    calls++;
                    assert.deepEqual(payload.start_location, anchor);
                    assert.deepEqual(payload.end_location, anchor);
                    assert.deepEqual(payload.search_coverage, calls === 1 ? undefined : coverage());
                    return calls === 1 ? response() : response({ ledger: coverage(5),
                        ...(applied ? { selected: 'road_aware', order: candidate } : {}) });
                } }, entities: { SavedRoute: { update: async (_id, update) => { patch = update; return { ...initial, ...update }; } } } };
                await action(initial, mode === 'anchor_round_trip' ? {} : { mode, homeBase: anchor },
                    { client, user: { id: 'manager' } });
                assert.equal(calls, 2);
                assert.equal(patch.metadata.road_search_coverage, undefined);
                assert.equal(patch.start_location ?? null, null);
                assert.equal(patch.end_location ?? null, null);
                assert.equal(JSON.stringify(patch).includes(String(anchor.lat)), false);
                assert.equal(JSON.stringify(patch).includes(String(anchor.lng)), false);
            }
        }
    } finally {
        if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
        else delete globalThis.navigator;
    }
});

test('shared custom bounds pass saved coverage and retain only its safe scheduling fields', async () => {
    const start = { lat: 35.11111, lng: -81.22222 }, end = { lat: 35.33333, lng: -81.44444 };
    let patch, calls = 0;
    const initial = { ...route, metadata: { road_search_coverage: coverage(3) } };
    const client = { functions: { invoke: async (_name, payload) => {
        calls++;
        assert.deepEqual(payload.search_coverage, coverage(3));
        assert.deepEqual(payload.start_location, start);
        assert.deepEqual(payload.end_location, end);
        return response({ ledger: { ...coverage(5), provider_error: 'private', start_location: start },
            selected: 'road_aware', order: candidate });
    } }, entities: { SavedRoute: { update: async (_id, update) => { patch = update; return { ...initial, ...update }; } } } };
    await action(initial, { anchors: { start, end } }, { client });
    assert.equal(calls, 1);
    assert.deepEqual(patch.metadata.road_search_coverage, coverage(5));
    assert.deepEqual(patch.start_location, start);
    assert.deepEqual(patch.end_location, end);
});

test('377-door route-only Optimize finishes the 45 remaining checks after reordering 24 stops', async () => {
    messages.length = 0;
    const homes = Array.from({ length: 377 }, (_, i) => ({
        address_hash: `door-${i}`, lat: 35 + i / 100000, lng: -81,
    }));
    const before = homes.map(p => p.address_hash), after = [...before];
    for (let i = 0; i < 24; i += 2) [after[i], after[i + 1]] = [after[i + 1], after[i]];
    const partial = { ...coverage(78, 123), checked_this_pass: 78, progress_this_pass: 78 };
    const complete = { ...coverage(123, 123), checked_this_pass: 45, progress_this_pass: 45 };
    const selected = { ...route, property_hashes: before, properties: homes, allProperties: homes,
        metrics: { distance: 273.77, house_count: 377 } };
    let calls = 0, saves = 0, saved;
    await action(selected, { mode: 'route_only' }, {
        // Neither territory homes nor account-wide history have loaded.
        effectiveProperties: [],
        client: { functions: { invoke: async (name, payload) => {
            assert.equal(name, 'optimizeRouteRoadMatrix');
            assert.equal(payload.start_location, undefined);
            assert.equal(payload.end_location, undefined);
            assert.deepEqual(payload.properties.map(p => p.address_hash), ++calls === 1 ? before : after);
            if (calls === 2) assert.deepEqual(payload.search_coverage, partial);
            return response({ order: after, selected: calls === 1 ? 'road_aware' : 'current',
                ledger: calls === 1 ? partial : complete,
                meta: { input_measured: calls === 1 ? 273.77 : 270.43,
                    winning_route_distance: 270.43, road_matrix_source: 'test-roads', road_matrix_version: 'v1' } });
        } }, entities: { SavedRoute: { update: async (_id, patch) => {
            saves++; saved = { ...selected, ...patch }; return saved;
        } } } },
    });
    assert.equal(calls, 2);
    assert.equal(saves, 1);
    assert.deepEqual(saved.property_hashes, after);
    assert.equal(saved.property_hashes.length, 377);
    assert.equal(saved.metrics.distance, 270.43);
    assert.equal(saved.metadata.road_search_coverage.remaining_windows, 0);
    const completion = messages.find(message => message.tone === 'success');
    assert.match(completion.message, /24 stops reordered/);
    assert.match(completion.message, /Saved ~3\.34 estimated miles/);
    assert.doesNotMatch(completion.message, /incomplete|checks remain/);
});

test('successive improvements measure savings from the original click and finish on the latest order', async () => {
    const orders = [candidate, ['B', 'C', 'A'], ['B', 'C', 'A']];
    const inputs = [10, 8, 7], distances = [8, 7, 7];
    const requests = [];
    const result = await optimize(properties, { maxSearchPasses: 3, client: api(async (_name, payload) => {
        const index = requests.length; requests.push(payload);
        return response({ selected: index < 2 ? 'road_aware' : 'current', order: orders[index],
            ledger: coverage(index === 2 ? 5 : index + 1),
            meta: { input_measured: inputs[index], winning_route_distance: distances[index] } });
    }) });
    assert.deepEqual(requests.map(request => request.properties.map(p => p.address_hash)),
        [hashes, candidate, orders[1]]);
    assert.deepEqual(result.order.map(p => p.address_hash), orders[1]);
    assert.equal(result.objective.appliedDistance, 7);
    assert.equal(result.objective.estimatedSavings, 3);
    assert.equal(result.routingMetadata.road_search_baseline_distance, 10);
    assert.equal(result.routingMetadata.road_search_coverage.cycle_complete, true);
});

test('no-ops before the first improvement do not pin savings to an older road measurement', async () => {
    let calls = 0;
    const result = await optimize(properties, { maxSearchPasses: 3, client: api(async () => {
        return ++calls === 1 ? response({ meta: { road_matrix_version: 'old' } })
            : response({ selected: 'road_aware', order: candidate, ledger: coverage(5),
                meta: { input_measured: 11, winning_route_distance: 9, road_matrix_version: 'new' } });
    }) });
    assert.equal(calls, 2);
    assert.equal(result.objective.estimatedSavings, 2);
    assert.equal(result.routingMetadata.road_search_baseline_distance, 11);
});

test('a later unchanged verification keeps a whole-route distance even without a winner field', async () => {
    let calls = 0;
    const result = await optimize(properties, { maxSearchPasses: 3, client: api(async () => {
        if (++calls === 1) return response({ selected: 'road_aware', order: candidate });
        const confirmed = response({ order: candidate, ledger: coverage(5), meta: { input_measured: 8 } });
        delete confirmed.data.routing_metadata.winning_route_distance;
        return confirmed;
    }) });
    assert.equal(calls, 2);
    assert.equal(result.objective.appliedDistance, 8);
    assert.equal(result.routingMetadata.winning_route_distance, 8);
    assert.equal(result.routingMetadata.road_search_coverage.cycle_complete, true);
});

for (const laterFailure of ['outage', 'malformed_order', 'partial_proof', 'changed_graph', 'changed_distance']) {
    test(`a later ${laterFailure} preserves the last fully verified improvement and its coverage`, async () => {
        let calls = 0;
        const result = await optimize(properties, { maxSearchPasses: 3,
            onOutcome: () => assert.fail('a later failure cannot discard the verified winner'),
            client: api(async () => {
                if (++calls === 1) return response({ selected: 'road_aware', order: candidate });
                if (laterFailure === 'outage') throw new Error('offline');
                if (laterFailure === 'malformed_order') return response({ selected: 'road_aware', order: ['A', 'A', 'B'] });
                if (laterFailure === 'partial_proof') return response({ selected: 'road_aware', order: ['B', 'C', 'A'],
                    meta: { input_measured: 8, road_path_validated: false } });
                return response({ order: candidate, ledger: coverage(5),
                    meta: { input_measured: laterFailure === 'changed_distance' ? 9 : 8,
                        ...(laterFailure === 'changed_graph' ? { road_matrix_version: 'new-graph' } : {}) } });
            }) });
        assert.equal(calls, 2);
        assert.deepEqual(result.order.map(p => p.address_hash), candidate);
        assert.equal(result.objective.appliedDistance, 8);
        assert.equal(result.objective.estimatedSavings, 2);
        assert.deepEqual(result.routingMetadata.road_search_coverage, coverage());
        assert.equal(result.routingMetadata.road_path_validated, true);
        assert.equal(result.routingMetadata.road_search_passes, 2);
        assert.ok(result.routingMetadata.road_search_stop_reason);
    });
}

test('an improvement can continue after invalidating old questions, but a later stalled no-op stops', async () => {
    let calls = 0;
    const noProgress = { ...coverage(), progress_this_pass: 0 };
    const result = await optimize(properties, { maxSearchPasses: 3, client: api(async () => {
        calls++;
        return response({ ledger: noProgress, order: candidate, selected: calls === 1 ? 'road_aware' : 'current',
            meta: { input_measured: calls === 1 ? 10 : 8 } });
    }) });
    assert.equal(calls, 2);
    assert.equal(result.objective.estimatedSavings, 2);
    assert.equal(result.routingMetadata.road_search_coverage.cycle_complete, false);
});
