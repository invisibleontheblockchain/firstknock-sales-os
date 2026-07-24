import { base44 } from '@/api/base44Client';
import {
    hasCompleteRouteMapPoints,
    hydrateRouteWithLookup,
    indexRouteProperties,
    lookupRoutePropertiesInBatches,
    orderRouteProperties,
} from './routeHydrationCore.js';

const routeHydrationCache = new Map();
const routeHydrationInflight = new Map();
const routeCollectionHydrationCache = new Map();
const MAX_ROUTE_HYDRATION_CACHE_ENTRIES = 12;
const MAX_ROUTE_HYDRATION_CACHE_PROPERTIES = 25_000;
const MAX_ROUTE_COLLECTION_CACHE_ENTRIES = 5;
let routeHydrationCachedPropertyCount = 0;

function manifestSignature(values = []) {
    let first = 2166136261;
    let second = 2246822507;
    values.forEach(value => {
        const identity = String(value ?? '');
        const framed = `${identity.length}:${identity}|`;
        for (let index = 0; index < framed.length; index += 1) {
            const code = framed.charCodeAt(index);
            first = Math.imul(first ^ code, 16777619);
            second = Math.imul(second ^ code, 3266489909);
        }
    });
    return `${values.length}:${(first >>> 0).toString(16)}${(second >>> 0).toString(16)}`;
}

function hydratedPropertyCount(route) {
    return Math.max(
        Array.isArray(route?.properties) ? route.properties.length : 0,
        Array.isArray(route?.allProperties) ? route.allProperties.length : 0,
    );
}

function readHydratedRouteCache(cacheKey) {
    if (!routeHydrationCache.has(cacheKey)) return null;
    const cached = routeHydrationCache.get(cacheKey);
    // Refresh insertion order so frequently viewed routes survive the bound.
    routeHydrationCache.delete(cacheKey);
    routeHydrationCache.set(cacheKey, cached);
    return cached;
}

function cacheHydratedRoute(cacheKey, route) {
    const existing = routeHydrationCache.get(cacheKey);
    if (existing) routeHydrationCachedPropertyCount -= hydratedPropertyCount(existing);
    routeHydrationCache.delete(cacheKey);
    routeHydrationCache.set(cacheKey, route);
    routeHydrationCachedPropertyCount += hydratedPropertyCount(route);

    while (
        routeHydrationCache.size > MAX_ROUTE_HYDRATION_CACHE_ENTRIES
        || routeHydrationCachedPropertyCount > MAX_ROUTE_HYDRATION_CACHE_PROPERTIES
    ) {
        const oldestKey = routeHydrationCache.keys().next().value;
        if (oldestKey === undefined) break;
        const oldest = routeHydrationCache.get(oldestKey);
        routeHydrationCachedPropertyCount -= hydratedPropertyCount(oldest);
        routeHydrationCache.delete(oldestKey);
    }
}

async function lookupRouteProperties({ hashes, routeId, userEmail }) {
    if (!Array.isArray(hashes) || hashes.length === 0) return [];
    return lookupRoutePropertiesInBatches({
        hashes,
        routeId,
        lookupBatch: async ({ hashes: batchHashes, routeId: authorizedRouteId }) => {
            const response = await base44.functions.invoke('getRoutePropertiesByHashes', {
                address_hashes: batchHashes,
                ...(authorizedRouteId ? { route_id: authorizedRouteId } : {}),
                user_email: userEmail,
                limit: batchHashes.length
            });
            return Array.isArray(response.data?.properties) ? response.data.properties : [];
        }
    });
}

export async function hydrateRouteForMap(route, userEmail = null) {
    if (!route) return route;

    const hashes = Array.isArray(route.property_hashes) ? route.property_hashes : [];
    // Only short-circuit when the in-memory properties cover EVERY hash —
    // partial coverage must fall through to backend hydration or doors get silently dropped.
    if (Array.isArray(route?.properties) && route.properties.length > 0) {
        const ordered = orderRouteProperties(route);
        if (hasCompleteRouteMapPoints(ordered)) return ordered;
    }
    if (hashes.length === 0) return route;

    const cacheKey = `${route.id || 'route'}:${route.updated_date || ''}:${manifestSignature(hashes)}`;
    const cachedRoute = readHydratedRouteCache(cacheKey);
    if (cachedRoute) return cachedRoute;
    if (routeHydrationInflight.has(cacheKey)) return routeHydrationInflight.get(cacheKey);

    const request = hydrateRouteWithLookup(route, ({ hashes: requestedHashes, routeId }) => (
        lookupRouteProperties({
            hashes: requestedHashes,
            routeId,
            userEmail
        })
    )).then(hydratedRoute => {
        // Do not make an outage or partial response sticky for the browser
        // session. A later render/refetch must be able to repair missing pins.
        if (hasCompleteRouteMapPoints(hydratedRoute)) {
            cacheHydratedRoute(cacheKey, hydratedRoute);
        }
        return hydratedRoute;
    }).finally(() => {
        routeHydrationInflight.delete(cacheKey);
    });

    routeHydrationInflight.set(cacheKey, request);
    return request;
}

export async function hydrateRoutesForMap(routes = [], userEmail = null, existingProperties = []) {
    if (!Array.isArray(routes) || routes.length === 0) return [];

    const routeSig = manifestSignature(routes.map(route => (
        `${route.id || ''}:${route.updated_date || ''}:${manifestSignature(route.property_hashes || [])}`
    )));
    const propSig = manifestSignature(existingProperties.map(p => (
        `${p.address_hash || p.legacy_hash || p.id || ''}:${p.updated_date || p.effective_status || ''}`
    )));
    const collectionKey = `${userEmail || ''}::${routeSig}::${propSig}`;
    if (routeCollectionHydrationCache.has(collectionKey)) return routeCollectionHydrationCache.get(collectionKey);

    const existingByHash = indexRouteProperties(existingProperties);
    const hydrated = await Promise.all(routes.map(async route => {
        const hashes = Array.isArray(route.property_hashes) ? route.property_hashes : [];
        // Local data may only be used when it covers EVERY hash in the route.
        // Partial coverage (e.g. map cache holds 33 of 66 doors) must go to the backend,
        // otherwise Route Command / map / checklist show fewer doors than Knock.
        if (Array.isArray(route?.properties) && route.properties.length > 0) {
            const ordered = orderRouteProperties(route);
            if (hasCompleteRouteMapPoints(ordered)) return ordered;
        }
        const existingOrdered = hashes.map(hash => existingByHash.get(hash)).filter(Boolean);
        if (existingOrdered.length >= hashes.length && existingOrdered.length > 0) {
            return {
                ...route,
                properties: existingOrdered,
                allProperties: existingOrdered,
                houseCount: existingOrdered.length,
            };
        }
        return hydrateRouteForMap(route, userEmail);
    }));

    // As above, never make an empty/partial hydration result permanent.
    if (hydrated.every(hasCompleteRouteMapPoints)) {
        routeCollectionHydrationCache.set(collectionKey, hydrated);
        if (routeCollectionHydrationCache.size > MAX_ROUTE_COLLECTION_CACHE_ENTRIES) {
            const oldestKey = routeCollectionHydrationCache.keys().next().value;
            routeCollectionHydrationCache.delete(oldestKey);
        }
    }
    return hydrated;
}
