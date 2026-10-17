/**
 * Send every route of a generation, split, merge, ZIP, campaign, import or
 * territory-wizard result through the SAME real-road optimizer as the Optimize
 * button (`tryRoadMatrixOptimize`: all passes, approximate access, cached
 * failures). A route adopts the road order only when the backend measured it
 * strictly shorter on the shared road matrix; otherwise it keeps its order and
 * says why.
 *
 * Routes run a few at a time, within the road server's real capacity, and
 * report live progress per route to the progress screen.
 */

import { tryRoadMatrixOptimize } from '@/lib/roadMatrixOptimize';
import { isValidRoutePoint } from '@/lib/routeBounds';
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
            let declineReason = null;
            let roadMeasurement = null;
            const end = endOf(route);
            const result = await tryRoadMatrixOptimize(properties, {
                client,
                start: isValidRoutePoint(route.startLocation) ? route.startLocation : null,
                end: isValidRoutePoint(end) ? end : null,
                onSearchProgress: value => job.progress(index, value),
                onOutcome: (reason, measurement) => { declineReason = reason; roadMeasurement = measurement; }
            });
            if (!result) {
                // Measured and found nothing shorter: verified, order kept.
                // Any other decline leaves the order unverified and says so.
                const outcome = verdictForOutcome({ doorCount: properties.length, declineReason });
                const confirmed = outcome.verdict === ROAD_VERIFICATION.CONFIRMED && roadMeasurement ? {
                    ...route, totalDistance: roadMeasurement.distanceMiles,
                    metadata: { ...route.metadata, ...roadMeasurement.routingMetadata },
                } : route;
                job.finishRoute(index, outcome.verdict === ROAD_VERIFICATION.CONFIRMED ? 'kept' : 'failed');
                return { unverified: outcome.verdict !== ROAD_VERIFICATION.CONFIRMED,
                    route: stampRoadVerification(confirmed, outcome.verdict, {
                        reason: outcome.reason, measuredMiles: roadMeasurement?.distanceMiles }) };
            }
            const saved = Number(result.objective.estimatedSavings) || 0;
            job.finishRoute(index, 'improved', { savedMiles: saved });
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
            unverifiedMessage: describeUnverifiedRoutes(routesOut)
        };
    } finally {
        job?.finish();
    }
}
