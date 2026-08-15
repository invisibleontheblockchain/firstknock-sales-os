// Compactness-constrained, barrier-aware repair of geometric work windows.
//
// THE DEFECT THIS EXISTS TO REMOVE
// A compact geometric window is usually the right grouping — Route 1J proved that
// replacing it wholesale with road-coherent grouping sprawls (417.9 and 386.0 mi
// against 358.3). But a lat/lng box drawn across a lake, river, rail line or
// limited-access highway contains doors that are aerial-near and road-far, and
// once both sides are members of the same window no amount of road-aware solving
// inside it can undo the crossing (Route 1I window 0: Ventana Ct and Quaker Rd,
// 2.202 mi apart in the air, 11.927 mi to drive).
//
// THE RULE THIS ENFORCES
// Keep the compact grouping wherever the road network agrees with it, and
// intervene ONLY where road evidence shows a window contains strongly
// road-disconnected pieces. This is a repair, not a regrouping: the geometric
// body of the decomposition — the thing that made the baseline good — survives.
//
//   for each window: price every block pair on a real road matrix
//     -> split into road-access components (excess = road - aerial, in absolute
//        miles; ratios mislead on short blocks and were already rejected)
//     -> keep the largest component where it is
//     -> move each minority component's COMPLETE street blocks to the
//        road-nearest window that is itself road-coherent with the component
//        and has door capacity; if none qualifies, the component becomes its
//        own window (it is internally coherent by construction)
//     -> re-check only the windows that received blocks, bounded passes
//
// Every decision here is priced on the road network. An unresolvable road cost
// fails the repair — the caller discards the candidate rather than shipping a
// membership that was guessed. Nothing is tuned to a city or fixture.

import { fetchRoadMatrix, createMatrixMetricFns, MAX_ROUTE_MATRIX_POINTS } from './roadMatrix.js';
import { coordinateKey, compareKeys, selectRepresentative } from './roadAwareGrouping.js';
import { haversineMiles } from './routeContinuityOptimizer.js';

export const BARRIER_REPAIR_VERSION = 'barrier_window_repair_v1';

// A block pair is road-disconnected when driving between them costs this many
// miles MORE than the straight line. Absolute excess, not a ratio: suburban
// same-side pairs measure well under this (road ~= aerial * 1.2..1.5 over short
// spans), while a genuine barrier detour measures several miles of pure excess
// (Route 1I: 9.7). The two populations are far apart, which is what makes a
// single threshold usable.
export const DEFAULT_BARRIER_EXCESS_MILES = 3;

// Moving a component can, in principle, make its destination straddle; receiving
// windows are re-checked. Bounded so a pathological geography terminates instead
// of ping-ponging blocks between two windows forever.
const MAX_REPAIR_PASSES = 3;

const doorsOf = (entries) => entries.reduce((total, entry) => total + entry.block.doors.length, 0);

/**
 * Split one window's blocks into road-access components.
 *
 * Two blocks are connected when the cheaper driving direction between their
 * representatives exceeds the straight line by less than `excessMiles`. Union of
 * those edges partitions the window; a coherent window comes back as ONE
 * component. Components are returned largest-doors-first with deterministic
 * tie-breaks, so "which side stays" never depends on input order.
 */
export function splitWindowByRoadAccess(entries, distanceBetween, excessMiles) {
    const parent = entries.map((_, index) => index);
    const find = (index) => (parent[index] === index ? index : (parent[index] = find(parent[index])));

    for (let first = 0; first < entries.length; first += 1) {
        for (let second = first + 1; second < entries.length; second += 1) {
            const from = entries[first].representative;
            const to = entries[second].representative;
            const out = distanceBetween(from, to);
            const back = distanceBetween(to, from);
            if (!Number.isFinite(out) || !Number.isFinite(back)) {
                throw new Error('Road cost unresolved while measuring window coherence.');
            }
            if (Math.min(out, back) - haversineMiles(from, to) <= excessMiles) {
                parent[find(first)] = find(second);
            }
        }
    }

    const byRoot = new Map();
    entries.forEach((entry, index) => {
        const root = find(index);
        if (!byRoot.has(root)) byRoot.set(root, []);
        byRoot.get(root).push(entry);
    });
    return [...byRoot.values()]
        .map((list) => ({
            entries: list,
            doorCount: doorsOf(list),
            representative: selectRepresentative(list.map((entry) => entry.representative))
        }))
        .sort((first, second) => (
            second.doorCount - first.doorCount
            || second.entries.length - first.entries.length
            || compareKeys(coordinateKey(first.representative), coordinateKey(second.representative))
        ));
}

/**
 * Move one stranded component into the best destination window, priced on roads.
 *
 * A destination qualifies only when it is itself road-coherent with the component
 * (same excess test — moving across the same barrier into a different window
 * repairs nothing) and has door capacity for the component's blocks. Among
 * qualifiers the road-nearest wins, which is what preserves compactness: the
 * nearest coherent window is the component's own side of the barrier.
 *
 * Returns true when placed; false means no window qualifies and the caller
 * should let the component stand alone.
 */
async function placeComponent(component, destinationWindows, {
    maxDoors,
    excessMiles,
    fetchMatrix,
    matrixOptions,
    accountMatrix
}) {
    if (destinationWindows.length === 0) return false;

    const destinationReps = destinationWindows.map((window) => (
        selectRepresentative(window.entries.map((entry) => entry.representative))
    ));
    const points = [component.representative, ...destinationReps];
    const matrix = await fetchMatrix(points, matrixOptions);
    accountMatrix(points.length);
    const { distanceBetween } = createMatrixMetricFns(points, matrix);

    const qualifiers = destinationWindows
        .map((window, index) => {
            const rep = destinationReps[index];
            const out = distanceBetween(component.representative, rep);
            const back = distanceBetween(rep, component.representative);
            if (!Number.isFinite(out) || !Number.isFinite(back)) {
                throw new Error('Road cost unresolved while placing a stranded component.');
            }
            return { window, rep, road: Math.min(out, back), aerial: haversineMiles(component.representative, rep) };
        })
        .filter((candidate) => candidate.road - candidate.aerial <= excessMiles)
        .filter((candidate) => doorsOf(candidate.window.entries) + component.doorCount <= maxDoors)
        .sort((first, second) => (
            Math.abs(first.road - second.road) > 1e-9
                ? first.road - second.road
                : compareKeys(coordinateKey(first.rep), coordinateKey(second.rep))
        ));

    if (qualifiers.length === 0) return false;
    qualifiers[0].window.entries.push(...component.entries);
    qualifiers[0].window.dirty = true;
    return true;
}

/**
 * Repair barrier-straddling windows in a geometric decomposition.
 *
 * @param {Array} windows `{ entries, doorCount, representative }` groups from the
 *   geometric partitioner. Never mutated.
 * @param {object} options `{ excessMiles, maxDoors, maxWindows, fetchMatrix,
 *   baseUrl, profile, timeoutMs }`. `maxDoors` is the exact-matrix door ceiling a
 *   receiving window must stay under; `fetchMatrix` is injectable so the repair
 *   can be exercised against a recorded road network in tests.
 * @returns {Promise<object>} `{ ok: true, windows, telemetry }` with every input
 *   block present exactly once, or `{ ok: false, code }` when a road cost the
 *   repair needs cannot be resolved — the caller must discard the candidate, not
 *   fall back to a guess.
 */
export async function repairBarrierWindows(windows, options = {}) {
    const {
        excessMiles = DEFAULT_BARRIER_EXCESS_MILES,
        maxDoors,
        maxWindows = MAX_ROUTE_MATRIX_POINTS,
        fetchMatrix = fetchRoadMatrix,
        baseUrl,
        profile = 'driving',
        timeoutMs = 20000
    } = options;
    if (!Number.isFinite(maxDoors) || maxDoors < 2) {
        return { ok: false, code: 'BARRIER_REPAIR_INVALID_DOOR_CEILING' };
    }
    const matrixOptions = { baseUrl, profile, timeoutMs };

    const working = windows.map((window) => ({ entries: [...window.entries], dirty: true }));
    const telemetry = {
        barrier_repair_version: BARRIER_REPAIR_VERSION,
        barrier_excess_miles: excessMiles,
        barrier_windows_checked: 0,
        barrier_straddling_windows: 0,
        barrier_components_moved: 0,
        barrier_blocks_moved: 0,
        barrier_doors_moved: 0,
        barrier_new_windows: 0,
        barrier_repair_passes: 0,
        repair_matrix_requests: 0,
        repair_road_pairs: 0
    };
    const accountMatrix = (pointCount) => {
        telemetry.repair_matrix_requests += 1;
        telemetry.repair_road_pairs += pointCount * pointCount;
    };

    try {
        for (let pass = 0; pass < MAX_REPAIR_PASSES; pass += 1) {
            let movedThisPass = false;
            // Detect AND repair one window at a time. Snapshotting every window's
            // components first and repairing afterwards loses blocks: a window that
            // receives a component early in the pass and then repairs itself from a
            // stale snapshot silently drops what it just received. Immediate repair
            // means every detection reads the entries as they are RIGHT NOW.
            // `working` may grow during iteration; new windows are pushed clean
            // (dirty: false) so the loop never re-processes them in-flight.
            for (const window of working) {
                if (!window.dirty) continue;
                window.dirty = false;
                if (window.entries.length < 2) continue;
                telemetry.barrier_windows_checked += 1;
                const points = window.entries.map((entry) => entry.representative);
                const matrix = await fetchMatrix(points, matrixOptions);
                accountMatrix(points.length);
                const { distanceBetween } = createMatrixMetricFns(points, matrix);
                const components = splitWindowByRoadAccess(window.entries, distanceBetween, excessMiles);
                if (components.length < 2) continue;

                telemetry.barrier_straddling_windows += 1;
                movedThisPass = true;
                // The largest component IS the window now; it is coherent by
                // construction, so the source needs no re-check.
                window.entries = components[0].entries;
                for (const component of components.slice(1)) {
                    const destinations = working.filter((candidate) => (
                        candidate !== window && candidate.entries.length > 0
                    ));
                    const placed = await placeComponent(component, destinations, {
                        maxDoors,
                        excessMiles,
                        fetchMatrix,
                        matrixOptions,
                        accountMatrix
                    });
                    if (!placed) {
                        working.push({ entries: [...component.entries], dirty: false });
                        telemetry.barrier_new_windows += 1;
                    }
                    telemetry.barrier_components_moved += 1;
                    telemetry.barrier_blocks_moved += component.entries.length;
                    telemetry.barrier_doors_moved += component.doorCount;
                }
            }
            if (!movedThisPass) break;
            telemetry.barrier_repair_passes = pass + 1;
            if (working.filter((window) => window.entries.length > 0).length > maxWindows) {
                return { ok: false, code: 'BARRIER_REPAIR_WINDOW_OVERFLOW' };
            }
        }
    } catch (error) {
        return { ok: false, code: 'BARRIER_REPAIR_ROAD_COST_UNAVAILABLE', reason: error.message };
    }

    return {
        ok: true,
        windows: working
            .filter((window) => window.entries.length > 0)
            .map((window) => ({
                // Canonical order inside the window; the window's own exact door
                // matrix decides the real sequence later.
                entries: [...window.entries].sort((first, second) => (
                    compareKeys(coordinateKey(first.representative), coordinateKey(second.representative))
                )),
                doorCount: doorsOf(window.entries),
                representative: selectRepresentative(window.entries.map((entry) => entry.representative))
            })),
        telemetry
    };
}