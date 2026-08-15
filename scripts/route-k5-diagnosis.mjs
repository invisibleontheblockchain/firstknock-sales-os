// Why does the new partitioner LOSE at one particular K? — controlled diagnosis.
//
//   node scripts/route-k5-diagnosis.mjs <doors.json> [--k=5]
//        [--tolerances=0,0.02,0.06,0.12] [--old-ndjson=<benchmark ndjson>]
//        [--out=<ndjson>]
//
// On Route 1I the new engine won 6 of 7 K values and lost K=5 by ~2 mi. This
// script does not tune for the number 5. It varies ONE thing at a time on the
// same territory, same solver and same measurement as the benchmark, so the loss
// can be attributed instead of guessed at:
//
//   * balance tolerance sweep — is the loss bought by an uneven partition?
//     (0 = near-equality, the old model's rule; 0.06 = current default)
//   * every portfolio candidate VERIFIED, not just the surrogate finalists — is a
//     candidate the portfolio already produced actually better than the one it
//     selected?
//   * surrogate vs verified ranking per candidate — does the refinement objective
//     disagree with measured mileage?
//   * per-route homes, miles and miles-per-home — is one route sprawling?
//   * under-filled routes vs the published allowed range — is the balance band
//     enforced on both sides, or only as a cap?
//
// The old model's number is read from the benchmark NDJSON rather than re-solved,
// because the old model is deterministic and was already measured on this fixture.
// Research tool: live routing engine, real requests, not part of the app or CI.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { partitionRouteTerritories, DEFAULT_BALANCE_TOLERANCE } from '../base44/shared/routeTerritoryPartitioner.js';
import { sequenceFrozenRoute } from '../base44/shared/frozenRouteSequencer.js';
import { measureRoadPath } from '../base44/shared/roadPathMeasure.js';
import { createRoadCostCache } from '../base44/shared/roadCostCache.js';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
    const found = args.find((arg) => arg.startsWith(`--${name}=`));
    return found ? found.slice(name.length + 3) : fallback;
};

const round = (value, places = 3) => (Number.isFinite(value)
    ? Math.round(value * 10 ** places) / 10 ** places
    : null);

/** The old model's already-measured result for this K, from a benchmark run. */
function oldResultFor(ndjsonPath, routeCount) {
    if (!ndjsonPath || !existsSync(ndjsonPath)) return null;
    const record = readFileSync(ndjsonPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((entry) => entry.stage === 'k_result' && entry.requested_route_count === routeCount);
    return record?.old?.ok ? record.old : null;
}

async function main() {
    const fixturePath = args.find((arg) => !arg.startsWith('--'));
    if (!fixturePath) {
        console.error('usage: node scripts/route-k5-diagnosis.mjs <doors.json> [--k=5] [--tolerances=0,0.06]');
        process.exit(1);
    }

    const raw = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const doors = (Array.isArray(raw) ? raw : raw.doors || raw.stops || [])
        .filter((door) => Number.isFinite(Number(door?.lat)) && Number.isFinite(Number(door?.lng)));
    const routeCount = Math.floor(Number(flag('k', '5')));
    const tolerances = flag('tolerances', `0,0.02,${DEFAULT_BALANCE_TOLERANCE},0.12`)
        .split(',')
        .map(Number)
        .filter((value) => Number.isFinite(value) && value >= 0);
    const outPath = flag('out', `/tmp/route-k${routeCount}-diagnosis.ndjson`);
    const old = oldResultFor(flag('old-ndjson'), routeCount);

    const cache = createRoadCostCache({ measurePath: measureRoadPath });
    const roadOptions = { fetchMatrix: cache.fetchMatrix, measurePath: cache.measurePath };
    const optimizeRoute = async (group) => {
        const sequenced = await sequenceFrozenRoute(group, roadOptions);
        return { order: sequenced.ok ? sequenced.order : null, code: sequenced.code || null };
    };
    const measure = async (order) => (order.length < 2 ? { ok: true, totalMiles: 0 } : cache.measurePath(order));

    const emit = (record) => {
        appendFileSync(outPath, `${JSON.stringify(record)}\n`);
        process.stderr.write(`${record.stage}: ${record.summary || ''}\n`);
    };

    emit({
        stage: 'diagnosis_started',
        fixture: fixturePath,
        route_name: raw.route_name || fixturePath,
        door_count: doors.length,
        route_count: routeCount,
        tolerances,
        old_combined_verified_road_miles: old?.combined_verified_road_miles ?? null,
        summary: `K=${routeCount} · ${doors.length} homes · tolerances ${tolerances.join('/')}`
            + (old ? ` · old ${old.combined_verified_road_miles} mi` : ' · old unknown')
    });

    const runs = [];
    for (const tolerance of tolerances) {
        const startedAt = Date.now();
        const result = await partitionRouteTerritories(doors, routeCount, {
            ...roadOptions,
            optimizeRoute,
            measurePath: measure,
            balanceTolerance: tolerance,
            // Verify EVERY candidate: the question is whether the portfolio already
            // held a better partition than the surrogate ranking chose to pay for.
            verifyCandidates: 99,
            cacheStats: cache.stats
        });
        if (!result.ok) {
            emit({ stage: 'run_failed', balance_tolerance: tolerance, code: result.code, summary: `tolerance ${tolerance} → ${result.code}` });
            continue;
        }

        const report = result.report;
        const perRoute = result.routes
            .map((route) => ({
                homes: route.doorCount,
                miles: round(route.verifiedRoadMiles),
                miles_per_home: round(route.verifiedRoadMiles / route.doorCount, 4)
            }))
            .sort((first, second) => second.miles - first.miles);
        const verifiedCandidates = (report.candidates || []).filter((candidate) => candidate.verified);
        const bestVerified = verifiedCandidates.length > 0
            ? Math.min(...verifiedCandidates.map((candidate) => candidate.combined_verified_road_miles))
            : null;
        // Surrogate-ranked first vs measured-best: if these differ, the refinement
        // objective is not a faithful proxy for the mileage that decides selection.
        const surrogateRanked = [...(report.candidates || [])]
            .sort((first, second) => first.surrogate_road_miles - second.surrogate_road_miles);
        const surrogateLeader = surrogateRanked[0] || null;
        // Identical surrogate AND identical verified miles across two strategies is
        // the signature of the portfolio producing the SAME partition twice.
        const distinctSignatures = new Set((report.candidates || [])
            .map((candidate) => `${candidate.surrogate_road_miles}|${candidate.combined_verified_road_miles}`));

        const run = {
            stage: 'run',
            balance_tolerance: tolerance,
            selected_candidate: report.selected_candidate,
            combined_verified_road_miles: report.combined_verified_road_miles,
            miles_vs_old: old ? round(old.combined_verified_road_miles - report.combined_verified_road_miles) : null,
            homes_per_route: report.homes_per_route,
            min_homes: report.min_homes,
            max_homes: report.max_homes,
            target_homes_per_route: report.target_homes_per_route,
            allowed_range: [report.min_homes_allowed, report.capacity_per_route],
            under_filled_routes: report.homes_per_route.filter((count) => count < report.min_homes_allowed).length,
            over_filled_routes: report.homes_per_route.filter((count) => count > report.capacity_per_route).length,
            max_deviation_pct: report.max_deviation_pct,
            per_route_sorted_by_miles: perRoute,
            worst_route: perRoute[0] || null,
            street_blocks_shared_across_routes: report.street_blocks_shared_across_routes,
            pockets_shared_across_routes: report.pockets_shared_across_routes,
            foreign_neighbour_rate_pct: report.foreign_neighbour_rate_pct,
            candidates: (report.candidates || []).map((candidate) => ({
                id: candidate.id,
                surrogate_road_miles: candidate.surrogate_road_miles,
                combined_verified_road_miles: candidate.combined_verified_road_miles,
                verified: candidate.verified,
                growth_capacity_relaxations: candidate.growth_capacity_relaxations ?? null,
                refinement: candidate.refinement || null
            })),
            best_verified_candidate_miles: bestVerified,
            selection_left_miles_on_table: bestVerified !== null
                ? round(report.combined_verified_road_miles - bestVerified)
                : null,
            surrogate_leader: surrogateLeader?.id || null,
            surrogate_leader_is_measured_winner: surrogateLeader?.id === report.selected_candidate,
            distinct_partitions_in_portfolio: distinctSignatures.size,
            atom_count: report.atom_count ?? null,
            runtime_s: round((Date.now() - startedAt) / 1000, 1),
            summary: `tolerance ${tolerance} → ${report.combined_verified_road_miles} mi`
                + ` (${report.min_homes}–${report.max_homes} homes, ${report.selected_candidate})`
                + (old ? ` · vs old ${old.combined_verified_road_miles}` : '')
        };
        runs.push(run);
        emit(run);
    }

    // Scoreboard
    console.log(`\n### K=${routeCount} diagnosis — ${raw.route_name || fixturePath}, ${doors.length} homes\n`);
    if (old) {
        console.log(`Old model: **${old.combined_verified_road_miles} mi**, homes ${old.min_homes}–${old.max_homes},`
            + ` longest route ${old.longest_route_miles} mi, blocks split ${old.street_blocks_shared_across_routes}\n`);
    }
    console.log('| Balance tolerance | New mi | vs old | Homes range | Allowed | Under-filled | Longest route | Winner | Distinct partitions | Runtime s |');
    console.log('|---|---|---|---|---|---|---|---|---|---|');
    runs.forEach((run) => {
        console.log(`| ${run.balance_tolerance} | ${run.combined_verified_road_miles} | ${run.miles_vs_old ?? '—'}`
            + ` | ${run.min_homes}–${run.max_homes} | ${run.allowed_range[0]}–${run.allowed_range[1]}`
            + ` | ${run.under_filled_routes} | ${run.worst_route?.miles ?? '—'} | ${run.selected_candidate}`
            + ` | ${run.distinct_partitions_in_portfolio} | ${run.runtime_s} |`);
    });

    console.log('\n### Candidates verified in full (surrogate vs measured)\n');
    runs.forEach((run) => {
        const ranked = run.candidates
            .map((candidate) => `${candidate.id}(surrogate ${candidate.surrogate_road_miles}`
                + `${candidate.verified ? `, verified ${candidate.combined_verified_road_miles}` : ', unverified'})`)
            .join(' · ');
        console.log(`- tolerance ${run.balance_tolerance} → **${run.selected_candidate}**`
            + ` · surrogate leader ${run.surrogate_leader}`
            + ` · selection left ${run.selection_left_miles_on_table} mi on the table — ${ranked}`);
    });

    console.log('\n### Per-route shape, worst first\n');
    runs.forEach((run) => {
        console.log(`- tolerance ${run.balance_tolerance}: `
            + run.per_route_sorted_by_miles.map((route) => `${route.homes}h/${route.miles}mi`).join(' · '));
    });

    emit({ stage: 'diagnosis_finished', cache: cache.stats(), summary: `${runs.length} runs · source ${outPath}` });
}

await main();