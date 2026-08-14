/**
 * Benchmark harness (not a pass/fail test): measures neighborhood re-entries —
 * how many times an optimized route leaves a subdivision and comes back to it
 * later. That bouncing is the reported field symptom.
 * Run with: node test/route-neighborhood-pocket-benchmark.mjs
 */
import { createServer } from 'vite';

function mulberry32(seed) {
    return function random() {
        seed |= 0;
        seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// Subdivisions of several streets each, laid out as separate pockets so leaving
// one before it is finished is always the wrong move.
function buildNeighborhoods(pocketCount, streetsPerPocket, doorsPerStreet, seed = 11) {
    const random = mulberry32(seed);
    const properties = [];
    const columns = Math.ceil(Math.sqrt(pocketCount));
    for (let pocket = 0; pocket < pocketCount; pocket++) {
        const row = Math.floor(pocket / columns);
        const column = pocket % columns;
        const pocketLat = 32.8 + row * 0.02;
        const pocketLng = -96.7 + column * 0.024;
        for (let street = 0; street < streetsPerPocket; street++) {
            const baseLat = pocketLat + (street % 3) * 0.0016 + random() * 0.0004;
            const baseLng = pocketLng + Math.floor(street / 3) * 0.0021 + random() * 0.0004;
            for (let door = 0; door < doorsPerStreet; door++) {
                properties.push({
                    address_hash: `pocket-${pocket}-${street}-${door}`,
                    house_number: 100 + door * 2,
                    street_name: `Pocket ${pocket} Street ${street}`,
                    subdivision_name: `Meadow Crossing ${pocket}`,
                    city: 'Mesquite',
                    zip_code: '75150',
                    lat: baseLat + door * 0.0003,
                    lng: baseLng + door * 0.0001,
                    effective_status: 'ELIGIBLE',
                });
            }
        }
    }
    for (let index = properties.length - 1; index > 0; index--) {
        const swap = Math.floor(random() * (index + 1));
        [properties[index], properties[swap]] = [properties[swap], properties[index]];
    }
    return properties;
}

function measure(order) {
    let miles = 0;
    let longest = 0;
    for (let index = 0; index < order.length - 1; index++) {
        const first = order[index];
        const second = order[index + 1];
        const x = (second.lng - first.lng) * Math.cos((first.lat + second.lat) / 2 * Math.PI / 180);
        const y = second.lat - first.lat;
        const leg = Math.sqrt(x * x + y * y) * 69;
        miles += leg;
        longest = Math.max(longest, leg);
    }
    const runs = order
        .map(({ subdivision_name: name }) => name)
        .filter((name, index, names) => index === 0 || name !== names[index - 1]);
    const reentries = runs.length - new Set(runs).size;
    return {
        aerialMiles: Number(miles.toFixed(3)),
        longestLegMiles: Number(longest.toFixed(3)),
        neighborhoodReentries: reentries,
    };
}

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
try {
    const { optimizeRouteByStreetSweep } = await vite.ssrLoadModule(
        '/src/components/logic/routeOptimizer.jsx',
    );
    for (const scenario of [
        { label: '9 subdivisions x 6 streets x 8 doors', pockets: 9, streets: 6, doors: 8 },
        { label: '25 subdivisions x 8 streets x 6 doors', pockets: 25, streets: 8, doors: 6 },
    ]) {
        const properties = buildNeighborhoods(scenario.pockets, scenario.streets, scenario.doors);
        const started = Date.now();
        const ordered = optimizeRouteByStreetSweep(properties, null, null, null);
        console.log(JSON.stringify({
            scenario: scenario.label,
            doors: properties.length,
            routedDoors: ordered.length,
            ...measure(ordered),
            elapsedMs: Date.now() - started,
        }));
    }
} finally {
    await vite.close();
}