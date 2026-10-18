// Settings for ZoomOutBackdrop (kept free of Leaflet so tests can import them).
// On phones each level only covers its own band (phoneMaxZoom), so one
// backdrop layer is active at a time instead of two.
export const BACKDROP_LEVELS = Object.freeze([
    Object.freeze({ nativeZoom: 11, minZoom: 12, phoneMaxZoom: 20 }),
    Object.freeze({ nativeZoom: 8, minZoom: 9, phoneMaxZoom: 11 }),
]);
export const BACKDROP_RING_TILES = 1;

export function backdropLayerOptions(level, { phone = false } = {}) {
    return {
        minZoom: level.minZoom,
        maxZoom: phone ? level.phoneMaxZoom : 20,
        maxNativeZoom: level.nativeZoom,
        ringTiles: BACKDROP_RING_TILES,
        // Below the real basemap (zIndex 1) and its labels.
        zIndex: 0,
        // Desktop keeps backdrop tiles for the whole session area; they are few
        // and coarse. Phones keep only the ring around the view (see
        // basemapTileOptions in basemapUrls.js: Safari paints tiles black past its layer memory).
        keepBuffer: phone ? 1 : 6,
        updateWhenZooming: true,
        updateWhenIdle: false,
        // The real layer above already credits the provider.
        attribution: '',
        className: 'fk-zoom-backdrop',
    };
}
