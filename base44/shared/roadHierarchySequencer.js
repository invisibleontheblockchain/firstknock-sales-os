// Hierarchical road-aware sequencing for routes too large for one road matrix.
//
// THE DEFECT THIS EXISTS TO REMOVE
// A complete door-to-door matrix costs ceil(N/46)^2 OSRM requests, so past ~250
// doors the route was priced on REPRESENTATIVES: one point stood in for a whole
// cluster of streets, and every leg inside that cluster was then judged with
// straight-line distance. Straight-line distance does not know about rivers,
// railways, limited-access highways, cul-de-sacs or one-way pairs, so it prices a
// leg that is 0.10 mi apart on the map but 0.48 mi to drive as if it were nearly
// free. The search happily wove between four such streets, and the route reported
// itself road-optimized because the computation had completed.
//
// THE RULE THIS ENFORCES
// If a comparison can decide which neighbourhood, street or block comes next,
// whether the route leaves an area and returns, or whether it crosses between
// road-access pockets, that comparison is priced on the road network. Not
// approximated by a representative of a group the decision happens INSIDE.
//
// HOW SCALE IS KEPT AFFORDABLE ANYWAY
// Clusters are sized by DOOR count, not block count, so that every door of a
// cluster fits inside one exact matrix:
//
//   doors -> street blocks -> door-budgeted clusters
//     level 1: cluster order            road matrix over cluster representatives
//     level 2: everything inside one    EXACT door-to-door matrix for that cluster
//     level 3: real mileage/geometry    OSRM /route over the final order
//
// Level 2 is the correction. Because the cluster's own matrix carries every one
// of its doors, the block order, the direction each block is walked, and the
// door order inside a block are all priced on real road distance — there is no
// intra-cluster aerial pricing left to be wrong about. The only approximation
// remaining is WHICH cluster follows which, which is priced on the road network
// between representatives and then realized against the true neighbouring door.
//
// Nothing here is tuned to a particular city. The inputs are doors and a road
// engine; the topology decides the shape.

import { haversineMiles, isValidPoint } from './routeContinuityOptimizer.js';
import { buildStreetBlocks, roadAwareStreetSweep } from './roadAwareStreetSweep.js';
import { createMatrixMetricFns, fetchRoadMatrix, MAX_ROUTE_MATRIX_POINTS } from './roadMatrix.js';

export const HIERARCHY_VERSION = 'road_hierarchy_v1';

// Two matrix slots per cluster are reserved for its entry and exit PORTS, so a
// cluster is never solved as an island: it is solved as the leg of a longer drive
// that arrives from a known door and leaves toward a known one.
const PORT_SLOTS = 2;
export const MAX_CLUSTER_DOORS = MAX_ROUTE_MATRIX_POINTS - PORT_SLOTS;

// Refinement depth, in the same deterministic DP steps the sweep budgets all of
// its work in. Spent per cluster rather than once for the route, so the pool is
// divided by cluster count to keep total solver time bounded and hardware
// independent — wall clock must never be the binding limit, or identical input
// could return different routes on different machines.
export const HIERARCHY_REFINEMENT_STEP_BUDGET = 2_000_000;

// Doors per window, which is what the OSRM bill is actually made of. A window of
// w doors costs ceil(w/46)^2 requests, so total cost is (N/w) * ceil(w/46)^2:
// 1,000 doors cost 22 requests at w=46, 44 at w=92, 65 at w=138. Bigger windows
// optimize more doors together but the cost climbs faster than the quality does,
// so 92 (two matrix chunks) is the default balance. Never above MAX_CLUSTER_DOORS,
// which is what one matrix can physically carry.
export const DEFAULT_WINDOW_DOORS = 92;
const CLUSTER_ORDER_REFINEMENT_PASSES = 5;

const coordinateKey = (point) => `${Number(point?.lat).toFixed(6)},${Number(point?.lng).toFixed(6)}`;
const compareKeys = (first, second) => (first < second ? -1 : first > second ? 1 : 0);

/** Doors carried by a group of block entries. */
const doorCountOf = (cluster) => cluster.reduce((total, entry) => total + entry.block.doors.length, 0);

/**
 * The door that represents a set of points: closest to their centroid, ties
 * broken by coordinate key. Deterministic, so the same route always builds the
 * same clusters and therefore reuses the same matrix cache entries.
 */
function selectRepresentative(points) {
    const centroid = points.reduce(
        (total, point) => ({
            lat: total.lat + Number(point.lat) / points.length,
            lng: total.lng + Number(point.lng) / points.length
        }),
        { lat: 0, lng: 0 }
    );
    return [...points].sort((first, second) => {
        const firstDistance = (Number(first.lat) - centroid.lat) ** 2 + (Number(first.lng) - centroid.lng) ** 2;
        const secondDistance = (Number(second.lat) - centroid.lat) ** 2 + (Number(second.lng) - centroid.lng) ** 2;
        if (Math.abs(firstDistance - secondDistance) > 1e-18) return firstDistance - secondDistance;
        return compareKeys(coordinateKey(first), coordinateKey(second));
    })[0];
}

/**
 * Split block entries into geographic clusters until every cluster's DOOR count
 * fits one exact matrix.
 *
 * Deterministic k-d bisection at the median of the wider axis. Door count is the
 * split criterion because it is what the matrix is billed in — clustering by
 * block count instead is what allowed a 200-door cluster to be priced by one
 * representative.
 *
 * A cluster that is a single street block and still too large cannot be split
 * without breaking street atomicity; it is returned as-is and reported, so the
 * caller degrades that cluster honestly instead of silently.
 */
export function partitionBlocksByDoorBudget(entries, { maxDoors = MAX_CLUSTER_DOORS, maxClusters = MAX_ROUTE_MATRIX_POINTS } = {}) {
    let clusters = [entries];
    const oversizeAtomic = [];

    for (;;) {
        let targetIndex = -1;
        let targetDoors = maxDoors;
        clusters.forEach((cluster, index) => {
            if (cluster.length < 2) return;
            if (oversizeAtomic.includes(index)) return;
            const doors = doorCountOf(cluster);
            if (doors > targetDoors) {
                targetDoors = doors;
                targetIndex = index;
            }
        });
        if (targetIndex === -1) break;
        if (clusters.length >= maxClusters) break;

        const cluster = clusters[targetIndex];
        const lats = cluster.map((entry) => Number(entry.representative.lat));
        const lngs = cluster.map((entry) => Number(entry.representative.lng));
        const axis = (Math.max(...lats) - Math.min(...lats)) >= (Math.max(...lngs) - Math.min(...lngs))
            ? 'lat'
            : 'lng';
        const sorted = [...cluster].sort((first, second) => {
            const delta = Number(first.representative[axis]) - Number(second.representative[axis]);
            if (delta !== 0) return delta;
            return compareKeys(coordinateKey(first.representative), coordinateKey(second.representative));
        });
        const middle = Math.floor(sorted.length / 2);
        clusters = [
            ...clusters.slice(0, targetIndex),
            sorted.slice(0, middle),
            sorted.slice(middle),
            ...clusters.slice(targetIndex + 1)
        ].filter((group) => group.length > 0);
    }

    return clusters.map((cluster) => ({
        entries: cluster,
        doorCount: doorCountOf(cluster),
        // A single block that exceeds the budget is one street segment; the doors
        // on it are walked in street order either way, so it is a reportable
        // limitation rather than a routing decision made without roads.
        atomicOversize: cluster.length === 1 && doorCountOf(cluster) > maxDoors,
        representative: selectRepresentative(cluster.map((entry) => entry.representative))
    }));
}

/**
 * Order units (cluster representatives) on a road-priced cost function.
 *
 * Nearest-neighbour seed, then reversal and relocation refinement under a
 * deterministic step budget — the same shape the street sweep uses, at a level
 * where a "unit" is a neighbourhood instead of a street. Every comparison it
 * makes goes through `cost`, which is a real road matrix lookup.
 */
export function orderUnitsByRoadCost(units, { cost, startLocation = null, endLocation = null, stepBudget = 200_000 } = {}) {
    if (units.length <= 2) return [...units];

    const pathCost = (order) => {
        let total = isValidPoint(startLocation) ? cost(startLocation, order[0].representative) : 0;
        for (let index = 0; index < order.length - 1; index += 1) {
            total += cost(order[index].representative, order[index + 1].representative);
        }
        if (isValidPoint(endLocation)) total += cost(order[order.length - 1].representative, endLocation);
        return total;
    };

    const remaining = [...units].sort((first, second) => (
        compareKeys(coordinateKey(first.representative), coordinateKey(second.representative))
    ));
    const ordered = [];
    let seedIndex = 0;
    if (isValidPoint(startLocation)) {
        let seedCost = Infinity;
        remaining.forEach((unit, index) => {
            const candidate = cost(startLocation, unit.representative);
            if (candidate + 1e-9 < seedCost) {
                seedCost = candidate;
                seedIndex = index;
            }
        });
    }
    ordered.push(remaining.splice(seedIndex, 1)[0]);
    while (remaining.length > 0) {
        const current = ordered[ordered.length - 1];
        let bestIndex = 0;
        let bestCost = Infinity;
        remaining.forEach((candidate, index) => {
            const value = cost(current.representative, candidate.representative);
            if (value + 1e-9 < bestCost) {
                bestCost = value;
                bestIndex = index;
            }
        });
        ordered.push(remaining.splice(bestIndex, 1)[0]);
    }

    let best = ordered;
    let bestCost = pathCost(best);
    let steps = stepBudget;
    for (let pass = 0; pass < CLUSTER_ORDER_REFINEMENT_PASSES; pass += 1) {
        let improvedOrder = null;
        for (let start = 0; start < best.length - 1 && steps > 0; start += 1) {
            for (let finish = start + 1; finish < best.length && steps > 0; finish += 1) {
                const candidate = [
                    ...best.slice(0, start),
                    ...best.slice(start, finish + 1).reverse(),
                    ...best.slice(finish + 1)
                ];
                steps -= candidate.length;
                const candidateCost = pathCost(candidate);
                if (candidateCost + 1e-6 < bestCost) {
                    bestCost = candidateCost;
                    improvedOrder = candidate;
                }
            }
        }
        for (let from = 0; from < best.length && steps > 0; from += 1) {
            for (let to = 0; to <= best.length && steps > 0; to += 1) {
                if (to === from || to === from + 1) continue;
                const candidate = [...best];
                const [moved] = candidate.splice(from, 1);
                candidate.splice(to > from ? to - 1 : to, 0, moved);
                steps -= candidate.length;
                const candidateCost = pathCost(candidate);
                if (candidateCost + 1e-6 < bestCost) {
                    bestCost = candidateCost;
                    improvedOrder = candidate;
                }
            }
        }
        if (!improvedOrder) break;
        best = improvedOrder;
    }
    return best;
}

/** Unique matrix coordinates for one cluster: its doors plus its two ports. */
function clusterMatrixPoints(doors, entryPort, exitPort) {
    const points = [];
    const seen = new Set();
    [...doors, entryPort, exitPort].forEach((point) => {
        if (!isValidPoint(point)) return;
        const key = coordinateKey(point);
        if (seen.has(key)) return;
        seen.add(key);
        points.push(point);
    });
    return points;
}

/**
 * Sequence a route hierarchically, road-aware at every level that can change the
 * order.
 *
 * @param {Array} properties doors to order
 * @param {object} options `{ startLocation, endLocation, baseUrl, profile,
 *   timeoutMs, fetchMatrix, refinementStepBudget }`. `fetchMatrix` is injectable
 *   so the levels can be exercised against a recorded road network in tests.
 * @returns {Promise<object>} `{ ok: true, order, telemetry }`, or
 *   `{ ok: false, code }` when the hierarchy does not apply / cannot be bounded.
 *   `telemetry.degraded` is true whenever ANY part of the final order was
 *   sequenced without road pricing — the caller must not describe a degraded
 *   route as road-optimized.
 */
export async function sequenceRoadHierarchy(properties, options = {}) {
    const {
        startLocation = null,
        endLocation = null,
        baseUrl,
        profile = 'driving',
        timeoutMs = 20000,
        fetchMatrix = fetchRoadMatrix,
        refinementStepBudget = HIERARCHY_REFINEMENT_STEP_BUDGET,
        windowDoors = DEFAULT_WINDOW_DOORS
    } = options;
    const maxWindowDoors = Math.max(2, Math.min(Number(windowDoors) || DEFAULT_WINDOW_DOORS, MAX_CLUSTER_DOORS));

    const blocks = buildStreetBlocks(properties);
    if (blocks.length === 0) return { ok: false, code: 'NO_STREET_BLOCKS' };

    const entries = blocks.map((block) => ({
        block,
        representative: selectRepresentative(block.doors)
    }));
    const anchorPoints = [startLocation, endLocation].filter(isValidPoint);

    const telemetry = {
        hierarchy_version: HIERARCHY_VERSION,
        cluster_count: 0,
        street_block_count: blocks.length,
        max_window_doors: maxWindowDoors,
        matrix_request_count: 0,
        // Level 1
        cluster_order_road_priced: false,
        // Whether the GROUPING of blocks into windows used road detail, or only
        // geometry. Geometric grouping can straddle a barrier; saying so is the
        // difference between a route that is road-priced and one that is also
        // road-grouped.
        window_grouping_road_priced: false,
        // Level 2, per cluster
        clusters_sequenced_on_exact_door_matrix: 0,
        clusters_degraded_to_aerial: 0,
        degraded_cluster_reasons: [],
        // Final legs, by how the decision that placed them was priced.
        intra_cluster_road_priced_legs: 0,
        cluster_seam_legs: 0,
        aerial_priced_legs: 0,
        degraded: false
    };

    // ---- Level 1: the order of STREET BLOCKS, priced on the road network. ----
    //
    // Blocks, not pre-built geographic clusters, are the level-1 unit. Cutting the
    // territory into lat/lng boxes first and ordering those boxes looks tidy but is
    // wrong in exactly the geography that matters: a box drawn across a river
    // contains both banks, so the rep is forced to cross once per box no matter how
    // well each box is solved internally. A barrier-blind grouping decision is
    // still a routing decision. (Measured on the river fixture: box clusters forced
    // 6 crossings where a road-priced block order needs 1.)
    //
    // So the road-priced block order comes FIRST, and the door-budgeted windows are
    // then cut out of that order as contiguous runs — which cannot straddle a
    // barrier unless the road network itself says crossing is cheap.
    // Two bounded strategies, chosen by whether the blocks fit one matrix. Both
    // price the ordering on roads; they differ in how much road detail the GROUPING
    // itself gets, which is reported rather than assumed.
    let orderedClusters = null;
    const blockPoints = [...entries.map((entry) => entry.representative), ...anchorPoints];

    if (blockPoints.length <= MAX_ROUTE_MATRIX_POINTS) {
        // Preferred: order every street block on the road network, then cut the
        // door-budgeted windows out of that order as contiguous runs. A window can
        // then only straddle a barrier if the road network says crossing is cheap.
        try {
            const blockMatrix = await fetchMatrix(blockPoints, { baseUrl, profile, timeoutMs });
            telemetry.matrix_request_count += 1;
            const { distanceBetween } = createMatrixMetricFns(blockPoints, blockMatrix);
            const cost = (from, to) => {
                const value = distanceBetween(from, to);
                return Number.isFinite(value) ? value : haversineMiles(from, to);
            };
            const orderedEntries = orderUnitsByRoadCost(entries, { cost, startLocation, endLocation });
            orderedClusters = [];
            let window = [];
            let windowDoors = 0;
            orderedEntries.forEach((entry) => {
                const doors = entry.block.doors.length;
                if (window.length > 0 && windowDoors + doors > maxWindowDoors) {
                    orderedClusters.push({ entries: window, doorCount: windowDoors });
                    window = [];
                    windowDoors = 0;
                }
                window.push(entry);
                windowDoors += doors;
            });
            if (window.length > 0) orderedClusters.push({ entries: window, doorCount: windowDoors });
            telemetry.cluster_order_road_priced = true;
            telemetry.window_grouping_road_priced = true;
        } catch (error) {
            telemetry.degraded_cluster_reasons.push(`block_order_matrix: ${error.message}`);
        }
    }

    if (!orderedClusters) {
        // Too many street blocks for one matrix (a wide 1,000-door territory), or
        // that matrix failed. Windows are then cut geometrically and only their
        // ORDER is road-priced. Grouping without road detail is an approximation
        // that can straddle a barrier, so it is reported explicitly — this route is
        // road-priced but not road-grouped.
        const geometric = partitionBlocksByDoorBudget(entries, { maxDoors: maxWindowDoors });
        const windowPoints = [...geometric.map((cluster) => cluster.representative), ...anchorPoints];
        telemetry.window_grouping_road_priced = false;
        if (windowPoints.length > MAX_ROUTE_MATRIX_POINTS) {
            return { ok: false, code: 'WINDOW_COUNT_EXCEEDS_MATRIX_LIMIT', windowCount: geometric.length };
        }
        try {
            const windowMatrix = await fetchMatrix(windowPoints, { baseUrl, profile, timeoutMs });
            telemetry.matrix_request_count += 1;
            const { distanceBetween } = createMatrixMetricFns(windowPoints, windowMatrix);
            const cost = (from, to) => {
                const value = distanceBetween(from, to);
                return Number.isFinite(value) ? value : haversineMiles(from, to);
            };
            orderedClusters = orderUnitsByRoadCost(geometric, { cost, startLocation, endLocation });
            telemetry.cluster_order_road_priced = true;
        } catch (error) {
            // Window order decides whether the rep drives across town and back, so
            // an unusable matrix here is a real degradation, not a detail.
            telemetry.degraded = true;
            telemetry.degraded_cluster_reasons.push(`window_order_aerial: ${error.message}`);
            orderedClusters = orderUnitsByRoadCost(geometric, { cost: haversineMiles, startLocation, endLocation });
        }
    }

    orderedClusters.forEach((cluster) => {
        cluster.representative = selectRepresentative(cluster.entries.map((entry) => entry.representative));
    });
    telemetry.cluster_count = orderedClusters.length;
    if (orderedClusters.length < 2) {
        // Every door fits one exact matrix; the caller's door tier is strictly
        // better than a hierarchy over a single window.
        return { ok: false, code: 'SINGLE_CLUSTER_USE_EXACT_MATRIX' };
    }

    // ---- Level 2: everything inside a cluster, on that cluster's own matrix. ----
    const perClusterBudget = Math.max(
        50_000,
        Math.floor(refinementStepBudget / orderedClusters.length)
    );
    const order = [];
    for (let index = 0; index < orderedClusters.length; index += 1) {
        const cluster = orderedClusters[index];
        const doors = cluster.entries.flatMap((entry) => entry.block.doors);
        // Ports: arrive from the door actually reached last, leave toward the next
        // cluster's representative (its own solve then refines that seam). Without
        // ports a cluster is solved as an island and its entry/exit fall wherever
        // the isolated solve likes, which reintroduces the seam backtracking.
        const entryPort = order.length > 0 ? order[order.length - 1] : startLocation;
        // Leave toward the first block of the NEXT window in the level-1 order, not
        // that window's centroid: the centroid can sit on the far side of the
        // window, which pulls the exit toward a door the rep never drives to next.
        const exitPort = index < orderedClusters.length - 1
            ? orderedClusters[index + 1].entries[0].representative
            : endLocation;

        if (doors.length === 1) {
            order.push(doors[0]);
            telemetry.clusters_sequenced_on_exact_door_matrix += 1;
            continue;
        }

        const points = clusterMatrixPoints(doors, entryPort, exitPort);
        let sequenced = null;
        if (points.length <= MAX_ROUTE_MATRIX_POINTS) {
            try {
                const matrix = await fetchMatrix(points, { baseUrl, profile, timeoutMs });
                telemetry.matrix_request_count += 1;
                const { distanceBetween } = createMatrixMetricFns(points, matrix);
                sequenced = roadAwareStreetSweep(doors, {
                    distanceBetween,
                    startLocation: isValidPoint(entryPort) ? entryPort : null,
                    endLocation: isValidPoint(exitPort) ? exitPort : null,
                    refinementStepBudget: perClusterBudget
                });
                telemetry.clusters_sequenced_on_exact_door_matrix += 1;
                telemetry.intra_cluster_road_priced_legs += doors.length - 1;
            } catch (error) {
                telemetry.degraded_cluster_reasons.push(`cluster_${index}_matrix: ${error.message}`);
            }
        } else {
            // One street segment with more doors than a matrix can carry. Its doors
            // are walked in street order regardless, but the route must say so.
            telemetry.degraded_cluster_reasons.push(`cluster_${index}_atomic_oversize_${doors.length}_doors`);
        }

        if (!sequenced) {
            telemetry.clusters_degraded_to_aerial += 1;
            telemetry.aerial_priced_legs += doors.length - 1;
            telemetry.degraded = true;
            sequenced = roadAwareStreetSweep(doors, {
                startLocation: isValidPoint(entryPort) ? entryPort : null,
                endLocation: isValidPoint(exitPort) ? exitPort : null,
                refinementStepBudget: perClusterBudget
            });
        }
        order.push(...sequenced);
    }

    telemetry.cluster_seam_legs = Math.max(0, orderedClusters.length - 1);
    const decisionLegs = telemetry.intra_cluster_road_priced_legs
        + telemetry.cluster_seam_legs
        + telemetry.aerial_priced_legs;
    telemetry.road_aware_leg_pct = decisionLegs > 0
        ? Math.round(
            ((telemetry.intra_cluster_road_priced_legs + telemetry.cluster_seam_legs) / decisionLegs) * 1000
        ) / 10
        : 0;
    if (!telemetry.cluster_order_road_priced) telemetry.degraded = true;

    return { ok: true, order, telemetry };
}