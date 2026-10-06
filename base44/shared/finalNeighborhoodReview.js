import { reviewNeighborhoodExcursions, reviewNeighborhoodExcursionsAsync, neighborhoodStreetKey } from './neighborhoodExcursions.js';
import { createVehicleRoutingContext } from './vehicleRouting.js';

// This runs on the final assembled order, including seams between optimization
// windows. Labels flag a review; snapped directed road costs decide the move.
export async function reviewFinalNeighborhoodRoute(order, options = {}) {
    const initial = reviewNeighborhoodExcursions(order, options);
    if (!initial.diagnostics.detected) return { ...initial, diagnostics: { ...initial.diagnostics, status: 'checked' } };
    try {
        const context = await createVehicleRoutingContext(order, {
            accessFor: () => null, streetSegmentKey: neighborhoodStreetKey,
        }, { ...options, sparseCosts: true, maxGeometryPoints: 100000,
            servicePolicy: { enabled: false, parkingSecondsPerStop: 0 } });
        const reviewed = await reviewNeighborhoodExcursionsAsync(order, { ...options, roadVerified: true,
            maxEvaluations: options.maxEvaluations ?? 1000,
            costBetween: context.optimizationCostBetween, prepareCosts: context.prepareCosts });
        if (!reviewed.diagnostics.relocated) return reviewed;
        // /table suggests a placement. /route checks the complete trip, including
        // turn continuity at intermediate stops and both personal boundaries.
        const [before, after, baseline] = await Promise.all([
            context.routeSequence(order, options), context.routeSequence(reviewed.properties, options),
            options.baselineOrder ? context.routeSequence(options.baselineOrder, options) : null,
        ]);
        const tolerance = options.preferContiguousOnTie === true ? Math.min(10, Math.max(0, Number(options.tieSeconds) || 0)) : 0;
        const betterTime = after.driveSeconds < before.driveSeconds - 1e-7
            || (options.preferContiguousOnTie === true && after.driveSeconds <= before.driveSeconds + tolerance);
        const accept = betterTime && after.distanceMiles <= before.distanceMiles
            && (!baseline || (after.driveSeconds <= baseline.driveSeconds + tolerance && after.distanceMiles <= baseline.distanceMiles));
        return { properties: accept ? reviewed.properties : order,
            diagnostics: { ...reviewed.diagnostics, status: accept ? reviewed.diagnostics.status : 'whole_route_guard_retained',
                applied: accept, secondsSaved: accept ? before.driveSeconds - after.driveSeconds : 0,
                remaining: accept ? reviewed.diagnostics.remaining : initial.diagnostics.remaining },
            measurement: accept ? after : before, baseline };
    } catch (error) {
        if (error?.name === 'AbortError' || /membership|locked stop|graph identity|cancelled/i.test(error?.message || '')) throw error;
        return { properties: order, diagnostics: { ...initial.diagnostics, reason: error.message } };
    }
}
