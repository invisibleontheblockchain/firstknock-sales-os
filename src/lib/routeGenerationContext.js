import {
    createRouteContinuityContext,
    createRouteRoadContext,
} from '@/components/logic/routeRoadContext';
import { isValidRoutePoint } from '@/lib/routeBounds';
import { requireUsableRouteContext } from '@/lib/routeContextGuard';

// Create Route loads the real road network for door sets this size or smaller, so
// the FIRST route a user receives is already ordered by real driving distance and
// no second Optimize press is needed. Above this the road context can only price
// whole streets by a single representative door, which is a weaker order than the
// street sweep it would replace, so generation keeps the instant local path.
export const ROAD_AWARE_GENERATION_MAX_DOORS = 500;

// Above this door count route generation runs in the background worker, which has
// no routing context of its own.
export const SYNCHRONOUS_CONTEXT_MAX_DOORS = 5000;

/**
 * The routing context every route generation run is built with.
 *
 * Road-aware is the default. createRouteRoadContext degrades to the synchronous
 * continuity context on every failure path (offline, rate-limited road source, no
 * routable roads, point limits), so a road outage still produces exactly the
 * previous route instead of an error. The mode that was actually used is recorded
 * on each route through buildPersistedRoadRoutingMetadata.
 */
export async function createRouteGenerationContext(
    properties,
    { start = null, end = null, onRoadLoadStart = null } = {},
) {
    const doorCount = Array.isArray(properties) ? properties.length : 0;
    if (doorCount > SYNCHRONOUS_CONTEXT_MAX_DOORS) return null;

    if (doorCount >= 2 && doorCount <= ROAD_AWARE_GENERATION_MAX_DOORS) {
        onRoadLoadStart?.(doorCount);
        const roadContext = await createRouteRoadContext(properties, {
            startLocation: isValidRoutePoint(start) ? start : null,
            endLocation: isValidRoutePoint(end) ? end : null,
        });
        requireUsableRouteContext(roadContext);
        return roadContext;
    }

    const continuityContext = createRouteContinuityContext(properties);
    requireUsableRouteContext(continuityContext);
    return continuityContext;
}