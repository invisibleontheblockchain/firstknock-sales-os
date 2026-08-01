/**
 * Pure metrics for the development-only route comparison map.
 *
 * Distances come from the baked Mesquite driving matrix, so every number here is
 * real road distance. Straight-line values are kept only as a diagnostic, and
 * geographic crossings are reported with the road cost of each crossing leg so a
 * rendering artifact can be told apart from genuine backtracking.
 */

const TAIL_LEG_COUNT = 14;

function haversineMiles(first, second) {
    const radians = Math.PI / 180;
    const earthRadiusMiles = 3958.7613;
    const latitudeDelta = (second.lat - first.lat) * radians;
    const longitudeDelta = (second.lng - first.lng) * radians;
    const chord = Math.sin(latitudeDelta / 2) ** 2
        + Math.cos(first.lat * radians) * Math.cos(second.lat * radians)
        * Math.sin(longitudeDelta / 2) ** 2;
    return 2 * earthRadiusMiles * Math.asin(Math.sqrt(chord));
}

function orientation(origin, first, second) {
    return (first.lng - origin.lng) * (second.lat - origin.lat)
        - (first.lat - origin.lat) * (second.lng - origin.lng);
}

function segmentsCross(firstStart, firstEnd, secondStart, secondEnd) {
    const first = orientation(secondStart, secondEnd, firstStart);
    const second = orientation(secondStart, secondEnd, firstEnd);
    const third = orientation(firstStart, firstEnd, secondStart);
    const fourth = orientation(firstStart, firstEnd, secondEnd);
    return ((first > 0 && second < 0) || (first < 0 && second > 0))
        && ((third > 0 && fourth < 0) || (third < 0 && fourth > 0));
}

export function describeRoute(order, { roadMiles, roadMinutes }) {
    const legs = order.slice(0, -1).map((property, index) => {
        const next = order[index + 1];
        const straightMiles = haversineMiles(property, next);
        const miles = roadMiles(property, next);
        return {
            index,
            from: property,
            to: next,
            miles,
            minutes: roadMinutes(property, next),
            straightMiles,
            detourRatio: straightMiles > 0 ? miles / straightMiles : 1,
            isTail: index >= order.length - 1 - TAIL_LEG_COUNT,
            sameStreet: property.street_name.toUpperCase() === next.street_name.toUpperCase()
        };
    });

    const crossings = [];
    for (let first = 0; first < legs.length; first++) {
        for (let second = first + 2; second < legs.length; second++) {
            if (segmentsCross(legs[first].from, legs[first].to, legs[second].from, legs[second].to)) {
                crossings.push({ first, second });
            }
        }
    }

    const streets = order.map(({ street_name: street }) => street.toUpperCase());
    const lastSeen = new Map();
    const reentries = [];
    streets.forEach((street, index) => {
        const previous = lastSeen.get(street);
        if (previous !== undefined && previous !== index - 1) reentries.push({ street, index, previous });
        lastSeen.set(street, index);
    });

    const total = values => values.reduce((sum, value) => sum + value, 0);
    const longestLegs = [...legs].sort((left, right) => right.miles - left.miles).slice(0, 5);

    return {
        order,
        legs,
        crossings,
        reentries,
        longestLegs,
        longestLegIndexes: new Set(longestLegs.map(({ index }) => index)),
        roadMiles: total(legs.map(({ miles }) => miles)),
        roadMinutes: total(legs.map(({ minutes }) => minutes)),
        straightMiles: total(legs.map(({ straightMiles }) => straightMiles)),
        tailMiles: total(legs.slice(-TAIL_LEG_COUNT).map(({ miles }) => miles)),
        longestLegMiles: Math.max(...legs.map(({ miles }) => miles)),
        transitions: streets.filter((street, index) => index > 0 && street !== streets[index - 1]).length
    };
}

/** Stops the route drives past and only visits much later. */
export function findPassedStops(described, roadMiles, minimumLaterStops = 6) {
    const { order, legs } = described;
    const passed = [];
    legs.forEach((leg, index) => {
        order.slice(index + 2 + minimumLaterStops).forEach((later) => {
            if (roadMiles(leg.from, later) < leg.miles * 0.6) {
                passed.push({ atIndex: index, at: leg.from, later });
            }
        });
    });
    return passed;
}

export const TAIL_LEG_WINDOW = TAIL_LEG_COUNT;