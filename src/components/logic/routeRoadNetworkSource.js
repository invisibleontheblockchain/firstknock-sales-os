import {
  CanvasRoadNetworkError,
  fetchOverpassRoadNetwork,
} from './overpassRoadNetwork';

const MAX_POLYGON_POINTS = 32;
const MAX_BOUNDS_AREA_SQ_MI = 125;
const MAX_BOUNDS_SPAN_MILES = 30;
const MAX_RESPONSE_BYTES = 3_500_000;
const MAX_OSM_ELEMENTS = 60_000;
const MAX_ENDPOINT_TIMEOUT_MS = 12_000;
const MAX_OVERALL_TIMEOUT_MS = 40_000;

function normalizedPolygon(polygon) {
  const normalized = (Array.isArray(polygon) ? polygon : []).map((point) => ({
    lat: Number(point?.lat),
    lng: Number(point?.lng ?? point?.lon),
  }));
  if (
    normalized.length > 1
    && normalized[0].lat === normalized.at(-1).lat
    && normalized[0].lng === normalized.at(-1).lng
  ) {
    normalized.pop();
  }
  return normalized;
}

function routeRoadError(message, code) {
  return new CanvasRoadNetworkError(message, { code });
}

function validateRoutePolygon(polygon) {
  if (polygon.length < 3 || polygon.length > MAX_POLYGON_POINTS) {
    throw routeRoadError(
      `A route road request requires 3-${MAX_POLYGON_POINTS} boundary points.`,
      'ROUTE_ROAD_POLYGON_INVALID',
    );
  }
  if (polygon.some((point) => (
    !Number.isFinite(point.lat)
    || !Number.isFinite(point.lng)
    || point.lat < -90
    || point.lat > 90
    || point.lng < -180
    || point.lng > 180
  ))) {
    throw routeRoadError(
      'The route road boundary contains an invalid coordinate.',
      'ROUTE_ROAD_POLYGON_INVALID',
    );
  }
  if (new Set(polygon.map((point) => `${point.lat},${point.lng}`)).size < 3) {
    throw routeRoadError(
      'The route road boundary requires three distinct points.',
      'ROUTE_ROAD_POLYGON_INVALID',
    );
  }

  const south = Math.min(...polygon.map((point) => point.lat));
  const north = Math.max(...polygon.map((point) => point.lat));
  const west = Math.min(...polygon.map((point) => point.lng));
  const east = Math.max(...polygon.map((point) => point.lng));
  const centerLatitude = (south + north) / 2;
  const widthMiles = Math.max(
    0,
    (east - west) * 69 * Math.max(0.05, Math.cos(centerLatitude * Math.PI / 180)),
  );
  const heightMiles = Math.max(0, (north - south) * 69);
  if (
    widthMiles <= 0
    || heightMiles <= 0
    || widthMiles > MAX_BOUNDS_SPAN_MILES
    || heightMiles > MAX_BOUNDS_SPAN_MILES
    || widthMiles * heightMiles > MAX_BOUNDS_AREA_SQ_MI
  ) {
    throw routeRoadError(
      'This route area is too large for one safe road-network request.',
      'ROUTE_ROAD_AREA_TOO_LARGE',
    );
  }
}

/**
 * Route-only OSM source.
 *
 * Requests go directly from the signed-in user's browser to public Overpass
 * endpoints. FirstKnock deliberately does not expose a generic server proxy:
 * doing so would require a durable, shared admission-control service rather
 * than process-local rate limits that reset across serverless isolates.
 */
export async function fetchRouteRoadNetwork(polygon, options = {}) {
  const safePolygon = normalizedPolygon(polygon);
  validateRoutePolygon(safePolygon);
  const browserFetch = options.browserFetch || fetchOverpassRoadNetwork;
  const roadNetwork = await browserFetch(safePolygon, {
    ...options,
    timeoutMs: Math.min(
      MAX_ENDPOINT_TIMEOUT_MS,
      Math.max(5_000, Number(options.timeoutMs) || MAX_ENDPOINT_TIMEOUT_MS),
    ),
    overallTimeoutMs: Math.min(
      MAX_OVERALL_TIMEOUT_MS,
      Math.max(5_000, Number(options.overallTimeoutMs) || MAX_OVERALL_TIMEOUT_MS),
    ),
    maxElements: Math.min(
      MAX_OSM_ELEMENTS,
      Math.max(1, Number(options.maxElements) || MAX_OSM_ELEMENTS),
    ),
    maxTotalBytes: Math.min(
      MAX_RESPONSE_BYTES,
      Math.max(1, Number(options.maxTotalBytes) || MAX_RESPONSE_BYTES),
    ),
    cacheEmptyResults: false,
  });
  if (!Array.isArray(roadNetwork?.elements)) {
    throw routeRoadError(
      'The road source returned no usable map elements.',
      'ROUTE_ROAD_NETWORK_MALFORMED',
    );
  }
  return {
    ...roadNetwork,
    _route_proxy: {
      proxied: false,
      source: 'browser-overpass-route-v1',
      endpoint: roadNetwork?._canvas?.source || null,
      cache_status: null,
      fetched_at: roadNetwork?._canvas?.fetched_at || new Date().toISOString(),
    },
  };
}

export const routeRoadNetworkSourceInternals = Object.freeze({
  normalizedPolygon,
  validateRoutePolygon,
});
