import {
  canonicalStringify,
  canonicalTileAddress,
  canonicalTileId,
  canonicalWorkUnitDescriptor,
  canonicalWorkUnitId,
} from './contract.mjs';
import { normalizeCanvasProperties } from './property-normalizer.mjs';

export const CANVAS_SOURCE_EVIDENCE_SCHEMA = Object.freeze({
  tile: 'firstknock.canvas-source-evidence-tile',
  version: 1,
});

export const CANVAS_SOURCE_ROLES = Object.freeze([
  'knock',
  'transit_only',
  'excluded',
  'uncertain',
]);

export const DEFAULT_MAX_NEAREST_ROAD_METERS = 60;

const NORMALIZED_TILE_SCHEMA = 'firstknock.canvas-normalized-evidence-tile';
const ASSOCIATION_PRIORITY = Object.freeze({
  address_street: 1,
  entrance_driveway: 2,
  side_of_street: 3,
  nearest_road: 4,
});
const DIRECT_ASSOCIATION_METHODS = new Set(['area_overlap', 'network_link']);
const ROAD_CLASSES = new Set([
  'residential',
  'living_street',
  'service',
  'unclassified',
  'tertiary',
  'secondary',
  'primary',
  'tertiary_link',
  'secondary_link',
  'primary_link',
  'trunk',
  'trunk_link',
  'motorway',
  'motorway_link',
  'pedestrian',
  'path',
  'footway',
  'cycleway',
  'track',
  'unknown',
]);
const LEGAL_ACCESS = new Set(['public', 'permitted', 'denied', 'unknown']);
const ADDRESS_OCCUPANCY = new Set(['residential', 'commercial', 'mixed', 'unknown']);
const BUILDING_USES = new Set([
  'yes',
  'house',
  'detached',
  'semidetached_house',
  'terrace',
  'residential',
  'apartments',
  'dormitory',
  'mixed_use',
  'commercial',
  'retail',
  'office',
  'warehouse',
  'industrial',
  'hotel',
  'school',
  'hospital',
  'civic',
  'public',
  'religious',
  'garage',
  'garages',
  'nonresidential',
]);
const SITE_USES = new Set([
  'residential',
  'apartments',
  'mixed_use',
  'commercial',
  'retail',
  'office',
  'warehouse',
  'industrial',
  'agricultural',
  'institutional',
  'education',
  'healthcare',
  'government',
  'religious',
  'parking',
  'recreation',
  'nonresidential',
  'unknown',
]);
const ENTRANCE_USES = new Set(['residential', 'mixed', 'commercial', 'unknown']);
const ENTRANCE_TYPES = new Set(['main', 'home', 'staircase', 'service', 'unknown']);
const LAND_USES = new Set([
  'residential',
  'mixed_use',
  'commercial',
  'retail',
  'office',
  'industrial',
  'farmland',
  'farmyard',
  'meadow',
  'orchard',
  'forest',
  'quarry',
  'construction',
  'institutional',
  'education',
  'healthcare',
  'military',
  'cemetery',
  'recreation',
  'parking',
]);
const PLACE_USES = new Set([
  'residential',
  'mixed_use',
  'shop',
  'commercial',
  'retail',
  'office',
  'warehouse',
  'industrial',
  'school',
  'university',
  'hospital',
  'institutional',
  'government',
  'religious',
  'hotel',
  'parking',
  'sports',
  'nonresidential',
]);
const PEDESTRIAN_ACCESS = new Set(['allowed', 'denied', 'unknown']);
const RESIDENTIAL_BUILDINGS = new Set([
  'house',
  'detached',
  'semidetached_house',
  'terrace',
  'residential',
  'apartments',
  'dormitory',
  'mixed_use',
]);
const MULTI_UNIT_BUILDINGS = new Set(['apartments', 'dormitory']);
const NEGATIVE_BUILDINGS = new Set([
  'commercial', 'retail', 'office', 'warehouse', 'industrial', 'hotel', 'school', 'hospital',
  'civic', 'public', 'religious', 'garage', 'garages', 'nonresidential',
]);
const NEGATIVE_SITES = new Set([
  'commercial', 'retail', 'office', 'warehouse', 'industrial', 'agricultural', 'institutional',
  'education', 'healthcare', 'government', 'religious', 'parking', 'recreation', 'nonresidential',
]);
const NEGATIVE_LAND_USES = new Set([
  'commercial',
  'retail',
  'office',
  'industrial',
  'farmland',
  'farmyard',
  'meadow',
  'orchard',
  'forest',
  'quarry',
  'construction',
  'institutional',
  'education',
  'healthcare',
  'military',
  'cemetery',
  'recreation',
  'parking',
]);
const NEGATIVE_PLACES = new Set([
  'shop', 'commercial', 'retail', 'office', 'warehouse', 'industrial', 'school', 'university',
  'hospital', 'institutional', 'government', 'religious', 'hotel', 'parking', 'sports', 'nonresidential',
]);

export class CanvasSourceNormalizationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CanvasSourceNormalizationError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new CanvasSourceNormalizationError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, field) {
  if (!isRecord(value)) fail('invalid_record', `${field} must be an object.`, { field });
  return value;
}

function requireArray(value, field, { nonempty = false } = {}) {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) {
    fail('invalid_array', `${field} must be ${nonempty ? 'a non-empty' : 'an'} array.`, { field });
  }
  return value;
}

function requireString(value, field, { pattern, maxLength = 256 } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.length > maxLength) {
    fail('invalid_string', `${field} must be a non-empty, trimmed string.`, { field });
  }
  if (pattern && !pattern.test(value)) fail('invalid_identifier', `${field} is not canonical.`, { field, value });
  return value;
}

function requireNumber(value, field, { min = -Infinity, max = Infinity } = {}) {
  if (!Number.isFinite(value) || value < min || value > max) {
    fail('invalid_number', `${field} must be a finite number from ${min} through ${max}.`, { field, value });
  }
  return value;
}

function requireInteger(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('invalid_integer', `${field} must be an integer from ${min} through ${max}.`, { field, value });
  }
  return value;
}

function requireEnum(value, allowed, field) {
  requireString(value, field);
  if (!allowed.has(value)) fail('invalid_enum', `${field} has an unsupported value.`, { field, value });
  return value;
}

function assertAllowedKeys(value, allowed, field) {
  requireRecord(value, field);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('unknown_source_field', `${field}.${key} is not part of source evidence v1.`, { field: `${field}.${key}` });
  }
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function identityDetails(value, field) {
  try {
    const identity = canonicalWorkUnitDescriptor(value);
    return { identity, id: canonicalWorkUnitId(identity) };
  } catch (error) {
    fail('invalid_work_unit_identity', `${field} is invalid: ${error.message}`, { field });
  }
}

function validateBounds(value, field) {
  assertAllowedKeys(value, new Set(['min_lng', 'min_lat', 'max_lng', 'max_lat']), field);
  const bounds = {
    min_lng: requireNumber(value.min_lng, `${field}.min_lng`, { min: -180, max: 180 }),
    min_lat: requireNumber(value.min_lat, `${field}.min_lat`, { min: -90, max: 90 }),
    max_lng: requireNumber(value.max_lng, `${field}.max_lng`, { min: -180, max: 180 }),
    max_lat: requireNumber(value.max_lat, `${field}.max_lat`, { min: -90, max: 90 }),
  };
  if (bounds.min_lng >= bounds.max_lng || bounds.min_lat >= bounds.max_lat) {
    fail('invalid_bounds', `${field} must have increasing coordinates.`, { field });
  }
  return bounds;
}

function validateCoverage(value, field) {
  assertAllowedKeys(value, new Set(['area_sq_mi', 'bounds']), field);
  return {
    area_sq_mi: requireNumber(value.area_sq_mi, `${field}.area_sq_mi`, { min: Number.EPSILON }),
    bounds: validateBounds(value.bounds, `${field}.bounds`),
  };
}

function validateGeometry(value, bounds, field) {
  assertAllowedKeys(value, new Set(['type', 'coordinates']), field);
  if (value.type !== 'LineString') fail('invalid_geometry', `${field}.type must be LineString.`, { field });
  const coordinates = requireArray(value.coordinates, `${field}.coordinates`, { nonempty: true });
  if (coordinates.length < 2 || coordinates.length > 2_048) {
    fail('invalid_geometry', `${field}.coordinates must have 2 through 2,048 positions.`, { field });
  }
  return {
    type: 'LineString',
    coordinates: coordinates.map((position, index) => {
      if (!Array.isArray(position) || position.length !== 2) {
        fail('invalid_coordinate', `${field}.coordinates[${index}] must be [longitude, latitude].`, { field, index });
      }
      const longitude = requireNumber(position[0], `${field}.coordinates[${index}][0]`, { min: -180, max: 180 });
      const latitude = requireNumber(position[1], `${field}.coordinates[${index}][1]`, { min: -90, max: 90 });
      if (
        longitude < bounds.min_lng - 1e-9
        || longitude > bounds.max_lng + 1e-9
        || latitude < bounds.min_lat - 1e-9
        || latitude > bounds.max_lat + 1e-9
      ) {
        fail('geometry_outside_tile', `${field}.coordinates[${index}] is outside the tile bounds.`, { field, index });
      }
      return [longitude, latitude];
    }),
  };
}

function validatePoint(value, bounds, field) {
  assertAllowedKeys(value, new Set(['lat', 'lng']), field);
  const point = {
    lat: requireNumber(value.lat, `${field}.lat`, { min: bounds.min_lat, max: bounds.max_lat }),
    lng: requireNumber(value.lng, `${field}.lng`, { min: bounds.min_lng, max: bounds.max_lng }),
  };
  return point;
}

function validateInstant(value, field) {
  requireString(value, field);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    fail('invalid_instant', `${field} must be a canonical UTC ISO-8601 instant.`, { field, value });
  }
  return value;
}

function validateProvenance(value, field) {
  const records = requireArray(value, field, { nonempty: true }).map((raw, index) => {
    const path = `${field}[${index}]`;
    assertAllowedKeys(raw, new Set(['source_id', 'dataset_version', 'feature_id', 'observed_at', 'license']), path);
    return {
      source_id: requireString(raw.source_id, `${path}.source_id`, {
        pattern: /^[a-z][a-z0-9._-]{0,127}$/,
        maxLength: 128,
      }),
      dataset_version: requireString(raw.dataset_version, `${path}.dataset_version`, { maxLength: 128 }),
      feature_id: requireString(raw.feature_id, `${path}.feature_id`, { maxLength: 256 }),
      observed_at: validateInstant(raw.observed_at, `${path}.observed_at`),
      license: requireString(raw.license, `${path}.license`, { maxLength: 256 }),
    };
  });
  const byKey = new Map();
  for (const record of records) {
    const key = `${record.source_id}\u0000${record.dataset_version}\u0000${record.feature_id}`;
    const existing = byKey.get(key);
    if (existing && canonicalStringify(existing) !== canonicalStringify(record)) {
      fail('conflicting_provenance', `${field} contains conflicting records for the same source feature.`, { field });
    }
    byKey.set(key, record);
  }
  return [...byKey.values()].sort((left, right) => (
    `${left.source_id}\u0000${left.dataset_version}\u0000${left.feature_id}`
      .localeCompare(`${right.source_id}\u0000${right.dataset_version}\u0000${right.feature_id}`)
  ));
}

function mergeProvenance(records, field) {
  return validateProvenance(records.flat(), field);
}

function validateNeighbor(raw, field) {
  assertAllowedKeys(raw, new Set(['identity', 'scope']), field);
  const { identity, id } = identityDetails(raw.identity, `${field}.identity`);
  if (raw.scope !== 'release' && raw.scope !== 'outside_release') {
    fail('invalid_neighbor_scope', `${field}.scope must be release or outside_release.`, { field });
  }
  return { identity, id, scope: raw.scope };
}

function validateRoad(raw, bounds, index) {
  const field = `source_tile.road_segments[${index}]`;
  assertAllowedKeys(raw, new Set([
    'identity',
    'geometry',
    'road_class',
    'legal_access',
    'provenance',
    'neighbors',
  ]), field);
  const { identity, id } = identityDetails(raw.identity, `${field}.identity`);
  const neighbors = requireArray(raw.neighbors, `${field}.neighbors`).map((neighbor, neighborIndex) => (
    validateNeighbor(neighbor, `${field}.neighbors[${neighborIndex}]`)
  ));
  if (new Set(neighbors.map((neighbor) => neighbor.id)).size !== neighbors.length) {
    fail('duplicate_neighbor', `${field}.neighbors contains a duplicate work unit.`, { work_unit_id: id });
  }
  if (neighbors.some((neighbor) => neighbor.id === id)) fail('self_neighbor', `${field} cannot reference itself.`, { work_unit_id: id });
  return {
    identity,
    id,
    geometry: validateGeometry(raw.geometry, bounds, `${field}.geometry`),
    roadClass: requireEnum(raw.road_class, ROAD_CLASSES, `${field}.road_class`),
    legalAccess: requireEnum(raw.legal_access, LEGAL_ACCESS, `${field}.legal_access`),
    provenance: validateProvenance(raw.provenance, `${field}.provenance`),
    neighbors: neighbors.sort((left, right) => left.id.localeCompare(right.id)),
    evidence: [],
  };
}

function validateAttributes(kind, raw, field) {
  requireRecord(raw, field);
  if (kind === 'address') {
    assertAllowedKeys(raw, new Set(['address_key', 'normalized_address', 'display_address', 'unit_keys', 'occupancy']), field);
    const unitKeys = raw.unit_keys === undefined
      ? []
      : requireArray(raw.unit_keys, `${field}.unit_keys`).map((key, index) => (
        requireString(key, `${field}.unit_keys[${index}]`, { maxLength: 256 })
      ));
    if (new Set(unitKeys).size !== unitKeys.length) fail('duplicate_unit_key', `${field}.unit_keys contains duplicates.`, { field });
    return {
      address_key: requireString(raw.address_key, `${field}.address_key`, { maxLength: 256 }),
      ...(raw.normalized_address === undefined ? {} : { normalized_address: requireString(raw.normalized_address, `${field}.normalized_address`, { maxLength: 500 }) }),
      ...(raw.display_address === undefined ? {} : { display_address: requireString(raw.display_address, `${field}.display_address`, { maxLength: 500 }) }),
      unit_keys: [...unitKeys].sort(),
      occupancy: requireEnum(raw.occupancy, ADDRESS_OCCUPANCY, `${field}.occupancy`),
    };
  }
  if (kind === 'building') {
    assertAllowedKeys(raw, new Set(['building_use', 'unit_count']), field);
    const result = { building_use: requireEnum(raw.building_use, BUILDING_USES, `${field}.building_use`) };
    if (raw.unit_count !== undefined) result.unit_count = requireInteger(raw.unit_count, `${field}.unit_count`, { min: 1, max: 100_000 });
    return result;
  }
  if (kind === 'site') {
    assertAllowedKeys(raw, new Set(['site_use', 'unit_count']), field);
    const result = { site_use: requireEnum(raw.site_use, SITE_USES, `${field}.site_use`) };
    if (raw.unit_count !== undefined) result.unit_count = requireInteger(raw.unit_count, `${field}.unit_count`, { min: 1, max: 100_000 });
    return result;
  }
  if (kind === 'entrance') {
    assertAllowedKeys(raw, new Set(['entrance_key', 'entrance_type', 'use']), field);
    return {
      entrance_key: requireString(raw.entrance_key, `${field}.entrance_key`, { maxLength: 256 }),
      entrance_type: requireEnum(raw.entrance_type, ENTRANCE_TYPES, `${field}.entrance_type`),
      use: requireEnum(raw.use, ENTRANCE_USES, `${field}.use`),
    };
  }
  if (kind === 'land_use') {
    assertAllowedKeys(raw, new Set(['land_use']), field);
    return { land_use: requireEnum(raw.land_use, LAND_USES, `${field}.land_use`) };
  }
  if (kind === 'place') {
    assertAllowedKeys(raw, new Set(['place_use']), field);
    return { place_use: requireEnum(raw.place_use, PLACE_USES, `${field}.place_use`) };
  }
  if (kind === 'access') {
    assertAllowedKeys(raw, new Set(['pedestrian_access']), field);
    return { pedestrian_access: requireEnum(raw.pedestrian_access, PEDESTRIAN_ACCESS, `${field}.pedestrian_access`) };
  }
  if (kind === 'barrier') {
    assertAllowedKeys(raw, new Set(['barrier_type', 'pedestrian_access']), field);
    return {
      barrier_type: requireString(raw.barrier_type, `${field}.barrier_type`, { maxLength: 80 }),
      pedestrian_access: requireEnum(raw.pedestrian_access, PEDESTRIAN_ACCESS, `${field}.pedestrian_access`),
    };
  }
  fail('invalid_evidence_kind', `${field} belongs to an unsupported evidence kind.`, { field, kind });
}

function validateAssociation(raw, field, roadById, maxNearestRoadMeters) {
  assertAllowedKeys(raw, new Set(['method', 'road_identity', 'distance_m']), field);
  const method = requireString(raw.method, `${field}.method`);
  if (!(method in ASSOCIATION_PRIORITY) && !DIRECT_ASSOCIATION_METHODS.has(method)) {
    fail('invalid_association_method', `${field}.method is unsupported.`, { field, method });
  }
  const { identity, id } = identityDetails(raw.road_identity, `${field}.road_identity`);
  if (!roadById.has(id)) fail('association_outside_tile', `${field} references a road absent from this tile.`, { road_id: id });
  if (method === 'nearest_road') {
    const distance = requireNumber(raw.distance_m, `${field}.distance_m`, { min: 0 });
    if (distance > maxNearestRoadMeters) {
      fail('nearest_road_out_of_range', `${field} exceeds the configured nearest-road fallback limit.`, {
        distance_m: distance,
        limit_m: maxNearestRoadMeters,
      });
    }
    return { method, identity, id, distance };
  }
  if (raw.distance_m !== undefined) fail('unexpected_distance', `${field}.distance_m is allowed only for nearest_road.`, { field });
  return { method, identity, id };
}

function chooseAssociationRoads(kind, associations, field) {
  const contextualMethod = kind === 'land_use' || kind === 'place' ? 'area_overlap' : 'network_link';
  if (kind === 'land_use' || kind === 'place' || kind === 'access' || kind === 'barrier') {
    if (associations.some((association) => association.method !== contextualMethod)) {
      fail('invalid_context_association', `${field} must use ${contextualMethod} associations.`, { field, kind });
    }
    return [...new Set(associations.map((association) => association.id))].sort();
  }
  if (associations.some((association) => !(association.method in ASSOCIATION_PRIORITY))) {
    fail('invalid_feature_association', `${field} must use the street-association hierarchy.`, { field, kind });
  }
  const priority = Math.min(...associations.map((association) => ASSOCIATION_PRIORITY[association.method]));
  const best = [...new Set(associations
    .filter((association) => ASSOCIATION_PRIORITY[association.method] === priority)
    .map((association) => association.id))].sort();
  if (best.length !== 1) {
    fail('ambiguous_evidence_association', `${field} has more than one road at its strongest association level.`, {
      field,
      road_ids: best,
    });
  }
  return best;
}

function validateEvidence(raw, index, roadById, bounds, maxNearestRoadMeters) {
  const field = `source_tile.evidence[${index}]`;
  assertAllowedKeys(raw, new Set(['evidence_id', 'kind', 'property_key', 'location', 'attributes', 'associations', 'provenance']), field);
  const evidenceId = requireString(raw.evidence_id, `${field}.evidence_id`, {
    pattern: /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/,
  });
  const kind = requireString(raw.kind, `${field}.kind`);
  const attributes = validateAttributes(kind, raw.attributes, `${field}.attributes`);
  const associations = requireArray(raw.associations, `${field}.associations`, { nonempty: true }).map((association, associationIndex) => (
    validateAssociation(association, `${field}.associations[${associationIndex}]`, roadById, maxNearestRoadMeters)
  ));
  const roadIds = chooseAssociationRoads(kind, associations, `${field}.associations`);
  const propertyKey = raw.property_key === undefined ? null : requireString(raw.property_key, `${field}.property_key`, { maxLength: 256 });
  if (raw.location !== undefined && !propertyKey) fail('property_key_missing', `${field}.location requires property_key.`, { field });
  return {
    evidenceId,
    kind,
    attributes,
    roadIds,
    propertyKey,
    associations,
    location: raw.location === undefined ? null : validatePoint(raw.location, bounds, `${field}.location`),
    provenance: validateProvenance(raw.provenance, `${field}.provenance`),
  };
}

function positiveUse(feature) {
  if (feature.kind === 'address') return feature.attributes.occupancy === 'residential' || feature.attributes.occupancy === 'mixed';
  if (feature.kind === 'building') return RESIDENTIAL_BUILDINGS.has(feature.attributes.building_use);
  if (feature.kind === 'site') return ['residential', 'apartments', 'mixed_use'].includes(feature.attributes.site_use);
  if (feature.kind === 'entrance') return feature.attributes.use === 'residential' || feature.attributes.use === 'mixed';
  if (feature.kind === 'land_use') return feature.attributes.land_use === 'residential' || feature.attributes.land_use === 'mixed_use';
  if (feature.kind === 'place') return feature.attributes.place_use === 'residential' || feature.attributes.place_use === 'mixed_use';
  return false;
}

function negativeUse(feature) {
  if (feature.kind === 'address') return feature.attributes.occupancy === 'commercial';
  if (feature.kind === 'building') return NEGATIVE_BUILDINGS.has(feature.attributes.building_use);
  if (feature.kind === 'site') return NEGATIVE_SITES.has(feature.attributes.site_use);
  if (feature.kind === 'entrance') return feature.attributes.use === 'commercial';
  if (feature.kind === 'land_use') return NEGATIVE_LAND_USES.has(feature.attributes.land_use);
  if (feature.kind === 'place') return NEGATIVE_PLACES.has(feature.attributes.place_use);
  return false;
}

function opportunityFromAddresses(features, residentialSupported) {
  const tokens = new Set();
  for (const feature of features) {
    if (feature.kind !== 'address') continue;
    const occupancy = feature.attributes.occupancy;
    if (occupancy !== 'residential' && occupancy !== 'mixed' && !(occupancy === 'unknown' && residentialSupported)) continue;
    if (feature.attributes.unit_keys.length > 0) {
      for (const unitKey of feature.attributes.unit_keys) tokens.add(`unit:${feature.attributes.address_key}:${unitKey}`);
    } else {
      tokens.add(`address:${feature.attributes.address_key}`);
    }
  }
  if (tokens.size === 0) return null;
  return {
    opportunity: { min: tokens.size, expected: tokens.size, max: tokens.size },
    basis: 'deduplicated_address_units',
    score: 0.95,
    ownershipKeys: [...tokens].sort(),
  };
}

function opportunityFromExplicitUnits(features) {
  let units = 0;
  for (const feature of features) {
    if (!positiveUse(feature)) continue;
    if ((feature.kind === 'building' || feature.kind === 'site') && feature.attributes.unit_count !== undefined) {
      units += feature.attributes.unit_count;
    }
  }
  if (units === 0) return null;
  return {
    opportunity: { min: units, expected: units, max: units },
    basis: 'explicit_unit_count',
    score: 0.92,
    ownershipKeys: [],
  };
}

function opportunityFromEntrances(features) {
  const entranceKeys = new Set();
  for (const feature of features) {
    if (feature.kind !== 'entrance' || !positiveUse(feature) || feature.attributes.entrance_type === 'service') continue;
    entranceKeys.add(feature.attributes.entrance_key);
  }
  if (entranceKeys.size === 0) return null;
  return {
    opportunity: { min: entranceKeys.size, expected: entranceKeys.size, max: entranceKeys.size * 2 },
    basis: 'residential_entrances',
    score: 0.8,
    ownershipKeys: [],
  };
}

function opportunityFromFootprints(features) {
  let min = 0;
  let expected = 0;
  let max = 0;
  let count = 0;
  let apartmentSites = 0;
  for (const feature of features) {
    if (feature.kind !== 'building' && feature.kind !== 'site') continue;
    if (!positiveUse(feature) || feature.attributes.unit_count !== undefined) continue;
    const use = feature.kind === 'building' ? feature.attributes.building_use : feature.attributes.site_use;
    count += 1;
    if (MULTI_UNIT_BUILDINGS.has(use) || use === 'apartments') {
      apartmentSites += 1;
      min += 1;
      expected += 8;
      max += 40;
    } else if (use === 'mixed_use') {
      min += 1;
      expected += 3;
      max += 12;
    } else {
      min += 1;
      expected += 1;
      max += 1;
    }
  }
  if (count === 0) return null;
  return {
    opportunity: { min, expected, max },
    basis: apartmentSites > 0 ? 'residential_footprints_with_wide_multi_unit_sites' : 'residential_footprints',
    score: apartmentSites > 0 ? 0.58 : 0.7,
    ownershipKeys: [],
  };
}

function classifyResidential(features) {
  const positive = features.filter(positiveUse);
  const negative = features.filter(negativeUse);
  const genericBuildings = features.filter((feature) => (
    feature.kind === 'building' && feature.attributes.building_use === 'yes'
  ));
  const explicitlyResidential = positive.some((feature) => !['land_use', 'place'].includes(feature.kind));
  const opportunity = opportunityFromAddresses(features, explicitlyResidential)
    || opportunityFromExplicitUnits(features)
    || opportunityFromEntrances(features)
    || opportunityFromFootprints(features);

  if (opportunity) {
    const mixed = positive.some((feature) => (
      (feature.kind === 'building' && feature.attributes.building_use === 'mixed_use')
      || (feature.kind === 'site' && feature.attributes.site_use === 'mixed_use')
      || (feature.kind === 'address' && feature.attributes.occupancy === 'mixed')
      || (feature.kind === 'land_use' && feature.attributes.land_use === 'mixed_use')
      || (feature.kind === 'place' && feature.attributes.place_use === 'mixed_use')
    ));
    return {
      state: 'opportunity',
      ...opportunity,
      reasons: [
        `opportunity_${opportunity.basis}`,
        ...(mixed || negative.length > 0 ? ['residential_mixed_use_preserved'] : ['residential_evidence']),
      ],
    };
  }
  if (negative.length > 0 && positive.length === 0) {
    return {
      state: 'excluded',
      opportunity: null,
      score: 0.9,
      reasons: ['commercial_industrial_or_nonresidential_land'],
      ownershipKeys: [],
    };
  }
  if (genericBuildings.length > 0) {
    return {
      state: 'uncertain',
      opportunity: null,
      score: 0.4,
      reasons: ['generic_building_use_unresolved'],
      ownershipKeys: [],
    };
  }
  if (positive.length > 0) {
    return {
      state: 'uncertain',
      opportunity: null,
      score: 0.45,
      reasons: ['residential_context_without_countable_site'],
      ownershipKeys: [],
    };
  }
  return {
    state: 'none',
    opportunity: null,
    score: 0.75,
    reasons: ['no_residential_opportunity_evidence'],
    ownershipKeys: [],
  };
}

function classifyAccess(road, features) {
  const baseline = road.legalAccess === 'public' || road.legalAccess === 'permitted'
    ? 'allowed'
    : road.legalAccess;
  const signals = [];
  for (const feature of features) {
    if (feature.kind === 'access' || feature.kind === 'barrier') signals.push(feature.attributes.pedestrian_access);
  }
  const allowed = signals.includes('allowed');
  const denied = signals.includes('denied');
  const unknown = signals.includes('unknown');
  if (allowed && denied) return { state: 'unknown', score: 0.3, reasons: ['conflicting_access_evidence'] };
  if ((baseline === 'allowed' && denied) || (baseline === 'denied' && allowed)) {
    return { state: 'unknown', score: 0.3, reasons: ['conflicting_access_evidence'] };
  }
  if (denied) return { state: 'denied', score: 0.98, reasons: ['pedestrian_access_denied'] };
  if (unknown && !allowed) return { state: 'unknown', score: 0.35, reasons: ['pedestrian_access_unresolved'] };
  if (allowed) return { state: 'allowed', score: 0.95, reasons: ['pedestrian_access_permitted'] };
  if (baseline === 'denied') return { state: 'denied', score: 0.98, reasons: ['pedestrian_access_denied'] };
  if (baseline === 'unknown') return { state: 'unknown', score: 0.35, reasons: ['pedestrian_access_unresolved'] };
  return { state: 'allowed', score: 0.95, reasons: [road.legalAccess === 'public' ? 'public_road_access' : 'pedestrian_access_permitted'] };
}

function confidenceScore(...scores) {
  return Math.round(Math.min(...scores) * 100) / 100;
}

function classifyCanvasSourceWorkUnit(road) {
  const residential = classifyResidential(road.evidence);
  const access = classifyAccess(road, road.evidence);
  let sourceRole;
  let opportunity = null;
  let score;
  if (access.state === 'denied') {
    sourceRole = 'excluded';
    score = access.score;
  } else if (access.state === 'unknown') {
    sourceRole = 'uncertain';
    score = access.score;
  } else if (residential.state === 'opportunity') {
    sourceRole = 'knock';
    opportunity = residential.opportunity;
    score = confidenceScore(residential.score, access.score);
  } else if (residential.state === 'excluded') {
    sourceRole = 'excluded';
    score = residential.score;
  } else if (residential.state === 'uncertain') {
    sourceRole = 'uncertain';
    score = residential.score;
  } else {
    sourceRole = 'transit_only';
    score = confidenceScore(residential.score, access.score);
  }
  const roleMap = {
    knock: 'opportunity',
    transit_only: 'transit',
    excluded: 'excluded',
    uncertain: 'uncertain',
  };
  return {
    source_role: sourceRole,
    canvas_role: roleMap[sourceRole],
    residential_state: residential.state,
    legal_access_state: access.state,
    opportunity_basis: residential.basis || null,
    opportunity,
    confidence: {
      score,
      reasons: [...new Set([...residential.reasons, ...access.reasons, `road_class_${road.roadClass}`])].sort(),
    },
    opportunity_ownership_keys: residential.ownershipKeys,
  };
}

function validateProtectedGroups(rawGroups, roadById) {
  const memberships = new Map();
  const groups = requireArray(rawGroups, 'source_tile.protected_groups').map((raw, index) => {
    const field = `source_tile.protected_groups[${index}]`;
    assertAllowedKeys(raw, new Set(['kind', 'members', 'entries']), field);
    if (raw.kind !== 'cul_de_sac') fail('invalid_protected_group_kind', `${field}.kind must be cul_de_sac.`, { field });
    const members = requireArray(raw.members, `${field}.members`, { nonempty: true }).map((identity, memberIndex) => (
      identityDetails(identity, `${field}.members[${memberIndex}]`)
    ));
    const entries = requireArray(raw.entries, `${field}.entries`, { nonempty: true }).map((identity, entryIndex) => (
      identityDetails(identity, `${field}.entries[${entryIndex}]`)
    ));
    const memberIds = new Set(members.map((member) => member.id));
    if (memberIds.size !== members.length) fail('duplicate_protected_member', `${field}.members contains duplicates.`, { field });
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) fail('duplicate_protected_entry', `${field}.entries contains duplicates.`, { field });
    for (const member of members) {
      if (!roadById.has(member.id)) fail('protected_group_crosses_tile', `${field} contains a non-local member.`, { work_unit_id: member.id });
      if (memberships.has(member.id)) fail('overlapping_protected_groups', `${field} overlaps another group.`, { work_unit_id: member.id });
      memberships.set(member.id, index);
    }
    for (const entry of entries) {
      if (!memberIds.has(entry.id)) fail('entry_outside_protected_group', `${field}.entries must be members.`, { work_unit_id: entry.id });
      const road = roadById.get(entry.id);
      if (!road.neighbors.some((neighbor) => !memberIds.has(neighbor.id))) {
        fail('invalid_cul_de_sac_entry', `${field} entry has no connection outside the protected group.`, { work_unit_id: entry.id });
      }
    }
    const visited = new Set([members[0].id]);
    const queue = [members[0].id];
    while (queue.length > 0) {
      const current = queue.shift();
      for (const neighbor of roadById.get(current).neighbors) {
        if (memberIds.has(neighbor.id) && !visited.has(neighbor.id)) {
          visited.add(neighbor.id);
          queue.push(neighbor.id);
        }
      }
    }
    if (visited.size !== memberIds.size) fail('disconnected_protected_group', `${field}.members must form one connected branch.`, { field });
    return {
      kind: 'cul_de_sac',
      members: members.sort((left, right) => left.id.localeCompare(right.id)).map((member) => member.identity),
      entries: entries.sort((left, right) => left.id.localeCompare(right.id)).map((entry) => entry.identity),
    };
  });
  return groups.sort((left, right) => canonicalStringify(left).localeCompare(canonicalStringify(right)));
}

function hasHardTransportationExclusion(unit) {
  if (unit?.canvas_role !== 'excluded') return false;
  const reasons = Array.isArray(unit?.confidence?.reasons) ? unit.confidence.reasons : [];
  return reasons.some((reason) => /(?:pedestrian|legal)_access_denied|access_barrier/.test(String(reason)));
}

export function applyPropertyWorkloadAuthority(workUnits, properties, { force = false } = {}) {
  const propertyAware = force || properties.some((property) => property.property_key.startsWith('fk-property-key-v1:'));
  if (!propertyAware) return workUnits;
  const eligibleDoorsByUnit = new Map();
  for (const property of properties) {
    if (property.canvass_eligibility !== 'eligible') continue;
    const id = canonicalWorkUnitId(property.work_unit_identity);
    eligibleDoorsByUnit.set(id, (eligibleDoorsByUnit.get(id) || 0) + property.door_count);
  }
  return workUnits.map((unit) => {
    const eligibleDoors = eligibleDoorsByUnit.get(canonicalWorkUnitId(unit.identity)) || 0;
    const context = { ...unit };
    delete context.opportunity;
    if (eligibleDoors) {
      return {
        ...context,
        canvas_role: 'opportunity',
        confidence: { score: 1, reasons: ['property_eligible_door_authority'] },
        opportunity: { min: eligibleDoors, expected: eligibleDoors, max: eligibleDoors },
      };
    }
    if (hasHardTransportationExclusion(unit)) return context;
    return {
      ...context,
      canvas_role: 'transit',
      confidence: { score: 0.9, reasons: ['property_no_eligible_doors'] },
    };
  });
}

function normalizeTileInternal(rawInput, { maxNearestRoadMeters = DEFAULT_MAX_NEAREST_ROAD_METERS } = {}) {
  const raw = requireRecord(rawInput, 'source_tile');
  assertAllowedKeys(raw, new Set([
    'schema',
    'schema_version',
    'tile_address',
    'coverage',
    'road_segments',
    'evidence',
    'protected_groups',
  ]), 'source_tile');
  if (raw.schema !== CANVAS_SOURCE_EVIDENCE_SCHEMA.tile || raw.schema_version !== CANVAS_SOURCE_EVIDENCE_SCHEMA.version) {
    fail('unsupported_source_schema', 'Source evidence must use the v1 tile schema.');
  }
  requireNumber(maxNearestRoadMeters, 'options.maxNearestRoadMeters', { min: 1, max: 1_000 });
  let tileAddress;
  try {
    tileAddress = canonicalTileAddress(raw.tile_address);
  } catch (error) {
    fail('invalid_tile_address', `source_tile.tile_address is invalid: ${error.message}`);
  }
  const coverage = validateCoverage(raw.coverage, 'source_tile.coverage');
  const roads = requireArray(raw.road_segments, 'source_tile.road_segments', { nonempty: true })
    .map((road, index) => validateRoad(road, coverage.bounds, index));
  const roadById = new Map();
  for (const road of roads) {
    if (roadById.has(road.id)) fail('duplicate_work_unit', 'source_tile.road_segments contains a duplicate identity.', { work_unit_id: road.id });
    roadById.set(road.id, road);
  }
  for (const road of roads) {
    for (const neighbor of road.neighbors) {
      const local = roadById.get(neighbor.id);
      if (local && neighbor.scope === 'outside_release') {
        fail('outside_release_neighbor_is_internal', 'A local neighbor cannot be marked outside_release.', { work_unit_id: road.id, neighbor_id: neighbor.id });
      }
      if (local && !local.neighbors.some((candidate) => candidate.id === road.id)) {
        fail('asymmetric_local_topology', 'Local road neighbors must be symmetric.', { work_unit_id: road.id, neighbor_id: neighbor.id });
      }
    }
  }
  const evidence = requireArray(raw.evidence, 'source_tile.evidence').map((feature, index) => (
    validateEvidence(feature, index, roadById, coverage.bounds, maxNearestRoadMeters)
  ));
  const evidenceIds = evidence.map((feature) => feature.evidenceId);
  if (new Set(evidenceIds).size !== evidenceIds.length) fail('duplicate_evidence_id', 'source_tile.evidence contains a duplicate evidence_id.');
  evidence.sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  for (const feature of evidence) {
    for (const roadId of feature.roadIds) roadById.get(roadId).evidence.push(feature);
  }
  const protectedGroups = validateProtectedGroups(raw.protected_groups, roadById);
  const properties = normalizeCanvasProperties({ evidence, roadById, mergeProvenance, fail });
  const ownership = [];
  const audit = [];
  let workUnits = roads.map((road) => {
    road.evidence.sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
    const classification = classifyCanvasSourceWorkUnit(road);
    ownership.push(...classification.opportunity_ownership_keys.map((key) => ({ key, roadId: road.id })));
    audit.push({
      work_unit_id: road.id,
      identity: road.identity,
      source_role: classification.source_role,
      canvas_role: classification.canvas_role,
      residential_state: classification.residential_state,
      legal_access_state: classification.legal_access_state,
      opportunity_basis: classification.opportunity_basis,
      opportunity: classification.opportunity,
      confidence: classification.confidence,
    });
    const provenance = mergeProvenance(
      [road.provenance, ...road.evidence.map((feature) => feature.provenance)],
      `source_tile.road_segments.${road.id}.combined_provenance`,
    );
    return {
      identity: road.identity,
      canvas_role: classification.canvas_role,
      confidence: classification.confidence,
      ...(classification.opportunity ? { opportunity: classification.opportunity } : {}),
      provenance,
      geometry: road.geometry,
      neighbors: road.neighbors.map((neighbor) => ({ identity: neighbor.identity, scope: neighbor.scope })),
    };
  }).sort((left, right) => (
    canonicalWorkUnitId(left.identity).localeCompare(canonicalWorkUnitId(right.identity))
  ));
  workUnits = applyPropertyWorkloadAuthority(workUnits, properties);
  return {
    tile: {
      schema: NORMALIZED_TILE_SCHEMA,
      schema_version: 1,
      tile_address: tileAddress,
      coverage,
      work_units: workUnits,
      properties,
      protected_groups: protectedGroups,
    },
    ownership,
    audit: audit.sort((left, right) => left.work_unit_id.localeCompare(right.work_unit_id)),
  };
}

export function normalizeCanvasSourceEvidenceTile(rawInput, options = {}) {
  return normalizeTileInternal(rawInput, options).tile;
}

export function normalizeCanvasSourceEvidenceTileWithAudit(rawInput, options = {}) {
  const { tile, audit } = normalizeTileInternal(rawInput, options);
  return { tile, audit };
}

export function normalizeCanvasSourceEvidenceTiles(rawTiles, options = {}) {
  const normalized = requireArray(rawTiles, 'source_tiles', { nonempty: true })
    .map((tile) => normalizeTileInternal(tile, options));
  const tileIds = normalized.map(({ tile }) => canonicalTileId(tile.tile_address));
  if (new Set(tileIds).size !== tileIds.length) fail('duplicate_source_tile', 'source_tiles contains a duplicate tile address.');
  const addressOwner = new Map();
  for (const { ownership } of normalized) {
    for (const claim of ownership) {
      const existing = addressOwner.get(claim.key);
      if (existing && existing !== claim.roadId) {
        fail('ambiguous_opportunity_ownership', 'The same address or unit is assigned to more than one road segment.', {
          opportunity_key: claim.key,
          road_ids: [existing, claim.roadId].sort(),
        });
      }
      addressOwner.set(claim.key, claim.roadId);
    }
  }
  return normalized
    .sort((left, right) => canonicalTileId(left.tile.tile_address).localeCompare(canonicalTileId(right.tile.tile_address)))
    .map(({ tile }) => tile);
}