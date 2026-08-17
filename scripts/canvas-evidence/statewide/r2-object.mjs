#!/usr/bin/env node
// Minimal R2 object helper for statewide build checkpointing.
// Uses the same SigV4 approach as ../source-artifacts/upload-r2.mjs.
// Usage:
//   node r2-object.mjs exists <key>       (exit 0 if present, 2 if absent)
//   node r2-object.mjs put <file> <key>   (immutable: fails if key exists with different bytes)
//   node r2-object.mjs get <key> <file>
import { createHash, createHmac } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

function fail(message) { throw new TypeError(message); }
function hmac(key, value, encoding) { return createHmac('sha256', key).update(value).digest(encoding); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function encodePath(value) { return value.split('/').map(encodeURIComponent).join('/'); }
function requiredEnv(name) { const value = process.env[name]; if (!value) fail(`${name} is required.`); return value; }

export async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function signedRequest({ method, key, payloadHash, metadataHash, contentLength, range }) {
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
  if (range) headers.range = range;
  if (metadataHash) headers['x-amz-meta-sha256'] = metadataHash;
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map((name) => `${name}:${headers[name]}\n`).join('');
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/auto/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), 'auto'), 's3'), 'aws4_request');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${hmac(signingKey, stringToSign, 'hex')}`;
  return { url: `https://${host}${canonicalUri}`, headers };
}

export async function headObject(key) {
  const request = signedRequest({ method: 'GET', key, payloadHash: EMPTY_SHA256, range: 'bytes=0-0' });
  const response = await fetch(request.url, { method: 'GET', headers: request.headers, redirect: 'manual' });
  if (response.status === 404 || response.status === 416) { await response.arrayBuffer(); return null; }
  if (response.status !== 206) fail(`R2 metadata probe failed for ${key}: HTTP ${response.status}`);
  const bytes = Number((response.headers.get('content-range') || '').match(/\/(\d+)$/)?.[1]);
  await response.arrayBuffer();
  return { bytes, sha256: response.headers.get('x-amz-meta-sha256') };
}

export async function putObject(path, key) {
  const expectedHash = await fileHash(path);
  const info = await stat(path);
  const existing = await headObject(key);
  if (existing) {
    if (existing.bytes === info.size && existing.sha256 === expectedHash) return { key, bytes: info.size, sha256: expectedHash, status: 'verified_existing' };
    fail(`Immutable R2 key already exists with different bytes: ${key}`);
  }
  const request = signedRequest({ method: 'PUT', key, payloadHash: expectedHash, metadataHash: expectedHash, contentLength: info.size });
  const response = await fetch(request.url, { method: 'PUT', headers: request.headers, body: createReadStream(path), duplex: 'half', redirect: 'manual' });
  if (!response.ok) fail(`R2 PUT failed for ${key}: HTTP ${response.status}`);
  const stored = await headObject(key);
  if (!stored || stored.bytes !== info.size || stored.sha256 !== expectedHash) fail(`R2 checksum verification failed for ${key}.`);
  return { key, bytes: info.size, sha256: expectedHash, status: 'uploaded' };
}

export async function getObject(key, path) {
  const request = signedRequest({ method: 'GET', key, payloadHash: EMPTY_SHA256 });
  const response = await fetch(request.url, { headers: request.headers, redirect: 'manual' });
  if (response.status !== 200) fail(`R2 GET failed for ${key}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
  return { key, path };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const [command, a, b] = process.argv.slice(2);
  const run = async () => {
    if (command === 'exists') {
      const found = await headObject(a);
      process.stdout.write(`${JSON.stringify({ key: a, exists: Boolean(found), ...(found || {}) })}\n`);
      if (!found) process.exitCode = 2;
      return;
    }
    if (command === 'put') { process.stdout.write(`${JSON.stringify(await putObject(a, b))}\n`); return; }
    if (command === 'get') { process.stdout.write(`${JSON.stringify(await getObject(a, b))}\n`); return; }
    fail('Usage: r2-object.mjs exists <key> | put <file> <key> | get <key> <file>');
  };
  run().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = process.exitCode || 1; });
}