import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildSalesRows,
  buildSaleUpdatePayload,
  extractSaleNote,
  parseOptionalSaleAmount,
  salesLogBelongsToScope,
} from '../src/components/analytics/salesManagement.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');

test('optional sale amount accepts blank, zero, and cents while rejecting invalid revenue', () => {
  assert.deepEqual(parseOptionalSaleAmount(''), { value: null, error: '' });
  assert.deepEqual(parseOptionalSaleAmount('   '), { value: null, error: '' });
  assert.deepEqual(parseOptionalSaleAmount('0'), { value: 0, error: '' });
  assert.deepEqual(parseOptionalSaleAmount('1150.25'), { value: 1150.25, error: '' });
  assert.deepEqual(parseOptionalSaleAmount('.50'), { value: 0.5, error: '' });
  assert.match(parseOptionalSaleAmount('-1').error, /valid amount/);
  assert.match(parseOptionalSaleAmount('Infinity').error, /valid amount/);
  assert.match(parseOptionalSaleAmount('1e3').error, /valid amount/);
  assert.match(parseOptionalSaleAmount('1.234').error, /two decimal places/);
});

test('sales rows join property, rep, and route data without capping the result', () => {
  const logs = Array.from({ length: 55 }, (_, index) => ({
    id: `sale_${index}`,
    address_hash: index === 0 ? 'house_1' : `house_${index}`,
    route_id: 'route_1',
    created_by: 'REP@example.com',
    created_date: new Date(2026, 6, 1, 12, index % 60).toISOString(),
    parsed_status: 'SOLD',
    sale_amount: index === 0 ? 0 : index === 1 ? undefined : index * 10,
    description: index === 0 ? 'Signed at the door' : '',
  }));
  logs.push({ id: 'not_sale', parsed_status: 'CALLBACK' });

  const rows = buildSalesRows({
    logs,
    properties: [{
      address_hash: 'house_1',
      full_address: '107 Beechnut Dr',
      owner_full_name: 'Alex Homeowner',
    }],
    routes: [{ id: 'route_1', name: 'North Route' }],
    members: [{ email: 'rep@example.com', name: 'Jordan Rep' }],
  });

  assert.equal(rows.length, 55);
  const zeroSale = rows.find((row) => row.id === 'sale_0');
  const unsetSale = rows.find((row) => row.id === 'sale_1');
  assert.equal(zeroSale.address, '107 Beechnut Dr');
  assert.equal(zeroSale.homeowner, 'Alex Homeowner');
  assert.equal(zeroSale.repName, 'Jordan Rep');
  assert.equal(zeroSale.routeName, 'North Route');
  assert.equal(zeroSale.amountRecorded, true);
  assert.equal(zeroSale.amount, 0);
  assert.equal(zeroSale.notes, 'Signed at the door');
  assert.equal(unsetSale.amountRecorded, false);
  assert.equal(unsetSale.amount, null);
  assert.ok(Date.parse(rows[0].createdAt) >= Date.parse(rows.at(-1).createdAt));
});

test('sales rows use durable snapshots when live joins are unavailable', () => {
  const [row] = buildSalesRows({
    logs: [{
      id: 'snapshot_sale',
      parsed_status: 'SOLD',
      property_address: '2211 E 38th St',
      homeowner_name: 'Pat Owner',
      rep_name: 'Taylor Rep',
      route_name: 'Tuesday Route',
      sale_date: '2026-07-21T18:30:00.000Z',
      created_date: '2026-07-21T18:31:00.000Z',
      raw_input_text: 'Marked as SOLD | Note: Follow up in August | Sale: $850',
    }],
  });

  assert.deepEqual({
    address: row.address,
    homeowner: row.homeowner,
    repName: row.repName,
    routeName: row.routeName,
    notes: row.notes,
    createdAt: row.createdAt,
  }, {
    address: '2211 E 38th St',
    homeowner: 'Pat Owner',
    repName: 'Taylor Rep',
    routeName: 'Tuesday Route',
    notes: 'Follow up in August',
    createdAt: '2026-07-21T18:30:00.000Z',
  });
});

test('sale edits preserve optional revenue and clear it when correcting the outcome', () => {
  assert.deepEqual(buildSaleUpdatePayload({ amountInput: '', outcome: 'SOLD', notes: '  Good close  ' }), {
    payload: {
      parsed_status: 'SOLD',
      sale_amount: null,
      description: 'Good close',
      raw_input_text: 'Outcome corrected to SOLD | Note: Good close',
    },
    error: '',
  });
  assert.deepEqual(buildSaleUpdatePayload({ amountInput: '99.95', outcome: 'SOLD', notes: '' }), {
    payload: {
      parsed_status: 'SOLD',
      sale_amount: 99.95,
      description: '',
      raw_input_text: 'Outcome corrected to SOLD',
    },
    error: '',
  });
  assert.deepEqual(buildSaleUpdatePayload({ amountInput: '999', outcome: 'NO_ANSWER', notes: 'Correction' }), {
    payload: {
      parsed_status: 'NO_ANSWER',
      sale_amount: null,
      description: 'Correction',
      raw_input_text: 'Outcome corrected to NO_ANSWER | Note: Correction',
    },
    error: '',
  });
  assert.match(buildSaleUpdatePayload({ amountInput: '-20', outcome: 'SOLD' }).error, /valid amount/);
  assert.equal(extractSaleNote({ description: '', raw_input_text: 'SOLD | Note: Old note' }), '');
});

test('sales scope is personal for reps and team-bound for managers including legacy rows', () => {
  const repScope = { userEmail: 'rep@example.com', tenantManagerId: 'manager_1' };
  assert.equal(salesLogBelongsToScope({ parsed_status: 'SOLD', created_by: 'REP@example.com', manager_id: 'manager_1' }, repScope), true);
  assert.equal(salesLogBelongsToScope({ parsed_status: 'SOLD', created_by: 'other@example.com', manager_id: 'manager_1' }, repScope), false);
  assert.equal(salesLogBelongsToScope({ parsed_status: 'SOLD', created_by: 'rep@example.com', manager_id: 'manager_2' }, repScope), false);

  const managerScope = {
    userEmail: 'manager@example.com',
    tenantManagerId: 'manager_1',
    manager: true,
    memberEmails: ['rep@example.com'],
  };
  assert.equal(salesLogBelongsToScope({ parsed_status: 'SOLD', created_by: 'any@example.com', manager_id: 'manager_1' }, managerScope), true);
  assert.equal(salesLogBelongsToScope({ parsed_status: 'SOLD', created_by: 'rep@example.com' }, managerScope), true);
  assert.equal(salesLogBelongsToScope({ parsed_status: 'SOLD', created_by: 'outsider@example.com' }, managerScope), false);
  assert.equal(salesLogBelongsToScope({ parsed_status: 'CALLBACK', created_by: 'rep@example.com', manager_id: 'manager_1' }, managerScope), false);
});

test('both Precision Sold entry points persist blank Save and Skip with mobile numeric input', () => {
  const repSheet = readSource('src/components/rep/PropertyDetailSheet.jsx');
  const managerSheet = readSource('src/components/map/ManagerPropertyDetailSheet.jsx');
  const history = readSource('src/components/rep/PropertyHistory.jsx');

  for (const source of [repSheet, managerSheet]) {
    assert.match(source, /inputMode="decimal"/);
    assert.match(source, /min="0"/);
    assert.match(source, /step="0\.01"/);
    assert.match(source, /handle(?:Mark|QuickMark)\('SOLD', \{ skipSaleAmount: true \}\)/);
    assert.match(source, />\s*Save\s*</);
    assert.match(source, />\s*Skip\s*</);
  }
  assert.match(repSheet, /description: logNote\.trim\(\) \|\| null/);
  assert.match(history, /hasOwnProperty\.call\(log, 'description'\)/);
});

test('route checklist uses the shared optional sale amount rules, including zero', () => {
  const checklist = readSource('src/components/routes/RouteChecklist.jsx');

  assert.match(checklist, /parseOptionalSaleAmount\(rawAmount\)/);
  assert.doesNotMatch(checklist, /numericAmount <= 0/);
});

test('Analytics exposes an all-pages Sales Manager with update, correction, and confirmed deletion', () => {
  const list = readSource('src/pages/List.jsx');
  const editor = readSource('src/components/analytics/SalesEditor.jsx');
  const adminTeam = readSource('src/pages/AdminTeam.jsx');

  assert.match(list, /\{ id: 'sales', label: 'Sales', icon: DollarSign \}/);
  assert.match(list, /queryKey: \['salesManagerLogs'/);
  assert.match(list, /fetchAllAnalyticsPages/);
  assert.match(list, /parsed_status: 'SOLD'/);
  assert.match(list, /manager: managerAnalytics/);
  assert.match(list, /<SalesEditor/);
  assert.doesNotMatch(editor, /\.slice\(0, 50\)/);
  assert.match(editor, /InteractionLog\.update/);
  assert.match(editor, /InteractionLog\.delete/);
  assert.match(editor, /Confirm delete/);
  assert.match(editor, /salesManagerLogs/);
  assert.match(editor, /selectedPropertyHistory/);
  assert.match(editor, /aria-label=\{`Edit sale at/);
  assert.match(adminTeam, /routes=\{routes\}/);
  assert.match(adminTeam, /currentUser=\{user\}/);
  assert.match(adminTeam, /\{canManageTeam && \(/);
});

test('Sales Manager uses the Knock visual language across phone, tablet, and desktop layouts', () => {
  const editor = readSource('src/components/analytics/SalesEditor.jsx');

  assert.match(editor, /Recorded revenue/);
  assert.match(editor, /revenueCoverage/);
  assert.match(editor, /min-w-0[\s\S]*break-all text-\[clamp\(1\.65rem,8vw,2\.65rem\)\]/);
  assert.match(editor, /valuedSales > 0 \? formatMoney\(averageDeal\) : '—'/);
  assert.match(editor, /radial-gradient\(circle_at_16%_-6%,rgba\(46,235,87,0\.18\)/);
  assert.match(editor, /grid grid-cols-1 gap-2\.5 md:grid-cols-2/);
  assert.match(editor, /break-words text-\[15px\] font-extrabold/);
  assert.match(editor, /min-h-10 shrink-0 items-center/);
  assert.match(editor, /bottom-0 left-0 top-auto[\s\S]*sm:bottom-auto sm:left-\[50%\] sm:top-\[50%\]/);
  assert.match(editor, /pb-\[calc\(1rem\+env\(safe-area-inset-bottom\)\)\]/);
  assert.match(editor, /flex-1 overflow-y-auto/);
  assert.match(editor, /min-h-12 rounded-xl bg-\[#2EEB57\]/);
});
