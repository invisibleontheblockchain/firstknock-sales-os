import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { getTeamPerformanceQueryPlan, subscribeToTeamUpdates, TEAM_LOG_FIELDS, TEAM_ROUTE_FIELDS } from '../src/lib/teamQueryLoading.js';

test('default Team Analytics reads30 days; lifetime history is explicit and other tabs perform no activity query', () => {
  const now = new Date(2026, 9, 14, 15);
  const initial = getTeamPerformanceQueryPlan('analytics', 30, now);
  assert.equal(initial.allTime, false);
  assert.equal(initial.label, '30D');
  assert.equal(new Date(initial.start).getTime(), new Date(2026, 8, 15).getTime());
  assert.deepEqual(initial.filter, { created_date: { $gte: initial.start } });
  assert.equal(getTeamPerformanceQueryPlan('roster', 30, now).allTime, true);
  assert.equal(getTeamPerformanceQueryPlan('analytics', 99999, now).allTime, true);
  assert.deepEqual(getTeamPerformanceQueryPlan('roster', 30, now).filter, {});
  for (const tab of ['access', 'bases', 'logistics', 'driving', 'time-clock', 'locations']) {
    assert.equal(getTeamPerformanceQueryPlan(tab, 30, now).enabled, false);
  }
});

test('team projections retain metric and assignment metadata while excluding large customer/media and route payloads', () => {
  for (const field of ['created_date', 'created_by', 'manager_id', 'parsed_status', 'sale_amount', 'counts_as_knock']) {
    assert.ok(TEAM_LOG_FIELDS.includes(field));
  }
  for (const field of ['raw_input_text', 'description', 'image_url', 'gps_proof_lat', 'property_address']) {
    assert.ok(!TEAM_LOG_FIELDS.includes(field));
  }
  assert.ok(TEAM_ROUTE_FIELDS.includes('metadata'), 'assignment clearing must retain unrelated route metadata');
  assert.ok(!TEAM_ROUTE_FIELDS.includes('property_hashes'));
  assert.ok(!TEAM_ROUTE_FIELDS.includes('geometry'));
});

function subscriptions() {
  const callbacks = {};
  const timers = new Map();
  let nextId = 0;
  let routeRefreshes = 0;
  let logRefreshes = 0;
  let logScans = 0;
  let unsubscribed = 0;
  const entities = Object.fromEntries(['SavedRoute', 'InteractionLog'].map((name) => [name, {
    subscribe: (callback) => { callbacks[name] = callback; return () => { unsubscribed += 1; }; },
  }]));
  const cleanup = subscribeToTeamUpdates({
    entities,
    managerId: 'manager',
    routeScope: { managerId: 'manager', managerAccount: true, userEmail: 'manager@example.com', assigneeIds: ['manager'] },
    getRoutes: () => [{ id: 'known-route' }],
    getLogs: () => { logScans += 1; return [{ id: 'known-log' }]; },
    onRoutesChanged: () => { routeRefreshes += 1; },
    onLogsChanged: () => { logRefreshes += 1; },
    schedule: (callback, delay) => { assert.equal(delay, 15000); const id = nextId++; timers.set(id, callback); return id; },
    cancel: (id) => timers.delete(id),
  });
  return { callbacks, timers, cleanup, counts: () => ({ routeRefreshes, logRefreshes, logScans, unsubscribed }) };
}

test('1000 same-team events coalesce into one refresh and cross-team events trigger no history scan', () => {
  const h = subscriptions();
  for (let index = 0; index < 1000; index += 1) {
    h.callbacks.SavedRoute({ id: `route-${index}`, data: { manager_id: 'manager' } });
    h.callbacks.InteractionLog({ id: `log-${index}`, data: { manager_id: 'manager' } });
    h.callbacks.InteractionLog({ id: `other-${index}`, data: { manager_id: 'other' } });
  }
  assert.equal(h.timers.size, 2);
  assert.equal(h.counts().logScans, 0);
  [...h.timers.values()].forEach((callback) => callback());
  assert.equal(h.counts().routeRefreshes, 1);
  assert.equal(h.counts().logRefreshes, 1);
  h.cleanup();
  assert.equal(h.counts().unsubscribed, 2);
});

test('cached-row deletion refreshes owned data, unknown events do not, and unmount cancels scheduled reads', () => {
  const h = subscriptions();
  h.callbacks.InteractionLog({ id: 'unknown', type: 'delete' });
  assert.equal(h.timers.size, 0);
  h.callbacks.InteractionLog({ id: 'known-log', type: 'delete' });
  h.callbacks.SavedRoute({ id: 'known-route', type: 'delete' });
  assert.equal(h.timers.size, 2);
  h.cleanup();
  assert.equal(h.timers.size, 0);
  assert.equal(h.counts().logRefreshes, 0);
  assert.equal(h.counts().routeRefreshes, 0);
});

test('Team keeps navigation available while reads load and never labels missing totals zero', () => {
  const team = readFileSync(new URL('../src/pages/AdminTeam.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(team, /refetchInterval: 15_000/);
  assert.match(team, /if \(userLoading \|\| teamLoading\)/);
  assert.match(team, /performanceReady \? teamTotals\.doorsKnocked/);
  assert.match(team, /Could not load \{label\}\. Totals are unavailable/);
  assert.match(team, /historyLabel=\{performancePlan\.label\}/);
});

test('Time Clock lowers read polling to4/min while local elapsed time and immediate mutation refresh remain intact', () => {
  const source = readFileSync(new URL('../src/components/team/TimeClockTab.jsx', import.meta.url), 'utf8');
  assert.equal((source.match(/refetchInterval: 30000/g) || []).length, 2);
  assert.doesNotMatch(source, /refetchInterval: 5000/);
  assert.match(source, /setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\)/);
  assert.match(source, /onSettled: \(\) => queryClient\.invalidateQueries\(\{ queryKey: \['timeClock'\] \}\)/);
});
