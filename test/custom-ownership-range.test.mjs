import test from 'node:test';
import assert from 'node:assert/strict';

import {
    customOwnershipDateBounds,
    isSoldDateInCustomOwnershipRange,
    normalizeOwnershipRangeDays,
} from '../src/components/logic/soldDateRange.js';
import { getCustomRangeRevealScrollTop } from '../src/components/logic/customRangeReveal.js';

const REFERENCE = new Date('2026-07-11T12:00:00.000Z');
const RANGE = [90, 180];

test('normalizes valid custom ownership ranges and rejects invalid ranges', () => {
    assert.deepEqual(normalizeOwnershipRangeDays([90, 180]), [90, 180]);
    assert.deepEqual(normalizeOwnershipRangeDays({ min: 90, max: 180 }), [90, 180]);
    assert.equal(normalizeOwnershipRangeDays([0, 180]), null);
    assert.equal(normalizeOwnershipRangeDays([180, 90]), null);
    assert.equal(normalizeOwnershipRangeDays([90, 366]), null);
    assert.equal(normalizeOwnershipRangeDays([90.5, 180]), null);
});

test('builds the inclusive 90–180 day Last Sold window from a fixed reference date', () => {
    assert.deepEqual(customOwnershipDateBounds(RANGE, REFERENCE), {
        min: 90,
        max: 180,
        oldestDate: '2026-01-12',
        newestDate: '2026-04-12'
    });
    assert.deepEqual(customOwnershipDateBounds(RANGE, REFERENCE.toISOString()), {
        min: 90,
        max: 180,
        oldestDate: '2026-01-12',
        newestDate: '2026-04-12'
    });
});

test('custom 90–180 day range excludes yesterday and both outside boundaries', () => {
    assert.equal(isSoldDateInCustomOwnershipRange('2026-07-10', RANGE, REFERENCE), false);
    assert.equal(isSoldDateInCustomOwnershipRange('2026-04-13', RANGE, REFERENCE), false);
    assert.equal(isSoldDateInCustomOwnershipRange('2026-04-12', RANGE, REFERENCE), true);
    assert.equal(isSoldDateInCustomOwnershipRange('2026-03-01T23:59:59-07:00', RANGE, REFERENCE), true);
    assert.equal(isSoldDateInCustomOwnershipRange('2026-01-12', RANGE, REFERENCE), true);
    assert.equal(isSoldDateInCustomOwnershipRange('2026-01-11', RANGE, REFERENCE), false);
    assert.equal(isSoldDateInCustomOwnershipRange(null, RANGE, REFERENCE), false);
    assert.equal(isSoldDateInCustomOwnershipRange('not-a-date', RANGE, REFERENCE), false);
});

test('mobile Custom Range reveal scrolls a newly expanded panel into view', () => {
    assert.equal(getCustomRangeRevealScrollTop({
        scrollTop: 180,
        viewportTop: 120,
        viewportBottom: 620,
        panelTop: 590,
        panelBottom: 860,
    }), 638);
});

test('mobile Custom Range reveal leaves an already visible panel in place', () => {
    assert.equal(getCustomRangeRevealScrollTop({
        scrollTop: 180,
        viewportTop: 120,
        viewportBottom: 620,
        panelTop: 160,
        panelBottom: 560,
    }), null);
});
