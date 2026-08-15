// Freeze one SavedRoute as an unordered, routing-only Precision benchmark fixture.
// Usage: node scripts/corpus/hydrateSavedRouteFixture.mjs <route-manifest.json> <fixture.json>

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { cleanDoorRows, CLEANING_RULE_VERSION } from './cleanDoors.js';

const [, , manifestPath, outputPath] = process.argv;
if (!manifestPath || !outputPath) throw new Error('Route manifest and output path are required.');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

const source = JSON.parse(readFileSync(manifestPath, 'utf8'));
const hashes = Array.isArray(source.property_hashes) ? source.property_hashes.map(String) : [];
if (hashes.length !== 1000 || new Set(hashes).size !== hashes.length) {
    throw new Error(`Expected 1,000 unique route hashes; received ${hashes.length}/${new Set(hashes).size}.`);
}

const sql = neon(process.env.DATABASE_URL);
const rows = await sql`
    SELECT
        p.id,
        p.address_hash,
        p.legacy_hash,
        p.full_address,
        p.house_number,
        p.street_name,
        p.city,
        p.zip_code,
        p.lat,
        p.lng,
        COALESCE(
            p.raw_payload -> 'property' ->> 'subdivision_name',
            p.raw_payload ->> 'subdivision_name',
            p.raw_payload ->> 'subdivisionName'
        ) AS subdivision_name
    FROM properties p
    WHERE p.address_hash = ANY(${hashes}) OR p.legacy_hash = ANY(${hashes})
`;

const byHash = new Map();
for (const row of rows) {
    if (row.address_hash) byHash.set(String(row.address_hash), row);
    if (row.legacy_hash) byHash.set(String(row.legacy_hash), row);
}
const missing = hashes.filter((hash) => !byHash.has(hash));
if (missing.length > 0) throw new Error(`Canonical Precision hydration missed ${missing.length} route hashes.`);

const repairs = {
    house_number_from_route_hash: 0,
    street_name_from_route_hash: 0,
    isolated_unresolved_route_record: 0
};
const rawDoors = hashes.map((hash) => {
    const row = byHash.get(hash);
    const hashAddress = hash.split('|')[0].trim();
    const candidates = [
        hashAddress.match(/^(\d+)\s+(.+)$/),
        String(row.full_address || '').trim().match(/^(\d+)\s+([^,]+)/)
    ].filter(Boolean);
    const parsed = candidates.find((candidate) => (
        Number(candidate[1]) > 0
        && !/^(unknown|null|none|n\/?a|test|tbd|no\s*street|address\s*not)/i.test(candidate[2].trim())
    ));
    let houseNumber = Number(row.house_number);
    let streetName = String(row.street_name || '').trim();
    if ((!Number.isInteger(houseNumber) || houseNumber <= 0) && parsed) {
        houseNumber = Number(parsed[1]);
        repairs.house_number_from_route_hash += 1;
    }
    if ((!streetName || /^(unknown|null|none|n\/?a|test|tbd|no\s*street|address\s*not)/i.test(streetName)) && parsed) {
        streetName = parsed[2];
        repairs.street_name_from_route_hash += 1;
    }
    const unresolvedStreet = !streetName
        || /^(unknown|null|none|n\/?a|test|tbd|no\s*street|address\s*not)/i.test(streetName);
    const unresolvedHouse = !Number.isInteger(houseNumber) || houseNumber <= 0;
    if (unresolvedStreet || unresolvedHouse) {
        streetName = `Unresolved ${createHash('sha256').update(hash).digest('hex').slice(0, 12)}`;
        houseNumber = 1;
        repairs.isolated_unresolved_route_record += 1;
    }
    return {
        address_hash: hash,
        house_number: houseNumber,
        street_name: streetName,
        city: row.city,
        zip_code: row.zip_code,
        lat: Number(row.lat),
        lng: Number(row.lng),
        subdivision_name: row.subdivision_name || null
    };
});
const cleaned = cleanDoorRows(rawDoors);
if (cleaned.doors.length !== hashes.length) {
    throw new Error(`Cleaning changed route membership (${hashes.length} raw -> ${cleaned.doors.length} clean): repairs=${JSON.stringify(repairs)} removed=${JSON.stringify(cleaned.removed)}`);
}

const doors = cleaned.doors
    .map((door) => ({
        address_hash: door.address_hash,
        house_number: door.house_number,
        street_name: door.street_name,
        city: door.city,
        zip_code: door.zip_code,
        lat: Math.round(door.lat * 1e6) / 1e6,
        lng: Math.round(door.lng * 1e6) / 1e6,
        ...(door.subdivision_name ? { subdivision_name: door.subdivision_name } : {})
    }))
    .sort((a, b) => a.address_hash.localeCompare(b.address_hash));
const checksum = createHash('sha256')
    .update(doors.map((door) => `${door.address_hash}|${door.lat.toFixed(6)}|${door.lng.toFixed(6)}`).join('\n'))
    .digest('hex');

const fixture = {
    _comment: `PRODUCTION-FROZEN generalization benchmark. ${source.route_name} (${source.route_id}, 1,000 doors) as an UNORDERED set hydrated from the canonical Precision/Neon property store. Routing-relevant attributes only; sorted by address_hash, never route order.`,
    fixture_version: 'route_1j_generalization_v1',
    route_id: source.route_id,
    route_name: source.route_name,
    extracted_at: new Date().toISOString(),
    source_path: 'precision_neon_canonical_by_saved_route_manifest',
    door_count: doors.length,
    unique_address_hashes: new Set(doors.map((door) => door.address_hash)).size,
    distinct_coordinate_count: new Set(doors.map((door) => `${door.lat.toFixed(6)},${door.lng.toFixed(6)}`)).size,
    coordinate_precision: 6,
    cleaning_rule_version: CLEANING_RULE_VERSION,
    canonical_field_repairs: repairs,
    cleaning_removed: cleaned.removed,
    doors_checksum_sha256: checksum,
    contains_route_order: false,
    contains_owner_contact_or_sale_data: false,
    doors
};
writeFileSync(outputPath, `${JSON.stringify(fixture, null, 1)}\n`);
console.log(JSON.stringify({ outputPath, door_count: doors.length, distinct_coordinate_count: fixture.distinct_coordinate_count, checksum, canonical_field_repairs: repairs, cleaning_removed: cleaned.removed }));