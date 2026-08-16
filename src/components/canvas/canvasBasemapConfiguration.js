// Canvas must always render a basemap. VITE_ values are not reliably injected
// into the deployed browser bundle, and returning no tile source left the whole
// Canvas map black while Precision (which hardcodes its tile URLs) worked. So an
// absent configuration falls back to the same providers Precision uses instead
// of rendering nothing. A conflicting configuration still fails closed.
const DEFAULT_STREETS_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const DEFAULT_SATELLITE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const DEFAULT_STREETS_ATTRIBUTION = '&copy; OpenStreetMap contributors, &copy; CARTO';
const DEFAULT_SATELLITE_ATTRIBUTION = 'Imagery &copy; Esri';
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
  const useSatellite = Boolean(satellite);
  const usingDefaultBasemap = !conflictingBaseMaps
    && (useSatellite ? !satelliteUrl : !xyzUrl && !pmtilesUrl);
  const mode = conflictingBaseMaps
    ? 'invalid'
    : useSatellite || xyzUrl || usingDefaultBasemap
      ? 'xyz'
      : 'pmtiles';
  const url = mode === 'invalid'
    ? null
    : mode === 'pmtiles'
      ? pmtilesUrl
      : useSatellite
        ? satelliteUrl || DEFAULT_SATELLITE_URL
        : xyzUrl || DEFAULT_STREETS_URL;
  const attribution = configured(useSatellite
    ? env?.VITE_CANVAS_SATELLITE_ATTRIBUTION
    : env?.VITE_CANVAS_BASEMAP_ATTRIBUTION)
    || (usingDefaultBasemap
      ? useSatellite ? DEFAULT_SATELLITE_ATTRIBUTION : DEFAULT_STREETS_ATTRIBUTION
      : '');
  const requestedFlavor = configured(env?.VITE_CANVAS_BASEMAP_PMTILES_FLAVOR)?.toLowerCase();
  const flavor = PMTILES_FLAVORS.has(requestedFlavor) ? requestedFlavor : 'dark';

  return Object.freeze({
    url,
    mode,
    flavor,
    attribution,
    configured: Boolean(url) && !usingDefaultBasemap,
    conflict: conflictingBaseMaps,
    usingDefaultBasemap,
    satelliteAvailable: Boolean(satelliteUrl) || usingDefaultBasemap,
  });
}