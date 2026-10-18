// Where the person last looked at the map, written only by their own moves
// (never by an automatic fit), per user and device. Kept free of Leaflet so
// startup code can read it before the map chunk loads.
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
