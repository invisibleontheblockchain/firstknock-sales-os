function hasMapPoint(property) {
    const lat = Number(property?.lat);
    const lng = Number(property?.lng);
    return Number.isFinite(lat)
        && Number.isFinite(lng)
        && !(Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001);
}

export function indexRouteProperties(properties = []) {
    const byHash = new Map();
    properties.forEach(property => {
        if (!property || !hasMapPoint(property)) return;
        const hash = property.address_hash || property.id;
        if (hash) byHash.set(String(hash), property);
        if (property.legacy_hash) byHash.set(String(property.legacy_hash), property);
    });
    return byHash;
}

function routeSourceProperties(route) {
    return [
        ...(Array.isArray(route?.allProperties) ? route.allProperties : []),
        ...(Array.isArray(route?.properties) ? route.properties : [])
    ];
}

export function orderRouteProperties(route, additionalProperties = []) {
    if (!route) return route;
    const hashes = Array.isArray(route.property_hashes)
        ? route.property_hashes.map(String)
        : [];
    if (hashes.length === 0) return route;

    // Server records fill gaps, while in-memory records win for matching
    // hashes because they carry the freshest effective outcome status.
    const byHash = indexRouteProperties([
        ...(Array.isArray(additionalProperties) ? additionalProperties : []),
        ...routeSourceProperties(route)
    ]);
    const ordered = hashes.map(hash => byHash.get(hash)).filter(Boolean);
    if (ordered.length === 0) return route;

    return {
        ...route,
        properties: ordered,
        allProperties: ordered,
        // property_hashes is the saved route manifest. A temporary partial
        // hydration must not make the route list claim doors were removed.
        houseCount: hashes.length || route.metrics?.house_count || ordered.length,
    };
}

export function hasCompleteRouteMapPoints(route) {
    const hashes = Array.isArray(route?.property_hashes)
        ? route.property_hashes.map(String)
        : [];
    if (hashes.length === 0) return true;
    const byHash = indexRouteProperties(routeSourceProperties(route));
    return hashes.every(hash => byHash.has(hash));
}

function missingRouteHashes(route) {
    const hashes = Array.isArray(route?.property_hashes)
        ? route.property_hashes.map(String)
        : [];
    const byHash = indexRouteProperties(routeSourceProperties(route));
    return hashes.filter(hash => !byHash.has(hash));
}

/**
 * Hydrate an authorized route without letting a single endpoint failure blank
 * its map pins. The first lookup is route-scoped. Any missing hashes are then
 * retried without a route id, which the backend restricts to the signed-in
 * caller's own workspace (or an explicitly authorized admin workspace).
 */
export async function hydrateRouteWithLookup(route, lookup) {
    if (!route || typeof lookup !== 'function') return route;
    const hashes = Array.isArray(route.property_hashes)
        ? route.property_hashes.map(String)
        : [];
    if (hashes.length === 0) return route;

    let hydrated = orderRouteProperties(route);
    if (hasCompleteRouteMapPoints(hydrated)) return hydrated;

    let routeScopedProperties = [];
    try {
        routeScopedProperties = await lookup({
            hashes: missingRouteHashes(hydrated),
            routeId: route.id || null,
        });
    } catch {
        routeScopedProperties = [];
    }
    hydrated = orderRouteProperties(
        hydrated,
        Array.isArray(routeScopedProperties) ? routeScopedProperties : []
    );
    if (hasCompleteRouteMapPoints(hydrated)) return hydrated;

    let workspaceProperties = [];
    try {
        workspaceProperties = await lookup({
            hashes: missingRouteHashes(hydrated),
            routeId: null,
        });
    } catch {
        workspaceProperties = [];
    }

    return orderRouteProperties(
        hydrated,
        Array.isArray(workspaceProperties) ? workspaceProperties : []
    );
}
