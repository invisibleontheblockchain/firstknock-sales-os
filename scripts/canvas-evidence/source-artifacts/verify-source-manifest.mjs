#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalStringify } from '../contract.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => { throw new TypeError(message); };

function featureId(feature) {
  return String(feature?.id || feature?.properties?.id || '');
}

function canonicalContent(parsed) {
  if (parsed?.type === 'FeatureCollection' && Array.isArray(parsed.features)) {
    return parsed.features.toSorted((left, right) => featureId(left).localeCompare(featureId(right)))
      .map((feature) => canonicalStringify(feature)).join('\n');
  }
  return canonicalStringify(parsed);
}

export async function verifySourceManifest(manifestPath, artifactRoot = '.') {
  const absoluteManifestPath = resolve(manifestPath);
  const manifest = JSON.parse(await readFile(absoluteManifestPath, 'utf8'));
  if (manifest.schema !== 'firstknock.canvas-source-artifact-manifest' || manifest.schema_version !== 1) fail('Unsupported Canvas source manifest.');
  if (!manifest.benchmark || !manifest.extraction || !manifest.versions) fail('Canvas source manifest identity, extraction rules, or versions are missing.');
  if (manifest.policy?.immutable !== true || manifest.policy?.overwrite_allowed !== false) fail('Canvas source artifacts must be immutable and non-overwritable.');
  if (!Array.isArray(manifest.sources) || !manifest.sources.length) fail('Canvas source manifest contains no sources.');

  const seen = new Set();
  const verified = [];
  for (const source of manifest.sources) {
    if (!source.source_id || seen.has(source.source_id)) fail(`Duplicate or missing source_id: ${source.source_id || '(missing)'}`);
    seen.add(source.source_id);
    if (!source.source_version || !source.origin || !source.license || !source.artifact_key) fail(`Source ${source.source_id} has incomplete provenance.`);
    if (!/^[a-f0-9]{64}$/.test(source.sha256 || '') || !Number.isSafeInteger(source.bytes) || source.bytes < 1) fail(`Source ${source.source_id} has no valid byte contract.`);
    const filePath = source.repository_path ? resolve(source.repository_path) : resolve(artifactRoot, source.relative_path || '');
    const bytes = await readFile(filePath).catch(() => fail(`Source ${source.source_id} is unavailable at ${filePath}.`));
    if (bytes.byteLength !== source.bytes || sha256(bytes) !== source.sha256) fail(`Source ${source.source_id} does not match its pinned bytes.`);
    if (source.canonical_content_sha256) {
      const canonicalHash = sha256(canonicalContent(JSON.parse(bytes.toString('utf8'))));
      if (canonicalHash !== source.canonical_content_sha256) fail(`Source ${source.source_id} does not match its canonical content hash.`);
    }
    verified.push({ source_id: source.source_id, bytes: bytes.byteLength, sha256: source.sha256 });
  }
  return { benchmark: manifest.benchmark, source_count: verified.length, verified };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const [manifestPath, artifactRoot = '.'] = process.argv.slice(2);
  if (!manifestPath) fail('Usage: verify-source-manifest <manifest.json> [artifact-root]');
  verifySourceManifest(manifestPath, artifactRoot)
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => { process.stderr.write(`Canvas source verification failed: ${error.message}\n`); process.exitCode = 1; });
}