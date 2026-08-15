// Turn a bag of real properties into one candidate territory plus its evidence.
//
// Selection discipline lives here: a territory is the ~N real doors closest to the
// densest point of a seed area — the same compact shape a real Precision pull
// produces — and it is described and labelled with no knowledge of any solver
// result. The doors keep their real coordinates and street identity because those
// ARE the inputs under test; everything a solver never sees is dropped.
//
// NOT PRODUCTION CODE — research tooling under scripts/.

import {
    describeDoorGeography,
    describeBarriers,
    classifyGeography,
    measureDetourProfile,
    territoryBounds,
    haversineMiles
} from './territoryGeography.js';
import { fetchBarrierFeatures } from './overpassBarriers.js';
import { sampleRoadPairs } from './sampleRoadPairs.js';
import { createHash } from 'node:crypto';

/** Stable pseudonym for a property: same input always yields the same id, and the
 *  real address hash cannot be recovered from it. */
export function anonymizeId(addressHash) {
    return `d_${createHash('sha256').update(`fk-corpus|${addressHash}`).digest('hex').slice(0, 16)}`;
}

/**
 * The solver's actual input surface, and nothing else.
 *
 * Owner names, prices, sale history, MLS ids and full addresses are removed: the
 * solver never reads them, and a frozen fixture should not carry resident data.
 * Street name and house number stay because street blocks are formed from them.
 */
export function toFixtureDoor(row) {
    return {
        id: anonymizeId(row.address_hash),
        lat: Number(row.lat),
        lng: Number(row.lng),
        street_name: row.street_name,
        house_number: Number.isFinite(row.house_number) ? row.house_number : null,
        zip_code: row.zip_code || row.zip || null,
        subdivision_name: row.subdivision_name || null
    };
}

/**
 * Keep only records that describe a real, distinct door.
 *
 * The production store contains import residue that would silently wreck a
 * mileage benchmark: in one metro bbox, 66,045 rows reduce to 14,233 distinct
 * address hashes and 12,044 distinct coordinates, including a single truncated
 * CSV hash ("Unknown Street", house number 0) repeated thousands of times and
 * stacked on one point. A fixture built from that would measure geocoding failure
 * rather than geography — 1,000 "doors" occupying 0.011 sq mi.
 *
 * So a door must have a named street, a real house number, a unique address
 * identity, and its own coordinate. Deduping by coordinate is deliberate: several
 * hundred addresses sharing one point is a geocoding artifact, not a real stack of
 * homes, and the solver's real duplicate-coordinate behaviour is covered by its
 * own unit test rather than by silently inflating every fixture.
 *
 * (Recorded as a separate production concern, not fixed here: these records are
 * also eligible for real Precision routes.)
 */
export function dedupeRealDoors(rows) {
    const seenIdentity = new Set();
    const seenCoordinate = new Set();
    const doors = [];

    for (const row of rows) {
        if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng)) continue;
        const street = String(row.street_name || '').trim();
        if (!street || /unknown/i.test(street)) continue;
        if (!Number.isFinite(row.house_number) || row.house_number <= 0) continue;
        if (!row.address_hash) continue;

        const identity = `${street.toLowerCase()}|${row.house_number}|${row.zip_code || row.zip || ''}`;
        if (seenIdentity.has(identity) || seenIdentity.has(row.address_hash)) continue;
        const coordinate = `${row.lat.toFixed(6)},${row.lng.toFixed(6)}`;
        if (seenCoordinate.has(coordinate)) continue;

        seenIdentity.add(identity);
        seenIdentity.add(row.address_hash);
        seenCoordinate.add(coordinate);
        doors.push(row);
    }

    return doors;
}

/**
 * Pick the densest compact door set inside a seed area.
 *
 * @param {Array} rows real MasterProperty rows already restricted to the seed bbox
 * @param {number} targetDoors ideal size; a territory with fewer real doors keeps
 *   its real count rather than being padded, so its character survives.
 */
export function selectTerritoryDoors(rows, targetDoors = 1000) {
    const usable = dedupeRealDoors(rows);
    if (!usable.length) return [];

    const cells = new Map();
    for (const row of usable) {
        const key = `${Math.round(row.lat / 0.01)}_${Math.round(row.lng / 0.01)}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(row);
    }
    const densest = [...cells.values()].sort((a, b) => b.length - a.length)[0];
    const centre = {
        lat: densest.reduce((sum, row) => sum + row.lat, 0) / densest.length,
        lng: densest.reduce((sum, row) => sum + row.lng, 0) / densest.length
    };

    return usable
        .map((row) => ({ row, miles: haversineMiles(centre, row) }))
        .sort((a, b) => a.miles - b.miles)
        .slice(0, targetDoors)
        .map((entry) => entry.row);
}

/**
 * Evaluate one candidate territory: describe it, measure its barriers, label it.
 * Returns the evidence AND the fixture doors, so the caller can freeze a territory
 * without ever re-deriving the numbers the label was based on.
 */
export async function evaluateTerritory({ key, rows, targetDoors = 1000, measureDetour = true }) {
    const selected = selectTerritoryDoors(rows, targetDoors);
    if (selected.length < 100) {
        return { key, ok: false, reason: 'INSUFFICIENT_REAL_DOORS', door_count: selected.length };
    }

    const doors = selected.map(toFixtureDoor);
    const geography = describeDoorGeography(doors);
    const bounds = territoryBounds(doors);

    const features = await fetchBarrierFeatures(bounds);
    const barriers = features.ok ? describeBarriers(features, geography) : null;
    const detour = measureDetour ? await measureDetourProfile(doors, sampleRoadPairs) : null;

    if (!barriers) {
        return { key, ok: false, reason: `BARRIERS_UNMEASURED: ${features.error}`, geography, detour };
    }

    const label = classifyGeography(geography, barriers, detour);
    return {
        key,
        ok: true,
        candidate_pool: rows.length,
        geography,
        barriers,
        detour,
        classified_as: label.geography,
        rationale: label.rationale,
        doors
    };
}