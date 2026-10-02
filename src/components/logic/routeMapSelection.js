import { hasCompleteRouteMapPoints, orderRouteProperties } from './routeHydrationCore.js';
import { isRenderableMapPoint } from '../map/mapLayerVisibility.js';

export async function loadSavedRouteSelection(route, properties, hydrate) {
    let selected = orderRouteProperties(route, properties);
    if (!hasCompleteRouteMapPoints(selected)) selected = await hydrate(selected);
    if (!hasCompleteRouteMapPoints(selected)) {
        throw new Error('Some route homes could not be loaded. Please retry opening the route.');
    }
    return {
        ...selected,
        houseCount: selected.property_hashes?.length || selected.metrics?.house_count || selected.properties?.length || 0,
        totalDistance: selected.metrics?.distance || 0,
        competitivenessScore: selected.metrics?.score || 0,
        isSaved: true,
    };
}

export function getReadyRouteMapPoints(route) {
    if (!route || !hasCompleteRouteMapPoints(route)) return null;
    const properties = route.allProperties || route.properties || [];
    const points = properties.filter(isRenderableMapPoint).map(p => [Number(p.lat), Number(p.lng)]);
    if (!points.length) return null;
    const mode = route.routeOriginMode || route.route_origin_mode || route.metadata?.route_bounds?.mode;
    if (['home_round_trip', 'current_to_home', 'anchor_round_trip'].includes(mode)) {
        const start = route.startLocation || route.start_location;
        const end = route.endLocation || route.end_location;
        if (isRenderableMapPoint(start)) points.unshift([Number(start.lat), Number(start.lng)]);
        if (isRenderableMapPoint(end)) points.push([Number(end.lat), Number(end.lng)]);
    }
    return points;
}
