import { calculateRouteDistanceMiles, isValidRoutePoint } from '../../base44/shared/routeBounds.js';

export function routeContainsProperty(route, property) {
    const keys = [property?.address_hash, property?.legacy_hash, property?.id].filter(Boolean);
    return Array.isArray(route?.property_hashes) && route.property_hashes.some(hash => keys.includes(hash));
}

export function buildRouteStopRemovalUpdate(route, property, properties = []) {
    if (!Array.isArray(route?.property_hashes)) throw new Error('This route has no saved address list.');
    if (!routeContainsProperty(route, property)) throw new Error('This address is no longer on this route. Refresh and try again.');
    const removedKeys = new Set([property.address_hash, property.legacy_hash, property.id].filter(Boolean));
    const hashes = route.property_hashes.filter(hash => !removedKeys.has(hash));
    const byHash = new Map();
    properties.forEach(stop => {
        [stop?.address_hash, stop?.legacy_hash, stop?.id].filter(Boolean).forEach(key => byHash.set(key, stop));
    });
    const remaining = hashes.map(hash => byHash.get(hash));
    const metrics = { ...route.metrics, house_count: hashes.length };
    // The old distance and road path include the removed stop. Recalculate an
    // estimate only when every remaining stop has coordinates.
    delete metrics.distance;
    if (remaining.every(isValidRoutePoint)) {
        metrics.distance = remaining.length === 0 ? 0 : Math.round(calculateRouteDistanceMiles(remaining, {
            startLocation: isValidRoutePoint(route.start_location) ? route.start_location : null,
            endLocation: isValidRoutePoint(route.end_location) ? route.end_location : null,
        }) * 100) / 100;
    }
    const metadata = { ...route.metadata };
    delete metadata.road_geometry;
    delete metadata.road_geometry_segments;
    delete metadata.routing;
    metadata.road_network_used = false;
    metadata.road_verification = {
        verdict: 'unknown', verified: false, reason: 'route_stop_removed',
        measured_road_miles: null, road_miles_saved: null,
    };
    return { property_hashes: hashes, metrics, metadata };
}

export function applyRouteStopRemoval(route, savedRoute) {
    const ordered = stops => {
        const byHash = new Map();
        stops.forEach(stop => {
            [stop?.address_hash, stop?.legacy_hash, stop?.id].filter(Boolean).forEach(key => byHash.set(key, stop));
        });
        return savedRoute.property_hashes.map(hash => byHash.get(hash)).filter(Boolean);
    };
    return {
        ...route,
        ...savedRoute,
        properties: ordered(route.properties || []),
        allProperties: ordered(route.allProperties || route.properties || []),
        houseCount: savedRoute.property_hashes.length,
        totalDistance: savedRoute.metrics?.distance ?? 0,
    };
}

export async function removeSavedRouteStop({ route, property, entities }) {
    if (!route?.id || route.isSaved === false) throw new Error('Save this route before removing an address.');
    // Read the persisted manifest so a display filter or an older local route
    // cannot accidentally remove unrelated stops or restore a previously removed one.
    const current = await entities.SavedRoute.get(route.id);
    if (!current) throw new Error('This route could not be found.');
    if (current.status === 'ARCHIVED') throw new Error('Archived routes are read-only.');
    const update = buildRouteStopRemovalUpdate(current, property, [
        ...(route.allProperties || []), ...(route.properties || []),
    ]);
    const saved = await entities.SavedRoute.update(route.id, update);
    return { ...current, ...update, ...saved };
}
