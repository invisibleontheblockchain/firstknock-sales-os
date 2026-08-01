import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { secrets } from 'base44:runtime';
import {
    createContinuityOptimizer,
    haversineMiles,
    isValidPoint,
    routePropertyOrderFingerprint,
    verifyExactOnceDoors
} from '../../shared/routeContinuityOptimizer.js';
import { roadAwareStreetSweep } from '../../shared/roadAwareStreetSweep.js';
import {
    buildRoadMatrixCacheKey,
    createMatrixMetricFns,
    DEFAULT_OSRM_BASE_URL,
    fetchRoadMatrix,
    MAX_ROUTE_MATRIX_POINTS,
    ROAD_MATRIX_VERSION
} from '../../shared/roadMatrix.js';
import {
    DURATION_TIE_TOLERANCE_MINUTES,
    measureRouteCandidate,
    OBJECTIVE_VERSION,
    selectBestRouteCandidate
} from '../../shared/routeCandidateSelection.js';

// Bump when candidate generation or the objective changes, so a stored route can
// be told apart from one produced by an older solver.
const OPTIMIZER_VERSION = 'road_matrix_multistart_v2';

function readSecret(name) {
    try {
        const value = secrets.get(name);
        return value ? String(value).trim() : '';
    } catch {
        return '';
    }
}

const propertyIdentity = (property) => String(property?.address_hash || property?.id || '');

/** Order-independent identity of the property SET being optimized. */
function propertySetFingerprint(properties) {
    return routePropertyOrderFingerprint(
        [...properties].sort((first, second) => (
            propertyIdentity(first) < propertyIdentity(second) ? -1 : 1
        ))
    );
}

function exactOnce(order, expectedCount) {
    return order.length === expectedCount
        && new Set(order.map(propertyIdentity)).size === expectedCount;
}

export default async function (req: Request): Promise<Response> {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();
        if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

        const body = await req.json().catch(() => ({}));
        const properties = Array.isArray(body.properties) ? body.properties : [];
        const startLocation = isValidPoint(body.start_location) ? body.start_location : null;
        const endLocation = isValidPoint(body.end_location) ? body.end_location : null;
        const profile = body.profile === 'walking' ? 'walking' : 'driving';
        const timeoutMs = Number.isFinite(Number(body.timeout_ms))
            ? Math.min(Math.max(Math.floor(Number(body.timeout_ms)), 50), 25000)
            : 20000;

        if (properties.length < 2) {
            return Response.json({
                error: 'Road-aware optimization needs at least two properties.',
                code: 'TOO_FEW_PROPERTIES'
            }, { status: 400 });
        }
        if (properties.length > MAX_ROUTE_MATRIX_POINTS) {
            return Response.json({
                error: `Road matrix limit is ${MAX_ROUTE_MATRIX_POINTS} properties per route.`,
                code: 'TOO_MANY_PROPERTIES'
            }, { status: 400 });
        }
        const invalidIndex = properties.findIndex((property) => !isValidPoint(property));
        if (invalidIndex >= 0) {
            return Response.json({
                error: 'Every route property requires a valid map coordinate.',
                code: 'INVALID_PROPERTY_COORDINATES',
                invalid_property_index: invalidIndex
            }, { status: 400 });
        }
        if (!exactOnce(properties, properties.length)) {
            return Response.json({
                error: 'The submitted route contains duplicate or unidentified properties.',
                code: 'DUPLICATE_PROPERTIES'
            }, { status: 400 });
        }

        // Canonical input: candidate GENERATION never sees the caller's array
        // order, so a shuffled or reversed request cannot change the winner. The
        // request order is preserved separately as the current-route candidate.
        const canonicalProperties = [...properties].sort((first, second) => (
            propertyIdentity(first) < propertyIdentity(second) ? -1 : 1
        ));
        const setFingerprint = propertySetFingerprint(properties);
        const cacheKey = await buildRoadMatrixCacheKey(properties, profile);
        const solverStartedAt = Date.now();

        // Candidate — straight-line continuity, the fallback path's answer.
        const continuity = createContinuityOptimizer(haversineMiles);
        const continuityChunks = continuity.buildRouteChunks(
            canonicalProperties,
            canonicalProperties.length,
            startLocation,
            endLocation
        );
        if (!verifyExactOnceDoors(continuityChunks.doorChunks, properties.length)) {
            throw new Error('Continuity candidate failed its exact-once property invariant.');
        }
        const continuityOrder = continuityChunks.doorChunks.flat().map((door) => door.property);

        let matrix = null;
        let matrixError = '';
        const matrixStartedAt = Date.now();
        try {
            matrix = await fetchRoadMatrix(properties, {
                baseUrl: readSecret('OSRM_BASE_URL') || DEFAULT_OSRM_BASE_URL,
                profile,
                timeoutMs
            });
        } catch (error) {
            matrixError = error.message;
        }
        const matrixMs = Date.now() - matrixStartedAt;

        const baseMetadata = {
            property_set_fingerprint: setFingerprint,
            start_constraint: startLocation,
            end_constraint: endLocation,
            return_to_start: false,
            routing_profile: profile,
            matrix_provider: 'osrm',
            road_matrix_version: ROAD_MATRIX_VERSION,
            road_matrix_cache_key: cacheKey,
            optimizer_version: OPTIMIZER_VERSION,
            objective_version: OBJECTIVE_VERSION,
            duration_tie_tolerance_minutes: DURATION_TIE_TOLERANCE_MINUTES
        };

        // Fallback: never block route creation on the routing engine. The caller
        // must not overwrite a verified road-aware order with this — `fallback`
        // and `road_network_used: false` say so explicitly.
        if (!matrix) {
            return Response.json({
                success: true,
                selected: 'continuity',
                order: continuityOrder.map(propertyIdentity),
                property_count: continuityOrder.length,
                routing_metadata: {
                    ...baseMetadata,
                    strategy: 'canonical_street_subdivision_continuity',
                    road_network_used: false,
                    fallback: true,
                    fallback_status: 'continuity_fallback',
                    fallback_reason: 'road_matrix_unavailable',
                    matrix_point_count: properties.length,
                    matrix_block_count: 0,
                    road_matrix_error: matrixError,
                    road_matrix_ms: matrixMs,
                    optimality_status: 'unmeasured_fallback',
                    selected_candidate_type: 'continuity',
                    property_order_fingerprint: routePropertyOrderFingerprint(continuityOrder),
                    exact_once_verified: true
                }
            });
        }

        const { distanceBetween, durationBetween, unresolved } = createMatrixMetricFns(properties, matrix);

        // Both objectives get their own sweep, so the duration winner is not
        // limited to whatever the distance-priced sweep happened to produce.
        const sweepOptions = { startLocation, endLocation };
        const roadDistanceOrder = roadAwareStreetSweep(canonicalProperties, { ...sweepOptions, distanceBetween });
        const roadDurationOrder = durationBetween
            ? roadAwareStreetSweep(canonicalProperties, { ...sweepOptions, distanceBetween: durationBetween })
            : null;

        const rawCandidates = [
            // The route the caller has right now — always in the running, so the
            // acceptance gate is monotonic by construction.
            { type: 'current', order: properties, is_current: true },
            { type: 'continuity', order: continuityOrder },
            { type: 'road_aware', order: roadDistanceOrder },
            ...(roadDurationOrder ? [{ type: 'road_aware', order: roadDurationOrder }] : [])
        ];
        // Whole-route direction. Only safe with no fixed anchors: with a start or
        // finish anchor the reversed order changes legs this measurement excludes.
        const withReversals = (!startLocation && !endLocation)
            ? rawCandidates.flatMap((candidate) => [
                candidate,
                { ...candidate, is_current: false, order: [...candidate.order].reverse() }
            ])
            : rawCandidates;

        const candidates = withReversals
            .filter((candidate) => exactOnce(candidate.order, properties.length))
            .map((candidate) => measureRouteCandidate(candidate, { distanceBetween, durationBetween }));
        if (candidates.length !== withReversals.length) {
            throw new Error('A route candidate failed its exact-once property invariant.');
        }

        const winner = selectBestRouteCandidate(candidates);
        if (!winner) {
            throw new Error('No route candidate could be measured on the road matrix.');
        }
        const current = candidates.find((candidate) => candidate.is_current);
        const bestRoadAware = candidates
            .filter((candidate) => candidate.type === 'road_aware')
            .sort((first, second) => (first.distance ?? Infinity) - (second.distance ?? Infinity))[0] || null;
        const bestContinuity = candidates.find((candidate) => candidate.type === 'continuity') || null;
        const round = (value) => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null);

        return Response.json({
            success: true,
            // 'current' tells the caller the saved order already won — leave it alone.
            selected: winner.is_current ? 'current' : winner.type,
            order: winner.order.map(propertyIdentity),
            property_count: winner.order.length,
            routing_metadata: {
                ...baseMetadata,
                strategy: winner.type === 'road_aware'
                    ? 'road_matrix_street_subdivision_continuity'
                    : 'canonical_street_subdivision_continuity',
                road_network_used: winner.type === 'road_aware',
                fallback: false,
                objective: matrix.objective,
                road_matrix_source: matrix.source,
                road_matrix_ms: matrixMs,
                road_matrix_snapped: matrix.snapped,
                road_matrix_unresolved_legs: unresolved.count,
                matrix_point_count: matrix.pointCount,
                matrix_block_count: matrix.blocks,
                matrix_unresolved_count: 0,
                fallback_status: 'none',
                fallback_reason: null,
                // Backward-compatible fields the clients already read.
                input_measured: round(current?.distance),
                continuity_measured: round(bestContinuity?.distance),
                road_aware_measured: round(
                    winner.type === 'road_aware' && !winner.is_current
                        ? winner.distance
                        : bestRoadAware?.distance
                ),
                improvement: round(
                    Number.isFinite(current?.distance) && Number.isFinite(winner.distance)
                        ? current.distance - winner.distance
                        : null
                ),
                current_route_distance: round(current?.distance),
                current_route_duration: round(current?.duration),
                winning_route_distance: round(winner.distance),
                winning_route_duration: round(winner.duration),
                distance_improvement: round(
                    Number.isFinite(current?.distance) && Number.isFinite(winner.distance)
                        ? current.distance - winner.distance
                        : null
                ),
                duration_improvement: round(
                    Number.isFinite(current?.duration) && Number.isFinite(winner.duration)
                        ? current.duration - winner.duration
                        : null
                ),
                candidate_count: candidates.length,
                // Deterministic best-of-search, not a proven global optimum.
                optimality_status: 'best_validated_candidate',
                selected_candidate_type: winner.is_current ? 'current' : winner.type,
                solver_runtime_ms: Date.now() - solverStartedAt,
                street_block_count: continuityChunks.streetBlocks.length,
                access_block_count: continuityChunks.accessBlocks.length,
                property_order_fingerprint: winner.fingerprint,
                exact_once_verified: true
            }
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
}