// Local door search complements the global street-block search. Street names
// are discovery hints, not indivisible service units: a branch visit may sit
// between the outbound and return stops on its parent street.
import { haversineMiles } from './routeContinuityOptimizer.js';
import { neighborhoodStreetKey } from './neighborhoodExcursions.js';
import { createVehicleRoutingContext } from './vehicleRouting.js';
import { trustedAccess } from './streetSideRouting.js';
import { buildMailCarrierCandidates, inferMailCarrierAccess, mailCarrierPassViolations, planMailCarrierWindows } from './mailCarrierRouting.js';
import { buildDrivingAreaCandidates, planDrivingAreaWindows } from './drivingAreaRouting.js';
import { buildDrivingAreaDoorCandidates } from './drivingAreaDoorSearch.js';
import { planShortDrivingWindows } from './shortDrivingWindows.js';
import { createRoadSearchCoverage } from './roadSearchCoverage.js';
import { isRoadSearchProof } from './roadSearchProof.js';

export const LOCAL_DRIVING_REVIEW_VERSION = 'entry_branch_return_v7_search_coverage';
const id = p => String(p?.address_hash || p?.legacy_hash || p?.id || '');
const protectedStop = (p, locks) => locks.has(id(p)) || p.order_locked || p.locked
    || p.routing_access?.resolution_status === 'unresolved';
// How many upcoming windows have their road context fetched while the current
// one is reviewed. Each costs one table and one route request; the dispatcher's
// concurrency cap still bounds the engine load.
const CONTEXT_LOOKAHEAD = 8;
// Candidate orders for one window priced at once: the default candidate count.
// The private gateway serves 16 requests at once, so a window's proposals no
// longer need to queue behind each other.
const CANDIDATE_POOL = 3;
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

function balanceDrivingWindows(windows) {
    // Each scale gets work before another scale consumes the finite budget.
    // A detailed window may also be a service/area window; process it once.
    const queues = [[], [], []];
    for (const window of windows) queues[window.local ? 1 : window.area ? 0 : 2].push(window);
    for (const queue of queues) queue.sort((a, b) => b.priority - a.priority || a.start - b.start);
    const result = [];
    for (let index = 0; queues.some(queue => index < queue.length); index++) {
        for (const queue of queues) if (queue[index]) result.push(queue[index]);
    }
    return result;
}

function searchFingerprint(candidate) {
    if (candidate.fingerprint === null) candidate.fingerprint = `${searchFingerprint(candidate.previous)}|${candidate.stopKey}`;
    return candidate.fingerprint;
}

function compareSearch(a, b) {
    // Keep tolerances small and separate from the final continuous-drive guard.
    if (Math.abs(a.seconds - b.seconds) > 0.1) return a.seconds - b.seconds;
    if (Math.abs(a.miles - b.miles) > 0.0001) return a.miles - b.miles;
    const numeric = a.crossings - b.crossings || a.passovers - b.passovers
        || a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds
        || a.entrySeconds - b.entrySeconds;
    if (numeric) return numeric;
    const first = searchFingerprint(a), second = searchFingerprint(b);
    return first < second ? -1 : first > second ? 1 : 0;
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
        insert(1 << i, i, { previous: null, stopIndex: i, stopKey: keys[i], seconds, miles: startMiles[i], startSeconds: seconds,
            endSeconds: 0, entrySeconds: 0, crossings: 0, passovers: 0, fingerprint: keys[i] });
    }
    for (let mask = 1; mask <= full; mask++) {
        for (let last = 0; last < size; last++) {
            for (const prior of states[mask * size + last] || []) {
                for (let next = 0; next < size; next++) {
                    if (mask & (1 << next)) continue;
                    const pair = last * size + next, seconds = secondsByPair[pair];
                    const passovers = countBits[betweenByPair[pair] & (full ^ mask) & ~(1 << next)];
                    // Most DP transitions are immediately discarded. Keep a
                    // predecessor link instead of copying the full path and
                    // identity string; materialize those only for a tie or a
                    // returned choice. Search order, quotas and sorting remain
                    // identical, including the tolerant cost comparator.
                    insert(mask | (1 << next), next, { previous: prior, stopIndex: next, stopKey: keys[next],
                        seconds: prior.seconds + seconds, miles: prior.miles + milesByPair[pair],
                        crossings: prior.crossings + crossingByPair[pair], passovers: prior.passovers + passovers,
                        startSeconds: prior.startSeconds, endSeconds: prior.endSeconds,
                        entrySeconds: prior.entrySeconds + (streets[last] !== streets[next] ? seconds : 0),
                        fingerprint: null });
                }
            }
        }
    }
    const candidates = [];
    for (let last = 0; last < size; last++) {
        for (const prior of states[full * size + last] || []) {
            const path = [];
            for (let state = prior; state; state = state.previous) path.push(state.stopIndex);
            path.reverse();
            candidates.push({ path, seconds: prior.seconds + endSeconds[last],
                miles: prior.miles + endMiles[last], startSeconds: prior.startSeconds, endSeconds: endSeconds[last],
                entrySeconds: prior.entrySeconds, crossings: prior.crossings, passovers: prior.passovers,
                fingerprint: searchFingerprint(prior), order: path.map(i => stops[i]) });
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

function plannedDrivingWindows(order, options, unmatchedIds, rank = true) {
    const explicit = Array.isArray(options.reviewWindows) ? options.reviewWindows : null;
    const areas = options.areaDrivingReview !== false ? planDrivingAreaWindows(order, options) : [];
    const failed = order.flatMap((p, i) => unmatchedIds.has(id(p)) ? [i] : []);
    const ranges = new Map();
    for (const window of explicit || [...areas, ...(options.mailCarrierMode === true ? planMailCarrierWindows(order, options) : []),
        ...planLocalDrivingWindows(order, options).map(window => ({ ...window, local: true }))]) {
        for (const safe of rangesAwayFromUnmatched(window, failed)) {
            const key = `${safe.start}:${safe.end}`;
            ranges.set(key, { ...ranges.get(key), ...safe });
        }
    }
    return rank ? balanceDrivingWindows([...ranges.values()].map(window => ({ ...window,
        priority: window.short && Number.isFinite(window.priority) ? window.priority : windowExcessMiles(order, window) })))
        : [...ranges.values()];
}

async function reviewDrivingWindows(order, options = {}) {
    const reviewStarted = Date.now();
    const timings = { curb_discovery_ms: 0, road_context_ms: 0, candidate_search_ms: 0, candidate_measurement_ms: 0 };
    const timed = async (stage, run) => {
        const started = Date.now();
        try { return await run(); } finally { timings[stage] += Date.now() - started; }
    };
    const finish = result => ({ ...result, diagnostics: { ...result.diagnostics,
        timings: { ...timings, total_ms: Date.now() - reviewStarted } } });
    const identities = order.map(id);
    const routeIdentities = new Set(identities);
    if (identities.some(key => !key) || new Set(identities).size !== order.length) throw new Error('Local driving review requires unique stop membership.');
    const locks = new Set((options.lockedStopIds || []).map(String));
    if ([...locks].some(key => !identities.includes(key))) throw new Error('Locked stop is not in route membership.');
    const report = { version: LOCAL_DRIVING_REVIEW_VERSION, status: 'checked', planned: 0, checked: 0, reused: 0,
        repaired: 0, candidatesMeasured: 0, localMilesSaved: 0, localSecondsSaved: 0,
        skipped: [], budgetExhausted: false, validation: 'unchanged', applied: false };
    const original = order;
    order = [...order];
    const unmatchedIds = new Set([
        ...(options.unresolvedStopIds || []).map(String),
        ...order.filter(p => p.routing_access?.resolution_status === 'unresolved').map(id),
        ...(options._roadSearchCoverage?.unmatchedIds || []),
    ]);
    const unmatchedIndexes = () => order.flatMap((p, i) => unmatchedIds.has(id(p)) ? [i] : []);
    const mailCarrier = options.mailCarrierMode === true;
    const explicitWindows = Array.isArray(options.reviewWindows) ? options.reviewWindows : null;
    if (explicitWindows?.some(window => !Number.isInteger(window.start) || !Number.isInteger(window.end)
        || window.start < 0 || window.end > order.length || window.end - window.start < 3 || window.end - window.start > 12)) {
        throw new Error('Local driving review received invalid window membership.');
    }
    const coverage = options._roadSearchCoverage?.state;
    const proof = options._roadSearchCoverage?.proof;
    const questionKey = window => coverage?.key(order, window, { ...options, unresolvedStopIds: [...unmatchedIds] });
    const planned = plannedDrivingWindows(order, options, unmatchedIds);
    const windows = coverage ? coverage.prioritize(planned, questionKey) : planned;
    report.areaReview = { planned: windows.filter(window => window.area).length, checked: 0, repaired: 0, candidatesMeasured: 0 };
    const scheduled = new Map(windows.map(window => [`${window.start}:${window.end}`, window]));
    const unscheduled = children => {
        const additions = children.filter(child => {
            const key = `${child.start}:${child.end}`, existing = scheduled.get(key);
            if (existing) {
                for (const flag of ['area', 'service', 'local']) existing[flag] ||= child[flag];
                return false;
            }
            scheduled.set(key, child);
            return true;
        });
        return coverage ? coverage.prioritize(additions, questionKey) : additions;
    };
    report.planned = windows.length;
    // Checks per pass and their time budget, from the 1,000-stop sweep on the
    // custom road server (Hickory and Charlotte 1H): 150 checks in 60 s finish a
    // big route's review in fewer passes (1H: every check done in 6 passes,
    // where 64 per pass left checks open after 8).
    const maxWindows = Math.max(0, Math.min(200, options.maxLocalWindows ?? 150));
    const deadline = Date.now() + Math.max(1, Math.min(60000, options.localReviewBudgetMs ?? 60000));
    const maxCandidates = Math.max(1, Math.min(8, options.maxLocalCandidates || 3));
    const contextOptions = { ...options, startLocation: null, endLocation: null, maxGeometryPoints: 100000,
        requireDirectedLegs: true, servicePolicy: { enabled: false, parkingSecondsPerStop: 0 } };
    const inferredAccess = proof?.inferredAccess || new Map(), discovered = proof?.discovered || new Set();
    const accessContext = { accessFor: p => {
        const known = options.knownDrivingAccessFor?.(p);
        return trustedAccess(p.routing_access) ? p.routing_access : trustedAccess(known) ? known
            : inferredAccess.get(id(p)) || p.routing_access || known || null;
    }, streetSegmentKey: neighborhoodStreetKey };
    const createContext = options.createLocalDrivingContext || ((points, config) => createVehicleRoutingContext(points, accessContext, config));
    // Section geometry for a window, exactly as the review loop builds it.
    const sectionFor = ({ start, end }) => {
        const left = order.slice(Math.max(0, start - 2), start);
        const right = order.slice(end, end + 2);
        if (!left.length && options.startLocation) left.push(options.startLocation);
        if (!right.length && options.endLocation) right.push(options.endLocation);
        const stops = order.slice(start, end);
        return { left, right, stops, section: [...left, ...stops, ...right] };
    };
    // Prefetched road context is reused only when the section's stops AND the
    // road access each stop would be routed with are exactly what the review
    // would request now. A repair upstream or new curb evidence changes the
    // snapshot, and the window is then fetched fresh. Same requests, same graph,
    // same answers: prefetching changes timing, never a decision.
    const sectionSnapshot = section => JSON.stringify(section.map(p => [id(p) || `${p.lat},${p.lng}`, accessContext.accessFor(p) || null]));
    const needsCurbDiscovery = section => mailCarrier && options.inferStreetSides !== false
        && section.some(p => (!proof || routeIdentities.has(id(p))) && !trustedAccess(accessContext.accessFor(p)) && !discovered.has(id(p)));
    // A prefetched section never shares a stop with the current section or with
    // another pending prefetch, so an unmatched pin costs one provider request,
    // exactly as in a one-window-at-a-time review: no two in-flight requests can
    // discover the same bad pin.
    const prefetched = new Map();
    const prefetchFrom = (index, currentSection) => {
        const claimed = new Set(currentSection.map(id));
        for (const entry of prefetched.values()) for (const key of entry.ids) claimed.add(key);
        const scheduledBefore = new Set(claimed);
        // Never fetch past the remaining window budget or the time budget.
        const lookahead = Date.now() >= deadline ? 0 : Math.min(maxWindows - report.checked,
            Math.max(0, Math.min(16, options.contextLookahead ?? CONTEXT_LOOKAHEAD)));
        const orderNow = [...order];
        for (let next = index + 1; next < Math.min(windows.length, index + 1 + lookahead); next++) {
            const window = windows[next];
            const key = `${window.start}:${window.end}`;
            if (prefetched.has(key)) continue;
            const parts = sectionFor(window), { section } = parts;
            const ids = section.map(id);
            const touchesPending = ids.some(stopId => claimed.has(stopId));
            const touchesEarlier = ids.some(stopId => scheduledBefore.has(stopId));
            // Every window scheduled before a candidate claims its stops for
            // discovery purposes, whether or not it is evaluated ahead itself.
            ids.forEach(stopId => scheduledBefore.add(stopId));
            // Plain evaluation is revalidated at commit (snapshot), so it only
            // needs to avoid the current window and pending look-aheads. Curb
            // discovery writes shared inferred access, so it may run early only
            // when no earlier-scheduled window could touch those stops first.
            const discovers = needsCurbDiscovery(section);
            if (touchesPending || (discovers && touchesEarlier)) continue;
            ids.forEach(stopId => claimed.add(stopId));
            const entry = { snapshot: null, ids, discovers, discovery: null, fetched: null };
            entry.discovery = discovers ? discoverCurbs(section).then(() => null, error => ({ error })) : Promise.resolve(null);
            entry.fetched = (async () => {
                if ((await entry.discovery)?.error) return null;
                entry.snapshot = sectionSnapshot(section);
                // A question the search proof already certifies is reused
                // without any road request; prefetch must not spend one on it.
                if (proof && proof.has(await proof.key(orderNow, window, { ...options,
                    unresolvedStopIds: [...unmatchedIds], knownDrivingAccessFor: accessContext.accessFor }))) return null;
                const context = await createContext(section, contextOptions);
                const baseline = await context.routeSequence(section);
                // The whole window is evaluated ahead; only its commit waits.
                return { context, baseline, evaluation: await evaluateWindow(window, parts, context, baseline) };
            })().catch(error => ({ error }));
            prefetched.set(key, entry);
        }
    };
    // The prefetch result for this exact section, or null to fetch fresh. A
    // failed prefetch is this window's first attempt, not an extra one.
    const takePrefetched = async (window, section) => {
        const key = `${window.start}:${window.end}`, entry = prefetched.get(key);
        prefetched.delete(key);
        if (!entry) return null;
        const fetched = await entry.fetched;
        return entry.snapshot !== null && entry.snapshot === sectionSnapshot(section) ? fetched : null;
    };
    // Everything a window decides depends only on its own section: the road
    // context, its candidate orders and their measured drives. This computes
    // that, without touching shared state, so it can run ahead of the commit.
    const evaluateWindow = async (window, { left, right, stops, section }, context, baseline) => {
        const { service, area, local } = window;
        const searchStarted = Date.now();
        const exactCandidates = (!area || service || local) && stops.length <= 12
            ? buildLocalDrivingCandidates(stops, context, left.at(-1), right[0], options) : [];
        const areaCandidates = area ? buildDrivingAreaCandidates(stops, context, left.at(-1), right[0], options) : [];
        const serviceCandidates = service || (area && mailCarrier)
            ? buildMailCarrierCandidates(stops, context, left.at(-1), right[0]) : [];
        const priorViolations = mailCarrier ? mailCarrierPassViolations(section, context) : 0;
        const acceptablePasses = candidateOrder => !mailCarrier
            || mailCarrierPassViolations([...left, ...candidateOrder, ...right], context) <= priorViolations;
        let candidates = [
            ...areaCandidates,
            ...serviceCandidates,
            ...(area ? buildDrivingAreaDoorCandidates(stops, context, left.at(-1), right[0], {
                lockedStopIds: options.lockedStopIds,
                seedOrders: [...serviceCandidates, ...areaCandidates].map(candidate => candidate.order),
                acceptOrder: acceptablePasses,
            }).map(candidate => ({ ...candidate, areaMove: true })) : []),
            ...exactCandidates,
        ];
        if (service || area) candidates.sort((a, b) => a.seconds - b.seconds || a.miles - b.miles);
        candidates = [...new Map(candidates.filter(candidate => candidate.order.some((p, i) => id(p) !== id(stops[i])))
            .map(c => [JSON.stringify(c.order.map(id)), c])).values()];
        if (mailCarrier) {
            // Fixed context may already contain an unavoidable violation.
            // Permit measured reductions without introducing a new one.
            candidates = candidates.filter(candidate => acceptablePasses(candidate.order));
        }
        const searchMs = Date.now() - searchStarted;
        const considered = candidates.slice(0, maxCandidates);
        // At most CANDIDATE_POOL proposals are priced at once, and the next one
        // starts as soon as a slot frees rather than when the batch returns. Results
        // are consumed in the original order, so ties and adoption stay
        // deterministic. Once a cancellation, a graph change or the deadline is
        // seen, nothing new starts; already-started work is drained first.
        const outcomes = new Array(considered.length);
        let launched = 0, deadlineHit = false;
        const measureStarted = Date.now();
        if (considered.length) await new Promise(resolveAll => {
            let active = 0, halted = false;
            const launch = () => {
                while (!halted && active < CANDIDATE_POOL && launched < considered.length) {
                    if (options.signal?.aborted) { halted = true; break; }
                    if (Date.now() >= deadline) { deadlineHit = true; halted = true; break; }
                    const index = launched++, candidate = considered[index];
                    active++;
                    context.routeSequence([...left, ...candidate.order, ...right])
                        .then(measured => ({ measured }), error => ({ error }))
                        .then(outcome => {
                            outcomes[index] = outcome; active--;
                            if (outcome.error) { try { fatal(outcome.error); } catch { halted = true; } }
                            launch();
                            if (active === 0) resolveAll();
                        });
                }
                if (active === 0) resolveAll();
            };
            launch();
        });
        return { candidates, exactCount: exactCandidates.length, considered, outcomes, launched, deadlineHit,
            searchMs, measureMs: Date.now() - measureStarted };
    };
    // Mail-carrier curb discovery for one section. It writes inferred access
    // only for that section's own stops.
    const discoverCurbs = async section => {
        const observation = await retryInferredHeading(section, async () => {
            const discovery = await createContext(section, { ...contextOptions, sparseCosts: true,
                routeOnly: true, discoverStreetSides: true });
            return discovery.routeSequence(section);
        });
        for (const [key, access] of inferMailCarrierAccess(section, observation.streetSideEvidence)) {
            if ((!proof || routeIdentities.has(key)) && !discovered.has(key)
                && !trustedAccess(accessContext.accessFor(section.find(p => id(p) === key)))) inferredAccess.set(key, access);
        }
        section.forEach(p => { if (!proof || routeIdentities.has(id(p))) discovered.add(id(p)); });
    };
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
            prefetched.delete(`${windows[index].start}:${windows[index].end}`);
            windows.splice(index, 1, ...unscheduled(safeRanges));
            report.planned = windows.length;
            index--;
            continue;
        }
        const { start, end, service, area, local } = windows[index];
        const { left, right, stops, section } = sectionFor(windows[index]);
        const coverageKey = questionKey(windows[index]);
        let fullyConsidered = false, unchanged = true, certifiedKey = null, attempted = false;
        const markAttempt = () => {
            if (attempted) return;
            attempted = true; coverage?.attempt(); report.checked++;
            if (area) report.areaReview.checked++;
        };
        const currentProofKey = () => proof.key(order, windows[index], { ...options,
            unresolvedStopIds: [...unmatchedIds], knownDrivingAccessFor: accessContext.accessFor });
        const advance = prefetched.get(`${start}:${end}`);
        try {
            if (advance?.discovers) {
                markAttempt();
                const outcome = await timed('curb_discovery_ms', () => advance.discovery);
                if (outcome?.error) { prefetched.delete(`${start}:${end}`); throw outcome.error; }
            } else if (needsCurbDiscovery(section)) {
                markAttempt();
                await timed('curb_discovery_ms', () => discoverCurbs(section));
            }
            if (proof) {
                certifiedKey = await currentProofKey();
                if (proof.has(certifiedKey)) {
                    coverage?.reuse(certifiedKey); report.reused++;
                    continue;
                }
            }
            markAttempt();
            let evaluation = null;
            const { context, baseline } = await timed('road_context_ms', async () => {
                const early = await takePrefetched(windows[index], section);
                if (early?.context) {
                    prefetchFrom(index, section);
                    evaluation = early.evaluation || null;
                    return early;
                }
                let firstError = early?.error || null;
                // This window's own request starts first; later windows are
                // fetched behind it, never ahead of it.
                const own = retryInferredHeading(section, async () => {
                    if (firstError) { const error = firstError; firstError = null; throw error; }
                    const context = await createContext(section, contextOptions);
                    return { context, baseline: await context.routeSequence(section) };
                });
                prefetchFrom(index, section);
                return own;
            });
            // A failed inferred heading can be removed while building the
            // baseline. Certify the policy actually used by the candidates.
            if (proof) certifiedKey = await currentProofKey();
            // Whole-run moves cannot repair a scrambled long street inside an
            // area. Ask bounded directed door questions as well; all proposals
            // still need the same continuous drive and unchanged boundary proof.
            if (!evaluation) evaluation = await evaluateWindow(windows[index], { left, right, stops, section }, context, baseline);
            const { candidates, exactCount, considered, outcomes, launched, deadlineHit } = evaluation;
            timings.candidate_search_ms += evaluation.searchMs;
            timings.candidate_measurement_ms += evaluation.measureMs;
            fullyConsidered = true;
            if ((service || area || exactCount) && !candidates.length) continue;
            if (!candidates.length) { fullyConsidered = false; report.skipped.push({ start, end, reason: 'unreachable_local_roads' }); continue; }
            if (deadlineHit) { fullyConsidered = false; report.budgetExhausted = true; }
            let selected = stops, selectedCandidate = null, best = baseline, bestPreference = preferenceFor(stops, context);
            if (options.signal?.aborted) throw options.signal.reason || new DOMException('Cancelled', 'AbortError');
            for (const outcome of outcomes) if (outcome?.error) fatal(outcome.error);
            for (let index = 0; index < launched; index++) {
                const candidate = considered[index];
                const { measured, error } = outcomes[index];
                if (error) { fullyConsidered = false; report.skipped.push({ start, end, candidate: true, reason: error.message }); continue; }
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
                const candidatePasses = mailCarrier ? mailCarrierPassViolations([...left, ...candidate.order, ...right], context) : 0;
                const selectedPasses = mailCarrier ? mailCarrierPassViolations([...left, ...selected, ...right], context) : 0;
                if (candidatePasses > selectedPasses) continue;
                const fixesPasses = candidatePasses < selectedPasses;
                if ((!fixesPasses || options.requireNoDrivingIncrease) && !improves(measured, best, preference, bestPreference)) continue;
                selected = candidate.order; selectedCandidate = candidate; best = measured; bestPreference = preference;
            }
            if (selected !== stops) {
                unchanged = false;
                order.splice(start, stops.length, ...selected);
                report.repaired++; report.localMilesSaved += baseline.distanceMiles - best.distanceMiles;
                report.localSecondsSaved += baseline.driveSeconds - best.driveSeconds;
                if (selectedCandidate?.areaMove) report.areaReview.repaired++;
            }
        } catch (error) {
            markAttempt();
            fullyConsidered = false;
            fatal(error);
            report.skipped.push({ start, end, reason: error.message });
            // A bad pin stays in its exact slot. Review the bounded runs on
            // either side instead of abandoning all the other neighborhoods.
            const match = /NoSegment.*coordinate (\d+)/i.exec(error.message);
            if (match) {
                const failed = section[Number(match[1])];
                if (failed && order.includes(failed)) {
                    unmatchedIds.add(id(failed));
                    options._roadSearchCoverage?.unmatchedIds.add(id(failed));
                    const children = unscheduled(rangesAwayFromUnmatched(windows[index], unmatchedIndexes()));
                    windows.splice(index + 1, 0, ...children);
                    report.planned = windows.length;
                }
            }
        } finally {
            // A window is decided once; its look-ahead entry no longer claims stops.
            prefetched.delete(`${start}:${end}`);
            if (fullyConsidered) {
                coverage?.complete(proof ? certifiedKey : coverageKey);
                if (proof && unchanged && certifiedKey && Date.now() < deadline && !options.signal?.aborted) proof.complete(certifiedKey);
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
    if (!report.repaired) return finish({ properties: original, diagnostics: report, accessFor: accessContext.accessFor });
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
        const worseThan = (measurement, priorOrder, strictDriving = false) => {
            const priorPasses = mailCarrier ? mailCarrierPassViolations(priorOrder, accessContext) : 0;
            return afterPasses > priorPasses || ((strictDriving || afterPasses === priorPasses)
                && (after.driveSeconds > measurement.driveSeconds + 0.1 || after.distanceMiles > measurement.distanceMiles + 0.0001));
        };
        if (worseThan(before, original, options.requireNoDrivingIncrease) || worseThan(baseline, options.baselineOrder || original)) {
            return finish({ properties: original, accessFor: accessContext.accessFor,
                diagnostics: { ...report, applied: false, status: 'whole_route_guard_retained', validation: 'whole_route' } });
        }
        report.validation = 'whole_route';
        return finish({ properties: order, diagnostics: report, measurement: after, baseline,
            previousMeasurement: before, accessFor: accessContext.accessFor });
    } catch (error) {
        fatal(error);
        // Outages, malformed geometry and changed turn continuity are not
        // access uncertainty. Only a named unmatched pin permits local proof.
        if (!/NoSegment|outside the fixed road-match radius|different service road/i.test(error.message)) {
            return finish({ properties: original, accessFor: accessContext.accessFor,
                diagnostics: { ...report, applied: false, status: 'whole_route_guard_retained', reason: error.message } });
        }
        // A partial road proof cannot excuse a known curb-pass regression
        // involving another occurrence of this street outside the window.
        if (report.streetSideService?.passViolationsAfter > report.streetSideService?.passViolationsBefore) {
            return finish({ properties: original, accessFor: accessContext.accessFor, diagnostics: { ...report, applied: false,
                status: 'whole_route_guard_retained', reason: 'Known curb-side passes would become less coherent.' } });
        }
        report.wholeRouteUnavailableReason = error.message;
        return finish({ properties: order, diagnostics: report, accessFor: accessContext.accessFor });
    }
}

async function reviewDrivingPhases(order, options = {}) {
    const phasesStarted = Date.now();
    const reviewed = await reviewDrivingWindows(order, options);
    if (options.shortDrivingCleanup !== true) return reviewed;
    const major = reviewed.diagnostics.applied ? reviewed : { ...reviewed, diagnostics: { ...reviewed.diagnostics,
        repaired: 0, localMilesSaved: 0, localSecondsSaved: 0,
        areaReview: { ...reviewed.diagnostics.areaReview, repaired: 0 },
        ...(reviewed.diagnostics.streetSideService ? { streetSideService: { ...reviewed.diagnostics.streetSideService,
            passViolationsAfter: reviewed.diagnostics.streetSideService.passViolationsBefore } } : {}) } };
    const shortWindows = planShortDrivingWindows(major.properties, options);
    const accessSnapshot = () => JSON.stringify(major.properties.map(stop => [id(stop), major.accessFor?.(stop) || null]));
    const majorAccessSnapshot = options._roadSearchCoverage?.proof ? accessSnapshot() : null;
    const count = value => Number.isFinite(value) ? value : 0;
    const combinedTimings = short => ({ ...Object.fromEntries(['curb_discovery_ms', 'road_context_ms',
        'candidate_search_ms', 'candidate_measurement_ms'].map(key =>
        [key, count(major.diagnostics.timings?.[key]) + count(short?.timings?.[key])])), total_ms: Date.now() - phasesStarted });
    const retain = shortCleanup => {
        const retained = { ...major };
        if (majorAccessSnapshot !== null && accessSnapshot() !== majorAccessSnapshot) {
            // Short cleanup shares the action's inference map. Removing an
            // infeasible heading invalidates measurements made before removal,
            // even when the short move is rejected and the main order survives.
            delete retained.measurement; delete retained.baseline; delete retained.previousMeasurement;
        }
        return { ...retained, diagnostics: { ...major.diagnostics,
        planned: count(major.diagnostics.planned) + count(shortCleanup.planned),
        checked: count(major.diagnostics.checked) + count(shortCleanup.checked),
        reused: count(major.diagnostics.reused) + count(shortCleanup.reused),
        candidatesMeasured: count(major.diagnostics.candidatesMeasured) + count(shortCleanup.candidatesMeasured),
        budgetExhausted: major.diagnostics.budgetExhausted || shortCleanup.budgetExhausted === true,
        skipped: [...(major.diagnostics.skipped || []), ...(shortCleanup.skipped || [])],
        timings: combinedTimings(shortCleanup), shortCleanup } };
    };
    if (!shortWindows.length) return retain({ status: 'not_needed', applied: false,
        planned: 0, checked: 0, repaired: 0, candidatesMeasured: 0, budgetExhausted: false });
    let cleanup;
    try {
        cleanup = await reviewDrivingWindows(major.properties, { ...options, shortDrivingCleanup: false,
            reviewWindows: shortWindows, knownDrivingAccessFor: major.accessFor, inferStreetSides: false,
            requireNoDrivingIncrease: true, baselineOrder: options.baselineOrder || order,
            maxLocalWindows: Math.min(24, shortWindows.length),
            localReviewBudgetMs: Math.max(1, Math.min(12000, Number(options.shortCleanupBudgetMs) || 8000)) });
    } catch (error) {
        fatal(error);
        if (options.signal?.aborted) throw options.signal.reason || error;
        return retain({ status: 'failed', applied: false, planned: shortWindows.length,
            checked: 0, repaired: 0, candidatesMeasured: 0, skipped: [{ reason: 'short_cleanup_unavailable' }] });
    }
    const after = cleanup.measurement, before = cleanup.previousMeasurement;
    const sameMeasurement = (a, b) => a && b && (a.dataVersion || null) === (b.dataVersion || null)
        && Math.abs(a.driveSeconds - b.driveSeconds) <= 0.1 && Math.abs(a.distanceMiles - b.distanceMiles) <= 0.0001
        && Array.isArray(a.directedLegs) && Array.isArray(b.directedLegs) && a.directedLegs.length === b.directedLegs.length
        && a.directedLegs.every((leg, i) => sameBoundaryLeg(leg, b.directedLegs[i]));
    const consistent = (!major.measurement || sameMeasurement(major.measurement, before))
        && (!major.baseline || !cleanup.baseline || sameMeasurement(major.baseline, cleanup.baseline));
    const complete = consistent && cleanup.diagnostics.applied === true && cleanup.diagnostics.validation === 'whole_route'
        && before && after && Number.isFinite(before.driveSeconds) && Number.isFinite(after.driveSeconds)
        && Number.isFinite(before.distanceMiles) && Number.isFinite(after.distanceMiles)
        && after.driveSeconds <= before.driveSeconds + 0.1 && after.distanceMiles <= before.distanceMiles + 0.0001;
    if (!complete) return retain({ ...cleanup.diagnostics, applied: false, repaired: 0,
        localMilesSaved: 0, localSecondsSaved: 0, status: cleanup.diagnostics.applied ? 'retained_major' : cleanup.diagnostics.status });
    const original = major.diagnostics, short = cleanup.diagnostics;
    const baseline = major.baseline || cleanup.baseline;
    return { ...cleanup, baseline, diagnostics: { ...original, status: short.status, applied: true, validation: 'whole_route',
        planned: count(original.planned) + count(short.planned), checked: count(original.checked) + count(short.checked),
        reused: count(original.reused) + count(short.reused),
        repaired: (original.applied ? count(original.repaired) : 0) + count(short.repaired),
        candidatesMeasured: count(original.candidatesMeasured) + count(short.candidatesMeasured),
        localMilesSaved: baseline ? baseline.distanceMiles - after.distanceMiles
            : (original.applied ? count(original.localMilesSaved) : 0) + count(short.localMilesSaved),
        localSecondsSaved: baseline ? baseline.driveSeconds - after.driveSeconds
            : (original.applied ? count(original.localSecondsSaved) : 0) + count(short.localSecondsSaved),
        budgetExhausted: original.budgetExhausted || short.budgetExhausted,
        skipped: [...(original.skipped || []), ...(short.skipped || [])], areaReview: original.areaReview,
        ...(short.streetSideService ? { streetSideService: { ...short.streetSideService,
            inferredStops: count(original.streetSideService?.inferredStops),
            passViolationsBefore: original.streetSideService?.passViolationsBefore ?? short.streetSideService.passViolationsBefore } } : {}),
        timings: combinedTimings(short), shortCleanup: short } };
}

export async function reviewLocalDrivingNeighborhoods(order, options = {}) {
    const suppliedProof = options.roadSearchProof || options.searchProof;
    if (suppliedProof && !isRoadSearchProof(suppliedProof)) throw new Error('Road search proof must be constructed by the authenticated endpoint.');
    const proof = suppliedProof || null;
    const state = createRoadSearchCoverage(options.searchCoverage, LOCAL_DRIVING_REVIEW_VERSION, { certified: Boolean(proof) });
    const unmatchedIds = new Set([...(options.unresolvedStopIds || []).map(String),
        ...order.filter(p => p.routing_access?.resolution_status === 'unresolved').map(id)]);
    const configured = { ...options, _roadSearchCoverage: { state, unmatchedIds, proof } };
    const result = await reviewDrivingPhases(order, configured);
    // Rebuild questions for the accepted order. A repair invalidates only the
    // sections whose ordered doors or fixed context changed; unrelated work
    // survives. Authenticated same-action receipts additionally bind effective
    // curb evidence; unsigned history remains only a scheduling hint.
    const finalOptions = { ...configured, unresolvedStopIds: [...unmatchedIds] };
    const keyFor = (window, settings) => proof
        ? proof.key(result.properties, window, { ...settings, knownDrivingAccessFor: result.accessFor })
        : state.key(result.properties, window, settings);
    const keys = await Promise.all(plannedDrivingWindows(result.properties, finalOptions, unmatchedIds, false)
        .map(window => keyFor(window, finalOptions)));
    if (options.shortDrivingCleanup === true) {
        const shortOptions = { ...finalOptions, knownDrivingAccessFor: result.accessFor,
            inferStreetSides: false, requireNoDrivingIncrease: true, shortDrivingCleanup: false,
            reviewWindows: planShortDrivingWindows(result.properties, finalOptions) };
        keys.push(...await Promise.all(plannedDrivingWindows(result.properties, shortOptions, unmatchedIds, false)
            .map(window => keyFor(window, shortOptions))));
    }
    if (proof) {
        proof.prune(keys);
        // Limits apply to fresh work. Valid unchanged questions outside that
        // prefix can still be certified without another provider request.
        for (const key of keys) if (proof.has(key) && !state.has(key)) state.reuse(key);
    }
    // This ephemeral field is lifted into routing_metadata by the endpoint;
    // keeping it outside diagnostics prevents nested personal-bound ledgers.
    const searchCoverage = state.report(keys);
    return { ...result, ...(proof ? { diagnostics: { ...result.diagnostics, reused: searchCoverage.reused_this_pass } } : {}), searchCoverage };
}
