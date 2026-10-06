// Small driving pilot: uncertainty keeps the supplied legacy route intact.
import { routePropertyOrderFingerprint } from './routeFingerprint.js';
import { isValidRoutePoint } from './routeBounds.js';
import { reviewNeighborhoodOrder, getNeighborhoodExcursionReview } from './neighborhoodExcursions.js';

const identity = stop => String(stop?.address_hash || stop?.id || '').trim();
export function assertPilotMembership(expected, actual) {
    const a = expected.map(identity), b = actual.map(identity);
    if (a.some(value => !value) || new Set(a).size !== a.length || b.length !== a.length
        || JSON.stringify([...a].sort()) !== JSON.stringify([...b].sort())) {
        throw new Error('Core driving pilot changed route membership. No routes may be saved.');
    }
}
function measureIsComplete(result) {
    return Number.isFinite(result?.driveSeconds) && result.driveSeconds >= 0
        && Number.isFinite(result?.distanceMiles) && result.distanceMiles >= 0
        && Array.isArray(result.geometry) && result.geometry.length >= 2
        && result.geometry.every(isValidRoutePoint);
}
function propagateIntegrityOrCancellation(error) {
    if (error?.name === 'AbortError' || /membership|stable identifiers|graph identity|cancelled/i.test(error?.message || '')) throw error;
}

/** Baseline and proposal use one context, graph, boundaries and snap policy.
 * A faster proposal must also avoid increasing miles. Ties retain legacy.
 * A failed baseline is never replaced by an uncomparable new route.
 */
export async function evaluateCoreDrivingRoute({ legacyOrder, createContext, propose, bounds = {}, problemPins = [] }) {
    assertPilotMembership(legacyOrder, legacyOrder);
    const fallback = (reason, error = null) => ({ eligible: false, selection: 'legacy_fallback', reason,
        error, properties: legacyOrder, baseline: null, candidate: null, selected: null, context: null });
    if (!legacyOrder.length || !legacyOrder.every(isValidRoutePoint)) return fallback('INVALID_COORDINATES');
    if (problemPins.length) return { ...fallback('UNRESOLVED_ACCESS'), problemPins: [...problemPins] };
    if (legacyOrder.length > 500) return fallback('ROUTE_TOO_LARGE');
    let context, baseline;
    try {
        context = await createContext(legacyOrder, bounds);
        if (!context?.vehicleAware) return fallback('ROAD_COSTS_UNAVAILABLE');
        baseline = await context.routeSequence(legacyOrder, bounds);
        if (!measureIsComplete(baseline)) return fallback('LEGACY_ROAD_ROUTE_INCOMPLETE');
    } catch (error) {
        propagateIntegrityOrCancellation(error);
        return fallback('ROAD_EVIDENCE_UNAVAILABLE', error.message);
    }
    let candidateOrder, candidate = null, candidateError = null;
    try {
        candidateOrder = await propose(legacyOrder, context, bounds);
        assertPilotMembership(legacyOrder, candidateOrder);
        if (legacyOrder.some((stop, i) => (stop.locked || stop.order_locked || stop.routing_access?.resolution_status === 'unresolved')
            && identity(candidateOrder[i]) !== identity(stop))) candidateOrder = legacyOrder;
        candidateOrder = reviewNeighborhoodOrder(candidateOrder, bounds.startLocation, bounds.endLocation, context);
    }
    catch (error) { propagateIntegrityOrCancellation(error); candidateError = error.message; }
    // An identity bug must fail the operation, never be disguised as fallback.
    if (candidateOrder) assertPilotMembership(legacyOrder, candidateOrder);
    if (candidateOrder) try {
        candidate = routePropertyOrderFingerprint(candidateOrder) === routePropertyOrderFingerprint(legacyOrder)
            ? baseline : await context.routeSequence(candidateOrder, bounds);
        if (!measureIsComplete(candidate)) { candidate = null; candidateError = 'Incomplete proposal road route.'; }
    } catch (error) { propagateIntegrityOrCancellation(error); candidateError = error.message; }
    const accept = candidate && candidate.driveSeconds < baseline.driveSeconds
        && candidate.distanceMiles <= baseline.distanceMiles;
    return { eligible: true, selection: accept ? 'road_aware' : 'legacy_guard',
        reason: accept ? null : candidate ? 'PROPOSAL_NOT_BETTER_IN_TIME_AND_MILES' : 'PROPOSAL_UNAVAILABLE',
        properties: accept ? candidateOrder : legacyOrder, baseline, candidate,
        candidateOrder: candidateOrder || null, candidateError, selected: accept ? candidate : baseline, context,
        neighborhoodReview: candidateOrder ? getNeighborhoodExcursionReview(candidateOrder) : null };
}
