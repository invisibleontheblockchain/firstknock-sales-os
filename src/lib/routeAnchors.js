/**
 * Custom route anchors — a manager-chosen fixed start and finish for one route.
 *
 * This is deliberately NOT an Optimize choice. The Optimize menu offers three
 * anchor SOURCES (none / Home Base / this device's car), and those sources are
 * personal, which is why `buildRouteOptimizeUpdate` never persists their
 * coordinates. A custom anchor is the opposite: an explicit fixed address the
 * manager typed for the whole crew (an office, a trailer, a meeting spot), which
 * `SavedRoute.start_location` / `end_location` exist to hold.
 */

import { ROUTE_ORIGIN_MODES } from './routeOriginModes';

const coordinate = (value, limit) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && Math.abs(parsed) <= limit ? parsed : null;
};

/**
 * A storable anchor, or null. Only lat/lng/address survive — an anchor is a
 * place, so nothing else from a geocoder response reaches the route.
 */
export function normalizeRouteAnchor(point) {
    const lat = coordinate(point?.lat ?? point?.latitude, 90);
    const lng = coordinate(point?.lng ?? point?.longitude, 180);
    if (lat === null || lng === null) return null;
    const address = String(point?.address || '').trim().slice(0, 300);
    return address ? { lat, lng, address } : { lat, lng };
}

/**
 * The SavedRoute update for setting or clearing custom anchors.
 *
 * Passing no usable start AND no usable end clears the anchors and returns the
 * route to `none`, so ANCHORS can undo itself without a second code path.
 */
export function buildRouteAnchorsUpdate({
    start = null,
    end = null,
    order,
    distanceMiles,
    existingMetrics = {},
    existingMetadata = {},
    routingMetadata = {}
}) {
    const normalizedStart = normalizeRouteAnchor(start);
    const normalizedEnd = normalizeRouteAnchor(end);
    const anchored = Boolean(normalizedStart || normalizedEnd);
    const metadata = { ...existingMetadata, ...routingMetadata };
    delete metadata.road_geometry;

    metadata.route_bounds = anchored
        ? { enabled: true, mode: ROUTE_ORIGIN_MODES.CUSTOM_BOUNDS, start_source: 'manual_address' }
        : { enabled: false, cleared_reason: 'anchors_cleared' };

    return {
        property_hashes: order,
        metrics: { ...existingMetrics, distance: distanceMiles, house_count: order.length },
        metadata,
        route_origin_mode: anchored ? ROUTE_ORIGIN_MODES.CUSTOM_BOUNDS : ROUTE_ORIGIN_MODES.NONE,
        start_location: anchored ? normalizedStart : null,
        end_location: anchored ? normalizedEnd : null
    };
}