function hasMapPoint(property) {
    const lat = Number(property?.lat);
    const lng = Number(property?.lng);
    return Number.isFinite(lat)
        && Number.isFinite(lng)
        && !(Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001);
}

export const ROUTE_HYDRATION_BATCH_LIMIT = 5000;

export function isRecoveryLimitedProperty(property) {
    return property?.recovery_limited === true;
}

function uniqueRouteHashes(hashes = []) {
    const unique = [];
    const seen = new Set();
    for (const value of Array.isArray(hashes) ? hashes : []) {
        const hash = String(value ?? '').trim();
        if (!hash || seen.has(hash)) continue;
        seen.add(hash);
        unique.push(hash);
    }
    return unique;
}

function routeHydrationError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, details);
    return error;
}

export function indexRouteProperties(properties = []) {
    const byHash = new Map();
    const indexProperty = (hash, property) => {
        if (!hash) return;
        const key = String(hash);
        const existing = byHash.get(key);
        // A pin-only recovery row must never overwrite a full tenant-scoped
        // property. For equally rich rows, preserve the existing "latest input
        // wins" behavior used by in-memory status updates.
        if (
            existing
            && !isRecoveryLimitedProperty(existing)
            && isRecoveryLimitedProperty(property)
        ) return;
        byHash.set(key, property);
    };
    properties.forEach(property => {
        if (!property || !hasMapPoint(property)) return;
        const hash = property.address_hash || property.id;
        indexProperty(hash, property);
        indexProperty(property.legacy_hash, property);
    });
    return byHash;
}

/**
 * Split a route lookup at the backend's authorization boundary. Every batch
 * carries the same route id, and no partial batch is returned to the caller.
 * This keeps large saved routes reliable without bypassing per-route ownership
 * checks or silently treating missing pins as a successful hydration.
 */
export async function lookupRoutePropertiesInBatches({
    hashes,
    routeId = null,
    lookupBatch,
    batchSize = ROUTE_HYDRATION_BATCH_LIMIT,
}) {
    if (typeof lookupBatch !== 'function') {
        throw routeHydrationError(
            'ROUTE_HYDRATION_LOOKUP_REQUIRED',
            'A route property batch lookup is required.'
        );
    }

    const requestedHashes = uniqueRouteHashes(hashes);
    if (requestedHashes.length === 0) return [];

    const numericBatchSize = Math.floor(Number(batchSize));
    const safeBatchSize = Math.min(
        ROUTE_HYDRATION_BATCH_LIMIT,
        Number.isFinite(numericBatchSize) && numericBatchSize > 0
            ? numericBatchSize
            : ROUTE_HYDRATION_BATCH_LIMIT
    );
    const orderedProperties = [];
    const returnedPropertyKeys = new Set();

    for (let offset = 0; offset < requestedHashes.length; offset += safeBatchSize) {
        const batchHashes = requestedHashes.slice(offset, offset + safeBatchSize);
        const response = await lookupBatch({
            hashes: batchHashes,
            routeId,
        });
        if (!Array.isArray(response)) {
            throw routeHydrationError(
                'ROUTE_HYDRATION_INVALID_RESPONSE',
                'Route property lookup returned an invalid response.',
                { batchOffset: offset }
            );
        }

        const byHash = indexRouteProperties(response);
        const missingHashes = batchHashes.filter(hash => !byHash.has(hash));
        if (missingHashes.length > 0) {
            throw routeHydrationError(
                'ROUTE_HYDRATION_PARTIAL_RESPONSE',
                `Route property lookup omitted ${missingHashes.length} requested properties.`,
                {
                    batchOffset: offset,
                    requestedCount: batchHashes.length,
                    missingCount: missingHashes.length,
                }
            );
        }

        for (const hash of batchHashes) {
            const property = byHash.get(hash);
            const propertyKey = String(property?.id || property?.address_hash || hash);
            if (returnedPropertyKeys.has(propertyKey)) continue;
            returnedPropertyKeys.add(propertyKey);
            orderedProperties.push(property);
        }
    }

    return orderedProperties;
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

export function hasRecoveryLimitedRouteProperties(route) {
    const hashes = Array.isArray(route?.property_hashes)
        ? route.property_hashes.map(String)
        : [];
    if (hashes.length === 0) return false;
    const byHash = indexRouteProperties(routeSourceProperties(route));
    return hashes.some(hash => isRecoveryLimitedProperty(byHash.get(hash)));
}

export function isRouteHydrationCacheable(route) {
    return hasCompleteRouteMapPoints(route)
        && !hasRecoveryLimitedRouteProperties(route);
}

function routeHashesNeedingHydration(route) {
    const hashes = Array.isArray(route?.property_hashes)
        ? route.property_hashes.map(String)
        : [];
    const byHash = indexRouteProperties(routeSourceProperties(route));
    return hashes.filter(hash => {
        const property = byHash.get(hash);
        return !property || isRecoveryLimitedProperty(property);
    });
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
    if (isRouteHydrationCacheable(hydrated)) return hydrated;

    let routeScopedProperties = [];
    try {
        routeScopedProperties = await lookup({
            hashes: routeHashesNeedingHydration(hydrated),
            routeId: route.id || null,
        });
    } catch {
        routeScopedProperties = [];
    }
    hydrated = orderRouteProperties(
        hydrated,
        Array.isArray(routeScopedProperties) ? routeScopedProperties : []
    );
    if (isRouteHydrationCacheable(hydrated)) return hydrated;

    let workspaceProperties = [];
    try {
        workspaceProperties = await lookup({
            hashes: routeHashesNeedingHydration(hydrated),
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
