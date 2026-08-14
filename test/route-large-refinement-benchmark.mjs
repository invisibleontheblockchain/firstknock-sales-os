/**
 * Benchmark harness (not a pass/fail test): measures ordered route mileage for
 * large routes, where block-order refinement previously did not run at all.
 * Run with: node test/route-large-refinement-benchmark.mjs
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

// Grid of streets with doors along each, so a greedy sweep has many chances to
// strand a block and double back.
export function buildSyntheticTerritory(streetCount, doorsPerStreet, seed = 7) {
    const random = mulberry32(seed);
    const properties = [];
    const columns = Math.ceil(Math.sqrt(streetCount));
    for (let street = 0; street < streetCount; street++) {
        const row = Math.floor(street / columns);
        const column = street % columns;
        const baseLat = 32.78 + row * 0.006 + random() * 0.0008;
        const baseLng = -96.62 + column * 0.008 + random() * 0.0008;
        for (let door = 0; door < doorsPerStreet; door++) {
            properties.push({
                address_hash: `syn-${street}-${door}`,
                house_number: 100 + door * 2,
                street_name: `Synthetic ${street} St`,
                city: 'Mesquite',
                zip_code: '75150',
                lat: baseLat + door * 0.00035,
                lng: baseLng + door * 0.00012,
                effective_status: 'ELIGIBLE',
            });
        }
    }
    // Shuffle so input order cannot flatter the optimizer.
    for (let index = properties.length - 1; index > 0; index--) {
        const swap = Math.floor(random() * (index + 1));
        [properties[index], properties[swap]] = [properties[swap], properties[index]];
    }
    return properties;
}

export function aerialMiles(order) {
    let total = 0;
    for (let index = 0; index < order.length - 1; index++) {
        const first = order[index];
        const second = order[index + 1];
        const x = (second.lng - first.lng) * Math.cos((first.lat + second.lat) / 2 * Math.PI / 180);
        const y = second.lat - first.lat;
        total += Math.sqrt(x * x + y * y) * 69;
    }
    return total;
}

export function longestLegMiles(order) {
    let longest = 0;
    for (let index = 0; index < order.length - 1; index++) {
        const first = order[index];
        const second = order[index + 1];
        const x = (second.lng - first.lng) * Math.cos((first.lat + second.lat) / 2 * Math.PI / 180);
        const y = second.lat - first.lat;
        longest = Math.max(longest, Math.sqrt(x * x + y * y) * 69);
    }
    return longest;
}

const scenarios = [
    { label: '200 streets x 6 doors (windowed refinement tier)', streets: 200, doors: 6 },
    { label: '600 streets x 4 doors (spatial-sort seed tier)', streets: 600, doors: 4 },
];

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
try {
    const { optimizeRouteByStreetSweep } = await vite.ssrLoadModule(
        '/src/components/logic/routeOptimizer.jsx',
    );
    for (const scenario of scenarios) {
        const properties = buildSyntheticTerritory(scenario.streets, scenario.doors);
        const started = Date.now();
        const ordered = optimizeRouteByStreetSweep(properties, null, null, null);
        const elapsed = Date.now() - started;
        console.log(JSON.stringify({
            scenario: scenario.label,
            doors: properties.length,
            routedDoors: ordered.length,
            aerialMiles: Number(aerialMiles(ordered).toFixed(3)),
            longestLegMiles: Number(longestLegMiles(ordered).toFixed(3)),
            elapsedMs: elapsed,
        }));
    }
} finally {
    await vite.close();
}