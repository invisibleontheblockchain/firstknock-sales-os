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
    DEFAULT_OSRM_BASE_URL,
    fetchRoadMatrix,
    ROAD_MATRIX_VERSION
} from '../../shared/roadMatrix.js';
import {
    BLOCK_TIER_REFINEMENT_STEP_BUDGET,
    classifyFinalRouteLegs,
    createTieredMatrixMetricFns,
    MAX_TIERED_ROUTE_DOORS,
    planTieredRoadMatrix,
    TIER_CLUSTER,
    TIER_DOOR
} from '../../shared/roadMatrixTiers.js';
import { sequenceRoadHierarchy } from '../../shared/roadHierarchySequencer.js';
import { measureRoadPath } from '../../shared/roadPathMeasure.js';
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

/** Matrix identity of a point — the same 6-decimal key the matrix indexes by. */
const coordinateIdentity = (point) => `${Number(point?.lat).toFixed(6)},${Number(point?.lng).toFixed(6)}`;

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
        if (properties.length > MAX_TIERED_ROUTE_DOORS) {
            return Response.json({
                error: `Road matrix limit is ${MAX_TIERED_ROUTE_DOORS} properties per route.`,
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
        // The anchors go INTO the matrix, so the drive from the start point and
        // back to the finish point is priced by the same road engine as every
        // door leg. Without them in the matrix the objective could not see the
        // anchor at all, and "optimize from Home" scored an order starting at the
        // nearest door no better than one starting on the far side of the
        // territory — so the saved order kept winning the tie.
        const anchorPoints = [];
        const seenAnchorKeys = new Set(properties.map(coordinateIdentity));
        [startLocation, endLocation].forEach((anchor) => {
            if (!anchor) return;
            const key = coordinateIdentity(anchor);
            if (seenAnchorKeys.has(key)) return;
            seenAnchorKeys.add(key);
            anchorPoints.push(anchor);
        });
        // How many coordinates this route can afford to price. Beyond the proven
        // door limit the matrix is bounded at the street-block level rather than
        // abandoned, so a large route is still ordered on real road distances.
        const plan = planTieredRoadMatrix(properties, anchorPoints);
        const anchorsInMatrix = plan.ok && plan.anchorsIncluded;
        const matrixPoints = plan.ok ? plan.matrixPoints : properties;
        const cacheKey = await buildRoadMatrixCacheKey(matrixPoints, profile);
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

        const baseMetadata = {
            property_set_fingerprint: setFingerprint,
            start_constraint: startLocation,
            end_constraint: endLocation,
            anchor_legs_measured: Boolean((startLocation || endLocation) && anchorsInMatrix),
            return_to_start: false,
            routing_profile: profile,
            matrix_provider: 'osrm',
            road_matrix_version: ROAD_MATRIX_VERSION,
            road_matrix_cache_key: cacheKey,
            // The tier a route was measured at, so a stored order can never
            // claim more precision than the matrix behind it actually had.
            matrix_tier: plan.ok ? plan.tier : null,
            matrix_street_block_count: plan.ok ? plan.blockCount : null,
            optimizer_version: OPTIMIZER_VERSION,
            objective_version: OBJECTIVE_VERSION,
            duration_tie_tolerance_minutes: DURATION_TIE_TOLERANCE_MINUTES
        };

        // Cluster-tier routes take the hierarchical path instead of a single
        // representative matrix. A representative matrix leaves every leg INSIDE a
        // cluster priced by straight-line distance, which is the defect that let a
        // route weave between four streets and still report itself optimized. The
        // hierarchy gives each cluster its own exact door matrix, so no
        // order-affecting comparison inside a cluster is made without roads, and
        // the result is then validated against real driving mileage before it is
        // allowed to replace the route the caller already has.
        if (plan.ok && plan.tier === TIER_CLUSTER) {
            const hierarchyStartedAt = Date.now();
            const osrmBaseUrl = readSecret('OSRM_BASE_URL') || DEFAULT_OSRM_BASE_URL;
            const hierarchy = await sequenceRoadHierarchy(canonicalProperties, {
                startLocation,
                endLocation,
                baseUrl: osrmBaseUrl,
                profile,
                timeoutMs,
                // Enables level-4 hotspot repair: the hierarchy measures its own
                // finished route so it can find the transitions that are still bad
                // and re-solve their neighbourhoods. Each round is kept only when a
                // fresh measurement is shorter, so this cannot lengthen the route.
                measurePath: measureRoadPath
            });

            if (hierarchy.ok && exactOnce(hierarchy.order, properties.length)) {
                const withAnchors = (order) => [
                    ...(startLocation ? [startLocation] : []),
                    ...order,
                    ...(endLocation ? [endLocation] : [])
                ];
                const measureOptions = { baseUrl: osrmBaseUrl, profile, timeoutMs };
                // Product truth: both orders measured the same way, on the road
                // network, in the units a manager cares about.
                const [proposedPath, currentPath] = await Promise.all([
                    measureRoadPath(withAnchors(hierarchy.order), measureOptions),
                    measureRoadPath(withAnchors(properties), measureOptions)
                ]);

                const telemetry = hierarchy.telemetry;
                const round = (value) => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null);
                const validated = proposedPath.ok && currentPath.ok;
                // An unvalidated order is never applied. Without a real-mileage
                // comparison there is no evidence it is better, and "the
                // computation finished" is not evidence.
                const keepCurrent = !validated || currentPath.totalMiles <= proposedPath.totalMiles;
                const winningOrder = keepCurrent ? properties : hierarchy.order;
                const degraded = telemetry.degraded;

                return Response.json({
                    success: true,
                    selected: keepCurrent ? 'current' : 'road_aware',
                    order: winningOrder.map(propertyIdentity),
                    property_count: winningOrder.length,
                    routing_metadata: {
                        ...baseMetadata,
                        strategy: 'road_hierarchy_cluster_exact_door_matrix',
                        road_network_used: true,
                        fallback: false,
                        objective: 'measured_road_miles',
                        road_matrix_source: `osrm:${profile}`,
                        road_matrix_ms: Date.now() - hierarchyStartedAt,
                        // Computational truth: how the decisions were priced.
                        ...telemetry,
                        // Product truth: what the route actually drives.
                        road_path_validated: validated,
                        road_path_error: proposedPath.ok ? (currentPath.error || null) : proposedPath.error,
                        validated_road_miles: round(proposedPath.ok ? proposedPath.totalMiles : null),
                        current_validated_road_miles: round(currentPath.ok ? currentPath.totalMiles : null),
                        validated_longest_leg_miles: round(proposedPath.ok ? proposedPath.longestLegMiles : null),
                        current_longest_leg_miles: round(currentPath.ok ? currentPath.longestLegMiles : null),
                        // The whole transition distribution, both routes, measured
                        // the same way. Longest-leg alone can be owned by one
                        // unavoidable highway hop and hides how the rest reads.
                        validated_leg_distribution: proposedPath.ok ? proposedPath.legDistribution : null,
                        current_leg_distribution: currentPath.ok ? currentPath.legDistribution : null,
                        road_miles_saved: round(
                            validated ? currentPath.totalMiles - proposedPath.totalMiles : null
                        ),
                        input_measured: round(currentPath.ok ? currentPath.totalMiles : null),
                        road_aware_measured: round(proposedPath.ok ? proposedPath.totalMiles : null),
                        improvement: round(
                            validated ? currentPath.totalMiles - proposedPath.totalMiles : null
                        ),
                        current_route_distance: round(currentPath.ok ? currentPath.totalMiles : null),
                        winning_route_distance: round(
                            keepCurrent
                                ? (currentPath.ok ? currentPath.totalMiles : null)
                                : proposedPath.totalMiles
                        ),
                        distance_improvement: round(
                            validated ? currentPath.totalMiles - proposedPath.totalMiles : null
                        ),
                        matrix_point_count: null,
                        matrix_block_count: telemetry.matrix_request_count,
                        // Never "ok because it finished": a route that had ANY
                        // aerial-priced sequencing, or that could not be measured
                        // on real roads, says exactly that here.
                        road_aware_degraded: degraded,
                        road_aware_degradation_reason: degraded
                            ? telemetry.degraded_cluster_reasons.join('; ') || 'cluster_sequencing_degraded'
                            : null,
                        distance_estimate: validated ? 'road_measured' : 'unvalidated',
                        fallback_status: validated ? 'none' : 'road_path_unvalidated',
                        fallback_reason: validated ? null : 'final_order_not_measured_on_road_network',
                        optimality_status: !validated
                            ? 'unvalidated_not_applied'
                            : degraded
                                ? 'road_validated_degraded_sequencing'
                                : 'road_validated_hierarchical',
                        selected_candidate_type: keepCurrent ? 'current' : 'road_aware_hierarchy',
                        candidate_count: 2,
                        solver_runtime_ms: Date.now() - solverStartedAt,
                        street_block_count: telemetry.street_block_count,
                        access_block_count: continuityChunks.accessBlocks.length,
                        property_order_fingerprint: routePropertyOrderFingerprint(winningOrder),
                        exact_once_verified: true
                    }
                });
            }
            // Hierarchy did not apply — fall through to the bounded representative
            // matrix below, which reports its own aerial degradation honestly.
        }

        let matrix = null;
        let matrixError = plan.ok ? '' : `Road matrix could not be bounded: ${plan.code}.`;
        const matrixStartedAt = Date.now();
        if (plan.ok) {
            try {
                matrix = await fetchRoadMatrix(matrixPoints, {
                    baseUrl: readSecret('OSRM_BASE_URL') || DEFAULT_OSRM_BASE_URL,
                    profile,
                    timeoutMs
                });
            } catch (error) {
                matrixError = error.message;
            }
        }
        const matrixMs = Date.now() - matrixStartedAt;

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
                    fallback_reason: plan.ok ? 'road_matrix_unavailable' : plan.code.toLowerCase(),
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

        const {
            distanceBetween,
            durationBetween,
            unresolved,
            intraBlockLegCount,
            aerialEvaluationCounts
        } = createTieredMatrixMetricFns(matrix, plan);

        // Both objectives get their own sweep, so the duration winner is not
        // limited to whatever the distance-priced sweep happened to produce.
        // Block-tier routes cap refinement depth so the deterministic step budget
        // — not the wall-clock safety cutoff — stays the binding limit.
        const sweepOptions = {
            startLocation,
            endLocation,
            // Every non-door tier (block and cluster) caps refinement depth so the
            // deterministic step budget stays the binding limit.
            ...(plan.tier !== TIER_DOOR
                ? { refinementStepBudget: BLOCK_TIER_REFINEMENT_STEP_BUDGET }
                : {})
        };
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
        // Whole-route direction. Safe whenever the measurement covers every leg
        // that reversing would change — with an anchor that means the anchor legs
        // must be in the matrix too.
        const withReversals = (!startLocation && !endLocation) || anchorsInMatrix
            ? rawCandidates.flatMap((candidate) => [
                candidate,
                { ...candidate, is_current: false, order: [...candidate.order].reverse() }
            ])
            : rawCandidates;

        const candidates = withReversals
            .filter((candidate) => exactOnce(candidate.order, properties.length))
            .map((candidate) => measureRouteCandidate(candidate, {
                distanceBetween,
                durationBetween,
                // Anchors only score when they are in this matrix; otherwise every
                // candidate is scored door-to-door, as before.
                startLocation: anchorsInMatrix ? startLocation : null,
                endLocation: anchorsInMatrix ? endLocation : null
            }));
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

        // What the STORED route is actually made of, as opposed to what the search
        // evaluated. A cluster-tier unit spans several streets, so a leg between
        // two different streets inside one unit was sequenced on straight-line
        // distance — that is a material degradation and the route is not allowed
        // to describe itself as fully road-optimized while it has any.
        const finalLegs = classifyFinalRouteLegs(winner.order, plan);
        const roadAwareDegraded = finalLegs.aerialCrossStreetLegs > 0;

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
                // CANDIDATE-SEARCH telemetry. This counts straight-line
                // evaluations made while searching for an order, so it reads in
                // the millions on a large route and must never be read as a count
                // of legs in the stored route — that is `final_route_*` below.
                intra_block_aerial_leg_count: intraBlockLegCount.count,
                aerial_evaluation_same_street_block: aerialEvaluationCounts.sameStreetBlock,
                aerial_evaluation_cross_street_same_unit: aerialEvaluationCounts.crossStreetSameUnit,
                // FINAL-ROUTE telemetry: the legs the rep will actually drive.
                final_route_leg_count: finalLegs.legCount,
                final_route_road_legs: finalLegs.roadLegs,
                final_route_aerial_same_street_block_legs: finalLegs.aerialSameStreetBlockLegs,
                final_route_aerial_cross_street_legs: finalLegs.aerialCrossStreetLegs,
                // Honest self-description. A cluster-tier route whose final legs
                // include cross-street aerial sequencing is road-INFORMED, not
                // road-optimized, and says so here rather than reporting clean.
                road_aware_degraded: roadAwareDegraded,
                road_aware_degradation_reason: roadAwareDegraded
                    ? 'aerial_cross_street_sequencing_within_matrix_unit'
                    : null,
                distance_estimate: plan.tier === TIER_DOOR
                    ? 'road'
                    : roadAwareDegraded
                        ? 'road_partial_aerial_sequencing'
                        : 'road_block_tier',
                matrix_point_count: matrix.pointCount,
                matrix_block_count: matrix.blocks,
                matrix_unresolved_count: 0,
                fallback_status: roadAwareDegraded ? 'aerial_intra_unit_sequencing' : 'none',
                fallback_reason: roadAwareDegraded
                    ? 'cluster_tier_intra_unit_legs_priced_aerially'
                    : null,
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
                optimality_status: plan.tier === TIER_DOOR
                    ? 'best_validated_candidate'
                    : roadAwareDegraded
                        ? 'best_validated_candidate_degraded_aerial_intra_unit'
                        : 'best_validated_candidate_block_tier',
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