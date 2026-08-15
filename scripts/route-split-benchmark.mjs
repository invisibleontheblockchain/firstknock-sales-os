// Old splitter vs new K-way partitioner, on real geography and live roads.
//
//   node scripts/route-split-benchmark.mjs <doors.json> [--k=2,3,5,10,20,50,100]
//                                          [--out=<ndjson>] [--report=<ndjson>]
//
// Both engines are scored the SAME way, which is the only thing that makes this a
// measurement rather than an argument:
//
//   OLD  frozen solver over all N homes -> cut that one order into K contiguous
//        balanced pieces (today's production model) -> frozen solver per piece ->
//        independent measurement per piece
//   NEW  partitionRouteTerritories -> K memberships -> the same frozen solver per
//        route -> the same independent measurement per route
//
// The full-territory frozen order the OLD model slices is computed ONCE and reused
// for every K, because it does not depend on K.
//
// Fragmentation and interleaving are computed for BOTH sides by one function over
// one atom set, so neither engine is scored by its own bookkeeping. Note the
// asymmetry this exposes rather than hides: the old model cuts by door index, so it
// can split an atom, and its interleaving is therefore reported under majority
// attribution (an atom counts for the route owning most of its doors) while its
// block/pocket splitting is counted exactly, at door level.
//
// Results stream to NDJSON as each K finishes, so a long run is never lost and can
// be reported on while still in flight. Research tool: it talks to a live routing
// engine, costs real requests, and is not part of the app or CI.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { partitionRouteTerritories, DEFAULT_BALANCE_TOLERANCE } from '../base44/shared/routeTerritoryPartitioner.js';
import { buildSplitAtoms } from '../base44/shared/splitAtoms.js';
import { sequenceFrozenRoute } from '../base44/shared/frozenRouteSequencer.js';
import { measureRoadPath } from '../base44/shared/roadPathMeasure.js';
import { createRoadCostCache } from '../base44/shared/roadCostCache.js';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
    const found = args.find((arg) => arg.startsWith(`--${name}=`));
    return found ? found.slice(name.length + 3) : fallback;
};

const reportOnly = flag('report');
const fixturePath = args.find((arg) => !arg.startsWith('--'));
const outPath = flag('out', '/tmp/route-split-benchmark.ndjson');
// All four partition candidates are ranked on the surrogate at every K, but each
// verified finalist costs K frozen-solver runs plus K measurements. Verifying four
// at K=100 is 400 solver runs, so the number of VERIFIED finalists tapers while the
// ranking of all four is reported everywhere.
const verifyCandidatesFor = (routeCount) => (routeCount <= 10 ? 4 : (routeCount <= 20 ? 2 : 1));

const round = (value, places = 3) => (Number.isFinite(value)
    ? Math.round(value * 10 ** places) / 10 ** places
    : null);
const identityOf = (door) => String(door?.address_hash || door?.id || '');

const quantile = (values, fraction) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((first, second) => first - second);
    const position = (sorted.length - 1) * fraction;
    const low = Math.floor(position);
    const high = Math.ceil(position);
    return round(low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (position - low));
};

/**
 * Fragmentation and interleaving for ANY membership, old or new, over one atom set.
 *
 * Block / pocket / unit splitting is counted at DOOR level, so it is exact for both
 * engines even when the old model cuts through an atom. Interleaving needs the atom
 * adjacency graph, so an atom is attributed to the route owning most of its doors —
 * flagged in the output, and only ever applicable to the old side.
 */
function structuralMetrics(groups, atoms, neighbours) {
    const keysByDoor = new Map();
    const atomOfDoor = new Map();
    atoms.forEach((atom, atomIndex) => {
        atom.doors.forEach((door) => {
            keysByDoor.set(identityOf(door), {
                blocks: atom.blockKeys || [],
                unit: atom.unitKey,
                pocket: atom.protected ? (atom.pocketId || atom.unitKey) : null
            });
            atomOfDoor.set(identityOf(door), atomIndex);
        });
    });

    const owners = { blocks: new Map(), units: new Map(), pockets: new Map() };
    const add = (map, key, routeIndex) => {
        if (!key) return;
        if (!map.has(key)) map.set(key, new Set());
        map.get(key).add(routeIndex);
    };
    groups.forEach((group, routeIndex) => group.forEach((door) => {
        const keys = keysByDoor.get(identityOf(door));
        if (!keys) return;
        keys.blocks.forEach((blockKey) => add(owners.blocks, blockKey, routeIndex));
        add(owners.units, keys.unit, routeIndex);
        add(owners.pockets, keys.pocket, routeIndex);
    }));
    const shared = (map) => {
        const multi = [...map.values()].filter((set) => set.size > 1);
        return { shared: multi.length, extraOwners: multi.reduce((sum, set) => sum + set.size - 1, 0) };
    };

    // Majority attribution for the adjacency-based measure.
    const doorsPerRoutePerAtom = new Map();
    groups.forEach((group, routeIndex) => group.forEach((door) => {
        const atomIndex = atomOfDoor.get(identityOf(door));
        if (atomIndex === undefined) return;
        if (!doorsPerRoutePerAtom.has(atomIndex)) doorsPerRoutePerAtom.set(atomIndex, new Map());
        const counts = doorsPerRoutePerAtom.get(atomIndex);
        counts.set(routeIndex, (counts.get(routeIndex) || 0) + 1);
    }));
    const routeOfAtom = new Map();
    let atomsSplitAcrossRoutes = 0;
    doorsPerRoutePerAtom.forEach((counts, atomIndex) => {
        if (counts.size > 1) atomsSplitAcrossRoutes += 1;
        const best = [...counts.entries()].sort((first, second) => second[1] - first[1] || first[0] - second[0])[0];
        routeOfAtom.set(atomIndex, best[0]);
    });

    let considered = 0;
    let foreign = 0;
    routeOfAtom.forEach((routeIndex, atomIndex) => {
        (neighbours[atomIndex] || []).forEach((neighbourIndex) => {
            const neighbourRoute = routeOfAtom.get(neighbourIndex);
            if (neighbourRoute === undefined) return;
            considered += 1;
            if (neighbourRoute !== routeIndex) foreign += 1;
        });
    });

    const blocks = shared(owners.blocks);
    const units = shared(owners.units);
    const pockets = shared(owners.pockets);
    return {
        street_blocks_shared_across_routes: blocks.shared,
        street_block_extra_owners: blocks.extraOwners,
        routing_units_shared_across_routes: units.shared,
        repeated_area_entries: units.extraOwners,
        pockets_shared_across_routes: pockets.shared,
        pocket_extra_owners: pockets.extraOwners,
        atoms_split_across_routes: atomsSplitAcrossRoutes,
        foreign_neighbour_rate_pct: considered > 0 ? round((foreign / considered) * 100, 1) : 0,
        neighbour_pairs_considered: considered,
        interleaving_basis: 'atom_majority_attribution'
    };
}

/** Road-nearest atom neighbours, from straight-line ranking of atom representatives. */
function atomNeighbours(atoms, perAtom = 6) {
    const distance = (first, second) => {
        const latMiles = (first.lat - second.lat) * 69;
        const lngMiles = (first.lng - second.lng) * 69 * Math.cos((first.lat * Math.PI) / 180);
        return Math.sqrt(latMiles ** 2 + lngMiles ** 2);
    };
    return atoms.map((atom, index) => atoms
        .map((other, otherIndex) => ({ otherIndex, miles: distance(atom.representative, other.representative) }))
        .filter((entry) => entry.otherIndex !== index)
        .sort((first, second) => first.miles - second.miles || first.otherIndex - second.otherIndex)
        .slice(0, perAtom)
        .map((entry) => entry.otherIndex));
}

function mileageShape(routeMiles) {
    return {
        shortest_route_miles: round(Math.min(...routeMiles)),
        median_route_miles: quantile(routeMiles, 0.5),
        p90_route_miles: quantile(routeMiles, 0.9),
        longest_route_miles: round(Math.max(...routeMiles))
    };
}

async function main() {
    if (reportOnly) return printReport(reportOnly);
    if (!fixturePath) {
        console.error('usage: node scripts/route-split-benchmark.mjs <doors.json> [--k=2,3,5] [--out=path]');
        process.exit(1);
    }

    const raw = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const doors = (Array.isArray(raw) ? raw : raw.doors || raw.stops || [])
        .filter((door) => Number.isFinite(Number(door?.lat)) && Number.isFinite(Number(door?.lng)));
    const routeName = raw.route_name || raw.route_id || fixturePath;
    const routeCounts = (flag('k', '2,3,5,10,20,50,100').split(','))
        .map((value) => Math.floor(Number(value)))
        .filter((value) => Number.isFinite(value) && value >= 2 && value <= doors.length);

    const cache = createRoadCostCache({ measurePath: measureRoadPath });
    const roadOptions = { fetchMatrix: cache.fetchMatrix, measurePath: cache.measurePath };

    // Both engines order every route through this one facade, so the comparison is
    // between memberships and nothing else.
    const optimizeRoute = async (group) => {
        const sequenced = await sequenceFrozenRoute(group, roadOptions);
        return { order: sequenced.ok ? sequenced.order : null, code: sequenced.code || null, path: sequenced.path };
    };
    const measure = async (order) => (order.length < 2
        ? { ok: true, totalMiles: 0 }
        : cache.measurePath(order));

    const emit = (record) => {
        appendFileSync(outPath, `${JSON.stringify(record)}\n`);
        process.stderr.write(`${record.stage}${record.requested_route_count ? ` K=${record.requested_route_count}` : ''}: ${record.summary || record.code || 'ok'}\n`);
    };

    emit({
        stage: 'run_started',
        fixture: fixturePath,
        route_name: routeName,
        door_count: doors.length,
        route_counts: routeCounts,
        balance_tolerance: DEFAULT_BALANCE_TOLERANCE,
        started_at: new Date().toISOString(),
        summary: `${doors.length} homes, K=${routeCounts.join('/')}`
    });

    // The one order the OLD model slices. K-independent, so bought once.
    const fullOrderStartedAt = Date.now();
    const fullOrder = await optimizeRoute(doors);
    if (!fullOrder.order) {
        emit({ stage: 'old_full_sequence_failed', code: fullOrder.code, summary: 'frozen solver could not sequence the territory' });
        process.exit(2);
    }
    emit({
        stage: 'old_full_sequence',
        runtime_s: round((Date.now() - fullOrderStartedAt) / 1000, 1),
        summary: `sequenced ${fullOrder.order.length} homes once for every K`
    });

    for (const routeCount of routeCounts) {
        // One atom set per K is the scoring basis for BOTH engines at that K.
        const built = buildSplitAtoms(doors, routeCount, {});
        const atoms = built.ok ? built.atoms : [];
        const neighbours = atoms.length > 0 ? atomNeighbours(atoms) : [];

        // OLD: contiguous balanced slices of the single frozen order.
        const oldStartedAt = Date.now();
        const base = Math.floor(doors.length / routeCount);
        const larger = doors.length % routeCount;
        const oldGroups = [];
        let offset = 0;
        for (let index = 0; index < routeCount; index += 1) {
            const size = base + (index < larger ? 1 : 0);
            oldGroups.push(fullOrder.order.slice(offset, offset + size));
            offset += size;
        }
        const oldMiles = [];
        let oldFailure = null;
        for (const group of oldGroups) {
            const optimized = await optimizeRoute(group);
            if (!optimized.order) { oldFailure = optimized.code || 'CHILD_SOLVER_FAILED'; break; }
            const measured = await measure(optimized.order);
            if (!measured?.ok) { oldFailure = 'CHILD_MEASUREMENT_FAILED'; break; }
            oldMiles.push(measured.totalMiles);
        }
        const oldCounts = oldGroups.map((group) => group.length);
        const oldResult = oldFailure ? { ok: false, code: oldFailure } : {
            ok: true,
            combined_verified_road_miles: round(oldMiles.reduce((sum, miles) => sum + miles, 0)),
            verified_road_miles_per_route: oldMiles.map((miles) => round(miles)),
            homes_per_route: oldCounts,
            min_homes: Math.min(...oldCounts),
            max_homes: Math.max(...oldCounts),
            ...mileageShape(oldMiles),
            ...structuralMetrics(oldGroups, atoms, neighbours),
            runtime_s: round((Date.now() - oldStartedAt) / 1000, 1)
        };

        // NEW: road-topology memberships, same solver, same measurement.
        const newStartedAt = Date.now();
        const partitioned = await partitionRouteTerritories(doors, routeCount, {
            ...roadOptions,
            optimizeRoute,
            measurePath: measure,
            // The old sweep competes as one candidate, priced on the same order
            // the door-exact old model above is sliced from.
            legacySweepOrder: fullOrder.order,
            verifyCandidates: verifyCandidatesFor(routeCount),
            cacheStats: cache.stats
        });
        const newResult = !partitioned.ok ? { ok: false, code: partitioned.code } : (() => {
            const report = partitioned.report;
            const groups = partitioned.routes.map((route) => route.doors);
            const routeMiles = partitioned.routes.map((route) => route.verifiedRoadMiles);
            const winner = (report.candidates || []).find((candidate) => candidate.id === report.selected_candidate);
            return {
                ok: true,
                selected_candidate: report.selected_candidate,
                candidate_ranking: (report.candidates || []).map((candidate) => ({
                    id: candidate.id,
                    policy_id: candidate.policy_id ?? null,
                    surrogate_road_miles: candidate.surrogate_road_miles,
                    combined_verified_road_miles: candidate.combined_verified_road_miles,
                    verified: candidate.verified,
                    balance_valid: candidate.balance?.balance_valid ?? null,
                    balance_relaxations: candidate.balance?.balance_relaxations ?? null
                })),
                combined_verified_road_miles: report.combined_verified_road_miles,
                verified_road_miles_per_route: report.verified_road_miles_per_route,
                homes_per_route: report.homes_per_route,
                min_homes: report.min_homes,
                max_homes: report.max_homes,
                max_deviation_pct: report.max_deviation_pct,
                ...mileageShape(routeMiles),
                balance_tolerance: report.balance_tolerance,
                balance_policy_id: report.selected_balance_policy,
                capacity_per_route: report.capacity_per_route,
                min_homes_allowed: report.min_homes_allowed,
                max_homes_allowed: report.max_homes_allowed,
                target_homes_per_route: report.target_homes_per_route,
                routes_below_min: report.routes_below_min,
                routes_above_max: report.routes_above_max,
                balance_relaxations: report.balance_relaxations,
                balance_valid: report.balance_valid,
                balance_relaxation_mode: report.balance_relaxation_mode,
                atom_forced_capacity: report.atom_forced_capacity,
                distinct_partition_count: report.distinct_partition_count,
                duplicate_candidates: report.duplicate_candidates,
                viable_candidate_count: report.viable_candidate_count,
                extra_seeds_generated: report.extra_seeds_generated,
                growth_bound_relaxations: winner?.growth_bound_relaxations ?? null,
                atom_count: atoms.length,
                atom_levels: report.atom_levels || built.telemetry?.atom_levels || null,
                atom_granularity_used: report.atom_granularity_used || built.telemetry?.atom_granularity_used || null,
                atoms_subdivided_to_feasibility: report.atoms_subdivided_to_feasibility
                    ?? built.telemetry?.atoms_subdivided_to_feasibility
                    ?? null,
                road_requests: report.road_requests,
                partitioner_report: report,
                ...structuralMetrics(groups, atoms, neighbours),
                runtime_s: round((Date.now() - newStartedAt) / 1000, 1)
            };
        })();

        const saved = oldResult.ok && newResult.ok
            ? round(oldResult.combined_verified_road_miles - newResult.combined_verified_road_miles)
            : null;
        emit({
            stage: 'k_result',
            route_name: routeName,
            requested_route_count: routeCount,
            door_count: doors.length,
            old: oldResult,
            new: newResult,
            miles_saved: saved,
            improvement_pct: saved !== null && oldResult.combined_verified_road_miles > 0
                ? round((saved / oldResult.combined_verified_road_miles) * 100, 1)
                : null,
            new_wins: saved !== null ? saved > 0 : null,
            cache: cache.stats(),
            summary: oldResult.ok && newResult.ok
                ? `old ${oldResult.combined_verified_road_miles} mi | new ${newResult.combined_verified_road_miles} mi | saved ${saved} | winner ${newResult.selected_candidate}`
                : `old ${oldResult.code || 'ok'} | new ${newResult.code || 'ok'}`
        });
    }

    emit({ stage: 'run_finished', finished_at: new Date().toISOString(), cache: cache.stats(), summary: 'complete' });
    printReport(outPath);
}

/** Print the scoreboard from a (possibly still-growing) NDJSON result file. */
function printReport(path) {
    if (!existsSync(path)) {
        console.error(`no results at ${path}`);
        process.exit(1);
    }
    const records = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const results = records.filter((record) => record.stage === 'k_result');
    const started = records.find((record) => record.stage === 'run_started');

    console.log(`\n### ${started?.route_name || path} — ${started?.door_count || '?'} homes\n`);
    console.log('| Route | K | Old mi | New mi | Saved | % | Homes range old/new | Blocks split old/new | Pockets split old/new | Interleave old/new | Winner | Runtime old/new s |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
    results.forEach((result) => {
        const old = result.old;
        const next = result.new;
        const cell = (value) => (value === null || value === undefined ? '—' : value);
        console.log(`| ${result.route_name} | ${result.requested_route_count} | ${cell(old.combined_verified_road_miles) || old.code} | ${cell(next.combined_verified_road_miles) || next.code} | ${cell(result.miles_saved)} | ${cell(result.improvement_pct)}% | ${old.ok ? `${old.min_homes}–${old.max_homes}` : '—'} / ${next.ok ? `${next.min_homes}–${next.max_homes}` : '—'} | ${cell(old.street_blocks_shared_across_routes)} / ${cell(next.street_blocks_shared_across_routes)} | ${cell(old.pockets_shared_across_routes)} / ${cell(next.pockets_shared_across_routes)} | ${cell(old.foreign_neighbour_rate_pct)}% / ${cell(next.foreign_neighbour_rate_pct)}% | ${cell(next.selected_candidate)} | ${cell(old.runtime_s)} / ${cell(next.runtime_s)} |`);
    });

    console.log('\n### Strict validity and scale-aware granularity\n');
    console.log('| K | Target | Allowed | Achieved | Granularity | Subdivided | Below/above | True relaxations | Exact K | Exact-once | Verified miles |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|');
    results.filter((result) => result.new.ok).forEach((result) => {
        const next = result.new;
        const report = next.partitioner_report || {};
        console.log(`| ${result.requested_route_count} | ${next.target_homes_per_route} | ${next.min_homes_allowed}–${next.max_homes_allowed} | ${next.min_homes}–${next.max_homes} | ${next.atom_granularity_used} | ${next.atoms_subdivided_to_feasibility} | ${next.routes_below_min}/${next.routes_above_max} | ${next.balance_relaxations} | ${report.route_count_exact ? 'yes' : 'NO'} | ${report.exact_once ? 'yes' : 'NO'} | ${next.combined_verified_road_miles} |`);
    });

    console.log('\n### Portfolio breadth\n');
    console.log('| K | Candidates | Viable | Distinct memberships | Duplicates | Extra seeds | Old sweep candidate |');
    console.log('|---|---|---|---|---|---|---|');
    results.filter((result) => result.new.ok).forEach((result) => {
        const next = result.new;
        const legacy = (next.candidate_ranking || []).find((candidate) => String(candidate.id).startsWith('legacy_sweep'));
        console.log(`| ${result.requested_route_count} | ${next.partitioner_report?.candidate_count ?? '—'} | ${next.viable_candidate_count} | ${next.distinct_partition_count} | ${next.duplicate_candidates} | ${next.extra_seeds_generated ? 'yes' : 'no'} | ${legacy ? `${legacy.verified ? legacy.combined_verified_road_miles : 'ranked'}` : '—'} |`);
    });

    console.log('\n### Route mileage shape (one bad route check)\n');
    console.log('| K | Old short/med/p90/long | New short/med/p90/long |');
    console.log('|---|---|---|');
    results.filter((result) => result.old.ok && result.new.ok).forEach(({ requested_route_count: k, old, new: next }) => {
        const shape = (entry) => `${entry.shortest_route_miles} / ${entry.median_route_miles} / ${entry.p90_route_miles} / ${entry.longest_route_miles}`;
        console.log(`| ${k} | ${shape(old)} | ${shape(next)} |`);
    });

    console.log('\n### Candidate ranking per K\n');
    results.filter((result) => result.new.ok).forEach((result) => {
        const ranked = result.new.candidate_ranking
            .map((candidate) => `${candidate.id}(surrogate ${candidate.surrogate_road_miles}${candidate.verified ? `, verified ${candidate.combined_verified_road_miles}` : ', unverified'})`)
            .join(' · ');
        console.log(`- K=${result.requested_route_count} → **${result.new.selected_candidate}** — ${ranked}`);
    });

    const last = records.filter((record) => record.cache).pop();
    if (last) {
        console.log(`\nRoad cost: ${last.cache.unique_road_pairs} unique pairs · ${last.cache.pairs_fetched} fetched · ${last.cache.pair_cache_hit_rate_pct}% pair cache hit rate · ${last.cache.unique_matrices} matrices\n`);
    }
    console.log(`Records: ${results.length} of ${started?.route_counts?.length ?? '?'} K values · source ${path}`);
}

await main();