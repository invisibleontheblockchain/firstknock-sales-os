// Old splitter vs new K-way partitioner, on real geography and real roads.
//
//   node scripts/route-split-benchmark.mjs <doors.json> [K,K,K...]
//
// Both models are scored the SAME way, which is the only thing that makes the
// comparison a measurement rather than an argument:
//
//   OLD  sequence all N homes with the frozen solver, cut that order into K
//        contiguous balanced pieces (today's production model), re-sequence each
//        piece with the frozen solver, measure each piece independently
//   NEW  partitionRouteTerritories -> K memberships, each sequenced by the same
//        frozen solver and measured by the same independent measurement
//
// Reported per K: combined verified road miles, balance, street/pocket
// fragmentation, interleaving, runtime, road requests. Research tool: it talks to
// a live routing engine and is not part of the app or CI.

import { readFileSync } from 'node:fs';
import { partitionRouteTerritories } from '../base44/shared/routeTerritoryPartitioner.js';
import {
    DEFAULT_DECOMPOSITION_PORTFOLIO,
    sequenceBestDecomposition
} from '../base44/shared/roadDecompositionPortfolio.js';
import { measureRoadPath } from '../base44/shared/roadPathMeasure.js';

const [doorsPath, kList] = process.argv.slice(2);
if (!doorsPath) {
    console.error('usage: node scripts/route-split-benchmark.mjs <doors.json> [K,K,K...]');
    process.exit(1);
}

const raw = JSON.parse(readFileSync(doorsPath, 'utf8'));
const doors = (Array.isArray(raw) ? raw : raw.doors || raw.stops || [])
    .filter((door) => Number.isFinite(Number(door?.lat)) && Number.isFinite(Number(door?.lng)));
const routeCounts = (kList ? kList.split(',') : ['2', '3', '5', '10', '20', '50', '100'])
    .map((value) => Math.floor(Number(value)))
    .filter((value) => Number.isFinite(value) && value >= 2 && value <= doors.length);

const frozenBaseline = DEFAULT_DECOMPOSITION_PORTFOLIO.filter((candidate) => candidate.mandatory);
const portfolio = frozenBaseline.length > 0 ? frozenBaseline : DEFAULT_DECOMPOSITION_PORTFOLIO.slice(0, 1);

const optimizeRoute = async (group) => {
    if (group.length < 2) return { order: [...group] };
    const sequenced = await sequenceBestDecomposition(group, { portfolio, measurePath: measureRoadPath });
    return { order: sequenced.ok ? sequenced.order : null };
};
const measurePath = async (order) => (order.length < 2 ? { ok: true, totalMiles: 0 } : measureRoadPath(order));

const identityOf = (door) => String(door?.address_hash || door?.id || '');

/** Structural fragmentation of an arbitrary membership, by street name. */
function fragmentation(groups) {
    const owners = new Map();
    groups.forEach((group, index) => group.forEach((door) => {
        const key = String(door?.street_name || door?.full_address || identityOf(door));
        if (!owners.has(key)) owners.set(key, new Set());
        owners.get(key).add(index);
    }));
    const shared = [...owners.values()].filter((set) => set.size > 1);
    return {
        streets_shared_across_routes: shared.length,
        street_extra_owners: shared.reduce((sum, set) => sum + set.size - 1, 0)
    };
}

/** TODAY'S MODEL: one frozen order, chopped into K contiguous balanced pieces. */
async function oldSplitter(routeCount) {
    const startedAt = Date.now();
    const sequenced = await optimizeRoute(doors);
    if (!sequenced.order) return { ok: false, code: 'FROZEN_SOLVER_FAILED' };

    const base = Math.floor(doors.length / routeCount);
    const larger = doors.length % routeCount;
    const groups = [];
    let offset = 0;
    for (let index = 0; index < routeCount; index += 1) {
        const size = base + (index < larger ? 1 : 0);
        groups.push(sequenced.order.slice(offset, offset + size));
        offset += size;
    }

    let combined = 0;
    for (const group of groups) {
        const optimized = await optimizeRoute(group);
        if (!optimized.order) return { ok: false, code: 'CHILD_SOLVER_FAILED' };
        const measured = await measurePath(optimized.order);
        if (!measured.ok) return { ok: false, code: 'CHILD_MEASUREMENT_FAILED' };
        combined += measured.totalMiles;
    }

    const counts = groups.map((group) => group.length);
    return {
        ok: true,
        combined_verified_road_miles: Math.round(combined * 1000) / 1000,
        homes_per_route: counts,
        min_homes: Math.min(...counts),
        max_homes: Math.max(...counts),
        ...fragmentation(groups),
        runtime_s: Math.round((Date.now() - startedAt) / 100) / 10
    };
}

async function newSplitter(routeCount) {
    const result = await partitionRouteTerritories(doors, routeCount, {
        optimizeRoute,
        measurePath,
        verifyCandidates: routeCount > 20 ? 1 : 2
    });
    if (!result.ok) return { ok: false, code: result.code };
    const groups = result.routes.map((route) => route.doors);
    return {
        ok: true,
        selected_candidate: result.selected_candidate,
        combined_verified_road_miles: result.report.combined_verified_road_miles,
        homes_per_route: result.report.homes_per_route,
        min_homes: result.report.min_homes,
        max_homes: result.report.max_homes,
        max_deviation_pct: result.report.max_deviation_pct,
        street_blocks_shared_across_routes: result.report.street_blocks_shared_across_routes,
        pockets_shared_across_routes: result.report.pockets_shared_across_routes,
        repeated_area_entries: result.report.repeated_area_entries,
        foreign_neighbour_rate_pct: result.report.foreign_neighbour_rate_pct,
        atom_count: result.report.atom_count,
        atom_levels: result.report.atom_levels,
        road_requests: result.report.road_requests,
        runtime_s: Math.round((result.report.runtime_ms || 0) / 100) / 10,
        ...fragmentation(groups)
    };
}

const results = [];
for (const routeCount of routeCounts) {
    process.stderr.write(`K=${routeCount} ...\n`);
    const [next, old] = [await newSplitter(routeCount), await oldSplitter(routeCount)];
    const delta = next.ok && old.ok
        ? Math.round((next.combined_verified_road_miles - old.combined_verified_road_miles) * 1000) / 1000
        : null;
    results.push({
        requested_route_count: routeCount,
        new: next,
        old: old,
        new_minus_old_miles: delta,
        new_wins: delta !== null ? delta < 0 : null
    });
    process.stderr.write(`  new ${next.combined_verified_road_miles ?? next.code} mi | old ${old.combined_verified_road_miles ?? old.code} mi | delta ${delta}\n`);
}

console.log(JSON.stringify({
    door_count: doors.length,
    fixture: doorsPath,
    route_counts: routeCounts,
    results
}, null, 2));