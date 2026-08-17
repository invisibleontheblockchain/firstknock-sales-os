import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeMarylandHomeData, mapHomeDataUse } from '../scripts/canvas-evidence/maryland-homedata-analysis.mjs';

const road = { source_namespace: 'openstreetmap', source_feature_id: 'way/1', segment_index: 0, from_millionths: 0, to_millionths: 1000000 };
const property = (id, address, point, reasons = ['property_use_unresolved']) => ({ fk_property_id: id, property_key: id, normalized_address: address, display_address: address, point, work_unit_identity: road, road_linkage: { work_unit_identity: road }, property_type: 'unknown', canvass_eligibility: 'review', confidence: { reasons } });
const evidence = (key, kind, attributes, location) => ({ property_key: key, kind, attributes, location, provenance: [{ source_id: kind === 'building' ? 'overture-buildings' : 'overture-addresses' }] });
const row = (account, address, lat, lng, use) => ({ account_id_mdp_field_acctid: account, mdp_street_address_mdp_field_address: address, mdp_street_address_city_mdp_field_city: 'DAMASCUS', mdp_street_address_zip_code_mdp_field_zipcode: '20872', mdp_latitude_mdp_field_digycord_converted_to_wgs84: String(lat), mdp_longitude_mdp_field_digxcord_converted_to_wgs84: String(lng), land_use_code_mdp_field_lu_desclu_sdat_field_50: use });

test('maps only documented HomeData descriptions to classifier concepts', () => {
  assert.equal(mapHomeDataUse(row('1', '', 0, 0, 'Residential (R)')).classifier_value, 'residential');
  assert.equal(mapHomeDataUse(row('2', '', 0, 0, 'Commercial (C)')).classifier_value, 'commercial');
  assert.equal(mapHomeDataUse(row('3', '', 0, 0, 'Agricultural (A)')).classifier_value, null);
});

test('profiles deterministic HomeData conflation and simulates without mutating frozen properties', () => {
  const first = property('FKP1_a', '100|oak road||damascus|md|20872|us', { lat: 39, lng: -77 });
  const second = property('FKP1_b', '200|main street||damascus|md|20872|us', { lat: 39.001, lng: -77 });
  const sourceTile = { evidence: [evidence(first.property_key, 'address', { occupancy: 'unknown' }, first.point), evidence(first.property_key, 'building', { building_use: 'yes' }, first.point), evidence(second.property_key, 'address', { occupancy: 'unknown' }, second.point), evidence(second.property_key, 'building', { building_use: 'yes' }, second.point)] };
  const input = { rows: [row('1', '100 OAK RD', 39, -77, 'Residential (R)'), row('2', '200 MAIN ST', 39.001, -77, 'Commercial (C)')], polygon: [{ lat: 38.9, lng: -77.1 }, { lat: 38.9, lng: -76.9 }, { lat: 39.1, lng: -76.9 }, { lat: 39.1, lng: -77.1 }], sourceTile, normalizedTiles: [{ properties: [first, second] }], sourceVersion: 'fixture' };
  const report = analyzeMarylandHomeData(input);
  assert.equal(report.coverage.exact_normalized_address_matches, 2);
  assert.deepEqual(report.dry_run.proposed, { eligible: 1, excluded: 1, review: 0 });
  assert.equal(first.canvass_eligibility, 'review');
  assert.deepEqual(report, analyzeMarylandHomeData({ ...input, rows: [...input.rows].reverse() }));
});

test('keeps existing and assessor use conflicts in review', () => {
  const current = { ...property('FKP1_a', '100|oak road||damascus|md|20872|us', { lat: 39, lng: -77 }), property_type: 'multifamily', canvass_eligibility: 'eligible', confidence: { reasons: ['residential_apartments'] } };
  const sourceTile = { evidence: [evidence(current.property_key, 'address', { occupancy: 'residential' }, current.point), evidence(current.property_key, 'building', { building_use: 'apartments' }, current.point)] };
  const report = analyzeMarylandHomeData({ rows: [row('1', '100 OAK RD', 39, -77, 'Commercial (C)')], polygon: [{ lat: 38.9, lng: -77.1 }, { lat: 38.9, lng: -76.9 }, { lat: 39.1, lng: -76.9 }, { lat: 39.1, lng: -77.1 }], sourceTile, normalizedTiles: [{ properties: [current] }], sourceVersion: 'fixture' });
  assert.deepEqual(report.dry_run.proposed, { eligible: 0, excluded: 0, review: 1 });
  assert.equal(report.dry_run.existing_control_conflicts_moved_to_review.eligible_to_review, 1);
});