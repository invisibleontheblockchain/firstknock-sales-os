import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { classifyCanvasPropertyEntity } from '../../src/components/logic/canvasPropertyClassification.js';
import { pointInRing } from './overture/geometry.mjs';

const FIELD = Object.freeze({
  account: 'account_id_mdp_field_acctid', lng: 'mdp_longitude_mdp_field_digxcord_converted_to_wgs84', lat: 'mdp_latitude_mdp_field_digycord_converted_to_wgs84',
  address: 'mdp_street_address_mdp_field_address', city: 'mdp_street_address_city_mdp_field_city', zip: 'mdp_street_address_zip_code_mdp_field_zipcode', unit: 'mdp_street_address_units_mdp_field_strtunt',
  premiseNumber: 'premise_address_number_mdp_field_premsnum_sdat_field_20', premiseSuffix: 'premise_address_number_suffix_sdat_field_21', premiseDirection: 'premise_address_direction_mdp_field_premsdir_sdat_field_22', premiseName: 'premise_address_name_mdp_field_premsnam_sdat_field_23', premiseType: 'premise_address_type_mdp_field_premstyp_sdat_field_24', premiseCity: 'premise_address_city_mdp_field_premcity_sdat_field_25', premiseZip: 'premise_address_zip_code_mdp_field_premzip_sdat_field_26', premiseUnit: 'premise_address_condominium_unit_no_sdat_field_28',
  landUse: 'land_use_code_mdp_field_lu_desclu_sdat_field_50', exemptClass: 'exempt_class_mdp_field_exclass_descexcl_sdat_field_49', ownerOccupancy: 'record_key_owner_occupancy_code_mdp_field_ooi_sdat_field_6', countyPropertyCode: 'county_system_property_code_sdat_field_56', taxClass: 'tax_class_sdat_field_58', publicUse: 'bpruc_public_use_code_mdp_field_ciuse_descciuse_sdat_field_61', yearBuilt: 'c_a_m_a_system_data_year_built_yyyy_mdp_field_yearblt_sdat_field_235', dwellingUnits: 'c_a_m_a_system_data_number_of_dwelling_units_mdp_field_bldg_units_sdat_field_239', structureArea: 'c_a_m_a_system_data_structure_area_sq_ft_mdp_field_sqftstrc_sdat_field_241', dwellingType: 'additional_c_a_m_a_data_dwelling_type_mdp_field_strubldg_sdat_field_265', buildingStyle: 'additional_c_a_m_a_data_building_style_code_and_description_mdp_field_strustyl_descstyl_sdat_field_264', zoning: 'zoning_code_mdp_field_zoning_sdat_field_45',
});
const SUFFIX = new Map([['road', 'rd'], ['street', 'st'], ['avenue', 'ave'], ['drive', 'dr'], ['lane', 'ln'], ['court', 'ct'], ['circle', 'cir'], ['boulevard', 'blvd'], ['place', 'pl'], ['parkway', 'pkwy'], ['highway', 'hwy'], ['terrace', 'ter'], ['trail', 'trl'], ['way', 'way']]);
const text = (value) => String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const street = (value) => text(value).split(' ').filter(Boolean).map((part) => SUFFIX.get(part) || part).join(' ');
const number = (value) => text(value).replace(/^0+(?=\d)/, '');
const zip = (value) => text(value).slice(0, 5);
const point = (row) => ({ lat: Number(row[FIELD.lat]), lng: Number(row[FIELD.lng]) });
const distance = (a, b) => Math.hypot((a.lat - b.lat) * 111_320, (a.lng - b.lng) * 111_320 * Math.cos((a.lat + b.lat) * Math.PI / 360));
const canonical = (value) => JSON.stringify(value, Object.keys(value).sort());
const frequency = (rows, field) => Object.entries(rows.reduce((out, row) => { const value = String(row[field] ?? '').trim() || '(missing)'; out[value] = (out[value] || 0) + 1; return out; }, {})).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([raw_value, count]) => ({ raw_value, count }));

function homeAddress(row) {
  const explicitNumber = `${number(row[FIELD.premiseNumber])}${text(row[FIELD.premiseSuffix])}`;
  const explicitStreet = street([row[FIELD.premiseDirection], row[FIELD.premiseName], row[FIELD.premiseType]].filter(Boolean).join(' '));
  const fallback = text(row[FIELD.address]).match(/^(\d+[a-z]?)\s+(.+)$/);
  return { number: explicitNumber || fallback?.[1] || '', street: explicitStreet || street(fallback?.[2]), unit: text(row[FIELD.premiseUnit] || row[FIELD.unit]), city: text(row[FIELD.premiseCity] || row[FIELD.city]), zip: zip(row[FIELD.premiseZip] || row[FIELD.zip]) };
}
function propertyAddress(property) {
  const parts = String(property.normalized_address || '').split('|');
  const propertyNumber = parts[0] || '';
  const propertyStreet = parts[1] || '';
  const hasUnit = parts.length >= 7;
  const unit = hasUnit ? parts[2] : '';
  const city = parts[hasUnit ? 3 : 2] || '';
  const postcode = parts.at(-2) || '';
  return { number: number(propertyNumber), street: street(propertyStreet), unit: text(unit), city: text(city), zip: zip(postcode) };
}
const fullKey = (address) => [address.number, address.street, address.unit, address.city, address.zip].join('|');
const relaxedKey = (address) => [address.number, address.street, address.unit, address.zip].join('|');

export function mapHomeDataUse(row) {
  const raw = String(row[FIELD.landUse] ?? '').trim();
  const exempt = String(row[FIELD.exemptClass] ?? '').trim();
  const direct = {
    'Residential (R)': ['residential', 'residential'], 'Residential Condominium (U)': ['residential_condominium', 'residential'], 'Apartments (M)': ['apartments', 'multifamily'],
    'Commercial (C)': ['commercial', 'commercial'], 'Commercial Condominium (CC)': ['commercial_condominium', 'commercial'], 'Exempt Commercial (EC)': ['exempt_commercial', 'commercial'],
    'Agricultural (A)': ['agricultural', null],
  }[raw];
  if (direct) return { raw_land_use: raw, raw_exempt_class: exempt || null, normalized_use: direct[0], classifier_value: direct[1], mapping_basis: 'documented_land_use_description' };
  if (raw !== 'Exempt (E)') return { raw_land_use: raw || null, raw_exempt_class: exempt || null, normalized_use: null, classifier_value: null, mapping_basis: 'unmapped' };
  const value = exempt.toLowerCase();
  if (/school|junior college/.test(value)) return { raw_land_use: raw, raw_exempt_class: exempt, normalized_use: 'education', classifier_value: 'school', mapping_basis: 'documented_exempt_class_description' };
  if (/church|synagogue|mosque|rectory/.test(value)) return { raw_land_use: raw, raw_exempt_class: exempt, normalized_use: 'religious', classifier_value: 'religious', mapping_basis: 'documented_exempt_class_description' };
  if (/parks|public works|government|historical preservation|fire department/.test(value)) return { raw_land_use: raw, raw_exempt_class: exempt, normalized_use: 'government', classifier_value: 'government', mapping_basis: 'documented_exempt_class_description' };
  return { raw_land_use: raw, raw_exempt_class: exempt || null, normalized_use: 'exempt_unknown', classifier_value: null, mapping_basis: 'insufficient_exempt_detail' };
}

function classificationFeature(item) {
  const a = item.attributes || {};
  if (item.kind === 'address') return { point: item.location, property_type: a.occupancy === 'mixed' ? 'mixed_use' : a.occupancy };
  if (item.kind === 'building') return { point: item.location, building_use: a.building_use };
  if (item.kind === 'site') return { point: item.location, site_use: a.site_use };
  if (item.kind === 'place') return { point: item.location, place_use: a.place_use, poi_type: a.place_use };
  if (item.kind === 'land_use') return { point: item.location, landuse: a.land_use };
  if (item.kind === 'access') return { point: item.location, canvass_access: a.pedestrian_access === 'denied' ? 'private_road' : a.pedestrian_access };
  if (item.kind === 'barrier') return { point: item.location, canvass_access: a.pedestrian_access === 'unknown' ? 'gated' : a.pedestrian_access };
  return { point: item.location };
}

function isGenericCohort(property, evidence, residentialBuildings) {
  if (property.canvass_eligibility !== 'review') return false;
  const uses = evidence.filter((item) => item.kind === 'building').map((item) => item.attributes?.building_use);
  const context = evidence.filter((item) => item.kind === 'land_use' || item.kind === 'place');
  const restricted = evidence.filter((item) => item.kind === 'access' || item.kind === 'barrier').some((item) => ['denied', 'unknown'].includes(item.attributes?.pedestrian_access)) || property.confidence?.reasons?.includes('canvass_access_private_road');
  const nearby = residentialBuildings.some((item) => item.property_key !== property.property_key && distance(property.point, item.location) <= 75);
  return uses.includes('yes') && !uses.some((use) => !['yes', null, undefined].includes(use)) && context.length === 0 && !restricted && !nearby;
}

export function analyzeMarylandHomeData({ rows, polygon, sourceTile, normalizedTiles, sourceVersion = 'unknown' }) {
  const ring = polygon.map(({ lng, lat }) => [Number(lng), Number(lat)]);
  const areaRows = rows.filter((row) => Number.isFinite(point(row).lat) && Number.isFinite(point(row).lng) && pointInRing(point(row), ring)).sort((a, b) => String(a[FIELD.account]).localeCompare(String(b[FIELD.account])));
  const properties = normalizedTiles.flatMap((tile) => tile.properties || []).sort((a, b) => a.fk_property_id.localeCompare(b.fk_property_id));
  const byFull = new Map(), byRelaxed = new Map();
  for (const property of properties) { const address = propertyAddress(property); byFull.set(fullKey(address), [...(byFull.get(fullKey(address)) || []), property]); byRelaxed.set(relaxedKey(address), [...(byRelaxed.get(relaxedKey(address)) || []), property]); }
  const matches = areaRows.map((row) => {
    const address = homeAddress(row); const exact = byFull.get(fullKey(address)) || []; const relaxed = exact.length ? [] : byRelaxed.get(relaxedKey(address)) || [];
    let candidates = exact.length ? exact : relaxed; let method = exact.length ? 'exact_normalized_address' : relaxed.length ? 'normalized_address_city_relaxed' : 'unmatched';
    if (!candidates.length) { candidates = properties.filter((property) => distance(point(row), property.point) <= 15); method = candidates.length ? 'spatial_only' : 'unmatched'; }
    const ranked = candidates.map((property) => ({ property, distance_m: distance(point(row), property.point) })).sort((a, b) => a.distance_m - b.distance_m || a.property.fk_property_id.localeCompare(b.property.fk_property_id));
    const ambiguous = ranked.length > 1 && (!Number.isFinite(ranked[0].distance_m) || ranked[1].distance_m - ranked[0].distance_m < 8);
    const selected = ranked.length && !ambiguous ? ranked[0] : null;
    const confidence = !selected ? 'unmatched_or_ambiguous' : method === 'exact_normalized_address' ? 'high' : method === 'normalized_address_city_relaxed' && selected.distance_m <= 40 ? 'high' : 'medium';
    return { account_id: String(row[FIELD.account]), row, address, method, confidence, candidate_fk_property_ids: ranked.map((item) => item.property.fk_property_id), fk_property_id: selected?.property.fk_property_id || null, distance_m: selected ? Number(selected.distance_m.toFixed(2)) : null, use: mapHomeDataUse(row) };
  });
  const matched = matches.filter((match) => match.fk_property_id); const byProperty = new Map();
  for (const match of matched) byProperty.set(match.fk_property_id, [...(byProperty.get(match.fk_property_id) || []), match]);
  const evidenceByProperty = new Map(); for (const item of sourceTile.evidence || []) if (item.property_key) evidenceByProperty.set(item.property_key, [...(evidenceByProperty.get(item.property_key) || []), item]);
  const residentialBuildings = (sourceTile.evidence || []).filter((item) => item.kind === 'building' && ['residential', 'house', 'detached', 'semidetached_house', 'terrace', 'apartments'].includes(item.attributes?.building_use) && item.location);
  const genericIds = new Set(properties.filter((property) => isGenericCohort(property, evidenceByProperty.get(property.property_key) || [], residentialBuildings)).map((property) => property.fk_property_id));
  const simulated = properties.map((property) => {
    const sourceEvidence = (evidenceByProperty.get(property.property_key) || []).map(classificationFeature);
    if (property.confidence?.reasons?.includes('canvass_access_private_road')) sourceEvidence.push({ point: property.point, canvass_access: 'private_road' });
    const assessor = byProperty.get(property.fk_property_id) || [];
    const values = [...new Set(assessor.map((item) => item.use.classifier_value).filter(Boolean))]; const raw = assessor.map((item) => ({ account_id: item.account_id, ...item.use }));
    const baselineResult = classifyCanvasPropertyEntity({ property_id: property.property_key, features: sourceEvidence });
    const result = classifyCanvasPropertyEntity({ property_id: property.property_key, features: [...sourceEvidence, ...values.map((assessor_class) => ({ point: property.point, assessor_class }))] });
    return { property, baselineResult, result, values, raw, conflicting_assessor_values: values.length > 1 };
  });
  const reviewSimulation = simulated.filter(({ property }) => property.canvass_eligibility === 'review');
  const moved = reviewSimulation.filter(({ result }) => result.canvass_eligibility !== 'review');
  const useInventory = frequency(areaRows, FIELD.landUse).map((entry) => ({ ...entry, mapping: mapHomeDataUse({ [FIELD.landUse]: entry.raw_value }).normalized_use }));
  const oneToMany = [...byProperty.values()].filter((items) => items.length > 1).length;
  const exact = matched.filter((item) => item.method === 'exact_normalized_address').length;
  const meaningfulReview = reviewSimulation.filter(({ property }) => (byProperty.get(property.fk_property_id) || []).some((item) => item.use.classifier_value)).length;
  const meaningfulGeneric = [...genericIds].filter((id) => (byProperty.get(id) || []).some((item) => item.use.classifier_value)).length;
  const useDistribution = (ids) => [...ids].flatMap((id) => byProperty.get(id) || []).reduce((out, item) => { const value = item.use.normalized_use || 'unmapped'; out[value] = (out[value] || 0) + 1; return out; }, {});
  const counts = (records, key) => records.reduce((out, item) => { const value = item[key]; out[value] = (out[value] || 0) + 1; return out; }, {});
  const classifierParityMismatches = simulated.filter(({ property, baselineResult }) => baselineResult.canvass_eligibility !== property.canvass_eligibility);
  const controlConflicts = simulated.filter(({ property, baselineResult, result }) => property.canvass_eligibility !== 'review' && baselineResult.canvass_eligibility === property.canvass_eligibility && result.canvass_eligibility === 'review');
  return {
    schema: 'firstknock.canvas-maryland-homedata-profile', schema_version: 1, classifier_changed: false,
    source: { source_id: 'maryland-sdat-homedata', dataset_id: 'ed4q-f8tm', filtered_view_id: 'kb22-is2w', dataset_version: sourceVersion, license: 'PUBLIC_DOMAIN', selected_rows_sha256: createHash('sha256').update(areaRows.map((row) => canonical(row)).join('\n')).digest('hex') },
    coverage: { input_bbox_records: rows.length, total_homedata_records_in_polygon: areaRows.length, matched_homedata_records: matched.length, unmatched_homedata_records: matches.filter((item) => !item.fk_property_id && item.candidate_fk_property_ids.length === 0).length, ambiguous_homedata_records: matches.filter((item) => !item.fk_property_id && item.candidate_fk_property_ids.length > 0).length, firstknock_properties: properties.length, firstknock_properties_matched: byProperty.size, firstknock_properties_without_match: properties.length - byProperty.size, one_to_one_matches: [...byProperty.values()].filter((items) => items.length === 1).length, one_to_many_firstknock_properties: oneToMany, many_to_one_homedata_records: matches.filter((item) => item.candidate_fk_property_ids.length > 1).length, exact_normalized_address_matches: exact, spatial_only_matches: matched.filter((item) => item.method === 'spatial_only').length, match_method_distribution: counts(matched, 'method'), match_confidence_distribution: counts(matches, 'confidence') },
    review_coverage: { review_properties: 557, review_properties_matched: reviewSimulation.filter(({ property }) => byProperty.has(property.fk_property_id)).length, review_properties_with_meaningful_use: meaningfulReview, meaningful_use_distribution: useDistribution(reviewSimulation.map(({ property }) => property.fk_property_id)), generic_cohort_properties: genericIds.size, generic_cohort_matched: [...genericIds].filter((id) => byProperty.has(id)).length, generic_cohort_with_meaningful_use: meaningfulGeneric, generic_cohort_use_distribution: useDistribution(genericIds) },
    signal_inventory: { land_use: useInventory, exempt_class: frequency(areaRows, FIELD.exemptClass), dwelling_type: frequency(areaRows, FIELD.dwellingType), building_style: frequency(areaRows, FIELD.buildingStyle), dwelling_units: frequency(areaRows, FIELD.dwellingUnits), tax_class: frequency(areaRows, FIELD.taxClass), county_property_code: frequency(areaRows, FIELD.countyPropertyCode), owner_occupancy_not_property_use: frequency(areaRows, FIELD.ownerOccupancy) },
    dry_run: { current: { eligible: 619, excluded: 46, review: 557 }, proposed: { eligible: simulated.filter(({ result }) => result.canvass_eligibility === 'eligible').length, excluded: simulated.filter(({ result }) => result.canvass_eligibility === 'excluded').length, review: simulated.filter(({ result }) => result.canvass_eligibility === 'review').length }, movements: { homedata_residential_review_to_eligible: moved.filter(({ result, values }) => result.canvass_eligibility === 'eligible' && values.some((value) => ['residential', 'multifamily'].includes(value))).length, homedata_commercial_review_to_excluded: moved.filter(({ result, values }) => result.canvass_eligibility === 'excluded' && values.includes('commercial')).length, homedata_institutional_government_review_to_excluded: moved.filter(({ result, values }) => result.canvass_eligibility === 'excluded' && values.some((value) => ['school', 'religious', 'government'].includes(value))).length, conflicting_evidence_remains_review: reviewSimulation.filter(({ result }) => result.canvass_eligibility === 'review' && result.classification_reasons.includes('conflicting_property_use')).length, still_insufficient_remains_review: reviewSimulation.filter(({ result }) => result.canvass_eligibility === 'review' && result.classification_reasons.includes('property_use_unresolved')).length, access_restricted_remains_review: reviewSimulation.filter(({ result }) => result.canvass_eligibility === 'review' && result.classification_reasons.some((reason) => reason.startsWith('canvass_access_'))).length }, classifier_parity_mismatches_without_homedata: classifierParityMismatches.length, existing_control_conflicts_moved_to_review: { total: controlConflicts.length, eligible_to_review: controlConflicts.filter(({ property }) => property.canvass_eligibility === 'eligible').length, excluded_to_review: controlConflicts.filter(({ property }) => property.canvass_eligibility === 'excluded').length, samples: controlConflicts.slice(0, 20).map(({ property, result, values }) => ({ fk_property_id: property.fk_property_id, address: property.display_address, current: property.canvass_eligibility, simulated: result.canvass_eligibility, current_reasons: property.confidence?.reasons || [], simulated_reasons: result.classification_reasons, homedata_values: values })) }, proposed_only: true },
    production_adapter_recommendation: meaningfulGeneric >= genericIds.size * 0.5 ? 'material_coverage_build_adapter' : 'insufficient_coverage_do_not_build_adapter',
  };
}

function readNdjson(file) { return fs.readFileSync(file, 'utf8').trim().split(/\n+/).filter(Boolean).map(JSON.parse); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [homeDataPath, polygonPath, sourcePath, normalizedPath, outputPath, sourceVersion = 'unknown'] = process.argv.slice(2);
  if (![homeDataPath, polygonPath, sourcePath, normalizedPath, outputPath].every(Boolean)) throw new Error('Usage: maryland-homedata-analysis <homedata.json> <polygon.json> <source.json> <normalized.ndjson> <output.json> [source-version]');
  const report = analyzeMarylandHomeData({ rows: JSON.parse(fs.readFileSync(homeDataPath)), polygon: JSON.parse(fs.readFileSync(polygonPath)), sourceTile: JSON.parse(fs.readFileSync(sourcePath)), normalizedTiles: readNdjson(normalizedPath), sourceVersion });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' }); process.stdout.write(`${JSON.stringify({ coverage: report.coverage, review_coverage: report.review_coverage, dry_run: report.dry_run, recommendation: report.production_adapter_recommendation })}\n`);
}