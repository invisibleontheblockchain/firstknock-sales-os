/**
 * One definition of "was this route's order actually verified on real roads?"
 *
 * THE FAILURE CLASS THIS EXISTS TO CLOSE
 *
 * Charlotte Precision Route 1H shipped 1,000 doors in 627.6 measured road miles.
 * The solver was never the problem: running the production sequencer on the same
 * doors returns 394-428 miles. The route simply never reached it — a whole-run
 * time budget in generation optimized the first two routes of a batch and skipped
 * the rest, and a skipped route was written to the database looking exactly like
 * an optimized one.
 *
 * Fixing that budget removes one way to lose the road pass. It does not remove
 * the CLASS, because every other way to lose it was equally silent: a backend
 * error, a timeout, an unsnapped door, a route above the supported size, an
 * aerial fallback, or the Optimize button falling through to its local
 * straight-line sweep. All of them ended with `out.push(route)` and no trace.
 *
 * So the rule is not "try harder to optimize". It is:
 *
 *   EVERY route leaving generation or optimization carries an explicit verdict
 *   about whether its order was measured on the road network, and an unverified
 *   route is required to say so.
 *
 * A route may legitimately be unverified — the road engine can be down, and
 * shipping a straight-line route beats shipping nothing. What it may not do is
 * be unverified and silent, because that is indistinguishable from success and
 * nobody goes looking.
 */

/** Verdicts. Two mean verified; the rest are honest admissions. */
export const ROAD_VERIFICATION = {
    /** The road pass ran and its order was adopted. */
    ADOPTED: 'road_adopted',
    /** The road pass ran and measured the existing order as already best. */
    CONFIRMED: 'road_confirmed_current',
    /** The pass was attempted and did not return a usable measured order. */
    PASS_FAILED: 'unverified_pass_failed',
    /** The batch spent its whole-run ceiling before reaching this route. */
    RUN_CEILING: 'unverified_run_ceiling',
    /** Too few doors for a road matrix to mean anything. */
    TOO_FEW_DOORS: 'unverified_too_few_doors',
    /** Ordered by the local straight-line sweep instead of the road engine. */
    LOCAL_FALLBACK: 'unverified_local_fallback',
    /** Saved before this contract existed. Not a claim either way. */
    UNKNOWN: 'unknown'
};

const VERIFIED_VERDICTS = new Set([ROAD_VERIFICATION.ADOPTED, ROAD_VERIFICATION.CONFIRMED]);

const ALL_VERDICTS = new Set(Object.values(ROAD_VERIFICATION));

/**
 * Write a verdict onto a route, returning a new route object.
 *
 * `road_network_used` is kept in agreement with the verdict rather than left to
 * whatever an earlier stage wrote, so the two can never contradict each other in
 * the same record — that contradiction is what made past routes unauditable.
 *
 * @param {object} route the route to stamp
 * @param {string} verdict one of `ROAD_VERIFICATION`
 * @param {object} [detail] `{ reason, measuredMiles, savedMiles }`
 * @returns {object} a new route carrying the verdict in `metadata`
 */
export function stampRoadVerification(route, verdict, detail = {}) {
    if (!ALL_VERDICTS.has(verdict)) {
        throw new Error(`Unknown road verification verdict: ${verdict}`);
    }
    const verified = VERIFIED_VERDICTS.has(verdict);
    return {
        ...route,
        metadata: {
            ...(route?.metadata || {}),
            road_verification: {
                verdict,
                verified,
                reason: detail.reason || null,
                measured_road_miles: Number.isFinite(detail.measuredMiles) ? detail.measuredMiles : null,
                road_miles_saved: Number.isFinite(detail.savedMiles) ? detail.savedMiles : null,
                stamped_at: new Date().toISOString()
            },
            road_network_used: verified
        }
    };
}

/**
 * Read a route's verdict. A route with no stamp is UNKNOWN, never "verified" —
 * absence of evidence is not evidence, and defaulting the other way is how an
 * unmeasured order came to be treated as a measured one.
 */
export function readRoadVerification(route) {
    const stamp = route?.metadata?.road_verification;
    if (!stamp || !ALL_VERDICTS.has(stamp.verdict)) {
        return { verdict: ROAD_VERIFICATION.UNKNOWN, verified: false, reason: null };
    }
    return {
        verdict: stamp.verdict,
        verified: VERIFIED_VERDICTS.has(stamp.verdict),
        reason: stamp.reason || null,
        measuredRoadMiles: stamp.measured_road_miles ?? null,
        roadMilesSaved: stamp.road_miles_saved ?? null
    };
}

/** True only when a road engine actually measured this order. */
export function isRoadVerified(route) {
    return readRoadVerification(route).verified;
}

/**
 * Batch summary, for callers that need to tell a user what happened.
 *
 * Generation previously returned `appliedCount` and `skippedForBudget` and no
 * caller read either, so a run in which six of eight routes were skipped
 * reported exactly the same as a clean one.
 */
export function summarizeRoadVerification(routes) {
    const list = Array.isArray(routes) ? routes : [];
    const byVerdict = {};
    let verified = 0;
    list.forEach((route) => {
        const { verdict, verified: ok } = readRoadVerification(route);
        byVerdict[verdict] = (byVerdict[verdict] || 0) + 1;
        if (ok) verified += 1;
    });
    return {
        total: list.length,
        verified,
        unverified: list.length - verified,
        allVerified: list.length > 0 && verified === list.length,
        byVerdict
    };
}

/**
 * The whole decision table, in one pure function.
 *
 * It lives here rather than inline in the generation loop for a specific reason:
 * `roadMatrixRouteGeneration.js` imports through the `@/` build alias, so it
 * cannot be loaded by the node test runner, and logic left inside it can only be
 * checked by reading the source. The rule that decides whether a route may call
 * itself road-verified is exactly the rule that must be executable in a test.
 *
 * @param {object} outcome
 *   `doorCount`       doors on the route
 *   `ceilingExceeded` the batch spent its whole-run ceiling before this route
 *   `adopted`         the road pass returned an order that was applied
 *   `declineReason`   why the road pass returned nothing, when it did
 * @returns {{verdict: string, reason: string|null}}
 */
export function verdictForOutcome({
    doorCount = 0,
    ceilingExceeded = false,
    adopted = false,
    declineReason = null
} = {}) {
    if (adopted) return { verdict: ROAD_VERIFICATION.ADOPTED, reason: null };
    // Order matters: a route too small to price was never a candidate, and a
    // ceiling that fired means the pass never ran at all. Neither is a failure
    // OF the road engine, and calling them one would hide real outages.
    if (doorCount < 2) {
        return { verdict: ROAD_VERIFICATION.TOO_FEW_DOORS, reason: `route holds ${doorCount} doors` };
    }
    if (ceilingExceeded) {
        return { verdict: ROAD_VERIFICATION.RUN_CEILING, reason: 'generation run ceiling reached' };
    }
    // The road engine measured this order against a road-priced alternative and
    // the existing one won. The order IS verified — it just did not change.
    if (declineReason === 'current_order_measured_best') {
        return { verdict: ROAD_VERIFICATION.CONFIRMED, reason: declineReason };
    }
    return { verdict: ROAD_VERIFICATION.PASS_FAILED, reason: declineReason };
}

/**
 * A one-line, user-facing description of a batch outcome, or null when every
 * route was verified and there is nothing the user needs to act on.
 */
export function describeUnverifiedRoutes(routes) {
    const summary = summarizeRoadVerification(routes);
    if (summary.unverified === 0) return null;
    const plural = summary.unverified === 1 ? 'route' : 'routes';
    return `${summary.unverified} of ${summary.total} ${plural} could not be checked against real road distances `
        + 'and kept a straight-line order. Run Optimize on them once the road service is available.';
}
