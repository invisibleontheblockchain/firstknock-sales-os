import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyQuery,
  groupResults,
  hasUsableCoordinates,
  rankResults,
  scoreResult,
} from '../src/components/search/searchQuery.js';
import { fitMapBounds, focusMapPoint, resolveSelectedProperty } from '../src/components/search/searchSelection.js';
import {
  addressDedupeKey,
  normalizeAddress,
  normalizeName,
  parseHouseNumber,
  parseStreetName,
  splitAddressUnit,
} from '../base44/shared/addressNormalize.js';
import { isRepAccount, tenantManagerId } from '../base44/shared/accountTenancy.js';

test('a person name never reaches the external geocoder', () => {
  const intent = classifyQuery('Amanda');
  assert.equal(intent.searchInternal, true);
  assert.equal(intent.searchAddress, false);
  assert.equal(intent.searchCounty, false);
});

test('street-like queries are treated as addresses even without a house number', () => {
  assert.equal(classifyQuery('Amanda Lane').searchAddress, true);
  assert.equal(classifyQuery('123 Oak St').searchAddress, true);
  assert.equal(classifyQuery('29678').searchAddress, true);
});

test('county queries resolve to county intent only', () => {
  const intent = classifyQuery('Maricopa County, Arizona');
  assert.equal(intent.searchCounty, true);
  assert.equal(intent.searchAddress, false);
});

test('queries shorter than the minimum are not searched at all', () => {
  const intent = classifyQuery('a');
  assert.equal(intent.usable, false);
  assert.equal(intent.searchInternal, false);
});

test('address normalization collapses suffix and casing differences but keeps units apart', () => {
  assert.equal(normalizeAddress('123 Oak Street'), normalizeAddress('123 oak st.'));
  assert.equal(normalizeAddress('123 Oak Road'), '123 oak rd');
  assert.notEqual(normalizeAddress('12 Oak St Apt 1'), normalizeAddress('12 Oak St Apt 2'));
  assert.deepEqual(splitAddressUnit('12 Oak St Unit 4B'), { street: '12 oak st', unit: '4b' });
});

test('duplicate detection treats ZIP+4 as the same door and different ZIPs as different doors', () => {
  assert.equal(
    addressDedupeKey({ address: '123 Oak Street', zip: '29678-1234' }),
    addressDedupeKey({ address: '123 oak st', zip: '29678' }),
  );
  assert.notEqual(
    addressDedupeKey({ address: '123 Oak St', zip: '29678' }),
    addressDedupeKey({ address: '123 Oak St', zip: '29679' }),
  );
});

test('house number and street name parse out of a raw address', () => {
  assert.equal(parseHouseNumber('123 Oak Street'), 123);
  assert.equal(parseStreetName('123 Oak Street'), 'oak st');
  assert.equal(parseHouseNumber('Oak Street'), null);
  assert.equal(normalizeName('Amanda  W. Whitfield'), 'amanda w whitfield');
});

test('stored records outrank external geocoder hits for the same address', () => {
  const internal = { type: 'record', name: null, formatted_address: '123 Oak St, Phoenix, AZ', address_hash: 'h1', lat: 1, lng: 1 };
  const external = { type: 'address', formatted_address: '123 Oak St, Phoenix, AZ, USA', lat: 1, lng: 1 };
  const ranked = rankResults([external, internal], '123 Oak St');
  assert.equal(ranked[0].type, 'record');
  assert.ok(scoreResult(internal, '123 oak st') > scoreResult(external, '123 oak st'));
});

test('two customers named Amanda both survive ranking and stay distinguishable', () => {
  const ranked = rankResults([
    { type: 'record', name: 'Amanda Reyes', address_hash: 'a1', formatted_address: '10 Pine St, Easley, SC', lat: 1, lng: 1 },
    { type: 'record', name: 'Amanda Whitfield', address_hash: 'a2', formatted_address: '88 Cedar Ct, Easley, SC', lat: 2, lng: 2 },
  ], 'Amanda');
  assert.equal(ranked.length, 2);
  assert.notEqual(ranked[0].formatted_address, ranked[1].formatted_address);
});

test('results are categorized for display', () => {
  const groups = groupResults([
    { type: 'route', id: 'r1', name: 'Phoenix Route' },
    { type: 'record', name: 'Amanda' },
    { type: 'address', formatted_address: '1 Oak St' },
    { type: 'county', name: 'Maricopa, Arizona' },
  ]);
  assert.deepEqual(groups.map((group) => group.label), ['Routes', 'Customers & Leads', 'Addresses', 'Counties']);
});

test('saved routes rank above similarly named records', () => {
  const ranked = rankResults([
    { type: 'record', address_hash: 'h1', name: 'Phoenix', formatted_address: '1 Oak St' },
    { type: 'route', route_id: 'r1', name: 'Phoenix Route', formatted_address: '50 doors' },
  ], 'Phoenix');
  assert.equal(ranked[0].type, 'route');
});

test('duplicate result keys collapse to the highest scoring entry', () => {
  const ranked = rankResults([
    { type: 'record', address_hash: 'h1', name: 'Amanda', formatted_address: '1 Oak St', lat: 1, lng: 1 },
    { type: 'record', address_hash: 'h1', name: 'Amanda Whitfield', formatted_address: '1 Oak St', lat: 1, lng: 1 },
  ], 'Amanda');
  assert.equal(ranked.length, 1);
});

test('selecting a stored record reuses the already-loaded property', () => {
  const loaded = [{ address_hash: 'h1', lat: 34.1, lng: -82.2, effective_status: 'CALLBACK', full_address: '1 Oak St' }];
  const { property, locatable } = resolveSelectedProperty({ type: 'record', address_hash: 'h1', name: 'Amanda' }, loaded);
  assert.equal(property, loaded[0]);
  assert.equal(locatable, true);
});

test('a record with missing coordinates still opens but is not locatable', () => {
  const { property, locatable } = resolveSelectedProperty(
    { type: 'record', address_hash: 'h9', name: 'Amanda', formatted_address: '5 Elm St', lat: null, lng: null },
    [],
  );
  assert.equal(locatable, false);
  assert.equal(property.address_hash, 'h9');
  assert.equal(hasUsableCoordinates(property), false);
});

test('null island coordinates are rejected as unusable', () => {
  assert.equal(hasUsableCoordinates({ lat: 0, lng: 0 }), false);
  assert.equal(hasUsableCoordinates({ lat: 34.1, lng: -82.2 }), true);
});

test('map commands are no-ops instead of throwing when the map is not ready', () => {
  assert.equal(focusMapPoint(null, { lat: 1, lng: 1 }), false);
  assert.equal(focusMapPoint({ current: {} }, { lat: 1, lng: 1 }), false);
  assert.equal(fitMapBounds({ current: { _mapPane: {} } }, null), false);
});

test('focusing a point issues exactly one explicit setView', () => {
  const calls = [];
  const mapRef = { current: { _mapPane: {}, setView: (...args) => calls.push(args) } };
  assert.equal(focusMapPoint(mapRef, { lat: 34.1, lng: -82.2 }), true);
  assert.deepEqual(calls, [[[34.1, -82.2], 18, { animate: true }]]);
});

test('county selection fits bounds and does not touch route state', () => {
  const calls = [];
  const mapRef = { current: { _mapPane: {}, fitBounds: (...args) => calls.push(args) } };
  const bounds = [[33.2, -113.3], [34.1, -111.0]];
  assert.equal(fitMapBounds(mapRef, bounds, { padding: [40, 40], maxZoom: 12 }), true);
  assert.deepEqual(calls[0][0], bounds);
  assert.equal(calls[0][1].maxZoom, 12);
});

test('tenant resolution keeps reps on their manager account and managers on their own', () => {
  assert.equal(isRepAccount({ app_role: 'rep', team_manager_id: 'mgr-1' }), true);
  assert.equal(tenantManagerId({ app_role: 'rep', id: 'u1', team_manager_id: 'mgr-1' }), 'mgr-1');
  assert.equal(isRepAccount({ app_role: 'manager', id: 'mgr-1' }), false);
  assert.equal(tenantManagerId({ app_role: 'manager', id: 'mgr-1' }), 'mgr-1');
  // A stale rep app_role must not override a platform admin account.
  assert.equal(isRepAccount({ app_role: 'rep', role: 'admin', id: 'admin-1' }), false);
});