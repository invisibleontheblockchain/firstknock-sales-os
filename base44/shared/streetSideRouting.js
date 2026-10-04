// Shared by browser, worker and backend optimizers. Preference units are meters,
// deliberately separate from estimated travel/access time; these are not savings.
export const STREET_SIDE_POLICY = Object.freeze({
    enabled: true,
    travelMode: 'driving',
    crossingPenaltyMeters: 20,
    walkingMetersPerSecond: 1.3,
    drivingMetersPerSecond: 8.33,
    parkingSecondsPerStop: 0,
    maxRefinementStops: 40,
});

export function streetSidePolicy(overrides = {}) {
    return Object.freeze({ ...STREET_SIDE_POLICY, ...overrides });
}

export function trustedAccess(access) {
    return access && access.confidence === 'high' && access.chainKey
        && ['left', 'right'].includes(access.side)
        && Number.isFinite(access.positionMeters);
}

export function refineStreetSideOrder(stops, start, end, costBetween, groupFor, policy = STREET_SIDE_POLICY) {
    if (!policy.enabled || stops.length > policy.maxRefinementStops || stops.length < 3) return stops;
    const score = order => (start ? costBetween(start, order[0]) : 0)
        + order.slice(1).reduce((sum, stop, i) => sum + costBetween(order[i], stop), 0)
        + (end ? costBetween(order.at(-1), end) : 0);
    let best = stops;
    let bestCost = score(best);
    // Bounded relocations/exchanges inside one street preserve street/access
    // continuity. Every trial includes incoming and onward travel.
    for (let pass = 0; pass < 2; pass++) {
        let improved = false;
        for (let i = 0; i < best.length; i++) {
            for (let j = i + 1; j < best.length; j++) {
                if (groupFor(best[i]) !== groupFor(best[j])) break;
                const exchanged = [...best];
                [exchanged[i], exchanged[j]] = [exchanged[j], exchanged[i]];
                const relocated = [...best];
                relocated.splice(j, 0, ...relocated.splice(i, 1));
                for (const candidate of [exchanged, relocated]) {
                    const cost = score(candidate);
                    if (cost < bestCost - 1e-9) { best = candidate; bestCost = cost; improved = true; }
                }
            }
        }
        if (!improved) break;
    }
    return best;
}

export function crossingPreferenceMeters(left, right, accessFor, policy = STREET_SIDE_POLICY) {
    if (!policy.enabled || policy.travelMode !== 'walking' || !accessFor) return 0;
    const a = accessFor(left);
    const b = accessFor(right);
    return trustedAccess(a) && trustedAccess(b) && a.chainKey === b.chainKey && a.side !== b.side
        ? Math.max(0, Number(policy.crossingPenaltyMeters) || 0) : 0;
}

// Only a connected, unbranched road chain supplies an along-road ordering.
// House-number parity remains a legacy candidate, never evidence of street side.
export function streetSideVariants(stops, legacy, accessFor, policy = STREET_SIDE_POLICY) {
    const variants = [legacy, [...legacy].reverse()];
    if (!policy.enabled || !accessFor || stops.length < 2) return variants;
    const accesses = stops.map(accessFor);
    if (!accesses.every(trustedAccess) || new Set(accesses.map(a => a.chainKey)).size !== 1) return variants;
    const position = new Map(stops.map((stop, i) => [stop, accesses[i]]));
    const along = [...stops].sort((a, b) => position.get(a).positionMeters - position.get(b).positionMeters
        || String(a.address_hash || a.id).localeCompare(String(b.address_hash || b.id)));
    variants.push(along, [...along].reverse());
    for (const side of ['right', 'left']) {
        variants.push([...along.filter(p => position.get(p).side === side),
            ...along.filter(p => position.get(p).side !== side).reverse()]);
    }
    return variants.filter((variant, index) => !variants.slice(0, index).some(previous =>
        previous.length === variant.length && previous.every((stop, i) => stop === variant[i])));
}

// Directed dynamic programming includes every interior leg and both boundaries.
// Reversing a variant must recalculate its interior cost, even at one-way streets.
export function chooseStreetVariants(blocks, start, end, costBetween, validPoint) {
    if (!blocks.length) return { cost: 0, orientations: [] };
    const interior = blocks.map(block => block.variantCosts || block.variants.map(stops => stops.slice(1).reduce(
        (sum, stop, i) => sum + costBetween(stops[i], stop), 0)));
    const costs = blocks.map(block => block.variants.map(() => Infinity));
    const parents = blocks.map(block => block.variants.map(() => -1));
    blocks[0].variants.forEach((stops, v) => {
        costs[0][v] = interior[0][v] + (validPoint(start) ? costBetween(start, stops[0]) : 0);
    });
    for (let i = 1; i < blocks.length; i++) {
        blocks[i].variants.forEach((stops, v) => {
            blocks[i - 1].variants.forEach((previous, p) => {
                const cost = costs[i - 1][p] + costBetween(previous.at(-1), stops[0]) + interior[i][v];
                if (cost < costs[i][v] - 1e-9) { costs[i][v] = cost; parents[i][v] = p; }
            });
        });
    }
    const last = blocks.length - 1;
    let orientation = 0;
    let cost = Infinity;
    blocks[last].variants.forEach((stops, v) => {
        const candidate = costs[last][v] + (validPoint(end) ? costBetween(stops.at(-1), end) : 0);
        if (candidate < cost - 1e-9) { cost = candidate; orientation = v; }
    });
    // Do not fabricate an order from unreachable transitions.
    if (!Number.isFinite(cost)) throw new Error('No complete route could be found with the available road access. The existing route was left unchanged.');
    const orientations = new Array(blocks.length);
    for (let i = last; i >= 0; i--) { orientations[i] = orientation; orientation = parents[i][orientation]; }
    return { cost, orientations };
}
