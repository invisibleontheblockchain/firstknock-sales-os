#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RESULT_SCHEMA = 'growth-render-result.v1';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CONTENT_TOKEN_PATTERN = /^[a-z0-9][a-z0-9._~-]{0,119}$/;
const SAFE_HOSTED_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
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

export function exactMediaPathPrefix(value) {
  const prefix = String(value || '').trim();
  if (
    !prefix
    || prefix.length > 1024
    || prefix === '/'
    || !prefix.startsWith('/')
    || !prefix.endsWith('/')
    || prefix.includes('%')
    || prefix.includes('\\')
    || prefix.includes('?')
    || prefix.includes('#')
    || prefix.includes('//')
    || !/^\/(?:[A-Za-z0-9][A-Za-z0-9._~-]*\/)+$/.test(prefix)
  ) {
    fail('The media path prefix must be a canonical absolute pathname with leading and trailing slashes');
  }
  const segments = prefix.slice(1, -1).split('/');
  if (
    !segments.length
    || segments.some((segment) => (
      !segment
      || segment === '.'
      || segment === '..'
    ))
  ) {
    fail('The media path prefix contains an unsafe path segment');
  }
  return prefix;
}

export function validateRemoteArtifactDescriptor(
  value,
  mediaOrigin,
  mediaPathPrefix = '/sha256/',
) {
  const sha256 = String(value?.media_sha256 || '').trim().toLowerCase();
  const artifactKey = String(value?.artifact_key || '').trim();
  const deliveryKey = String(value?.delivery_key || '').trim();
  const byteSize = value?.byte_size;
  const pathPrefix = exactMediaPathPrefix(mediaPathPrefix);
  const expectedFilename = `${sha256}-${artifactKey}.mp4`;
  const expectedDeliveryKey = `sha256/${expectedFilename}`;
  const rawMediaUrl = String(value?.media_url || '').trim();
  let mediaUrl;
  try {
    mediaUrl = new URL(rawMediaUrl);
  } catch {
    fail(`${artifactKey || 'artifact'} has no canonical media URL`);
  }
  const hostedFilename = mediaUrl.pathname.startsWith(pathPrefix)
    ? mediaUrl.pathname.slice(pathPrefix.length)
    : '';
  if (
    !SHA256_PATTERN.test(sha256)
    || !CONTENT_TOKEN_PATTERN.test(artifactKey)
    || deliveryKey !== expectedDeliveryKey
    || mediaUrl.protocol !== 'https:'
    || mediaUrl.origin !== mediaOrigin
    || rawMediaUrl.includes('%')
    || rawMediaUrl.includes('\\')
    || /\/\.{1,2}(?:\/|$)/.test(rawMediaUrl)
    || !hostedFilename
    || hostedFilename.includes('/')
    || !SAFE_HOSTED_FILENAME_PATTERN.test(hostedFilename)
    || !hostedFilename.endsWith(expectedFilename)
    || mediaUrl.search
    || mediaUrl.hash
    || mediaUrl.username
    || mediaUrl.password
    || value?.mime_type !== 'video/mp4'
    || !Number.isSafeInteger(byteSize)
    || byteSize < 1
    || byteSize > MAX_MEDIA_BYTES
  ) {
    fail(`${artifactKey || 'artifact'} has an invalid content-addressed descriptor`);
  }
  return {
    artifactKey,
    sha256,
    mediaUrl: mediaUrl.toString(),
    byteSize,
    deliveryKey,
    hostedFilename,
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
  mediaPathPrefix,
  timeoutMs = 20000,
  includePreviews = false,
  fetchImpl = fetch,
} = {}) {
  if (!resultPath) fail('--result is required');
  const result = JSON.parse(await readFile(resolve(resultPath), 'utf8'));
  const mediaOrigin = exactOrigin(result?.media_origin);
  const pathPrefix = exactMediaPathPrefix(mediaPathPrefix);
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
    validateRemoteArtifactDescriptor(artifact, mediaOrigin, pathPrefix)
  ));
  const verified = [];
  for (const descriptor of descriptors) {
    verified.push(await fetchAndHash(descriptor, timeoutMs, fetchImpl));
  }
  return {
    schema_version: 'growth-media-origin-verification.v1',
    media_origin: mediaOrigin,
    media_path_prefix: pathPrefix,
    verified_count: verified.length,
    verified,
  };
}

function parseArgs(argv) {
  const options = {
    resultPath: process.env.FIRSTKNOCK_RENDER_RESULT || '',
    mediaPathPrefix: process.env.GROWTH_MEDIA_PATH_PREFIX
      || process.env.FIRSTKNOCK_BASE44_MEDIA_PATH_PREFIX
      || '',
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
    else if (value === '--media-path-prefix') options.mediaPathPrefix = next;
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
    media_path_prefix: result.media_path_prefix,
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
