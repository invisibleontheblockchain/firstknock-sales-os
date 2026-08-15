// Freeze guard for the real unordered Route 1J generalization fixture.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(
    new URL('./fixtures/charlotte-route-1j-generalization-1000.json', import.meta.url),
    'utf8'
));

test('FREEZE-1J-01 keeps the exact 1,000-door manifest and checksum', () => {
    assert.equal(fixture.fixture_version, 'route_1j_generalization_v1');
    assert.equal(fixture.door_count, 1000);
    assert.equal(fixture.doors.length, 1000);
    assert.equal(new Set(fixture.doors.map((door) => door.address_hash)).size, 1000);
    const checksum = createHash('sha256')
        .update(fixture.doors
            .map((door) => `${door.address_hash}|${door.lat.toFixed(6)}|${door.lng.toFixed(6)}`)
            .join('\n'))
        .digest('hex');
    assert.equal(checksum, fixture.doors_checksum_sha256);
});

test('FREEZE-1J-02 is unordered routing evidence without sensitive or solution fields', () => {
    const allowed = new Set([
        'address_hash', 'house_number', 'street_name', 'city', 'zip_code',
        'lat', 'lng', 'subdivision_name'
    ]);
    fixture.doors.forEach((door) => Object.keys(door).forEach((key) => {
        assert.ok(allowed.has(key), `unexpected fixture field: ${key}`);
    }));
    const hashes = fixture.doors.map((door) => door.address_hash);
    assert.deepEqual(hashes, [...hashes].sort());
    assert.equal(fixture.contains_route_order, false);
    assert.equal(fixture.contains_owner_contact_or_sale_data, false);
});

test('FREEZE-1J-03 records deterministic hygiene without dropping route members', () => {
    assert.equal(fixture.source_path, 'precision_neon_canonical_by_saved_route_manifest');
    assert.deepEqual(fixture.cleaning_removed, {
        invalid_coordinates: 0,
        placeholder_street: 0,
        invalid_house_number: 0,
        malformed_row: 0,
        duplicate_address_identity: 0,
        stacked_coordinate_overflow: 0
    });
    assert.equal(fixture.canonical_field_repairs.isolated_unresolved_route_record, 4);
    assert.equal(fixture.distinct_coordinate_count, 1000);
});