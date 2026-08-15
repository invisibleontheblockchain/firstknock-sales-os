// Cross-window seam repair for hierarchically sequenced routes.
//
// WHY THIS IS SURGICAL AND NOT ANOTHER DECOMPOSITION
// Windows are cut geometrically because that wins on measured miles: grouping the
// same 1,000 doors by road-access instead cost 38 extra miles (417.9 vs 379.8),
// since nearest-seed groups are road-coherent but sprawling. That experiment did
// prove one thing — it cut the longest transition from 10.8 mi to 7.9 mi on the
// identical road network, so the long hop is an artefact of WHERE a window
// boundary falls, not of the geography. A boundary artefact is a local problem,
// and this repairs it locally instead of trading 38 miles for it.
//
// WHY THE DELTA IT MEASURES IS REAL MILEAGE, NOT A SURROGATE
// A seam repair re-solves a contiguous run of doors that straddles one boundary,
// with the door BEFORE the run and the door AFTER it pinned as anchors. The door
// set is unchanged and both ends stay attached to the same neighbours, so every
// leg outside the run is untouched and the change in total route distance is
// exactly the change in this run — measured on that run's own exact door-to-door
// road matrix. There is no internal score standing in for miles.
//
// COST
// One run is bounded to fit a single OSRM matrix chunk, so one seam costs one
// matrix request. A 15-window route pays 14 requests on top of ~66.

import { isValidPoint } from './routeContinuityOptimizer.js';
import { roadAwareStreetSweep } from './roadAwareStreetSweep.js';
import { createMatrixMetricFns, fetchRoadMatrix } from './roadMatrix.js';
import { MATRIX_CHUNK_SIZE } from './roadMatrix.js';

// Doors taken from each side of a boundary. 22 + 22 + 2 anchors stays inside one
// 46-coordinate matrix chunk, which is what keeps a seam repair one request.
// Neighbourhood widths, applied as successive passes. MEASURED on the 1,000-door
// Charlotte route, each width alone against the 379.754-mile baseline:
//   22 doors/side -> 365.709 mi, longest hop 10.763 mi (14/14 seams improved)
//   44 doors/side -> 369.053 mi, longest hop  5.559 mi (3/14 seams improved)
// The narrow pass harvests more total miles; the wide pass is the only one that
// reaches the long transition, because the doors that make it repairable sit more
// than 22 doors from the boundary. Neither width dominates, so both run, narrow
// first — every move in either pass must shorten the run it touches, so passes
// compound instead of trading against each other.
export const DEFAULT_SEAM_PASSES = [22, 44];
export const DEFAULT_SEAM_DOORS_PER_SIDE = DEFAULT_SEAM_PASSES[0];

/** Multiset of coordinate keys, so a candidate can be proven a permutation. */
function keyCounts(points) {
    const counts = new Map();
    points.forEach((point) => {
        const key = `${Number(point?.lat).toFixed(6)},${Number(point?.lng).toFixed(6)}`;
        counts.set(key, (counts.get(key) || 0) + 1);
    });
    return counts;
}

/**
 * A candidate may only reorder the run it was given. Exact-once membership for the
 * whole route is what this protects: a sweep that dropped or duplicated a door
 * would otherwise silently change the route's door count.
 */
function isPermutationOf(candidate, original) {
    if (candidate.length !== original.length) return false;
    const wanted = keyCounts(original);
    const got = keyCounts(candidate);
    if (wanted.size !== got.size) return false;
    for (const [key, count] of wanted) {
        if (got.get(key) !== count) return false;
    }
    return true;
}

/** Road cost of a run, including its legs to the pinned anchors. */
function runCost(run, anchorIn, anchorOut, cost) {
    let total = 0;
    if (isValidPoint(anchorIn)) {
        const leg = cost(anchorIn, run[0]);
        if (!Number.isFinite(leg)) return null;
        total += leg;
    }
    for (let index = 0; index < run.length - 1; index += 1) {
        const leg = cost(run[index], run[index + 1]);
        if (!Number.isFinite(leg)) return null;
        total += leg;
    }
    if (isValidPoint(anchorOut)) {
        const leg = cost(run[run.length - 1], anchorOut);
        if (!Number.isFinite(leg)) return null;
        total += leg;
    }
    return total;
}

/** Unique matrix coordinates for one run: its doors plus its two anchors. */
function runMatrixPoints(run, anchorIn, anchorOut) {
    const points = [];
    const seen = new Set();
    [...run, anchorIn, anchorOut].forEach((point) => {
        if (!isValidPoint(point)) return;
        const key = `${Number(point.lat).toFixed(6)},${Number(point.lng).toFixed(6)}`;
        if (seen.has(key)) return;
        seen.add(key);
        points.push(point);
    });
    return points;
}

/**
 * Re-solve the door run straddling ONE boundary, on that run's own exact road
 * matrix, with the doors immediately before and after the run pinned.
 *
 * Returns the improved full order, or null when the seam was skipped or the
 * re-solve did not shorten the run. Counters are recorded on `telemetry`.
 */
async function repairSeam(working, boundary, perSide, telemetry, options) {
    const {
        startLocation, endLocation, fetchMatrix, baseUrl, profile, timeoutMs, refinementStepBudget
    } = options;

    if (!Number.isFinite(boundary) || boundary <= 0 || boundary >= working.length) return null;
    const start = Math.max(0, boundary - perSide);
    const end = Math.min(working.length - 1, boundary + perSide - 1);
    const run = working.slice(start, end + 1);
    if (run.length < 4) return null;

    // Pinned neighbours. Both ends of the run stay attached to exactly the door
    // they are attached to now, which is what makes the local delta equal the
    // route-wide delta.
    const anchorIn = start > 0 ? working[start - 1] : startLocation;
    const anchorOut = end < working.length - 1 ? working[end + 1] : endLocation;

    telemetry.seams_examined += 1;
    const points = runMatrixPoints(run, anchorIn, anchorOut);
    let cost = null;
    try {
        const matrix = await fetchMatrix(points, { baseUrl, profile, timeoutMs });
        telemetry.seam_matrix_requests += 1;
        telemetry.seam_road_pairs_requested += points.length * points.length;
        cost = createMatrixMetricFns(points, matrix).distanceBetween;
    } catch {
        telemetry.seams_skipped_unresolved += 1;
        return null;
    }
    if (!cost) {
        telemetry.seams_skipped_unresolved += 1;
        return null;
    }

    const currentCost = runCost(run, anchorIn, anchorOut, cost);
    if (currentCost === null) {
        telemetry.seams_skipped_unresolved += 1;
        return null;
    }

    // The sweep rebuilds street blocks from these doors, so block atomicity and
    // orientation are decided inside the repair on the same road matrix — this one
    // move therefore covers relocation, swaps, orientation changes and cross-seam
    // 2-opt/Or-opt without six separate operators to keep honest.
    let candidate;
    try {
        candidate = roadAwareStreetSweep(run, {
            distanceBetween: cost,
            startLocation: isValidPoint(anchorIn) ? anchorIn : null,
            endLocation: isValidPoint(anchorOut) ? anchorOut : null,
            refinementStepBudget
        });
    } catch {
        telemetry.seams_skipped_unresolved += 1;
        return null;
    }
    if (!Array.isArray(candidate) || !isPermutationOf(candidate, run)) {
        telemetry.seams_skipped_unresolved += 1;
        return null;
    }

    const candidateCost = runCost(candidate, anchorIn, anchorOut, cost);
    if (candidateCost === null) {
        telemetry.seams_skipped_unresolved += 1;
        return null;
    }
    // Never-worse, per seam: a repair that does not shorten the run is dropped, so
    // a route can only leave this pass shorter than it arrived.
    if (candidateCost + 1e-6 >= currentCost) {
        telemetry.seams_rejected_no_gain += 1;
        return null;
    }

    telemetry.seams_improved += 1;
    telemetry.seam_miles_saved += currentCost - candidateCost;
    return [...working.slice(0, start), ...candidate, ...working.slice(end + 1)];
}

/**
 * Repair each window boundary of an already road-sequenced door order.
 *
 * @param {Array} order the full door order produced by the hierarchy
 * @param {Array<number>} boundaries indexes in `order` where a new window begins
 * @param {object} options `{ startLocation, endLocation, fetchMatrix, baseUrl,
 *   profile, timeoutMs, doorsPerSide, refinementStepBudget }`
 * @returns {Promise<object>} `{ order, telemetry }`. The returned order is always
 *   a permutation of the input; a seam whose matrix cannot be resolved is SKIPPED
 *   and counted, never repaired on a guessed distance.
 */
export async function refineWindowSeams(order, boundaries, options = {}) {
    const {
        startLocation = null,
        endLocation = null,
        fetchMatrix = fetchRoadMatrix,
        baseUrl,
        profile = 'driving',
        timeoutMs = 20000,
        doorsPerSide = DEFAULT_SEAM_PASSES,
        refinementStepBudget = 200_000
    } = options;

    const telemetry = {
        seams_examined: 0,
        seams_improved: 0,
        seams_skipped_unresolved: 0,
        seams_rejected_no_gain: 0,
        seam_matrix_requests: 0,
        seam_road_pairs_requested: 0,
        seam_miles_saved: 0
    };

    let working = [...order];
    const passes = (Array.isArray(doorsPerSide) ? doorsPerSide : [doorsPerSide])
        .map((width) => Math.max(2, Math.min(Number(width) || DEFAULT_SEAM_DOORS_PER_SIDE, MATRIX_CHUNK_SIZE * 2 - 2)))
        .filter((width, index, all) => all.indexOf(width) === index);
    telemetry.seam_passes = passes.join(',');

    for (const perSide of passes) {
        for (const boundary of boundaries) {
            const repaired = await repairSeam(working, boundary, perSide, telemetry, {
                startLocation, endLocation, fetchMatrix, baseUrl, profile, timeoutMs, refinementStepBudget
            });
            if (repaired) working = repaired;
        }
    }

    telemetry.seam_miles_saved = Math.round(telemetry.seam_miles_saved * 1000) / 1000;
    return { order: working, telemetry };
}