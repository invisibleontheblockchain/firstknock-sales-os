import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRouteNavigationPlan,
  detectNavigationEnvironment,
  getNavigationSessionProgress,
  selectRemainingTodoStops,
} from '../src/components/logic/routeNavigation.js';

function stops(count, { addressOnly = false } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    address_hash: `hash-${index + 1}`,
    full_address: addressOnly ? `${index + 1} ${'Long Street Name '.repeat(4)}Phoenix, AZ 85001` : `${index + 1} Main St`,
    ...(addressOnly ? {} : { lat: 33.4 + index / 1000, lng: -112.1 - index / 1000 }),
  }));
}

function flattenedKeys(plan) {
  return plan.batches.flatMap(batch => batch.stops.map(stop => stop.navigationKey));
}

test('detects legacy Apple Maps only on iOS versions older than 18.4', () => {
  const oldIOS = detectNavigationEnvironment({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X)',
    platform: 'ios',
    isNative: true,
  });
  const modernIOS = detectNavigationEnvironment({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X)',
    platform: 'ios',
    isNative: true,
  });

  assert.equal(oldIOS.isLegacyAppleMaps, true);
  assert.equal(modernIOS.isLegacyAppleMaps, false);
});

test('selects every ordered Todo stop independently of visual filters', () => {
  const properties = stops(5);
  const remaining = selectRemainingTodoStops(properties, {
    'hash-1': 'SOLD',
    'hash-2': 'ELIGIBLE',
    'hash-3': 'NO_ANSWER',
    'hash-5': 'ELIGIBLE',
  });

  assert.deepEqual(remaining.map(property => property.address_hash), ['hash-2', 'hash-4', 'hash-5']);
});

test('Google mobile web batches four stops and preserves current-location origin and order', () => {
  const properties = stops(9);
  const environment = detectNavigationEnvironment({
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)',
    platform: 'web',
    isNative: false,
  });
  const plan = buildRouteNavigationPlan(properties, {
    provider: 'google',
    environment,
    travelMode: 'walking',
  });

  assert.deepEqual(plan.batches.map(batch => batch.stops.length), [4, 4, 1]);
  assert.deepEqual(flattenedKeys(plan), properties.map(property => property.address_hash));

  const firstUrl = new URL(plan.batches[0].url);
  assert.equal(firstUrl.searchParams.has('origin'), false);
  assert.equal(firstUrl.searchParams.get('dir_action'), 'navigate');
  assert.equal(firstUrl.searchParams.get('destination'), '33.403,-112.103');
  assert.equal(firstUrl.searchParams.get('waypoints'), '33.4,-112.1|33.401,-112.101|33.402,-112.102');
  assert.equal(firstUrl.searchParams.get('travelmode'), 'walking');
});

test('Google native and desktop batches ten stops without dropping any', () => {
  const properties = stops(23);
  const plan = buildRouteNavigationPlan(properties, {
    provider: 'google',
    environment: detectNavigationEnvironment({ platform: 'android', isNative: true }),
  });

  assert.deepEqual(plan.batches.map(batch => batch.stops.length), [10, 10, 3]);
  assert.deepEqual(flattenedKeys(plan), properties.map(property => property.address_hash));
  assert.ok(plan.batches.every(batch => batch.url.length <= 2048));
  assert.ok(plan.batches.every(batch => new URL(batch.url).searchParams.get('dir_action') === 'navigate'));
});

test('URL length creates smaller contiguous batches with no stop loss', () => {
  const properties = stops(7, { addressOnly: true });
  const plan = buildRouteNavigationPlan(properties, {
    provider: 'google',
    environment: detectNavigationEnvironment({ platform: 'android', isNative: true }),
    maxUrlLength: 330,
  });

  assert.ok(plan.batches.length > 1);
  assert.ok(plan.batches.every(batch => batch.url.length <= 330));
  assert.deepEqual(flattenedKeys(plan), properties.map(property => property.address_hash));
});

test('modern Apple unified URLs repeat waypoint parameters and omit source for current location', () => {
  const properties = stops(4);
  const plan = buildRouteNavigationPlan(properties, {
    provider: 'apple',
    environment: detectNavigationEnvironment({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X)',
      platform: 'ios',
      isNative: true,
    }),
    travelMode: 'driving',
    startDelaySeconds: 0,
  });

  assert.equal(plan.format, 'apple-unified');
  assert.equal(plan.batches.length, 1);
  const url = new URL(plan.batches[0].url);
  assert.equal(url.pathname, '/directions');
  assert.equal(url.searchParams.has('source'), false);
  assert.deepEqual(url.searchParams.getAll('waypoint'), [
    '33.4,-112.1',
    '33.401,-112.101',
    '33.402,-112.102',
  ]);
  assert.equal(url.searchParams.get('destination'), '33.403,-112.103');
  assert.equal(url.searchParams.get('mode'), 'driving');
  assert.equal(url.searchParams.get('start'), '0');
});

test('modern Apple routes batch at the supported app stop capacity without loss', () => {
  const properties = stops(31);
  const plan = buildRouteNavigationPlan(properties, {
    provider: 'apple',
    environment: detectNavigationEnvironment({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X)',
      platform: 'ios',
      isNative: true,
    }),
  });

  assert.deepEqual(plan.batches.map(batch => batch.stops.length), [15, 15, 1]);
  assert.deepEqual(flattenedKeys(plan), properties.map(property => property.address_hash));
  assert.ok(plan.batches.every(batch => batch.url.length <= 2048));
});

test('older iOS falls back to contiguous legacy single-stop Apple batches', () => {
  const properties = stops(3);
  const plan = buildRouteNavigationPlan(properties, {
    provider: 'apple',
    environment: detectNavigationEnvironment({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_7 like Mac OS X)',
      platform: 'ios',
      isNative: true,
    }),
    travelMode: 'walking',
  });

  assert.equal(plan.format, 'apple-legacy');
  assert.deepEqual(plan.batches.map(batch => batch.stops.length), [1, 1, 1]);
  assert.deepEqual(flattenedKeys(plan), properties.map(property => property.address_hash));
  plan.batches.forEach((batch) => {
    const url = new URL(batch.url);
    assert.equal(url.pathname, '/');
    assert.equal(url.searchParams.has('daddr'), true);
    assert.equal(url.searchParams.get('dirflg'), 'w');
  });
});

test('an unusable stop fails instead of being silently removed', () => {
  assert.throws(
    () => buildRouteNavigationPlan([{ address_hash: 'broken' }], { provider: 'google' }),
    /no usable coordinates or address/i,
  );
});

test('missing coordinates fall back to the address instead of Null Island', () => {
  const plan = buildRouteNavigationPlan([{
    address_hash: 'address-only',
    full_address: '107 Beechnut Dr, Phoenix, AZ 85001',
    lat: null,
    lng: '',
  }], { provider: 'google' });

  assert.equal(new URL(plan.batches[0].url).searchParams.get('destination'), '107 Beechnut Dr, Phoenix, AZ 85001');
});

test('a navigation session resumes unfinished stops before advancing a batch', () => {
  const properties = stops(6);
  const plan = buildRouteNavigationPlan(properties, {
    provider: 'google',
    environment: detectNavigationEnvironment({
      userAgent: 'Mozilla/5.0 (Linux; Android 15)',
      platform: 'web',
    }),
  });
  const session = { plan, batchIndex: 0 };

  const unfinished = getNavigationSessionProgress(session, properties.slice(1));
  assert.equal(unfinished.canResume, true);
  assert.equal(unfinished.canAdvance, false);
  assert.deepEqual(unfinished.remainingStops.map((stop) => stop.navigationKey), ['hash-2', 'hash-3', 'hash-4']);

  const completed = getNavigationSessionProgress(session, properties.slice(4));
  assert.equal(completed.canResume, false);
  assert.equal(completed.canAdvance, true);
  assert.deepEqual(completed.continuationStops.map((stop) => stop.address_hash), ['hash-5', 'hash-6']);
});

test('navigation continuation excludes completed and deleted future stops while preserving live route order', () => {
  const properties = stops(9);
  const plan = buildRouteNavigationPlan(properties, {
    provider: 'google',
    environment: detectNavigationEnvironment({
      userAgent: 'Mozilla/5.0 (Linux; Android 15)',
      platform: 'web',
    }),
  });
  const session = { plan, batchIndex: 0 };

  // The first batch is complete. Stop 6 was completed out of order, stop 7 was
  // deleted from the route, and a newly-added stop now follows stop 9.
  const liveRemaining = [properties[4], properties[7], properties[8], {
    address_hash: 'hash-10',
    full_address: '10 Main St',
    lat: 33.41,
    lng: -112.11,
  }];
  const progress = getNavigationSessionProgress(session, liveRemaining);

  assert.equal(progress.canResume, false);
  assert.equal(progress.canAdvance, true);
  assert.deepEqual(
    progress.continuationStops.map((stop) => stop.address_hash),
    ['hash-5', 'hash-8', 'hash-9', 'hash-10'],
  );

  const continuationPlan = buildRouteNavigationPlan(progress.continuationStops, {
    provider: 'google',
    environment: detectNavigationEnvironment({
      userAgent: 'Mozilla/5.0 (Linux; Android 15)',
      platform: 'web',
    }),
  });
  assert.deepEqual(flattenedKeys(continuationPlan), ['hash-5', 'hash-8', 'hash-9', 'hash-10']);
});

test('navigation continuation does not advance when every live Todo stop is complete', () => {
  const properties = stops(6);
  const plan = buildRouteNavigationPlan(properties, {
    provider: 'google',
    environment: detectNavigationEnvironment({
      userAgent: 'Mozilla/5.0 (Linux; Android 15)',
      platform: 'web',
    }),
  });
  const progress = getNavigationSessionProgress({ plan, batchIndex: 0 }, []);

  assert.equal(progress.canResume, false);
  assert.equal(progress.canAdvance, false);
  assert.deepEqual(progress.continuationStops, []);
});
