import { canonicalStringify } from '../contract.mjs';
import { normalizeCanvasSourceEvidenceTile } from '../source-normalizer.mjs';
import { normalizeOvertureAddress, sanitizeSourceFeatureId } from './identity.mjs';
import { bboxAreaSqMi, boundsForFeatures, distanceToLineMeters, featureContainsPoint, pointOf } from './geometry.mjs';

const OVERTURE_LICENSE = 'ODbL-1.0';
const OSM_LICENSE = 'ODbL-1.0';
const norm = (value) => String(value ?? '').trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
const source = (id, provider, version, license, observedAt) => ({ source_id: id, provider, dataset_version: version, license, captured_at: observedAt });
const provenance = (sourceId, version, featureId, observedAt, license = OVERTURE_LICENSE) => [{ source_id: sourceId, dataset_version: version, feature_id: sanitizeSourceFeatureId(featureId), observed_at: observedAt, license }];

const BUILDING_USE = new Map([
  ['residential', 'residential'], ['house', 'house'], ['detached', 'detached'], ['semi_detached', 'semidetached_house'], ['apartments', 'apartments'], ['commercial', 'commercial'], ['industrial', 'industrial'], ['warehouse', 'warehouse'], ['retail', 'retail'], ['office', 'office'], ['school', 'school'], ['hospital', 'hospital'], ['civic', 'civic'], ['religious', 'religious'], ['garage', 'garage'],
]);
const PLACE_USE = new Map([
  ['school', 'school'], ['university', 'university'], ['hospital', 'hospital'], ['government', 'government'], ['public_service', 'government'], ['religious_organization', 'religious'], ['place_of_worship', 'religious'], ['hotel', 'hotel'], ['warehouse', 'warehouse'], ['office', 'office'], ['store', 'retail'], ['shopping', 'retail'], ['retail', 'retail'], ['restaurant', 'commercial'], ['commercial_service', 'commercial'],
]);

function collection(value, label) {
  if (!value) return [];
  if (value.type === 'FeatureCollection' && Array.isArray(value.features)) return value.features;
  if (Array.isArray(value)) return value;
  throw new TypeError(`${label} must be a GeoJSON FeatureCollection.`);
}

function roadIdentity(feature, index) {
  return { source_namespace: 'overture-transportation', source_feature_id: sanitizeSourceFeatureId(feature?.id || feature?.properties?.id, `segment-${index}`), segment_index: 0, from_millionths: 0, to_millionths: 1_000_000 };
}

function roadClass(feature) {
  const value = norm(feature?.properties?.class);
  return ['residential', 'living_street', 'service', 'unclassified', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway', 'pedestrian', 'path', 'footway', 'cycleway', 'track'].includes(value) ? value : 'unknown';
}

function roadName(feature) {
  return norm(feature?.properties?.names?.primary || feature?.properties?.name);
}

function roadAccess(feature) {
  const restrictions = feature?.properties?.access_restrictions || [];
  return restrictions.some((item) => ['denied', 'no', 'private'].includes(norm(item?.access_type || item?.value))) ? 'denied' : 'public';
}

function buildRoads(features, version, observedAt) {
  const candidates = features.filter((feature) => feature?.geometry?.type === 'LineString' && feature?.properties?.subtype !== 'rail');
  const identities = candidates.map(roadIdentity);
  const byConnector = new Map();
  candidates.forEach((feature, index) => (feature?.properties?.connectors || []).forEach((connector) => {
    const id = String(connector?.connector_id || connector?.id || '');
    if (id) byConnector.set(id, [...(byConnector.get(id) || []), index]);
  }));
  const neighborIndexes = candidates.map(() => new Set());
  for (const indexes of byConnector.values()) indexes.forEach((index) => indexes.forEach((other) => { if (other !== index) neighborIndexes[index].add(other); }));
  return candidates.map((feature, index) => ({
    identity: identities[index],
    geometry: feature.geometry,
    road_class: roadClass(feature),
    legal_access: roadAccess(feature),
    provenance: provenance('overture-transportation', version, feature.id || feature.properties?.id || `segment-${index}`, observedAt),
    neighbors: [...neighborIndexes[index]].sort((a, b) => a - b).map((other) => ({ identity: identities[other], scope: 'release' })),
    _name: roadName(feature),
  }));
}

function nearestRoad(point, street, roads, maxMeters) {
  const named = roads.map((road, index) => ({ road, index, distance: distanceToLineMeters(point, road.geometry.coordinates) }))
    .filter((candidate) => street && candidate.road._name === street)
    .sort((left, right) => left.distance - right.distance || left.index - right.index);
  if (named[0]) return { ...named[0], method: 'address_street' };
  const nearest = roads.map((road, index) => ({ road, index, distance: distanceToLineMeters(point, road.geometry.coordinates) }))
    .sort((left, right) => left.distance - right.distance || left.index - right.index)[0];
  return nearest && nearest.distance <= maxMeters ? { ...nearest, method: 'nearest_road' } : null;
}

function buildingUse(feature) {
  return BUILDING_USE.get(norm(feature?.properties?.class)) || BUILDING_USE.get(norm(feature?.properties?.subtype)) || 'yes';
}

function placeUse(feature) {
  const values = [feature?.properties?.categories?.primary, ...(feature?.properties?.categories?.alternate || []), feature?.properties?.amenity, feature?.properties?.shop, feature?.properties?.office].map(norm);
  for (const value of values) {
    if (PLACE_USE.has(value)) return PLACE_USE.get(value);
    for (const [token, mapped] of PLACE_USE) if (value.includes(token)) return mapped;
  }
  return null;
}

function linkedContext(point, features, radiusMeters = 35) {
  return features.filter((feature) => featureContainsPoint(feature, point) || (() => {
    const candidate = pointOf(feature);
    if (!candidate) return false;
    return distanceToLineMeters(point, [[candidate.lng, candidate.lat], [candidate.lng, candidate.lat]]) <= radiusMeters;
  })());
}

export function buildOvertureCanvasRegion({ addresses, buildings, places, roads, osm = null, nad = null, assessors = null, regionKey, releaseVersion, observedAt, maxNearestRoadMeters = 60 } = {}) {
  const addressFeatures = collection(addresses, 'addresses');
  const buildingFeatures = collection(buildings, 'buildings');
  const placeFeatures = [...collection(places, 'places'), ...collection(osm, 'osm')];
  const roadFeatures = collection(roads, 'roads');
  const supportingAddresses = [...collection(nad, 'nad'), ...collection(assessors, 'assessors')];
  if (!addressFeatures.length || !roadFeatures.length) throw new TypeError('A regional Canvas build requires Overture addresses and transportation segments.');
  const roadRecords = buildRoads(roadFeatures, releaseVersion, observedAt);
  const evidence = [];
  const unlinked = [];
  const seenProperties = new Set();
  for (const [index, feature] of [...addressFeatures, ...supportingAddresses].entries()) {
    const point = pointOf(feature);
    if (!point) continue;
    let identity;
    try { identity = normalizeOvertureAddress(feature.properties || {}); } catch { continue; }
    if (seenProperties.has(identity.property_key)) continue;
    seenProperties.add(identity.property_key);
    const road = nearestRoad(point, norm(feature.properties?.street), roadRecords, maxNearestRoadMeters);
    if (!road) { unlinked.push({ fk_property_id: identity.fk_property_id, normalized_address: identity.normalized_address, point }); continue; }
    const association = { method: road.method, road_identity: road.road.identity, ...(road.method === 'nearest_road' ? { distance_m: Number(road.distance.toFixed(2)) } : {}) };
    const matchedBuildings = buildingFeatures.filter((building) => featureContainsPoint(building, point));
    const matchedPlaces = linkedContext(point, placeFeatures);
    const residentialBuilding = matchedBuildings.map(buildingUse).find((use) => ['residential', 'house', 'detached', 'semidetached_house', 'apartments'].includes(use));
    const excludedPlace = matchedPlaces.map(placeUse).find(Boolean);
    const occupancy = excludedPlace ? 'commercial' : residentialBuilding ? 'residential' : 'unknown';
    const addressSourceId = index < addressFeatures.length ? 'overture-addresses' : feature?.properties?._adapter_source === 'assessor' ? 'public-assessor' : 'national-address-database';
    const license = addressSourceId === 'overture-addresses' ? OVERTURE_LICENSE : 'public-data';
    evidence.push({
      evidence_id: `${addressSourceId}:${sanitizeSourceFeatureId(feature.id || feature.properties?.id, `address-${index}`)}`,
      kind: 'address', property_key: identity.property_key, location: point,
      attributes: { address_key: identity.property_key, normalized_address: identity.normalized_address, display_address: identity.display_address, unit_keys: feature.properties?.unit ? [String(feature.properties.unit)] : [], occupancy },
      associations: [association],
      provenance: provenance(addressSourceId, releaseVersion, feature.id || feature.properties?.id || `address-${index}`, observedAt, license),
    });
    matchedBuildings.slice(0, 1).forEach((building, buildingIndex) => evidence.push({
      evidence_id: `overture-building:${sanitizeSourceFeatureId(building.id || building.properties?.id, `${index}-${buildingIndex}`)}`,
      kind: 'building', property_key: identity.property_key, location: point,
      attributes: { building_use: buildingUse(building), ...(Number.isInteger(building.properties?.unit_count) && building.properties.unit_count > 0 ? { unit_count: building.properties.unit_count } : {}) },
      associations: [{ method: 'side_of_street', road_identity: road.road.identity }],
      provenance: provenance('overture-buildings', releaseVersion, building.id || building.properties?.id || `${index}-${buildingIndex}`, observedAt),
    }));
    matchedPlaces.forEach((place, placeIndex) => {
      const use = placeUse(place);
      if (!use) return;
      const osmFeature = !String(place.id || '').includes('-') && (place.properties?.osm_id || place.properties?.amenity || place.properties?.shop);
      const sourceId = osmFeature ? 'openstreetmap' : 'overture-places';
      evidence.push({ evidence_id: `${sourceId}:${sanitizeSourceFeatureId(place.id || place.properties?.id, `${index}-${placeIndex}`)}`, kind: 'place', property_key: identity.property_key, location: point, attributes: { place_use: use }, associations: [{ method: 'area_overlap', road_identity: road.road.identity }], provenance: provenance(sourceId, releaseVersion, place.id || place.properties?.id || `${index}-${placeIndex}`, observedAt, sourceId === 'openstreetmap' ? OSM_LICENSE : OVERTURE_LICENSE) });
    });
  }
  const allGeometry = [...addressFeatures, ...roadFeatures];
  const bounds = boundsForFeatures(allGeometry);
  const sourceTile = {
    schema: 'firstknock.canvas-source-evidence-tile', schema_version: 1,
    tile_address: { scheme: 'firstknock-regional-grid', scheme_version: 1, key: sanitizeSourceFeatureId(regionKey, 'region') },
    coverage: { area_sq_mi: Number(bboxAreaSqMi(bounds).toFixed(6)), bounds },
    road_segments: roadRecords.map(({ _name, ...road }) => road), evidence, protected_groups: [],
  };
  const normalizedTile = normalizeCanvasSourceEvidenceTile(sourceTile, { maxNearestRoadMeters });
  const counts = normalizedTile.properties.reduce((result, property) => { result[property.canvass_eligibility] += 1; return result; }, { eligible: 0, excluded: 0, review: 0 });
  return {
    source_tile: sourceTile,
    normalized_tile: normalizedTile,
    sources: [
      source('overture-addresses', 'Overture Maps Addresses', releaseVersion, OVERTURE_LICENSE, observedAt),
      source('overture-buildings', 'Overture Maps Buildings', releaseVersion, OVERTURE_LICENSE, observedAt),
      source('overture-places', 'Overture Maps Places', releaseVersion, OVERTURE_LICENSE, observedAt),
      source('overture-transportation', 'Overture Maps Transportation', releaseVersion, OVERTURE_LICENSE, observedAt),
      ...(osm ? [source('openstreetmap', 'OpenStreetMap', releaseVersion, OSM_LICENSE, observedAt)] : []),
      ...(nad ? [source('national-address-database', 'National Address Database', releaseVersion, 'public-data', observedAt)] : []),
      ...(assessors ? [source('public-assessor', 'Public assessor/parcel feeds', releaseVersion, 'public-data', observedAt)] : []),
    ].filter((record) => normalizedTile.properties.some((property) => property.provenance.some((item) => item.source_id === record.source_id)) || record.source_id === 'overture-transportation'),
    report: { region_key: regionKey, overture_release: releaseVersion, discovered_address_count: seenProperties.size, signed_property_count: normalizedTile.properties.length, unlinked_property_count: unlinked.length, property_classification_counts: counts, eligible_door_count: normalizedTile.properties.filter((property) => property.canvass_eligibility === 'eligible').reduce((sum, property) => sum + property.door_count, 0), batchdata_call_count: 0, input_digest: canonicalStringify({ addresses: addressFeatures.length, buildings: buildingFeatures.length, places: placeFeatures.length, roads: roadFeatures.length }) },
    unlinked_properties: unlinked,
  };
}