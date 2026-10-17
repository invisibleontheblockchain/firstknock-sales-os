import test from 'node:test';
import assert from 'node:assert/strict';
import { tryRoadMatrixOptimize } from '../base44/shared/roadMatrixSearch.js';
import { routePropertyOrderFingerprint } from '../base44/shared/routeFingerprint.js';

// Three verified passes over 6 stops: pass 1 reorders, pass 2 improves on it,
// pass 3 finds nothing more. Continuation tokens chain the passes.
const stops = Array.from({ length: 6 }, (_, i) => ({ address_hash: `S${i}`, lat: 35 + i / 1000, lng: -81,
    ...(i === 4 ? { routing_access: { resolution_status: 'resolved', source: 'test', point: { lat: 35.004, lng: -81.0001 } } } : {}) }));
const original = stops.map(stop => stop.address_hash);
const key = i => String(i).padStart(32, '0');
function scripted() {
    const calls = [];
    const orders = [['S1', 'S0', 'S2', 'S3', 'S4', 'S5'], ['S1', 'S0', 'S2', 'S3', 'S5', 'S4'], null];
    const miles = [[10, 9], [9, 8.5], [8.5, 8.5]];
    const invoke = async (_name, payload) => {
        const pass = calls.length;
        calls.push(structuredClone(payload));
        const input = payload.properties.map(stop => stop.address_hash);
        const output = orders[pass] || input;
        const [inputMiles, outputMiles] = miles[pass];
        return { data: { success: true, selected: orders[pass] ? 'road_aware' : 'current', order: output,
            search_continuation: `token-${pass}`,
            routing_metadata: { input_measured: inputMiles, winning_route_distance: outputMiles, duration_improvement: orders[pass] ? 1 : 0,
                road_path_validated: true, road_network_used: true, road_geometry: [[35, -81], [35.1, -81]],
                neighborhood_excursion_review: { local_driving_review: { validation: 'whole_route', applied: Boolean(orders[pass]),
                    planned: 3, checked: 1, skipped: [] } },
                road_search_coverage: { version: 1, policy: 'resume_test', completed_window_keys: Array.from({ length: pass + 1 }, (_, i) => key(i + 1)),
                    total_windows: 3, remaining_windows: 2 - pass, checked_this_pass: 1, progress_this_pass: 1, cycle_complete: pass === 2 },
                ...(pass ? { road_search_comparison: { version: 1, service_objective: 'coherent_side_passes_then_driving_cost', graph_version: 'g',
                    original_order_fingerprint: routePropertyOrderFingerprint(original), input_order_fingerprint: routePropertyOrderFingerprint(input),
                    output_order_fingerprint: routePropertyOrderFingerprint(output), original_miles: 10, input_miles: inputMiles, output_miles: outputMiles,
                    original_seconds: 600, input_seconds: inputMiles * 60, output_seconds: outputMiles * 60,
                    original_pass_violations: 0, input_pass_violations: 0, output_pass_violations: 0 } } : {}) } } };
    };
    return { calls, client: { functions: { invoke } } };
}

test('a search suspended after every pass and resumed from JSON state ends exactly like one uninterrupted search', async () => {
    const whole = scripted();
    const uninterrupted = await tryRoadMatrixOptimize(stops, { client: whole.client, maxSearchPasses: 8 });

    const stepped = scripted();
    let state = null, result = null, invocations = 0;
    for (;;) {
        let suspended = null;
        invocations++;
        result = await tryRoadMatrixOptimize(stops, { client: stepped.client, maxSearchPasses: 8,
            resume: state, suspendAfterPasses: 1, onSuspend: value => { suspended = value; } });
        if (!suspended) break;
        state = JSON.parse(JSON.stringify(suspended)); // as saved on the job record
        assert.equal(JSON.stringify(state).includes('road_geometry'), false, 'display geometry is not carried between calls');
    }
    assert.equal(invocations, 3);
    assert.deepEqual(stepped.calls, whole.calls, 'the same requests, tokens, coverage and known failures');
    assert.deepEqual(result.order.map(stop => stop.address_hash), uninterrupted.order.map(stop => stop.address_hash));
    assert.deepEqual(result.objective, uninterrupted.objective);
    assert.equal(result.objective.appliedDistance, 8.5);
    assert.equal(result.objective.estimatedSavings, 1.5);
    assert.equal(result.routingMetadata.road_search_passes, 3);
    const s4 = order => order.find(stop => stop.address_hash === 'S4');
    assert.deepEqual(s4(result.order).routing_access, s4(uninterrupted.order).routing_access);
    assert.deepEqual(s4(result.order).routing_access, stops[4].routing_access, 'recovered access survives the round trip');
});

test('saved state for another route cannot be resumed', async () => {
    const { client } = scripted();
    let state;
    await tryRoadMatrixOptimize(stops, { client, suspendAfterPasses: 1, onSuspend: value => { state = value; } });
    const other = stops.map((stop, i) => ({ ...stop, address_hash: `T${i}` }));
    await assert.rejects(tryRoadMatrixOptimize(other, { client, resume: state }), /does not match this route/);
});
