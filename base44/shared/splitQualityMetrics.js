// Splitter quality, measured rather than eyeballed.
//
// The old splitter shipped with no way to tell whether a change helped: the only
// available evidence was a screenshot of coloured pins, so "the peninsula looks
// wrong" was a bug report and "that looks better" was a regression test. Every
// number below exists so a split can be compared to another split without
// looking at a map.
//
// Two families, kept apart on purpose:
//   BALANCE / FRAGMENTATION  structural facts about the memberships themselves
//   MILEAGE                  supplied by INDEPENDENT road measurement of the
//                            finished routes; never estimated in this module
//
// Nothing here scores a route. Mileage is passed in already measured, so a
// metric can never flatter a partition by pricing it with its own assumptions.

export const SPLIT_METRICS_VERSION = 'split_metrics_v1';

const round = (value, places = 2) => {
    if (!Number.isFinite(value)) return null;
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
};

/** How many distinct routes each key (unit / block / pocket) is spread across. */
function sharedKeyCounts(routes, atoms, keysOf) {
    const routesByKey = new Map();
    routes.forEach((route, routeIndex) => {
        route.atomIndexes.forEach((atomIndex) => {
            keysOf(atoms[atomIndex]).forEach((key) => {
                if (!key) return;
                if (!routesByKey.has(key)) routesByKey.set(key, new Set());
                routesByKey.get(key).add(routeIndex);
            });
        });
    });
    let sharedKeys = 0;
    let extraOwners = 0;
    routesByKey.forEach((owners) => {
        if (owners.size > 1) {
            sharedKeys += 1;
            // Each additional owner is one more rep who has to enter the same
            // piece of geography — the cost a manager actually feels.
            extraOwners += owners.size - 1;
        }
    });
    return { totalKeys: routesByKey.size, sharedKeys, extraOwners };
}

/**
 * Interleaving: how often an atom's road-nearest neighbours belong to somebody
 * else's route. A clean set of service territories scores low; K ribbons woven
 * through each other score high, which is exactly the failure the sweep-slicing
 * splitter produced and could not see.
 */
function interleavingMetrics(routes, atoms, neighbours) {
    const routeOfAtom = new Map();
    routes.forEach((route, routeIndex) => {
        route.atomIndexes.forEach((atomIndex) => routeOfAtom.set(atomIndex, routeIndex));
    });

    let considered = 0;
    let foreign = 0;
    const perRoute = routes.map(() => ({ considered: 0, foreign: 0 }));
    routeOfAtom.forEach((routeIndex, atomIndex) => {
        (neighbours?.[atomIndex] || []).forEach((neighbourIndex) => {
            const neighbourRoute = routeOfAtom.get(neighbourIndex);
            if (neighbourRoute === undefined) return;
            considered += 1;
            perRoute[routeIndex].considered += 1;
            if (neighbourRoute !== routeIndex) {
                foreign += 1;
                perRoute[routeIndex].foreign += 1;
            }
        });
    });

    const rate = (part, whole) => (whole > 0 ? round((part / whole) * 100, 1) : 0);
    return {
        foreign_neighbour_rate_pct: rate(foreign, considered),
        foreign_neighbour_pairs: foreign,
        neighbour_pairs_considered: considered,
        per_route_foreign_neighbour_rate_pct: perRoute.map((entry) => rate(entry.foreign, entry.considered))
    };
}

/**
 * Build the full split report.
 *
 * @param {object} input `{ requestedRouteCount, doorCount, atoms, routes,
 *   neighbours, runtimeMs, roadRequestCount, cacheStats, candidates }` where
 *   each route is `{ atomIndexes, doorCount, verifiedRoadMiles }` and
 *   `verifiedRoadMiles` came from independent road measurement.
 */
export function computeSplitQualityMetrics(input = {}) {
    const {
        requestedRouteCount = 0,
        doorCount = 0,
        atoms = [],
        routes = [],
        neighbours = [],
        runtimeMs = null,
        roadRequestCount = null,
        cacheStats = null,
        candidates = [],
        balance = null,
        balanceBounds = null,
        diversity = null
    } = input;

    const homesPerRoute = routes.map((route) => route.doorCount);
    const totalHomes = homesPerRoute.reduce((sum, count) => sum + count, 0);
    const target = routes.length > 0 ? totalHomes / routes.length : 0;
    const deviations = homesPerRoute.map((count) => Math.abs(count - target));
    const assignedAtoms = routes.flatMap((route) => route.atomIndexes);
    const routeMiles = routes.map((route) => (
        Number.isFinite(route.verifiedRoadMiles) ? round(route.verifiedRoadMiles, 3) : null
    ));
    const allMeasured = routeMiles.every((miles) => miles !== null);

    const units = sharedKeyCounts(routes, atoms, (atom) => [atom.unitKey]);
    const blocks = sharedKeyCounts(routes, atoms, (atom) => atom.blockKeys || []);
    const pockets = sharedKeyCounts(routes, atoms, (atom) => (atom.protected ? [atom.pocketId || atom.unitKey] : []));

    return {
        metrics_version: SPLIT_METRICS_VERSION,
        // Contract
        requested_route_count: requestedRouteCount,
        produced_route_count: routes.length,
        route_count_exact: routes.length === requestedRouteCount,
        door_count_in: doorCount,
        door_count_out: totalHomes,
        exact_once: totalHomes === doorCount
            && assignedAtoms.length === atoms.length
            && new Set(assignedAtoms).size === atoms.length,
        // Balance
        homes_per_route: homesPerRoute,
        min_homes: homesPerRoute.length ? Math.min(...homesPerRoute) : 0,
        max_homes: homesPerRoute.length ? Math.max(...homesPerRoute) : 0,
        mean_homes: round(target),
        target_homes_per_route: round(target),
        max_deviation_from_target: round(deviations.length ? Math.max(...deviations) : 0),
        max_deviation_pct: target > 0 && deviations.length
            ? round((Math.max(...deviations) / target) * 100, 1)
            : 0,
        // Balance contract — declared bounds and BOTH kinds of violation, so an
        // under-filled route can never again be reported as balanced.
        balance_policy_id: balance?.policy_id ?? null,
        balance_tolerance: balanceBounds?.tolerance ?? null,
        min_homes_allowed: balance?.min_homes_allowed ?? null,
        max_homes_allowed: balance?.max_homes_allowed ?? null,
        routes_below_min: balance?.routes_below_min ?? null,
        routes_above_max: balance?.routes_above_max ?? null,
        balance_relaxations: balance?.balance_relaxations ?? null,
        worst_under_fill_homes: balance?.worst_under_fill_homes ?? null,
        worst_over_fill_homes: balance?.worst_over_fill_homes ?? null,
        balance_valid: balance?.balance_valid ?? null,
        balance_bounds_widened_to_whole_homes: balanceBounds?.band_widened_to_whole_homes ?? null,
        balance_bounds_widened_for_feasibility: balanceBounds?.band_widened_for_feasibility ?? null,
        // Mileage — independently measured, or explicitly absent.
        combined_verified_road_miles: allMeasured
            ? round(routeMiles.reduce((sum, miles) => sum + miles, 0), 3)
            : null,
        verified_road_miles_per_route: routeMiles,
        all_routes_measured: allMeasured,
        // Fragmentation
        routing_units_shared_across_routes: units.sharedKeys,
        routing_unit_extra_owners: units.extraOwners,
        street_blocks_shared_across_routes: blocks.sharedKeys,
        street_block_extra_owners: blocks.extraOwners,
        pockets_shared_across_routes: pockets.sharedKeys,
        pocket_extra_owners: pockets.extraOwners,
        // A repeated entry is one route having to drive into a piece of
        // geography another route also owns.
        repeated_area_entries: units.extraOwners,
        // Interleaving
        ...interleavingMetrics(routes, atoms, neighbours),
        // Cost of producing the answer
        runtime_ms: runtimeMs,
        road_requests: roadRequestCount,
        road_pair_cache_hit_rate_pct: cacheStats?.pair_cache_hit_rate_pct ?? null,
        // Portfolio breadth: distinct memberships actually searched, not the
        // number of strategies that were run.
        candidate_count: diversity?.candidate_count ?? candidates.length,
        viable_candidate_count: diversity?.viable_candidate_count ?? null,
        distinct_partition_count: diversity?.distinct_partition_count ?? null,
        duplicate_candidates: diversity?.duplicate_candidates ?? null,
        extra_seeds_generated: diversity?.extra_seeds_generated ?? null,
        balance_policies_tried: diversity?.balance_policies_tried ?? null,
        legacy_sweep_candidate_included: diversity?.legacy_sweep_candidate_included ?? null,
        candidates
    };
}