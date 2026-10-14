import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { loadAuthoritativeUser } from '../base44/shared/accountIdentity.js';
import { isPrecisionJob, precisionJobBelongsToSubject } from '../base44/shared/precisionOrderSafety.js';
import { isValidRoutePoint } from '../base44/shared/routeBounds.js';
import { createManagedRoute, pendingRouteSaves, retryPendingRouteSaves } from '../src/lib/createManagedRoute.js';
import { isRepAccount, tenantManagerId } from '../base44/shared/accountTenancy.js';

const source = readFileSync(new URL('../base44/functions/createManagedRoute/entry.ts', import.meta.url), 'utf8');
const manager = { id: 'manager-1', role: 'user', app_role: 'manager', full_name: 'Manager', email: 'manager@example.com' };
const payload = { name: 'Generated homes', manager_id: manager.id, assigned_to: manager.id,
  property_hashes: ['home-a', 'home-b'], route_mode: 'precision', metrics: { distance: 1.5, house_count: 2 } };
function harness({ actor = manager, stored = actor, member = null, job = null, routes = [], createError } = {}) {
  const writes = [];
  const records = [...routes];
  const account = stored ? { ...stored } : null;
  const client = { auth: { me: async () => actor }, asServiceRole: { entities: {
    User: { get: async () => account, updateMany: async (filter, update) => {
      if (filter.route_save_lock_token && filter.route_save_lock_token !== account.route_save_lock_token) return { updated: 0 };
      if (filter.$or && account.route_save_lock_token && account.route_save_lock_expires_at > new Date().toISOString()) return { updated: 0 };
      Object.assign(account, update.$set); return { success: true, updated: 1, has_more: false };
    } },
    TeamMember: { get: async () => member, filter: async () => member ? [member] : [] },
    FetchJob: { get: async () => job },
    SavedRoute: { filter: async () => records, get: async id => records.find(record => record.id === id), create: async data => {
      if (createError) throw createError;
      writes.push(data); const saved = { ...data, id: `saved-route-${writes.length}` }; records.push(saved); return saved;
    } },
  } } };
  let handler;
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(compiled.replace(/^import .*;\s*$/gm, ''), {
    createClientFromRequest: () => client, loadAuthoritativeUser, isPrecisionJob, precisionJobBelongsToSubject, isValidRoutePoint, isRepAccount, tenantManagerId,
    Response, crypto, console: { error() {}, warn() {} }, Deno: { serve: callback => { handler = callback; } },
  });
  return { writes, run: async (route = payload, requestId) => {
    const response = await handler(new Request('https://firstknock.test/save', { method: 'POST', body: JSON.stringify({ route, request_id: requestId }) }));
    return { status: response.status, data: await response.json() };
  } };
}

test('an ordinary manager saves through the verified service path with exact door order', async () => {
  const h = harness(); const result = await h.run({ ...payload, id: 'forged', created_by: 'other@example.com', silent: true });
  assert.equal(result.status, 200); assert.equal(result.data.route.id, 'saved-route-1');
  assert.equal(h.writes[0].manager_id, manager.id);
  assert.equal(h.writes[0].assigned_to, manager.id);
  assert.deepEqual(Array.from(h.writes[0].property_hashes), payload.property_hashes);
  assert.equal(h.writes[0].created_by, undefined); assert.equal(h.writes[0].silent, undefined);
});

test('authentication and authoritative manager role are required before any write', async () => {
  for (const options of [{ actor: null }, { stored: { ...manager, app_role: 'rep' } }, { actor: { ...manager, role: 'admin' }, stored: { ...manager, app_role: 'rep', role: 'user' } }]) {
    const h = harness(options); const result = await h.run();
    assert.ok([401, 403].includes(result.status)); assert.equal(h.writes.length, 0);
  }
});

test('foreign tenant and foreign or inactive assignees cannot be selected', async () => {
  for (const [route, member] of [
    [{ ...payload, manager_id: 'other-manager' }, null],
    [{ ...payload, assigned_to: 'other-rep' }, { id: 'other-rep', manager_id: 'other-manager' }],
    [{ ...payload, assigned_to: 'inactive-rep' }, { id: 'inactive-rep', manager_id: manager.id, status: 'inactive' }],
  ]) {
    const h = harness({ member }); assert.equal((await h.run(route)).status, 403); assert.equal(h.writes.length, 0);
  }
  const h = harness({ member: { id: 'own-rep', name: 'Our rep', manager_id: manager.id, status: 'active' } });
  assert.equal((await h.run({ ...payload, assigned_to: 'own-rep', assigned_to_name: 'Fake name' })).data.route.assigned_to_name, 'Our rep');
});

test('invalid or duplicate home identifiers cannot create a route', async () => {
  for (const hashes of [[], ['a', 'a'], [''], [123], Array.from({ length: 10001 }, (_, i) => `home-${i}`)]) {
    const h = harness(); assert.equal((await h.run({ ...payload, property_hashes: hashes })).status, 400); assert.equal(h.writes.length, 0);
  }
});

test('job ownership is immutable and a completed-job retry reuses an existing saved route', async () => {
  const route = { ...payload, metadata: { newly_generated: true, precision_area: { job_id: 'job-1', polygon: [] } } };
  const job = { id: 'job-1', status: 'completed', mode_tag: 'PRECISION_TARGET', precision_usage_user_id: manager.id, polygon: [] };
  for (const badJob of [null, { ...job, precision_usage_user_id: 'other-manager', user_email: manager.email }, { ...job, status: 'running' }]) {
    const h = harness({ job: badJob }); assert.ok([403, 409].includes((await h.run(route)).status)); assert.equal(h.writes.length, 0);
  }
  const existing = { ...route, id: 'existing-route', status: 'ACTIVE', property_hashes: ['home-b', 'home-a'] };
  const h = harness({ job, routes: [existing] }); const result = await h.run(route);
  assert.equal(result.data.route.id, existing.id); assert.equal(result.data.already_saved, true); assert.equal(h.writes.length, 0);
});

test('personal anchors and their road geometry never reach a shared route', async () => {
  const h = harness(); const result = await h.run({ ...payload, route_origin_mode: 'home_round_trip',
    start_location: { lat: 33, lng: -112 }, end_location: { lat: 33, lng: -112 },
    metadata: { anchor: { record_id: 'foreign' }, route_bounds: {}, road_geometry: [[33, -112]], road_geometry_segments: [] } });
  assert.equal(result.status, 200); assert.equal(result.data.route.start_location, null);
  assert.equal(result.data.route.end_location, null); assert.deepEqual(result.data.route.metadata, {});
});

test('backend and incomplete responses reject instead of becoming device-only success', async () => {
  const h = harness({ createError: new Error('Database unavailable') }); assert.equal((await h.run()).status, 500);
  for (const invoke of [
    async () => { throw { response: { data: { message: 'Database unavailable' } } }; },
    async () => ({ data: {} }), async () => ({ data: { route: { id: 'local_route' } } }),
  ]) await assert.rejects(createManagedRoute({ functions: { invoke } }, payload), /generated but could not be saved/);
  const saved = await createManagedRoute({ functions: { invoke: async (name, body) => {
    assert.equal(name, 'createManagedRoute'); assert.equal(body.route, payload);
    return { data: { route: { ...payload, id: 'remote-route' } } };
  } } }, payload);
  assert.equal(saved.id, 'remote-route');
});

test('save request replay and concurrent requests create one persisted record', async () => {
  const h = harness(); const requestId = `route-${'a'.repeat(64)}`;
  const results = await Promise.all([h.run(payload, requestId), h.run(payload, requestId)]);
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.equal(results.filter(result => result.status === 409).length, 1);
  const replay = await h.run(payload, requestId);
  assert.equal(replay.status, 200); assert.equal(replay.data.already_saved, true);
  assert.equal(h.writes.length, 1);
  assert.equal((await h.run({ ...payload, property_hashes: ['different'] }, requestId)).status, 409);
});

test('a save lost to an outage survives reload and can only be retried by its account', async () => {
  const memory = new Map(); const storage = { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) };
  let calls = 0;
  const client = { auth: { me: async () => manager }, functions: { invoke: async () => {
    calls++; throw Object.assign(new Error('Offline'), { status: 503 });
  } } };
  await assert.rejects(createManagedRoute(client, payload, { storage, sleep: async () => {} }), /could not be saved/);
  assert.equal(calls, 3); assert.equal(pendingRouteSaves(manager.id, storage).length, 1);
  assert.equal((await retryPendingRouteSaves(client, 'other-account', { storage })).length, 0);
  client.functions.invoke = async (name, body) => ({ data: { route: { ...body.route, id: 'recovered-save' } } });
  const result = await retryPendingRouteSaves(client, manager.id, { storage });
  assert.equal(result[0].value.id, 'recovered-save'); assert.equal(pendingRouteSaves(manager.id, storage).length, 0);
});

test('device storage failure cannot prevent a successful account save', async () => {
  const storage = { getItem() { throw new Error('Storage disabled'); }, setItem() { throw new Error('Quota exceeded'); } };
  const client = { auth: { me: async () => manager }, functions: { invoke: async (_, body) => ({ data: { route: { ...body.route, id: 'cloud-route' } } }) } };
  assert.equal((await createManagedRoute(client, payload, { storage })).id, 'cloud-route');
});

test('all browser route creation uses the verified saver instead of direct entity writes', () => {
  const files = ['src/pages/Home.jsx', 'src/pages/ZipCodeExplorer.jsx', 'src/components/map/MapToolbar.jsx',
    'src/components/routes/ActiveRoutesTab.jsx', 'src/components/routes/SplitRouteModal.jsx',
    'src/components/team/CampaignWizard.jsx', 'src/components/manager/TerritorySetupWizard.jsx',
    'src/components/import/redfinCsvImport.jsx', 'src/components/import/savePropertyImport.js'];
  for (const file of files) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /\.entities\.SavedRoute\.(create|bulkCreate)\(/, file);
    assert.match(text, /createManagedRoute/, file);
  }
});
