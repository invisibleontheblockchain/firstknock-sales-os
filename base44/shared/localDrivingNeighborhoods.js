// Local door search complements the global street-block search. Street names
// are discovery hints, not indivisible service units: a branch visit may sit
// between the outbound and return stops on its parent street.
import { haversineMiles } from './routeContinuityOptimizer.js';
import { neighborhoodStreetKey } from './neighborhoodExcursions.js';
import { createVehicleRoutingContext } from './vehicleRouting.js';
import { trustedAccess } from './streetSideRouting.js';
import { buildMailCarrierCandidates, hasCoherentMailCarrierPasses, inferMailCarrierAccess, mailCarrierPassViolations, planMailCarrierWindows } from './mailCarrierRouting.js';
import { buildDrivingAreaCandidates, planDrivingAreaWindows } from './drivingAreaRouting.js';

export const LOCAL_DRIVING_REVIEW_VERSION = 'entry_branch_return_v4_area_relocation';
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
    const size = stops.length, full = (1 << size) - 1;
    // Costs and access evidence are fixed for this search. Resolve them once,
    // rather than doing provider-map lookups, street normalization and an
    // unvisited-stop scan for every exponential DP transition.
    const keys = stops.map(id), streets = stops.map(neighborhoodStreetKey);
    const accesses = stops.map(p => context.accessFor?.(p));
    const trusted = accesses.map(a => Boolean(trustedAccess(a)));
    const secondsByPair = [], milesByPair = [], crossingByPair = [], betweenByPair = [];
    for (let first = 0; first < size; first++) {
        for (let last = 0; last < size; last++) {
            const pair = first * size + last;
            secondsByPair[pair] = first === last ? 0 : duration(stops[first], stops[last]);
            milesByPair[pair] = first === last ? 0 : distance(stops[first], stops[last]);
            crossingByPair[pair] = 0; betweenByPair[pair] = 0;
            const a = accesses[first], b = accesses[last];
            if (!trusted[first] || !trusted[last] || a.chainKey !== b.chainKey) continue;
            crossingByPair[pair] = Number(a.side !== b.side);
            const low = Math.min(a.positionMeters, b.positionMeters);
            const high = Math.max(a.positionMeters, b.positionMeters);
            for (let i = 0; i < size; i++) {
                const access = accesses[i];
                if (trusted[i] && access.chainKey === a.chainKey && access.side === a.side
                    && access.positionMeters > low + 0.1 && access.positionMeters < high - 0.1) betweenByPair[pair] |= 1 << i;
            }
        }
    }
    const startSeconds = stops.map(p => duration(start, p)), startMiles = stops.map(p => distance(start, p));
    const endSeconds = stops.map(p => duration(p, end)), endMiles = stops.map(p => distance(p, end));
    const countBits = new Uint8Array(full + 1);
    for (let mask = 1; mask <= full; mask++) countBits[mask] = countBits[mask >>> 1] + (mask & 1);
    const states = [];
    const insert = (mask, last, candidate) => {
        if (!Number.isFinite(candidate.seconds) || !Number.isFinite(candidate.miles)) return;
        const key = mask * size + last;
        const choices = states[key] || [];
        choices.push(candidate); choices.sort(compareSearch);
        states[key] = choices.slice(0, width);
    };
    for (let i = 0; i < size; i++) {
        const seconds = startSeconds[i];
        insert(1 << i, i, { path: [i], seconds, miles: startMiles[i], startSeconds: seconds,
            endSeconds: 0, entrySeconds: 0, crossings: 0, passovers: 0, fingerprint: keys[i] });
    }
    for (let mask = 1; mask <= full; mask++) {
        for (let last = 0; last < size; last++) {
            for (const prior of states[mask * size + last] || []) {
                for (let next = 0; next < size; next++) {
                    if (mask & (1 << next)) continue;
                    const pair = last * size + next, seconds = secondsByPair[pair];
                    const passovers = countBits[betweenByPair[pair] & (full ^ mask) & ~(1 << next)];
                    insert(mask | (1 << next), next, { ...prior, path: [...prior.path, next],
                        seconds: prior.seconds + seconds, miles: prior.miles + milesByPair[pair],
                        crossings: prior.crossings + crossingByPair[pair], passovers: prior.passovers + passovers,
                        entrySeconds: prior.entrySeconds + (streets[last] !== streets[next] ? seconds : 0),
                        fingerprint: `${prior.fingerprint}|${keys[next]}` });
                }
            }
        }
    }
    const candidates = [];
    for (let last = 0; last < size; last++) {
        for (const prior of states[full * size + last] || []) {
            candidates.push({ ...prior, seconds: prior.seconds + endSeconds[last],
                miles: prior.miles + endMiles[last], endSeconds: endSeconds[last],
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

function rangesAwayFromUnmatched(window, failedIndexes) {
    let ranges = [window];
    for (const failed of failedIndexes) ranges = ranges.flatMap(range => {
        if (failed < range.start - 2 || failed >= range.end + 2) return [range];
        // The failed pin and its two neighbors on either side stay fixed.
        // The neighbors become valid, unchanged context for either repair;
        // including the failed pin in a child's context would fail again.
        return [
            { ...range, end: Math.min(range.end, failed - 2) },
            { ...range, start: Math.max(range.start, failed + 3) },
        ].filter(child => child.end - child.start >= 3);
    });
    return ranges;
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
    const unmatchedIds = new Set([
        ...(options.unresolvedStopIds || []).map(String),
        ...order.filter(p => p.routing_access?.resolution_status === 'unresolved').map(id),
    ]);
    const unmatchedIndexes = () => order.flatMap((p, i) => unmatchedIds.has(id(p)) ? [i] : []);
    const mailCarrier = options.mailCarrierMode === true;
    const areaWindows = options.areaDrivingReview !== false ? planDrivingAreaWindows(order, options) : [];
    report.areaReview = { planned: areaWindows.length, checked: 0, repaired: 0, candidatesMeasured: 0 };
    const ranges = new Map();
    for (const window of [...areaWindows, ...(mailCarrier ? planMailCarrierWindows(order, options) : []),
        ...planLocalDrivingWindows(order, options).map(window => ({ ...window, local: true }))]) {
        const key = `${window.start}:${window.end}`;
        ranges.set(key, { ...ranges.get(key), ...window });
    }
    const windows = [...ranges.values()]
        .map(window => ({ ...window, priority: windowExcessMiles(order, window) }))
        .sort((a, b) => Number(Boolean(b.area)) - Number(Boolean(a.area))
            || Number(Boolean(b.service)) - Number(Boolean(a.service)) || b.priority - a.priority || a.start - b.start);
    const scheduled = new Map(windows.map(window => [`${window.start}:${window.end}`, window]));
    const unscheduled = children => children.filter(child => {
        const key = `${child.start}:${child.end}`, existing = scheduled.get(key);
        if (existing) {
            for (const flag of ['area', 'service', 'local']) existing[flag] ||= child[flag];
            return false;
        }
        scheduled.set(key, child);
        return true;
    });
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
    const retryInferredHeading = async (section, run) => {
        for (let retry = 0; retry < 9; retry++) {
            try { return await run(); }
            catch (error) {
                fatal(error);
                const coordinate = /NoSegment.*coordinate (\d+)/i.exec(error.message);
                const key = coordinate && id(section[Number(coordinate[1])]);
                // Only an inferred curb constraint may be removed. The source
                // pin and the provider's fixed road-match radius stay intact.
                if (!key || !inferredAccess.has(key) || retry === 8) throw error;
                inferredAccess.delete(key);
            }
        }
    };
    for (let index = 0; index < windows.length; index++) {
        if (report.checked >= maxWindows || Date.now() >= deadline) { report.budgetExhausted = true; break; }
        if (options.signal?.aborted) throw options.signal.reason || new DOMException('Cancelled', 'AbortError');
        const safeRanges = rangesAwayFromUnmatched(windows[index], unmatchedIndexes());
        if (safeRanges.length !== 1 || safeRanges[0].start !== windows[index].start || safeRanges[0].end !== windows[index].end) {
            windows.splice(index, 1, ...unscheduled(safeRanges));
            report.planned = windows.length;
            index--;
            continue;
        }
        const { start, end, service, area, local } = windows[index];
        const left = order.slice(Math.max(0, start - 2), start);
        const right = order.slice(end, end + 2);
        if (!left.length && options.startLocation) left.push(options.startLocation);
        if (!right.length && options.endLocation) right.push(options.endLocation);
        const stops = order.slice(start, end), section = [...left, ...stops, ...right];
        report.checked++;
        if (area) report.areaReview.checked++;
        try {
            if (mailCarrier && section.some(p => !trustedAccess(accessContext.accessFor(p)) && !discovered.has(id(p)))) {
                const observation = await retryInferredHeading(section, async () => {
                    const discovery = await createContext(section, { ...contextOptions, sparseCosts: true,
                        routeOnly: true, discoverStreetSides: true });
                    return discovery.routeSequence(section);
                });
                for (const [key, access] of inferMailCarrierAccess(section, observation.streetSideEvidence)) {
                    if (!discovered.has(key) && !trustedAccess(accessContext.accessFor(section.find(p => id(p) === key)))) inferredAccess.set(key, access);
                }
                section.forEach(p => discovered.add(id(p)));
            }
            const { context, baseline } = await retryInferredHeading(section, async () => {
                const context = await createContext(section, contextOptions);
                return { context, baseline: await context.routeSequence(section) };
            });
            // Larger area questions move whole service runs. The existing
            // bounded door search still handles local branch/return details.
            const exactCandidates = (!area || service || local) && stops.length <= 12
                ? buildLocalDrivingCandidates(stops, context, left.at(-1), right[0], options) : [];
            let candidates = [
                ...(area ? buildDrivingAreaCandidates(stops, context, left.at(-1), right[0], options) : []),
                ...(service || (area && mailCarrier) ? buildMailCarrierCandidates(stops, context, left.at(-1), right[0]) : []),
                ...exactCandidates,
            ];
            if (service || area) candidates.sort((a, b) => a.seconds - b.seconds || a.miles - b.miles);
            candidates = [...new Map(candidates.map(c => [JSON.stringify(c.order.map(id)), c])).values()];
            if (mailCarrier) candidates = candidates.filter(candidate => hasCoherentMailCarrierPasses([...left, ...candidate.order, ...right], context));
            if ((service || area) && !candidates.length) continue;
            if (!candidates.length) { report.skipped.push({ start, end, reason: 'unreachable_local_roads' }); continue; }
            let selected = stops, selectedCandidate = null, best = baseline, bestPreference = preferenceFor(stops, context);
            for (const candidate of candidates.slice(0, maxCandidates)) {
                if (Date.now() >= deadline) { report.budgetExhausted = true; break; }
                if (candidate.order.every((p, i) => p === stops[i])) continue;
                const proposed = [...left, ...candidate.order, ...right];
                let measured;
                try { measured = await context.routeSequence(proposed); }
                catch (error) { fatal(error); report.skipped.push({ start, end, candidate: true, reason: error.message }); continue; }
                report.candidatesMeasured++;
                if (candidate.areaMove) report.areaReview.candidatesMeasured++;
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
                selected = candidate.order; selectedCandidate = candidate; best = measured; bestPreference = preference;
            }
            if (selected !== stops) {
                order.splice(start, stops.length, ...selected);
                report.repaired++; report.localMilesSaved += baseline.distanceMiles - best.distanceMiles;
                report.localSecondsSaved += baseline.driveSeconds - best.driveSeconds;
                if (selectedCandidate?.areaMove) report.areaReview.repaired++;
            }
        } catch (error) {
            fatal(error);
            report.skipped.push({ start, end, reason: error.message });
            // A bad pin stays in its exact slot. Review the bounded runs on
            // either side instead of abandoning all the other neighborhoods.
            const match = /NoSegment.*coordinate (\d+)/i.exec(error.message);
            if (match) {
                const failed = section[Number(match[1])];
                if (failed && order.includes(failed)) {
                    unmatchedIds.add(id(failed));
                    const children = unscheduled(rangesAwayFromUnmatched({ start, end, service, area, local }, unmatchedIndexes()));
                    windows.splice(index + 1, 0, ...children);
                    report.planned = windows.length;
                }
            }
        }
    }
    if (order.length !== original.length || new Set(order.map(id)).size !== original.length
        || order.some(p => !identities.includes(id(p)))) throw new Error('Local driving review changed route membership.');
    original.forEach((stop, i) => { if (protectedStop(stop, locks) && order[i] !== stop) throw new Error('Local driving review moved a locked stop.'); });
    for (const failed of original.flatMap((p, i) => unmatchedIds.has(id(p)) ? [i] : [])) {
        for (let i = Math.max(0, failed - 2); i <= Math.min(order.length - 1, failed + 2); i++) {
            if (order[i] !== original[i]) throw new Error('Local driving review moved an unresolved stop boundary.');
        }
    }
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
