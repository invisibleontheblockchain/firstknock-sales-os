import { buildCanvasStreetWorkUnits } from './canvasStreetTopology';
import {
  createRoadNetworkRoutingContext,
  DEFAULT_ROUTABLE_HIGHWAYS,
} from './roadNetworkRouting';
import { fetchRouteRoadNetwork } from './routeRoadNetworkSource';
import { canonicalStreetRoutingKey } from './routeOptimizer';

const METERS_PER_MILE = 1609.344;
const DEFAULT_MAX_FULL_ROUTE_POINTS = 500;
const DEFAULT_MAX_COST_ONLY_POINTS = 5000;
const DEFAULT_MAX_COST_ONLY_BLOCKS = 300;
const ROUTE_HIGHWAY_FILTER = DEFAULT_ROUTABLE_HIGHWAYS.join('|');
const INVALID_AREA_LABELS = new Set([
  '-',
  '0',
  'n/a',
  'na',
  'none',
  'null',
  'unknown',
  'not available',
  'not provided',
  'no subdivision',
  'unnamed',
]);

function pointFrom(value) {
  const lat = Number(value?.lat ?? value?.latitude);
  const lng = Number(value?.lng ?? value?.lon ?? value?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function propertyIdentity(property, fallbackIndex = 0) {
  return String(
    property?.address_hash
    || property?.legacy_hash
    || property?.id
    || [
      Number(property?.lat).toFixed(7),
      Number(property?.lng).toFixed(7),
      property?.street_name || '',
      property?.house_number || '',
      fallbackIndex,
    ].join('|'),
  );
}

function propertyManifestIdentity(value) {
  const identity = value?.address_hash || value?.legacy_hash || value?.id;
  return identity === null || identity === undefined || String(identity).trim() === ''
    ? ''
    : String(identity).trim();
}

function propertyManifestLocationKey(value) {
  const point = pointFrom(value);
  if (!point) return '';
  const street = String(value?.street_name || value?.street || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const houseNumber = String(value?.house_number || value?.houseNumber || '')
    .trim()
    .toLowerCase();
  return [
    point.lat.toFixed(7),
    point.lng.toFixed(7),
    street,
    houseNumber,
  ].join('|');
}

function buildValidPropertyManifest(properties) {
  const objectMembers = new WeakSet();
  const identities = new Set();
  const locationKeys = new Set();
  properties.forEach((property) => {
    if (property && typeof property === 'object') objectMembers.add(property);
    const identity = propertyManifestIdentity(property);
    const locationKey = propertyManifestLocationKey(property);
    if (identity) identities.add(identity);
    if (locationKey) locationKeys.add(locationKey);
  });
  return Object.freeze({
    size: properties.length,
    has(value) {
      if (!value || typeof value !== 'object') return false;
      if (objectMembers.has(value)) return true;
      const identity = propertyManifestIdentity(value);
      if (identity && identities.has(identity)) return true;
      const locationKey = propertyManifestLocationKey(value);
      return Boolean(locationKey && locationKeys.has(locationKey));
    },
  });
}

function frozenReasonCounts(reasonCounts) {
  return Object.freeze(Object.fromEntries(
    [...reasonCounts.entries()].sort(([first], [second]) => (
      compareStableKeys(first, second)
    )),
  ));
}

export function routePropertyOrderFingerprint(propertiesOrHashes) {
  if (!Array.isArray(propertiesOrHashes) || propertiesOrHashes.length === 0) return '';
  const identities = propertiesOrHashes.map((value) => {
    if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
    return String(
      value?.address_hash
      || value?.legacy_hash
      || value?.id
      || '',
    ).trim();
  });
  if (identities.some((identity) => !identity)) return '';

  let first = 2166136261;
  let second = 2246822507;
  identities.forEach((identity) => {
    const framed = `${identity.length}:${identity}|`;
    for (let index = 0; index < framed.length; index += 1) {
      const code = framed.charCodeAt(index);
      first = Math.imul(first ^ code, 16777619);
      second = Math.imul(second ^ code, 3266489909);
    }
  });
  return `${identities.length}:${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function normalizeAreaLabel(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > 160) return '';
  const comparison = normalized
    .toLowerCase()
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return INVALID_AREA_LABELS.has(comparison) ? '' : comparison;
}

function explicitAreaLabel(property) {
  const candidates = [
    property?.subdivision_name,
    property?.subdivisionName,
    property?.neighborhood_name,
    property?.neighborhoodName,
    typeof property?.subdivision === 'string' ? property.subdivision : null,
    property?.subdivision?.name,
    property?.raw_metadata?.subdivision_name,
    property?.raw_metadata?.subdivisionName,
    property?.raw_metadata?.SUBDIVISION,
    property?.raw_metadata?.Subdivision,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeAreaLabel(candidate);
    if (normalized) return normalized;
  }
  return '';
}

function explicitAccessKey(property, roadContext = null) {
  const area = explicitAreaLabel(property);
  if (!area) return '';
  const state = String(property?.state || '').trim().toLowerCase();
  const city = String(property?.city || '').trim().toLowerCase();
  const zip = String(property?.zip_code || property?.zip || '').trim().slice(0, 5);
  const component = roadContext?.roadComponentKey?.(property) || 'unscoped';
  return `provider-area:${state}|${city}|${zip}|${area}|${component}`;
}

function compareStableKeys(first, second) {
  const firstKey = String(first);
  const secondKey = String(second);
  if (firstKey < secondKey) return -1;
  if (firstKey > secondKey) return 1;
  return 0;
}

function selectBlockRepresentative(properties) {
  const centroid = properties.reduce(
    (result, property) => ({
      lat: result.lat + Number(property.lat) / properties.length,
      lng: result.lng + Number(property.lng) / properties.length,
    }),
    { lat: 0, lng: 0 },
  );
  return [...properties].sort((first, second) => {
    const firstDistance = (Number(first.lat) - centroid.lat) ** 2
      + (Number(first.lng) - centroid.lng) ** 2;
    const secondDistance = (Number(second.lat) - centroid.lat) ** 2
      + (Number(second.lng) - centroid.lng) ** 2;
    return firstDistance - secondDistance
      || compareStableKeys(propertyIdentity(first), propertyIdentity(second));
  })[0];
}

function buildCostOnlyBlockPlan(properties) {
  const propertiesByStreet = new Map();
  const streetKeyByIdentity = new Map();
  properties.forEach((property, index) => {
    const canonicalStreetKey = canonicalStreetRoutingKey(property, index);
    const accessKey = explicitAccessKey(property);
    // The same street name may exist in separate subdivisions inside one ZIP.
    // Keep those local street segments distinct so a cost-only route cannot
    // merge both pockets and then lose the higher-level access grouping.
    const streetKey = accessKey
      ? `${canonicalStreetKey}|${accessKey}`
      : canonicalStreetKey;
    const identity = propertyIdentity(property);
    streetKeyByIdentity.set(identity, streetKey);
    if (!propertiesByStreet.has(streetKey)) propertiesByStreet.set(streetKey, []);
    propertiesByStreet.get(streetKey).push(property);
  });

  const representativeByStreet = new Map();
  [...propertiesByStreet.entries()]
    .sort(([firstKey], [secondKey]) => compareStableKeys(firstKey, secondKey))
    .forEach(([streetKey, streetProperties]) => {
      representativeByStreet.set(streetKey, selectBlockRepresentative(streetProperties));
    });

  return {
    blockCount: representativeByStreet.size,
    representatives: [...representativeByStreet.values()],
    representativeByStreet,
    streetKeyByIdentity,
  };
}

function routeBoundsPolygon(properties, paddingMiles = null) {
  const points = properties.map(pointFrom).filter(Boolean);
  if (!points.length) return [];
  const south = Math.min(...points.map(({ lat }) => lat));
  const north = Math.max(...points.map(({ lat }) => lat));
  const west = Math.min(...points.map(({ lng }) => lng));
  const east = Math.max(...points.map(({ lng }) => lng));
  const centerLatitude = (south + north) / 2;
  const widthMiles = Math.max(0, (east - west) * 69 * Math.cos(centerLatitude * Math.PI / 180));
  const heightMiles = Math.max(0, (north - south) * 69);
  const inferredPaddingMiles = Math.min(2, Math.max(0.75, Math.max(widthMiles, heightMiles) * 0.2));
  const padding = Number.isFinite(Number(paddingMiles))
    ? Math.min(3, Math.max(0.25, Number(paddingMiles)))
    : inferredPaddingMiles;
  const latitudePadding = padding / 69;
  const longitudeScale = Math.max(0.2, Math.cos(centerLatitude * Math.PI / 180));
  const longitudePadding = padding / (69 * longitudeScale);
  return [
    { lat: south - latitudePadding, lng: west - longitudePadding },
    { lat: south - latitudePadding, lng: east + longitudePadding },
    { lat: north + latitudePadding, lng: east + longitudePadding },
    { lat: north + latitudePadding, lng: west - longitudePadding },
  ];
}

function buildProtectedAccessGroups({
  properties,
  roadNetwork,
  polygon,
  roadContext,
}) {
  const candidates = [];
  const candidateIdByProperty = new Map();
  const seenCandidateIds = new Set();

  properties.forEach((property, index) => {
    const point = pointFrom(property);
    const roadSnap = roadContext.snapFor(property);
    if (!point || !roadSnap?.edgeId) return;
    const baseId = propertyIdentity(property, index);
    let candidateId = baseId;
    let duplicate = 1;
    while (seenCandidateIds.has(candidateId)) {
      candidateId = `${baseId}|${duplicate}`;
      duplicate += 1;
    }
    seenCandidateIds.add(candidateId);
    candidateIdByProperty.set(property, candidateId);
    candidates.push({
      id: candidateId,
      ...point,
      streetName: property?.street_name || '',
      roadEdgeId: roadSnap.edgeId,
    });
  });

  if (!candidates.length) {
    return {
      keyByProperty: new Map(),
      status: 'unavailable',
      diagnostics: { reason: 'NO_SNAPPED_CANDIDATES' },
    };
  }

  const topology = buildCanvasStreetWorkUnits({
    polygon,
    roadNetwork,
    candidates,
    allowedHighways: DEFAULT_ROUTABLE_HIGHWAYS,
    maxSnapDistanceMeters: 300,
    roadSnapAmbiguityMeters: 0,
    roadSnapAmbiguityRatio: 1,
  });
  if (!topology.ok) {
    return {
      keyByProperty: new Map(),
      status: 'degraded',
      diagnostics: {
        reason: topology.code || 'TOPOLOGY_UNAVAILABLE',
      },
    };
  }

  const protectedUnitByCandidate = new Map();
  topology.workUnits
    .filter((unit) => unit.protected && unit.candidateIds.length > 0)
    .forEach((unit) => {
      unit.candidateIds.forEach((candidateId) => {
        protectedUnitByCandidate.set(candidateId, `osm-access:${unit.id}`);
      });
    });
  const keyByProperty = new Map();
  properties.forEach((property) => {
    const candidateId = candidateIdByProperty.get(property);
    const accessKey = candidateId ? protectedUnitByCandidate.get(candidateId) : null;
    if (accessKey) keyByProperty.set(propertyIdentity(property), accessKey);
  });
  return {
    keyByProperty,
    status: topology.status,
    diagnostics: {
      protectedAccessGroupCount: new Set(keyByProperty.values()).size,
      protectedCandidateCount: keyByProperty.size,
      workUnitCount: topology.diagnostics?.workUnitCount || 0,
    },
  };
}

function fallbackContext(properties, reason, error = null, diagnostics = {}) {
  const hasExplicitAreas = properties.some((property) => explicitAreaLabel(property));
  return Object.freeze({
    status: hasExplicitAreas ? 'area-only' : 'unavailable',
    source: hasExplicitAreas ? 'provider-area' : 'aerial-fallback',
    roadAware: false,
    costOnly: false,
    mode: 'fallback',
    streetSegmentKey(property) {
      const accessKey = explicitAccessKey(property);
      return accessKey
        ? `${canonicalStreetRoutingKey(property)}|${accessKey}`
        : '';
    },
    accessGroupKey(property) {
      return explicitAccessKey(property);
    },
    diagnostics: Object.freeze({
      reason,
      errorCode: error?.code || null,
      suppliedPointCount: properties.length,
      ...diagnostics,
    }),
  });
}

/**
 * Returns the synchronous street/subdivision continuity context used whenever
 * fetching a live road graph is unnecessary or unavailable. This has no route
 * size limit and performs no network work.
 */
export function createRouteContinuityContext(properties) {
  const validProperties = (Array.isArray(properties) ? properties : [])
    .filter((property) => pointFrom(property));
  return fallbackContext(validProperties, 'SYNCHRONOUS_CONTINUITY');
}

function costOnlyContext({
  properties,
  roadContext,
  blockPlan,
  polygon,
  proxyMetadata = null,
  snappedRepresentativeCount,
}) {
  let roadCostQueryCount = 0;
  let roadCostFallbackCount = 0;
  let blockToBlockRoadCostQueryCount = 0;
  let blockToBlockRoadCostFallbackCount = 0;
  let externalBoundRoadCostQueryCount = 0;
  let externalBoundRoadCostFallbackCount = 0;
  const fallbackReasons = new Map();
  const blockFallbackReasons = new Map();
  const externalBoundFallbackReasons = new Map();

  const blockKeyFor = (value) => {
    if (!value || typeof value !== 'object') return '';
    return blockPlan.streetKeyByIdentity.get(propertyIdentity(value)) || '';
  };
  const representativeFor = (value) => {
    if (!value || typeof value !== 'object') return value;
    const streetKey = blockKeyFor(value);
    return streetKey
      ? blockPlan.representativeByStreet.get(streetKey) || value
      : value;
  };
  const evaluateCost = (left, right) => {
    roadCostQueryCount += 1;
    const blockToBlock = Boolean(blockKeyFor(left) && blockKeyFor(right));
    if (blockToBlock) blockToBlockRoadCostQueryCount += 1;
    else externalBoundRoadCostQueryCount += 1;
    const route = roadContext.routeBetween(
      representativeFor(left),
      representativeFor(right),
    );
    if (route.usedFallback) {
      roadCostFallbackCount += 1;
      const reason = route.reason || 'UNKNOWN';
      fallbackReasons.set(reason, (fallbackReasons.get(reason) || 0) + 1);
      if (blockToBlock) {
        blockToBlockRoadCostFallbackCount += 1;
        blockFallbackReasons.set(reason, (blockFallbackReasons.get(reason) || 0) + 1);
      } else {
        externalBoundRoadCostFallbackCount += 1;
        externalBoundFallbackReasons.set(
          reason,
          (externalBoundFallbackReasons.get(reason) || 0) + 1,
        );
      }
    }
    return route;
  };
  const diagnostics = {
    ...roadContext.diagnostics,
    requestedMode: 'cost-only',
    mode: 'cost-only',
    originalPointCount: properties.length,
    representativeBlockCount: blockPlan.blockCount,
    representativePointCount: blockPlan.representatives.length,
    snappedRepresentativeCount,
    accessGrouping: 'provider-area-only',
    geometryPersisted: false,
    roadNetworkSource: proxyMetadata?.source || 'injected-or-browser-road-network',
    roadNetworkCacheStatus: proxyMetadata?.cache_status || null,
    polygon: Object.freeze(polygon.map((point) => Object.freeze({ ...point }))),
    get dijkstraRunCount() {
      return roadContext.diagnostics.dijkstraRunCount;
    },
    get cachedSourceTreeCount() {
      return roadContext.diagnostics.cachedSourceTreeCount;
    },
    get roadCostQueryCount() {
      return roadCostQueryCount;
    },
    get roadCostFallbackCount() {
      return roadCostFallbackCount;
    },
    get roadCostFallbackReasons() {
      return frozenReasonCounts(fallbackReasons);
    },
    get blockToBlockRoadCostQueryCount() {
      return blockToBlockRoadCostQueryCount;
    },
    get blockToBlockRoadCostFallbackCount() {
      return blockToBlockRoadCostFallbackCount;
    },
    get blockToBlockRoadCostFallbackReasons() {
      return frozenReasonCounts(blockFallbackReasons);
    },
    get externalBoundRoadCostQueryCount() {
      return externalBoundRoadCostQueryCount;
    },
    get externalBoundRoadCostFallbackCount() {
      return externalBoundRoadCostFallbackCount;
    },
    get externalBoundRoadCostFallbackReasons() {
      return frozenReasonCounts(externalBoundFallbackReasons);
    },
  };

  return Object.freeze({
    status: roadContext.status,
    source: proxyMetadata?.proxied === true
      ? 'osm-road-network-proxy-cost-only'
      : 'osm-road-network-cost-only',
    roadAware: true,
    costOnly: true,
    mode: 'cost-only',
    distanceBetween(left, right) {
      return evaluateCost(left, right).distanceMiles;
    },
    distanceBetweenMeters(left, right) {
      return evaluateCost(left, right).distanceMeters;
    },
    streetSegmentKey(property) {
      const identity = propertyIdentity(property);
      return blockPlan.streetKeyByIdentity.get(identity)
        || canonicalStreetRoutingKey(property);
    },
    accessGroupKey(property) {
      const representative = representativeFor(property);
      return explicitAccessKey(property, {
        roadComponentKey() {
          return roadContext.roadComponentKey(representative);
        },
      });
    },
    diagnostics: Object.freeze(diagnostics),
  });
}

function fullRoadContext({
  properties,
  roadContext,
  protectedGroups,
  polygon,
  proxyMetadata = null,
  requestedMode,
}) {
  const validPropertyManifest = buildValidPropertyManifest(properties);
  let roadCostQueryCount = 0;
  let roadCostFallbackCount = 0;
  let doorToDoorRoadCostQueryCount = 0;
  let doorToDoorRoadCostFallbackCount = 0;
  let externalBoundRoadCostQueryCount = 0;
  let externalBoundRoadCostFallbackCount = 0;
  const fallbackReasons = new Map();
  const doorToDoorFallbackReasons = new Map();
  const externalBoundFallbackReasons = new Map();

  const incrementReason = (reasonCounts, reason) => {
    reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
  };
  const evaluateRoute = (left, right) => {
    const doorToDoor = validPropertyManifest.has(left) && validPropertyManifest.has(right);
    roadCostQueryCount += 1;
    if (doorToDoor) {
      doorToDoorRoadCostQueryCount += 1;
    } else {
      externalBoundRoadCostQueryCount += 1;
    }

    const route = roadContext.routeBetween(left, right);
    if (route.usedFallback) {
      const reason = route.reason || 'UNKNOWN';
      roadCostFallbackCount += 1;
      incrementReason(fallbackReasons, reason);
      if (doorToDoor) {
        doorToDoorRoadCostFallbackCount += 1;
        incrementReason(doorToDoorFallbackReasons, reason);
      } else {
        externalBoundRoadCostFallbackCount += 1;
        incrementReason(externalBoundFallbackReasons, reason);
      }
    }
    return route;
  };
  const diagnostics = {
    ...roadContext.diagnostics,
    requestedMode,
    mode: 'full',
    validPropertyManifestCount: validPropertyManifest.size,
    roadCostClassification: 'valid-property-manifest',
    roadNetworkSource: proxyMetadata?.source || 'injected-or-browser-road-network',
    roadNetworkCacheStatus: proxyMetadata?.cache_status || null,
    accessTopologyStatus: protectedGroups.status,
    accessTopology: Object.freeze({ ...protectedGroups.diagnostics }),
    polygon: Object.freeze(polygon.map((point) => Object.freeze({ ...point }))),
    get dijkstraRunCount() {
      return roadContext.diagnostics.dijkstraRunCount;
    },
    get cachedSourceTreeCount() {
      return roadContext.diagnostics.cachedSourceTreeCount;
    },
    get roadCostQueryCount() {
      return roadCostQueryCount;
    },
    get roadCostFallbackCount() {
      return roadCostFallbackCount;
    },
    get roadCostFallbackReasons() {
      return frozenReasonCounts(fallbackReasons);
    },
    get doorToDoorRoadCostQueryCount() {
      return doorToDoorRoadCostQueryCount;
    },
    get doorToDoorRoadCostFallbackCount() {
      return doorToDoorRoadCostFallbackCount;
    },
    get doorToDoorRoadCostFallbackReasons() {
      return frozenReasonCounts(doorToDoorFallbackReasons);
    },
    get externalBoundRoadCostQueryCount() {
      return externalBoundRoadCostQueryCount;
    },
    get externalBoundRoadCostFallbackCount() {
      return externalBoundRoadCostFallbackCount;
    },
    get externalBoundRoadCostFallbackReasons() {
      return frozenReasonCounts(externalBoundFallbackReasons);
    },
  };

  return Object.freeze({
    status: roadContext.status,
    source: proxyMetadata?.proxied === true
      ? 'osm-road-network-proxy'
      : 'osm-road-network',
    roadAware: true,
    costOnly: false,
    mode: 'full',
    distanceBetween(left, right) {
      return evaluateRoute(left, right).distanceMiles;
    },
    distanceBetweenMeters(left, right) {
      return evaluateRoute(left, right).distanceMeters;
    },
    routeBetween: evaluateRoute,
    pathBetween(left, right) {
      return evaluateRoute(left, right).path.map((point) => ({ ...point }));
    },
    snapFor: roadContext.snapFor,
    streetSegmentKey: roadContext.streetSegmentKey,
    roadComponentKey: roadContext.roadComponentKey,
    accessGroupKey(property) {
      const explicit = explicitAccessKey(property, roadContext);
      if (explicit) return explicit;
      return protectedGroups.keyByProperty.get(propertyIdentity(property)) || '';
    },
    diagnostics: Object.freeze(diagnostics),
  });
}

/**
 * Fetches the road graph once, then returns the synchronous context consumed by
 * routeOptimizer. External start/home points are allowed to fall back when they
 * sit outside the local road window; door-to-door transitions remain road-aware.
 */
export async function createRouteRoadContext(properties, options = {}) {
  const validProperties = (Array.isArray(properties) ? properties : [])
    .filter((property) => pointFrom(property));
  if (validProperties.length < 2) {
    return fallbackContext(validProperties, 'TOO_FEW_POINTS');
  }

  const maxRoutePoints = Math.max(
    2,
    Math.floor(Number(options.maxRoutePoints) || DEFAULT_MAX_COST_ONLY_POINTS),
  );
  const maxFullRoutePoints = Math.min(
    maxRoutePoints,
    Math.max(
      2,
      Math.floor(Number(options.maxFullRoutePoints) || DEFAULT_MAX_FULL_ROUTE_POINTS),
    ),
  );
  const requestedMode = validProperties.length > maxFullRoutePoints
    ? 'cost-only'
    : 'full';
  if (validProperties.length > maxRoutePoints) {
    return fallbackContext(validProperties, 'POINT_LIMIT_EXCEEDED', null, {
      requestedMode,
      maxRoutePoints,
    });
  }

  const blockPlan = requestedMode === 'cost-only'
    ? buildCostOnlyBlockPlan(validProperties)
    : null;
  const maxCostOnlyBlocks = Math.max(
    2,
    Math.floor(Number(options.maxCostOnlyBlocks) || DEFAULT_MAX_COST_ONLY_BLOCKS),
  );
  if (blockPlan && blockPlan.blockCount > maxCostOnlyBlocks) {
    return fallbackContext(validProperties, 'COST_ONLY_BLOCK_LIMIT_EXCEEDED', null, {
      requestedMode,
      representativeBlockCount: blockPlan.blockCount,
      maxCostOnlyBlocks,
    });
  }

  const polygon = routeBoundsPolygon(validProperties, options.paddingMiles);
  const fetchRoadNetwork = options.fetchRoadNetwork || fetchRouteRoadNetwork;
  try {
    const roadNetwork = await fetchRoadNetwork(polygon, {
      highwayFilter: ROUTE_HIGHWAY_FILTER,
      includeGradeSeparated: true,
      timeoutMs: options.timeoutMs || 12000,
      overallTimeoutMs: options.overallTimeoutMs || 40000,
      cacheMaxAgeMs: options.cacheMaxAgeMs || 30 * 60 * 1000,
      maxElements: options.maxElements || 150000,
      maxTotalBytes: options.maxTotalBytes || 16_000_000,
      signal: options.signal,
    });
    const roadContext = createRoadNetworkRoutingContext({
      roadNetwork,
      properties: blockPlan?.representatives || validProperties,
      startLocation: options.startLocation,
      endLocation: options.endLocation,
      maxSnapDistanceMeters: options.maxSnapDistanceMeters || 300,
      fallbackRoadFactor: options.fallbackRoadFactor || 1.3,
    });
    if (!roadContext.diagnostics.routableSegmentCount) {
      return fallbackContext(validProperties, 'NO_ROUTABLE_ROADS', null, {
        requestedMode,
        representativeBlockCount: blockPlan?.blockCount || null,
      });
    }

    if (blockPlan) {
      const snappedRepresentativeCount = blockPlan.representatives
        .filter((representative) => roadContext.snapFor(representative))
        .length;
      if (snappedRepresentativeCount !== blockPlan.representatives.length) {
        return fallbackContext(validProperties, 'INCOMPLETE_SNAPPED_COST_BLOCKS', null, {
          requestedMode,
          representativeBlockCount: blockPlan.blockCount,
          representativePointCount: blockPlan.representatives.length,
          snappedRepresentativeCount,
        });
      }
      return costOnlyContext({
        properties: validProperties,
        roadContext,
        blockPlan,
        polygon,
        proxyMetadata: roadNetwork?._route_proxy || null,
        snappedRepresentativeCount,
      });
    }

    const snappedPropertyCount = validProperties
      .filter((property) => roadContext.snapFor(property))
      .length;
    if (snappedPropertyCount !== validProperties.length) {
      return fallbackContext(validProperties, 'INCOMPLETE_SNAPPED_ROUTE_PROPERTIES', null, {
        requestedMode,
        snappedPropertyCount,
        propertyPointCount: validProperties.length,
      });
    }

    const proxyMetadata = roadNetwork?._route_proxy || null;
    const protectedGroups = buildProtectedAccessGroups({
      properties: validProperties,
      roadNetwork,
      polygon,
      roadContext,
    });
    return fullRoadContext({
      properties: validProperties,
      roadContext,
      protectedGroups,
      polygon,
      proxyMetadata,
      requestedMode,
    });
  } catch (error) {
    console.warn('[routeRoadContext] Road network unavailable; using continuity fallback.', error);
    return fallbackContext(validProperties, 'ROAD_NETWORK_UNAVAILABLE', error, {
      requestedMode,
      representativeBlockCount: blockPlan?.blockCount || null,
    });
  }
}

export function calculateRoadAwareRouteMiles(
  properties,
  routingContext,
  { startLocation = null, endLocation = null } = {},
) {
  if (routingContext?.costOnly === true) return null;
  const points = [
    pointFrom(startLocation) ? startLocation : null,
    ...(Array.isArray(properties) ? properties : []),
    pointFrom(endLocation) ? endLocation : null,
  ].filter(Boolean);
  if (points.length < 2 || typeof routingContext?.distanceBetween !== 'function') return null;
  let meters = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const distance = Number(routingContext.distanceBetweenMeters?.(points[index], points[index + 1]));
    if (!Number.isFinite(distance)) return null;
    meters += distance;
  }
  return meters / METERS_PER_MILE;
}

export function buildRoadRouteGeometry(
  properties,
  routingContext,
  { startLocation = null, endLocation = null, maxPoints = 12000 } = {},
) {
  if (!routingContext?.roadAware || typeof routingContext.routeBetween !== 'function') return null;
  const points = [
    pointFrom(startLocation) ? startLocation : null,
    ...(Array.isArray(properties) ? properties : []),
    pointFrom(endLocation) ? endLocation : null,
  ].filter(Boolean);
  const geometry = [];
  const append = (point) => {
    const normalized = pointFrom(point);
    if (!normalized) return;
    const previous = geometry[geometry.length - 1];
    if (previous && previous.lat === normalized.lat && previous.lng === normalized.lng) return;
    geometry.push(normalized);
  };
  for (let index = 0; index < points.length - 1; index += 1) {
    const leg = routingContext.routeBetween(points[index], points[index + 1]);
    if (!leg || leg.usedFallback || !Array.isArray(leg.path)) return null;
    leg.path.forEach(append);
    if (geometry.length > maxPoints) return null;
  }
  return geometry.length > 1 ? geometry : null;
}

export function buildPersistedRoadRoutingMetadata(
  routingContext,
  geometry = null,
  propertiesOrHashes = null,
) {
  const diagnostics = routingContext?.diagnostics || {};
  const propertyOrderFingerprint = routePropertyOrderFingerprint(propertiesOrHashes);
  return {
    routing: {
      engine: routingContext?.source || 'aerial-fallback',
      status: routingContext?.status || 'unavailable',
      road_aware: routingContext?.roadAware === true,
      mode: routingContext?.mode || diagnostics.mode || 'fallback',
      cost_only: routingContext?.costOnly === true,
      distance_estimate: routingContext?.costOnly === true
        ? 'aerial-door-path'
        : routingContext?.roadAware === true
          ? 'road-network'
          : 'aerial',
      snapped_point_count: Number(diagnostics.snappedPointCount) || 0,
      supplied_point_count: Number(diagnostics.suppliedPointCount) || 0,
      input_point_count: Number(
        diagnostics.originalPointCount ?? diagnostics.suppliedPointCount,
      ) || 0,
      road_component_count: Number(diagnostics.roadComponentCount) || 0,
      representative_block_count: Number(diagnostics.representativeBlockCount) || 0,
      representative_point_count: Number(diagnostics.representativePointCount) || 0,
      road_cost_query_count: Number(diagnostics.roadCostQueryCount) || 0,
      road_cost_fallback_count: Number(diagnostics.roadCostFallbackCount) || 0,
      block_to_block_road_cost_query_count: Number(
        diagnostics.blockToBlockRoadCostQueryCount,
      ) || 0,
      block_to_block_road_cost_fallback_count: Number(
        diagnostics.blockToBlockRoadCostFallbackCount,
      ) || 0,
      door_to_door_road_cost_query_count: Number(
        diagnostics.doorToDoorRoadCostQueryCount,
      ) || 0,
      door_to_door_road_cost_fallback_count: Number(
        diagnostics.doorToDoorRoadCostFallbackCount,
      ) || 0,
      external_bound_road_cost_query_count: Number(
        diagnostics.externalBoundRoadCostQueryCount,
      ) || 0,
      external_bound_road_cost_fallback_count: Number(
        diagnostics.externalBoundRoadCostFallbackCount,
      ) || 0,
      protected_access_group_count: Number(
        diagnostics.accessTopology?.protectedAccessGroupCount,
      ) || 0,
      ...(propertyOrderFingerprint
        ? { property_order_fingerprint: propertyOrderFingerprint }
        : {}),
      optimized_at: new Date().toISOString(),
    },
    ...(Array.isArray(geometry) && geometry.length > 1
      ? { road_geometry: geometry }
      : {}),
  };
}

export const routeRoadContextInternals = Object.freeze({
  explicitAreaLabel,
  routeBoundsPolygon,
});