// Live end-to-end benchmark of the real optimizeRouteRoadMatrix handler against
// the configured OSRM engine. Speed changes must not change the answer: every
// run records a quality fingerprint (final order, measured miles and minutes,
// review work) and --compare fails when any route's result differs.
//
//   deno run --import-map=scripts/benchmark-optimize-live/import_map.json \
//     --allow-net --allow-env --allow-read --allow-write \
//     scripts/benchmark-optimize-live.mjs --out after.json [--compare before.json] [--runs 2]
//
// Needs OSRM_BASE_URL and OSRM_GATEWAY_KEY in the environment. Routes are
// contiguous 377-door slices of the frozen Charlotte fixtures in continuity
// order, i.e. a realistic saved route, not a shuffled one.
const args = {};
for (let i = 0; i < Deno.args.length; i += 1) {
    if (Deno.args[i].startsWith('--')) args[Deno.args[i].slice(2)] = Deno.args[i + 1]?.startsWith('--') ? true : Deno.args[++i] ?? true;
}
const root = new URL('../', import.meta.url);
const ROUTES = [
    { name: '1I-300', fixture: 'charlotte-route-1i-barrier-1000.json', start: 300 },
    { name: '1I-600', fixture: 'charlotte-route-1i-barrier-1000.json', start: 600 },
    { name: '1J-0', fixture: 'charlotte-route-1j-generalization-1000.json', start: 0 },
].filter(route => !args.route || route.name === args.route);
const COUNT = Number(args.count) || 377;
const RUNS = Math.max(1, Number(args.runs) || 1);

const log = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const match = url.pathname.match(/\/(table|route|nearest)\/v1\/[^/]+\/(.+)$/);
    const startedAt = performance.now();
    const response = await realFetch(input, init);
    const bytes = (await response.clone().arrayBuffer()).byteLength;
    log.push({ service: match?.[1] || 'other', steps: url.searchParams.get('steps') === 'true',
        startedAt, ms: performance.now() - startedAt, bytes });
    return response;
};

const handler = (await import(new URL('base44/functions/optimizeRouteRoadMatrix/entry.ts', root).href)).default;
const { createContinuityOptimizer, haversineMiles, routePropertyOrderFingerprint } =
    await import(new URL('base44/shared/routeContinuityOptimizer.js', root).href);

async function runOnce(route) {
    const all = JSON.parse(await Deno.readTextFile(new URL(`test/fixtures/${route.fixture}`, root))).doors;
    const ordered = createContinuityOptimizer(haversineMiles).buildRouteChunks(all, all.length, null, null)
        .doorChunks.flat().map(door => door.property);
    const doors = ordered.slice(route.start, route.start + COUNT);
    log.length = 0;
    const started = performance.now();
    const response = await handler(new Request('https://benchmark.invalid/', { method: 'POST',
        body: JSON.stringify({ properties: doors, profile: 'driving' }) }));
    const totalMs = performance.now() - started;
    const body = await response.json();
    const meta = body.routing_metadata || {};
    const review = meta.neighborhood_excursion_review?.local_driving_review || {};
    let busy = 0, inFlight = 0;
    for (let t = started; t < started + totalMs; t += 50) {
        const n = log.filter(e => e.startedAt <= t && e.startedAt + e.ms > t).length;
        if (n) { busy += 1; inFlight += n; }
    }
    const round = value => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
    return {
        route: route.name,
        quality: {
            status: response.status, error: body.error || null, selected: body.selected || null,
            strategy: meta.strategy || null,
            order_fingerprint: Array.isArray(body.order) ? routePropertyOrderFingerprint(body.order) : null,
            winning_miles: round(meta.winning_route_distance ?? meta.validated_road_miles ?? null),
            winning_minutes: round(meta.winning_route_duration ?? null),
            review: { planned: review.planned ?? null, checked: review.checked ?? null, repaired: review.repaired ?? null,
                candidatesMeasured: review.candidatesMeasured ?? null, budgetExhausted: review.budgetExhausted ?? null,
                miles_saved: round(review.localMilesSaved), seconds_saved: round(review.localSecondsSaved) },
        },
        speed: {
            total_ms: Math.round(totalMs),
            review_ms: meta.optimization_timings?.neighborhood_review_ms ?? null,
            review_timings: review.timings || null,
            requests: log.length,
            route_steps_requests: log.filter(e => e.service === 'route' && e.steps).length,
            table_requests: log.filter(e => e.service === 'table').length,
            megabytes: Math.round(log.reduce((sum, e) => sum + e.bytes, 0) / 1e4) / 100,
            avg_in_flight_when_busy: busy ? Math.round(inFlight / busy * 100) / 100 : 0,
        },
    };
}

const results = [];
for (const route of ROUTES) for (let run = 0; run < RUNS; run += 1) {
    const result = await runOnce(route);
    results.push(result);
    console.log(JSON.stringify({ route: result.route, status: result.quality.status, selected: result.quality.selected,
        miles: result.quality.winning_miles, ...result.speed, review_timings: undefined }));
}
if (args.out) await Deno.writeTextFile(String(args.out), JSON.stringify({ count: COUNT, runs: RUNS, results }, null, 1));

if (args.compare) {
    const before = JSON.parse(await Deno.readTextFile(String(args.compare))).results;
    const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
    let identical = true;
    for (const route of ROUTES) {
        const a = before.filter(r => r.route === route.name), b = results.filter(r => r.route === route.name);
        const same = a.length > 0 && b.length > 0 && b.every(r => JSON.stringify(r.quality) === JSON.stringify(a[0].quality));
        identical &&= same;
        const ta = median(a.map(r => r.speed.total_ms)), tb = median(b.map(r => r.speed.total_ms));
        console.log(JSON.stringify({ route: route.name, identical_result: same, before_ms: ta, after_ms: tb,
            reduction_percent: Math.round((1 - tb / ta) * 1000) / 10,
            before_requests: a[0]?.speed.requests, after_requests: b[0]?.speed.requests,
            before_mb: a[0]?.speed.megabytes, after_mb: b[0]?.speed.megabytes }));
        if (!same) console.log(JSON.stringify({ route: route.name, before: a[0]?.quality, after: b[0]?.quality }));
    }
    if (!identical) { console.error('Route results changed: this is not a pure speed-up.'); Deno.exit(1); }
}
