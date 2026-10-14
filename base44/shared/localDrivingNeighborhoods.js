// Local door search complements the global street-block search. Street names
// are discovery hints, not indivisible service units: a branch visit may sit
// between the outbound and return stops on its parent street.
import { haversineMiles } from './routeContinuityOptimizer.js';
import { neighborhoodStreetKey } from './neighborhoodExcursions.js';
import { createVehicleRoutingContext } from './vehicleRouting.js';
import { trustedAccess } from './streetSideRouting.js';
import { buildMailCarrierCandidates, hasCoherentMailCarrierPasses, inferMailCarrierAccess, mailCarrierPassViolations, planMailCarrierWindows } from './mailCarrierRouting.js';

export const LOCAL_DRIVING_REVIEW_VERSION = 'entry_branch_return_v2_mail_carrier';
const id = p => String(p?.address_hash || p?.legacy_hash || p?.id || '');
const protectedStop = (p, locks) => locks.has(id(p)) || p.order_locked || p.locked
    || p.routing_access?.resolution_status === 'unresolved';
const fatal = error => {
    if (error?.name === 'AbortError' || /membership|locked stop|graph identity|cancelled/i.test(error?.message || '')) throw error;
};

// Bounded, contiguous geographic windows only discover candidate work. They do
// not establish road connectivity, street side, or savings. Exact directed road
// costs and continuous routes make those decisions below.
export function planLocalDrivingWindows(order, options = {}) {
    const maxStops = Math.max(3, Math.min(12, Math.floor(options.maxLocalStops || 10)));
    const radius = Math.max(0.05, Math.min(1, Number(options.localRadiusMiles) || 0.45));
    const locks = new Set((options.lockedStopIds || []).map(String));
    const windows = [];
    let start = 0;
    while (start < order.length) {
        if (protectedStop(order[start], locks)) { start++; continue; }
        let end = start + 1;
        while (end < order.length && end - start < maxStops && !protectedStop(order[end], locks)
            && haversineMiles(order[start], order[end]) <= radius
            && haversineMiles(order[end - 1], order[end]) <= radius) end++;
        if (end - start >= 3) windows.push({ start, end });
        // Overlap capped windows so a branch cannot fall between two search
        // chunks (the real Troutman example straddles a ten-stop boundary).
        start = end - start === maxStops ? start + Math.max(1, Math.floor(maxStops / 3)) : end;
    }
    return windows;
}

function windowExcessMiles(order, window) {
    const points = order.slice(Math.max(0, window.start - 1), Math.min(order.length, window.end + 1));
    const driven = points.slice(1).reduce((sum, p, i) => sum + haversineMiles(points[i], p), 0);
    // Geometry only prioritizes which local questions to ask first. A minimum
    // spanning tree is a screening lower bound, never a claimed driving cost.
    const reached = new Set([0]);
    let tree = 0;
    while (reached.size < points.length) {
        let nearest = -1, distance = Infinity;
        for (const i of reached) for (let j = 0; j < points.length; j++) {
            if (reached.has(j)) continue;
            const leg = haversineMiles(points[i], points[j]);
            if (leg < distance) { distance = leg; nearest = j; }
        }
        if (nearest < 0) return 0;
        reached.add(nearest); tree += distance;
    }
    return driven - tree;
}

function compareSearch(a, b) {
    // Keep tolerances small and separate from the final continuous-drive guard.
    if (Math.abs(a.seconds - b.seconds) > 0.1) return a.seconds - b.seconds;
    if (Math.abs(a.miles - b.miles) > 0.0001) return a.miles - b.miles;
    return a.crossings - b.crossings || a.passovers - b.passovers
        || a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds
        || a.entrySeconds - b.entrySeconds || (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0);
}

function serviceTransition(a, b, unvisited, context) {
    const first = context.accessFor?.(a), second = context.accessFor?.(b);
    if (!trustedAccess(first) || !trustedAccess(second) || first.chainKey !== second.chainKey) {
        return { crossings: 0, passovers: 0 };
    }
    // A nearby opposite-side house can deliberately be left for the return pass.
    // Only skipping a still-unserved house on this same side counts as passing it.
    const low = Math.min(first.positionMeters, second.positionMeters);
    const high = Math.max(first.positionMeters, second.positionMeters);
    return { crossings: Number(first.side !== second.side), passovers: unvisited.filter(stop => {
        const access = context.accessFor?.(stop);
        return trustedAccess(access) && access.chainKey === first.chainKey && access.side === first.side
            && access.positionMeters > low + 0.1 && access.positionMeters < high - 0.1;
    }).length };
}

// K-best Held–Karp states keep alternative service tours, including split-street
// tours. No aerial fallback is permitted in search. Both fixed boundary stops
// are priced; extra overlapping boundary legs are checked during validation.
export function buildLocalDrivingCandidates(stops, context, start = null, end = null, options = {}) {
    if (stops.length < 2 || stops.length > 12) return [];
    const width = Math.max(1, Math.min(8, options.localSearchWidth || 4));
    const duration = (a, b) => a && b ? context.optimizationCostBetween(a, b) : 0;
    const distance = (a, b) => a && b ? context.distanceBetween(a, b) : 0;
    const states = new Map();
    const insert = (mask, last, candidate) => {
        if (!Number.isFinite(candidate.seconds) || !Number.isFinite(candidate.miles)) return;
        const key = `${mask}:${last}`;
        const choices = states.get(key) || [];
        choices.push(candidate); choices.sort(compareSearch);
        states.set(key, choices.slice(0, width));
    };
    for (let i = 0; i < stops.length; i++) {
        const seconds = duration(start, stops[i]);
        insert(1 << i, i, { path: [i], seconds, miles: distance(start, stops[i]), startSeconds: seconds,
            endSeconds: 0, entrySeconds: 0, crossings: 0, passovers: 0, fingerprint: id(stops[i]) });
    }
    const full = (1 << stops.length) - 1;
    for (let mask = 1; mask <= full; mask++) {
        for (let last = 0; last < stops.length; last++) {
            for (const prior of states.get(`${mask}:${last}`) || []) {
                for (let next = 0; next < stops.length; next++) {
                    if (mask & (1 << next)) continue;
                    const a = stops[last], b = stops[next];
                    const preference = serviceTransition(a, b, stops.filter((_, i) => !(mask & (1 << i)) && i !== next), context);
                    const seconds = duration(a, b);
                    insert(mask | (1 << next), next, { ...prior, path: [...prior.path, next],
                        seconds: prior.seconds + seconds, miles: prior.miles + distance(a, b),
                        crossings: prior.crossings + preference.crossings, passovers: prior.passovers + preference.passovers,
                        entrySeconds: prior.entrySeconds + (neighborhoodStreetKey(a) !== neighborhoodStreetKey(b) ? seconds : 0),
                        fingerprint: `${prior.fingerprint}|${id(b)}` });
                }
            }
        }
    }
    const candidates = [];
    for (let last = 0; last < stops.length; last++) {
        for (const prior of states.get(`${full}:${last}`) || []) {
            const endSeconds = duration(stops[last], end);
            candidates.push({ ...prior, seconds: prior.seconds + endSeconds,
                miles: prior.miles + distance(stops[last], end), endSeconds,
                order: prior.path.map(i => stops[i]) });
        }
    }
    return candidates.filter(p => Number.isFinite(p.seconds) && Number.isFinite(p.miles)).sort(compareSearch);
}

function sameBoundaryLeg(a, b) {
    return a && b && a.from === b.from && a.to === b.to && a.pathKey === b.pathKey
        && Math.abs(a.driveSeconds - b.driveSeconds) <= 0.1
        && Math.abs(a.distanceMiles - b.distanceMiles) <= 0.0001;
}

function improves(candidate, baseline, preference, priorPreference) {
    if (candidate.driveSeconds > baseline.driveSeconds + 0.1 || candidate.distanceMiles > baseline.distanceMiles + 0.0001) return false;
    if (candidate.driveSeconds < baseline.driveSeconds - 0.1 || candidate.distanceMiles < baseline.distanceMiles - 0.0001) return true;
    return (candidate.estimatedTurnarounds ?? Infinity) < (baseline.estimatedTurnarounds ?? Infinity)
        || ((candidate.estimatedTurnarounds ?? Infinity) === (baseline.estimatedTurnarounds ?? Infinity)
            && (preference.crossings < priorPreference.crossings
                || (preference.crossings === priorPreference.crossings && preference.passovers < priorPreference.passovers)));
}

function preferenceFor(order, context) {
    const preference = { crossings: 0, passovers: 0 };
    for (let i = 1; i < order.length; i++) {
        const leg = serviceTransition(order[i - 1], order[i], order.slice(i + 1), context);
        preference.crossings += leg.crossings; preference.passovers += leg.passovers;
    }
    return preference;
}

export async function reviewLocalDrivingNeighborhoods(order, options = {}) {
    const identities = order.map(id);
    if (identities.some(key => !key) || new Set(identities).size !== order.length) throw new Error('Local driving review requires unique stop membership.');
    const locks = new Set((options.lockedStopIds || []).map(String));
    if ([...locks].some(key => !identities.includes(key))) throw new Error('Locked stop is not in route membership.');
    const report = { version: LOCAL_DRIVING_REVIEW_VERSION, status: 'checked', planned: 0, checked: 0,
        repaired: 0, candidatesMeasured: 0, localMilesSaved: 0, localSecondsSaved: 0,
        skipped: [], budgetExhausted: false, validation: 'unchanged', applied: false };
    const original = order;
    order = [...order];
    const mailCarrier = options.mailCarrierMode === true;
    const windows = [...(mailCarrier ? planMailCarrierWindows(order, options) : []), ...planLocalDrivingWindows(order, options)]
        .map(window => ({ ...window, priority: windowExcessMiles(order, window) }))
        .sort((a, b) => Number(Boolean(b.service)) - Number(Boolean(a.service)) || b.priority - a.priority || a.start - b.start);
    report.planned = windows.length;
    const maxWindows = Math.max(0, Math.min(100, options.maxLocalWindows ?? 64));
    const deadline = Date.now() + Math.max(1, Math.min(60000, options.localReviewBudgetMs ?? 45000));
    const maxCandidates = Math.max(1, Math.min(8, options.maxLocalCandidates || 3));
    const contextOptions = { ...options, startLocation: null, endLocation: null, maxGeometryPoints: 100000,
        requireDirectedLegs: true, servicePolicy: { enabled: false, parkingSecondsPerStop: 0 } };
    const inferredAccess = new Map(), discovered = new Set();
    const accessContext = { accessFor: p => trustedAccess(p.routing_access) ? p.routing_access
        : inferredAccess.get(id(p)) || p.routing_access || null, streetSegmentKey: neighborhoodStreetKey };
    const createContext = options.createLocalDrivingContext || ((points, config) => createVehicleRoutingContext(points, accessContext, config));
    for (let index = 0; index < windows.length; index++) {
        if (report.checked >= maxWindows || Date.now() >= deadline) { report.budgetExhausted = true; break; }
        if (options.signal?.aborted) throw options.signal.reason || new DOMException('Cancelled', 'AbortError');
        const { start, end, service } = windows[index];
        const left = order.slice(Math.max(0, start - 2), start);
        const right = order.slice(end, end + 2);
        if (!left.length && options.startLocation) left.push(options.startLocation);
        if (!right.length && options.endLocation) right.push(options.endLocation);
        const stops = order.slice(start, end), section = [...left, ...stops, ...right];
        report.checked++;
        try {
            if (mailCarrier && section.some(p => !trustedAccess(accessContext.accessFor(p)) && !discovered.has(id(p)))) {
                const discovery = await createContext(section, { ...contextOptions, sparseCosts: true,
                    routeOnly: true, discoverStreetSides: true });
                const observation = await discovery.routeSequence(section);
                for (const [key, access] of inferMailCarrierAccess(section, observation.streetSideEvidence)) {
                    if (!discovered.has(key) && !trustedAccess(accessContext.accessFor(section.find(p => id(p) === key)))) inferredAccess.set(key, access);
                }
                section.forEach(p => discovered.add(id(p)));
            }
            let context, baseline;
            for (let retry = 0; retry < 9; retry++) {
                try {
                    context = await createContext(section, contextOptions);
                    baseline = await context.routeSequence(section);
                    break;
                } catch (error) {
                    fatal(error);
                    const coordinate = /NoSegment.*coordinate (\d+)/i.exec(error.message);
                    const key = coordinate && id(section[Number(coordinate[1])]);
                    // A proposed heading on a one-way or restricted service
                    // point can be infeasible. Remove only that inferred curb
                    // constraint; keep the original pin and road-match radius.
                    if (!key || !inferredAccess.has(key) || retry === 8) throw error;
                    inferredAccess.delete(key);
                }
            }
            const exactCandidates = stops.length <= 12 ? buildLocalDrivingCandidates(stops, context, left.at(-1), right[0], options) : [];
            let candidates = service ? [...buildMailCarrierCandidates(stops, context, left.at(-1), right[0]), ...exactCandidates]
                .sort((a, b) => a.seconds - b.seconds || a.miles - b.miles) : exactCandidates;
            candidates = [...new Map(candidates.map(c => [JSON.stringify(c.order.map(id)), c])).values()];
            if (mailCarrier) candidates = candidates.filter(candidate => hasCoherentMailCarrierPasses([...left, ...candidate.order, ...right], context));
            if (service && !candidates.length) continue;
            if (!candidates.length) { report.skipped.push({ start, end, reason: 'unreachable_local_roads' }); continue; }
            let selected = stops, best = baseline, bestPreference = preferenceFor(stops, context);
            for (const candidate of candidates.slice(0, maxCandidates)) {
                if (Date.now() >= deadline) { report.budgetExhausted = true; break; }
                if (candidate.order.every((p, i) => p === stops[i])) continue;
                const proposed = [...left, ...candidate.order, ...right];
                let measured;
                try { measured = await context.routeSequence(proposed); }
                catch (error) { fatal(error); report.skipped.push({ start, end, candidate: true, reason: error.message }); continue; }
                report.candidatesMeasured++;
                // These unchanged overlapping legs keep the arrival and exit
                // states consistent with the route outside this neighborhood.
                if (left.length >= 2 && !sameBoundaryLeg(baseline.directedLegs?.[0], measured.directedLegs?.[0])) continue;
                if (right.length >= 2 && !sameBoundaryLeg(baseline.directedLegs?.at(-1), measured.directedLegs?.at(-1))) continue;
                const preference = preferenceFor(candidate.order, context);
                // Mail-carrier service is the user's first objective. A legal
                // coherent pass may drive farther than a zig-zag order. Once
                // passes are coherent, real driving time/miles decide the win.
                const fixesPasses = mailCarrier && mailCarrierPassViolations([...left, ...candidate.order, ...right], context)
                    < mailCarrierPassViolations([...left, ...selected, ...right], context);
                if (!fixesPasses && !improves(measured, best, preference, bestPreference)) continue;
                selected = candidate.order; best = measured; bestPreference = preference;
            }
            if (selected !== stops) {
                order.splice(start, stops.length, ...selected);
                report.repaired++; report.localMilesSaved += baseline.distanceMiles - best.distanceMiles;
                report.localSecondsSaved += baseline.driveSeconds - best.driveSeconds;
            }
        } catch (error) {
            fatal(error);
            report.skipped.push({ start, end, reason: error.message });
            // A bad pin stays in its exact slot. Review the bounded runs on
            // either side instead of abandoning all the other neighborhoods.
            const match = /NoSegment.*coordinate (\d+)/i.exec(error.message);
            if (match) {
                const failed = section[Number(match[1])];
                const split = stops.indexOf(failed);
                if (split >= 0) {
                    if (split >= 3) windows.splice(index + 1, 0, { start, end: start + split });
                    if (stops.length - split - 1 >= 3) windows.splice(index + 1, 0, { start: start + split + 1, end });
                }
            }
        }
    }
    if (order.length !== original.length || new Set(order.map(id)).size !== original.length
        || order.some(p => !identities.includes(id(p)))) throw new Error('Local driving review changed route membership.');
    original.forEach((stop, i) => { if (protectedStop(stop, locks) && order[i] !== stop) throw new Error('Local driving review moved a locked stop.'); });
    if (mailCarrier) report.streetSideService = {
        mode: 'mail_carrier_right_curb',
        objective: 'coherent_side_passes_then_driving_cost',
        knownStops: order.filter(p => trustedAccess(accessContext.accessFor(p))).length,
        totalStops: order.length, inferredStops: inferredAccess.size,
        unknownStops: order.filter(p => !trustedAccess(accessContext.accessFor(p))).length,
        passViolationsBefore: mailCarrierPassViolations(original, accessContext),
        passViolationsAfter: mailCarrierPassViolations(order, accessContext),
    };
    if (!report.repaired) return { properties: original, diagnostics: report };
    report.applied = true; report.validation = 'overlapping_boundary_legs';
    report.status = report.skipped.length || report.budgetExhausted || report.streetSideService?.unknownStops > 0
        ? 'partially_reviewed' : 'locally_verified';
    // If all road matches are available, independently measure the complete
    // trip as well. A NoSegment outside a repaired window cannot erase the
    // section's exact boundary validation or become a made-up full-route total.
    try {
        const context = await createContext(order, { ...contextOptions, sparseCosts: true,
            startLocation: options.startLocation, endLocation: options.endLocation });
        const before = await context.routeSequence(original, options);
        const after = await context.routeSequence(order, options);
        const baseline = options.baselineOrder ? await context.routeSequence(options.baselineOrder, options) : before;
        const afterPasses = mailCarrier ? mailCarrierPassViolations(order, accessContext) : 0;
        const worseThan = (measurement, priorOrder) => {
            const priorPasses = mailCarrier ? mailCarrierPassViolations(priorOrder, accessContext) : 0;
            return afterPasses > priorPasses || (afterPasses === priorPasses
                && (after.driveSeconds > measurement.driveSeconds + 0.1 || after.distanceMiles > measurement.distanceMiles + 0.0001));
        };
        if (worseThan(before, original) || worseThan(baseline, options.baselineOrder || original)) {
            return { properties: original, diagnostics: { ...report, applied: false, status: 'whole_route_guard_retained', validation: 'whole_route' } };
        }
        report.validation = 'whole_route';
        return { properties: order, diagnostics: report, measurement: after, baseline };
    } catch (error) {
        fatal(error);
        // Outages, malformed geometry and changed turn continuity are not
        // access uncertainty. Only a named unmatched pin permits local proof.
        if (!/NoSegment|outside the fixed road-match radius|different service road/i.test(error.message)) {
            return { properties: original, diagnostics: { ...report, applied: false, status: 'whole_route_guard_retained', reason: error.message } };
        }
        report.wholeRouteUnavailableReason = error.message;
        return { properties: order, diagnostics: report };
    }
}
