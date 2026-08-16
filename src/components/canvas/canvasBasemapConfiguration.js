// Canvas basemaps are identical in the dev preview, the published web app, and
// the native builds.
//
// The defaults live here in code rather than only in `.env` because Vite reads
// env files once at server start and bakes them at build time: an env file that
// is missing, unloaded, or added without a restart produced a fully black map.
// Precision likewise hardcodes its CARTO URLs (src/components/map/BaseMapTiles.jsx),
// so this adds no new provider dependency.
//
// These defaults are UNCONDITIONAL — never keyed off DEV/PROD. A mode-specific
// substitute is a second visual variation, and that is exactly the bug where the
// Base44 preview and phones rendered different maps. The env vars below stay
// supported as a deliberate override, applied the same way in every mode.
const DEFAULT_BASEMAP = Object.freeze({
  url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
});

// Map Style in Map Settings offers the same four choices in both modes. Dark and
// satellite are their own sources, so they are pinned to constants instead of the
// street override — a manager picking Dark must not get the light street tiles.
const DARK_BASEMAP = Object.freeze({
  url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
});

const SATELLITE_BASEMAP = Object.freeze({
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  attribution: 'Imagery &copy; Esri',
});

// 'carto' is our OSM-Carto-styled theme (canvasCartoFlavor.js); the rest are
// protomaps-leaflet built-ins, kept available as an env override.
const PMTILES_FLAVORS = new Set(['carto', 'light', 'dark', 'white', 'grayscale', 'black']);

const SATELLITE_THEMES = new Set(['satellite', 'hybrid']);

function configured(value) {
  const result = String(value || '').trim();
  return result || null;
}

export function getCanvasBasemapConfiguration({ theme = 'light', satellite = false, env = {} } = {}) {
  const wantsSatellite = Boolean(satellite) || SATELLITE_THEMES.has(theme);
  const wantsDark = theme === 'dark';
  const pmtilesUrl = configured(env?.VITE_CANVAS_BASEMAP_PMTILES_URL);
  // A self-hosted vector archive serves every street theme; it carries its own
  // dark palette, so Dark stays on PMTiles rather than falling back to raster.
  const streetUrl = pmtilesUrl
    ? null
    : wantsDark
      ? DARK_BASEMAP.url
      : configured(env?.VITE_CANVAS_BASEMAP_TILE_URL) || DEFAULT_BASEMAP.url;
  const satelliteUrl = configured(env?.VITE_CANVAS_SATELLITE_TILE_URL) || SATELLITE_BASEMAP.url;
  const conflictingBaseMaps = Boolean(configured(env?.VITE_CANVAS_BASEMAP_TILE_URL) && pmtilesUrl);
  const mode = conflictingBaseMaps
    ? 'invalid'
    : wantsSatellite || streetUrl
      ? 'xyz'
      : pmtilesUrl
        ? 'pmtiles'
        : 'none';
  const url = mode === 'pmtiles'
    ? pmtilesUrl
    : mode === 'xyz'
      ? wantsSatellite ? satelliteUrl : streetUrl
      : null;
  const attribution = configured(wantsSatellite
    ? env?.VITE_CANVAS_SATELLITE_ATTRIBUTION
    : env?.VITE_CANVAS_BASEMAP_ATTRIBUTION)
    || (url === SATELLITE_BASEMAP.url ? SATELLITE_BASEMAP.attribution : '')
    || (url === DEFAULT_BASEMAP.url || url === DARK_BASEMAP.url ? DEFAULT_BASEMAP.attribution : '');
  const requestedFlavor = configured(env?.VITE_CANVAS_BASEMAP_PMTILES_FLAVOR)?.toLowerCase();
  const flavor = PMTILES_FLAVORS.has(requestedFlavor)
    ? requestedFlavor
    : wantsDark ? 'dark' : 'carto';

  return Object.freeze({
    url,
    mode,
    flavor,
    attribution,
    configured: Boolean(url),
    conflict: conflictingBaseMaps,
    satelliteAvailable: true,
  });
}