// Measure one candidate territory end to end, from input-side evidence only.
//
// Everything here runs BEFORE any solver sees the doors: extraction, cleaning, door
// geography, road-graph topology, barrier features, and the road-detour profile. No
// route, mileage, window size or candidate result is in scope, which is what makes
// the resulting geography label usable as a SELECTION criterion instead of a
// post-hoc justification for whichever strategy happened to win.
//
// The classifier this calls is frozen as of corpus selection: once the eight are
// chosen, a surprising solver result is a finding about the solver, never a reason
// to relabel the geography.
//
// NOT PRODUCTION CODE — research tooling under scripts/.

import {
    describeDoorGeography,
    describeBarriers,
    classifyGeography,
    measureDetourProfile,
    territoryBounds
} from './territoryGeography.js';
import { fetchBarrierFeatures } from './overpassBarriers.js';
import { fetchRoadNetwork, describeRoadTopology } from './roadGraph.js';
import { sampleRoadPairs } from './sampleRoadPairs.js';
import { cleanDoorRows } from './cleanDoors.js';
import { selectTerritoryDoors } from './buildFixture.js';

/**
 * The declared fixture door budget. A geography label is only trustworthy when it
 * was measured on the population the solver will actually receive, so a run capped
 * below this is a probe: fully measured, deliberately left unlabelled.
 */
export const FIXTURE_DOOR_BUDGET = 1000;

/** Area of an extraction box, so the retrieval-vs-footprint gap is visible. */
function bboxAreaSqMi(bounds) {
    const heightMiles = (bounds.maxLat - bounds.minLat) * 69.05;
    const midLat = (((bounds.maxLat + bounds.minLat) / 2) * Math.PI) / 180;
    const widthMiles = (bounds.maxLng - bounds.minLng) * 69.05 * Math.cos(midLat);
    return Math.round(heightMiles * widthMiles * 1000) / 1000;
}

/**
 * Bounding box for an extraction query, derived from the candidate's own measured
 * area with margin. Returned as data so the fixture manifest can record the exact
 * query that produced the doors.
 */
export function queryBoundsFor(centre, areaSqMi, marginPct = 30) {
    const halfSide = (Math.sqrt(Math.max(Number(areaSqMi) || 0, 0.05)) / 2) * (1 + marginPct / 100);
    const latDeg = halfSide / 69.05;
    const lngDeg = halfSide / (69.05 * Math.cos((centre.lat * Math.PI) / 180));
    return {
        minLat: round6(centre.lat - latDeg),
        maxLat: round6(centre.lat + latDeg),
        minLng: round6(centre.lng - lngDeg),
        maxLng: round6(centre.lng + lngDeg)
    };
}

/**
 * @param {object} spec `{ id, centre, query_bounds, target_doors }`
 * @param {Function} fetchRows `(bounds) => Promise<Array<row>>` raw extraction
 * @returns {Promise<object>} `{ ok, spec, rawRows, doors, cleaned, measurements }`
 */
export async function measureTerritory(spec, fetchRows, { pairCount = 60 } = {}) {
    const rawRows = await fetchRows(spec.query_bounds);
    const cleaned = cleanDoorRows(rawRows);
    if (!cleaned.doors.length) return { ok: false, error: 'NO_CLEAN_DOORS', spec, cleaned };

    // Deterministic contiguous selection — nearest-to-centre with a stable tiebreak,
    // the identical rule the fixture builder applies. Never a random sample: the
    // measured geography must describe the exact door set the solver receives. When
    // the box holds fewer clean doors than the budget, all of them are used and the
    // real count is recorded rather than padded outward.
    const doors = selectTerritoryDoors(cleaned.doors, spec.centre, spec.target_doors);
    // Density comes from the doors' OWN occupied footprint, never the retrieval box,
    // so an oversized extraction container cannot make packed homes read as rural.
    const geography = describeDoorGeography(doors);
    const bounds = territoryBounds(doors);

    // Both OSM pulls use the SELECTED doors' bbox rather than the query box, so the
    // barrier and road-graph evidence describes the territory that will actually be
    // routed — not the slack around it.
    const [features, network] = await Promise.all([
        fetchBarrierFeatures(bounds),
        fetchRoadNetwork(bounds)
    ]);
    const barriers = features.ok ? describeBarriers(features, geography) : null;
    const roadTopology = network.ok ? describeRoadTopology(network, geography) : null;
    const detour = await measureDetourProfile(doors, sampleRoadPairs, { pairCount });

    // A label is only as honest as the population it was measured on. A probe subset
    // is reported with every metric but NO geography, so a temporary cap can never
    // dilute density into a wrong label that later gets frozen into the corpus.
    const isFixturePopulation = doors.length >= FIXTURE_DOOR_BUDGET
        || doors.length === cleaned.doors.length;
    const extractionAreaSqMi = bboxAreaSqMi(spec.query_bounds);

    return {
        ok: true,
        spec,
        rawRows,
        doors,
        cleaned,
        measurements: {
            geography,
            barriers,
            road_topology: roadTopology?.ok ? roadTopology : null,
            detour,
            // Classification runs ONLY on the declared fixture population.
            label: !isFixturePopulation
                ? {
                    geography: 'unclassified_probe',
                    rationale: `${doors.length} of ${cleaned.doors.length} clean doors is a probe cap below the ${FIXTURE_DOOR_BUDGET}-door budget; density would not describe the fixture`
                }
                : barriers
                    ? classifyGeography(geography, barriers, detour)
                    : { geography: 'unmeasured', rationale: `barrier features unavailable: ${features.error}` },
            // Retrieval container vs actual routed footprint, kept as separate numbers
            // so a density figure can never be read against the wrong denominator.
            extraction: {
                query_bounds: spec.query_bounds,
                extraction_bbox_area_sq_mi: extractionAreaSqMi,
                occupied_door_footprint_sq_mi: geography.area_sq_mi,
                footprint_share_of_extraction_pct: extractionAreaSqMi
                    ? Math.round((geography.area_sq_mi / extractionAreaSqMi) * 1000) / 10
                    : null,
                clean_doors_per_sq_mi_of_extraction: extractionAreaSqMi
                    ? Math.round(cleaned.doors.length / extractionAreaSqMi)
                    : null,
                selected_doors_per_sq_mi_of_footprint: geography.doors_per_sq_mi,
                median_nearest_neighbour_miles: geography.median_nearest_neighbour_miles,
                p90_nearest_neighbour_miles: geography.p90_nearest_neighbour_miles,
                is_fixture_population: isFixturePopulation,
                door_budget: FIXTURE_DOOR_BUDGET
            },
            // Hygiene exposure: how much of the raw extraction survived cleaning, so a
            // fixture disproportionately shaped by cleaning is visible at a glance
            // rather than hidden behind a round door count.
            hygiene: {
                raw_row_count: cleaned.raw_row_count,
                clean_door_count: cleaned.doors.length,
                selected_door_count: doors.length,
                removed_pct: cleaned.raw_row_count
                    ? Math.round(((cleaned.raw_row_count - cleaned.doors.length) / cleaned.raw_row_count) * 1000) / 10
                    : 0,
                removed: cleaned.removed
            },
            osm_data_timestamp: features.osmDataTimestamp || network.osmDataTimestamp || null
        }
    };
}

function round6(value) {
    return Math.round(value * 1e6) / 1e6;
}