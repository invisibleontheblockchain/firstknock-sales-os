// Candidate generation only. All costs come from the caller's directed road
// matrix; continuous route validation remains the adoption authority.
export const MAX_DRIVING_AREA_DOOR_SEARCH_STOPS = 40;
const identity = stop => String(stop?.address_hash || stop?.legacy_hash || stop?.id || '');
const validCost = value => Number.isFinite(value) && value >= 0 ? value : Infinity;
const lexicographic = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const compare = (a, b) => Math.abs(a.seconds - b.seconds) > 0.1 ? a.seconds - b.seconds
    : Math.abs(a.miles - b.miles) > 0.0001 ? a.miles - b.miles : lexicographic(a.fingerprint, b.fingerprint);
const improves = (a, b) => a.seconds < b.seconds - 0.1
    || Math.abs(a.seconds - b.seconds) <= 0.1 && a.miles < b.miles - 0.0001;

/** Bounded directed door refinement for a connected driving area. Locks retain
 * their exact input indices, including unresolved access stops. The function
 * performs no network requests and never estimates missing road costs. */
export function buildDrivingAreaDoorCandidates(stops, context, start = null, end = null, options = {}) {
    if (!Array.isArray(stops) || stops.length < 3 || stops.length > MAX_DRIVING_AREA_DOOR_SEARCH_STOPS
        || typeof context?.optimizationCostBetween !== 'function' || typeof context?.distanceBetween !== 'function') return [];
    const keys = stops.map(identity);
    if (keys.some(key => !key) || new Set(keys).size !== stops.length) return [];
    const count = stops.length, terminal = count + 1, points = [start, ...stops, end];
    const lockedIds = new Set((options.lockedStopIds || []).map(String));
    const locked = stops.map(stop => lockedIds.has(identity(stop)) || stop.order_locked === true || stop.locked === true
        || stop.routing_access?.resolution_status === 'unresolved');
    const free = stops.map((_, i) => i + 1).filter(index => !locked[index - 1]);
    if (free.length < 2) return [];
    const costs = points.map((a, i) => points.map((b, j) => i === j || !a || !b ? 0
        : validCost(context.optimizationCostBetween(a, b))));
    const miles = points.map((a, i) => points.map((b, j) => i === j || !a || !b ? 0
        : validCost(context.distanceBetween(a, b))));
    const maxEvaluations = Math.max(1, Math.min(120000, Math.floor(Number(options.maxEvaluations) || 60000)));
    const maxCandidates = Math.max(1, Math.min(8, Math.floor(Number(options.maxCandidates) || 4)));
    let evaluations = 0;
    const expand = order => {
        let cursor = 0;
        return stops.map((_, i) => locked[i] ? i + 1 : order[cursor++]);
    };
    const fingerprint = order => JSON.stringify(order.map(index => keys[index - 1]));
    const incumbentFingerprint = fingerprint(stops.map((_, i) => i + 1));
    const measure = order => {
        if (evaluations >= maxEvaluations) return null;
        evaluations++;
        let seconds = 0, distance = 0, previous = 0;
        for (const next of order) {
            seconds += costs[previous][next]; distance += miles[previous][next]; previous = next;
        }
        seconds += costs[previous][terminal]; distance += miles[previous][terminal];
        if (!Number.isFinite(seconds) || !Number.isFinite(distance)) return null;
        return { seconds, miles: distance, fingerprint: fingerprint(order) };
    };
    const candidates = new Map();
    const retain = order => {
        const full = expand(order), measured = measure(full);
        if (measured && measured.fingerprint !== incumbentFingerprint && !candidates.has(measured.fingerprint)) {
            candidates.set(measured.fingerprint, { ...measured, indices: [...full] });
        }
        return measured;
    };
    const seeds = [[...free]];
    const indexById = new Map(keys.map((key, index) => [key, index + 1]));
    for (const supplied of (Array.isArray(options.seedOrders) ? options.seedOrders.slice(0, 8) : [])) {
        if (!Array.isArray(supplied) || supplied.length !== count) continue;
        const indices = supplied.map(stop => indexById.get(identity(stop)));
        if (indices.some(index => !index) || new Set(indices).size !== count
            || indices.some((index, slot) => locked[slot] && index !== slot + 1)) continue;
        seeds.push(indices.filter((_, slot) => !locked[slot]));
    }
    const canonical = [...free].sort((a, b) => lexicographic(keys[a - 1], keys[b - 1]));
    let randomState = 2166136261;
    for (const key of [...keys].sort()) for (const character of key) randomState = Math.imul(randomState ^ character.charCodeAt(0), 16777619) >>> 0;
    const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 4294967296; };

    // Different deterministic nearest choices expose branch/return tours that
    // a single greedy start misses. Fixed doors are visited at their own slots.
    for (let trial = 0; trial < 5; trial++) {
        const remaining = [...canonical], order = [];
        let previous = 0;
        for (let slot = 0; slot < count; slot++) {
            if (locked[slot]) { previous = slot + 1; continue; }
            remaining.sort((a, b) => costs[previous][a] - costs[previous][b]
                || miles[previous][a] - miles[previous][b] || lexicographic(keys[a - 1], keys[b - 1]));
            const rank = trial === 0 ? 0 : Math.floor(random() * Math.min(trial < 3 ? 2 : 3, remaining.length));
            previous = remaining.splice(rank, 1)[0]; order.push(previous);
        }
        seeds.push(order);
    }
    // Cheapest directed insertion supplies a seed with a different failure mode
    // from nearest-neighbor. This temporary seed has no claimed route metric.
    let insertion = [], remaining = [...canonical];
    const insertionLimit = Math.max(1, Math.floor(maxEvaluations * 0.2));
    while (remaining.length && evaluations < insertionLimit) {
        let best = null;
        for (let nextIndex = 0; nextIndex < remaining.length && evaluations < insertionLimit; nextIndex++) {
            const next = remaining[nextIndex];
            for (let position = 0; position <= insertion.length && evaluations < insertionLimit; position++) {
                const candidate = [...insertion.slice(0, position), next, ...insertion.slice(position)];
                const measured = measure(candidate);
                if (measured && (!best || compare(measured, best.measured) < 0)) best = { candidate, next, measured };
            }
        }
        if (!best) break;
        insertion = best.candidate; remaining = remaining.filter(index => index !== best.next);
    }
    if (!remaining.length) seeds.push(insertion);
    seeds.push([...free].reverse());
    const uniqueSeeds = [...new Map(seeds.map(seed => [seed.join(','), seed])).values()]
        .map(order => ({ order, measured: measure(expand(order)) })).filter(seed => seed.measured)
        .sort((a, b) => compare(a.measured, b.measured)).map(seed => seed.order);

    // Full directed sums are deliberately recomputed (at most 41 transitions).
    // Undirected 2-opt deltas would miss every reversed internal arc. Tight
    // evaluation quotas bound both CPU and the number of retained candidates.
    for (let seedIndex = 0; seedIndex < uniqueSeeds.length && evaluations < maxEvaluations; seedIndex++) {
        let order = [...uniqueSeeds[seedIndex]], current = retain(order);
        const remainingSeeds = uniqueSeeds.length - seedIndex;
        const share = seedIndex === 0 && remainingSeeds > 1 ? 0.5 : 1 / remainingSeeds;
        const quota = Math.min(maxEvaluations, evaluations + Math.max(1,
            Math.floor((maxEvaluations - evaluations) * share)));
        if (!current) continue;
        for (let pass = 0; pass < 12 && evaluations < quota; pass++) {
            let best = null;
            const consider = candidate => {
                if (evaluations >= quota) return;
                const measured = measure(expand(candidate));
                if (measured && improves(measured, current) && (!best || compare(measured, best.measured) < 0)) {
                    best = { order: candidate, measured };
                }
            };
            for (let length = 1; length <= Math.min(3, order.length - 1) && evaluations < quota; length++) {
                for (let from = 0; from + length <= order.length && evaluations < quota; from++) {
                    const block = order.slice(from, from + length), rest = [...order.slice(0, from), ...order.slice(from + length)];
                    for (let to = 0; to <= rest.length && evaluations < quota; to++) {
                        if (to !== from) consider([...rest.slice(0, to), ...block, ...rest.slice(to)]);
                    }
                }
            }
            for (let first = 0; first < order.length - 1 && evaluations < quota; first++) {
                for (let last = first + 1; last < order.length && evaluations < quota; last++) {
                    const swapped = [...order]; [swapped[first], swapped[last]] = [swapped[last], swapped[first]];
                    consider(swapped);
                    if (last > first + 1) consider([...order.slice(0, first), ...order.slice(first, last + 1).reverse(), ...order.slice(last + 1)]);
                }
            }
            if (!best) break;
            order = best.order; current = best.measured;
            if (current.fingerprint !== incumbentFingerprint && !candidates.has(current.fingerprint)) {
                candidates.set(current.fingerprint, { ...current, indices: expand(order) });
            }
        }
    }
    return [...candidates.values()].sort(compare).map(candidate => ({
        order: candidate.indices.map(index => stops[index - 1]), seconds: candidate.seconds, miles: candidate.miles,
        source: 'directed_area_door_search', searchEvaluations: evaluations,
    })).filter(candidate => typeof options.acceptOrder !== 'function' || options.acceptOrder(candidate.order))
        .slice(0, maxCandidates);
}
