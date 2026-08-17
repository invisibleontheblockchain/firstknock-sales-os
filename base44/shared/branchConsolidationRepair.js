// Level 5: enter a single-entry branch once, serve it, leave.
//
// THE RULE
//
//   single-entry branch -> enter once -> reach the deepest useful point ->
//   service continuously toward the exit -> never re-enter.
//
// This is the one rule a distance objective cannot express. Re-entering a
// peninsula is not merely expensive, it is wrong: the rep pays the entrance
// twice for nothing. But a shortest-path search will happily do it whenever the
// arithmetic works out, and across 999 legs it works out often. On Route 1H,
// after the pipeline fix took the route from 627.6 to 394.1 measured road miles,
// 53% of its branches were still entered more than once.
//
// HOW THIS STAYS SAFE
//
// It is a repair, not a constraint on the search. Each branch is consolidated
// into one contiguous visit, the whole route is re-measured on the road network,
// and the change is kept ONLY when it measures shorter. A repair that cannot be
// measured is discarded. So this layer can cost solver time and can decline to
// help, but it cannot lengthen a route.
//
// That is deliberately the weaker of the two designs. Making re-entry illegal
// inside the search is the stronger rule and the right end state, but it changes
// window decomposition and door sequencing at once, on a solver whose behaviour
// is frozen against benchmarks. This lands the behaviour first, with measurement
// proving every change, and leaves the search-space constraint to follow on that
// evidence.

import { roadAwareStreetSweep } from './roadAwareStreetSweep.js';
import { createMatrixMetricFns, fetchRoadMatrix, MAX_ROUTE_MATRIX_POINTS } from './roadMatrix.js';
import {
    buildRoadAdjacency,
    countEntries,
    DEFAULT_ADJACENCY_MILES,
    DEFAULT_MIN_BRANCH_DOORS,
    findSingleEntryBranches,
    scoreBranch
} from './branchTopology.js';
import { isValidPoint } from './routeContinuityOptimizer.js';

/** Branches repaired per pass, highest priority first. Bounds the matrix bill. */
export const DEFAULT_MAX_BRANCH_REPAIRS = 12;

const identityOf = (door) => String(door?.address_hash || door?.id || '');

/** Contiguous runs of a door set within an order, as [start, end] index pairs. */
function runsOf(order, memberSet) {
    const runs = [];
    let start = -1;
    for (let index = 0; index < order.length; index += 1) {
        const inside = memberSet.has(identityOf(order[index]));
        if (inside && start === -1) start = index;
        if (!inside && start !== -1) { runs.push([start, index - 1]); start = -1; }
    }
    if (start !== -1) runs.push([start, order.length - 1]);
    return runs;
}

/**
 * Rebuild one branch as a single visit, spliced where its largest run already sits.
 *
 * The anchor is the largest existing run rather than the first: the solver put
 * most of the branch somewhere sensible relative to the rest of the route, and
 * moving the majority to meet a stray two-door visit is how a repair turns into
 * a regression.
 */
function consolidateBranch(order, memberSet) {
    const runs = runsOf(order, memberSet);
    if (runs.length < 2) return null;

    let anchor = runs[0];
    let anchorLength = anchor[1] - anchor[0];
    runs.forEach((run) => {
        const length = run[1] - run[0];
        if (length > anchorLength) { anchor = run; anchorLength = length; }
    });

    const branchDoors = [];
    const rest = [];
    let insertAt = -1;
    order.forEach((door, index) => {
        if (memberSet.has(identityOf(door))) {
            branchDoors.push(door);
            if (index === anchor[0]) insertAt = rest.length;
            return;
        }
        rest.push(door);
    });
    if (insertAt === -1) insertAt = Math.min(anchor[0], rest.length);
    return { branchDoors, rest, insertAt };
}

/**
 * Re-solve a branch's internal order for a single in-and-out visit.
 *
 * Entry and exit ports are the doors the rep actually arrives from and leaves
 * toward, so the branch is solved as a leg of a longer drive rather than as an
 * island. With both ports outside the branch and only one way in, the sweep's
 * cheapest answer runs to the far end and works back — the farthest-first
 * traversal, arrived at by measurement instead of asserted.
 */
async function sequenceBranchVisit(branchDoors, entryPort, exitPort, options) {
    const { fetchMatrix, baseUrl, profile, timeoutMs, refinementStepBudget } = options;
    const points = [];
    const seen = new Set();
    [...branchDoors, entryPort, exitPort].forEach((point) => {
        if (!isValidPoint(point)) return;
        const key = `${Number(point.lat).toFixed(6)},${Number(point.lng).toFixed(6)}`;
        if (seen.has(key)) return;
        seen.add(key);
        points.push(point);
    });
    if (points.length > MAX_ROUTE_MATRIX_POINTS) return null;

    const matrix = await fetchMatrix(points, { baseUrl, profile, timeoutMs });
    const { distanceBetween } = createMatrixMetricFns(points, matrix);
    return roadAwareStreetSweep(branchDoors, {
        distanceBetween,
        startLocation: isValidPoint(entryPort) ? entryPort : null,
        endLocation: isValidPoint(exitPort) ? exitPort : null,
        refinementStepBudget
    });
}

/**
 * Consolidate re-entered single-entry branches, keeping only measured wins.
 *
 * @param {Array} order the finished door order
 * @param {object} options `{ startLocation, endLocation, measurePath, fetchMatrix,
 *   baseUrl, profile, timeoutMs, refinementStepBudget, adjacencyMiles,
 *   minBranchDoors, maxRepairs }`. `measurePath` is required — without a way to
 *   measure, there is no way to prove a repair helped, and an unproven repair is
 *   not applied.
 * @returns {Promise<{order: Array, telemetry: object}>} always returns a usable
 *   order; on any failure that is the input order, unchanged.
 */
export async function repairBranchReentries(order, options = {}) {
    const {
        startLocation = null,
        endLocation = null,
        measurePath = null,
        fetchMatrix = fetchRoadMatrix,
        baseUrl,
        profile = 'driving',
        timeoutMs = 20000,
        refinementStepBudget = 200_000,
        adjacencyMiles = DEFAULT_ADJACENCY_MILES,
        minBranchDoors = DEFAULT_MIN_BRANCH_DOORS,
        maxRepairs = DEFAULT_MAX_BRANCH_REPAIRS,
        // Apply a consolidation even when it measures longer. See the rejection
        // branch below: this buys route SHAPE at a measured mileage price.
        enforceRule = false
    } = options;

    const telemetry = {
        branch_repair_ran: false,
        branch_adjacency_miles: adjacencyMiles,
        branch_adjacency_requests: 0,
        branch_adjacency_failed_tiles: 0,
        branches_found: 0,
        branch_doors_total: 0,
        branches_reentered_before: 0,
        branch_extra_entries_before: 0,
        branches_repaired: 0,
        branches_rejected_no_gain: 0,
        branches_enforced: 0,
        branch_miles_conceded: 0,
        branches_rejected_unmeasured: 0,
        branches_reentered_after: 0,
        branch_extra_entries_after: 0,
        branch_repair_matrix_requests: 0,
        branch_miles_saved: 0
    };

    if (!Array.isArray(order) || order.length < 4) return { order, telemetry };
    if (typeof measurePath !== 'function') return { order, telemetry };

    let adjacency;
    try {
        const built = await buildRoadAdjacency(order, {
            thresholdMiles: adjacencyMiles, fetchMatrix, baseUrl, profile, timeoutMs
        });
        adjacency = built.adjacency;
        telemetry.branch_adjacency_requests = built.requestCount;
        telemetry.branch_adjacency_failed_tiles = built.failedTiles;
    } catch {
        // No topology means no repair. The route is returned exactly as given.
        return { order, telemetry };
    }

    // The graph is indexed by position in `order`; branches must be identified by
    // door, because the order is about to change underneath them.
    const branches = findSingleEntryBranches(adjacency, { minDoors: minBranchDoors })
        .map((branch) => ({
            ...branch,
            doorIds: new Set(branch.members.map((index) => identityOf(order[index])))
        }))
        .filter((branch) => branch.doorIds.size === branch.size);

    telemetry.branches_found = branches.length;
    telemetry.branch_doors_total = branches.reduce((total, branch) => total + branch.size, 0);
    if (branches.length === 0) return { order, telemetry };

    const violated = branches
        .map((branch) => ({ branch, entries: countEntries(order, branch.doorIds, identityOf) }))
        .filter((entry) => entry.entries > 1);
    telemetry.branches_reentered_before = violated.length;
    telemetry.branch_extra_entries_before = violated.reduce((total, entry) => total + entry.entries - 1, 0);
    if (violated.length === 0) return { order, telemetry };

    const baseline = await measurePath(
        [...(isValidPoint(startLocation) ? [startLocation] : []), ...order,
            ...(isValidPoint(endLocation) ? [endLocation] : [])],
        { baseUrl, profile, timeoutMs }
    );
    if (!baseline?.ok || !Number.isFinite(baseline.totalMiles)) return { order, telemetry };

    telemetry.branch_repair_ran = true;
    // Worst first: doors times depth is what a wrong answer actually costs.
    violated.sort((first, second) => (scoreBranch(second.branch) - scoreBranch(first.branch))
        || (second.entries - first.entries));

    let current = order;
    let currentMiles = baseline.totalMiles;

    for (const { branch } of violated.slice(0, maxRepairs)) {
        // Re-check against the CURRENT order: an earlier repair may already have
        // consolidated this branch as a side effect.
        if (countEntries(current, branch.doorIds, identityOf) < 2) continue;
        const consolidated = consolidateBranch(current, branch.doorIds);
        if (!consolidated) continue;
        const { branchDoors, rest, insertAt } = consolidated;

        const entryPort = insertAt > 0 ? rest[insertAt - 1] : startLocation;
        const exitPort = insertAt < rest.length ? rest[insertAt] : endLocation;

        let sequenced = null;
        try {
            sequenced = await sequenceBranchVisit(branchDoors, entryPort, exitPort, {
                fetchMatrix, baseUrl, profile, timeoutMs, refinementStepBudget
            });
            if (sequenced) telemetry.branch_repair_matrix_requests += 1;
        } catch {
            sequenced = null;
        }
        // A branch too large for one matrix still gets consolidated; it simply
        // keeps the order the solver already gave it rather than being re-solved.
        const visit = sequenced && sequenced.length === branchDoors.length ? sequenced : branchDoors;

        const candidate = [...rest.slice(0, insertAt), ...visit, ...rest.slice(insertAt)];
        if (candidate.length !== current.length) continue;

        const measured = await measurePath(
            [...(isValidPoint(startLocation) ? [startLocation] : []), ...candidate,
                ...(isValidPoint(endLocation) ? [endLocation] : [])],
            { baseUrl, profile, timeoutMs }
        );
        if (!measured?.ok || !Number.isFinite(measured.totalMiles)) {
            telemetry.branches_rejected_unmeasured += 1;
            continue;
        }
        if (measured.totalMiles + 1e-9 >= currentMiles) {
            // Consolidating this branch costs more than the re-entry does.
            //
            // This is common, not exceptional: on Route 1H nine of twelve
            // attempted repairs measured LONGER. A big branch whose gate the
            // route passes twice anyway is genuinely cheaper to split, and no
            // amount of wanting the rule changes that arithmetic.
            //
            // `enforceRule` is therefore a deliberate product choice, not a
            // tuning knob: apply the consolidation anyway and pay the miles,
            // because a route a rep refuses to drive is worth less than a
            // slightly longer one they will. Default is off — the mileage gate
            // stands unless someone decides otherwise with the number in hand.
            telemetry.branches_rejected_no_gain += 1;
            telemetry.branch_miles_conceded += Math.round((measured.totalMiles - currentMiles) * 1000) / 1000;
            if (!enforceRule) continue;
            telemetry.branches_enforced += 1;
        }
        current = candidate;
        currentMiles = measured.totalMiles;
        telemetry.branches_repaired += 1;
    }

    const after = branches
        .map((branch) => countEntries(current, branch.doorIds, identityOf))
        .filter((entries) => entries > 1);
    telemetry.branches_reentered_after = after.length;
    telemetry.branch_extra_entries_after = after.reduce((total, entries) => total + entries - 1, 0);
    telemetry.branch_miles_saved = Math.round((baseline.totalMiles - currentMiles) * 1000) / 1000;

    return { order: current, telemetry };
}
