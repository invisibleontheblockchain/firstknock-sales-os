// The balance contract: what "balanced" is allowed to mean, in whole homes.
//
// WHY THIS MODULE EXISTS
// The first version of the partitioner enforced balance as an upper capacity
// during growth and checked the lower bound only inside refinement. Growth could
// therefore leave a seed region holding almost nothing, refinement had no
// incentive to fill it (a 1-home route is a very short tour, so the surrogate
// liked it), and the relaxation counter still reported 0 because nothing had
// overflowed. Route 1I produced a 2-home route at K=50 and a 1-home route at
// K=100 while calling itself balanced. A mileage win bought that way is not a
// product win — it is one rep with 2 houses and another with 22.
//
// So balance is now a CONTRACT, declared before the split runs, enforced on both
// sides during growth and refinement, and reported in full whether or not it was
// met. A candidate that misses it is not a finalist unless the caller explicitly
// enters relaxation mode, and that mode is recorded in the report.
//
// EVERYTHING HERE IS WHOLE HOMES
// A percentage tolerance is a convenient way to say "roughly even", but homes are
// indivisible and K can be large enough that a percentage stops meaning anything:
// at K=100 on 1,000 homes the target is 10, and 6% of 10 is 0.6 of a house. Each
// bound is therefore resolved to an integer, widened to at least a one-home band
// so a tight policy stays satisfiable, and then checked for arithmetic
// feasibility (K routes of at most `max_allowed` must be able to hold N homes,
// and K routes of at least `min_allowed` must not require more than N).

export const BALANCE_CONTRACT_VERSION = 'split_balance_contract_v1';

/**
 * The balance policies the portfolio competes over.
 *
 * The K=5 diagnosis on Route 1I showed one fixed tolerance is not universally
 * best: exact equality was the worst result (475.9 mi), 6% lost to the old sweep
 * by 2.1 mi, and 12% beat it by 11.9 mi. Rather than swap one constant for
 * another, all three compete and the benchmark decides — with fairness now a
 * hard gate rather than something traded away silently for mileage.
 */
export const BALANCE_POLICIES = [
    { id: 'tight', tolerance: 0.02 },
    { id: 'moderate', tolerance: 0.06 },
    { id: 'loose', tolerance: 0.12 }
];

export const DEFAULT_BALANCE_POLICY_ID = 'moderate';

/**
 * Resolve one policy into integer home bounds for this exact N and K.
 *
 * @param {number} doorCount N homes being split
 * @param {number} routeCount K routes requested
 * @param {object} policy `{ id, tolerance }`
 * @returns {object} the contract: target, integer `min_allowed` / `max_allowed`,
 *   whether either bound had to be widened to stay satisfiable in whole homes,
 *   and whether the arithmetic is feasible at all.
 */
export function resolveBalanceBounds(doorCount, routeCount, policy = {}, context = {}) {
    const tolerance = Math.max(0, Number(policy.tolerance) || 0);
    const target = doorCount / routeCount;
    const largestAtomHomes = Math.max(0, Number(context.largestAtomHomes) || 0);

    // Percentage bounds, then pulled outward to whole homes. `floor`/`ceil` alone
    // would make a tight policy unsatisfiable whenever N/K is fractional, because
    // no integer sits inside the band.
    let minAllowed = Math.max(1, Math.floor(target * (1 - tolerance)));
    let maxAllowed = Math.max(1, Math.ceil(target * (1 + tolerance)));
    const bandWidenedToWholeHomes = minAllowed > Math.floor(target) || maxAllowed < Math.ceil(target);
    minAllowed = Math.min(minAllowed, Math.floor(target));
    maxAllowed = Math.max(maxAllowed, Math.ceil(target));
    minAllowed = Math.max(1, minAllowed);

    // Indivisibility. The splitter's smallest unit is an atom (a natural area, a
    // street block, or a single home), and an atom is never cut. If one atom holds
    // more homes than the band's ceiling, no valid split can respect that ceiling,
    // so the ceiling is raised to admit it and the reason is recorded. This is a
    // property of the geography, not a fairness concession being hidden.
    const atomWidened = largestAtomHomes > maxAllowed;
    if (atomWidened) maxAllowed = largestAtomHomes;

    // Arithmetic feasibility. K routes capped at maxAllowed must be able to hold
    // all N homes, and K routes each holding minAllowed must not exceed N.
    let feasibilityWidened = false;
    if (maxAllowed * routeCount < doorCount) {
        maxAllowed = Math.ceil(doorCount / routeCount);
        feasibilityWidened = true;
    }
    if (minAllowed * routeCount > doorCount) {
        minAllowed = Math.floor(doorCount / routeCount);
        feasibilityWidened = true;
    }

    return {
        contract_version: BALANCE_CONTRACT_VERSION,
        policy_id: policy.id || 'custom',
        tolerance,
        target_homes_per_route: Math.round(target * 100) / 100,
        min_homes_allowed: minAllowed,
        max_homes_allowed: maxAllowed,
        band_widened_to_whole_homes: bandWidenedToWholeHomes,
        band_widened_for_feasibility: feasibilityWidened,
        band_widened_for_atom_indivisibility: atomWidened,
        largest_atom_homes: largestAtomHomes,
        feasible: minAllowed >= 1 && minAllowed <= maxAllowed && maxAllowed * routeCount >= doorCount
    };
}

/**
 * Score a produced set of route sizes against its contract.
 *
 * Reports both bounds, both actuals, and both kinds of violation separately, so
 * "0 relaxations" can never again mean "no overflow" while a rep holds one house.
 *
 * @param {number[]} homesPerRoute homes on each produced route
 * @param {object} bounds from `resolveBalanceBounds`
 */
export function evaluateBalance(homesPerRoute = [], bounds = {}) {
    const counts = homesPerRoute.map((count) => Number(count) || 0);
    const minAllowed = Number(bounds.min_homes_allowed) || 0;
    const maxAllowed = Number(bounds.max_homes_allowed) || 0;
    const target = Number(bounds.target_homes_per_route) || 0;
    const below = counts.filter((count) => count < minAllowed);
    const above = counts.filter((count) => count > maxAllowed);
    const maxDeviation = counts.length ? Math.max(...counts.map((count) => Math.abs(count - target))) : 0;

    return {
        policy_id: bounds.policy_id || null,
        target_homes_per_route: target,
        min_homes_allowed: minAllowed,
        max_homes_allowed: maxAllowed,
        actual_min_homes: counts.length ? Math.min(...counts) : 0,
        actual_max_homes: counts.length ? Math.max(...counts) : 0,
        routes_below_min: below.length,
        routes_above_max: above.length,
        // The honest single number: every route outside its declared band, in
        // either direction. This is what "relaxations" now means.
        balance_relaxations: below.length + above.length,
        worst_under_fill_homes: below.length ? minAllowed - Math.min(...below) : 0,
        worst_over_fill_homes: above.length ? Math.max(...above) - maxAllowed : 0,
        max_deviation_homes: Math.round(maxDeviation * 100) / 100,
        max_deviation_pct: target > 0 ? Math.round((maxDeviation / target) * 1000) / 10 : 0,
        balance_valid: below.length === 0 && above.length === 0
    };
}