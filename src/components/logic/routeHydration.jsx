import { base44 } from '@/api/base44Client';
import { withReadDeadline } from '@/lib/readRequest';
import { mapWithConcurrency } from '@/lib/mapWithConcurrency';
import {
    hasCompleteRouteMapPoints,
    hydrateRouteWithLookup,
    indexRouteProperties,
    isImportedRoute,
    isRouteHydrationCacheable,
    lookupRoutePropertiesInBatches,
    orderRouteProperties,
} from './routeHydrationCore.js';

const routeHydrationCache = new Map();
const routeHydrationInflight = new Map();
const routeCollectionHydrationCache = new Map();
const importedCollectionInflight = new Map();
const MAX_ROUTE_HYDRATION_CACHE_ENTRIES = 128;
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

function hydrationCacheKey(route, userEmail) {
    const viewer = String(userEmail || '').trim().toLowerCase();
    return viewer ? `${viewer}:${route.id || 'route'}:${route.updated_date || ''}:${manifestSignature(route.property_hashes || [])}` : null;
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
            // The caller owns recovery. Retrying every batch here and then
            // retrying the whole query multiplied one slow read into minutes.
            const response = await withReadDeadline(() => base44.functions.invoke('getRoutePropertiesByHashes', {
                address_hashes: batchHashes,
                ...(authorizedRouteId ? { route_id: authorizedRouteId } : {}),
                user_email: userEmail,
                limit: batchHashes.length
            }));
            return Array.isArray(response.data?.properties) ? response.data.properties : [];
        }
    });
}

export async function hydrateRouteForMap(route, userEmail = null) {
    if (!route) return route;

    const hashes = Array.isArray(route.property_hashes) ? route.property_hashes : [];
    const cacheKey = hydrationCacheKey(route, userEmail);
    // Only short-circuit when the in-memory properties cover EVERY hash —
    // partial coverage must fall through to backend hydration or doors get silently dropped.
    if (Array.isArray(route?.properties) && route.properties.length > 0) {
        const ordered = orderRouteProperties(route);
        if (hasCompleteRouteMapPoints(ordered)) {
            if (cacheKey && isRouteHydrationCacheable(ordered)) cacheHydratedRoute(cacheKey, ordered);
            return ordered;
        }
    }
    if (hashes.length === 0) return orderRouteProperties(route);

    const cachedRoute = cacheKey ? readHydratedRouteCache(cacheKey) : null;
    if (cachedRoute) return cachedRoute;
    if (cacheKey && routeHydrationInflight.has(cacheKey)) return routeHydrationInflight.get(cacheKey);

    const request = hydrateRouteWithLookup(route, ({ hashes: requestedHashes, routeId }) => (
        lookupRouteProperties({
            hashes: requestedHashes,
            routeId,
            userEmail
        })
    )).then(hydratedRoute => {
        // Do not make an outage or partial response sticky for the browser
        // session. A later render/refetch must be able to repair missing pins.
        if (cacheKey && isRouteHydrationCacheable(hydratedRoute)) {
            cacheHydratedRoute(cacheKey, hydratedRoute);
        }
        return hydratedRoute;
    }).finally(() => {
        if (cacheKey) routeHydrationInflight.delete(cacheKey);
    });

    if (cacheKey) routeHydrationInflight.set(cacheKey, request);
    return request;
}

export async function hydrateRoutesForMap(routes = [], userEmail = null, existingProperties = [], {
    onRouteHydrated = () => {},
    shouldContinue = () => true,
} = {}) {
    if (!Array.isArray(routes) || routes.length === 0) return [];

    const routeSig = manifestSignature(routes.map(route => (
        `${route.id || ''}:${route.updated_date || ''}:${manifestSignature(route.property_hashes || [])}`
    )));
    const propSig = manifestSignature(existingProperties.map(p => (
        `${p.address_hash || p.legacy_hash || p.id || ''}:${p.updated_date || p.effective_status || ''}`
    )));
    const viewer = String(userEmail || '').trim().toLowerCase();
    const collectionKey = viewer ? `${viewer}::${routeSig}::${propSig}` : null;
    if (collectionKey && routeCollectionHydrationCache.has(collectionKey)) {
        const cached = routeCollectionHydrationCache.get(collectionKey);
        cached.forEach((route, index) => { if (shouldContinue()) onRouteHydrated(route, index); });
        return cached;
    }

    const existingByHash = indexRouteProperties(existingProperties);
    const prepared = routes.map(route => {
        const hashes = Array.isArray(route.property_hashes) ? route.property_hashes : [];
        const cached = readHydratedRouteCache(hydrationCacheKey(route, userEmail));
        return orderRouteProperties(route, [
            ...(cached?.allProperties || cached?.properties || []),
            ...hashes.map(hash => existingByHash.get(String(hash))).filter(Boolean),
        ]);
    });
    const imported = prepared.filter(route => !hasCompleteRouteMapPoints(route) && route.id && isImportedRoute(route));
    const batchedIds = new Set();
    // Imported collections need one authorized read per group, rather than a
    // function/auth/manifest read for every route whenever the map mounts.
    if (viewer && imported.length > 1) {
        let batch = [];
        let hashCount = 0;
        const loadBatch = async () => {
            if (!batch.length || !shouldContinue()) return;
            const current = batch;
            const requestKey = `${viewer}::${manifestSignature(current.map(route => hydrationCacheKey(route, userEmail)))}`;
            let request = importedCollectionInflight.get(requestKey);
            if (!request) {
                request = withReadDeadline(() => base44.functions.invoke('getRoutePropertiesByHashes', {
                    route_ids: current.map(route => route.id),
                }), 30_000).finally(() => importedCollectionInflight.delete(requestKey));
                importedCollectionInflight.set(requestKey, request);
            }
            const response = await request;
            if (!Array.isArray(response.data?.routes)) throw new Error('Route homes could not be loaded.');
            const byId = new Map(response.data.routes.map(route => [route.id, route]));
            for (const route of current) {
                const index = prepared.findIndex(item => item.id === route.id);
                const hydrated = orderRouteProperties(route, byId.get(route.id)?.properties || []);
                prepared[index] = hydrated;
                batchedIds.add(route.id);
                const key = hydrationCacheKey(route, userEmail);
                if (key && isRouteHydrationCacheable(hydrated)) cacheHydratedRoute(key, hydrated);
                if (shouldContinue()) onRouteHydrated(hydrated, index);
            }
        };
        for (const route of imported) {
            const count = route.property_hashes?.length || 0;
            // Larger individual manifests keep the established paged loader.
            if (count > 5000) continue;
            if (batch.length >= 40 || hashCount + count > 5000) {
                await loadBatch();
                batch = [];
                hashCount = 0;
            }
            batch.push(route);
            hashCount += count;
        }
        await loadBatch();
    }
    const hydrated = await mapWithConcurrency(prepared, async (route, index) => {
        if (!shouldContinue()) return route;
        // A partial/throttled bulk read must not fan out into dozens of
        // individual recovery calls. The page retries just the missing routes.
        if (batchedIds.has(route.id)) return route;
        const result = await hydrateRouteForMap(route, userEmail);
        // A slow route must not hold every other route's pins behind the
        // collection promise. Cache and publish each finished route separately.
        if (shouldContinue()) onRouteHydrated(result, index);
        return result;
    });

    // As above, never make an empty/partial hydration result permanent.
    if (collectionKey && hydrated.every(isRouteHydrationCacheable)) {
        routeCollectionHydrationCache.set(collectionKey, hydrated);
        if (routeCollectionHydrationCache.size > MAX_ROUTE_COLLECTION_CACHE_ENTRIES) {
            const oldestKey = routeCollectionHydrationCache.keys().next().value;
            routeCollectionHydrationCache.delete(oldestKey);
        }
    }
    return hydrated;
}
