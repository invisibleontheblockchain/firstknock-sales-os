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
import { routePropertyOrderFingerprint } from '../../base44/shared/routeFingerprint.js';

// The product ceiling for one road-aware optimization request, mirroring the
// backend's MAX_TIERED_ROUTE_DOORS. It is NOT the OSRM per-request coordinate
// limit: the backend assembles larger routes from matrix blocks, and past 250
// doors it bounds the matrix at the street-block level instead of giving up.
// Every earlier version of this number was a silent cliff — a route above it
// skipped OSRM, and with it the never-worse gate, while still being labelled
// optimized (that is how a 183-door route shipped an unmeasured order).
const MAX_ROAD_MATRIX_DOORS = 2500;

// A fully verified 626-door production request took 133 seconds. Give larger
// manifests three minutes while retaining the two-minute bound up to 500 doors.
// The complete Optimize action still has a separate five-minute ceiling.
const ROAD_MATRIX_DEADLINE_MS = 120000;
const LARGE_ROAD_MATRIX_DEADLINE_MS = 180000;
const LARGE_ROAD_MATRIX_THRESHOLD = 500;
const OPTIMIZE_ACTION_DEADLINE_MS = 300000;
// This is a request-count fuse, not a target. Real continuations are governed
// by remaining work, proof, progress, and the five-minute action budget.
const MAX_OPTIMIZE_PASSES = 8;
const MIN_CONTINUATION_BUDGET_MS = 60000;
// Keep in step with REUSABLE_ACCESS_FAILURES in base44/shared/routeAccessRecovery.js.
const REUSABLE_FAILURES = new Set(['road_not_matched', 'address_not_matched', 'address_match_rejected',
    'address_road_not_matched', 'address_road_mismatch', 'ambiguous_service_road']);
const boundedSearchContinuation = value => typeof value === 'string' && value.length > 0 && value.length <= 262144
    ? value : null;
const routeRequestDeadline = properties => properties?.length > LARGE_ROAD_MATRIX_THRESHOLD
    ? LARGE_ROAD_MATRIX_DEADLINE_MS : ROAD_MATRIX_DEADLINE_MS;

// Coverage is scheduling history, never reusable driving proof. Whitelist its
// opaque identifiers and counters so private anchors/provider payloads cannot
// enter shared route metadata through this ledger.
export function normalizeRoadSearchCoverage(value) {
    const count = number => Number.isSafeInteger(number) && number >= 0 && number <= 1000000;
    if (value?.version !== 1 || typeof value.policy !== 'string' || !/^[a-z\d_-]{1,120}$/i.test(value.policy)
        || !Array.isArray(value.completed_window_keys) || value.completed_window_keys.length > 8192
        || value.completed_window_keys.some(key => typeof key !== 'string' || !/^(?:[a-f\d]{32}|[a-f\d]{64})$/.test(key))
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

// Match the backend's protected boundary: an unknown stop and two positions
// on either side stay fixed, together with every explicitly locked position.
function partialOrderGuard(input, order, recovery) {
    if (!Array.isArray(recovery?.unresolved) || !recovery.unresolved.length) return null;
    const protectedPositions = new Set(), unresolved = new Map();
    for (const issue of recovery.unresolved) {
        const index = issue?.stop_number - 1, id = String(issue?.property_id || '');
        if (!Number.isInteger(issue?.stop_number) || index < 0 || index >= input.length || !id
            || propertyKey(input[index]) !== id || unresolved.has(id)) return null;
        unresolved.set(id, index);
    }
    input.forEach((property, index) => {
        if (property.order_locked === true || property.locked === true) protectedPositions.add(index);
        if (unresolved.has(propertyKey(property)) || property.routing_access?.resolution_status === 'unresolved') {
            for (let neighbor = Math.max(0, index - 2); neighbor <= Math.min(input.length - 1, index + 2); neighbor++) {
                protectedPositions.add(neighbor);
            }
        }
    });
    if ([...protectedPositions].some(index => propertyKey(input[index]) !== propertyKey(order[index]))) return null;
    return [...unresolved].sort(([left], [right]) => left.localeCompare(right));
}

// Base44 wraps Axios failures, but keeps the response body in `data`. A 429
// can mean a processing limit rather than throttling, so identify that exact
// code before classifying the HTTP status. Keep raw messages and URLs out of
// the outcome callback and its saved attempt history.
// The server's own reason, made safe to show and store: no URLs, coordinates
// or control characters, and short. "Could not complete the driving check"
// alone gave a manager nothing to act on.
const safeServerMessage = value => {
    if (typeof value !== 'string') return null;
    const text = value
        .replace(/[a-z][a-z\d+.-]*:\/\/[^\s)]+/gi, '<url>')
        .replace(/-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+/g, '<coordinates>')
        .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    return text || null;
};
const failureMeasurement = (failure, elapsedMs) => {
    const response = failure?.response || failure?.originalError?.response;
    const data = response?.data ?? failure?.data ?? failure;
    const rawStatus = response?.status ?? failure?.status;
    const httpStatus = Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : null;
    const rawCode = typeof data?.error === 'string' ? data.error : data?.error?.code ?? data?.code;
    const errorCode = rawCode === 'cpu-exceeded' ? 'cpu-exceeded' : httpStatus === 429 ? 'rate-limited' : null;
    // Only the field the server marks public is shown; `error` stays private.
    const serverMessage = errorCode ? null : safeServerMessage(data?.public_error);
    return { diagnostic: { httpStatus, errorCode, elapsedMs: Math.max(0, Math.round(elapsedMs)),
        ...(serverMessage ? { serverMessage } : {}) },
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
    deadlineMs = routeRequestDeadline(routeProperties),
    onOutcome = null,
    neighborhoodReview = null,
    searchCoverage = null,
    comparisonOrder = null,
    searchPhase = null,
    searchContinuation = null,
    onSearchContinuation = null,
    knownUnresolved = null,
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
            timeout_ms: 12000,
            search_continuation_version: 1
        };
        const coverage = normalizeRoadSearchCoverage(searchCoverage);
        if (coverage) payload.search_coverage = coverage;
        if (searchPhase === 'remaining_neighborhoods') payload.search_phase = searchPhase;
        if (searchPhase === 'remaining_neighborhoods' && boundedSearchContinuation(searchContinuation)) {
            payload.search_continuation = searchContinuation;
        }
        if (Array.isArray(comparisonOrder)) payload.comparison_order = comparisonOrder.map(propertyKey);
        if (knownUnresolved?.size) payload.known_unresolved_stops = [...knownUnresolved].map(([property_id, reason]) => ({ property_id, reason }));
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
        // This private transport channel never enters route metadata or a
        // returned measurement. The action promotes it only after its existing
        // proof and coverage checks accept another pass.
        onSearchContinuation?.(boundedSearchContinuation(data.search_continuation));
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
            if (!partialOrderGuard(routeProperties, order, responseMeta.road_access_recovery)) {
                return decline('partial_order_changed_protected_stops', { routingMetadata });
            }
            const review = responseMeta.neighborhood_excursion_review?.local_driving_review;
            const unchanged = order.every((p, i) => p === routeProperties[i]);
            if (data.selected === 'current' || unchanged) {
                if (!unchanged) return decline('order_failed_exact_once', { routingMetadata });
                return decline('road_access_unresolved', { routingMetadata, verifiedCurrentOrder: true });
            }
            if (review?.applied !== true || review.validation !== 'overlapping_boundary_legs') {
                return decline('unverified_partial_order', { routingMetadata });
            }
            // The first winner needs the same complete proof as every later
            // pass. Aggregation must not turn an incomplete or contradictory
            // response into apparently verified local savings.
            if (!partialSearchProof(responseMeta, routeProperties, order, false)) {
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

// A new neighborhood can discover curb-side restrictions that change the
// mileage of an unchanged order. Reconcile that only with a fresh, complete
// comparison of all three orders under one backend road/service policy.
// Never add savings measured under incompatible policies from separate passes.
function freshDrivingComparison(meta, original, input, output, inputMiles, outputMiles) {
    const proof = meta?.road_search_comparison;
    if (measurementMiles(inputMiles) === null || measurementMiles(outputMiles) === null
        || !proof || proof.version !== 1 || proof.service_objective !== 'coherent_side_passes_then_driving_cost'
        || !(proof.graph_version === null || typeof proof.graph_version === 'string' && proof.graph_version.length > 0
            && proof.graph_version.length <= 512)) return null;
    const orders = { original, input, output };
    const originalIds = new Set(original.map(propertyKey));
    const safe = { version: 1, service_objective: proof.service_objective, graph_version: proof.graph_version };
    for (const [name, order] of Object.entries(orders)) {
        const ids = order.map(propertyKey);
        if (ids.length !== original.length || ids.some(id => !id) || new Set(ids).size !== ids.length
            || ids.some(id => !originalIds.has(id))) return null;
        const fingerprint = routePropertyOrderFingerprint(order);
        if (!fingerprint || proof[`${name}_order_fingerprint`] !== fingerprint) return null;
        safe[`${name}_order_fingerprint`] = fingerprint;
        for (const unit of ['miles', 'seconds', 'pass_violations']) {
            const key = `${name}_${unit}`, value = proof[key];
            if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
                || unit === 'pass_violations' && !Number.isSafeInteger(value)) return null;
            safe[key] = value;
        }
    }
    if (Math.abs(proof.input_miles - inputMiles) > 0.002 || Math.abs(proof.output_miles - outputMiles) > 0.002) return null;
    if (meta.property_order_fingerprint && meta.property_order_fingerprint !== safe.output_order_fingerprint) return null;
    const notWorse = reference => proof.output_pass_violations < proof[`${reference}_pass_violations`]
        || proof.output_pass_violations === proof[`${reference}_pass_violations`]
            && proof.output_miles <= proof[`${reference}_miles`] + 0.0001
            && proof.output_seconds <= proof[`${reference}_seconds`] + 0.1;
    if (!notWorse('input') || !notWorse('original')) return null;
    // One context must report the same costs when two labels name one order.
    for (const [left, right] of [['original', 'input'], ['original', 'output'], ['input', 'output']]) {
        if (safe[`${left}_order_fingerprint`] !== safe[`${right}_order_fingerprint`]) continue;
        if (Math.abs(safe[`${left}_miles`] - safe[`${right}_miles`]) > 0.0001
            || Math.abs(safe[`${left}_seconds`] - safe[`${right}_seconds`]) > 0.1
            || safe[`${left}_pass_violations`] !== safe[`${right}_pass_violations`]) return null;
    }
    return safe;
}

function sameDrivingProvider(previous, meta) {
    return ['road_matrix_source', 'road_matrix_version'].every(key =>
        (previous[key] ?? null) === (meta[key] ?? null));
}

function partialSearchProof(meta, input, order, unchanged) {
    const recovery = meta?.road_access_recovery;
    const review = meta?.neighborhood_excursion_review?.local_driving_review;
    const unresolved = partialOrderGuard(input, order, recovery);
    const provider = meta?.road_matrix_source || meta?.matrix_provider;
    if (meta?.strategy !== 'access_guarded_neighborhood_repair' || meta.fallback === true
        || meta.road_path_validated !== false || meta.distance_estimate !== 'unavailable'
        || recovery?.inventory_complete !== true || (recovery.unverified_count ?? 0) !== 0
        || !unresolved || typeof provider !== 'string' || !provider
        || typeof meta.road_matrix_version !== 'string' || !meta.road_matrix_version
        || ['input_measured', 'continuity_measured', 'winning_route_distance', 'road_aware_measured']
            .some(key => meta[key] !== null && meta[key] !== undefined)) return null;
    if (unchanged) {
        if (review?.applied !== false || review.validation !== 'unchanged'
            || measurementMiles(review.localMilesSaved) !== 0) return null;
    } else if (review?.applied !== true || review.validation !== 'overlapping_boundary_legs'
        || measurementMiles(review.localMilesSaved) === null) return null;
    return { unresolved };
}

function consistentPartialSearch(previous, meta, before, after) {
    return JSON.stringify(before.unresolved) === JSON.stringify(after.unresolved)
        && ['road_matrix_source', 'matrix_provider', 'road_matrix_version', 'routing_profile'].every(key =>
            (previous[key] ?? null) === (meta[key] ?? null))
        && ['graphIdentity', 'publicDataVersion'].every(key =>
            (previous.county_road_routing?.[key] ?? null) === (meta.county_road_routing?.[key] ?? null));
}

function appliedPartialMetadata(meta, localMilesSaved) {
    const neighborhood = { ...meta.neighborhood_excursion_review, local_driving_review: {
        ...meta.neighborhood_excursion_review.local_driving_review,
        applied: true, validation: 'overlapping_boundary_legs', localMilesSaved,
    } };
    return { ...meta, road_path_validated: false, road_network_used: true,
        input_measured: null, winning_route_distance: null, distance_estimate: 'unavailable',
        neighborhood_excursion_review: neighborhood,
        routing: { ...meta.routing, neighborhood_excursion_review: neighborhood } };
}

/** Continue verified improvements AND no-op checks while fresh questions remain.
 * Every pass prices the latest accepted order under the same bounds. Keep the
 * original click's mileage baseline and save only once after the bounded action. */
export async function tryRoadMatrixOptimize(routeProperties, {
    searchCoverage = null, maxSearchPasses = MAX_OPTIMIZE_PASSES,
    totalDeadlineMs = OPTIMIZE_ACTION_DEADLINE_MS, deadlineMs,
    onOutcome = null, onProgress = null, onSearchProgress = null, ...options
} = {}) {
    const limit = Number.isFinite(maxSearchPasses) ? Math.max(1, Math.min(MAX_OPTIMIZE_PASSES, Math.floor(maxSearchPasses))) : 1;
    const budget = Number.isFinite(totalDeadlineMs) ? Math.max(1, Math.min(OPTIMIZE_ACTION_DEADLINE_MS, totalDeadlineMs)) : OPTIMIZE_ACTION_DEADLINE_MS;
    const defaultDeadline = routeRequestDeadline(routeProperties);
    const requestBudget = Number.isFinite(deadlineMs) ? Math.max(1, Math.min(defaultDeadline, deadlineMs)) : defaultDeadline;
    const continuationBudget = Math.min(MIN_CONTINUATION_BUDGET_MS, requestBudget);
    const started = Date.now();
    let coverage = normalizeRoadSearchCoverage(searchCoverage), lastReason, lastMeasurement;
    let currentProperties = routeProperties, accepted = null, baselineMiles = null;
    let acceptedPartialProof = null, localSavings = 0;
    // Only the preceding accepted response in this click can supply a token.
    // A saved route, a different action, or a caller option cannot seed it.
    let searchContinuation = null;
    const knownUnresolved = new Map();
    // Remaining checks after the previous pass. A pass that changed nothing and
    // left as many checks open is repeating questions that cannot complete
    // (for example next to an unresolved stop); another pass would do the same.
    let previousRemaining = Infinity;
    const shouldContinue = (proof, result, returnedCoverage, pass) => {
        if (returnedCoverage?.cycle_complete) return false;
        const stalled = !result && returnedCoverage && returnedCoverage.remaining_windows >= previousRemaining;
        if (returnedCoverage) previousRemaining = returnedCoverage.remaining_windows;
        const stopReason = !proof ? 'incomplete_verification'
            : !returnedCoverage ? 'invalid_search_coverage'
            : !result && (returnedCoverage.progress_this_pass === 0 || stalled) ? 'no_progress'
            : pass >= limit ? 'pass_limit'
            : budget - (Date.now() - started) < continuationBudget ? 'action_budget' : null;
        if (stopReason) {
            const target = accepted?.routingMetadata || lastMeasurement?.routingMetadata;
            if (target) target.road_search_stop_reason = stopReason;
            return false;
        }
        return returnedCoverage.remaining_windows > 0;
    };
    // Live progress for the progress screen: after each finished pass, the
    // checks done so far and the best verified result.
    const reportProgress = (passesDone, done) => {
        if (!onSearchProgress) return;
        const total = coverage ? coverage.total_windows : null;
        onSearchProgress({ passesDone, maxPasses: limit, done,
            checksTotal: total, checksDone: total === null ? null : total - coverage.remaining_windows,
            savedMiles: accepted ? Math.max(0, Number(accepted.objective?.estimatedSavings) || 0) : 0,
            bestMiles: Number.isFinite(accepted?.objective?.appliedDistance) ? accepted.objective.appliedDistance : null });
    };
    let passesDone = 0;
    for (let pass = 1; pass <= limit; pass++) {
        if (pass > 1) reportProgress(passesDone, false);
        if (pass > 1) onProgress?.({ pass, maxPasses: limit, remainingWindows: coverage.remaining_windows });
        passesDone = pass;
        let reason, measurement, nextSearchContinuation = null;
        const result = await tryRoadMatrixOptimizePass(currentProperties, { ...options, searchCoverage: coverage,
            ...(pass > 1 ? { searchPhase: 'remaining_neighborhoods', comparisonOrder: routeProperties, knownUnresolved } : {}),
            searchContinuation: pass > 1 ? searchContinuation : null,
            onSearchContinuation: value => { nextSearchContinuation = value; },
            deadlineMs: Math.min(requestBudget, Math.max(1, budget - (Date.now() - started))),
            onOutcome: (value, details) => { reason = value; measurement = details; } });
        const meta = result?.routingMetadata || measurement?.routingMetadata;
        const returnedCoverage = normalizeRoadSearchCoverage(meta?.road_search_coverage);
        // Address/road failures repeat identically within this action; later
        // passes skip re-matching them (outages and limits are never reused).
        // An approximate stand-in keeps its original reason, so a later pass goes
        // straight to the stand-in instead of re-matching the address.
        const recovery = meta?.road_access_recovery;
        for (const issue of [...(recovery?.unresolved || []), ...(recovery?.approximate || [])]) {
            if (REUSABLE_FAILURES.has(issue?.reason) && typeof issue?.property_id === 'string') knownUnresolved.set(issue.property_id, issue.reason);
        }
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
        const partial = meta?.strategy === 'access_guarded_neighborhood_repair';
        const acceptedPartial = accepted?.routingMetadata.strategy === 'access_guarded_neighborhood_repair';
        if ((acceptedPartial && verified) || (accepted && !acceptedPartial && partial)) {
            accepted.routingMetadata = { ...accepted.routingMetadata, road_search_passes: pass,
                road_search_stop_reason: 'scope_changed' };
            break;
        }
        if (partial || acceptedPartial) {
            const unchanged = !result && reason === 'road_access_unresolved' && measurement?.verifiedCurrentOrder === true;
            const proof = (result || unchanged) ? partialSearchProof(meta, currentProperties,
                result?.order || currentProperties, unchanged) : null;
            if (acceptedPartial && (!proof || !consistentPartialSearch(accepted.routingMetadata, meta, acceptedPartialProof, proof))) {
                accepted.routingMetadata = { ...accepted.routingMetadata, road_search_passes: pass,
                    road_search_stop_reason: !proof ? reason || 'incomplete_verification' : 'measurement_changed' };
                break;
            }
            if (result || acceptedPartial) {
                localSavings += result?.objective.estimatedSavings || 0;
                accepted = { ...(result || accepted),
                    ...(!result ? { order: withRecoveredAccess(currentProperties, meta) } : {}),
                    objective: { applyCandidate: true, appliedDistance: null, estimatedSavings: localSavings },
                    routingMetadata: appliedPartialMetadata(finalMeta, localSavings) };
                currentProperties = accepted.order;
                acceptedPartialProof = proof;
            }
            if (!shouldContinue(proof, result, returnedCoverage, pass)) break;
            if (!accepted) currentProperties = withRecoveredAccess(currentProperties, meta);
            searchContinuation = nextSearchContinuation;
            continue;
        }
        const comparison = verified && pass > 1
            ? freshDrivingComparison(meta, routeProperties, currentProperties, result?.order || currentProperties, inputMiles, measuredMiles)
            : null;
        const invalidComparison = pass > 1 && meta?.road_search_comparison !== undefined && !comparison;
        if (finalMeta) {
            delete finalMeta.road_search_comparison;
            if (comparison) finalMeta.road_search_comparison = comparison;
        }
        if (accepted && (!verified || invalidComparison || !(comparison
            ? sameDrivingProvider(accepted.routingMetadata, meta) : consistentDrivingPass(accepted, meta, inputMiles)))) {
            // A later outage, incomplete proof or changed graph must not erase
            // the improvement already verified during this click.
            accepted.routingMetadata = { ...accepted.routingMetadata, road_search_passes: pass,
                road_search_stop_reason: verified ? 'measurement_changed' : reason || 'incomplete_verification' };
            break;
        }
        if (invalidComparison) {
            lastReason = 'invalid_search_comparison';
            lastMeasurement = { routingMetadata: { ...finalMeta, road_search_stop_reason: 'measurement_changed' } };
            break;
        }
        // Earlier no-ops still leave the original order in place. Its fresh
        // measurement on the first accepted pass is the savings baseline.
        if (!accepted && result && verified) baselineMiles = inputMiles;
        if (comparison) baselineMiles = comparison.original_miles;
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
        if (!shouldContinue(verified, result, returnedCoverage, pass)) break;
        if (!accepted) currentProperties = withRecoveredAccess(currentProperties, meta);
        searchContinuation = nextSearchContinuation;
    }
    reportProgress(passesDone, true);
    if (accepted) return accepted;
    onOutcome?.(lastReason, lastMeasurement);
    return null;
}
