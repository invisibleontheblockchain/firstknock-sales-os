// Scaling the road matrix past one route's worth of doors.
//
// A complete door-to-door matrix is what the solver wants, but its cost is
// quadratic in BOTH directions: N x N cells fetched as ceil(N/46)^2 OSRM
// requests (250 doors = 36 requests, 1,000 = 484, 2,000 = 1,936). On the public
// OSRM demo server that wall is real, so above the proven door limit the route
// used to skip the matrix entirely and keep an aerial order while still being
// labelled optimized. That silent cliff is what this module removes.
//
// Instead of dropping to aerial, the matrix is bounded at the STREET BLOCK level
// — the same blocks `roadAwareStreetSweep` reorders. One representative door per
// block goes into the matrix, so every leg the solver prices BETWEEN blocks (the
// legs that decide the route) stays road-priced, and only legs inside a single
// street segment fall back to straight-line distance. Those intra-block legs are
// walked in house-number order regardless, so they are not a decision the
// objective makes.
//
// Two tiers, one contract:
//   door  — exact, every leg road-priced (unchanged behaviour, <= 250 doors)
//   block — road-priced between blocks, aerial within a block
// The tier is always reported so a stored route can never claim more precision
// than it was measured with.

import { haversineMiles } from './routeContinuityOptimizer.js';
import { buildStreetBlocks } from './roadAwareStreetSweep.js';
import { createMatrixMetricFns, MAX_ROUTE_MATRIX_POINTS } from './roadMatrix.js';

export const TIER_DOOR = 'door';
export const TIER_BLOCK = 'block';
// Third tier, for routes with more street blocks than the matrix can carry.
// Blocks are grouped into neighbourhood clusters so the legs BETWEEN
// neighbourhoods — the ones that decide whether a rep drives 15 minutes away and
// back — stay road-priced. Without it those routes dropped to a pure aerial
// order, which is precisely the back-and-forth this tier removes.
export const TIER_CLUSTER = 'cluster';

// Hard product ceiling for one road-aware request. Block-tier work is bounded by
// BLOCK count, not door count, so this only guards the linear per-door passes
// (grouping, boustrophedon, intra-street 2-opt) and response size.
export const MAX_TIERED_ROUTE_DOORS = 2500;

// Refinement depth for the block tier, in the same deterministic DP steps the
// sweep budgets all of its other work in.
//
// The door tier keeps its tuned 16M budget — those fixtures spend it and get
// measurable quality for it. A block-tier route has many more blocks, and one
// that does not converge spends the whole pool: measured at 120 blocks / 1,440
// doors that was 78.8s for a single sweep, and a request runs two (distance and
// duration) against a 90s wall-clock safety cutoff. Letting wall clock be the
// binding limit is the one outcome the sweep must avoid, because identical input
// could then return different routes on different hardware.
//
// Measured on a 120-block grid territory:
//   16,000,000 steps -> 78.8s, 102.6 mi
//    2,000,000 steps -> 13.1s, 102.6 mi   <- shipped
//      500,000 steps ->  4.1s, 102.6 mi
// The depth above 2M was unspent value on that route, so this buys bounded,
// hardware-independent runtime for no measured quality loss.
export const BLOCK_TIER_REFINEMENT_STEP_BUDGET = 2_000_000;

const coordinateKey = (point) => `${Number(point?.lat).toFixed(6)},${Number(point?.lng).toFixed(6)}`;

// 20 mph — the pace a rep actually covers a residential street segment at,
// including stopping. Only ever applied to intra-block legs.
const INTRA_BLOCK_MINUTES_PER_MILE = 3;

/**
 * The door a block is represented by: closest to the block centroid, ties broken
 * by coordinate key. Deterministic, so the same route always builds the same
 * matrix (and therefore hits the same cache key).
 */
function selectBlockRepresentative(doors) {
    const centroid = doors.reduce(
        (total, door) => ({
            lat: total.lat + Number(door.lat) / doors.length,
            lng: total.lng + Number(door.lng) / doors.length
        }),
        { lat: 0, lng: 0 }
    );
    return [...doors].sort((first, second) => {
        const firstDistance = (Number(first.lat) - centroid.lat) ** 2 + (Number(first.lng) - centroid.lng) ** 2;
        const secondDistance = (Number(second.lat) - centroid.lat) ** 2 + (Number(second.lng) - centroid.lng) ** 2;
        if (Math.abs(firstDistance - secondDistance) > 1e-18) return firstDistance - secondDistance;
        return coordinateKey(first) < coordinateKey(second) ? -1 : 1;
    })[0];
}

/**
 * Group street blocks into at most `maxClusters` geographic clusters.
 *
 * Deterministic k-d bisection: the largest remaining cluster is split at the
 * median of its wider axis until the cluster budget is met. No randomness and no
 * iteration-order dependence, so the same route always builds the same clusters
 * — and therefore hits the same matrix cache key.
 */
function partitionBlocksIntoClusters(entries, maxClusters) {
    let clusters = [entries];
    while (clusters.length < maxClusters) {
        let targetIndex = -1;
        let targetSize = 1;
        clusters.forEach((cluster, index) => {
            if (cluster.length > targetSize) {
                targetSize = cluster.length;
                targetIndex = index;
            }
        });
        if (targetIndex === -1) break;

        const cluster = clusters[targetIndex];
        const lats = cluster.map((entry) => Number(entry.representative.lat));
        const lngs = cluster.map((entry) => Number(entry.representative.lng));
        const axis = (Math.max(...lats) - Math.min(...lats)) >= (Math.max(...lngs) - Math.min(...lngs))
            ? 'lat'
            : 'lng';
        const sorted = [...cluster].sort((first, second) => {
            const delta = Number(first.representative[axis]) - Number(second.representative[axis]);
            if (delta !== 0) return delta;
            return coordinateKey(first.representative) < coordinateKey(second.representative) ? -1 : 1;
        });
        const middle = Math.floor(sorted.length / 2);
        clusters = [
            ...clusters.slice(0, targetIndex),
            sorted.slice(0, middle),
            sorted.slice(middle),
            ...clusters.slice(targetIndex + 1)
        ].filter((group) => group.length > 0);
    }
    return clusters;
}

/**
 * The tier rule, as a pure predicate over counts.
 *
 * Extracted so a caller can ask "what tier would this route get?" WITHOUT
 * building a matrix — the territory partitioner validates every partition this
 * way before it is allowed to proceed. It is exported precisely so the
 * thresholds are not restated anywhere else: `planTieredRoadMatrix` below is its
 * only other consumer, so the plan and the prediction can never disagree.
 *
 * Pass `blockCount: null` when blocks have not been built yet; the answer is
 * then `tier: null, needsBlockCount: true` for any route above the door tier.
 *
 * @returns {object} `{ ok: true, tier, blockBudget, anchorsIncluded }` or
 *   `{ ok: false, code, ... }`.
 */
export function predictMatrixTier({ doorCount, blockCount = null, anchorCount = 0 }) {
    if (doorCount > MAX_TIERED_ROUTE_DOORS) {
        return { ok: false, code: 'ROUTE_EXCEEDS_TIERED_DOOR_LIMIT', doorCount, limit: MAX_TIERED_ROUTE_DOORS };
    }
    if (doorCount <= MAX_ROUTE_MATRIX_POINTS) {
        return {
            ok: true,
            tier: TIER_DOOR,
            blockBudget: null,
            anchorsIncluded: doorCount + anchorCount <= MAX_ROUTE_MATRIX_POINTS
        };
    }

    const blockBudget = MAX_ROUTE_MATRIX_POINTS - anchorCount;
    if (blockCount === null) {
        return { ok: true, tier: null, needsBlockCount: true, blockBudget };
    }
    if (blockBudget < 2) {
        return {
            ok: false,
            code: 'STREET_BLOCKS_EXCEED_MATRIX_LIMIT',
            doorCount,
            blockCount,
            limit: MAX_ROUTE_MATRIX_POINTS
        };
    }
    return {
        ok: true,
        tier: blockCount > blockBudget ? TIER_CLUSTER : TIER_BLOCK,
        blockBudget,
        anchorsIncluded: true
    };
}

/**
 * Decide which coordinates the matrix should carry for this route.
 *
 * @returns {object} `{ ok: true, tier, matrixPoints, blockCount, doorCount,
 *   representativeByCoordKey, blockKeyByCoordKey }` or `{ ok: false, code }`
 *   when even the block tier cannot be bounded — the caller then takes its
 *   explicit, labelled fallback rather than quietly mispricing the route.
 */
export function planTieredRoadMatrix(properties, anchorPoints = []) {
    const doorCount = properties.length;
    const doorDecision = predictMatrixTier({ doorCount, anchorCount: anchorPoints.length });
    if (!doorDecision.ok) return doorDecision;

    if (doorDecision.tier === TIER_DOOR) {
        // Proven path, unchanged: every door in the matrix, and the anchors too
        // whenever they still fit beside them.
        const { anchorsIncluded } = doorDecision;
        return {
            ok: true,
            tier: TIER_DOOR,
            anchorsIncluded,
            matrixPoints: anchorsIncluded ? [...properties, ...anchorPoints] : [...properties],
            doorCount,
            blockCount: 0,
            representativeByCoordKey: new Map(),
            blockKeyByCoordKey: new Map()
        };
    }

    const blocks = buildStreetBlocks(properties);
    const decision = predictMatrixTier({
        doorCount,
        blockCount: blocks.length,
        anchorCount: anchorPoints.length
    });
    if (!decision.ok) return decision;
    const { blockBudget } = decision;
    if (decision.tier === TIER_CLUSTER) {
        // Too many blocks to price one by one — cluster them rather than
        // abandoning the matrix and shipping an unmeasured aerial order.
        const entries = blocks.map((block) => ({
            block,
            representative: selectBlockRepresentative(block.doors)
        }));
        const clusters = partitionBlocksIntoClusters(entries, blockBudget);
        const clusterRepresentativeByCoordKey = new Map();
        const clusterKeyByCoordKey = new Map();
        const clusterRepresentatives = [];
        clusters.forEach((cluster, index) => {
            const representative = selectBlockRepresentative(
                cluster.map((entry) => entry.representative)
            );
            clusterRepresentatives.push(representative);
            const clusterKey = `cluster:${index}`;
            cluster.forEach((entry) => entry.block.doors.forEach((door) => {
                const key = coordinateKey(door);
                if (clusterRepresentativeByCoordKey.has(key)) return;
                clusterRepresentativeByCoordKey.set(key, representative);
                clusterKeyByCoordKey.set(key, clusterKey);
            }));
        });

        return {
            ok: true,
            tier: TIER_CLUSTER,
            anchorsIncluded: true,
            matrixPoints: [...clusterRepresentatives, ...anchorPoints],
            doorCount,
            blockCount: blocks.length,
            clusterCount: clusters.length,
            representativeByCoordKey: clusterRepresentativeByCoordKey,
            blockKeyByCoordKey: clusterKeyByCoordKey
        };
    }

    const representativeByCoordKey = new Map();
    const blockKeyByCoordKey = new Map();
    const representatives = [];
    blocks.forEach((block) => {
        const representative = selectBlockRepresentative(block.doors);
        representatives.push(representative);
        block.doors.forEach((door) => {
            const key = coordinateKey(door);
            // A shared coordinate keeps its first canonical block, matching how
            // the matrix itself de-duplicates identical coordinates.
            if (representativeByCoordKey.has(key)) return;
            representativeByCoordKey.set(key, representative);
            blockKeyByCoordKey.set(key, block.key);
        });
    });

    return {
        ok: true,
        tier: TIER_BLOCK,
        // Block tier always has room for the anchors, so anchor legs are priced.
        anchorsIncluded: true,
        matrixPoints: [...representatives, ...anchorPoints],
        doorCount,
        blockCount: blocks.length,
        representativeByCoordKey,
        blockKeyByCoordKey
    };
}

/**
 * Metric functions for a planned tier.
 *
 * Door tier delegates straight through. Block tier resolves each door to its
 * block representative before the lookup, and prices a same-block leg with
 * straight-line distance — anchors, which belong to no block, resolve to
 * themselves and stay road-priced.
 */
export function createTieredMatrixMetricFns(matrix, plan) {
    const base = createMatrixMetricFns(plan.matrixPoints, matrix);
    if (plan.tier === TIER_DOOR) {
        return { ...base, intraBlockLegCount: { count: 0 } };
    }

    const intraBlockLegCount = { count: 0 };
    const resolve = (point) => plan.representativeByCoordKey.get(coordinateKey(point)) || point;
    const blockOf = (point) => plan.blockKeyByCoordKey.get(coordinateKey(point));

    const tiered = (metric) => (metric
        ? (from, to) => {
            const fromBlock = blockOf(from);
            const toBlock = blockOf(to);
            if (fromBlock !== undefined && fromBlock === toBlock) {
                intraBlockLegCount.count += 1;
                return haversineMiles(from, to);
            }
            return metric(resolve(from), resolve(to));
        }
        : null);

    return {
        // Duration keeps its own units: an intra-block leg is converted from
        // miles at a walking-to-door pace so the two objectives stay comparable.
        distanceBetween: tiered(base.distanceBetween),
        durationBetween: base.durationBetween
            ? (from, to) => {
                const fromBlock = blockOf(from);
                const toBlock = blockOf(to);
                if (fromBlock !== undefined && fromBlock === toBlock) {
                    intraBlockLegCount.count += 1;
                    return haversineMiles(from, to) * INTRA_BLOCK_MINUTES_PER_MILE;
                }
                return base.durationBetween(resolve(from), resolve(to));
            }
            : null,
        unresolved: base.unresolved,
        intraBlockLegCount
    };
}