import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CanvasEvidenceReleaseError,
  NORMALIZED_RELEASE_SCHEMA,
  NORMALIZED_TILE_SCHEMA,
  buildCanvasEvidenceRelease,
  resolveProductionSigningMaterial,
} from '../scripts/canvas-evidence/release-builder.mjs';
import { runCanvasEvidenceReleaseCli } from '../scripts/canvas-evidence/build-release.mjs';
import { canonicalReleaseId, canonicalStringify, verifyCanvasEvidenceManifest } from '../scripts/canvas-evidence/contract.mjs';
import {
  LOCAL_FIXTURE_PRIVATE_KEY,
  LOCAL_FIXTURE_PUBLIC_KEY,
} from '../scripts/canvas-evidence/local-fixture-keys.mjs';

const SOURCE = Object.freeze({
  source_id: 'normalized-test-source',
  provider: 'provider-neutral test ETL',
  dataset_version: '2026-08-14.test.1',
  license: 'test-data-only',
  captured_at: '2026-08-14T10:00:00.000Z',
});

function keypair() {
  const generated = generateKeyPairSync('ed25519');
  return {
    privateKey: generated.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKey: generated.publicKey.export({ type: 'spki', format: 'pem' }),
    keyId: 'canvas-production-test-2026-08',
  };
}

function releaseMetadata({ version = '2026-08-14.release.1', generatedAt = '2026-08-14T12:00:00.000Z', bounds } = {}) {
  return {
    schema: NORMALIZED_RELEASE_SCHEMA,
    schema_version: 1,
    release: {
      dataset_namespace: 'firstknock-normalized-test',
      dataset_version: version,
      generated_at: generatedAt,
    },
    coverage: {
      country_codes: ['US'],
      bounds: bounds || { min_lng: -1, min_lat: 0, max_lng: 1, max_lat: 1 },
    },
    tile_scheme: { scheme: 'normalized-test-grid', scheme_version: 1 },
    sources: [SOURCE],
  };
}

function identity(featureId, segmentIndex = 0) {
  return {
    source_namespace: 'normalized-test-road',
    source_feature_id: featureId,
    segment_index: segmentIndex,
    from_millionths: 0,
    to_millionths: 1000000,
  };
}

function neighbor(targetIdentity, scope = 'release') {
  return { identity: targetIdentity, scope };
}

function workUnit({ featureId, segmentIndex = 0, geometry, neighbors = [], role = 'opportunity', expected = 10 }) {
  return {
    identity: identity(featureId, segmentIndex),
    canvas_role: role,
    confidence: {
      score: role === 'uncertain' ? 0.4 : 0.9,
      reasons: role === 'uncertain' ? ['missing_address_evidence'] : ['address_points'],
    },
    ...(role === 'opportunity' ? { opportunity: { min: Math.max(0, expected - 2), expected, max: expected + 2 } } : {}),
    provenance: [{
      source_id: SOURCE.source_id,
      dataset_version: SOURCE.dataset_version,
      feature_id: `${featureId}/${segmentIndex}`,
      observed_at: SOURCE.captured_at,
      license: SOURCE.license,
    }],
    geometry: { type: 'LineString', coordinates: geometry },
    neighbors,
  };
}

function normalizedTile({ key, bounds, units, protectedGroups = [] }) {
  return {
    schema: NORMALIZED_TILE_SCHEMA,
    schema_version: 1,
    tile_address: { scheme: 'normalized-test-grid', scheme_version: 1, key },
    coverage: { area_sq_mi: 1, bounds },
    work_units: units,
    protected_groups: protectedGroups,
  };
}

function boundaryFixture({ reverse = false, oneWay = false, includeOutsideTarget = false } = {}) {
  const a1Identity = identity('alpha', 0);
  const a2Identity = identity('alpha', 1);
  const b1Identity = identity('bravo', 0);
  const outsideIdentity = identity('outside-release', 0);
  const alphaUnits = [
    workUnit({
      featureId: 'alpha',
      segmentIndex: 0,
      geometry: [[-0.9, 0.5], [-0.5, 0.5]],
      neighbors: [neighbor(a2Identity)],
      expected: 8,
    }),
    workUnit({
      featureId: 'alpha',
      segmentIndex: 1,
      geometry: [[-0.5, 0.5], [0, 0.5]],
      neighbors: [neighbor(a1Identity), neighbor(b1Identity)],
      expected: 12,
    }),
  ];
  const bravoUnits = [
    workUnit({
      featureId: 'bravo',
      geometry: [[0, 0.5], [0.8, 0.5]],
      neighbors: [
        ...(oneWay ? [] : [neighbor(a2Identity)]),
        neighbor(outsideIdentity, 'outside_release'),
      ],
      role: 'transit',
    }),
  ];
  if (includeOutsideTarget) {
    bravoUnits.push(workUnit({
      featureId: 'outside-release',
      geometry: [[0.8, 0.5], [0.9, 0.5]],
      neighbors: [],
      role: 'excluded',
    }));
  }
  const protectedGroup = {
    kind: 'cul_de_sac',
    members: reverse ? [a2Identity, a1Identity] : [a1Identity, a2Identity],
    entries: [a1Identity],
  };
  if (reverse) alphaUnits.reverse();
  const tiles = [
    normalizedTile({
      key: 'west',
      bounds: { min_lng: -1, min_lat: 0, max_lng: 0, max_lat: 1 },
      units: alphaUnits,
      protectedGroups: [protectedGroup],
    }),
    normalizedTile({
      key: 'east',
      bounds: { min_lng: 0, min_lat: 0, max_lng: 1, max_lat: 1 },
      units: bravoUnits,
    }),
  ];
  if (reverse) tiles.reverse();
  return tiles;
}

async function writeBoundaryInputs(directory, tiles, { oneNdjson = true } = {}) {
  await mkdir(directory, { recursive: true });
  if (oneNdjson) {
    const ndjson = tiles.map((tile) => JSON.stringify(tile)).join('\n');
    await writeFile(join(directory, 'tiles.ndjson'), `${ndjson}\n`, 'utf8');
  } else {
    await writeFile(join(directory, 'west.json'), JSON.stringify(tiles[0]), 'utf8');
    await writeFile(join(directory, 'east.json'), JSON.stringify(tiles[1]), 'utf8');
  }
}

function expectReleaseError(code) {
  return (error) => {
    assert.ok(error instanceof CanvasEvidenceReleaseError, error?.stack);
    assert.equal(error.code, code);
    return true;
  };
}

test('production builder signs and atomically publishes deterministic JSON/NDJSON artifacts', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'canvas-release-build-test-'));
  try {
    const inputA = join(temporary, 'input-a');
    const inputB = join(temporary, 'input-b');
    await writeBoundaryInputs(inputA, boundaryFixture(), { oneNdjson: false });
    await writeBoundaryInputs(inputB, boundaryFixture({ reverse: true }));
    const signing = keypair();
    const metadata = releaseMetadata();
    const first = await buildCanvasEvidenceRelease({
      releaseMetadata: metadata,
      tileInputPaths: [inputA],
      outputRoot: join(temporary, 'releases-a'),
      objectPrefix: 'firstknock/canvas/evidence',
      ...signing,
    });
    const second = await buildCanvasEvidenceRelease({
      releaseMetadata: metadata,
      tileInputPaths: [inputB],
      outputRoot: join(temporary, 'releases-b'),
      objectPrefix: 'firstknock/canvas/evidence',
      ...signing,
    });
    assert.equal(first.tile_count, 2);
    assert.equal(first.work_unit_count, 3);
    assert.equal(first.topology.outside_neighbor_references, 1);
    assert.equal(first.resumed, false);

    const firstManifestBytes = await readFile(first.manifest_path);
    const secondManifestBytes = await readFile(second.manifest_path);
    assert.ok(firstManifestBytes.equals(secondManifestBytes), 'input file, tile, unit, reason, and protected-member order do not affect output');
    const manifest = JSON.parse(firstManifestBytes);
    assert.equal(verifyCanvasEvidenceManifest(manifest, {
      publicKey: signing.publicKey,
      expectedKeyId: signing.keyId,
    }), true);
    assert.deepEqual(manifest.tiles.map((tile) => tile.tile_id), [...manifest.tiles.map((tile) => tile.tile_id)].sort());

    const inventoryBytes = await readFile(join(first.release_directory, 'upload-inventory.json'));
    assert.equal(inventoryBytes.toString('utf8'), canonicalStringify(JSON.parse(inventoryBytes)));
    const inventory = JSON.parse(inventoryBytes);
    assert.equal(inventory.release_id, first.release_id);
    assert.equal(inventory.object_prefix, `firstknock/canvas/evidence/${first.release_id}`);
    assert.equal(inventory.artifacts.length, 3);
    assert.ok(inventory.artifacts.every((artifact) => artifact.cache_control.includes('immutable')));
    const checksums = await readFile(join(first.release_directory, 'SHA256SUMS'), 'utf8');
    assert.equal(checksums.trim().split('\n').length, 4, 'checksums cover the manifest, both tiles, and upload inventory');

    const resumed = await buildCanvasEvidenceRelease({
      releaseMetadata: metadata,
      tileInputPaths: [inputA],
      outputRoot: join(temporary, 'releases-a'),
      objectPrefix: 'firstknock/canvas/evidence',
      resume: true,
      ...signing,
    });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.release_directory, first.release_directory);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('validate-only streams inputs, checks boundary topology, and writes no release', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'canvas-release-validate-test-'));
  try {
    const input = join(temporary, 'input');
    await writeBoundaryInputs(input, boundaryFixture());
    const output = join(temporary, 'must-not-exist');
    const result = await buildCanvasEvidenceRelease({
      releaseMetadata: releaseMetadata(),
      tileInputPaths: [input],
      outputRoot: output,
      validateOnly: true,
    });
    assert.equal(result.mode, 'validate-only');
    assert.equal(result.signed, false);
    assert.equal(result.work_unit_count, 3);
    await assert.rejects(readFile(output), (error) => error.code === 'ENOENT');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('CLI resolves explicit tile inputs and performs unsigned validation without secret material', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'canvas-release-cli-test-'));
  try {
    const input = join(temporary, 'tiles');
    const releasePath = join(temporary, 'release.json');
    await writeBoundaryInputs(input, boundaryFixture());
    await writeFile(releasePath, JSON.stringify(releaseMetadata()), 'utf8');
    const result = await runCanvasEvidenceReleaseCli([
      '--release', releasePath,
      '--input', input,
      '--validate-only',
    ], {});
    assert.equal(result.mode, 'validate-only');
    assert.equal(result.tile_count, 2);
    assert.equal(result.signed, false);

    const signing = keypair();
    const privateKeyPath = join(temporary, 'production-private.pem');
    const publicKeyPath = join(temporary, 'production-public.pem');
    await writeFile(privateKeyPath, signing.privateKey, { mode: 0o600 });
    await writeFile(publicKeyPath, signing.publicKey, 'utf8');
    const built = await runCanvasEvidenceReleaseCli([
      '--release', releasePath,
      '--input', input,
      '--output', join(temporary, 'published'),
      '--private-key-file', privateKeyPath,
      '--public-key-file', publicKeyPath,
      '--key-id', signing.keyId,
    ], {});
    assert.equal(built.mode, 'build');
    assert.equal(built.tile_count, 2);
    assert.equal(JSON.parse(await readFile(built.manifest_path, 'utf8')).signature.key_id, signing.keyId);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('release topology fails closed for asymmetric, dangling, and mislabeled boundary links', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'canvas-release-boundary-test-'));
  try {
    const asymmetricInput = join(temporary, 'asymmetric');
    await writeBoundaryInputs(asymmetricInput, boundaryFixture({ oneWay: true }));
    await assert.rejects(buildCanvasEvidenceRelease({
      releaseMetadata: releaseMetadata(),
      tileInputPaths: [asymmetricInput],
      validateOnly: true,
    }), expectReleaseError('asymmetric_release_topology'));

    const internalOutsideInput = join(temporary, 'internal-outside');
    await writeBoundaryInputs(internalOutsideInput, boundaryFixture({ includeOutsideTarget: true }));
    await assert.rejects(buildCanvasEvidenceRelease({
      releaseMetadata: releaseMetadata(),
      tileInputPaths: [internalOutsideInput],
      validateOnly: true,
    }), expectReleaseError('outside_release_neighbor_is_internal'));

    const danglingTiles = boundaryFixture();
    danglingTiles[1].work_units[0].neighbors[0] = neighbor(identity('missing-from-release'));
    const danglingInput = join(temporary, 'dangling');
    await writeBoundaryInputs(danglingInput, danglingTiles);
    await assert.rejects(buildCanvasEvidenceRelease({
      releaseMetadata: releaseMetadata(),
      tileInputPaths: [danglingInput],
      validateOnly: true,
    }), expectReleaseError('missing_release_neighbor'));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('a failed topology pass never publishes and --resume can finish its private staging directory', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'canvas-release-stage-resume-test-'));
  try {
    const input = join(temporary, 'input');
    const output = join(temporary, 'releases');
    const metadata = releaseMetadata({ version: '2026-08-14.stage-resume.1' });
    const releaseId = canonicalReleaseId(metadata.release);
    const signing = keypair();
    await writeBoundaryInputs(input, boundaryFixture({ oneWay: true }));
    await assert.rejects(buildCanvasEvidenceRelease({
      releaseMetadata: metadata,
      tileInputPaths: [input],
      outputRoot: output,
      ...signing,
    }), expectReleaseError('asymmetric_release_topology'));
    await assert.rejects(readFile(join(output, releaseId, 'manifest.json')), (error) => error.code === 'ENOENT');

    await writeBoundaryInputs(input, boundaryFixture());
    const completed = await buildCanvasEvidenceRelease({
      releaseMetadata: metadata,
      tileInputPaths: [input],
      outputRoot: output,
      resume: true,
      ...signing,
    });
    assert.equal(completed.resumed, false, 'resume completed staging and performed the first atomic publication');
    assert.equal(completed.release_directory, join(output, releaseId));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('immutable release IDs cannot be silently reused for changed source content', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'canvas-release-immutable-test-'));
  try {
    const input = join(temporary, 'input');
    const tiles = boundaryFixture();
    await writeBoundaryInputs(input, tiles);
    const signing = keypair();
    const options = {
      releaseMetadata: releaseMetadata(),
      tileInputPaths: [input],
      outputRoot: join(temporary, 'releases'),
      ...signing,
    };
    await buildCanvasEvidenceRelease(options);
    tiles[0].work_units[0].opportunity.expected += 1;
    tiles[0].work_units[0].opportunity.max += 1;
    await writeBoundaryInputs(input, tiles);
    await assert.rejects(buildCanvasEvidenceRelease({ ...options, resume: true }), expectReleaseError('immutable_release_conflict'));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('production signing rejects the checked-in fixture key even under another key ID', () => {
  assert.throws(() => resolveProductionSigningMaterial({
    privateKey: LOCAL_FIXTURE_PRIVATE_KEY,
    publicKey: LOCAL_FIXTURE_PUBLIC_KEY,
    keyId: 'renamed-key-id',
  }), expectReleaseError('fixture_signing_key_forbidden'));
});

test('streaming topology validation handles a 10,000-work-unit multi-tile release', { timeout: 60_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'canvas-release-scale-test-'));
  try {
    const tileCount = 50;
    const unitsPerTile = 200;
    const totalUnits = tileCount * unitsPerTile;
    const path = join(temporary, 'scale.ndjson');
    const lines = [];
    for (let tileIndex = 0; tileIndex < tileCount; tileIndex += 1) {
      const minLng = -125 + tileIndex;
      const units = [];
      for (let localIndex = 0; localIndex < unitsPerTile; localIndex += 1) {
        const globalIndex = tileIndex * unitsPerTile + localIndex;
        const ownIdentity = identity('national-scale-chain', globalIndex);
        const neighbors = [];
        if (globalIndex > 0) neighbors.push(neighbor(identity('national-scale-chain', globalIndex - 1)));
        if (globalIndex + 1 < totalUnits) neighbors.push(neighbor(identity('national-scale-chain', globalIndex + 1)));
        const y = 0.001 + localIndex * 0.004;
        units.push(workUnit({
          featureId: ownIdentity.source_feature_id,
          segmentIndex: ownIdentity.segment_index,
          geometry: [[minLng + 0.1, y], [minLng + 0.9, y]],
          neighbors,
          expected: 1,
        }));
      }
      lines.push(JSON.stringify(normalizedTile({
        key: `national-${String(tileIndex).padStart(4, '0')}`,
        bounds: { min_lng: minLng, min_lat: 0, max_lng: minLng + 1, max_lat: 1 },
        units,
      })));
    }
    await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
    const result = await buildCanvasEvidenceRelease({
      releaseMetadata: releaseMetadata({
        version: '2026-08-14.scale.1',
        bounds: { min_lng: -125, min_lat: 0, max_lng: -75, max_lat: 1 },
      }),
      tileInputPaths: [path],
      validateOnly: true,
      topologyBucketCount: 64,
    });
    assert.equal(result.tile_count, tileCount);
    assert.equal(result.work_unit_count, totalUnits);
    assert.equal(result.topology.release_neighbor_references, (totalUnits - 1) * 2);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
