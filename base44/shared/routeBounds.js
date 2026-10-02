const EARTH_RADIUS_MILES = 3958.7613;
const DEFAULT_MAX_2_OPT_PASSES = 25;
const DEFAULT_MAX_2_OPT_STOPS = 300;
const IMPROVEMENT_EPSILON_MILES = 1e-9;

function numericCoordinate(value) {
    if (value === null || value === undefined || value === '') return null;
    const coordinate = Number(value);
    return Number.isFinite(coordinate) ? coordinate : null;
}

function normalizedPoint(point) {
    const lat = numericCoordinate(point?.lat);
    const lng = numericCoordinate(point?.lng);
    if (lat === null || lng === null) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
}

function assertPoint(point, label) {
    const normalized = normalizedPoint(point);
    if (!normalized) {
        throw new TypeError(`${label} must contain finite lat/lng coordinates within geographic bounds.`);
    }
    return normalized;
}

function resolveBounds({ startLocation = null, endLocation = null, returnToStart = false } = {}) {
    const start = startLocation === null || startLocation === undefined
        ? null
        : assertPoint(startLocation, 'startLocation');

    if (returnToStart && !start) {
        throw new TypeError('returnToStart requires a valid startLocation.');
    }

    const end = returnToStart
        ? start
        : endLocation === null || endLocation === undefined
            ? null
            : assertPoint(endLocation, 'endLocation');

    return { start, end };
}

function assertStops(stops) {
    if (!Array.isArray(stops)) {
        throw new TypeError('stops must be an array.');
    }

    return stops.map((stop, index) => ({
        stop,
        point: assertPoint(stop, `stops[${index}]`),
    }));
}

export function isValidRoutePoint(point) {
    return normalizedPoint(point) !== null;
}

export function haversineDistanceMiles(from, to) {
    const a = assertPoint(from, 'from');
    const b = assertPoint(to, 'to');
    const toRadians = (degrees) => degrees * Math.PI / 180;
    const dLat = toRadians(b.lat - a.lat);
    const dLng = toRadians(b.lng - a.lng);
    const lat1 = toRadians(a.lat);
    const lat2 = toRadians(b.lat);
    const haversine = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    const clamped = Math.min(1, Math.max(0, haversine));
    return EARTH_RADIUS_MILES * 2 * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped));
}

export function calculateRouteDistanceMiles(stops, bounds = {}) {
    const routeStops = assertStops(stops);
    const { start, end } = resolveBounds(bounds);
    const path = [];
    if (start) path.push(start);
    path.push(...routeStops.map(({ point }) => point));
    if (end) path.push(end);

    let distance = 0;
    for (let index = 0; index < path.length - 1; index += 1) {
        distance += haversineDistanceMiles(path[index], path[index + 1]);
    }
    return distance;
}

function nearestNeighbor(stops, start, end) {
    if (stops.length <= 1) return [...stops];

    const remaining = [...stops];
    const ordered = [];
    let current = start;
    let finalStop = null;

    // Reserve a door close to the fixed finish so routes above the 2-opt safety
    // cap still end near home instead of wherever the greedy walk happens to stop.
    if (end && remaining.length > 1) {
        let finalIndex = 0;
        let finalDistance = Infinity;
        remaining.forEach(({ point }, index) => {
            const distance = haversineDistanceMiles(point, end);
            if (distance < finalDistance) {
                finalDistance = distance;
                finalIndex = index;
            }
        });
        [finalStop] = remaining.splice(finalIndex, 1);
    }

    if (!current) {
        let firstIndex = 0;
        if (end) {
            let farthestDistance = -Infinity;
            remaining.forEach(({ point }, index) => {
                const distance = haversineDistanceMiles(point, end);
                if (distance > farthestDistance) {
                    farthestDistance = distance;
                    firstIndex = index;
                }
            });
        }
        const [first] = remaining.splice(firstIndex, 1);
        ordered.push(first);
        current = first.point;
    }

    while (remaining.length > 0) {
        let nearestIndex = 0;
        let nearestDistance = Infinity;
        remaining.forEach(({ point }, index) => {
            const distance = haversineDistanceMiles(current, point);
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestIndex = index;
            }
        });
        const [next] = remaining.splice(nearestIndex, 1);
        ordered.push(next);
        current = next.point;
    }

    if (finalStop) ordered.push(finalStop);

    return ordered;
}

function boundaryDistance(from, to) {
    return from && to ? haversineDistanceMiles(from, to) : 0;
}

function fixedEndpoint2Opt(route, start, end, maxPasses) {
    if (route.length < 2 || maxPasses <= 0) return route;

    for (let pass = 0; pass < maxPasses; pass += 1) {
        let bestImprovement = IMPROVEMENT_EPSILON_MILES;
        let bestStart = -1;
        let bestEnd = -1;

        for (let segmentStart = 0; segmentStart < route.length - 1; segmentStart += 1) {
            const before = segmentStart === 0 ? start : route[segmentStart - 1].point;

            for (let segmentEnd = segmentStart + 1; segmentEnd < route.length; segmentEnd += 1) {
                const after = segmentEnd === route.length - 1 ? end : route[segmentEnd + 1].point;
                const oldBoundaryDistance = boundaryDistance(before, route[segmentStart].point)
                    + boundaryDistance(route[segmentEnd].point, after);
                const newBoundaryDistance = boundaryDistance(before, route[segmentEnd].point)
                    + boundaryDistance(route[segmentStart].point, after);
                const improvement = oldBoundaryDistance - newBoundaryDistance;

                if (improvement > bestImprovement) {
                    bestImprovement = improvement;
                    bestStart = segmentStart;
                    bestEnd = segmentEnd;
                }
            }
        }

        if (bestStart < 0) break;
        const reversed = route.slice(bestStart, bestEnd + 1).reverse();
        route.splice(bestStart, reversed.length, ...reversed);
    }

    return route;
}

export function optimizeRouteWithBounds(stops, {
    startLocation = null,
    endLocation = null,
    returnToStart = false,
    max2OptPasses = DEFAULT_MAX_2_OPT_PASSES,
    max2OptStops = DEFAULT_MAX_2_OPT_STOPS,
} = {}) {
    const routeStops = assertStops(stops);
    const { start, end } = resolveBounds({ startLocation, endLocation, returnToStart });
    const safeMaxPasses = Number.isFinite(Number(max2OptPasses))
        ? Math.max(0, Math.floor(Number(max2OptPasses)))
        : DEFAULT_MAX_2_OPT_PASSES;
    const safeMaxStops = Number.isFinite(Number(max2OptStops))
        ? Math.max(0, Math.floor(Number(max2OptStops)))
        : DEFAULT_MAX_2_OPT_STOPS;

    const ordered = nearestNeighbor(routeStops, start, end);
    if (ordered.length <= safeMaxStops) {
        fixedEndpoint2Opt(ordered, start, end, safeMaxPasses);
    }

    return ordered.map(({ stop }) => stop);
}
