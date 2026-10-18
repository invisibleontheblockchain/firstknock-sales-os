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

// Where the person last looked at the map, written only by their own moves
// (never by an automatic fit), per user and device.
export const mapViewStorageKey = user => ((user?.id || user?.email) ? `fk_map_view_v2_${user.id || user.email}` : null);

export function readStoredMapView(user) {
    const key = mapViewStorageKey(user);
    if (!key || typeof localStorage === 'undefined') return null;
    try {
        const stored = JSON.parse(localStorage.getItem(key));
        if (stored && Number.isFinite(stored.lat) && Number.isFinite(stored.lng) && (stored.lat !== 0 || stored.lng !== 0)) {
            return { center: [stored.lat, stored.lng], zoom: Number.isFinite(stored.zoom) ? stored.zoom : 15 };
        }
    } catch { /* unreadable storage: no stored view */ }
    return null;
}

export function storeMapView(user, center, zoom) {
    const key = mapViewStorageKey(user);
    if (!key || typeof localStorage === 'undefined' || !center) return;
    if (!Number.isFinite(center.lat) || !Number.isFinite(center.lng) || (center.lat === 0 && center.lng === 0)) return;
    try { localStorage.setItem(key, JSON.stringify({ lat: center.lat, lng: center.lng, zoom })); } catch { /* storage full or blocked */ }
}

/**
 * Where the map opens: the person's working area, never "everything".
 * 1. The last view they moved to on this device (instant, needs no data).
 * 2. A drawn Precision boundary.
 * 3. One route: their active (not completed) route, else the most recent —
 *    a rep's assigned route, or a manager's latest. Only that route's pins
 *    are needed, so it resolves as soon as that route loads.
 * 4. The most recent Precision pull area, then loaded properties, then GPS.
 * Seeing all routes is an explicit action ("Show all routes"), never automatic.
 * Returns null while the data a step needs is still loading.
 */
export function computeAccountWorkingArea({
    drawnPolygon,
    user,
    savedRoutes = [],
    savedRoutesReady = true,
    hydratedSavedRoutes = [],
    precisionFetchJobs = [],
    availableProperties = [],
    gpsLocation = null,
} = {}) {
    // 1. The last view this person moved to on this device.
    const stored = readStoredMapView(user);
    if (stored) return { type: 'center', ...stored };

    // 2. Precision drawn boundary (state or persisted)
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

    // 3. One route: the active one, else the most recent. Wait for the list,
    // then for that one route's pins only.
    if (!savedRoutesReady) return null;
    if (Array.isArray(savedRoutes) && savedRoutes.length > 0) {
        const target = savedRoutes.find(route => route.status !== 'COMPLETED' && route.status !== 'ARCHIVED') || savedRoutes[0];
        const hydrated = (hydratedSavedRoutes || []).find(route => route.id === target.id);
        const points = routePinPoints(hydrated);
        return points.length ? { type: 'bounds', bounds: L.latLngBounds(points) } : null;
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

    // 6. Where the person is, when the browser shares it.
    if (gpsLocation && Number.isFinite(gpsLocation.lat) && Number.isFinite(gpsLocation.lng)) {
        return { type: 'center', center: [gpsLocation.lat, gpsLocation.lng], zoom: 15 };
    }
    return null;
}

export default computeAccountWorkingArea;
