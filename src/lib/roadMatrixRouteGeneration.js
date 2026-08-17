/**
 * Road-aware by default for INITIAL route generation.
 *
 * Create Route builds the continuity candidate locally (unchanged), then each
 * generated route is re-priced through the SAME backend OSRM pipeline the
 * Optimize button uses (`optimizeRouteRoadMatrix`). The road-aware order is
 * adopted only when the backend measured it strictly better than the generated
 * order on one shared road matrix, so the user no longer has to generate a
 * weaker route and press Optimize afterwards.
 *
 * Every failure path — timeout, rate limit, unsnapped door, a route beyond the
 * supported optimization size, no improvement, backend unavailable — leaves that
 * route exactly as the continuity optimizer produced it. A whole-run time budget
 * stops the pass from holding the generation overlay open when the routing engine
 * is slow.
 */

import { buildPersistedRoadRoutingMetadata } from '@/components/logic/routeRoadContext';
import { isValidRoutePoint } from '@/lib/routeBounds';
import { tryRoadMatrixOptimize } from '@/lib/roadMatrixOptimize';
import {
    describeUnverifiedRoutes,
    ROAD_VERIFICATION,
    stampRoadVerification,
    summarizeRoadVerification,
    verdictForOutcome
} from '@/lib/routeRoadVerification';

// How long ONE route's road pass is allowed to take, and how long a whole
// generation may spend on road passes in total.
//
// These were previously a single flat 60s budget for the WHOLE run, sized on an
// assumption that one route takes ~15s. Measured on a real 1,000-door Charlotte
// route (`scripts/route-1h-solver-bench.mjs`, `scripts/route-1h-deadline-probe.mjs`):
// sequencing 28.3s + the backend's dual road measurement 3.9s = ~32s per route.
//
// At 32s a route, a 60s whole-run budget optimizes the first two routes of a
// batch and silently skips every route after them — they keep the straight-line
// continuity order they were generated with. That is how Charlotte Precision
// Route 1H shipped at 627.6 measured road miles while the same doors, through
// the same solver, measure 428.3. The skip was never surfaced anywhere, so the
// route was labelled generated and looked no different from an optimized one.
//
// The per-route budget therefore has to clear the measured cost with headroom
// for a slow road engine, and the run ceiling has to scale with how many routes
// were actually generated rather than capping the batch at two.
const ROAD_MATRIX_PER_ROUTE_BUDGET_MS = 90000;
const ROAD_MATRIX_RUN_CEILING_MS = 20 * 60 * 1000;

/**
 * The whole generation tail: stamp the continuity provenance each route was
 * built with, then run the road-matrix pass over the result. Both Create Route
 * and Reorder call this so neither can drift into a different optimizer.
 */
export async function buildRoadAwareGeneratedRoutes({ rawGenerated, routingContext = null, onStage, onPhase } = {}) {
    const continuityRoutes = Array.isArray(rawGenerated)
        ? rawGenerated.map((route) => (routingContext
            ? {
                ...route,
                metadata: {
                    ...(route.metadata || {}),
                    ...buildPersistedRoadRoutingMetadata(routingContext, null, route.properties)
                }
            }
            : route))
        : rawGenerated;

    // One road-optimization call per route covers street ordering, boundary and
    // transition refinement, and the independent final measurement, so the phase
    // reported here is the one the work is actually inside.
    onPhase?.('verify');
    onStage?.('Verifying real road mileage...');
    return applyRoadMatrixToGeneratedRoutes(continuityRoutes, {
        onProgress: ({ index, total }) => onStage?.(total > 1
            ? `Verifying route ${index} of ${total} on real roads...`
            : 'Verifying real road mileage...')
    });
}

export async function applyRoadMatrixToGeneratedRoutes(routes, { onProgress } = {}) {
    if (!Array.isArray(routes) || routes.length === 0) {
        return {
            routes,
            appliedCount: 0,
            savedMiles: 0,
            skippedForBudget: 0,
            unverifiedCount: 0,
            verification: summarizeRoadVerification([]),
            unverifiedMessage: null
        };
    }

    const startedAt = Date.now();
    const out = [];
    let appliedCount = 0;
    let savedMiles = 0;
    let skippedForBudget = 0;
    let unverifiedCount = 0;

    for (let index = 0; index < routes.length; index += 1) {
        const route = routes[index];
        const properties = route?.properties;
        if (!Array.isArray(properties) || properties.length < 2) {
            const outcome = verdictForOutcome({ doorCount: properties?.length ?? 0 });
            out.push(stampRoadVerification(route, outcome.verdict, { reason: outcome.reason }));
            continue;
        }
        // The ceiling exists so a dead road engine cannot hold generation open
        // forever. It must never be the reason a route ships unoptimized while
        // the engine is healthy, so it is sized for the whole batch rather than
        // spent by the first two routes.
        const runCeiling = Math.min(
            ROAD_MATRIX_RUN_CEILING_MS,
            routes.length * ROAD_MATRIX_PER_ROUTE_BUDGET_MS
        );
        if (Date.now() - startedAt > runCeiling) {
            skippedForBudget += 1;
            unverifiedCount += 1;
            // A skipped route keeps its straight-line order. Say so on the route
            // itself: an unoptimized route that looks identical to an optimized
            // one is how a 628-mile route passed for a generated route.
            const outcome = verdictForOutcome({ doorCount: properties.length, ceilingExceeded: true });
            out.push(stampRoadVerification(route, outcome.verdict, {
                reason: `${outcome.reason} (${Math.round(runCeiling / 1000)}s) before route ${index + 1} of ${routes.length}`
            }));
            continue;
        }

        onProgress?.({ index: index + 1, total: routes.length });
        let declineReason = null;
        const result = await tryRoadMatrixOptimize(properties, {
            start: isValidRoutePoint(route.startLocation) ? route.startLocation : null,
            end: isValidRoutePoint(route.endLocation) ? route.endLocation : null,
            deadlineMs: ROAD_MATRIX_PER_ROUTE_BUDGET_MS,
            onOutcome: (reason) => { declineReason = reason; }
        });
        if (!result) {
            // The road engine having measured the generated order and found
            // nothing better is a VERIFIED outcome, not a failure — the order is
            // confirmed on real roads. Every other decline leaves the route
            // straight-line ordered and unverified, and must say so.
            const outcome = verdictForOutcome({ doorCount: properties.length, declineReason });
            out.push(stampRoadVerification(route, outcome.verdict, { reason: outcome.reason }));
            if (outcome.verdict !== ROAD_VERIFICATION.CONFIRMED) unverifiedCount += 1;
            continue;
        }

        appliedCount += 1;
        savedMiles += result.objective.estimatedSavings;
        out.push(stampRoadVerification({
            ...route,
            properties: result.order,
            totalDistance: Math.round(result.objective.appliedDistance * 100) / 100,
            metadata: {
                ...(route.metadata || {}),
                // Spread last so the OSRM provenance (including the `routing`
                // block) replaces the aerial continuity metadata rather than
                // sitting beside it and contradicting it.
                ...result.routingMetadata
            }
        }, ROAD_VERIFICATION.ADOPTED, {
            measuredMiles: result.objective.appliedDistance,
            savedMiles: result.objective.estimatedSavings
        }));
    }

    const verification = summarizeRoadVerification(out);
    // Loud, because silence is what let this ship. A run that could not verify
    // some of its routes is a materially different run from a clean one, and the
    // previous return values said so only in counters nobody read.
    if (verification.unverified > 0) {
        console.warn(
            `[roadMatrixRouteGeneration] ${verification.unverified} of ${verification.total} routes are NOT road-verified`,
            verification.byVerdict
        );
    }

    return {
        routes: out,
        appliedCount,
        savedMiles: Math.round(savedMiles * 100) / 100,
        skippedForBudget,
        unverifiedCount,
        verification,
        // Null when everything verified, so a caller can surface it unconditionally.
        unverifiedMessage: describeUnverifiedRoutes(out)
    };
}