// Settings for ZoomOutBackdrop (kept free of Leaflet so tests can import them).
export const BACKDROP_LEVELS = Object.freeze([
    Object.freeze({ nativeZoom: 11, minZoom: 12 }),
    Object.freeze({ nativeZoom: 8, minZoom: 9 }),
]);
export const BACKDROP_RING_TILES = 1;

export function backdropLayerOptions(level) {
    return {
        minZoom: level.minZoom,
        maxZoom: 20,
        maxNativeZoom: level.nativeZoom,
        ringTiles: BACKDROP_RING_TILES,
        // Below the real basemap (zIndex 1) and its labels.
        zIndex: 0,
        // Keep backdrop tiles for the whole session area; they are few and coarse.
        keepBuffer: 6,
        updateWhenZooming: true,
        updateWhenIdle: false,
        // The real layer above already credits the provider.
        attribution: '',
        className: 'fk-zoom-backdrop',
    };
}
