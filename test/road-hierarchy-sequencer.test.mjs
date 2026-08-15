// The hierarchy is judged on a CLASS of geography, not on a city we already know
// failed. This fixture is a river with exactly one bridge: straight-line distance
// says the two banks are neighbours, the road network says every crossing costs a
// detour. Any sequencer that prices intra-cluster decisions aerially will weave
// across the water; one that prices them on roads will work a bank at a time.
//
// The road network is injected, so the assertions are about the ALGORITHM rather
// than about OSRM being reachable from CI.

import test from 'node:test';
import assert from 'node:assert/strict';
import { haversineMiles } from '../base44/shared/routeContinuityOptimizer.js';
import {
    partitionBlocksByDoorBudget,
    sequenceRoadHierarchy,
    MAX_CLUSTER_DOORS
} from '../base44/shared/roadHierarchySequencer.js';
import { roadAwareStreetSweep } from '../base44/shared/roadAwareStreetSweep.js';

const RIVER_LNG = -80.95;
const BRIDGE = { lat: 35.30, lng: RIVER_LNG };
const bank = (point) => (Number(point.lng) < RIVER_LNG ? 'west' : 'east');

/** Driving distance on the fixture network: crossing the river must use the bridge. */
function roadMiles(from, to) {
    if (bank(from) === bank(to)) return haversineMiles(from, to) * 1.25;
    return (haversineMiles(from, BRIDGE) + haversineMiles(BRIDGE, to)) * 1.25;
}

/**
 * A NARROW barrier, which is the shape that defeats aerial pricing: the two banks
 * are ~0.09 mi apart on the map but a crossing costs a multi-mile detour to the
 * only bridge. Streets run parallel to the river, so from any street the closest
 * street IN THE AIR is on the far bank while the closest street TO DRIVE is the
 * next one on the same bank. Aerial sequencing weaves; road sequencing must not.
 */
function buildRiverTerritory() {
    const doors = [];
    // Short cul-de-sac stubs facing each other across the water, paired by row.
    // Ending a stub leaves the rep 0.17 mi (in the air) from the stub on the far
    // bank and 0.28 mi from the next stub on their own bank, so straight-line
    // pricing prefers to cross on every single row.
    for (let row = 0; row < 20; row += 1) {
        const lat = 35.20 + row * 0.004;
        for (let house = 0; house < 8; house += 1) {
            doors.push({
                address_hash: `w-${row}-${house}`,
                house_number: 101 + house * 2,
                street_name: `West Row ${row} Ct`,
                city: 'Testville',
                zip_code: '00001',
                lat: lat + (house % 2) * 0.0001,
                lng: RIVER_LNG - 0.0008 - house * 0.0002
            });
            doors.push({
                address_hash: `e-${row}-${house}`,
                house_number: 101 + house * 2,
                street_name: `East Row ${row} Ct`,
                city: 'Testville',
                zip_code: '00001',
                lat: lat + (house % 2) * 0.0001,
                lng: RIVER_LNG + 0.0008 + house * 0.0002
            });
        }
    }
    return doors;
}

function measureOnFixtureNetwork(order) {
    let total = 0;
    for (let index = 0; index < order.length - 1; index += 1) {
        total += roadMiles(order[index], order[index + 1]);
    }
    return total;
}

/** Matrix built from the fixture road network, in the shape fetchRoadMatrix returns. */
function fixtureMatrix(points) {
    return {
        distances: points.map((from) => points.map((to) => roadMiles(from, to))),
        durations: null,
        objective: 'distance_miles',
        snapped: points.length,
        source: 'fixture:river',
        blocks: 1,
        pointCount: points.length
    };
}

test('every cluster is small enough to be priced door-to-door', () => {
    const doors = buildRiverTerritory();
    const entries = doors.map((door) => ({ block: { key: door.address_hash, doors: [door] }, representative: door }));
    const clusters = partitionBlocksByDoorBudget(entries);
    assert.ok(clusters.length >= 2, 'a large territory must split into clusters');
    clusters.forEach((cluster) => {
        assert.ok(
            cluster.doorCount <= MAX_CLUSTER_DOORS,
            `cluster of ${cluster.doorCount} doors cannot fit an exact matrix`
        );
    });
});

test('no order-affecting decision is priced aerially, and barrier crossings collapse', async () => {
    const doors = buildRiverTerritory();
    assert.ok(doors.length > 250, 'fixture must exceed the single-matrix door limit');

    const result = await sequenceRoadHierarchy(doors, { fetchMatrix: async (points) => fixtureMatrix(points) });
    assert.equal(result.ok, true);

    const telemetry = result.telemetry;
    assert.equal(telemetry.aerial_priced_legs, 0, 'no leg may be sequenced without road pricing');
    assert.equal(telemetry.clusters_degraded_to_aerial, 0);
    assert.equal(telemetry.cluster_order_road_priced, true);
    assert.equal(telemetry.road_aware_leg_pct, 100);
    assert.equal(telemetry.degraded, false, 'a fully road-priced route must not report degraded');

    // Exact-once: a sequencer that loses or duplicates a door is unusable however
    // good its mileage looks.
    assert.equal(result.order.length, doors.length);
    assert.equal(new Set(result.order.map((door) => door.address_hash)).size, doors.length);

    // The product question: does it stop crossing the barrier?
    const aerialOrder = roadAwareStreetSweep(doors);
    const crossings = (order) => order.reduce(
        (count, door, index) => (index > 0 && bank(order[index - 1]) !== bank(door) ? count + 1 : count),
        0
    );
    const hierarchyCrossings = crossings(result.order);
    const aerialCrossings = crossings(aerialOrder);
    // One crossing is the floor: both banks have doors, so the rep must cross once.
    assert.equal(
        hierarchyCrossings, 1,
        `road-priced sequencing crossed the river ${hierarchyCrossings}x; the floor is 1`
    );
    assert.ok(
        aerialCrossings > hierarchyCrossings,
        `fixture is not discriminating: aerial also crossed only ${aerialCrossings}x`
    );
    assert.ok(
        measureOnFixtureNetwork(result.order) < measureOnFixtureNetwork(aerialOrder),
        'road-priced sequencing must not drive further than aerial sequencing'
    );
});

test('a cluster whose matrix fails is reported as degraded, never as optimized', async () => {
    const doors = buildRiverTerritory();
    let matrixCalls = 0;
    const result = await sequenceRoadHierarchy(doors, {
        fetchMatrix: async (points) => {
            matrixCalls += 1;
            // Level 1 succeeds, the first cluster matrix fails.
            if (matrixCalls === 2) throw new Error('osrm 429');
            return fixtureMatrix(points);
        }
    });

    assert.equal(result.ok, true);
    assert.equal(result.telemetry.degraded, true);
    assert.equal(result.telemetry.clusters_degraded_to_aerial, 1);
    assert.ok(result.telemetry.aerial_priced_legs > 0);
    assert.ok(result.telemetry.road_aware_leg_pct < 100);
    assert.ok(result.telemetry.degraded_cluster_reasons.some((reason) => reason.includes('osrm 429')));
    // Still a complete route: degradation is reported, not thrown away.
    assert.equal(result.order.length, doors.length);
});

test('a losing cluster order is not hidden when level 1 cannot be priced', async () => {
    const doors = buildRiverTerritory();
    const result = await sequenceRoadHierarchy(doors, {
        fetchMatrix: async (points) => {
            // Level 1 is the first call; failing it means cluster order was aerial.
            if (points.length < 60) throw new Error('cluster matrix unavailable');
            return fixtureMatrix(points);
        }
    });
    assert.equal(result.ok, true);
    assert.equal(result.telemetry.cluster_order_road_priced, false);
    assert.equal(result.telemetry.degraded, true);
});