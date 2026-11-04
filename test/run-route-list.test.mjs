import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRepRouteScope } from '../src/components/rep/repRouteCollection.js';
import { shouldRetryRead } from '../src/lib/readRequest.js';
import { loadRunRouteList, runRouteListCacheKey } from '../src/lib/runRouteList.js';

// A rep shaped like Jeremy on Kevin's team: routes are assigned to the
// TeamMember id and carry the manager's id as the tenant.
const rep = { id: 'user-1', email: 'rep@example.com', app_role: 'rep', team_manager_id: 'mgr-1', team_member_id: 'tm-1' };
const scope = buildRepRouteScope(rep);
const myRoute = { id: 'r1', manager_id: 'mgr-1', assigned_to: 'tm-1', created_date: '2026-11-04T10:00:00Z' };
const otherTenantRoute = { id: 'r2', manager_id: 'mgr-2', assigned_to: 'tm-1', created_date: '2026-11-04T11:00:00Z' };

function memoryCache(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: async key => (store.has(key) ? store.get(key) : null),
    setItem: async (key, value) => { store.set(key, value); },
  };
}

const pages = rows => async (filter, limit, skip) => (skip === 0 ? rows : []);
const stalled = () => new Promise(() => {});

test('a stalled read fails with a retryable timeout instead of hanging forever', async () => {
  const started = Date.now();
  await assert.rejects(
    loadRunRouteList({ fetchFilterPage: stalled, scope, cache: memoryCache(), deadlineMs: 20 }),
    error => {
      assert.equal(error.code, 'READ_TIMEOUT');
      assert.equal(shouldRetryRead(0, error), true);
      return true;
    },
  );
  assert.ok(Date.now() - started < 1000);
});

test('a good load returns the routes and saves a device snapshot', async () => {
  const cache = memoryCache();
  const result = await loadRunRouteList({ fetchFilterPage: pages([myRoute]), scope, cache });
  assert.deepEqual(result, { items: [myRoute], fromCache: false });
  assert.deepEqual(cache.store.get(runRouteListCacheKey(scope)), [myRoute]);
});

test('a failed load falls back to the snapshot, re-scoped to this account', async () => {
  const cache = memoryCache({ [runRouteListCacheKey(scope)]: [myRoute, otherTenantRoute] });
  const result = await loadRunRouteList({ fetchFilterPage: stalled, scope, cache, deadlineMs: 20 });
  assert.deepEqual(result, { items: [myRoute], fromCache: true });
});

test('an empty snapshot is still a valid answer when offline', async () => {
  const cache = memoryCache({ [runRouteListCacheKey(scope)]: [] });
  const result = await loadRunRouteList({ fetchFilterPage: stalled, scope, cache, deadlineMs: 20 });
  assert.deepEqual(result, { items: [], fromCache: true });
});

test('a broken device store neither hides a good load nor masks a failure', async () => {
  const broken = {
    getItem: async () => { throw new Error('store blocked'); },
    setItem: async () => { throw new Error('store full'); },
  };
  assert.deepEqual(
    await loadRunRouteList({ fetchFilterPage: pages([myRoute]), scope, cache: broken }),
    { items: [myRoute], fromCache: false },
  );
  const failure = Object.assign(new Error('network down'), { status: 503 });
  await assert.rejects(
    loadRunRouteList({ fetchFilterPage: async () => { throw failure; }, scope, cache: broken }),
    error => error === failure,
  );
});

test('snapshots are kept per account so a shared phone never shows another rep\'s routes', () => {
  const other = buildRepRouteScope({ ...rep, id: 'user-2', email: 'other@example.com', team_member_id: 'tm-2' });
  assert.notEqual(runRouteListCacheKey(scope), runRouteListCacheKey(other));
});

test('no signed-in user means no routes and no network read', async () => {
  let reads = 0;
  const result = await loadRunRouteList({ fetchFilterPage: async () => { reads += 1; return []; }, scope: buildRepRouteScope(null) });
  assert.deepEqual(result, { items: [], fromCache: false });
  assert.equal(reads, 0);
});
