/**
 * NEW BUILD — a door is only flagged as new construction when it is a year old
 * or newer AND carries no prior ownership transfer. Year alone would mislabel a
 * recently built home that has already resold.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isNewConstruction, getYearBuilt } from '../src/lib/newConstruction.js';

const NOW = new Date('2026-08-01T00:00:00Z');

test('NEWBUILD-01 built this year with no transfer on record is a new build', () => {
    assert.equal(isNewConstruction({ year_built: 2026 }, NOW), true);
    assert.equal(isNewConstruction({ yearBuilt: 2025 }, NOW), true);
});

test('NEWBUILD-02 a recorded ownership transfer disqualifies it', () => {
    assert.equal(isNewConstruction({ year_built: 2026, sold_date: '2026-05-01' }, NOW), false);
    assert.equal(isNewConstruction({ year_built: 2026, last_sale_price: 410000 }, NOW), false);
    assert.equal(isNewConstruction({ year_built: 2025, lastSoldDate: '2026-01-09' }, NOW), false);
});

test('NEWBUILD-03 older homes and unknown years are never flagged', () => {
    assert.equal(isNewConstruction({ year_built: 2024 }, NOW), false);
    assert.equal(isNewConstruction({ year_built: 1998 }, NOW), false);
    assert.equal(isNewConstruction({}, NOW), false);
    assert.equal(isNewConstruction(null, NOW), false);
});

test('NEWBUILD-04 junk year values are rejected rather than trusted', () => {
    assert.equal(getYearBuilt({ year_built: 0 }), null);
    assert.equal(getYearBuilt({ year_built: 'unknown' }), null);
    assert.equal(getYearBuilt({ year_built: '2026' }), 2026);
    // A zero sale price is not evidence of a transfer.
    assert.equal(isNewConstruction({ year_built: 2026, sale_price: 0 }, NOW), true);
});