// Soft balance pass over already-valid partitions.
//
// Stage 2, step 3. Median bisection produces partitions that are valid and
// compact but not necessarily even: one side of a cut can end up noticeably
// lighter than the other. This pass evens them out — and only that.
//
// Precedence is fixed and enforced structurally, not by convention:
//
//   1. VALIDITY   a move that would push the receiving partition over the home
//                 or block budget is never considered.
//   2. TOPOLOGY   moves are whole routing units, so a protected pocket cannot be
//                 split by balancing. There is no code path here that touches a
//                 unit's contents.
//   3. COMPACTNESS only a BOUNDARY unit may move, and only to its own nearest
//                 neighbouring partition, so balance shifts the seam between two
//                 adjacent partitions instead of flinging a unit across the
//                 territory. (Comparing "closer to the receiver's centroid than
//                 to my own" was tried first and is wrong: in an evenly filled
//                 strip even the seam unit sits closer to its own centroid, so
//                 no move ever qualified and the pass was inert.)
//   4. BALANCE    the objective, and the only thing allowed to be sacrificed.
//
// Consequence, stated plainly: when those rules conflict with even sizing, the
// result stays uneven on purpose. `limitedBy` records why, so an uneven outcome
// is explainable instead of looking like a bug.

const EARTH_RADIUS_METERS = 6371000;
const MOVES_PER_PARTITION_CAP = 8;
// How many seam-adjacent units of a partition may be considered for a move.
// Small on purpose: this is a seam adjustment, not a re-partition.
const BOUNDARY_CANDIDATES = 3;

const compareText = (left, right) => {
    const first = String(left);
    const second = String(right);
    if (first < second) return -1;
    if (first > second) return 1;
    return 0;
};

const homesIn = (group) => group.reduce((total, unit) => total + unit.doorCount, 0);
const blocksIn = (group) => group.reduce((total, unit) => total + unit.blockCount, 0);

function groupCentroid(group) {
    const doors = homesIn(group) || group.length;
    return group.reduce(
        (total, unit) => {
            const weight = (unit.doorCount || 1) / doors;
            return { lat: total.lat + unit.centroid.lat * weight, lng: total.lng + unit.centroid.lng * weight };
        },
        { lat: 0, lng: 0 }
    );
}

function metersBetween(first, second) {
    const latitude = (first.lat + second.lat) / 2 * Math.PI / 180;
    const deltaLat = (second.lat - first.lat) * Math.PI / 180;
    const deltaLng = (second.lng - first.lng) * Math.PI / 180 * Math.cos(latitude);
    return Math.sqrt(deltaLat * deltaLat + deltaLng * deltaLng) * EARTH_RADIUS_METERS;
}

/**
 * Sum of squared deviation from the mean. Every accepted move must strictly
 * reduce this, which is what makes the pass terminate: the objective is bounded
 * below and can never revisit a previous arrangement.
 */
function imbalance(groups, mean) {
    return groups.reduce((total, group) => {
        const deviation = homesIn(group) - mean;
        return total + deviation * deviation;
    }, 0);
}

function spreadOf(groups) {
    if (groups.length === 0) return 0;
    const homes = groups.map(homesIn);
    return Math.max(...homes) - Math.min(...homes);
}

/**
 * The donor units sitting on the seam toward `target`, nearest first.
 *
 * More than one is offered because the single nearest unit is often the wrong
 * SIZE: on a street grid of mixed lengths the seam street may hold 60 homes when
 * moving 10 is what balance needs. A few seam-adjacent candidates keep the move
 * local while letting the pass pick a unit that actually helps.
 */
function seamCandidates(group, target) {
    return [...group]
        .sort((first, second) => {
            const delta = metersBetween(first.centroid, target) - metersBetween(second.centroid, target);
            if (Math.abs(delta) > 1e-9) return delta;
            return compareText(first.key, second.key);
        })
        .slice(0, BOUNDARY_CANDIDATES);
}

/** The partition a unit is nearest to, excluding the one it currently sits in. */
function nearestOtherPartition(unit, centroids, ownIndex) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    centroids.forEach((centroid, index) => {
        if (index === ownIndex) return;
        const distance = metersBetween(unit.centroid, centroid);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
        }
    });
    return bestIndex;
}

/**
 * The single best legal move, or null when none improves balance.
 *
 * Every candidate is fully ordered before comparison (objective delta, then
 * unit key, then partition indices), so the chosen move never depends on
 * iteration order or on the order properties arrived in.
 */
function findBestMove(groups, budgets, mean) {
    const centroids = groups.map(groupCentroid);
    let best = null;

    groups.forEach((donor, donorIndex) => {
        // A single-unit partition cannot donate: emptying it would delete a
        // partition, and if it is an oversized atomic unit it must stay whole.
        if (donor.length < 2) return;
        const donorHomes = homesIn(donor);

        groups.forEach((receiver, receiverIndex) => {
            if (donorIndex === receiverIndex) return;

            const receiverHomes = homesIn(receiver);
            const receiverBlocks = blocksIn(receiver);

            // 3. Compactness — only seam units between these two partitions are
            // eligible, and only when this receiver is that unit's own nearest
            // neighbouring partition. Interior units never move.
            seamCandidates(donor, centroids[receiverIndex]).forEach((unit) => {
                if (nearestOtherPartition(unit, centroids, donorIndex) !== receiverIndex) return;

                // 1. Validity — the receiver must still fit both budgets.
                if (receiverHomes + unit.doorCount > budgets.maxHomes) return;
                if (receiverBlocks + unit.blockCount > budgets.maxBlocks) return;

                // 4. Balance — strict improvement only.
                const before = (donorHomes - mean) ** 2 + (receiverHomes - mean) ** 2;
                const after = (donorHomes - unit.doorCount - mean) ** 2
                    + (receiverHomes + unit.doorCount - mean) ** 2;
                const delta = after - before;
                if (delta >= 0) return;

                const candidate = { donorIndex, receiverIndex, unit, delta };
                if (
                    !best
                    || candidate.delta < best.delta
                    || (candidate.delta === best.delta && compareText(candidate.unit.key, best.unit.key) < 0)
                    || (candidate.delta === best.delta && candidate.unit.key === best.unit.key
                        && candidate.receiverIndex < best.receiverIndex)
                ) {
                    best = candidate;
                }
            });
        });
    });

    return best;
}

/**
 * Even out partition sizes without violating anything above balance.
 *
 * @param {Array<Array>} groups partitions as arrays of routing-unit descriptors
 * @param {object} budgets `{ maxHomes, maxBlocks }`
 * @returns {object} `{ groups, moves, spreadBefore, spreadAfter, limitedBy }`
 *   where `limitedBy` is `already_balanced`, `no_improving_move` or
 *   `move_cap_reached` — the reason an uneven result was accepted.
 */
export function balancePartitions(groups, budgets) {
    const spreadBefore = spreadOf(groups);
    if (groups.length < 2) {
        return { groups, moves: [], spreadBefore, spreadAfter: spreadBefore, limitedBy: 'already_balanced' };
    }

    const working = groups.map((group) => [...group]);
    const mean = homesIn(working.flat()) / working.length;
    const moveCap = working.length * MOVES_PER_PARTITION_CAP;
    const moves = [];
    let limitedBy = 'no_improving_move';

    while (moves.length < moveCap) {
        const move = findBestMove(working, budgets, mean);
        if (!move) break;
        working[move.donorIndex] = working[move.donorIndex].filter((unit) => unit.key !== move.unit.key);
        working[move.receiverIndex] = [...working[move.receiverIndex], move.unit];
        moves.push({
            unitKey: move.unit.key,
            protected: move.unit.protected,
            pocketId: move.unit.pocketId,
            homes: move.unit.doorCount,
            blocks: move.unit.blockCount,
            fromPartition: move.donorIndex,
            toPartition: move.receiverIndex
        });
    }
    if (moves.length >= moveCap) limitedBy = 'move_cap_reached';
    const spreadAfter = spreadOf(working);
    if (spreadAfter === 0) limitedBy = 'already_balanced';

    return {
        groups: working,
        moves,
        spreadBefore,
        spreadAfter,
        imbalanceBefore: Math.round(imbalance(groups, mean)),
        imbalanceAfter: Math.round(imbalance(working, mean)),
        limitedBy
    };
}