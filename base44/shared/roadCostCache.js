// Shared road truth for one Precision generation.
//
// THE WASTE THIS REMOVES
// A decomposition portfolio solves the SAME doors several ways. The doors, the
// street blocks and therefore most of the road pairs are identical between
// candidates — the level-1 matrix over street-block representatives is byte-for-
// byte the same set of coordinates for every candidate, because a candidate only
// changes how blocks are GROUPED, never what the blocks are. Without a shared
// cache each candidate re-bought that matrix (25 requests at 250 points) and every
// repeated window matrix on top of it, so four attempts cost four times one.
//
// WHAT THIS IS ALLOWED TO DO
// Serve values already bought from OSRM, at the same coordinates, profile and
// engine version. Nothing else. It never interpolates, never substitutes a nearby
// pair, and never invents a value it was not given — a cache hit returns the exact
// meters and seconds OSRM returned, so a cached candidate and a cold candidate are
// numerically identical and selection stays a measurement rather than an artifact
// of ordering. A miss is a real fetch; an unresolvable pair still fails the route.
//
// Two layers, both exact:
//   matrix memo  same coordinate SET (order-independent) -> reuse whole matrix
//   pair store   individual from/to pairs -> a block whose every pair is already
//                known is answered locally instead of requested
// plus a measurement memo, because an identical final door order measures the
// same miles and the verification /route calls are otherwise re-bought per
// candidate.

import {
    fetchRoadMatrix,
    roadPointKey,
    ROAD_MATRIX_VERSION,
    DEFAULT_OSRM_BASE_URL
} from './roadMatrix.js';

// Cache schema version. Bumped whenever the stored shape or the meaning of a key
// changes, so an old entry can never be served to new key semantics.
const ROAD_COST_CACHE_SCHEMA = 'road_cost_cache_v1';

/**
 * The full identity of a road-cost QUESTION. A hit must mean "exactly this
 * question was already asked", not "a similar coordinate set was asked", so every
 * input capable of changing road truth belongs in the key: the cache schema, the
 * matrix/engine version, the routing profile, the engine endpoint, and the
 * annotation mode. Two candidates asking the same coordinates of a different
 * profile, a different OSRM deployment or a different annotation set are asking
 * different questions and must not share cached values.
 *
 * Coordinate identity itself comes from roadPointKey — the same rounding the
 * matrix indexes by — so a key can never mean a different place than the lookup.
 */
const questionIdentity = (options = {}) => [
    ROAD_COST_CACHE_SCHEMA,
    ROAD_MATRIX_VERSION,
    options.profile || 'driving',
    String(options.baseUrl || DEFAULT_OSRM_BASE_URL).replace(/\/+$/, ''),
    // fetchRoadMatrix asks for distance AND duration, and readBlock only serves a
    // block when both are known. A caller narrowing the annotation set is asking a
    // different question, so it is keyed as one.
    options.annotations || 'distance,duration'
].join('#');

/** Ordered key for a measured path: the miles depend on the ORDER, not the set. */
const measureRoadPathKey = (stops, identity) => [identity, ...stops.map(roadPointKey)].join('>');

// Pair-store ceiling. A 1,000-door candidate touches roughly 200k pairs, so a
// full portfolio would exceed a function's memory if every pair were kept
// forever. Once the ceiling is reached the store stops ACCEPTING new pairs and
// keeps serving what it has: correctness never depends on the cache, only cost
// does, and the skipped-store count is reported so the ceiling is visible rather
// than silently shaping the numbers.
export const MAX_CACHED_ROAD_PAIRS = 400_000;

/**
 * Create a generation-scoped road cost cache.
 *
 * Scoped, never global: it is created per generation and discarded with it, so a
 * later route can never be priced on coordinates bought for an earlier one under
 * a different profile or engine.
 *
 * @param {object} deps `{ fetchMatrix, measurePath, maxPairs }` — the fetchers are
 *   injectable so the reuse behavior can be tested against a counted fake engine.
 * @returns {object} `{ fetchMatrix, measurePath, stats }` — drop-in replacements
 *   for the sequencer's own fetchers.
 */
export function createRoadCostCache(deps = {}) {
    const {
        fetchMatrix: fetchMatrixImpl = fetchRoadMatrix,
        measurePath: measurePathImpl = null,
        maxPairs = MAX_CACHED_ROAD_PAIRS
    } = deps;

    const matrixMemo = new Map();
    const pairMeters = new Map();
    const pairSeconds = new Map();
    const measureMemo = new Map();
    const counters = {
        matrix_calls: 0,
        matrix_memo_hits: 0,
        pairs_served_from_cache: 0,
        pairs_fetched: 0,
        pair_stores_skipped_at_ceiling: 0,
        blocks_requested: 0,
        blocks_served_from_cache: 0,
        measure_calls: 0,
        measure_memo_hits: 0
    };

    // Road costs are DIRECTED. One-way streets, divided roads, turn restrictions
    // and ramps all make A->B and B->A legitimately different, so the two are
    // never canonicalized into one key — the direction is part of the pair.
    const pairKey = (identity, fromKey, toKey) => `${identity}|${fromKey}|${toKey}`;

    /**
     * A pair-store view bound to ONE road-cost question. The matrix layer only
     * knows the profile, so the rest of the identity (engine endpoint, annotation
     * mode, schema and engine version) is bound here rather than threaded through
     * it. Views share the counters and the stores; they never share key space.
     */
    const pairCacheFor = (identity) => ({
        /**
         * Whole-block read. A block is only served locally when EVERY one of its
         * pairs is already known in both objectives — a partially known block is
         * fetched in full, because splitting it into per-pair requests would cost
         * more OSRM calls than it saves.
         */
        readBlock(_profile, sources, destinations) {
            counters.blocks_requested += 1;
            const sourceKeys = sources.map(roadPointKey);
            const destinationKeys = destinations.map(roadPointKey);
            const distances = [];
            const durations = [];
            for (let row = 0; row < sourceKeys.length; row += 1) {
                const meterRow = [];
                const secondRow = [];
                for (let column = 0; column < destinationKeys.length; column += 1) {
                    const key = pairKey(identity, sourceKeys[row], destinationKeys[column]);
                    if (!pairMeters.has(key) || !pairSeconds.has(key)) return null;
                    meterRow.push(pairMeters.get(key));
                    secondRow.push(pairSeconds.get(key));
                }
                distances.push(meterRow);
                durations.push(secondRow);
            }
            counters.blocks_served_from_cache += 1;
            counters.pairs_served_from_cache += sourceKeys.length * destinationKeys.length;
            return { distances, durations };
        },

        /** Record a fetched block's pairs, exactly as the engine returned them. */
        writeBlock(_profile, sources, destinations, distances, durations) {
            const sourceKeys = sources.map(roadPointKey);
            const destinationKeys = destinations.map(roadPointKey);
            counters.pairs_fetched += sourceKeys.length * destinationKeys.length;
            if (!distances || !durations) return;
            for (let row = 0; row < sourceKeys.length; row += 1) {
                for (let column = 0; column < destinationKeys.length; column += 1) {
                    const meters = distances[row]?.[column];
                    const seconds = durations[row]?.[column];
                    if (!Number.isFinite(meters) || !Number.isFinite(seconds)) continue;
                    if (pairMeters.size >= maxPairs) {
                        counters.pair_stores_skipped_at_ceiling += 1;
                        continue;
                    }
                    const key = pairKey(identity, sourceKeys[row], destinationKeys[column]);
                    pairMeters.set(key, meters);
                    pairSeconds.set(key, seconds);
                }
            }
        }
    });

    /**
     * Coordinate-SET key: order-independent, so a reordered ask reuses a matrix.
     * The sorted key list is a MULTISET — repeated coordinates are kept, never
     * deduplicated — because a 46-point matrix with a repeated coordinate is not
     * the same question as the 45-point matrix without it.
     */
    const matrixKey = (points, identity) => [identity, ...points.map(roadPointKey).sort()].join('|');

    return {
        async fetchMatrix(points, options = {}) {
            counters.matrix_calls += 1;
            const identity = questionIdentity(options);
            const key = matrixKey(points, identity);
            const memoized = matrixMemo.get(key);
            // The memo is keyed by the coordinate SET, so a reuse must be re-indexed
            // against THIS caller's point order before its lookups mean anything.
            if (memoized && memoized.pointCount === points.length) {
                const reused = reindexMatrix(memoized, points);
                // A set that cannot be mapped one-to-one (duplicate coordinates
                // collapsing differently) is treated as a miss and re-fetched
                // rather than served against the wrong positions.
                if (reused) {
                    counters.matrix_memo_hits += 1;
                    return reused;
                }
            }
            const matrix = await fetchMatrixImpl(points, { ...options, pairCache: pairCacheFor(identity) });
            matrixMemo.set(key, { ...matrix, points: [...points] });
            return matrix;
        },

        async measurePath(stops, options = {}) {
            if (typeof measurePathImpl !== 'function') {
                throw new Error('Road cost cache was created without a path measurer.');
            }
            counters.measure_calls += 1;
            const key = measureRoadPathKey(stops, questionIdentity(options));
            if (measureMemo.has(key)) {
                counters.measure_memo_hits += 1;
                return measureMemo.get(key);
            }
            const measured = await measurePathImpl(stops, options);
            // Only successful measurements are memoized: a transient engine failure
            // must be retryable, not remembered as this order's verdict.
            if (measured?.ok) measureMemo.set(key, measured);
            return measured;
        },

        stats() {
            const totalPairs = counters.pairs_served_from_cache + counters.pairs_fetched;
            return {
                ...counters,
                cache_schema: ROAD_COST_CACHE_SCHEMA,
                road_matrix_version: ROAD_MATRIX_VERSION,
                unique_road_pairs: pairMeters.size,
                unique_matrices: matrixMemo.size,
                pair_cache_hit_rate_pct: totalPairs > 0
                    ? Math.round((counters.pairs_served_from_cache / totalPairs) * 1000) / 10
                    : 0,
                blocks_avoided_by_reuse: counters.blocks_served_from_cache,
                pair_cache_at_ceiling: pairMeters.size >= maxPairs
            };
        }
    };
}

/**
 * Re-map a memoized matrix onto a new point order.
 *
 * The memo is hit when the coordinate SET matches, which does not mean the arrays
 * are in the same order. Returning the stored tables as-is would then price the
 * wrong pairs — silently, and only for callers lucky enough to hit the memo. The
 * tables are therefore permuted through the stored points' coordinate keys, and a
 * set that cannot be mapped one-to-one is treated as a miss by the caller.
 */
function reindexMatrix(stored, points) {
    const positionByKey = new Map();
    stored.points.forEach((point, index) => {
        const key = roadPointKey(point);
        if (!positionByKey.has(key)) positionByKey.set(key, index);
    });
    const mapping = points.map((point) => positionByKey.get(roadPointKey(point)));
    if (mapping.some((index) => index === undefined)) return null;

    const permute = (table) => (table
        ? mapping.map((row) => mapping.map((column) => table[row][column]))
        : null);
    return {
        ...stored,
        distances: permute(stored.distances),
        durations: permute(stored.durations),
        source: `${stored.source}+cache`,
        points: undefined
    };
}