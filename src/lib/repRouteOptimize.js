/**
 * The rep-side route optimization orchestration.
 *
 * Extracted from RepHome so all three modes can be EXECUTED in tests with the
 * real helper modules rather than asserted against source text. A regex over a
 * page cannot tell you whether GPS was requested before the identity refusal, or
 * whether a parked-car coordinate reached the SavedRoute payload.
 *
 * RepHome supplies the I/O — identity, hydrated properties, persistence, the
 * confirmation dialog. Every routing decision lives here, and every one of them
 * is the same helper the manager surface calls, so the two cannot drift.
 */

import { optimizeRouteByStreetSweep } from '@/components/logic/routeOptimizer';
import {
    buildPersistedRoadRoutingMetadata,
    createRouteContinuityContext,
} from '@/components/logic/routeRoadContext';
import { haversineDistanceMiles, isValidRoutePoint } from '@/lib/routeBounds';
import {
    captureParkedCarLocation,
    isLowAccuracyCapture,
    lowAccuracyConfirmationMessage,
} from '@/lib/parkedCarLocation';
import {
    OPTIMIZE_MODES,
    ROUTE_ORIGIN_MODES,
    normalizeRouteOriginMode,
    resolveOptimizeMode,
    routeOriginModeForOptimizeMode,
} from '@/lib/routeOriginModes';
import {
    buildRouteOptimizeUpdate,
    compareRouteObjective,
    optimizeSuccessMessage,
} from '@/lib/routeOptimizeUpdate';

export const REP_OPTIMIZE_ERRORS = Object.freeze({
    NO_ROUTE: 'no_route',
    ARCHIVED: 'archived_route',
    NOT_ASSIGNED: 'not_assigned',
    INCOMPLETE: 'incomplete_hydration',
    NO_PROPERTIES: 'no_properties',
    MISSING_COORDINATES: 'missing_coordinates',
    MISSING_HOME_BASE: 'missing_home_base',
    LOCATION_FAILED: 'location_failed',
    LOCATION_DECLINED: 'location_declined',
    CONTEXT_UNAVAILABLE: 'context_unavailable',
    INTEGRITY: 'integrity_failed',
    SAVE_FAILED: 'save_failed',
});

const hashOf = (property) => property?.address_hash || property?.legacy_hash || property?.id || '';

const failure = (code, message) => ({ ok: false, code, message });

/**
 * The routing context must be usable before anything is reordered. A degraded
 * context silently produces a straight-line order that ignores streets.
 */
function usableRouteContext(routingContext) {
    return Boolean(
        routingContext
        && ['full', 'cost-only', 'fallback'].includes(routingContext.mode)
        && typeof routingContext.accessGroupKey === 'function'
    );
}

/**
 * Proves the candidate is a pure reordering: same route, same count, same set,
 * nothing missing, nothing duplicated, nothing added. Outcomes and notes are
 * linked by address hash, so an altered membership silently orphans them.
 */
export function verifyRouteMembership(currentProperties, candidateProperties) {
    const currentHashes = currentProperties.map(hashOf);
    const candidateHashes = candidateProperties.map(hashOf);

    if (currentHashes.some((hash) => !hash) || candidateHashes.some((hash) => !hash)) {
        return { ok: false, reason: 'A route property is missing its address identifier.' };
    }
    if (currentHashes.length !== candidateHashes.length) {
        return { ok: false, reason: 'The optimizer could not preserve every property in this route.' };
    }

    const currentSet = new Set(currentHashes);
    const candidateSet = new Set(candidateHashes);
    if (candidateSet.size !== candidateHashes.length) {
        return { ok: false, reason: 'The optimizer produced a duplicate stop.' };
    }
    if (currentSet.size !== candidateSet.size || candidateHashes.some((hash) => !currentSet.has(hash))) {
        return { ok: false, reason: 'Route integrity verification failed, so the existing route was left unchanged.' };
    }

    return { ok: true, hashes: candidateHashes };
}

/**
 * Resolves the start/end anchor for a chosen mode.
 *
 * `route_only` returns nulls and requests nothing: no GPS, no Home Base lookup,
 * no map centre, no stale saved anchor. `car_round_trip` is the only path that
 * touches the GPS radio, and it does so exactly once.
 */
async function resolveOptimizeAnchor({ optimizeMode, homeBase, captureLocation, confirmLowAccuracy }) {
    if (optimizeMode === OPTIMIZE_MODES.ROUTE_ONLY) {
        return { ok: true, start: null, end: null, carCapture: null, gpsRequested: false };
    }

    if (optimizeMode === OPTIMIZE_MODES.HOME_ROUND_TRIP) {
        if (!isValidRoutePoint(homeBase)) {
            return failure(
                REP_OPTIMIZE_ERRORS.MISSING_HOME_BASE,
                'Save a Home Base above before optimizing this route.'
            );
        }
        // Start and finish are the SAME point — a round trip, not a one-way leg.
        return { ok: true, start: homeBase, end: homeBase, carCapture: null, gpsRequested: false };
    }

    const capture = await captureLocation();
    if (!capture?.ok) {
        return failure(
            REP_OPTIMIZE_ERRORS.LOCATION_FAILED,
            capture?.message || 'Your location could not be determined. Try again.'
        );
    }
    if (isLowAccuracyCapture(capture.point)) {
        const accepted = await confirmLowAccuracy(lowAccuracyConfirmationMessage(capture.point));
        if (!accepted) {
            // Declining changes nothing at all: no optimization, no save, no
            // session anchor, and above all no substituted fallback point.
            return failure(REP_OPTIMIZE_ERRORS.LOCATION_DECLINED, '');
        }
    }

    // Frozen for the whole optimization. The car does not move while the rep
    // walks, and re-reading it would re-anchor the route underneath them.
    const point = { lat: capture.point.lat, lng: capture.point.lng };
    return { ok: true, start: point, end: point, carCapture: capture.point, gpsRequested: true };
}

/**
 * Optimize one assigned route under an explicitly chosen anchor.
 *
 * Returns `{ ok: true, ... }` with the persisted update, the applied order and
 * the SESSION-ONLY anchor, or `{ ok: false, code, message }`. It never throws
 * for an expected refusal, and it never partially applies: the route is saved
 * once, and the session anchor is returned only because that save succeeded.
 */
export async function optimizeRepRoute({
    mode,
    route,
    routeProperties = [],
    homeBase = null,
    routeBelongsToRep = false,
    routeArchived = false,
    hydrationComplete = true,
    expectedPropertyCount = null,
    captureLocation = captureParkedCarLocation,
    confirmLowAccuracy = () => true,
    saveRoute,
}) {
    const optimizeMode = resolveOptimizeMode({ mode });

    if (!route?.id) {
        return failure(REP_OPTIMIZE_ERRORS.NO_ROUTE, 'Select a route before optimizing.');
    }
    if (routeArchived) {
        return failure(REP_OPTIMIZE_ERRORS.ARCHIVED, 'Archived routes are read-only and cannot be optimized.');
    }
    // The identity refusal comes BEFORE any location request. Asking a rep for
    // GPS and only then telling them the route is not theirs would collect a
    // precise personal location for an operation that was never going to run.
    if (!routeBelongsToRep) {
        return failure(
            REP_OPTIMIZE_ERRORS.NOT_ASSIGNED,
            'This route must be assigned to you before you can optimize it.'
        );
    }

    // `Number(null)` is 0 and 0 is finite, so the caller's "not supplied" must be
    // checked before coercion or the route's own hash count is never consulted
    // and a partial load compares against zero.
    const expected = typeof expectedPropertyCount === 'number' && Number.isFinite(expectedPropertyCount)
        ? expectedPropertyCount
        : (route.property_hashes?.length || 0);
    if (!routeProperties.length) {
        return failure(REP_OPTIMIZE_ERRORS.NO_PROPERTIES, 'No properties are loaded for the selected route.');
    }
    // Partial hydration must refuse. Optimizing the subset that happens to have
    // loaded would write that subset back as the whole route.
    if (!hydrationComplete || (expected > 0 && routeProperties.length !== expected)) {
        return failure(
            REP_OPTIMIZE_ERRORS.INCOMPLETE,
            `Only ${routeProperties.length} of ${expected} route properties loaded. Refresh and try again.`
        );
    }
    if (routeProperties.some((property) => !isValidRoutePoint(property))) {
        return failure(
            REP_OPTIMIZE_ERRORS.MISSING_COORDINATES,
            'A route property is missing map coordinates. Ask your manager to repair this route.'
        );
    }

    const anchor = await resolveOptimizeAnchor({ optimizeMode, homeBase, captureLocation, confirmLowAccuracy });
    if (!anchor.ok) return anchor;

    const routingContext = createRouteContinuityContext(routeProperties);
    if (!usableRouteContext(routingContext)) {
        return failure(
            REP_OPTIMIZE_ERRORS.CONTEXT_UNAVAILABLE,
            'The route optimizer could not initialize safely. The existing route was left unchanged.'
        );
    }

    const candidate = optimizeRouteByStreetSweep(routeProperties, anchor.start, anchor.end, routingContext);
    const membership = verifyRouteMembership(routeProperties, candidate);
    if (!membership.ok) return failure(REP_OPTIMIZE_ERRORS.INTEGRITY, membership.reason);

    // Baseline and candidate are measured under the SAME anchors the rep just
    // chose. Comparing the stored metric from a previous mode would report the
    // gap between two anchors as optimizer savings.
    const objective = compareRouteObjective({
        currentOrder: routeProperties,
        candidateOrder: candidate,
        start: isValidRoutePoint(anchor.start) ? anchor.start : null,
        end: isValidRoutePoint(anchor.end) ? anchor.end : null,
        distanceFn: (from, to) => haversineDistanceMiles(from, to),
    });
    const appliedProperties = objective.applyCandidate ? candidate : routeProperties;
    const appliedHashes = appliedProperties.map(hashOf);

    const distanceMiles = Math.round(objective.appliedDistance * 100) / 100;
    const savedMiles = Math.round(objective.estimatedSavings * 100) / 100;
    const existingMetadata = { ...(route.metadata || {}) };
    const routeUpdate = buildRouteOptimizeUpdate({
        optimizeMode,
        order: appliedHashes,
        distanceMiles,
        existingMetrics: route.metrics,
        existingMetadata,
        routingMetadata: buildPersistedRoadRoutingMetadata(routingContext, null, appliedHashes),
        carCapture: anchor.carCapture,
    });

    try {
        await saveRoute(route.id, routeUpdate);
    } catch (error) {
        return failure(
            REP_OPTIMIZE_ERRORS.SAVE_FAILED,
            error?.message || 'Could not save the optimized route. Please try again.'
        );
    }

    const routeOriginMode = routeOriginModeForOptimizeMode(optimizeMode);
    const base = optimizeSuccessMessage(optimizeMode, { alreadyOptimal: !objective.applyCandidate });
    const message = objective.applyCandidate && savedMiles > 0
        ? `${base} Saved ~${savedMiles} estimated miles (${distanceMiles} mi street-continuity estimate).`
        : `${base} (${distanceMiles} mi street-continuity estimate)`;

    return {
        ok: true,
        optimizeMode,
        routeOriginMode,
        routeUpdate,
        order: appliedHashes,
        orderedProperties: appliedProperties,
        applied: objective.applyCandidate,
        distanceMiles,
        savedMiles,
        message,
        // The exact coordinate leaves this function ONLY here, for React state.
        // `routeUpdate` deliberately carries none.
        sessionAnchor: routeOriginMode === ROUTE_ORIGIN_MODES.NONE ? null : {
            routeId: route.id,
            mode: routeOriginMode,
            startLocation: anchor.start,
            endLocation: anchor.end,
            accuracy_m: anchor.carCapture?.accuracy_m ?? null,
            captured_at: anchor.carCapture?.captured_at ?? null,
        },
    };
}

/**
 * What the rep's map should draw, given the saved route and the live session.
 *
 * The session anchor wins while it lasts, because it is the only place an exact
 * Home or car coordinate exists. After a refresh a `home_round_trip` route can
 * re-resolve its anchor from the authenticated user, but a `car_round_trip`
 * route cannot: nothing persisted the car, so the map draws no anchor and the
 * rep recaptures it from the menu. Substituting live GPS there would silently
 * claim the rep is standing where they parked.
 */
export function resolveRepMapAnchor({ route, sessionAnchor = null, homeBase = null }) {
    const empty = { mode: ROUTE_ORIGIN_MODES.NONE, startLocation: null, endLocation: null };
    if (!route?.id) return empty;

    if (sessionAnchor?.routeId === route.id && isValidRoutePoint(sessionAnchor.startLocation)) {
        return {
            mode: normalizeRouteOriginMode(sessionAnchor.mode),
            startLocation: sessionAnchor.startLocation,
            endLocation: sessionAnchor.endLocation ?? null,
        };
    }

    const savedMode = normalizeRouteOriginMode(route.route_origin_mode || route.routeOriginMode);
    if (savedMode === ROUTE_ORIGIN_MODES.HOME_ROUND_TRIP && isValidRoutePoint(homeBase)) {
        return { mode: savedMode, startLocation: homeBase, endLocation: homeBase };
    }
    if (savedMode === ROUTE_ORIGIN_MODES.CURRENT_TO_HOME && isValidRoutePoint(homeBase)) {
        return { mode: savedMode, startLocation: null, endLocation: homeBase };
    }
    // car_round_trip without a session anchor, and every unanchored mode, draw
    // nothing rather than inventing a point.
    return empty;
}
