import { orderRouteProperties } from '@/components/logic/routeHydrationCore';

export function countChangedRouteStops(before = [], after = []) {
    return after.filter((hash, index) => String(hash) !== String(before[index])).length;
}

function applySavedOrder(current, saved, properties) {
    return {
        ...orderRouteProperties({ ...current, ...saved, properties: [], allProperties: [] }, [
            ...properties,
            ...(current?.allProperties || []),
            ...(current?.properties || []),
        ]),
        houseCount: saved.property_hashes.length,
        totalDistance: saved.metrics?.distance,
        routeOriginMode: saved.route_origin_mode,
        startLocation: saved.start_location ?? null,
        endLocation: saved.end_location ?? null,
    };
}

// A completed solver request is not a completed Optimize action. Confirm the
// persisted manifest, then publish that same order to the map and route caches.
export async function persistOptimizedRoute({ route, update, properties, client, queryClient, setActiveRoute, session = {} }) {
    let response = await client.entities.SavedRoute.update(route.id, update);
    if (!Array.isArray(response?.property_hashes)) {
        response = await client.entities.SavedRoute.get(route.id);
    }
    if ((response?.id && response.id !== route.id)
        || !Array.isArray(response?.property_hashes)
        || response.property_hashes.length !== update.property_hashes.length
        || countChangedRouteStops(update.property_hashes, response.property_hashes) !== 0) {
        throw new Error('The saved route did not keep the optimized stop order. Refresh the route and try again.');
    }
    const saved = { ...route, ...update, ...response, id: route.id };
    await syncOptimizedRoute({ saved, properties, queryClient, setActiveRoute, session });
    return saved;
}

export async function syncOptimizedRoute({ saved, properties, queryClient, setActiveRoute, session = {}, metadataOnly = false }) {
    const roots = ['savedRoutes', 'myRoutes', 'savedRouteMapProperties', 'routeMap'];
    // An older hydration/list request must not finish after this write and put
    // the original order back into the cache when the route is reopened.
    await queryClient?.cancelQueries({ predicate: query => roots.includes(query.queryKey[0]) });
    const updateRoute = current => metadataOnly
        ? { ...current, metadata: saved.metadata, ...(saved.updated_date ? { updated_date: saved.updated_date } : {}) }
        : applySavedOrder(current, saved, properties);
    const replace = current => {
        if (Array.isArray(current)) return current.map(replace);
        if (current?.id === saved.id) return updateRoute(current);
        if (Array.isArray(current?.items)) return { ...current, items: current.items.map(replace) };
        return current;
    };
    for (const root of roots) queryClient?.setQueriesData({ queryKey: [root] }, replace);
    // Read the current selection when the request finishes, not the selection
    // captured when a potentially minute-long optimization was started.
    setActiveRoute?.(current => current?.id === saved.id
        ? { ...updateRoute(current), ...session }
        : current);
    await Promise.allSettled(['savedRoutes', 'myRoutes'].map(root =>
        queryClient?.invalidateQueries({ queryKey: [root] })
    ));
}
