import { classifyCanvasPropertyEntity } from '../../src/components/logic/canvasPropertyClassification.js';

const KIND_PRIORITY = Object.freeze({ address: 1, entrance: 2, building: 3, site: 4, place: 5, land_use: 6, access: 7, barrier: 8 });

function classificationFeature(feature) {
  const attributes = feature.attributes || {};
  const point = feature.location || null;
  if (feature.kind === 'address') return { point, property_type: attributes.occupancy === 'mixed' ? 'mixed_use' : attributes.occupancy };
  if (feature.kind === 'building') return { point, building_use: attributes.building_use };
  if (feature.kind === 'site') return { point, site_use: attributes.site_use };
  if (feature.kind === 'place') return { point, place_use: attributes.place_use, poi_type: attributes.place_use };
  if (feature.kind === 'land_use') return { point, landuse: attributes.land_use };
  if (feature.kind === 'access') return { point, canvass_access: attributes.pedestrian_access === 'denied' ? 'private_road' : attributes.pedestrian_access };
  if (feature.kind === 'barrier') return { point, canvass_access: attributes.pedestrian_access === 'unknown' ? 'gated' : attributes.pedestrian_access };
  return { point };
}

function doorCount(features) {
  const addresses = features.filter((feature) => feature.kind === 'address');
  if (!addresses.length) return 1;
  return Math.max(1, ...addresses.map((feature) => feature.attributes.unit_keys?.length || 1));
}

export function normalizeCanvasProperties({ evidence, roadById, mergeProvenance, fail }) {
  const grouped = new Map();
  for (const feature of evidence) {
    if (!feature.propertyKey) continue;
    grouped.set(feature.propertyKey, [...(grouped.get(feature.propertyKey) || []), feature]);
  }
  return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([propertyKey, features]) => {
    const ranked = [...features].sort((left, right) => (KIND_PRIORITY[left.kind] || 99) - (KIND_PRIORITY[right.kind] || 99)
      || left.evidenceId.localeCompare(right.evidenceId));
    const located = ranked.find((feature) => feature.location);
    if (!located) fail('property_location_missing', `Property ${propertyKey} has no point geometry.`, { property_key: propertyKey });
    const associated = ranked.find((feature) => feature.roadIds?.length === 1);
    const roadId = associated?.roadIds?.[0];
    const road = roadById.get(roadId);
    if (!road) fail('property_road_missing', `Property ${propertyKey} has no unambiguous road association.`, { property_key: propertyKey });
    const classification = classifyCanvasPropertyEntity({
      property_id: propertyKey,
      features: features.map(classificationFeature),
    });
    if (classification.canvass_eligibility === 'eligible' && ['denied', 'unknown'].includes(road.legalAccess)) {
      classification.canvass_eligibility = 'review';
      classification.confidence_score = Math.min(classification.confidence_score, 0.69);
      classification.classification_reasons = [...new Set([...classification.classification_reasons, 'canvass_access_private_road'])].sort();
    }
    const displayAddress = ranked.find((feature) => feature.kind === 'address' && feature.attributes.display_address)?.attributes.display_address;
    return {
      property_key: propertyKey,
      point: located.location,
      work_unit_identity: road.identity,
      property_type: classification.property_type,
      canvass_eligibility: classification.canvass_eligibility,
      confidence: { score: classification.confidence_score, reasons: classification.classification_reasons },
      door_count: doorCount(features),
      ...(displayAddress ? { display_address: displayAddress } : {}),
      provenance: mergeProvenance(features.map((feature) => feature.provenance), `source_tile.properties.${propertyKey}.provenance`),
    };
  });
}