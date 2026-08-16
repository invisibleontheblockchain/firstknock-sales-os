// Canvas has exactly one basemap, and it is identical in the dev preview, the
// published web app, and the native builds.
//
// The default lives here in code rather than only in `.env` because Vite reads
// env files once at server start and bakes them at build time: an env file that
// is missing, unloaded, or added without a restart produced a fully black map.
// Precision likewise hardcodes its CARTO URLs (src/components/map/BaseMapTiles.jsx),
// so this adds no new provider dependency.
//
// This default is UNCONDITIONAL — never keyed off DEV/PROD. A mode-specific
// substitute is a second visual variation, and that is exactly the bug where the
// Base44 preview and phones rendered different maps. The env vars below stay
// supported as a deliberate override, applied the same way in every mode.
const DEFAULT_BASEMAP = Object.freeze({
  url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
});

// 'carto' is our OSM-Carto-styled theme (canvasCartoFlavor.js); the rest are
// protomaps-leaflet built-ins, kept available as an env override.
const PMTILES_FLAVORS = new Set(['carto', 'light', 'dark', 'white', 'grayscale', 'black']);

function configured(value) {
  const result = String(value || '').trim();
  return result || null;
}

export function getCanvasBasemapConfiguration({ satellite = false, env = {} } = {}) {
  const xyzUrl = configured(env?.VITE_CANVAS_BASEMAP_TILE_URL)
    || (configured(env?.VITE_CANVAS_BASEMAP_PMTILES_URL) ? null : DEFAULT_BASEMAP.url);
  const pmtilesUrl = configured(env?.VITE_CANVAS_BASEMAP_PMTILES_URL);
  const satelliteUrl = configured(env?.VITE_CANVAS_SATELLITE_TILE_URL);
  const conflictingBaseMaps = Boolean(xyzUrl && pmtilesUrl);
  const useSatellite = Boolean(satellite && satelliteUrl);
  const mode = conflictingBaseMaps
    ? 'invalid'
    : useSatellite || xyzUrl
      ? 'xyz'
      : pmtilesUrl
        ? 'pmtiles'
        : 'none';
  const url = mode === 'pmtiles'
    ? pmtilesUrl
    : mode === 'xyz'
      ? useSatellite ? satelliteUrl : xyzUrl
      : null;
  const attribution = configured(useSatellite
    ? env?.VITE_CANVAS_SATELLITE_ATTRIBUTION
    : env?.VITE_CANVAS_BASEMAP_ATTRIBUTION)
    || (url === DEFAULT_BASEMAP.url ? DEFAULT_BASEMAP.attribution : '');
  const requestedFlavor = configured(env?.VITE_CANVAS_BASEMAP_PMTILES_FLAVOR)?.toLowerCase();
  const flavor = PMTILES_FLAVORS.has(requestedFlavor) ? requestedFlavor : 'carto';

  return Object.freeze({
    url,
    mode,
    flavor,
    attribution,
    configured: Boolean(url),
    conflict: conflictingBaseMaps,
    satelliteAvailable: Boolean(satelliteUrl),
  });
}