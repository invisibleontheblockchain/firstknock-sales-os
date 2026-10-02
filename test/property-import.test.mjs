import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ExcelJS from 'exceljs';
import ts from 'typescript';
import { parsePropertyImportFile, workbookToRows } from '../src/components/import/propertyImportFile.js';
import { preparePropertyImport, propertyAddressKey, mergeImportedStops, geocodePropertyImportBatch } from '../src/components/import/propertyImportData.js';
import { savePropertyImport, canAppendToRoute } from '../src/components/import/savePropertyImport.js';

const user = { id: 'manager-1', email: 'manager@example.com', full_name: 'Manager' };
const sourceRow = (overrides = {}) => ({ 'Husband Name': 'Jody', 'Wife Name': 'April', 'Last Name': 'Davis ', Address: '3103 E 23rd Ave', City: 'Tampa', State: 'FL', Zip: 33605, County: 'Hills', ...overrides });
const locate = async addresses => addresses.map(() => ({ lat: 27.95, lng: -82.46, source: 'census' }));
const prepare = (rows, options = {}) => preparePropertyImport(rows, 'Tampa.xlsx', { geocodeBatch: locate, ...options });
const property = (hash, address, zip = '33605') => ({ address_hash: hash, address, full_address: address, zip_code: zip, city: 'Tampa', state: 'FL', lat: 27.95, lng: -82.46 });

test('Tampa columns preserve names, county and ZIP and deduplicate before geocoding', async () => {
  let requested;
  const batch = await prepare([sourceRow(), sourceRow({ Address: '3103 e 23rd Avenue' })], {
    geocodeBatch: async addresses => { requested = addresses; return locate(addresses); },
  });
  assert.equal(requested.length, 1);
  assert.equal('Husband Name' in requested[0], false);
  assert.equal(batch.properties[0].owner_full_name, 'Jody & April Davis');
  assert.equal(batch.properties[0].zip_code, '33605');
  assert.equal(batch.properties[0].raw_metadata.County, 'Hills');
  assert.deepEqual(batch.summary, { ready: 1, skipped: 0, duplicatesRemoved: 1 });
  const again = await prepare([sourceRow()], { geocodeBatch: async () => [{ lat: 27.95001, lng: -82.46001 }] });
  assert.equal(batch.properties[0].address_hash, again.properties[0].address_hash);
});

test('Excel reads title rows, multiple visible sheets, cached formulas and ignores formatting-only cells', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Tampa');
  sheet.addRow(['Tampa addresses']);
  sheet.addRow(['Address', 'City', 'State', 'Zip', null, 'Last Name']);
  sheet.addRow(['123 Main St', 'Tampa', 'FL', { formula: '33605', result: 33605 }, null, { richText: [{ text: 'Davis' }] }]);
  sheet.getCell('P80').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000000' } };
  const second = workbook.addWorksheet('More');
  second.addRow(['Address', 'City', 'State', 'Zip']);
  second.addRow(['125 Main St', 'Tampa', 'FL', 33605]);
  const hidden = workbook.addWorksheet('Hidden', { state: 'hidden' });
  hidden.addRow(['Address', 'City']); hidden.addRow(['999 Wrong St', 'Elsewhere']);
  const bytes = await workbook.xlsx.writeBuffer();
  const rows = await parsePropertyImportFile({ name: 'Tampa.xlsx', arrayBuffer: async () => bytes });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].Zip, 33605);
  assert.equal(rows[0]['Last Name'], 'Davis');
  assert.equal(Object.keys(rows[0]).some(header => !header), false);
  assert.throws(() => workbookToRows(new ExcelJS.Workbook()), /No property rows/);
  const history = new ExcelJS.Workbook();
  const historySheet = history.addWorksheet('Activity History');
  historySheet.addRow(['address_hash', 'status']);
  historySheet.addRow(['legacy-stop', 'SOLD']);
  assert.deepEqual(workbookToRows(history), [{ address_hash: 'legacy-stop', status: 'SOLD' }]);
});

test('CSV and wrapped JSON share the same property pipeline; malformed files fail', async () => {
  const csv = await parsePropertyImportFile({ name: 'LIST.CSV', text: async () => 'Address,City,State,Zip\n123 Main St,Tampa,FL,33605\n' });
  const json = await parsePropertyImportFile({ name: 'list.json', text: async () => JSON.stringify({ properties: [sourceRow()] }) });
  assert.equal(csv.length, 1); assert.equal(json.length, 1);
  await assert.rejects(parsePropertyImportFile({ name: 'list.csv', text: async () => 'Address,City\n"bad,Tampa' }), /unclosed quote/);
  await assert.rejects(parsePropertyImportFile({ name: 'list.xls' }), /xlsx/);
  await assert.rejects(parsePropertyImportFile({ name: 'list.json', text: async () => '[1,2]' }), /property objects/);
});

test('coordinates bypass lookup, invalid coordinates are located and lookup failures never masquerade as success', async () => {
  const batch = await prepare([sourceRow({ lat: '27.95', lng: '-82.46' })], { geocodeBatch: () => assert.fail('should not geocode') });
  assert.equal(batch.summary.ready, 1);
  const partial = await prepare([sourceRow(), sourceRow({ Address: '999 Unknown St' }), sourceRow({ Address: '' })], {
    geocodeBatch: async () => [{ lat: 27.95, lng: -82.46 }, { reason: 'No match' }],
  });
  assert.equal(partial.summary.skipped, 2);
  assert.equal(partial.skippedRows[0].reason, 'Missing address and coordinates');
  assert.equal(partial.skippedRows[1].reason, 'No match');
  await assert.rejects(prepare([sourceRow()], { geocodeBatch: async () => { throw new Error('Service down'); } }), /Service down/);
  await assert.rejects(prepare([sourceRow()], { geocodeBatch: async () => [] }), /incomplete/);
  await assert.rejects(prepare([sourceRow()], { geocodeBatch: async () => [null] }), /No properties could be located/);
});

test('address lookup runs in bounded batches and different addresses without a locality do not collide', async () => {
  const sizes = [];
  const batch = await prepare(Array.from({ length: 205 }, (_, i) => sourceRow({ Address: `${i + 1} Main St` })), {
    geocodeBatch: async addresses => { sizes.push(addresses.length); return locate(addresses); },
  });
  assert.deepEqual(sizes, [100, 100, 5]); assert.equal(batch.properties.length, 205);
  const noArea = await prepare([sourceRow({ Address: '1 Main St', Zip: '', State: '', City: '' }), sourceRow({ Address: '2 Main St', Zip: '', State: '', City: '' })]);
  assert.equal(noArea.properties.length, 2);
  assert.notEqual(noArea.properties[0].address_hash, noArea.properties[1].address_hash);
});

test('merge preserves legacy stop hashes and order and keeps different ZIPs and units distinct', () => {
  const route = { property_hashes: ['old-b', 'old-a'] };
  const existing = [property('old-b', '3103 E 23rd Ave'), property('old-a', '125 Main St')];
  const merged = mergeImportedStops(route, existing, [property('new-same', '3103 East 23rd Avenue'), property('new-unit', '3103 E 23rd Ave Apt 2'), property('new-zip', '3103 E 23rd Ave', '33606')]);
  assert.equal(merged.duplicatesRemoved, 1);
  assert.deepEqual(merged.propertyHashes, ['old-b', 'old-a', 'new-unit', 'new-zip']);
  assert.notEqual(propertyAddressKey(existing[0]), propertyAddressKey(property('x', '3103 E 23rd Ave Apt 2')));
  assert.notEqual(propertyAddressKey(existing[0]), propertyAddressKey(property('x', '3103 E 23rd Ave, Apt 2')));
  assert.equal(propertyAddressKey(property('x', '3103 E 23rd Ave #2')), propertyAddressKey(property('x', '3103 E 23rd Ave Apt 2')));
});

function mockClient(initialRoute, initialProperties = []) {
  let route = structuredClone(initialRoute);
  const properties = [...initialProperties];
  const writes = { createdRoutes: [], routeUpdates: [], propertyBatches: [] };
  const client = { entities: {
    SavedRoute: {
      get: async () => structuredClone(route),
      create: async payload => { writes.createdRoutes.push(payload); route = { id: 'new-route', ...payload }; return route; },
      update: async (id, payload) => { writes.routeUpdates.push({ id, payload }); route = { ...route, ...payload }; return route; },
    },
    MasterProperty: {
      filter: async filter => properties.filter(p => p.created_by === filter.created_by && filter.address_hash.$in.includes(p.address_hash)),
      bulkCreate: async batch => { writes.propertyBatches.push(batch); properties.push(...batch); return batch; },
    },
  } };
  return { client, properties, writes, setRoute: value => { route = value; } };
}

const existingRoute = { id: 'route-1', name: 'Tampa route', manager_id: user.id, assigned_to: 'rep-1', assigned_to_name: 'Alex', status: 'IN_PROGRESS', property_hashes: ['legacy-a'], metrics: { house_count: 1, score: 82 }, metadata: { campaign: 'Tampa' }, start_location: { lat: 27.94, lng: -82.47 } };

test('saving an additional file updates the existing route without changing assignment, progress or order', async () => {
  const old = property('legacy-a', '3103 E 23rd Ave');
  const mock = mockClient(existingRoute);
  const batch = await prepare([sourceRow(), sourceRow({ Address: '3200 E 23rd Ave' })]);
  const result = await savePropertyImport(batch, { client: mock.client, user, routeId: existingRoute.id, loadRouteProperties: async () => [old] });
  assert.equal(mock.writes.createdRoutes.length, 0);
  assert.equal(mock.writes.propertyBatches[0].length, 1);
  assert.equal(result.added, 1); assert.equal(result.total, 2); assert.equal(result.duplicatesRemoved, 1);
  assert.equal(result.route.property_hashes[0], 'legacy-a');
  for (const key of ['name', 'assigned_to', 'assigned_to_name', 'status', 'manager_id', 'start_location']) assert.deepEqual(result.route[key], existingRoute[key]);
  assert.equal(result.route.metrics.score, 82); assert.equal(result.route.metadata.campaign, 'Tampa');
  assert.equal(result.route.metadata.imports[0].file_name, 'Tampa.xlsx');
});

test('reimporting an identical file adds nothing and writes no new properties or route', async () => {
  const batch = await prepare([sourceRow()]);
  const mock = mockClient(existingRoute);
  const result = await savePropertyImport(batch, { client: mock.client, user, routeId: existingRoute.id, loadRouteProperties: async () => [property('legacy-a', '3103 E 23rd Ave')] });
  assert.equal(result.added, 0); assert.equal(result.duplicatesRemoved, 1);
  assert.equal(mock.writes.routeUpdates.length, 0); assert.equal(mock.writes.propertyBatches.length, 0);
});

test('new route uses the chosen name, reuses persisted records on retry and isolates rep tenant ownership', async () => {
  const batch = await prepare([sourceRow()]);
  const cached = { ...batch.properties[0], created_by: user.email, original_status: 'HARD_NO', id: 'property-1' };
  const mock = mockClient(null, [cached]);
  const result = await savePropertyImport({ ...batch, routeName: 'Tampa October' }, { client: mock.client, user });
  assert.equal(result.route.name, 'Tampa October'); assert.equal(mock.writes.propertyBatches.length, 0);
  assert.equal(mock.properties[0].original_status, 'HARD_NO');
  const rep = { id: 'rep-1', email: 'rep@example.com', data: { team_manager_id: user.id } };
  const repMock = mockClient(null);
  const repResult = await savePropertyImport(batch, { client: repMock.client, user: rep });
  assert.equal(repResult.route.manager_id, user.id); assert.equal(repResult.route.assigned_to, 'rep-1');
});

test('unauthorized, completed, incomplete and concurrently changed routes fail safely', async () => {
  const batch = await prepare([sourceRow({ Address: '3200 E 23rd Ave' })]);
  for (const route of [{ ...existingRoute, manager_id: 'other-manager' }, { ...existingRoute, status: 'COMPLETED' }]) {
    const mock = mockClient(route);
    await assert.rejects(savePropertyImport(batch, { client: mock.client, user, routeId: route.id }), /unavailable/);
    assert.equal(mock.writes.propertyBatches.length, 0);
  }
  const missing = mockClient(existingRoute);
  await assert.rejects(savePropertyImport(batch, { client: missing.client, user, routeId: existingRoute.id, loadRouteProperties: async () => [] }), /could not be loaded/);
  assert.equal(missing.writes.propertyBatches.length, 0);
  const changed = mockClient(existingRoute);
  await assert.rejects(savePropertyImport(batch, {
    client: changed.client, user, routeId: existingRoute.id,
    loadRouteProperties: async () => { changed.setRoute({ ...existingRoute, property_hashes: ['legacy-a', 'other-new'] }); return [property('legacy-a', '3103 E 23rd Ave')]; },
  }), /changed during/);
  assert.equal(changed.writes.routeUpdates.length, 0);
  assert.equal(canAppendToRoute({ ...existingRoute, status: 'ARCHIVED' }, user), false);
});

const persistenceSource = fs.readFileSync(new URL('../base44/functions/persistImportedProperties/entry.ts', import.meta.url), 'utf8')
  .replace(/^import .*?;\s*/m, '').replace(/Deno\.serve\([\s\S]*$/, '');
const persistenceJs = ts.transpileModule(persistenceSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { persistProperties } = await import(`data:text/javascript;base64,${Buffer.from(persistenceJs).toString('base64')}`);

test('trusted property persistence saves rep additions under their verified manager and strips forged system fields', async () => {
  const batch = await prepare([sourceRow()]);
  const mock = mockClient(existingRoute);
  mock.client.asServiceRole = { entities: { MasterProperty: mock.client.entities.MasterProperty, User: { get: async id => id === user.id ? user : null } } };
  const rep = { id: 'rep-1', email: 'rep@example.com', data: { team_manager_id: user.id } };
  const result = await persistProperties(mock.client, rep, {
    route_id: existingRoute.id,
    properties: [{ ...batch.properties[0], id: 'forged-id', created_by: 'outsider@example.com', manager_id: 'other-team' }],
  });
  assert.equal(result.status, 200);
  assert.equal(result.properties[0].created_by, user.email);
  assert.equal('manager_id' in result.properties[0], false);
  assert.equal('id' in result.properties[0], false);
  const again = await persistProperties(mock.client, rep, { route_id: existingRoute.id, properties: batch.properties });
  assert.equal(again.status, 200);
  assert.equal(mock.writes.propertyBatches.length, 1);
});

test('trusted property persistence rejects foreign routes, unverified owners and malformed property batches', async () => {
  const batch = await prepare([sourceRow()]);
  const mock = mockClient({ ...existingRoute, manager_id: 'other-team', created_by: user.email });
  mock.client.asServiceRole = { entities: { MasterProperty: mock.client.entities.MasterProperty, User: { get: async () => null } } };
  assert.equal(canAppendToRoute({ ...existingRoute, manager_id: 'other-team', created_by: user.email }, user), false);
  assert.equal((await persistProperties(mock.client, user, { route_id: existingRoute.id, properties: batch.properties })).status, 403);
  const rep = { id: 'rep-1', email: 'rep@example.com', data: { team_manager_id: user.id } };
  assert.equal((await persistProperties(mock.client, rep, { properties: batch.properties })).status, 403);
  for (const properties of [[], [{ ...batch.properties[0], lat: null }], [{ ...batch.properties[0], lat: 91 }], [batch.properties[0], batch.properties[0]]]) {
    assert.equal((await persistProperties(mock.client, user, { properties })).status, 400);
  }
  assert.equal(mock.writes.propertyBatches.length, 0);
});

test('route is never updated after incomplete trusted persistence', async () => {
  const batch = await prepare([sourceRow({ Address: '3200 E 23rd Ave' })]);
  const mock = mockClient(existingRoute);
  await assert.rejects(savePropertyImport(batch, {
    client: mock.client, user, routeId: existingRoute.id,
    loadRouteProperties: async () => [property('legacy-a', '3103 E 23rd Ave')],
    persistProperties: async () => [],
  }), /could not be saved/);
  assert.equal(mock.writes.routeUpdates.length, 0);
});

test('existing address service and fallback preserve input order and geocoder provenance', async () => {
  const addresses = [{ address: '1 Main St' }, { address: '2 Main St' }, { address: '3 Main St' }];
  const results = await geocodePropertyImportBatch(addresses, {
    geocodeBatch: async items => {
      assert.deepEqual(items.map(item => item.id), ['0', '1', '2']);
      return { '2': { lat: 28.2, lng: -82.2, source: 'geocodio' }, '0': { lat: 28, lng: -82, source: 'census' } };
    },
    geocodeOne: async query => { assert.equal(query.address, '2 Main St'); return { lat: 28.1, lng: -82.1 }; },
    delayMs: 0,
  });
  assert.deepEqual(results.map(result => result.lat), [28, 28.1, 28.2]);
  assert.deepEqual(results.map(result => result.source), ['census', 'nominatim', 'geocodio']);
  await assert.rejects(geocodePropertyImportBatch(addresses, { geocodeBatch: async () => { throw new Error('offline'); } }), /unavailable/);
});
