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
    createMatrixDistanceFn,
    DEFAULT_OSRM_BASE_URL,
    fetchRoadMatrix,
    MAX_MATRIX_COORDINATES,
    measureOrder,
    ROAD_MATRIX_VERSION
} from '../../shared/roadMatrix.js';

function readSecret(name) {
    try {
        const value = secrets.get(name);
        return value ? String(value).trim() : '';
    } catch {
        return '';
    }
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
        if (properties.length > MAX_MATRIX_COORDINATES) {
            return Response.json({
                error: `Road matrix limit is ${MAX_MATRIX_COORDINATES} properties per request.`,
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

        const housesPerRoute = properties.length;
        const cacheKey = await buildRoadMatrixCacheKey(properties, profile);

        // Candidate A — today's shipping behavior, straight-line continuity.
        const continuity = createContinuityOptimizer(haversineMiles);
        const continuityChunks = continuity.buildRouteChunks(properties, housesPerRoute, startLocation, endLocation);
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

        // Fallback: never block route creation on the routing engine.
        if (!matrix) {
            return Response.json({
                success: true,
                selected: 'continuity',
                order: continuityOrder.map((property) => property.address_hash || property.id),
                property_count: continuityOrder.length,
                routing_metadata: {
                    strategy: 'canonical_street_subdivision_continuity',
                    road_network_used: false,
                    fallback: true,
                    fallback_reason: 'road_matrix_unavailable',
                    road_matrix_error: matrixError,
                    road_matrix_version: ROAD_MATRIX_VERSION,
                    road_matrix_cache_key: cacheKey,
                    road_matrix_ms: matrixMs,
                    property_order_fingerprint: routePropertyOrderFingerprint(continuityOrder),
                    exact_once_verified: true
                }
            });
        }

        const { distanceBetween, unresolved } = createMatrixDistanceFn(properties, matrix);

        // Candidate B — the shipped street sweep, priced with real road distances.
        const roadOrder = roadAwareStreetSweep(properties, {
            distanceBetween,
            startLocation,
            endLocation
        });
        const roadIdentities = new Set(roadOrder.map((property) => property.address_hash || property.id));
        if (roadOrder.length !== properties.length || roadIdentities.size !== properties.length) {
            throw new Error('Road-aware candidate failed its exact-once property invariant.');
        }

        // Accept/reject: both candidates are measured with the SAME road matrix,
        // and the road-aware order only wins when it actually measures better.
        const continuityMeasured = measureOrder(continuityOrder, distanceBetween);
        const roadMeasured = measureOrder(roadOrder, distanceBetween);
        // The request body carries the properties in their CURRENT saved order, so
        // callers can judge the road-aware candidate against what the user has now.
        const inputMeasured = measureOrder(properties, distanceBetween);
        const comparable = Number.isFinite(continuityMeasured) && Number.isFinite(roadMeasured);
        const acceptRoadAware = comparable && roadMeasured + 0.0001 < continuityMeasured;
        const selectedOrder = acceptRoadAware ? roadOrder : continuityOrder;

        return Response.json({
            success: true,
            selected: acceptRoadAware ? 'road_aware' : 'continuity',
            order: selectedOrder.map((property) => property.address_hash || property.id),
            property_count: selectedOrder.length,
            routing_metadata: {
                strategy: acceptRoadAware
                    ? 'road_matrix_street_subdivision_continuity'
                    : 'canonical_street_subdivision_continuity',
                road_network_used: acceptRoadAware,
                fallback: false,
                objective: matrix.objective,
                road_matrix_version: ROAD_MATRIX_VERSION,
                road_matrix_cache_key: cacheKey,
                road_matrix_source: matrix.source,
                road_matrix_ms: matrixMs,
                road_matrix_snapped: matrix.snapped,
                road_matrix_unresolved_legs: unresolved.count,
                input_measured: Number.isFinite(inputMeasured) ? Math.round(inputMeasured * 1000) / 1000 : null,
                continuity_measured: comparable ? Math.round(continuityMeasured * 1000) / 1000 : null,
                road_aware_measured: comparable ? Math.round(roadMeasured * 1000) / 1000 : null,
                improvement: comparable
                    ? Math.round((continuityMeasured - roadMeasured) * 1000) / 1000
                    : null,
                street_block_count: continuityChunks.streetBlocks.length,
                access_block_count: continuityChunks.accessBlocks.length,
                property_order_fingerprint: routePropertyOrderFingerprint(selectedOrder),
                exact_once_verified: true
            }
        });
    } catch (error) {
        return Response.json({ error: error.message }, { status: 500 });
    }
}