// Canvas has exactly one basemap, configured once in `.env` and therefore
// identical in the dev preview, the published web app, and the native builds.
// There is deliberately no mode-specific fallback: a dev-only substitute tile
// source is a second visual variation, and it silently shipped a different map
// to the Base44 preview than to phones. A missing configuration must render
// nothing so the misconfiguration is visible instead of disguised.
const PMTILES_FLAVORS = new Set(['light', 'dark', 'white', 'grayscale', 'black']);

function configured(value) {
  const result = String(value || '').trim();
  return result || null;
}

export function getCanvasBasemapConfiguration({ satellite = false, env = {} } = {}) {
  const xyzUrl = configured(env?.VITE_CANVAS_BASEMAP_TILE_URL);
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
    : env?.VITE_CANVAS_BASEMAP_ATTRIBUTION) || '';
  const requestedFlavor = configured(env?.VITE_CANVAS_BASEMAP_PMTILES_FLAVOR)?.toLowerCase();
  const flavor = PMTILES_FLAVORS.has(requestedFlavor) ? requestedFlavor : 'dark';

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