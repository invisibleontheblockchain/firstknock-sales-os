// One entry point for "sequence these homes with the frozen optimizer".
//
// Production has TWO frozen ordering paths, chosen by size:
//
//   large   `sequenceBestDecomposition` — the decomposition portfolio over the
//           road hierarchy. It REFUSES a route small enough to fit one matrix,
//           returning SINGLE_CLUSTER_USE_EXACT_MATRIX.
//   small   the exact road matrix — plan the tiered matrix, fetch it, sweep the
//           doors against real road distance and real road duration, and keep
//           the best order.
//
// Splitting needs both, because K is a dial: at K=2 each route is ~500 homes and
// at K=100 it is ~10. Callers that knew only the portfolio path failed outright on
// every small route, which is why this facade exists rather than each caller
// guessing a threshold.
//
// The small path is composed from the same shared primitives production composes
// (`planTieredRoadMatrix`, `fetchRoadMatrix`, `createTieredMatrixMetricFns`,
// `roadAwareStreetSweep`) — nothing is reimplemented here. One deliberate
// difference from `optimizeRouteRoadMatrix`: that endpoint selects on its
// duration-primary objective, while this facade selects on INDEPENDENTLY measured
// road miles, because mileage is the objective every splitting decision is judged
// on. Selection only ever picks between orders of the same homes, so exact-once is
// unaffected either way.

import { sequenceBestDecomposition, DEFAULT_DECOMPOSITION_PORTFOLIO } from './roadDecompositionPortfolio.js';
import { planTieredRoadMatrix, createTieredMatrixMetricFns } from './roadMatrixTiers.js';
import { roadAwareStreetSweep } from './roadAwareStreetSweep.js';
import { fetchRoadMatrix } from './roadMatrix.js';
import { measureRoadPath } from './roadPathMeasure.js';

export const FROZEN_SEQUENCER_VERSION = 'frozen_route_sequencer_v1';

/** The production default: the frozen baseline decomposition only. */
export const FROZEN_BASELINE_PORTFOLIO = (() => {
    const mandatory = DEFAULT_DECOMPOSITION_PORTFOLIO.filter((candidate) => candidate.mandatory);
    return mandatory.length > 0 ? mandatory : DEFAULT_DECOMPOSITION_PORTFOLIO.slice(0, 1);
})();

const identityOf = (door) => String(door?.address_hash || door?.id || '');

/** True when the portfolio declined only because the route belongs on one matrix. */
function wantsExactMatrix(result) {
    if (result.code === 'SINGLE_CLUSTER_USE_EXACT_MATRIX') return true;
    const candidates = Array.isArray(result.candidates) ? result.candidates : [];
    return candidates.length > 0
        && candidates.every((candidate) => !candidate.ok && candidate.reason === 'SINGLE_CLUSTER_USE_EXACT_MATRIX');
}

/** Same homes, no repeats, nothing lost — checked before any order is returned. */
function isSameDoorSet(order, doors) {
    if (!Array.isArray(order) || order.length !== doors.length) return false;
    const identities = order.map(identityOf);
    if (identities.some((identity) => !identity)) return false;
    const seen = new Set(identities);
    return seen.size === doors.length && doors.every((door) => seen.has(identityOf(door)));
}

/** Small-route ordering: one exact road matrix, both objectives swept, best measured order kept. */
async function sequenceOnExactMatrix(doors, options) {
    const {
        fetchMatrix = fetchRoadMatrix,
        measurePath = measureRoadPath,
        baseUrl,
        profile = 'driving',
        timeoutMs
    } = options;

    const plan = planTieredRoadMatrix(doors, []);
    if (!plan.ok) return { ok: false, code: `EXACT_MATRIX_PLAN_FAILED_${plan.code}` };

    let matrix;
    try {
        matrix = await fetchMatrix(plan.matrixPoints, { baseUrl, profile, timeoutMs });
    } catch (error) {
        return { ok: false, code: 'EXACT_MATRIX_UNAVAILABLE', reason: error.message };
    }
    if (!matrix) return { ok: false, code: 'EXACT_MATRIX_UNAVAILABLE' };

    const { distanceBetween, durationBetween } = createTieredMatrixMetricFns(matrix, plan);
    const candidates = [
        { type: 'input_order', order: doors },
        { type: 'road_distance_sweep', order: roadAwareStreetSweep(doors, { distanceBetween }) },
        ...(durationBetween
            ? [{ type: 'road_duration_sweep', order: roadAwareStreetSweep(doors, { distanceBetween: durationBetween }) }]
            : [])
    ].filter((candidate) => isSameDoorSet(candidate.order, doors));

    let best = null;
    for (const candidate of candidates) {
        const measured = await measurePath(candidate.order, { baseUrl, profile, timeoutMs });
        // Fail rather than guess: an unmeasured order cannot win a mileage contest.
        if (!measured?.ok || !Number.isFinite(measured.totalMiles)) continue;
        if (!best || measured.totalMiles < best.miles - 1e-9) {
            best = { order: candidate.order, miles: measured.totalMiles, type: candidate.type };
        }
    }
    if (!best) return { ok: false, code: 'EXACT_MATRIX_NO_MEASURED_ORDER' };

    return {
        ok: true,
        order: best.order,
        path: 'exact_matrix',
        metadata: {
            sequencer_version: FROZEN_SEQUENCER_VERSION,
            path: 'exact_matrix',
            matrix_tier: plan.tier,
            selected_candidate_type: best.type,
            candidates_measured: candidates.length,
            verified_road_miles: Math.round(best.miles * 1000) / 1000
        }
    };
}

/**
 * Sequence one route's homes with the frozen optimizer, whatever its size.
 *
 * @param {Array} doors the route's homes
 * @param {object} options `{ portfolio, fetchMatrix, measurePath, baseUrl,
 *   profile, timeoutMs }`. `fetchMatrix`/`measurePath` are injectable so a caller
 *   can share one road-cost cache across many routes.
 * @returns {Promise<object>} `{ ok: true, order, path, metadata }` or `{ ok: false, code }`.
 */
export async function sequenceFrozenRoute(doors, options = {}) {
    const homes = Array.isArray(doors) ? doors : [];
    // A one-home route has exactly one order and nothing to sequence.
    if (homes.length < 2) {
        return { ok: true, order: [...homes], path: 'trivial', metadata: { path: 'trivial' } };
    }

    const viaPortfolio = await sequenceBestDecomposition(homes, {
        ...options,
        portfolio: options.portfolio || FROZEN_BASELINE_PORTFOLIO
    });
    if (viaPortfolio.ok && isSameDoorSet(viaPortfolio.order, homes)) {
        return {
            ok: true,
            order: viaPortfolio.order,
            path: 'decomposition_portfolio',
            metadata: {
                sequencer_version: FROZEN_SEQUENCER_VERSION,
                path: 'decomposition_portfolio',
                decomposition: viaPortfolio.best?.id || null,
                verified_road_miles: viaPortfolio.best?.verified_road_miles ?? null,
                degraded: viaPortfolio.telemetry?.degraded ?? null
            }
        };
    }
    if (viaPortfolio.ok) return { ok: false, code: 'PORTFOLIO_CHANGED_MEMBERSHIP' };
    if (!wantsExactMatrix(viaPortfolio)) return { ok: false, code: viaPortfolio.code || 'PORTFOLIO_FAILED' };

    return sequenceOnExactMatrix(homes, options);
}