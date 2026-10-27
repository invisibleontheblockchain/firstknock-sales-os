import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RUN_ROUTE_POSITION_KEY,
  RUN_ROUTE_POSITION_MAX_AGE_MS,
  clearRunRoutePosition,
  findRestoreStopKey,
  firstVisibleStopKey,
  getRouteStopKey,
  readRunRoutePosition,
  writeRunRoutePosition,
} from '../src/lib/runRoutePosition.js';

function memoryStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
    dump: () => Object.fromEntries(store),
  };
}

const NOW = Date.parse('2026-10-27T15:00:00Z');

test('a remembered position survives a reload and comes back for the same route only', () => {
  const storage = memoryStorage();
  assert.equal(writeRunRoutePosition(storage, {
    routeId: 'route-1', stopKey: 'house-18', openStopKey: 'house-18', filterStatus: 'todo', todoRouteTypes: ['ELIGIBLE', 'CALLBACK'],
  }, { now: NOW }), true);

  const restored = readRunRoutePosition(storage, 'route-1', { now: NOW + 60_000 });
  assert.deepEqual(restored, {
    routeId: 'route-1', stopKey: 'house-18', openStopKey: 'house-18', filterStatus: 'todo', todoRouteTypes: ['ELIGIBLE', 'CALLBACK'], savedAt: NOW,
  });
  assert.equal(readRunRoutePosition(storage, 'route-2', { now: NOW }), null);
  assert.equal(readRunRoutePosition(storage, '', { now: NOW }), null);
});

test('positions for several routes coexist and switching back resumes each one', () => {
  const storage = memoryStorage();
  writeRunRoutePosition(storage, { routeId: 'route-1', stopKey: 'a-7', filterStatus: 'all' }, { now: NOW });
  writeRunRoutePosition(storage, { routeId: 'route-2', stopKey: 'b-3', filterStatus: 'done' }, { now: NOW + 1000 });
  assert.equal(readRunRoutePosition(storage, 'route-1', { now: NOW + 2000 }).stopKey, 'a-7');
  assert.equal(readRunRoutePosition(storage, 'route-2', { now: NOW + 2000 }).stopKey, 'b-3');
  assert.equal(Object.keys(JSON.parse(storage.getItem(RUN_ROUTE_POSITION_KEY))).length, 2);
});

test('a position from a previous shift is ignored and pruned on the next write', () => {
  const storage = memoryStorage();
  writeRunRoutePosition(storage, { routeId: 'route-1', stopKey: 'a-7' }, { now: NOW });
  const later = NOW + RUN_ROUTE_POSITION_MAX_AGE_MS + 1;
  assert.equal(readRunRoutePosition(storage, 'route-1', { now: later }), null);
  writeRunRoutePosition(storage, { routeId: 'route-2', stopKey: 'b-1' }, { now: later });
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem(RUN_ROUTE_POSITION_KEY))), ['route-2']);
  // A clock that jumped backwards far enough is treated as stale too.
  writeRunRoutePosition(storage, { routeId: 'route-3', stopKey: 'c-1' }, { now: later + 3_600_000 });
  assert.equal(readRunRoutePosition(storage, 'route-3', { now: later }), null);
});

test('garbage in storage, unknown tabs and odd values never break the restore', () => {
  assert.equal(readRunRoutePosition(memoryStorage({ [RUN_ROUTE_POSITION_KEY]: '{not json' }), 'route-1', { now: NOW }), null);
  assert.equal(readRunRoutePosition(memoryStorage({ [RUN_ROUTE_POSITION_KEY]: '[]' }), 'route-1', { now: NOW }), null);
  const storage = memoryStorage();
  writeRunRoutePosition(storage, { routeId: 'route-1', stopKey: 42, openStopKey: null, filterStatus: 'bogus', todoRouteTypes: 'ELIGIBLE' }, { now: NOW });
  assert.deepEqual(readRunRoutePosition(storage, 'route-1', { now: NOW }), {
    routeId: 'route-1', stopKey: '42', openStopKey: null, filterStatus: null, todoRouteTypes: null, savedAt: NOW,
  });
  // Nothing worth restoring reads as no position at all.
  writeRunRoutePosition(storage, { routeId: 'route-1', filterStatus: 'nope' }, { now: NOW });
  assert.equal(readRunRoutePosition(storage, 'route-1', { now: NOW }), null);
  assert.equal(readRunRoutePosition(null, 'route-1', { now: NOW }), null);
  assert.equal(writeRunRoutePosition({ getItem() { throw new Error('private mode'); }, setItem() { throw new Error('quota'); } }, { routeId: 'route-1', stopKey: 'a' }), false);
  assert.equal(writeRunRoutePosition(storage, { stopKey: 'a' }), false);
});

test('completing a route forgets its position and leaves the others alone', () => {
  const storage = memoryStorage();
  writeRunRoutePosition(storage, { routeId: 'route-1', stopKey: 'a-7' }, { now: NOW });
  writeRunRoutePosition(storage, { routeId: 'route-2', stopKey: 'b-3' }, { now: NOW });
  assert.equal(clearRunRoutePosition(storage, 'route-1'), true);
  assert.equal(readRunRoutePosition(storage, 'route-1', { now: NOW }), null);
  assert.equal(readRunRoutePosition(storage, 'route-2', { now: NOW }).stopKey, 'b-3');
  assert.equal(clearRunRoutePosition(storage, 'route-2'), true);
  assert.equal(storage.getItem(RUN_ROUTE_POSITION_KEY), null);
  assert.equal(clearRunRoutePosition(storage, 'missing'), true);
});

test('the restore target is the remembered stop, else the next visible stop in route order', () => {
  const route = ['h1', 'h2', 'h3', 'h4', 'h5'];
  assert.equal(findRestoreStopKey(route, route, 'h3'), 'h3');
  // h3 was just knocked and left the Todo tab: land on the next door, not #1.
  assert.equal(findRestoreStopKey(route, ['h1', 'h2', 'h4', 'h5'], 'h3'), 'h4');
  // Everything after it is done too: stay at the last open door before it.
  assert.equal(findRestoreStopKey(route, ['h1', 'h2'], 'h3'), 'h2');
  assert.equal(findRestoreStopKey(route, ['h1', 'h2'], 'unknown'), null);
  assert.equal(findRestoreStopKey(route, [], 'h3'), null);
  assert.equal(findRestoreStopKey(route, route, ''), null);
});

test('the first stop still on screen is remembered when the app goes to the background', () => {
  const stops = [
    { key: 'h1', top: -200, bottom: -120 },
    { key: 'h2', top: -110, bottom: -30 },
    { key: 'h3', top: -20, bottom: 60 },
    { key: 'h4', top: 70, bottom: 150 },
  ];
  assert.equal(firstVisibleStopKey(stops, 0), 'h3');
  assert.equal(firstVisibleStopKey(stops, 100), 'h4');
  assert.equal(firstVisibleStopKey([{ key: '', bottom: 50 }, null, { key: 'h9', bottom: 40 }], 0), 'h9');
  assert.equal(firstVisibleStopKey([], 0), null);
  assert.equal(getRouteStopKey({ address_hash: 'abc', id: 'row' }), 'abc');
  assert.equal(getRouteStopKey({ id: 'row' }), 'row');
  assert.equal(getRouteStopKey(null), '');
});

test('Run Route wires the position memory into the list, the card, the tab and route completion', () => {
  const repHome = readFileSync(new URL('../src/pages/RepHome.jsx', import.meta.url), 'utf8');
  // Restore happens once per route after the homes load, and never over an appointment deep link.
  assert.match(repHome, /restoredPositionRouteIdRef\.current === routeId\) return;\s*\n\s*restoredPositionRouteIdRef\.current = routeId;/);
  assert.match(repHome, /if \(appointmentRunFocusHandledRef\.current\) return;\s*\n\s*let saved = null;\s*\n\s*try \{ saved = readRunRoutePosition\(localStorage, routeId\); \}/);
  assert.match(repHome, /if \(saved\.filterStatus\) setFilterStatus\(saved\.filterStatus\);/);
  assert.match(repHome, /setSelectedProperty\(routeProperties\[index\]\);\s*\n\s*setSelectedPropertyIndex\(index\);/);
  // Saving waits for the restore so a fresh mount cannot overwrite the saved place.
  assert.match(repHome, /if \(!routeId \|\| restoredPositionRouteIdRef\.current !== routeId\) return;\s*\n\s*try \{\s*\n\s*writeRunRoutePosition\(localStorage, \{/);
  assert.match(repHome, /openStopKey: selectedStopKey \|\| null,\s*\n\s*filterStatus,\s*\n\s*todoRouteTypes,/);
  // Scroll target comes from the rendered list, not the whole document.
  assert.match(repHome, /routeStopListRef\.current\?\.querySelectorAll\('\[data-route-stop-hash\]'\)/);
  assert.match(repHome, /<div ref=\{routeStopListRef\} className="space-y-1\.5">/);
  assert.match(repHome, /document\.addEventListener\('visibilitychange', rememberVisibleStop\);\s*\n\s*window\.addEventListener\('pagehide', rememberVisibleStop\);/);
  assert.match(repHome, /try \{ clearRunRoutePosition\(localStorage, routeId\); \} catch \{\}/);
  // The recovery warning does not flash over placeholder homes.
  assert.match(repHome, /\{!routeHydrationComplete && !propertiesPlaceholder &&/);
});
