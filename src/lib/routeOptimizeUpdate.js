/**
 * Pure helpers behind the Optimize menu.
 *
 * These are extracted so identity resolution, anchor clearing, the SavedRoute
 * update payload and the baseline/candidate comparison can be executed in tests
 * rather than asserted against source text. A regex over a file cannot tell you
 * whether a coordinate actually reaches the payload.
 */

import { OPTIMIZE_MODES, routeOriginModeForOptimizeMode } from './routeOriginModes';

// Custom ANCHORS live in their own module (their coordinates ARE persisted), and
// are re-exported here so callers keep a single route-update import.
export { buildRouteAnchorsUpdate, normalizeRouteAnchor } from './routeAnchors';

const normalizedEmail = (value) => String(value || '').trim().toLowerCase();

/**
 * Does this route belong to the person currently holding the device?
 *
 * `assigned_to` may hold either a User id or a TeamMember entity id, and a
 * TeamMember links back by `user_id` or by email. Comparing only against
 * `user.id` denies the real assignee whenever the route stored a TeamMember id
 * — which is exactly the rep this feature exists for.
 */
export function routeBelongsToActingUser(route, user, teamMembers = []) {
    if (!route) return false;
    if (!route.assigned_to) return true; // unassigned routes stay with the acting user
    if (!user?.id) return false;

    if (route.assigned_to === user.id) return true;

    const members = Array.isArray(teamMembers) ? teamMembers : [];
    const assignedMember = members.find(
        (member) => member?.id === route.assigned_to || member?.user_id === route.assigned_to
    );
    if (!assignedMember) return false;

    if (assignedMember.user_id && assignedMember.user_id === user.id) return true;

    const memberEmail = normalizedEmail(assignedMember.email);
    return Boolean(memberEmail) && memberEmail === normalizedEmail(user.email);
}

/** Straight-line miles for an ordered set of stops, plus optional external legs. */
export function boundedRouteDistance(order, { start = null, end = null, distanceFn } = {}) {
    const stops = Array.isArray(order) ? order.filter(Boolean) : [];
    if (stops.length === 0) return 0;

    let total = 0;
    if (start) total += distanceFn(start, stops[0]);
    for (let i = 0; i < stops.length - 1; i += 1) total += distanceFn(stops[i], stops[i + 1]);
    if (end) total += distanceFn(stops[stops.length - 1], end);
    return total;
}

const EPSILON_MILES = 1e-9;

/**
 * Compares the CURRENT order and the CANDIDATE order under the SAME anchors.
 *
 * Comparing a stored metric from a previous mode against a new mode's objective
 * reports the difference between two anchors as optimizer savings — a route
 * re-anchored from a distant Home Base to a nearby car would claim miles saved
 * without a single door being reordered. Both sides must use one objective.
 */
export function compareRouteObjective({ currentOrder, candidateOrder, start = null, end = null, distanceFn }) {
    const baselineDistance = boundedRouteDistance(currentOrder, { start, end, distanceFn });
    const candidateDistance = boundedRouteDistance(candidateOrder, { start, end, distanceFn });

    // Ties keep the candidate: it is the freshly optimized order under the
    // anchors the user just chose, and keeping it avoids a confusing no-op.
    const applyCandidate = candidateDistance <= baselineDistance + EPSILON_MILES;
    const appliedDistance = applyCandidate ? candidateDistance : baselineDistance;

    return {
        baselineDistance,
        candidateDistance,
        applyCandidate,
        appliedDistance,
        estimatedSavings: Math.max(0, baselineDistance - appliedDistance)
    };
}

/**
 * The SavedRoute update payload.
 *
 * `SavedRoute.start_location` / `end_location` are documented as
 * "Optional non-personal fixed trip start… Personal home/current coordinates
 * must not be stored on shared routes."
 *
 * So neither a Home Base nor a parked-car coordinate is ever written here. The
 * mode and non-coordinate provenance are persisted; the exact point stays in
 * in-memory session state. Defining cross-device storage for a precise personal
 * location is a deliberate contract, not a side effect of this feature.
 */
export function buildRouteOptimizeUpdate({
    optimizeMode,
    order,
    distanceMiles,
    existingMetrics = {},
    existingMetadata = {},
    routingMetadata = {},
    carCapture = null
}) {
    const routeOriginMode = routeOriginModeForOptimizeMode(optimizeMode);
    const metadata = { ...existingMetadata, ...routingMetadata };
    delete metadata.road_geometry;

    if (optimizeMode === OPTIMIZE_MODES.ROUTE_ONLY) {
        // Always clear, whatever the previous mode was — including car_round_trip
        // and a legacy `none` that still carried a stale start_location.
        metadata.route_bounds = { enabled: false, cleared_reason: 'optimized_route_only' };
    } else if (optimizeMode === OPTIMIZE_MODES.CAR_ROUND_TRIP) {
        metadata.route_bounds = {
            enabled: true,
            mode: 'car_round_trip',
            start_source: 'gps_snapshot',
            accuracy_m: carCapture?.accuracy_m ?? null,
            captured_at: carCapture?.captured_at ?? null
        };
    } else {
        metadata.route_bounds = { enabled: true, mode: routeOriginMode };
    }

    return {
        property_hashes: order,
        metrics: { ...existingMetrics, distance: distanceMiles, house_count: order.length },
        metadata,
        route_origin_mode: routeOriginMode,
        // Never a personal coordinate. Explicitly nulled so switching away from a
        // previously anchored mode cannot leave a stale point behind.
        start_location: null,
        end_location: null
    };
}

/** Mode-specific success copy. */
export function optimizeSuccessMessage(optimizeMode, { alreadyOptimal = false } = {}) {
    if (alreadyOptimal) return 'This route was already optimized for that starting point.';
    if (optimizeMode === OPTIMIZE_MODES.CAR_ROUND_TRIP) {
        return 'Car round trip optimized. You will finish back at your parked-car location.';
    }
    if (optimizeMode === OPTIMIZE_MODES.HOME_ROUND_TRIP) return 'Home round trip optimized.';
    return 'Route order optimized.';
}