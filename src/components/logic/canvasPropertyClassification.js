const RESIDENTIAL = new Set(['single_family', 'townhome', 'duplex', 'triplex', 'quadplex', 'house', 'detached', 'semidetached_house', 'terrace', 'residential', 'mixed_use']);
const MULTIFAMILY = new Set(['apartments', 'multifamily', 'dormitory', 'senior_living']);
const NON_RESIDENTIAL = new Set(['commercial', 'retail', 'office', 'industrial', 'warehouse', 'school', 'hospital', 'government', 'civic', 'institutional', 'religious', 'utility', 'military', 'vacant']);
const ACCESS_REVIEW = new Set(['gated', 'private_road', 'senior_living', 'dormitory', 'military_housing', 'no_solicitation', 'inaccessible_multifamily']);

const normalized = (value) => String(value ?? '').trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_');
const tag = (feature, key) => normalized(feature?.tags?.[key] ?? feature?.[key]);
const unique = (values) => [...new Set(values.filter(Boolean))].sort();

function signalValues(features, keys) {
  return unique(features.flatMap((feature) => keys.map((key) => tag(feature, key))));
}

function pointFrom(features) {
  for (const feature of features) {
    const source = feature?.point || feature?.center || feature;
    const lat = Number(source?.lat ?? source?.latitude);
    const lng = Number(source?.lng ?? source?.lon ?? source?.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  return null;
}

export function classifyCanvasPropertyEntity({ property_id, features = [] } = {}) {
  const values = signalValues(features, ['usps_rdi', 'delivery_type', 'assessor_class', 'property_type', 'building', 'building_use', 'site_use', 'landuse', 'place_use', 'poi_type']);
  const directValues = signalValues(features, ['usps_rdi', 'delivery_type', 'assessor_class', 'property_type', 'building', 'building_use', 'site_use']);
  const access = signalValues(features, ['canvass_access', 'access_classification', 'access', 'site_access']);
  const dpv = signalValues(features, ['usps_dpv', 'delivery_valid']);
  const positive = values.filter((value) => value === 'residential' || RESIDENTIAL.has(value));
  const multifamily = values.filter((value) => MULTIFAMILY.has(value));
  const negative = values.filter((value) => value === 'business' || NON_RESIDENTIAL.has(value));
  const reasons = [];
  let propertyType = 'unknown';
  let typeScore = 0;

  if (negative.length >= 2 || (negative.length && !positive.length && !multifamily.length)) {
    propertyType = negative.includes('vacant') ? 'vacant' : negative.includes('government') || negative.includes('civic') ? 'government' : negative.includes('school') || negative.includes('hospital') || negative.includes('institutional') ? 'institutional' : 'commercial';
    typeScore = negative.length >= 2 ? 0.99 : 0.9;
    reasons.push(...negative.map((value) => `non_residential_${value}`));
  } else if (positive.length || multifamily.length) {
    propertyType = multifamily.length ? 'multifamily' : 'residential';
    typeScore = Math.min(0.99, 0.72 + (unique([...positive, ...multifamily]).length * 0.09));
    reasons.push(...unique([...positive, ...multifamily]).map((value) => `residential_${value}`));
    if (!directValues.some((value) => value === 'residential' || RESIDENTIAL.has(value) || MULTIFAMILY.has(value))) {
      typeScore = Math.min(typeScore, 0.69);
      reasons.push('residential_context_only');
    }
    if (negative.length) { typeScore = Math.min(typeScore, 0.69); reasons.push('conflicting_property_use'); }
  } else {
    reasons.push('property_use_unresolved');
  }

  if (dpv.includes('valid') || dpv.includes('confirmed') || dpv.includes('yes')) reasons.push('delivery_point_verified');
  if (dpv.includes('invalid') || dpv.includes('no')) { typeScore = Math.min(typeScore, 0.45); reasons.push('delivery_point_unverified'); }

  const accessReason = access.find((value) => ACCESS_REVIEW.has(value));
  let eligibility = 'review';
  let confidenceScore = typeScore;
  if (['commercial', 'government', 'institutional', 'vacant'].includes(propertyType) && typeScore >= 0.8) eligibility = 'excluded';
  else if (accessReason) { eligibility = 'review'; confidenceScore = Math.min(confidenceScore || 0.6, 0.69); reasons.push(`canvass_access_${accessReason}`); }
  else if (['residential', 'multifamily'].includes(propertyType) && typeScore >= 0.8) eligibility = 'eligible';

  return {
    property_id: String(property_id || ''),
    point: pointFrom(features),
    property_type: propertyType,
    canvass_eligibility: eligibility,
    confidence_score: Number(confidenceScore.toFixed(2)),
    confidence_percent: Math.round(confidenceScore * 100),
    classification_reasons: unique(reasons),
  };
}

export function summarizeCanvasPropertyClassifications(properties = []) {
  const counts = { eligible: 0, excluded: 0, review: 0 };
  properties.forEach((property) => { if (counts[property?.canvass_eligibility] !== undefined) counts[property.canvass_eligibility] += 1; });
  const total = counts.eligible + counts.excluded + counts.review;
  return { ...counts, total, automatically_resolved: counts.eligible + counts.excluded, automatically_resolved_percent: total ? Number((((counts.eligible + counts.excluded) / total) * 100).toFixed(1)) : 0 };
}