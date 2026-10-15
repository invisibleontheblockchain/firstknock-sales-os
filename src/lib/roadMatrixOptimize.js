/**
 * OSRM road-matrix beta for the explicit Optimize action.
 *
 * Calls the backend `optimizeRouteRoadMatrix` function, which fetches a real
 * driving-distance matrix (public OSRM demo server for now — switch via the
 * OSRM_BASE_URL secret later) and compares today's continuity order against a
 * road-priced street sweep using the SAME matrix.
 *
 * Returns an accepted, verified order or an explicit unchanged/failure outcome.
 * Unchanged complete driving checks may continue with fresh neighborhoods;
 * errors never fall through to an unverified local reorder.
 */

import { base44 } from '@/api/base44Client';

// The product ceiling for one road-aware optimization request, mirroring the
// backend's MAX_TIERED_ROUTE_DOORS. It is NOT the OSRM per-request coordinate
// limit: the backend assembles larger routes from matrix blocks, and past 250
// doors it bounds the matrix at the street-block level instead of giving up.
// Every earlier version of this number was a silent cliff — a route above it
// skipped OSRM, and with it the never-worse gate, while still being labelled
// optimized (that is how a 183-door route shipped an unmeasured order).
const MAX_ROAD_MATRIX_DOORS = 2500;

// Keep the interactive wait bounded, with room for provider/network variation.
// The complete 377-door area/curb review measured 88.4 seconds live; a 90-second
// ceiling can discard a valid result before it reaches a field user's browser.
const ROAD_MATRIX_DEADLINE_MS = 120000;
const OPTIMIZE_ACTION_DEADLINE_MS = 300000;
const MAX_OPTIMIZE_PASSES = 3;

// Coverage is scheduling history, never reusable driving proof. Whitelist its
// opaque identifiers and counters so private anchors/provider payloads cannot
// enter shared route metadata through this ledger.
export function normalizeRoadSearchCoverage(value) {
    const count = number => Number.isSafeInteger(number) && number >= 0 && number <= 1000000;
    if (value?.version !== 1 || typeof value.policy !== 'string' || !/^[a-z\d_-]{1,120}$/i.test(value.policy)
        || !Array.isArray(value.completed_window_keys) || value.completed_window_keys.length > 8192
        || value.completed_window_keys.some(key => typeof key !== 'string' || !/^[a-f\d]{32}$/.test(key))
        || new Set(value.completed_window_keys).size !== value.completed_window_keys.length
        || !['total_windows', 'remaining_windows', 'checked_this_pass', 'progress_this_pass'].every(key => count(value[key]))
        || value.remaining_windows > value.total_windows || value.progress_this_pass > value.checked_this_pass
        || value.cycle_complete !== (value.remaining_windows === 0)) return null;
    return { version: 1, policy: value.policy, completed_window_keys: [...value.completed_window_keys],
        total_windows: value.total_windows, remaining_windows: value.remaining_windows,
        checked_this_pass: value.checked_this_pass, progress_this_pass: value.progress_this_pass,
        cycle_complete: value.cycle_complete };
}

const propertyKey = (property) => String(property.address_hash || property.legacy_hash || property.id || '');
const withRecoveredAccess = (order, meta) => order.map(property => {
    const access = meta.road_access_recovery?.access_overrides?.[propertyKey(property)];
    return access ? { ...property, routing_access: access } : property;
});
const measurementMiles = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const miles = Number(value);
    return Number.isFinite(miles) && miles >= 0 ? miles : null;
};

// Base44 wraps Axios failures, but keeps the response body in `data`. A 429
// can mean a processing limit rather than throttling, so identify that exact
// code before classifying the HTTP status. Keep raw messages and URLs out of
// the outcome callback and its saved attempt history.
const failureMeasurement = (failure, elapsedMs) => {
    const response = failure?.response || failure?.originalError?.response;
    const data = response?.data ?? failure?.data ?? failure;
    const rawStatus = response?.status ?? failure?.status;
    const httpStatus = Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : null;
    const rawCode = typeof data?.error === 'string' ? data.error : data?.error?.code ?? data?.code;
    const errorCode = rawCode === 'cpu-exceeded' ? 'cpu-exceeded' : httpStatus === 429 ? 'rate-limited' : null;
    return { diagnostic: { httpStatus, errorCode, elapsedMs: Math.max(0, Math.round(elapsedMs)) },
        ...(data?.routing_metadata ? { routingMetadata: data.routing_metadata } : {}) };
};
const failureReason = (measurement, fallback) => measurement.diagnostic.errorCode === 'cpu-exceeded'
    ? 'backend_cpu_limit' : measurement.diagnostic.httpStatus === 429 ? 'backend_rate_limited' : fallback;

/**
 * The persisted `routing` provenance block for a road-matrix order.
 *
 * A route whose order came from OSRM must not keep the aerial continuity block
 * written by buildPersistedRoadRoutingMetadata — that left records claiming both
 * `osrm:driving` and `engine: aerial-fallback`, with a fingerprint from an
 * earlier order, which made the record impossible to audit.
 */
export function buildRoadMatrixRoutingBlock(meta = {}) {
    return {
        engine: meta.road_matrix_source || 'osrm:driving',
        status: meta.strategy === 'access_guarded_neighborhood_repair' ? 'partial' : 'ok',
        road_aware: meta.road_network_used === true,
        mode: 'road_matrix',
        cost_only: false,
        // 'road' when every leg was priced door-to-door, 'road_block_tier' when a
        // large route was priced between street blocks with house-order legs
        // inside them. Never claim more than the matrix measured.
        distance_estimate: meta.distance_estimate || 'road',
        matrix_tier: meta.matrix_tier || null,
        intra_block_aerial_leg_count: meta.intra_block_aerial_leg_count ?? 0,
        objective: meta.objective || null,
        supplied_point_count: meta.road_matrix_snapped ?? null,
        snapped_point_count: meta.road_matrix_snapped ?? null,
        unresolved_leg_count: meta.road_matrix_unresolved_legs ?? 0,
        matrix_version: meta.road_matrix_version || null,
        matrix_cache_key: meta.road_matrix_cache_key || null,
        matrix_ms: meta.road_matrix_ms ?? null,
        neighborhood_excursion_review: meta.neighborhood_excursion_review || null,
        road_access_recovery: meta.road_access_recovery || null,
        fallback: meta.fallback === true,
        property_order_fingerprint: meta.property_order_fingerprint || null,
        optimized_at: new Date().toISOString()
    };
}

/**
 * @param {Array} routeProperties the route's current order
 * @param {object} options `{ start, end, deadlineMs, onOutcome }`.
 *   `onOutcome(reason, measurement)` supplies a reason on every null return,
 *   plus the current-order measurement when it won. A bare null told callers
 *   nothing, so a
 *   backend outage and "your route is already optimal" were the same event and
 *   both were recorded as neither. Callers that ignore it are unaffected.
 */
async function tryRoadMatrixOptimizePass(routeProperties, {
    start = null,
    end = null,
    deadlineMs = ROAD_MATRIX_DEADLINE_MS,
    onOutcome = null,
    neighborhoodReview = null,
    searchCoverage = null,
    client = base44
} = {}) {
    const decline = (reason, measurement = null) => { onOutcome?.(reason, measurement); return null; };

    if (!Array.isArray(routeProperties) || routeProperties.length < 2) {
        return decline('too_few_doors');
    }
    if (routeProperties.length > MAX_ROAD_MATRIX_DOORS) {
        return decline('route_exceeds_supported_size');
    }

    const startedAt = Date.now();
    try {
        const payload = {
            // Current saved order — the backend measures it so savings are honest.
            properties: routeProperties.map((property) => ({
                address_hash: propertyKey(property),
                house_number: property.house_number,
                street_name: property.street_name,
                city: property.city,
                state: property.state || property.state_code,
                zip_code: property.zip_code || property.zip,
                subdivision_name: property.subdivision_name,
                lat: property.lat,
                lng: property.lng,
                routing_access: property.routing_access,
                order_locked: property.order_locked === true || property.locked === true,
            })),
            timeout_ms: 12000
        };
        const coverage = normalizeRoadSearchCoverage(searchCoverage);
        if (coverage) payload.search_coverage = coverage;
        if (neighborhoodReview) payload.neighborhood_review = {
            prefer_contiguous_on_tie: neighborhoodReview.preferContiguousOnTie === true,
            tie_seconds: Math.min(10, Math.max(0, Number(neighborhoodReview.tieSeconds) || 0)),
        };
        if (start) payload.start_location = { lat: start.lat, lng: start.lng };
        if (end) payload.end_location = { lat: end.lat, lng: end.lng };

        let deadlineTimer = null;
        const response = await Promise.race([
            client.functions.invoke('optimizeRouteRoadMatrix', payload),
            new Promise((resolve) => {
                deadlineTimer = setTimeout(() => resolve(null), deadlineMs);
            })
        ]).finally(() => clearTimeout(deadlineTimer));
        if (!response) {
            console.warn(`[roadMatrixOptimize] Road matrix exceeded ${deadlineMs}ms`);
            return decline('deadline_exceeded');
        }
        const data = response?.data || response;
        // Any winner other than the caller's current order is an order the backend
        // measured strictly better on ONE shared road matrix — including a
        // reversed or continuity-shaped candidate. Requiring the 'road_aware'
        // label discarded those, which is why routes kept their zig-zag order
        // even though OSRM had already priced a shorter one.
        if (!data?.success) {
            const measurement = failureMeasurement(response, Date.now() - startedAt);
            if (data?.routing_metadata) measurement.routingMetadata = data.routing_metadata;
            return decline(failureReason(measurement, 'backend_reported_failure'), measurement);
        }
        const responseMeta = data.routing_metadata || {};
        const routingMetadata = { ...responseMeta, source: 'optimizeRouteRoadMatrix',
            routing: buildRoadMatrixRoutingBlock(responseMeta) };
        if (responseMeta.fallback === true) return decline('aerial_fallback', { routingMetadata });
        // Access-limited results carry proof for changed neighborhoods only.
        // A missing whole-trip total must not discard that proof or become zero miles.
        if (responseMeta.strategy === 'access_guarded_neighborhood_repair') {
            const byKey = new Map(routeProperties.map(property => [propertyKey(property), property]));
            const order = Array.isArray(data.order) ? data.order.map(hash => byKey.get(String(hash))) : [];
            if (order.length !== routeProperties.length || order.some(p => !p) || new Set(order).size !== routeProperties.length) {
                return decline('order_failed_exact_once', { routingMetadata });
            }
            const review = responseMeta.neighborhood_excursion_review?.local_driving_review;
            if (data.selected === 'current' || order.every((p, i) => p === routeProperties[i])) {
                return decline('road_access_unresolved', { routingMetadata });
            }
            if (review?.applied !== true || review.validation !== 'overlapping_boundary_legs') {
                return decline('unverified_partial_order', { routingMetadata });
            }
            return { order: withRecoveredAccess(order, responseMeta), objective: { applyCandidate: true, appliedDistance: null,
                estimatedSavings: Math.max(0, measurementMiles(review.localMilesSaved) ?? 0) }, routingMetadata };
        }
        // The backend measured both orders and the saved one won. That IS a road
        // verification: the order is confirmed, not merely unimproved.
        if (data.selected === 'current') {
            if (data.order !== undefined && (!Array.isArray(data.order) || data.order.length !== routeProperties.length
                || data.order.some((hash, index) => String(hash) !== propertyKey(routeProperties[index])))) {
                return decline('order_failed_exact_once', { routingMetadata });
            }
            const meta = data.routing_metadata || {};
            const measured = measurementMiles(meta.input_measured) ?? measurementMiles(meta.continuity_measured);
            if (measured === null) return decline('backend_returned_no_measurement', { routingMetadata });
            return decline('current_order_measured_best', {
                distanceMiles: measured,
                verifiedCurrentOrder: Array.isArray(data.order) && data.order.length === routeProperties.length
                    && data.order.every((hash, index) => String(hash) === propertyKey(routeProperties[index])),
                routingMetadata: { ...meta, source: 'optimizeRouteRoadMatrix', routing: buildRoadMatrixRoutingBlock(meta) }
            });
        }
        if (!Array.isArray(data.order)) return decline('backend_returned_no_order', { routingMetadata });

        const byKey = new Map(routeProperties.map((property) => [propertyKey(property), property]));
        const order = data.order.map((hash) => byKey.get(String(hash))).filter(Boolean);
        if (order.length !== routeProperties.length || new Set(order).size !== routeProperties.length) {
            return decline('order_failed_exact_once', { routingMetadata });
        }

        const meta = data.routing_metadata || {};
        const roadMiles = measurementMiles(meta.winning_route_distance) ?? measurementMiles(meta.road_aware_measured);
        const baseline = measurementMiles(meta.input_measured) ?? measurementMiles(meta.continuity_measured);
        if (roadMiles === null || baseline === null) {
            return decline('backend_returned_no_measurement', { routingMetadata });
        }
        // Applied review diagnostics can describe an earlier candidate. They
        // cannot turn the exact current manifest into a newly reordered route.
        if (order.every((property, index) => propertyKey(property) === propertyKey(routeProperties[index]))) {
            return decline('current_order_measured_best', {
                distanceMiles: baseline,
                verifiedCurrentOrder: true,
                routingMetadata: { ...meta, source: 'optimizeRouteRoadMatrix', routing: buildRoadMatrixRoutingBlock(meta) }
            });
        }
        const savings = baseline - roadMiles;
        // The backend verifies coherent curb passes before travel cost. Keep
        // that approved service improvement even when it requires more driving.
        const durationGain = Number(meta.duration_improvement);
        const preferredTie = neighborhoodReview?.preferContiguousOnTie === true && meta.neighborhood_excursion_review?.applied === true;
        const serviceReview = meta.neighborhood_excursion_review?.local_driving_review;
        const preferredServiceTie = serviceReview?.applied === true
            && ['whole_route', 'overlapping_boundary_legs'].includes(serviceReview.validation);
        if (!(savings > 0) && !(durationGain > 0) && !preferredTie && !preferredServiceTie) return decline('current_order_measured_best', {
            distanceMiles: baseline,
            routingMetadata: { ...meta, source: 'optimizeRouteRoadMatrix', routing: buildRoadMatrixRoutingBlock(meta) }
        });

        // A partially matched route has an estimated matrix total and separately
        // verified local savings. Keep those scopes separate instead of treating
        // their difference as a measured whole-route improvement.
        const verifiedLocalSavings = preferredServiceTie && serviceReview.validation === 'overlapping_boundary_legs'
            ? Math.max(0, measurementMiles(serviceReview.localMilesSaved) ?? 0) : null;

        return {
            order: withRecoveredAccess(order, meta),
            objective: {
                applyCandidate: true,
                appliedDistance: roadMiles,
                estimatedSavings: verifiedLocalSavings ?? (preferredServiceTie ? Math.max(0, savings) : savings)
            },
            routingMetadata: {
                ...meta,
                source: 'optimizeRouteRoadMatrix',
                routing: buildRoadMatrixRoutingBlock(meta)
            }
        };
    } catch (error) {
        const measurement = failureMeasurement(error, Date.now() - startedAt);
        console.warn('[roadMatrixOptimize] Road-matrix backend unavailable', measurement.diagnostic);
        return decline(failureReason(measurement, 'backend_unavailable'), measurement);
    }
}

function completeDrivingPass(meta, miles) {
    const review = meta?.neighborhood_excursion_review?.local_driving_review;
    const recovery = meta?.road_access_recovery;
    return measurementMiles(miles) !== null && meta?.road_path_validated === true
        && meta.fallback !== true && review?.validation === 'whole_route'
        && !recovery?.unresolved?.length && recovery?.inventory_complete !== false;
}

function consistentDrivingPass(previous, meta, inputMiles) {
    // Each pass measures its input again. Chain savings only when that
    // measurement agrees with the last verified winner on the same road graph.
    return measurementMiles(inputMiles) !== null
        && Math.abs(inputMiles - previous.objective.appliedDistance) <= 0.002
        && ['road_matrix_source', 'road_matrix_version'].every(key =>
            (previous.routingMetadata[key] ?? null) === (meta[key] ?? null));
}

/** Continue verified improvements AND no-op checks while fresh questions remain.
 * Every pass prices the latest accepted order under the same bounds. Keep the
 * original click's mileage baseline and save only once after the bounded action. */
export async function tryRoadMatrixOptimize(routeProperties, {
    searchCoverage = null, maxSearchPasses = 1,
    totalDeadlineMs = OPTIMIZE_ACTION_DEADLINE_MS, deadlineMs = ROAD_MATRIX_DEADLINE_MS,
    onOutcome = null, onProgress = null, ...options
} = {}) {
    const limit = Number.isFinite(maxSearchPasses) ? Math.max(1, Math.min(MAX_OPTIMIZE_PASSES, Math.floor(maxSearchPasses))) : 1;
    const budget = Number.isFinite(totalDeadlineMs) ? Math.max(1, Math.min(OPTIMIZE_ACTION_DEADLINE_MS, totalDeadlineMs)) : OPTIMIZE_ACTION_DEADLINE_MS;
    const requestBudget = Number.isFinite(deadlineMs) ? Math.max(1, Math.min(ROAD_MATRIX_DEADLINE_MS, deadlineMs)) : ROAD_MATRIX_DEADLINE_MS;
    const started = Date.now();
    let coverage = normalizeRoadSearchCoverage(searchCoverage), lastReason, lastMeasurement;
    let currentProperties = routeProperties, accepted = null, baselineMiles = null;
    for (let pass = 1; pass <= limit; pass++) {
        if (pass > 1) onProgress?.({ pass, maxPasses: limit, remainingWindows: coverage.remaining_windows });
        let reason, measurement;
        const result = await tryRoadMatrixOptimizePass(currentProperties, { ...options, searchCoverage: coverage,
            deadlineMs: Math.min(requestBudget, Math.max(1, budget - (Date.now() - started))),
            onOutcome: (value, details) => { reason = value; measurement = details; } });
        const meta = result?.routingMetadata || measurement?.routingMetadata;
        const returnedCoverage = normalizeRoadSearchCoverage(meta?.road_search_coverage);
        if (returnedCoverage) coverage = returnedCoverage;
        const finalMeta = meta ? { ...meta, road_search_passes: pass } : null;
        if (finalMeta) {
            delete finalMeta.road_search_coverage;
            if (returnedCoverage) finalMeta.road_search_coverage = returnedCoverage;
        }
        lastReason = reason;
        lastMeasurement = finalMeta ? { ...(measurement || {}), routingMetadata: finalMeta } : measurement;
        const inputMiles = result
            ? measurementMiles(meta?.input_measured) ?? measurementMiles(meta?.continuity_measured)
            : measurementMiles(measurement?.distanceMiles);
        const measuredMiles = result ? result.objective.appliedDistance : measurement?.distanceMiles;
        const verified = completeDrivingPass(meta, measuredMiles)
            && (Boolean(result) || reason === 'current_order_measured_best' && measurement?.verifiedCurrentOrder === true);
        if (accepted && (!verified || !consistentDrivingPass(accepted, meta, inputMiles))) {
            // A later outage, incomplete proof or changed graph must not erase
            // the improvement already verified during this click.
            accepted.routingMetadata = { ...accepted.routingMetadata, road_search_passes: pass,
                road_search_stop_reason: verified ? 'measurement_changed' : reason || 'incomplete_verification' };
            break;
        }
        // Earlier no-ops still leave the original order in place. Its fresh
        // measurement on the first accepted pass is the savings baseline.
        if (!accepted && result && verified) baselineMiles = inputMiles;
        if (result || accepted) {
            accepted = {
                ...(result || accepted),
                ...(!result ? { order: withRecoveredAccess(currentProperties, meta) } : {}),
                objective: verified && baselineMiles !== null
                    ? { applyCandidate: true, appliedDistance: measuredMiles,
                        estimatedSavings: Math.max(0, baselineMiles - measuredMiles) }
                    : result.objective,
                routingMetadata: { ...finalMeta,
                    // A verified no-op measured the retained winner itself.
                    ...(!result ? { winning_route_distance: measuredMiles } : {}),
                    ...(baselineMiles !== null ? { road_search_baseline_distance: baselineMiles } : {}) },
            };
            currentProperties = accepted.order;
        }
        const canContinue = verified && returnedCoverage?.remaining_windows > 0
            && (result || returnedCoverage.progress_this_pass > 0)
            && !returnedCoverage.cycle_complete && pass < limit && budget - (Date.now() - started) >= requestBudget;
        if (!canContinue) break;
    }
    if (accepted) return accepted;
    onOutcome?.(lastReason, lastMeasurement);
    return null;
}
