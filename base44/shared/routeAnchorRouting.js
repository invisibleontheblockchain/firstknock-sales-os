import { haversineDistanceMiles, optimizeRouteWithBounds } from './routeBounds.js';

// Move whole street sweeps toward the anchor while preserving the saved walking
// order inside each sweep. Reversing a sweep changes entry/exit without scattering
// its doors across the route, as a door-level nearest-neighbor pass would do.
export function optimizeAnchoredStreetRoute(properties, anchor) {
    const groups = new Map();
    properties.forEach((property, index) => {
        const addressStreet = String(property.address || property.address_line || '').split(',')[0].replace(/^\s*\d+[\w-]*\s+/, '');
        const street = String(property.street_name || addressStreet).trim().toLowerCase().replace(/\s+/g, ' ');
        const key = street || `door:${index}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(property);
    });
    const centroids = [...groups.values()].map(stops => ({
        stops,
        lat: stops.reduce((sum, stop) => sum + Number(stop.lat), 0) / stops.length,
        lng: stops.reduce((sum, stop) => sum + Number(stop.lng), 0) / stops.length,
    }));
    const ordered = optimizeRouteWithBounds(centroids, { startLocation: anchor, endLocation: anchor });
    if (!ordered.length) return [];
    const entry = (group, direction) => group.stops[direction ? group.stops.length - 1 : 0];
    const exit = (group, direction) => group.stops[direction ? 0 : group.stops.length - 1];
    // Two-state dynamic programming chooses the best direction for every saved
    // sweep given the street order and the fixed start/finish.
    const costs = ordered.map(() => [0, 0]);
    const parents = ordered.map(() => [0, 0]);
    for (let direction = 0; direction < 2; direction++) costs[0][direction] = haversineDistanceMiles(anchor, entry(ordered[0], direction));
    for (let index = 1; index < ordered.length; index++) {
        for (let direction = 0; direction < 2; direction++) {
            const alternatives = [0, 1].map(previous => costs[index - 1][previous]
                + haversineDistanceMiles(exit(ordered[index - 1], previous), entry(ordered[index], direction)));
            const parent = alternatives[0] <= alternatives[1] ? 0 : 1;
            costs[index][direction] = alternatives[parent];
            parents[index][direction] = parent;
        }
    }
    const last = ordered.length - 1;
    const finishCosts = [0, 1].map(direction => costs[last][direction] + haversineDistanceMiles(exit(ordered[last], direction), anchor));
    let direction = finishCosts[0] <= finishCosts[1] ? 0 : 1;
    const sweeps = [];
    for (let index = last; index >= 0; index--) {
        sweeps.push(direction ? [...ordered[index].stops].reverse() : ordered[index].stops);
        direction = parents[index][direction];
    }
    return sweeps.reverse().flat();
}
