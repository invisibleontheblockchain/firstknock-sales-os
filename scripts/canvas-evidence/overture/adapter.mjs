import { canonicalStringify, canonicalWorkUnitId } from '../contract.mjs';
import { normalizeCanvasSourceEvidenceTile } from '../source-normalizer.mjs';
import { normalizeOvertureAddress, sanitizeSourceFeatureId } from './identity.mjs';
import { bboxAreaSqMi, boundsForFeatures, distanceToLineMeters, featureContainsPoint, lineIntersectsRing, pointInRing, pointOf } from './geometry.mjs';

const OVERTURE_LICENSE = 'ODbL-1.0';
const OSM_LICENSE = 'ODbL-1.0';
const norm = (value) => String(value ?? '').trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
const source = (id, provider, version, license, observedAt) => ({ source_id: id, provider, dataset_version: version, license, captured_at: observedAt });
const provenance = (sourceId, version, featureId, observedAt, license = OVERTURE_LICENSE) => [{ source_id: sourceId, dataset_version: version, feature_id: sanitizeSourceFeatureId(featureId), observed_at: observedAt, license }];

const BUILDING_USE = new Map([
  ['residential', 'residential'], ['house', 'house'], ['detached', 'detached'], ['semi_detached', 'semidetached_house'], ['apartments', 'apartments'], ['terrace', 'terrace'], ['commercial', 'commercial'], ['industrial', 'industrial'], ['warehouse', 'warehouse'], ['retail', 'retail'], ['office', 'office'], ['school', 'school'], ['hospital', 'hospital'], ['civic', 'civic'], ['religious', 'religious'], ['garage', 'garage'], ['shed', 'nonresidential'], ['farm_auxiliary', 'nonresidential'],
]);
const PLACE_USE = new Map([
  ['residential', 'residential'], ['school', 'school'], ['university', 'university'], ['hospital', 'hospital'], ['government', 'government'], ['public_service', 'government'], ['religious_organization', 'religious'], ['place_of_worship', 'religious'], ['church', 'religious'], ['hotel', 'hotel'], ['warehouse', 'warehouse'], ['office', 'office'], ['store', 'retail'], ['shopping', 'retail'], ['retail', 'retail'], ['restaurant', 'commercial'], ['commercial_service', 'commercial'], ['professional_services', 'commercial'], ['contractor', 'commercial'], ['parking', 'parking'],
]);
const LAND_USE = new Map([
  ['residential', 'residential'], ['commercial', 'commercial'], ['retail', 'retail'], ['office', 'office'], ['industrial', 'industrial'], ['farmland', 'farmland'], ['farmyard', 'farmyard'], ['meadow', 'meadow'], ['orchard', 'orchard'], ['forest', 'forest'], ['quarry', 'quarry'], ['construction', 'construction'], ['institutional', 'institutional'], ['education', 'education'], ['healthcare', 'healthcare'], ['military', 'military'], ['cemetery', 'cemetery'], ['recreation_ground', 'recreation'], ['park', 'recreation'], ['nature_reserve', 'recreation'], ['parking', 'parking'],
]);

export const CANVAS_PROPERTY_IDENTITY_VERSION = 'fk-property-key-v1';
export const CANVAS_OSM_ASSERTION_NORMALIZATION_VERSION = 'osm-assertions-v2';

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
  const value = norm(feature?.properties?.class || feature?.properties?.highway);
  return ['residential', 'living_street', 'service', 'unclassified', 'tertiary', 'tertiary_link', 'secondary', 'secondary_link', 'primary', 'primary_link', 'trunk', 'trunk_link', 'motorway', 'motorway_link', 'pedestrian', 'path', 'footway', 'cycleway', 'track'].includes(value) ? value : 'unknown';
}

function roadName(feature) {
  return norm(feature?.properties?.names?.primary || feature?.properties?.name);
}

function roadAccess(feature) {
  const restrictions = feature?.properties?.access_restrictions || [];
  const direct = norm(feature?.properties?.access);
  return ['denied', 'no', 'private'].includes(direct) || restrictions.some((item) => ['denied', 'no', 'private'].includes(norm(item?.access_type || item?.value))) ? 'denied' : 'public';
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
    identity: identities[index], geometry: feature.geometry, road_class: roadClass(feature), legal_access: roadAccess(feature),
    provenance: provenance('overture-transportation', version, feature.id || feature.properties?.id || `segment-${index}`, observedAt),
    neighbors: [...neighborIndexes[index]].sort((a, b) => a - b).map((other) => ({ identity: identities[other], scope: 'release' })), _name: roadName(feature),
  }));
}

const OSM_TRAVERSABLE_HIGHWAYS = new Set(['residential', 'living_street', 'service', 'unclassified', 'tertiary', 'tertiary_link', 'secondary', 'secondary_link', 'primary', 'primary_link', 'trunk', 'trunk_link', 'motorway', 'motorway_link']);

export function buildOsmRoadGraph(features, version, observedAt) {
  const ways = features.filter((feature) => feature?.geometry?.type === 'LineString' && OSM_TRAVERSABLE_HIGHWAYS.has(norm(feature?.properties?.highway)))
    .sort((left, right) => String(left.id || left.properties?.id).localeCompare(String(right.id || right.properties?.id), 'en', { numeric: true }));
  const nodeUse = new Map();
  ways.forEach((feature) => {
    const nodeIds = feature?.properties?.node_ids;
    const coordinates = feature.geometry.coordinates || [];
    if (!Array.isArray(nodeIds) || nodeIds.length !== coordinates.length) throw new TypeError('OSM road features require one authoritative node_id per coordinate.');
    new Set(nodeIds.map(String)).forEach((node) => nodeUse.set(node, (nodeUse.get(node) || 0) + 1));
  });
  const edges = [];
  ways.forEach((feature, featureIndex) => {
    const coordinates = feature.geometry.coordinates;
    const nodeIds = feature.properties.node_ids.map(String);
    const featureId = sanitizeSourceFeatureId(feature.id || feature.properties?.id, `way-${featureIndex}`);
    const last = coordinates.length - 1;
    const forced = new Set([0, last]);
    if (nodeIds[0] === nodeIds[last] && last >= 2) forced.add(Math.floor(last / 2));
    let anchor = 0;
    let segmentIndex = 0;
    for (let index = 1; index <= last; index += 1) {
      if (index !== last && !forced.has(index) && (nodeUse.get(nodeIds[index]) || 0) < 2) continue;
      if (nodeIds[anchor] === nodeIds[index]) { anchor = index; continue; }
      const identity = { source_namespace: 'openstreetmap', source_feature_id: featureId, segment_index: segmentIndex, from_millionths: Math.round(anchor / last * 1_000_000), to_millionths: Math.round(index / last * 1_000_000) };
      edges.push({ identity, geometry: { type: 'LineString', coordinates: coordinates.slice(anchor, index + 1) }, road_class: roadClass(feature), legal_access: roadAccess(feature), provenance: provenance('openstreetmap', version, feature.id || feature.properties?.id || `way-${featureIndex}`, observedAt, OSM_LICENSE), _name: roadName(feature), _nodes: [nodeIds[anchor], nodeIds[index]] });
      anchor = index;
      segmentIndex += 1;
    }
  });
  const byNode = new Map();
  edges.forEach((edge, index) => edge._nodes.forEach((node) => byNode.set(node, [...(byNode.get(node) || []), index])));
  edges.forEach((edge, index) => { edge.neighbors = [...new Set(edge._nodes.flatMap((node) => byNode.get(node) || []).filter((other) => other !== index))].sort((a, b) => a - b).map((other) => ({ identity: edges[other].identity, scope: 'release' })); });
  const claimed = new Set();
  const protectedGroups = [];
  const orderedTerminals = [...byNode.entries()].filter(([, indexes]) => indexes.length === 1).sort(([left], [right]) => left.localeCompare(right));
  for (const [terminalNode, indexes] of orderedTerminals) {
    if (claimed.has(indexes[0])) continue;
    const members = [];
    let currentEdge = indexes[0];
    let currentNode = terminalNode;
    while (!claimed.has(currentEdge)) {
      members.push(currentEdge);
      const edge = edges[currentEdge];
      const nextNode = edge._nodes[0] === currentNode ? edge._nodes[1] : edge._nodes[0];
      const incident = byNode.get(nextNode) || [];
      if (incident.length !== 2) break;
      const nextEdge = incident.find((candidate) => candidate !== currentEdge);
      if (nextEdge === undefined || members.includes(nextEdge)) break;
      currentNode = nextNode;
      currentEdge = nextEdge;
    }
    const entry = members.at(-1);
    const memberIds = new Set(members.map((member) => canonicalStringify(edges[member].identity)));
    if (!edges[entry].neighbors.some((neighbor) => !memberIds.has(canonicalStringify(neighbor.identity)))) continue;
    members.forEach((member) => claimed.add(member));
    protectedGroups.push({ kind: 'cul_de_sac', members: members.map((member) => edges[member].identity), entries: [edges[entry].identity] });
  }
  return { roadRecords: edges.map(({ _nodes, ...edge }) => edge), protectedGroups };
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
  return BUILDING_USE.get(norm(feature?.properties?.class))
    || BUILDING_USE.get(norm(feature?.properties?.subtype))
    || BUILDING_USE.get(norm(feature?.properties?.building))
    || 'yes';
}

function placeUse(feature) {
  const values = [feature?.properties?.categories?.primary, ...(feature?.properties?.categories?.alternate || []), feature?.properties?.amenity, feature?.properties?.shop ? 'retail' : '', feature?.properties?.office ? 'office' : '', feature?.properties?.government ? 'government' : ''].map(norm);
  for (const value of values) {
    if (PLACE_USE.has(value)) return PLACE_USE.get(value);
    for (const [token, mapped] of PLACE_USE) if (value.includes(token)) return mapped;
  }
  return null;
}

function landUse(feature) {
  for (const value of [norm(feature?.properties?.landuse), norm(feature?.properties?.leisure)]) {
    if (LAND_USE.has(value)) return LAND_USE.get(value);
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

export function buildOverturePropertyEvidence({ addressFeatures, supportingAddresses = [], buildingFeatures, placeFeatures, roadRecords, releaseVersion, observedAt, osmSource = null, maxNearestRoadMeters = 60 } = {}) {
  const evidence = [];
  const unlinked = [];
  const canonicalProperties = new Set();
  const assertionIds = new Set();
  const allAddresses = [...addressFeatures, ...supportingAddresses];
  const sourceDetails = (feature, defaultSourceId) => {
    const osmEvidence = feature?.properties?._adapter_source === 'osm';
    return osmEvidence
      ? { sourceId: osmSource?.source_id || 'openstreetmap', sourceVersion: osmSource?.dataset_version || releaseVersion, sourceObservedAt: osmSource?.captured_at || observedAt, sourceLicense: osmSource?.license || OSM_LICENSE }
      : { sourceId: defaultSourceId, sourceVersion: releaseVersion, sourceObservedAt: observedAt, sourceLicense: defaultSourceId.startsWith('overture-') ? OVERTURE_LICENSE : 'public-data' };
  };
  const addAssertion = ({ feature, fallback, kind, propertyId, defaultSourceId, location, attributes, association }) => {
    const details = sourceDetails(feature, defaultSourceId);
    const featureId = sanitizeSourceFeatureId(feature?.id || feature?.properties?.id, fallback).slice(0, 120);
    const evidenceId = `${details.sourceId}:${featureId}:${kind}:${propertyId}`;
    if (assertionIds.has(evidenceId)) return;
    assertionIds.add(evidenceId);
    evidence.push({
      evidence_id: evidenceId,
      kind,
      property_key: propertyId,
      location,
      attributes,
      associations: [association],
      provenance: provenance(details.sourceId, details.sourceVersion, feature?.id || feature?.properties?.id || fallback, details.sourceObservedAt, details.sourceLicense),
    });
  };

  for (const [index, feature] of allAddresses.entries()) {
    const point = pointOf(feature);
    if (!point) continue;
    let identity;
    try { identity = normalizeOvertureAddress(feature.properties || {}); } catch { continue; }
    canonicalProperties.add(identity.property_key);
    const road = nearestRoad(point, norm(feature.properties?.street), roadRecords, maxNearestRoadMeters);
    if (!road) {
      unlinked.push({ fk_property_id: identity.fk_property_id, normalized_address: identity.normalized_address, point });
      continue;
    }
    const association = { method: road.method, road_identity: road.road.identity, ...(road.method === 'nearest_road' ? { distance_m: Number(road.distance.toFixed(2)) } : {}) };
    const matchedBuildings = buildingFeatures.filter((building) => featureContainsPoint(building, point));
    const matchedContext = linkedContext(point, placeFeatures);
    const residentialBuilding = matchedBuildings.map(buildingUse).find((use) => ['residential', 'house', 'detached', 'semidetached_house', 'terrace', 'apartments'].includes(use));
    const placeUses = matchedContext.map(placeUse).filter(Boolean);
    const landUses = matchedContext.map(landUse).filter(Boolean);
    const residentialContext = placeUses.includes('residential') || landUses.includes('residential');
    const excludedContext = placeUses.find((use) => use !== 'residential') || landUses.find((use) => use !== 'residential');
    const occupancy = excludedContext ? 'commercial' : residentialBuilding || residentialContext ? 'residential' : 'unknown';
    const addressSourceId = index < addressFeatures.length ? 'overture-addresses' : feature?.properties?._adapter_source === 'assessor' ? 'public-assessor' : 'national-address-database';
    addAssertion({
      feature, fallback: `address-${index}`, kind: 'address', propertyId: identity.property_key,
      defaultSourceId: addressSourceId, location: point,
      attributes: { address_key: identity.property_key, normalized_address: identity.normalized_address, display_address: identity.display_address, unit_keys: feature.properties?.unit ? [String(feature.properties.unit)] : [], occupancy },
      association,
    });
    matchedBuildings.slice(0, 8).forEach((building, buildingIndex) => addAssertion({
      feature: building, fallback: `${index}-${buildingIndex}`, kind: 'building', propertyId: identity.property_key,
      defaultSourceId: 'overture-buildings', location: point,
      attributes: { building_use: buildingUse(building), ...(Number.isInteger(building.properties?.unit_count) && building.properties.unit_count > 0 ? { unit_count: building.properties.unit_count } : {}) },
      association: { method: 'side_of_street', road_identity: road.road.identity },
    }));
    matchedContext.forEach((context, contextIndex) => {
      const use = placeUse(context);
      if (use) addAssertion({
        feature: context, fallback: `${index}-${contextIndex}`, kind: 'place', propertyId: identity.property_key,
        defaultSourceId: 'overture-places', location: point, attributes: { place_use: use },
        association: { method: 'area_overlap', road_identity: road.road.identity },
      });
      const land = landUse(context);
      if (land) addAssertion({
        feature: context, fallback: `${index}-${contextIndex}`, kind: 'land_use', propertyId: identity.property_key,
        defaultSourceId: 'overture-places', location: point, attributes: { land_use: land },
        association: { method: 'area_overlap', road_identity: road.road.identity },
      });
    });
  }
  return {
    evidence,
    unlinked,
    rawAddressRecordCount: allAddresses.length,
    canonicalPropertyCount: canonicalProperties.size,
    duplicateAddressRecordCount: allAddresses.length - canonicalProperties.size,
    discoveredPropertyCount: canonicalProperties.size,
    evidenceAssertionCount: evidence.length,
  };
}

export function partitionNormalizedCanvasTile(tile, tileCount = 1) {
  if (!Number.isInteger(tileCount) || tileCount < 1) throw new TypeError('tileCount must be a positive integer.');
  if (tileCount === 1) return [tile];
  const unitById = new Map(tile.work_units.map((unit) => [canonicalWorkUnitId(unit.identity), unit]));
  const groupedIds = new Set();
  const atoms = (tile.protected_groups || []).map((group, index) => {
    const ids = group.members.map(canonicalWorkUnitId);
    ids.forEach((id) => groupedIds.add(id));
    return { key: `group:${index}`, ids, group };
  });
  tile.work_units.forEach((unit) => {
    const id = canonicalWorkUnitId(unit.identity);
    if (!groupedIds.has(id)) atoms.push({ key: `unit:${id}`, ids: [id], group: null });
  });
  const center = (atom) => {
    const points = atom.ids.flatMap((id) => unitById.get(id).geometry.coordinates);
    return { lng: points.reduce((sum, point) => sum + Number(point[0]), 0) / points.length, lat: points.reduce((sum, point) => sum + Number(point[1]), 0) / points.length };
  };
  atoms.sort((left, right) => center(left).lng - center(right).lng || center(left).lat - center(right).lat || left.key.localeCompare(right.key));
  const buckets = Array.from({ length: tileCount }, () => ({ ids: new Set(), groups: [] }));
  atoms.forEach((atom, index) => {
    const bucket = buckets[Math.min(tileCount - 1, Math.floor(index * tileCount / atoms.length))];
    atom.ids.forEach((id) => bucket.ids.add(id));
    if (atom.group) bucket.groups.push(atom.group);
  });
  const propertyByUnit = new Map();
  (tile.properties || []).forEach((property) => {
    const id = canonicalWorkUnitId(property.work_unit_identity);
    propertyByUnit.set(id, [...(propertyByUnit.get(id) || []), property]);
  });
  return buckets.map((bucket, index) => {
    const workUnits = tile.work_units.filter((unit) => bucket.ids.has(canonicalWorkUnitId(unit.identity)));
    const properties = workUnits.flatMap((unit) => propertyByUnit.get(canonicalWorkUnitId(unit.identity)) || []);
    const geometryFeatures = [
      ...workUnits.map((unit) => ({ geometry: unit.geometry })),
      ...properties.map((property) => ({ geometry: { type: 'Point', coordinates: [property.point.lng, property.point.lat] } })),
    ];
    const bounds = boundsForFeatures(geometryFeatures);
    return {
      ...tile,
      tile_address: { ...tile.tile_address, key: `${tile.tile_address.key}-${String(index + 1).padStart(2, '0')}` },
      coverage: { area_sq_mi: Number(bboxAreaSqMi(bounds).toFixed(6)), bounds },
      work_units: workUnits,
      properties,
      protected_groups: bucket.groups,
    };
  });
}

export function buildOvertureCanvasRegion({ addresses, buildings, places, roads, osm = null, nad = null, assessors = null, propertyPolygon = null, osmSource = null, regionKey, releaseVersion, observedAt, maxNearestRoadMeters = 60 } = {}) {
  const polygonRing = Array.isArray(propertyPolygon) ? propertyPolygon.map((point) => [Number(point.lng), Number(point.lat)]) : null;
  const addressRecords = collection(addresses, 'addresses');
  const addressFeatures = polygonRing ? addressRecords.filter((feature) => { const point = pointOf(feature); return point && pointInRing(point, polygonRing); }) : addressRecords;
  const buildingFeatures = collection(buildings, 'buildings');
  const placeFeatures = [...collection(places, 'places'), ...collection(osm, 'osm')];
  const roadFeatures = collection(roads, 'roads');
  const supportingRecords = [...collection(nad, 'nad'), ...collection(assessors, 'assessors')];
  const supportingAddresses = polygonRing ? supportingRecords.filter((feature) => { const point = pointOf(feature); return point && pointInRing(point, polygonRing); }) : supportingRecords;
  if (!addressFeatures.length || !roadFeatures.length) throw new TypeError('A regional Canvas build requires Overture addresses and transportation segments.');
  const osmRoadAuthority = roadFeatures.some((feature) => Array.isArray(feature?.properties?.node_ids));
  const roadGraph = osmRoadAuthority ? buildOsmRoadGraph(roadFeatures, osmSource?.dataset_version || releaseVersion, osmSource?.captured_at || observedAt) : { roadRecords: buildRoads(roadFeatures, releaseVersion, observedAt), protectedGroups: [] };
  const roadRecords = roadGraph.roadRecords;
  const linkageRoadRecords = polygonRing ? roadRecords.filter((road) => lineIntersectsRing(road.geometry.coordinates, polygonRing)) : roadRecords;
  const { evidence, unlinked, discoveredPropertyCount } = buildOverturePropertyEvidence({
    addressFeatures, supportingAddresses, buildingFeatures, placeFeatures, roadRecords: linkageRoadRecords,
    releaseVersion, observedAt, maxNearestRoadMeters, osmSource,
  });
  const allGeometry = [...addressFeatures, ...roadFeatures];
  const bounds = boundsForFeatures(allGeometry);
  const sourceTile = {
    schema: 'firstknock.canvas-source-evidence-tile', schema_version: 1,
    tile_address: { scheme: 'firstknock-regional-grid', scheme_version: 1, key: sanitizeSourceFeatureId(regionKey, 'region') },
    coverage: { area_sq_mi: Number(bboxAreaSqMi(bounds).toFixed(6)), bounds },
    road_segments: roadRecords.map(({ _name, ...road }) => road), evidence, protected_groups: roadGraph.protectedGroups,
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
      ...(osmRoadAuthority ? [] : [source('overture-transportation', 'Overture Maps Transportation', releaseVersion, OVERTURE_LICENSE, observedAt)]),
      ...(osm || osmRoadAuthority ? [source('openstreetmap', 'OpenStreetMap', osmSource?.dataset_version || releaseVersion, OSM_LICENSE, osmSource?.captured_at || observedAt)] : []),
      ...(nad ? [source('national-address-database', 'National Address Database', releaseVersion, 'public-data', observedAt)] : []),
      ...(assessors ? [source('public-assessor', 'Public assessor/parcel feeds', releaseVersion, 'public-data', observedAt)] : []),
    ].filter((record) => normalizedTile.properties.some((property) => property.provenance.some((item) => item.source_id === record.source_id)) || record.source_id === (osmRoadAuthority ? 'openstreetmap' : 'overture-transportation')),
    report: { region_key: regionKey, overture_release: releaseVersion, source_address_records_outside_property_polygon: addressRecords.length + supportingRecords.length - addressFeatures.length - supportingAddresses.length, property_polygon_enforced: Boolean(polygonRing), outside_property_workload: 0, road_authority: osmRoadAuthority ? 'pinned_openstreetmap_node_graph' : 'overture_transportation', linkage_road_scope: polygonRing ? 'workload_polygon_intersections' : 'all_release_roads', synthetic_road_edge_count: 0, protected_group_count: roadGraph.protectedGroups.length, raw_source_address_record_count: addressFeatures.length + supportingAddresses.length, canonical_property_count: discoveredPropertyCount, duplicate_source_record_count: addressFeatures.length + supportingAddresses.length - discoveredPropertyCount, discovered_address_count: discoveredPropertyCount, signed_property_count: normalizedTile.properties.length, unlinked_property_count: unlinked.length, evidence_assertion_count: evidence.length, property_identity_version: CANVAS_PROPERTY_IDENTITY_VERSION, osm_assertion_normalization_version: CANVAS_OSM_ASSERTION_NORMALIZATION_VERSION, property_classification_counts: counts, eligible_door_count: normalizedTile.properties.filter((property) => property.canvass_eligibility === 'eligible').reduce((sum, property) => sum + property.door_count, 0), batchdata_call_count: 0, input_digest: canonicalStringify({ addresses: addressFeatures.length, buildings: buildingFeatures.length, places: placeFeatures.length, roads: roadFeatures.length }) },
    unlinked_properties: unlinked,
  };
}