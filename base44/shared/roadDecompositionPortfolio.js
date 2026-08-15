// Decomposition diversity: solve the SAME 1,000 doors under several different
// groupings and keep whichever finished route measures shortest on the road.
//
// WHY THIS LAYER EXISTS
// Everything below it is now measurably good: window order is road-priced, each
// window is solved on its own exact door matrix, seams are repaired, and the worst
// measured transitions are re-solved. The frozen 358.285-mile Route 1J benchmark
// shows the route BODY is clean (p50-p90 unchanged across the last two rounds), so
// more generic local repair is spent effort. The one decision left that no local
// operator can undo is WHICH doors were grouped together before the exact solver
// ever saw them: a door on the wrong side of a window cut can only be fixed by a
// repair whose neighbourhood happens to span that cut.
//
// WHY IT IS A PORTFOLIO AND NOT A REPLACEMENT
// Replacing the decomposition on a theory has already failed once here: nearest-
// seed road-access grouping is road-coherent and sounds better, and it measured
// 417.9 miles against 379.8 for the geometric cut. So no strategy is trusted.
// Every candidate — including the current production decomposition, which is
// mandatory and always entered — runs the identical proven stack:
//
//   road-aware hierarchy -> seam refinement -> hotspot refinement
//     -> independent OSRM /route measurement of the final order
//
// and selection is exactly one rule: LOWEST INDEPENDENTLY VERIFIED ROAD MILEAGE,
// among candidates that are exact-once, have zero order-affecting aerial
// decisions, and were actually measured. A candidate that fails any of those is
// discarded, never repaired into contention. If every alternative loses, the
// baseline wins and the route is byte-identical to today's — so this layer cannot
// make a route worse, only cost time.
//
// The strategies are properties of the road graph and the door budget only. No
// coordinate, city, route name or fixture is referenced anywhere in this file.

import { sequenceRoadHierarchy, DEFAULT_WINDOW_DOORS, MAX_CLUSTER_DOORS } from './roadHierarchySequencer.js';
import { createRoadCostCache } from './roadCostCache.js';

/**
 * The portfolio. Ordered cheapest-signal-first so a time budget truncates the
 * speculative tail rather than the mandatory baseline.
 *
 * - baseline_windows_92       the production decomposition, whatever path the
 *                             territory's size selects. MANDATORY baseline.
 * - windows_92_offset_46      same grouping with the cuts slid half a window, so
 *                             every boundary falls between a different pair of
 *                             blocks. Cheapest probe for "is this door stranded by
 *                             the cut rather than by the geography".
 * - coarse_road_ordered_*     the structural bet. Above ~250 street blocks the
 *                             baseline cannot road-order the blocks (one matrix
 *                             cannot hold them) and falls to geometric boxes. This
 *                             cuts matrix-sized coarse groups, orders the groups on
 *                             roads, orders the blocks inside each group on roads,
 *                             and cuts windows from THAT order — road-priced
 *                             grouping at full 1,000-door size.
 * - windows_138 / windows_69  wider windows solve more doors exactly together but
 *                             cost road pairs quadratically; narrower windows leave
 *                             more seams but solve each interior closer to optimal.
 */
export const DEFAULT_DECOMPOSITION_PORTFOLIO = [
    { id: 'baseline_windows_92', mandatory: true, options: {} },
    { id: 'windows_92_offset_46', options: { windowOffsetDoors: 46 } },
    { id: 'coarse_road_ordered_windows_92', options: { coarseBlockOrder: true } },
    { id: 'coarse_road_ordered_windows_92_offset_46', options: { coarseBlockOrder: true, windowOffsetDoors: 46 } },
    { id: 'windows_138', options: { windowDoors: 138 } },
    { id: 'windows_69', options: { windowDoors: 69 } },
    { id: 'windows_60', options: { windowDoors: 60 } },
    { id: 'windows_80', options: { windowDoors: 80 } }
];

/** The candidate that must always run, whatever the budget allows. */
const BASELINE = DEFAULT_DECOMPOSITION_PORTFOLIO[0];

const round = (value) => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null);

/** Exact-once: every input door present exactly once in the produced order. */
function isExactOnce(order, expectedCount) {
    if (!Array.isArray(order) || order.length !== expectedCount) return false;
    return new Set(order).size === expectedCount;
}

/**
 * Solve one decomposition end to end and measure the result independently.
 *
 * Returns a record in every case — a rejected candidate reports WHY, because a
 * silently missing candidate looks the same as one that was never tried.
 */
async function runCandidate(candidate, properties, options) {
    const { startLocation, endLocation, measurePath, ...sequencerOptions } = options;
    const startedAt = Date.now();

    const sequenced = await sequenceRoadHierarchy(properties, {
        ...sequencerOptions,
        startLocation,
        endLocation,
        measurePath,
        ...candidate.options
    });
    if (!sequenced.ok) {
        return { id: candidate.id, ok: false, reason: sequenced.code, runtime_ms: Date.now() - startedAt };
    }
    if (!isExactOnce(sequenced.order, properties.length)) {
        return { id: candidate.id, ok: false, reason: 'EXACT_ONCE_VIOLATED', runtime_ms: Date.now() - startedAt };
    }
    if (Number(sequenced.telemetry?.order_affecting_aerial_decisions) > 0) {
        return { id: candidate.id, ok: false, reason: 'ORDER_AFFECTING_AERIAL_DECISIONS', runtime_ms: Date.now() - startedAt };
    }

    // Independent verification. The stack's own internal numbers do not decide
    // this — a fresh /route over the final order does, so a candidate cannot win
    // on a measurement it produced itself while optimizing.
    const measured = await measurePath([
        ...(startLocation ? [startLocation] : []),
        ...sequenced.order,
        ...(endLocation ? [endLocation] : [])
    ], { baseUrl: sequencerOptions.baseUrl, profile: sequencerOptions.profile, timeoutMs: sequencerOptions.timeoutMs });
    if (!measured?.ok || !Number.isFinite(measured.totalMiles)) {
        return {
            id: candidate.id,
            ok: false,
            reason: `UNVERIFIED_ROAD_MILES: ${measured?.error || 'measurement_failed'}`,
            runtime_ms: Date.now() - startedAt
        };
    }

    const telemetry = sequenced.telemetry;
    return {
        id: candidate.id,
        ok: true,
        order: sequenced.order,
        telemetry,
        runtime_ms: Date.now() - startedAt,
        verified_road_miles: round(measured.totalMiles),
        longest_leg_miles: round(measured.longestLegMiles),
        p95_leg_miles: round(measured.legDistribution?.p95_miles),
        leg_distribution: measured.legDistribution || null,
        decomposition: telemetry.decomposition,
        group_count: telemetry.cluster_count,
        matrix_requests: telemetry.matrix_request_count,
        road_pairs_requested: telemetry.road_pairs_requested,
        osrm_requests: telemetry.osrm_requests
    };
}

/**
 * Run the decomposition portfolio and return the lowest verified-mileage route.
 *
 * @param {Array} properties doors to sequence
 * @param {object} options sequencer options plus:
 *   `measurePath` (required — no measurement means no selection rule),
 *   `portfolio` to override the candidate list,
 *   `runBudgetMs` to stop entering NEW candidates once elapsed (a candidate
 *     already in flight always finishes, and the baseline always runs),
 *   `onCandidate` progress hook: `{ index, total, id, result }`.
 * @returns {Promise<object>} `{ ok, order, telemetry, candidates, best }`, or
 *   `{ ok: false, code }` when no candidate could be verified.
 */
export async function sequenceBestDecomposition(properties, options = {}) {
    const {
        portfolio = DEFAULT_DECOMPOSITION_PORTFOLIO,
        runBudgetMs = 0,
        onCandidate = null,
        measurePath = null,
        ...sequencerOptions
    } = options;
    const { fetchMatrix, ...restSequencerOptions } = sequencerOptions;

    // Without an independent measurer there is no honest way to compare two
    // decompositions, so the portfolio does not run at all — the caller keeps the
    // single-decomposition path rather than picking a winner on faith.
    if (typeof measurePath !== 'function') {
        return { ok: false, code: 'PORTFOLIO_REQUIRES_MEASURED_PATH' };
    }

    // Candidates differ only in how the SAME doors are grouped, so most of the road
    // truth one candidate buys is the truth the next one needs — above all the
    // street-block matrix, which is the identical coordinate set for every
    // candidate. One shared cache for the whole portfolio means the second and
    // later attempts pay only for what is genuinely new. It changes cost, never
    // values: a hit returns the engine's own meters, so a cached candidate measures
    // exactly what a cold one would.
    const cache = createRoadCostCache({
        fetchMatrix: fetchMatrix || undefined,
        measurePath
    });

    const startedAt = Date.now();
    const candidates = [];
    let best = null;
    let spentPairs = { fetched: 0, cached: 0, matrixHits: 0, blocksCached: 0 };

    for (let index = 0; index < portfolio.length; index += 1) {
        const candidate = portfolio[index];
        const budgetSpent = runBudgetMs > 0 && Date.now() - startedAt > runBudgetMs;
        if (budgetSpent && !candidate.mandatory && candidates.some((entry) => entry.ok)) {
            candidates.push({ id: candidate.id, ok: false, reason: 'SKIPPED_RUN_BUDGET' });
            onCandidate?.({ index: index + 1, total: portfolio.length, id: candidate.id, result: null });
            continue;
        }

        const result = await runCandidate(candidate, properties, {
            ...restSequencerOptions,
            fetchMatrix: cache.fetchMatrix,
            measurePath: cache.measurePath
        });
        // What this candidate cost INCREMENTALLY, which is the only cost figure that
        // describes a portfolio honestly: a candidate that measures 39s alone can be
        // much cheaper once the road truth it needs is already paid for.
        const spent = cache.stats();
        Object.assign(result, {
            pairs_fetched: spent.pairs_fetched - spentPairs.fetched,
            pairs_served_from_cache: spent.pairs_served_from_cache - spentPairs.cached,
            matrix_memo_hits: spent.matrix_memo_hits - spentPairs.matrixHits,
            blocks_served_from_cache: spent.blocks_served_from_cache - spentPairs.blocksCached
        });
        const candidatePairs = result.pairs_fetched + result.pairs_served_from_cache;
        result.pair_cache_hit_rate_pct = candidatePairs > 0
            ? Math.round((result.pairs_served_from_cache / candidatePairs) * 1000) / 10
            : 0;
        spentPairs = {
            fetched: spent.pairs_fetched,
            cached: spent.pairs_served_from_cache,
            matrixHits: spent.matrix_memo_hits,
            blocksCached: spent.blocks_served_from_cache
        };
        candidates.push(result);
        onCandidate?.({ index: index + 1, total: portfolio.length, id: candidate.id, result });
        // The ONLY selection rule. Ties keep the earlier candidate, which keeps the
        // production baseline in place unless an alternative is strictly shorter.
        if (result.ok && (!best || result.verified_road_miles < best.verified_road_miles)) best = result;
    }

    if (!best) {
        return {
            ok: false,
            code: 'NO_VERIFIED_DECOMPOSITION',
            candidates: candidates.map(({ order, ...rest }) => rest)
        };
    }

    const baseline = candidates.find((entry) => entry.id === BASELINE.id && entry.ok) || null;
    return {
        ok: true,
        order: best.order,
        telemetry: {
            ...best.telemetry,
            selected_decomposition: best.id,
            decomposition_candidates_run: candidates.filter((entry) => entry.ok).length,
            decomposition_candidates_total: portfolio.length,
            decomposition_portfolio_ms: Date.now() - startedAt,
            // Cost of the whole generation, not of one attempt: unique pairs bought,
            // how much of the demand was answered from work already paid for, and
            // how many engine requests that reuse removed.
            road_cost_cache: cache.stats(),
            baseline_decomposition_miles: baseline ? baseline.verified_road_miles : null,
            decomposition_miles_saved_vs_baseline: baseline
                ? round(baseline.verified_road_miles - best.verified_road_miles)
                : null,
            decomposition_candidates: candidates.map(({ order, telemetry, leg_distribution, ...rest }) => rest)
        },
        best,
        candidates
    };
}

export { DEFAULT_WINDOW_DOORS, MAX_CLUSTER_DOORS };