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

const MAX_ROAD_MATRIX_DOORS = 100;

const propertyKey = (property) => String(property.address_hash || property.legacy_hash || property.id || '');

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
        const roadMiles = Number(meta.road_aware_measured);
        const baseline = Number.isFinite(Number(meta.input_measured))
            ? Number(meta.input_measured)
            : Number(meta.continuity_measured);
        if (!Number.isFinite(roadMiles) || !Number.isFinite(baseline)) return null;
        const savings = baseline - roadMiles;
        if (!(savings > 0)) return null;

        return {
            order,
            objective: {
                applyCandidate: true,
                appliedDistance: roadMiles,
                estimatedSavings: savings
            },
            routingMetadata: { ...meta, source: 'optimizeRouteRoadMatrix' }
        };
    } catch (error) {
        console.warn('[roadMatrixOptimize] Road-matrix backend unavailable; using local optimize path', error);
        return null;
    }
}