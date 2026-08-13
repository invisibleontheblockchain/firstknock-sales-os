// One canonical candidate comparison for every route-ordering workflow.
//
// Create Route and the Optimize action both build a set of candidate orders,
// price EVERY candidate with the SAME road matrix, and hand them to
// selectBestRouteCandidate. That gives three guarantees the routing audit
// demanded:
//
//   1. Monotonic — the route's CURRENT order is always one of the candidates,
//      and it wins every tie, so an optimization pass can never replace a route
//      with an equal or worse-scoring order.
//   2. Deterministic — the comparison is a total order over candidate CONTENT
//      (duration, then distance, then the order fingerprint), so the array order
//      in which candidates arrive cannot change the winner.
//   3. Explicit objective — real road driving duration is primary, road distance
//      is the tie-break. Haversine is never used to pick a winner when a matrix
//      is available.

import { routePropertyOrderFingerprint } from './routeContinuityOptimizer.js';
import { measureOrder } from './roadMatrix.js';

// Two orders within this much driving time are treated as tied, and the
// comparison falls through to distance. OSRM durations are modelled, not
// measured, so sub-tolerance "wins" are noise rather than real improvement.
export const DURATION_TIE_TOLERANCE_MINUTES = 0.1;
export const DISTANCE_TIE_TOLERANCE_MILES = 0.001;

export const OBJECTIVE_VERSION = 'duration_primary_distance_tiebreak_v1';

/**
 * Price one candidate order on the shared matrix.
 *
 * When a start/finish anchor is given it MUST be part of the same matrix, and its
 * legs are included in the score. Measuring door-to-door legs only made the
 * anchor invisible to the objective: "optimize from Home" then generated an
 * order that began at the door nearest home but scored no better than the saved
 * order, so the incumbent won every time and the route still started at a far
 * door. An anchor that cannot be priced is dropped rather than guessed, so every
 * candidate is still scored on exactly the same legs.
 */
function measureWithAnchors(order, metricFn, start, end) {
    if (typeof metricFn !== 'function') return null;
    const doors = measureOrder(order, metricFn);
    if (!Number.isFinite(doors) || order.length === 0) return doors;
    let total = doors;
    for (const [from, to] of [[start, order[0]], [order[order.length - 1], end]]) {
        if (!from || !to) continue;
        const leg = metricFn(from, to);
        if (!Number.isFinite(leg)) return null;
        total += leg;
    }
    return total;
}

export function measureRouteCandidate(candidate, {
    distanceBetween,
    durationBetween = null,
    startLocation = null,
    endLocation = null
} = {}) {
    const order = candidate.order || [];
    const distance = measureWithAnchors(order, distanceBetween, startLocation, endLocation);
    const duration = typeof durationBetween === 'function'
        ? measureWithAnchors(order, durationBetween, startLocation, endLocation)
        : null;
    return {
        ...candidate,
        distance: Number.isFinite(distance) ? distance : null,
        duration: Number.isFinite(duration) ? duration : null,
        fingerprint: routePropertyOrderFingerprint(order)
    };
}

/** Negative when a is the better route. Total order, content-only. */
export function compareRouteCandidates(a, b) {
    const aMeasured = Number.isFinite(a.duration) || Number.isFinite(a.distance);
    const bMeasured = Number.isFinite(b.duration) || Number.isFinite(b.distance);
    if (aMeasured !== bMeasured) return aMeasured ? -1 : 1;

    if (Number.isFinite(a.duration) && Number.isFinite(b.duration)) {
        const gap = a.duration - b.duration;
        if (Math.abs(gap) > DURATION_TIE_TOLERANCE_MINUTES) return gap < 0 ? -1 : 1;
    }
    if (Number.isFinite(a.distance) && Number.isFinite(b.distance)) {
        const gap = a.distance - b.distance;
        if (Math.abs(gap) > DISTANCE_TIE_TOLERANCE_MILES) return gap < 0 ? -1 : 1;
    }

    // Effectively tied: never churn the rep's existing route to look busy.
    if (a.is_current !== b.is_current) return a.is_current ? -1 : 1;

    if (a.fingerprint === b.fingerprint) return 0;
    return a.fingerprint < b.fingerprint ? -1 : 1;
}

/**
 * Pick the winning candidate.
 * @param {Array} candidates measured candidates; exactly one should carry
 *   is_current so the incumbent route participates in the comparison.
 * @returns {object|null}
 */
export function selectBestRouteCandidate(candidates) {
    const measured = (candidates || []).filter((candidate) => (
        Array.isArray(candidate.order)
        && candidate.order.length > 0
        && (Number.isFinite(candidate.duration) || Number.isFinite(candidate.distance))
    ));
    if (measured.length === 0) return null;
    return [...measured].sort(compareRouteCandidates)[0];
}