import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMarylandHomeDataAdapter } from '../scripts/canvas-evidence/overture/maryland-homedata-adapter.mjs';
import { normalizeCanvasSourceEvidenceTile } from '../scripts/canvas-evidence/source-normalizer.mjs';

const observedAt = '2026-08-05T22:25:30.000Z';
const road = { source_namespace: 'openstreetmap', source_feature_id: 'way/1', segment_index: 0, from_millionths: 0, to_millionths: 1000000 };
const provenance = (source_id, feature_id) => [{ source_id, dataset_version: 'fixture', feature_id, observed_at: observedAt, license: source_id === 'openstreetmap' ? 'ODbL-1.0' : 'ODbL-1.0' }];
const address = (key, number, lng) => ({ evidence_id: `address:${number}`, kind: 'address', property_key: key, location: { lat: 39, lng }, attributes: { address_key: key, normalized_address: `${number}|oak rd||damascus|md|20872|us`, display_address: `${number} Oak Rd`, unit_keys: [], occupancy: 'unknown' }, associations: [{ method: 'address_street', road_identity: road }], provenance: provenance('overture-addresses', `address-${number}`) });
const building = (key, number, lng, use = 'yes') => ({ evidence_id: `building:${number}`, kind: 'building', property_key: key, location: { lat: 39, lng }, attributes: { building_use: use }, associations: [{ method: 'side_of_street', road_identity: road }], provenance: provenance('overture-buildings', `building-${number}`) });
const row = (account, number, use) => ({ account_id_mdp_field_acctid: account, mdp_street_address_mdp_field_address: `${number} OAK RD`, mdp_street_address_city_mdp_field_city: 'DAMASCUS', mdp_street_address_zip_code_mdp_field_zipcode: '20872', mdp_latitude_mdp_field_digycord_converted_to_wgs84: '39', mdp_longitude_mdp_field_digxcord_converted_to_wgs84: String(-77 + Number(number) / 100000), land_use_code_mdp_field_lu_desclu_sdat_field_50: use });

function fixture() {
  const keys = ['fk-property-key-v1:a'.padEnd(83, 'a'), 'fk-property-key-v1:b'.padEnd(83, 'b')];
  const sourceTile = { schema: 'firstknock.canvas-source-evidence-tile', schema_version: 1, tile_address: { scheme: 'firstknock-regional-grid', scheme_version: 1, key: 'homedata-test' }, coverage: { area_sq_mi: 1, bounds: { min_lng: -77.01, min_lat: 38.99, max_lng: -76.99, max_lat: 39.01 } }, road_segments: [{ identity: road, geometry: { type: 'LineString', coordinates: [[-77.01, 39], [-76.99, 39]] }, road_class: 'residential', legal_access: 'public', provenance: provenance('openstreetmap', 'way/1'), neighbors: [] }], evidence: [address(keys[0], '100', -76.999), building(keys[0], '100', -76.999), address(keys[1], '200', -76.998), building(keys[1], '200', -76.998, 'commercial')], protected_groups: [] };
  return { keys, sourceTile, normalizedTiles: [normalizeCanvasSourceEvidenceTile(sourceTile)] };
}

test('HomeData adapter emits deterministic auditable evidence without runtime providers', () => {
  const input = fixture();
  const args = { rows: [row('A1', '100', 'Residential (R)'), row('A2', '200', 'Residential (R)')], polygon: [{ lat: 38.99, lng: -77.01 }, { lat: 38.99, lng: -76.99 }, { lat: 39.01, lng: -76.99 }, { lat: 39.01, lng: -77.01 }], ...input, datasetVersion: observedAt, observedAt };
  const first = applyMarylandHomeDataAdapter(args);
  const second = applyMarylandHomeDataAdapter({ ...args, rows: [...args.rows].reverse() });
  assert.deepEqual(first, second);
  assert.equal(first.report.workload_authority, 'eligible_properties');
  assert.equal(first.report.batchdata_call_count, 0);
  assert.ok(first.evidence_ledger.every((item) => item.source_hash && item.mapping_version && item.conflation_method && item.match_confidence));
  assert.ok(first.normalized_tile.properties.some((property) => property.canvass_eligibility === 'eligible'));
});