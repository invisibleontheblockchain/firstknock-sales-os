// Server-side road distance matrix via OSRM.
//
// The browser Overpass graph proved untrustworthy (it split a 58-door Mesquite
// route into 16 disconnected components and produced a WORSE order than the
// straight-line continuity route). A real routing engine is the only source of
// truth we price routes with, and it is only ever called from the backend.

export const ROAD_MATRIX_VERSION = 'osrm_table_v1';
export const DEFAULT_OSRM_BASE_URL = 'https://router.project-osrm.org';
export const MAX_MATRIX_COORDINATES = 100;

function coordinateKey(point) {
    return `${Number(point?.lat).toFixed(6)},${Number(point?.lng).toFixed(6)}`;
}

/**
 * Stable cache key for a coordinate set. Order-independent so reordering,
 * reopening or exporting the same route reuses one matrix.
 */
export async function buildRoadMatrixCacheKey(points, profile = 'driving') {
    const canonical = [
        ROAD_MATRIX_VERSION,
        profile,
        ...points.map(coordinateKey).sort()
    ].join('|');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Fetch a full pairwise road matrix from OSRM.
 * Returns { distances, durations, objective, snapped, source } — distances in
 * miles, durations in minutes. Throws on timeout/failure so callers can fall
 * back to the continuity route rather than block route creation.
 */
export async function fetchRoadMatrix(points, options = {}) {
    const {
        baseUrl = DEFAULT_OSRM_BASE_URL,
        profile = 'driving',
        timeoutMs = 20000
    } = options;

    if (!Array.isArray(points) || points.length < 2) {
        throw new Error('A road matrix needs at least two coordinates.');
    }
    if (points.length > MAX_MATRIX_COORDINATES) {
        throw new Error(`Road matrix limit is ${MAX_MATRIX_COORDINATES} coordinates per request.`);
    }

    const coordinates = points
        .map((point) => `${Number(point.lng).toFixed(6)},${Number(point.lat).toFixed(6)}`)
        .join(';');
    const url = `${String(baseUrl).replace(/\/+$/, '')}/table/v1/${profile}/${coordinates}`
        + '?annotations=distance,duration';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let payload;
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(`OSRM table request failed with status ${response.status}.`);
        }
        payload = await response.json();
    } finally {
        clearTimeout(timer);
    }

    if (payload?.code !== 'Ok') {
        throw new Error(`OSRM table request rejected: ${payload?.code || 'unknown'}.`);
    }

    const metersToMiles = 0.000621371;
    const rawDistances = Array.isArray(payload.distances) ? payload.distances : null;
    const rawDurations = Array.isArray(payload.durations) ? payload.durations : null;
    if (!rawDistances && !rawDurations) {
        throw new Error('OSRM table response contained no distances or durations.');
    }

    const distances = rawDistances
        ? rawDistances.map((row) => row.map((meters) => (
            Number.isFinite(meters) ? meters * metersToMiles : null
        )))
        : null;
    const durations = rawDurations
        ? rawDurations.map((row) => row.map((seconds) => (
            Number.isFinite(seconds) ? seconds / 60 : null
        )))
        : null;

    return {
        distances,
        durations,
        // Distance is the objective the Mesquite regression is measured in.
        objective: distances ? 'distance_miles' : 'duration_minutes',
        snapped: Array.isArray(payload.sources) ? payload.sources.length : points.length,
        source: `osrm:${profile}`
    };
}

/**
 * Wrap a matrix in a distance function keyed by coordinates, so any object with
 * lat/lng (doors, blocks, start/end anchors) can be priced. Points outside the
 * matrix (external start/finish anchors) return null so the caller's fallback
 * cost applies.
 */
export function createMatrixDistanceFn(points, matrix) {
    const index = new Map();
    points.forEach((point, position) => {
        const key = coordinateKey(point);
        if (!index.has(key)) index.set(key, position);
    });
    const table = matrix.distances || matrix.durations;
    const unresolved = { count: 0 };

    const distanceBetween = (from, to) => {
        const fromIndex = index.get(coordinateKey(from));
        const toIndex = index.get(coordinateKey(to));
        if (fromIndex === undefined || toIndex === undefined) {
            unresolved.count += 1;
            return null;
        }
        const value = table?.[fromIndex]?.[toIndex];
        if (!Number.isFinite(value)) {
            unresolved.count += 1;
            return null;
        }
        return value;
    };

    return { distanceBetween, unresolved };
}

/** Sum a road-matrix objective over an ordered door list. */
export function measureOrder(order, distanceBetween) {
    let total = 0;
    for (let index = 0; index < order.length - 1; index++) {
        const leg = distanceBetween(order[index], order[index + 1]);
        if (!Number.isFinite(leg)) return null;
        total += leg;
    }
    return total;
}