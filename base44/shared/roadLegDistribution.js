// What the whole route's transitions look like, not just its worst one.
//
// The longest leg is a single geography event: one unavoidable highway hop can
// own it while every other transition is clean, and one repairable boundary can
// own it while the route is otherwise ugly everywhere. Neither case is visible
// from a maximum. The percentiles and threshold counts below are what tell a
// manager whether the route as a whole reads as continuous work.
//
// These are computed from ALREADY-MEASURED per-leg road miles — OSRM /route
// output on the final order — so they are a description of the drive, never of
// the optimizer's internal opinion of it. Nothing here decides anything.

/** Nearest-rank percentile over an ascending copy. */
function percentile(sortedAscending, fraction) {
    if (sortedAscending.length === 0) return null;
    const rank = Math.ceil(fraction * sortedAscending.length);
    return sortedAscending[Math.min(sortedAscending.length - 1, Math.max(0, rank - 1))];
}

const round = (value) => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null);

/**
 * Summarize measured leg distances.
 *
 * @param {Array<number>} legMiles per-leg road miles, in route order
 * @returns {object|null} percentiles, threshold counts, and the mileage carried by
 *   the ten longest transitions — or null when there are no legs to describe.
 */
export function summarizeLegMiles(legMiles) {
    const legs = (Array.isArray(legMiles) ? legMiles : []).filter(Number.isFinite);
    if (legs.length === 0) return null;

    const ascending = [...legs].sort((first, second) => first - second);
    const descending = [...ascending].reverse();
    const topTen = descending.slice(0, 10);

    return {
        leg_count: legs.length,
        total_miles: round(legs.reduce((total, miles) => total + miles, 0)),
        mean_miles: round(legs.reduce((total, miles) => total + miles, 0) / legs.length),
        p50_miles: round(percentile(ascending, 0.5)),
        p75_miles: round(percentile(ascending, 0.75)),
        p90_miles: round(percentile(ascending, 0.9)),
        p95_miles: round(percentile(ascending, 0.95)),
        p99_miles: round(percentile(ascending, 0.99)),
        longest_miles: round(descending[0]),
        legs_over_1_mi: legs.filter((miles) => miles > 1).length,
        legs_over_2_mi: legs.filter((miles) => miles > 2).length,
        legs_over_5_mi: legs.filter((miles) => miles > 5).length,
        // How much of the drive the worst handful of transitions actually costs:
        // the honest size of the prize any further repair work is chasing.
        top_10_longest_miles: round(topTen.reduce((total, miles) => total + miles, 0)),
        top_10_longest: topTen.map(round)
    };
}

/**
 * The legs worth spending another road matrix on.
 *
 * Selection is by measured length, taking the worst `fraction` of transitions and
 * never more than `maxCount`, with anything already short excluded — a repair
 * around a 0.1-mile leg cannot return enough to pay for its request. Purely a
 * ranking of measured miles: no address, street name or region is consulted, so
 * the same rule applies to any territory.
 *
 * @returns {Array<number>} leg indexes, worst first. Leg i is the drive from
 *   stop i to stop i+1.
 */
export function selectWorstLegIndexes(legMiles, { fraction = 0.08, maxCount = 10, minMiles = 0.25 } = {}) {
    const legs = Array.isArray(legMiles) ? legMiles : [];
    const budget = Math.min(
        Number.isFinite(maxCount) ? maxCount : legs.length,
        Math.max(1, Math.ceil(legs.length * fraction))
    );
    return legs
        .map((miles, index) => ({ miles, index }))
        .filter((leg) => Number.isFinite(leg.miles) && leg.miles > minMiles)
        .sort((first, second) => (second.miles - first.miles) || (first.index - second.index))
        .slice(0, budget)
        .map((leg) => leg.index);
}