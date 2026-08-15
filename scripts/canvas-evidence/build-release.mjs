#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CanvasEvidenceReleaseError,
  buildCanvasEvidenceRelease,
  loadReleaseMetadata,
  loadSigningKeysFromFiles,
} from './release-builder.mjs';

const USAGE = `Build a signed, immutable Canvas evidence release from normalized tiles.

Usage:
  node scripts/canvas-evidence/build-release.mjs \\
    --release <release.json> \\
    --input <tile-file-or-directory> [--input ...] \\
    --output <release-root> \\
    --private-key-file <ed25519-private.pem> \\
    [--public-key-file <ed25519-public.pem>] \\
    --key-id <production-key-id> \\
    [--object-prefix canvas-evidence/releases] [--resume]

Validation without writing or signing:
  node scripts/canvas-evidence/build-release.mjs \\
    --release <release.json> --input <tiles> --validate-only

The key-file options can also be supplied through:
  CANVAS_EVIDENCE_SIGNING_PRIVATE_KEY_FILE
  CANVAS_EVIDENCE_SIGNING_PUBLIC_KEY_FILE
  CANVAS_EVIDENCE_SIGNING_KEY_ID
`;

function parseArguments(argv) {
  const result = { input: [] };
  const valueOptions = new Map([
    ['--release', 'release'],
    ['--input', 'input'],
    ['--output', 'output'],
    ['--private-key-file', 'privateKeyFile'],
    ['--public-key-file', 'publicKeyFile'],
    ['--key-id', 'keyId'],
    ['--object-prefix', 'objectPrefix'],
    ['--topology-buckets', 'topologyBuckets'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      result.help = true;
      continue;
    }
    if (argument === '--resume') {
      result.resume = true;
      continue;
    }
    if (argument === '--validate-only') {
      result.validateOnly = true;
      continue;
    }
    const property = valueOptions.get(argument);
    if (!property) throw new CanvasEvidenceReleaseError('unknown_argument', `Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new CanvasEvidenceReleaseError('missing_argument_value', `${argument} requires a value.`);
    index += 1;
    if (property === 'input') result.input.push(value);
    else result[property] = value;
  }
  return result;
}

export async function runCanvasEvidenceReleaseCli(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArguments(argv);
  if (options.help) return { help: true };
  if (!options.release) throw new CanvasEvidenceReleaseError('missing_release_metadata', '--release is required.');
  const releasePath = resolve(options.release);
  const releaseMetadata = await loadReleaseMetadata(releasePath);
  const validateOnly = Boolean(options.validateOnly);
  let signing = {};
  if (!validateOnly || options.privateKeyFile || environment.CANVAS_EVIDENCE_SIGNING_PRIVATE_KEY_FILE) {
    const privateKeyPath = options.privateKeyFile || environment.CANVAS_EVIDENCE_SIGNING_PRIVATE_KEY_FILE;
    const publicKeyPath = options.publicKeyFile || environment.CANVAS_EVIDENCE_SIGNING_PUBLIC_KEY_FILE;
    const keyId = options.keyId || environment.CANVAS_EVIDENCE_SIGNING_KEY_ID;
    if (!privateKeyPath || !keyId) {
      throw new CanvasEvidenceReleaseError(
        'missing_signing_configuration',
        'Production builds require --private-key-file and --key-id (or their environment-variable equivalents).',
      );
    }
    signing = await loadSigningKeysFromFiles({
      privateKeyPath: resolve(privateKeyPath),
      publicKeyPath: publicKeyPath ? resolve(publicKeyPath) : undefined,
      keyId,
    });
  }
  let topologyBucketCount;
  if (options.topologyBuckets !== undefined) {
    topologyBucketCount = Number(options.topologyBuckets);
    if (!Number.isSafeInteger(topologyBucketCount)) {
      throw new CanvasEvidenceReleaseError('invalid_topology_bucket_count', '--topology-buckets must be an integer.');
    }
  }
  return buildCanvasEvidenceRelease({
    releaseMetadata,
    inputBaseDirectory: dirname(releasePath),
    tileInputPaths: options.input.map((path) => resolve(path)),
    outputRoot: options.output ? resolve(options.output) : undefined,
    objectPrefix: options.objectPrefix,
    resume: Boolean(options.resume),
    validateOnly,
    ...(topologyBucketCount === undefined ? {} : { topologyBucketCount }),
    ...signing,
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const result = await runCanvasEvidenceReleaseCli();
    if (result.help) {
      process.stdout.write(USAGE);
    } else if (result.mode === 'validate-only') {
      process.stdout.write(`Canvas evidence input valid: ${result.release_id}\n`);
      process.stdout.write(`Tiles: ${result.tile_count}; work units: ${result.work_unit_count}; signed check: ${result.signed ? 'yes' : 'no'}\n`);
    } else {
      process.stdout.write(`Canvas evidence release ${result.resumed ? 'verified' : 'published'}: ${result.release_id}\n`);
      process.stdout.write(`Directory: ${result.release_directory}\n`);
      process.stdout.write(`Tiles: ${result.tile_count}; work units: ${result.work_unit_count}\n`);
      process.stdout.write(`Public key SHA-256: ${result.public_key_sha256}\n`);
    }
  } catch (error) {
    const code = error?.code || 'unexpected_error';
    process.stderr.write(`Canvas evidence release failed [${code}]: ${error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}
