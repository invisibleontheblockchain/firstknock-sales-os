// Benchmark harness for level-4 hotspot repair against the frozen Route 1J
// benchmark (363.695 measured road miles, 1,000 doors).
//
// Not a test: it needs a live OSRM and a hydrated 1,000-door route, so it is run
// deliberately rather than in the suite. Every number it prints comes from an
// independent /route measurement of the final order, never from optimizer state.
//
//   node test/route-hotspot-benchmark.mjs <doors.json> '<jsonConfig>'
//
// Config keys: hotspot (bool), hotspotPasses, hotspotFraction, hotspotMax, rounds.

import { readFileSync } from 'node:fs';

import { sequenceRoadHierarchy } from '../base44/shared/roadHierarchySequencer.js';
import { measureRoadPath } from '../base44/shared/roadPathMeasure.js';

const [doorsPath, rawConfig = '{}'] = process.argv.slice(2);
const config = JSON.parse(rawConfig);
const doors = JSON.parse(readFileSync(doorsPath, 'utf8'));
const properties = (Array.isArray(doors) ? doors : doors.stops || doors.properties)
    .filter((door) => Number.isFinite(Number(door.lat)) && Number.isFinite(Number(door.lng)));

const startedAt = Date.now();
const sequenced = await sequenceRoadHierarchy(properties, {
    measurePath: config.hotspot ? measureRoadPath : null,
    hotspotOptions: {
        ...(config.hotspotPasses ? { hotspotPasses: config.hotspotPasses } : {}),
        ...(config.hotspotFraction ? { hotspotFraction: config.hotspotFraction } : {}),
        ...(config.hotspotMax ? { hotspotMax: config.hotspotMax } : {}),
        ...(config.rounds ? { rounds: config.rounds } : {})
    }
});
if (!sequenced.ok) {
    console.log(JSON.stringify({ ok: false, code: sequenced.code, level: sequenced.level }));
    process.exit(1);
}
const solveSeconds = (Date.now() - startedAt) / 1000;

const measured = await measureRoadPath(sequenced.order, {});
const unique = new Set(sequenced.order.map((door) => `${door.lat.toFixed(6)},${door.lng.toFixed(6)}`));

console.log(JSON.stringify({
    ok: true,
    config,
    doors_in: properties.length,
    doors_out: sequenced.order.length,
    unique_doors_out: unique.size,
    solve_seconds: Number(solveSeconds.toFixed(1)),
    measured_total_miles: measured.ok ? Number(measured.totalMiles.toFixed(3)) : null,
    vs_frozen_363_695: measured.ok ? Number((measured.totalMiles - 363.695).toFixed(3)) : null,
    distribution: measured.ok ? measured.legDistribution : null,
    telemetry: sequenced.telemetry
}, null, 2));