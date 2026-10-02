import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { locationStatus, locationAgeLabel, validLocation, LOCATION_FIX_MAX_AGE_MS } from '../base44/shared/repLocations.js';
import { startRepLocationSession } from '../src/lib/repLocationSession.js';

const manager = { id: 'manager-a', app_role: 'manager', role: 'user' };
const rep = { id: 'rep-a', app_role: 'rep', role: 'user', team_manager_id: manager.id };
const member = { id: 'member-a', manager_id: manager.id, user_id: rep.id, role: 'rep', status: 'active', name: 'Alex' };
const fresh = (overrides = {}) => ({ id: 'location-a', manager_id: manager.id, member_id: member.id, rep_user_id: rep.id,
  session_id: 'session-a', sharing: true, lat: 33.4, lng: -112, accuracy: 12,
  observed_at: new Date().toISOString(), received_at: new Date().toISOString(), ...overrides });

function harness({ caller = manager, savedUser = caller, members = [member], locations = [], ignoreScope = false } = {}) {
  const writes = [];
  const queries = [];
  let handler;
  const filter = (records) => async (query, sort, limit, skip) => {
    queries.push(query);
    const rows = (ignoreScope ? records : records.filter(row => Object.entries(query).every(([k, v]) => row[k] === v)))
      .sort((a, b) => sort === '-received_at' ? Date.parse(b.received_at) - Date.parse(a.received_at) : 0);
    return { items: rows.slice(skip, skip + limit) };
  };
  const base44 = { auth: { me: async () => caller }, asServiceRole: { entities: {
    User: { get: async id => id === savedUser?.id ? savedUser : id === manager.id ? manager : null },
    TeamMember: { filter: filter(members) },
    RepLocation: {
      filter: filter(locations),
      create: async data => { writes.push(data); locations.push({ id: `new-${locations.length}`, ...data }); },
      update: async (id, data) => { writes.push({ id, ...data }); Object.assign(locations.find(row => row.id === id), data); },
    },
  } } };
  const code = ts.transpileModule(fs.readFileSync('base44/functions/repLocations/entry.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/^import .*;\s*$/gm, '');
  vm.runInNewContext(code, { createClientFromRequest: () => base44, Deno: { serve: fn => { handler = fn; } },
    locationStatus, validLocation, LOCATION_FIX_MAX_AGE_MS, Response, console });
  return { writes, queries, invoke: async (body = {}) => {
    const response = await handler(new Request('https://team.test/locations', { method: 'POST', body: JSON.stringify(body) }));
    return { status: response.status, data: await response.json() };
  } };
}

test('manager report excludes foreign, inactive, unlinked and stopped locations', async () => {
  const locations = [fresh(), fresh({ id: 'foreign', manager_id: 'other', member_id: 'other-member', rep_user_id: 'other-rep' })];
  const members = [{ ...member }, { ...member, id: 'inactive', status: 'inactive' }, { ...member, id: 'other-member', manager_id: 'other', user_id: 'other-rep' }];
  const { invoke } = harness({ members, locations, ignoreScope: true });
  const { status, data } = await invoke({ manager_id: 'other' });
  assert.equal(status, 200);
  assert.equal(data.manager_id, manager.id);
  assert.deepEqual(data.reps.map(row => row.member_id), [member.id]);
  assert.equal(data.reps[0].location.lat, 33.4);
  locations[0].sharing = false;
  assert.equal((await invoke()).data.reps[0].location, null);
  locations[0].sharing = true;
  members[0].user_id = 'replacement-rep';
  assert.equal((await invoke()).data.reps[0].location, null);
});

test('reps cannot read locations, including callers with forged manager auth flags', async () => {
  const { invoke } = harness({ caller: { ...rep, role: 'admin', is_owner: true }, savedUser: rep });
  assert.equal((await invoke()).status, 403);
  assert.equal((await harness({ caller: null }).invoke()).status, 401);
});

test('publishing binds location to the saved rep identity and membership', async () => {
  const { invoke, writes } = harness({ caller: rep });
  const { status } = await invoke({ ...fresh(), action: 'publish', manager_id: 'foreign', member_id: 'foreign', rep_user_id: 'foreign' });
  assert.equal(status, 200);
  assert.equal(writes[0].manager_id, manager.id);
  assert.equal(writes[0].member_id, member.id);
  assert.equal(writes[0].rep_user_id, rep.id);
});

test('removed, inactive and promoted reps cannot publish through a stale team link', async () => {
  for (const members of [[], [{ ...member, status: 'inactive' }], [{ ...member, role: 'manager' }], [{ ...member, user_id: 'other' }]]) {
    const { invoke, writes } = harness({ caller: rep, members });
    assert.equal((await invoke({ ...fresh(), action: 'publish' })).status, 403);
    assert.equal(writes.length, 0);
  }
});

test('bad coordinates, stale fixes, future timestamps and negative accuracy are rejected', async () => {
  for (const override of [{ lat: 91 }, { lng: -181 }, { lat: '33' }, { accuracy: -1 },
    { observed_at: new Date(Date.now() - 31_000).toISOString() }, { observed_at: new Date(Date.now() + 60_000).toISOString() },
    { observed_at: 'invalid' }, { session_id: '' }]) {
    const { invoke, writes } = harness({ caller: rep });
    assert.equal((await invoke({ ...fresh(), ...override, action: 'publish' })).status, 400);
    assert.equal(writes.length, 0);
  }
});

test('stopping affects only the current sharing session and hides its coordinates', async () => {
  const locations = [fresh(), fresh({ id: 'different-session', session_id: 'session-b' })];
  const { invoke, writes } = harness({ caller: rep, locations });
  assert.equal((await invoke({ action: 'stop', session_id: 'session-a' })).status, 200);
  assert.equal(writes.length, 1);
  assert.equal(locations[0].sharing, false);
  assert.equal(locations[1].sharing, true);
});

test('a delayed GPS update cannot move a rep back to an older position', async () => {
  const latest = fresh();
  const { invoke, writes } = harness({ caller: rep, locations: [latest] });
  const { status, data } = await invoke({ ...fresh(), action: 'publish', lat: 30,
    observed_at: new Date(Date.parse(latest.observed_at) - 5000).toISOString() });
  assert.equal(status, 200);
  assert.equal(data.ignored, true);
  assert.equal(writes.length, 0);
  assert.equal(latest.lat, 33.4);
});

test('live signals age into delayed and then offline; expired coordinates are suppressed', async () => {
  const now = Date.now();
  const location = fresh({ observed_at: new Date(now).toISOString() });
  assert.equal(locationStatus(location, now + 60_000), 'live');
  assert.equal(locationStatus(location, now + 60_001), 'stale');
  assert.equal(locationStatus(location, now + 300_001), 'offline');
  assert.equal(locationAgeLabel(location, now + 90_000), '1m ago');
  const { invoke } = harness({ locations: [fresh({ observed_at: new Date(now - 301_000).toISOString() })] });
  assert.equal((await invoke()).data.reps[0].location, null);
});

test('manager report paginates the complete team roster', async () => {
  const members = Array.from({ length: 501 }, (_, i) => ({ ...member, id: `member-${i}`, user_id: `rep-${i}` }));
  const { invoke } = harness({ members });
  assert.equal((await invoke()).data.reps.length, 501);
});

const flush = () => new Promise(resolve => setImmediate(resolve));
function gpsHarness(invoke = async () => {}) {
  let time = Date.now();
  let onPosition;
  let heartbeat;
  let pendingPublish;
  const calls = [];
  const updates = [];
  const cleared = [];
  const position = () => ({ timestamp: time, coords: { latitude: 33.4, longitude: -112, accuracy: 12 } });
  const session = startRepLocationSession({
    geolocation: {
      watchPosition: callback => { onPosition = callback; return 7; },
      getCurrentPosition: callback => { callback(position()); },
      clearWatch: id => cleared.push(id),
    },
    invoke: async body => { calls.push(body); if (body.action === 'publish') pendingPublish = invoke(body); await pendingPublish; },
    sessionId: 'session-a', onState: update => updates.push(update), now: () => time,
    setTimer: callback => { heartbeat = callback; return 8; }, clearTimer: id => cleared.push(id),
  });
  return { session, calls, updates, cleared, position, emit: p => onPosition(p || position()),
    advance: ms => { time += ms; }, heartbeat: () => heartbeat() };
}

test('stationary reps publish fresh GPS heartbeats and rapid fixes are throttled', async () => {
  const gps = gpsHarness();
  gps.emit(); await flush();
  gps.emit(); await flush();
  assert.equal(gps.calls.length, 1);
  gps.advance(15_000); gps.heartbeat(); await flush();
  assert.equal(gps.calls.length, 2);
  assert.notEqual(gps.calls[0].observed_at, gps.calls[1].observed_at);
  await gps.session.stop();
  assert.deepEqual(gps.cleared, [7, 8]);
});

test('stop drains an in-flight publish, prevents late GPS writes, and runs once', async () => {
  let complete;
  const gps = gpsHarness(() => new Promise(resolve => { complete = resolve; }));
  gps.emit(); await flush();
  const stop = gps.session.stop();
  gps.advance(15_000); gps.emit(); gps.heartbeat();
  assert.equal(gps.calls.length, 1);
  complete(); await stop;
  assert.deepEqual(gps.calls.map(body => body.action), ['publish', 'stop']);
  await gps.session.stop();
  assert.equal(gps.calls.length, 2);
});

test('GPS errors and sync failures never falsely report a successful live publish', async () => {
  const gps = gpsHarness(async () => { throw new Error('offline'); });
  gps.emit({ ...gps.position(), timestamp: Date.now() - 40_000 }); await flush();
  assert.equal(gps.calls.length, 0);
  gps.emit(); await flush();
  assert.ok(gps.updates.at(-1).error);
  assert.equal(gps.updates.some(update => update.lastPublished), false);
  await assert.rejects(gps.session.stop());
});
