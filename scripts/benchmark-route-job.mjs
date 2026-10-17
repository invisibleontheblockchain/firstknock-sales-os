// End-to-end benchmark of a server-side background road search
// (RouteOptimizationJob), as a server generator would leave a route:
//   1. "before": the server's current finish (one neighborhood review);
//   2. the job, one pass per worker call, against an in-memory store, calling
//      optimizeRouteRoadMatrix in-process with the signed worker credential
//      (the SDK stub has no user, so the credential path is exercised).
// Read-only against the road server; nothing is written anywhere.
//
//   OSRM_BASE_URL=... OSRM_GATEWAY_KEY=... ROUTE_SEARCH_CONTINUATION_SECRET=<32+ chars> \
//   deno run --import-map=scripts/benchmark-optimize-live/job_import_map.json --allow-net --allow-env --allow-read --allow-write \
//     scripts/benchmark-route-job.mjs --route route.json [--out result.json]

const args = {};
for (let i = 0; i < Deno.args.length; i += 1) if (Deno.args[i].startsWith('--')) args[Deno.args[i].slice(2)] = Deno.args[++i];
const root = new URL('../', import.meta.url);
// Search continuations are bound to the app id, as in production.
Deno.env.set('BASE44_APP_ID', Deno.env.get('BASE44_APP_ID') || 'benchmark-app');
const handler = (await import(new URL('base44/functions/optimizeRouteRoadMatrix/entry.ts', root).href)).default;
const jobs = await import(new URL('base44/shared/routeOptimizationJobs.js', root).href);
const { reviewFinalNeighborhoodRoute } = await import(new URL('base44/shared/finalNeighborhoodReview.js', root).href);
const { measureRoadPath } = await import(new URL('base44/shared/roadPathMeasure.js', root).href);
const { fetchOsrmJson } = await import(new URL('base44/shared/osrmDispatcher.js', root).href);
const { readOsrmProvider } = await import(new URL('base44/shared/osrmProvider.js', root).href);
const readSecret = name => Deno.env.get(name) || '';
const baseUrl = readOsrmProvider(readSecret).baseUrl;
const doors = JSON.parse(await Deno.readTextFile(String(args.route))).doors;
const round = value => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null);
const measure = async order => { const m = await measureRoadPath(order, { baseUrl, timeoutMs: 120000 }); return m.ok ? round(m.totalMiles) : null; };
const byHash = new Map(doors.map(door => [door.address_hash, door]));

// 1. The server's current finish for a generated route.
let started = performance.now();
const review = await reviewFinalNeighborhoodRoute(doors, { vehicleBaseUrl: baseUrl,
    vehicleFetch: async url => { const payload = await fetchOsrmJson(url); return { ok: true, json: async () => payload }; } });
const serverMs = performance.now() - started;
const before = review.properties;

// 2. The background job over that saved route.
const tables = { RouteOptimizationJob: new Map(), SavedRoute: new Map(), InteractionLog: new Map() };
let next = 1;
const entity = name => ({
    create: async data => { const row = { id: `${name}${next++}`, created_date: new Date().toISOString(), ...data }; tables[name].set(row.id, row); return row; },
    get: async id => structuredClone(tables[name].get(id) ?? null),
    update: async (id, patch) => { const row = { ...tables[name].get(id), ...patch }; tables[name].set(id, row); if (name === 'SavedRoute') writes.push({ at: performance.now(), row }); return row; },
    filter: async (query = {}) => [...tables[name].values()].filter(row => Object.entries(query).every(([k, v]) => row[k] === v)),
});
const writes = [];
const service = { entities: Object.fromEntries(Object.keys(tables).map(name => [name, entity(name)])), functions: { invoke: async () => ({}) } };
tables.SavedRoute.set('route', { id: 'route', manager_id: 'manager', status: 'ACTIVE', assigned_to: null, route_origin_mode: 'none',
    start_location: null, end_location: null, property_hashes: before.map(door => door.address_hash), metrics: {}, metadata: {} });
const invoke = async (_name, payload) => {
    const response = await handler(new Request('https://benchmark.invalid/', { method: 'POST', body: JSON.stringify(payload) }));
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Optimize failed'), { response: { status: response.status, data } });
    return { data };
};
started = performance.now();
const job = await jobs.enqueueRouteOptimizationJob(service, { route: tables.SavedRoute.get('route'), properties: before,
    source: 'auto_recent_sales', ownerUserId: 'manager', managerId: 'manager', kick: false });
const calls = [];
let outcome;
for (let call = 0; call < 12; call += 1) {
    const callStarted = performance.now();
    outcome = await jobs.advanceRouteOptimizationJob(service, job.id, { readSecret, invoke, kick: async () => {} });
    calls.push({ status: outcome.status, ms: Math.round(performance.now() - callStarted) });
    if (!['queued', 'retry'].includes(outcome.status)) break;
}
const jobMs = performance.now() - started;
const final = tables.SavedRoute.get('route').property_hashes.map(hash => byHash.get(hash));
const record = tables.RouteOptimizationJob.get(job.id);
// Reference: the same search uninterrupted from the same saved order, as the
// app's Optimize button would run it.
let reference = null;
if (args.compare !== 'false') {
    const { tryRoadMatrixOptimize } = await import(new URL('base44/shared/roadMatrixSearch.js', root).href);
    const { signWorkerCredential } = await import(new URL('base44/shared/routeOptimizationWorkerAuth.js', root).href);
    const passes = [];
    const refStarted = performance.now();
    const client = { functions: { invoke: async (name, payload) => { passes.push(1); return invoke(name, { ...payload,
        worker_credential: await signWorkerCredential(readSecret('ROUTE_SEARCH_CONTINUATION_SECRET'), { ownerUserId: 'manager', jobId: 'reference' }) }); } } };
    const trace = [];
    const best = await tryRoadMatrixOptimize(before, { client, maxSearchPasses: 8,
        onSearchProgress: value => trace.push({ pass: value.passesDone, saved: value.savedMiles, best: value.bestMiles, checks: `${value.checksDone}/${value.checksTotal}` }) });
    if (args.trace) console.log(JSON.stringify({ trace, final: best?.objective, stop: best?.routingMetadata?.road_search_stop_reason, strategy: best?.routingMetadata?.strategy }));
    reference = { ms: Math.round(performance.now() - refStarted), passes: passes.length, measured_distance: best?.objective?.appliedDistance ?? null,
        miles: await measure((best?.order || before).map(stop => byHash.get(stop.address_hash))),
        checks: best?.routingMetadata?.road_search_coverage ? `${best.routingMetadata.road_search_coverage.total_windows - best.routingMetadata.road_search_coverage.remaining_windows}/${best.routingMetadata.road_search_coverage.total_windows}` : null };
}
const result = {
    stops: doors.length,
    server_call_ms: Math.round(serverMs), before_miles: await measure(before),
    job_status: record.status, job_ms: Math.round(jobMs), worker_calls: calls.length, passes: record.passes_done,
    first_saved_ms: writes.length ? Math.round(writes[0].at - started) : null, route_writes: writes.length,
    checks: record.checks_total ? `${record.checks_done}/${record.checks_total}` : null,
    after_miles: await measure(final), after_measured_distance: tables.SavedRoute.get('route').metrics.distance ?? null,
    improved_miles_reported: record.improved_miles, uninterrupted_reference: reference, calls,
};
console.log(JSON.stringify(result));
if (args.out) await Deno.writeTextFile(String(args.out), JSON.stringify(result, null, 2));
