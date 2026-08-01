/**
 * Street-block macro sequencing helpers.
 *
 * The mail-carrier optimizer already builds good local street blocks and already
 * picks block orientations with a dynamic program (`streetBlockOrderCost`). Road
 * verification of the Mesquite 58-door route showed the remaining loss is
 * macro-level: a single greedy nearest-neighbor seed strands an awkward group of
 * blocks at the end of the route. Through stop 43 the greedy order was 1.85 road
 * miles better than an independent benchmark, then gave back 2.26 miles across
 * the final 14 legs.
 *
 * This module supplies the deterministic pieces needed to fix that without
 * touching street grouping: diverse seed selection for a multi-start search,
 * tail-cost measurement, and a single deterministic winner-selection rule.
 * Every weight and limit lives here so the scoring basis stays centrally
 * documented and replaceable (a later mixed driving/walking model only has to
 * change the leg cost handed in).
 */

/**
 * Central sequencing configuration.
 *
 * `roadDistance` is the primary objective: real road distance or duration for
 * the complete open route, exactly as `streetBlockOrderCost` measures it.
 *
 * The tail terms are deliberately NOT added into the primary cost. A flat tail
 * penalty just relocates the expensive stretch somewhere else in the route, so
 * tail cost is measured for reporting and used only to break near-equal totals.
 */
export const BLOCK_SEQUENCING_WEIGHTS = Object.freeze({
    // Candidate orders are compared on complete-route cost first.
    roadDistance: 1,
    // Two orders within this many miles of each other are treated as equal, and
    // the one with the cheaper end-of-route stretch wins.
    equalCostToleranceMiles: 0.02,
    // Tail diagnostics: the last N legs, and the last share of the route.
    tailLegCount: 10,
    tailRouteShare: 0.2
});

/** Deterministic seed budget. Both limits are cost, not correctness, guards. */
export const BLOCK_SEQUENCING_LIMITS = Object.freeze({
    // Diverse starting blocks tried in addition to the anchored greedy order.
    maxSeedCandidates: 8,
    // Seeds carried into the expensive reversal / or-opt refinement.
    maxRefinedCandidates: 4,
    // Above this block count the search stays single-start for responsiveness.
    maxMultiStartBlocks: 160,
    // Cost-only road contexts pay a much higher price per distance lookup.
    maxCostOnlySeedCandidates: 3,
    maxCostOnlyRefinedCandidates: 2,
    maxCostOnlyMultiStartBlocks: 60
});

function compareKeys(first, second) {
    const firstKey = String(first);
    const secondKey = String(second);
    if (firstKey < secondKey) return -1;
    if (firstKey > secondKey) return 1;
    return 0;
}

function planarDistance(first, second) {
    const x = (Number(second.lng) - Number(first.lng))
        * Math.cos((Number(first.lat) + Number(second.lat)) / 2 * Math.PI / 180);
    const y = Number(second.lat) - Number(first.lat);
    return Math.sqrt(x * x + y * y) * 69;
}

/**
 * Pick geographically diverse starting blocks by farthest-point sampling.
 *
 * The two ends of the neighborhood's principal axis are chosen first — those are
 * the perimeter starts a rep would naturally use — and each later seed is the
 * block farthest from every seed already chosen. Selection is deterministic:
 * ties fall back to the block key, never to input order or randomness.
 *
 * @param {Array<{key: string, lat: number, lng: number}>} blocks
 * @param {number} maxSeeds
 * @returns {number[]} indexes into `blocks`, in selection order
 */
export function selectDiverseSeedBlockIndexes(blocks, maxSeeds) {
    const budget = Math.max(0, Math.floor(Number(maxSeeds) || 0));
    if (!Array.isArray(blocks) || blocks.length === 0 || budget === 0) return [];
    if (blocks.length <= budget) {
        return blocks
            .map((block, index) => ({ key: block.key, index }))
            .sort((first, second) => compareKeys(first.key, second.key))
            .map(({ index }) => index);
    }

    // Principal axis: the farthest-apart pair of block centroids.
    let axisStart = 0;
    let axisEnd = 1;
    let longestSpan = -1;
    for (let first = 0; first < blocks.length; first++) {
        for (let second = first + 1; second < blocks.length; second++) {
            const span = planarDistance(blocks[first], blocks[second]);
            if (
                span > longestSpan + 1e-9
                || (
                    Math.abs(span - longestSpan) <= 1e-9
                    && compareKeys(blocks[first].key, blocks[axisStart].key) < 0
                )
            ) {
                longestSpan = span;
                axisStart = first;
                axisEnd = second;
            }
        }
    }

    const selected = compareKeys(blocks[axisStart].key, blocks[axisEnd].key) <= 0
        ? [axisStart, axisEnd]
        : [axisEnd, axisStart];

    while (selected.length < budget) {
        let bestIndex = -1;
        let bestDistance = -1;
        for (let index = 0; index < blocks.length; index++) {
            if (selected.includes(index)) continue;
            let nearest = Infinity;
            selected.forEach((seedIndex) => {
                nearest = Math.min(nearest, planarDistance(blocks[index], blocks[seedIndex]));
            });
            if (
                nearest > bestDistance + 1e-9
                || (
                    Math.abs(nearest - bestDistance) <= 1e-9
                    && bestIndex >= 0
                    && compareKeys(blocks[index].key, blocks[bestIndex].key) < 0
                )
            ) {
                bestDistance = nearest;
                bestIndex = index;
            }
        }
        if (bestIndex < 0) break;
        selected.push(bestIndex);
    }
    return selected.slice(0, budget);
}

/**
 * Measure how much of a route's cost is concentrated at its end.
 *
 * `excessMiles` is the amount by which the final stretch exceeds an even share
 * of the route. A healthy sweep finishes near zero; a stranded tail stands out.
 *
 * @param {number[]} legDistances door-to-door leg costs in route order
 */
export function summarizeRouteTail(legDistances) {
    const legs = (Array.isArray(legDistances) ? legDistances : [])
        .map(Number)
        .filter(Number.isFinite);
    const total = legs.reduce((sum, leg) => sum + leg, 0);
    if (legs.length === 0) {
        return {
            totalMiles: 0,
            finalLegCountMiles: 0,
            finalShareMiles: 0,
            longestTailLegMiles: 0,
            excessMiles: 0
        };
    }

    const tailLegCount = Math.min(legs.length, BLOCK_SEQUENCING_WEIGHTS.tailLegCount);
    const shareLegCount = Math.max(
        1,
        Math.min(legs.length, Math.round(legs.length * BLOCK_SEQUENCING_WEIGHTS.tailRouteShare))
    );
    const finalLegs = legs.slice(legs.length - tailLegCount);
    const shareLegs = legs.slice(legs.length - shareLegCount);
    const shareCost = shareLegs.reduce((sum, leg) => sum + leg, 0);
    const evenShare = total * (shareLegCount / legs.length);

    return {
        totalMiles: total,
        finalLegCountMiles: finalLegs.reduce((sum, leg) => sum + leg, 0),
        finalShareMiles: shareCost,
        longestTailLegMiles: Math.max(...finalLegs),
        excessMiles: Math.max(0, shareCost - evenShare)
    };
}

/**
 * Count streets that are left and later re-entered.
 *
 * A street split into several blocks (a long avenue, or a name reused across a
 * neighborhood) may be cheaper to interleave with its neighbors, but a rep
 * experiences that as leaving a street and coming back to it. Blocks carry the
 * street identity in the part of their key before the piece suffix.
 */
export function countStreetReentries(order) {
    const streets = (Array.isArray(order) ? order : [])
        .map(block => String(block?.key ?? '').split('#')[0]);
    const lastSeen = new Map();
    let reentries = 0;
    streets.forEach((street, index) => {
        const previous = lastSeen.get(street);
        if (previous !== undefined && previous !== index - 1) reentries += 1;
        lastSeen.set(street, index);
    });
    return reentries;
}

/**
 * Deterministically choose the winning candidate order.
 *
 * Street continuity outranks raw distance: an order that leaves and re-enters a
 * street can never win on cost alone, because that is the rep-facing workflow the
 * mail-carrier sweep exists to protect. Among orders with equal continuity the
 * complete-route cost decides, then the cheaper end-of-route stretch, and
 * finally the block-key signature so the result never depends on evaluation
 * order.
 *
 * @param {Array<{order: Array<{key: string}>, cost: number, tail: {excessMiles: number}}>} candidates
 */
export function selectBestBlockOrderCandidate(candidates) {
    const usable = (Array.isArray(candidates) ? candidates : [])
        .filter(candidate => Array.isArray(candidate?.order) && Number.isFinite(candidate?.cost));
    if (usable.length === 0) return null;

    const signature = candidate => candidate.order.map(block => String(block.key)).join('>');
    const reentriesOf = candidate => (
        Number.isFinite(candidate.reentries) ? candidate.reentries : countStreetReentries(candidate.order)
    );
    return usable.reduce((best, candidate) => {
        const candidateReentries = reentriesOf(candidate);
        const bestReentries = reentriesOf(best);
        if (candidateReentries !== bestReentries) {
            return candidateReentries < bestReentries ? candidate : best;
        }

        const tolerance = BLOCK_SEQUENCING_WEIGHTS.equalCostToleranceMiles;
        if (candidate.cost + tolerance < best.cost) return candidate;
        if (best.cost + tolerance < candidate.cost) return best;

        const candidateExcess = Number(candidate.tail?.excessMiles) || 0;
        const bestExcess = Number(best.tail?.excessMiles) || 0;
        if (candidateExcess + 1e-9 < bestExcess) return candidate;
        if (bestExcess + 1e-9 < candidateExcess) return best;

        if (candidate.cost + 1e-9 < best.cost) return candidate;
        if (best.cost + 1e-9 < candidate.cost) return best;
        return compareKeys(signature(candidate), signature(best)) < 0 ? candidate : best;
    });
}