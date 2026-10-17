import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRepRouteScope,
  buildSavedRouteQueryFilters,
  collectKnockRoutes,
  fetchAllSavedRoutePages,
  fetchKnockRouteGroups,
  KNOCK_ROUTE_SCOPE_FIELDS,
} from '../src/components/rep/repRouteCollection.js';

const manager = { id: 'mgr', email: 'boss@example.com', app_role: 'manager' };
const rep = { id: 'rep', email: 'rep@example.com', app_role: 'rep', team_manager_id: 'mgr' };
const route = (id, extra = {}) => ({
  id, created_date: `2026-10-${String(10 + Number(id.replace(/\D/g, '') || 0)).padStart(2, '0')}T00:00:00Z`,
  property_hashes: ['a', 'b', 'c'], metadata: { road_geometry_segments: [[1, 2], [3, 4]] }, ...extra,
});

// A tiny in-memory SavedRoute table that understands the filters these reads use.
function table(rows) {
  const calls = [];
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => (
    value && typeof value === 'object' && Array.isArray(value.$in) ? value.$in.includes(row[key]) : row[key] === value
  ));
  const fetchFilterPage = async (filter, limit, skip, fields) => {
    calls.push({ filter, fields });
    const page = rows.filter((row) => matches(row, filter))
      .sort((left, right) => right.created_date.localeCompare(left.created_date))
      .slice(skip, skip + limit);
    return fields ? page.map((row) => Object.fromEntries(fields.filter((field) => field in row).map((field) => [field, row[field]]))) : page;
  };
  return { calls, fetchFilterPage };
}

async function previousResult(rows, scope) {
  const { fetchFilterPage } = table(rows);
  const groups = await Promise.all(buildSavedRouteQueryFilters(scope).map((filter) => (
    fetchAllSavedRoutePages((limit, skip) => fetchFilterPage(filter, limit, skip))
  )));
  return collectKnockRoutes(groups, scope);
}

const ROWS = [
  route('r1', { manager_id: 'mgr', assigned_to: 'mgr', created_by: 'boss@example.com' }),
  route('r2', { manager_id: 'mgr', assigned_to: 'rep', created_by: 'boss@example.com' }),
  route('r3', { manager_id: 'mgr', created_by: 'boss@example.com' }),
  // Legacy rows that predate manager_id: visible to the manager only through the fallbacks.
  route('r4', { created_by: 'boss@example.com' }),
  route('r5', { assigned_to: 'mgr' }),
  // Another tenant's row must stay out even though it was assigned to this id.
  route('r6', { manager_id: 'other', assigned_to: 'mgr', created_by: 'boss@example.com' }),
];

test('manager reads return exactly the routes the three full reads returned', async () => {
  const scope = buildRepRouteScope(manager);
  const { calls, fetchFilterPage } = table(ROWS);
  const result = collectKnockRoutes(await fetchKnockRouteGroups(fetchFilterPage, scope), scope);
  assert.deepEqual(result, await previousResult(ROWS, scope));
  assert.deepEqual(result.map((row) => row.id).sort(), ['r1', 'r2', 'r3', 'r4', 'r5']);
  assert.ok(result.every((row) => Array.isArray(row.property_hashes) && row.metadata), 'every route keeps its full record');

  const full = calls.filter((call) => !call.fields);
  const slim = calls.filter((call) => call.fields);
  assert.deepEqual(full.map((call) => call.filter), [{ manager_id: 'mgr' }, { id: { $in: ['r5', 'r4'] } }]);
  assert.ok(slim.length >= 2 && slim.every((call) => call.fields === KNOCK_ROUTE_SCOPE_FIELDS));
});

test('a manager whose routes all carry manager_id makes no extra read', async () => {
  const rows = ROWS.filter((row) => row.manager_id === 'mgr');
  const scope = buildRepRouteScope(manager);
  const { calls, fetchFilterPage } = table(rows);
  const result = collectKnockRoutes(await fetchKnockRouteGroups(fetchFilterPage, scope), scope);
  assert.deepEqual(result, await previousResult(rows, scope));
  assert.equal(calls.filter((call) => !call.fields).length, 1, 'only the tenant read downloads full routes');
});

test('rep reads are unchanged', async () => {
  const scope = buildRepRouteScope(rep);
  const { calls, fetchFilterPage } = table(ROWS);
  const result = collectKnockRoutes(await fetchKnockRouteGroups(fetchFilterPage, scope), scope);
  assert.deepEqual(result, await previousResult(ROWS, scope));
  assert.ok(calls.every((call) => !call.fields));
  assert.deepEqual(calls.map((call) => call.filter), buildSavedRouteQueryFilters(scope));
});

test('a visible fallback row without an id keeps its whole group in full', async () => {
  const rows = [...ROWS, { created_date: '2026-10-30T00:00:00Z', created_by: 'boss@example.com', name: 'No id', property_hashes: ['z'] }];
  const scope = buildRepRouteScope(manager);
  const { fetchFilterPage } = table(rows);
  const result = collectKnockRoutes(await fetchKnockRouteGroups(fetchFilterPage, scope), scope);
  assert.deepEqual(result, await previousResult(rows, scope));
  assert.ok(result.some((row) => row.name === 'No id' && row.property_hashes));
});
