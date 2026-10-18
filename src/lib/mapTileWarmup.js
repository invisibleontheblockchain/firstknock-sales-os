import { basemapTileUrlsForView } from '../components/map/basemapUrls.js';
import { readStoredMapView } from './mapViewStorage.js';

// The map opens on the last view saved on this device, so its first tiles are
// known before the map chunk has even downloaded. Requesting them at sign-in
// means the tile layer finds them already loading or cached instead of
// starting from nothing (and from a cold connection) after the map mounts.
export const MAX_WARM_TILES = 40;
const warming = [];

function readPrecisionTheme(storage) {
    try {
        if (storage?.getItem('fk_routeMode') === 'canvas') return null; // Canvas draws its own basemap
        return storage?.getItem('fk_mapTheme_v3') || 'hybrid';
    } catch {
        return 'hybrid';
    }
}

export function mapTileWarmupUrls(user, { win = globalThis.window, storage = globalThis.localStorage } = {}) {
    if (!win) return [];
    const mapTheme = readPrecisionTheme(storage);
    const view = mapTheme && readStoredMapView(user);
    if (!view) return [];
    const size = { width: win.innerWidth || 0, height: win.innerHeight || 0 };
    if (!size.width || !size.height) return [];
    return basemapTileUrlsForView(view, size, { mapTheme, retina: (win.devicePixelRatio || 1) > 1 }).slice(0, MAX_WARM_TILES);
}

export function warmMapTiles(user, options = {}) {
    const win = options.win || globalThis.window;
    if (!win?.Image) return [];
    const urls = mapTileWarmupUrls(user, { ...options, win });
    urls.forEach((url) => {
        const image = new win.Image();
        image.decoding = 'async';
        image.src = url;
        warming.push(image); // keep a reference so the request is not dropped
    });
    // Release the references once the map has had time to take over.
    if (urls.length && typeof win.setTimeout === 'function') win.setTimeout(() => { warming.length = 0; }, 30_000);
    return urls;
}

// Basemap hosts the map's first tiles come from (imagery, then CARTO labels on
// its subdomains). Opening their connections while the app boots takes the
// TLS handshakes (~0.5 s each on cellular) off the map's first paint.
export const MAP_TILE_ORIGINS = Object.freeze([
    'https://server.arcgisonline.com',
    'https://a.basemaps.cartocdn.com',
    'https://b.basemaps.cartocdn.com',
    'https://c.basemaps.cartocdn.com',
]);
const MAP_PAGES = new Set(['Home', 'RoleSelect']);

export function preconnectMapHosts(pageName, doc = globalThis.document) {
    if (!MAP_PAGES.has(pageName) || !doc?.head) return 0;
    let added = 0;
    MAP_TILE_ORIGINS.forEach((origin) => {
        if (doc.head.querySelector(`link[rel="preconnect"][href="${origin}"]`)) return;
        const link = doc.createElement('link');
        link.rel = 'preconnect';
        link.href = origin; // tiles are plain <img> requests, so no crossorigin attribute
        doc.head.appendChild(link);
        added += 1;
    });
    return added;
}
