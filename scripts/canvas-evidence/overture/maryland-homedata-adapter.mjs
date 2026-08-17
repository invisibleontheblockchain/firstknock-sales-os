import { createHash } from 'node:crypto';
import { canonicalStringify } from '../contract.mjs';
import { normalizeCanvasSourceEvidenceTile } from '../source-normalizer.mjs';
import { MARYLAND_HOMEDATA_MAPPING_VERSION, canonicalMarylandHomeDataRowsHash, conflateMarylandHomeData } from '../maryland-homedata-analysis.mjs';

const SOURCE_ID = 'maryland-sdat-homedata';
const LICENSE = 'PUBLIC_DOMAIN';
const siteUse = (value) => ({ residential: 'residential', multifamily: 'apartments', commercial: 'commercial', school: 'education', religious: 'religious', government: 'government' }[value] || null);
const featureId = (value) => String(value || '').replace(/[^A-Za-z0-9._:/-]/g, '_').slice(0, 180) || 'unknown-account';
const evidenceId = (match, property) => `${SOURCE_ID}:${featureId(match.account_id)}:${createHash('sha256').update(canonicalStringify({ property_key: property.property_key, mapping: match.use })).digest('hex').slice(0, 24)}`;
const conflictsWithBaseline = (property, value) => (property.canvass_eligibility === 'eligible' && ['commercial', 'school', 'religious', 'government'].includes(value)) || (property.canvass_eligibility === 'excluded' && ['residential', 'multifamily'].includes(value));

export function applyMarylandHomeDataAdapter({ rows, polygon, sourceTile, normalizedTiles, datasetVersion, observedAt, expectedSourceHash } = {}) {
  const properties = normalizedTiles.flatMap((tile) => tile.properties || []);
  const { areaRows, matches, byProperty } = conflateMarylandHomeData({ rows, polygon, properties });
  const sourceHash = canonicalMarylandHomeDataRowsHash(areaRows);
  if (expectedSourceHash && sourceHash !== expectedSourceHash) throw new TypeError('Maryland HomeData selected-row hash does not match the pinned source hash.');
  const evidenceByProperty = new Map();
  for (const item of sourceTile.evidence || []) if (item.property_key) evidenceByProperty.set(item.property_key, [...(evidenceByProperty.get(item.property_key) || []), item]);
  const ledger = [];
  const assertions = [];
  for (const property of properties) {
    const association = (evidenceByProperty.get(property.property_key) || []).find((item) => item.kind === 'address')?.associations?.[0];
    for (const match of byProperty.get(property.fk_property_id) || []) {
      const normalized = siteUse(match.use.classifier_value);
      const conflictDowngrade = match.confidence === 'medium' && conflictsWithBaseline(property, match.use.classifier_value);
      const accepted = Boolean(normalized && association && (match.confidence === 'high' || conflictDowngrade));
      const reasonCodes = accepted ? [match.confidence === 'high' ? 'homedata_high_confidence_conflation' : 'homedata_conflict_downgrade_only', `homedata_${match.use.normalized_use}`].sort() : ['homedata_not_accepted_for_automatic_influence'];
      const id = evidenceId(match, property);
      ledger.push({ evidence_id: id, fk_property_id: property.fk_property_id, property_key: property.property_key, source_id: SOURCE_ID, source_feature_id: match.account_id, dataset_version: datasetVersion, source_hash: sourceHash, raw_source_value: match.use.raw_land_use, raw_exempt_class: match.use.raw_exempt_class, normalized_assertion: match.use.classifier_value, conflation_method: match.method, match_confidence: match.confidence, mapping_version: MARYLAND_HOMEDATA_MAPPING_VERSION, reason_codes: reasonCodes, accepted, distance_m: match.distance_m });
      if (!accepted) continue;
      assertions.push({ evidence_id: id, kind: 'site', property_key: property.property_key, location: property.point, attributes: { site_use: normalized }, associations: [association], provenance: [{ source_id: SOURCE_ID, dataset_version: datasetVersion, feature_id: featureId(match.account_id), observed_at: observedAt, license: LICENSE }] });
    }
  }
  assertions.sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
  ledger.sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
  const augmentedSourceTile = { ...sourceTile, evidence: [...sourceTile.evidence, ...assertions] };
  const normalizedTile = normalizeCanvasSourceEvidenceTile(augmentedSourceTile);
  const counts = normalizedTile.properties.reduce((out, property) => { out[property.canvass_eligibility] += 1; return out; }, { eligible: 0, excluded: 0, review: 0 });
  return { source_tile: augmentedSourceTile, normalized_tile: normalizedTile, evidence_ledger: ledger, source: { source_id: SOURCE_ID, provider: 'Maryland SDAT/MDP HomeData', dataset_version: datasetVersion, license: LICENSE, captured_at: observedAt, source_hash: sourceHash, mapping_version: MARYLAND_HOMEDATA_MAPPING_VERSION }, report: { source_hash: sourceHash, mapping_version: MARYLAND_HOMEDATA_MAPPING_VERSION, selected_record_count: areaRows.length, matched_record_count: matches.filter((match) => match.fk_property_id).length, accepted_assertion_count: assertions.length, high_confidence_assertion_count: ledger.filter((item) => item.accepted && item.match_confidence === 'high').length, conflict_downgrade_assertion_count: ledger.filter((item) => item.accepted && item.reason_codes.includes('homedata_conflict_downgrade_only')).length, property_classification_counts: counts, review_percent: Number((counts.review / properties.length * 100).toFixed(1)), workload_authority: 'eligible_properties', batchdata_call_count: 0, rentcast_call_count: 0 } };
}