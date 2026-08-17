import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const RESIDENTIAL = new Set(['residential', 'house', 'detached', 'semidetached_house', 'terrace']);
const MULTIFAMILY = new Set(['apartments', 'multifamily', 'dormitory', 'senior_living']);
const COMMERCIAL = new Set(['commercial', 'retail', 'office', 'warehouse', 'industrial', 'hotel', 'parking']);
const INSTITUTIONAL = new Set(['school', 'university', 'hospital', 'institutional', 'government', 'civic', 'religious', 'military']);
const unique = (values) => [...new Set(values.filter(Boolean))].sort();

function distanceMeters(left, right) {
  const latitude = (left.lat + right.lat) * Math.PI / 360;
  return Math.hypot((right.lat - left.lat) * 111_320, (right.lng - left.lng) * 111_320 * Math.cos(latitude));
}

function propertySignals(property, evidence, residentialBuildings) {
  const address = evidence.find((item) => item.kind === 'address');
  const buildings = evidence.filter((item) => item.kind === 'building');
  const buildingUses = unique(buildings.map((item) => item.attributes?.building_use));
  const landUses = unique(evidence.filter((item) => item.kind === 'land_use').map((item) => item.attributes?.land_use));
  const placeUses = unique(evidence.filter((item) => item.kind === 'place').map((item) => item.attributes?.place_use));
  const accessValues = unique(evidence.filter((item) => item.kind === 'access' || item.kind === 'barrier')
    .map((item) => item.attributes?.pedestrian_access));
  const sources = new Set(evidence.flatMap((item) => item.provenance || []).map((item) => item.source_id));
  const nearbyResidentialBuildingCount = residentialBuildings.filter((item) => (
    item.propertyKey !== property.property_key && distanceMeters(property.point, item.point) <= 75
  )).length;
  const commercialConflict = [...buildingUses, ...landUses, ...placeUses].some((value) => COMMERCIAL.has(value));
  const institutionalConflict = [...buildingUses, ...landUses, ...placeUses].some((value) => INSTITUTIONAL.has(value));
  const residentialContext = landUses.includes('residential') || placeUses.includes('residential');
  const residentialBuilding = buildingUses.some((value) => RESIDENTIAL.has(value));
  const multifamily = buildingUses.some((value) => MULTIFAMILY.has(value));
  const genericBuilding = buildingUses.includes('yes');
  const restrictedAccess = accessValues.some((value) => value === 'denied' || value === 'unknown')
    || property.confidence?.reasons?.includes('canvass_access_private_road');
  const buildingClass = multifamily ? 'multifamily' : residentialBuilding ? 'residential'
    : buildingUses.some((value) => COMMERCIAL.has(value) || INSTITUTIONAL.has(value)) ? 'nonresidential'
      : genericBuilding ? 'generic' : 'none';
  const buildingSource = sources.has('overture-buildings') && sources.has('openstreetmap') ? 'both'
    : sources.has('openstreetmap') ? 'osm' : sources.has('overture-buildings') ? 'overture' : 'none';
  const poiClass = placeUses.some((value) => INSTITUTIONAL.has(value)) ? 'institutional'
    : placeUses.some((value) => COMMERCIAL.has(value)) ? 'commercial'
      : placeUses.includes('residential') ? 'residential' : 'none';
  const landUseClass = landUses.some((value) => COMMERCIAL.has(value) || INSTITUTIONAL.has(value)) ? 'exclusion'
    : landUses.includes('residential') ? 'residential' : 'none';
  return {
    normalized_address_present: Boolean(address?.attributes?.normalized_address || property.normalized_address),
    building_linkage_present: buildings.length > 0,
    overture_building_evidence: sources.has('overture-buildings') && buildings.length > 0,
    osm_building_evidence: sources.has('openstreetmap') && buildings.length > 0,
    building_uses: buildingUses,
    residential_land_use_context: residentialContext,
    nearby_residential_building_count: nearbyResidentialBuildingCount,
    commercial_poi_nearby: placeUses.some((value) => COMMERCIAL.has(value)),
    institutional_poi_nearby: placeUses.some((value) => INSTITUTIONAL.has(value)),
    industrial_or_commercial_land_use: landUses.some((value) => COMMERCIAL.has(value)),
    assessor_or_parcel_evidence: sources.has('public-assessor'),
    access_restricted_or_unknown: restrictedAccess,
    multifamily_indicators: multifamily,
    conflicting_use_evidence: commercialConflict || institutionalConflict,
    generic_building_yes: genericBuilding,
    cohort_key: [
      `address:${address ? 'yes' : 'no'}`,
      `building:${buildingClass}`,
      `building_source:${buildingSource}`,
      `landuse:${landUseClass}`,
      `poi:${poiClass}`,
      `nearby_residential:${nearbyResidentialBuildingCount >= 2 ? '2+' : nearbyResidentialBuildingCount}`,
      `access:${restrictedAccess ? 'restricted' : 'clear'}`,
      `conflict:${commercialConflict || institutionalConflict ? 'yes' : 'no'}`,
    ].join('|'),
  };
}

function summarizeRule(id, description, resolution, records, rationale, risk, scope) {
  return {
    rule_id: id,
    proposed_only: true,
    evidence_combination: description,
    properties_resolved: records.length,
    resulting_eligible: resolution === 'eligible' ? records.length : 0,
    resulting_excluded: resolution === 'excluded' ? records.length : 0,
    confidence_rationale: rationale,
    false_positive_risk: risk,
    geographic_scope: scope,
    sample_properties: records.slice(0, 3).map(({ property, signals }) => ({
      fk_property_id: property.fk_property_id,
      display_address: property.display_address,
      evidence: signals,
    })),
  };
}

export function profileReviewCohorts({ sourceTile, normalizedTiles }) {
  const properties = normalizedTiles.flatMap((tile) => tile.properties || []);
  const evidenceByProperty = new Map();
  for (const item of sourceTile.evidence || []) {
    if (!item.property_key) continue;
    evidenceByProperty.set(item.property_key, [...(evidenceByProperty.get(item.property_key) || []), item]);
  }
  const residentialBuildings = (sourceTile.evidence || []).filter((item) => (
    item.kind === 'building' && [...RESIDENTIAL, ...MULTIFAMILY].includes(item.attributes?.building_use) && item.location
  )).map((item) => ({ propertyKey: item.property_key, point: item.location }));
  const reviews = properties.filter((property) => property.canvass_eligibility === 'review');
  const records = reviews.map((property) => ({
    property,
    signals: propertySignals(property, evidenceByProperty.get(property.property_key) || [], residentialBuildings),
  }));
  const cohorts = new Map();
  for (const record of records) cohorts.set(record.signals.cohort_key, [...(cohorts.get(record.signals.cohort_key) || []), record]);
  const frequency = [...cohorts.entries()].map(([combination, members]) => ({
    combination,
    count: members.length,
    percent_of_review: Number((members.length / reviews.length * 100).toFixed(1)),
    sample_properties: members.slice(0, 3).map(({ property }) => ({ fk_property_id: property.fk_property_id, display_address: property.display_address })),
  })).sort((left, right) => right.count - left.count || left.combination.localeCompare(right.combination));
  const unresolved = records.filter(({ property }) => property.confidence?.reasons?.includes('property_use_unresolved'));
  const safe = ({ signals }) => signals.normalized_address_present && !signals.conflicting_use_evidence && !signals.access_restricted_or_unknown;
  const candidates = [
    summarizeRule('P2-R1', 'valid address + generic physical building + residential land-use context + no exclusion or access conflict', 'eligible', unresolved.filter((record) => safe(record) && record.signals.generic_building_yes && record.signals.residential_land_use_context), 'Four explicit signals agree and property use remains distinct from access eligibility.', 'Low to moderate; broad residential polygons can contain non-residential accessory buildings.', 'national'),
    summarizeRule('P2-R2', 'valid address + generic physical building + at least two nearby explicitly residential buildings + no exclusion or access conflict', 'eligible', unresolved.filter((record) => safe(record) && record.signals.generic_building_yes && record.signals.nearby_residential_building_count >= 2), 'Address and building evidence are reinforced by independently typed nearby residential buildings.', 'Moderate; mixed-use edges and institutional campuses near homes require geometry/parcel safeguards.', 'national'),
    summarizeRule('P2-R3', 'valid address + matching commercial/institutional POI or land-use exclusion + physical building evidence', 'excluded', unresolved.filter(({ signals }) => signals.normalized_address_present && signals.building_linkage_present && signals.conflicting_use_evidence), 'Positive non-residential context agrees with a physical site and address.', 'Moderate; nearby POIs must overlap the property rather than merely be close.', 'national'),
  ];
  const baseline = {
    total: properties.length,
    eligible: properties.filter((property) => property.canvass_eligibility === 'eligible').length,
    excluded: properties.filter((property) => property.canvass_eligibility === 'excluded').length,
    review: reviews.length,
  };
  return {
    schema: 'firstknock.canvas-phase2-review-profile',
    schema_version: 1,
    baseline: {
      ...baseline,
      automatic_resolution_percent: Number(((baseline.eligible + baseline.excluded) / baseline.total * 100).toFixed(1)),
      review_percent: Number((baseline.review / baseline.total * 100).toFixed(1)),
      unresolved_property_use: unresolved.length,
    },
    signal_coverage: Object.fromEntries(Object.keys(records[0]?.signals || {}).filter((key) => key !== 'cohort_key' && key !== 'building_uses')
      .map((key) => [key, records.filter(({ signals }) => typeof signals[key] === 'number' ? signals[key] > 0 : signals[key] === true).length])),
    cohort_count: frequency.length,
    cohorts: frequency,
    proposed_rules: candidates,
    unavailable_current_signals: ['building_geometry_scale', 'parcel_boundary', 'assessor_use_class', 'census_property_identity'],
  };
}

function readNdjson(file) {
  return fs.readFileSync(file, 'utf8').trim().split(/\n+/).filter(Boolean).map(JSON.parse);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [sourcePath, normalizedPath, outputPath] = process.argv.slice(2);
  if (!sourcePath || !normalizedPath || !outputPath) throw new Error('Usage: profile-review-cohorts <source.json> <normalized.ndjson> <output.json>');
  const report = profileReviewCohorts({ sourceTile: JSON.parse(fs.readFileSync(sourcePath)), normalizedTiles: readNdjson(normalizedPath) });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify(report.baseline)}\n`);
}