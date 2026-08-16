const DEVELOPMENT_FALLBACK_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const DEVELOPMENT_FALLBACK_ATTRIBUTION = '&copy; OpenStreetMap contributors';
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
  const developmentFallback = env?.DEV === true
    && !conflictingBaseMaps
    && !xyzUrl
    && !pmtilesUrl
    && !useSatellite;
  const mode = conflictingBaseMaps
    ? 'invalid'
    : useSatellite || xyzUrl || developmentFallback
      ? 'xyz'
      : pmtilesUrl
        ? 'pmtiles'
        : 'none';
  const url = mode === 'pmtiles'
    ? pmtilesUrl
    : mode === 'xyz'
      ? useSatellite ? satelliteUrl : xyzUrl || DEVELOPMENT_FALLBACK_URL
      : null;
  const attribution = configured(useSatellite
    ? env?.VITE_CANVAS_SATELLITE_ATTRIBUTION
    : env?.VITE_CANVAS_BASEMAP_ATTRIBUTION) || (developmentFallback ? DEVELOPMENT_FALLBACK_ATTRIBUTION : '');
  const requestedFlavor = configured(env?.VITE_CANVAS_BASEMAP_PMTILES_FLAVOR)?.toLowerCase();
  const flavor = PMTILES_FLAVORS.has(requestedFlavor) ? requestedFlavor : 'dark';

  return Object.freeze({
    url,
    mode,
    flavor,
    attribution,
    configured: Boolean(url) && !developmentFallback,
    conflict: conflictingBaseMaps,
    developmentFallback,
    satelliteAvailable: Boolean(satelliteUrl),
  });
}