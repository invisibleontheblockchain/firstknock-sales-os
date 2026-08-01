// Server-side road distance matrix via OSRM.
//
// The browser Overpass graph proved untrustworthy (it split a 58-door Mesquite
// route into 16 disconnected components and produced a WORSE order than the
// straight-line continuity route). A real routing engine is the only source of
// truth we price routes with, and it is only ever called from the backend.

export const ROAD_MATRIX_VERSION = 'osrm_table_v1';
export const DEFAULT_OSRM_BASE_URL = 'https://router.project-osrm.org';
// How many coordinates one OSRM table request accepts. An IMPLEMENTATION limit:
// larger routes are assembled from source-chunk x destination-chunk blocks.
export const MAX_MATRIX_COORDINATES = 100;
// Chunk width, so one block request carries at most 2 x 46 = 92 coordinates.
// 183 properties therefore assemble from 4 x 4 = 16 blocks, the shape the
// Anderson audit proved returns a complete matrix with zero unresolved cells.
export const MATRIX_CHUNK_SIZE = 46;
// PRODUCT limit for one optimization request. Bounded because block count grows
// quadratically (ceil(N/46)^2), not because of the per-request coordinate cap.
export const MAX_ROUTE_MATRIX_POINTS = 250;
// The public demo server rate-limits aggressive parallelism, so blocks go out in
// small batches rather than all at once.
const MATRIX_BLOCK_CONCURRENCY = 4;

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

const METERS_TO_MILES = 0.000621371;

function coordinateParam(point) {
    return `${Number(point.lng).toFixed(6)},${Number(point.lat).toFixed(6)}`;
}

/** Index ranges of one chunked dimension, e.g. 183 -> [0..45][46..91][...]. */
function chunkRanges(count, size) {
    const ranges = [];
    for (let start = 0; start < count; start += size) {
        ranges.push({ start, end: Math.min(start + size, count) });
    }
    return ranges;
}

/**
 * One OSRM table request for a source range x destination range block.
 * Sources and destinations are addressed by position inside the request, so the
 * caller can map the response back onto the canonical property indexes.
 */
async function fetchMatrixBlock(points, sourceRange, destinationRange, { baseUrl, profile, timeoutMs }) {
    const sameRange = sourceRange.start === destinationRange.start
        && sourceRange.end === destinationRange.end;
    const sourcePoints = points.slice(sourceRange.start, sourceRange.end);
    const destinationPoints = sameRange ? [] : points.slice(destinationRange.start, destinationRange.end);
    const blockPoints = [...sourcePoints, ...destinationPoints];
    if (blockPoints.length > MAX_MATRIX_COORDINATES) {
        throw new Error(`Road matrix block exceeded ${MAX_MATRIX_COORDINATES} coordinates.`);
    }

    const sources = sourcePoints.map((_, index) => index);
    const destinations = sameRange
        ? sources
        : destinationPoints.map((_, index) => index + sourcePoints.length);
    const url = `${String(baseUrl).replace(/\/+$/, '')}/table/v1/${profile}/`
        + `${blockPoints.map(coordinateParam).join(';')}`
        + `?annotations=distance,duration&sources=${sources.join(';')}&destinations=${destinations.join(';')}`;

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

    const distances = Array.isArray(payload.distances) ? payload.distances : null;
    const durations = Array.isArray(payload.durations) ? payload.durations : null;
    if (!distances && !durations) {
        throw new Error('OSRM table response contained no distances or durations.');
    }
    return { sourceRange, destinationRange, distances, durations };
}

/**
 * Fetch a COMPLETE pairwise road matrix from OSRM, at any supported route size.
 *
 * Routes wider than one OSRM request are assembled from source-chunk x
 * destination-chunk blocks into one N x N matrix. Returns { distances,
 * durations, objective, snapped, source, blocks, pointCount } — distances in
 * miles, durations in minutes. Throws when the matrix cannot be completed, so a
 * caller either optimizes on a whole matrix or takes the explicit fallback path.
 * It never returns a partially assembled matrix.
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
    if (points.length > MAX_ROUTE_MATRIX_POINTS) {
        throw new Error(`Road matrix limit is ${MAX_ROUTE_MATRIX_POINTS} coordinates per route.`);
    }

    const count = points.length;
    const ranges = chunkRanges(count, MATRIX_CHUNK_SIZE);
    const blockRequests = ranges.flatMap((sourceRange) => (
        ranges.map((destinationRange) => ({ sourceRange, destinationRange }))
    ));

    const distances = Array.from({ length: count }, () => new Array(count).fill(null));
    const durations = Array.from({ length: count }, () => new Array(count).fill(null));
    let sawDistances = false;
    let sawDurations = false;

    for (let index = 0; index < blockRequests.length; index += MATRIX_BLOCK_CONCURRENCY) {
        const batch = blockRequests.slice(index, index + MATRIX_BLOCK_CONCURRENCY);
        const blocks = await Promise.all(batch.map(({ sourceRange, destinationRange }) => (
            fetchMatrixBlock(points, sourceRange, destinationRange, { baseUrl, profile, timeoutMs })
        )));
        blocks.forEach((block) => {
            const rows = block.sourceRange.end - block.sourceRange.start;
            const columns = block.destinationRange.end - block.destinationRange.start;
            const table = block.distances || block.durations;
            if (table.length !== rows || table.some((row) => row.length !== columns)) {
                throw new Error('OSRM matrix block did not match its requested source/destination shape.');
            }
            if (block.distances) sawDistances = true;
            if (block.durations) sawDurations = true;
            for (let row = 0; row < rows; row++) {
                for (let column = 0; column < columns; column++) {
                    const target = block.sourceRange.start + row;
                    const destination = block.destinationRange.start + column;
                    if (block.distances) {
                        const meters = block.distances[row][column];
                        distances[target][destination] = Number.isFinite(meters)
                            ? meters * METERS_TO_MILES
                            : null;
                    }
                    if (block.durations) {
                        const seconds = block.durations[row][column];
                        durations[target][destination] = Number.isFinite(seconds)
                            ? seconds / 60
                            : null;
                    }
                }
            }
        });
    }

    // Completeness gate. A hole anywhere means some candidate leg would be
    // unpriceable, which is exactly how an unmeasured order used to slip through.
    let unresolved = 0;
    for (let row = 0; row < count; row++) {
        for (let column = 0; column < count; column++) {
            if (sawDistances && !Number.isFinite(distances[row][column])) unresolved += 1;
            else if (!sawDistances && sawDurations && !Number.isFinite(durations[row][column])) unresolved += 1;
        }
    }
    if (unresolved > 0) {
        throw new Error(`Road matrix is incomplete: ${unresolved} unresolved cells.`);
    }

    return {
        distances: sawDistances ? distances : null,
        durations: sawDurations ? durations : null,
        // Distance is the objective the Mesquite regression is measured in.
        objective: sawDistances ? 'distance_miles' : 'duration_minutes',
        snapped: count,
        source: `osrm:${profile}`,
        blocks: blockRequests.length,
        pointCount: count
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

/**
 * Both objectives from ONE matrix response: driving duration (the primary
 * objective) and driving distance (the tie-break), sharing one unresolved-leg
 * counter so a partially unsnapped matrix is visible to the caller.
 */
export function createMatrixMetricFns(points, matrix) {
    const distance = createMatrixDistanceFn(points, { distances: matrix.distances });
    const duration = matrix.durations
        ? createMatrixDistanceFn(points, { distances: matrix.durations })
        : null;
    return {
        distanceBetween: matrix.distances ? distance.distanceBetween : null,
        durationBetween: duration ? duration.distanceBetween : null,
        unresolved: distance.unresolved
    };
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