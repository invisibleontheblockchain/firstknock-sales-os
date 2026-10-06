// One review contract for browser, workers and server optimizers. A pocket is
// evidence to investigate an excursion, never a requirement to finish it.
import { roadNetworkRoutingInternals } from './roadNetworkRouting.js';
const reports = new WeakMap();
const key = p => String(p?.address_hash || p?.legacy_hash || p?.id || '');
const label = value => String(value || '').trim().toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ');
const bounded = (value, fallback, max) => Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value))) : fallback;
const pointKey = p => [key(p), p?.lat, p?.lng, p?.routing_access?.point, p?.routing_access?.serviceBearing];
const pairKey = (a, b) => JSON.stringify([pointKey(a), pointKey(b)]);
const finiteCost = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : Infinity;

export function neighborhoodStreetKey(stop) {
    if (!label(stop?.street_name)) return '';
    return [roadNetworkRoutingInternals.normalizeStreetName(stop.street_name), label(stop?.city), String(stop?.zip_code || stop?.zip || '')].join('|');
}

function unitsFor(order, options) {
    const units = [];
    order.forEach((stop, index) => {
        const suppliedStreet = options.streetKeyFor?.(stop);
        const street = suppliedStreet?.replaceAll('|', '').trim() ? suppliedStreet : neighborhoodStreetKey(stop);
        const unitKey = street.replaceAll('|', '') ? street : `STOP:${key(stop) || index}`;
        const pocket = options.neighborhoodKeyFor?.(stop)
            || label(stop.subdivision_name || stop.neighborhood_name || stop.neighborhoodName)
            || unitKey;
        const last = units.at(-1);
        if (last?.key === unitKey && last.pocket === pocket) last.stops.push(stop);
        else units.push({ key: unitKey, pocket, stops: [stop] });
    });
    return units;
}

function excursions(units) {
    const runs = [];
    units.forEach((unit, i) => {
        if (runs.at(-1)?.pocket === unit.pocket) runs.at(-1).end = i;
        else runs.push({ pocket: unit.pocket, start: i, end: i });
    });
    const first = new Map(), last = new Map();
    runs.forEach(run => { if (!first.has(run.pocket)) first.set(run.pocket, run.start); last.set(run.pocket, run.end + 1); });
    const previous = new Map(), found = [];
    for (const run of runs) {
        const prior = previous.get(run.pocket);
        if (prior) found.push({ pocket: run.pocket, from: prior.end + 1, end: run.start - 1,
            before: first.get(run.pocket), after: last.get(run.pocket) });
        previous.set(run.pocket, run);
    }
    return found;
}

function edges(units, move, options) {
    const first = unit => unit?.stops[0];
    const last = unit => unit?.stops.at(-1);
    const before = last(units[move.from - 1]) || options.startLocation;
    const after = first(units[move.end + 1]) || options.endLocation;
    const head = first(units[move.from]), tail = last(units[move.end]);
    const left = last(units[move.to - 1]) || options.startLocation;
    const right = first(units[move.to]) || options.endLocation;
    // No internal edge is reversed or changed. These six directed boundary
    // edges account for BOTH removal and insertion, including trip anchors.
    return { old: [[before, head], [tail, after], [left, right]],
        next: [[before, after], [left, head], [tail, right]] };
}

function applyMove(units, move) {
    const result = [...units];
    const segment = result.splice(move.from, move.end - move.from + 1);
    result.splice(move.to > move.end ? move.to - segment.length : move.to, 0, ...segment);
    return result;
}

function* review(order, options) {
    if (!Array.isArray(order)) throw new Error('Neighborhood review requires an ordered stop list.');
    const identifiers = order.map(key);
    const membership = new Set(identifiers);
    if (identifiers.some(id => !id) || new Set(identifiers).size !== order.length) {
        throw new Error('Neighborhood review requires unique stop membership.');
    }
    const locked = new Set((options.lockedStopIds || []).map(String));
    for (const id of locked) if (!membership.has(id)) throw new Error('Locked stop is not in route membership.');
    const protectedStop = stop => locked.has(key(stop)) || stop.order_locked === true || stop.locked === true
        || stop.routing_access?.resolution_status === 'unresolved';
    let units = unitsFor(order, options);
    const report = { version: 1, status: 'checked', detected: excursions(units).length,
        evaluated: 0, relocated: 0, secondsSaved: 0, remaining: 0, budgetExhausted: false, unverifiedGroups: 0, unverifiedMoves: 0,
        preference: { preferContiguousOnTie: options.preferContiguousOnTie === true,
            tieSeconds: Math.min(10, Math.max(0, Number(options.tieSeconds) || 0)) } };
    const finish = () => {
        const flattened = units.flatMap(unit => unit.stops);
        const properties = flattened.every((stop, i) => stop === order[i]) ? order : flattened;
        if (properties.length !== order.length || new Set(properties.map(key)).size !== order.length
            || properties.some(stop => !membership.has(key(stop)))) throw new Error('Neighborhood relocation changed membership.');
        order.forEach((stop, i) => {
            if (protectedStop(stop) && properties[i] !== stop) throw new Error('Neighborhood relocation moved a locked stop.');
        });
        report.remaining = excursions(units).length;
        reports.set(properties, Object.freeze(report));
        return { properties, diagnostics: report };
    };
    if (!options.roadVerified || typeof options.costBetween !== 'function') {
        report.status = 'road_evidence_unavailable';
        return finish();
    }
    if (!report.detected) return finish();
    // Labels may repeat across disconnected areas. Require bounded, reciprocal
    // ROAD access to a stable member before sharing a neighborhood key.
    const groups = new Map();
    units.forEach(unit => {
        if (!groups.has(unit.pocket)) groups.set(unit.pocket, []);
        groups.get(unit.pocket).push(unit);
    });
    const pairs = [];
    for (const group of groups.values()) {
        if (group.length < 2) continue;
        const root = [...group.flatMap(unit => unit.stops)].sort((a, b) => key(a).localeCompare(key(b)))[0];
        group.forEach(unit => { pairs.push([root, unit.stops[0]], [unit.stops[0], root]); });
    }
    const roadCost = yield pairs;
    const maxPocketSeconds = Math.max(1, Number(options.maxNeighborhoodTravelSeconds) || 600);
    for (const group of groups.values()) {
        if (group.length < 2) continue;
        const root = [...group.flatMap(unit => unit.stops)].sort((a, b) => key(a).localeCompare(key(b)))[0];
        group.forEach(unit => {
            const accessCost = Math.max(roadCost(root, unit.stops[0]), roadCost(unit.stops[0], root));
            if (!Number.isFinite(accessCost)) { report.unverifiedGroups++; report.status = 'partial_road_evidence'; }
            if (accessCost > maxPocketSeconds) {
                unit.pocket = `UNCONNECTED:${key(unit.stops[0])}`;
            }
        });
    }
    const limit = bounded(options.maxEvaluations, 10000, 50000);
    const passes = bounded(options.maxPasses, 3, 10);
    const maxOutside = bounded(options.maxOutsideUnits, 32, 1000);
    for (let pass = 0; pass < passes; pass++) {
        const found = excursions(units);
        if (!found.length) break;
        const candidates = [], seen = new Set();
        const protectedPrefix = [0];
        units.forEach(unit => protectedPrefix.push(protectedPrefix.at(-1) + Number(unit.stops.some(protectedStop))));
        for (const excursion of found) {
            if (excursion.end - excursion.from + 1 > maxOutside) { report.budgetExhausted = true; continue; }
            // Always examine before-entry and after-exit first, then every other
            // route slot, until the deterministic evaluation budget is spent.
            const slots = new Set([excursion.before, excursion.after, 0, units.length,
                ...Array.from({ length: units.length + 1 }, (_, i) => i)]);
            for (const to of slots) {
                if (to >= excursion.from && to <= excursion.end + 1) continue;
                const move = { from: excursion.from, end: excursion.end, to };
                const identity = `${move.from}:${move.end}:${to}`;
                if (seen.has(identity)) continue;
                seen.add(identity);
                // Relocation shifts the intervening stops. Protect their exact
                // indices too, not just stops inside the moved outside run.
                if (protectedPrefix[Math.max(move.end + 1, to)] > protectedPrefix[Math.min(move.from, to)]) continue;
                if (report.evaluated + candidates.length >= limit) { report.budgetExhausted = true; break; }
                candidates.push({ ...move, edges: edges(units, move, options) });
            }
            if (report.evaluated + candidates.length >= limit) break;
        }
        if (!candidates.length) break;
        const cost = yield candidates.flatMap(move => [...move.edges.old, ...move.edges.next]);
        let best = null, bestDelta = 0, bestReturns = found.length;
        const sum = pairs => pairs.reduce((total, [a, b]) => total + (a && b ? cost(a, b) : 0), 0);
        for (const candidate of candidates) {
            report.evaluated++;
            const before = sum(candidate.edges.old), after = sum(candidate.edges.next);
            if (!Number.isFinite(before) || !Number.isFinite(after)) {
                report.unverifiedMoves++; report.status = 'partial_road_evidence'; continue;
            }
            const delta = after - before;
            const strict = delta < bestDelta - 1e-7;
            const tie = report.preference.preferContiguousOnTie && Math.abs(delta - bestDelta) <= report.preference.tieSeconds
                && delta - report.secondsSaved <= report.preference.tieSeconds;
            if (!strict && !tie) continue;
            const candidateReturns = tie ? excursions(applyMove(units, candidate)).length : found.length;
            if (!strict && candidateReturns >= bestReturns) continue;
            best = candidate; bestDelta = delta; bestReturns = candidateReturns;
        }
        if (!best) break;
        const moved = applyMove(units, best);
        units = [];
        // Once an interruption is removed, the joined street run stays atomic.
        for (const unit of moved) {
            const prior = units.at(-1);
            if (prior?.key === unit.key && prior.pocket === unit.pocket) prior.stops = [...prior.stops, ...unit.stops];
            else units.push({ ...unit, stops: [...unit.stops] });
        }
        report.relocated++;
        report.secondsSaved -= bestDelta;
        if (pass === passes - 1 && excursions(units).length) report.budgetExhausted = true;
        if (report.evaluated >= limit) { report.budgetExhausted = true; break; }
    }
    return finish();
}

function cacheLookup(options) {
    const cache = new Map();
    return { cache, read(a, b) { return a === b ? 0 : cache.get(pairKey(a, b)) ?? Infinity; },
        missing(pairs) {
            const distinct = new Map();
            for (const [a, b] of pairs) if (a && b && a !== b && !cache.has(pairKey(a, b))) distinct.set(pairKey(a, b), [a, b]);
            return [...distinct.entries()];
        } };
}

export function reviewNeighborhoodExcursions(order, options = {}) {
    const engine = review(order, options), lookup = cacheLookup(options);
    let step = engine.next();
    while (!step.done) {
        for (const [id, [a, b]] of lookup.missing(step.value)) lookup.cache.set(id, finiteCost(options.costBetween(a, b)));
        step = engine.next(lookup.read);
    }
    return step.value;
}

export async function reviewNeighborhoodExcursionsAsync(order, options = {}) {
    const engine = review(order, options), lookup = cacheLookup(options);
    let step = engine.next();
    try {
        while (!step.done) {
            if (options.signal?.aborted) throw options.signal.reason || new DOMException('Cancelled', 'AbortError');
            const missing = lookup.missing(step.value);
            await options.prepareCosts?.(missing.map(([, pair]) => pair));
            for (const [id, [a, b]] of missing) lookup.cache.set(id, finiteCost(await options.costBetween(a, b)));
            step = engine.next(lookup.read);
        }
        return step.value;
    } catch (error) {
        if (error?.name === 'AbortError' || /membership|locked stop|graph identity|cancelled/i.test(error?.message || '')) throw error;
        const fallback = reviewNeighborhoodExcursions(order, { ...options, roadVerified: false });
        const diagnostics = Object.freeze({ ...fallback.diagnostics, reason: error.message });
        reports.set(fallback.properties, diagnostics);
        return { properties: fallback.properties, diagnostics };
    }
}

export const getNeighborhoodExcursionReview = order => reports.get(order) || null;

export function reviewNeighborhoodOrder(order, startLocation, endLocation, context = null, options = {}) {
    // Internal seam searches also sequence anonymous matrix points. Their caller
    // validates coordinate membership; they are not saved property manifests.
    // Preserve that existing search, and reserve relocation for durable stops.
    if (order.some(stop => !key(stop))) {
        reports.set(order, Object.freeze({ version: 1, status: 'stop_identity_unavailable', detected: 0,
            evaluated: 0, relocated: 0, secondsSaved: 0, remaining: 0, budgetExhausted: false }));
        return order;
    }
    const original = options.originalOrder;
    if (original?.some((stop, i) => (stop.order_locked || stop.locked || stop.routing_access?.resolution_status === 'unresolved')
        && key(order[i]) !== key(stop))) order = original;
    return reviewNeighborhoodExcursions(order, {
        ...(context?.neighborhoodExcursionOptions || {}), ...options, startLocation, endLocation,
        roadVerified: context?.vehicleAware === true || context?.neighborhoodRoadVerified === true,
        costBetween: context?.neighborhoodCostBetween || context?.optimizationCostBetween,
        neighborhoodKeyFor: context?.accessGroupKey,
        streetKeyFor: context?.streetSegmentKey
    }).properties;
}
