import test from 'node:test';
import assert from 'node:assert/strict';
import {
    advanceRouteOptimizationJob, enqueueRouteOptimizationJob, publicJobStatus, sweepRouteOptimizationJobs, JOB_LEASE_MS
} from '../base44/shared/routeOptimizationJobs.js';
import { verifyWorkerCredential } from '../base44/shared/routeOptimizationWorkerAuth.js';
import { routePropertyOrderFingerprint } from '../base44/shared/routeFingerprint.js';

const SECRET = 'worker-test-secret-0123456789abcdefghij';
const readSecret = name => (name === 'ROUTE_SEARCH_CONTINUATION_SECRET' ? SECRET : '');
const stops = Array.from({ length: 6 }, (_, i) => ({ address_hash: `S${i}`, lat: 35 + i / 1000, lng: -81,
    house_number: String(100 + i), street_name: 'Elm St', owner_name: 'never stored' }));
const original = stops.map(stop => stop.address_hash);

// In-memory Base44 entities, as the service role sees them.
function store({ route = {}, logs = [] } = {}) {
    let next = 1;
    const tables = { RouteOptimizationJob: new Map(), SavedRoute: new Map(), InteractionLog: new Map() };
    const now = () => new Date().toISOString();
    const entity = name => ({
        create: async data => { const row = { id: `${name}-${next++}`, created_date: now(), ...data }; tables[name].set(row.id, row); return row; },
        get: async id => (tables[name].has(id) ? structuredClone(tables[name].get(id)) : null),
        update: async (id, patch) => { const row = { ...tables[name].get(id), ...patch, updated_date: now() }; tables[name].set(id, row); return row; },
        filter: async (query = {}, _sort, limit = 50) => [...tables[name].values()]
            .filter(row => Object.entries(query).every(([k, v]) => row[k] === v)).slice(0, limit),
    });
    tables.SavedRoute.set('route-1', { id: 'route-1', manager_id: 'mgr', status: 'ACTIVE', assigned_to: 'rep-1',
        start_location: null, end_location: null, route_origin_mode: 'none', property_hashes: [...original],
        metrics: { distance: 10, house_count: 6 }, metadata: { kept: true }, ...route });
    for (const log of logs) tables.InteractionLog.set(`log-${next++}`, log);
    const service = { entities: Object.fromEntries(Object.keys(tables).map(name => [name, entity(name)])),
        functions: { invoke: async () => ({ data: {} }) } };
    return { service, tables };
}

// The optimizer behind the worker: 3 verified passes (10 -> 9 -> 8.5 -> 8.5 mi).
function optimizer() {
    const calls = [];
    const orders = [['S1', 'S0', 'S2', 'S3', 'S4', 'S5'], ['S1', 'S0', 'S2', 'S3', 'S5', 'S4'], null];
    const miles = [[10, 9], [9, 8.5], [8.5, 8.5]];
    const invoke = async (name, payload) => {
        assert.equal(name, 'optimizeRouteRoadMatrix');
        const pass = calls.length;
        calls.push(payload);
        const input = payload.properties.map(stop => stop.address_hash);
        const output = orders[pass] || input;
        const [inputMiles, outputMiles] = miles[pass];
        return { data: { success: true, selected: orders[pass] ? 'road_aware' : 'current', order: output, search_continuation: `token-${pass}`,
            routing_metadata: { input_measured: inputMiles, winning_route_distance: outputMiles, duration_improvement: orders[pass] ? 1 : 0,
                road_path_validated: true, road_network_used: true, start_location: payload.start_location, road_geometry: [[35, -81]],
                neighborhood_excursion_review: { local_driving_review: { validation: 'whole_route', applied: Boolean(orders[pass]), planned: 3, checked: 1, skipped: [] } },
                road_search_coverage: { version: 1, policy: 'job_test', completed_window_keys: Array.from({ length: pass + 1 }, (_, i) => String(i + 1).padStart(32, '0')),
                    total_windows: 3, remaining_windows: 2 - pass, checked_this_pass: 1, progress_this_pass: 1, cycle_complete: pass === 2 },
                ...(pass ? { road_search_comparison: { version: 1, service_objective: 'coherent_side_passes_then_driving_cost', graph_version: 'g',
                    original_order_fingerprint: routePropertyOrderFingerprint(original), input_order_fingerprint: routePropertyOrderFingerprint(input),
                    output_order_fingerprint: routePropertyOrderFingerprint(output), original_miles: 10, input_miles: inputMiles, output_miles: outputMiles,
                    original_seconds: 600, input_seconds: inputMiles * 60, output_seconds: outputMiles * 60,
                    original_pass_violations: 0, input_pass_violations: 0, output_pass_violations: 0 } } : {}) } } };
    };
    return { calls, invoke };
}

async function runToEnd(service, jobId, invoke, extra = {}) {
    const kicks = [];
    let outcome;
    for (let i = 0; i < 10; i++) {
        outcome = await advanceRouteOptimizationJob(service, jobId, { readSecret, invoke, kick: async id => { kicks.push(id); }, ...extra });
        if (outcome.status !== 'queued') break;
    }
    return { outcome, kicks };
}

test('a queued job runs one pass per call, saves each measurable improvement and ends with the full search result', async () => {
    const { service, tables } = store();
    const route = tables.SavedRoute.get('route-1');
    const job = await enqueueRouteOptimizationJob(service, { route, properties: stops, source: 'auto_recent_sales',
        ownerUserId: 'mgr', managerId: 'mgr', kick: false });
    assert.equal(JSON.parse(job.properties_json).some(stop => 'owner_name' in stop), false, 'only what the search needs is stored');
    const { calls, invoke } = optimizer();
    const first = await advanceRouteOptimizationJob(service, job.id, { readSecret, invoke, kick: async () => {} });
    assert.equal(first.status, 'queued');
    assert.equal(calls.length, 1, 'one pass per worker call');
    // Pass 1 saves 1 mi at once: first result fast, on the server too.
    assert.deepEqual(tables.SavedRoute.get('route-1').property_hashes, ['S1', 'S0', 'S2', 'S3', 'S4', 'S5']);
    const saved = tables.RouteOptimizationJob.get(job.id);
    assert.equal(saved.passes_done, 1); assert.equal(saved.checks_done, 1); assert.equal(saved.checks_total, 3);
    assert.ok(saved.state_json.includes('token-0'));

    const { outcome, kicks } = await runToEnd(service, job.id, invoke);
    assert.equal(outcome.status, 'improved');
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map(call => call.search_continuation ?? null), [null, 'token-0', 'token-1'], 'continuations chain across calls');
    for (const call of calls) assert.deepEqual(await verifyWorkerCredential(SECRET, call.worker_credential), { id: 'mgr', worker_job_id: job.id });
    assert.equal(kicks.length, 1, 'the worker chains itself after each suspended pass');
    const final = tables.SavedRoute.get('route-1');
    assert.deepEqual(final.property_hashes, ['S1', 'S0', 'S2', 'S3', 'S5', 'S4']);
    assert.equal(final.metrics.distance, 8.5);
    assert.equal(final.metadata.kept, true);
    assert.equal(final.metadata.road_verification.verdict, 'road_adopted');
    assert.equal(final.metadata.background_road_search.job_id, job.id);
    const done = tables.RouteOptimizationJob.get(job.id);
    assert.equal(done.status, 'improved'); assert.equal(done.improved_miles, 1.5); assert.equal(done.state_json, '');
});

test('the job never overwrites a route that was edited, started, run or reassigned after it began', async () => {
    const cases = [
        ['edited', tables => { tables.SavedRoute.get('route-1').property_hashes.reverse(); }],
        ['started', tables => { tables.SavedRoute.get('route-1').status = 'IN_PROGRESS'; }],
        ['reassigned', tables => { tables.SavedRoute.get('route-1').assigned_to = 'rep-2'; }],
        ['run', tables => { tables.InteractionLog.set('knock', { route_id: 'route-1', created_date: new Date(Date.now() + 2000).toISOString() }); }],
        ['deleted', tables => { tables.SavedRoute.delete('route-1'); }],
    ];
    for (const [reason, change] of cases) {
        const { service, tables } = store();
        const job = await enqueueRouteOptimizationJob(service, { route: tables.SavedRoute.get('route-1'), properties: stops,
            source: 'rep_anchor_change', ownerUserId: 'mgr', managerId: 'mgr', kick: false });
        const before = structuredClone(tables.SavedRoute.get('route-1'));
        change(tables);
        const { invoke, calls } = optimizer();
        const outcome = await advanceRouteOptimizationJob(service, job.id, { readSecret, invoke, kick: async () => {} });
        assert.equal(outcome.status, 'discarded', reason);
        assert.equal(outcome.reason, reason);
        assert.equal(calls.length, 0, `${reason}: no search runs`);
        if (reason !== 'deleted') assert.notDeepEqual(tables.SavedRoute.get('route-1').metadata?.background_road_search, { job_id: job.id });
        void before;
    }
});

test('an edit between passes stops the job before its next write', async () => {
    const { service, tables } = store();
    const job = await enqueueRouteOptimizationJob(service, { route: tables.SavedRoute.get('route-1'), properties: stops,
        source: 'auto_recent_sales', ownerUserId: 'mgr', managerId: 'mgr', kick: false });
    const { invoke } = optimizer();
    await advanceRouteOptimizationJob(service, job.id, { readSecret, invoke, kick: async () => {} });
    const afterPassOne = tables.SavedRoute.get('route-1').property_hashes.join();
    // The manager drags a stop: the order differs from what the job wrote.
    tables.SavedRoute.get('route-1').property_hashes = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5'];
    const outcome = await advanceRouteOptimizationJob(service, job.id, { readSecret, invoke, kick: async () => {} });
    assert.deepEqual([outcome.status, outcome.reason], ['discarded', 'edited']);
    assert.notEqual(tables.SavedRoute.get('route-1').property_hashes.join(), afterPassOne);
    assert.equal(tables.SavedRoute.get('route-1').property_hashes.join(), 'S0,S1,S2,S3,S4,S5');
});

test('one worker at a time: a live lease turns a second call away; an expired one is resumed by the sweep', async () => {
    const { service, tables } = store();
    const job = await enqueueRouteOptimizationJob(service, { route: tables.SavedRoute.get('route-1'), properties: stops,
        source: 'rep_anchor_change', ownerUserId: 'mgr', managerId: 'mgr', kick: false });
    tables.RouteOptimizationJob.set(job.id, { ...tables.RouteOptimizationJob.get(job.id), status: 'running',
        lease_token: 'other', lease_until: new Date(Date.now() + JOB_LEASE_MS).toISOString() });
    const { invoke, calls } = optimizer();
    assert.equal((await advanceRouteOptimizationJob(service, job.id, { readSecret, invoke })).status, 'busy');
    assert.equal(calls.length, 0);
    let kicked = [];
    await sweepRouteOptimizationJobs(service, { kick: async id => { kicked.push(id); } });
    assert.deepEqual(kicked, [], 'a live lease is left alone');
    tables.RouteOptimizationJob.get(job.id).lease_until = new Date(Date.now() - 1000).toISOString();
    await sweepRouteOptimizationJobs(service, { kick: async id => { kicked.push(id); } });
    assert.deepEqual(kicked, [job.id], 'a worker that died is restarted');
    const outcome = await advanceRouteOptimizationJob(service, job.id, { readSecret, invoke, kick: async () => {} });
    assert.equal(outcome.status, 'queued');
});

test('a crashed pass keeps the last saved state, and a newer job for the route cancels the older one', async () => {
    const { service, tables } = store();
    const route = tables.SavedRoute.get('route-1');
    const job = await enqueueRouteOptimizationJob(service, { route, properties: stops, source: 'rep_anchor_change',
        ownerUserId: 'mgr', managerId: 'mgr', kick: false });
    const crashed = await advanceRouteOptimizationJob(service, job.id, { readSecret, kick: async () => {},
        invoke: async () => { throw new Error('function timed out'); } });
    assert.deepEqual(crashed, { status: 'retry', reason: 'backend_unavailable' }, 'an outage on a pass is retried later');
    assert.equal(tables.RouteOptimizationJob.get(job.id).status, 'queued');
    assert.equal(tables.RouteOptimizationJob.get(job.id).passes_done, 0, 'the failed pass does not count');
    assert.deepEqual(tables.SavedRoute.get('route-1').property_hashes, original, 'nothing written');
    const newer = await enqueueRouteOptimizationJob(service, { route, properties: stops, source: 'rep_anchor_change',
        ownerUserId: 'mgr', managerId: 'mgr', kick: false });
    assert.equal(tables.RouteOptimizationJob.get(job.id).status, 'cancelled');
    assert.equal(tables.RouteOptimizationJob.get(newer.id).status, 'queued');
});

test('a backend-generated route is searched once it is saved with the same stop order', async () => {
    const { service, tables } = store({ route: { property_hashes: ['X'] } });
    const job = await enqueueRouteOptimizationJob(service, { properties: stops, source: 'backend_generation',
        ownerUserId: 'mgr', managerId: 'mgr', kick: false });
    assert.equal(job.status, 'awaiting_route');
    const { invoke, calls } = optimizer();
    assert.equal((await advanceRouteOptimizationJob(service, job.id, { readSecret, invoke })).status, 'awaiting_route');
    tables.SavedRoute.set('route-2', { id: 'route-2', manager_id: 'mgr', status: 'PENDING', assigned_to: null, start_location: null,
        end_location: null, route_origin_mode: null, property_hashes: [...original], metrics: {}, metadata: {} });
    const outcome = await advanceRouteOptimizationJob(service, job.id, { readSecret, invoke, kick: async () => {} });
    assert.equal(outcome.status, 'queued');
    assert.equal(tables.RouteOptimizationJob.get(job.id).route_id, 'route-2');
    assert.equal(calls.length, 1);
});

test('anchored jobs never write the private anchor onto the route, and the app sees only safe status fields', async () => {
    const { service, tables } = store({ route: { route_origin_mode: 'anchor_round_trip' } });
    const anchor = { lat: 35.123456, lng: -81.654321 };
    const job = await enqueueRouteOptimizationJob(service, { route: tables.SavedRoute.get('route-1'), properties: stops,
        start: anchor, end: anchor, source: 'rep_anchor_change', ownerUserId: 'mgr', managerId: 'mgr', kick: false });
    const { invoke, calls } = optimizer();
    await runToEnd(service, job.id, invoke);
    assert.deepEqual(calls[0].start_location, anchor, 'the search runs from the anchor');
    assert.doesNotMatch(JSON.stringify(tables.SavedRoute.get('route-1')), /35\.123456|81\.654321/);
    const view = publicJobStatus(tables.RouteOptimizationJob.get(job.id));
    assert.doesNotMatch(JSON.stringify(view), /35\.123456|properties_json|state_json|lease|token|Elm St/);
    assert.equal(view.status, 'improved');
});
