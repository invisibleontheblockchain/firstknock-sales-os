// Read-only reproduction of the user's seven-stop neighborhood example.
// Offline: node scripts/route-troutman-diagnosis.mjs
// Fresh public OSRM measurements: node scripts/route-troutman-diagnosis.mjs --live
// No Base44 access, saved-route updates, or production optimization calls.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { buildStreetBlocks, roadAwareStreetSweep } from '../base44/shared/roadAwareStreetSweep.js';
import { measureRouteCandidate } from '../base44/shared/routeCandidateSelection.js';
import { buildLocalDrivingCandidates, reviewLocalDrivingNeighborhoods } from '../base44/shared/localDrivingNeighborhoods.js';

const fixture = JSON.parse(fs.readFileSync(new URL('../test/fixtures/troutman-neighborhood-311-317.json', import.meta.url), 'utf8'));
const live = process.argv.includes('--live');
const properties = fixture.properties;
const startLocation = properties[0];
const endLocation = properties.at(-1);
const doors = properties.slice(1, -1);
const indexFor = point => properties.findIndex(p => p.address_hash === point.address_hash);
const byStop = new Map(properties.map(p => [p.stop, p]));
const base = fixture.provider;

async function request(service, points, options) {
    const url = new URL(`${base}/${service}/v1/${fixture.profile}/${points.map(p => `${p.lng},${p.lat}`).join(';')}`);
    for (const [key, value] of Object.entries(options)) url.searchParams.set(key, value);
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    assert.equal(response.ok && data.code === 'Ok', true, `${data.code}: ${data.message}`);
    return data;
}

const matrix = live ? await request('table', properties, { annotations: 'duration,distance' }) : fixture.matrix;
const durationBetween = (a, b) => matrix.durations[indexFor(a)][indexFor(b)] / 60;
const distanceBetween = (a, b) => matrix.distances[indexFor(a)][indexFor(b)] / 1609.344;
const swept = roadAwareStreetSweep(doors, { startLocation, endLocation, distanceBetween: durationBetween });
const neighborhood = buildLocalDrivingCandidates(doors, {
    optimizationCostBetween: (a, b) => durationBetween(a, b) * 60, distanceBetween,
}, startLocation, endLocation)[0].order;
const candidates = [
    { type: 'saved', order: doors },
    { type: 'exact_road_street_sweep', order: swept },
    { type: 'user_desired', order: fixture.desiredOrder.map(n => byStop.get(n)) },
    { type: 'neighborhood_driving', order: neighborhood },
];

const comparisons = [];
for (const candidate of candidates) {
    assert.deepEqual(candidate.order.map(p => p.stop).sort(), doors.map(p => p.stop).sort());
    const measured = measureRouteCandidate(candidate, { startLocation, endLocation, durationBetween, distanceBetween });
    const order = candidate.order.map(p => p.stop);
    let continuous;
    if (live) {
        const data = await request('route', [startLocation, ...candidate.order, endLocation], {
            overview: 'false', steps: 'true', continue_straight: 'true',
        });
        const route = data.routes[0];
        continuous = { miles: route.distance / 1609.344, seconds: route.duration,
            uturns: route.legs.flatMap(leg => leg.steps).filter(step => step.maneuver.modifier === 'uturn').length };
    } else {
        continuous = fixture.measurements.find(result => JSON.stringify(result.order) === JSON.stringify(order));
    }
    comparisons.push({ candidate: candidate.type, order: order.join(' → '),
        tableMiles: measured.distance, tableSeconds: measured.duration * 60,
        continuousMiles: continuous?.miles ?? null, continuousSeconds: continuous?.seconds ?? null,
        uturns: continuous?.uturns ?? null });
}

const saved = comparisons[0], desired = comparisons[2];
assert.ok(desired.continuousMiles < saved.continuousMiles, 'Desired order must improve the saved continuous drive.');
assert.ok(desired.continuousSeconds < saved.continuousSeconds, 'Desired order must reduce continuous drive time.');
assert.deepEqual(neighborhood.map(p => p.stop), fixture.desiredOrder, 'Local driving search must discover the requested service tour.');
if (live) {
    const reviewed = await reviewLocalDrivingNeighborhoods(doors, { startLocation, endLocation,
        vehicleBaseUrl: fixture.provider, vehicleProfile: fixture.profile });
    assert.deepEqual(reviewed.properties.map(p => p.stop), fixture.desiredOrder);
    assert.equal(reviewed.diagnostics.validation, 'whole_route');
    console.log(JSON.stringify({ liveReview: reviewed.diagnostics }));
}
console.table(comparisons.map(row => ({ ...row,
    tableMiles: row.tableMiles.toFixed(3), tableSeconds: row.tableSeconds.toFixed(1),
    continuousMiles: row.continuousMiles?.toFixed(3), continuousSeconds: row.continuousSeconds?.toFixed(1),
})));
console.log(JSON.stringify({ mode: live ? 'live' : 'frozen', measuredAt: live ? new Date().toISOString() : fixture.measuredAt,
    fixedBoundaries: [startLocation.stop, endLocation.stop],
    streetBlocks: buildStreetBlocks(doors).map(block => ({ key: block.key, stops: block.doors.map(p => p.stop) })),
    savedRouting: fixture.savedRouting, reviewFailure: fixture.reviewFailure,
    interpretation: 'The desired order splits Winding Forest across the Crooked Branch visit. Exact road costs improve the sweep, but drive-only scoring ties another service order. The frozen measurements use unrestricted road snaps, without driveway or curb-side verification.',
}, null, 2));
