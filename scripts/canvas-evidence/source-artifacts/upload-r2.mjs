#!/usr/bin/env node
import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySourceManifest } from './verify-source-manifest.mjs';

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

function fail(message) { throw new TypeError(message); }
function hmac(key, value, encoding) { return createHmac('sha256', key).update(value).digest(encoding); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function encodePath(value) { return value.split('/').map(encodeURIComponent).join('/'); }
function requiredEnv(name) { const value = process.env[name]; if (!value) fail(`${name} is required.`); return value; }

async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function signedRequest({ method, key, payloadHash, metadataHash, contentLength, contentType, cacheControl, range }) {
  const accountId = requiredEnv('CANVAS_R2_ACCOUNT_ID');
  const accessKeyId = requiredEnv('CANVAS_R2_ACCESS_KEY_ID');
  const secretAccessKey = requiredEnv('CANVAS_R2_SECRET_ACCESS_KEY');
  const bucket = requiredEnv('CANVAS_R2_BUCKET');
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const canonicalUri = `/${encodePath(bucket)}/${encodePath(key)}`;
  const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (contentLength !== undefined) headers['content-length'] = String(contentLength);
  if (contentType) headers['content-type'] = contentType;
  if (cacheControl) headers['cache-control'] = cacheControl;
  if (range) headers.range = range;
  if (metadataHash) headers['x-amz-meta-sha256'] = metadataHash;
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map((name) => `${name}:${headers[name]}\n`).join('');
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/auto/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const dateKey = hmac(`AWS4${secretAccessKey}`, date);
  const regionKey = hmac(dateKey, 'auto');
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${hmac(signingKey, stringToSign, 'hex')}`;
  return { url: `https://${host}${canonicalUri}`, headers };
}

async function headObject(key) {
  const range = 'bytes=0-0';
  const request = signedRequest({ method: 'GET', key, payloadHash: EMPTY_SHA256, range });
  const response = await fetch(request.url, { method: 'GET', headers: request.headers, redirect: 'manual' });
  if (response.status === 404) return null;
  if (response.status !== 206) fail(`R2 metadata probe failed for ${key}: HTTP ${response.status}`);
  const contentRange = response.headers.get('content-range') || '';
  const bytes = Number(contentRange.match(/\/(\d+)$/)?.[1]);
  await response.arrayBuffer();
  if (!Number.isSafeInteger(bytes) || bytes < 1) fail(`R2 metadata probe returned an invalid object length for ${key}.`);
  return {
    bytes,
    sha256: response.headers.get('x-amz-meta-sha256'),
    contentType: response.headers.get('content-type'),
    cacheControl: response.headers.get('cache-control'),
  };
}

async function putImmutable(path, key, expectedHash, { contentType, cacheControl } = {}) {
  const info = await stat(path);
  const matches = (object) => object
    && object.bytes === info.size
    && object.sha256 === expectedHash
    && (!contentType || object.contentType === contentType)
    && (!cacheControl || object.cacheControl === cacheControl);
  const existing = await headObject(key);
  if (existing) {
    if (!matches(existing)) fail(`Immutable R2 key already exists with different bytes or metadata: ${key}`);
    return { key, bytes: info.size, sha256: expectedHash, status: 'verified_existing' };
  }
  const request = signedRequest({ method: 'PUT', key, payloadHash: expectedHash, metadataHash: expectedHash, contentLength: info.size, contentType, cacheControl });
  const response = await fetch(request.url, { method: 'PUT', headers: request.headers, body: createReadStream(path), duplex: 'half', redirect: 'manual' });
  if (!response.ok) fail(`R2 PUT failed for ${key}: HTTP ${response.status}`);
  const stored = await headObject(key);
  if (!matches(stored)) fail(`R2 checksum or metadata verification failed for ${key}.`);
  return { key, bytes: info.size, sha256: expectedHash, status: 'uploaded' };
}

export async function uploadCanvasArtifacts({ sourceManifestPath, sourceRoot, releaseRoot, registryPaths = [] }) {
  await verifySourceManifest(sourceManifestPath, sourceRoot);
  const manifest = JSON.parse(await readFile(resolve(sourceManifestPath), 'utf8'));
  const uploaded = [];
  for (const source of manifest.sources) {
    const path = source.repository_path ? resolve(source.repository_path) : resolve(sourceRoot, source.relative_path);
    uploaded.push(await putImmutable(path, source.artifact_key, source.sha256));
  }
  for (const path of registryPaths) {
    const resolved = resolve(path);
    uploaded.push(await putImmutable(resolved, `${manifest.artifact_prefix}registry/${basename(resolved)}`, await fileHash(resolved)));
  }
  const releaseDirectory = resolve(releaseRoot);
  const inventory = JSON.parse(await readFile(join(releaseDirectory, 'upload-inventory.json'), 'utf8'));
  for (const artifact of inventory.artifacts) {
    const path = join(releaseDirectory, artifact.path);
    const actualHash = await fileHash(path);
    const info = await stat(path);
    if (actualHash !== artifact.sha256 || info.size !== artifact.byte_length) fail(`Release inventory mismatch for ${artifact.path}.`);
    uploaded.push(await putImmutable(path, artifact.object_key, artifact.sha256, {
      contentType: artifact.content_type,
      cacheControl: artifact.cache_control,
    }));
  }
  for (const name of ['upload-inventory.json', 'SHA256SUMS']) {
    const path = join(releaseDirectory, name);
    uploaded.push(await putImmutable(path, `${inventory.object_prefix}/${name}`, await fileHash(path)));
  }
  return { source_count: manifest.sources.length, release_id: inventory.release_id, object_count: uploaded.length, uploaded };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const [sourceManifestPath, sourceRoot, releaseRoot, ...registryPaths] = process.argv.slice(2);
  if (!sourceManifestPath || !sourceRoot || !releaseRoot) fail('Usage: upload-r2.mjs <source-manifest> <source-root> <release-root> [registry-file ...]');
  uploadCanvasArtifacts({ sourceManifestPath, sourceRoot, releaseRoot, registryPaths })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => { process.stderr.write(`Canvas R2 upload failed: ${error.message}\n`); process.exitCode = 1; });
}