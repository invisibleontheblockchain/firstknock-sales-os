import { sign } from 'node:crypto';

import { canonicalStringify, sha256Hex } from '../src/canonical.mjs';

export const FIXTURE_KEY_ID = 'firstknock-local-fixture-v1';
export const FIXTURE_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIPpdU8Ht5DXFVk9Rz635np+GTkLZg0Y04elyw3dnpcNs
-----END PRIVATE KEY-----
`;
export const FIXTURE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAMQFVkuRo9ZigeLUVQyO3hJ9cYXXHLOintJYXPlD6Tqs=
-----END PUBLIC KEY-----
`;

const RELEASE_ID = `cer1_${'1'.repeat(64)}`;
const TILE_ID = `cet1_${'2'.repeat(64)}`;
const UNIT_ENTRY = `cewu1_${'3'.repeat(64)}`;
const UNIT_BOWL = `cewu1_${'4'.repeat(64)}`;
const UNIT_EXTERNAL = `cewu1_${'5'.repeat(64)}`;
const GROUP_ID = `cepg1_${'6'.repeat(64)}`;
const PROPERTY_ELIGIBLE = `cepr1_${'7'.repeat(64)}`;
const PROPERTY_EXCLUDED = `cepr1_${'8'.repeat(64)}`;
const PROPERTY_REVIEW = `cepr1_${'9'.repeat(64)}`;

const provenance = (featureId) => [{
  source_id: 'fixture-source',
  dataset_version: 'fixture.1',
  feature_id: featureId,
  observed_at: '2026-08-14T11:00:00.000Z',
  license: 'test-data-only',
}];

export function makeEvidenceFixture() {
  const tile = {
    schema: 'firstknock.canvas-evidence-tile',
    schema_version: 1,
    release_id: RELEASE_ID,
    tile_id: TILE_ID,
    tile_address: { scheme: 'fixture-grid', scheme_version: 1, key: 'phoenix-1' },
    coverage: {
      area_sq_mi: 0.25,
      bounds: { min_lng: -112.081, min_lat: 33.449, max_lng: -112.076, max_lat: 33.453 },
    },
    external_neighbor_ids: [UNIT_EXTERNAL],
    work_units: [
      {
        work_unit_id: UNIT_ENTRY,
        identity: { source_namespace: 'fixture', source_feature_id: 'sunset-court', segment_index: 0, from_millionths: 0, to_millionths: 500000 },
        canvas_role: 'opportunity',
        confidence: { score: 0.94, tier: 'high', reasons: ['address_points'] },
        opportunity: { min: 9, expected: 10, max: 12 },
        provenance: provenance('sunset-court/0'),
        geometry: { type: 'LineString', coordinates: [[-112.079, 33.45], [-112.078, 33.451]] },
        neighbor_ids: [UNIT_BOWL, UNIT_EXTERNAL].sort(),
        protected_group_id: GROUP_ID,
      },
      {
        work_unit_id: UNIT_BOWL,
        identity: { source_namespace: 'fixture', source_feature_id: 'sunset-court', segment_index: 1, from_millionths: 500000, to_millionths: 1000000 },
        canvas_role: 'opportunity',
        confidence: { score: 0.91, tier: 'high', reasons: ['address_points', 'cul_de_sac_topology'] },
        opportunity: { min: 11, expected: 13, max: 15 },
        provenance: provenance('sunset-court/1'),
        geometry: { type: 'LineString', coordinates: [[-112.078, 33.451], [-112.0775, 33.4522]] },
        neighbor_ids: [UNIT_ENTRY],
        protected_group_id: GROUP_ID,
      },
    ].sort((left, right) => left.work_unit_id.localeCompare(right.work_unit_id)),
    properties: [
      { property_id: PROPERTY_ELIGIBLE, fk_property_id: `FKP1_${'a'.repeat(64)}`, property_key: '100-sunset-ct', work_unit_id: UNIT_ENTRY, building_linkage: ['fixture:building-100'], road_linkage: { method: 'address_street' }, point: { lat: 33.4501, lng: -112.0789 }, property_type: 'residential', canvass_eligibility: 'eligible', confidence: { score: 0.98, tier: 'high', reasons: ['residential_house'] }, door_count: 1, display_address: '100 Sunset Ct', provenance: provenance('property/100') },
      { property_id: PROPERTY_EXCLUDED, fk_property_id: `FKP1_${'b'.repeat(64)}`, property_key: '102-sunset-ct', work_unit_id: UNIT_ENTRY, building_linkage: ['fixture:building-102'], road_linkage: { method: 'address_street' }, point: { lat: 33.4502, lng: -112.0788 }, property_type: 'commercial', canvass_eligibility: 'excluded', confidence: { score: 0.99, tier: 'high', reasons: ['non_residential_commercial'] }, door_count: 1, display_address: '102 Sunset Ct', provenance: provenance('property/102') },
      { property_id: PROPERTY_REVIEW, fk_property_id: `FKP1_${'c'.repeat(64)}`, property_key: '104-sunset-ct', work_unit_id: UNIT_BOWL, building_linkage: [], road_linkage: { method: 'address_street' }, point: { lat: 33.4503, lng: -112.0787 }, property_type: 'unknown', canvass_eligibility: 'review', confidence: { score: 0.45, tier: 'low', reasons: ['property_use_unresolved'] }, door_count: 1, display_address: '104 Sunset Ct', provenance: provenance('property/104') },
    ].sort((left, right) => left.property_id.localeCompare(right.property_id)),
    protected_groups: [{
      protected_group_id: GROUP_ID,
      kind: 'cul_de_sac',
      member_work_unit_ids: [UNIT_ENTRY, UNIT_BOWL].sort(),
      entry_work_unit_ids: [UNIT_ENTRY],
    }],
  };
  const tileBytes = Buffer.from(canonicalStringify(tile), 'utf8');
  const unsignedManifest = {
    schema: 'firstknock.canvas-evidence-manifest',
    schema_version: 1,
    release: {
      release_id: RELEASE_ID,
      dataset_namespace: 'firstknock-fixture',
      dataset_version: 'fixture.1',
      generated_at: '2026-08-14T12:00:00.000Z',
      compiler_version: 'fixture-compiler/1',
    },
    coverage: {
      country_codes: ['US'],
      bounds: tile.coverage.bounds,
    },
    tile_scheme: { scheme: 'fixture-grid', scheme_version: 1 },
    limits: { max_tile_bytes: 5_500_000 },
    sources: [{
      source_id: 'fixture-source',
      provider: 'Local fixture provider',
      dataset_version: 'fixture.1',
      license: 'test-data-only',
      captured_at: '2026-08-14T11:00:00.000Z',
    }],
    tiles: [{
      tile_id: TILE_ID,
      tile_address: tile.tile_address,
      uri: `tiles/${TILE_ID}.json`,
      sha256: sha256Hex(tileBytes),
      byte_length: tileBytes.byteLength,
      work_unit_count: tile.work_units.length,
      property_count: tile.properties.length,
      coverage_area_sq_mi: tile.coverage.area_sq_mi,
      coverage_bounds: tile.coverage.bounds,
      expected_opportunities: 23,
    }],
  };
  const signature = sign(null, Buffer.from(canonicalStringify(unsignedManifest), 'utf8'), FIXTURE_PRIVATE_KEY).toString('base64url');
  const manifest = { ...unsignedManifest, signature: { algorithm: 'Ed25519', key_id: FIXTURE_KEY_ID, value: signature } };
  const manifestBytes = Buffer.from(canonicalStringify(manifest), 'utf8');
  return {
    manifest,
    manifestBytes,
    tile,
    tileBytes,
    manifestUrl: 'https://evidence.test/releases/fixture/manifest.json',
    tileUrl: `https://evidence.test/releases/fixture/tiles/${TILE_ID}.json`,
    ids: { release: RELEASE_ID, tile: TILE_ID, entry: UNIT_ENTRY, bowl: UNIT_BOWL, external: UNIT_EXTERNAL, group: GROUP_ID, propertyEligible: PROPERTY_ELIGIBLE, propertyExcluded: PROPERTY_EXCLUDED, propertyReview: PROPERTY_REVIEW },
  };
}

export function makeConnectivityEvidenceFixture() {
  const fixture = makeEvidenceFixture();
  const secondId = `cewu1_${'d'.repeat(64)}`;
  const insidePropertyId = `cepr1_${'e'.repeat(64)}`;
  const outsidePropertyId = `cepr1_${'f'.repeat(64)}`;
  fixture.tile.work_units[0].neighbor_ids = [...new Set([...fixture.tile.work_units[0].neighbor_ids, UNIT_EXTERNAL])].sort();
  fixture.tile.work_units.push(
    {
      work_unit_id: UNIT_EXTERNAL,
      identity: { source_namespace: 'fixture', source_feature_id: 'real-outside-connector', segment_index: 0, from_millionths: 0, to_millionths: 1_000_000 },
      canvas_role: 'transit',
      confidence: { score: 1, tier: 'high', reasons: ['authoritative_road_topology'] },
      opportunity: null,
      provenance: provenance('real-outside-connector'),
      geometry: { type: 'LineString', coordinates: [[-112.078, 33.451], [-112.078, 33.4502]] },
      neighbor_ids: [UNIT_ENTRY, secondId].sort(),
      protected_group_id: null,
    },
    {
      work_unit_id: secondId,
      identity: { source_namespace: 'fixture', source_feature_id: 'second-inside-road', segment_index: 0, from_millionths: 0, to_millionths: 1_000_000 },
      canvas_role: 'opportunity',
      confidence: { score: 1, tier: 'high', reasons: ['address_points'] },
      opportunity: { min: 1, expected: 1, max: 1 },
      provenance: provenance('second-inside-road'),
      geometry: { type: 'LineString', coordinates: [[-112.078, 33.4502], [-112.0788, 33.4502]] },
      neighbor_ids: [UNIT_EXTERNAL],
      protected_group_id: null,
    },
  );
  fixture.tile.work_units.sort((left, right) => left.work_unit_id.localeCompare(right.work_unit_id));
  fixture.tile.external_neighbor_ids = [];
  fixture.tile.properties.push(
    { property_id: insidePropertyId, fk_property_id: `FKP1_${'d'.repeat(64)}`, property_key: '106-sunset-ct', work_unit_id: secondId, building_linkage: [], road_linkage: { method: 'fixture' }, point: { lat: 33.4502, lng: -112.0788 }, property_type: 'residential', canvass_eligibility: 'eligible', confidence: { score: 1, tier: 'high', reasons: ['residential_house'] }, door_count: 1, display_address: '106 Sunset Ct', provenance: provenance('property/106') },
    { property_id: outsidePropertyId, fk_property_id: `FKP1_${'e'.repeat(64)}`, property_key: 'outside-sunset-ct', work_unit_id: UNIT_EXTERNAL, building_linkage: [], road_linkage: { method: 'fixture' }, point: { lat: 33.4511, lng: -112.078 }, property_type: 'residential', canvass_eligibility: 'eligible', confidence: { score: 1, tier: 'high', reasons: ['residential_house'] }, door_count: 99, display_address: 'Outside Sunset Ct', provenance: provenance('property/outside') },
  );
  fixture.tile.properties.sort((left, right) => left.property_id.localeCompare(right.property_id));
  fixture.tileBytes = Buffer.from(canonicalStringify(fixture.tile), 'utf8');
  const entry = fixture.manifest.tiles[0];
  entry.sha256 = sha256Hex(fixture.tileBytes);
  entry.byte_length = fixture.tileBytes.byteLength;
  entry.work_unit_count = fixture.tile.work_units.length;
  entry.property_count = fixture.tile.properties.length;
  entry.expected_opportunities = 24;
  const { signature: _signature, ...unsignedManifest } = fixture.manifest;
  fixture.manifest = {
    ...unsignedManifest,
    signature: {
      algorithm: 'Ed25519',
      key_id: FIXTURE_KEY_ID,
      value: sign(null, Buffer.from(canonicalStringify(unsignedManifest), 'utf8'), FIXTURE_PRIVATE_KEY).toString('base64url'),
    },
  };
  fixture.manifestBytes = Buffer.from(canonicalStringify(fixture.manifest), 'utf8');
  fixture.ids.second = secondId;
  fixture.ids.insideProperty = insidePropertyId;
  fixture.ids.outsideProperty = outsidePropertyId;
  return fixture;
}