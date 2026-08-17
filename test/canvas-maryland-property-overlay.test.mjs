import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMarylandPropertyOverlay } from '../scripts/canvas-evidence/overture/maryland-overlay.mjs';

const observedAt = '2026-07-22T00:00:00.000Z';
const releaseVersion = '2026-07-22.0';
const fc = (features) => ({ type: 'FeatureCollection', features });
const identity = (id) => ({ source_namespace: 'maryland-osm', source_feature_id: id, segment_index: 0, from_millionths: 0, to_millionths: 1_000_000 });
const provenance = (id) => [{ source_id: 'maryland-osm', dataset_version: '2026-07-01', feature_id: id, observed_at: '2026-07-01T00:00:00.000Z', license: 'ODbL-1.0' }];

function baseTile() {
  const home = identity('home-road');
  const civic = identity('civic-road');
  return {
    schema: 'firstknock.canvas-normalized-evidence-tile', schema_version: 1,
    tile_address: { scheme: 'maryland-grid', scheme_version: 1, key: 'damascus-test' },
    coverage: { area_sq_mi: 1, bounds: { min_lng: -77.21, min_lat: 39.26, max_lng: -77.19, max_lat: 39.28 } },
    work_units: [
      { identity: home, canvas_role: 'uncertain', confidence: { score: 0.4, reasons: ['generic_building_use_unresolved'] }, provenance: provenance('home-road'), geometry: { type: 'LineString', coordinates: [[-77.209, 39.27], [-77.2, 39.27]] }, neighbors: [{ identity: civic, scope: 'release' }] },
      { identity: civic, canvas_role: 'opportunity', confidence: { score: 0.8, reasons: ['estimated_blockface_opportunity'] }, opportunity: { min: 3, expected: 5, max: 7 }, provenance: provenance('civic-road'), geometry: { type: 'LineString', coordinates: [[-77.2, 39.27], [-77.191, 39.27]] }, neighbors: [{ identity: home, scope: 'release' }] },
    ],
    properties: [], protected_groups: [],
  };
}

const point = (id, coordinates, properties) => ({ type: 'Feature', id, geometry: { type: 'Point', coordinates }, properties });
const polygon = (id, ring, properties) => ({ type: 'Feature', id, geometry: { type: 'Polygon', coordinates: [ring] }, properties });

test('Maryland overlay preserves its road graph while properties replace blockface workload', () => {
  const base = baseTile();
  const result = buildMarylandPropertyOverlay({
    baseTiles: [base], releaseVersion, observedAt,
    addresses: fc([
      point('address-home', [-77.205, 39.2701], { number: '100', street: 'Oak Road', postal_city: 'Damascus', region: 'MD', postcode: '20872', country: 'US' }),
      point('address-school', [-77.195, 39.2701], { number: '200', street: 'Main Street', postal_city: 'Damascus', region: 'MD', postcode: '20872', country: 'US' }),
    ]),
    buildings: fc([
      polygon('building-home-generic', [[-77.2052, 39.2699], [-77.2048, 39.2699], [-77.2048, 39.2703], [-77.2052, 39.2703], [-77.2052, 39.2699]], {}),
      polygon('building-school', [[-77.1952, 39.2699], [-77.1948, 39.2699], [-77.1948, 39.2703], [-77.1952, 39.2703], [-77.1952, 39.2699]], { class: 'school' }),
    ]),
    places: fc([point('place-school', [-77.195, 39.2701], { categories: { primary: 'school' } })]),
    osm: fc([polygon('osm-building-home', [[-77.2052, 39.2699], [-77.2048, 39.2699], [-77.2048, 39.2703], [-77.2052, 39.2703], [-77.2052, 39.2699]], { building: 'house' })]),
    osmSource: { dataset_version: '2026-07-01', captured_at: '2026-07-01T00:00:00.000Z', license: 'ODbL-1.0' },
  });
  const output = result.normalized_tiles[0];
  const byFeatureId = (units) => Object.fromEntries(units.map((unit) => [unit.identity.source_feature_id, unit]));
  const outputById = byFeatureId(output.work_units);
  const baseById = byFeatureId(base.work_units);
  assert.deepEqual(Object.keys(outputById).sort(), Object.keys(baseById).sort());
  Object.keys(baseById).forEach((id) => {
    assert.deepEqual(outputById[id].identity, baseById[id].identity);
    assert.deepEqual(outputById[id].neighbors, baseById[id].neighbors);
  });
  assert.deepEqual(result.report.baseline_blockface_counts, { opportunity: 1, transit: 0, excluded: 0, uncertain: 1 });
  assert.deepEqual(result.report.property_classification_counts, { eligible: 1, excluded: 1, review: 0 });
  assert.equal(result.report.eligible_door_count, 1);
  assert.deepEqual(result.report.property_authoritative_road_counts, { opportunity: 1, transit: 1, excluded: 0, uncertain: 0 });
  assert.equal(result.report.transportation_graph_reused, true);
  assert.equal(result.report.osm_supporting_feature_count, 1);
  const home = output.properties.find((property) => property.display_address.startsWith('100'));
  assert.equal(home.canvass_eligibility, 'eligible');
  assert.ok(home.provenance.some((item) => item.source_id === 'openstreetmap'));
  assert.ok(output.properties.every((property) => property.fk_property_id.startsWith('FKP1_')));
});