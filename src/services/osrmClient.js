/**
 * osrmClient — transport layer for the self-hosted full-USA OSRM instance.
 *
 * Nothing in here knows about routing strategy; it moves coordinates to OSRM and
 * numbers back, with the retry, deadline and accounting behaviour the rest of the
 * app depends on. Strategy (how doors become blocks, how blocks become tiles)
 * lives in components/logic/osrmRoadContext.js.
 *
 * Two constraints shape every function below, both verified against the pinned
 * server release (v26.8.0):
 *
 *   1. osrm-routed accepts GET only. POST body support was merged upstream on
 *      2026-08-13, one day after v26.8.0 shipped, so it is not available to us.
 *      Coordinates therefore ride in the URL path and URL length is a hard
 *      ceiling — see MAX_COORDS_PER_REQUEST.
 *   2. The server is started with --max-table-size 8000, which limits the
 *      *coordinate count* of a /table call, not the cell count. Our own URL
 *      ceiling is stricter, so it binds first.
 */

const DEFAULT_BASE_URL = 'http://localhost:5000';

// ~21 bytes per "lng,lat;" pair at 6 decimals. 200 coordinates is ~4.2 KB of
// URL, comfortably under the 8 KB request line that proxies commonly enforce
// and that has bitten OSRM users historically.
export const MAX_COORDS_PER_REQUEST = 200;

// 6 decimal places is ~11 cm. Anything beyond that is URL weight for no accuracy.
const COORD_PRECISION = 6;

const ROUTE_TIMEOUT_MS = 10_000;
// A full-USA table over ~200 coordinates is not a 10-second operation. The old
// draft client used one 10s budget for both endpoints, which would have made
// every matrix call time out and silently fall back to straight-line distance —
// the $168/month server would never actually have been used.
const TABLE_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 5_000;

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;

// Worst case without this: 4 attempts x 60s plus backoff is over four minutes of
// a frozen UI before the local fallback engages. The deadline bounds the whole
// operation including retries.
const DEFAULT_DEADLINE_MS = 90_000;

/** Rising fallback rate is the earliest signal the single droplet is saturating. */
const counters = {
  tableRequests: 0,
  tableFailures: 0,
  routeRequests: 0,
  routeFailures: 0,
  cellsFetched: 0,
  retries: 0,
  totalTableMs: 0,
  lastError: null,
};

export function getOsrmCounters() {
  const total = counters.tableRequests + counters.routeRequests;
  const failed = counters.tableFailures + counters.routeFailures;
  return Object.freeze({
    ...counters,
    fallbackRate: total > 0 ? failed / total : 0,
    meanTableMs: counters.tableRequests > 0
      ? Math.round(counters.totalTableMs / counters.tableRequests)
      : 0,
  });
}

export function resetOsrmCounters() {
  Object.assign(counters, {
    tableRequests: 0,
    tableFailures: 0,
    routeRequests: 0,
    routeFailures: 0,
    cellsFetched: 0,
    retries: 0,
    totalTableMs: 0,
    lastError: null,
  });
}

function readEnv(key) {
  try {
    return import.meta.env?.[key];
  } catch {
    return undefined;
  }
}

export function getOsrmBaseUrl() {
  const configured = readEnv('VITE_OSRM_BASE_URL');
  return String(configured || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export function isOsrmConfigured() {
  return Boolean(readEnv('VITE_OSRM_BASE_URL'));
}

function authHeaders() {
  const token = readEnv('VITE_OSRM_TOKEN');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** OSRM takes lng,lat — the reverse of every property record in this codebase. */
export function buildCoordString(points) {
  return points
    .map((point) => {
      const lng = Number(point.lng ?? point.longitude);
      const lat = Number(point.lat ?? point.latitude);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
        throw new Error(`osrmClient: invalid coordinate ${JSON.stringify(point)}`);
      }
      return `${lng.toFixed(COORD_PRECISION)},${lat.toFixed(COORD_PRECISION)}`;
    })
    .join(';');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch with per-attempt timeout, exponential backoff, and an overall deadline
 * that survives retries. Retries only what is worth retrying: a 400 from OSRM
 * means our request is malformed and will be malformed again.
 */
async function requestJson(url, { timeoutMs, deadlineAt, signal, label }) {
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (Date.now() >= deadlineAt) {
      throw new Error(`osrmClient: ${label} exceeded its ${DEFAULT_DEADLINE_MS}ms deadline`);
    }
    if (signal?.aborted) throw new Error(`osrmClient: ${label} aborted`);

    const controller = new AbortController();
    const budget = Math.min(timeoutMs, deadlineAt - Date.now());
    const timer = setTimeout(() => controller.abort(), budget);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', ...authHeaders() },
        signal: controller.signal,
      });

      if (!response.ok) {
        // 4xx other than 429 is our bug, not a transient fault.
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          const body = await response.text().catch(() => '');
          throw Object.assign(
            new Error(`osrmClient: ${label} rejected with ${response.status}: ${body.slice(0, 200)}`),
            { permanent: true },
          );
        }
        throw new Error(`osrmClient: ${label} returned ${response.status}`);
      }

      const payload = await response.json();
      if (payload.code && payload.code !== 'Ok') {
        throw Object.assign(
          new Error(`osrmClient: ${label} returned code ${payload.code}: ${payload.message || ''}`),
          { permanent: payload.code === 'InvalidQuery' || payload.code === 'TooBig' },
        );
      }
      return payload;
    } catch (error) {
      lastError = error;
      counters.lastError = error.message;
      if (error.permanent || attempt === MAX_RETRIES) break;

      const backoff = BACKOFF_BASE_MS * 2 ** attempt;
      if (Date.now() + backoff >= deadlineAt) break;
      counters.retries += 1;
      await sleep(backoff);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  throw lastError || new Error(`osrmClient: ${label} failed`);
}

/**
 * One /table call. `points` is the full coordinate list; `sources` and
 * `destinations` are index arrays into it. Splitting a matrix into source and
 * destination subsets of the same coordinate list is what lets a 200-coordinate
 * request return 40,000 cells.
 *
 * Returns metres and seconds; conversion to miles happens at the strategy layer.
 */
export async function getTable(points, options = {}) {
  const {
    sources = null,
    destinations = null,
    signal = null,
    deadlineAt = Date.now() + DEFAULT_DEADLINE_MS,
    profile = 'driving',
  } = options;

  if (!Array.isArray(points) || points.length < 2) {
    throw new Error('osrmClient: getTable needs at least 2 points');
  }
  if (points.length > MAX_COORDS_PER_REQUEST) {
    throw new Error(
      `osrmClient: ${points.length} coordinates exceeds MAX_COORDS_PER_REQUEST (${MAX_COORDS_PER_REQUEST}). Chunk before calling.`,
    );
  }

  const params = new URLSearchParams({ annotations: 'distance,duration' });
  if (sources) params.set('sources', sources.join(';'));
  if (destinations) params.set('destinations', destinations.join(';'));

  const url = `${getOsrmBaseUrl()}/table/v1/${profile}/${buildCoordString(points)}?${params}`;

  counters.tableRequests += 1;
  const startedAt = Date.now();
  try {
    const payload = await requestJson(url, {
      timeoutMs: TABLE_TIMEOUT_MS,
      deadlineAt,
      signal,
      label: 'table',
    });
    counters.totalTableMs += Date.now() - startedAt;

    const distances = payload.distances || [];
    counters.cellsFetched += distances.length * (distances[0]?.length || 0);

    return {
      distances,                       // metres
      durations: payload.durations || [],  // seconds
      sources: payload.sources || [],
      destinations: payload.destinations || [],
    };
  } catch (error) {
    counters.tableFailures += 1;
    counters.totalTableMs += Date.now() - startedAt;
    throw error;
  }
}

/**
 * Turn-by-turn route between an ordered list of points.
 *
 * Reads routes[0]. OSRM returns the primary route first and only returns
 * alternatives when they are explicitly requested — an earlier draft of this
 * client read routes[1], which throws on undefined for every successful
 * response and degrades every call to the local fallback.
 */
export async function getRoute(points, options = {}) {
  const {
    signal = null,
    deadlineAt = Date.now() + DEFAULT_DEADLINE_MS,
    profile = 'driving',
    overview = 'simplified',
    geometries = 'geojson',
    steps = false,
  } = options;

  if (!Array.isArray(points) || points.length < 2) {
    throw new Error('osrmClient: getRoute needs at least 2 points');
  }
  if (points.length > MAX_COORDS_PER_REQUEST) {
    throw new Error(
      `osrmClient: ${points.length} waypoints exceeds MAX_COORDS_PER_REQUEST (${MAX_COORDS_PER_REQUEST})`,
    );
  }

  const params = new URLSearchParams({
    overview,
    geometries,
    steps: String(steps),
    continue_straight: 'false',
  });
  const url = `${getOsrmBaseUrl()}/route/v1/${profile}/${buildCoordString(points)}?${params}`;

  counters.routeRequests += 1;
  try {
    const payload = await requestJson(url, {
      timeoutMs: ROUTE_TIMEOUT_MS,
      deadlineAt,
      signal,
      label: 'route',
    });

    const route = payload.routes?.[0];
    if (!route) throw new Error('osrmClient: response contained no routes');

    return {
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      geometry: route.geometry || null,
      legs: route.legs || [],
      waypoints: payload.waypoints || [],
      fallback: false,
    };
  } catch (error) {
    counters.routeFailures += 1;
    throw error;
  }
}

/**
 * Liveness probe. Uses stops 1 and 2 of Charlotte-Precision-Route-2 (Belmont NC
 * 28012) — a real pair from a real route export, so a pass also proves the graph
 * covers territory we actually sell in. The compose healthcheck and the watchdog
 * deliberately probe the *other* export (Mooresville NC 28115) so that between
 * them both service areas are continuously verified.
 */
export async function checkOsrmHealth(options = {}) {
  const { signal = null } = options;
  const probe = [
    { lng: -81.069989, lat: 35.195012 },  // 146 McCullough Dr, Belmont NC 28012
    { lng: -81.065900, lat: 35.190189 },  // 114 Carrigan Dr, Belmont NC 28012
  ];
  const url = `${getOsrmBaseUrl()}/route/v1/driving/${buildCoordString(probe)}?overview=false`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', ...authHeaders() },
      signal: controller.signal,
    });
    if (!response.ok) return { healthy: false, reason: `HTTP_${response.status}` };
    const payload = await response.json();
    return payload.code === 'Ok'
      ? { healthy: true, reason: null }
      : { healthy: false, reason: payload.code || 'UNKNOWN' };
  } catch (error) {
    return {
      healthy: false,
      reason: error.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE',
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export const osrmClientInternals = Object.freeze({
  COORD_PRECISION,
  ROUTE_TIMEOUT_MS,
  TABLE_TIMEOUT_MS,
  DEFAULT_DEADLINE_MS,
  MAX_RETRIES,
});
