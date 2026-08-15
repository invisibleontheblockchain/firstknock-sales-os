// Regression coverage for the corpus cleaning rule.
//
// This exists because the production store turned out to contain import corruption
// at scale — a placeholder street value repeated thousands of times, with house
// number 0, and blocks of rows stacked on single coordinates. A territory built out
// of those rows would give the solver hundreds of doors at no road distance from
// each other, and any decomposition would look brilliant on it. These tests pin the
// rule that keeps that out, and equally pin the two things the rule must NOT do:
// throw away real units that share a rooftop, or depend on row order.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    cleanDoorRows,
    doorIdentity,
    CLEANING_RULE_VERSION,
    STACKED_COORDINATE_LIMIT
} from '../scripts/corpus/cleanDoors.js';

const door = (overrides) => ({
    address_hash: `h_${Math.random().toString(36).slice(2)}`,
    lat: 35.2,
    lng: -80.8,
    street_name: 'Ashley Circle',
    house_number: 101,
    zip_code: '28226',
    ...overrides
});

test('CLEAN-01 rejects the observed "Unknown Street" / house 0 corruption pattern', () => {
    const corrupt = Array.from({ length: 3900 }, (_, i) => door({
        street_name: 'Unknown Street',
        house_number: 0,
        lat: 35.1 + i * 1e-9,
        lng: -80.9
    }));
    const real = [door({ street_name: 'Ashley Circle', house_number: 101 })];

    const result = cleanDoorRows([...corrupt, ...real]);

    assert.equal(result.doors.length, 1, 'only the real address survives');
    // Placeholder street is checked before house number, so the whole block is
    // attributed to one reason rather than split across two.
    assert.equal(result.removed.placeholder_street, 3900);
    assert.equal(result.removed.invalid_house_number, 0);
});

test('CLEAN-02 rejects unusable coordinates including null island', () => {
    const result = cleanDoorRows([
        door({ lat: null, lng: -80.8 }),
        door({ lat: 35.2, lng: undefined }),
        door({ lat: 0, lng: 0 }),
        door({ lat: 120, lng: -80.8 }),
        door({ house_number: 102 })
    ]);

    assert.equal(result.removed.invalid_coordinates, 4);
    assert.equal(result.doors.length, 1);
});

test('CLEAN-03 collapses repeated deliveries of one address into one door', () => {
    const identical = Array.from({ length: 6 }, () => door({ street_name: 'ASHLEY  CIRCLE.', house_number: 101 }));
    const result = cleanDoorRows(identical);

    assert.equal(result.doors.length, 1);
    assert.equal(result.removed.duplicate_address_identity, 5);
    assert.equal(result.distinct_address_count, 1);
});

test('CLEAN-04 keeps distinct units that a geocoder snapped to one coordinate', () => {
    // The failure this guards against is silent: collapsing by coordinate would
    // delete real, separately knocked doors and shrink measured workload.
    const units = ['A', 'B', 'C', 'D'].map((unit) => door({
        house_number: 400,
        unit,
        lat: 32.8899,
        lng: -79.7901
    }));

    const result = cleanDoorRows(units);

    assert.equal(result.doors.length, 4);
    assert.equal(result.distinct_coordinate_count, 1);
    assert.equal(result.removed.duplicate_address_identity, 0);
    assert.equal(result.removed.stacked_coordinate_overflow, 0);
});

test('CLEAN-05 rejects an entire coordinate stack once it exceeds a real structure cluster', () => {
    const stack = Array.from({ length: STACKED_COORDINATE_LIMIT + 5 }, (_, i) => door({
        house_number: 500 + i,
        street_name: 'Marsh View Drive',
        lat: 32.7,
        lng: -80.05
    }));
    const clean = [door({ house_number: 900, street_name: 'Marsh View Drive', lat: 32.71, lng: -80.06 })];

    const result = cleanDoorRows([...stack, ...clean]);

    assert.equal(result.removed.stacked_coordinate_overflow, STACKED_COORDINATE_LIMIT + 5);
    assert.deepEqual(result.doors.map((d) => d.house_number), [900]);
    assert.equal(result.max_doors_on_one_coordinate, STACKED_COORDINATE_LIMIT + 5);
});

test('CLEAN-06 rejects rows with no stable key and invalid house numbers', () => {
    const result = cleanDoorRows([
        door({ address_hash: null }),
        door({ house_number: -4 }),
        door({ house_number: 12.5 }),
        door({ house_number: 'abc' }),
        door({ house_number: 77 })
    ]);

    assert.equal(result.removed.malformed_row, 1);
    assert.equal(result.removed.invalid_house_number, 3);
    assert.equal(result.doors.length, 1);
});

test('CLEAN-07 is order independent and reports the rule version', () => {
    const rows = [
        door({ house_number: 3, lat: 35.21, lng: -80.81 }),
        door({ house_number: 1, lat: 35.22, lng: -80.82 }),
        door({ street_name: 'unknown', house_number: 0, lat: 35.23, lng: -80.83 }),
        door({ house_number: 2, lat: 35.24, lng: -80.84 })
    ];
    const forward = cleanDoorRows(rows);
    const reversed = cleanDoorRows([...rows].reverse());

    assert.deepEqual(
        forward.doors.map(doorIdentity),
        reversed.doors.map(doorIdentity),
        'same doors in the same order regardless of input order'
    );
    assert.deepEqual(forward.removed, reversed.removed);
    assert.equal(forward.version, CLEANING_RULE_VERSION);
    assert.equal(forward.raw_row_count, 4);
});