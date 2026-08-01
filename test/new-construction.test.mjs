/**
 * NEW BUILD — a door is flagged as new construction purely on year built: this
 * calendar year or last one. Sale history must NOT suppress the badge, because
 * Precision routes are assembled from recently-sold homes and every record
 * carries a sale date/price.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isNewConstruction, getYearBuilt } from '../src/lib/newConstruction.js';

const NOW = new Date('2026-08-01T00:00:00Z');

test('NEWBUILD-01 built this year or last year is a new build', () => {
    assert.equal(isNewConstruction({ year_built: 2026 }, NOW), true);
    assert.equal(isNewConstruction({ yearBuilt: 2025 }, NOW), true);
});

test('NEWBUILD-02 a recorded sale does not suppress the badge', () => {
    // The reported bug: 2025 builds sitting on existing sold-property routes.
    assert.equal(isNewConstruction({ year_built: 2025, sold_date: '2026-05-01' }, NOW), true);
    assert.equal(isNewConstruction({ year_built: 2025, last_sale_price: 410000 }, NOW), true);
    assert.equal(isNewConstruction({ year_built: 2026, lastSoldDate: '2026-01-09', sale_price: 512000 }, NOW), true);
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
});

test('NEWBUILD-05 the window rolls with the calendar', () => {
    // Same 2025 house is still new in 2026 and no longer new in 2027.
    assert.equal(isNewConstruction({ year_built: 2025 }, new Date('2026-12-31T00:00:00Z')), true);
    assert.equal(isNewConstruction({ year_built: 2025 }, new Date('2027-01-01T00:00:00Z')), false);
});