import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifySourceManifest } from '../scripts/canvas-evidence/source-artifacts/verify-source-manifest.mjs';

const sourceBytes = Buffer.from('{"type":"FeatureCollection","features":[]}');
const hash = 'ed778c73ea51338d6576fb5992b189f2b94d9f3d5e199f46c1af520d6b0b3e6c';
const manifest = (sha256 = hash) => ({
  schema: 'firstknock.canvas-source-artifact-manifest', schema_version: 1,
  benchmark: 'fixture', extraction: { bbox: [0, 0, 1, 1] }, versions: { normalizer: 'v1' },
  policy: { immutable: true, overwrite_allowed: false },
  sources: [{ source_id: 'fixture', source_version: 'v1', origin: 'https://example.test/source', license: 'fixture', artifact_key: 'fixtures/source.json', relative_path: 'source.json', bytes: sourceBytes.length, sha256 }],
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'canvas-source-manifest-'));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'source.json'), sourceBytes);
  const manifestPath = join(root, 'manifest.json');
  return { root, manifestPath };
}

test('verifies exact immutable source bytes', async () => {
  const value = await fixture();
  await writeFile(value.manifestPath, JSON.stringify(manifest()));
  const result = await verifySourceManifest(value.manifestPath, value.root);
  assert.equal(result.source_count, 1);
});

test('rejects changed source bytes', async () => {
  const value = await fixture();
  await writeFile(value.manifestPath, JSON.stringify(manifest('0'.repeat(64))));
  await assert.rejects(verifySourceManifest(value.manifestPath, value.root), /does not match its pinned bytes/);
});