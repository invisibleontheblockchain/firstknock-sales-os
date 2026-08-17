import {
  buildCanvasStreetWorkUnits,
  canvasStreetTopologyInternals,
} from './canvasStreetTopology.js';
import { classifyCanvasPropertyEntity, summarizeCanvasPropertyClassifications } from './canvasPropertyClassification.js';

const { edgeIdFor } = canvasStreetTopologyInternals;

const ALGORITHM_VERSION = 'canvas_residential_territory_v2_balanced';
const EARTH_RADIUS_METERS = 6371008.8;
const DEFAULT_MAX_ASSOCIATION_METERS = 120;
const DEFAULT_AMBIGUITY_METERS = 12;
const DEFAULT_AMBIGUITY_RATIO = 1.5;

const RESIDENTIAL_BUILDINGS = new Set([
  'apartments', 'bungalow', 'cabin', 'detached', 'dormitory', 'farm', 'house',
  'houseboat', 'residential', 'semidetached_house', 'semi_detached', 'static_caravan', 'terrace',
]);
const MULTI_UNIT_BUILDINGS = new Set(['apartments', 'dormitory', 'residential']);
const NON_RESIDENTIAL_BUILDINGS = new Set([
  'church', 'civic', 'commercial', 'garage', 'garages', 'hospital', 'industrial',
  'office', 'parking', 'retail', 'school', 'warehouse',
]);
const NON_RESIDENTIAL_LANDUSE = new Set(['commercial', 'industrial', 'retail']);
const OPEN_LANDUSE = new Set(['farmland', 'forest', 'grass', 'meadow', 'orchard']);
const OPEN_NATURAL = new Set(['field', 'grassland']);
const PUBLIC_PEDESTRIAN_HIGHWAYS = new Set([
  'footway', 'living_street', 'path', 'pedestrian', 'primary', 'residential',
  'secondary', 'service', 'steps', 'tertiary', 'track', 'unclassified',
]);
const FALLBACK_ASSOCIATION_HIGHWAYS = new Set([
  'living_street', 'residential', 'road', 'service', 'tertiary', 'unclassified',
]);
const PEDESTRIAN_ALLOWED = new Set(['designated', 'permissive', 'yes']);
const PEDESTRIAN_DENIED = new Set(['customers', 'no', 'private']);
const ACCESS_DENIED = new Set(['customers', 'destination', 'no', 'private']);
const UNCERTAIN_BARRIERS = new Set(['gate', 'kissing_gate', 'lift_gate', 'swing_gate']);

function compareIds(left, right) {
  return String(left).localeCompare(String(right), 'en', { numeric: true });
}

function canonicalId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function tagsOf(value) {
  return value?.tags && typeof value.tags === 'object' ? value.tags : {};
}

function tag(tags, key) {
  return String(tags?.[key] ?? '').trim().toLowerCase();
}

function normalizeStreetName(value) {
  const suffixes = {
    avenue: 'ave', boulevard: 'blvd', circle: 'cir', court: 'ct', drive: 'dr',
    lane: 'ln', parkway: 'pkwy', place: 'pl', road: 'rd', street: 'st',
  };
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((part) => suffixes[part] || part)
    .join(' ');
}

function pointFrom(value) {
  const source = value?.point || value?.center || value;
  const lat = Number(source?.lat ?? source?.latitude);
  const lng = Number(source?.lng ?? source?.lon ?? source?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function projectMeters(point, latitude) {
  const radians = Math.PI / 180;
  return {
    x: EARTH_RADIUS_METERS * point.lng * radians * Math.cos(latitude * radians),
    y: EARTH_RADIUS_METERS * point.lat * radians,
  };
}

function distanceToSegmentMeters(point, start, end) {
  const latitude = (point.lat + start.lat + end.lat) / 3;
  const projectedPoint = projectMeters(point, latitude);
  const projectedStart = projectMeters(start, latitude);
  const projectedEnd = projectMeters(end, latitude);
  const deltaX = projectedEnd.x - projectedStart.x;
  const deltaY = projectedEnd.y - projectedStart.y;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  const position = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
    ((projectedPoint.x - projectedStart.x) * deltaX
      + (projectedPoint.y - projectedStart.y) * deltaY) / lengthSquared));
  return Math.hypot(
    projectedPoint.x - (projectedStart.x + position * deltaX),
    projectedPoint.y - (projectedStart.y + position * deltaY),
  );
}

function unitDistanceMeters(point, unit) {
  const distances = (unit.segments || []).map((segment) => {
    const start = pointFrom(segment.start);
    const end = pointFrom(segment.end);
    return start && end ? distanceToSegmentMeters(point, start, end) : Infinity;
  });
  return distances.length ? Math.min(...distances) : Infinity;
}

function unitStreetNames(unit) {
  return [...new Set([
    ...(unit.streetNames || []),
    ...(unit.street_names || []),
    unit.streetName,
    unit.street_name,
  ].filter(Boolean).map(normalizeStreetName).filter(Boolean))].sort();
}

function unitHighways(unit) {
  return [...new Set([
    ...(unit.highwayTypes || []),
    ...(unit.highway_types || []),
    ...(unit.segments || []).flatMap((segment) => segment.highwayTypes || segment.highway_types || []),
  ].map((value) => String(value).toLowerCase()).filter(Boolean))].sort();
}

function featurePoint(feature, nodeMap = new Map()) {
  const direct = pointFrom(feature);
  if (direct) return direct;
  const geometry = Array.isArray(feature?.geometry) ? feature.geometry.map(pointFrom).filter(Boolean) : [];
  const referenced = Array.isArray(feature?.nodes)
    ? feature.nodes.map((id) => nodeMap.get(canonicalId(id))).filter(Boolean)
    : [];
  const points = geometry.length ? geometry : referenced;
  if (!points.length) return null;
  return {
    lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
    lng: points.reduce((sum, point) => sum + point.lng, 0) / points.length,
  };
}

function normalizedFeatures(features = [], nodeMap = new Map()) {
  return (Array.isArray(features) ? features : []).map((feature, index) => ({
    ...feature,
    id: canonicalId(feature?.id ?? feature?.feature_id) || `feature:${index}`,
    point: featurePoint(feature, nodeMap),
    tags: tagsOf(feature),
  })).sort((left, right) => compareIds(left.id, right.id));
}

function associationFailure(featureId, reason, details = {}) {
  return {
    feature_id: featureId,
    street_unit_id: null,
    basis: 'unassociated',
    confidence: 'none',
    reason,
    ...details,
  };
}

function chooseNearestAssociation(feature, candidates, basis, options) {
  if (!feature.point) return associationFailure(feature.id, 'missing_geometry');
  const ranked = candidates.map((unit) => ({
    unit,
    distance: unitDistanceMeters(feature.point, unit),
  })).filter((candidate) => Number.isFinite(candidate.distance))
    .sort((left, right) => left.distance - right.distance || compareIds(left.unit.id, right.unit.id));
  const best = ranked[0];
  if (!best || best.distance > options.maxAssociationMeters) {
    return associationFailure(feature.id, 'outside_association_limit', {
      distance_meters: best ? Number(best.distance.toFixed(2)) : null,
      maximum_distance_meters: options.maxAssociationMeters,
    });
  }
  const second = ranked.find((candidate) => candidate.unit.id !== best.unit.id);
  if (second) {
    const gap = second.distance - best.distance;
    const ratio = best.distance <= 0.01
      ? (second.distance <= 0.01 ? 1 : Infinity)
      : second.distance / best.distance;
    const sameNamedStreet = unitStreetNames(best.unit)
      .some((name) => unitStreetNames(second.unit).includes(name));
    if (!sameNamedStreet && gap <= options.ambiguityMeters && ratio <= options.ambiguityRatio) {
      return associationFailure(feature.id, 'ambiguous_nearest_street', {
        candidate_street_unit_ids: [best.unit.id, second.unit.id].sort(compareIds),
        distance_meters: Number(best.distance.toFixed(2)),
      });
    }
  }
  return {
    feature_id: feature.id,
    street_unit_id: best.unit.id,
    basis,
    confidence: basis === 'address_street' || basis === 'explicit' ? 'high' : 'low',
    distance_meters: Number(best.distance.toFixed(2)),
  };
}

/**
 * Associates evidence to exactly one street unit. The geometric fallback is
 * deliberately bounded and rejects similarly-close streets instead of guessing.
 */
export function associateCanvasFeaturesToStreetUnits(input = {}) {
  const streetUnits = input.street_units ?? input.streetUnits ?? input.work_units ?? [];
  const unitById = new Map(streetUnits.map((unit) => [canonicalId(unit?.id), unit]).filter(([id]) => id));
  const nodeMap = input.nodeMap instanceof Map ? input.nodeMap : new Map();
  const features = normalizedFeatures(input.features ?? input.evidenceFeatures ?? [], nodeMap);
  const options = {
    maxAssociationMeters: Number(input.max_association_meters
      ?? input.maxAssociationMeters ?? DEFAULT_MAX_ASSOCIATION_METERS),
    ambiguityMeters: Number(input.association_ambiguity_meters
      ?? input.ambiguityMeters ?? DEFAULT_AMBIGUITY_METERS),
    ambiguityRatio: Number(input.association_ambiguity_ratio
      ?? input.ambiguityRatio ?? DEFAULT_AMBIGUITY_RATIO),
  };
  const associations = features.map((feature) => {
    const explicitId = canonicalId(feature.street_unit_id ?? feature.work_unit_id
      ?? feature.streetUnitId ?? feature.workUnitId);
    if (explicitId) {
      return unitById.has(explicitId)
        ? {
          feature_id: feature.id,
          street_unit_id: explicitId,
          basis: 'explicit',
          confidence: 'high',
          distance_meters: feature.point ? Number(unitDistanceMeters(feature.point, unitById.get(explicitId)).toFixed(2)) : null,
        }
        : associationFailure(feature.id, 'unknown_explicit_street_unit', { requested_street_unit_id: explicitId });
    }

    const addressStreet = normalizeStreetName(
      feature.addr_street ?? feature.street_name ?? feature.tags?.['addr:street'],
    );
    if (addressStreet) {
      const named = streetUnits.filter((unit) => unitStreetNames(unit).includes(addressStreet));
      if (named.length === 1 && !feature.point) {
        return {
          feature_id: feature.id,
          street_unit_id: named[0].id,
          basis: 'address_street',
          confidence: 'high',
          distance_meters: null,
        };
      }
      if (named.length) return chooseNearestAssociation(feature, named, 'address_street', options);
      return associationFailure(feature.id, 'address_street_not_found', { normalized_street_name: addressStreet });
    }

    const frontageStreet = normalizeStreetName(feature.frontage_street
      ?? feature.frontageStreet ?? feature.tags?.['frontage:street'] ?? feature.tags?.['driveway:street']);
    if (frontageStreet) {
      const named = streetUnits.filter((unit) => unitStreetNames(unit).includes(frontageStreet));
      if (named.length) return chooseNearestAssociation(feature, named, 'frontage_street', options);
      return associationFailure(feature.id, 'frontage_street_not_found', { normalized_street_name: frontageStreet });
    }

    const eligible = streetUnits.filter((unit) => unitHighways(unit)
      .some((highway) => FALLBACK_ASSOCIATION_HIGHWAYS.has(highway)));
    return chooseNearestAssociation(feature, eligible, 'bounded_nearest', options);
  }).sort((left, right) => compareIds(left.feature_id, right.feature_id));

  return {
    ok: true,
    associations,
    associated: associations.filter((association) => association.street_unit_id),
    unassociated: associations.filter((association) => !association.street_unit_id),
  };
}

function positiveInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).trim());
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 10000 ? parsed : null;
}

function addressKeys(feature) {
  const tags = feature.tags || {};
  const number = String(tags['addr:housenumber'] ?? feature.addr_housenumber ?? '').trim().toLowerCase();
  if (!number) return [];
  const rawUnits = String(tags['addr:unit'] ?? feature.addr_unit ?? '').trim().toLowerCase();
  const units = rawUnits ? rawUnits.split(/[;,]/).map((value) => value.trim()).filter(Boolean) : [''];
  return units.map((unit) => `${number}\u0000${unit}`);
}

function featureSignals(feature) {
  const tags = feature.tags || {};
  const building = tag(tags, 'building');
  const landuse = tag(tags, 'landuse');
  const natural = tag(tags, 'natural');
  const buildingUse = tag(tags, 'building:use');
  const mixedUse = tag(tags, 'mixed_use');
  const hasCommercial = Boolean(tag(tags, 'shop') || tag(tags, 'office') || tag(tags, 'amenity'))
    || NON_RESIDENTIAL_BUILDINGS.has(building)
    || NON_RESIDENTIAL_LANDUSE.has(landuse);
  const mixedResidential = ['mixed', 'mixed_use', 'residential'].includes(buildingUse)
    || ['yes', 'mixed', 'residential'].includes(mixedUse)
    || tag(tags, 'residential') === 'yes';
  const residentialBuilding = RESIDENTIAL_BUILDINGS.has(building);
  return {
    residential: residentialBuilding || mixedResidential || landuse === 'residential',
    residentialBuilding,
    multiUnit: MULTI_UNIT_BUILDINGS.has(building) || mixedResidential,
    mixedResidential,
    ambiguousBuilding: building === 'yes',
    negative: hasCommercial,
    openLand: OPEN_LANDUSE.has(landuse) || OPEN_NATURAL.has(natural),
    serviceEntrance: tag(tags, 'entrance') === 'service',
  };
}

function isPropertyEntityFeature(feature) {
  const tags = feature.tags || {};
  return Boolean(feature.entity_id || feature.building_id || feature.site_id || feature.parent_building_id
    || tags.building || tags['addr:housenumber'] || feature.addr_housenumber || feature.address_key);
}

function estimateEntityOpportunity(features) {
  const signals = features.map(featureSignals);
  const residential = signals.some((signal) => signal.residential);
  const mixedResidential = signals.some((signal) => signal.mixedResidential);
  const negative = signals.some((signal) => signal.negative);
  const addressSet = new Set(features.flatMap(addressKeys));
  const explicitResidentialCounts = features.flatMap((feature) => [
    positiveInteger(feature.tags?.['residential:units']),
    positiveInteger(feature.tags?.['units:residential']),
    positiveInteger(feature.residential_units),
  ]).filter(Boolean);
  const explicitGenericCounts = features.flatMap((feature) => [
    positiveInteger(feature.tags?.['building:units']),
    positiveInteger(feature.tags?.['building:flats']),
  ]).filter(Boolean);
  const entrances = features.filter((feature) => tag(feature.tags, 'entrance')
    && !featureSignals(feature).serviceEntrance && !featureSignals(feature).negative).length;

  if (explicitResidentialCounts.length) {
    const count = Math.max(...explicitResidentialCounts);
    return { low: count, expected: count, high: count, source: 'explicit_residential_units', confidence: 'high' };
  }
  if (explicitGenericCounts.length && (residential || !negative)) {
    const count = Math.max(...explicitGenericCounts);
    return { low: count, expected: count, high: count, source: 'explicit_units', confidence: 'high' };
  }
  if (addressSet.size && (!mixedResidential || features.some((feature) => tag(feature.tags, 'residential') === 'yes'))) {
    const count = addressSet.size;
    return { low: count, expected: count, high: count, source: 'deduplicated_addresses', confidence: 'high' };
  }
  if (signals.some((signal) => signal.multiUnit) && residential) {
    return {
      low: Math.max(2, entrances),
      expected: Math.max(8, entrances * 2),
      high: Math.max(30, entrances * 4),
      source: 'multi_unit_proxy',
      confidence: 'low',
    };
  }
  if (signals.some((signal) => signal.residentialBuilding)) {
    return { low: 1, expected: 1, high: 1, source: 'residential_footprint', confidence: 'low' };
  }
  if (addressSet.size && !negative) {
    const count = addressSet.size;
    return { low: count, expected: count, high: count, source: 'deduplicated_addresses', confidence: 'high' };
  }
  return { low: 0, expected: 0, high: 0, source: 'none', confidence: 'none' };
}

/** Aggregates evidence per building/site entity before summing it by street. */
export function aggregateCanvasResidentialOpportunity(input = {}) {
  const features = normalizedFeatures(input.features ?? input.evidenceFeatures ?? [], input.nodeMap);
  const associationByFeature = new Map((input.associations || [])
    .map((association) => [canonicalId(association.feature_id), association]));
  const entities = new Map();
  features.forEach((feature) => {
    const entityId = canonicalId(feature.entity_id ?? feature.building_id ?? feature.site_id
      ?? feature.parent_building_id) || feature.id;
    entities.set(entityId, [...(entities.get(entityId) || []), feature]);
  });

  const byStreet = new Map();
  const entityEstimates = [];
  [...entities.entries()].sort(([left], [right]) => compareIds(left, right)).forEach(([entityId, entityFeatures]) => {
    const rankedAssociations = entityFeatures.map((feature) => associationByFeature.get(feature.id))
      .filter((association) => association?.street_unit_id)
      .sort((left, right) => {
        const rank = { explicit: 0, address_street: 1, frontage_street: 2, bounded_nearest: 3 };
        return (rank[left.basis] ?? 9) - (rank[right.basis] ?? 9)
          || Number(left.distance_meters ?? Infinity) - Number(right.distance_meters ?? Infinity)
          || compareIds(left.street_unit_id, right.street_unit_id);
      });
    const selected = rankedAssociations[0];
    const signals = entityFeatures.map(featureSignals);
    const estimate = estimateEntityOpportunity(entityFeatures);
    const propertyClassification = entityFeatures.some(isPropertyEntityFeature)
      ? classifyCanvasPropertyEntity({ property_id: entityId, features: entityFeatures })
      : null;
    const eligibleEstimate = propertyClassification?.canvass_eligibility === 'eligible'
      ? estimate
      : { low: 0, expected: 0, high: 0, source: estimate.source, confidence: estimate.confidence };
    const record = {
      entity_id: entityId,
      street_unit_id: selected?.street_unit_id || null,
      ...eligibleEstimate,
      ...(propertyClassification || {}),
      residential_evidence: signals.some((signal) => signal.residential),
      ambiguous_building_evidence: signals.some((signal) => signal.ambiguousBuilding),
      negative_evidence: signals.some((signal) => signal.negative),
      open_land_evidence: signals.some((signal) => signal.openLand),
    };
    if (propertyClassification) entityEstimates.push(record);
    if (!selected) return;
    const current = byStreet.get(selected.street_unit_id) || {
      low: 0,
      expected: 0,
      high: 0,
      entity_ids: [],
      sources: [],
      residential_evidence: false,
      ambiguous_building_evidence: false,
      negative_evidence: false,
      open_land_evidence: false,
      uncertain_property_count: 0,
      excluded_property_count: 0,
      eligible_property_count: 0,
    };
    current.low += eligibleEstimate.low;
    current.expected += eligibleEstimate.expected;
    current.high += eligibleEstimate.high;
    if (propertyClassification) {
      current[`${propertyClassification.canvass_eligibility === 'review' ? 'uncertain' : propertyClassification.canvass_eligibility}_property_count`] += 1;
      current.entity_ids.push(entityId);
    }
    current.sources.push(estimate.source);
    current.residential_evidence ||= record.residential_evidence;
    current.ambiguous_building_evidence ||= record.ambiguous_building_evidence;
    current.negative_evidence ||= record.negative_evidence;
    current.open_land_evidence ||= record.open_land_evidence;
    byStreet.set(selected.street_unit_id, current);
  });

  const byStreetUnit = Object.fromEntries([...byStreet.entries()].sort(([left], [right]) => compareIds(left, right))
    .map(([streetUnitId, value]) => [streetUnitId, {
      ...value,
      entity_ids: [...new Set(value.entity_ids)].sort(compareIds),
      sources: [...new Set(value.sources)].sort(),
    }]));
  return { ok: true, by_street_unit: byStreetUnit, entity_estimates: entityEstimates };
}

function classifyAccess(highwayTypes, evidence) {
  const evidenceTags = (Array.isArray(evidence) ? evidence : [evidence]).filter(Boolean).map(tagsOf);
  const footValues = new Set(evidenceTags.map((tags) => tag(tags, 'foot')).filter(Boolean));
  const accessValues = new Set(evidenceTags.map((tags) => tag(tags, 'access')).filter(Boolean));
  const hasConditional = evidenceTags.some((tags) => tag(tags, 'foot:conditional') || tag(tags, 'access:conditional'));
  const footAllowed = [...footValues].some((value) => PEDESTRIAN_ALLOWED.has(value));
  const footDenied = [...footValues].some((value) => PEDESTRIAN_DENIED.has(value));
  const lockedBarrier = evidenceTags.some((tags) => tag(tags, 'locked') === 'yes' && tag(tags, 'barrier'));
  const uncertainBarrier = evidenceTags.some((tags) => UNCERTAIN_BARRIERS.has(tag(tags, 'barrier'))
    && tag(tags, 'locked') !== 'no');
  if (footDenied || lockedBarrier) return { classification: 'restricted', reasons: ['explicit_pedestrian_denial'] };
  if (footAllowed && !hasConditional) return { classification: 'permitted', reasons: ['explicit_pedestrian_permission'] };
  if ([...accessValues].some((value) => ACCESS_DENIED.has(value))) {
    return { classification: 'restricted', reasons: ['generic_access_denial'] };
  }
  if (hasConditional || uncertainBarrier || footValues.size > 1) {
    return { classification: 'uncertain', reasons: ['conditional_or_ambiguous_access'] };
  }
  if (highwayTypes.some((highway) => highway === 'motorway' || highway === 'motorway_link')) {
    return { classification: 'restricted', reasons: ['pedestrian_prohibited_highway'] };
  }
  if (highwayTypes.some((highway) => PUBLIC_PEDESTRIAN_HIGHWAYS.has(highway))) {
    return { classification: 'permitted', reasons: ['osm_highway_default'] };
  }
  return { classification: 'uncertain', reasons: ['missing_access_default'] };
}

/** Precedence-complete two-pass classifier. */
export function classifyCanvasStreetUnit(input = {}) {
  const opportunity = input.opportunity || input.opportunity_estimate || {};
  const expected = Number(opportunity.expected ?? input.opportunity_expected ?? 0);
  const propertyAware = Number.isFinite(Number(opportunity.eligible_property_count))
    || Number.isFinite(Number(opportunity.uncertain_property_count));
  const positive = expected > 0 || Boolean(input.residential_evidence);
  const ambiguous = Boolean(input.ambiguous_building_evidence || input.conflicting_evidence);
  const negative = Boolean(input.negative_evidence || input.open_land_evidence);
  let opportunityClassification;
  if (expected > 0) opportunityClassification = 'likely';
  else if (propertyAware) opportunityClassification = 'none';
  else if (positive || ambiguous) opportunityClassification = 'uncertain';
  else if (negative) opportunityClassification = 'none';
  else opportunityClassification = 'uncertain';

  const highways = [...new Set([
    ...(input.highwayTypes || []),
    ...(input.highway_types || []),
  ].map((value) => String(value).toLowerCase()))];
  const access = classifyAccess(highways, input.access_evidence ?? input.accessEvidence ?? []);
  const connectivityNeeded = Boolean(input.connectivity_needed ?? input.connectivityNeeded);
  let canvasRole;
  if (opportunityClassification === 'likely' && access.classification === 'permitted') canvasRole = 'knock';
  else if (opportunityClassification === 'none' && access.classification === 'permitted' && connectivityNeeded) canvasRole = 'transit_only';
  else if (opportunityClassification === 'none' && access.classification !== 'uncertain') canvasRole = 'excluded';
  else canvasRole = 'uncertain';

  return {
    opportunity_classification: opportunityClassification,
    access_classification: access.classification,
    canvas_role: canvasRole,
    opportunity: {
      low: Number(opportunity.low || 0),
      expected: Number(opportunity.expected || 0),
      high: Number(opportunity.high || 0),
    },
    classification_reasons: {
      opportunity: opportunityClassification === 'likely'
        ? ['positive_residential_opportunity']
        : opportunityClassification === 'none' ? ['affirmative_non_residential_evidence'] : ['missing_or_ambiguous_evidence'],
      access: access.reasons,
    },
  };
}

function endpointKey(point) {
  const normalized = pointFrom(point);
  return normalized ? `${normalized.lat.toFixed(7)}:${normalized.lng.toFixed(7)}` : null;
}

function deriveNeighbors(streetUnits) {
  const neighbors = new Map(streetUnits.map((unit) => [unit.id, new Set()]));
  const endpointUnits = new Map();
  streetUnits.forEach((unit) => {
    const explicit = unit.neighborIds ?? unit.neighbor_ids;
    if (Array.isArray(explicit)) explicit.forEach((neighborId) => {
      if (neighbors.has(neighborId) && neighborId !== unit.id) neighbors.get(unit.id).add(neighborId);
    });
    (unit.segments || []).forEach((segment) => [endpointKey(segment.start), endpointKey(segment.end)]
      .filter(Boolean).forEach((key) => endpointUnits.set(key, [...(endpointUnits.get(key) || []), unit.id])));
  });
  endpointUnits.forEach((ids) => ids.forEach((id) => ids.forEach((neighborId) => {
    if (id !== neighborId) neighbors.get(id)?.add(neighborId);
  })));
  neighbors.forEach((ids, id) => ids.forEach((neighborId) => neighbors.get(neighborId)?.add(id)));
  return new Map([...neighbors.entries()].map(([id, ids]) => [id, [...ids].sort(compareIds)]));
}

function effectiveKnockNeighbors(streetUnits, baseNeighbors) {
  const byId = new Map(streetUnits.map((unit) => [unit.id, unit]));
  const knockIds = streetUnits.filter((unit) => unit.canvas_role === 'knock').map((unit) => unit.id).sort(compareIds);
  const result = new Map(knockIds.map((id) => [id, new Set()]));
  knockIds.forEach((id) => (baseNeighbors.get(id) || []).forEach((neighborId) => {
    if (result.has(neighborId)) result.get(id).add(neighborId);
  }));

  const transitIds = new Set(streetUnits.filter((unit) => unit.canvas_role === 'transit_only').map((unit) => unit.id));
  const unseen = new Set(transitIds);
  while (unseen.size) {
    const seed = [...unseen].sort(compareIds)[0];
    const queue = [seed];
    const borders = new Set();
    unseen.delete(seed);
    for (let index = 0; index < queue.length; index += 1) {
      (baseNeighbors.get(queue[index]) || []).forEach((neighborId) => {
        if (transitIds.has(neighborId) && unseen.has(neighborId)) {
          unseen.delete(neighborId);
          queue.push(neighborId);
        } else if (byId.get(neighborId)?.canvas_role === 'knock') borders.add(neighborId);
      });
    }
    const orderedBorders = [...borders].sort(compareIds);
    orderedBorders.forEach((id) => orderedBorders.forEach((neighborId) => {
      if (id !== neighborId) result.get(id).add(neighborId);
    }));
  }
  return new Map([...result.entries()].map(([id, ids]) => [id, [...ids].sort(compareIds)]));
}

function connectedComponents(ids, neighbors) {
  const unseen = new Set(ids);
  const components = [];
  while (unseen.size) {
    const seed = [...unseen].sort(compareIds)[0];
    const queue = [seed];
    const component = [];
    unseen.delete(seed);
    for (let index = 0; index < queue.length; index += 1) {
      const id = queue[index];
      component.push(id);
      (neighbors.get(id) || []).forEach((neighborId) => {
        if (!unseen.has(neighborId)) return;
        unseen.delete(neighborId);
        queue.push(neighborId);
      });
    }
    components.push(component.sort(compareIds));
  }
  return components.sort((left, right) => compareIds(left[0], right[0]));
}

// Workload in estimated minutes:
//   expected opportunities × attempt time + walking time + MDU/site overhead
//
// Selecting this basis changes what the partitioner balances, so it changes
// results for the same evidence. That makes it an ALGORITHM VERSION change, not
// a tunable — it is opt-in via `workload_basis: 'minutes'` and the default stays
// opportunity count so already-deployed plans stay reproducible.
export const CANVAS_PARTITION_WORKLOAD_DEFAULTS = Object.freeze({
  attempt_minutes: 3.5,
  walk_meters_per_minute: 60,
  mdu_site_overhead_minutes: 12,
});

function segmentMeters(start, end) {
  const from = pointFrom(start);
  const to = pointFrom(end);
  if (!from || !to) return 0;
  const latitude = (from.lat + to.lat) / 2;
  const projectedFrom = projectMeters(from, latitude);
  const projectedTo = projectMeters(to, latitude);
  return Math.hypot(projectedTo.x - projectedFrom.x, projectedTo.y - projectedFrom.y);
}

function unitStreetMeters(unit) {
  const declared = Number(unit?.length_meters ?? unit?.street_length_meters);
  if (Number.isFinite(declared) && declared > 0) return declared;
  const segments = Array.isArray(unit?.segments) ? unit.segments : [];
  return segments.reduce((sum, segment) => sum + segmentMeters(segment?.start, segment?.end), 0);
}

function unitWorkloadMinutes(unit, model = CANVAS_PARTITION_WORKLOAD_DEFAULTS) {
  const expected = Math.max(0, Number(unit?.opportunity?.expected ?? unit?.opportunity_expected ?? 0));
  const pace = Math.max(1, Number(model.walk_meters_per_minute) || 1);
  const mduSites = Number(unit?.mdu_site_count ?? unit?.mdu_sites) || (unit?.is_mdu === true ? 1 : 0);
  return expected * (Number(model.attempt_minutes) || 0)
    + unitStreetMeters(unit) / pace
    + Math.max(0, mduSites) * (Number(model.mdu_site_overhead_minutes) || 0);
}

function workload(unit) {
  const weight = Number(unit?.workload_weight);
  if (Number.isFinite(weight) && weight > 0) return weight;
  return Math.max(1, Number(unit.opportunity?.expected ?? unit.opportunity_expected ?? 0));
}

function allocateZoneCounts(components, areaCount, byId) {
  const allocation = components.map(() => 1);
  for (let remaining = areaCount - components.length; remaining > 0; remaining -= 1) {
    const candidates = components.map((ids, index) => ({
      index,
      capacity: ids.length - allocation[index],
      pressure: ids.reduce((sum, id) => sum + workload(byId.get(id)), 0) / allocation[index],
      firstId: ids[0],
    })).filter((candidate) => candidate.capacity > 0)
      .sort((left, right) => right.pressure - left.pressure || compareIds(left.firstId, right.firstId));
    if (!candidates.length) return null;
    allocation[candidates[0].index] += 1;
  }
  return allocation;
}

function graphDistances(seed, allowed, neighbors) {
  const distances = new Map([[seed, 0]]);
  const queue = [seed];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    (neighbors.get(id) || []).forEach((neighborId) => {
      if (!allowed.has(neighborId) || distances.has(neighborId)) return;
      distances.set(neighborId, distances.get(id) + 1);
      queue.push(neighborId);
    });
  }
  return distances;
}

function heapPush(heap, value, descending) {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    const ordered = descending ? heap[parent] >= heap[index] : heap[parent] <= heap[index];
    if (ordered) break;
    [heap[parent], heap[index]] = [heap[index], heap[parent]];
    index = parent;
  }
}

function heapPop(heap, descending) {
  if (!heap.length) return null;
  const first = heap[0];
  const last = heap.pop();
  if (heap.length) {
    heap[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let selected = index;
      if (left < heap.length && (descending ? heap[left] > heap[selected] : heap[left] < heap[selected])) selected = left;
      if (right < heap.length && (descending ? heap[right] > heap[selected] : heap[right] < heap[selected])) selected = right;
      if (selected === index) break;
      [heap[selected], heap[index]] = [heap[index], heap[selected]];
      index = selected;
    }
  }
  return first;
}

function farthestRemainingRank(seed, remaining, adjacency) {
  const distances = new Int32Array(remaining.length);
  distances.fill(-1);
  const queue = new Int32Array(remaining.length);
  let head = 0;
  let tail = 1;
  queue[0] = seed;
  distances[seed] = 0;
  let farthest = seed;
  while (head < tail) {
    const rank = queue[head];
    head += 1;
    if (distances[rank] > distances[farthest]
      || (distances[rank] === distances[farthest] && rank < farthest)) farthest = rank;
    adjacency[rank].forEach((neighborRank) => {
      if (!remaining[neighborRank] || distances[neighborRank] >= 0) return;
      distances[neighborRank] = distances[rank] + 1;
      queue[tail] = neighborRank;
      tail += 1;
    });
  }
  return farthest;
}

function connectedFloodOrder(seed, remaining, remainingCount, adjacency, descending) {
  const visited = new Uint8Array(remaining.length);
  const heap = [];
  const order = new Int32Array(remainingCount);
  let length = 0;
  visited[seed] = 1;
  heapPush(heap, seed, descending);
  while (heap.length) {
    const rank = heapPop(heap, descending);
    order[length] = rank;
    length += 1;
    adjacency[rank].forEach((neighborRank) => {
      if (!remaining[neighborRank] || visited[neighborRank]) return;
      visited[neighborRank] = 1;
      heapPush(heap, neighborRank, descending);
    });
  }
  return length === remainingCount ? order : null;
}

function bestConnectedPrefix(order, zonesRemaining, remainingLoad, weights, adjacency, positionByRank) {
  const length = order.length;
  const prefixLoads = new Float64Array(length + 1);
  positionByRank.fill(-1);
  for (let index = 0; index < length; index += 1) {
    prefixLoads[index + 1] = prefixLoads[index] + weights[order[index]];
    positionByRank[order[index]] = index;
  }

  // Reverse union-find makes the suffix-connectivity check linear. Every flood
  // prefix is connected; this pass finds the closest balanced cut whose
  // complement is also connected, without repeatedly traversing the graph.
  const parent = new Int32Array(length);
  const sizes = new Int32Array(length);
  const active = new Uint8Array(length);
  const find = (value) => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    let cursor = value;
    while (parent[cursor] !== cursor) {
      const next = parent[cursor];
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  let componentCount = 0;
  const union = (left, right) => {
    let leftRoot = find(left);
    let rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    if (sizes[leftRoot] < sizes[rightRoot]) [leftRoot, rightRoot] = [rightRoot, leftRoot];
    parent[rightRoot] = leftRoot;
    sizes[leftRoot] += sizes[rightRoot];
    componentCount -= 1;
  };

  const target = remainingLoad / zonesRemaining;
  const targetCount = length / zonesRemaining;
  const maxPrefixCount = length - (zonesRemaining - 1);
  let best = null;
  for (let index = length - 1; index >= 0; index -= 1) {
    parent[index] = index;
    sizes[index] = 1;
    active[index] = 1;
    componentCount += 1;
    adjacency[order[index]].forEach((neighborRank) => {
      const neighborIndex = positionByRank[neighborRank];
      if (neighborIndex >= 0 && active[neighborIndex]) union(index, neighborIndex);
    });
    const prefixCount = index;
    if (prefixCount < 1 || prefixCount > maxPrefixCount || componentCount !== 1) continue;
    const candidate = {
      count: prefixCount,
      load: prefixLoads[prefixCount],
      loadError: Math.abs(prefixLoads[prefixCount] - target),
      countError: Math.abs(prefixCount - targetCount),
    };
    if (!best || candidate.loadError < best.loadError
      || (candidate.loadError === best.loadError && candidate.countError < best.countError)
      || (candidate.loadError === best.loadError && candidate.countError === best.countError
        && candidate.count < best.count)) best = candidate;
  }
  return best;
}

function peelConnectedZones(component, zoneCount, byId, neighbors, descending) {
  const ids = [...component].sort(compareIds);
  const rankById = new Map(ids.map((id, index) => [id, index]));
  const adjacency = ids.map((id) => (neighbors.get(id) || [])
    .map((neighborId) => rankById.get(neighborId))
    .filter((rank) => Number.isInteger(rank))
    .sort((left, right) => left - right));
  const weights = Float64Array.from(ids, (id) => workload(byId.get(id)));
  const remaining = new Uint8Array(ids.length);
  remaining.fill(1);
  const positionByRank = new Int32Array(ids.length);
  let remainingCount = ids.length;
  let remainingLoad = weights.reduce((sum, value) => sum + value, 0);
  const zones = [];

  for (let zonesRemaining = zoneCount; zonesRemaining > 1; zonesRemaining -= 1) {
    let firstRemaining = 0;
    while (firstRemaining < remaining.length && !remaining[firstRemaining]) firstRemaining += 1;
    const seed = farthestRemainingRank(firstRemaining, remaining, adjacency);
    const order = connectedFloodOrder(seed, remaining, remainingCount, adjacency, descending);
    if (!order) return null;
    const cut = bestConnectedPrefix(
      order,
      zonesRemaining,
      remainingLoad,
      weights,
      adjacency,
      positionByRank,
    );
    if (!cut) return null;
    const zoneIds = new Set();
    for (let index = 0; index < cut.count; index += 1) {
      const rank = order[index];
      remaining[rank] = 0;
      zoneIds.add(ids[rank]);
    }
    remainingCount -= cut.count;
    remainingLoad -= cut.load;
    zones.push({ ids: zoneIds, load: cut.load });
  }
  const finalIds = new Set();
  let finalLoad = 0;
  for (let rank = 0; rank < remaining.length; rank += 1) {
    if (!remaining[rank]) continue;
    finalIds.add(ids[rank]);
    finalLoad += weights[rank];
  }
  zones.push({ ids: finalIds, load: finalLoad });
  return zones;
}

function partitionScore(zones, target) {
  return zones.reduce((score, zone) => {
    const deviation = Math.abs(zone.load - target) / Math.max(1, target);
    return {
      maximum: Math.max(score.maximum, deviation),
      squared: score.squared + deviation * deviation,
    };
  }, { maximum: 0, squared: 0 });
}

function subsetDistances(seed, subset, allowed, adjacency) {
  const distances = new Int32Array(adjacency.length);
  distances.fill(-1);
  const queue = new Int32Array(subset.length);
  let head = 0;
  let tail = 1;
  queue[0] = seed;
  distances[seed] = 0;
  while (head < tail) {
    const rank = queue[head];
    head += 1;
    adjacency[rank].forEach((neighborRank) => {
      if (!allowed.has(neighborRank) || distances[neighborRank] >= 0) return;
      distances[neighborRank] = distances[rank] + 1;
      queue[tail] = neighborRank;
      tail += 1;
    });
  }
  return tail === subset.length ? distances : null;
}

function balancedDistanceSplit(subset, zoneCount, weights, adjacency) {
  const leftZoneCount = Math.floor(zoneCount / 2);
  const rightZoneCount = zoneCount - leftZoneCount;
  const allowed = new Set(subset);
  const landmarks = [subset[0]];
  const landmarkDistances = [subsetDistances(subset[0], subset, allowed, adjacency)];
  if (!landmarkDistances[0]) return null;

  // Four farthest-point landmarks expose both axes of grid-like street graphs,
  // while still using only topology (no square/rectangle assumptions).
  while (landmarks.length < Math.min(4, subset.length)) {
    let selected = null;
    let selectedDistance = -1;
    subset.forEach((rank) => {
      const distance = Math.min(...landmarkDistances.map((distances) => distances[rank]));
      if (distance > selectedDistance || (distance === selectedDistance && (selected === null || rank < selected))) {
        selected = rank;
        selectedDistance = distance;
      }
    });
    if (selected === null || landmarks.includes(selected)) break;
    landmarks.push(selected);
    landmarkDistances.push(subsetDistances(selected, subset, allowed, adjacency));
  }

  const totalLoad = subset.reduce((sum, rank) => sum + weights[rank], 0);
  const targetLoad = totalLoad * leftZoneCount / zoneCount;
  const targetCount = subset.length * leftZoneCount / zoneCount;
  let best = null;
  for (let leftIndex = 0; leftIndex < landmarks.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < landmarks.length; rightIndex += 1) {
      const layers = new Map();
      subset.forEach((rank) => {
        const coordinate = landmarkDistances[leftIndex][rank] - landmarkDistances[rightIndex][rank];
        if (!layers.has(coordinate)) layers.set(coordinate, { ranks: [], load: 0 });
        layers.get(coordinate).ranks.push(rank);
        layers.get(coordinate).load += weights[rank];
      });
      const orderedLayers = [...layers.entries()].sort((left, right) => left[0] - right[0]);
      const leftRanks = [];
      let leftLoad = 0;
      for (let layerIndex = 0; layerIndex < orderedLayers.length - 1; layerIndex += 1) {
        const [, layer] = orderedLayers[layerIndex];
        leftRanks.push(...layer.ranks);
        leftLoad += layer.load;
        if (leftRanks.length < leftZoneCount || subset.length - leftRanks.length < rightZoneCount) continue;
        const candidate = {
          left: [...leftRanks].sort((left, right) => left - right),
          loadError: Math.abs(leftLoad - targetLoad),
          countError: Math.abs(leftRanks.length - targetCount),
          leftLandmark: landmarks[leftIndex],
          rightLandmark: landmarks[rightIndex],
          coordinate: orderedLayers[layerIndex][0],
        };
        if (!best || candidate.loadError < best.loadError
          || (candidate.loadError === best.loadError && candidate.countError < best.countError)
          || (candidate.loadError === best.loadError && candidate.countError === best.countError
            && candidate.leftLandmark < best.leftLandmark)
          || (candidate.loadError === best.loadError && candidate.countError === best.countError
            && candidate.leftLandmark === best.leftLandmark && candidate.rightLandmark < best.rightLandmark)
          || (candidate.loadError === best.loadError && candidate.countError === best.countError
            && candidate.leftLandmark === best.leftLandmark && candidate.rightLandmark === best.rightLandmark
            && candidate.coordinate < best.coordinate)) best = candidate;
      }
    }
  }
  if (!best) return null;
  const leftSet = new Set(best.left);
  return {
    left: best.left,
    right: subset.filter((rank) => !leftSet.has(rank)),
    leftZoneCount,
    rightZoneCount,
  };
}

function distanceBisectedZones(component, zoneCount, byId, neighbors) {
  const ids = [...component].sort(compareIds);
  const rankById = new Map(ids.map((id, index) => [id, index]));
  const adjacency = ids.map((id) => (neighbors.get(id) || [])
    .map((neighborId) => rankById.get(neighborId))
    .filter((rank) => Number.isInteger(rank))
    .sort((left, right) => left - right));
  const weights = Float64Array.from(ids, (id) => workload(byId.get(id)));
  const recurse = (subset, count) => {
    if (count === 1) {
      return [{
        ids: new Set(subset.map((rank) => ids[rank])),
        load: subset.reduce((sum, rank) => sum + weights[rank], 0),
      }];
    }
    const split = balancedDistanceSplit(subset, count, weights, adjacency);
    if (!split) return null;
    const left = recurse(split.left, split.leftZoneCount);
    if (!left) return null;
    const right = recurse(split.right, split.rightZoneCount);
    return right ? [...left, ...right] : null;
  };
  return recurse(ids.map((_, rank) => rank), zoneCount);
}

function partitionComponent(component, zoneCount, byId, neighbors) {
  if (zoneCount === 1) {
    return [{
      ids: new Set(component),
      load: component.reduce((sum, id) => sum + workload(byId.get(id)), 0),
    }];
  }
  const target = component.reduce((sum, id) => sum + workload(byId.get(id)), 0) / zoneCount;
  const ascending = peelConnectedZones(component, zoneCount, byId, neighbors, false);
  const descending = peelConnectedZones(component, zoneCount, byId, neighbors, true);
  const peelCandidates = [ascending, descending].filter(Boolean)
    .map((zones, index) => ({ zones, index, score: partitionScore(zones, target) }))
    .sort((left, right) => left.score.maximum - right.score.maximum
      || left.score.squared - right.score.squared || left.index - right.index);
  if (peelCandidates[0]?.score.maximum <= 0.25) return peelCandidates[0].zones;
  const bisected = distanceBisectedZones(component, zoneCount, byId, neighbors);
  const candidates = [...peelCandidates, ...(bisected ? [{
    zones: bisected,
    index: 2,
    score: partitionScore(bisected, target),
  }] : [])];
  if (!candidates.length) return null;
  return candidates.sort((left, right) => left.score.maximum - right.score.maximum
      || left.score.squared - right.score.squared || left.index - right.index)[0].zones;
}

function idsConnected(ids, neighbors) {
  if (!ids.length) return false;
  const allowed = new Set(ids);
  return graphDistances(ids[0], allowed, neighbors).size === ids.length;
}

function protectedGroupIds(unit) {
  return [...new Set([
    ...(Array.isArray(unit?.protected_group_ids) ? unit.protected_group_ids : []),
    unit?.protected_group_id,
  ].map(canonicalId).filter(Boolean))].sort(compareIds);
}

function buildResidentialOwnershipAtoms(knockUnits, unitNeighbors, weighting = null) {
  const parent = new Map(knockUnits.map((unit) => [unit.id, unit.id]));
  const find = (id) => {
    let root = parent.get(id);
    while (root && root !== parent.get(root)) root = parent.get(root);
    let cursor = id;
    while (root && parent.get(cursor) !== root) {
      const next = parent.get(cursor);
      parent.set(cursor, root);
      cursor = next;
    }
    return root || id;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    const [first, second] = [leftRoot, rightRoot].sort(compareIds);
    parent.set(second, first);
  };
  const firstByGroup = new Map();
  knockUnits.forEach((unit) => protectedGroupIds(unit).forEach((groupId) => {
    if (firstByGroup.has(groupId)) union(unit.id, firstByGroup.get(groupId));
    else firstByGroup.set(groupId, unit.id);
  }));

  const membersByRoot = new Map();
  knockUnits.forEach((unit) => {
    const root = find(unit.id);
    membersByRoot.set(root, [...(membersByRoot.get(root) || []), unit]);
  });
  const atomIdByUnitId = new Map();
  const atoms = [...membersByRoot.values()].map((members) => {
    members.sort((left, right) => compareIds(left.id, right.id));
    const groupIds = [...new Set(members.flatMap(protectedGroupIds))].sort(compareIds);
    const id = groupIds.length ? `canvas-protected-group:${groupIds[0]}` : members[0].id;
    members.forEach((unit) => atomIdByUnitId.set(unit.id, id));
    return {
      id,
      member_unit_ids: members.map((unit) => unit.id),
      protected_group_ids: groupIds,
      protected: members.some((unit) => unit.protected === true) || groupIds.length > 0,
      opportunity: {
        low: members.reduce((sum, unit) => sum + Number(unit?.opportunity?.low ?? unit?.opportunity_low ?? 0), 0),
        expected: members.reduce((sum, unit) => sum + Number(unit?.opportunity?.expected ?? unit?.opportunity_expected ?? 0), 0),
        high: members.reduce((sum, unit) => sum + Number(unit?.opportunity?.high ?? unit?.opportunity_high ?? 0), 0),
      },
      // Members are id-sorted above, so this sum is order-stable and the
      // partition stays deterministic for a fixed evidence release.
      ...(weighting ? {
        workload_minutes: members.reduce((sum, unit) => sum + unitWorkloadMinutes(unit, weighting), 0),
        workload_weight: Math.max(
          Number.EPSILON,
          members.reduce((sum, unit) => sum + unitWorkloadMinutes(unit, weighting), 0),
        ),
      } : {}),
    };
  }).sort((left, right) => compareIds(left.id, right.id));
  const atomNeighbors = new Map(atoms.map((atom) => [atom.id, new Set()]));
  knockUnits.forEach((unit) => (unitNeighbors.get(unit.id) || []).forEach((neighborId) => {
    const left = atomIdByUnitId.get(unit.id);
    const right = atomIdByUnitId.get(neighborId);
    if (left && right && left !== right) {
      atomNeighbors.get(left).add(right);
      atomNeighbors.get(right).add(left);
    }
  }));
  return {
    atoms,
    atomNeighbors: new Map([...atomNeighbors].map(([id, ids]) => [id, [...ids].sort(compareIds)])),
  };
}

/** Partitions preclassified, stable-ID street units without mutating them. */
/**
 * Merge two areas into one. Territories must stay connected, so this refuses a
 * merge of two areas that do not touch rather than producing a territory a rep
 * cannot walk. Returns the merged work-unit set for the caller to lock and
 * regenerate around; it does not repartition on its own.
 */
export function mergeCanvasResidentialZones(input = {}) {
  const streetUnits = input.street_units ?? input.classified_street_units ?? input.streetUnits ?? [];
  const zones = Array.isArray(input.zones) ? input.zones : [];
  const targetIds = [input.zone_id_a, input.zone_id_b].map((id) => String(id ?? ''));
  if (!Array.isArray(streetUnits) || targetIds.some((id) => !id) || targetIds[0] === targetIds[1]) {
    return { ok: false, code: 'INVALID_MERGE_REQUEST' };
  }
  const [first, second] = targetIds.map((id) => zones.find((zone) => String(zone?.zone_id) === id));
  if (!first || !second) return { ok: false, code: 'MERGE_ZONE_NOT_FOUND' };

  const knockUnits = streetUnits.filter((unit) => unit.canvas_role === 'knock');
  const neighbors = effectiveKnockNeighbors(streetUnits, deriveNeighbors(streetUnits));
  const { atomNeighbors } = buildResidentialOwnershipAtoms(
    knockUnits.sort((left, right) => compareIds(left.id, right.id)),
    neighbors,
  );
  const atomIdByMemberUnitId = new Map();
  buildResidentialOwnershipAtoms(knockUnits, neighbors).atoms
    .forEach((atom) => atom.member_unit_ids.forEach((unitId) => atomIdByMemberUnitId.set(unitId, atom.id)));

  const mergedUnitIds = [...new Set([
    ...(first.work_unit_ids || []),
    ...(second.work_unit_ids || []),
  ].map(canonicalId).filter(Boolean))].sort(compareIds);
  const mergedAtomIds = [...new Set(mergedUnitIds.map((id) => atomIdByMemberUnitId.get(id)).filter(Boolean))];

  if (!idsConnected(mergedAtomIds, atomNeighbors)) {
    return { ok: false, code: 'MERGE_ZONES_NOT_ADJACENT' };
  }
  return {
    ok: true,
    merged_zone: {
      zone_id: first.zone_id,
      work_unit_ids: mergedUnitIds,
      locked: true,
    },
    removed_zone_id: second.zone_id,
    // One fewer area than before the merge.
    area_count: Math.max(1, zones.length - 1),
  };
}

export function partitionCanvasResidentialTerritories(input = {}) {
  const streetUnits = input.street_units ?? input.classified_street_units ?? input.streetUnits ?? [];
  const areaCount = Number(input.area_count ?? input.requested_zone_count ?? input.zone_count ?? 1);
  if (!Array.isArray(streetUnits) || !Number.isInteger(areaCount) || areaCount <= 0) {
    return { ok: false, status: 'blocked', deployable: false, code: 'INVALID_PARTITION_INPUT', zones: [], work_units: [] };
  }
  const ids = streetUnits.map((unit) => canonicalId(unit?.id));
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    return { ok: false, status: 'blocked', deployable: false, code: 'INVALID_STREET_UNIT_IDS', zones: [], work_units: [] };
  }
  const byId = new Map(streetUnits.map((unit) => [unit.id, unit]));
  const knockUnits = streetUnits.filter((unit) => unit.canvas_role === 'knock').sort((left, right) => compareIds(left.id, right.id));
  const baseNeighbors = deriveNeighbors(streetUnits);
  const neighbors = effectiveKnockNeighbors(streetUnits, baseNeighbors);
  const knockIds = knockUnits.map((unit) => unit.id);
  if (!knockIds.length) {
    return {
      ok: false,
      status: 'needs_review',
      deployable: false,
      code: 'NO_KNOCK_OPPORTUNITY',
      zones: [],
      work_units: [],
      context_street_units: streetUnits,
      qa: { connected_zones: false, protected_units_intact: true, exclusive_work_unit_coverage: true },
    };
  }
  // Default stays opportunity count. `workload_basis: 'minutes'` opts into the
  // time-based objective and is an algorithm-version change (see the constant).
  const weighting = String(input.workload_basis ?? '') === 'minutes'
    ? { ...CANVAS_PARTITION_WORKLOAD_DEFAULTS, ...(input.workload_model || {}) }
    : null;
  const { atoms, atomNeighbors } = buildResidentialOwnershipAtoms(knockUnits, neighbors, weighting);
  const atomById = new Map(atoms.map((atom) => [atom.id, atom]));
  const atomIds = atoms.map((atom) => atom.id);

  // Manager-locked areas survive a regeneration unchanged, which is what
  // "preserve manager-locked areas and reduce churn during edits" requires.
  // A lock is only honoured when it is itself a legal territory: whole atoms
  // only, non-overlapping, and connected. Anything else is rejected rather than
  // quietly repartitioned, because a silently-moved lock is worse than an error.
  const lockFailure = (code) => ({
    ok: false, status: 'blocked', deployable: false, code, zones: [], work_units: knockUnits,
  });
  const atomIdByMemberUnitId = new Map();
  atoms.forEach((atom) => atom.member_unit_ids.forEach((unitId) => atomIdByMemberUnitId.set(unitId, atom.id)));

  const lockedGroups = [];
  const lockedAtomIds = new Set();
  for (const locked of (Array.isArray(input.locked_zones) ? input.locked_zones : [])) {
    const unitIds = (locked?.work_unit_ids || locked?.street_work_unit_ids || [])
      .map(canonicalId).filter(Boolean);
    if (!unitIds.length) return lockFailure('INVALID_LOCKED_ZONE');
    const unitIdSet = new Set(unitIds);
    const groupAtomIds = new Set();
    for (const unitId of unitIds) {
      const atomId = atomIdByMemberUnitId.get(unitId);
      if (!atomId) return lockFailure('LOCKED_UNIT_NOT_ELIGIBLE');
      if (lockedAtomIds.has(atomId)) return lockFailure('LOCKED_ZONE_OVERLAP');
      groupAtomIds.add(atomId);
    }
    // Taking whole atoms is what keeps a protected cul-de-sac from being cut.
    for (const atomId of groupAtomIds) {
      const members = atomById.get(atomId)?.member_unit_ids || [];
      if (!members.every((id) => unitIdSet.has(id))) return lockFailure('LOCKED_ZONE_SPLITS_PROTECTED_GROUP');
    }
    if (!idsConnected([...groupAtomIds], atomNeighbors)) return lockFailure('LOCKED_ZONE_DISCONNECTED');
    groupAtomIds.forEach((id) => lockedAtomIds.add(id));
    lockedGroups.push({
      ids: groupAtomIds,
      load: [...groupAtomIds].reduce((sum, id) => sum + workload(atomById.get(id)), 0),
      locked: true,
      locked_zone_id: locked?.zone_id ? String(locked.zone_id) : null,
    });
  }

  // Only the unlocked remainder is repartitioned, and it must stay connected
  // without routing through a locked atom.
  const freeAtomIds = atomIds.filter((id) => !lockedAtomIds.has(id));
  const freeNeighbors = new Map(freeAtomIds.map((id) => [
    id,
    (atomNeighbors.get(id) || []).filter((neighborId) => !lockedAtomIds.has(neighborId)),
  ]));
  const components = connectedComponents(freeAtomIds, freeNeighbors);
  const freeAreaCount = areaCount - lockedGroups.length;
  const minimumZoneCount = components.length + lockedGroups.length;
  const maximumZoneCount = freeAtomIds.length + lockedGroups.length;
  if (areaCount < minimumZoneCount || areaCount > maximumZoneCount) {
    return {
      ok: false,
      status: 'infeasible',
      deployable: false,
      code: areaCount < minimumZoneCount ? 'TOO_FEW_ZONES_FOR_COMPONENTS' : 'TOO_MANY_ZONES_FOR_WORK_UNITS',
      zones: [],
      work_units: knockUnits,
      details: { minimum_zone_count: minimumZoneCount, maximum_zone_count: maximumZoneCount },
    };
  }
  const allocation = allocateZoneCounts(components, freeAreaCount, atomById);
  const groups = [...lockedGroups];
  components.forEach((component, index) => {
    const partitioned = partitionComponent(component, allocation[index], atomById, freeNeighbors);
    if (partitioned) groups.push(...partitioned);
  });
  if (groups.length !== areaCount) {
    return { ok: false, status: 'infeasible', deployable: false, code: 'CONNECTED_PARTITION_FAILED', zones: [], work_units: knockUnits };
  }
  const total = atoms.reduce((sum, atom) => sum + workload(atom), 0);
  const target = total / areaCount;
  const zones = groups.map((group, index) => {
    const atomIdsInZone = [...group.ids].sort(compareIds);
    const workUnitIds = atomIdsInZone.flatMap((id) => atomById.get(id)?.member_unit_ids || []).sort(compareIds);
    const opportunity = workUnitIds.reduce((sum, id) => {
      const unit = byId.get(id);
      return sum + Number(unit?.opportunity?.expected ?? unit?.opportunity_expected ?? 0);
    }, 0);
    return {
      zone_id: `canvas-residential-zone:${index + 1}`,
      zone_number: index + 1,
      work_unit_ids: workUnitIds,
      opportunity_expected: opportunity,
      workload_score: group.load,
      ...(group.locked ? { locked: true } : {}),
      ...(group.workload_minutes !== undefined ? { workload_minutes: group.workload_minutes } : {}),
    };
  });
  const assignedIds = zones.flatMap((zone) => zone.work_unit_ids);
  const connected = groups.every((group) => idsConnected([...group.ids], atomNeighbors));
  const zoneByUnitId = new Map(zones.flatMap((zone) => zone.work_unit_ids.map((id) => [id, zone.zone_id])));
  const protectedGroupsIntact = atoms.filter((atom) => atom.protected_group_ids.length)
    .every((atom) => new Set(atom.member_unit_ids.map((id) => zoneByUnitId.get(id))).size === 1);
  const deviation = Math.max(...zones.map((zone) => Math.abs(zone.workload_score - target) / Math.max(1, target))) * 100;
  return {
    ok: connected && new Set(assignedIds).size === knockIds.length,
    status: 'ready',
    deployable: connected && new Set(assignedIds).size === knockIds.length,
    algorithm_version: ALGORITHM_VERSION,
    area_count: areaCount,
    zones,
    territories: zones,
    work_units: knockUnits,
    context_street_units: streetUnits.filter((unit) => unit.canvas_role !== 'knock'),
    shared_transit_unit_ids: streetUnits.filter((unit) => unit.canvas_role === 'transit_only').map((unit) => unit.id).sort(compareIds),
    qa: {
      connected_zones: connected,
      exclusive_work_unit_coverage: assignedIds.length === knockIds.length && new Set(assignedIds).size === knockIds.length,
      protected_units_intact: protectedGroupsIntact && knockUnits.filter((unit) => unit.protected)
        .every((unit) => assignedIds.filter((id) => id === unit.id).length === 1),
      minimum_zone_count: components.length,
      maximum_zone_count: atomIds.length,
      max_opportunity_deviation_percent: Number(deviation.toFixed(2)),
    },
  };
}

function relevantEvidenceElement(element) {
  const tags = tagsOf(element);
  return !tags.highway && ['building', 'landuse', 'natural', 'shop', 'amenity', 'entrance', 'barrier',
    'addr:housenumber', 'addr:street', 'building:units', 'building:flats', 'building:use', 'mixed_use']
    .some((key) => tags[key] !== undefined);
}

function nodeMapFrom(elements) {
  return new Map((elements || []).filter((element) => element?.type === 'node').map((element) => [
    canonicalId(element.id),
    { id: canonicalId(element.id), ...pointFrom(element), tags: tagsOf(element) },
  ]).filter(([id, point]) => id && Number.isFinite(point.lat) && Number.isFinite(point.lng)));
}

function accessEvidenceByUnit(workUnits, roadNetwork, evidenceFeatures, associations) {
  const result = new Map(workUnits.map((unit) => [unit.id, []]));
  const edgeTags = new Map();
  (roadNetwork?.elements || []).filter((element) => element?.type === 'way' && tagsOf(element).highway)
    .forEach((way) => {
      for (let index = 0; index < (way.nodes || []).length - 1; index += 1) {
        const edgeId = edgeIdFor(way.nodes[index], way.nodes[index + 1]);
        edgeTags.set(edgeId, [...(edgeTags.get(edgeId) || []), way]);
      }
    });
  workUnits.forEach((unit) => unit.edgeIds.forEach((edgeId) => {
    result.get(unit.id).push(...(edgeTags.get(edgeId) || []));
  }));
  const featureById = new Map(evidenceFeatures.map((feature) => [feature.id, feature]));
  associations.filter((association) => association.street_unit_id).forEach((association) => {
    const feature = featureById.get(association.feature_id);
    if (feature && (feature.tags?.barrier || feature.tags?.access || feature.tags?.foot)) {
      result.get(association.street_unit_id)?.push(feature);
    }
  });
  return result;
}

function safeBarrierNodeIds(elements) {
  return (elements || []).filter((element) => {
    if (element?.type !== 'node') return false;
    const tags = tagsOf(element);
    const foot = tag(tags, 'foot');
    if (PEDESTRIAN_ALLOWED.has(foot)) return false;
    return PEDESTRIAN_DENIED.has(foot)
      || (ACCESS_DENIED.has(tag(tags, 'access')) && !PEDESTRIAN_ALLOWED.has(foot))
      || (tag(tags, 'locked') === 'yes' && Boolean(tag(tags, 'barrier')));
  }).map((element) => canonicalId(element.id)).filter(Boolean).sort(compareIds);
}

function connectivityConnectorIds(units) {
  const neighbors = deriveNeighbors(units);
  const candidateIds = new Set(units.filter((unit) => (
    unit.canvas_role === 'knock'
      || (unit.opportunity_classification === 'none' && unit.access_classification === 'permitted')
  )).map((unit) => unit.id));
  const knockIds = new Set(units.filter((unit) => unit.canvas_role === 'knock').map((unit) => unit.id));
  const active = new Set(candidateIds);
  let changed = true;
  while (changed) {
    changed = false;
    [...active].sort(compareIds).forEach((id) => {
      if (knockIds.has(id)) return;
      const degree = (neighbors.get(id) || []).filter((neighborId) => active.has(neighborId)).length;
      if (degree <= 1) {
        active.delete(id);
        changed = true;
      }
    });
  }
  return new Set([...active].filter((id) => !knockIds.has(id)));
}

/** End-to-end deterministic residential analysis over an OSM-like road network. */
export function analyzeCanvasResidentialTerritory(input = {}) {
  const elements = input.roadNetwork?.elements || [];
  const topology = buildCanvasStreetWorkUnits({
    polygon: input.polygon,
    roadNetwork: input.roadNetwork,
    inferOsmBarriers: false,
    barrierNodeIds: safeBarrierNodeIds(elements),
  });
  if (!topology.ok) return { ...topology, classified_street_units: [], work_units: [], zones: [], territories: [] };
  const nodeMap = nodeMapFrom(elements);
  const rawFeatures = input.evidenceFeatures ?? input.features ?? elements.filter(relevantEvidenceElement);
  const features = normalizedFeatures(rawFeatures, nodeMap);
  const association = associateCanvasFeaturesToStreetUnits({
    ...input,
    features,
    street_units: topology.workUnits,
    nodeMap,
  });
  const aggregated = aggregateCanvasResidentialOpportunity({
    features,
    associations: association.associations,
    nodeMap,
  });
  const accessByUnit = accessEvidenceByUnit(topology.workUnits, input.roadNetwork, features, association.associations);
  let classified = topology.workUnits.map((unit) => {
    const opportunity = aggregated.by_street_unit[unit.id] || {
      low: 0, expected: 0, high: 0, residential_evidence: false,
      ambiguous_building_evidence: false, negative_evidence: false, open_land_evidence: false,
    };
    const classification = classifyCanvasStreetUnit({
      highwayTypes: unitHighways(unit),
      opportunity,
      residential_evidence: opportunity.residential_evidence,
      ambiguous_building_evidence: opportunity.ambiguous_building_evidence,
      negative_evidence: opportunity.negative_evidence,
      open_land_evidence: opportunity.open_land_evidence,
      access_evidence: accessByUnit.get(unit.id),
    });
    return {
      ...unit,
      street_names: unit.streetNames,
      neighbor_ids: unit.neighborIds,
      ...classification,
      confidence: opportunity.sources?.includes('deduplicated_addresses')
        || opportunity.sources?.includes('explicit_units') ? 'high'
        : opportunity.expected > 0 ? 'low' : 'none',
    };
  });
  const connectors = connectivityConnectorIds(classified);
  classified = classified.map((unit) => {
    if (!connectors.has(unit.id)) return unit;
    return classifyCanvasStreetUnit({
      ...unit,
      highwayTypes: unitHighways(unit),
      opportunity: unit.opportunity,
      negative_evidence: true,
      connectivity_needed: true,
      access_evidence: accessByUnit.get(unit.id),
    });
  }).map((unit, index) => ({
    ...topology.workUnits[index],
    ...unit,
    street_names: topology.workUnits[index].streetNames,
    neighbor_ids: topology.workUnits[index].neighborIds,
  }));

  const partition = partitionCanvasResidentialTerritories({
    street_units: classified,
    area_count: input.area_count ?? input.requested_zone_count ?? input.zone_count ?? 1,
  });
  const uncertain = classified.filter((unit) => unit.canvas_role === 'uncertain');
  const excluded = classified.filter((unit) => unit.canvas_role === 'excluded');
  const transit = classified.filter((unit) => unit.canvas_role === 'transit_only');
  const classifiedProperties = aggregated.entity_estimates;
  const propertySummary = summarizeCanvasPropertyClassifications(classifiedProperties);
  const uncertainProperties = classifiedProperties.filter((property) => property.canvass_eligibility === 'review');
  const structurallyOk = partition.ok || partition.code === 'NO_KNOCK_OPPORTUNITY';
  return {
    ok: structurallyOk,
    status: uncertainProperties.length || !partition.ok ? 'needs_review' : 'ready',
    deployable: Boolean(partition.ok && !uncertainProperties.length),
    algorithm_version: ALGORITHM_VERSION,
    classified_street_units: classified,
    feature_associations: association.associations,
    opportunity_by_street_unit: aggregated.by_street_unit,
    opportunity_entities: aggregated.entity_estimates,
    classified_properties: classifiedProperties,
    uncertain_properties: uncertainProperties,
    property_classification_summary: propertySummary,
    zones: partition.zones || [],
    territories: partition.zones || [],
    work_units: classified.filter((unit) => unit.canvas_role === 'knock'),
    context_street_units: classified.filter((unit) => unit.canvas_role !== 'knock'),
    uncertain_street_units: uncertain,
    excluded_street_units: excluded,
    transit_street_units: transit,
    shared_transit_unit_ids: transit.map((unit) => unit.id).sort(compareIds),
    qa: {
      ...(partition.qa || {}),
      unresolved_uncertain_count: uncertainProperties.length,
      unresolved_property_count: uncertainProperties.length,
      property_automatic_resolution_percent: propertySummary.automatically_resolved_percent,
      unassociated_feature_count: association.unassociated.length,
      cul_de_sac_splits: partition.qa?.protected_units_intact === false ? 1 : 0,
    },
    warnings: [
      ...(topology.warnings || []),
      ...association.unassociated.map((item) => ({ code: 'UNASSOCIATED_EVIDENCE', ...item })),
    ],
    partition,
  };
}