// Server-side road distance matrix via OSRM.
//
// The browser Overpass graph proved untrustworthy (it split a 58-door Mesquite
// route into 16 disconnected components and produced a WORSE order than the
// straight-line continuity route). A real routing engine is the only source of
// truth we price routes with, and it is only ever called from the backend.

import { fetchOsrmJson } from './osrmDispatcher.js';

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
// Concurrency is no longer this module's business: every OSRM request in the
// codebase — matrix blocks, per-cluster matrices, final route geometry — is
// enqueued through the process-wide dispatcher, so one global cap applies
// instead of each level of the hierarchy independently allowing four in flight.

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

    const payload = await fetchOsrmJson(url, { timeoutMs });

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

    // Every block is handed over at once; the dispatcher, not this function,
    // decides how many reach OSRM simultaneously.
    const blocks = await Promise.all(blockRequests.map(({ sourceRange, destinationRange }) => (
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
 * Road costs from every source to every destination — a RECTANGULAR table.
 *
 * The square matrix above is bounded at 250 coordinates because its request count
 * grows as ceil(N/46)^2. Grouping asks a different question: "how far is each of
 * 400+ street blocks from each of 20 candidate access points, by road?" That is
 * S x D, not N x N, so it costs ceil(S/46) * ceil(D/46) requests — 9 x 1 for 400
 * blocks against 20 seeds. Cheap enough to make the GROUPING decision road-priced
 * instead of geometric, which is the whole point of asking.
 *
 * Distances are miles. Throws on any unresolved cell, so a caller can never group
 * blocks on a partially known road network.
 */
export async function fetchRoadCostRows(sources, destinations, options = {}) {
    const {
        baseUrl = DEFAULT_OSRM_BASE_URL,
        profile = 'driving',
        timeoutMs = 20000
    } = options;

    if (!Array.isArray(sources) || sources.length < 1) throw new Error('Road cost rows need at least one source.');
    if (!Array.isArray(destinations) || destinations.length < 1) {
        throw new Error('Road cost rows need at least one destination.');
    }
    if (destinations.length > MAX_ROUTE_MATRIX_POINTS) {
        throw new Error(`Road cost destinations limit is ${MAX_ROUTE_MATRIX_POINTS}.`);
    }

    const sourceRanges = chunkRanges(sources.length, MATRIX_CHUNK_SIZE);
    const destinationRanges = chunkRanges(destinations.length, MATRIX_CHUNK_SIZE);
    const rows = Array.from({ length: sources.length }, () => new Array(destinations.length).fill(null));

    const requests = sourceRanges.flatMap((sourceRange) => destinationRanges.map(async (destinationRange) => {
        const sourcePoints = sources.slice(sourceRange.start, sourceRange.end);
        const destinationPoints = destinations.slice(destinationRange.start, destinationRange.end);
        const blockPoints = [...sourcePoints, ...destinationPoints];
        const sourceIndexes = sourcePoints.map((_, index) => index);
        const destinationIndexes = destinationPoints.map((_, index) => index + sourcePoints.length);
        const url = `${String(baseUrl).replace(/\/+$/, '')}/table/v1/${profile}/`
            + `${blockPoints.map(coordinateParam).join(';')}`
            + `?annotations=distance&sources=${sourceIndexes.join(';')}&destinations=${destinationIndexes.join(';')}`;

        const payload = await fetchOsrmJson(url, { timeoutMs });
        const distances = Array.isArray(payload.distances) ? payload.distances : null;
        if (!distances) throw new Error('OSRM table response contained no distances.');
        distances.forEach((row, rowIndex) => row.forEach((meters, columnIndex) => {
            rows[sourceRange.start + rowIndex][destinationRange.start + columnIndex] = Number.isFinite(meters)
                ? meters * METERS_TO_MILES
                : null;
        }));
    }));
    await Promise.all(requests);

    const unresolved = rows.reduce(
        (total, row) => total + row.filter((value) => !Number.isFinite(value)).length,
        0
    );
    if (unresolved > 0) {
        throw new Error(`Road cost rows are incomplete: ${unresolved} unresolved cells.`);
    }

    return { rows, requestCount: sourceRanges.length * destinationRanges.length };
}

const NOT_IN_MATRIX = -1;

/**
 * Resolve any lat/lng-bearing object to its canonical matrix index.
 *
 * The solver prices millions of legs from a small, fixed set of door objects, so
 * the coordinate string is built at most ONCE per object and then reused by
 * identity. Rebuilding `lat.toFixed(6),lng.toFixed(6)` and hashing it on every
 * lookup was the optimizer's dominant cost — the same search ran ~14x faster on
 * raw indexed lookups, which is what this closes.
 *
 * Callers legitimately pass copies (`{...property}`) and external anchors, so the
 * coordinate map remains the source of truth; identity is only a memo in front of
 * it, and misses are memoized too so anchors do not re-pay the string cost.
 */
function createPointIndex(points) {
    const indexByKey = new Map();
    points.forEach((point, position) => {
        const key = coordinateKey(point);
        if (!indexByKey.has(key)) indexByKey.set(key, position);
    });
    const indexByPoint = new WeakMap();

    return (point) => {
        if (point === null || typeof point !== 'object') return NOT_IN_MATRIX;
        const memoized = indexByPoint.get(point);
        if (memoized !== undefined) return memoized;
        const key = coordinateKey(point);
        const resolved = indexByKey.has(key) ? indexByKey.get(key) : NOT_IN_MATRIX;
        indexByPoint.set(point, resolved);
        return resolved;
    };
}

/**
 * Flatten a row-major table into one Float64Array so a lookup is a single
 * numeric index instead of two array dereferences. Unpriceable cells become NaN,
 * which keeps "no value" a numeric test rather than a truthiness check.
 */
function flattenTable(table, count) {
    if (!table) return null;
    const flat = new Float64Array(count * count);
    for (let row = 0; row < count; row++) {
        for (let column = 0; column < count; column++) {
            const value = table[row]?.[column];
            flat[row * count + column] = Number.isFinite(value) ? value : NaN;
        }
    }
    return flat;
}

function createFlatLookup(flat, count, resolveIndex, unresolved) {
    return (from, to) => {
        const fromIndex = resolveIndex(from);
        const toIndex = resolveIndex(to);
        if (fromIndex === NOT_IN_MATRIX || toIndex === NOT_IN_MATRIX) {
            unresolved.count += 1;
            return null;
        }
        const value = flat[fromIndex * count + toIndex];
        // NaN marks an unpriceable cell; it is the only non-finite value stored.
        if (value !== value) {
            unresolved.count += 1;
            return null;
        }
        return value;
    };
}

/**
 * Wrap a matrix in a distance function keyed by coordinates, so any object with
 * lat/lng (doors, blocks, start/end anchors) can be priced. Points outside the
 * matrix (external start/finish anchors) return null so the caller's fallback
 * cost applies.
 */
export function createMatrixDistanceFn(points, matrix) {
    const count = points.length;
    const resolveIndex = createPointIndex(points);
    const flat = flattenTable(matrix.distances || matrix.durations, count);
    const unresolved = { count: 0 };
    const distanceBetween = flat
        ? createFlatLookup(flat, count, resolveIndex, unresolved)
        : () => {
            unresolved.count += 1;
            return null;
        };

    return { distanceBetween, unresolved };
}

/**
 * Both objectives from ONE matrix response: driving duration (the primary
 * objective) and driving distance (the tie-break), sharing one unresolved-leg
 * counter so a partially unsnapped matrix is visible to the caller.
 *
 * Both objectives share ONE point index, so a door resolves its matrix position
 * once no matter which objective a sweep prices in.
 */
export function createMatrixMetricFns(points, matrix) {
    const count = points.length;
    const resolveIndex = createPointIndex(points);
    const unresolved = { count: 0 };
    const distances = flattenTable(matrix.distances, count);
    const durations = flattenTable(matrix.durations, count);

    return {
        distanceBetween: distances
            ? createFlatLookup(distances, count, resolveIndex, unresolved)
            : null,
        durationBetween: durations
            ? createFlatLookup(durations, count, resolveIndex, unresolved)
            : null,
        unresolved
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