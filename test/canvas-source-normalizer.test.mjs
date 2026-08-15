import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { canonicalStringify, canonicalWorkUnitId } from '../scripts/canvas-evidence/contract.mjs';
import { runCanvasSourceNormalizerCli } from '../scripts/canvas-evidence/normalize-source.mjs';
import { buildCanvasEvidenceRelease } from '../scripts/canvas-evidence/release-builder.mjs';
import {
  CANVAS_SOURCE_ROLES,
  CanvasSourceNormalizationError,
  normalizeCanvasSourceEvidenceTile,
  normalizeCanvasSourceEvidenceTileWithAudit,
  normalizeCanvasSourceEvidenceTiles,
} from '../scripts/canvas-evidence/source-normalizer.mjs';

const OBSERVED_AT = '2026-08-13T00:00:00.000Z';
const DATASET_VERSION = '2026-08-13.fixture.1';
const LICENSE = 'test-data-only';

function identity(featureId) {
  return {
    source_namespace: 'fixture-road',
    source_feature_id: featureId,
    segment_index: 0,
    from_millionths: 0,
    to_millionths: 1_000_000,
  };
}

function provenance(sourceId, featureId) {
  return [{
    source_id: sourceId,
    dataset_version: DATASET_VERSION,
    feature_id: featureId,
    observed_at: OBSERVED_AT,
    license: LICENSE,
  }];
}

function association(roadIdentity, method, distance) {
  return {
    method,
    road_identity: roadIdentity,
    ...(distance === undefined ? {} : { distance_m: distance }),
  };
}

function neighbor(roadIdentity, scope = 'release') {
  return { identity: roadIdentity, scope };
}

function road(featureId, coordinates, neighbors = [], legalAccess = 'public') {
  return {
    identity: identity(featureId),
    geometry: { type: 'LineString', coordinates },
    road_class: 'residential',
    legal_access: legalAccess,
    provenance: provenance('fixture-roads', featureId),
    neighbors,
  };
}

function evidence(evidenceId, kind, attributes, associations) {
  return {
    evidence_id: evidenceId,
    kind,
    attributes,
    associations,
    provenance: provenance('fixture-places', evidenceId),
  };
}

function sourceFixture({ reverse = false } = {}) {
  const westIds = Object.fromEntries([
    'neighborhood',
    'cul-entry',
    'cul-bowl',
    'commercial',
    'field',
    'generic',
    'mixed',
    'transit',
    'denied',
    'gated',
    'apartments',
    'west-seam',
  ].map((key) => [key, identity(key)]));
  const eastSeam = identity('east-seam');
  const westRoads = [
    road('neighborhood', [[0.05, 0.1], [0.25, 0.1]], [neighbor(westIds['cul-entry'])]),
    road('cul-entry', [[0.25, 0.1], [0.4, 0.2]], [neighbor(westIds.neighborhood), neighbor(westIds['cul-bowl'])]),
    road('cul-bowl', [[0.4, 0.2], [0.45, 0.25], [0.35, 0.25], [0.4, 0.2]], [neighbor(westIds['cul-entry'])]),
    road('commercial', [[0.05, 0.35], [0.25, 0.35]]),
    road('field', [[0.05, 0.45], [0.25, 0.45]]),
    road('generic', [[0.05, 0.55], [0.25, 0.55]]),
    road('mixed', [[0.35, 0.35], [0.55, 0.35]]),
    road('transit', [[0.35, 0.45], [0.55, 0.45]]),
    road('denied', [[0.35, 0.55], [0.55, 0.55]], [], 'denied'),
    road('gated', [[0.65, 0.1], [0.85, 0.1]]),
    road('apartments', [[0.65, 0.25], [0.85, 0.25]]),
    road('west-seam', [[0.8, 0.8], [1, 0.8]], [neighbor(eastSeam)]),
  ];
  const westEvidence = [
    evidence('address-main', 'address', {
      address_key: '100-main-st',
      unit_keys: ['B', 'A'],
      occupancy: 'residential',
    }, [
      association(westIds.commercial, 'nearest_road', 10),
      association(westIds.neighborhood, 'address_street'),
    ]),
    evidence('building-main', 'building', { building_use: 'residential', unit_count: 99 }, [
      association(westIds.neighborhood, 'side_of_street'),
    ]),
    evidence('entrance-main', 'entrance', {
      entrance_key: 'main-front', entrance_type: 'main', use: 'residential',
    }, [association(westIds.neighborhood, 'entrance_driveway')]),
    evidence('cul-entry-home', 'building', { building_use: 'house' }, [association(westIds['cul-entry'], 'side_of_street')]),
    evidence('cul-bowl-home', 'building', { building_use: 'detached' }, [association(westIds['cul-bowl'], 'side_of_street')]),
    evidence('warehouse', 'building', { building_use: 'warehouse' }, [association(westIds.commercial, 'side_of_street')]),
    evidence('farm-field', 'land_use', { land_use: 'farmland' }, [association(westIds.field, 'area_overlap')]),
    evidence('generic-building', 'building', { building_use: 'yes', unit_count: 77 }, [association(westIds.generic, 'side_of_street')]),
    evidence('mixed-address', 'address', {
      address_key: '200-market-st', unit_keys: [], occupancy: 'mixed',
    }, [association(westIds.mixed, 'address_street')]),
    evidence('mixed-shop', 'place', { place_use: 'shop' }, [association(westIds.mixed, 'area_overlap')]),
    evidence('denied-home', 'address', {
      address_key: '300-private-rd', unit_keys: [], occupancy: 'residential',
    }, [association(westIds.denied, 'address_street')]),
    evidence('gated-home', 'address', {
      address_key: '400-gated-rd', unit_keys: [], occupancy: 'residential',
    }, [association(westIds.gated, 'address_street')]),
    evidence('unknown-gate', 'barrier', {
      barrier_type: 'gate', pedestrian_access: 'unknown',
    }, [association(westIds.gated, 'network_link')]),
    evidence('apartments-building', 'building', { building_use: 'apartments' }, [association(westIds.apartments, 'side_of_street')]),
  ];
  const west = {
    schema: 'firstknock.canvas-source-evidence-tile',
    schema_version: 1,
    tile_address: { scheme: 'fixture-source-grid', scheme_version: 1, key: 'west' },
    coverage: { area_sq_mi: 1, bounds: { min_lng: 0, min_lat: 0, max_lng: 1, max_lat: 1 } },
    road_segments: reverse
      ? westRoads.toReversed().map((item) => ({ ...item, neighbors: item.neighbors.toReversed() }))
      : westRoads,
    evidence: reverse
      ? westEvidence.toReversed().map((item) => ({ ...item, associations: item.associations.toReversed() }))
      : westEvidence,
    protected_groups: [{
      kind: 'cul_de_sac',
      members: reverse ? [westIds['cul-bowl'], westIds['cul-entry']] : [westIds['cul-entry'], westIds['cul-bowl']],
      entries: [westIds['cul-entry']],
    }],
  };
  const east = {
    schema: 'firstknock.canvas-source-evidence-tile',
    schema_version: 1,
    tile_address: { scheme: 'fixture-source-grid', scheme_version: 1, key: 'east' },
    coverage: { area_sq_mi: 1, bounds: { min_lng: 1, min_lat: 0, max_lng: 2, max_lat: 1 } },
    road_segments: [road('east-seam', [[1, 0.8], [1.2, 0.8]], [neighbor(westIds['west-seam'])])],
    evidence: [],
    protected_groups: [],
  };
  return reverse ? [east, west] : [west, east];
}

function workUnitsByFeature(tile) {
  return new Map(tile.work_units.map((unit) => [unit.identity.source_feature_id, unit]));
}

function expectNormalizationError(code) {
  return (error) => {
    assert.ok(error instanceof CanvasSourceNormalizationError, error?.stack);
    assert.equal(error.code, code);
    return true;
  };
}

function releaseMetadata() {
  return {
    schema: 'firstknock.canvas-normalized-evidence-release',
    schema_version: 1,
    release: {
      dataset_namespace: 'firstknock-source-normalizer-fixture',
      dataset_version: '2026-08-14.fixture.1',
      generated_at: '2026-08-14T00:00:00.000Z',
    },
    coverage: {
      country_codes: ['US'],
      bounds: { min_lng: 0, min_lat: 0, max_lng: 2, max_lat: 1 },
    },
    tile_scheme: { scheme: 'fixture-source-grid', scheme_version: 1 },
    sources: [
      {
        source_id: 'fixture-places',
        provider: 'local deterministic fixture',
        dataset_version: DATASET_VERSION,
        license: LICENSE,
        captured_at: OBSERVED_AT,
      },
      {
        source_id: 'fixture-roads',
        provider: 'local deterministic fixture',
        dataset_version: DATASET_VERSION,
        license: LICENSE,
        captured_at: OBSERVED_AT,
      },
    ],
  };
}

test('source normalizer implements the four safe roles and the evidence priority hierarchy', () => {
  assert.deepEqual(CANVAS_SOURCE_ROLES, ['knock', 'transit_only', 'excluded', 'uncertain']);
  const audited = normalizeCanvasSourceEvidenceTileWithAudit(sourceFixture()[0]);
  assert.deepEqual([...new Set(audited.audit.map((item) => item.source_role))].sort(), [
    'excluded', 'knock', 'transit_only', 'uncertain',
  ]);
  const west = normalizeCanvasSourceEvidenceTiles(sourceFixture()).find((tile) => tile.tile_address.key === 'west');
  const units = workUnitsByFeature(west);
  assert.equal(units.get('neighborhood').canvas_role, 'opportunity');
  assert.deepEqual(units.get('neighborhood').opportunity, { min: 2, expected: 2, max: 2 }, 'address/unit evidence wins over explicit count, entrance, and footprint evidence');
  assert.ok(units.get('neighborhood').confidence.reasons.includes('opportunity_deduplicated_address_units'));
  assert.equal(units.get('transit').canvas_role, 'transit');
  assert.equal(units.get('commercial').canvas_role, 'excluded');
  assert.equal(units.get('field').canvas_role, 'excluded');
  assert.equal(units.get('generic').canvas_role, 'uncertain');
  assert.equal(units.get('generic').opportunity, undefined, 'building=yes never invents workload');
  assert.equal(units.get('denied').canvas_role, 'excluded', 'legal access is combined after residential classification');
  assert.equal(units.get('denied').opportunity, undefined);
  assert.equal(units.get('gated').canvas_role, 'uncertain');
});

test('mixed use stays knockable and apartment fallback is wide without footprint-derived unit math', () => {
  const west = normalizeCanvasSourceEvidenceTiles(sourceFixture()).find((tile) => tile.tile_address.key === 'west');
  const units = workUnitsByFeature(west);
  assert.equal(units.get('mixed').canvas_role, 'opportunity');
  assert.deepEqual(units.get('mixed').opportunity, { min: 1, expected: 1, max: 1 });
  assert.ok(units.get('mixed').confidence.reasons.includes('residential_mixed_use_preserved'));
  assert.deepEqual(units.get('apartments').opportunity, { min: 1, expected: 8, max: 40 });
  assert.ok(units.get('apartments').confidence.reasons.includes('opportunity_residential_footprints_with_wide_multi_unit_sites'));
});

test('opportunity estimates descend from explicit units to entrances to residential footprints', () => {
  const explicitFixture = sourceFixture()[0];
  explicitFixture.evidence = explicitFixture.evidence.filter((item) => item.evidence_id !== 'address-main');
  let units = workUnitsByFeature(normalizeCanvasSourceEvidenceTile(explicitFixture));
  assert.deepEqual(units.get('neighborhood').opportunity, { min: 99, expected: 99, max: 99 });
  assert.ok(units.get('neighborhood').confidence.reasons.includes('opportunity_explicit_unit_count'));

  const entranceFixture = sourceFixture()[0];
  entranceFixture.evidence = entranceFixture.evidence.filter((item) => item.evidence_id !== 'address-main');
  delete entranceFixture.evidence.find((item) => item.evidence_id === 'building-main').attributes.unit_count;
  units = workUnitsByFeature(normalizeCanvasSourceEvidenceTile(entranceFixture));
  assert.deepEqual(units.get('neighborhood').opportunity, { min: 1, expected: 1, max: 2 });
  assert.ok(units.get('neighborhood').confidence.reasons.includes('opportunity_residential_entrances'));

  const footprintFixture = sourceFixture()[0];
  footprintFixture.evidence = footprintFixture.evidence.filter((item) => !['address-main', 'entrance-main'].includes(item.evidence_id));
  delete footprintFixture.evidence.find((item) => item.evidence_id === 'building-main').attributes.unit_count;
  units = workUnitsByFeature(normalizeCanvasSourceEvidenceTile(footprintFixture));
  assert.deepEqual(units.get('neighborhood').opportunity, { min: 1, expected: 1, max: 1 });
  assert.ok(units.get('neighborhood').confidence.reasons.includes('opportunity_residential_footprints'));
});

test('specific access evidence can resolve unknown access while conflicting evidence remains uncertain', () => {
  const resolved = sourceFixture()[0];
  resolved.road_segments.find((item) => item.identity.source_feature_id === 'gated').legal_access = 'unknown';
  resolved.evidence.find((item) => item.evidence_id === 'unknown-gate').attributes.pedestrian_access = 'allowed';
  let units = workUnitsByFeature(normalizeCanvasSourceEvidenceTile(resolved));
  assert.equal(units.get('gated').canvas_role, 'opportunity');

  const conflict = sourceFixture()[0];
  conflict.evidence.push(evidence('private-access-claim', 'access', { pedestrian_access: 'allowed' }, [
    association(identity('denied'), 'network_link'),
  ]));
  units = workUnitsByFeature(normalizeCanvasSourceEvidenceTile(conflict));
  assert.equal(units.get('denied').canvas_role, 'uncertain');
  assert.ok(units.get('denied').confidence.reasons.includes('conflicting_access_evidence'));
});

test('street association uses address, entrance, side, then bounded nearest-road fallback', () => {
  const west = normalizeCanvasSourceEvidenceTiles(sourceFixture()).find((tile) => tile.tile_address.key === 'west');
  const units = workUnitsByFeature(west);
  assert.equal(units.get('neighborhood').opportunity.expected, 2);
  assert.equal(units.get('commercial').canvas_role, 'excluded', 'weaker nearest-road candidate did not steal the address');

  const ambiguous = sourceFixture()[0];
  ambiguous.evidence[0].associations = [
    association(identity('neighborhood'), 'address_street'),
    association(identity('commercial'), 'address_street'),
  ];
  assert.throws(() => normalizeCanvasSourceEvidenceTile(ambiguous), expectNormalizationError('ambiguous_evidence_association'));

  const distant = sourceFixture()[0];
  distant.evidence[0].associations = [association(identity('neighborhood'), 'nearest_road', 61)];
  assert.throws(() => normalizeCanvasSourceEvidenceTile(distant), expectNormalizationError('nearest_road_out_of_range'));
});

test('cul-de-sac ownership, topology, provenance, IDs, and output are deterministic across input order', () => {
  const first = normalizeCanvasSourceEvidenceTiles(sourceFixture());
  const second = normalizeCanvasSourceEvidenceTiles(sourceFixture({ reverse: true }));
  assert.equal(canonicalStringify(first), canonicalStringify(second));
  const west = first.find((tile) => tile.tile_address.key === 'west');
  assert.equal(west.protected_groups.length, 1);
  assert.equal(west.protected_groups[0].kind, 'cul_de_sac');
  assert.deepEqual(
    west.protected_groups[0].members.map(canonicalWorkUnitId),
    [...west.protected_groups[0].members.map(canonicalWorkUnitId)].sort(),
  );
  for (const unit of west.work_units) {
    assert.ok(unit.provenance.length > 0);
    assert.ok(unit.confidence.reasons.length > 0);
  }
  const westSeam = workUnitsByFeature(west).get('west-seam');
  assert.equal(westSeam.neighbors[0].identity.source_feature_id, 'east-seam');
  assert.equal(westSeam.neighbors[0].scope, 'release');
});

test('invalid fields, broken cul-de-sac topology, and duplicate address ownership fail closed', () => {
  const unknownField = sourceFixture()[0];
  unknownField.evidence[0].attributes.footprint_area = 10_000;
  assert.throws(() => normalizeCanvasSourceEvidenceTile(unknownField), expectNormalizationError('unknown_source_field'));

  const brokenGroup = sourceFixture()[0];
  brokenGroup.protected_groups[0].entries = [identity('cul-bowl')];
  assert.throws(() => normalizeCanvasSourceEvidenceTile(brokenGroup), expectNormalizationError('invalid_cul_de_sac_entry'));

  const duplicateOwnership = sourceFixture();
  duplicateOwnership[1].evidence.push(evidence('duplicate-address', 'address', {
    address_key: '100-main-st', unit_keys: ['A'], occupancy: 'residential',
  }, [association(identity('east-seam'), 'address_street')]));
  assert.throws(() => normalizeCanvasSourceEvidenceTiles(duplicateOwnership), expectNormalizationError('ambiguous_opportunity_ownership'));
});

test('normalized fixture validates end to end through the production release builder', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'canvas-source-e2e-'));
  try {
    const normalized = normalizeCanvasSourceEvidenceTiles(sourceFixture({ reverse: true }));
    const input = join(temporary, 'normalized.ndjson');
    await writeFile(input, `${normalized.map((tile) => canonicalStringify(tile)).join('\n')}\n`, 'utf8');
    const result = await buildCanvasEvidenceRelease({
      releaseMetadata: releaseMetadata(),
      tileInputPaths: [input],
      validateOnly: true,
    });
    assert.equal(result.tile_count, 2);
    assert.equal(result.work_unit_count, 13);
    assert.equal(result.topology.release_neighbor_references, 6);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('CLI accepts versioned JSON collections, emits canonical NDJSON, and never overwrites', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'canvas-source-cli-'));
  try {
    const input = join(temporary, 'source.json');
    const output = join(temporary, 'normalized.ndjson');
    await writeFile(input, JSON.stringify({
      schema: 'firstknock.canvas-source-evidence-collection',
      schema_version: 1,
      tiles: sourceFixture({ reverse: true }),
    }), 'utf8');
    const result = await runCanvasSourceNormalizerCli(['--input', input, '--output', output]);
    assert.equal(result.tile_count, 2);
    assert.equal(result.role_counts.opportunity, 5);
    assert.equal(result.role_counts.transit, 3);
    assert.equal(result.role_counts.excluded, 3);
    assert.equal(result.role_counts.uncertain, 2);
    const lines = (await readFile(output, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    assert.ok(lines.every((line) => line === canonicalStringify(JSON.parse(line))));
    const sourceNdjson = join(temporary, 'source.ndjson');
    await writeFile(sourceNdjson, `${sourceFixture().map((tile) => JSON.stringify(tile)).join('\n')}\n`, 'utf8');
    const validation = await runCanvasSourceNormalizerCli(['--input', sourceNdjson, '--validate-only']);
    assert.equal(validation.mode, 'validate-only');
    assert.equal(validation.tile_count, 2);
    await assert.rejects(
      runCanvasSourceNormalizerCli(['--input', input, '--output', output]),
      expectNormalizationError('output_already_exists'),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
