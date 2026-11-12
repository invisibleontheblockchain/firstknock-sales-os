import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEVICE_AREA_ACCOUNT_KEY,
  DEVICE_AREA_KEYS,
  claimDeviceAreaStorage,
  clearDeviceAreaStorage,
  deviceAreaAccountId,
} from '../src/lib/deviceAreaStorage.js';

const readSource = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

class MemoryStorage {
  constructor(entries = {}) { this.map = new Map(Object.entries(entries)); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

const pulledArea = (lat) => JSON.stringify([{ polygon: [{ lat, lng: -105 }, { lat: lat + 0.1, lng: -105 }, { lat, lng: -104.9 }], queried: true }]);
const accountA = { id: 'user-a', email: 'first@gmail.com' };
const accountB = { id: 'user-b', email: 'second@gmail.com' };

test('areas pulled by one account are gone when another account signs in on the same device', () => {
  const storage = new MemoryStorage();
  claimDeviceAreaStorage(storage, accountA);
  storage.setItem('fk_polygonHistory', pulledArea(40));
  storage.setItem('fk_polygonHistoryHidden', JSON.stringify(['40.00000:-105.00000:3']));
  storage.setItem('fk_drawnPolygon', JSON.stringify([{ lat: 40, lng: -105 }]));
  storage.setItem('fk_drawnPolygonQueried', 'true');

  assert.equal(claimDeviceAreaStorage(storage, accountB), true);
  for (const key of DEVICE_AREA_KEYS) assert.equal(storage.getItem(key), null, `${key} cleared for the next account`);
  assert.equal(storage.getItem(DEVICE_AREA_ACCOUNT_KEY), 'user-b');
});

test('the same account keeps its own areas across visits', () => {
  const storage = new MemoryStorage();
  claimDeviceAreaStorage(storage, accountA);
  storage.setItem('fk_polygonHistory', pulledArea(40));

  assert.equal(claimDeviceAreaStorage(storage, accountA), false);
  assert.equal(storage.getItem('fk_polygonHistory'), pulledArea(40));
});

test('areas stored before accounts were recorded are cleared, since their owner is unknown', () => {
  const storage = new MemoryStorage({ fk_polygonHistory: pulledArea(39.7), fk_drawnPolygon: '[]' });
  assert.equal(claimDeviceAreaStorage(storage, accountB), true);
  assert.equal(storage.getItem('fk_polygonHistory'), null);
  assert.equal(storage.getItem('fk_drawnPolygon'), null);
  assert.equal(storage.getItem(DEVICE_AREA_ACCOUNT_KEY), 'user-b');
});

test('nothing is claimed or cleared without a signed-in account', () => {
  const storage = new MemoryStorage({ fk_polygonHistory: pulledArea(40), [DEVICE_AREA_ACCOUNT_KEY]: 'user-a' });
  assert.equal(claimDeviceAreaStorage(storage, null), false);
  assert.equal(claimDeviceAreaStorage(storage, {}), false);
  assert.equal(storage.getItem('fk_polygonHistory'), pulledArea(40));
});

test('the account is the user id, falling back to a normalized email', () => {
  assert.equal(deviceAreaAccountId({ id: ' u1 ', email: 'X@Y.com' }), 'u1');
  assert.equal(deviceAreaAccountId({ email: ' Sean@Gmail.com ' }), 'sean@gmail.com');
  assert.equal(deviceAreaAccountId(undefined), null);
});

test('signing out clears the areas and the record of whose they were', () => {
  const storage = new MemoryStorage();
  claimDeviceAreaStorage(storage, accountA);
  storage.setItem('fk_polygonHistory', pulledArea(40));
  storage.setItem('fk_showGhostAreas', 'true');
  clearDeviceAreaStorage(storage);
  for (const key of [...DEVICE_AREA_KEYS, DEVICE_AREA_ACCOUNT_KEY]) assert.equal(storage.getItem(key), null);
  // The ghost-button setting is a display preference, not an area.
  assert.equal(storage.getItem('fk_showGhostAreas'), 'true');
});

test('blocked storage never throws', () => {
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  assert.equal(claimDeviceAreaStorage(blocked, accountA), false);
  assert.doesNotThrow(() => clearDeviceAreaStorage(blocked));
  assert.equal(claimDeviceAreaStorage(null, accountA), false);
});

test('every device key the map uses for areas is covered', () => {
  const history = readSource('src/components/map/PolygonHistory.jsx');
  assert.ok(DEVICE_AREA_KEYS.includes(history.match(/const STORAGE_KEY = '([^']+)'/)[1]));
  assert.ok(DEVICE_AREA_KEYS.includes(history.match(/const HIDDEN_KEY = '([^']+)'/)[1]));
  const sources = ['src/pages/Home.jsx', 'src/components/map/TerritoryPrompt.jsx', 'src/lib/accountWorkingArea.js']
    .map(readSource).join('\n');
  const areaKeys = new Set([...sources.matchAll(/'(fk_drawnPolygon\w*|fk_polygonHistory\w*)'/g)].map((m) => m[1]));
  assert.ok(areaKeys.size > 0);
  for (const key of areaKeys) assert.ok(DEVICE_AREA_KEYS.includes(key), `${key} is cleared between accounts`);
});

test('Layout claims device areas for the signed-in account before any page renders, and clears them on sign-out', () => {
  const layout = readSource('src/Layout.jsx');
  const signInGuard = layout.indexOf('if (!user) {');
  const claim = layout.indexOf('claimDeviceAreaStorage(window.localStorage, user)');
  const pageRender = layout.indexOf('const currentPath = window.location.pathname;');
  assert.ok(signInGuard > 0 && claim > signInGuard && claim < pageRender, 'claim runs after sign-in and before pages render');
  const logout = layout.slice(layout.indexOf('const handleLogout'), layout.indexOf('base44.auth.logout(window.location.origin)'));
  assert.match(logout, /clearDeviceAreaStorage\(window\.localStorage\)/);
});
