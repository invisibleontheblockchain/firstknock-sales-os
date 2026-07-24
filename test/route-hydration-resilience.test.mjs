import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasCompleteRouteMapPoints,
  hydrateRouteWithLookup,
} from '../src/components/logic/routeHydrationCore.js';

const route = {
  id: 'route-1',
  property_hashes: ['legacy-a', 'hash-b'],
  metrics: { house_count: 2 },
};

const propertyA = {
  id: 'property-a',
  address_hash: 'hash-a',
  legacy_hash: 'legacy-a',
  lat: 33.1,
  lng: -112.1,
};

const propertyB = {
  id: 'property-b',
  address_hash: 'hash-b',
  lat: 33.2,
  lng: -112.2,
};

test('route hydration retries the signed-in workspace when the scoped lookup fails', async () => {
  const calls = [];
  const hydrated = await hydrateRouteWithLookup(route, async (request) => {
    calls.push(request);
    if (request.routeId) throw new Error('temporary route lookup failure');
    return [propertyB, propertyA];
  });

  assert.deepEqual(calls, [
    { hashes: ['legacy-a', 'hash-b'], routeId: 'route-1' },
    { hashes: ['legacy-a', 'hash-b'], routeId: null },
  ]);
  assert.deepEqual(hydrated.properties.map(property => property.id), ['property-a', 'property-b']);
  assert.equal(hasCompleteRouteMapPoints(hydrated), true);
});

test('partial route hydration requests only the missing hashes and preserves route order', async () => {
  const calls = [];
  const hydrated = await hydrateRouteWithLookup(
    { ...route, properties: [{ ...propertyA, effective_status: 'NO_ANSWER' }] },
    async (request) => {
      calls.push(request);
      return request.routeId ? [] : [propertyB];
    }
  );

  assert.deepEqual(calls, [
    { hashes: ['hash-b'], routeId: 'route-1' },
    { hashes: ['hash-b'], routeId: null },
  ]);
  assert.deepEqual(hydrated.properties.map(property => property.id), ['property-a', 'property-b']);
  assert.equal(hydrated.properties[0].effective_status, 'NO_ANSWER');
  assert.equal(hasCompleteRouteMapPoints(hydrated), true);
});

test('a complete scoped response does not make an unnecessary fallback request', async () => {
  const calls = [];
  const hydrated = await hydrateRouteWithLookup(route, async (request) => {
    calls.push(request);
    return [propertyA, propertyB];
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].routeId, 'route-1');
  assert.equal(hasCompleteRouteMapPoints(hydrated), true);
});

test('failed hydration preserves valid in-memory pins instead of replacing them with an empty route', async () => {
  const partialRoute = { ...route, properties: [propertyA] };
  const hydrated = await hydrateRouteWithLookup(partialRoute, async () => {
    throw new Error('lookup unavailable');
  });

  assert.deepEqual(hydrated.properties.map(property => property.id), ['property-a']);
  assert.equal(hydrated.houseCount, 2);
  assert.equal(hasCompleteRouteMapPoints(hydrated), false);
});
