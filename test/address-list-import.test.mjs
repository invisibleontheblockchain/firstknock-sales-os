import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCensusBatchCsv,
  geocodeWithCensus,
  parseCensusBatchResponse
} from '../base44/shared/censusGeocode.js';
import {
  cleanZip,
  geocodeCandidates,
  isAddressListData,
  prepareAddressListImport,
  splitStreetAndUnit,
  tidyCase
} from '../src/lib/addressListImport.js';
import { matrixToRows } from '../src/lib/spreadsheetFile.js';

// Shaped like the Tampa sheet a customer sent: owner columns, ALL-CAPS rows,
// a unit suffix, a duplicate address, and "Hills" vs "Hillsborough".
const tampaRows = () => [
  { 'Husband Name': 'Jody', 'Wife Name': 'April', 'Last Name': 'Davis', Address: '3103 E 23rd Ave', City: 'Tampa', State: 'FL', Zip: 33605, County: 'Hills' },
  { 'Husband Name': null, 'Wife Name': null, 'Last Name': null, Address: '2711 W NORTH B STREET #2', City: 'Tampa', State: 'FL', Zip: 33609, County: 'HILLSBOROUGH' },
  { 'Husband Name': 'Michael', 'Wife Name': 'Susan', 'Last Name': 'Coats', Address: '410 Montrose Ave', City: 'Temple Terrace ', State: 'FL', Zip: 33617, County: 'Hills' },
  { 'Husband Name': null, 'Wife Name': null, 'Last Name': null, Address: '410 MONTROSE AVENUE', City: 'Temple Terrace', State: 'FL', Zip: 33617, County: 'HILLSBOROUGH' },
  { 'Husband Name': null, 'Wife Name': null, 'Last Name': null, Address: '8306 Riverbend Rise Ln', City: 'Tampa', State: 'FL', Zip: 33617, County: 'Hillsborough' }
];

// Census answers for everything except Riverbend Rise Ln.
const fakeCensus = async (items) => Object.fromEntries(
  items
    .filter((item) => !/riverbend/i.test(item.address))
    .map((item, index) => [item.id, { lat: 27.9 + index / 100, lng: -82.4 - index / 100, matchType: 'Exact' }])
);

test('detects an address list that has no coordinates', () => {
  assert.equal(isAddressListData(tampaRows()), true);
  assert.equal(isAddressListData([{ Address: '1 Main St', City: 'Tampa', State: 'FL' }]), true);
  assert.equal(isAddressListData([{ Address: '1 Main St', Zip: '33605' }]), true);
});

test('does not claim sheets that already have coordinates, or lack locality or addresses', () => {
  assert.equal(isAddressListData([{ Address: '1 Main St', City: 'Tampa', State: 'FL', Lat: 27.9, Lng: -82.4 }]), false);
  assert.equal(isAddressListData([{ Address: '1 Main St' }]), false);
  assert.equal(isAddressListData([{ Name: 'Pat', City: 'Tampa', State: 'FL' }]), false);
  assert.equal(isAddressListData([]), false);
});

test('mixed sheets still geocode only the rows missing coordinates', async () => {
  const rows = [
    { Address: '1 Main St', City: 'Tampa', State: 'FL', Zip: '33605', Latitude: 27.95, Longitude: -82.45 },
    { Address: '2 Main St', City: 'Tampa', State: 'FL', Zip: '33605', Latitude: '', Longitude: '' }
  ];
  const asked = [];
  const batch = await prepareAddressListImport(rows, 'mixed.csv', {
    geocodeBatch: async (items) => { asked.push(...items.map((i) => i.address)); return fakeCensus(items); }
  });
  assert.deepEqual(asked, ['2 Main St']);
  assert.equal(batch.properties.length, 2);
  assert.equal(batch.properties[0].lat, 27.95);
  assert.equal(batch.properties[0].raw_metadata.geocode_source, 'file');
});

test('cleans, de-duplicates and tags the Tampa-style sheet', async () => {
  const batch = await prepareAddressListImport(tampaRows(), 'Tampa.9.30.xlsx', { geocodeBatch: fakeCensus });

  assert.equal(batch.source, 'address_list');
  assert.equal(batch.routeName, 'Tampa.9.30');
  assert.equal(batch.summary.duplicatesRemoved, 1);
  assert.equal(batch.summary.ready, 3);
  assert.equal(batch.summary.unmatched, 1);
  assert.deepEqual(batch.unmatched.map((row) => [row.rowNumber, row.address]), [[6, '8306 Riverbend Rise Ln']]);

  const [davis, northB, coats] = batch.properties;
  assert.equal(davis.owner_full_name, 'Jody & April Davis');
  assert.equal(davis.data_source, 'csv_import');
  assert.equal(davis.original_status, 'ELIGIBLE');
  assert.equal(davis.zip_code, '33605');
  assert.equal(davis.house_number, 3103);
  assert.equal(davis.street_name, 'E 23rd Ave');

  // Unit is kept for display and tagging but never sent to the geocoder.
  assert.equal(northB.full_address, '2711 W North B Street #2');
  assert.equal(northB.raw_metadata.unit, '#2');
  assert.equal(northB.owner_full_name, undefined);

  // The duplicate row had no names; the first row's owner survives, and
  // "Hills" is expanded to the "Hillsborough" used elsewhere in the file.
  assert.equal(coats.owner_full_name, 'Michael & Susan Coats');
  assert.equal(coats.city, 'Temple Terrace');
  for (const property of batch.properties) {
    assert.equal(property.raw_metadata.county, 'Hillsborough');
    assert.equal(property.raw_metadata.County, undefined); // only the cleaned county is kept
    assert.equal(property.raw_metadata.list_name, 'Tampa.9.30');
    assert.equal(property.raw_metadata.geocode_source, 'census');
    assert.ok(Number.isFinite(property.lat) && Number.isFinite(property.lng));
  }
  assert.equal(new Set(batch.properties.map((p) => p.address_hash)).size, 3);
});

test('sends the geocoder the street without the unit', async () => {
  const seen = [];
  await prepareAddressListImport(tampaRows(), 'x.xlsx', {
    geocodeBatch: async (items) => { seen.push(...items); return fakeCensus(items); }
  });
  const northB = seen.find((item) => /north b/i.test(item.address));
  assert.equal(northB.address, '2711 W North B Street');
  assert.equal(northB.zip, '33609');
  assert.equal(northB.state, 'FL');
});

test('addresses Census misses are retried one at a time and tagged by source', async () => {
  const single = [];
  const batch = await prepareAddressListImport(tampaRows(), 'x.xlsx', {
    geocodeBatch: fakeCensus,
    geocodeOne: async (query) => { single.push(query.address); return { lat: 28.01, lng: -82.33 }; },
    wait: async () => {}
  });
  assert.deepEqual(single, ['8306 Riverbend Rise Ln']);
  assert.equal(batch.summary.unmatched, 0);
  assert.equal(batch.summary.geocodedByCensus, 3);
  assert.equal(batch.summary.geocodedByFallback, 1);
  assert.equal(batch.properties.at(-1).raw_metadata.geocode_source, 'nominatim');
});

test('a failing backend lookup falls back to single lookups instead of losing the file', async () => {
  const batch = await prepareAddressListImport(tampaRows(), 'x.xlsx', {
    geocodeBatch: async () => { throw new Error('function not deployed'); },
    geocodeOne: async () => ({ lat: 28, lng: -82 }),
    wait: async () => {}
  });
  assert.equal(batch.summary.ready, 4);
  assert.equal(batch.summary.geocodedByFallback, 4);
});

test('throws a clear error when nothing can be located', async () => {
  await assert.rejects(
    prepareAddressListImport(tampaRows(), 'x.xlsx', { geocodeBatch: async () => ({}) }),
    /None of the addresses/
  );
  await assert.rejects(
    prepareAddressListImport(tampaRows(), 'x.xlsx', { geocodeBatch: async () => { throw new Error('down'); } }),
    /could not look up any/
  );
});

test('rejects coordinates outside valid ranges from a geocoder', async () => {
  await assert.rejects(
    prepareAddressListImport(tampaRows(), 'x.xlsx', {
      geocodeBatch: async (items) => Object.fromEntries(items.map((item) => [item.id, { lat: 999, lng: -82 }]))
    }),
    /None of the addresses/
  );
});

test('chunks batches, reports progress, and caps single-lookup fallback', async () => {
  const candidates = Array.from({ length: 7 }, (_, i) => ({ id: `r${i}`, coords: null, query: { address: `${i} Main St` } }));
  const chunkSizes = [];
  const progress = [];
  const singles = [];
  const { resolved, fallbackSkipped } = await geocodeCandidates(candidates, {
    batchSize: 3,
    maxFallback: 2,
    geocodeBatch: async (items) => { chunkSizes.push(items.length); return {}; },
    geocodeOne: async (query) => { singles.push(query.address); return null; },
    onProgress: (event) => progress.push(event.phase),
    wait: async () => {}
  });
  assert.deepEqual(chunkSizes, [3, 3, 1]);
  assert.equal(singles.length, 2);
  assert.equal(fallbackSkipped, 5);
  assert.equal(resolved.size, 0);
  assert.ok(progress.includes('batch') && progress.includes('fallback'));
});

test('address helpers', () => {
  assert.deepEqual(splitStreetAndUnit('4015 BAYSHORE BOULEVARD #12B'), { street: '4015 BAYSHORE BOULEVARD', unit: '#12B' });
  assert.deepEqual(splitStreetAndUnit('5713 BOWEN DANIEL DR. #1502'), { street: '5713 BOWEN DANIEL DR', unit: '#1502' });
  assert.deepEqual(splitStreetAndUnit('12 Oak St Apt 4'), { street: '12 Oak St', unit: 'Apt 4' });
  assert.deepEqual(splitStreetAndUnit('12 Oak St'), { street: '12 Oak St', unit: '' });
  assert.equal(tidyCase('7002 THRASHER DRIVE'), '7002 Thrasher Drive');
  assert.equal(tidyCase('1234 N 53RD ST'), '1234 N 53rd St');
  assert.equal(tidyCase('1 McDonald Rd'), '1 McDonald Rd');
  assert.equal(cleanZip(2134), '02134');
  assert.equal(cleanZip('33605-1234'), '33605');
  assert.equal(cleanZip(33605), '33605');
});

test('reads a worksheet matrix into row objects', () => {
  const rows = matrixToRows([
    [],
    ['Address', 'City', null, 'City'],
    ['1 Main St', 'Tampa', 'x', 'Dup'],
    [null, null, null, null],
    ['2 Main St', 'Tampa', null, null]
  ]);
  assert.deepEqual(rows, [
    { Address: '1 Main St', City: 'Tampa', 'Column 3': 'x', 'City (2)': 'Dup' },
    { Address: '2 Main St', City: 'Tampa', 'Column 3': null, 'City (2)': null }
  ]);
  assert.deepEqual(matrixToRows([]), []);
});

test('builds the Census batch upload with quoting', () => {
  assert.equal(
    buildCensusBatchCsv([{ id: 'r0', address: '1 Main St, Unit "A"', city: 'Tampa', state: 'FL', zip: '33605' }]),
    'r0,"1 Main St, Unit ""A""",Tampa,FL,33605'
  );
});

test('parses a Census batch response, keeping only real matches', () => {
  const body = [
    '"r0","3103 E 23rd Ave, Tampa, FL, 33605","Match","Exact","3103 E 23RD AVE, TAMPA, FL, 33605","-82.425755,27.971869","123","L"',
    '"r1","5335 Maritime Breeze Lp, Tampa, FL, 33619","No_Match"',
    '"r2","10 Elm St, Tampa, FL, 33605","Tie"',
    '"r3","bad","Match","Exact","x","not,numbers","1","L"',
    ''
  ].join('\n');
  assert.deepEqual(parseCensusBatchResponse(body), {
    r0: { lat: 27.971869, lng: -82.425755, matchedAddress: '3103 E 23RD AVE, TAMPA, FL, 33605', matchType: 'Exact' }
  });
});

test('geocodeWithCensus posts the batch and surfaces HTTP failures', async () => {
  let posted;
  const ok = await geocodeWithCensus([{ id: 'a', address: '1 Main St', city: 'Tampa', state: 'FL', zip: '33605' }], {
    fetchImpl: async (url, init) => {
      posted = { url, init };
      return { ok: true, text: async () => '"a","x","Match","Exact","1 MAIN ST","-82.1,27.1","1","L"' };
    }
  });
  assert.equal(ok.a.lat, 27.1);
  assert.match(posted.url, /addressbatch$/);
  assert.equal(posted.init.method, 'POST');
  assert.equal(posted.init.body.get('benchmark'), 'Public_AR_Current');

  await assert.rejects(
    geocodeWithCensus([{ id: 'a', address: '1 Main St' }], { fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /503/
  );
  assert.deepEqual(await geocodeWithCensus([], { fetchImpl: async () => { throw new Error('should not call'); } }), {});
});
