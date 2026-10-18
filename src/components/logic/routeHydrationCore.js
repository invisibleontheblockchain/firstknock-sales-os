import { isRenderableMapPoint as hasMapPoint } from '../map/mapLayerVisibility.js';

export const ROUTE_HYDRATION_BATCH_LIMIT = 5000;

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
    properties.forEach(property => {
        if (!property || !hasMapPoint(property)) return;
        const hash = property.address_hash || property.id;
        if (hash) byHash.set(String(hash), property);
        if (property.legacy_hash) byHash.set(String(property.legacy_hash), property);
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
    if (hashes.length === 0) {
        return Array.isArray(route.property_hashes)
            ? { ...route, properties: [], allProperties: [], houseCount: 0 }
            : route;
    }

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

export function isRecoveryLimitedProperty(property) {
    return property?.recovery_limited === true;
}

export function isRouteHydrationCacheable(route) {
    if (!hasCompleteRouteMapPoints(route)) return false;
    return !routeSourceProperties(route).some(isRecoveryLimitedProperty);
}

// CSV/Redfin imports keep their homes outside the territory overview, so
// waiting for that overview never saves them a lookup.
export function isImportedRoute(route) {
    return ['csv_import', 'redfin_csv'].includes(route?.metadata?.source)
        || route?.metadata?.imports?.length > 0
        || !!route?.property_hashes?.some(hash => String(hash).startsWith('import_'));
}

export const EARLY_ROUTE_HYDRATION_COUNT = 3;

/**
 * Saved routes to look up while the territory overview is still loading.
 * Most route homes arrive with that overview, so looking every route up before
 * it lands downloads them twice (on one production manager account, ~33 calls
 * and 7 MB of JSON per map open). Until it settles, only the newest routes, any
 * route in progress and imports are looked up; the rest render from territory
 * homes and are completed afterwards, when only homes the overview lacks are
 * requested.
 */
export function selectRoutesToHydrate(routes = [], {
    overviewLoading = false,
    earlyCount = EARLY_ROUTE_HYDRATION_COUNT,
    center = null,
    homesByHash = null,
    nearViewCount = EARLY_ROUTE_HYDRATION_COUNT,
} = {}) {
    if (!Array.isArray(routes)) return [];
    // Viewport first: the routes where the map is looking load before the rest.
    const ordered = orderRoutesNearView(routes, center, homesByHash);
    if (!overviewLoading) return ordered;
    const nearView = new Set(center ? ordered.filter(route => routeLocationHint(route, homesByHash)).slice(0, nearViewCount) : []);
    const early = new Set(routes.filter((route, index) => (
        index < earlyCount || route?.status === 'IN_PROGRESS' || isImportedRoute(route)
    )));
    return ordered.filter(route => nearView.has(route) || early.has(route));
}

const pointOf = value => (Array.isArray(value) ? { lat: Number(value[0]), lng: Number(value[1]) }
    : value ? { lat: Number(value.lat), lng: Number(value.lng) } : null);
const usablePoint = point => point && Number.isFinite(point.lat) && Number.isFinite(point.lng) && (point.lat !== 0 || point.lng !== 0);

/**
 * A point where a route is, before its homes are looked up: any of its homes
 * already on the device (territory overview, an earlier lookup), else its saved
 * driving path, the area it was pulled from, or its start. Null when unknown.
 */
export function routeLocationHint(route, homesByHash = null) {
    for (const property of [...(route?.properties || []), ...(route?.allProperties || [])]) {
        const point = pointOf(property);
        if (usablePoint(point)) return point;
    }
    if (homesByHash) {
        for (const hash of route?.property_hashes || []) {
            const point = pointOf(homesByHash.get(String(hash)));
            if (usablePoint(point)) return point;
        }
    }
    const metadata = route?.metadata || {};
    const candidates = [metadata.road_geometry_segments?.[0]?.points?.[0], metadata.road_geometry?.[0],
        (metadata.precision_area?.polygon || metadata.drawn_polygon || metadata.polygon)?.[0],
        route?.start_location, route?.startLocation];
    for (const candidate of candidates) {
        const point = pointOf(candidate);
        if (usablePoint(point)) return point;
    }
    return null;
}

/** Routes nearest `center` first; routes with no known location keep their order, last. */
export function orderRoutesNearView(routes = [], center = null, homesByHash = null) {
    const origin = pointOf(center);
    if (!Array.isArray(routes) || !usablePoint(origin)) return Array.isArray(routes) ? routes : [];
    const scale = Math.cos(origin.lat * Math.PI / 180);
    const distance = route => {
        const point = routeLocationHint(route, homesByHash);
        if (!point) return Infinity;
        const dLat = point.lat - origin.lat, dLng = (point.lng - origin.lng) * scale;
        return dLat * dLat + dLng * dLng;
    };
    return routes.map((route, index) => ({ route, index, distance: distance(route) }))
        .sort((a, b) => (a.distance - b.distance) || (a.index - b.index))
        .map(item => item.route);
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
    if (hashes.length === 0) return orderRouteProperties(route);

    let hydrated = orderRouteProperties(route);
    if (hasCompleteRouteMapPoints(hydrated)) return hydrated;

    let routeScopedProperties = [];
    try {
        routeScopedProperties = await lookup({
            hashes: missingRouteHashes(hydrated),
            routeId: route.id || null,
        });
    } catch (error) {
        const status = Number(error?.status || error?.response?.status || 0);
        // A timed-out/rate-limited endpoint will not become faster through its
        // more expensive legacy workspace-discovery path. Preserve loaded
        // pins and let the caller retry this route once the service recovers.
        const networkFailure = ['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT', 'READ_TIMEOUT'].includes(error?.code)
            || error?.name === 'AbortError'
            || (error instanceof TypeError && /fetch|network/i.test(error.message));
        if (status === 408 || status === 429 || status >= 500 || networkFailure) return hydrated;
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
