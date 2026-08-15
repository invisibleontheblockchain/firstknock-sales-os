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

    const doors = selectTerritoryDoors(cleaned.doors, spec.centre, spec.target_doors);
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
            label: barriers
                ? classifyGeography(geography, barriers, detour)
                : { geography: 'unmeasured', rationale: `barrier features unavailable: ${features.error}` },
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