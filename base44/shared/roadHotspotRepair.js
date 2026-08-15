// Large-neighborhood repair around the worst REMAINING transitions.
//
// WHY THIS IS NOT THE SEAM LAYER AGAIN
// Seam repair asks "is this window boundary badly cut?" — it looks where the
// hierarchy made a cut, whether or not anything there is actually wrong. This
// layer asks the opposite question: "where is the drive still ugly?", and it
// learns that from the independently measured road legs of the finished route.
// The two find different defects. A long transition in the MIDDLE of a window is
// invisible to seam repair, because no boundary sits there; a hotspot centred on
// it is free to reach across several window boundaries at once, because its
// neighbourhood is defined by route position, not by the hierarchy's cuts.
//
// WHY THE MOVE IS THE SAME MOVE
// A repair is still: take a bounded contiguous run of doors, pin the door before
// and the door after, re-solve the run on its own exact road matrix, and keep the
// result only if the run got shorter. Because the anchors hold and the door set is
// unchanged, the run's delta IS the route's delta. Reusing that one verified
// operator is deliberate — relocating blocks, reversing orientations, reordering
// adjacent blocks and lifting a small group out and reinserting it are all just
// outcomes the sweep can reach inside the run, so none of them needs its own
// operator with its own correctness argument.
//
// COST AND HONESTY
// Each pass costs one linear /route measurement plus one matrix per hotspot. The
// pass keeps its result only if the RE-MEASURED total is shorter, so the layer is
// never-worse against the frozen benchmark on real miles, not on local estimates.

import { measureRoadPath } from './roadPathMeasure.js';
import { refineWindowSeams } from './roadSeamRefinement.js';
import { selectWorstLegIndexes, summarizeLegMiles } from './roadLegDistribution.js';

// Doors taken from each side of a hotspot, as successive passes. Wider than the
// seam widths on purpose: a hotspot is a transition that survived seam repair, so
// the doors that make it fixable are further away than 22 stops. Runs above one
// matrix chunk are fetched as chunks, which is why width is a measured tradeoff
// rather than "as wide as possible".
export const DEFAULT_HOTSPOT_PASSES = [44];
// Share of transitions treated as hotspots, and the ceiling on how many are
// repaired per pass. Cost is one matrix per hotspot, so this is the knob that
// buys mileage with compute.
export const DEFAULT_HOTSPOT_FRACTION = 0.08;
export const DEFAULT_HOTSPOT_MAX = 10;

/**
 * Repair the neighbourhoods around the worst measured transitions of a finished
 * route.
 *
 * @param {Array} order the frozen door order to improve
 * @param {object} options `{ startLocation, endLocation, measurePath, fetchMatrix,
 *   baseUrl, profile, timeoutMs, refinementStepBudget, hotspotPasses,
 *   hotspotFraction, hotspotMax, rounds }`
 * @returns {Promise<object>} `{ order, telemetry }`. `order` is always a
 *   permutation of the input, and is only changed when a fresh measurement proves
 *   the total shorter. A measurement that cannot be completed skips the layer and
 *   is reported — the route is never repaired against an unmeasured baseline.
 */
export async function repairWorstTransitions(order, options = {}) {
    const {
        startLocation = null,
        endLocation = null,
        measurePath = measureRoadPath,
        fetchMatrix,
        baseUrl,
        profile = 'driving',
        timeoutMs = 20000,
        refinementStepBudget = 200_000,
        hotspotPasses = DEFAULT_HOTSPOT_PASSES,
        hotspotFraction = DEFAULT_HOTSPOT_FRACTION,
        hotspotMax = DEFAULT_HOTSPOT_MAX,
        // Rounds re-measure between attempts, so a later round targets the
        // transitions that are worst AFTER the earlier repairs landed.
        rounds = 1
    } = options;

    const telemetry = {
        hotspot_rounds_run: 0,
        hotspot_rounds_accepted: 0,
        hotspot_candidates_examined: 0,
        hotspot_candidates_improved: 0,
        hotspot_matrix_requests: 0,
        hotspot_measure_requests: 0,
        hotspot_miles_saved: 0,
        hotspot_widths: (Array.isArray(hotspotPasses) ? hotspotPasses : [hotspotPasses]).join(','),
        hotspot_skipped_reason: null
    };

    if (!Array.isArray(order) || order.length < 8) {
        telemetry.hotspot_skipped_reason = 'route_too_short';
        return { order, telemetry, distribution: null };
    }

    const stops = (candidate) => [startLocation, ...candidate, endLocation].filter(
        (point) => point && Number.isFinite(Number(point.lat)) && Number.isFinite(Number(point.lng))
    );
    const measure = async (candidate) => {
        const measured = await measurePath(stops(candidate), { baseUrl, profile, timeoutMs });
        if (measured?.ok) telemetry.hotspot_measure_requests += measured.requestCount || 0;
        return measured;
    };

    let working = [...order];
    let baseline = await measure(working);
    if (!baseline?.ok) {
        // No trustworthy total to compare against. Repairing anyway would mean
        // accepting candidates on local estimates, which is the exact substitution
        // this solver refuses to make.
        telemetry.hotspot_skipped_reason = `baseline_unmeasured: ${baseline?.error || 'unknown'}`;
        return { order, telemetry, distribution: null };
    }
    const startDistribution = baseline.legDistribution;

    for (let round = 0; round < Math.max(1, Number(rounds) || 1); round += 1) {
        const hotspots = selectWorstLegIndexes(baseline.legMiles, {
            fraction: hotspotFraction,
            maxCount: hotspotMax
        });
        if (hotspots.length === 0) break;
        telemetry.hotspot_rounds_run += 1;

        // A leg's index in the measured path counts the anchor stops, so it is
        // shifted back into door-order space before being used as a run centre.
        const anchorOffset = startLocation && Number.isFinite(Number(startLocation.lat)) ? 1 : 0;
        const centres = [...new Set(
            hotspots
                .map((legIndex) => legIndex + 1 - anchorOffset)
                .filter((boundary) => boundary > 0 && boundary < working.length)
        )];
        if (centres.length === 0) break;

        const repaired = await refineWindowSeams(working, centres, {
            startLocation,
            endLocation,
            fetchMatrix,
            baseUrl,
            profile,
            timeoutMs,
            doorsPerSide: hotspotPasses,
            refinementStepBudget
        });
        telemetry.hotspot_candidates_examined += repaired.telemetry.seams_examined;
        telemetry.hotspot_candidates_improved += repaired.telemetry.seams_improved;
        telemetry.hotspot_matrix_requests += repaired.telemetry.seam_matrix_requests;
        if (repaired.telemetry.seams_improved === 0) break;

        // Independent re-measurement, because the whole point of this layer is that
        // it is judged on the drive, not on the run-local arithmetic that proposed
        // the change.
        const verified = await measure(repaired.order);
        if (!verified?.ok || verified.totalMiles + 1e-6 >= baseline.totalMiles) {
            telemetry.hotspot_skipped_reason = verified?.ok
                ? 'round_rejected_no_measured_gain'
                : `round_unmeasured: ${verified?.error || 'unknown'}`;
            break;
        }
        telemetry.hotspot_miles_saved += baseline.totalMiles - verified.totalMiles;
        telemetry.hotspot_rounds_accepted += 1;
        working = repaired.order;
        baseline = verified;
    }

    telemetry.hotspot_miles_saved = Math.round(telemetry.hotspot_miles_saved * 1000) / 1000;
    return {
        order: working,
        telemetry,
        distribution: baseline.legDistribution || summarizeLegMiles(baseline.legMiles),
        startDistribution
    };
}