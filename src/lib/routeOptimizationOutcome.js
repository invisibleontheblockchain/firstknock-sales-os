const ACCESS_REASONS = new Set([
    'no_drivable_road', 'address_not_found', 'provider_unavailable',
    'ambiguous_access', 'recovery_budget_exhausted', 'unmatched_stop',
    'invalid_coordinates', 'address_match_rejected', 'address_road_mismatch',
]);
const ACCESS_REASON_ALIASES = {
    road_not_matched: 'no_drivable_road', address_road_not_matched: 'no_drivable_road',
    address_not_matched: 'address_not_found', ambiguous_service_road: 'ambiguous_access',
    recovery_limit_reached: 'recovery_budget_exhausted',
    road_provider_unavailable: 'provider_unavailable', address_provider_unavailable: 'provider_unavailable',
};

const safeCount = value => Number.isInteger(value) && value >= 0 ? value : 0;
const optionalCount = value => Number.isInteger(value) && value >= 0 ? value : null;
const safeToken = value => typeof value === 'string' && /^[a-z\d_-]{1,120}$/i.test(value) ? value : null;
const safeAddress = value => {
    if (typeof value !== 'string' || /[a-z][a-z\d+.-]*:\/\/|\b-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+/i.test(value)) return null;
    return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240) || null;
};

// Why the road server could not be used, as a short phrase. The backend already
// strips URLs and coordinates; this re-checks every field before display.
const FAILURE_KINDS = new Set(['config', 'network', 'auth', 'timeout', 'http', 'osrm', 'cancelled', 'other']);
function roadFailureDetail(detail) {
    if (!detail || typeof detail !== 'object' || !FAILURE_KINDS.has(detail.kind)) return null;
    const status = Number.isInteger(detail.status) && detail.status >= 100 && detail.status <= 599 ? detail.status : null;
    const osrmCode = typeof detail.osrm_code === 'string' && /^[A-Z][A-Za-z]{1,40}$/.test(detail.osrm_code) ? detail.osrm_code : null;
    const host = typeof detail.host === 'string' && /^[a-z\d.-]{1,253}$/i.test(detail.host) ? detail.host : null;
    const message = safeAddress(typeof detail.message === 'string'
        ? detail.message.replace(/^OSRM request (failed|rejected):\s*/i, '').slice(0, 160) : null);
    return { kind: detail.kind, status, osrm_code: osrmCode, message, host };
}
export function roadFailureCause(detail) {
    const failure = roadFailureDetail(detail);
    if (!failure) return '';
    const { kind, status, osrm_code: osrmCode, message, host } = failure;
    if (kind === 'network') return `couldn't connect to the road server${host ? ` ${host}` : ''}${message ? ` (${message})` : ''}`;
    if (kind === 'auth') return `the road server rejected the key (${status || 'refused'})`;
    if (kind === 'timeout') return 'the road server did not answer in time';
    if (kind === 'config') return 'no road server is configured';
    if (kind === 'cancelled') return 'the request was cancelled';
    if (kind === 'osrm') return `the road server refused the request (${osrmCode || status || 'error'})`;
    if (kind === 'http') return `the road server returned an error${status ? ` (HTTP ${status})` : ''}`;
    return `the road request failed${message ? ` (${message})` : ''}`;
}

// Road access is a separate concern from an unknown curb side. Only copy the
// public property identity/address and controlled reason codes into shared data.
function roadAccessRecovery(meta) {
    const recovery = meta?.road_access_recovery;
    if (!recovery || typeof recovery !== 'object') return null;
    const unresolved = (Array.isArray(recovery.unresolved) ? recovery.unresolved : []).map(issue => ({
        property_id: safeAddress(issue?.property_id),
        stop_number: Number.isInteger(issue?.stop_number) && issue.stop_number > 0 ? issue.stop_number : null,
        address: safeAddress(issue?.address),
        reason: ACCESS_REASONS.has(issue?.reason) ? issue.reason
            : Object.hasOwn(ACCESS_REASON_ALIASES, issue?.reason) ? ACCESS_REASON_ALIASES[issue.reason] : 'unmatched_stop',
    }));
    const recovered = safeCount(recovery.recovered);
    // Stops routed from the nearest road because nothing better matched.
    const approximate = (Array.isArray(recovery.approximate) ? recovery.approximate : []).slice(0, 100).map(item => ({
        property_id: safeAddress(item?.property_id),
        stop_number: Number.isInteger(item?.stop_number) && item.stop_number > 0 ? item.stop_number : null,
        address: safeAddress(item?.address),
        snap_meters: optionalCount(item?.snap_meters),
    })).filter(item => item.property_id);
    return {
        status: recovery.status === 'provider_unavailable' || unresolved.some(issue => issue.reason === 'provider_unavailable') ? 'provider_unavailable'
            : unresolved.length ? recovered > 0 ? 'partial' : 'unresolved'
            : recovered > 0 ? 'recovered' : 'not_needed',
        attempted: safeCount(recovery.attempted), recovered, unresolved,
        ...(approximate.length ? { approximate } : {}),
        ...(typeof recovery.inventory_complete === 'boolean' ? { inventory_complete: recovery.inventory_complete } : {}),
        ...(optionalCount(recovery.unverified_count) !== null ? { unverified_count: recovery.unverified_count } : {}),
        ...(roadFailureDetail(recovery.failure_detail) ? { failure_detail: roadFailureDetail(recovery.failure_detail) } : {}),
    };
}

export function approximateAccessMessage(recovery) {
    const approximate = recovery?.approximate || [];
    if (!approximate.length) return '';
    const stops = approximate.slice(0, 5).map(item => `${item.stop_number ? `Stop ${item.stop_number}` : 'Stop'}${item.address ? ` (${item.address})` : ''}`);
    const more = approximate.length > 5 ? `; ${approximate.length - 5} more` : '';
    return ` Approximate road access for ${approximate.length} ${approximate.length === 1 ? 'stop' : 'stops'}, routed from the nearest road: ${stops.join('; ')}${more}.`;
}

function recoveryMessage(recovery) {
    if (!recovery) return '';
    const recovered = `${recovery.recovered > 0
        ? ` Road access recovered automatically for ${recovery.recovered} ${recovery.recovered === 1 ? 'stop' : 'stops'}.` : ''}${approximateAccessMessage(recovery)}`;
    const cause = roadFailureCause(recovery.failure_detail);
    if (!recovery.unresolved.length) return `${recovered}${recovery.inventory_complete === false && recovery.unverified_count > 0
        ? ` Road access could not be checked for ${recovery.unverified_count} stops${cause ? `: ${cause}` : ''}.` : ''}`;
    const stops = recovery.unresolved.map(issue => `${issue.stop_number ? `Stop ${issue.stop_number}` : 'Stop'}${issue.address ? ` (${issue.address})` : ''}`);
    return `${recovered} Road access ${recovery.status === 'provider_unavailable' ? 'could not be checked' : 'is still unresolved'} for ${stops.join('; ')}${cause ? ` (${cause})` : ''}. All stops are retained in the route.`;
}

function withRecovery(outcome, recovery) {
    return { ...outcome, message: `${outcome.message}${recoveryMessage(recovery)}` };
}

const unknownSides = review => safeCount(review?.streetSideService?.unknownStops);
const sideMessage = review => unknownSides(review) > 0
    ? ` Curb-side approaches are unconfirmed for ${unknownSides(review)} ${unknownSides(review) === 1 ? 'stop' : 'stops'}.` : '';
const skippedMessage = review => {
    const skipped = Array.isArray(review?.skipped) ? review.skipped : [];
    const unavailable = skipped.filter(issue => /NoSegment|request failed|fetch failed|network|timed out|provider unavailable/i.test(String(issue?.reason || ''))).length;
    return unavailable === skipped.length
        ? `Driving data could not be loaded for ${skipped.length} ${skipped.length === 1 ? 'neighborhood check' : 'neighborhood checks'}.`
        : `${skipped.length} ${skipped.length === 1 ? 'neighborhood check could' : 'neighborhood checks could'} not be verified.`;
};
const validDistance = value => Number.isFinite(value) && value >= 0;
function completeDrivingVerification(meta, measurement = null, applied = false) {
    const review = meta?.neighborhood_excursion_review?.local_driving_review;
    const recovery = roadAccessRecovery(meta);
    if (meta?.road_path_validated !== true || meta?.fallback === true || review?.validation !== 'whole_route'
        || recovery?.unresolved.length || recovery?.inventory_complete === false) return false;
    return applied ? validDistance(meta.winning_route_distance) || validDistance(meta.road_aware_measured)
        : validDistance(measurement?.distanceMiles) || validDistance(meta.input_measured) || validDistance(meta.continuity_measured);
}
const countyRoadsIncluded = meta => meta?.county_road_routing?.countyStopCount > 0
    || (typeof meta?.road_matrix_source === 'string' && /\+(?:nc|county)_ng911$/.test(meta.road_matrix_source));
const coverageSummary = meta => {
    const coverage = meta?.road_search_coverage;
    return coverage?.version === 1 && optionalCount(coverage.total_windows) !== null
        && optionalCount(coverage.remaining_windows) !== null && coverage.remaining_windows <= coverage.total_windows
        && coverage.cycle_complete === (coverage.remaining_windows === 0) ? coverage : null;
};
const searchIncomplete = (review, meta) => coverageSummary(meta) ? coverageSummary(meta).remaining_windows > 0
    : review?.budgetExhausted === true || review?.skipped?.length > 0
        || (optionalCount(review?.checked) !== null && optionalCount(review?.planned) !== null && review.checked < review.planned);
function incompleteSearchMessage(review, meta) {
    const coverage = coverageSummary(meta);
    if (coverage) {
        const passes = safeCount(meta?.road_search_passes);
        const stopped = {
            action_budget: ' The search time limit was reached.',
            pass_limit: ' The search reached its limit for this run.',
            no_progress: ' The remaining checks made no verified progress.',
            measurement_changed: ' Road measurements changed; the last verified result was kept.',
        }[meta?.road_search_stop_reason] || '';
        return `Neighborhood search is incomplete: ${coverage.remaining_windows} of ${coverage.total_windows} checks remain${passes > 1 ? ` after ${passes} passes` : ''}.${stopped}`;
    }
    const reasons = [];
    const counts = optionalCount(review?.checked) !== null && optionalCount(review?.planned) !== null && review.planned > 0
        ? `${review.checked} of ${review.planned} neighborhoods` : '';
    if (review?.budgetExhausted) reasons.push(`the time limit was reached${counts ? ` after checking ${counts}` : ''}`);
    else if (review?.checked < review?.planned) reasons.push(`only ${counts} were checked`);
    const skipped = Array.isArray(review?.skipped) ? review.skipped.length : 0;
    if (skipped) reasons.push(`${skipped} candidate ${skipped === 1 ? 'check was' : 'checks were'} skipped`);
    return `Neighborhood search is incomplete${reasons.length ? `: ${reasons.join('; ')}` : ''}.`;
}
function roadAccessSearchDetails(review, meta) {
    if (searchIncomplete(review, meta)) return ` ${incompleteSearchMessage(review, meta)}`;
    const coverage = coverageSummary(meta);
    const total = coverage ? coverage.total_windows : optionalCount(review?.planned);
    if (total === null || (!coverage && (optionalCount(review?.checked) === null || review.checked < total))) return '';
    const passes = safeCount(meta?.road_search_passes);
    return ` Neighborhood search completed: ${total} ${total === 1 ? 'check' : 'checks'} finished${passes > 1 ? ` after ${passes} passes` : ''}.`;
}
function completedRouteDetails(meta, recovery) {
    const review = meta?.neighborhood_excursion_review?.local_driving_review;
    return `${sideMessage(review)}${recoveryMessage(recovery)}${countyRoadsIncluded(meta)
        ? ' County-mapped local roads included; local-road travel times are estimated.' : ''}`;
}

// A retained route is an outcome, not proof of optimality. In particular, a
// previously verified route must survive a failed attempt without that failure
// being turned into a success message or fresh verification.
export function describeRoadOptimizationOutcome(reason, measurement = null) {
    const meta = measurement?.routingMetadata || {};
    const recovery = roadAccessRecovery(meta);
    const review = meta.neighborhood_excursion_review?.local_driving_review;
    const finish = outcome => withRecovery(outcome, recovery);
    if (reason === 'backend_cpu_limit') return finish({
        status: 'processing_limit', tone: 'error',
        message: 'The driving optimizer reached its processing limit. Your route was kept unchanged.',
    });
    if (reason === 'backend_rate_limited') return finish({
        status: 'rate_limited', tone: 'warning',
        message: 'The driving optimizer is busy. Your route was kept unchanged. Wait a moment and try again.',
    });
    if (reason === 'deadline_exceeded') return finish({
        status: 'timed_out', tone: 'warning',
        message: 'Optimization timed out. Your route was kept unchanged. Try again.',
    });
    if (recovery?.status === 'provider_unavailable' && recovery.inventory_complete === false) return finish({
        status: 'road_provider_unavailable', tone: 'error',
        message: `The driving service could not load the road matches needed for optimization. Your route was kept unchanged.${roadAccessSearchDetails(review, meta)}`,
    });
    if (recovery?.unresolved.length || recovery?.inventory_complete === false) return finish({
        status: recovery.status === 'provider_unavailable' ? 'road_provider_unavailable' : 'road_access_unresolved', tone: 'error',
        message: `${recovery.status === 'provider_unavailable'
            ? 'The road or address data provider could not complete automatic road-access recovery. Your route was kept unchanged.'
            : 'Automatic road-access recovery could not verify the complete driving route. Your route was kept unchanged.'}${roadAccessSearchDetails(review, meta)}`,
    });
    // The continuity fallback: no road distances at all, and now the reason.
    if (reason === 'aerial_fallback' && roadFailureCause(meta.road_failure_detail)) return finish({
        status: 'road_provider_unavailable', tone: 'error',
        message: `Road distances were unavailable, so your route was kept unchanged: ${roadFailureCause(meta.road_failure_detail)}.`,
    });
    if (reason !== 'current_order_measured_best' || !validDistance(measurement?.distanceMiles)) {
        const serverMessage = safeAddress(typeof measurement?.diagnostic?.serverMessage === 'string'
            ? measurement.diagnostic.serverMessage.slice(0, 160) : null);
        return finish({
            status: 'failed', tone: 'error',
            message: `Could not complete the driving check${serverMessage ? `: ${serverMessage.replace(/\.$/, '')}` : ''}. Your route was kept unchanged. Try again.`,
        });
    }
    if (review?.repaired > 0 && review.applied === false && review.status === 'whole_route_guard_retained'
        && (review.reason || review.validation !== 'whole_route')) return finish({
        status: 'verification_failed', tone: 'error',
        message: 'Improvements were found, but they could not be verified for driving. Your route was kept unchanged.',
    });
    // Exhausting the search budget or lacking a curb-side label does not undo
    // the separate continuous driving check for the returned complete route.
    if (completeDrivingVerification(meta, measurement) && searchIncomplete(review, meta)) return {
        status: 'incomplete', tone: 'warning',
        message: `Your route was kept unchanged. ${incompleteSearchMessage(review, meta)} The complete driving route was verified.${approximateAccessMessage(recovery)}`,
    };
    if (completeDrivingVerification(meta, measurement)) return {
        status: 'no_improvement', tone: 'info',
        message: `Complete driving route verified. No better order found among the orders checked. Your route was kept unchanged.${approximateAccessMessage(recovery)}`,
    };
    if (review?.budgetExhausted) return finish({
        status: 'incomplete', tone: 'warning',
        message: `The optimization time limit was reached${Number.isInteger(review.checked) && Number.isInteger(review.planned)
            ? ` after checking ${review.checked} of ${review.planned} neighborhoods` : ''}. Your route was kept unchanged.${sideMessage(review)}`,
    });
    if (review?.skipped?.length) return finish({
        status: 'incomplete', tone: 'warning',
        message: `${skippedMessage(review)} Your route was kept unchanged.${sideMessage(review)}`,
    });
    if (review?.checked < review?.planned) return finish({
        status: 'incomplete', tone: 'warning',
        message: `Only ${review.checked} of ${review.planned} neighborhoods were checked. Your route was kept unchanged.${sideMessage(review)}`,
    });
    if (unknownSides(review) > 0) return finish({
        status: 'curb_side_incomplete', tone: 'warning',
        message: `Your route was kept unchanged.${sideMessage(review)} This does not mean the addresses are invalid.`,
    });
    if (!review || (meta.matrix_tier && meta.matrix_tier !== 'door' && review.validation !== 'whole_route')) return finish({
        status: 'limited', tone: 'warning',
        message: 'No improvement found in the limited comparison. The complete driving route was not verified.',
    });
    return finish({
        status: 'no_improvement', tone: 'info',
        message: 'No better order found among the orders checked. Your route was kept unchanged.',
    });
}

export function describeAppliedRoadOptimization(routingMetadata) {
    const recovery = roadAccessRecovery(routingMetadata);
    const review = routingMetadata?.neighborhood_excursion_review?.local_driving_review;
    const finish = outcome => withRecovery(outcome, recovery);
    if (recovery?.unresolved.length || recovery?.inventory_complete === false) return finish({
        status: 'applied_partial', tone: 'warning',
        message: `Verified route improvements applied; the complete driving route remains unverified.${roadAccessSearchDetails(review, routingMetadata)}`,
    });
    if (completeDrivingVerification(routingMetadata, null, true) && searchIncomplete(review, routingMetadata)) return {
        status: 'applied_partial', tone: 'warning',
        message: `Route updated. ${incompleteSearchMessage(review, routingMetadata)} The complete driving route was verified.`,
    };
    if (completeDrivingVerification(routingMetadata, null, true)) return {
        status: 'applied', tone: 'success',
        message: 'Route updated. The complete driving route was verified.',
    };
    const limited = review?.validation !== 'whole_route' || review?.budgetExhausted || review?.skipped?.length
        || review?.checked < review?.planned;
    const remaining = `${review?.budgetExhausted ? ' The optimization time limit was reached.' : review?.skipped?.length
        ? ` ${skippedMessage(review)}` : limited
            ? ' Some parts of the route still need checking.' : ''}${sideMessage(review)}`;
    if (review?.applied && review.areaReview?.repaired > 0) return finish({
        status: limited || unknownSides(review) > 0 ? 'applied_partial' : 'applied',
        tone: limited || unknownSides(review) > 0 ? 'warning' : 'success',
        message: limited || unknownSides(review) > 0 ? `Verified neighborhood order improvements applied.${remaining}`
            : 'Neighborhood order improved with verified driving paths and curb-side approaches.',
    });
    if (review?.applied && review.streetSideService?.mode === 'mail_carrier_right_curb') return finish({
        status: limited || unknownSides(review) > 0 ? 'applied_partial' : 'applied',
        tone: limited || unknownSides(review) > 0 ? 'warning' : 'success',
        message: limited || unknownSides(review) > 0 ? `Verified mail-carrier improvements applied.${remaining}`
            : 'Mail-carrier order applied with verified curb-side approaches.',
    });
    if (review?.applied && (limited || unknownSides(review) > 0)) return finish({
        status: 'applied_partial', tone: 'warning',
        message: `Verified neighborhood improvements applied.${remaining}`,
    });
    if (recovery?.recovered > 0) return finish({
        status: 'applied', tone: 'success', message: 'Verified route improvements applied.',
    });
    return null;
}

// Store enough evidence to diagnose the last click even when the stop order
// does not change. Whitelist fields: home/car anchors stay out of shared data.
// What a person sees after Optimize, generation or a split: one short,
// plain message. Search coverage, verification and estimate details belong to
// the saved attempt and diagnostics, not the toast. A warning or error only
// for something actually wrong: stops without road access, or a failed check.
const PROBLEM_STATUSES = new Set(['processing_limit', 'rate_limited', 'timed_out', 'road_provider_unavailable',
    'road_access_unresolved', 'failed', 'verification_failed']);
const DIAGNOSTIC_SENTENCE = /incomplete|checks? remain|estimat|background|still need checking|time limit was reached|neighborhoods were checked|complete driving route (?:was|remains)|limited comparison|curb-side|does not mean/i;
const stopsWord = count => `${count} ${count === 1 ? 'stop' : 'stops'}`;

/** Drop diagnostic sentences (search coverage, estimates, verification) from a message. */
export function plainMessageText(message) {
    return String(message || '').split(/(?<=\.)\s+/).filter(sentence => sentence && !DIAGNOSTIC_SENTENCE.test(sentence)).join(' ').trim();
}

/**
 * { tone, message } for the one notice after an optimization.
 * Applied: "Route optimized · 14 stops reordered · ~0.3 mi shorter".
 * Nothing shorter: "Route checked · already the shortest order found".
 */
export function plainOptimizeMessage({ applied = false, changedStops = 0, savedMiles = 0, routingMetadata = null, outcome = null } = {}) {
    const recovery = roadAccessRecovery(routingMetadata);
    const approximate = recovery?.approximate?.length || 0;
    const approximateNote = approximate ? ` · ${stopsWord(approximate)} on approximate road access` : '';
    const accessProblem = Boolean(recovery?.unresolved?.length || recovery?.inventory_complete === false);
    if (!applied && outcome && (PROBLEM_STATUSES.has(outcome.status) || outcome.tone === 'error')) {
        return { tone: outcome.tone === 'info' || outcome.tone === 'success' ? 'warning' : outcome.tone,
            message: plainMessageText(outcome.message) || 'Optimization could not finish. Your route was kept unchanged.' };
    }
    if (!applied || changedStops <= 0) {
        return { tone: 'success', message: `Route checked · already the shortest order found${approximateNote}` };
    }
    const miles = Math.round((Number(savedMiles) || 0) * 10) / 10;
    const parts = ['Route optimized', `${stopsWord(changedStops)} reordered`, ...(miles >= 0.1 ? [`~${miles} mi shorter`] : [])];
    const message = `${parts.join(' · ')}${approximateNote}`;
    if (!accessProblem) return { tone: 'success', message };
    return { tone: 'warning', message: `${message}. ${plainMessageText(recoveryMessage(recovery))}`.trim() };
}

export function buildRoadOptimizationAttempt(reason, measurement, {
    mode, doorCount, finishedAt = new Date().toISOString(), applied = false,
} = {}) {
    const meta = measurement?.routingMetadata || {};
    const outcome = applied ? describeAppliedRoadOptimization(meta) || {
        status: 'applied', message: 'Verified route improvements applied.',
    } : describeRoadOptimizationOutcome(reason, measurement);
    const review = meta.neighborhood_excursion_review?.local_driving_review;
    const recovery = roadAccessRecovery(meta);
    const verificationComplete = ['applied', 'no_improvement', 'applied_partial', 'incomplete'].includes(outcome.status)
        && (applied || reason === 'current_order_measured_best') && completeDrivingVerification(meta, measurement, applied);
    const reasonCode = String(reason || 'no_result').split(':')[0];
    const diagnostic = measurement?.diagnostic;
    const coverage = coverageSummary(meta);
    return {
        finished_at: finishedAt, mode, door_count: doorCount,
        status: outcome.status, message: `${outcome.message}${verificationComplete ? completedRouteDetails(meta, recovery) : ''}`,
        route_changed: applied === true, route_verification_complete: verificationComplete,
        reason: /^[a-z_]+$/.test(reasonCode) ? reasonCode : 'no_result',
        http_status: Number.isInteger(diagnostic?.httpStatus) && diagnostic.httpStatus >= 100 && diagnostic.httpStatus <= 599
            ? diagnostic.httpStatus : null,
        elapsed_ms: Number.isFinite(diagnostic?.elapsedMs) && diagnostic.elapsedMs >= 0
            ? Math.round(diagnostic.elapsedMs) : null,
        optimizer_version: safeToken(meta.optimizer_version),
        matrix_tier: safeToken(meta.matrix_tier),
        neighborhoods_planned: coverage ? coverage.total_windows : optionalCount(review?.planned),
        neighborhoods_checked: coverage ? coverage.total_windows - coverage.remaining_windows : optionalCount(review?.checked),
        neighborhoods_skipped: Array.isArray(review?.skipped) ? review.skipped.length : null,
        budget_exhausted: review?.budgetExhausted === true && (!coverage || coverage.remaining_windows > 0),
        ...(safeCount(meta.road_search_passes) ? { search_passes: safeCount(meta.road_search_passes) } : {}),
        ...(safeToken(meta.road_search_stop_reason) ? { search_stop_reason: safeToken(meta.road_search_stop_reason) } : {}),
        curb_sides_unconfirmed: unknownSides(review),
        county_roads_included: countyRoadsIncluded(meta),
        ...(recovery ? { road_access_recovery: recovery } : {}),
    };
}
