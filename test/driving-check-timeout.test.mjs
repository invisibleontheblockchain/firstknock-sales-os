import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { configureOsrmDispatcher, fetchOsrmJson, osrmCounters, resetOsrmCounters } from '../base44/shared/osrmDispatcher.js';
import { tryRoadMatrixOptimize } from '../base44/shared/roadMatrixSearch.js';

// Lincolnton Precision Route 1 (184 stops), 2026-10-18: one road request on
// the server got no answer, the 15 s vehicle-routing timer failed pass 1 after
// 24.9 s, and the person saw "Vehicle routing timed out" with the route
// unchanged. The gateway answered every request it received in under 1 s.

const originalFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = originalFetch;
    configureOsrmDispatcher({ maxConcurrent: 16, spacingMs: 0, attemptStallMs: 8000, baseUrl: '', gatewayKey: '' });
    resetOsrmCounters();
});

// A request that is never answered: it only ends when its signal aborts.
const silent = (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
});

test('a road request that gets no answer is sent again instead of waiting out the whole deadline', async () => {
    configureOsrmDispatcher({ attemptStallMs: 40 });
    let calls = 0;
    globalThis.fetch = async (url, options) => (++calls === 1 ? silent(url, options) : Response.json({ code: 'Ok', n: calls }));
    const started = Date.now();
    assert.deepEqual(await fetchOsrmJson('https://gateway.example/table/v1/driving/1,2;3,4', { timeoutMs: 5000 }), { code: 'Ok', n: 2 });
    assert.ok(Date.now() - started < 1000, 'answered by the second attempt, long before the deadline');
    assert.equal(osrmCounters().stalls, 1);
    assert.equal(osrmCounters().retries, 1);
});

test('the stall clock starts when a request is sent, not while it waits its turn', async () => {
    configureOsrmDispatcher({ maxConcurrent: 1, attemptStallMs: 60 });
    globalThis.fetch = async () => { await new Promise(resolve => setTimeout(resolve, 35)); return Response.json({ code: 'Ok' }); };
    await Promise.all([1, 2, 3].map(i => fetchOsrmJson(`https://gateway.example/route/v1/driving/${i},0;1,1`, { timeoutMs: 5000 })));
    assert.equal(osrmCounters().stalls, 0, 'the third waited ~70 ms in the queue without being called stalled');
});

test('a request that never answers still ends at its deadline, with the deadline error', async () => {
    configureOsrmDispatcher({ attemptStallMs: 30 });
    globalThis.fetch = silent;
    await assert.rejects(fetchOsrmJson('https://gateway.example/route/v1/driving/1,2;3,4', { timeoutMs: 200 }),
        error => error.code === 'OSRM_DEADLINE' || /no answer within/.test(error.message));
});

const stops = Array.from({ length: 6 }, (_, i) => ({ address_hash: `S${i}`, lat: 35 + i / 1000, lng: -81 }));
const better = ['S1', 'S0', 'S2', 'S3', 'S4', 'S5'];
const serverError = (status, publicError) => Object.assign(new Error(`Request failed with status code ${status}`),
    { response: { status, data: { error: 'private', public_error: publicError } } });
const verifiedPass = () => ({ data: { success: true, selected: 'road_aware', order: better,
    routing_metadata: { input_measured: 10, winning_route_distance: 9, duration_improvement: 1,
        road_path_validated: true, road_network_used: true,
        neighborhood_excursion_review: { local_driving_review: { validation: 'whole_route', applied: true, planned: 1, checked: 1, skipped: [] } },
        road_search_coverage: { version: 1, policy: 'timeout_test', completed_window_keys: ['0'.repeat(32)],
            total_windows: 1, remaining_windows: 0, checked_this_pass: 1, progress_this_pass: 1, cycle_complete: true } } } });
function server(failures) {
    const calls = [];
    return { calls, client: { functions: { invoke: async (_name, payload) => {
        calls.push(payload);
        const failure = failures[calls.length - 1];
        if (failure) throw failure;
        return verifiedPass();
    } } } };
}

test('a pass that fails on the server is sent once more, and its verified result is kept', async () => {
    const backend = server([serverError(500, 'Vehicle routing timed out. The existing route was left unchanged.')]);
    let reason = null;
    const result = await tryRoadMatrixOptimize(stops, { client: backend.client, maxSearchPasses: 8, onOutcome: value => { reason = value; } });
    assert.equal(backend.calls.length, 2);
    assert.deepEqual(result.order.map(stop => stop.address_hash), better);
    assert.equal(result.objective.estimatedSavings, 1);
    assert.equal(result.routingMetadata.road_search_retried_pass, 1);
    assert.equal(reason, null, 'no failure is reported');
});

test('a pass is retried only once, and never for an answer about the route', async () => {
    const twice = server([serverError(500, 'Vehicle routing timed out.'), serverError(502, 'Bad gateway')]);
    let reason = null;
    assert.equal(await tryRoadMatrixOptimize(stops, { client: twice.client, maxSearchPasses: 8, onOutcome: value => { reason = value; } }), null);
    assert.equal(twice.calls.length, 2);
    assert.equal(reason, 'backend_unavailable');

    const lost = server([new Error('Network Error')]);
    await tryRoadMatrixOptimize(stops, { client: lost.client, maxSearchPasses: 8 });
    assert.equal(lost.calls.length, 1, 'a request lost with no status may still be running: never sent twice');

    for (const status of [400, 403]) {
        const refused = server([serverError(status, 'Refused')]);
        await tryRoadMatrixOptimize(stops, { client: refused.client, maxSearchPasses: 8 });
        assert.equal(refused.calls.length, 1, `HTTP ${status} is an answer`);
    }
    const limited = server([Object.assign(serverError(500, ''), { response: { status: 500, data: { error: 'cpu-exceeded' } } })]);
    await tryRoadMatrixOptimize(stops, { client: limited.client, maxSearchPasses: 8 });
    assert.equal(limited.calls.length, 1, 'a CPU limit is not retried here');

    const worker = server([serverError(500, 'Vehicle routing timed out.')]);
    await tryRoadMatrixOptimize(stops, { client: worker.client, maxSearchPasses: 8, retryTransientPass: false });
    assert.equal(worker.calls.length, 1, 'the server worker retries from its saved state instead');
});
