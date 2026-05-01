import { base44 } from '@/api/base44Client';

const routeHydrationCache = new Map();
const routeHydrationInflight = new Map();

function hasMapPoints(route) {
    return Array.isArray(route?.properties) && route.properties.some(p => p?.lat && p?.lng);
}

function indexProperties(properties = []) {
    const byHash = new Map();
    properties.forEach(p => {
        if (!p) return;
        const hash = p.address_hash || p.id;
        if (hash) byHash.set(hash, p);
        if (p.legacy_hash) byHash.set(p.legacy_hash, p);
    });
    return byHash;
}

export async function hydrateRouteForMap(route, userEmail = null) {
    if (!route || hasMapPoints(route)) return route;

    const hashes = Array.isArray(route.property_hashes) ? route.property_hashes : [];
    if (hashes.length === 0) return route;

    const cacheKey = route.id || hashes.join('|');
    if (routeHydrationCache.has(cacheKey)) return routeHydrationCache.get(cacheKey);
    if (routeHydrationInflight.has(cacheKey)) return routeHydrationInflight.get(cacheKey);

    const request = base44.functions.invoke('getRoutePropertiesByHashes', {
        address_hashes: hashes,
        user_email: userEmail,
        limit: hashes.length
    }).then(res => {
        const loaded = Array.isArray(res.data?.properties) ? res.data.properties : [];
        if (loaded.length === 0) return route;

        const byHash = indexProperties(loaded);
        const ordered = hashes.map(hash => byHash.get(hash)).filter(Boolean);
        const hydratedRoute = {
            ...route,
            properties: ordered,
            allProperties: ordered,
            houseCount: ordered.length || route.metrics?.house_count || hashes.length,
        };
        routeHydrationCache.set(cacheKey, hydratedRoute);
        return hydratedRoute;
    }).catch(() => route).finally(() => {
        routeHydrationInflight.delete(cacheKey);
    });

    routeHydrationInflight.set(cacheKey, request);
    return request;
}

export async function hydrateRoutesForMap(routes = [], userEmail = null, existingProperties = []) {
    if (!Array.isArray(routes) || routes.length === 0) return [];

    const existingByHash = indexProperties(existingProperties);
    const hydrated = await Promise.all(routes.map(async route => {
        if (hasMapPoints(route)) return route;
        const hashes = Array.isArray(route.property_hashes) ? route.property_hashes : [];
        const existingOrdered = hashes.map(hash => existingByHash.get(hash)).filter(Boolean);
        if (existingOrdered.length > 0) {
            return {
                ...route,
                properties: existingOrdered,
                allProperties: existingOrdered,
                houseCount: existingOrdered.length || route.metrics?.house_count || hashes.length,
            };
        }
        return hydrateRouteForMap(route, userEmail);
    }));

    return hydrated;
}