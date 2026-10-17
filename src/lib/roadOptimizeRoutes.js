/**
 * Send every route of a generation, split, merge, ZIP, campaign, import or
 * territory-wizard result through the SAME real-road optimizer as the Optimize
 * button (`tryRoadMatrixOptimize`: all passes, approximate access, cached
 * failures). A route adopts the road order only when the backend measured it
 * strictly shorter on the shared road matrix; otherwise it keeps its order and
 * says why.
 *
 * First result fast: every route's first pass runs (a few at a time, within
 * the road server's real capacity) and is returned for saving. The remaining
 * passes then run in the background; a route's shorter order is saved once
 * the flow has saved the route and only if nobody has touched it since.
 */

import { toast } from 'sonner';
import { isValidRoutePoint } from '@/lib/routeBounds';
import {
    awaitSavedGeneratedRoute,
    finishInBackground,
    optimizeFirstThenFinish
} from '@/lib/backgroundRouteImprovement';
import { queryClientInstance } from '@/lib/query-client';
import { runWithConcurrency, startRoadOptimizationJob } from '@/lib/roadOptimizationProgress';
import {
    describeUnverifiedRoutes,
    ROAD_VERIFICATION,
    stampRoadVerification,
    summarizeRoadVerification,
    verdictForOutcome
} from '@/lib/routeRoadVerification';

// Routes optimized at once. One 1,000-stop route keeps on average 4-5 of the
// gateway's 16 request slots busy (peaks at 16), so three routes fill the
// gateway without queueing behind each other for long.
export const ROUTE_OPTIMIZE_CONCURRENCY = 3;
// Runaway ceiling for a whole batch: a dead road engine cannot hold a batch
// open forever. Each route also has the Optimize action's own five-minute cap.
const RUN_CEILING_MS = 60 * 60 * 1000;

const endOf = route => (route.returnToFirstStop ? route.properties?.[0] : route.endLocation);
const routeKey = property => property?.address_hash || property?.legacy_hash || property?.id;

/** At most `count` background searches at once, starting only after `open()`. */
function backgroundSlots(count) {
    let free = count;
    const waiting = [];
    let openGate;
    const gate = new Promise(resolve => { openGate = resolve; });
    return {
        open: () => openGate(),
        acquire: async () => {
            await gate;
            if (free > 0) { free -= 1; return; }
            await new Promise(resolve => waiting.push(resolve));
        },
        release: () => {
            const next = waiting.shift();
            if (next) next(); else free += 1;
        },
    };
}

/** The saved route update for a shorter background order. */
function backgroundRouteUpdate(current, finalResult, miles) {
    const applied = Number.isFinite(finalResult.objective.appliedDistance)
        ? Math.round(finalResult.objective.appliedDistance * 100) / 100 : null;
    return {
        property_hashes: finalResult.order.map(routeKey),
        metrics: { ...(current.metrics || {}), ...(applied !== null ? { distance: applied } : {}) },
        metadata: stampRoadVerification({ metadata: { ...(current.metadata || {}), ...finalResult.routingMetadata } },
            applied !== null ? ROAD_VERIFICATION.ADOPTED : ROAD_VERIFICATION.PARTIAL, {
                ...(applied === null ? { reason: 'verified_neighborhoods_only' } : {}),
                measuredMiles: applied, savedMiles: miles,
            }).metadata,
    };
}

async function settleBackgrounds(backgrounds, job) {
    const results = await Promise.all(backgrounds);
    job?.finish();
    const improved = results.filter(item => item?.saved);
    const miles = Math.round(improved.reduce((sum, item) => sum + item.miles, 0) * 100) / 100;
    if (improved.length) {
        await Promise.allSettled(['savedRoutes', 'myRoutes'].map(root => queryClientInstance.invalidateQueries({ queryKey: [root] })));
        toast.success(improved.length === 1
            ? `Route improved by ${miles} mi while you worked.`
            : `${improved.length} routes improved by ${miles} mi while you worked.`, { duration: 6000 });
    }
    return { improved: improved.length, miles };
}

export async function optimizeRoutesOnRoads(routes, {
    client, title, onProgress, concurrency = ROUTE_OPTIMIZE_CONCURRENCY, background = false
} = {}) {
    const list = Array.isArray(routes) ? routes : [];
    const startedAt = Date.now();
    let started = 0;
    const job = list.length ? startRoadOptimizationJob({
        title, concurrency, background,
        routes: list.map((route, index) => ({ name: route.name || (list.length > 1 ? `Route ${index + 1}` : null),
            stops: route.properties?.length || 0 })),
    }) : null;
    let ceilingHit = false;
    const slots = backgroundSlots(concurrency);
    const backgrounds = [];
    let firstResultsDone = false;

    try {
        const out = await runWithConcurrency(list, concurrency, async (route, index) => {
            const properties = route?.properties;
            if (!Array.isArray(properties) || properties.length < 2) {
                const outcome = verdictForOutcome({ doorCount: properties?.length ?? 0 });
                job.finishRoute(index, 'kept');
                return { route: stampRoadVerification(route, outcome.verdict, { reason: outcome.reason }) };
            }
            if (Date.now() - startedAt > RUN_CEILING_MS) {
                ceilingHit = true;
                const outcome = verdictForOutcome({ doorCount: properties.length, ceilingExceeded: true });
                job.finishRoute(index, 'failed');
                return { skipped: true, route: stampRoadVerification(route, outcome.verdict, {
                    reason: `${outcome.reason} (${Math.round(RUN_CEILING_MS / 60000)} min) before route ${index + 1} of ${list.length}` }) };
            }
            started += 1;
            onProgress?.({ index: started, total: list.length });
            job.startRoute(index);
            const end = endOf(route);
            let holdsSlot = false;
            const search = optimizeFirstThenFinish(properties, {
                client,
                start: isValidRoutePoint(route.startLocation) ? route.startLocation : null,
                end: isValidRoutePoint(end) ? end : null,
                onSearchProgress: value => job.progress(index, value),
                // Every route's first result comes before any background pass.
                beforeBackground: async () => { await slots.acquire(); holdsSlot = true; },
            });
            const { result, reason: declineReason, measurement: roadMeasurement, more } = await search.first;
            if (more) {
                // The flow binds the saved record after its save; a shorter
                // order is written only onto an untouched route.
                backgrounds.push(finishInBackground({
                    final: search.final, firstResult: result, client,
                    snapshot: awaitSavedGeneratedRoute(result?.order || properties),
                    save: async (finalResult, current, miles) => {
                        await client.entities.SavedRoute.update(current.id, backgroundRouteUpdate(current, finalResult, miles));
                    },
                }).catch(() => ({ saved: false })).then(value => {
                    if (holdsSlot) slots.release();
                    job.finishRoute(index, value?.saved || result ? 'improved' : 'kept',
                        value?.saved ? { savedMiles: (Number(result?.objective.estimatedSavings) || 0) + value.miles } : {});
                    return value;
                }));
            }
            if (!result) {
                // Measured and found nothing shorter: verified, order kept.
                // Any other decline leaves the order unverified and says so.
                const outcome = verdictForOutcome({ doorCount: properties.length, declineReason });
                const confirmed = outcome.verdict === ROAD_VERIFICATION.CONFIRMED && roadMeasurement ? {
                    ...route, totalDistance: roadMeasurement.distanceMiles,
                    metadata: { ...route.metadata, ...roadMeasurement.routingMetadata },
                } : route;
                if (!more) job.finishRoute(index, outcome.verdict === ROAD_VERIFICATION.CONFIRMED ? 'kept' : 'failed');
                return { unverified: outcome.verdict !== ROAD_VERIFICATION.CONFIRMED,
                    route: stampRoadVerification(confirmed, outcome.verdict, {
                        reason: outcome.reason, measuredMiles: roadMeasurement?.distanceMiles }) };
            }
            const saved = Number(result.objective.estimatedSavings) || 0;
            if (!more) job.finishRoute(index, 'improved', { savedMiles: saved });
            const appliedDistance = Number.isFinite(result.objective.appliedDistance)
                ? Math.round(result.objective.appliedDistance * 100) / 100 : route.totalDistance;
            return { applied: true, saved, route: stampRoadVerification({
                ...route,
                properties: result.order,
                totalDistance: appliedDistance,
                // Spread last so the road provenance replaces the aerial
                // continuity metadata instead of contradicting it.
                metadata: { ...(route.metadata || {}), ...result.routingMetadata }
            }, ROAD_VERIFICATION.ADOPTED, { measuredMiles: result.objective.appliedDistance, savedMiles: saved }) };
        });
        firstResultsDone = true;

        const routesOut = out.map(item => item.route);
        const verification = summarizeRoadVerification(routesOut);
        if (verification.unverified > 0) {
            console.warn(`[roadOptimizeRoutes] ${verification.unverified} of ${verification.total} routes are NOT road-verified`,
                verification.byVerdict);
        }
        return {
            routes: routesOut,
            appliedCount: out.filter(item => item.applied).length,
            savedMiles: Math.round(out.reduce((sum, item) => sum + (item.saved || 0), 0) * 100) / 100,
            skippedForBudget: out.filter(item => item.skipped).length,
            unverifiedCount: out.filter(item => item.unverified || item.skipped).length,
            ceilingHit,
            verification,
            unverifiedMessage: describeUnverifiedRoutes(routesOut),
            // Settles when the background passes end (they save on their own).
            backgroundDone: backgrounds.length ? settleBackgrounds(backgrounds, job) : Promise.resolve({ improved: 0, miles: 0 }),
        };
    } finally {
        // Every first result is in (or the batch failed): background passes may start.
        slots.open();
        if (!firstResultsDone || !backgrounds.length) job?.finish();
        else job?.finishInBackground();
    }
}
