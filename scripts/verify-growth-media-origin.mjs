#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RESULT_SCHEMA = 'growth-render-result.v1';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_MEDIA_BYTES = 250 * 1024 * 1024;

function fail(message) {
  const error = new Error(message);
  error.name = 'GrowthMediaOriginError';
  throw error;
}

function exactOrigin(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    fail('The render result media_origin must be an exact HTTPS origin');
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== '/'
    || url.hostname === 'localhost'
    || url.hostname.endsWith('.localhost')
  ) {
    fail('The render result media_origin must be an exact HTTPS origin');
  }
  return url.origin;
}

export function validateRemoteArtifactDescriptor(value, mediaOrigin) {
  const sha256 = String(value?.media_sha256 || '').trim().toLowerCase();
  const deliveryKey = String(value?.delivery_key || '').trim();
  const byteSize = value?.byte_size;
  let mediaUrl;
  try {
    mediaUrl = new URL(String(value?.media_url || '').trim());
  } catch {
    fail(`${value?.artifact_key || 'artifact'} has no canonical media URL`);
  }
  if (
    !SHA256_PATTERN.test(sha256)
    || !deliveryKey.startsWith(`sha256/${sha256}-`)
    || !deliveryKey.endsWith('.mp4')
    || mediaUrl.origin !== mediaOrigin
    || mediaUrl.pathname !== `/${deliveryKey}`
    || mediaUrl.search
    || mediaUrl.hash
    || mediaUrl.username
    || mediaUrl.password
    || value?.mime_type !== 'video/mp4'
    || !Number.isSafeInteger(byteSize)
    || byteSize < 1
    || byteSize > MAX_MEDIA_BYTES
  ) {
    fail(`${value?.artifact_key || 'artifact'} has an invalid content-addressed descriptor`);
  }
  return {
    artifactKey: String(value.artifact_key),
    sha256,
    mediaUrl: mediaUrl.toString(),
    byteSize,
  };
}

export async function fetchAndHash(descriptor, timeoutMs, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(descriptor.mediaUrl, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: controller.signal,
      headers: { accept: 'video/mp4' },
    });
    if (response.status !== 200 || response.type === 'opaqueredirect') {
      fail(`${descriptor.artifactKey} returned HTTP ${response.status}; direct 200 required`);
    }
    const contentType = String(response.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (contentType !== 'video/mp4') {
      fail(`${descriptor.artifactKey} returned ${contentType || 'no content type'} instead of video/mp4`);
    }
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (
      declaredLength
      && (
        declaredLength !== descriptor.byteSize
        || declaredLength > MAX_MEDIA_BYTES
      )
    ) {
      fail(`${descriptor.artifactKey} returned an unexpected Content-Length`);
    }
    if (!response.body) fail(`${descriptor.artifactKey} returned an empty response body`);
    const digest = createHash('sha256');
    const reader = response.body.getReader();
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_MEDIA_BYTES || bytes > descriptor.byteSize) {
        await reader.cancel();
        fail(`${descriptor.artifactKey} exceeded its approved byte size`);
      }
      digest.update(value);
    }
    const sha256 = digest.digest('hex');
    if (
      bytes !== descriptor.byteSize
      || sha256 !== descriptor.sha256
    ) {
      fail(`${descriptor.artifactKey} remote bytes do not match the render result`);
    }
    return { artifact_key: descriptor.artifactKey, byte_size: bytes, sha256 };
  } catch (error) {
    if (error?.name === 'GrowthMediaOriginError') throw error;
    fail(`${descriptor.artifactKey} could not be fetched: ${error?.name || 'network_error'}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyGrowthMediaOrigin({
  resultPath,
  timeoutMs = 20000,
  includePreviews = false,
} = {}) {
  if (!resultPath) fail('--result is required');
  const result = JSON.parse(await readFile(resolve(resultPath), 'utf8'));
  const mediaOrigin = exactOrigin(result?.media_origin);
  const artifacts = Array.isArray(result?.artifacts) ? result.artifacts : [];
  if (
    result?.schema_version !== RESULT_SCHEMA
    || Number(result?.artifact_count) !== artifacts.length
    || !artifacts.length
  ) {
    fail(`The result file must use ${RESULT_SCHEMA}`);
  }
  const selected = artifacts.filter((artifact) => (
    includePreviews || artifact?.distribution_state === 'publish_candidate'
  ));
  if (!selected.length) fail('The result has no selected media to verify');
  const descriptors = selected.map((artifact) => (
    validateRemoteArtifactDescriptor(artifact, mediaOrigin)
  ));
  const verified = [];
  for (const descriptor of descriptors) {
    verified.push(await fetchAndHash(descriptor, timeoutMs));
  }
  return {
    schema_version: 'growth-media-origin-verification.v1',
    media_origin: mediaOrigin,
    verified_count: verified.length,
    verified,
  };
}

function parseArgs(argv) {
  const options = {
    resultPath: process.env.FIRSTKNOCK_RENDER_RESULT || '',
    timeoutMs: 20000,
    includePreviews: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--include-previews') {
      options.includePreviews = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) fail(`${value} requires a value`);
    if (value === '--result') options.resultPath = next;
    else if (value === '--timeout-ms') {
      const timeout = Number(next);
      if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 60000) {
        fail('--timeout-ms must be an integer from 1000 through 60000');
      }
      options.timeoutMs = timeout;
    } else fail(`Unknown argument: ${value}`);
    index += 1;
  }
  return options;
}

async function main() {
  const result = await verifyGrowthMediaOrigin(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({
    status: 'verified',
    media_origin: result.media_origin,
    verified_count: result.verified_count,
  }, null, 2)}\n`);
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
