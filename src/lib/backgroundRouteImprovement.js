/**
 * First result fast, finish in the background.
 *
 * One road-search pass already captures almost all of the savings (the full
 * search adds 0.04-0.9% on real routes, at about twice the time). So every
 * optimizer path saves and shows the pass-1 result right away, then lets the
 * remaining passes run in the background of the same browser tab.
 *
 * A background result is saved only when it is measurably shorter than what
 * was saved, and only onto a route nobody has touched since: same stop order,
 * status, assignee and bounds, no door knocked, and no newer optimization of
 * that route. Otherwise it is dropped and the user's changes stand. If the tab
 * closes, the passes simply stop; the pass-1 result is already saved.
 */

import { tryRoadMatrixOptimize } from '@/lib/roadMatrixOptimize';

// Less than this is measurement noise, not an improvement worth a reorder.
export const MIN_BACKGROUND_IMPROVEMENT_MILES = 0.05;
// Statuses a background improvement may still reorder.
const UNSTARTED = new Set(['PENDING', 'ACTIVE', '', undefined, null]);

const routeKey = property => property?.address_hash || property?.legacy_hash || property?.id;

/**
 * Start the full road search. `first` settles after pass 1 (or with the final
 * outcome when one pass was all there was to do); `final` settles when the
 * search ends. Both carry { result, reason, measurement }.
 */
export function optimizeFirstThenFinish(properties, { beforeBackground = null, ...options } = {}) {
    let resolveFirst, rejectFirst, firstSent = false;
    const first = new Promise((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
    let outcome = { reason: null, measurement: null };
    const final = tryRoadMatrixOptimize(properties, {
        ...options,
        onFirstResult: async value => {
            firstSent = true;
            resolveFirst({ ...value, more: true });
            // A batch holds its background passes until every route has its first result.
            if (beforeBackground) await beforeBackground();
        },
        onOutcome: (reason, measurement) => { outcome = { reason, measurement }; },
    }).then(result => {
        const value = { result, ...outcome, more: false };
        if (!firstSent) resolveFirst(value);
        return value;
    }, error => {
        if (!firstSent) rejectFirst(error);
        throw error;
    });
    // A failure after pass 1 only ends the background search.
    final.catch(() => {});
    return { first, final };
}

/**
 * How many miles the background result saves over what pass 1 saved, or 0
 * when it is not measurably shorter. Each result's savings are measured
 * against the original order within its own pass, so a change in road
 * evidence between passes (fresh curb measurements) cannot pass for a gain.
 */
export function backgroundImprovementMiles(firstResult, finalResult) {
    if (!finalResult?.objective?.applyCandidate || !Array.isArray(finalResult.order)) return 0;
    if (firstResult && finalResult.order.map(routeKey).join('|') === firstResult.order.map(routeKey).join('|')) return 0;
    const savings = result => Number(result?.objective?.estimatedSavings) || 0;
    const gain = savings(finalResult) - (firstResult ? savings(firstResult) : 0);
    return gain >= MIN_BACKGROUND_IMPROVEMENT_MILES ? Math.round(gain * 100) / 100 : 0;
}

// The newest optimization of each route. An older background search must not
// save over a newer click on the same route.
const latestRun = new Map();
let nextRun = 1;
export function claimRouteOptimization(routeId) {
    const run = nextRun++;
    if (routeId) latestRun.set(String(routeId), run);
    return run;
}
const isLatestRun = (routeId, run) => latestRun.get(String(routeId)) === run;

/** What a background save must still find on the route. */
export function routeGuardSnapshot(savedRoute, { run = null, at = Date.now() } = {}) {
    return {
        id: savedRoute?.id ? String(savedRoute.id) : null,
        hashes: [...(savedRoute?.property_hashes || [])].map(String),
        status: savedRoute?.status ?? null,
        assignedTo: savedRoute?.assigned_to ?? null,
        bounds: JSON.stringify([savedRoute?.start_location ?? null, savedRoute?.end_location ?? null, savedRoute?.route_origin_mode ?? null]),
        run,
        at,
    };
}

/** { ok, reason, route } — ok only when nothing a person did could be overwritten. */
export async function routeUnchangedSince(snapshot, client) {
    if (!snapshot?.id) return { ok: false, reason: 'not_saved' };
    if (snapshot.run !== null && !isLatestRun(snapshot.id, snapshot.run)) return { ok: false, reason: 'optimized_again' };
    let current;
    try { current = await client.entities.SavedRoute.get(snapshot.id); } catch { return { ok: false, reason: 'unreadable' }; }
    if (!current) return { ok: false, reason: 'deleted' };
    const hashes = (current.property_hashes || []).map(String);
    if (hashes.length !== snapshot.hashes.length || hashes.some((hash, i) => hash !== snapshot.hashes[i])) return { ok: false, reason: 'edited' };
    if ((current.status ?? null) !== snapshot.status || !UNSTARTED.has(current.status)) return { ok: false, reason: 'started' };
    if ((current.assigned_to ?? null) !== snapshot.assignedTo) return { ok: false, reason: 'reassigned' };
    const bounds = JSON.stringify([current.start_location ?? null, current.end_location ?? null, current.route_origin_mode ?? null]);
    if (bounds !== snapshot.bounds) return { ok: false, reason: 'edited' };
    try {
        const [latest] = await client.entities.InteractionLog.filter({ route_id: snapshot.id }, '-created_date', 1);
        if (latest && Date.parse(latest.created_date) >= snapshot.at - 1000) return { ok: false, reason: 'run' };
    } catch { return { ok: false, reason: 'unreadable' }; }
    return { ok: true, route: current };
}

/**
 * Wait for the background search, then save it through `save(finalResult,
 * currentRoute, miles)` only when it is measurably shorter and the route is
 * untouched; `quiet(finalValue, currentRoute)` may record a search that found
 * nothing shorter. Resolves to { saved, miles, reason }.
 */
export async function finishInBackground({ final, firstResult, snapshot, client, save, quiet = null }) {
    let value;
    try { value = await final; } catch { return { saved: false, reason: 'search_failed' }; }
    const miles = backgroundImprovementMiles(firstResult, value?.result);
    if (!miles) {
        // Nothing shorter: optionally record the finished search, same guard, no notice.
        if (quiet) {
            const check = await routeUnchangedSince(await snapshot, client);
            if (check.ok) await quiet(value, check.route);
        }
        return { saved: false, reason: 'no_improvement' };
    }
    const check = await routeUnchangedSince(await snapshot, client);
    if (!check.ok) return { saved: false, reason: check.reason, miles };
    await save(value.result, check.route, miles);
    return { saved: true, miles };
}

// Generated routes are optimized before they are saved. Their background
// search waits here until the flow that saved them binds the saved records
// (bindBetaGeneratedRoutes runs after every generation flow's save).
const pendingByOrder = new Map();
const PENDING_BIND_MS = 10 * 60 * 1000;
const orderKey = hashes => hashes.map(String).join('|');

/** Register a generated route's pass-1 order; returns a promise of its saved snapshot. */
export function awaitSavedGeneratedRoute(order) {
    const key = orderKey(order.map(routeKey));
    let settle;
    const saved = new Promise(resolve => { settle = resolve; });
    const timer = setTimeout(() => { pendingByOrder.delete(key); settle(null); }, PENDING_BIND_MS);
    pendingByOrder.set(key, savedRoute => { clearTimeout(timer); pendingByOrder.delete(key); settle(savedRoute); });
    return saved;
}

/** Called with the saved records of a generation flow. */
export function bindSavedGeneratedRoutes(savedRoutes) {
    for (const route of savedRoutes || []) {
        if (!route?.id || String(route.id).startsWith('local_') || !Array.isArray(route.property_hashes)) continue;
        const bind = pendingByOrder.get(orderKey(route.property_hashes));
        if (bind) bind(routeGuardSnapshot(route, { run: claimRouteOptimization(route.id) }));
    }
}
