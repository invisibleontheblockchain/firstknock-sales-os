import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOvertureCanvasRegion, partitionNormalizedCanvasTile, partitionNormalizedCanvasTileByByteLimit } from '../scripts/canvas-evidence/overture/adapter.mjs';

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

test('duplicate normalized addresses conflate into one property while retaining every source feature as provenance', () => {
  const input = fixture();
  input.addresses.features.push(point('overture-address-home-duplicate', [-82.6502, 34.5101], { number: '100', street: 'Oak Street', postal_city: 'Anderson', postcode: '29621', country: 'US' }));
  const result = buildOvertureCanvasRegion({ ...input, regionKey: 'duplicates', releaseVersion, observedAt });
  const home = result.normalized_tile.properties.find((property) => property.display_address.startsWith('100'));
  assert.equal(result.report.raw_source_address_record_count, 4);
  assert.equal(result.report.canonical_property_count, 3);
  assert.equal(result.report.duplicate_source_record_count, 1);
  assert.equal(result.normalized_tile.properties.length, 3);
  assert.ok(home.provenance.some((item) => item.feature_id === 'overture-address-home'));
  assert.ok(home.provenance.some((item) => item.feature_id === 'overture-address-home-duplicate'));
});

test('one mixed-tag OSM feature emits unique building, land-use, and place assertions', () => {
  const input = fixture();
  input.osm = featureCollection([polygon('osm-mixed-school', [[-82.6504, 34.5099], [-82.65, 34.5099], [-82.65, 34.5103], [-82.6504, 34.5103], [-82.6504, 34.5099]], { building: 'yes', amenity: 'school', landuse: 'residential' })]);
  const result = buildOvertureCanvasRegion({ ...input, regionKey: 'mixed-assertions', releaseVersion, observedAt });
  const home = result.normalized_tile.properties.find((property) => property.display_address.startsWith('100'));
  const mixedProvenance = home.provenance.filter((item) => item.feature_id === 'osm-mixed-school');
  assert.equal(mixedProvenance.length, 1, 'assertions share one source-feature provenance record');
  assert.equal(home.canvass_eligibility, 'excluded', 'the complete conflicting evidence set is classified');
  assert.ok(result.report.evidence_assertion_count > result.report.raw_source_address_record_count);
});

test('pinned OSM node identities produce only real edges, deterministic neighbors, and terminal protected groups', () => {
  const input = fixture();
  input.roads = featureCollection([
    { type: 'Feature', id: 'way/1', geometry: { type: 'LineString', coordinates: [[-82.651, 34.51], [-82.65, 34.51], [-82.649, 34.51]] }, properties: { highway: 'residential', name: 'Oak Street', node_ids: ['1', '2', '3'] } },
    { type: 'Feature', id: 'way/2', geometry: { type: 'LineString', coordinates: [[-82.649, 34.51], [-82.648, 34.51], [-82.647, 34.51]] }, properties: { highway: 'secondary', name: 'Main Street', node_ids: ['3', '4', '5'] } },
    { type: 'Feature', id: 'way/3', geometry: { type: 'LineString', coordinates: [[-82.649, 34.51], [-82.649, 34.511]] }, properties: { highway: 'residential', name: 'Court', node_ids: ['3', '6'] } },
  ]);
  const first = buildOvertureCanvasRegion({ ...input, regionKey: 'osm-roads', releaseVersion, observedAt });
  const second = buildOvertureCanvasRegion({ ...input, roads: featureCollection(input.roads.features.toReversed()), regionKey: 'osm-roads', releaseVersion, observedAt });
  assert.equal(first.report.road_authority, 'pinned_openstreetmap_node_graph');
  assert.equal(first.report.synthetic_road_edge_count, 0);
  assert.ok(first.report.protected_group_count > 0);
  assert.equal(JSON.stringify(first.normalized_tile), JSON.stringify(second.normalized_tile));
  assert.equal(first.normalized_tile.work_units.length, 3);
  const tiles = partitionNormalizedCanvasTile(first.normalized_tile, 2);
  assert.equal(tiles.length, 2);
  assert.equal(tiles.flatMap((tile) => tile.work_units).length, 3);
  assert.equal(tiles.flatMap((tile) => tile.properties).length, first.normalized_tile.properties.length);
  assert.equal(tiles.flatMap((tile) => tile.protected_groups).length, first.normalized_tile.protected_groups.length);
});

test('byte-limited production tiling preserves identities, classifications, protected groups, and release topology', () => {
  const input = fixture();
  input.roads = featureCollection([
    { type: 'Feature', id: 'way/1', geometry: { type: 'LineString', coordinates: [[-82.651, 34.51], [-82.65, 34.51], [-82.649, 34.51]] }, properties: { highway: 'residential', name: 'Oak Street', node_ids: ['1', '2', '3'] } },
    { type: 'Feature', id: 'way/2', geometry: { type: 'LineString', coordinates: [[-82.649, 34.51], [-82.648, 34.51], [-82.647, 34.51]] }, properties: { highway: 'secondary', name: 'Main Street', node_ids: ['3', '4', '5'] } },
    { type: 'Feature', id: 'way/3', geometry: { type: 'LineString', coordinates: [[-82.649, 34.51], [-82.649, 34.511]] }, properties: { highway: 'residential', name: 'Court', node_ids: ['3', '6'] } },
  ]);
  const source = buildOvertureCanvasRegion({ ...input, regionKey: 'byte-limited', releaseVersion, observedAt }).normalized_tile;
  const twoTiles = partitionNormalizedCanvasTile(source, 2);
  const byteLimit = Math.max(...twoTiles.map((tile) => Buffer.byteLength(JSON.stringify(tile)))) + 100;
  const first = partitionNormalizedCanvasTileByByteLimit(source, byteLimit);
  const second = partitionNormalizedCanvasTileByByteLimit({ ...source, work_units: source.work_units.toReversed(), properties: source.properties.toReversed() }, byteLimit);
  const originalProperties = source.properties.map((property) => [property.fk_property_id, property.canvass_eligibility]).sort();
  const tiledProperties = first.flatMap((tile) => tile.properties).map((property) => [property.fk_property_id, property.canvass_eligibility]).sort();
  const tiledUnitIds = first.flatMap((tile) => tile.work_units).map((unit) => JSON.stringify(unit.identity));
  const allUnitIds = new Set(tiledUnitIds);

  assert.deepEqual(tiledProperties, originalProperties);
  assert.equal(new Set(tiledProperties.map(([id]) => id)).size, source.properties.length);
  assert.equal(new Set(tiledUnitIds).size, source.work_units.length);
  assert.equal(first.flatMap((tile) => tile.protected_groups).length, source.protected_groups.length);
  assert.ok(first.every((tile) => Buffer.byteLength(JSON.stringify(tile)) <= byteLimit));
  assert.ok(first.flatMap((tile) => tile.work_units).every((unit) => unit.neighbors.filter((neighbor) => neighbor.scope === 'release').every((neighbor) => allUnitIds.has(JSON.stringify(neighbor.identity)))));
  assert.deepEqual(second, first);
});

test('real outside connector roads retain topology but carry zero property workload', () => {
  const input = fixture();
  input.addresses = featureCollection([point('boundary-home', [-82.6508, 34.5098], { number: '100', street: 'Oak Street', postal_city: 'Anderson', postcode: '29621', country: 'US' })]);
  input.buildings = featureCollection([polygon('boundary-building', [[-82.65085, 34.50975], [-82.65075, 34.50975], [-82.65075, 34.50985], [-82.65085, 34.50985], [-82.65085, 34.50975]], { class: 'house' })]);
  input.places = featureCollection([]);
  input.roads = featureCollection([
    { type: 'Feature', id: 'way/connector', geometry: { type: 'LineString', coordinates: [[-82.651, 34.509], [-82.651, 34.51]] }, properties: { highway: 'residential', name: 'Oak Street', node_ids: ['1', '2'] } },
    { type: 'Feature', id: 'way/inside', geometry: { type: 'LineString', coordinates: [[-82.651, 34.51], [-82.649, 34.51]] }, properties: { highway: 'residential', name: 'Main Street', node_ids: ['2', '3'] } },
  ]);
  const propertyPolygon = [
    { lng: -82.6509, lat: 34.5097 }, { lng: -82.6507, lat: 34.5097 },
    { lng: -82.6507, lat: 34.5102 }, { lng: -82.6509, lat: 34.5102 },
  ];
  const result = buildOvertureCanvasRegion({ ...input, propertyPolygon, regionKey: 'boundary-connector', releaseVersion, observedAt });
  const connector = result.normalized_tile.work_units.find((unit) => unit.identity.source_feature_id === 'way/connector');
  const property = result.normalized_tile.properties[0];
  assert.equal(result.report.outside_connector_count, 1);
  assert.equal(result.report.outside_connector_workload, 0);
  assert.equal(connector.canvas_role, 'transit');
  assert.equal(connector.opportunity, undefined);
  assert.equal(property.work_unit_identity.source_feature_id, 'way/inside');
  assert.equal(property.road_linkage.method, 'boundary_connector');
});