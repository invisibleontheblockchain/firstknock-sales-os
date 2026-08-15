import {
  generateOptimizedRoutes,
  isStrictRoutePropertyPoint,
} from './routeOptimizer.jsx';
import {
  createRouteContinuityContext,
  routePropertyOrderFingerprint,
} from './routeRoadContext.js';
import {
  createOsrmContextPayload,
  hydrateOsrmRoadContext,
} from './osrmRoadContext.js';

export const MAX_SAVED_ROUTE_PROPERTIES = 10_000;
const WORKER_INDEX_KEY = '__firstknock_large_route_input_index';
const DEFAULT_TIMEOUT_MS = 180_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;

function routeIntegrityError(message, code = 'LARGE_ROUTE_INTEGRITY_FAILED') {
  const error = new Error(message);
  error.name = 'LargeRouteIntegrityError';
  error.code = code;
  return error;
}

function normalizedRouteSize(value) {
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric) || numeric <= 0) return MAX_SAVED_ROUTE_PROPERTIES;
  return Math.min(numeric, MAX_SAVED_ROUTE_PROPERTIES);
}

function normalizedTimeoutMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.round(numeric)));
}

function routingMetadata(inputPropertyCount, outputPropertyCount, routeCount, roadContext = null) {
  const roadAware = roadContext?.roadAware === true;
  return {
    strategy: roadAware
      ? 'osrm_road_matrix_over_street_blocks'
      : 'canonical_street_subdivision_continuity',
    execution: 'browser_module_worker',
    fallback: !roadAware,
    fallback_reason: roadAware ? null : 'large_route_uses_local_continuity_worker',
    road_network_used: roadAware,
    routing_engine: roadContext?.source || 'aerial-fallback',
    // The share of distance queries answered from a real road matrix. A route
    // saved with a low share is one to be suspicious of.
    road_exact_lookup_share: roadAware
      ? roadContext?.diagnostics?.exactLookupShare ?? null
      : null,
    street_key: 'canonical_street_with_suffix',
    access_key: roadAware ? 'osrm_tile' : 'subdivision_name_when_available',
    input_property_count: inputPropertyCount,
    output_property_count: outputPropertyCount,
    route_count: routeCount,
    exact_once_verified: true,
  };
}

export function verifyLargeRouteManifests(
  routeManifests,
  expectedMembership,
  inputPropertyCount = null,
) {
  const expectedIndexes = Array.isArray(expectedMembership)
    ? expectedMembership
    : Array.from({ length: Number(expectedMembership) || 0 }, (_, index) => index);
  const sourcePropertyCount = Number.isInteger(inputPropertyCount)
    ? inputPropertyCount
    : expectedIndexes.length;
  if (!Array.isArray(routeManifests)) {
    throw routeIntegrityError('Large-route optimizer returned an invalid route manifest.');
  }
  if (expectedIndexes.length > 0 && routeManifests.length === 0) {
    throw routeIntegrityError('Large-route optimizer returned no routes.');
  }

  const indexes = [];
  routeManifests.forEach((manifest) => {
    if (!manifest || !Array.isArray(manifest.propertyIndexes)) {
      throw routeIntegrityError('Large-route optimizer returned a route without property indexes.');
    }
    if (
      manifest.propertyIndexes.length === 0
      || manifest.propertyIndexes.length > MAX_SAVED_ROUTE_PROPERTIES
    ) {
      throw routeIntegrityError(
        `Large-route optimizer returned a route outside the 1-${MAX_SAVED_ROUTE_PROPERTIES.toLocaleString()} home limit.`
      );
    }
    manifest.propertyIndexes.forEach((index) => {
      if (!Number.isInteger(index) || index < 0 || index >= sourcePropertyCount) {
        throw routeIntegrityError('Large-route optimizer returned an out-of-range property index.');
      }
      indexes.push(index);
    });
  });

  const uniqueIndexes = new Set(indexes);
  const expectedIndexSet = new Set(expectedIndexes);
  if (
    expectedIndexSet.size !== expectedIndexes.length
    || expectedIndexes.some((index) => (
      !Number.isInteger(index) || index < 0 || index >= sourcePropertyCount
    ))
  ) {
    throw routeIntegrityError('Large-route optimizer declared an invalid eligible membership.');
  }
  if (
    indexes.length !== expectedIndexes.length
    || uniqueIndexes.size !== expectedIndexes.length
    || indexes.some((index) => !expectedIndexSet.has(index))
  ) {
    throw routeIntegrityError(
      `Large-route optimizer failed exact membership: expected ${expectedIndexes.length} homes and received ${indexes.length}.`
    );
  }
  expectedIndexes.forEach((index) => {
    if (!uniqueIndexes.has(index)) {
      throw routeIntegrityError(`Large-route optimizer omitted property index ${index}.`);
    }
  });
  return true;
}

function selectEligibleProperties(properties, allLogs, options) {
  let eligible = properties.filter(isStrictRoutePropertyPoint);

  const addresses = new Map();
  eligible.forEach((property) => {
    const key = [
      property.house_number || 0,
      String(property.street_name || '').toUpperCase().trim(),
      String(property.zip_code || '').trim().slice(0, 5),
    ].join('|');
    const existing = addresses.get(key);
    if (!existing) {
      addresses.set(key, property);
      return;
    }
    const existingDate = existing.sold_date ? new Date(existing.sold_date).getTime() : 0;
    const propertyDate = property.sold_date ? new Date(property.sold_date).getTime() : 0;
    if (propertyDate > existingDate) addresses.set(key, property);
  });
  eligible = [...addresses.values()];

  const cooldownDays = Number(options?.streetCooldownDays);
  const effectiveCooldownDays = Number.isFinite(cooldownDays) && cooldownDays >= 0
    ? cooldownDays
    : 30;
  const now = Date.now();
  const streetByAddressHash = new Map();
  const cooldownStreets = new Set();
  eligible.forEach((property) => {
    const hash = property.address_hash;
    if (hash && !streetByAddressHash.has(hash)) {
      streetByAddressHash.set(hash, property.street_name);
    }
    if (
      property.street_name
      && property.street_next_eligible_date
      && new Date(property.street_next_eligible_date).getTime() > now
    ) {
      cooldownStreets.add(property.street_name);
    }
  });
  (Array.isArray(allLogs) ? allLogs : []).forEach((log) => {
    if (log?.parsed_status !== 'NO_ANSWER') return;
    const street = streetByAddressHash.get(log.address_hash);
    const createdAt = new Date(log.created_date).getTime();
    if (
      street
      && Number.isFinite(createdAt)
      && (now - createdAt) / 86_400_000 < effectiveCooldownDays
    ) {
      cooldownStreets.add(street);
    }
  });
  const propertiesExcludedByCooldown = eligible.filter(
    (property) => cooldownStreets.has(property.street_name)
  ).length;
  if (cooldownStreets.size > 0) {
    eligible = eligible.filter((property) => !cooldownStreets.has(property.street_name));
  }

  if (options?.excludeTerminal !== false) {
    const terminalStatuses = new Set(['HARD_NO', 'DO_NOT_KNOCK', 'COOLDOWN']);
    eligible = eligible.filter((property) => !terminalStatuses.has(property.effective_status));
  }

  return {
    eligible,
    cooldownInfo: cooldownStreets.size > 0
      ? {
          streetsOnCooldown: [...cooldownStreets],
          propertiesExcluded: propertiesExcludedByCooldown,
        }
      : null,
  };
}

/**
 * Runs wholly inside the module worker (or the explicit no-Worker fallback).
 * Only index manifests leave this boundary; callers rematerialize their
 * original property objects after a second exact-membership verification.
 */
export function buildLargeRouteManifests(input = {}) {
  const properties = Array.isArray(input.properties) ? input.properties : [];
  if (properties.length === 0) {
    return {
      routeManifests: [],
      eligiblePropertyIndexes: [],
      routingMetadata: routingMetadata(0, 0, 0),
      cooldownInfo: null,
    };
  }

  const indexedSource = properties.map((property, index) => ({
    ...property,
    [WORKER_INDEX_KEY]: index,
  }));
  const { eligible, cooldownInfo } = selectEligibleProperties(
    indexedSource,
    input.allLogs,
    input.optimizerOptions,
  );
  const eligiblePropertyIndexes = eligible.map((property) => property[WORKER_INDEX_KEY]);
  const indexedProperties = eligible.map((property) => ({
    ...property,
    // The ordinary optimizer's identity invariant must distinguish duplicate
    // hashes. Original hashes are restored before anything can save.
    address_hash: `__firstknock_large_route_${property[WORKER_INDEX_KEY]}`,
  }));
  // Road distances when the caller prefetched them (see optimizeLargeRoutesAsync),
  // street/subdivision continuity otherwise. The worker cannot fetch: it is
  // synchronous by construction and has no network budget inside the optimizer.
  const continuityContext = hydrateOsrmRoadContext(input.osrmContextPayload)
    || createRouteContinuityContext(indexedProperties);
  const routes = generateOptimizedRoutes(
    indexedProperties,
    normalizedRouteSize(input.housesPerRoute),
    input.startLocation || null,
    [],
    {
      ...(input.optimizerOptions || {}),
      excludeTerminal: false,
      preserveInputMembership: true,
      preserveGlobalChunkOrder: true,
      use2Opt: false,
      routingContext: continuityContext,
    },
    input.learnedWeights || null,
  );

  const routeManifests = routes.map((route) => {
    const propertyIndexes = route.properties.map((property) => property[WORKER_INDEX_KEY]);
    const orderedOriginals = propertyIndexes.map((index) => properties[index]);
    const { properties: ignoredProperties, ...routeFields } = route;
    void ignoredProperties;
    return {
      ...routeFields,
      houseCount: propertyIndexes.length,
      metadata: {
        ...(route.metadata || {}),
        routing: {
          ...routingMetadata(properties.length, eligible.length, routes.length, continuityContext),
          route_property_count: propertyIndexes.length,
          property_order_fingerprint: routePropertyOrderFingerprint(orderedOriginals),
        },
      },
      propertyIndexes,
    };
  });

  verifyLargeRouteManifests(
    routeManifests,
    eligiblePropertyIndexes,
    properties.length,
  );
  return {
    routeManifests,
    eligiblePropertyIndexes,
    routingMetadata: routingMetadata(properties.length, eligible.length, routes.length, continuityContext),
    cooldownInfo,
  };
}

export function materializeLargeRoutes(properties, workerResult) {
  const originals = Array.isArray(properties) ? properties : [];
  const routeManifests = workerResult?.routeManifests;
  verifyLargeRouteManifests(
    routeManifests,
    workerResult?.eligiblePropertyIndexes,
    originals.length,
  );
  return routeManifests.map((manifest) => {
    const { propertyIndexes, ...routeFields } = manifest;
    const routeProperties = propertyIndexes.map((index) => originals[index]);
    return {
      ...routeFields,
      properties: routeProperties,
      houseCount: routeProperties.length,
      metadata: {
        ...(routeFields.metadata || {}),
        routing: {
          ...(routeFields.metadata?.routing || {}),
          property_order_fingerprint: routePropertyOrderFingerprint(routeProperties),
        },
      },
    };
  });
}

function workerRequestId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `large_route_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
}

function workerError(payload = {}) {
  const error = new Error(String(payload.message || 'Large-route optimization failed in the background worker.'));
  error.name = String(payload.name || 'Error');
  if (payload.code) error.code = String(payload.code);
  return error;
}

function synchronousFallback(input) {
  const result = buildLargeRouteManifests(input);
  const routes = materializeLargeRoutes(input.properties, result);
  if (result.cooldownInfo) {
    Object.defineProperty(routes, '_cooldownInfo', {
      value: result.cooldownInfo,
      enumerable: false,
    });
  }
  return {
    routes,
    routingMetadata: result.routingMetadata,
    executionMode: 'synchronous-worker-unavailable',
  };
}

/**
 * Fetch the OSRM road matrix on the main thread, before the worker starts.
 *
 * This is the only place it can happen. The optimizer's distance hook is
 * synchronous and the worker has no route to the network mid-run, so road
 * awareness for the large-route path has to be resolved up front and handed
 * across as data. A null result is not an error — it means this run uses
 * street/subdivision continuity, exactly as it did before.
 */
async function prefetchOsrmPayload(input, options) {
  if (options.useOsrm === false) return null;
  try {
    return await createOsrmContextPayload(input.properties || [], {
      signal: options.signal,
      deadlineMs: options.osrmDeadlineMs,
    });
  } catch (error) {
    console.warn('[largeRouteOptimizer] OSRM prefetch failed; using continuity context.', error);
    return null;
  }
}

export async function optimizeLargeRoutesAsync(input = {}, options = {}) {
  const osrmContextPayload = await prefetchOsrmPayload(input, options);
  const enrichedInput = osrmContextPayload ? { ...input, osrmContextPayload } : input;

  if (typeof Worker !== 'function') return synchronousFallback(enrichedInput);

  let worker;
  try {
    worker = new Worker(
      new URL('./largeRouteOptimizer.worker.js', import.meta.url),
      { type: 'module', name: 'firstknock-large-route-optimizer' },
    );
  } catch (error) {
    console.warn('[largeRouteOptimizer] Module worker unavailable; using synchronous fallback.', error);
    return synchronousFallback(enrichedInput);
  }

  const activeRequestId = workerRequestId();
  const timeoutMs = normalizedTimeoutMs(options.timeoutMs);
  const workerResult = await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      try { worker.terminate(); } catch {}
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanup();
      callback(value);
    };
    const timeout = setTimeout(() => {
      const error = new Error(`Large-route optimization exceeded the ${Math.round(timeoutMs / 1000)}-second safety limit.`);
      error.name = 'LargeRouteTimeoutError';
      error.code = 'LARGE_ROUTE_TIMEOUT';
      settle(reject, error);
    }, timeoutMs);

    worker.onmessage = (event) => {
      if (String(event?.data?.requestId || '') !== activeRequestId) return;
      if (event?.data?.ok !== true) {
        settle(reject, workerError(event?.data?.error));
        return;
      }
      settle(resolve, event.data.result);
    };
    worker.onerror = (event) => {
      if (typeof event?.preventDefault === 'function') event.preventDefault();
      const error = new Error(String(event?.message || 'Large-route optimization worker failed.'));
      error.name = 'LargeRouteWorkerError';
      error.code = 'LARGE_ROUTE_WORKER_FAILED';
      settle(reject, error);
    };
    worker.onmessageerror = () => {
      const error = new Error('Large-route optimization returned an unreadable worker response.');
      error.name = 'LargeRouteWorkerError';
      error.code = 'LARGE_ROUTE_WORKER_MESSAGE_INVALID';
      settle(reject, error);
    };

    try {
      worker.postMessage({ requestId: activeRequestId, input: enrichedInput });
    } catch (error) {
      settle(reject, error);
    }
  });

  const routes = materializeLargeRoutes(input.properties, workerResult);
  if (workerResult.cooldownInfo) {
    Object.defineProperty(routes, '_cooldownInfo', {
      value: workerResult.cooldownInfo,
      enumerable: false,
    });
  }
  return {
    routes,
    routingMetadata: workerResult.routingMetadata,
    executionMode: 'module-worker',
  };
}

export const largeRouteOptimizerInternals = Object.freeze({
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  normalizedRouteSize,
  normalizedTimeoutMs,
});
