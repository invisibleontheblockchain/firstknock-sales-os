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
 * Every failure path — timeout, rate limit, unsnapped door, >100 doors, no
 * improvement, backend unavailable — leaves that route exactly as the continuity
 * optimizer produced it. A whole-run time budget stops the pass from holding the
 * generation overlay open when the routing engine is slow.
 */

import { buildPersistedRoadRoutingMetadata } from '@/components/logic/routeRoadContext';
import { isValidRoutePoint } from '@/lib/routeBounds';
import { tryRoadMatrixOptimize } from '@/lib/roadMatrixOptimize';

const ROAD_MATRIX_RUN_BUDGET_MS = 30000;

/**
 * The whole generation tail: stamp the continuity provenance each route was
 * built with, then run the road-matrix pass over the result. Both Create Route
 * and Reorder call this so neither can drift into a different optimizer.
 */
export async function buildRoadAwareGeneratedRoutes({ rawGenerated, routingContext = null, onStage } = {}) {
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

    onStage?.('Checking real road distances...');
    return applyRoadMatrixToGeneratedRoutes(continuityRoutes, {
        onProgress: ({ index, total }) => onStage?.(total > 1
            ? `Checking real road distances (${index}/${total})...`
            : 'Checking real road distances...')
    });
}

export async function applyRoadMatrixToGeneratedRoutes(routes, { onProgress } = {}) {
    if (!Array.isArray(routes) || routes.length === 0) {
        return { routes, appliedCount: 0, savedMiles: 0, skippedForBudget: 0 };
    }

    const startedAt = Date.now();
    const out = [];
    let appliedCount = 0;
    let savedMiles = 0;
    let skippedForBudget = 0;

    for (let index = 0; index < routes.length; index += 1) {
        const route = routes[index];
        const properties = route?.properties;
        if (!Array.isArray(properties) || properties.length < 2) {
            out.push(route);
            continue;
        }
        if (Date.now() - startedAt > ROAD_MATRIX_RUN_BUDGET_MS) {
            skippedForBudget += 1;
            out.push(route);
            continue;
        }

        onProgress?.({ index: index + 1, total: routes.length });
        const result = await tryRoadMatrixOptimize(properties, {
            start: isValidRoutePoint(route.startLocation) ? route.startLocation : null,
            end: isValidRoutePoint(route.endLocation) ? route.endLocation : null
        });
        if (!result) {
            out.push(route);
            continue;
        }

        appliedCount += 1;
        savedMiles += result.objective.estimatedSavings;
        out.push({
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
        });
    }

    return {
        routes: out,
        appliedCount,
        savedMiles: Math.round(savedMiles * 100) / 100,
        skippedForBudget
    };
}