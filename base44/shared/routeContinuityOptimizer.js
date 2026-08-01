// Canonical street/subdivision continuity optimizer shared by backend route
// generation paths. The cost function is injected so the same block sweep can be
// priced with straight-line miles (fallback) or a real road matrix (OSRM).
//
// Door-level reordering is intentionally NOT supported here: streets and
// subdivision accesses stay atomic, and only whole blocks are reordered or
// reversed. That invariant is what keeps generated routes walkable.

export function isValidPoint(point) {
    if (!point || point.lat === null || point.lat === undefined || point.lat === '' || point.lng === null || point.lng === undefined || point.lng === '') {
        return false;
    }
    const lat = Number(point?.lat);
    const lng = Number(point?.lng);
    return Number.isFinite(lat)
        && Number.isFinite(lng)
        && lat >= -90
        && lat <= 90
        && lng >= -180
        && lng <= 180
        && !(Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001);
}

export function haversineMiles(a, b) {
    if (!isValidPoint(a) || !isValidPoint(b)) return 9999;
    const r = 3959;
    const dLat = (Number(b.lat) - Number(a.lat)) * Math.PI / 180;
    const dLng = (Number(b.lng) - Number(a.lng)) * Math.PI / 180;
    const lat1 = Number(a.lat) * Math.PI / 180;
    const lat2 = Number(b.lat) * Math.PI / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return r * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

const STREET_SUFFIX_ALIASES = new Map([
    ['STREET', 'ST'], ['ST', 'ST'],
    ['AVENUE', 'AVE'], ['AVE', 'AVE'],
    ['BOULEVARD', 'BLVD'], ['BLVD', 'BLVD'],
    ['DRIVE', 'DR'], ['DR', 'DR'],
    ['LANE', 'LN'], ['LN', 'LN'],
    ['COURT', 'CT'], ['CT', 'CT'],
    ['PLACE', 'PL'], ['PL', 'PL'],
    ['ROAD', 'RD'], ['RD', 'RD'],
    ['CIRCLE', 'CIR'], ['CIR', 'CIR'],
    ['TRAIL', 'TRL'], ['TRL', 'TRL'],
    ['PARKWAY', 'PKWY'], ['PKWY', 'PKWY'],
    ['HIGHWAY', 'HWY'], ['HWY', 'HWY'],
    ['TERRACE', 'TER'], ['TER', 'TER'],
    ['PLAZA', 'PLZ'], ['PLZ', 'PLZ'],
    ['SQUARE', 'SQ'], ['SQ', 'SQ'],
    ['TURNPIKE', 'TPKE'], ['TPKE', 'TPKE'],
    ['WAY', 'WAY']
]);

const EMPTY_AREA_LABELS = new Set([
    '', 'N A', 'NA', 'NONE', 'NULL', 'UNKNOWN', 'NO SUBDIVISION', 'UNINCORPORATED'
]);

export function routePropertyOrderFingerprint(propertiesOrHashes) {
    if (!Array.isArray(propertiesOrHashes) || propertiesOrHashes.length === 0) return '';
    const identities = propertiesOrHashes.map((value) => {
        if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
        return String(
            value?.address_hash
            || value?.legacy_hash
            || value?.id
            || '',
        ).trim();
    });
    if (identities.some((identity) => !identity)) return '';

    let first = 2166136261;
    let second = 2246822507;
    identities.forEach((identity) => {
        const framed = `${identity.length}:${identity}|`;
        for (let index = 0; index < framed.length; index += 1) {
            const code = framed.charCodeAt(index);
            first = Math.imul(first ^ code, 16777619);
            second = Math.imul(second ^ code, 3266489909);
        }
    });
    return `${identities.length}:${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function normalizeKeyPart(value) {
    if (value === undefined || value === null) return '';
    return String(value)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

function firstMeaningfulValue(values) {
    for (const value of values) {
        if (value !== undefined && value !== null && String(value).trim()) return value;
    }
    return '';
}

function canonicalStreetName(property) {
    const rawStreet = firstMeaningfulValue([
        property?.street_name,
        property?.streetName,
        property?.raw_metadata?.street_name,
        property?.raw_metadata?.streetName,
        property?.raw_metadata?.STREET_NAME,
        property?.raw_metadata?.street
    ]);
    const tokens = normalizeKeyPart(rawStreet).split(' ').filter(Boolean);
    if (tokens.length === 0) return '';
    const finalToken = tokens[tokens.length - 1];
    if (STREET_SUFFIX_ALIASES.has(finalToken)) {
        // Canonicalize equivalent spellings, but retain the suffix category.
        // MAIN ST and MAIN RD must never collapse into the same street block.
        tokens[tokens.length - 1] = STREET_SUFFIX_ALIASES.get(finalToken);
    }
    return tokens.join(' ');
}

function canonicalSubdivisionName(property) {
    const value = normalizeKeyPart(firstMeaningfulValue([
        property?.subdivision_name,
        property?.subdivisionName,
        typeof property?.subdivision === 'string' ? property.subdivision : null,
        property?.subdivision?.name,
        property?.raw_metadata?.subdivision_name,
        property?.raw_metadata?.subdivisionName,
        property?.raw_metadata?.SUBDIVISION_NAME,
        typeof property?.raw_metadata?.subdivision === 'string'
            ? property.raw_metadata.subdivision
            : null,
        property?.raw_metadata?.subdivision?.name
    ]));
    return EMPTY_AREA_LABELS.has(value) ? '' : value;
}

function canonicalAreaScope(property) {
    const city = normalizeKeyPart(firstMeaningfulValue([
        property?.city,
        property?.raw_metadata?.city,
        property?.raw_metadata?.CITY
    ]));
    const state = normalizeKeyPart(firstMeaningfulValue([
        property?.state,
        property?.raw_metadata?.state,
        property?.raw_metadata?.STATE
    ]));
    const zip = normalizeKeyPart(firstMeaningfulValue([
        property?.zip_code,
        property?.zip,
        property?.raw_metadata?.zip,
        property?.raw_metadata?.ZIP
    ])).slice(0, 5);
    return `${city}|${state}|${zip}`;
}

function stableDoorIdentity(property, inputIndex) {
    return normalizeKeyPart(firstMeaningfulValue([
        property?.address_hash,
        property?.legacy_hash,
        property?.id,
        property?.full_address,
        property?.address
    ])) || `INPUT ${String(inputIndex).padStart(6, '0')}`;
}

function numericHouseNumber(property) {
    const raw = firstMeaningfulValue([
        property?.house_number,
        property?.houseNumber,
        String(property?.full_address || property?.address || '').match(/^\s*(\d+)/)?.[1]
    ]);
    const match = String(raw || '').match(/\d+/);
    return match ? Number(match[0]) : null;
}

function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function compareDoors(left, right) {
    const leftNumber = numericHouseNumber(left.property);
    const rightNumber = numericHouseNumber(right.property);
    const leftSide = leftNumber === null ? 2 : Math.abs(leftNumber % 2) === 1 ? 0 : 1;
    const rightSide = rightNumber === null ? 2 : Math.abs(rightNumber % 2) === 1 ? 0 : 1;
    if (leftSide !== rightSide) return leftSide - rightSide;
    if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) {
        return leftSide === 1 ? rightNumber - leftNumber : leftNumber - rightNumber;
    }
    const identityResult = compareText(left.identity, right.identity);
    if (identityResult !== 0) return identityResult;
    const latResult = Number(left.lat || 0) - Number(right.lat || 0);
    if (latResult !== 0) return latResult;
    const lngResult = Number(left.lng || 0) - Number(right.lng || 0);
    return lngResult !== 0 ? lngResult : left.inputIndex - right.inputIndex;
}

function centroidOfDoors(doors) {
    const validDoors = doors.filter(isValidPoint);
    if (validDoors.length === 0) return { lat: null, lng: null };
    return {
        lat: validDoors.reduce((sum, door) => sum + Number(door.lat), 0) / validDoors.length,
        lng: validDoors.reduce((sum, door) => sum + Number(door.lng), 0) / validDoors.length
    };
}

export function buildCanonicalStreetBlocks(properties) {
    const grouped = new Map();
    properties.forEach((property, inputIndex) => {
        const door = {
            property,
            inputIndex,
            identity: stableDoorIdentity(property, inputIndex),
            lat: property?.lat,
            lng: property?.lng
        };
        const scope = canonicalAreaScope(property);
        const subdivisionName = canonicalSubdivisionName(property);
        const streetName = canonicalStreetName(property);
        const safeStreetName = streetName || `UNKNOWN ${door.identity}`;
        const accessKey = subdivisionName
            ? `SUBDIVISION|${scope}|${subdivisionName}`
            : `STREET|${scope}|${safeStreetName}`;
        const streetKey = `${accessKey}|STREET|${safeStreetName}`;
        door.accessKey = accessKey;
        door.streetKey = streetKey;
        if (!grouped.has(streetKey)) {
            grouped.set(streetKey, {
                key: streetKey,
                streetKey,
                accessKey,
                subdivisionName,
                streetName: safeStreetName,
                doors: []
            });
        }
        grouped.get(streetKey).doors.push(door);
    });

    return [...grouped.values()]
        .sort((left, right) => compareText(left.key, right.key))
        .map((block) => {
            const forward = [...block.doors].sort(compareDoors);
            const centroid = centroidOfDoors(forward);
            return {
                ...block,
                ...centroid,
                variants: [forward, [...forward].reverse()]
            };
        });
}

/**
 * Build the continuity optimizer bound to one cost function.
 * @param {(from: object, to: object) => number} distanceFn cost between two points
 */
export function createContinuityOptimizer(distanceFn = haversineMiles) {
    const cost = (a, b) => {
        const value = Number(distanceFn(a, b));
        return Number.isFinite(value) && value >= 0 ? value : haversineMiles(a, b);
    };

    function blockPathCost(blocks, startLocation = null, endLocation = null, includePath = false) {
        if (blocks.length === 0) {
            return includePath ? { cost: 0, orientations: [] } : 0;
        }
        const costs = blocks.map(() => [Infinity, Infinity]);
        const previous = blocks.map(() => [-1, -1]);

        for (let orientation = 0; orientation < 2; orientation++) {
            const firstDoor = blocks[0].variants[orientation][0];
            costs[0][orientation] = isValidPoint(startLocation)
                ? cost(startLocation, firstDoor)
                : 0;
        }

        for (let blockIndex = 1; blockIndex < blocks.length; blockIndex++) {
            for (let orientation = 0; orientation < 2; orientation++) {
                const firstDoor = blocks[blockIndex].variants[orientation][0];
                for (let previousOrientation = 0; previousOrientation < 2; previousOrientation++) {
                    const previousDoors = blocks[blockIndex - 1].variants[previousOrientation];
                    const previousLastDoor = previousDoors[previousDoors.length - 1];
                    const candidateCost = costs[blockIndex - 1][previousOrientation]
                        + cost(previousLastDoor, firstDoor);
                    if (candidateCost + 0.0000001 < costs[blockIndex][orientation]) {
                        costs[blockIndex][orientation] = candidateCost;
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
            const candidateCost = costs[blocks.length - 1][orientation]
                + (isValidPoint(endLocation) ? cost(finalDoor, endLocation) : 0);
            if (candidateCost + 0.0000001 < finalCost) {
                finalCost = candidateCost;
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

    /** Cheapest real transition cost into a block, over both orientations. */
    function entryDistance(from, block) {
        const fromPoint = from?.variants
            ? (() => {
                let best = Infinity;
                from.variants.forEach((variant) => {
                    const exit = variant[variant.length - 1];
                    block.variants.forEach((candidate) => {
                        best = Math.min(best, cost(exit, candidate[0]));
                    });
                });
                return best;
            })()
            : null;
        if (fromPoint !== null) return fromPoint;
        return Math.min(...block.variants.map((variant) => cost(from, variant[0])));
    }

    function compareBlockPosition(left, right) {
        const leftValid = isValidPoint(left);
        const rightValid = isValidPoint(right);
        if (leftValid !== rightValid) return leftValid ? -1 : 1;
        if (leftValid && Number(left.lat) !== Number(right.lat)) return Number(left.lat) - Number(right.lat);
        if (leftValid && Number(left.lng) !== Number(right.lng)) return Number(left.lng) - Number(right.lng);
        return compareText(left.key, right.key);
    }

    function optimizeBlockOrder(blocks, startLocation = null, endLocation = null) {
        if (blocks.length <= 1) return [...blocks];
        if (blocks.length > 500) {
            const cellSize = 0.01;
            const spatiallySorted = [...blocks].sort((left, right) => {
                const leftValid = isValidPoint(left);
                const rightValid = isValidPoint(right);
                if (leftValid !== rightValid) return leftValid ? -1 : 1;
                if (!leftValid) return compareText(left.key, right.key);
                const leftRow = Math.floor(Number(left.lat) / cellSize);
                const rightRow = Math.floor(Number(right.lat) / cellSize);
                if (leftRow !== rightRow) return leftRow - rightRow;
                if (Number(left.lng) !== Number(right.lng)) {
                    return leftRow % 2 === 0
                        ? Number(left.lng) - Number(right.lng)
                        : Number(right.lng) - Number(left.lng);
                }
                return compareText(left.key, right.key);
            });
            const reversed = [...spatiallySorted].reverse();
            return blockPathCost(reversed, startLocation, endLocation) + 0.000001
                < blockPathCost(spatiallySorted, startLocation, endLocation)
                ? reversed
                : spatiallySorted;
        }
        const remaining = [...blocks].sort(compareBlockPosition);
        const ordered = [];
        // Greedy selection is priced door-to-door, not centroid-to-centroid: a
        // centroid is not a place a rep can drive to, so a road matrix keyed by
        // real coordinates could never resolve it.
        let current = isValidPoint(startLocation) ? startLocation : null;

        while (remaining.length > 0) {
            let bestIndex = 0;
            if (current) {
                let bestDistance = Infinity;
                for (let index = 0; index < remaining.length; index++) {
                    const candidateDistance = entryDistance(current, remaining[index]);
                    if (candidateDistance + 0.0000001 < bestDistance) {
                        bestDistance = candidateDistance;
                        bestIndex = index;
                    }
                }
            }
            const [next] = remaining.splice(bestIndex, 1);
            ordered.push(next);
            current = next;
        }

        // Refine only the relatively small block graph. Door-level optimization is
        // intentionally forbidden here because it can split a street or subdivision.
        if (ordered.length <= 80) {
            let currentCost = blockPathCost(ordered, startLocation, endLocation);
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
                        const candidateCost = blockPathCost(candidate, startLocation, endLocation);
                        if (candidateCost + 0.000001 < bestCost) {
                            bestCost = candidateCost;
                            bestOrder = candidate;
                        }
                    }
                }
                // Or-opt relocation: a reversal alone cannot rescue a block that
                // the greedy pass stranded, which is what produces the long tail
                // detour seen on the Mesquite regression route.
                for (let from = 0; from < ordered.length; from++) {
                    for (let to = 0; to <= ordered.length; to++) {
                        if (to === from || to === from + 1) continue;
                        const candidate = [...ordered];
                        const [moved] = candidate.splice(from, 1);
                        candidate.splice(to > from ? to - 1 : to, 0, moved);
                        const candidateCost = blockPathCost(candidate, startLocation, endLocation);
                        if (candidateCost + 0.000001 < bestCost) {
                            bestCost = candidateCost;
                            bestOrder = candidate;
                        }
                    }
                }
                if (!bestOrder) break;
                ordered.splice(0, ordered.length, ...bestOrder);
                currentCost = bestCost;
            }
        }
        return ordered;
    }

    function orientBlockSequence(blocks, startLocation = null, endLocation = null) {
        const { cost: sequenceCost, orientations } = blockPathCost(blocks, startLocation, endLocation, true);
        return {
            cost: sequenceCost,
            blocks: blocks.map((block, index) => ({
                ...block,
                selectedDoors: block.variants[orientations[index]]
            }))
        };
    }

    function buildSubdivisionAccessBlocks(streetBlocks) {
        const grouped = new Map();
        streetBlocks.forEach((streetBlock) => {
            if (!grouped.has(streetBlock.accessKey)) grouped.set(streetBlock.accessKey, []);
            grouped.get(streetBlock.accessKey).push(streetBlock);
        });

        return [...grouped.entries()]
            .sort(([leftKey], [rightKey]) => compareText(leftKey, rightKey))
            .map(([accessKey, accessStreetBlocks]) => {
                const orderedStreets = optimizeBlockOrder(accessStreetBlocks);
                const forward = orientBlockSequence(orderedStreets).blocks;
                const forwardDoors = forward.flatMap((block) => block.selectedDoors);
                const reverse = [...forward]
                    .reverse()
                    .map((block) => ({ ...block, selectedDoors: [...block.selectedDoors].reverse() }));
                const centroid = centroidOfDoors(forwardDoors);
                return {
                    key: accessKey,
                    accessKey,
                    ...centroid,
                    variants: [forwardDoors, [...forwardDoors].reverse()],
                    streetVariants: [forward, reverse]
                };
            });
    }

    function orderStreetBlocksThroughAccesses(accessBlocks, startLocation, endLocation) {
        const orderedAccesses = optimizeBlockOrder(accessBlocks, startLocation, endLocation);
        const { orientations } = blockPathCost(
            orderedAccesses,
            startLocation,
            endLocation,
            true
        );
        return orderedAccesses.flatMap((accessBlock, index) =>
            accessBlock.streetVariants[orientations[index]]
        );
    }

    function splitOversizedStreetBlocks(streetBlocks, housesPerRoute) {
        const maximumPreferredSize = Math.max(housesPerRoute, Math.floor(housesPerRoute * 1.25));
        const result = [];
        streetBlocks.forEach((streetBlock) => {
            const doors = streetBlock.selectedDoors;
            if (doors.length <= maximumPreferredSize) {
                result.push({
                    ...streetBlock,
                    variants: [doors, [...doors].reverse()]
                });
                return;
            }

            const pieceCount = Math.ceil(doors.length / housesPerRoute);
            const baseSize = Math.floor(doors.length / pieceCount);
            const remainder = doors.length % pieceCount;
            let cursor = 0;
            for (let pieceIndex = 0; pieceIndex < pieceCount; pieceIndex++) {
                const pieceSize = baseSize + (pieceIndex < remainder ? 1 : 0);
                const pieceDoors = doors.slice(cursor, cursor + pieceSize);
                cursor += pieceSize;
                const centroid = centroidOfDoors(pieceDoors);
                result.push({
                    ...streetBlock,
                    key: `${streetBlock.key}|PIECE|${String(pieceIndex + 1).padStart(4, '0')}`,
                    ...centroid,
                    selectedDoors: pieceDoors,
                    variants: [pieceDoors, [...pieceDoors].reverse()]
                });
            }
        });
        return result;
    }

    function chunkStreetBlocks(streetBlocks, housesPerRoute) {
        const chunks = [];
        const totalRemainingFrom = new Array(streetBlocks.length + 1).fill(0);
        for (let index = streetBlocks.length - 1; index >= 0; index--) {
            totalRemainingFrom[index] = totalRemainingFrom[index + 1] + streetBlocks[index].selectedDoors.length;
        }

        let cursor = 0;
        while (cursor < streetBlocks.length) {
            let runningCount = 0;
            let best = null;
            for (let end = cursor; end < streetBlocks.length; end++) {
                runningCount += streetBlocks[end].selectedDoors.length;
                const next = streetBlocks[end + 1] || null;
                const sameAccess = Boolean(next && next.accessKey === streetBlocks[end].accessKey);
                const sameStreet = Boolean(next && next.streetKey === streetBlocks[end].streetKey);
                const remainder = totalRemainingFrom[end + 1];
                let score = Math.abs(runningCount - housesPerRoute);
                if (sameAccess) score += housesPerRoute * 0.18;
                if (sameStreet) score += housesPerRoute * 0.45;
                if (remainder > 0 && remainder < housesPerRoute * 0.35) score += housesPerRoute * 0.25;
                const boundaryRank = sameStreet ? 2 : sameAccess ? 1 : 0;

                if (!best
                    || score + 0.000001 < best.score
                    || (Math.abs(score - best.score) <= 0.000001 && boundaryRank < best.boundaryRank)) {
                    best = { end, score, boundaryRank };
                }
                if (runningCount >= housesPerRoute * 1.5) break;
            }
            const selectedEnd = best?.end ?? cursor;
            chunks.push(streetBlocks.slice(cursor, selectedEnd + 1));
            cursor = selectedEnd + 1;
        }
        return chunks;
    }

    function orientRouteChunk(streetBlocks, startLocation, endLocation) {
        const forward = orientBlockSequence(streetBlocks, startLocation, endLocation);
        const reversed = orientBlockSequence([...streetBlocks].reverse(), startLocation, endLocation);
        const selected = reversed.cost + 0.000001 < forward.cost ? reversed : forward;
        return selected.blocks.flatMap((block) => block.selectedDoors);
    }

    function routeDistance(properties, startLocation, endLocation = null) {
        if (properties.length === 0) return 0;
        let total = isValidPoint(startLocation) ? cost(startLocation, properties[0]) : 0;
        for (let i = 0; i < properties.length - 1; i++) total += cost(properties[i], properties[i + 1]);
        if (isValidPoint(endLocation)) total += cost(properties[properties.length - 1], endLocation);
        return Math.round(total * 100) / 100;
    }

    /** Full continuity pipeline: properties in, ordered door chunks out. */
    function buildRouteChunks(properties, housesPerRoute, startLocation = null, endLocation = null) {
        const streetBlocks = buildCanonicalStreetBlocks(properties);
        const accessBlocks = buildSubdivisionAccessBlocks(streetBlocks);
        const orderedStreetBlocks = orderStreetBlocksThroughAccesses(accessBlocks, startLocation, endLocation);
        const splittableStreetBlocks = splitOversizedStreetBlocks(orderedStreetBlocks, housesPerRoute);
        const rawRouteChunks = chunkStreetBlocks(splittableStreetBlocks, housesPerRoute);
        return {
            streetBlocks,
            accessBlocks,
            doorChunks: rawRouteChunks.map((chunk) => orientRouteChunk(chunk, startLocation, endLocation))
        };
    }

    return {
        cost,
        blockPathCost,
        buildCanonicalStreetBlocks,
        buildSubdivisionAccessBlocks,
        orderStreetBlocksThroughAccesses,
        splitOversizedStreetBlocks,
        chunkStreetBlocks,
        orientRouteChunk,
        routeDistance,
        buildRouteChunks
    };
}

/** Exact-once invariant shared by every backend routing path. */
export function verifyExactOnceDoors(doorChunks, expectedCount) {
    const routedInputIndexes = doorChunks.flatMap((chunk) => chunk.map((door) => door.inputIndex));
    const unique = new Set(routedInputIndexes);
    return routedInputIndexes.length === expectedCount
        && unique.size === expectedCount
        && routedInputIndexes.every((inputIndex) =>
            Number.isInteger(inputIndex) && inputIndex >= 0 && inputIndex < expectedCount
        );
}