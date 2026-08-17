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
// backend's MAX_TIERED_ROUTE_DOORS. It is NOT the OSRM per-request coordinate
// limit: the backend assembles larger routes from matrix blocks, and past 250
// doors it bounds the matrix at the street-block level instead of giving up.
// Every earlier version of this number was a silent cliff — a route above it
// skipped OSRM, and with it the never-worse gate, while still being labelled
// optimized (that is how a 183-door route shipped an unmeasured order).
const MAX_ROAD_MATRIX_DOORS = 2500;

// A large route is assembled from many OSRM matrix blocks, so a slow or
// rate-limited road service can leave the request outstanding for minutes with
// nothing on screen but a ticking toast. Optimize is interactive, so the wait
// gets a ceiling: past it the attempt is abandoned and the caller runs the
// existing local path, which is exactly what every other failure mode does.
//
// Sized from measurement, not assumption. On a real 1,000-door route against a
// healthy road engine (`scripts/route-1h-deadline-probe.mjs`): 28.3s to sequence
// plus 3.9s for the backend's dual road measurement = 32.2s, and a barrier-repair
// configuration adds ~8s more. The previous 45s left roughly 5s of margin on the
// biggest routes, so any load on the road engine turned a finished, strictly
// better order into a silent null and the route kept its straight-line order.
// Abandoning a 200-mile improvement to save 30 seconds is the wrong trade.
const ROAD_MATRIX_DEADLINE_MS = 90000;

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
        fallback: meta.fallback === true,
        property_order_fingerprint: meta.property_order_fingerprint || null,
        optimized_at: new Date().toISOString()
    };
}

export async function tryRoadMatrixOptimize(routeProperties, {
    start = null,
    end = null,
    deadlineMs = ROAD_MATRIX_DEADLINE_MS
} = {}) {
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

        let deadlineTimer = null;
        const response = await Promise.race([
            base44.functions.invoke('optimizeRouteRoadMatrix', payload),
            new Promise((resolve) => {
                deadlineTimer = setTimeout(() => resolve(null), deadlineMs);
            })
        ]).finally(() => clearTimeout(deadlineTimer));
        if (!response) {
            console.warn(`[roadMatrixOptimize] Road matrix exceeded ${deadlineMs}ms; using local optimize path`);
            return null;
        }
        const data = response?.data || response;
        // Any winner other than the caller's current order is an order the backend
        // measured strictly better on ONE shared road matrix — including a
        // reversed or continuity-shaped candidate. Requiring the 'road_aware'
        // label discarded those, which is why routes kept their zig-zag order
        // even though OSRM had already priced a shorter one.
        if (!data?.success
            || data.selected === 'current'
            // Aerial fallback orders are unmeasured — never adopt one.
            || data.routing_metadata?.fallback === true
            || !Array.isArray(data.order)) return null;

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