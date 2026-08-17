import test from 'node:test';
import assert from 'node:assert/strict';
import { profileReviewCohorts } from '../scripts/canvas-evidence/profile-review-cohorts.mjs';

const road = { source_namespace: 'openstreetmap', source_feature_id: 'way/1', segment_index: 0, from_millionths: 0, to_millionths: 1000000 };
const property = (id, eligibility, reasons, point) => ({
  property_key: id, fk_property_id: id, display_address: `${id} Main St`, normalized_address: `${id}|main st|town|md|20000|us`,
  canvass_eligibility: eligibility, confidence: { reasons }, point, work_unit_identity: road, road_linkage: { work_unit_identity: road, method: 'address_street' },
});
const evidence = (propertyKey, kind, attributes, location, sourceId) => ({
  property_key: propertyKey, kind, attributes, location, provenance: [{ source_id: sourceId }],
});

test('profiles deterministic evidence cohorts without changing classifications', () => {
  const sourceTile = { evidence: [
    evidence('a', 'address', { normalized_address: 'a', occupancy: 'unknown' }, { lat: 39, lng: -77 }, 'overture-addresses'),
    evidence('a', 'building', { building_use: 'yes' }, { lat: 39, lng: -77 }, 'overture-buildings'),
    evidence('b', 'address', { normalized_address: 'b', occupancy: 'residential' }, { lat: 39.0002, lng: -77 }, 'overture-addresses'),
    evidence('b', 'building', { building_use: 'house' }, { lat: 39.0002, lng: -77 }, 'overture-buildings'),
    evidence('c', 'address', { normalized_address: 'c', occupancy: 'residential' }, { lat: 39.0003, lng: -77 }, 'overture-addresses'),
    evidence('c', 'building', { building_use: 'detached' }, { lat: 39.0003, lng: -77 }, 'overture-buildings'),
  ] };
  const normalizedTiles = [{ properties: [
    property('a', 'review', ['property_use_unresolved'], { lat: 39, lng: -77 }),
    property('b', 'eligible', ['residential_house'], { lat: 39.0002, lng: -77 }),
    property('c', 'eligible', ['residential_detached'], { lat: 39.0003, lng: -77 }),
  ] }];
  const first = profileReviewCohorts({ sourceTile, normalizedTiles });
  const second = profileReviewCohorts({ sourceTile: { evidence: [...sourceTile.evidence].reverse() }, normalizedTiles });
  assert.deepEqual(first, second);
  assert.deepEqual(first.baseline, { total: 3, eligible: 2, excluded: 0, review: 1, automatic_resolution_percent: 66.7, review_percent: 33.3, unresolved_property_use: 1 });
  assert.equal(first.proposed_rules.find((rule) => rule.rule_id === 'P2-R2').properties_resolved, 1);
  assert.equal(normalizedTiles[0].properties[0].canvass_eligibility, 'review');
});