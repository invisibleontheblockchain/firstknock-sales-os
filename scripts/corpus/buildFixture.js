// Build one immutable benchmark fixture, with the provenance needed to trust it.
//
// A fixture is an UNORDERED SET OF DOORS plus a manifest. It never contains a route,
// a sequence, a decomposition, a window size, or a mileage — a fixture that carried
// its own winning answer would let a later solver be graded against the strategy
// that produced it.
//
// It also carries only routing-relevant fields. Owner names, phones, emails, account
// and lead metadata are dropped at extraction, both because they are irrelevant to
// road distance and because a benchmark corpus is the wrong place for resident
// contact data.
//
// The manifest exists so that a number measured today can be defended in six
// months: the extraction bounds and timestamp, the raw row count, the cleaning rule
// version and its per-reason removals, the door/address/coordinate counts, a
// checksum over the unordered set, and the routing profile plus road-engine and OSM
// data versions the measurements were taken against.
//
// NOT PRODUCTION CODE — research tooling under scripts/.

import { createHash } from 'node:crypto';

import { cleanDoorRows, CLEANING_RULE_VERSION } from './cleanDoors.js';
import { describeDoorGeography, haversineMiles, territoryBounds } from './territoryGeography.js';

export const FIXTURE_SCHEMA_VERSION = 'corpus_fixture_v1';

/**
 * Fields a fixture door keeps. Everything else in the source row is discarded:
 * `key` is a stable pseudonym, not the production hash, so the fixture cannot be
 * joined back to a customer record.
 */
function toFixtureDoor(row, index) {
    return {
        key: `d${String(index).padStart(4, '0')}_${createHash('sha256').update(String(row.address_hash)).digest('hex').slice(0, 10)}`,
        lat: round6(row.lat),
        lng: round6(row.lng),
        street_name: row.street_name,
        house_number: row.house_number,
        zip_code: row.zip_code ?? null,
        subdivision_name: row.subdivision_name ?? null
    };
}

/**
 * Checksum over the unordered door set.
 *
 * Sorted by content before hashing, so the same doors extracted in a different page
 * order produce the same checksum, and any change to a coordinate or an address
 * changes it. This is what makes "immutable benchmark input" checkable.
 */
export function fixtureChecksum(doors) {
    const canonical = doors
        .map((door) => `${door.street_name}|${door.house_number}|${door.zip_code ?? ''}|${door.lat}|${door.lng}`)
        .sort()
        .join('\n');
    return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * Select the doors that make up a territory.
 *
 * Nearest-to-centre up to the target, and NOT padded outward to reach a round
 * number: if the geography only supports 700 clean doors inside its own bounds, the
 * fixture is 700 doors and says so. Stretching a rural territory until it hits 1,000
 * would change the routing problem being measured.
 */
export function selectTerritoryDoors(cleanRows, centre, targetDoors) {
    return cleanRows
        .map((row) => ({ row, miles: haversineMiles(centre, row) }))
        .sort((a, b) => (a.miles - b.miles) || (a.row.address_hash < b.row.address_hash ? -1 : 1))
        .slice(0, targetDoors)
        .map((entry) => entry.row);
}

/**
 * Build a fixture and its manifest.
 *
 * @param {object} spec `{ id, geography_label_pending, query_bounds, centre, target_doors }`
 * @param {Array<object>} rawRows every row the extraction query returned
 * @param {object} measurements `{ geography, barriers, road_topology, detour }`
 * @param {object} engine `{ routing_profile, road_engine, matrix_schema_version, cache_schema_version, osm_data_timestamp }`
 */
export function buildFixture(spec, rawRows, measurements, engine) {
    const cleaned = cleanDoorRows(rawRows);
    const selected = selectTerritoryDoors(cleaned.doors, spec.centre, spec.target_doors);
    const doors = selected.map(toFixtureDoor);
    const bounds = territoryBounds(doors);

    return {
        fixture: {
            id: spec.id,
            schema_version: FIXTURE_SCHEMA_VERSION,
            // Deliberately unordered input: the solver receives a set of doors and
            // must derive its own structure.
            doors
        },
        manifest: {
            fixture_id: spec.id,
            fixture_schema_version: FIXTURE_SCHEMA_VERSION,
            geography: measurements.label?.geography ?? null,
            geography_rationale: measurements.label?.rationale ?? null,
            selection_note: spec.selection_note ?? null,
            extraction: {
                source_entity: 'MasterProperty',
                query_bounds: spec.query_bounds,
                requested_centre: spec.centre,
                target_doors: spec.target_doors,
                extracted_at: new Date().toISOString(),
                raw_row_count: cleaned.raw_row_count,
                clean_door_count_in_bounds: cleaned.doors.length,
                selected_door_count: doors.length,
                distinct_address_count: doors.length,
                distinct_coordinate_count: new Set(doors.map((d) => `${d.lat},${d.lng}`)).size,
                max_doors_on_one_coordinate: cleaned.max_doors_on_one_coordinate
            },
            cleaning: {
                rule_version: CLEANING_RULE_VERSION,
                removed: cleaned.removed
            },
            geometry: {
                bbox: {
                    minLat: round6(bounds.minLat),
                    maxLat: round6(bounds.maxLat),
                    minLng: round6(bounds.minLng),
                    maxLng: round6(bounds.maxLng)
                },
                area_sq_mi: measurements.geography.area_sq_mi,
                doors_per_sq_mi: measurements.geography.doors_per_sq_mi
            },
            door_geography: measurements.geography,
            road_topology: measurements.road_topology ?? null,
            barriers: measurements.barriers ?? null,
            detour_profile: measurements.detour ?? null,
            measurement_environment: engine,
            checksum: fixtureChecksum(doors),
            // Stated explicitly so a future reader does not look for one.
            contains_route_order: false,
            contains_decomposition: false,
            contains_personal_data: false
        }
    };
}

function round6(value) {
    return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null;
}