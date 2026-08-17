import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOvertureCanvasRegion } from '../scripts/canvas-evidence/overture/adapter.mjs';

const observedAt = '2026-07-22T00:00:00.000Z';
const releaseVersion = '2026-07-22.0';
const featureCollection = (features) => ({ type: 'FeatureCollection', features });
const point = (id, coordinates, properties) => ({ type: 'Feature', id, geometry: { type: 'Point', coordinates }, properties });
const polygon = (id, coordinates, properties) => ({ type: 'Feature', id, geometry: { type: 'Polygon', coordinates: [coordinates] }, properties });

function fixture() {
  const roads = featureCollection([
    { type: 'Feature', id: 'road-home', geometry: { type: 'LineString', coordinates: [[-82.651, 34.51], [-82.649, 34.51]] }, properties: { subtype: 'road', class: 'residential', names: { primary: 'Oak Street' }, connectors: [{ connector_id: 'junction' }, { connector_id: 'west' }] } },
    { type: 'Feature', id: 'road-civic', geometry: { type: 'LineString', coordinates: [[-82.649, 34.51], [-82.647, 34.51]] }, properties: { subtype: 'road', class: 'secondary', names: { primary: 'Main Street' }, connectors: [{ connector_id: 'junction' }, { connector_id: 'east' }] } },
  ]);
  const addresses = featureCollection([
    point('overture-address-home', [-82.6502, 34.5101], { number: '100', street: 'Oak Street', postal_city: 'Anderson', postcode: '29621', country: 'US' }),
    point('overture-address-school', [-82.6482, 34.5101], { number: '200', street: 'Main Street', postal_city: 'Anderson', postcode: '29621', country: 'US' }),
    point('overture-address-unknown', [-82.6506, 34.5099], { number: '102', street: 'Oak Street', postal_city: 'Anderson', postcode: '29621', country: 'US' }),
  ]);
  const buildings = featureCollection([
    polygon('overture-building-home', [[-82.6504, 34.5099], [-82.65, 34.5099], [-82.65, 34.5103], [-82.6504, 34.5103], [-82.6504, 34.5099]], { subtype: 'residential', class: 'house' }),
    polygon('overture-building-school', [[-82.6484, 34.5099], [-82.648, 34.5099], [-82.648, 34.5103], [-82.6484, 34.5103], [-82.6484, 34.5099]], { subtype: 'civic', class: 'school' }),
    polygon('overture-building-unknown', [[-82.6508, 34.5097], [-82.6504, 34.5097], [-82.6504, 34.5101], [-82.6508, 34.5101], [-82.6508, 34.5097]], { subtype: null, class: null }),
  ]);
  const places = featureCollection([point('overture-place-school', [-82.6482, 34.5101], { categories: { primary: 'school' } })]);
  return { addresses, buildings, places, roads };
}

test('Overture regional ETL emits FirstKnock-owned property identities and property-authoritative workload', () => {
  const result = buildOvertureCanvasRegion({ ...fixture(), regionKey: 'us-sc-anderson-test', releaseVersion, observedAt });
  assert.equal(result.report.discovered_address_count, 3);
  assert.deepEqual(result.report.property_classification_counts, { eligible: 1, excluded: 1, review: 1 });
  assert.equal(result.report.eligible_door_count, 1);
  assert.equal(result.report.batchdata_call_count, 0);
  assert.ok(result.normalized_tile.properties.every((property) => /^FKP1_[a-f0-9]{64}$/.test(property.fk_property_id)));
  assert.ok(result.normalized_tile.properties.every((property) => !property.fk_property_id.includes('overture')));
  assert.ok(result.normalized_tile.properties.every((property) => property.normalized_address && property.road_linkage?.work_unit_identity));
  assert.ok(result.normalized_tile.properties.find((property) => property.canvass_eligibility === 'eligible').building_linkage.length > 0);
  const opportunities = result.normalized_tile.work_units.filter((unit) => unit.canvas_role === 'opportunity');
  assert.equal(opportunities.length, 1);
  assert.deepEqual(opportunities[0].opportunity, { min: 1, expected: 1, max: 1 });
  assert.equal(result.normalized_tile.work_units.some((unit) => unit.canvas_role === 'uncertain'), false);
});

test('FirstKnock property identity is stable across Overture feature ID changes', () => {
  const first = buildOvertureCanvasRegion({ ...fixture(), regionKey: 'stable-a', releaseVersion, observedAt });
  const changed = fixture();
  changed.addresses.features[0].id = 'different-overture-address-id';
  const second = buildOvertureCanvasRegion({ ...changed, regionKey: 'stable-b', releaseVersion, observedAt });
  const firstHome = first.normalized_tile.properties.find((property) => property.display_address.startsWith('100'));
  const secondHome = second.normalized_tile.properties.find((property) => property.display_address.startsWith('100'));
  assert.equal(firstHome.fk_property_id, secondHome.fk_property_id);
  assert.equal(firstHome.property_key, secondHome.property_key);
  assert.notDeepEqual(firstHome.provenance, secondHome.provenance, 'Overture IDs remain provenance and may change independently');
});