import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  hasCompleteRouteMapPoints,
  hasRecoveryLimitedRouteProperties,
  hydrateRouteWithLookup,
  isRouteHydrationCacheable,
  lookupRoutePropertiesInBatches,
  ROUTE_HYDRATION_BATCH_LIMIT,
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

test('pin-only scoped recovery retries the workspace and keeps the richer property', async () => {
  const calls = [];
  const limitedProperty = {
    ...propertyA,
    recovery_limited: true,
  };
  const richProperty = {
    ...propertyA,
    sold_date: '2025-10-01T00:00:00.000Z',
    price: 750000,
  };
  const onePropertyRoute = {
    id: 'route-limited',
    property_hashes: ['legacy-a'],
  };

  const hydrated = await hydrateRouteWithLookup(onePropertyRoute, async (request) => {
    calls.push(request);
    return request.routeId ? [limitedProperty] : [richProperty];
  });

  assert.deepEqual(calls, [
    { hashes: ['legacy-a'], routeId: 'route-limited' },
    { hashes: ['legacy-a'], routeId: null },
  ]);
  assert.equal(hydrated.properties[0].recovery_limited, undefined);
  assert.equal(hydrated.properties[0].price, 750000);
  assert.equal(hydrated.properties[0].sold_date, '2025-10-01T00:00:00.000Z');
  assert.equal(isRouteHydrationCacheable(hydrated), true);
});

test('pin-only recovery remains visible but is not cacheable when the workspace has no richer row', async () => {
  const limitedProperty = {
    ...propertyA,
    recovery_limited: true,
  };
  const onePropertyRoute = {
    id: 'route-still-limited',
    property_hashes: ['legacy-a'],
  };

  const hydrated = await hydrateRouteWithLookup(onePropertyRoute, async () => [limitedProperty]);

  assert.equal(hasCompleteRouteMapPoints(hydrated), true);
  assert.equal(hasRecoveryLimitedRouteProperties(hydrated), true);
  assert.equal(isRouteHydrationCacheable(hydrated), false);
});

test('map and Knock caches use the recovery-aware cacheability guard', () => {
  const wrapperSource = fs.readFileSync('src/components/logic/routeHydration.jsx', 'utf8');
  const repHomeSource = fs.readFileSync('src/pages/RepHome.jsx', 'utf8');

  assert.match(wrapperSource, /if \(isRouteHydrationCacheable\(hydratedRoute\)\)/);
  assert.match(wrapperSource, /hydrated\.every\(isRouteHydrationCacheable\)/);
  assert.match(repHomeSource, /cached\.some\(isRecoveryLimitedProperty\)/);
  assert.match(repHomeSource, /localforage\.removeItem\(`cached_props_\$\{activeRoute\.id\}`\)/);
  assert.match(repHomeSource, /if \(isRouteHydrationCacheable\(bestRoute\)\)/);
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

test('a 10,000-property saved route hydrates in authorized backend-sized batches', async () => {
  const hashes = Array.from({ length: 10_000 }, (_, index) => `hash-${index}`);
  const byHash = new Map(hashes.map((hash, index) => [hash, {
    id: `property-${index}`,
    address_hash: hash,
    lat: 33 + (index / 100_000),
    lng: -112 - (index / 100_000),
  }]));
  const calls = [];
  const largeRoute = {
    id: 'route-10000',
    property_hashes: hashes,
  };

  const hydrated = await hydrateRouteWithLookup(largeRoute, request => (
    lookupRoutePropertiesInBatches({
      ...request,
      lookupBatch: async (batch) => {
        calls.push(batch);
        // Deliberately scramble each response; hydration must restore manifest order.
        return batch.hashes.map(hash => byHash.get(hash)).reverse();
      },
    })
  ));

  assert.equal(ROUTE_HYDRATION_BATCH_LIMIT, 5000);
  assert.deepEqual(calls.map(call => call.hashes.length), [5000, 5000]);
  assert.ok(calls.every(call => call.routeId === largeRoute.id));
  assert.equal(hydrated.properties.length, 10_000);
  assert.equal(hydrated.properties[0].address_hash, 'hash-0');
  assert.equal(hydrated.properties.at(-1).address_hash, 'hash-9999');
  assert.equal(hasCompleteRouteMapPoints(hydrated), true);
});

test('a partial batch fails closed instead of returning a partially hydrated route lookup', async () => {
  const hashes = Array.from({ length: 5001 }, (_, index) => `hash-${index}`);
  let batchNumber = 0;

  await assert.rejects(
    lookupRoutePropertiesInBatches({
      hashes,
      routeId: 'route-partial',
      lookupBatch: async ({ hashes: batchHashes }) => {
        batchNumber += 1;
        const returnedHashes = batchNumber === 2 ? batchHashes.slice(0, -1) : batchHashes;
        return returnedHashes.map((hash, index) => ({
          id: `${batchNumber}-${index}`,
          address_hash: hash,
          lat: 33.1,
          lng: -112.1,
        }));
      },
    }),
    error => error?.code === 'ROUTE_HYDRATION_PARTIAL_RESPONSE'
      && error?.missingCount === 1
      && error?.batchOffset === 5000
  );
  assert.equal(batchNumber, 2);
});

test('batched hydration de-duplicates lookup hashes while preserving first-requested property order', async () => {
  const calls = [];
  const properties = await lookupRoutePropertiesInBatches({
    hashes: ['hash-b', 'hash-a', 'hash-b', 'legacy-a'],
    routeId: 'route-deduplicated',
    batchSize: 2,
    lookupBatch: async (batch) => {
      calls.push(batch);
      if (batch.hashes.includes('hash-b')) {
        return [{
          id: 'property-b',
          address_hash: 'hash-b',
          lat: 33.2,
          lng: -112.2,
        }, {
          id: 'property-a',
          address_hash: 'hash-a',
          legacy_hash: 'legacy-a',
          lat: 33.1,
          lng: -112.1,
        }];
      }
      return [{
        id: 'property-a',
        address_hash: 'hash-a',
        legacy_hash: 'legacy-a',
        lat: 33.1,
        lng: -112.1,
      }];
    },
  });

  assert.deepEqual(calls.map(call => call.hashes), [
    ['hash-b', 'hash-a'],
    ['legacy-a'],
  ]);
  assert.ok(calls.every(call => call.routeId === 'route-deduplicated'));
  assert.deepEqual(properties.map(property => property.id), ['property-b', 'property-a']);
});

test('a failed route-scoped batch is discarded before the workspace fallback hydrates the route', async () => {
  const hashes = Array.from({ length: 6 }, (_, index) => `hash-${index}`);
  const calls = [];
  const failedRoute = {
    id: 'route-batch-failure',
    property_hashes: hashes,
  };

  const hydrated = await hydrateRouteWithLookup(failedRoute, request => (
    lookupRoutePropertiesInBatches({
      ...request,
      batchSize: 3,
      lookupBatch: async (batch) => {
        calls.push({
          routeId: batch.routeId,
          hashes: [...batch.hashes],
        });
        if (batch.routeId && batch.hashes.includes('hash-3')) {
          throw new Error('second authorized batch unavailable');
        }
        return batch.hashes.map((hash, index) => ({
          id: `${hash}-${index}`,
          address_hash: hash,
          lat: 33.2,
          lng: -112.2,
        }));
      },
    })
  ));

  assert.deepEqual(calls.map(call => call.routeId), [
    failedRoute.id,
    failedRoute.id,
    null,
    null,
  ]);
  assert.deepEqual(
    hydrated.properties.map(property => property.address_hash),
    hashes
  );
  assert.equal(hasCompleteRouteMapPoints(hydrated), true);
});
