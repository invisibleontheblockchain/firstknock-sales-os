// A retained route is an outcome, not proof of optimality. In particular, a
// previously verified route must survive a failed attempt without that failure
// being turned into a success message or fresh verification.
export function describeRoadOptimizationOutcome(reason, measurement = null) {
    if (reason === 'backend_cpu_limit') return {
        status: 'processing_limit', tone: 'error',
        message: 'The driving optimizer reached its processing limit. Your route was kept unchanged.',
    };
    if (reason === 'backend_rate_limited') return {
        status: 'rate_limited', tone: 'warning',
        message: 'The driving optimizer is busy. Your route was kept unchanged. Wait a moment and try again.',
    };
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
    if (review?.budgetExhausted || review?.checked < review?.planned || review?.skipped?.length || review?.streetSideService?.unknownStops > 0) return {
        status: 'incomplete', tone: 'warning',
        message: 'Some neighborhoods or street sides could not be verified. Your route was kept unchanged.',
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
    if (review?.applied && review.streetSideService?.mode === 'mail_carrier_right_curb') return {
        tone: review.validation !== 'whole_route' || review.budgetExhausted || review.skipped?.length
            || review.streetSideService.unknownStops > 0 ? 'warning' : 'success',
        message: review.streetSideService.unknownStops > 0
            ? 'Mail-carrier passes applied where street sides are verified. Some stops still need checking.'
            : review.validation !== 'whole_route' || review.budgetExhausted || review.skipped?.length
                ? 'Verified mail-carrier improvements applied. Some neighborhoods still need checking.'
                : 'Mail-carrier order applied with verified curb-side approaches.',
    };
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
    const diagnostic = measurement?.diagnostic;
    return {
        finished_at: finishedAt, mode, door_count: doorCount,
        status: outcome.status, reason: /^[a-z_]+$/.test(reasonCode) ? reasonCode : 'no_result',
        http_status: Number.isInteger(diagnostic?.httpStatus) && diagnostic.httpStatus >= 100 && diagnostic.httpStatus <= 599
            ? diagnostic.httpStatus : null,
        elapsed_ms: Number.isFinite(diagnostic?.elapsedMs) && diagnostic.elapsedMs >= 0
            ? Math.round(diagnostic.elapsedMs) : null,
        optimizer_version: meta.optimizer_version || null,
        matrix_tier: meta.matrix_tier || null,
        neighborhoods_planned: review?.planned ?? null,
        neighborhoods_checked: review?.checked ?? null,
        neighborhoods_skipped: review?.skipped?.length ?? null,
        budget_exhausted: review?.budgetExhausted === true,
    };
}
