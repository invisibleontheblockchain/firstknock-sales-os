import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FIELD_BANNER_DISMISS_MAX_AGE_MS,
  dismissFieldBanner,
  fieldBannerKey,
  isFieldBannerDismissed,
  locationBannerScope,
  locationBannerTitle,
  mileageBannerScope,
} from '../src/lib/fieldBannerDismissal.js';

function memoryStorage() {
  const store = new Map();
  return {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    store,
  };
}

const NOW = Date.parse('2026-10-27T15:00:00Z');
const banner = (scope, userId = 'rep-1', bannerId = 'location') => ({ bannerId, userId, scope });

test('a closed notice stays closed for that shift, through reloads, for that account only', () => {
  const storage = memoryStorage();
  const scope = locationBannerScope({ sharing: true, shiftId: 'shift-9' });
  assert.equal(isFieldBannerDismissed(storage, banner(scope), { now: NOW }), false);
  assert.equal(dismissFieldBanner(storage, banner(scope), { now: NOW }), true);
  assert.equal(isFieldBannerDismissed(storage, banner(scope), { now: NOW + 3 * 60 * 60 * 1000 }), true);
  assert.equal(isFieldBannerDismissed(storage, banner(scope, 'rep-2'), { now: NOW }), false, 'another account on the device');
  assert.equal(isFieldBannerDismissed(storage, banner(scope, 'rep-1', 'mileage'), { now: NOW }), false, 'another notice');
  assert.ok(storage.store.has(fieldBannerKey('location', 'rep-1')));
});

test('the notice comes back on the next shift, after clocking out, and after a working day', () => {
  const storage = memoryStorage();
  const onShift = locationBannerScope({ sharing: true, shiftId: 'shift-9' });
  dismissFieldBanner(storage, banner(onShift), { now: NOW });
  assert.equal(isFieldBannerDismissed(storage, banner(locationBannerScope({ sharing: true, shiftId: 'shift-10' })), { now: NOW }), false);
  assert.equal(isFieldBannerDismissed(storage, banner(locationBannerScope({ sharing: false, shiftId: null })), { now: NOW }), false);
  assert.equal(isFieldBannerDismissed(storage, banner(onShift), { now: NOW + FIELD_BANNER_DISMISS_MAX_AGE_MS + 1 }), false);
  // A shift that could not be verified is its own notice, not a hidden one.
  assert.equal(locationBannerScope({ sharing: true, shiftId: 'shift-9', verificationError: true }), 'verification');
});

test('the mileage prompt and the mileage-on notice close separately per shift', () => {
  assert.equal(mileageBannerScope({ consent: false, shiftId: null }), 'prompt:no-shift');
  assert.equal(mileageBannerScope({ consent: false, shiftId: 'shift-9' }), 'prompt:shift-9');
  assert.equal(mileageBannerScope({ consent: true, shiftId: 'shift-9' }), 'on:shift-9');
  const storage = memoryStorage();
  dismissFieldBanner(storage, banner('prompt:no-shift', 'rep-1', 'mileage'), { now: NOW });
  assert.equal(isFieldBannerDismissed(storage, banner('prompt:no-shift', 'rep-1', 'mileage'), { now: NOW }), true);
  assert.equal(isFieldBannerDismissed(storage, banner('on:no-shift', 'rep-1', 'mileage'), { now: NOW }), false, 'turning mileage on shows its status');
});

test('unreadable or missing storage never hides a notice or throws', () => {
  const broken = { getItem() { throw new Error('private mode'); }, setItem() { throw new Error('quota'); } };
  assert.equal(isFieldBannerDismissed(broken, banner('off-shift'), { now: NOW }), false);
  assert.equal(dismissFieldBanner(broken, banner('off-shift'), { now: NOW }), false);
  assert.equal(isFieldBannerDismissed(null, banner('off-shift'), { now: NOW }), false);
  assert.equal(isFieldBannerDismissed({ getItem: () => '{oops' }, banner('off-shift'), { now: NOW }), false);
  assert.equal(isFieldBannerDismissed(memoryStorage(), banner('off-shift', ''), { now: NOW }), false, 'no account, no memory');
  assert.equal(dismissFieldBanner(memoryStorage(), banner('off-shift', null), { now: NOW }), false);
});

test('a blocked or silent GPS is named plainly instead of "connecting" forever', () => {
  const blocked = 'Location permission is blocked. Allow location access for FirstKnock in your phone settings, then return to the app.';
  assert.equal(locationBannerTitle({ sharing: true, live: false, error: blocked }), 'On the clock · location access is blocked');
  assert.equal(locationBannerTitle({ sharing: true, live: false, error: 'Waiting for GPS. Keep the app open with location access enabled.' }), 'On the clock · waiting for GPS…');
  assert.equal(locationBannerTitle({ sharing: true, live: false, error: 'Waiting for a fresh GPS location.' }), 'On the clock · waiting for GPS…');
  assert.equal(locationBannerTitle({ sharing: true, live: false, error: 'Location sharing is unavailable on this device.' }), 'On the clock · location sharing unavailable');
  assert.equal(locationBannerTitle({ sharing: true, live: false, error: 'Location could not sync. Retrying when connected.' }), 'On the clock · location not updating');
  assert.equal(locationBannerTitle({ sharing: true, live: false, error: '' }), 'On the clock · connecting your location…');
  assert.equal(locationBannerTitle({ sharing: true, live: true, error: '' }), 'On the clock · location live with your manager');
  assert.equal(locationBannerTitle({ sharing: false }), 'Location sharing starts when you clock in');
  assert.equal(locationBannerTitle({ sharing: true, verificationError: true }), 'Location sharing paused: your shift could not be verified');
});

test('both top notices offer an X that only hides them', () => {
  const location = readFileSync(new URL('../src/components/team/RepLocationSharing.jsx', import.meta.url), 'utf8');
  const mileage = readFileSync(new URL('../src/components/team/AutoDrivingTracking.jsx', import.meta.url), 'utf8');
  const session = readFileSync(new URL('../src/lib/repLocationSession.js', import.meta.url), 'utf8');
  assert.match(location, /useFieldBannerDismissal\('location', userId,/);
  assert.match(location, /if \(!eligible \|\| dismissed\) return null;/);
  assert.match(mileage, /useFieldBannerDismissal\('mileage', context\?\.userId,/);
  assert.match(mileage, /<FieldBannerClose label="Hide mileage notice" onClose=\{dismiss\} \/>/);
  assert.match(mileage, /if \(!context\?\.eligible \|\| dismissed\) return null;/);
  assert.doesNotMatch(session, /restart sharing/, 'there is no restart control to point at');
});
