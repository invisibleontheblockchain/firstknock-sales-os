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
        endLocation = null
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

    function nearestNeighborBlocks(blocks) {
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
        if (isValidPoint(startLocation)) {
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

    function refineBlockOrder(blocks) {
        let ordered = blocks;
        if (ordered.length > 120) return ordered;
        let currentCost = blockOrderCost(ordered);
        for (let pass = 0; pass < 5; pass++) {
            let bestCost = currentCost;
            let bestOrder = null;
            for (let start = 0; start < ordered.length - 1; start++) {
                for (let finish = start + 1; finish < ordered.length; finish++) {
                    const candidate = [
                        ...ordered.slice(0, start),
                        ...ordered.slice(start, finish + 1).reverse(),
                        ...ordered.slice(finish + 1)
                    ];
                    const candidateCost = blockOrderCost(candidate);
                    if (candidateCost + 0.000001 < bestCost) {
                        bestCost = candidateCost;
                        bestOrder = candidate;
                    }
                }
            }
            for (let from = 0; from < ordered.length; from++) {
                for (let to = 0; to <= ordered.length; to++) {
                    if (to === from || to === from + 1) continue;
                    const candidate = [...ordered];
                    const [moved] = candidate.splice(from, 1);
                    candidate.splice(to > from ? to - 1 : to, 0, moved);
                    const candidateCost = blockOrderCost(candidate);
                    if (candidateCost + 0.000001 < bestCost) {
                        bestCost = candidateCost;
                        bestOrder = candidate;
                    }
                }
            }
            if (!bestOrder) break;
            ordered = bestOrder;
            currentCost = bestCost;
        }
        return ordered;
    }

    const blocks = refineBlockOrder(nearestNeighborBlocks(buildBlocks()));
    const { orientations } = blockOrderCost(blocks, true);
    return blocks.flatMap((block, index) => block.variants[orientations[index]]);
}