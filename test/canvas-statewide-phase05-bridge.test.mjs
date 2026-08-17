import assert from 'node:assert/strict';
import test from 'node:test';
import { compileCanvasEvidenceTile } from '../scripts/canvas-evidence/compiler.mjs';
import { DEFAULT_CANVAS_EVIDENCE_LIMITS } from '../scripts/canvas-evidence/contract.mjs';
import { compileNormalizedCanvasEvidenceTile } from '../scripts/canvas-evidence/release-builder.mjs';
import { buildMarylandPropertyOverlay } from '../scripts/canvas-evidence/overture/maryland-overlay.mjs';
import { applyMarylandHomeDataAdapter } from '../scripts/canvas-evidence/overture/maryland-homedata-adapter.mjs';
import { buildTopologyIdentityIndex, rehydrateCompiledTopologyTile } from '../scripts/canvas-evidence/statewide/phase05-topology-bridge.mjs';

const observedAt = '2026-08-16T20:00:00.000Z';
const releaseId = `cer1_${'a'.repeat(64)}`;
const identity = (id) => ({ source_namespace: 'osm-way', source_feature_id: id, segment_index: 0, from_millionths: 0, to_millionths: 1_000_000 });
const provenance = (id) => [{ source_id: 'geofabrik-maryland', dataset_version: 'osm-fixture', feature_id: id, observed_at: observedAt, license: 'ODbL-1.0' }];
const fc = (features) => ({ type: 'FeatureCollection', features });

function compiledTopology() {
  const west = identity('way/west');
  const east = identity('way/east');
  const tile = ({ key, bounds, own, neighbor, coordinates }) => compileCanvasEvidenceTile({
    tile_address: { scheme: 'osm-bbox', scheme_version: 1, key },
    coverage: { area_sq_mi: 1, bounds },
    external_neighbors: [{ fixture_key: 'external', identity: neighbor }],
    protected_groups: [],
    work_units: [{
      fixture_key: 'own', identity: own, canvas_role: 'uncertain', confidence: { score: 0.4, reasons: ['generic_building_use_unresolved'] },
      provenance: provenance(own.source_feature_id), geometry: { type: 'LineString', coordinates }, neighbors: [], external_neighbors: ['external'], protected_group: null,
    }],
    properties: [],
  }, releaseId).tile;
  return [
    tile({ key: 'us-md-west', bounds: { min_lng: -77.01, min_lat: 38.99, max_lng: -77, max_lat: 39.01 }, own: west, neighbor: east, coordinates: [[-77.01, 39], [-77, 39]] }),
    tile({ key: 'us-md-east', bounds: { min_lng: -77, min_lat: 38.99, max_lng: -76.99, max_lat: 39.01 }, own: east, neighbor: west, coordinates: [[-77, 39], [-76.99, 39]] }),
  ];
}

test('Phase 05 rehydrates frozen topology, applies unchanged property/HomeData mappings, and passes the compiler contract', () => {
  const compiled = compiledTopology();
  const identityIndex = buildTopologyIdentityIndex(compiled);
  const topology = compiled.map((tile) => rehydrateCompiledTopologyTile(tile, identityIndex));
  assert.equal(topology[0].work_units[0].neighbors[0].scope, 'release');
  assert.deepEqual(topology[0].work_units[0].neighbors[0].identity, topology[1].work_units[0].identity);

  const overlay = buildMarylandPropertyOverlay({
    baseTiles: topology,
    addresses: fc([{ type: 'Feature', id: 'address-100', geometry: { type: 'Point', coordinates: [-77.005, 39.0001] }, properties: { number: '100', street: 'Oak Road', postal_city: 'Damascus', region: 'MD', postcode: '20872', country: 'US' } }]),
    buildings: fc([{ type: 'Feature', id: 'building-100', geometry: { type: 'Polygon', coordinates: [[[-77.0052, 38.9999], [-77.0048, 38.9999], [-77.0048, 39.0003], [-77.0052, 39.0003], [-77.0052, 38.9999]]] }, properties: { class: 'house' } }]),
    places: fc([]), releaseVersion: '2026-07-22.0', observedAt,
  });
  const properties = overlay.normalized_tiles.flatMap((tile) => tile.properties);
  assert.equal(properties.length, 1);
  assert.equal(new Set(properties.map((property) => property.fk_property_id)).size, 1);
  assert.equal(overlay.normalized_tiles[1].properties.length, 0, 'the property has one authoritative topology owner');

  const enriched = applyMarylandHomeDataAdapter({
    rows: [{ account_id_mdp_field_acctid: 'A1', mdp_street_address_mdp_field_address: '100 OAK ROAD', mdp_street_address_city_mdp_field_city: 'DAMASCUS', mdp_street_address_zip_code_mdp_field_zipcode: '20872', mdp_latitude_mdp_field_digycord_converted_to_wgs84: '39.0001', mdp_longitude_mdp_field_digxcord_converted_to_wgs84: '-77.005', land_use_code_mdp_field_lu_desclu_sdat_field_50: 'Residential (R)' }],
    polygon: [{ lat: 38.99, lng: -77.01 }, { lat: 38.99, lng: -77 }, { lat: 39.01, lng: -77 }, { lat: 39.01, lng: -77.01 }],
    sourceTile: overlay.source_tiles[0], normalizedTiles: [overlay.normalized_tiles[0]], datasetVersion: 'ed4q-f8tm-2026-08-16', observedAt,
  });
  assert.equal(enriched.report.workload_authority, 'eligible_properties');
  assert.equal(enriched.normalized_tile.properties[0].canvass_eligibility, 'eligible');

  const sources = [
    { source_id: 'geofabrik-maryland', provider: 'Geofabrik', dataset_version: 'osm-fixture', license: 'ODbL-1.0', captured_at: observedAt },
    { source_id: 'overture-addresses', provider: 'Overture Maps Addresses', dataset_version: '2026-07-22.0', license: 'ODbL-1.0', captured_at: observedAt },
    { source_id: 'overture-buildings', provider: 'Overture Maps Buildings', dataset_version: '2026-07-22.0', license: 'ODbL-1.0', captured_at: observedAt },
    enriched.source,
  ];
  const validated = compileNormalizedCanvasEvidenceTile(enriched.normalized_tile, {
    field: 'phase05-sample', releaseId, limits: DEFAULT_CANVAS_EVIDENCE_LIMITS,
    tileScheme: { scheme: 'osm-bbox', scheme_version: 1 },
    releaseCoverage: { bounds: { min_lng: -77.01, min_lat: 38.99, max_lng: -76.99, max_lat: 39.01 } },
    sourceById: new Map(sources.map((source) => [source.source_id, source])), generatedAt: observedAt,
  });
  assert.equal(validated.tile.properties.length, 1);
  assert.ok(validated.topologyRecords.some((record) => record.type === 'release_neighbor'));
});