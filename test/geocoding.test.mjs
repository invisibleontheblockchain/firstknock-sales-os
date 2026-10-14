import test from 'node:test';
import assert from 'node:assert/strict';
import { geocodeAddress } from '../src/lib/geocoding.js';
import { geocodeAddressItems } from '../base44/shared/addressGeocoder.js';

const rural = '123 NW Highway 464B, Exampletown, Florida 32268';
const apartment = '456 Example Ave, Apt 305, Tampa, FL 33647';
const censusAddress = '123 NW HWY 464B, EXAMPLETOWN, FL, 32668';
const response = match => ({ data: { success: true, results: match ? { location: match } : {} } });
const hit = { lat: 29.24, lng: -82.37, matchedAddress: censusAddress, source: 'census', matchType: 'Exact' };

test('free-text rural addresses use the backend and show its normalized ZIP', async () => {
  let requested;
  const result = await geocodeAddress(rural, {
    invokeGeocoder: async addresses => { requested = addresses; return response(hit); },
  });
  assert.deepEqual(requested, [{ id: 'location', address: rural }]);
  assert.deepEqual(result, { address: censusAddress, lat: 29.24, lng: -82.37 });
});

test('structured addresses retain separate locality fields', async () => {
  let requested;
  await geocodeAddress({ address: '123 NW Highway 464B', city: 'Exampletown', state: 'FL', zip: '32668' }, {
    invokeGeocoder: async addresses => { requested = addresses; return response(hit); },
  });
  assert.deepEqual(requested, [{ id: 'location', address: '123 NW Highway 464B', city: 'Exampletown', state: 'FL', zip: '32668' }]);
});

test('building matches keep apartment, suite, building and hash units in the saved address', async () => {
  for (const unit of ['Apt 305', 'Apartment 305', 'Unit A-1', 'Suite A', 'Bldg 2A', '#305', 'Apt 305, Bldg 2A']) {
    const result = await geocodeAddress(`456 Example Ave, ${unit}, Tampa, FL 33647`, {
      invokeGeocoder: async () => response({ ...hit, matchedAddress: '456 EXAMPLE AVE, TAMPA, FL, 33647' }),
    });
    assert.equal(result.address, `456 EXAMPLE AVE, ${unit}, TAMPA, FL, 33647`);
  }
  const result = await geocodeAddress(apartment, {
    invokeGeocoder: async () => response({ ...hit, matchedAddress: '456 EXAMPLE AVE, APT 305, TAMPA, FL, 33647' }),
  });
  assert.equal(result.address.match(/apt 305/gi).length, 1);
});

test('the client reaches Geocodio when Census misses or is unavailable', async () => {
  for (const censusDown of [false, true]) {
    const providers = [];
    const invokeGeocoder = async addresses => {
      const data = await geocodeAddressItems(addresses, {
        geocodioApiKey: 'test-key',
        fetchImpl: async url => {
          if (String(url).includes('census.gov')) {
            providers.push('census');
            return censusDown ? { ok: false, status: 503 } : { ok: true, text: async () => '"location","x","No_Match"' };
          }
          providers.push('geocodio');
          return { ok: true, json: async () => ({ results: { location: { response: { results: [{
            location: { lat: 28.14, lng: -82.31 }, accuracy: 1, accuracy_type: 'rooftop',
            formatted_address: '456 Example Ave, Tampa, FL 33647', address_components: { state_province: 'FL' },
          }] } } } }) };
        },
      });
      return { data: { success: true, ...data } };
    };
    const result = await geocodeAddress(apartment, { invokeGeocoder });
    assert.deepEqual(providers, ['census', 'geocodio']);
    assert.deepEqual(result, { address: '456 Example Ave, Apt 305, Tampa, FL 33647', lat: 28.14, lng: -82.31 });
  }
});

test('no match is distinct from provider and network failures', async () => {
  await assert.rejects(geocodeAddress(rural, { invokeGeocoder: async () => response(null) }), /could not find.*ZIP/);
  for (const error of [new Error('Network error'), { response: { status: 502, data: { error: 'provider failed with secret details' } } }]) {
    await assert.rejects(geocodeAddress(rural, { invokeGeocoder: async () => { throw error; } }),
      /^Error: Address lookup is temporarily unavailable\. Please try again\.$/);
  }
});

test('authentication failures ask for sign-in', async () => {
  for (const status of [401, 403]) {
    await assert.rejects(geocodeAddress(rural, { invokeGeocoder: async () => { throw { response: { status } }; } }), /Sign in again/);
  }
});

test('empty addresses do not call a provider', async () => {
  for (const value of ['', '   ', null, {}, { city: 'Tampa', state: 'FL' }]) {
    await assert.rejects(geocodeAddress(value, { invokeGeocoder: () => assert.fail('unexpected lookup') }), /Enter a street address/);
  }
});

test('malformed backend responses never become a successful lookup', async () => {
  for (const data of [null, {}, { success: false, results: {} }, { success: true, results: [] }]) {
    await assert.rejects(geocodeAddress(rural, { invokeGeocoder: async () => ({ data }) }), /invalid response/);
  }
});

test('invalid coordinates cannot be saved; numeric strings are accepted', async () => {
  for (const bad of [null, undefined, '', ' ', NaN, Infinity, false, [], {}, 999]) {
    for (const coordinate of ['lat', 'lng']) {
      await assert.rejects(geocodeAddress(rural, { invokeGeocoder: async () => response({ ...hit, [coordinate]: bad }) }), /invalid coordinates/);
    }
  }
  const result = await geocodeAddress(rural, { invokeGeocoder: async () => response({ ...hit, lat: '29.24', lng: '-82.37' }) });
  assert.equal(result.lat, 29.24);
  assert.equal(result.lng, -82.37);
});

test('a stalled lookup times out and cancellation does not become a missing-address error', async () => {
  await assert.rejects(geocodeAddress(rural, { invokeGeocoder: () => new Promise(() => {}), timeoutMs: 10 }), /timed out/);
  const controller = new AbortController();
  const pending = geocodeAddress(rural, { signal: controller.signal, invokeGeocoder: () => new Promise(() => {}) });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(geocodeAddress(rural, { signal: controller.signal, invokeGeocoder: () => assert.fail('already cancelled') }), { name: 'AbortError' });
});

