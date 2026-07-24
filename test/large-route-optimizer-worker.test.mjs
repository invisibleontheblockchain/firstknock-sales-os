import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after, before } from 'node:test';
import { createServer } from 'vite';

let vite;
let buildLargeRouteManifests;
let generateOptimizedRoutes;
let isStrictRoutePropertyPoint;
let largeRouteOptimizerInternals;
let materializeLargeRoutes;
let optimizeLargeRoutesAsync;
let verifyLargeRouteManifests;

before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  ({
    buildLargeRouteManifests,
    largeRouteOptimizerInternals,
    materializeLargeRoutes,
    optimizeLargeRoutesAsync,
    verifyLargeRouteManifests,
  } = await vite.ssrLoadModule('/src/components/logic/largeRouteOptimizer.js'));
  ({
    generateOptimizedRoutes,
    isStrictRoutePropertyPoint,
  } = await vite.ssrLoadModule('/src/components/logic/routeOptimizer.jsx'));
});

after(async () => {
  await vite?.close();
});

function property(index, overrides = {}) {
  return {
    id: `door-${index}`,
    address_hash: `hash-${index}`,
    street_name: `Grid Street ${index}`,
    house_number: (index % 9999) + 1,
    subdivision_name: `Neighborhood ${Math.floor(index / 100)}`,
    city: 'Scaleville',
    state: 'NC',
    zip_code: '28081',
    lat: 35 + Math.floor(index / 100) * 0.0001,
    lng: -80 + (index % 100) * 0.0001,
    effective_status: 'ELIGIBLE',
    ...overrides,
  };
}

async function withWorker(value, callback) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  if (value === undefined) delete globalThis.Worker;
  else Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value });
  try {
    return await callback();
  } finally {
    if (original) Object.defineProperty(globalThis, 'Worker', original);
    else delete globalThis.Worker;
  }
}

test('globally optimizes 10,001 unique-street homes into exact index-only manifests', () => {
  const properties = Array.from({ length: 10_001 }, (_, index) => property(index));
  const startedAt = Date.now();
  const result = buildLargeRouteManifests({
    properties,
    housesPerRoute: 50_000,
    optimizerOptions: { excludeTerminal: true },
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.routeManifests.length, 2);
  assert.ok(result.routeManifests.every((route) => route.propertyIndexes.length <= 10_000));
  assert.ok(result.routeManifests.every((route) => !Object.hasOwn(route, 'properties')));
  assert.equal(
    result.routeManifests.flatMap((route) => route.propertyIndexes).length,
    properties.length,
  );
  assert.equal(
    new Set(result.routeManifests.flatMap((route) => route.propertyIndexes)).size,
    properties.length,
  );
  assert.equal(result.routingMetadata.exact_once_verified, true);
  assert.ok(elapsedMs < 20_000, `large unique-street optimization took ${elapsedMs}ms`);

  const routes = materializeLargeRoutes(properties, result);
  assert.equal(routes.flatMap((route) => route.properties).length, properties.length);
  assert.ok(routes.every((route) => route.houseCount <= 10_000));
  routes.forEach((route) => {
    assert.equal(
      route.metadata.routing.property_order_fingerprint,
      route.metadata.routing.property_order_fingerprint.trim(),
    );
    assert.ok(route.metadata.routing.property_order_fingerprint.length > 0);
  });
});

test('excludeTerminal false preserves terminal records while retaining exact membership', () => {
  const properties = [
    property(1, {
      id: 'hard-no',
      address_hash: 'hard-no',
      street_name: 'Same Street',
      house_number: 12,
      effective_status: 'HARD_NO',
    }),
    property(2, {
      id: 'dnc',
      address_hash: 'dnc',
      street_name: 'Same Street',
      house_number: 14,
      effective_status: 'DO_NOT_KNOCK',
    }),
  ];
  const result = buildLargeRouteManifests({
    properties,
    housesPerRoute: 10_000,
    optimizerOptions: { excludeTerminal: false },
  });
  const routes = materializeLargeRoutes(properties, result);
  assert.equal(routes.flatMap((route) => route.properties).length, 2);
  assert.equal(routes[0].properties[0] === properties[0] || routes[0].properties[1] === properties[0], true);
  assert.equal(routes[0].properties[0] === properties[1] || routes[0].properties[1] === properties[1], true);
});

test('large worker applies terminal and street-cooldown eligibility before exact verification', () => {
  const properties = Array.from({ length: 6_010 }, (_, index) => property(index, {
    street_name: `Eligible Street ${index % 100}`,
    house_number: index + 1,
    subdivision_name: `Eligible Neighborhood ${Math.floor((index % 100) / 10)}`,
  }));
  properties[6_000] = property(6_000, {
    street_name: 'Terminal Street',
    effective_status: 'HARD_NO',
  });
  properties[6_001] = property(6_001, {
    street_name: 'Terminal Street',
    effective_status: 'DO_NOT_KNOCK',
  });
  properties[6_002] = property(6_002, {
    street_name: 'Terminal Street',
    effective_status: 'COOLDOWN',
  });
  for (let index = 6_003; index < properties.length; index += 1) {
    properties[index] = property(index, {
      street_name: 'Logged Cooldown Street',
      house_number: index + 1,
    });
  }
  const allLogs = [{
    address_hash: properties[6_003].address_hash,
    parsed_status: 'NO_ANSWER',
    created_date: new Date().toISOString(),
  }];

  const result = buildLargeRouteManifests({
    properties,
    housesPerRoute: 10_000,
    allLogs,
    optimizerOptions: { excludeTerminal: true, streetCooldownDays: 30 },
  });
  const routes = materializeLargeRoutes(properties, result);
  const routedIds = new Set(routes.flatMap((route) => route.properties).map(({ id }) => id));

  assert.equal(result.routingMetadata.input_property_count, 6_010);
  assert.equal(result.routingMetadata.output_property_count, 6_000);
  assert.equal(result.eligiblePropertyIndexes.length, 6_000);
  assert.equal(routedIds.size, 6_000);
  for (let index = 6_000; index < 6_010; index += 1) {
    assert.equal(routedIds.has(`door-${index}`), false);
  }
  assert.deepEqual(result.cooldownInfo.streetsOnCooldown, ['Logged Cooldown Street']);
  assert.equal(result.cooldownInfo.propertiesExcluded, 7);
});

test('property-level street cooldown is route-size independent without interaction logs', () => {
  const futureCooldown = property(1, {
    street_name: 'Future Cooldown Street',
    street_next_eligible_date: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const smallRoutes = generateOptimizedRoutes(
    [futureCooldown],
    10,
    null,
    [],
    { excludeTerminal: true, streetCooldownDays: 30 },
  );
  const largeResult = buildLargeRouteManifests({
    properties: [futureCooldown],
    housesPerRoute: 10,
    allLogs: [],
    optimizerOptions: { excludeTerminal: true, streetCooldownDays: 30 },
  });

  assert.equal(smallRoutes.length, 0);
  assert.equal(largeResult.eligiblePropertyIndexes.length, 0);
  assert.equal(materializeLargeRoutes([futureCooldown], largeResult).length, 0);
});

test('strict shared coordinates allow equator and prime-meridian homes and reject invalid bounds', () => {
  const equator = property(1, { lat: 0, lng: 10 });
  const primeMeridian = property(2, { lat: 10, lng: 0 });
  const latitudeOutOfRange = property(3, { lat: 91, lng: 10 });
  const longitudeOutOfRange = property(4, { lat: 10, lng: -181 });
  const nullIsland = property(5, { lat: 0, lng: 0 });

  assert.equal(isStrictRoutePropertyPoint(equator), true);
  assert.equal(isStrictRoutePropertyPoint(primeMeridian), true);
  assert.equal(isStrictRoutePropertyPoint(latitudeOutOfRange), false);
  assert.equal(isStrictRoutePropertyPoint(longitudeOutOfRange), false);
  assert.equal(isStrictRoutePropertyPoint(nullIsland), false);
  assert.throws(
    () => generateOptimizedRoutes(
      [equator, latitudeOutOfRange],
      10,
      null,
      [],
      { preserveInputMembership: true, excludeTerminal: false },
    ),
    /invalid coordinates/i,
  );

  const properties = [
    equator,
    primeMeridian,
    latitudeOutOfRange,
    longitudeOutOfRange,
    nullIsland,
  ];
  const result = buildLargeRouteManifests({
    properties,
    housesPerRoute: 10,
    optimizerOptions: { excludeTerminal: false },
  });
  assert.deepEqual(result.eligiblePropertyIndexes, [0, 1]);
  assert.deepEqual(
    materializeLargeRoutes(properties, result)
      .flatMap((route) => route.properties)
      .map(({ id }) => id)
      .sort(),
    [equator.id, primeMeridian.id].sort(),
  );
});

test('fails closed on a duplicate, missing, oversized, or out-of-range worker manifest', () => {
  assert.throws(
    () => verifyLargeRouteManifests([{ propertyIndexes: [0, 0] }], 2),
    /failed exact membership/i,
  );
  assert.throws(
    () => verifyLargeRouteManifests([{ propertyIndexes: [0] }], 2),
    /failed exact membership/i,
  );
  assert.throws(
    () => verifyLargeRouteManifests([{ propertyIndexes: [0, 2] }], 2),
    /out-of-range/i,
  );
  assert.throws(
    () => verifyLargeRouteManifests(
      [{ propertyIndexes: Array.from({ length: 10_001 }, (_, index) => index) }],
      10_001,
    ),
    /1-10,000 home limit/i,
  );
});

test('uses the deterministic synchronous path only when Worker is unavailable', async () => {
  const properties = Array.from({ length: 43 }, (_, index) => property(index));
  await withWorker(undefined, async () => {
    const result = await optimizeLargeRoutesAsync({ properties, housesPerRoute: 25 });
    assert.equal(result.executionMode, 'synchronous-worker-unavailable');
    assert.equal(result.routes.flatMap((route) => route.properties).length, properties.length);
    assert.ok(result.routes.every((route) => route.houseCount <= 25));
  });
});

test('uses a bounded module worker and rejects runtime failure without UI-thread retry', async () => {
  const instances = [];
  class SuccessfulWorker {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.terminated = 0;
      instances.push(this);
    }

    postMessage(message) {
      this.request = message;
      const result = buildLargeRouteManifests(message.input);
      queueMicrotask(() => this.onmessage?.({
        data: { requestId: message.requestId, ok: true, result },
      }));
    }

    terminate() {
      this.terminated += 1;
    }
  }

  const properties = Array.from({ length: 51 }, (_, index) => property(index));
  await withWorker(SuccessfulWorker, async () => {
    const result = await optimizeLargeRoutesAsync({ properties, housesPerRoute: 25 });
    const [worker] = instances;
    assert.equal(result.executionMode, 'module-worker');
    assert.equal(result.routes.flatMap((route) => route.properties).length, 51);
    assert.equal(worker.options.type, 'module');
    assert.equal(worker.options.name, 'firstknock-large-route-optimizer');
    assert.match(worker.url.href, /largeRouteOptimizer\.worker\.js$/);
    assert.equal(worker.terminated, 1);
  });

  let runtimeInstance;
  class FailedWorker {
    constructor() {
      this.terminated = 0;
      runtimeInstance = this;
    }

    postMessage() {
      queueMicrotask(() => this.onerror?.({
        message: 'worker module load failed',
        preventDefault() {},
      }));
    }

    terminate() {
      this.terminated += 1;
    }
  }
  await withWorker(FailedWorker, async () => {
    await assert.rejects(
      optimizeLargeRoutesAsync({ properties, housesPerRoute: 25 }),
      (error) => error?.code === 'LARGE_ROUTE_WORKER_FAILED',
    );
    assert.equal(runtimeInstance.terminated, 1);
  });
});

test('falls back synchronously when worker construction is blocked', async () => {
  class BlockedWorker {
    constructor() {
      throw new Error('worker construction blocked');
    }
  }
  const properties = Array.from({ length: 21 }, (_, index) => property(index));
  await withWorker(BlockedWorker, async () => {
    const result = await optimizeLargeRoutesAsync({ properties, housesPerRoute: 10 });
    assert.equal(result.executionMode, 'synchronous-worker-unavailable');
    assert.equal(result.routes.flatMap((route) => route.properties).length, properties.length);
  });
});

test('Home routes both large generation paths locally and bounds save concurrency', async () => {
  const home = await readFile(new URL('../src/pages/Home.jsx', import.meta.url), 'utf8');
  const adapter = await readFile(
    new URL('../src/components/logic/largeRouteOptimizer.js', import.meta.url),
    'utf8',
  );
  assert.match(home, /import \{ optimizeLargeRoutesAsync \} from '\.\.\/components\/logic\/largeRouteOptimizer'/);
  assert.equal((home.match(/await optimizeLargeRoutesAsync\(/g) || []).length, 2);
  assert.doesNotMatch(home, /generateRoutesBackend/);
  assert.equal((home.match(/mapWithConcurrency\(\s*(?:saveable|generated),\s*4,/g) || []).length, 2);
  assert.match(home, /savedProperties\.some\(\(property\) => !isStrictRoutePropertyPoint\(property\)\)/);
  assert.match(
    home,
    /if \(data\.capped === true\)[\s\S]*Generation stopped before optimization so no homes could be silently omitted/,
    'a capped candidate response must fail closed instead of optimizing a truncated working set',
  );
  assert.match(
    adapter,
    /new Worker\(\s*new URL\('\.\/largeRouteOptimizer\.worker\.js', import\.meta\.url\),\s*\{ type: 'module'/,
  );

  const { DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, normalizedTimeoutMs } =
    largeRouteOptimizerInternals;
  assert.ok(DEFAULT_TIMEOUT_MS > 0);
  assert.equal(normalizedTimeoutMs(1), MIN_TIMEOUT_MS);
  assert.equal(normalizedTimeoutMs(Number.MAX_SAFE_INTEGER), MAX_TIMEOUT_MS);
});
