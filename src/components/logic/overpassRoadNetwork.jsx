const DEFAULT_HIGHWAY_FILTER = 'primary|secondary|tertiary|unclassified|residential|living_street';
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const DEFAULT_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const LARGE_AREA_TILE_THRESHOLD_SQ_MI = 20;
const TARGET_TILE_SIDE_MILES = 5;
const MAX_BROWSER_TILES = 144;
const DEFAULT_TILE_CONCURRENCY = 2;
const MAX_BROWSER_OSM_JSON_BYTES = 20_000_000;
const MAX_BROWSER_OSM_ELEMENTS = 250_000;
const MAX_BROWSER_TILE_JSON_BYTES = 8_000_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 180_000;

export class CanvasRoadNetworkError extends Error {
  constructor(message, {
    code = 'CANVAS_ROAD_NETWORK_UNAVAILABLE',
    status = null,
    endpoint = null,
    failures = [],
  } = {}) {
    super(message);
    this.name = 'CanvasRoadNetworkError';
    this.code = code;
    this.status = status;
    this.endpoint = endpoint;
    this.failures = failures;
  }
}

function endpointName(url) {
  try { return new URL(url).hostname; } catch { return String(url || 'unknown'); }
}

function canvasRequestReferrer() {
  try {
    const origin = String(globalThis.location?.origin || '').trim();
    return /^https?:\/\//i.test(origin) ? `${origin.replace(/\/$/, '')}/` : null;
  } catch {
    return null;
  }
}

function httpFailureCode(status) {
  if (status === 429) return 'CANVAS_ROAD_NETWORK_RATE_LIMITED';
  if ([408, 425, 502, 503, 504].includes(status)) return 'CANVAS_ROAD_NETWORK_SERVICE_BUSY';
  return 'CANVAS_ROAD_NETWORK_HTTP_ERROR';
}

function roadNetworkResult(data, url) {
  const elements = Array.isArray(data?.elements) ? data.elements : [];
  return {
    ...data,
    elements,
    _canvas: {
      status: elements.length ? 'ready' : 'empty',
      source: endpointName(url),
      fetched_at: new Date().toISOString(),
    },
  };
}

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

function buildOverpassQuery(
  polygon,
  highwayFilter = DEFAULT_HIGHWAY_FILTER,
  { includeGradeSeparated = false } = {},
) {
  const poly = polygonToOverpassPoly(polygon);
  const safeFilter = String(highwayFilter || DEFAULT_HIGHWAY_FILTER).replace(/[^a-z_|]/gi, '') || DEFAULT_HIGHWAY_FILTER;
  const gradeFilter = includeGradeSeparated ? '' : '["bridge"!="yes"]["tunnel"!="yes"]';
  return `[out:json][timeout:25];
(
  way["highway"~"^(${safeFilter})$"]${gradeFilter}(poly:"${poly}");
);
out body;
>;
out body qt;`;
}

function polygonBounds(polygon = []) {
  const points = polygon.filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng));
  if (!points.length) return null;
  return {
    south: Math.min(...points.map((point) => Number(point.lat))),
    west: Math.min(...points.map((point) => Number(point.lng))),
    north: Math.max(...points.map((point) => Number(point.lat))),
    east: Math.max(...points.map((point) => Number(point.lng))),
  };
}

function approximateBoundsSizeMiles(bounds) {
  if (!bounds) return { width: 0, height: 0, area: 0 };
  const centerLatitude = (bounds.south + bounds.north) / 2;
  const width = Math.max(0, (bounds.east - bounds.west) * 69 * Math.cos(centerLatitude * Math.PI / 180));
  const height = Math.max(0, (bounds.north - bounds.south) * 69);
  return { width, height, area: width * height };
}

function tiledBoundsForPolygon(polygon) {
  const bounds = polygonBounds(polygon);
  const size = approximateBoundsSizeMiles(bounds);
  if (!bounds || (size.area <= LARGE_AREA_TILE_THRESHOLD_SQ_MI && polygon.length <= 120)) return [];
  const columns = Math.max(1, Math.ceil(size.width / TARGET_TILE_SIDE_MILES));
  const rows = Math.max(1, Math.ceil(size.height / TARGET_TILE_SIDE_MILES));
  if (columns * rows > MAX_BROWSER_TILES) {
    throw new CanvasRoadNetworkError('This boundary spans too many street-import tiles for an interactive preview.', {
      code: 'CANVAS_ROAD_NETWORK_AREA_TOO_COMPLEX',
    });
  }
  const latitudeStep = (bounds.north - bounds.south) / rows;
  const longitudeStep = (bounds.east - bounds.west) / columns;
  const tiles = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      tiles.push({
        south: bounds.south + latitudeStep * row,
        west: bounds.west + longitudeStep * column,
        north: row === rows - 1 ? bounds.north : bounds.south + latitudeStep * (row + 1),
        east: column === columns - 1 ? bounds.east : bounds.west + longitudeStep * (column + 1),
      });
    }
  }
  return tiles;
}

function buildBoundingBoxQuery(
  bounds,
  highwayFilter = DEFAULT_HIGHWAY_FILTER,
  { includeGradeSeparated = false } = {},
) {
  const safeFilter = String(highwayFilter || DEFAULT_HIGHWAY_FILTER).replace(/[^a-z_|]/gi, '') || DEFAULT_HIGHWAY_FILTER;
  const bbox = [bounds.south, bounds.west, bounds.north, bounds.east].map((value) => Number(value).toFixed(7)).join(',');
  const gradeFilter = includeGradeSeparated ? '' : '["bridge"!="yes"]["tunnel"!="yes"]';
  return `[out:json][timeout:25];
(
  way["highway"~"^(${safeFilter})$"]${gradeFilter}(${bbox});
);
out body;
>;
out body qt;`;
}

async function readBoundedJsonResponse(response, maxBytes) {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new CanvasRoadNetworkError('Street source response exceeded the safe preview size.', {
      code: 'CANVAS_ROAD_NETWORK_TOO_COMPLEX',
      status: response.status,
    });
  }
  let encoded;
  let byteLength = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || []);
      byteLength += chunk.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new CanvasRoadNetworkError('Street source response exceeded the safe preview size.', {
          code: 'CANVAS_ROAD_NETWORK_TOO_COMPLEX',
          status: response.status,
        });
      }
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    chunks.forEach((chunk) => { bytes.set(chunk, offset); offset += chunk.byteLength; });
    encoded = new TextDecoder().decode(bytes);
  } else if (typeof response.text === 'function') {
    encoded = await response.text();
    byteLength = new TextEncoder().encode(encoded).byteLength;
  } else {
    const data = await response.json();
    encoded = JSON.stringify(data);
    byteLength = new TextEncoder().encode(encoded).byteLength;
  }
  if (byteLength > maxBytes) {
    throw new CanvasRoadNetworkError('Street source response exceeded the safe preview size.', {
      code: 'CANVAS_ROAD_NETWORK_TOO_COMPLEX',
      status: response.status,
    });
  }
  try {
    return { data: JSON.parse(encoded), byteLength };
  } catch {
    throw new CanvasRoadNetworkError('Street source returned an unreadable response.', {
      code: 'CANVAS_ROAD_NETWORK_MALFORMED_RESPONSE',
      status: response.status,
    });
  }
}

async function fetchWithTimeout(url, body, timeoutMs, signal, maxResponseBytes = MAX_BROWSER_TILE_JSON_BYTES) {
  const endpoint = endpointName(url);
  if (signal?.aborted) {
    throw new CanvasRoadNetworkError('Street loading was cancelled.', {
      code: 'CANVAS_ROAD_NETWORK_ABORTED',
      endpoint,
    });
  }
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortFromCaller = () => controller.abort(signal?.reason);
  signal?.addEventListener?.('abort', abortFromCaller, { once: true });
  try {
    const request = {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      body: new URLSearchParams({ data: body }),
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'strict-origin-when-cross-origin',
    };
    const referrer = canvasRequestReferrer();
    if (referrer) request.referrer = referrer;
    const response = await fetch(url, request);
    if (!response.ok) {
      throw new CanvasRoadNetworkError(`Street source returned HTTP ${response.status}.`, {
        code: httpFailureCode(response.status),
        status: response.status,
        endpoint,
      });
    }
    const result = await readBoundedJsonResponse(response, maxResponseBytes);
    return { ...result, endpoint };
  } catch (error) {
    if (error instanceof CanvasRoadNetworkError) throw error;
    if (signal?.aborted) {
      throw new CanvasRoadNetworkError('Street loading was cancelled.', {
        code: 'CANVAS_ROAD_NETWORK_ABORTED',
        endpoint,
      });
    }
    if (timedOut) {
      throw new CanvasRoadNetworkError('Street source timed out.', {
        code: 'CANVAS_ROAD_NETWORK_TIMEOUT',
        endpoint,
      });
    }
    throw new CanvasRoadNetworkError('Street source could not be reached.', {
      code: 'CANVAS_ROAD_NETWORK_REQUEST_FAILED',
      endpoint,
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener?.('abort', abortFromCaller);
  }
}

async function fetchQueryWithFallback(query, {
  timeoutMs,
  signal,
  maxResponseBytes = MAX_BROWSER_TILE_JSON_BYTES,
  maxElements = MAX_BROWSER_OSM_ELEMENTS,
}) {
  let lastError = null;
  const failures = [];
  for (const url of OVERPASS_URLS) {
    try {
      const { data, byteLength } = await fetchWithTimeout(url, query, timeoutMs, signal, maxResponseBytes);
      if (!Array.isArray(data?.elements)) {
        throw new CanvasRoadNetworkError('Street source returned no usable element list.', {
          code: 'CANVAS_ROAD_NETWORK_MALFORMED_RESPONSE',
          endpoint: endpointName(url),
        });
      }
      if (data.elements.length > maxElements) {
        throw new CanvasRoadNetworkError('Street source returned too many map elements for one preview.', {
          code: 'CANVAS_ROAD_NETWORK_TOO_COMPLEX',
          endpoint: endpointName(url),
        });
      }
      return { data, url, failures, byteLength };
    } catch (error) {
      if (['CANVAS_ROAD_NETWORK_ABORTED', 'CANVAS_ROAD_NETWORK_TOO_COMPLEX'].includes(error?.code)) throw error;
      lastError = error;
      failures.push({
        endpoint: error?.endpoint || endpointName(url),
        code: error?.code || 'CANVAS_ROAD_NETWORK_REQUEST_FAILED',
        status: Number(error?.status) || null,
        message: String(error?.message || error).slice(0, 180),
      });
      console.warn(`[FK] Overpass fetch failed via ${url}:`, error?.message || error);
    }
  }
  throw new CanvasRoadNetworkError('Street network service is temporarily unavailable.', {
    code: 'CANVAS_ROAD_NETWORK_UNAVAILABLE',
    status: Number(lastError?.status) || null,
    endpoint: lastError?.endpoint || null,
    failures,
  });
}

function mergeRoadElementsInto(byIdentity, network) {
  (network?.elements || []).forEach((element) => {
    const key = `${String(element?.type || '')}:${String(element?.id ?? '')}`;
    if (key === ':') return;
    const existing = byIdentity.get(key);
    if (!existing || JSON.stringify(element).length > JSON.stringify(existing).length) byIdentity.set(key, element);
  });
}

async function fetchTiledRoadNetwork(tiles, highwayFilter, options) {
  const byIdentity = new Map();
  const sources = new Set();
  const batchController = new AbortController();
  const maxTotalBytes = Math.min(MAX_BROWSER_OSM_JSON_BYTES, Math.max(1, Number(options.maxTotalBytes) || MAX_BROWSER_OSM_JSON_BYTES));
  const maxElements = Math.min(MAX_BROWSER_OSM_ELEMENTS, Math.max(1, Number(options.maxElements) || MAX_BROWSER_OSM_ELEMENTS));
  const overallTimeoutMs = Math.min(DEFAULT_OVERALL_TIMEOUT_MS, Math.max(1_000, Number(options.overallTimeoutMs) || DEFAULT_OVERALL_TIMEOUT_MS));
  let cursor = 0;
  let completed = 0;
  let cumulativeBytes = 0;
  let fatalError = null;
  let overallTimedOut = false;
  const abortFromCaller = () => batchController.abort(options.signal?.reason);
  options.signal?.addEventListener?.('abort', abortFromCaller, { once: true });
  const overallTimeout = setTimeout(() => {
    overallTimedOut = true;
    batchController.abort();
  }, overallTimeoutMs);
  const concurrency = Math.max(1, Math.min(4, Number(options.tileConcurrency) || DEFAULT_TILE_CONCURRENCY));
  const worker = async () => {
    while (cursor < tiles.length && !fatalError) {
      const index = cursor;
      cursor += 1;
      const fetched = await fetchQueryWithFallback(buildBoundingBoxQuery(tiles[index], highwayFilter, options), {
        ...options,
        signal: batchController.signal,
        maxResponseBytes: Math.min(MAX_BROWSER_TILE_JSON_BYTES, maxTotalBytes),
        maxElements,
      });
      cumulativeBytes += fetched.byteLength;
      mergeRoadElementsInto(byIdentity, fetched.data);
      if (cumulativeBytes > maxTotalBytes || byIdentity.size > maxElements) {
        fatalError = new CanvasRoadNetworkError('This street network is too large for one safe interactive preview.', {
          code: 'CANVAS_ROAD_NETWORK_TOO_COMPLEX',
        });
        batchController.abort();
        throw fatalError;
      }
      sources.add(endpointName(fetched.url));
      completed += 1;
      options.onProgress?.({ completed, total: tiles.length, phase: 'streets' });
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, tiles.length) }, () => worker()));
  } catch (error) {
    if (fatalError) throw fatalError;
    if (options.signal?.aborted) throw error;
    if (overallTimedOut) {
      throw new CanvasRoadNetworkError('Large-area street loading exceeded the safe preview time.', {
        code: 'CANVAS_ROAD_NETWORK_TIMEOUT',
      });
    }
    throw error;
  } finally {
    clearTimeout(overallTimeout);
    options.signal?.removeEventListener?.('abort', abortFromCaller);
  }
  const elements = [...byIdentity.values()].sort((left, right) => String(left.type).localeCompare(String(right.type)) || Number(left.id) - Number(right.id));
  return {
    elements,
    _canvas: {
      status: elements.length ? 'ready' : 'empty',
      source: [...sources].sort().join(', '),
      fetched_at: new Date().toISOString(),
      tiled: true,
      tile_count: tiles.length,
    },
  };
}

export function getRoadNetworkCacheKey(polygon, highwayFilter = DEFAULT_HIGHWAY_FILTER, options = {}) {
  const gradeMode = options.includeGradeSeparated === true ? 'all-grades' : 'surface-only';
  return `fk_overpass_${gradeMode}_${highwayFilter}_${stablePolygonKey(polygon)}`;
}

export function clearOverpassRoadNetworkCache(polygon, highwayFilter = DEFAULT_HIGHWAY_FILTER, options = {}) {
  try {
    sessionStorage.removeItem(getRoadNetworkCacheKey(polygon, highwayFilter, options));
  } catch {}
}

export async function fetchOverpassRoadNetwork(polygon, options = {}) {
  const highwayFilter = options.highwayFilter || DEFAULT_HIGHWAY_FILTER;
  const timeoutMs = Math.max(5000, Number(options.timeoutMs) || 25000);
  const cacheMaxAgeMs = Math.max(0, Number(options.cacheMaxAgeMs) || DEFAULT_CACHE_MAX_AGE_MS);
  const cacheEmptyResults = options.cacheEmptyResults !== false;
  const cacheKey = getRoadNetworkCacheKey(polygon, highwayFilter, options);

  if (options.bypassCache === true) clearOverpassRoadNetworkCache(polygon, highwayFilter, options);
  else {
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) {
        const record = JSON.parse(cached);
        const cachedAt = Number(record?.cached_at);
        const data = record?.data;
        if (
          Number.isFinite(cachedAt)
          && Date.now() - cachedAt <= cacheMaxAgeMs
          && Array.isArray(data?.elements)
          && (cacheEmptyResults || data.elements.length > 0)
        ) {
          console.info(`[FK] Canvas road network cache hit: ${data.elements.length} OSM elements`);
          return data;
        }
        sessionStorage.removeItem(cacheKey);
      }
    } catch {}
  }

  const tiles = tiledBoundsForPolygon(polygon);
  const result = tiles.length
    ? await fetchTiledRoadNetwork(tiles, highwayFilter, { ...options, timeoutMs })
    : (() => fetchQueryWithFallback(buildOverpassQuery(polygon, highwayFilter, options), {
      timeoutMs,
      signal: options.signal,
      maxResponseBytes: Math.min(MAX_BROWSER_OSM_JSON_BYTES, Math.max(1, Number(options.maxTotalBytes) || MAX_BROWSER_OSM_JSON_BYTES)),
      maxElements: Math.min(MAX_BROWSER_OSM_ELEMENTS, Math.max(1, Number(options.maxElements) || MAX_BROWSER_OSM_ELEMENTS)),
    })
      .then(({ data, url }) => roadNetworkResult(data, url)))();
  const resolved = await result;
  try {
    const serialized = JSON.stringify({ cached_at: Date.now(), data: resolved });
    if (
      (cacheEmptyResults || resolved.elements.length > 0)
      && serialized.length < 4_500_000
    ) sessionStorage.setItem(cacheKey, serialized);
  } catch {}
  console.info(`[FK] Canvas road network fetched: ${resolved.elements.length} OSM elements${tiles.length ? ` across ${tiles.length} tiles` : ''}`);
  return resolved;
}
