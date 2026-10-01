import test from 'node:test';
import assert from 'node:assert/strict';

import { geocodeAddressItems } from '../base44/shared/addressGeocoder.js';
import { buildGeocodioPayload, geocodeWithGeocodio, normalizeGeocodioKey, parseGeocodioResponse } from '../base44/shared/geocodioGeocode.js';

const entry = (lat, lng, accuracy_type, accuracy = 1, state = 'FL') => ({
  response: { results: [{ location: { lat, lng }, accuracy, accuracy_type, formatted_address: 'x', address_components: { state_province: state } }] }
});

const items = [
  { id: 'a', address: '8306 Riverbend Rise Ln', city: 'Tampa', state: 'FL', zip: '33617' },
  { id: 'b', address: 'nonsense zzz', city: 'Tampa', state: 'FL', zip: '33605' },
  { id: 'c', address: '99999 Fake St', city: 'Tampa', state: 'FL', zip: '33605' },
  { id: 'd', address: '1 Main St', city: 'Tampa', state: 'FL', zip: '33605' },
  { id: 'e', address: '5 Oak Ave', city: 'Tampa', state: 'FL', zip: '33605' }
];

test('builds a keyed payload of one-line addresses', () => {
  assert.deepEqual(buildGeocodioPayload(items.slice(0, 1)), { a: '8306 Riverbend Rise Ln, Tampa, FL, 33617' });
});

test('keeps house-level matches and rejects the confident-looking junk Geocodio returns', () => {
  const body = { results: {
    a: entry(28.02, -82.4, 'rooftop'),
    b: entry(34.76, -94.62, 'place', 1, 'AR'),          // "nonsense zzz" -> a town in Arkansas
    c: entry(27.94, -82.47, 'street_center', 0.62),     // fake house number -> street centre
    d: entry(27.95, -82.47, 'range_interpolation', 0.9),
    e: entry(40.7, -74.0, 'rooftop', 1, 'NY')           // right accuracy, wrong state
  } };
  const parsed = parseGeocodioResponse(body, items);
  assert.deepEqual(Object.keys(parsed).sort(), ['a', 'd']);
  assert.equal(parsed.a.matchType, 'rooftop');
  assert.equal(parsed.d.accuracy, 0.9);
});

test('ignores empty, malformed and out-of-range entries', () => {
  assert.deepEqual(parseGeocodioResponse({}, items), {});
  assert.deepEqual(parseGeocodioResponse({ results: { a: { response: { results: [] } }, d: entry(999, 0, 'rooftop') } }, items), {});
});

test('geocodeWithGeocodio sends the key as a bearer token and requires one', async () => {
  let call;
  const out = await geocodeWithGeocodio(items.slice(0, 1), {
    apiKey: 'secret',
    fetchImpl: async (url, init) => { call = { url, init }; return { ok: true, json: async () => ({ results: { a: entry(28, -82, 'rooftop') } }) }; }
  });
  assert.equal(out.a.lat, 28);
  assert.equal(call.init.headers.Authorization, 'Bearer secret');
  assert.match(call.url, /api\.geocod\.io\/v2\/geocode/);
  assert.deepEqual(JSON.parse(call.init.body), { a: '8306 Riverbend Rise Ln, Tampa, FL, 33617' });

  await assert.rejects(geocodeWithGeocodio(items, { apiKey: '' }), /not configured/);
  await assert.rejects(geocodeWithGeocodio(items, { apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 401 }) }), /401/);
});

// One fetch stub that plays both services.
const fakeServices = ({ censusDown = false, geocodioDown = false } = {}) => async (url) => {
  if (String(url).includes('census.gov')) {
    if (censusDown) return { ok: false, status: 503 };
    return { ok: true, text: async () => '"d","x","Match","Exact","1 MAIN","-82.1,27.1","1","L"' };
  }
  if (geocodioDown) return { ok: false, status: 500 };
  return { ok: true, json: async () => ({ results: { a: entry(28.02, -82.4, 'rooftop') } }) };
};

test('waterfall: Census first, Geocodio only for the misses, each result tagged', async () => {
  const { results, counts, warnings } = await geocodeAddressItems(items.slice(0, 2).concat(items[3]), {
    geocodioApiKey: 'k', fetchImpl: fakeServices()
  });
  assert.equal(results.d.source, 'census');
  assert.equal(results.a.source, 'geocodio');
  assert.equal(results.b, undefined);
  assert.deepEqual(counts, { census: 1, geocodio: 1 });
  assert.deepEqual(warnings, []);
});

test('waterfall: without a key Census still works and the gap is reported', async () => {
  const { results, warnings } = await geocodeAddressItems([items[0], items[3]], { fetchImpl: fakeServices() });
  assert.deepEqual(Object.keys(results), ['d']);
  assert.match(warnings.join(), /GEOCODIO_API_KEY/);
});

test('waterfall: Census outage is absorbed by Geocodio', async () => {
  const { results, warnings } = await geocodeAddressItems([items[0]], { geocodioApiKey: 'k', fetchImpl: fakeServices({ censusDown: true }) });
  assert.equal(results.a.source, 'geocodio');
  assert.match(warnings[0], /census/);
});

test('waterfall: throws only when every source failed and nothing resolved', async () => {
  await assert.rejects(
    geocodeAddressItems([items[0]], { geocodioApiKey: 'k', fetchImpl: fakeServices({ censusDown: true, geocodioDown: true }) }),
    /census.*geocodio/
  );
  // Geocodio failing after Census resolved something is not an error.
  const ok = await geocodeAddressItems([items[0], items[3]], { geocodioApiKey: 'k', fetchImpl: fakeServices({ geocodioDown: true }) });
  assert.deepEqual(Object.keys(ok.results), ['d']);
});

test('tolerates a secret pasted with quotes, whitespace, or a label prefix', () => {
  const variants = ['abc123', '  abc123\n', '"abc123"', "'abc123'", 'Bearer abc123', 'Milecraft abc123', 'Milecraft\nabc123\n'];
  for (const raw of variants) {
    assert.equal(normalizeGeocodioKey(raw), 'abc123', JSON.stringify(raw));
  }
  assert.equal(normalizeGeocodioKey(''), '');
  assert.equal(normalizeGeocodioKey(undefined), '');
});

test('sends the normalized key, and a rejected key reports the reason and key length', async () => {
  let auth;
  await assert.rejects(
    geocodeWithGeocodio(items.slice(0, 1), {
      apiKey: ' "secretkey" ',
      fetchImpl: async (url, init) => { auth = init.headers.Authorization; return { ok: false, status: 403, json: async () => ({ error: 'Invalid API key' }) }; }
    }),
    /403: Invalid API key \(key length 9\)/
  );
  assert.equal(auth, 'Bearer secretkey');
});
