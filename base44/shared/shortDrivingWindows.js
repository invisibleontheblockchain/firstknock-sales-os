import { haversineDistanceMiles, isValidRoutePoint } from './routeBounds.js';

export const MAX_SHORT_DRIVING_WINDOWS = 24;
const identity = stop => String(stop?.address_hash || stop?.legacy_hash || stop?.id || '');
const bound = (value, fallback, low, high) => Number.isFinite(Number(value))
    ? Math.max(low, Math.min(high, Number(value))) : fallback;

function permutations(values) {
    if (values.length < 2) return [values];
    return values.flatMap((value, i) => permutations([...values.slice(0, i), ...values.slice(i + 1)])
        .map(rest => [value, ...rest]));
}
const arrangements = new Map([3, 4].map(size => [size, permutations(Array.from({ length: size }, (_, i) => i))]));

/** Discover small branch/return questions, never driving savings or a new order.
 * The caller holds both outer context stops on each side fixed and validates
 * every proposed directed leg, curb pass, and complete drive before adoption. */
export function planShortDrivingWindows(order, options = {}) {
    if (!Array.isArray(order) || order.length < 7) return [];
    const keys = order.map(identity);
    if (keys.some(key => !key) || new Set(keys).size !== order.length) return [];
    const limit = Math.floor(bound(options.maxShortWindows, 16, 0, MAX_SHORT_DRIVING_WINDOWS));
    if (!limit) return [];
    const radius = bound(options.shortRadiusMiles, 0.45, 0.05, 1);
    const minimumGain = bound(options.minShortGainMiles, 0.005, 0, 0.1);
    const protectedIds = new Set([...(options.lockedStopIds || []), ...(options.unresolvedStopIds || [])].map(String));
    const blocked = new Set();
    order.forEach((stop, index) => {
        if (protectedIds.has(keys[index]) || stop.locked || stop.order_locked
            || stop.routing_access?.resolution_status === 'unresolved' || !isValidRoutePoint(stop)) {
            for (let i = Math.max(0, index - 2); i <= Math.min(order.length - 1, index + 2); i++) blocked.add(i);
        }
    });
    const questions = new Map();
    for (const size of [3, 4]) for (let start = 2; start + size <= order.length - 2; start++) {
        const end = start + size;
        if (Array.from({ length: size }, (_, i) => start + i).some(index => blocked.has(index))) continue;
        const nearby = order.slice(start - 1, end + 1);
        if (!nearby.every(point => isValidRoutePoint(point)
            && haversineDistanceMiles(order[start], point) <= radius)) continue;
        const costs = nearby.map(a => nearby.map(b => haversineDistanceMiles(a, b)));
        const measure = permutation => {
            let cost = 0, previous = 0;
            for (const index of permutation) { cost += costs[previous][index + 1]; previous = index + 1; }
            return cost + costs[previous][size + 1];
        };
        const incumbent = arrangements.get(size)[0];
        const baseline = measure(incumbent);
        let best = incumbent, bestCost = baseline;
        for (const permutation of arrangements.get(size)) {
            const cost = measure(permutation);
            if (cost < bestCost - 1e-10) { best = permutation; bestCost = cost; }
        }
        const gain = baseline - bestCost;
        if (gain <= Math.max(minimumGain, 1e-10)) continue;
        const ratio = baseline > 0 ? gain / baseline : 0;
        const question = { start, end, short: true, local: true,
            screenGainMiles: gain, screenGainRatio: ratio, priority: gain * (1 + ratio) };
        // A wider window can describe the same three-door change. Ask that
        // exact geometric question once instead of spending two review slots.
        const changed = JSON.stringify(best.flatMap((index, slot) => index === slot ? [] : [[start + slot, start + index]]));
        const prior = questions.get(changed);
        if (!prior || question.priority > prior.priority + 1e-10
            || (Math.abs(question.priority - prior.priority) <= 1e-10 && size < prior.end - prior.start)) questions.set(changed, question);
    }
    return [...questions.values()].sort((a, b) => b.priority - a.priority
        || b.screenGainMiles - a.screenGainMiles || b.screenGainRatio - a.screenGainRatio
        || a.start - b.start || a.end - b.end).slice(0, limit);
}
