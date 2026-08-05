import {
  canonicalStreetRoutingKey,
  isStrictRoutePropertyPoint,
  optimizeRouteByStreetSweep,
} from '@/components/logic/routeOptimizer';
import {
  buildPersistedRoadRoutingMetadata,
  createRouteContinuityContext,
} from '@/components/logic/routeRoadContext';
import {
  calculateRouteDistanceMiles,
  haversineDistanceMiles,
} from '@/lib/routeBounds';

const SPLIT_HASH = '__firstknock_split_manifest_hash';
const SPLIT_MISSING = '__firstknock_split_missing_property';

function cleanText(value) {
  return value === null || value === undefined
    ? ''
    : String(value).trim().replace(/\s+/g, ' ');
}

function propertyIdentityValues(property) {
  return [property?.address_hash, property?.legacy_hash, property?.id]
    .map(cleanText)
    .filter(Boolean);
}

function routePropertySources(route) {
  return [
    ...(Array.isArray(route?.allProperties) ? route.allProperties : []),
    ...(Array.isArray(route?.properties) ? route.properties : []),
  ];
}

/**
 * Return the complete route manifest in its saved order. Missing hydrated
 * properties remain represented so planning can fail closed instead of
 * silently dropping homes from a split.
 */
export function getRouteStops(route) {
  const manifest = (Array.isArray(route?.property_hashes) ? route.property_hashes : [])
    .map(cleanText)
    .filter(Boolean);
  const sources = routePropertySources(route);
  const byIdentity = new Map();

  sources.forEach((property) => {
    propertyIdentityValues(property).forEach((identity) => {
      if (!byIdentity.has(identity)) byIdentity.set(identity, property);
    });
  });

  if (manifest.length > 0) {
    return manifest.map((hash) => {
      const property = byIdentity.get(hash);
      return property
        ? { ...property, [SPLIT_HASH]: hash }
        : {
            address_hash: hash,
            id: hash,
            [SPLIT_HASH]: hash,
            [SPLIT_MISSING]: true,
          };
    });
  }

  const seen = new Set();
  return sources.flatMap((property) => {
    const identity = propertyIdentityValues(property)[0];
    if (!identity || seen.has(identity)) return [];
    seen.add(identity);
    return [{ ...property, [SPLIT_HASH]: identity }];
  });
}

function stopManifestHash(stop) {
  return cleanText(stop?.[SPLIT_HASH] || stop?.address_hash || stop?.legacy_hash || stop?.id);
}

function assertExactMembership(expectedStops, actualStops, label) {
  const expected = expectedStops.map(stopManifestHash);
  const actual = actualStops.map(stopManifestHash);
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  if (
    expected.some((hash) => !hash)
    || actual.some((hash) => !hash)
    || expectedSet.size !== expected.length
    || actualSet.size !== actual.length
    || actual.length !== expected.length
    || actual.some((hash) => !expectedSet.has(hash))
  ) {
    throw new Error(`${label} changed the saved route membership, so no routes were created.`);
  }
}

function normalizeStopsForPlanning(route) {
  const stops = getRouteStops(route);
  if (stops.length < 2) {
    throw new Error('This route needs at least two loaded homes before it can be divided.');
  }

  const missingCount = stops.filter((stop) => stop?.[SPLIT_MISSING]).length;
  if (missingCount > 0) {
    throw new Error(
      `${missingCount} of ${stops.length} route homes are not loaded. Refresh the route before dividing it.`,
    );
  }

  const normalized = stops.map((stop) => ({
    ...stop,
    lat: Number(stop.lat),
    lng: Number(stop.lng),
  }));
  const invalidCount = normalized.filter((stop) => !isStrictRoutePropertyPoint(stop)).length;
  if (invalidCount > 0) {
    throw new Error(
      `${invalidCount} route ${invalidCount === 1 ? 'home is' : 'homes are'} missing a usable map location. Fix the locations before dividing this route.`,
    );
  }

  assertExactMembership(normalized, normalized, 'Route validation');
  return normalized;
}

function safeContextKey(routingContext, method, property) {
  if (typeof routingContext?.[method] !== 'function') return '';
  try {
    return cleanText(routingContext[method](property));
  } catch {
    return '';
  }
}

function splitBoundaryPenalty(stops, cutIndex, routingContext) {
  if (cutIndex <= 0 || cutIndex >= stops.length) return 0;
  const left = stops[cutIndex - 1];
  const right = stops[cutIndex];
  const leftAccess = safeContextKey(routingContext, 'accessGroupKey', left);
  const rightAccess = safeContextKey(routingContext, 'accessGroupKey', right);
  if (leftAccess && leftAccess === rightAccess) return 10_000;

  const leftSegment = safeContextKey(routingContext, 'streetSegmentKey', left);
  const rightSegment = safeContextKey(routingContext, 'streetSegmentKey', right);
  if (leftSegment && leftSegment === rightSegment) return 1_000;
  if (canonicalStreetRoutingKey(left) === canonicalStreetRoutingKey(right)) return 500;

  // When two equally balanced cuts both preserve natural groups, prefer the
  // larger geographic gap between them.
  try {
    return -Math.min(50, haversineDistanceMiles(left, right));
  } catch {
    return 0;
  }
}

/**
 * Every route receives either floor(N / K) or ceil(N / K) homes. A small
 * dynamic program decides where the larger groups go so their cut points are
 * least likely to break a subdivision/access group or a street segment.
 */
function chooseBalancedGroupSizes(orderedStops, routeCount, routingContext) {
  const total = orderedStops.length;
  const baseSize = Math.floor(total / routeCount);
  const largerGroupCount = total % routeCount;
  const smallerGroupCount = routeCount - largerGroupCount;
  const memo = new Map();

  const solve = (groupIndex, usedLargerGroups) => {
    const key = `${groupIndex}:${usedLargerGroups}`;
    if (memo.has(key)) return memo.get(key);
    if (groupIndex === routeCount) {
      return usedLargerGroups === largerGroupCount
        ? { cost: 0, sizes: [] }
        : null;
    }

    const usedSmallerGroups = groupIndex - usedLargerGroups;
    const offset = (groupIndex * baseSize) + usedLargerGroups;
    const candidates = [];
    if (usedLargerGroups < largerGroupCount) candidates.push(baseSize + 1);
    if (usedSmallerGroups < smallerGroupCount) candidates.push(baseSize);

    let best = null;
    for (const size of candidates) {
      const usesLargerGroup = size === baseSize + 1 && largerGroupCount > 0;
      const next = solve(groupIndex + 1, usedLargerGroups + (usesLargerGroup ? 1 : 0));
      if (!next) continue;
      const cutIndex = offset + size;
      const boundaryCost = groupIndex === routeCount - 1
        ? 0
        : splitBoundaryPenalty(orderedStops, cutIndex, routingContext);
      const candidate = {
        cost: boundaryCost + next.cost,
        sizes: [size, ...next.sizes],
      };
      if (!best || candidate.cost < best.cost - 0.000001) best = candidate;
    }

    memo.set(key, best);
    return best;
  };

  return solve(0, 0)?.sizes || [];
}

function alphaCode(index) {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

export function splitRouteCode(index, totalRoutes) {
  if (totalRoutes <= 26) return alphaCode(index);
  return String(index + 1).padStart(String(totalRoutes).length, '0');
}

export function buildDefaultSplitRouteName(parentName, code, totalRoutes = 1) {
  const sourceName = cleanText(parentName) || 'Route';
  if (totalRoutes <= 26 && /\bRoute\s+\d+$/i.test(sourceName)) {
    return `${sourceName}${code}`;
  }
  return `${sourceName} — Route ${code}`;
}

function mostCommonLabel(stops, getters) {
  const counts = new Map();
  stops.forEach((stop) => {
    for (const getter of getters) {
      const value = cleanText(getter(stop));
      if (!value || /^(unknown|n\/a|null)$/i.test(value)) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
      break;
    }
  });
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] || '';
}

function splitAreaLabel(stops) {
  return mostCommonLabel(stops, [
    (stop) => stop.subdivision_name,
    (stop) => stop.subdivision,
    (stop) => stop.neighborhood,
    (stop) => stop.raw_metadata?.subdivision_name,
    (stop) => stop.raw_metadata?.subdivision,
    (stop) => stop.raw_metadata?.neighborhood,
  ]) || mostCommonLabel(stops, [
    (stop) => stop.street_name,
    (stop) => stop.raw_metadata?.street_name,
  ]) || mostCommonLabel(stops, [
    (stop) => stop.city,
    (stop) => stop.zip_code,
    (stop) => stop.zip,
  ]);
}

function sizingFor(totalHomes, sizingMode, rawValue) {
  const requestedValue = Number(rawValue);
  if (!Number.isInteger(requestedValue) || requestedValue < 1) {
    throw new Error('Enter a whole number greater than zero.');
  }

  if (sizingMode === 'route_count') {
    if (requestedValue < 2) throw new Error('Choose at least two routes.');
    if (requestedValue > totalHomes) {
      throw new Error(`This route has only ${totalHomes} homes.`);
    }
    return { routeCount: requestedValue, requestedValue, sizingMode };
  }

  if (sizingMode !== 'max_homes') throw new Error('Choose how FirstKnock should divide the route.');
  if (requestedValue >= totalHomes) {
    throw new Error(`Choose fewer than ${totalHomes} homes per route to create a split.`);
  }
  return {
    routeCount: Math.ceil(totalHomes / requestedValue),
    requestedValue,
    sizingMode,
  };
}

/**
 * Build a deterministic, geographically ordered and exactly balanced preview.
 * This function performs no writes.
 */
export function buildOptimizedSplitPlan({ route, sizingMode = 'max_homes', value = 25 }) {
  const sourceStops = normalizeStopsForPlanning(route);
  const sizing = sizingFor(sourceStops.length, sizingMode, value);
  const routingContext = createRouteContinuityContext(sourceStops);
  const globallyOrdered = optimizeRouteByStreetSweep(sourceStops, null, null, routingContext);
  assertExactMembership(sourceStops, globallyOrdered, 'Route optimization');

  const sizes = chooseBalancedGroupSizes(globallyOrdered, sizing.routeCount, routingContext);
  if (sizes.length !== sizing.routeCount || sizes.reduce((sum, size) => sum + size, 0) !== sourceStops.length) {
    throw new Error('FirstKnock could not create a balanced route plan. No routes were changed.');
  }
  if (sizingMode === 'max_homes' && sizes.some((size) => size > sizing.requestedValue)) {
    throw new Error('FirstKnock could not honor the maximum homes per route. No routes were changed.');
  }

  let offset = 0;
  const routes = sizes.map((size, index) => {
    const group = globallyOrdered.slice(offset, offset + size);
    offset += size;
    const childContext = createRouteContinuityContext(group);
    const optimizedStops = optimizeRouteByStreetSweep(group, null, null, childContext);
    assertExactMembership(group, optimizedStops, `Route ${index + 1} optimization`);
    const propertyHashes = optimizedStops.map(stopManifestHash);
    const distanceMiles = Math.round(calculateRouteDistanceMiles(optimizedStops) * 100) / 100;
    const code = splitRouteCode(index, sizing.routeCount);
    return {
      index,
      routeNumber: index + 1,
      code,
      name: buildDefaultSplitRouteName(route?.name, code, sizing.routeCount),
      areaLabel: splitAreaLabel(optimizedStops),
      stops: optimizedStops,
      propertyHashes,
      houseCount: optimizedStops.length,
      distanceMiles,
      routingMetadata: buildPersistedRoadRoutingMetadata(childContext, null, propertyHashes),
    };
  });

  assertExactMembership(sourceStops, routes.flatMap((child) => child.stops), 'Route splitting');
  const counts = routes.map((child) => child.houseCount);
  return {
    ...sizing,
    totalHomes: sourceStops.length,
    routeCount: routes.length,
    minHomes: Math.min(...counts),
    maxHomes: Math.max(...counts),
    routes,
  };
}

function routeScore(routePlan, sourceRoute) {
  const scores = routePlan.stops
    .map((stop) => Number(stop.score))
    .filter(Number.isFinite);
  if (scores.length > 0) {
    return Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
  }
  return Number(sourceRoute?.competitivenessScore || sourceRoute?.metrics?.score || 0);
}

function normalizedRouteManifest(propertyHashes) {
  if (!Array.isArray(propertyHashes) || propertyHashes.length === 0) return '';
  const normalized = propertyHashes.map(cleanText);
  if (normalized.some((hash) => !hash) || new Set(normalized).size !== normalized.length) return '';
  return normalized;
}

function routeManifestSignature(propertyHashes) {
  const normalized = normalizedRouteManifest(propertyHashes);
  return normalized ? JSON.stringify(normalized) : '';
}

export function routeMembershipMatches(firstPropertyHashes, secondPropertyHashes) {
  const first = normalizedRouteManifest(firstPropertyHashes);
  const second = normalizedRouteManifest(secondPropertyHashes);
  if (!first || !second || first.length !== second.length) return false;
  const sortedFirst = [...first].sort();
  const sortedSecond = [...second].sort();
  return sortedFirst.every((hash, index) => hash === sortedSecond[index]);
}

/**
 * A saved source may be archived only after the API confirms every planned
 * child, with a unique ID and the exact persisted stop order for that child.
 */
export function splitRouteCreationMatchesPlan(records = [], createdRoutes = []) {
  if (!Array.isArray(records) || !Array.isArray(createdRoutes) || records.length === 0) return false;
  if (createdRoutes.length !== records.length) return false;

  const createdIds = createdRoutes.map((route) => cleanText(route?.id));
  if (createdIds.some((id) => !id) || new Set(createdIds).size !== createdIds.length) return false;

  const expectedManifests = records.map((record) => routeManifestSignature(record?.property_hashes)).sort();
  const persistedManifests = createdRoutes.map((record) => routeManifestSignature(record?.property_hashes)).sort();
  if (expectedManifests.some((manifest) => !manifest) || persistedManifests.some((manifest) => !manifest)) return false;
  return expectedManifests.every((manifest, index) => manifest === persistedManifests[index]);
}

export function buildSplitRouteRecords({
  route,
  plan,
  managerId,
  routeNames = [],
  createdAt = new Date().toISOString(),
  operationId = null,
}) {
  if (!plan?.routes?.length) return [];
  const safeMetadata = { ...(route?.metadata || {}) };
  delete safeMetadata.route_bounds;
  delete safeMetadata.road_geometry;
  delete safeMetadata.routing;

  return plan.routes.map((child, index) => {
    const requestedName = cleanText(routeNames[index]);
    const name = requestedName || child.name;
    return {
      name,
      description: `Route ${child.code} of ${plan.routeCount} created from ${route?.name || 'the original route'}`,
      route_mode: route?.route_mode || 'precision',
      status: 'PENDING',
      assigned_to: null,
      assigned_to_name: null,
      priority: Number(route?.priority || 0) + index + 1,
      property_hashes: [...child.propertyHashes],
      metrics: {
        distance: child.distanceMiles,
        house_count: child.houseCount,
        score: routeScore(child, route),
      },
      start_location: null,
      end_location: null,
      route_origin_mode: 'none',
      metadata: {
        ...safeMetadata,
        ...(child.routingMetadata || {}),
        split_source: {
          route_id: route?.id || null,
          route_name: route?.name || null,
          sizing_mode: plan.sizingMode,
          requested_value: plan.requestedValue,
          route_code: child.code,
          route_number: index + 1,
          route_total: plan.routeCount,
          created_at: createdAt,
          operation_id: operationId,
        },
      },
      manager_id: route?.manager_id || managerId,
      parent_route_id: route?.id || null,
      // Retain the schema-backed internal lineage fields for compatibility;
      // the product UI deliberately calls these routes, not batches.
      batch_number: index + 1,
      batch_total: plan.routeCount,
      batch_date: null,
    };
  });
}
