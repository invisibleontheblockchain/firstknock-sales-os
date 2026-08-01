/**
 * OSRM road-matrix beta for the explicit Optimize action.
 *
 * Calls the backend `optimizeRouteRoadMatrix` function, which fetches a real
 * driving-distance matrix (public OSRM demo server for now — switch via the
 * OSRM_BASE_URL secret later) and compares today's continuity order against a
 * road-priced street sweep using the SAME matrix.
 *
 * Returns a result ONLY when the road-aware order measures strictly better
 * than the route's CURRENT saved order. Every other outcome — backend error,
 * OSRM timeout/rate-limit, fallback, integrity mismatch, or no improvement —
 * returns null so the caller runs the existing local optimize path unchanged.
 */

import { base44 } from '@/api/base44Client';

// The product ceiling for one road-aware optimization request, mirroring the
// backend's MAX_ROUTE_MATRIX_POINTS. It is NOT the OSRM per-request coordinate
// limit: the backend assembles larger routes from matrix blocks. Before chunking
// existed this was 100, which is how a 183-door route skipped OSRM — and with it
// the never-worse gate — while still being labelled optimized.
const MAX_ROAD_MATRIX_DOORS = 250;

const propertyKey = (property) => String(property.address_hash || property.legacy_hash || property.id || '');

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
        status: 'ok',
        road_aware: meta.road_network_used === true,
        mode: 'road_matrix',
        cost_only: false,
        distance_estimate: 'road',
        objective: meta.objective || null,
        supplied_point_count: meta.road_matrix_snapped ?? null,
        snapped_point_count: meta.road_matrix_snapped ?? null,
        unresolved_leg_count: meta.road_matrix_unresolved_legs ?? 0,
        matrix_version: meta.road_matrix_version || null,
        matrix_cache_key: meta.road_matrix_cache_key || null,
        matrix_ms: meta.road_matrix_ms ?? null,
        fallback: meta.fallback === true,
        property_order_fingerprint: meta.property_order_fingerprint || null,
        optimized_at: new Date().toISOString()
    };
}

export async function tryRoadMatrixOptimize(routeProperties, { start = null, end = null } = {}) {
    if (!Array.isArray(routeProperties)
        || routeProperties.length < 2
        || routeProperties.length > MAX_ROAD_MATRIX_DOORS) return null;

    try {
        const payload = {
            // Current saved order — the backend measures it so savings are honest.
            properties: routeProperties.map((property) => ({
                address_hash: propertyKey(property),
                house_number: property.house_number,
                street_name: property.street_name,
                city: property.city,
                zip_code: property.zip_code || property.zip,
                subdivision_name: property.subdivision_name,
                lat: property.lat,
                lng: property.lng
            })),
            timeout_ms: 12000
        };
        if (start) payload.start_location = { lat: start.lat, lng: start.lng };
        if (end) payload.end_location = { lat: end.lat, lng: end.lng };

        const response = await base44.functions.invoke('optimizeRouteRoadMatrix', payload);
        const data = response?.data || response;
        if (data?.selected !== 'road_aware' || !Array.isArray(data.order)) return null;

        const byKey = new Map(routeProperties.map((property) => [propertyKey(property), property]));
        const order = data.order.map((hash) => byKey.get(String(hash))).filter(Boolean);
        if (order.length !== routeProperties.length || new Set(order).size !== routeProperties.length) return null;

        const meta = data.routing_metadata || {};
        const roadMiles = Number.isFinite(Number(meta.winning_route_distance))
            ? Number(meta.winning_route_distance)
            : Number(meta.road_aware_measured);
        const baseline = Number.isFinite(Number(meta.input_measured))
            ? Number(meta.input_measured)
            : Number(meta.continuity_measured);
        if (!Number.isFinite(roadMiles) || !Number.isFinite(baseline)) return null;
        const savings = baseline - roadMiles;
        // Driving time is the primary objective, so a candidate that saves
        // minutes is adopted even when the mileage is a wash. The backend gate
        // already refused to return anything worse than the current order.
        const durationGain = Number(meta.duration_improvement);
        if (!(savings > 0) && !(durationGain > 0)) return null;

        return {
            order,
            objective: {
                applyCandidate: true,
                appliedDistance: roadMiles,
                estimatedSavings: savings
            },
            routingMetadata: {
                ...meta,
                source: 'optimizeRouteRoadMatrix',
                routing: buildRoadMatrixRoutingBlock(meta)
            }
        };
    } catch (error) {
        console.warn('[roadMatrixOptimize] Road-matrix backend unavailable; using local optimize path', error);
        return null;
    }
}