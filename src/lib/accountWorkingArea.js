import L from '@/components/map/leafletPatches';
import { isRenderableMapPoint } from '@/components/map/mapLayerVisibility.js';

function toLatLngPoints(points = []) {
    return points
        .map(p => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [Number(p?.lat), Number(p?.lng)]))
        .filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]) && (p[0] !== 0 || p[1] !== 0));
}

function routePinPoints(route) {
    return toLatLngPoints((route?.properties || []).filter(isRenderableMapPoint));
}

/**
 * Resolves where the map should open for this account.
 * Order: drawn boundary → saved routes (the real working area) → last map
 * position → most recent Precision pull area → loaded properties.
 * Returns null when nothing is known yet, or while saved routes are still
 * hydrating, so the map never jumps to an unrelated area first.
 */
export function computeAccountWorkingArea({
    drawnPolygon,
    user,
    savedRoutes = [],
    hydratedSavedRoutes = [],
    precisionFetchJobs = [],
    availableProperties = [],
} = {}) {
    // 1. Precision drawn boundary (state or persisted)
    let polygonToUse = drawnPolygon;
    if (!Array.isArray(polygonToUse) || polygonToUse.length < 3) {
        try {
            const storedDrawn = typeof localStorage !== 'undefined' ? localStorage.getItem('fk_drawnPolygon') : null;
            const parsed = storedDrawn ? JSON.parse(storedDrawn) : null;
            if (Array.isArray(parsed) && parsed.length >= 3) polygonToUse = parsed;
        } catch (e) {}
    }
    if (Array.isArray(polygonToUse) && polygonToUse.length >= 3) {
        const pts = toLatLngPoints(polygonToUse);
        if (pts.length >= 3) return { type: 'bounds', bounds: L.latLngBounds(pts) };
    }

    // 2. Active or most recent saved route — routes are the account's working
    // area, so they take priority over any stale last-map-position.
    const routesWithPins = (hydratedSavedRoutes || []).filter(r => routePinPoints(r).length > 0);
    if (routesWithPins.length > 0) {
        const activeOrRecent = routesWithPins.find(r => r.status !== 'COMPLETED') || routesWithPins[0];
        return { type: 'bounds', bounds: L.latLngBounds(routePinPoints(activeOrRecent)) };
    }
    // Routes exist but their pins have not hydrated yet — wait rather than
    // dropping the user in an unrelated area for a moment.
    if (Array.isArray(savedRoutes) && savedRoutes.length > 0) return null;

    // 3. Last map position for this account
    const storageKey = (user?.id || user?.email) ? `fk_last_map_position_${user.id || user.email}` : 'fk_last_map_position';
    if (typeof localStorage !== 'undefined') {
        try {
            const rawStored = localStorage.getItem(storageKey) || localStorage.getItem('fk_last_map_position');
            const stored = rawStored ? JSON.parse(rawStored) : null;
            if (stored && Number.isFinite(stored.lat) && Number.isFinite(stored.lng) && (stored.lat !== 0 || stored.lng !== 0)) {
                return { type: 'center', center: [stored.lat, stored.lng], zoom: stored.zoom || 15 };
            }
        } catch (e) {}
    }

    // 4. Most recent Precision fetch job boundary
    const mostRecentJob = Array.isArray(precisionFetchJobs) ? precisionFetchJobs[0] : null;
    if (Array.isArray(mostRecentJob?.polygon) && mostRecentJob.polygon.length >= 3) {
        const pts = toLatLngPoints(mostRecentJob.polygon);
        if (pts.length >= 3) return { type: 'bounds', bounds: L.latLngBounds(pts) };
    }

    // 5. Loaded properties, narrowed to the most recent ZIP
    const renderableProps = (availableProperties || []).filter(isRenderableMapPoint);
    if (renderableProps.length > 0) {
        const mostRecentZip = renderableProps.find(p => p.zip_code)?.zip_code;
        const zipProps = mostRecentZip ? renderableProps.filter(p => p.zip_code === mostRecentZip) : renderableProps;
        const pts = toLatLngPoints(zipProps).slice(0, 1000);
        if (pts.length > 0) return { type: 'bounds', bounds: L.latLngBounds(pts) };
    }

    return null;
}

export default computeAccountWorkingArea;