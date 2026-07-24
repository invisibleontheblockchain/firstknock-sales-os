import { base44 } from '@/api/base44Client';
import {
    hasCompleteRouteMapPoints,
    hydrateRouteWithLookup,
    indexRouteProperties,
    orderRouteProperties,
} from './routeHydrationCore.js';

const routeHydrationCache = new Map();
const routeHydrationInflight = new Map();
const routeCollectionHydrationCache = new Map();

async function lookupRouteProperties({ hashes, routeId, userEmail }) {
    if (!Array.isArray(hashes) || hashes.length === 0) return [];
    const response = await base44.functions.invoke('getRoutePropertiesByHashes', {
        address_hashes: hashes,
        ...(routeId ? { route_id: routeId } : {}),
        user_email: userEmail,
        limit: hashes.length
    });
    return Array.isArray(response.data?.properties) ? response.data.properties : [];
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

    const cacheKey = `${route.id || 'route'}:${route.updated_date || ''}:${hashes.join('|')}`;
    if (routeHydrationCache.has(cacheKey)) return routeHydrationCache.get(cacheKey);
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
            routeHydrationCache.set(cacheKey, hydratedRoute);
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

    const routeSig = routes.map(route => `${route.id || ''}:${route.updated_date || ''}:${(route.property_hashes || []).join('|')}`).join('~');
    const propSig = existingProperties.map(p => `${p.address_hash || p.id || ''}:${p.updated_date || p.effective_status || ''}`).join('~');
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
        if (routeCollectionHydrationCache.size > 25) {
            const oldestKey = routeCollectionHydrationCache.keys().next().value;
            routeCollectionHydrationCache.delete(oldestKey);
        }
    }
    return hydrated;
}
