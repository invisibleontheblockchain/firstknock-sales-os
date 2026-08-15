// Deterministic merge pass over an already-valid partition set.
//
// Why this exists: `partitionUnits` cuts by recursive bisection, which always
// halves. A territory needing two routes can therefore come back as three
// lopsided parts (2 / 4 / 2 doors against a 4-door budget) — every part valid,
// but more routes than the budget actually requires, and more routes means more
// road-matrix requests and more rep commutes for the same doors.
//
// This pass only ever COMBINES parts, so it cannot split a routing unit, cannot
// break a pocket, and cannot invalidate a partition: a merge is considered only
// when the combined homes AND blocks both stay inside budget. It is the mirror
// image of `territoryBalance.js`, which evens sizes without changing the count.
//
// Precedence matches the partitioner: validity first (budgets), then topology
// (whole units only), then compactness (nearest partition wins), and size is
// used only to decide which partition looks for a partner first.

const compareText = (left, right) => {
    const first = String(left);
    const second = String(right);
    if (first < second) return -1;
    if (first > second) return 1;
    return 0;
};

const doorsIn = (group) => group.reduce((total, unit) => total + unit.doorCount, 0);
const blocksIn = (group) => group.reduce((total, unit) => total + unit.blockCount, 0);

/** Stable identity for a group, used for deterministic tie-breaking. */
const signatureOf = (group) => group.map((unit) => unit.key).sort(compareText).join(',');

/** Door-weighted centroid, so a large unit pulls the centre more than a stub. */
function centroidOf(group) {
    const doors = doorsIn(group) || group.length;
    return group.reduce(
        (total, unit) => {
            const weight = (unit.doorCount || 1) / doors;
            return {
                lat: total.lat + unit.centroid.lat * weight,
                lng: total.lng + unit.centroid.lng * weight
            };
        },
        { lat: 0, lng: 0 }
    );
}

/** Squared planar distance with longitude scaled by cos(latitude). */
function distanceSquared(first, second) {
    const scale = Math.cos((first.lat + second.lat) / 2 * Math.PI / 180);
    const x = (second.lng - first.lng) * scale;
    const y = second.lat - first.lat;
    return x * x + y * y;
}

function fits(group, other, budgets) {
    return doorsIn(group) + doorsIn(other) <= budgets.maxHomes
        && blocksIn(group) + blocksIn(other) <= budgets.maxBlocks;
}

/**
 * Merge adjacent partitions while both budgets still hold.
 *
 * @param {Array<Array>} groups partitions as unit arrays, already valid
 * @param {object} budgets `{ maxHomes, maxBlocks }`
 * @returns {object} `{ groups, merges }` where each merge records the combined
 *   signatures and the resulting size, so a reviewer can see why the route
 *   count is what it is.
 */
export function mergePartitions(groups, budgets) {
    let current = groups.map((group) => [...group]);
    const merges = [];

    // Every accepted merge removes one partition, so this terminates in at most
    // groups.length - 1 rounds without needing an arbitrary cap.
    while (current.length > 1) {
        const order = current
            .map((group, index) => ({ index, doors: doorsIn(group), signature: signatureOf(group) }))
            .sort((first, second) => (
                first.doors - second.doors || compareText(first.signature, second.signature)
            ));

        let applied = false;
        for (const entry of order) {
            const group = current[entry.index];
            const origin = centroidOf(group);
            let bestIndex = -1;
            let bestDistance = Infinity;
            let bestSignature = '';

            current.forEach((candidate, index) => {
                if (index === entry.index) return;
                if (!fits(group, candidate, budgets)) return;
                const distance = distanceSquared(origin, centroidOf(candidate));
                const candidateSignature = signatureOf(candidate);
                if (
                    distance + 1e-15 < bestDistance
                    || (
                        Math.abs(distance - bestDistance) <= 1e-15
                        && compareText(candidateSignature, bestSignature) < 0
                    )
                ) {
                    bestDistance = distance;
                    bestIndex = index;
                    bestSignature = candidateSignature;
                }
            });

            if (bestIndex === -1) continue;

            const merged = [...group, ...current[bestIndex]];
            merges.push({
                from: entry.signature,
                into: bestSignature,
                doorCount: doorsIn(merged),
                blockCount: blocksIn(merged)
            });
            current = current
                .filter((_, index) => index !== entry.index && index !== bestIndex)
                .concat([merged]);
            applied = true;
            break;
        }

        if (!applied) break;
    }

    return { groups: current, merges };
}