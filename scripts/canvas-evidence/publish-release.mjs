#!/usr/bin/env node
// Publish a signed Canvas evidence release to S3-compatible object storage.
//
// The release builder emits `upload-inventory.json`, which pins every artifact's
// object key, SHA-256, byte length, content type and cache-control. This script
// treats that inventory as an allowlist: nothing else is uploaded, and every
// object is re-read from the store and hashed after writing.
//
// Two ordering rules matter and are enforced here rather than left to the
// operator:
//
//   1. Tiles upload before the manifest. The manifest is the commit point — it
//      pins tile hashes, so a manifest visible before its tiles is a release
//      that resolves to missing objects.
//   2. An existing release prefix is never overwritten. Releases are immutable;
//      a changed release gets a new id. Overwriting one silently invalidates
//      every pinned snapshot that already referenced it.
//
// Verification is independent: a multipart ETag is not a SHA-256, so the
// uploaded bytes are fetched back and hashed rather than trusting the store's
// own metadata.

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const USAGE = `Publish a signed Canvas evidence release to R2 or S3.

Usage:
  node scripts/canvas-evidence/publish-release.mjs \\
    --release-dir <cer1_.../> \\
    --bucket <bucket-name> \\
    --endpoint <https://<account>.r2.cloudflarestorage.com> \\
    [--region auto] [--dry-run]

Credentials come from the environment, never from arguments:
  R2_ACCESS_KEY_ID
  R2_SECRET_ACCESS_KEY

Dry run lists exactly what would be uploaded and verifies local hashes first.
`;

const INVENTORY_SCHEMA = 'firstknock.canvas-evidence-upload-inventory';

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseArguments(argv) {
  const keys = new Map([
    ['--release-dir', 'releaseDir'], ['--bucket', 'bucket'],
    ['--endpoint', 'endpoint'], ['--region', 'region'],
  ]);
  const result = { region: 'auto', dryRun: false, resume: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--help' || argv[index] === '-h') return { help: true };
    if (argv[index] === '--dry-run') { result.dryRun = true; continue; }
    if (argv[index] === '--resume') { result.resume = true; continue; }
    const key = keys.get(argv[index]);
    if (!key) fail(`Unknown option: ${argv[index]}`);
    const value = argv[index + 1];
    if (value === undefined) fail(`${argv[index]} requires a value`);
    result[key] = value;
    index += 1;
  }
  for (const required of ['releaseDir', 'bucket', 'endpoint']) {
    if (!result[required]) fail(`Missing required option: --${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  return result;
}

/** Read the inventory and confirm every local file matches the hash it pins. */
async function loadVerifiedInventory(releaseDir) {
  const inventoryPath = join(releaseDir, 'upload-inventory.json');
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  if (inventory.schema !== INVENTORY_SCHEMA) {
    fail(`${inventoryPath} is not a Canvas upload inventory (schema: ${inventory.schema}).`);
  }
  if (!Array.isArray(inventory.artifacts) || !inventory.artifacts.length) {
    fail('Upload inventory lists no artifacts.');
  }

  const artifacts = [];
  for (const artifact of inventory.artifacts) {
    const localPath = join(releaseDir, artifact.path);
    const bytes = await readFile(localPath).catch(() => null);
    if (!bytes) fail(`Inventory lists ${artifact.path} but it is missing from the release directory.`);
    if (bytes.byteLength !== artifact.byte_length) {
      fail(`${artifact.path}: local byte length ${bytes.byteLength} does not match inventory ${artifact.byte_length}.`);
    }
    const digest = sha256Hex(bytes);
    if (digest !== artifact.sha256) {
      fail(`${artifact.path}: local SHA-256 ${digest} does not match inventory ${artifact.sha256}. The release directory has been modified since it was signed.`);
    }
    artifacts.push({ ...artifact, bytes });
  }

  // Refuse to publish a release the local checksums do not vouch for.
  const listed = new Set(inventory.artifacts.map((artifact) => artifact.path));
  const tileDirectory = join(releaseDir, 'tiles');
  const tilesOnDisk = await readdir(tileDirectory).catch(() => []);
  for (const name of tilesOnDisk) {
    const path = `tiles/${name}`;
    if (!listed.has(path)) fail(`${path} exists on disk but is not in the inventory. Refusing to publish an unsigned artifact.`);
  }

  return { inventory, artifacts };
}

/** The manifest commits the release, so it is uploaded last. */
function publishOrder(artifacts) {
  const manifest = artifacts.filter((artifact) => artifact.path === 'manifest.json');
  const rest = artifacts.filter((artifact) => artifact.path !== 'manifest.json');
  return [...rest, ...manifest];
}

async function prefixIsOccupied(client, bucket, prefix) {
  const listing = await client.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: `${prefix}/`,
    MaxKeys: 1,
  }));
  return (listing.KeyCount || 0) > 0;
}

const UPLOAD_ATTEMPTS = 5;

const sleep = (milliseconds) => new Promise((resolveSleep) => { setTimeout(resolveSleep, milliseconds); });

/** 'absent', 'match', or 'mismatch' — what the store currently holds for this key. */
async function remoteState(client, bucket, artifact) {
  let object;
  try {
    object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: artifact.object_key }));
  } catch (error) {
    const code = error?.name || error?.Code;
    if (code === 'NoSuchKey' || code === 'NotFound' || error?.$metadata?.httpStatusCode === 404) return 'absent';
    throw error;
  }
  const bytes = Buffer.from(await object.Body.transformToByteArray());
  if (bytes.byteLength !== artifact.byte_length) return 'mismatch';
  return sha256Hex(bytes) === artifact.sha256 ? 'match' : 'mismatch';
}

// One dropped connection used to abandon a single object mid-release, leaving a
// prefix that looks published but is quietly missing tiles — and the run still
// exited zero. Uploads are network work, so transient failure is expected and
// must be retried rather than tolerated. A release that cannot place every
// object now fails loudly.
async function putVerified(client, bucket, artifact) {
  let lastError = null;
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: artifact.object_key,
        Body: artifact.bytes,
        ContentType: artifact.content_type,
        CacheControl: artifact.cache_control,
        ContentLength: artifact.byte_length,
      }));
      if (await remoteState(client, bucket, artifact) === 'match') return attempt;
      lastError = new Error('stored bytes do not match the pinned SHA-256');
    } catch (error) {
      lastError = error;
    }
    if (attempt < UPLOAD_ATTEMPTS) await sleep(250 * 2 ** (attempt - 1));
  }
  throw new Error(`${artifact.object_key}: giving up after ${UPLOAD_ATTEMPTS} attempts (${lastError?.message || lastError}).`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  const releaseDir = resolve(options.releaseDir);
  const { inventory, artifacts } = await loadVerifiedInventory(releaseDir);
  const prefix = inventory.object_prefix;

  process.stdout.write(`Release   : ${inventory.release_id}\n`);
  process.stdout.write(`Prefix    : ${prefix}\n`);
  process.stdout.write(`Artifacts : ${artifacts.length} (local hashes verified)\n`);
  process.stdout.write(`Signed by : ${inventory.signing.key_id} (${inventory.signing.algorithm})\n\n`);

  if (basename(releaseDir) !== inventory.release_id) {
    process.stdout.write(`Note: directory name ${basename(releaseDir)} differs from release id ${inventory.release_id}; the inventory prefix wins.\n\n`);
  }

  if (options.dryRun) {
    for (const artifact of publishOrder(artifacts)) {
      process.stdout.write(`  would PUT ${artifact.object_key}  ${artifact.byte_length} bytes\n`);
    }
    process.stdout.write('\nDry run only. Nothing was uploaded.\n');
    return;
  }

  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    fail('R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be set in the environment.');
  }

  const client = new S3Client({
    region: options.region,
    endpoint: options.endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });

  if (await prefixIsOccupied(client, options.bucket, prefix) && !options.resume) {
    fail(`Refusing to publish: ${prefix}/ already exists in ${options.bucket}.\nReleases are immutable. Build a new release id rather than overwriting one.\nIf an earlier publish of this exact release was interrupted, re-run with --resume.`);
  }

  // --resume finishes an interrupted publish without weakening immutability:
  // an object already carrying the pinned hash is left alone, and one holding
  // anything else is a hard failure rather than something to overwrite.
  let placed = 0;
  let skipped = 0;
  for (const artifact of publishOrder(artifacts)) {
    if (options.resume) {
      const state = await remoteState(client, options.bucket, artifact);
      if (state === 'match') {
        skipped += 1;
        continue;
      }
      if (state === 'mismatch') {
        fail(`${artifact.object_key} already exists with different bytes than this release pins.\nReleases are immutable. Build a new release id rather than overwriting one.`);
      }
    }
    const attempts = await putVerified(client, options.bucket, artifact);
    placed += 1;
    process.stdout.write(`  ok ${artifact.object_key}${attempts > 1 ? ` (after ${attempts} attempts)` : ''}\n`);
  }

  process.stdout.write(`\nPublished ${artifacts.length} artifacts (${placed} uploaded, ${skipped} already present); every object re-read and hash-verified.\n`);
  process.stdout.write(`\nManifest URL for CANVAS_EVIDENCE_MANIFEST_URL:\n  <your public base>/${prefix}/manifest.json\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => fail(error?.message || String(error)));
}

export { loadVerifiedInventory, publishOrder, sha256Hex };
