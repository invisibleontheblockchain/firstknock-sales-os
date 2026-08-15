// Grouping street blocks into work windows using ROAD distance, not geometry.
//
// THE DEFECT THIS EXISTS TO REMOVE
// A wide territory has more street blocks than one 250-point matrix can carry, so
// the windows the solver optimizes inside used to be cut with a k-d bisection on
// latitude/longitude. Every level BELOW that cut is road-priced, but the cut
// itself is a routing decision made without roads: a box drawn across a river,
// a highway, a rail line or a single-throat subdivision contains blocks that are
// 0.2 mi apart on the map and four miles apart to drive. Once two such blocks are
// in the same window, no amount of road-aware optimization inside that window can
// undo it — the rep is committed to the crossing.
//
// WHAT THIS DOES INSTEAD
// Blocks are assigned to access seeds by measured DRIVING distance:
//
//   seeds        spread across the territory (coverage only, see below)
//   assignment   each block joins the seed it is closest to BY ROAD
//   capacity     a group never exceeds the doors one exact matrix can carry
//
// Geometry is used for ONE thing: choosing where the seeds sit, which only needs
// to cover the territory. Which group a block actually lands in — the decision
// that can trap the solver — is priced on the road network. A block on the far
// bank is road-far from this bank's seed and road-near to its own, so the two
// banks separate without anyone teaching the code what a river is.
//
// Nothing here is tuned to a city or a fixture: the inputs are blocks and a road
// engine, and the topology decides the grouping.

import { fetchRoadCostRows, MAX_ROUTE_MATRIX_POINTS } from './roadMatrix.js';

export const ROAD_GROUPING_VERSION = 'road_access_grouping_v1';

// Seeds requested beyond the theoretical minimum (totalDoors / maxDoors). Road
// groups are uneven by nature — a dense subdivision and a sparse rural strip do
// not hold the same number of doors — so asking for exactly the minimum forces
// overflow spill on almost every route. Extra seeds are nearly free: they widen
// the destination side of one rectangular table, not the request count.
const SEED_OVERSHOOT = 1.6;

export const coordinateKey = (point) => `${Number(point?.lat).toFixed(6)},${Number(point?.lng).toFixed(6)}`;
export const compareKeys = (first, second) => (first < second ? -1 : first > second ? 1 : 0);

/**
 * The point that represents a set of points: closest to their centroid, ties
 * broken by coordinate key. Deterministic, so the same territory always produces
 * the same representatives and therefore reuses the same matrix cache entries.
 */
export function selectRepresentative(points) {
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

const doorCountOf = (entries) => entries.reduce((total, entry) => total + entry.block.doors.length, 0);

/**
 * Spread seed blocks across the territory by farthest-point sampling.
 *
 * Deliberately geometric. A seed is only a place to measure road distance FROM;
 * it makes no grouping decision, so it needs coverage rather than road truth, and
 * measuring road distance to choose the points we measure road distance to would
 * be circular. The first seed is the lowest coordinate key so the whole sequence
 * is deterministic.
 */
function selectSeedEntries(entries, seedCount) {
    const canonical = [...entries].sort((first, second) => (
        compareKeys(coordinateKey(first.representative), coordinateKey(second.representative))
    ));
    const seeds = [canonical[0]];
    const squaredGap = (first, second) => (
        (Number(first.representative.lat) - Number(second.representative.lat)) ** 2
        + (Number(first.representative.lng) - Number(second.representative.lng)) ** 2
    );
    while (seeds.length < seedCount && seeds.length < canonical.length) {
        let bestEntry = null;
        let bestGap = -1;
        canonical.forEach((entry) => {
            if (seeds.includes(entry)) return;
            const nearest = seeds.reduce((min, seed) => Math.min(min, squaredGap(entry, seed)), Infinity);
            if (nearest > bestGap + 1e-18) {
                bestGap = nearest;
                bestEntry = entry;
            }
        });
        if (!bestEntry) break;
        seeds.push(bestEntry);
    }
    return seeds;
}

/**
 * Group street blocks into door-budgeted windows on measured road distance.
 *
 * @param {Array} entries `{ block, representative }` for every street block
 * @param {object} options `{ maxDoors, baseUrl, profile, timeoutMs, fetchRows }`.
 *   `fetchRows` is injectable so the grouping can be exercised against a recorded
 *   road network in tests.
 * @returns {Promise<object>} `{ ok: true, groups, telemetry }` where each group is
 *   `{ entries, doorCount, representative }`, or `{ ok: false, code }`. Road cost
 *   that cannot be resolved fails the grouping: guessing here is what put two
 *   sides of a barrier in one window in the first place.
 */
export async function groupBlocksByRoadAccess(entries, options = {}) {
    const {
        maxDoors,
        baseUrl,
        profile = 'driving',
        timeoutMs = 20000,
        fetchRows = fetchRoadCostRows
    } = options;

    const totalDoors = doorCountOf(entries);
    const minimumGroups = Math.max(2, Math.ceil(totalDoors / maxDoors));
    const seedCount = Math.min(
        entries.length,
        MAX_ROUTE_MATRIX_POINTS,
        Math.ceil(minimumGroups * SEED_OVERSHOOT)
    );
    if (seedCount < 2) return { ok: false, code: 'TOO_FEW_BLOCKS_TO_GROUP' };

    const seeds = selectSeedEntries(entries, seedCount);
    let rows;
    let requestCount = 0;
    try {
        const measured = await fetchRows(
            entries.map((entry) => entry.representative),
            seeds.map((seed) => seed.representative),
            { baseUrl, profile, timeoutMs }
        );
        rows = measured.rows;
        requestCount = measured.requestCount || 0;
    } catch (error) {
        return { ok: false, code: 'GROUPING_ROAD_COST_UNAVAILABLE', reason: error.message };
    }

    // Each block's seeds in ascending ROAD distance. This ranking is the grouping
    // decision, and it is the reason a barrier separates groups on its own.
    const preferences = entries.map((entry, index) => {
        const ranked = seeds
            .map((_, seedIndex) => ({ seedIndex, cost: rows[index][seedIndex] }))
            .sort((first, second) => (
                Math.abs(first.cost - second.cost) > 1e-9
                    ? first.cost - second.cost
                    : first.seedIndex - second.seedIndex
            ));
        return { entry, index, ranked, bestCost: ranked[0].cost };
    });

    // Blocks with the clearest home are placed first, so a block that sits close
    // to one access point is never displaced by one that had a choice anyway.
    const placementOrder = [...preferences].sort((first, second) => (
        Math.abs(first.bestCost - second.bestCost) > 1e-9
            ? first.bestCost - second.bestCost
            : compareKeys(coordinateKey(first.entry.representative), coordinateKey(second.entry.representative))
    ));

    const buckets = seeds.map(() => ({ entries: [], doorCount: 0 }));
    let spilledBlocks = 0;
    for (const candidate of placementOrder) {
        const doors = candidate.entry.block.doors.length;
        // Preferred seed first, then the next-nearest BY ROAD that still has room.
        const target = candidate.ranked.find((choice) => (
            buckets[choice.seedIndex].doorCount + doors <= maxDoors
        ));
        if (!target) {
            return {
                ok: false,
                code: 'ROAD_GROUPING_CAPACITY_EXCEEDED',
                doorCount: doors,
                maxDoors
            };
        }
        if (target.seedIndex !== candidate.ranked[0].seedIndex) spilledBlocks += 1;
        buckets[target.seedIndex].entries.push(candidate.entry);
        buckets[target.seedIndex].doorCount += doors;
    }

    const groups = buckets
        .filter((bucket) => bucket.entries.length > 0)
        .map((bucket) => ({
            // Restored to canonical order inside the group; the group's own exact
            // door matrix decides the real sequence later.
            entries: [...bucket.entries].sort((first, second) => (
                compareKeys(coordinateKey(first.representative), coordinateKey(second.representative))
            )),
            doorCount: bucket.doorCount,
            representative: selectRepresentative(bucket.entries.map((entry) => entry.representative))
        }));

    if (groups.length < 2) return { ok: false, code: 'ROAD_GROUPING_COLLAPSED_TO_ONE_GROUP' };
    if (groups.length > MAX_ROUTE_MATRIX_POINTS) {
        return { ok: false, code: 'ROAD_GROUP_COUNT_EXCEEDS_MATRIX_LIMIT', groupCount: groups.length };
    }

    return {
        ok: true,
        groups,
        telemetry: {
            grouping_version: ROAD_GROUPING_VERSION,
            grouping_seed_count: seeds.length,
            grouping_group_count: groups.length,
            grouping_blocks_spilled_to_second_choice: spilledBlocks,
            grouping_osrm_requests: requestCount,
            grouping_road_pairs_requested: entries.length * seeds.length
        }
    };
}