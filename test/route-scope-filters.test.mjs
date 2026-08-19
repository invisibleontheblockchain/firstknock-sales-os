/**
 * RUN ROUTE SCOPE — the "Remove LLC" and "New build" toggles that sit on the
 * Decisions row. New build keeps only doors inside the rolling new-construction
 * window (this calendar year or last one), and the two toggles stack.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRouteScopeFilters, countRouteScope } from '../src/lib/routeScopeFilters.js';

// Local-time constructor on purpose: isNewConstruction reads getFullYear(),
// so a UTC literal would land in the previous year west of Greenwich.
const NOW = new Date(2026, 7, 19);

const NEW_HOUSE = { address_hash: 'new-2025', year_built: 2025, owner_full_name: 'Dana Reyes' };
const NEWEST_HOUSE = { address_hash: 'new-2026', yearBuilt: 2026, owner_full_name: 'Sam Cole' };
const OLD_HOUSE = { address_hash: 'old', year_built: 1998, owner_full_name: 'Pat Nguyen' };
const NEW_LLC = { address_hash: 'llc-new', year_built: 2026, owner_full_name: 'Beacon Ridge LLC' };
const OLD_LLC = { address_hash: 'llc-old', year_built: 1975, corporate_owned: true };
const UNKNOWN_YEAR = { address_hash: 'unknown', owner_full_name: 'Jo Park' };

const ROUTE = [NEW_HOUSE, NEWEST_HOUSE, OLD_HOUSE, NEW_LLC, OLD_LLC, UNKNOWN_YEAR];

const hashes = (properties) => properties.map((property) => property.address_hash);

test('SCOPE-01 counts describe the whole route, not the filtered view', () => {
    assert.deepEqual(countRouteScope(ROUTE, NOW), { businessOwned: 2, newBuild: 3 });
    assert.deepEqual(countRouteScope([], NOW), { businessOwned: 0, newBuild: 0 });
    assert.deepEqual(countRouteScope(undefined, NOW), { businessOwned: 0, newBuild: 0 });
});

test('SCOPE-02 no toggle on returns the route untouched, by reference', () => {
    assert.equal(applyRouteScopeFilters(ROUTE, {}, NOW), ROUTE);
    assert.equal(applyRouteScopeFilters(ROUTE, { hideBusinessOwned: false, newBuildsOnly: false }, NOW), ROUTE);
});

test('SCOPE-03 new build keeps this year and last year only', () => {
    const filtered = applyRouteScopeFilters(ROUTE, { newBuildsOnly: true }, NOW);
    assert.deepEqual(hashes(filtered), ['new-2025', 'new-2026', 'llc-new']);
});

test('SCOPE-04 an unknown year built is never treated as a new build', () => {
    assert.deepEqual(hashes(applyRouteScopeFilters([UNKNOWN_YEAR], { newBuildsOnly: true }, NOW)), []);
});

test('SCOPE-05 the two toggles stack — non-business AND new build', () => {
    const filtered = applyRouteScopeFilters(ROUTE, { hideBusinessOwned: true, newBuildsOnly: true }, NOW);
    assert.deepEqual(hashes(filtered), ['new-2025', 'new-2026']);
});

test('SCOPE-06 remove LLC on its own still behaves as before', () => {
    const filtered = applyRouteScopeFilters(ROUTE, { hideBusinessOwned: true }, NOW);
    assert.deepEqual(hashes(filtered), ['new-2025', 'new-2026', 'old', 'unknown']);
});

test('SCOPE-07 the new build window rolls with the calendar', () => {
    // The same 2025 door drops out of the filter once 2027 starts.
    const inTwentySeven = applyRouteScopeFilters(ROUTE, { newBuildsOnly: true }, new Date(2027, 0, 1));
    assert.deepEqual(hashes(inTwentySeven), ['new-2026', 'llc-new']);
});
