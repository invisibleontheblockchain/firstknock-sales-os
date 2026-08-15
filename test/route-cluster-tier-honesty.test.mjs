// Cluster-tier honesty, measured against a REAL bad route.
//
// Charlotte Precision Route 1J shipped reporting matrix_tier 'cluster',
// fallback false and status ok while 6,608,356 straight-line evaluations decided
// its sequencing. Two separate claims were wrong and neither was visible:
//
//   1. `intra_block_aerial_leg_count` counts candidate EVALUATIONS during search,
//      not legs in the stored route. Read as legs it is nonsense (6.6M legs on a
//      999-leg route) and it hid how much of the objective was aerial.
//   2. A cluster spans several streets, so an intra-unit leg is a real
//      cross-street decision priced without roads — not the house-number-order
//      walk the block tier's aerial legs are.
//
// These tests pin both distinctions. They are deliberately network-free: OSRM is
// not called, so the assertions are about what the tier CLASSIFIES, which is the
// part that lied.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    classifyFinalRouteLegs,
    createTieredMatrixMetricFns,
    planTieredRoadMatrix,
    TIER_CLUSTER
} from '../base44/shared/roadMatrixTiers.js';

const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/charlotte-route-1j-ashley-circle.json', import.meta.url))
);

const coordinateKey = (point) => `${Number(point.lat).toFixed(6)},${Number(point.lng).toFixed(6)}`;

/**
 * The Ashley Circle neighbourhood as the cluster tier actually saw it: stops
 * 207-213 are within ~0.2 mi of each other, so they land in ONE matrix unit and
 * their mutual order was decided on straight-line distance — including the
 * 210 -> 211 -> 212 -> 213 backtrack visible in the field screenshot.
 */
function ashleyNeighbourhoodPlan() {
    const stops = fixture.stops.filter((stop) => stop.stop >= 207 && stop.stop <= 213);
    const representativeByCoordKey = new Map();
    const blockKeyByCoordKey = new Map();
    const streetBlockKeyByCoordKey = new Map();
    stops.forEach((stop) => {
        const key = coordinateKey(stop);
        representativeByCoordKey.set(key, stops[0]);
        blockKeyByCoordKey.set(key, 'cluster:0');
        streetBlockKeyByCoordKey.set(key, `${stop.street_name}|${stop.zip_code}`);
    });
    return {
        ok: true,
        tier: TIER_CLUSTER,
        representativeByCoordKey,
        blockKeyByCoordKey,
        streetBlockKeyByCoordKey
    };
}

test('Route 1J: cluster-tier legs between different streets are reported as aerial, not road', () => {
    const plan = ashleyNeighbourhoodPlan();
    const order = fixture.stops.filter((stop) => stop.stop >= 207 && stop.stop <= 213);

    const legs = classifyFinalRouteLegs(order, plan);

    assert.equal(legs.legCount, 6);
    // 207->208, 208->209, 209->210 are the Ashley Circle sweep: same street.
    assert.equal(legs.aerialSameStreetBlockLegs, 3);
    // 210->Eaton, Eaton->Airport, Airport->Airline are cross-street decisions
    // the objective made without a road distance. This is the defect.
    assert.equal(legs.aerialCrossStreetLegs, 3);
    assert.equal(legs.roadLegs, 0);
});

test('Route 1J: a route with cross-street aerial legs cannot claim to be fully road optimized', () => {
    const legs = classifyFinalRouteLegs(
        fixture.stops.filter((stop) => stop.stop >= 207 && stop.stop <= 213),
        ashleyNeighbourhoodPlan()
    );
    // The exact predicate optimizeRouteRoadMatrix uses to set road_aware_degraded.
    assert.equal(legs.aerialCrossStreetLegs > 0, true);
    // The stored route reported the opposite, which is what this pins.
    assert.equal(fixture.stored_routing_metadata.fallback, false);
    assert.equal(fixture.stored_routing_metadata.distance_estimate, 'road_block_tier');
});

test('Candidate-search evaluations are counted separately from final-route legs', () => {
    const plan = ashleyNeighbourhoodPlan();
    // A matrix over the single cluster representative: any intra-unit leg would
    // otherwise resolve to the same point and price as zero, which is precisely
    // why the tier substitutes straight-line distance here.
    const matrix = { distances: [[0]], durations: [[0]] };
    plan.matrixPoints = [fixture.stops.find((stop) => stop.stop === 207)];

    const { distanceBetween, intraBlockLegCount, aerialEvaluationCounts } =
        createTieredMatrixMetricFns(matrix, plan);

    const ashley = fixture.stops.find((stop) => stop.stop === 209);
    const alsoAshley = fixture.stops.find((stop) => stop.stop === 210);
    const eaton = fixture.stops.find((stop) => stop.stop === 211);

    // Search prices the same pair many times; that is an evaluation count.
    distanceBetween(ashley, alsoAshley);
    distanceBetween(ashley, alsoAshley);
    distanceBetween(ashley, eaton);

    assert.equal(intraBlockLegCount.count, 3);
    assert.equal(aerialEvaluationCounts.sameStreetBlock, 2);
    assert.equal(aerialEvaluationCounts.crossStreetSameUnit, 1);
    // Evaluations must never be mistaken for the stored route's legs.
    assert.notEqual(intraBlockLegCount.count, classifyFinalRouteLegs([ashley, alsoAshley], plan).legCount);
});

test('The cluster tier records the true street block beside the matrix unit', () => {
    // 300 doors on 300 distinct streets forces more blocks than the 250-point
    // matrix can carry, which is the condition that selects the cluster tier.
    const doors = Array.from({ length: 300 }, (_, index) => ({
        address_hash: `${100 + index} STREET ${index} RD|28208`,
        house_number: 100 + index,
        street_name: `Street ${index} Rd`,
        zip_code: '28208',
        lat: 35.2 + index * 0.001,
        lng: -80.9 - index * 0.001
    }));

    const plan = planTieredRoadMatrix(doors, []);

    assert.equal(plan.ok, true);
    assert.equal(plan.tier, TIER_CLUSTER);
    assert.equal(plan.streetBlockKeyByCoordKey instanceof Map, true);
    assert.equal(plan.streetBlockKeyByCoordKey.size, doors.length);
    // The two views must be distinguishable: a unit key is not a street key.
    const sampleKey = coordinateKey(doors[0]);
    assert.notEqual(
        plan.streetBlockKeyByCoordKey.get(sampleKey),
        plan.blockKeyByCoordKey.get(sampleKey)
    );
});