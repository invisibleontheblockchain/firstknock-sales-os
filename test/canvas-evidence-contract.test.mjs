import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CanvasEvidenceContractError,
  canonicalStringify,
  selectCanvasEvidenceTiles,
  selectCanvasEvidenceWorkUnits,
  validateCanvasEvidenceBundle,
  validateCanvasEvidenceManifest,
  validateCanvasEvidenceTile,
  verifyCanvasEvidenceManifest,
} from '../scripts/canvas-evidence/contract.mjs';
import { compileCanvasEvidenceFixture } from '../scripts/canvas-evidence/compiler.mjs';
import {
  LOCAL_FIXTURE_KEY_ID,
  LOCAL_FIXTURE_PRIVATE_KEY,
  LOCAL_FIXTURE_PUBLIC_KEY,
} from '../scripts/canvas-evidence/local-fixture-keys.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(testDirectory, 'fixtures/canvas-evidence/input.json');
const keyOptions = {
  privateKey: LOCAL_FIXTURE_PRIVATE_KEY,
  publicKey: LOCAL_FIXTURE_PUBLIC_KEY,
  keyId: LOCAL_FIXTURE_KEY_ID,
};

const clone = (value) => JSON.parse(JSON.stringify(value));

async function loadFixture() {
  return JSON.parse(await readFile(fixturePath, 'utf8'));
}

async function compileFixture() {
  return compileCanvasEvidenceFixture(await loadFixture(), keyOptions);
}

function expectContractError(callback, code) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof CanvasEvidenceContractError);
    assert.equal(error.code, code);
    return true;
  });
}

test('local compiler is deterministic, canonical, signed, and has no network dependency', async () => {
  const fixture = await loadFixture();
  const reordered = clone(fixture);
  reordered.sources.reverse();
  reordered.tiles.reverse();
  for (const tile of reordered.tiles) {
    tile.work_units.reverse();
    tile.protected_groups.reverse();
    tile.external_neighbors.reverse();
    for (const unit of tile.work_units) {
      unit.neighbors.reverse();
      unit.provenance.reverse();
      unit.confidence.reasons.reverse();
    }
    for (const group of tile.protected_groups) {
      group.members.reverse();
      group.entries.reverse();
    }
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('Network access is forbidden in the Canvas fixture compiler.');
  };
  try {
    const first = compileCanvasEvidenceFixture(fixture, keyOptions);
    const second = compileCanvasEvidenceFixture(reordered, keyOptions);
    assert.equal(canonicalStringify(first), canonicalStringify(second));
    assert.equal(verifyCanvasEvidenceManifest(first.manifest, {
      publicKey: LOCAL_FIXTURE_PUBLIC_KEY,
      expectedKeyId: LOCAL_FIXTURE_KEY_ID,
    }), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('manifest signature and tile digest fail closed after tampering', async () => {
  const bundle = await compileFixture();
  const tamperedManifest = clone(bundle.manifest);
  tamperedManifest.tiles[0].expected_opportunities += 1;
  assert.equal(verifyCanvasEvidenceManifest(tamperedManifest, {
    publicKey: LOCAL_FIXTURE_PUBLIC_KEY,
    expectedKeyId: LOCAL_FIXTURE_KEY_ID,
  }), false);

  const tamperedTiles = clone(bundle.tiles);
  const [tileId] = Object.keys(tamperedTiles);
  tamperedTiles[tileId].work_units[0].geometry.coordinates[0][0] += 0.000001;
  expectContractError(() => validateCanvasEvidenceBundle({
    manifest: bundle.manifest,
    tiles: tamperedTiles,
    publicKey: LOCAL_FIXTURE_PUBLIC_KEY,
    expectedKeyId: LOCAL_FIXTURE_KEY_ID,
  }), 'bundle_tile_digest_mismatch');
});

test('compiled work units carry all four roles, provenance, confidence, symmetric topology, and protected groups', async () => {
  const bundle = await compileFixture();
  const tile = Object.values(bundle.tiles)[0];
  const metrics = validateCanvasEvidenceTile(tile, bundle.manifest.limits);
  assert.equal(metrics.work_unit_count, 6);
  assert.deepEqual([...new Set(tile.work_units.map((unit) => unit.canvas_role))].sort(), [
    'excluded',
    'opportunity',
    'transit',
    'uncertain',
  ]);
  for (const unit of tile.work_units) {
    assert.ok(unit.provenance.length > 0);
    assert.ok(unit.confidence.reasons.length > 0);
    if (unit.canvas_role !== 'opportunity') assert.equal(unit.opportunity, null);
    for (const neighborId of unit.neighbor_ids) {
      const neighbor = tile.work_units.find((candidate) => candidate.work_unit_id === neighborId);
      if (neighbor) assert.ok(neighbor.neighbor_ids.includes(unit.work_unit_id));
      else assert.ok(tile.external_neighbor_ids.includes(neighborId));
    }
  }
  assert.equal(tile.protected_groups.length, 1);
  const [group] = tile.protected_groups;
  assert.equal(group.kind, 'cul_de_sac');
  assert.equal(group.member_work_unit_ids.length, 2);
  assert.ok(group.member_work_unit_ids.every((id) => (
    tile.work_units.find((unit) => unit.work_unit_id === id)?.protected_group_id === group.protected_group_id
  )));
});

test('tile validation enforces density, canonical byte, topology, and provenance limits', async () => {
  const bundle = await compileFixture();
  const tile = Object.values(bundle.tiles)[0];
  expectContractError(() => validateCanvasEvidenceTile(tile, {
    ...bundle.manifest.limits,
    max_work_units_per_sq_mi: 1,
  }), 'work_unit_density_exceeded');
  expectContractError(() => validateCanvasEvidenceTile(tile, {
    ...bundle.manifest.limits,
    max_tile_bytes: 100,
  }), 'tile_byte_limit_exceeded');

  const asymmetric = clone(tile);
  const linkedUnit = asymmetric.work_units.find((unit) => unit.neighbor_ids.length > 1);
  const neighborId = linkedUnit.neighbor_ids[0];
  const neighbor = asymmetric.work_units.find((unit) => unit.work_unit_id === neighborId);
  neighbor.neighbor_ids = neighbor.neighbor_ids.filter((id) => id !== linkedUnit.work_unit_id);
  expectContractError(() => validateCanvasEvidenceTile(asymmetric, bundle.manifest.limits), 'asymmetric_topology');

  const missingProvenance = clone(tile);
  missingProvenance.work_units[0].provenance = [];
  expectContractError(() => validateCanvasEvidenceTile(missingProvenance, bundle.manifest.limits), 'missing_provenance');
});

test('manifest bounds select intersecting tiles without fetching tile payloads', async () => {
  const bundle = await compileFixture();
  const inside = [
    [-112.079, 33.449],
    [-112.076, 33.449],
    [-112.076, 33.451],
    [-112.079, 33.451],
  ];
  const outside = [
    [-80.1, 25.1],
    [-80, 25.1],
    [-80, 25.2],
    [-80.1, 25.2],
  ];
  assert.equal(selectCanvasEvidenceTiles(bundle.manifest, inside).length, 1);
  assert.equal(selectCanvasEvidenceTiles(bundle.manifest, outside).length, 0);

  const noBounds = clone(bundle.manifest);
  delete noBounds.tiles[0].coverage_bounds;
  expectContractError(() => validateCanvasEvidenceManifest(noBounds), 'invalid_record');
});

test('polygon selection keeps protected streets atomic and preserves cut-edge neighbors', async () => {
  const bundle = await compileFixture();
  const tile = Object.values(bundle.tiles)[0];
  const courtOnlyBoundary = {
    type: 'Polygon',
    coordinates: [[
      [-112.07755, 33.4504],
      [-112.07725, 33.4504],
      [-112.07725, 33.4507],
      [-112.07755, 33.4507],
      [-112.07755, 33.4504]
    ]],
  };
  const selection = selectCanvasEvidenceWorkUnits(tile, courtOnlyBoundary, bundle.manifest.limits);
  assert.equal(selection.work_units.length, 2, 'selecting the cul-de-sac entry expands to its protected bowl');
  assert.equal(selection.protected_groups.length, 1);
  assert.equal(selection.protected_groups[0].member_work_unit_ids.length, 2);
  assert.equal(selection.external_neighbor_ids.length, 1, 'the edge back to the unselected main street remains explicit');
  assert.ok(selection.work_units.some((unit) => unit.neighbor_ids.includes(selection.external_neighbor_ids[0])));

  const westOnlyBoundary = [
    [-112.0803, 33.4498],
    [-112.079, 33.4498],
    [-112.079, 33.4502],
    [-112.0803, 33.4502],
  ];
  const westSelection = selectCanvasEvidenceWorkUnits(tile, westOnlyBoundary, bundle.manifest.limits);
  assert.ok(tile.external_neighbor_ids.every((id) => westSelection.external_neighbor_ids.includes(id)), 'source-tile external neighbors survive polygon selection');
});
