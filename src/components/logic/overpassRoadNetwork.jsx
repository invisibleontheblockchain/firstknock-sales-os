const DEFAULT_HIGHWAY_FILTER = 'primary|secondary|tertiary|unclassified|residential|living_street';
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const DEFAULT_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

function stablePolygonKey(polygon = []) {
  return polygon
    .filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng))
    .map((point) => `${Number(point.lat).toFixed(7)},${Number(point.lng).toFixed(7)}`)
    .join('|');
}

function polygonToOverpassPoly(polygon = []) {
  return polygon
    .filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng))
    .map((point) => `${Number(point.lat).toFixed(7)} ${Number(point.lng).toFixed(7)}`)
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
out body qt;`;
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

export function clearOverpassRoadNetworkCache(polygon, highwayFilter = DEFAULT_HIGHWAY_FILTER) {
  try {
    sessionStorage.removeItem(getRoadNetworkCacheKey(polygon, highwayFilter));
  } catch {}
}

export async function fetchOverpassRoadNetwork(polygon, options = {}) {
  const highwayFilter = options.highwayFilter || DEFAULT_HIGHWAY_FILTER;
  const timeoutMs = Math.max(5000, Number(options.timeoutMs) || 25000);
  const cacheMaxAgeMs = Math.max(0, Number(options.cacheMaxAgeMs) || DEFAULT_CACHE_MAX_AGE_MS);
  const query = buildOverpassQuery(polygon, highwayFilter);
  const cacheKey = getRoadNetworkCacheKey(polygon, highwayFilter);

  if (options.bypassCache === true) clearOverpassRoadNetworkCache(polygon, highwayFilter);
  else {
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) {
        const record = JSON.parse(cached);
        const cachedAt = Number(record?.cached_at);
        const data = record?.data;
        if (Number.isFinite(cachedAt) && Date.now() - cachedAt <= cacheMaxAgeMs && data?.elements?.length) {
          console.info(`[FK] Canvas road network cache hit: ${data.elements.length} OSM elements`);
          return data;
        }
        sessionStorage.removeItem(cacheKey);
      }
    } catch {}
  }

  let lastError = null;
  for (const url of OVERPASS_URLS) {
    try {
      const data = await fetchWithTimeout(url, query, timeoutMs);
      if (!Array.isArray(data?.elements)) throw new Error('Malformed Overpass response');
      try {
        const serialized = JSON.stringify({ cached_at: Date.now(), data });
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
