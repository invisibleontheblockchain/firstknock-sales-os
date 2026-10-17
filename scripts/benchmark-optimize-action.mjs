// End-to-end benchmark of one Optimize click: the browser's multi-pass action
// (tryRoadMatrixOptimize, continuation tokens included) driving the real
// optimizeRouteRoadMatrix handler, against the configured OSRM engine.
//
//   deno run --import-map=scripts/benchmark-optimize-live/action_import_map.json \
//     --allow-net --allow-env --allow-read --allow-write \
//     scripts/benchmark-optimize-action.mjs --route route.json [--runs 3] [--passes 8] [--out result.json]
//
// --route is a local JSON file `{ "doors": [ { address_hash, house_number,
// street_name, city, state, zip_code, lat, lng, routing_access? }, ... ] }` in
// saved order. Route files and credentials stay outside the repo. Needs
// OSRM_BASE_URL, OSRM_GATEWAY_KEY and ROUTE_SEARCH_CONTINUATION_SECRET (any
// test value); GEOCODIO_API_KEY is optional, as in production.
//
// Reported per run: wall time and time to the first pass's result, each pass's
// stage timings and search coverage, OSRM request count and concurrency, road
// miles of the original and final order (both measured the same way, through
// the engine), whether the whole route was verified, and unresolved stops.
const args = {};
for (let i = 0; i < Deno.args.length; i += 1) {
    if (Deno.args[i].startsWith('--')) args[Deno.args[i].slice(2)] = Deno.args[i + 1]?.startsWith('--') ? true : Deno.args[++i] ?? true;
}
if (!args.route) throw new Error('Pass --route <file.json>.');
const root = new URL('../', import.meta.url);
const RUNS = Math.max(1, Number(args.runs) || 1);
const PASSES = Math.max(1, Number(args.passes) || 8);
Deno.env.set('BASE44_APP_ID', Deno.env.get('BASE44_APP_ID') || 'benchmark-app');

const log = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const service = url.pathname.match(/\/(table|route|nearest)\/v1\//)?.[1] || 'other';
    const startedAt = performance.now();
    const response = await realFetch(input, init);
    log.push({ service, startedAt, ms: performance.now() - startedAt });
    return response;
};

const handler = (await import(new URL('base44/functions/optimizeRouteRoadMatrix/entry.ts', root).href)).default;
const { tryRoadMatrixOptimize } = await import(new URL('src/lib/roadMatrixOptimize.js', root).href);
const { measureRoadPath } = await import(new URL('base44/shared/roadPathMeasure.js', root).href);
const { readOsrmProvider } = await import(new URL('base44/shared/osrmProvider.js', root).href);
const doors = JSON.parse(await Deno.readTextFile(String(args.route))).doors;
const baseUrl = readOsrmProvider(name => Deno.env.get(name)).baseUrl;
if (!baseUrl) throw new Error('Set OSRM_BASE_URL and OSRM_GATEWAY_KEY.');
const round = (value, places = 3) => Number.isFinite(value) ? Math.round(value * 10 ** places) / 10 ** places : null;
const measure = async order => {
    const measured = await measureRoadPath(order, { baseUrl, timeoutMs: 120000 });
    return measured.ok ? round(measured.totalMiles) : null;
};
const byHash = new Map(doors.map(door => [door.address_hash, door]));

async function runOnce() {
    log.length = 0;
    const passes = [];
    const started = performance.now();
    let firstResultMs = null;
    const client = { functions: { invoke: async (_name, body) => {
        const passStarted = performance.now();
        const response = await handler(new Request('https://benchmark.invalid/', { method: 'POST', body: JSON.stringify(body) }));
        const data = await response.json();
        const meta = data.routing_metadata || {};
        const review = meta.neighborhood_excursion_review?.local_driving_review || {};
        firstResultMs ??= performance.now() - started;
        passes.push({ pass: passes.length + 1, ms: Math.round(performance.now() - passStarted), status: response.status,
            strategy: meta.strategy || null, stage_ms: meta.optimization_timings || null,
            review: { checked: review.checked ?? null, reused: review.reused ?? null, repaired: review.repaired ?? null,
                budget_exhausted: review.budgetExhausted ?? null },
            coverage: meta.road_search_coverage ? { total: meta.road_search_coverage.total_windows,
                remaining: meta.road_search_coverage.remaining_windows } : null,
            unresolved: (meta.road_access_recovery?.unresolved || []).length, error: data.error || null });
        if (!response.ok) throw Object.assign(new Error(data.error || 'Optimize failed'), { response: { status: response.status, data } });
        return { data };
    } } };
    let outcome = null;
    const result = await tryRoadMatrixOptimize(doors, { client, maxSearchPasses: PASSES,
        onOutcome: (reason, measurement) => { outcome = { reason, meta: measurement?.routingMetadata || null }; } });
    const totalMs = performance.now() - started;
    const meta = result?.routingMetadata || outcome?.meta || {};
    const finalOrder = result?.order?.map(entry => byHash.get(entry.address_hash || entry) || entry) || doors;
    const busy = [];
    for (let t = started; t < started + totalMs; t += 100) busy.push(log.filter(e => e.startedAt <= t && e.startedAt + e.ms > t).length);
    const active = busy.filter(Boolean);
    const last = passes.at(-1) || {};
    return {
        total_ms: Math.round(totalMs), first_result_ms: Math.round(firstResultMs ?? totalMs), passes: passes.length,
        stop_reason: meta.road_search_stop_reason || null, outcome: result ? 'applied' : outcome?.reason || null,
        whole_route_verified: Boolean(result && meta.strategy && meta.strategy !== 'access_guarded_neighborhood_repair' && meta.fallback !== true),
        checks: last.coverage ? { completed: last.coverage.total - last.coverage.remaining, total: last.coverage.total } : null,
        unresolved_stops: last.unresolved ?? null,
        original_miles: await measure(doors), final_miles: await measure(finalOrder),
        reported_savings_miles: round(result?.objective?.estimatedSavings ?? null),
        osrm: { requests: log.length, peak_in_flight: Math.max(0, ...busy),
            avg_in_flight_when_busy: active.length ? round(active.reduce((a, b) => a + b, 0) / active.length, 2) : 0 },
        per_pass: passes,
    };
}

const runs = [];
for (let run = 0; run < RUNS; run += 1) {
    const result = await runOnce();
    runs.push(result);
    const { per_pass: _perPass, ...summary } = result;
    console.log(JSON.stringify(summary));
}
const median = values => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null; };
const summary = { stops: doors.length, runs: RUNS,
    total_ms: { median: median(runs.map(r => r.total_ms)), worst: Math.max(...runs.map(r => r.total_ms)) },
    first_result_ms: { median: median(runs.map(r => r.first_result_ms)), worst: Math.max(...runs.map(r => r.first_result_ms)) },
    final_miles: { median: median(runs.map(r => r.final_miles)), worst: Math.max(...runs.map(r => r.final_miles ?? 0)) },
    whole_route_verified: runs.map(r => r.whole_route_verified) };
console.log(JSON.stringify({ summary }));
if (args.out) await Deno.writeTextFile(String(args.out), JSON.stringify({ summary, runs }, null, 1));
