// The old sweep-slice split, demoted from algorithm to candidate.
//
// The old production splitter optimizes all N homes into one street sweep and
// cuts that order into K contiguous balanced pieces. Route 1I at K=5 is why it
// stays in the running: its accidental cut beat every road-topology partition by
// 2.1 miles. Keeping it as one competitor gives the never-worse rule — if the old
// cut is the best VALID split for a given K, the system simply ships it — without
// keeping it as the engine.
//
// HONESTY NOTE, and the one place this is not the old model exactly:
// the old splitter cuts by door index and can therefore slice through a street
// block. Cutting here is done at ATOM boundaries in sweep order, because every
// other candidate is atom-based and the whole comparison (exact-once, block
// splitting, interleaving) is defined over atoms. So this is the old model's
// one-dimensional sweep-slicing IDEA, quantized to atoms: it reproduces the cut
// the old model would make, but never mid-block. The door-exact old model is
// still measured separately by the benchmark harness, which is where the two can
// be compared without either one being flattered.

/** Atom order induced by a full-territory sweep: first appearance of each atom's doors. */
function atomSweepOrder(atoms, sequencedDoors) {
    const atomOfDoor = new Map();
    atoms.forEach((atom, atomIndex) => {
        atom.doors.forEach((door) => atomOfDoor.set(String(door?.address_hash || door?.id || ''), atomIndex));
    });

    const order = [];
    const seen = new Set();
    sequencedDoors.forEach((door) => {
        const atomIndex = atomOfDoor.get(String(door?.address_hash || door?.id || ''));
        if (atomIndex === undefined || seen.has(atomIndex)) return;
        seen.add(atomIndex);
        order.push(atomIndex);
    });
    // Any atom the sweep did not touch would silently vanish from the split, so
    // an incomplete order is rejected rather than patched.
    return order.length === atoms.length ? order : null;
}

/**
 * Cut a sweep order into exactly K contiguous atom runs inside the balance band.
 *
 * Greedy with a feasibility guard: a run closes at whichever size leaves the
 * remaining atoms able to fill every remaining route to its minimum without
 * exceeding its maximum. That guard is what stops the classic sweep failure of
 * spending all the homes early and leaving the last route with a handful.
 *
 * @param {Array} atoms atom set from `buildSplitAtoms`
 * @param {Array} sequencedDoors the frozen full-territory order
 * @param {number} routeCount K
 * @param {object} bounds from `resolveBalanceBounds`
 * @returns {object} `{ ok: true, members }` (arrays of atom indexes) or `{ ok: false, code }`
 */
export function buildLegacySweepMembership(atoms, sequencedDoors, routeCount, bounds) {
    if (!Array.isArray(sequencedDoors) || sequencedDoors.length === 0) {
        return { ok: false, code: 'LEGACY_SWEEP_ORDER_MISSING' };
    }
    const order = atomSweepOrder(atoms, sequencedDoors);
    if (!order) return { ok: false, code: 'LEGACY_SWEEP_ORDER_INCOMPLETE' };

    const doorsOf = (atomIndex) => atoms[atomIndex].doorCount;
    const suffixDoors = new Array(order.length + 1).fill(0);
    for (let index = order.length - 1; index >= 0; index -= 1) {
        suffixDoors[index] = suffixDoors[index + 1] + doorsOf(order[index]);
    }

    // Cutting is guarded by the ELIGIBILITY band, not the declared band. A sweep
    // order is fixed, so the only sizes available are sums of consecutive atoms:
    // 40 homes into 3 routes of 4-home atoms can only be 12/12/16, which no
    // declared band around 13.3 contains. Guarding on the declared band would
    // simply delete the old model from the portfolio for arithmetic reasons. The
    // cut is still scored against the declared band afterwards, like every other
    // candidate, so it earns no leniency at selection time.
    const minAllowed = Number(bounds.eligible_min_homes) || bounds.min_homes_allowed;
    const maxAllowed = Number(bounds.eligible_max_homes) || bounds.max_homes_allowed;
    const members = [];
    let cursor = 0;
    for (let route = 0; route < routeCount; route += 1) {
        const routesLeftAfter = routeCount - route - 1;
        const run = [];
        let doors = 0;
        while (cursor < order.length) {
            const remainingAfterTaking = suffixDoors[cursor + 1];
            const nextDoors = doors + doorsOf(order[cursor]);
            // Taking this atom must not overflow us, and must leave the routes
            // after us enough homes to reach their own minimum. The last route
            // takes whatever is left — it has nobody to hand homes to.
            const canTake = routesLeftAfter === 0
                || (nextDoors <= maxAllowed && remainingAfterTaking >= routesLeftAfter * minAllowed);
            if (!canTake) {
                if (run.length > 0) break;
                return { ok: false, code: 'LEGACY_SWEEP_CANNOT_SATISFY_BALANCE' };
            }
            run.push(order[cursor]);
            doors = nextDoors;
            cursor += 1;
            // Close the run at the target, unless the routes after us could not
            // hold everything that would be left — then keep taking.
            const wouldOverwhelmTheRest = suffixDoors[cursor] > routesLeftAfter * maxAllowed;
            if (routesLeftAfter > 0 && doors >= bounds.target_homes_per_route && !wouldOverwhelmTheRest) break;
        }
        if (run.length === 0) return { ok: false, code: 'LEGACY_SWEEP_PRODUCED_EMPTY_ROUTE' };
        members.push(run.sort((first, second) => first - second));
    }

    if (cursor !== order.length) return { ok: false, code: 'LEGACY_SWEEP_LEFT_ATOMS_UNASSIGNED' };
    return { ok: true, members };
}