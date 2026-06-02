const DEFAULT_HIGHWAY_FILTER = 'primary|secondary|tertiary|residential';
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

function stablePolygonKey(polygon = []) {
  return polygon
    .filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng))
    .map((point) => `${Number(point.lat).toFixed(6)},${Number(point.lng).toFixed(6)}`)
    .join('|');
}

function polygonToOverpassPoly(polygon = []) {
  return polygon
    .filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng))
    .map((point) => `${Number(point.lat).toFixed(6)} ${Number(point.lng).toFixed(6)}`)
    .join(' ');
}

function buildOverpassQuery(polygon, highwayFilter = DEFAULT_HIGHWAY_FILTER) {
  const poly = polygonToOverpassPoly(polygon);
  const safeFilter = String(highwayFilter || DEFAULT_HIGHWAY_FILTER).replace(/[^a-z_|]/gi, '') || DEFAULT_HIGHWAY_FILTER;
  return `[out:json][timeout:25];
(
  way["highway"~"^(${safeFilter})$"]["bridge"!="yes"]["tunnel"!="yes"](poly:"${poly}");
);
out body;
>;
out skel qt;`;
}

async function fetchWithTimeout(url, body, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ data: body }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export function getRoadNetworkCacheKey(polygon, highwayFilter = DEFAULT_HIGHWAY_FILTER) {
  return `fk_overpass_${highwayFilter}_${stablePolygonKey(polygon)}`;
}

export async function fetchOverpassRoadNetwork(polygon, options = {}) {
  const highwayFilter = options.highwayFilter || DEFAULT_HIGHWAY_FILTER;
  const timeoutMs = Math.max(5000, Number(options.timeoutMs) || 25000);
  const query = buildOverpassQuery(polygon, highwayFilter);
  const cacheKey = getRoadNetworkCacheKey(polygon, highwayFilter);

  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed?.elements?.length) {
        console.info(`[FK] Canvas road network cache hit: ${parsed.elements.length} OSM elements`);
        return parsed;
      }
    }
  } catch {}

  let lastError = null;
  for (const url of OVERPASS_URLS) {
    try {
      const data = await fetchWithTimeout(url, query, timeoutMs);
      if (!Array.isArray(data?.elements)) throw new Error('Malformed Overpass response');
      try {
        const serialized = JSON.stringify(data);
        if (serialized.length < 4_500_000) sessionStorage.setItem(cacheKey, serialized);
      } catch {}
      console.info(`[FK] Canvas road network fetched: ${data.elements.length} OSM elements`);
      return data;
    } catch (error) {
      lastError = error;
      console.warn(`[FK] Overpass fetch failed via ${url}:`, error?.message || error);
    }
  }

  throw lastError || new Error('Overpass road network unavailable');
}