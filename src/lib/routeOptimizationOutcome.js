// A retained route is an outcome, not proof of optimality. In particular, a
// previously verified route must survive a failed attempt without that failure
// being turned into a success message or fresh verification.
export function describeRoadOptimizationOutcome(reason, measurement = null) {
    if (reason === 'deadline_exceeded') return {
        status: 'timed_out', tone: 'warning',
        message: 'Optimization timed out. Your route was kept unchanged. Try again.',
    };
    if (reason !== 'current_order_measured_best' || !Number.isFinite(measurement?.distanceMiles)) return {
        status: 'failed', tone: 'error',
        message: 'Could not complete the driving check. Your route was kept unchanged. Try again.',
    };
    const meta = measurement.routingMetadata || {};
    const review = meta.neighborhood_excursion_review?.local_driving_review;
    if (review?.repaired > 0 && review.applied === false && review.status === 'whole_route_guard_retained'
        && (review.reason || review.validation !== 'whole_route')) return {
        status: 'verification_failed', tone: 'error',
        message: 'Improvements were found, but the final driving check failed. Your route was kept unchanged. Try again.',
    };
    if (review?.budgetExhausted || review?.checked < review?.planned || review?.skipped?.length) return {
        status: 'incomplete', tone: 'warning',
        message: 'Optimization was incomplete: some neighborhoods could not be checked. Your route was kept unchanged.',
    };
    if (!review || (meta.matrix_tier && meta.matrix_tier !== 'door' && review.validation !== 'whole_route')) return {
        status: 'limited', tone: 'warning',
        message: 'No improvement found in the limited comparison. The complete driving route was not verified.',
    };
    return {
        status: 'no_improvement', tone: 'info',
        message: 'No faster order found among the orders checked. Your route was kept unchanged.',
    };
}

export function describeAppliedRoadOptimization(routingMetadata) {
    const review = routingMetadata?.neighborhood_excursion_review?.local_driving_review;
    if (review?.applied && (review.validation !== 'whole_route' || review.budgetExhausted || review.skipped?.length)) return {
        tone: 'warning',
        message: 'Verified neighborhood improvements applied. Some parts of the route still need checking.',
    };
    return null;
}

// Store enough evidence to diagnose the last click even when the stop order
// does not change. Whitelist fields: home/car anchors stay out of shared data.
export function buildRoadOptimizationAttempt(reason, measurement, { mode, doorCount, finishedAt = new Date().toISOString() } = {}) {
    const outcome = describeRoadOptimizationOutcome(reason, measurement);
    const meta = measurement?.routingMetadata || {};
    const review = meta.neighborhood_excursion_review?.local_driving_review;
    const reasonCode = String(reason || 'no_result').split(':')[0];
    return {
        finished_at: finishedAt, mode, door_count: doorCount,
        status: outcome.status, reason: /^[a-z_]+$/.test(reasonCode) ? reasonCode : 'no_result',
        optimizer_version: meta.optimizer_version || null,
        matrix_tier: meta.matrix_tier || null,
        neighborhoods_planned: review?.planned ?? null,
        neighborhoods_checked: review?.checked ?? null,
        neighborhoods_skipped: review?.skipped?.length ?? null,
        budget_exhausted: review?.budgetExhausted === true,
    };
}
