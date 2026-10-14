import { haversineMiles } from './routeContinuityOptimizer.js';
import { neighborhoodStreetKey } from './neighborhoodExcursions.js';
import { mailCarrierPassViolations } from './mailCarrierRouting.js';
import { trustedAccess } from './streetSideRouting.js';

const identity = p => String(p?.address_hash || p?.legacy_hash || p?.id || '');
const bound = (value, fallback, min, max) => Number.isFinite(Number(value))
    ? Math.max(min, Math.min(max, Math.floor(Number(value)))) : fallback;
const protectedStop = (p, locks) => locks.has(identity(p)) || p?.order_locked || p?.locked
    || p?.routing_access?.resolution_status === 'unresolved';
const finiteCost = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : Infinity;

function runKey(stop, context = {}) {
    const access = context.accessFor?.(stop) || stop?.routing_access;
    if (trustedAccess(access)) return `SERVICE:${access.chainKey}`;
    const street = context.streetSegmentKey?.(stop) || neighborhoodStreetKey(stop);
    return street?.replaceAll('|', '').trim() ? `STREET:${street}` : `STOP:${identity(stop)}`;
}

// Geometry chooses larger questions to investigate, never connected work areas
// or driving savings. Overlapping windows leave room to move a complete visit
// past several other streets, rather than being limited to ten individual doors.
export function planDrivingAreaWindows(order, options = {}) {
    const maxStops = bound(options.maxAreaWindowStops, 40, 3, 40);
    const minStops = bound(options.minAreaWindowStops, Math.min(11, maxStops), 3, maxStops);
    const radius = Math.max(0.05, Math.min(2, Number(options.areaRadiusMiles) || 0.75));
    const locks = new Set((options.lockedStopIds || []).map(String));
    const keys = order.map(p => runKey(p));
    const seam = i => i === 0 || i === order.length || keys[i] !== keys[i - 1];
    const seeds = new Set();
    let runStart = 0;
    for (let i = 0; i <= order.length; i++) {
        if (i < order.length && i > 0 && !seam(i)
            && !protectedStop(order[i - 1], locks) && !protectedStop(order[i], locks)) continue;
        if (runStart < order.length) seeds.add(runStart);
        // Long streets need overlapping bounded tails so the next branch is
        // still reachable. Windows containing only that street are discarded.
        if (i - runStart > maxStops) for (let start = runStart + Math.max(1, Math.floor(maxStops / 3)); start < i;
            start += Math.max(1, Math.floor(maxStops / 3))) seeds.add(start);
        runStart = i;
    }
    const windows = [];
    let furthestEnd = 0;
    // Every existing run entrance gets a question. A short geographic window
    // on the previous street must not skip the first houses of a larger area.
    for (const start of [...seeds].sort((a, b) => a - b)) {
        if (protectedStop(order[start], locks)) continue;
        let end = start + 1;
        while (end < order.length && end - start < maxStops && !protectedStop(order[end], locks)
            && haversineMiles(order[start], order[end]) <= radius
            && haversineMiles(order[end - 1], order[end]) <= radius) end++;
        // Prefer complete existing runs when the size cap cuts through a street.
        // A long single street can still be reviewed in bounded overlapping parts.
        if (end - start === maxStops && !seam(end)) {
            let prior = end - 1;
            while (prior > start && !seam(prior)) prior--;
            if (prior - start >= minStops) end = prior;
        }
        if (end - start < minStops || end <= furthestEnd || new Set(keys.slice(start, end)).size < 2) continue;
        windows.push({ start, end, area: true });
        furthestEnd = end;
    }
    return windows;
}

function contiguousUnits(stops, context) {
    const units = [];
    stops.forEach((stop, i) => {
        const key = runKey(stop, context), prior = units.at(-1);
        if (prior?.key === key) { prior.stops.push(stop); prior.end = i + 1; }
        else units.push({ key, start: i, end: i + 1, stops: [stop] });
    });
    return units;
}

function applyMove(units, move) {
    const moved = [...units];
    const segment = moved.splice(move.from, move.finish - move.from + 1);
    moved.splice(move.to > move.finish ? move.to - segment.length : move.to, 0, ...segment);
    return moved.flatMap(unit => unit.stops);
}

const compare = (a, b) => Math.abs(a.seconds - b.seconds) > 0.1 ? a.seconds - b.seconds
    : Math.abs(a.miles - b.miles) > 0.0001 ? a.miles - b.miles
        : a.from - b.from || a.finish - b.finish || a.to - b.to;

// The existing order inside each service/street run survives unchanged. Moving
// consecutive runs can finish an upper branch before visiting a lower branch,
// even when their streets share no subdivision or neighborhood label. Every
// metric is read once; six changed directed edges score each relocation in O(1).
// A caller must validate the proposed continuous drive before applying it.
export function buildDrivingAreaCandidates(stops, context, start = null, end = null, options = {}) {
    if (stops.length < 3 || stops.length > 40) return [];
    const identifiers = stops.map(identity);
    if (identifiers.some(id => !id) || new Set(identifiers).size !== stops.length) {
        throw new Error('Driving area search requires unique stop membership.');
    }
    const locks = new Set((options.lockedStopIds || []).map(String));
    const units = contiguousUnits(stops, context);
    if (units.length < 2) return [];
    const limit = bound(options.maxAreaCandidates, 24, 1, 32);
    const maxMoveUnits = bound(options.maxAreaMoveUnits, 4, 1, 4);
    const points = [...new Set([start, ...stops, end].filter(Boolean))];
    const index = new Map(points.map((p, i) => [p, i]));
    const seconds = [], miles = [];
    for (let a = 0; a < points.length; a++) for (let b = 0; b < points.length; b++) {
        const pair = a * points.length + b;
        seconds[pair] = a === b ? 0 : finiteCost(context.optimizationCostBetween(points[a], points[b]));
        miles[pair] = a === b ? 0 : finiteCost(context.distanceBetween(points[a], points[b]));
    }
    const metric = (cache, a, b) => a && b ? cache[index.get(a) * points.length + index.get(b)] : 0;
    const sum = (cache, pairs) => pairs.reduce((total, [a, b]) => total + metric(cache, a, b), 0);
    const originalPath = [start, ...stops, end].filter(Boolean);
    const originalPairs = originalPath.slice(1).map((p, i) => [originalPath[i], p]);
    const baselineSeconds = sum(seconds, originalPairs), baselineMiles = sum(miles, originalPairs);
    if (!Number.isFinite(baselineSeconds) || !Number.isFinite(baselineMiles)) return [];
    const protectedPrefix = [0];
    stops.forEach(p => protectedPrefix.push(protectedPrefix.at(-1) + Number(Boolean(protectedStop(p, locks)))));
    const first = unit => unit?.stops[0];
    const last = unit => unit?.stops.at(-1);
    const scored = [];
    for (let from = 0; from < units.length; from++) {
        for (let finish = from; finish < Math.min(units.length, from + maxMoveUnits); finish++) {
            for (let to = 0; to <= units.length; to++) {
                if (to >= from && to <= finish + 1) continue;
                const insertion = units[to]?.start ?? stops.length;
                const low = Math.min(units[from].start, insertion), high = Math.max(units[finish].end, insertion);
                // Removal and insertion shift the intervening stops too. A lock
                // protects its exact index throughout that entire changed span.
                if (protectedPrefix[high] !== protectedPrefix[low]) continue;
                const before = last(units[from - 1]) || start, after = first(units[finish + 1]) || end;
                const head = first(units[from]), tail = last(units[finish]);
                const left = last(units[to - 1]) || start, right = first(units[to]) || end;
                const oldPairs = [[before, head], [tail, after], [left, right]];
                const nextPairs = [[before, after], [left, head], [tail, right]];
                const duration = baselineSeconds - sum(seconds, oldPairs) + sum(seconds, nextPairs);
                const distance = baselineMiles - sum(miles, oldPairs) + sum(miles, nextPairs);
                if (!Number.isFinite(duration) || !Number.isFinite(distance)) continue;
                scored.push({ from, finish, to, seconds: duration, miles: distance });
            }
        }
    }
    scored.sort(compare);
    const serviceContext = { accessFor: p => context.accessFor?.(p) || p?.routing_access };
    const priorViolations = mailCarrierPassViolations(stops, serviceContext);
    const candidates = [], seen = new Set();
    for (const move of scored) {
        const order = applyMove(units, move);
        const fingerprint = order.map(identity).join('|');
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        if (mailCarrierPassViolations(order, serviceContext) > priorViolations) continue;
        candidates.push({ order, seconds: move.seconds, miles: move.miles, fingerprint,
            crossings: 0, passovers: 0, area: true, areaMove: true });
        if (candidates.length >= limit) break;
    }
    return candidates;
}
