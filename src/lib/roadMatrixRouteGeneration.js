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
 * route exactly as the continuity optimizer produced it. Only a runaway ceiling
 * (an hour per batch) bounds the whole run.
 */

import { buildPersistedRoadRoutingMetadata } from '@/components/logic/routeRoadContext';
import { applyRoadAwareBetaToGeneratedRoutes } from '@/lib/roadAwareRoutingBeta';
import { optimizeRoutesOnRoads } from '@/lib/roadOptimizeRoutes';
import { summarizeRoadVerification } from '@/lib/routeRoadVerification';

// Each route gets the Optimize button's full search and five-minute action
// cap (see roadOptimizeRoutes.js). Generation used to stop after one pass and
// 120 s a route, so a new 1,000-stop route could ship weaker than pressing
// Optimize afterwards.

/**
 * The whole generation tail: stamp the continuity provenance each route was
 * built with, then run the road-matrix pass over the result. Both Create Route
 * and Reorder call this so neither can drift into a different optimizer.
 */
export async function buildRoadAwareGeneratedRoutes({ rawGenerated, routingContext = null, onStage, onPhase } = {}) {
    const continuityRoutes = Array.isArray(rawGenerated)
        ? rawGenerated.map((route) => (routingContext && !route.metadata?.routing?.road_aware_routing_beta
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

export async function applyRoadMatrixToGeneratedRoutes(routes, { onProgress, client } = {}) {
    const beta = await applyRoadAwareBetaToGeneratedRoutes(routes || [], { entryPoint: 'home_generation_or_reorder', onProgress, client });
    if (beta) return beta;
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
    return optimizeRoutesOnRoads(routes, { client, onProgress,
        title: routes.length > 1 ? `Optimizing ${routes.length} new routes` : 'Optimizing your new route' });
}
