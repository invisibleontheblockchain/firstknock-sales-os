import { createVehicleRoutingContext } from './vehicleRouting.js';
import { neighborhoodStreetKey } from './neighborhoodExcursions.js';
import { isValidRoutePoint } from './routeBounds.js';

const identity = point => String(point?.address_hash || point?.legacy_hash || point?.id || `${point?.lat},${point?.lng}`);
const nonnegative = value => Number.isFinite(value) && value >= 0;
const sameOrder = (left, right) => left.length === right.length && left.every((stop, index) => identity(stop) === identity(right[index]));

function assertMembership(baselineOrder, candidateOrder, options) {
    if (!Array.isArray(baselineOrder) || !baselineOrder.length || !Array.isArray(candidateOrder)
        || baselineOrder.length !== candidateOrder.length) throw new Error('Complete driving verification changed route membership.');
    const baseline = new Map(baselineOrder.map(stop => [identity(stop), stop]));
    if (baseline.size !== baselineOrder.length || new Set(candidateOrder.map(identity)).size !== candidateOrder.length
        || candidateOrder.some(stop => !baseline.has(identity(stop)))) throw new Error('Complete driving verification changed route membership.');
    for (const stop of candidateOrder) {
        const original = baseline.get(identity(stop));
        if (!isValidRoutePoint(stop) || !isValidRoutePoint(original)
            || Number(stop.lat) !== Number(original.lat) || Number(stop.lng) !== Number(original.lng)) {
            throw new Error('Complete driving verification changed a route stop location.');
        }
    }
    const locked = new Set((options.lockedStopIds || []).map(String));
    const unresolved = new Set((options.unresolvedStopIds || []).map(String));
    baselineOrder.forEach((stop, index) => {
        if ((stop.order_locked || stop.locked || locked.has(identity(stop)) || unresolved.has(identity(stop))
            || stop.routing_access?.resolution_status === 'unresolved') && identity(candidateOrder[index]) !== identity(stop)) {
            throw new Error('Complete driving verification moved a locked stop or unresolved stop boundary.');
        }
    });
}

function routeBounds(options) {
    const startLocation = options.startLocation ?? null;
    const endLocation = options.returnToStart ? startLocation : options.endLocation ?? null;
    if ((startLocation !== null && !isValidRoutePoint(startLocation)) || (endLocation !== null && !isValidRoutePoint(endLocation))
        || (options.returnToStart && startLocation === null)) throw new Error('Complete driving verification requires valid route boundaries.');
    return { startLocation, endLocation };
}

function assertMeasurement(measurement, order, bounds) {
    const ordered = [bounds.startLocation, ...order, bounds.endLocation].filter(Boolean);
    if (!nonnegative(measurement?.distanceMiles) || !nonnegative(measurement?.driveSeconds)
        || !Array.isArray(measurement.geometry) || measurement.geometry.length < 2 || measurement.geometry.length > 100000
        || !measurement.geometry.every(isValidRoutePoint)
        || !Array.isArray(measurement.directedLegs) || measurement.directedLegs.length !== ordered.length - 1) {
        throw new Error('Complete driving provider returned an incomplete route or directed leg sequence.');
    }
    for (const [index, leg] of measurement.directedLegs.entries()) {
        if (leg.from !== identity(ordered[index]) || leg.to !== identity(ordered[index + 1])
            || !nonnegative(leg.driveSeconds) || !nonnegative(leg.distanceMiles)
            || typeof leg.pathKey !== 'string' || !leg.pathKey
            || !Array.isArray(leg.geometry) || !leg.geometry.length || !leg.geometry.every(isValidRoutePoint)) {
            throw new Error('Complete driving provider returned mismatched consecutive directed legs.');
        }
    }
    const seconds = measurement.directedLegs.reduce((sum, leg) => sum + leg.driveSeconds, 0);
    const miles = measurement.directedLegs.reduce((sum, leg) => sum + leg.distanceMiles, 0);
    // OSRM rounds leg and route aggregates independently to a tenth. Match the
    // provider validator's bounded rounding allowance, including long chunks.
    const rounding = Math.max(1, measurement.directedLegs.length) * 0.11;
    if (Math.abs(seconds - measurement.driveSeconds) > rounding
        || Math.abs(miles - measurement.distanceMiles) * 1609.344 > rounding) {
        throw new Error('Complete driving route totals disagree with consecutive leg costs.');
    }
    for (const key of ['objectiveSeconds', 'walkingAccessSeconds', 'parkingSeconds']) {
        if (measurement[key] != null && !nonnegative(measurement[key])) throw new Error('Complete driving provider returned invalid route costs.');
    }
    return measurement;
}

function assertSameGraph(before, after) {
    if ((before.dataVersion || null) !== (after.dataVersion || null)) {
        throw new Error('Complete driving provider graph identity changed. No routes may be saved.');
    }
}

function diagnosticsFor(neighborhood, applied, guarded) {
    const existing = neighborhood?.diagnostics || {};
    const prior = existing.local_driving_review || {};
    const numeric = value => nonnegative(value) ? value : 0;
    const local = { ...prior, planned: numeric(prior.planned), checked: numeric(prior.checked),
        repaired: applied ? numeric(prior.repaired) : 0, candidatesMeasured: numeric(prior.candidatesMeasured),
        localMilesSaved: applied ? numeric(prior.localMilesSaved) : 0,
        localSecondsSaved: applied ? numeric(prior.localSecondsSaved) : 0,
        skipped: Array.isArray(prior.skipped) ? prior.skipped.map(issue => ({ ...issue })) : [],
        budgetExhausted: prior.budgetExhausted === true, applied, validation: 'whole_route',
        status: guarded ? 'whole_route_guard_retained' : applied
            ? (prior.status && prior.status !== 'whole_route_guard_retained' ? prior.status : 'whole_route_verified')
            : 'current_order_verified' };
    delete local.wholeRouteUnavailableReason;
    delete local.reason;
    const diagnostics = { ...existing, applied, status: guarded ? 'whole_route_guard_retained' : applied
        ? (existing.status && existing.status !== 'whole_route_guard_retained' ? existing.status : 'whole_route_verified')
        : 'current_order_verified', secondsSaved: applied ? numeric(existing.secondsSaved) : 0, local_driving_review: local };
    delete diagnostics.reason;
    delete diagnostics.wholeRouteUnavailableReason;
    return diagnostics;
}

/** Make every successful fully accessible route pass complete driving checks,
 * including runs where neighborhood review finds no repairs. Approximate block
 * costs alone cannot approve a changed route or label its full distance verified. */
export async function verifyCompleteDrivingCandidate({ baselineOrder, candidateOrder, neighborhood = null, options = {} }) {
    assertMembership(baselineOrder, candidateOrder, options);
    const bounds = routeBounds(options);
    const changed = !sameOrder(baselineOrder, candidateOrder);
    let before; let after; let approvedLocal = false;
    const local = neighborhood?.diagnostics?.local_driving_review;
    if (changed && local?.validation === 'whole_route' && local.applied === true
        && Array.isArray(neighborhood.properties) && sameOrder(neighborhood.properties, candidateOrder)) {
        try {
            before = assertMeasurement(neighborhood.baseline, baselineOrder, bounds);
            after = assertMeasurement(neighborhood.measurement, candidateOrder, bounds);
            assertSameGraph(before, after);
            approvedLocal = true;
        } catch {
            // A missing/stale partial proof is remeasured with the current graph.
            before = null; after = null;
        }
    }
    if (!approvedLocal) {
        const factory = options.createDrivingContext || createVehicleRoutingContext;
        const context = await factory(candidateOrder, { accessFor: stop => stop.routing_access || null,
            streetSegmentKey: neighborhoodStreetKey }, { ...options, ...bounds, routeOnly: true, sparseCosts: true,
            requireDirectedLegs: true, maxGeometryPoints: 100000,
            servicePolicy: { ...options.servicePolicy, enabled: false, parkingSecondsPerStop: 0 } });
        if (!context?.routeSequence) throw new Error('Complete driving route costs are unavailable.');
        before = assertMeasurement(await context.routeSequence(baselineOrder, bounds), baselineOrder, bounds);
        after = changed ? assertMeasurement(await context.routeSequence(candidateOrder, bounds), candidateOrder, bounds) : before;
        assertSameGraph(before, after);
    }
    const guarded = changed && !approvedLocal
        && (after.driveSeconds > before.driveSeconds + 0.1 || after.distanceMiles > before.distanceMiles + 0.0001);
    const applied = changed && !guarded;
    return { properties: applied ? candidateOrder : baselineOrder, measurement: applied ? after : before, baseline: before,
        diagnostics: diagnosticsFor(neighborhood, applied, guarded), applied, keptCurrent: !applied };
}
