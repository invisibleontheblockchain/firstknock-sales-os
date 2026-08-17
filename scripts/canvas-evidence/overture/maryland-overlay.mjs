import { canonicalWorkUnitId } from '../contract.mjs';
import { applyPropertyWorkloadAuthority, normalizeCanvasSourceEvidenceTile } from '../source-normalizer.mjs';
import { CANVAS_OSM_ASSERTION_NORMALIZATION_VERSION, CANVAS_PROPERTY_IDENTITY_VERSION, buildOverturePropertyEvidence } from './adapter.mjs';

const features = (value, label) => {
  if (value?.type === 'FeatureCollection' && Array.isArray(value.features)) return value.features;
  if (Array.isArray(value)) return value;
  throw new TypeError(`${label} must be a GeoJSON FeatureCollection.`);
};

const inBounds = (point, bounds) => point.lng >= bounds.min_lng && point.lng <= bounds.max_lng
  && point.lat >= bounds.min_lat && point.lat <= bounds.max_lat;

const countBy = (values, field, initial) => values.reduce((counts, value) => {
  const key = value?.[field];
  if (key in counts) counts[key] += 1;
  return counts;
}, { ...initial });

function legalAccess(unit) {
  const reasons = unit?.confidence?.reasons || [];
  return unit?.canvas_role === 'excluded' && reasons.some((reason) => /(?:pedestrian|legal)_access_denied|access_barrier/.test(String(reason)))
    ? 'denied'
    : 'public';
}

export function buildMarylandPropertyOverlay({ baseTiles, addresses, buildings, places, osm = null, osmSource = null, releaseVersion, observedAt, maxNearestRoadMeters = 60 } = {}) {
  if (!Array.isArray(baseTiles) || !baseTiles.length) throw new TypeError('Maryland overlay requires at least one normalized Maryland tile.');
  const roadOwner = new Map();
  const roadRecords = baseTiles.flatMap((tile, tileIndex) => {
    if (tile?.schema !== 'firstknock.canvas-normalized-evidence-tile' || !Array.isArray(tile.work_units)) throw new TypeError('Maryland inputs must be normalized Canvas evidence tiles.');
    return tile.work_units.map((unit) => {
      const id = canonicalWorkUnitId(unit.identity);
      if (roadOwner.has(id)) throw new TypeError(`Maryland regional input contains duplicate work unit ${id}.`);
      roadOwner.set(id, tileIndex);
      return { identity: unit.identity, geometry: unit.geometry, _name: '', _tileIndex: tileIndex };
    });
  });
  const osmFeatures = osm ? features(osm, 'osm').map((feature) => ({ ...feature, properties: { ...(feature.properties || {}), _adapter_source: 'osm' } })) : [];
  const propertyEvidence = buildOverturePropertyEvidence({
    addressFeatures: features(addresses, 'addresses'),
    buildingFeatures: [...features(buildings, 'buildings'), ...osmFeatures.filter((feature) => ['Polygon', 'MultiPolygon'].includes(feature.geometry?.type) && feature.properties?.building)],
    placeFeatures: [...features(places, 'places'), ...osmFeatures],
    roadRecords,
    releaseVersion,
    observedAt,
    osmSource,
    maxNearestRoadMeters,
  });
  const validPropertyKeys = new Set();
  const boundaryUnlinked = [];
  for (const item of propertyEvidence.evidence.filter((item) => item.kind === 'address')) {
    const roadId = canonicalWorkUnitId(item.associations[0].road_identity);
    const tileIndex = roadOwner.get(roadId);
    const bounds = baseTiles[tileIndex]?.coverage?.bounds;
    if (bounds && inBounds(item.location, bounds)) validPropertyKeys.add(item.property_key);
    else boundaryUnlinked.push({ fk_property_id: `FKP1_${item.property_key.split(':').at(-1)}`, normalized_address: item.attributes.normalized_address, point: item.location, reason: 'property_point_outside_owning_tile' });
  }
  const evidenceByTile = baseTiles.map(() => []);
  propertyEvidence.evidence.filter((item) => validPropertyKeys.has(item.property_key)).forEach((item) => {
    const roadId = canonicalWorkUnitId(item.associations[0].road_identity);
    evidenceByTile[roadOwner.get(roadId)].push(item);
  });
  const normalizedTiles = baseTiles.map((tile, tileIndex) => {
    const sourceTile = {
      schema: 'firstknock.canvas-source-evidence-tile', schema_version: 1,
      tile_address: tile.tile_address, coverage: tile.coverage,
      road_segments: tile.work_units.map((unit) => ({
        identity: unit.identity, geometry: unit.geometry, road_class: 'unknown', legal_access: legalAccess(unit),
        provenance: unit.provenance,
        neighbors: unit.neighbors,
      })),
      evidence: evidenceByTile[tileIndex], protected_groups: tile.protected_groups || [],
    };
    const normalized = normalizeCanvasSourceEvidenceTile(sourceTile, { maxNearestRoadMeters });
    return { ...normalized, work_units: applyPropertyWorkloadAuthority(normalized.work_units, normalized.properties, { force: true }) };
  });
  const baselineUnits = baseTiles.flatMap((tile) => tile.work_units);
  const properties = normalizedTiles.flatMap((tile) => tile.properties);
  const outputUnits = normalizedTiles.flatMap((tile) => tile.work_units);
  const propertyCounts = countBy(properties, 'canvass_eligibility', { eligible: 0, excluded: 0, review: 0 });
  const automaticallyResolved = propertyCounts.eligible + propertyCounts.excluded;
  const linkedToBuildings = properties.filter((property) => property.building_linkage.length > 0).length;
  const linkedToRoads = properties.filter((property) => property.road_linkage?.work_unit_identity).length;
  return {
    normalized_tiles: normalizedTiles,
    unlinked_properties: [...propertyEvidence.unlinked, ...boundaryUnlinked],
    report: {
      source_region: 'maryland',
      transportation_graph_reused: true,
      preserved_work_unit_count: baselineUnits.length,
      baseline_blockface_counts: countBy(baselineUnits, 'canvas_role', { opportunity: 0, transit: 0, excluded: 0, uncertain: 0 }),
      property_classification_counts: propertyCounts,
      raw_source_address_record_count: propertyEvidence.rawAddressRecordCount,
      canonical_property_count: propertyEvidence.canonicalPropertyCount,
      duplicate_source_record_count: propertyEvidence.duplicateAddressRecordCount,
      discovered_address_count: propertyEvidence.discoveredPropertyCount,
      signed_property_count: properties.length,
      unique_fk_property_id_count: new Set(properties.map((property) => property.fk_property_id)).size,
      automatically_resolved_percent: properties.length ? Number((automaticallyResolved / properties.length * 100).toFixed(1)) : 0,
      review_percent: properties.length ? Number((propertyCounts.review / properties.length * 100).toFixed(1)) : 0,
      linked_to_building_count: linkedToBuildings,
      linked_to_maryland_road_count: linkedToRoads,
      duplicate_address_count_resolved: features(addresses, 'addresses').length - propertyEvidence.discoveredPropertyCount,
      eligible_door_count: properties.filter((property) => property.canvass_eligibility === 'eligible').reduce((sum, property) => sum + property.door_count, 0),
      property_authoritative_road_counts: countBy(outputUnits, 'canvas_role', { opportunity: 0, transit: 0, excluded: 0, uncertain: 0 }),
      unlinked_property_count: propertyEvidence.unlinked.length + boundaryUnlinked.length,
      osm_supporting_feature_count: osmFeatures.length,
      evidence_assertion_count: propertyEvidence.evidenceAssertionCount,
      property_identity_version: CANVAS_PROPERTY_IDENTITY_VERSION,
      osm_assertion_normalization_version: CANVAS_OSM_ASSERTION_NORMALIZATION_VERSION,
      batchdata_call_count: 0,
    },
  };
}