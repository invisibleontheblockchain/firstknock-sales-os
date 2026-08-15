// Regression coverage for the corpus geography classifier.
//
// The first version of the barrier measurement compared each door to its NEAREST
// neighbour and scored the road/aerial RATIO. Real doors sit 35-140 ft apart, so
// driving around one ordinary block scored as a 72x detour, and 10 of 16 shortlisted
// territories came back as "barrier" territories — including a 2,252 door/sq-mi grid
// whose only water was a single pond in the bounding box. A corpus labelled that way
// would have claimed to span eight routing problems while actually testing one.
//
// These tests pin the corrected rule: severance is measured in ABSOLUTE excess road
// miles over a quarter-mile separation band, and mapped hydrology alone never earns
// a barrier label.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    classifyGeography,
    measureDetourProfile,
    LIMITED_CROSSING_EXCESS_MILES,
    DETOUR_BAND_MIN_MILES,
    DETOUR_BAND_MAX_MILES
} from '../scripts/corpus/territoryGeography.js';

const geography = (overrides = {}) => ({
    door_count: 1000,
    area_sq_mi: 0.6,
    doors_per_sq_mi: 1600,
    median_nearest_neighbour_miles: 0.01,
    p90_nearest_neighbour_miles: 0.03,
    distinct_streets: 45,
    median_doors_per_street: 12,
    terminal_street_door_pct: 8,
    through_street_door_pct: 88,
    ...overrides
});

const barriers = (overrides = {}) => ({
    waterway_meters_per_sq_mi: 0,
    water_body_count: 0,
    motorway_meters_per_sq_mi: 0,
    railway_meters_per_sq_mi: 0,
    bridge_count: 0,
    ...overrides
});

const severedDetour = (overrides = {}) => ({
    ok: true,
    pairs: 30,
    excess_median_miles: 0.4,
    excess_p95_miles: 1.4,
    limited_crossing_pct: 28,
    detour_median: 2.1,
    detour_p95: 6.2,
    ...overrides
});

test('GEO-01 a dense grid with one mapped pond is not a barrier territory', () => {
    // This is the exact false positive that broke the first classification pass.
    const result = classifyGeography(
        geography({ doors_per_sq_mi: 2252, terminal_street_door_pct: 0, through_street_door_pct: 91 }),
        barriers({ water_body_count: 1, bridge_count: 27 }),
        { ok: true, pairs: 30, excess_median_miles: 0.05, excess_p95_miles: 0.2, limited_crossing_pct: 3, detour_median: 1.4, detour_p95: 3.1 }
    );

    assert.equal(result.geography, 'dense_suburban_grid');
});

test('GEO-02 hydrology alone never produces a barrier label', () => {
    // 128 rural ponds are farm ponds, not crossings. Without measured road excess
    // the territory must fall through to its density class.
    const result = classifyGeography(
        geography({ doors_per_sq_mi: 39, area_sq_mi: 25.4, p90_nearest_neighbour_miles: 0.4, terminal_street_door_pct: 3 }),
        barriers({ water_body_count: 128, waterway_meters_per_sq_mi: 2400 }),
        { ok: true, pairs: 24, excess_median_miles: 0.1, excess_p95_miles: 0.3, limited_crossing_pct: 4, detour_median: 1.5, detour_p95: 2.2 }
    );

    assert.equal(result.geography, 'rural');
});

test('GEO-03 measured water severance yields river_lake_barrier and reports the evidence', () => {
    const result = classifyGeography(
        geography({ doors_per_sq_mi: 700 }),
        barriers({ water_body_count: 12, waterway_meters_per_sq_mi: 2600 }),
        severedDetour()
    );

    assert.equal(result.geography, 'river_lake_barrier');
    assert.match(result.rationale, /\+1\.4 mi of road at p95/);
    assert.match(result.rationale, /28% past \+0\.75 mi/);
});

test('GEO-04 corridor severance yields highway_separated, and both barrier kinds yield mixed', () => {
    const corridor = classifyGeography(
        geography({ doors_per_sq_mi: 1176, terminal_street_door_pct: 1 }),
        barriers({ motorway_meters_per_sq_mi: 3027, railway_meters_per_sq_mi: 3263 }),
        severedDetour()
    );
    assert.equal(corridor.geography, 'highway_separated');

    const both = classifyGeography(
        geography({ doors_per_sq_mi: 667 }),
        barriers({ water_body_count: 12, waterway_meters_per_sq_mi: 5100, motorway_meters_per_sq_mi: 5222 }),
        severedDetour()
    );
    assert.equal(both.geography, 'mixed_geography');
});

test('GEO-05 severance requires both absolute excess and prevalence', () => {
    const b = barriers({ water_body_count: 12, waterway_meters_per_sq_mi: 2600 });

    const oneOffCrossing = classifyGeography(
        geography(),
        b,
        severedDetour({ excess_p95_miles: 2.0, limited_crossing_pct: 6 })
    );
    assert.notEqual(oneOffCrossing.geography, 'river_lake_barrier', 'a single long pair is not a territory-wide barrier');

    const smallExcess = classifyGeography(
        geography(),
        b,
        severedDetour({ excess_p95_miles: LIMITED_CROSSING_EXCESS_MILES - 0.01, limited_crossing_pct: 40 })
    );
    assert.notEqual(smallExcess.geography, 'river_lake_barrier', 'sub-threshold excess is street geometry');
});

test('GEO-06 unmeasured road distance can never produce a barrier label', () => {
    for (const detour of [null, { ok: false, error: 'INSUFFICIENT_ROAD_PAIRS' }]) {
        const result = classifyGeography(
            geography({ doors_per_sq_mi: 700 }),
            barriers({ water_body_count: 40, waterway_meters_per_sq_mi: 9000, motorway_meters_per_sq_mi: 9000 }),
            detour
        );
        assert.ok(!['river_lake_barrier', 'highway_separated'].includes(result.geography));
    }
});

test('GEO-07 the detour sample only uses pairs inside the separation band', async () => {
    // Touching doors and far-apart doors both mislead: one measures block geometry,
    // the other measures the whole territory. Only the band is sampled.
    const doors = [
        { lat: 35.2, lng: -80.8 },       // anchor
        { lat: 35.20005, lng: -80.8 },   // ~18 ft — below band
        { lat: 35.2036, lng: -80.8 },    // ~0.25 mi — in band
        { lat: 35.3, lng: -80.8 }        // ~6.9 mi — above band
    ];
    const seen = [];
    const sampler = async (pairs) => {
        seen.push(...pairs);
        return pairs.map((pair) => pair.aerialMiles + 1.2);
    };

    const profile = await measureDetourProfile(doors, sampler, { pairCount: 4 });

    assert.ok(seen.length > 0, 'band pairs were measured');
    for (const pair of seen) {
        assert.ok(pair.aerialMiles >= DETOUR_BAND_MIN_MILES && pair.aerialMiles <= DETOUR_BAND_MAX_MILES);
    }
    assert.equal(profile.ok, false, 'too few band pairs is reported, never guessed');
    assert.equal(profile.error, 'INSUFFICIENT_ROAD_PAIRS');
});