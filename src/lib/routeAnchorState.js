// Keep hydrated doors in the order returned by the anchor optimizer.
export function mergeAnchoredRoute(current, saved) {
    const byHash = new Map();
    for (const property of current?.allProperties?.length ? current.allProperties : current?.properties || []) {
        for (const key of [property.address_hash, property.legacy_hash, property.id]) if (key) byHash.set(String(key), property);
    }
    const properties = (saved.property_hashes || []).map(hash => byHash.get(hash)).filter(Boolean);
    return { ...current, ...saved, startLocation: null, endLocation: null, routeOriginMode: saved.route_origin_mode,
        properties, allProperties: properties, houseCount: saved.metrics?.house_count, totalDistance: saved.metrics?.distance };
}
