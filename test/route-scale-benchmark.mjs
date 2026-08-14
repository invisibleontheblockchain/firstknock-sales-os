// Routing-work benchmark: what does a route of N doors actually cost the solver?
//
// The ceiling that matters is not the door count — it is the ROUTING UNIT count.
// A dense suburban 1,000 doors collapses onto ~70 street blocks; the same 1,000
// rural doors can produce 300+. Block count drives both the matrix size (and so
// the OSRM request count) and the sweep's refinement work, so this script
// measures units, matrix points, OSRM requests, and wall clock per door count.
//
// Usage:
//   node test/route-scale-benchmark.mjs                 # all door counts, both densities
//   node test/route-scale-benchmark.mjs 250,500 dense   # subset
//
// No network: the road metric is a synthetic 1.3x haversine, which is O(1) per
// lookup exactly like a matrix lookup, so solver timings stay representative
// while the OSRM request count is derived from the real tier planner.

import { buildStreetBlocks, roadAwareStreetSweep, REFINEMENT_STEP_BUDGET } from '../base44/shared/roadAwareStreetSweep.js';
import { haversineMiles } from '../base44/shared/routeContinuityOptimizer.js';
import { MATRIX_CHUNK_SIZE } from '../base44/shared/roadMatrix.js';
import {
    BLOCK_TIER_REFINEMENT_STEP_BUDGET,
    planTieredRoadMatrix,
    TIER_DOOR
} from '../base44/shared/roadMatrixTiers.js';

const DOOR_COUNTS = [250, 500, 750, 1000, 1250, 1500];

// Doors per blockface. Dense suburban tracts run long blocks; rural addressing
// scatters a handful of doors per named road, which is the expensive shape.
const DENSITIES = {
    dense: { doorsPerBlock: 14, streetSpacingDeg: 0.0022 },
    sparse: { doorsPerBlock: 3, streetSpacingDeg: 0.0075 }
};

/**
 * Synthetic territory: a grid of named streets with doors down each blockface,
 * every 7th street closed as a cul-de-sac stub so pocket-shaped geometry is
 * represented rather than a pure lattice.
 */
function buildTerritory(doorCount, { doorsPerBlock, streetSpacingDeg }) {
    const properties = [];
    const streetCount = Math.ceil(doorCount / doorsPerBlock);
    for (let street = 0; street < streetCount && properties.length < doorCount; street += 1) {
        const isPocket = street % 7 === 6;
        const baseLat = 35.2 + street * streetSpacingDeg;
        const baseLng = -80.85 + (isPocket ? 0.004 : 0);
        for (let door = 0; door < doorsPerBlock && properties.length < doorCount; door += 1) {
            const index = properties.length;
            properties.push({
                address_hash: `bench-${index}`,
                house_number: 100 + door * 2,
                street_name: `${isPocket ? 'Pocket' : 'Grid'} ${street} ${isPocket ? 'Ct' : 'St'}`,
                city: 'Charlotte',
                state: 'NC',
                zip_code: '28202',
                lat: baseLat + (door % 2 === 0 ? 0 : 0.00012),
                lng: baseLng + door * (isPocket ? 0.0004 : 0.00055)
            });
        }
    }
    return properties;
}

function osrmRequestCount(matrixPointCount) {
    return Math.ceil(matrixPointCount / MATRIX_CHUNK_SIZE) ** 2;
}

function measureMiles(order) {
    let miles = 0;
    for (let index = 0; index < order.length - 1; index += 1) {
        miles += haversineMiles(order[index], order[index + 1]) * 1.3;
    }
    return miles;
}

function runCell(doorCount, densityName) {
    const properties = buildTerritory(doorCount, DENSITIES[densityName]);
    const blockCount = buildStreetBlocks(properties).length;
    const plan = planTieredRoadMatrix(properties, [{ lat: 35.19, lng: -80.86 }]);
    const matrixPoints = plan.ok ? plan.matrixPoints.length : 0;

    const refinementStepBudget = plan.ok && plan.tier === TIER_DOOR
        ? REFINEMENT_STEP_BUDGET
        : BLOCK_TIER_REFINEMENT_STEP_BUDGET;

    if (global.gc) global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = Date.now();
    const order = roadAwareStreetSweep(properties, {
        distanceBetween: (from, to) => haversineMiles(from, to) * 1.3,
        refinementStepBudget
    });
    const sweepMs = Date.now() - startedAt;
    const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);

    const exactOnce = order.length === doorCount
        && new Set(order.map((property) => property.address_hash)).size === doorCount;

    return {
        doorCount,
        density: densityName,
        blockCount,
        tier: plan.ok ? plan.tier : `REFUSED:${plan.code}`,
        matrixPoints,
        osrmRequests: matrixPoints ? osrmRequestCount(matrixPoints) : 0,
        // The backend runs the sweep once per objective (distance and duration).
        sweepMs,
        requestSweepMs: sweepMs * 2,
        heapDeltaMb: Math.round(heapDeltaMb * 10) / 10,
        miles: Math.round(measureMiles(order) * 10) / 10,
        exactOnce
    };
}

const requestedCounts = (process.argv[2] || '')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
const requestedDensities = (process.argv[3] || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => Object.keys(DENSITIES).includes(value));

const counts = requestedCounts.length > 0 ? requestedCounts : DOOR_COUNTS;
const densities = requestedDensities.length > 0 ? requestedDensities : Object.keys(DENSITIES);

const rows = [];
densities.forEach((density) => {
    counts.forEach((doorCount) => {
        const row = runCell(doorCount, density);
        rows.push(row);
        console.log(JSON.stringify(row));
    });
});

console.log('');
console.log('doors  density  blocks  tier   matrixPts  osrmReqs  sweepMs  requestMs  heapMb  exactOnce');
rows.forEach((row) => {
    console.log([
        String(row.doorCount).padStart(5),
        row.density.padEnd(7),
        String(row.blockCount).padStart(6),
        String(row.tier).padEnd(6),
        String(row.matrixPoints).padStart(9),
        String(row.osrmRequests).padStart(8),
        String(row.sweepMs).padStart(7),
        String(row.requestSweepMs).padStart(9),
        String(row.heapDeltaMb).padStart(6),
        String(row.exactOnce).padStart(9)
    ].join('  '));
});