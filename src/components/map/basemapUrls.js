// Basemap tile sources, shared by the map's tile layers and the startup tile
// warm-up so both always request byte-identical URLs. Free of Leaflet so it
// can load with the app shell.
export const BASEMAP_URLS = {
    satellite: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    hybrid: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=cb1_47jm_1_e43254c2ef5a3cbfc430e52f",
    dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=cb1_47jm_1_e43254c2ef5a3cbfc430e52f",
    streets: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=cb1_47jm_1_e43254c2ef5a3cbfc430e52f",
    terrain: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    minimal: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png?key=cb1_47jm_1_e43254c2ef5a3cbfc430e52f",
};

export const LABEL_URL = "https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png?key=cb1_47jm_1_e43254c2ef5a3cbfc430e52f";

// Leaflet's defaults for these layers.
const SUBDOMAINS = ['a', 'b', 'c'];
const TILE_SIZE = 256;
export const MAX_NATIVE_ZOOM = 19;

// Phones and tablets (WebKit) cap the GPU memory for composited layers, and
// past that cap Safari paints tiles black: the owner's iPhone map went black
// except for the labels after zooming around routes. Leaflet places every tile
// with a 3D transform, which Safari composites as its own layer (~2.4 MB per
// tile at 3x), so on touch devices keep only a one-tile ring and load when a
// pan or zoom settles, as Leaflet's own mobile defaults do. Desktop is unchanged.
export function basemapTileOptions({ phone = false } = {}) {
    return phone
        ? { keepBuffer: 1, updateWhenZooming: false, updateWhenIdle: true, maxNativeZoom: MAX_NATIVE_ZOOM, maxZoom: 20 }
        : { keepBuffer: 3, updateWhenZooming: true, updateWhenIdle: false, maxNativeZoom: MAX_NATIVE_ZOOM, maxZoom: 20 };
}

export const precisionThemeFor = (mapTheme = 'hybrid') => (mapTheme.startsWith('light_') ? 'light' : mapTheme);
export const showsLabelsFor = (mapTheme = 'hybrid') => mapTheme === 'hybrid' || mapTheme === 'satellite';

// The Web Mercator pixel Leaflet projects a point to at a given zoom.
function projectToPixel(lat, lng, zoom) {
    const scale = TILE_SIZE * 2 ** zoom;
    const clampedLat = Math.max(Math.min(lat, 85.0511287798), -85.0511287798);
    const sin = Math.sin(clampedLat * Math.PI / 180);
    return {
        x: scale * (lng / 360 + 0.5),
        y: scale * (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)),
    };
}

/**
 * The tiles Leaflet requests for a view: the same tile zoom (rounded view zoom,
 * capped at the native maximum), pixel bounds and tile range as GridLayer.
 */
export function tileCoordsForView({ center, zoom }, { width, height }) {
    const viewZoom = Math.round(zoom * 4) / 4;
    const tileZoom = Math.min(Math.round(viewZoom), MAX_NATIVE_ZOOM);
    const scale = 2 ** (viewZoom - tileZoom);
    const pixel = projectToPixel(center[0], center[1], tileZoom);
    const cx = Math.floor(pixel.x), cy = Math.floor(pixel.y);
    const halfW = width / (scale * 2), halfH = height / (scale * 2);
    const minX = Math.floor((cx - halfW) / TILE_SIZE), maxX = Math.ceil((cx + halfW) / TILE_SIZE) - 1;
    const minY = Math.floor((cy - halfH) / TILE_SIZE), maxY = Math.ceil((cy + halfH) / TILE_SIZE) - 1;
    const limit = 2 ** tileZoom;
    const coords = [];
    for (let y = Math.max(0, minY); y <= Math.min(limit - 1, maxY); y += 1) {
        for (let x = minX; x <= maxX; x += 1) coords.push({ x: ((x % limit) + limit) % limit, y, z: tileZoom });
    }
    // Centre first, as Leaflet orders its queue.
    const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
    return coords.sort((a, b) => Math.hypot(a.x - midX, a.y - midY) - Math.hypot(b.x - midX, b.y - midY));
}

export function tileUrl(template, { x, y, z }, { retina = false } = {}) {
    return template
        .replace('{s}', SUBDOMAINS[Math.abs(x + y) % SUBDOMAINS.length])
        .replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
        .replace('{r}', retina ? '@2x' : '');
}

/** Every basemap tile URL the map will request first for this view and theme. */
export function basemapTileUrlsForView(view, size, { mapTheme = 'hybrid', retina = false } = {}) {
    const theme = precisionThemeFor(mapTheme);
    const templates = [BASEMAP_URLS[theme] || BASEMAP_URLS.dark, ...(showsLabelsFor(mapTheme) ? [LABEL_URL] : [])];
    const coords = tileCoordsForView(view, size);
    return templates.flatMap((template) => coords.map((coord) => tileUrl(template, coord, { retina })));
}
