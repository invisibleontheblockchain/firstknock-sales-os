import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ANALYTICS_LOG_FIELDS,
  adjustAnalyticsStatusCounts,
  buildAnalyticsRouteStats,
  collectAnalyticsRouteProperties,
  countAnalyticsWorkedDoors,
  fetchAnalyticsTerritorySummary,
  fetchPersonalAnalyticsLogs,
  getAnalyticsAppointmentDateFilter,
  requireCompleteAnalyticsRouteProperties,
} from '../src/lib/analyticsLoading.js';
import { getAnalyticsDateWindow } from '../src/lib/analyticsDateFilter.js';

test('historical day starts concurrently with recent history and keeps a compact outcome projection', async () => {
  let finishRecent;
  const recent = new Promise((resolve) => { finishRecent = resolve; });
  const calls = [];
  const window = getAnalyticsDateWindow({ selectedDate: new Date(2020, 1, 2) });
  const request = fetchPersonalAnalyticsLogs({ filter: async (...args) => {
    calls.push(args);
    return args[0].created_date ? [{ id: 'historical' }] : recent;
  } }, ['rep@example.com', 'rep@example.com'], { selectedWindow: window, read: (read) => read() });
  assert.equal(calls.length, 2, 'slow recent history must not delay the selected-day query');
  assert.deepEqual(calls[1][0].created_date, { $gte: window.start.toISOString(), $lt: window.end.toISOString() });
  assert.deepEqual(calls[0][4], ANALYTICS_LOG_FIELDS);
  for (const field of ['image_url', 'gps_proof_lat', 'gps_proof_lng', 'raw_input_text']) {
    assert.ok(!ANALYTICS_LOG_FIELDS.includes(field));
  }
  finishRecent([{ id: 'recent' }]);
  assert.deepEqual((await request).map((row) => row.id), ['recent', 'historical']);
});

test('explicit All Time reads continue beyond 5000 outcomes while normal startup keeps the existing recent window', async () => {
  const calls = [];
  const entity = { filter: async (filter, sort, limit, skip) => {
    calls.push({ filter, sort, limit, skip });
    return skip ? [{ id: 'older' }] : Array.from({ length: 5000 }, (_, index) => ({ id: `recent-${index}` }));
  } };
  const recent = await fetchPersonalAnalyticsLogs(entity, ['rep@example.com']);
  assert.equal(recent.length, 5000);
  assert.deepEqual(calls.map((call) => call.skip), [0]);
  calls.length = 0;
  const all = await fetchPersonalAnalyticsLogs(entity, ['rep@example.com'], { allTime: true });
  assert.equal(all.length, 5001);
  assert.deepEqual(calls.map((call) => call.skip), [0, 5000]);
});

test('route inventory counts every unique manifest door without requiring geometry', () => {
  const properties = collectAnalyticsRouteProperties([
    { property_hashes: ['one', 'two'], properties: [{ address_hash: 'one', full_address: '1 First St' }] },
    { property_hashes: ['two', 'three'] },
  ]);
  assert.deepEqual(properties.map((property) => property.address_hash), ['one', 'two', 'three']);
  assert.equal(properties[0].full_address, '1 First St');
});

test('territory aggregate corrections retain unworked and imported-status door counts', () => {
  const baseline = { ELIGIBLE: 99990, HARD_NO: 5, UNVERIFIED: 5 };
  const corrected = adjustAnalyticsStatusCounts(baseline, [
    { original_status: 'ELIGIBLE', effective_status: 'SOLD' },
    { original_status: 'ELIGIBLE', effective_status: 'CALLBACK' },
    { original_status: 'HARD_NO', effective_status: 'ELIGIBLE' },
    { original_status: 'UNVERIFIED', effective_status: 'NO_ANSWER' },
  ]);
  assert.deepEqual(corrected, { ELIGIBLE: 99989, HARD_NO: 4, UNVERIFIED: 4, SOLD: 1, CALLBACK: 1, NO_ANSWER: 1 });
  assert.equal(Object.values(corrected).reduce((sum, value) => sum + value, 0), 100000);
  assert.deepEqual(baseline, { ELIGIBLE: 99990, HARD_NO: 5, UNVERIFIED: 5 });
});

test('large historical summary matches stay in bounded batches and count the territory once', async () => {
  let active = 0;
  let maximum = 0;
  const sizes = [];
  const summary = await fetchAnalyticsTerritorySummary(Array.from({ length: 12001 }, (_, i) => `door-${i}`), async (hashes) => {
    sizes.push(hashes.length);
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return { success: true, count: 100000, status_counts: { ELIGIBLE: 100000 }, properties: hashes.map((address_hash) => ({ address_hash })) };
  });
  assert.deepEqual(sizes, [5000, 5000, 2001]);
  assert.equal(maximum, 2);
  assert.equal(summary.count, 100000);
  assert.equal(summary.properties.length, 12001);
});

test('summary errors and changing count snapshots cannot masquerade as zero activity', async () => {
  await assert.rejects(fetchAnalyticsTerritorySummary([], async () => ({ success: false })), /Unable to load/);
  await assert.rejects(fetchAnalyticsTerritorySummary([], async () => ({ success: true, count: -1, properties: [], status_counts: {} })), /Unable to load/);
  let requests = 0;
  await assert.rejects(fetchAnalyticsTerritorySummary(Array.from({ length: 5001 }, (_, i) => `door-${i}`), async () => ({
    success: true, count: requests++, status_counts: {}, properties: [],
  })), /Territory changed/);
});

test('appointment reads are bounded by both timestamp and legacy local date windows', () => {
  const window = getAnalyticsDateWindow({ selectedDate: new Date(2026, 9, 14) });
  const filter = getAnalyticsAppointmentDateFilter(window);
  assert.deepEqual(filter.$or[0].scheduled_date, { $gte: window.start.toISOString(), $lt: window.end.toISOString() });
  assert.deepEqual(filter.$or[1].scheduled_date, { $gte: '2026-10-14', $lt: '2026-10-15' });
  assert.deepEqual(getAnalyticsAppointmentDateFilter({ isAllTime: true }), {});
});

test('route statistics retain repeat visits, exclusions, duplicate manifests and metric denominators', () => {
  const stats = buildAnalyticsRouteStats([
    { id: 'pending', status: 'PENDING', property_hashes: ['one', 'one', 'two'], metrics: { house_count: 10 } },
    { id: 'active', status: 'ACTIVE', property_hashes: ['three'] },
    { id: 'archived', status: 'ARCHIVED', property_hashes: ['one'] },
  ], [
    { address_hash: 'one', parsed_status: 'NO_ANSWER' },
    { address_hash: 'one', parsed_status: 'SOLD' },
    { address_hash: 'two', parsed_status: 'CALLBACK', counts_as_knock: false },
    { address_hash: 'three', parsed_status: 'QUALIFIED' },
    { address_hash: 'outside', parsed_status: 'SOLD' },
  ]);
  assert.deepEqual(stats.map((route) => route.id), ['active', 'pending']);
  assert.deepEqual([stats[1].uniqueKnocked, stats[1].sales, stats[1].logCount, stats[1].total, stats[1].percent], [1, 1, 2, 10, 10]);
});

test('route statistics index 5000 logs once instead of rescanning them for all 500 routes', () => {
  let hashReads = 0;
  const logs = Array.from({ length: 5000 }, (_, index) => ({
    get address_hash() { hashReads += 1; return `door-${index}`; },
    parsed_status: 'NO_ANSWER',
  }));
  const routes = Array.from({ length: 500 }, (_, index) => ({
    status: 'ACTIVE', property_hashes: Array.from({ length: 3000 }, (_, door) => `door-${index + door}`),
  }));
  const stats = buildAnalyticsRouteStats(routes, logs);
  assert.equal(stats.length, 500);
  assert.ok(hashReads <= 5000 * 3, `log hashes were read ${hashReads} times`);
  assert.equal(stats[0].uniqueKnocked, 3000);
});

test('Analytics does not make performance or route progress wait on geometry or forced auth refresh', () => {
  const source = readFileSync(new URL('../src/pages/List.jsx', import.meta.url), 'utf8');
  assert.match(source, /response_mode: 'analytics_summary'/);
  assert.doesNotMatch(source, /refetchOnMount: 'always'/);
  assert.doesNotMatch(source, /logs\.filter\(\(log\) => log\.address_hash === property\.address_hash\)/);
  assert.match(source, /<RouteProgress routes=\{savedRoutes\}/);
  assert.match(source, /\(isSalesTab && legacySalesRoutes\.length > 0\)/);
  assert.match(source, /Load door statuses/);
  assert.match(source, /requireCompleteAnalyticsRouteProperties\(hydrated\)/);
  assert.doesNotMatch(source, /const isLoading = [^\n]*hydratedRoutesLoading/);
});

test('an empty matched territory set excludes outside doors even when territory inventory is nonzero', () => {
  const logs = [{ address_hash: 'outside' }, { address_hash: 'inside' }, { address_hash: 'inside' }];
  assert.equal(countAnalyticsWorkedDoors(logs, [], true), 0);
  assert.equal(countAnalyticsWorkedDoors(logs, ['inside'], true), 1);
  assert.equal(countAnalyticsWorkedDoors(logs, [], false), 2);
});

test('on-demand imported route statuses preserve real baselines and reject incomplete lookups', () => {
  const routes = [{ property_hashes: ['hard-no', 'dnc', 'unverified'], properties: [
    { address_hash: 'hard-no', original_status: 'HARD_NO' },
    { address_hash: 'dnc', original_status: 'DO_NOT_KNOCK' },
    { address_hash: 'unverified', original_status: 'UNVERIFIED' },
  ] }];
  const verified = requireCompleteAnalyticsRouteProperties(routes);
  assert.deepEqual(collectAnalyticsRouteProperties(verified).map((property) => property.original_status), ['HARD_NO', 'DO_NOT_KNOCK', 'UNVERIFIED']);
  assert.throws(() => requireCompleteAnalyticsRouteProperties([{ property_hashes: ['one', 'two'], properties: [{ address_hash: 'one' }] }]), /statuses are unavailable/);
});
