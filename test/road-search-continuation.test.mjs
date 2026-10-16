import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { routePropertyOrderFingerprint } from '../base44/shared/routeFingerprint.js';

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
function comparison({ original = hashes, input = candidate, output = candidate,
    originalMiles = 11, inputMiles = 9, outputMiles = inputMiles,
    originalSeconds = originalMiles * 60, inputSeconds = inputMiles * 60, outputSeconds = outputMiles * 60,
    originalViolations = 0, inputViolations = 0, outputViolations = 0 } = {}) {
    return { version: 1, service_objective: 'coherent_side_passes_then_driving_cost', graph_version: 'roads-2026',
        original_order_fingerprint: routePropertyOrderFingerprint(original),
        input_order_fingerprint: routePropertyOrderFingerprint(input), output_order_fingerprint: routePropertyOrderFingerprint(output),
        original_miles: originalMiles, input_miles: inputMiles, output_miles: outputMiles,
        original_seconds: originalSeconds, input_seconds: inputSeconds, output_seconds: outputSeconds,
        original_pass_violations: originalViolations, input_pass_violations: inputViolations, output_pass_violations: outputViolations };
}

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
    assert.equal(requests[0].search_phase, undefined);
    assert.equal(requests[0].comparison_order, undefined);
    assert.deepEqual(requests[1].search_coverage, coverage());
    for (const request of requests.slice(1)) {
        assert.equal(request.search_phase, 'remaining_neighborhoods');
        assert.deepEqual(request.comparison_order, hashes, 'the original click order remains the comparison baseline');
    }
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
    assert.equal(outcome.measurement.routingMetadata.road_search_stop_reason, 'pass_limit');
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
    assert.equal(outcome.measurement.routingMetadata.road_search_stop_reason, 'action_budget');
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

test('377-door continuation completes 34 remaining checks after fresh curb measurements change', async () => {
    messages.length = 0;
    const homes = Array.from({ length: 377 }, (_, i) => ({ address_hash: `troutman-${i}`, lat: 35 + i / 100000, lng: -81 }));
    const before = homes.map(property => property.address_hash), first = [...before];
    first.splice(0, 33, ...first.slice(1, 33), first[0]);
    const final = [...first]; [final[40], final[41]] = [final[41], final[40]];
    const selected = { ...route, properties: homes, allProperties: homes, property_hashes: before,
        metrics: { distance: 271.1, house_count: 377 } };
    const ledgers = [coverage(88, 122), coverage(110, 122), coverage(122, 122)];
    const realNow = Date.now;
    let now = realNow(), calls = 0, saved, saves = 0;
    Date.now = () => now;
    try {
        await action(selected, { mode: 'route_only' }, { client: {
            functions: { invoke: async (_name, payload) => {
                const pass = calls++;
                now += [83470, 38000, 27000][pass];
                if (pass) {
                    assert.equal(payload.search_phase, 'remaining_neighborhoods');
                    assert.deepEqual(payload.comparison_order, before);
                    assert.deepEqual(payload.properties.map(property => property.address_hash), pass === 1 ? first : final);
                }
                return response({ selected: pass < 2 ? 'road_aware' : 'current', order: pass ? final : first,
                    ledger: ledgers[pass], meta: { road_matrix_source: 'test-roads', road_matrix_version: 'v1',
                        input_measured: [271.1, 271, 270.5][pass], winning_route_distance: pass ? 270.5 : 269.69,
                        ...(pass ? { road_search_comparison: comparison({ original: before,
                            input: pass === 1 ? first : final, output: final, originalMiles: 274.8,
                            inputMiles: pass === 1 ? 271 : 270.5, outputMiles: 270.5 }) } : {}) } });
            } },
            entities: { SavedRoute: { update: async (_id, patch) => { saves++; saved = { ...selected, ...patch }; return saved; } } },
        } });
    } finally { Date.now = realNow; }
    assert.equal(calls, 3);
    assert.equal(saves, 1);
    assert.deepEqual(saved.property_hashes, final);
    assert.equal(new Set(saved.property_hashes).size, 377);
    assert.equal(saved.metrics.distance, 270.5);
    assert.equal(saved.metadata.road_search_baseline_distance, 274.8);
    assert.equal(saved.metadata.road_search_coverage.remaining_windows, 0);
    assert.equal(saved.metadata.road_search_stop_reason, undefined);
    const completion = messages.find(message => message.tone === 'success');
    assert.match(completion.message, /Saved ~4\.3 estimated miles/);
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

test('fresh same-policy comparison continues after curb evidence changes the incumbent mileage', async () => {
    const next = ['B', 'C', 'A'], requests = [];
    const proof = comparison({ output: next, outputMiles: 7.5 });
    const result = await optimize(properties, { maxSearchPasses: 3, client: api(async (_name, payload) => {
        requests.push(payload);
        if (requests.length === 1) return response({ selected: 'road_aware', order: candidate });
        return response({ selected: 'road_aware', order: next, ledger: coverage(5),
            meta: { input_measured: 9, winning_route_distance: 7.5,
                road_search_comparison: { ...proof, private_anchor: { lat: 35, lng: -81 } } } });
    }) });
    assert.equal(requests.length, 2);
    assert.deepEqual(result.order.map(property => property.address_hash), next);
    assert.equal(result.objective.appliedDistance, 7.5);
    assert.equal(result.objective.estimatedSavings, 3.5, 'original order is remeasured under the new curb policy');
    assert.equal(result.routingMetadata.road_search_baseline_distance, 11);
    assert.deepEqual(result.routingMetadata.road_search_comparison, proof, 'only the proof contract is retained');
    assert.equal(result.routingMetadata.road_search_stop_reason, undefined);
});

test('a fresh no-op comparison retains the winner and completes coverage under the new curb policy', async () => {
    let calls = 0;
    const result = await optimize(properties, { maxSearchPasses: 3, client: api(async () => ++calls === 1
        ? response({ selected: 'road_aware', order: candidate })
        : response({ order: candidate, ledger: coverage(5), meta: { input_measured: 9, winning_route_distance: 9,
            road_search_comparison: comparison() } })) });
    assert.equal(calls, 2);
    assert.deepEqual(result.order.map(property => property.address_hash), candidate);
    assert.equal(result.objective.appliedDistance, 9);
    assert.equal(result.objective.estimatedSavings, 2);
    assert.equal(result.routingMetadata.road_search_coverage.remaining_windows, 0);
});

test('the fresh comparison preserves coherent-side service priority before driving cost', async () => {
    let calls = 0;
    const next = ['B', 'C', 'A'];
    const proof = comparison({ output: next, outputMiles: 12, originalViolations: 4, inputViolations: 2, outputViolations: 0 });
    const result = await optimize(properties, { maxSearchPasses: 3, client: api(async () => ++calls === 1
        ? response({ selected: 'road_aware', order: candidate })
        : response({ selected: 'road_aware', order: next, ledger: coverage(5), meta: { input_measured: 9,
            winning_route_distance: 12, road_search_comparison: proof } })) });
    assert.deepEqual(result.order.map(property => property.address_hash), next);
    assert.equal(result.objective.appliedDistance, 12);
    assert.equal(result.objective.estimatedSavings, 0, 'a service improvement cannot invent mileage savings');
});

test('a current-policy comparison can restore the original order when it is the verified winner', async () => {
    let calls = 0;
    const proof = comparison({ output: hashes, originalMiles: 7, outputMiles: 7 });
    const result = await optimize(properties, { maxSearchPasses: 3, client: api(async () => ++calls === 1
        ? response({ selected: 'road_aware', order: candidate })
        : response({ selected: 'road_aware', order: hashes, ledger: coverage(5), meta: { input_measured: 9,
            winning_route_distance: 7, road_search_comparison: proof } })) });
    assert.deepEqual(result.order.map(property => property.address_hash), hashes);
    assert.equal(result.objective.appliedDistance, 7);
    assert.equal(result.objective.estimatedSavings, 0);
});

for (const [name, mutate] of [
    ['original identity mismatch', proof => { proof.original_order_fingerprint = routePropertyOrderFingerprint(candidate); }],
    ['input identity mismatch', proof => { proof.input_order_fingerprint = routePropertyOrderFingerprint(hashes); }],
    ['output identity mismatch', proof => { proof.output_order_fingerprint = routePropertyOrderFingerprint(hashes); }],
    ['negative miles', proof => { proof.original_miles = -1; }],
    ['missing seconds', proof => { delete proof.input_seconds; }],
    ['non-finite seconds', proof => { proof.output_seconds = Infinity; }],
    ['fractional violations', proof => { proof.output_pass_violations = 0.5; }],
    ['wrong service objective', proof => { proof.service_objective = 'straight_lines'; }],
    ['invalid graph identity', proof => { proof.graph_version = {}; }],
    ['input measurement mismatch', proof => { proof.input_miles = 10; }],
    ['output measurement mismatch', proof => { proof.output_miles = 10; }],
    ['worse than original', proof => { proof.original_miles = 7; proof.original_seconds = 420; }],
    ['inconsistent identical order', proof => { proof.output_seconds = proof.input_seconds - 1; }],
]) {
    test(`a fresh comparison with ${name} cannot replace the last verified winner`, async () => {
        let calls = 0;
        const proof = comparison(); mutate(proof);
        const result = await optimize(properties, { maxSearchPasses: 3, client: api(async () => ++calls === 1
            ? response({ selected: 'road_aware', order: candidate })
            : response({ order: candidate, ledger: coverage(5), meta: { input_measured: 9, winning_route_distance: 9,
                road_search_comparison: proof } })) });
        assert.equal(calls, 2);
        assert.equal(result.objective.appliedDistance, 8);
        assert.equal(result.objective.estimatedSavings, 2);
        assert.deepEqual(result.routingMetadata.road_search_coverage, coverage());
        assert.equal(result.routingMetadata.road_search_stop_reason, 'measurement_changed');
    });
}

test('a contradictory fresh proof is rejected even if the old mileage happens to agree', async () => {
    let calls = 0;
    const proof = comparison({ inputMiles: 8 }); proof.output_miles = 7;
    const result = await optimize(properties, { maxSearchPasses: 3, client: api(async () => ++calls === 1
        ? response({ selected: 'road_aware', order: candidate })
        : response({ order: candidate, ledger: coverage(5), meta: { input_measured: 8, winning_route_distance: 8,
            road_search_comparison: proof } })) });
    assert.equal(result.objective.appliedDistance, 8);
    assert.deepEqual(result.routingMetadata.road_search_coverage, coverage());
    assert.equal(result.routingMetadata.road_search_stop_reason, 'measurement_changed');
});

for (const [name, values] of [
    ['distance', { outputMiles: 9.1, outputSeconds: 500 }],
    ['duration', { outputMiles: 8, outputSeconds: 541 }],
    ['curb pass violations', { outputMiles: 8, outputViolations: 1 }],
]) {
    test(`a fresh comparison cannot worsen incumbent ${name}`, async () => {
        let calls = 0;
        const next = ['B', 'C', 'A'], proof = comparison({ output: next, ...values });
        const result = await optimize(properties, { maxSearchPasses: 3, client: api(async () => ++calls === 1
            ? response({ selected: 'road_aware', order: candidate })
            : response({ selected: 'road_aware', order: next, ledger: coverage(5), meta: { input_measured: 9,
                winning_route_distance: proof.output_miles, road_search_comparison: proof } })) });
        assert.deepEqual(result.order.map(property => property.address_hash), candidate);
        assert.equal(result.objective.appliedDistance, 8);
        assert.equal(result.routingMetadata.road_search_stop_reason, 'measurement_changed');
    });
}

test('a fresh comparison cannot cross providers or optimizer versions between accepted passes', async () => {
    for (const key of ['road_matrix_source', 'road_matrix_version']) {
        let calls = 0;
        const result = await optimize(properties, { maxSearchPasses: 3, client: api(async () => ++calls === 1
            ? response({ selected: 'road_aware', order: candidate })
            : response({ order: candidate, ledger: coverage(5), meta: { input_measured: 9, winning_route_distance: 9,
                [key]: 'changed', road_search_comparison: comparison() } })) });
        assert.equal(result.objective.appliedDistance, 8);
        assert.equal(result.routingMetadata.road_search_stop_reason, 'measurement_changed');
    }
});

test('fresh recovery from an unchanged pass is carried to the remaining-neighborhood request', async () => {
    let calls = 0, outcome;
    const access = { source: 'county-road', lat: 35.001, lng: -81.001, resolved_at: '2026-10-15T00:00:00Z' };
    await optimize(properties, { maxSearchPasses: 3, client: api(async (_name, payload) => {
        if (++calls === 2) assert.deepEqual(payload.properties[0].routing_access, access);
        return response({ ledger: calls === 1 ? coverage() : coverage(5),
            meta: { road_access_recovery: { inventory_complete: true, access_overrides: { A: access } } } });
    }), onOutcome: (reason, measurement) => { outcome = { reason, measurement }; } });
    assert.equal(calls, 2);
    assert.equal(outcome.reason, 'current_order_measured_best');
    assert.equal(outcome.measurement.routingMetadata.road_search_coverage.remaining_windows, 0);
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
    assert.equal(result.routingMetadata.road_search_stop_reason, 'no_progress');
});

const ruralHomes = Array.from({ length: 626 }, (_, i) => ({ address_hash: `rural-${i}`,
    lat: 35 + i / 100000, lng: -81, ...(i === 10 ? { order_locked: true } : {}) }));
const ruralHashes = ruralHomes.map(p => p.address_hash);
const swap = (order, left, right) => {
    const next = [...order]; [next[left], next[right]] = [next[right], next[left]]; return next;
};
const ruralFirst = swap(ruralHashes, 0, 1), ruralSecond = swap(ruralFirst, 20, 21);
function partialResponse({ order = ruralFirst, done = 16, savings = 29.98, unchanged = false, meta = {} } = {}) {
    return { data: { success: true, selected: unchanged ? 'current' : 'road_aware', order: [...order],
        routing_metadata: { strategy: 'access_guarded_neighborhood_repair', road_path_validated: false,
            fallback: false, distance_estimate: 'unavailable', input_measured: null, winning_route_distance: null,
            matrix_provider: 'test-driving-roads', road_matrix_version: 'v1', routing_profile: 'driving',
            road_access_recovery: { status: 'partial', recovered: 5, inventory_complete: true, unverified_count: 0,
                access_overrides: {}, unresolved: [{ property_id: ruralHashes[294], stop_number: 295,
                    address: '154 Emma Ln, Statesville, 28625', reason: 'address_road_not_matched' }] },
            neighborhood_excursion_review: { local_driving_review: { applied: !unchanged,
                validation: unchanged ? 'unchanged' : 'overlapping_boundary_legs', localMilesSaved: unchanged ? 0 : savings,
                planned: 181, checked: done, skipped: [], budgetExhausted: done < 181 } },
            road_search_coverage: coverage(done, 181), ...meta } } };
}

test('626-door route automatically finishes local checks around unresolved Stop 295 and saves once', async () => {
    messages.length = 0;
    let calls = 0, saves = 0, saved;
    const selected = { ...route, property_hashes: ruralHashes, properties: ruralHomes, allProperties: ruralHomes,
        metrics: { distance: 543.21, house_count: 626 } };
    await action(selected, { mode: 'route_only' }, { effectiveProperties: [], client: {
        functions: { invoke: async (_name, payload) => {
            const expected = [ruralHashes, ruralFirst, ruralSecond][calls];
            assert.deepEqual(payload.properties.map(p => p.address_hash), expected);
            assert.equal(payload.properties[10].order_locked, true);
            if (calls) assert.deepEqual(payload.search_coverage, coverage(calls === 1 ? 16 : 100, 181));
            return [partialResponse(), partialResponse({ order: ruralSecond, done: 100, savings: 1.02 }),
                partialResponse({ order: ruralSecond, done: 181, unchanged: true })][calls++];
        } }, entities: { SavedRoute: { update: async (_id, patch) => { saves++; saved = { ...selected, ...patch }; return saved; } } },
    } });
    assert.equal(calls, 3); assert.equal(saves, 1);
    assert.deepEqual(saved.property_hashes, ruralSecond);
    assert.equal(saved.property_hashes.length, 626);
    assert.deepEqual(saved.property_hashes.slice(292, 297), ruralHashes.slice(292, 297));
    assert.equal(saved.metrics.distance, 543.21, 'local savings cannot be subtracted from an unverified trip total');
    assert.equal(saved.metadata.road_search_coverage.remaining_windows, 0);
    assert.equal(saved.metadata.routing.road_access_recovery.unresolved[0].stop_number, 295);
    assert.equal(saved.metadata.last_optimization_attempt.route_verification_complete, false);
    assert.equal(saved.metadata.routing.neighborhood_excursion_review.local_driving_review.localMilesSaved, 31);
    assert.ok(messages.some(message => /Whole-route distance remains unverified/.test(message.message)));
});

test('partial passes accumulate only independently verified local savings and never invent a whole-route baseline', async () => {
    let calls = 0;
    const result = await optimize(ruralHomes, { maxSearchPasses: 3, client: api(async () => [partialResponse(),
        partialResponse({ order: ruralSecond, done: 100, savings: 1.02 }),
        partialResponse({ order: ruralSecond, done: 181, unchanged: true })][calls++]) });
    assert.equal(calls, 3);
    assert.equal(result.objective.appliedDistance, null);
    assert.equal(result.objective.estimatedSavings, 31);
    assert.equal(result.routingMetadata.road_search_baseline_distance, undefined);
    assert.equal(result.routingMetadata.winning_route_distance, null);
    assert.equal(result.routingMetadata.road_path_validated, false);
    assert.equal(result.routingMetadata.road_search_passes, 3);
    assert.equal(result.routingMetadata.road_search_coverage.cycle_complete, true);
    assert.equal(result.routingMetadata.neighborhood_excursion_review.local_driving_review.localMilesSaved, 31);
});

for (const unsafeIndex of [10, 292, 293, 294, 295, 296]) {
    test(`partial proof cannot move protected position ${unsafeIndex + 1} on the first pass`, async () => {
        let reason, calls = 0;
        const result = await optimize(ruralHomes, { maxSearchPasses: 3,
            onOutcome: value => { reason = value; }, client: api(async () => {
                calls++; return partialResponse({ order: swap(ruralFirst, unsafeIndex, 40) });
            }) });
        assert.equal(result, null); assert.equal(calls, 1);
        assert.equal(reason, 'partial_order_changed_protected_stops');
    });
}

for (const failure of ['outage', 'invalid_proof', 'malformed_order', 'moved_unresolved', 'changed_unresolved',
    'changed_provider', 'changed_county_graph', 'changed_public_graph', 'incomplete_inventory']) {
    test(`a later partial ${failure} retains the last safe local winner and its coverage`, async () => {
        let calls = 0;
        const result = await optimize(ruralHomes, { maxSearchPasses: 3, client: api(async () => {
            if (++calls === 1) return partialResponse();
            if (failure === 'outage') throw new Error('offline');
            const value = partialResponse({ order: ruralSecond, done: 181, savings: 1.02 });
            const meta = value.data.routing_metadata;
            if (failure === 'invalid_proof') meta.neighborhood_excursion_review.local_driving_review.validation = 'unchecked';
            if (failure === 'malformed_order') value.data.order[1] = value.data.order[0];
            if (failure === 'moved_unresolved') value.data.order = swap(ruralSecond, 294, 40);
            if (failure === 'changed_unresolved') meta.road_access_recovery.unresolved = [
                { property_id: ruralHashes[400], stop_number: 401, reason: 'road_not_matched' }];
            if (failure === 'changed_provider') meta.matrix_provider = 'different-road-provider';
            if (failure === 'changed_county_graph') meta.county_road_routing = { graphIdentity: 'changed' };
            if (failure === 'changed_public_graph') meta.county_road_routing = { publicDataVersion: 'new' };
            if (failure === 'incomplete_inventory') meta.road_access_recovery.inventory_complete = false;
            return value;
        }) });
        assert.equal(calls, 2);
        assert.deepEqual(result.order.map(p => p.address_hash), ruralFirst);
        assert.equal(result.objective.appliedDistance, null);
        assert.equal(result.objective.estimatedSavings, 29.98);
        assert.deepEqual(result.routingMetadata.road_search_coverage, coverage(16, 181));
        assert.equal(result.routingMetadata.road_search_passes, 2);
        assert.ok(result.routingMetadata.road_search_stop_reason);
    });
}

test('a whole-route proof after a partial improvement stops without mixing savings scopes', async () => {
    let calls = 0;
    const result = await optimize(ruralHomes, { maxSearchPasses: 3, client: api(async () => ++calls === 1
        ? partialResponse() : response({ order: ruralSecond, selected: 'road_aware', ledger: coverage(181, 181) })) });
    assert.equal(calls, 2);
    assert.deepEqual(result.order.map(p => p.address_hash), ruralFirst);
    assert.equal(result.objective.appliedDistance, null);
    assert.equal(result.objective.estimatedSavings, 29.98);
    assert.equal(result.routingMetadata.road_search_stop_reason, 'scope_changed');
    assert.deepEqual(result.routingMetadata.road_search_coverage, coverage(16, 181));
});

test('a partial no-op with no coverage progress stops automatic requests', async () => {
    let calls = 0;
    const result = await optimize(ruralHomes, { maxSearchPasses: 3, client: api(async () => {
        if (++calls === 1) return partialResponse();
        return partialResponse({ unchanged: true,
            meta: { road_search_coverage: { ...coverage(16, 181), progress_this_pass: 0 } } });
    }) });
    assert.equal(calls, 2);
    assert.equal(result.objective.estimatedSavings, 29.98);
    assert.equal(result.routingMetadata.road_search_coverage.remaining_windows, 165);
});

test('an incomplete first partial proof cannot be adopted or automatically continued', async () => {
    for (const field of ['inventory_complete', 'matrix_provider', 'road_matrix_version', 'localMilesSaved']) {
        let calls = 0, reason;
        const result = await optimize(ruralHomes, { maxSearchPasses: 3, client: api(async () => {
            calls++; const value = partialResponse();
            if (field === 'inventory_complete') delete value.data.routing_metadata.road_access_recovery.inventory_complete;
            else if (field === 'localMilesSaved') delete value.data.routing_metadata.neighborhood_excursion_review.local_driving_review.localMilesSaved;
            else delete value.data.routing_metadata[field];
            return value;
        }), onOutcome: value => { reason = value; } });
        assert.equal(calls, 1); assert.equal(result, null);
        assert.equal(reason, 'unverified_partial_order');
    }
});

test('a contradictory first partial result cannot normalize invalid proof into an accepted winner', async () => {
    const cases = [
        value => { value.road_access_recovery.inventory_complete = false; },
        value => { value.road_access_recovery.unverified_count = 1; },
        value => { value.road_path_validated = true; },
        value => { value.distance_estimate = 'road'; },
        value => { value.input_measured = 10; },
        value => { value.winning_route_distance = 9; },
        value => { value.road_aware_measured = -1; },
        value => { value.continuity_measured = 'not-measured'; },
        value => { value.neighborhood_excursion_review.local_driving_review.localMilesSaved = NaN; },
        value => { value.neighborhood_excursion_review.local_driving_review.localMilesSaved = Infinity; },
        value => { value.neighborhood_excursion_review.local_driving_review.localMilesSaved = -1; },
    ];
    for (const alter of cases) {
        let calls = 0, reason;
        const result = await optimize(ruralHomes, { maxSearchPasses: 3, client: api(async () => {
            calls++; const value = partialResponse(); alter(value.data.routing_metadata); return value;
        }), onOutcome: value => { reason = value; } });
        assert.equal(calls, 1); assert.equal(result, null);
        assert.equal(reason, 'unverified_partial_order');
    }
});

test('an invalid first partial response cannot save a changed route', async () => {
    let patch;
    const selected = { ...route, property_hashes: ruralHashes, properties: ruralHomes, allProperties: ruralHomes,
        metrics: { distance: 543.21, house_count: 626 } };
    await action(selected, { mode: 'route_only' }, { client: {
        functions: { invoke: async () => {
            const value = partialResponse(); value.data.routing_metadata.road_access_recovery.inventory_complete = false;
            return value;
        } }, entities: { SavedRoute: { update: async (_id, update) => { patch = update; return { ...selected, ...update }; } } },
    } });
    assert.equal(patch.property_hashes, undefined);
    assert.equal(patch.metrics, undefined);
    assert.equal(patch.metadata.last_optimization_attempt.route_changed, false);
});
