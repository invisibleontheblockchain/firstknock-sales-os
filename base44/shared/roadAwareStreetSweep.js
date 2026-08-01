// Server-side port of the shipped frontend street sweep
// (src/components/logic/routeOptimizer.jsx: mailCarrierOrder and friends),
// with the leg cost injected so it can be priced by a real OSRM road matrix.
//
// Structural invariants preserved from the frontend implementation:
//   - a street segment is atomic: only whole segments are reordered or reversed;
//   - segments are split where a spatial gap proves they are disconnected;
//   - dense streets are walked side-by-side (boustrophedon), sparse streets are
//     walked straight through along the street axis so no door is passed twice.

import { haversineMiles, isValidPoint } from './routeContinuityOptimizer.js';

const DENSE_SIDE_DOOR_COUNT = 3;
const MAX_AXIS_ORDER_DOORS = 60;
export const STREET_SPLIT_GAP_MILES = 0.4;
// Greedy nearest-neighbour from a single seed strands whole sections of a route
// (the Kannapolis audit lost ~3% that way, because the best answer runs the
// territory in the opposite overall direction). Below this block count every
// block is tried as the seed and the cheapest refined result wins; the limit
// keeps the pass inside the synchronous request budget.
export const MULTI_START_BLOCK_LIMIT = 40;
export const REFINED_SEED_COUNT = 3;

// Refinement cost is budgeted in DP steps, never in wall-clock time and never by
// a block-count threshold. Pricing one candidate block order costs ~blocks DP
// steps, so a step budget bounds solver time the same way at 20 blocks and at
// 200 — and, because the budget is consumed in a fixed exploration order, the
// same input always spends it on the same candidates and returns the same route.
// The previous "refine below 120 blocks, refine nothing above" rule produced an
// inverted cliff: Charlotte 95 cost ~16.9s while Anderson 183 skipped refinement
// entirely at 36ms.
// Quality-first budget. Measured on the frozen fixtures, route quality is still
// improving at 4M, so the default is set at the knee of the curve rather than at
// the cheapest setting that felt fast:
//   Charlotte 95   900k 355.4min  4M 345.1  16M 340.5  32M 339.3
//   Anderson 183   900k 437.5min  4M 437.5  16M 430.0  32M 428.4
//   Mesquite 58    900k  61.4min  4M  61.4  16M  61.4 (converged, budget unspent)
// 16M costs ~5s per sweep at the 250-door client cap (~12s for both sweeps),
// which buys the best validated route inside one Create Route press. 32M doubles
// that for a further 0.4%, and its ~9s sweeps leave too little headroom under
// REFINEMENT_SAFETY_MS, whose wall-clock cutoff would make results
// machine-dependent if it ever bound.
export const REFINEMENT_STEP_BUDGET = 16_000_000;
export const SCREENING_STEP_BUDGET = 300_000;
// Emergency cutoff only. The step budget is what makes runtime predictable; this
// exists so a pathological matrix cannot hang a request, and it is set far above
// the step budget's expected runtime so it never decides a normal result. Worst
// measured sweep at the shipped budget is ~5.9s (250 doors), so this keeps ~3.4x
// headroom and stays out of the way of normal results.
export const REFINEMENT_SAFETY_MS = 20_000;

const STREET_SUFFIX_CANONICAL = new Map([
    ['ALY', 'ALY'], ['ALLEY', 'ALY'],
    ['AVE', 'AVE'], ['AVENUE', 'AVE'],
    ['BLVD', 'BLVD'], ['BOULEVARD', 'BLVD'],
    ['CIR', 'CIR'], ['CIRCLE', 'CIR'],
    ['CT', 'CT'], ['COURT', 'CT'],
    ['CV', 'CV'], ['COVE', 'CV'],
    ['DR', 'DR'], ['DRIVE', 'DR'],
    ['HWY', 'HWY'], ['HIGHWAY', 'HWY'],
    ['LN', 'LN'], ['LANE', 'LN'],
    ['PKWY', 'PKWY'], ['PARKWAY', 'PKWY'],
    ['PL', 'PL'], ['PLACE', 'PL'],
    ['PT', 'PT'], ['POINT', 'PT'],
    ['RD', 'RD'], ['ROAD', 'RD'],
    ['SQ', 'SQ'], ['SQUARE', 'SQ'],
    ['ST', 'ST'], ['STREET', 'ST'],
    ['TER', 'TER'], ['TERRACE', 'TER'],
    ['TRL', 'TRL'], ['TRAIL', 'TRL'],
    ['WAY', 'WAY']
]);

function normalizeStreetName(raw) {
    if (!raw || !String(raw).trim()) return '__UNKNOWN__';
    const tokens = String(raw)
        .toUpperCase()
        .trim()
        .split(/\s+/)
        .map((token) => token.replace(/[.,]+$/g, ''));
    if (tokens.length > 1 && STREET_SUFFIX_CANONICAL.has(tokens[tokens.length - 1])) {
        tokens[tokens.length - 1] = STREET_SUFFIX_CANONICAL.get(tokens[tokens.length - 1]);
    }
    return tokens.join(' ') || '__UNKNOWN__';
}

function stablePropertyKey(property, fallbackIndex = 0) {
    return String(
        property?.address_hash
        || property?.legacy_hash
        || property?.id
        || [
            property?.house_number || '',
            normalizeStreetName(property?.street_name),
            property?.lat ?? '',
            property?.lng ?? '',
            fallbackIndex
        ].join('|')
    );
}

function compareStableKeys(first, second) {
    const firstKey = String(first);
    const secondKey = String(second);
    if (firstKey < secondKey) return -1;
    if (firstKey > secondKey) return 1;
    return 0;
}

function streetGroupKey(property, fallbackIndex) {
    const normalizedStreet = normalizeStreetName(property?.street_name);
    const zip = String(property?.zip_code || property?.zip || '').trim().slice(0, 5);
    const city = String(property?.city || '').trim().toUpperCase();
    return normalizedStreet === '__UNKNOWN__'
        ? `__UNKNOWN__|${stablePropertyKey(property, fallbackIndex)}`
        : `${normalizedStreet}|${city}|${zip}`;
}

function groupByStreet(properties) {
    const groups = new Map();
    [...properties]
        .sort((first, second) => compareStableKeys(stablePropertyKey(first), stablePropertyKey(second)))
        .forEach((property, index) => {
            const key = streetGroupKey(property, index);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(property);
        });
    return groups;
}

function orderAlongStreetAxis(props) {
    if (props.length <= 2 || props.length > MAX_AXIS_ORDER_DOORS) return props;
    let start = props[0];
    let end = props[1];
    let longest = -1;
    for (let i = 0; i < props.length; i++) {
        for (let j = i + 1; j < props.length; j++) {
            const span = haversineMiles(props[i], props[j]);
            if (span > longest) {
                longest = span;
                start = props[i];
                end = props[j];
            }
        }
    }
    const axisLat = Number(end.lat) - Number(start.lat);
    const axisLng = Number(end.lng) - Number(start.lng);
    if (axisLat === 0 && axisLng === 0) return props;
    const projection = (p) => (Number(p.lat) - Number(start.lat)) * axisLat
        + (Number(p.lng) - Number(start.lng)) * axisLng;
    return [...props].sort((a, b) => projection(a) - projection(b));
}

function boustrophedonStreet(props, reverseDirection) {
    if (props.length <= 1) return props;
    const odd = props.filter((p) => {
        const num = parseInt(p.house_number, 10);
        return Number.isNaN(num) || num % 2 !== 0;
    });
    const even = props.filter((p) => {
        const num = parseInt(p.house_number, 10);
        return !Number.isNaN(num) && num % 2 === 0;
    });

    if (odd.length < DENSE_SIDE_DOOR_COUNT || even.length < DENSE_SIDE_DOOR_COUNT) {
        const axisOrder = orderAlongStreetAxis(props);
        return reverseDirection ? [...axisOrder].reverse() : axisOrder;
    }

    const sortByNum = (a, b) => (parseInt(a.house_number, 10) || 0) - (parseInt(b.house_number, 10) || 0);
    odd.sort(sortByNum);
    even.sort(sortByNum);
    return reverseDirection ? [...even.reverse(), ...odd] : [...odd, ...even.reverse()];
}

function splitStreetGroupByGaps(props) {
    if (props.length <= 1 || props.length > MAX_AXIS_ORDER_DOORS) return [props];
    const ordered = orderAlongStreetAxis(props);
    const pieces = [];
    let current = [ordered[0]];
    for (let i = 1; i < ordered.length; i++) {
        if (haversineMiles(ordered[i - 1], ordered[i]) > STREET_SPLIT_GAP_MILES) {
            pieces.push(current);
            current = [];
        }
        current.push(ordered[i]);
    }
    pieces.push(current);
    return pieces;
}

/**
 * Road-aware street sweep.
 * @param {Array} properties doors to order
 * @param {object} options { distanceBetween, startLocation, endLocation }
 * @returns {Array} the same doors, ordered
 */
export function roadAwareStreetSweep(properties, options = {}) {
    const {
        distanceBetween = null,
        startLocation = null,
        endLocation = null,
        multiStartBlockLimit = MULTI_START_BLOCK_LIMIT,
        refinementStepBudget = REFINEMENT_STEP_BUDGET,
        refinedSeedCount = REFINED_SEED_COUNT
    } = options;

    if (!Array.isArray(properties) || properties.length === 0) return [];
    if (properties.length === 1) return [...properties];

    const cost = (from, to) => {
        if (typeof distanceBetween === 'function') {
            const value = Number(distanceBetween(from, to));
            if (Number.isFinite(value) && value >= 0) return value;
        }
        return haversineMiles(from, to);
    };

    function intraStreet2Opt(props) {
        if (props.length < 4 || props.length > 50) return props;
        let improved = true;
        let iterations = 0;
        while (improved && iterations < 10) {
            improved = false;
            iterations++;
            for (let i = 0; i < props.length - 2; i++) {
                for (let j = i + 2; j < props.length; j++) {
                    const tailExists = j + 1 < props.length;
                    const before = cost(props[i], props[i + 1])
                        + (tailExists ? cost(props[j], props[j + 1]) : 0);
                    const after = cost(props[i], props[j])
                        + (tailExists ? cost(props[i + 1], props[j + 1]) : 0);
                    if (after + 0.000001 < before) {
                        const segment = props.splice(i + 1, j - i).reverse();
                        props.splice(i + 1, 0, ...segment);
                        improved = true;
                    }
                }
            }
        }
        return props;
    }

    function buildBlocks() {
        return [...groupByStreet(properties).entries()]
            .sort(([firstKey], [secondKey]) => compareStableKeys(firstKey, secondKey))
            .flatMap(([key, allProps]) => splitStreetGroupByGaps(allProps).map((props, pieceIndex, pieces) => {
                const forward = intraStreet2Opt(boustrophedonStreet([...props], false));
                return {
                    key: pieces.length > 1 ? `${key}#${pieceIndex}` : key,
                    lat: forward.reduce((sum, p) => sum + Number(p.lat), 0) / forward.length,
                    lng: forward.reduce((sum, p) => sum + Number(p.lng), 0) / forward.length,
                    variants: [forward, [...forward].reverse()]
                };
            }));
    }

    /** DP over block orientations for a fixed block sequence. */
    function blockOrderCost(blocks, includePath = false) {
        if (blocks.length === 0) return includePath ? { cost: 0, orientations: [] } : 0;
        const costs = blocks.map(() => [Infinity, Infinity]);
        const previous = blocks.map(() => [-1, -1]);

        for (let orientation = 0; orientation < 2; orientation++) {
            const firstDoor = blocks[0].variants[orientation][0];
            costs[0][orientation] = isValidPoint(startLocation) ? cost(startLocation, firstDoor) : 0;
        }
        for (let blockIndex = 1; blockIndex < blocks.length; blockIndex++) {
            for (let orientation = 0; orientation < 2; orientation++) {
                const firstDoor = blocks[blockIndex].variants[orientation][0];
                for (let previousOrientation = 0; previousOrientation < 2; previousOrientation++) {
                    const previousDoors = blocks[blockIndex - 1].variants[previousOrientation];
                    const previousLastDoor = previousDoors[previousDoors.length - 1];
                    const candidate = costs[blockIndex - 1][previousOrientation]
                        + cost(previousLastDoor, firstDoor);
                    if (candidate + 0.000000001 < costs[blockIndex][orientation]) {
                        costs[blockIndex][orientation] = candidate;
                        previous[blockIndex][orientation] = previousOrientation;
                    }
                }
            }
        }

        let finalOrientation = 0;
        let finalCost = Infinity;
        for (let orientation = 0; orientation < 2; orientation++) {
            const finalDoors = blocks[blocks.length - 1].variants[orientation];
            const finalDoor = finalDoors[finalDoors.length - 1];
            const candidate = costs[blocks.length - 1][orientation]
                + (isValidPoint(endLocation) ? cost(finalDoor, endLocation) : 0);
            if (candidate + 0.000000001 < finalCost) {
                finalCost = candidate;
                finalOrientation = orientation;
            }
        }
        if (!includePath) return finalCost;

        const orientations = new Array(blocks.length);
        orientations[blocks.length - 1] = finalOrientation;
        for (let blockIndex = blocks.length - 1; blockIndex > 0; blockIndex--) {
            orientations[blockIndex - 1] = previous[blockIndex][orientations[blockIndex]];
        }
        return { cost: finalCost, orientations };
    }

    function transitionCost(firstBlock, secondBlock) {
        let best = Infinity;
        firstBlock.variants.forEach((firstVariant) => {
            const exit = firstVariant[firstVariant.length - 1];
            secondBlock.variants.forEach((secondVariant) => {
                best = Math.min(best, cost(exit, secondVariant[0]));
            });
        });
        return best;
    }

    function nearestNeighborBlocks(blocks, forcedFirstKey = null) {
        const remaining = [...blocks].sort((first, second) => compareStableKeys(first.key, second.key));
        const ordered = [];
        let finalBlock = null;

        if (isValidPoint(endLocation) && remaining.length > 1) {
            let finalIndex = 0;
            let finalDistance = Infinity;
            remaining.forEach((block, index) => {
                const distance = Math.min(...block.variants.map((variant) =>
                    cost(variant[variant.length - 1], endLocation)));
                if (distance + 0.000000001 < finalDistance) {
                    finalDistance = distance;
                    finalIndex = index;
                }
            });
            [finalBlock] = remaining.splice(finalIndex, 1);
        }

        let firstIndex = 0;
        if (forcedFirstKey !== null) {
            const forcedIndex = remaining.findIndex((block) => block.key === forcedFirstKey);
            if (forcedIndex >= 0) firstIndex = forcedIndex;
        } else if (isValidPoint(startLocation)) {
            let firstDistance = Infinity;
            remaining.forEach((block, index) => {
                const distance = Math.min(...block.variants.map((variant) => cost(startLocation, variant[0])));
                if (distance + 0.000000001 < firstDistance) {
                    firstDistance = distance;
                    firstIndex = index;
                }
            });
        }
        ordered.push(remaining.splice(firstIndex, 1)[0]);

        while (remaining.length > 0) {
            const current = ordered[ordered.length - 1];
            let bestIndex = 0;
            let bestDistance = Infinity;
            remaining.forEach((candidate, index) => {
                const distance = transitionCost(current, candidate);
                if (distance + 0.000000001 < bestDistance) {
                    bestDistance = distance;
                    bestIndex = index;
                }
            });
            ordered.push(remaining.splice(bestIndex, 1)[0]);
        }

        if (finalBlock) ordered.push(finalBlock);
        return ordered;
    }

    /**
     * Reversal + relocation refinement under a deterministic step budget.
     * Every candidate it returns has been fully priced, so an exhausted budget
     * degrades the search depth — never the validity of the result.
     */
    function refineBlockOrder(blocks, budget) {
        let ordered = blocks;
        if (ordered.length < 3) return ordered;
        let currentCost = blockOrderCost(ordered);

        // Returns null once the budget is spent, which unwinds the search and
        // hands back the best order priced so far.
        const price = (candidate) => {
            if (budget.steps <= 0) return null;
            budget.steps -= candidate.length;
            budget.evaluations++;
            if (budget.evaluations % 512 === 0 && Date.now() > budget.deadline) {
                budget.steps = 0;
                budget.safetyCutoff = true;
                return null;
            }
            return blockOrderCost(candidate);
        };

        for (let pass = 0; pass < 5; pass++) {
            let bestCost = currentCost;
            let bestOrder = null;
            let exhausted = false;

            for (let start = 0; start < ordered.length - 1 && !exhausted; start++) {
                for (let finish = start + 1; finish < ordered.length; finish++) {
                    const candidate = [
                        ...ordered.slice(0, start),
                        ...ordered.slice(start, finish + 1).reverse(),
                        ...ordered.slice(finish + 1)
                    ];
                    const candidateCost = price(candidate);
                    if (candidateCost === null) { exhausted = true; break; }
                    if (candidateCost + 0.000001 < bestCost) {
                        bestCost = candidateCost;
                        bestOrder = candidate;
                    }
                }
            }
            for (let from = 0; from < ordered.length && !exhausted; from++) {
                for (let to = 0; to <= ordered.length; to++) {
                    if (to === from || to === from + 1) continue;
                    const candidate = [...ordered];
                    const [moved] = candidate.splice(from, 1);
                    candidate.splice(to > from ? to - 1 : to, 0, moved);
                    const candidateCost = price(candidate);
                    if (candidateCost === null) { exhausted = true; break; }
                    if (candidateCost + 0.000001 < bestCost) {
                        bestCost = candidateCost;
                        bestOrder = candidate;
                    }
                }
            }

            // A better order found before the budget ran out is still a fully
            // measured improvement, so keep it rather than discarding the pass.
            if (bestOrder) {
                ordered = bestOrder;
                currentCost = bestCost;
            }
            if (exhausted || !bestOrder) break;
        }
        return ordered;
    }

    // Deterministic multi-start: seed from every block (in canonical key order),
    // refine each, and keep the cheapest. Ties keep the earlier canonical seed,
    // so the winner never depends on input array order or iteration timing.
    const allBlocks = buildBlocks();
    // Screening one seed costs ~blocks² transition lookups, so the number of
    // seeds screened is budgeted the same deterministic way as refinement
    // instead of being switched off wholesale past a block-count threshold.
    const screenableSeeds = Math.min(
        allBlocks.length,
        multiStartBlockLimit,
        Math.max(1, Math.floor(SCREENING_STEP_BUDGET / Math.max(1, allBlocks.length * allBlocks.length)))
    );
    const seedKeys = screenableSeeds > 1
        ? [...allBlocks]
            .sort((first, second) => compareStableKeys(first.key, second.key))
            .map((block) => block.key)
            .slice(0, screenableSeeds)
        : [null];

    // Screen every seed with the cheap greedy pass, then spend the expensive
    // reversal/relocation refinement only on the most promising few. Refining
    // all seeds exceeds the function CPU budget on a 30+ block route.
    const screened = seedKeys
        .map((seedKey) => {
            const greedy = nearestNeighborBlocks(allBlocks, seedKey);
            return { seedKey, greedy, cost: blockOrderCost(greedy) };
        })
        .sort((first, second) => (
            Math.abs(first.cost - second.cost) > 0.000001
                ? first.cost - second.cost
                : compareStableKeys(String(first.seedKey), String(second.seedKey))
        ))
        .slice(0, Math.max(1, refinedSeedCount));

    // One shared pool, drawn in screened order: the strongest seed refines to
    // convergence first and later seeds spend whatever remains. Splitting the
    // pool evenly instead starved every seed and cost Charlotte ~10 minutes of
    // route quality. Order is fixed, so the pool is always spent identically.
    const budget = {
        steps: refinementStepBudget,
        evaluations: 0,
        safetyCutoff: false,
        deadline: Date.now() + REFINEMENT_SAFETY_MS
    };

    let blocks = screened[0].greedy;
    let bestCost = Infinity;
    screened.forEach(({ greedy }) => {
        const candidate = refineBlockOrder(greedy, budget);
        const candidateCost = blockOrderCost(candidate);
        if (candidateCost + 0.000001 < bestCost) {
            bestCost = candidateCost;
            blocks = candidate;
        }
    });

    const { orientations } = blockOrderCost(blocks, true);
    return blocks.flatMap((block, index) => block.variants[orientations[index]]);
}