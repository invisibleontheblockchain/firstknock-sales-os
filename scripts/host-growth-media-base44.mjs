#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write --allow-net

/*
 * Run through Base44's authenticated standalone executor:
 *
 *   npm run host:growth-media:base44
 *
 * The Node launcher streams this same Deno-compatible source to a pinned
 * Base44 CLI. The executor supplies `globalThis.base44`. Configuration is
 * intentionally environment-only so no credential or authenticated SDK setup
 * is persisted.
 */

export const RENDER_RESULT_SCHEMA = 'growth-render-result.v1';
export const HOSTING_RECEIPT_SCHEMA =
  'growth-media-base44-hosting-receipt.v1';
export const HOSTING_AUTHORIZATION_SCHEMA =
  'growth-media-hosting-authorization.v1';
export const BASE44_MEDIA_ORIGIN = 'https://media.base44.com';
export const BASE44_CLI_PACKAGE = 'base44@0.1.6';
export const BASE44_CLI_MINIMUM_NODE_VERSION = '20.19.0';
export const MAX_MEDIA_BYTES = 250 * 1024 * 1024;

const MAX_ARTIFACTS = 100;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._~-]{0,119}$/;
const PATH_PREFIX_PATTERN =
  /^\/(?:files|videos)\/public\/[a-f0-9]{24}\/$/;
const PROVIDER_FILENAME_PREFIX_PATTERN = /^[A-Za-z0-9_-]{0,80}$/;
const VIDEO_MIME = 'video/mp4';
const HOSTING_AUTHORIZATION_SCOPE = 'base44_hosting_only';
const HOSTING_AUTHORIZATION_KEYS = Object.freeze([
  'schema_version',
  'review_id',
  'review_status',
  'authorization_scope',
  'batch_id',
  'render_result_sha256',
  'pack_sha256',
  'renderer_environment_sha256',
  'hosting_authorized',
  'reviewed_at',
  'reviewed_by',
  'unresolved_blockers',
  'artifacts',
]);
const HOSTING_AUTHORIZATION_ARTIFACT_KEYS = Object.freeze([
  'artifact_key',
  'media_sha256',
]);
const textEncoder = new TextEncoder();
const strictTextDecoder = new TextDecoder('utf-8', { fatal: true });

function fail(message) {
  const error = new Error(message);
  error.name = 'GrowthMediaBase44HostingError';
  throw error;
}

function errorMessage(error) {
  return String(error?.message || error || 'unknown error');
}

function isNotFound(error) {
  return (
    error?.name === 'NotFound'
    || error?.name === 'NotFoundError'
    || error?.code === 'ENOENT'
  );
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  fail('Expected binary file bytes');
}

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index])
  );
}

export function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }
  return `{${Object.entries(value)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => (
      left < right ? -1 : left > right ? 1 : 0
    ))
    .map(([key, nested]) => (
      `${JSON.stringify(key)}:${canonicalStringify(nested)}`
    ))
    .join(',')}}`;
}

export async function sha256Bytes(value, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle?.digest) {
    fail('Web Crypto SHA-256 support is required');
  }
  const digest = await cryptoImpl.subtle.digest('SHA-256', asBytes(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Text(value, cryptoImpl) {
  return sha256Bytes(textEncoder.encode(String(value)), cryptoImpl);
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function prettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function safeToken(value, label) {
  const token = String(value || '').trim();
  if (!TOKEN_PATTERN.test(token)) {
    fail(`${label} is not a valid content token`);
  }
  return token;
}

function safeFilename(value, label) {
  const filename = String(value || '').trim();
  if (
    !filename
    || filename === '.'
    || filename === '..'
    || filename.includes('/')
    || filename.includes('\\')
    || filename.includes('\0')
  ) {
    fail(`${label} must be an opaque filename`);
  }
  return filename;
}

function pathSeparator(root) {
  return root.includes('\\') && !root.includes('/') ? '\\' : '/';
}

function joinPath(root, ...segments) {
  const separator = pathSeparator(root);
  let joined = String(root || '').replace(/[\\/]+$/, '');
  for (const segmentValue of segments) {
    const segment = safeFilename(segmentValue, 'Path segment');
    joined = `${joined}${separator}${segment}`;
  }
  return joined;
}

function pathBasename(path) {
  const pieces = String(path || '').split(/[\\/]/);
  return pieces[pieces.length - 1] || '';
}

function comparablePath(path) {
  const normalized = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
}

function assertMp4Bytes(bytes, artifactKey) {
  if (
    bytes.byteLength < 12
    || bytes[4] !== 0x66
    || bytes[5] !== 0x74
    || bytes[6] !== 0x79
    || bytes[7] !== 0x70
  ) {
    fail(`${artifactKey} is not an MP4 file with an ftyp box`);
  }
  const firstBoxSize = (
    (
      (bytes[0] * 0x1000000)
      + (bytes[1] << 16)
      + (bytes[2] << 8)
      + bytes[3]
    ) >>> 0
  );
  if (
    firstBoxSize !== 0
    && (firstBoxSize < 12 || firstBoxSize > bytes.byteLength)
  ) {
    fail(`${artifactKey} has an invalid MP4 ftyp box size`);
  }
}

export function normalizeBase44MediaPathPrefix(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    fail(
      'GROWTH_MEDIA_PATH_PREFIX (or FIRSTKNOCK_BASE44_MEDIA_PATH_PREFIX) '
      + 'is required',
    );
  }
  let pathname = raw;
  if (raw.startsWith('https://')) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      fail('The Base44 media path prefix is invalid');
    }
    if (
      url.origin !== BASE44_MEDIA_ORIGIN
      || url.username
      || url.password
      || url.search
      || url.hash
      || url.toString() !== raw
    ) {
      fail(
        `The Base44 media path prefix URL must use exact origin ${BASE44_MEDIA_ORIGIN}`,
      );
    }
    pathname = url.pathname;
  }
  if (!PATH_PREFIX_PATTERN.test(pathname)) {
    fail(
      'The Base44 media path prefix must be an exact '
      + '/files/public/<24 lowercase hex app id>/ or '
      + '/videos/public/<24 lowercase hex app id>/ path',
    );
  }
  return pathname;
}

export function base44AppIdFromMediaPathPrefix(value) {
  const prefix = normalizeBase44MediaPathPrefix(value);
  const match = prefix.match(
    /^\/(?:files|videos)\/public\/([a-f0-9]{24})\/$/,
  );
  if (!match) {
    fail('The Base44 media path prefix has no exact app namespace');
  }
  return match[1];
}

export function base44CliInvocation({
  npmExecPath,
  nodeExecutable,
  operation,
  appId = '',
} = {}) {
  const npmCli = String(npmExecPath || '').trim();
  const node = String(nodeExecutable || '').trim();
  if (!npmCli || !node) {
    fail(
      'The npm launcher context is missing. Run this through '
      + 'npm run host:growth-media:base44.',
    );
  }
  if (!['whoami', 'exec'].includes(operation)) {
    fail('Unsupported Base44 CLI launcher operation');
  }
  const args = [
    npmCli,
    'exec',
    '--yes',
    `--package=${BASE44_CLI_PACKAGE}`,
    '--',
    'base44',
    operation,
  ];
  if (operation === 'exec') {
    if (!/^[a-f0-9]{24}$/.test(appId)) {
      fail('Base44 exec requires an exact 24-character app id');
    }
    args.push('--app-id', appId);
  }
  return { command: node, args };
}

export function assertBase44LauncherNodeVersion(value) {
  const version = String(value || '').trim();
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) {
    fail(
      `The ${BASE44_CLI_PACKAGE} launcher could not determine a valid `
      + 'Node.js version.',
    );
  }
  const actual = match.slice(1, 4).map(Number);
  const minimum = BASE44_CLI_MINIMUM_NODE_VERSION.split('.').map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return version;
    if (actual[index] < minimum[index]) {
      fail(
        `${BASE44_CLI_PACKAGE} requires Node.js `
        + `>=${BASE44_CLI_MINIMUM_NODE_VERSION} for the standalone launcher; `
        + `current Node.js is ${version}. Upgrade Node.js and rerun the npm command.`,
      );
    }
  }
  return version;
}

export function validateBase44MediaUrl(
  value,
  mediaPathPrefix,
  expectedFilename,
) {
  const prefix = normalizeBase44MediaPathPrefix(mediaPathPrefix);
  const filename = safeFilename(expectedFilename, 'Expected upload filename');
  const raw = String(value || '').trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`Base44 did not return a valid URL for ${filename}`);
  }
  const leaf = url.pathname.startsWith(prefix)
    ? url.pathname.slice(prefix.length)
    : '';
  const providerPrefix = leaf.endsWith(filename)
    ? leaf.slice(0, -filename.length)
    : '';
  if (
    !raw
    || url.toString() !== raw
    || url.origin !== BASE44_MEDIA_ORIGIN
    || url.protocol !== 'https:'
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
    || !leaf
    || leaf.includes('/')
    || leaf.includes('\\')
    || leaf.includes('%')
    || !leaf.endsWith(filename)
    || !PROVIDER_FILENAME_PREFIX_PATTERN.test(providerPrefix)
  ) {
    fail(
      `Base44 URL for ${filename} is outside the configured FirstKnock path `
      + 'or does not preserve the exact SHA-prefixed filename suffix',
    );
  }
  return url.toString();
}

function validateArtifactDescriptor(artifact) {
  const artifactKey = safeToken(artifact?.artifact_key, 'artifact_key');
  const sha256 = String(artifact?.media_sha256 || '').trim();
  const deliveryKey = String(artifact?.delivery_key || '').trim();
  const byteSize = artifact?.byte_size;
  const filename = `${sha256}-${artifactKey}.mp4`;
  const expectedDeliveryKey = `sha256/${filename}`;
  if (
    !SHA256_PATTERN.test(sha256)
    || deliveryKey !== expectedDeliveryKey
    || artifact?.mime_type !== VIDEO_MIME
    || !Number.isSafeInteger(byteSize)
    || byteSize < 12
    || byteSize > MAX_MEDIA_BYTES
    || artifact?.media_url !== null
    || artifact?.qc?.ready_for_content_engine_import !== true
    || artifact?.artifact_fields?.artifact_key !== artifactKey
    || artifact?.artifact_fields?.format !== 'video'
    || artifact?.artifact_fields?.media_url !== null
    || artifact?.artifact_fields?.media_sha256 !== sha256
    || artifact?.artifact_fields?.mime_type !== VIDEO_MIME
  ) {
    fail(`${artifactKey} has an invalid unhosted publish-candidate descriptor`);
  }
  return {
    artifactKey,
    deliveryKey,
    filename,
    sha256,
    byteSize,
    mimeType: VIDEO_MIME,
  };
}

export async function validateUnhostedRenderResult(
  result,
  sourceResultSha256,
  cryptoImpl,
) {
  const artifacts = Array.isArray(result?.artifacts) ? result.artifacts : [];
  const batchId = safeToken(result?.batch_id, 'batch_id');
  if (
    result?.schema_version !== RENDER_RESULT_SCHEMA
    || result?.media_origin !== null
    || !Number.isSafeInteger(result?.artifact_count)
    || result.artifact_count !== artifacts.length
    || artifacts.length < 1
    || artifacts.length > MAX_ARTIFACTS
    || !result?.pack
    || result.pack.schema_version !== 'growth-render-pack.v1'
    || result.pack.batch_id !== batchId
  ) {
    fail(`The input must be an unhosted ${RENDER_RESULT_SCHEMA} manifest`);
  }
  const artifactKeys = artifacts.map((artifact) => (
    safeToken(artifact?.artifact_key, 'artifact_key')
  ));
  if (new Set(artifactKeys).size !== artifactKeys.length) {
    fail('The render result contains duplicate artifact keys');
  }
  if (artifacts.some((artifact) => (
    !['publish_candidate', 'sanitized_preview_only'].includes(
      artifact?.distribution_state,
    )
    || artifact?.media_url !== null
    || artifact?.artifact_fields?.media_url !== null
  ))) {
    fail('Every artifact in the input render result must be unhosted');
  }
  const packSha256 = String(result?.pack_sha256 || '').trim();
  const computedPackSha256 = await sha256Text(
    canonicalStringify(result.pack),
    cryptoImpl,
  );
  if (
    !SHA256_PATTERN.test(packSha256)
    || packSha256 !== computedPackSha256
  ) {
    fail('The render result pack_sha256 does not match its embedded pack');
  }
  const renderer = result?.renderer;
  const rendererEnvironmentSha256 = String(
    renderer?.environment_sha256 || '',
  ).trim();
  if (!renderer || typeof renderer !== 'object' || Array.isArray(renderer)) {
    fail('The render result has no renderer environment');
  }
  const { environment_sha256: ignoredEnvironmentSha256, ...environment } =
    renderer;
  const computedEnvironmentSha256 = await sha256Text(
    canonicalStringify(environment),
    cryptoImpl,
  );
  if (
    !SHA256_PATTERN.test(rendererEnvironmentSha256)
    || rendererEnvironmentSha256 !== computedEnvironmentSha256
    || artifacts.some((artifact) => (
      artifact?.render_environment_sha256 !== rendererEnvironmentSha256
    ))
  ) {
    fail('The render result renderer environment hash is invalid');
  }
  const selected = artifacts
    .filter((artifact) => artifact.distribution_state === 'publish_candidate')
    .map(validateArtifactDescriptor);
  if (!selected.length) {
    fail('The render result has no publish_candidate artifacts');
  }
  const deliveryKeys = selected.map((descriptor) => descriptor.deliveryKey);
  if (new Set(deliveryKeys).size !== deliveryKeys.length) {
    fail('The render result contains duplicate publish-candidate delivery keys');
  }
  return {
    batchId,
    packSha256,
    rendererEnvironmentSha256,
    sourceResultSha256,
    descriptors: selected,
  };
}

function exactUtcTimestamp(value, label) {
  const timestamp = String(value || '').trim();
  if (
    !timestamp
    || Number.isNaN(Date.parse(timestamp))
    || new Date(timestamp).toISOString() !== timestamp
  ) {
    fail(`${label} must be an exact ISO-8601 UTC timestamp`);
  }
  return timestamp;
}

function boundedReviewText(value, label) {
  const text = String(value || '').trim();
  if (
    !text
    || text.length > 160
    || /[\u0000-\u001f\u007f]/.test(text)
  ) {
    fail(`${label} must contain 1-160 printable characters`);
  }
  return text;
}

export function validateHostingAuthorizationReview(review, context) {
  if (!exactKeys(review, HOSTING_AUTHORIZATION_KEYS)) {
    fail('The hosting authorization review has an unsupported shape');
  }
  const reviewId = safeToken(review.review_id, 'review_id');
  const blockers = Array.isArray(review.unresolved_blockers)
    ? review.unresolved_blockers.map((blocker, index) => (
      safeToken(blocker, `unresolved_blockers[${index}]`)
    ))
    : fail('unresolved_blockers must be an array');
  if (new Set(blockers).size !== blockers.length) {
    fail('The hosting authorization review contains duplicate blockers');
  }
  const artifacts = Array.isArray(review.artifacts)
    ? review.artifacts
    : fail('The hosting authorization review artifacts must be an array');
  const normalizedArtifacts = artifacts.map((artifact, index) => {
    if (!exactKeys(artifact, HOSTING_AUTHORIZATION_ARTIFACT_KEYS)) {
      fail(`hosting authorization artifact ${index} has an unsupported shape`);
    }
    const artifactKey = safeToken(
      artifact.artifact_key,
      `artifacts[${index}].artifact_key`,
    );
    const mediaSha256 = String(artifact.media_sha256 || '').trim();
    if (!SHA256_PATTERN.test(mediaSha256)) {
      fail(`artifacts[${index}].media_sha256 must be a complete SHA-256`);
    }
    return {
      artifact_key: artifactKey,
      media_sha256: mediaSha256,
    };
  });
  const artifactKeys = normalizedArtifacts.map(
    (artifact) => artifact.artifact_key,
  );
  if (new Set(artifactKeys).size !== artifactKeys.length) {
    fail('The hosting authorization review contains duplicate artifact keys');
  }
  const sortedArtifacts = [...normalizedArtifacts].sort((left, right) => (
    left.artifact_key < right.artifact_key
      ? -1
      : left.artifact_key > right.artifact_key
        ? 1
        : 0
  ));
  if (
    normalizedArtifacts.some((artifact, index) => (
      artifact.artifact_key !== sortedArtifacts[index].artifact_key
    ))
  ) {
    fail('The hosting authorization artifact list must be sorted by artifact_key');
  }
  const expectedArtifacts = context.descriptors
    .map((descriptor) => ({
      artifact_key: descriptor.artifactKey,
      media_sha256: descriptor.sha256,
    }))
    .sort((left, right) => (
      left.artifact_key < right.artifact_key
        ? -1
        : left.artifact_key > right.artifact_key
          ? 1
          : 0
    ));
  if (
    normalizedArtifacts.length !== expectedArtifacts.length
    || normalizedArtifacts.some((artifact, index) => (
      artifact.artifact_key !== expectedArtifacts[index].artifact_key
      || artifact.media_sha256 !== expectedArtifacts[index].media_sha256
    ))
  ) {
    fail(
      'The hosting authorization review does not bind every exact '
      + 'publish-candidate artifact and media SHA-256',
    );
  }
  if (
    review.schema_version !== HOSTING_AUTHORIZATION_SCHEMA
    || review.authorization_scope !== HOSTING_AUTHORIZATION_SCOPE
    || review.batch_id !== context.batchId
    || review.render_result_sha256 !== context.sourceResultSha256
    || review.pack_sha256 !== context.packSha256
    || review.renderer_environment_sha256
      !== context.rendererEnvironmentSha256
  ) {
    fail('The hosting authorization review does not match this render result');
  }
  if (
    review.review_status !== 'authorized'
    || review.hosting_authorized !== true
  ) {
    fail('The hosting authorization review is pending or not authorized');
  }
  if (blockers.length) {
    fail('The hosting authorization review has unresolved blockers');
  }
  const reviewedAt = exactUtcTimestamp(review.reviewed_at, 'reviewed_at');
  const reviewedBy = boundedReviewText(review.reviewed_by, 'reviewed_by');
  return {
    reviewId,
    reviewedAt,
    reviewedBy,
    artifacts: normalizedArtifacts,
  };
}

function requireIo(io) {
  const methods = [
    'lstat',
    'realPath',
    'readBytes',
    'readText',
    'atomicWriteText',
    'createExclusiveText',
    'removeFile',
  ];
  if (!io || methods.some((method) => typeof io[method] !== 'function')) {
    fail(`The filesystem adapter must provide ${methods.join(', ')}`);
  }
  return io;
}

async function regularFileInfo(path, io, label, optional = false) {
  let info;
  try {
    info = await io.lstat(path);
  } catch (error) {
    if (optional && isNotFound(error)) return null;
    fail(`${label} could not be inspected: ${errorMessage(error)}`);
  }
  if (!info) {
    if (optional) return null;
    fail(`${label} does not exist`);
  }
  if (info.isSymlink || !info.isFile) {
    fail(`${label} must be a regular, non-symlink file`);
  }
  return info;
}

async function readOptionalText(path, io, label) {
  const info = await regularFileInfo(path, io, label, true);
  if (!info) return null;
  try {
    return await io.readText(path);
  } catch (error) {
    fail(`${label} could not be read: ${errorMessage(error)}`);
  }
}

async function readRequiredUtf8(path, io, label) {
  await regularFileInfo(path, io, label);
  let bytes;
  try {
    bytes = asBytes(await io.readBytes(path));
  } catch (error) {
    if (error?.name === 'GrowthMediaBase44HostingError') throw error;
    fail(`${label} could not be read: ${errorMessage(error)}`);
  }
  let text;
  try {
    text = strictTextDecoder.decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
  return { bytes, text };
}

export async function preflightHostingAuthorization({
  resultPath,
  reviewPath,
  cryptoImpl = globalThis.crypto,
  io: suppliedIo,
} = {}) {
  const io = requireIo(suppliedIo || createDenoIo());
  if (!resultPath) fail('FIRSTKNOCK_RENDER_RESULT is required');
  if (!reviewPath) {
    fail('FIRSTKNOCK_HOSTING_REVIEW_FILE is required');
  }
  const source = await readRequiredUtf8(
    resultPath,
    io,
    'The unhosted render result',
  );
  const sourceResult = parseJson(
    source.text,
    'The unhosted render result',
  );
  const sourceResultSha256 = await sha256Bytes(
    source.bytes,
    cryptoImpl,
  );
  const context = await validateUnhostedRenderResult(
    sourceResult,
    sourceResultSha256,
    cryptoImpl,
  );
  const review = await readRequiredUtf8(
    reviewPath,
    io,
    'The hosting authorization review',
  );
  let sourceRealPath;
  let reviewRealPath;
  try {
    [sourceRealPath, reviewRealPath] = await Promise.all([
      io.realPath(resultPath),
      io.realPath(reviewPath),
    ]);
  } catch (error) {
    fail(
      'The render result or hosting authorization review could not be resolved: '
      + errorMessage(error),
    );
  }
  if (comparablePath(sourceRealPath) === comparablePath(reviewRealPath)) {
    fail('The hosting authorization review must be a separate external file');
  }
  const reviewPayload = parseJson(
    review.text,
    'The hosting authorization review',
  );
  if (review.text !== prettyJson(reviewPayload)) {
    fail(
      'The hosting authorization review is not in deterministic serialized form',
    );
  }
  const authorization = validateHostingAuthorizationReview(
    reviewPayload,
    context,
  );
  const reviewSha256 = await sha256Bytes(review.bytes, cryptoImpl);
  return {
    sourceResult,
    sourceBytes: source.bytes,
    sourceText: source.text,
    context: {
      ...context,
      hostingAuthorizationReviewId: authorization.reviewId,
      hostingAuthorizationReviewSha256: reviewSha256,
    },
    authorization,
  };
}

export async function verifyLocalArtifact(
  descriptor,
  outputRoot,
  io,
  cryptoImpl,
) {
  const expectedPath = joinPath(
    outputRoot,
    'sha256',
    descriptor.filename,
  );
  const info = await regularFileInfo(
    expectedPath,
    io,
    `${descriptor.artifactKey} local media`,
  );
  if (
    !Number.isSafeInteger(info.size)
    || info.size !== descriptor.byteSize
  ) {
    fail(`${descriptor.artifactKey} local byte size does not match the result`);
  }
  let realPath;
  try {
    realPath = await io.realPath(expectedPath);
  } catch (error) {
    fail(
      `${descriptor.artifactKey} local path could not be resolved: `
      + errorMessage(error),
    );
  }
  if (comparablePath(realPath) !== comparablePath(expectedPath)) {
    fail(`${descriptor.artifactKey} local media resolved through a symlink`);
  }
  let bytes;
  try {
    bytes = asBytes(await io.readBytes(expectedPath));
  } catch (error) {
    if (error?.name === 'GrowthMediaBase44HostingError') throw error;
    fail(`${descriptor.artifactKey} local media could not be read`);
  }
  if (bytes.byteLength !== descriptor.byteSize) {
    fail(`${descriptor.artifactKey} local bytes changed while being read`);
  }
  assertMp4Bytes(bytes, descriptor.artifactKey);
  const sha256 = await sha256Bytes(bytes, cryptoImpl);
  if (sha256 !== descriptor.sha256) {
    fail(`${descriptor.artifactKey} local SHA-256 does not match the result`);
  }
  return { bytes, path: expectedPath };
}

async function readResponseBytes(response, descriptor) {
  if (!response.body) {
    fail(`${descriptor.artifactKey} returned no response body`);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = asBytes(value);
    total += chunk.byteLength;
    if (total > descriptor.byteSize || total > MAX_MEDIA_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // The size failure remains authoritative.
      }
      fail(`${descriptor.artifactKey} remote response exceeded its byte size`);
    }
    chunks.push(chunk);
  }
  if (total !== descriptor.byteSize) {
    fail(`${descriptor.artifactKey} remote byte size does not match the result`);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

export async function fetchAndVerifyBase44Media(
  descriptor,
  mediaUrl,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = 20000,
    cryptoImpl = globalThis.crypto,
  } = {},
) {
  if (typeof fetchImpl !== 'function') {
    fail('A fetch implementation is required');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    fail('Remote verification timeout must be 1-60000 milliseconds');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(mediaUrl, {
      method: 'GET',
      redirect: 'manual',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        accept: VIDEO_MIME,
        'accept-encoding': 'identity',
      },
    });
    if (
      response?.status !== 200
      || response?.type === 'opaqueredirect'
      || response?.redirected === true
      || (response?.url && response.url !== mediaUrl)
    ) {
      fail(
        `${descriptor.artifactKey} Base44 URL must return a direct HTTP 200`,
      );
    }
    const contentType = String(
      response.headers?.get?.('content-type') || '',
    )
      .split(';')[0]
      .trim()
      .toLowerCase();
    const rawLength = String(
      response.headers?.get?.('content-length') || '',
    ).trim();
    const contentEncoding = String(
      response.headers?.get?.('content-encoding') || '',
    )
      .trim()
      .toLowerCase();
    if (contentType !== descriptor.mimeType) {
      fail(
        `${descriptor.artifactKey} Base44 URL returned `
        + `${contentType || 'no content type'} instead of ${descriptor.mimeType}`,
      );
    }
    if (
      rawLength
      && (
        !/^[1-9][0-9]*$/.test(rawLength)
        || Number(rawLength) !== descriptor.byteSize
      )
    ) {
      fail(
        `${descriptor.artifactKey} Base44 URL returned an unexpected `
        + 'Content-Length',
      );
    }
    if (contentEncoding && contentEncoding !== 'identity') {
      fail(`${descriptor.artifactKey} Base44 URL returned encoded bytes`);
    }
    const bytes = await readResponseBytes(response, descriptor);
    assertMp4Bytes(bytes, descriptor.artifactKey);
    const sha256 = await sha256Bytes(bytes, cryptoImpl);
    if (sha256 !== descriptor.sha256) {
      fail(
        `${descriptor.artifactKey} remote SHA-256 does not match the result`,
      );
    }
    return {
      artifact_key: descriptor.artifactKey,
      media_url: mediaUrl,
      media_sha256: sha256,
      byte_size: bytes.byteLength,
      mime_type: descriptor.mimeType,
    };
  } catch (error) {
    if (error?.name === 'GrowthMediaBase44HostingError') throw error;
    fail(
      `${descriptor.artifactKey} Base44 URL could not be verified: `
      + (error?.name || 'network_error'),
    );
  } finally {
    clearTimeout(timeout);
  }
}

const RECEIPT_ENTRY_KEYS = [
  'artifact_key',
  'delivery_key',
  'upload_filename',
  'media_url',
  'media_sha256',
  'byte_size',
  'mime_type',
  'remote_verified',
];

const RECEIPT_KEYS = [
  'schema_version',
  'status',
  'source_result_sha256',
  'batch_id',
  'pack_sha256',
  'hosting_authorization_review_id',
  'hosting_authorization_review_sha256',
  'media_origin',
  'media_path_prefix',
  'publish_candidate_count',
  'hosted_result_filename',
  'hosted_result_sha256',
  'artifacts',
  'receipt_sha256',
];

function receiptEntry(descriptor, mediaUrl, remoteVerified = true) {
  if (typeof remoteVerified !== 'boolean') {
    fail(`${descriptor.artifactKey} has an invalid remote verification state`);
  }
  return {
    artifact_key: descriptor.artifactKey,
    delivery_key: descriptor.deliveryKey,
    upload_filename: descriptor.filename,
    media_url: mediaUrl,
    media_sha256: descriptor.sha256,
    byte_size: descriptor.byteSize,
    mime_type: descriptor.mimeType,
    remote_verified: remoteVerified,
  };
}

async function buildReceipt(
  context,
  mediaPathPrefix,
  hostedResultFilename,
  entries,
  hostedResultSha256,
  cryptoImpl,
) {
  const hasPendingVerification = entries.some(
    (entry) => entry.remote_verified !== true,
  );
  if (hostedResultSha256 && hasPendingVerification) {
    fail('A hosted receipt cannot include an unverified Base44 URL');
  }
  const payload = {
    schema_version: HOSTING_RECEIPT_SCHEMA,
    status: hostedResultSha256
      ? 'hosted'
      : hasPendingVerification
        ? 'uploaded_pending_verification'
        : 'in_progress',
    source_result_sha256: context.sourceResultSha256,
    batch_id: context.batchId,
    pack_sha256: context.packSha256,
    hosting_authorization_review_id:
      context.hostingAuthorizationReviewId,
    hosting_authorization_review_sha256:
      context.hostingAuthorizationReviewSha256,
    media_origin: BASE44_MEDIA_ORIGIN,
    media_path_prefix: mediaPathPrefix,
    publish_candidate_count: context.descriptors.length,
    hosted_result_filename: hostedResultFilename,
    hosted_result_sha256: hostedResultSha256 || null,
    artifacts: entries,
  };
  return {
    ...payload,
    receipt_sha256: await sha256Text(
      canonicalStringify(payload),
      cryptoImpl,
    ),
  };
}

function validateReceiptEntry(entry, descriptor, mediaPathPrefix) {
  if (
    !exactKeys(entry, RECEIPT_ENTRY_KEYS)
    || entry.artifact_key !== descriptor.artifactKey
    || entry.delivery_key !== descriptor.deliveryKey
    || entry.upload_filename !== descriptor.filename
    || entry.media_sha256 !== descriptor.sha256
    || entry.byte_size !== descriptor.byteSize
    || entry.mime_type !== descriptor.mimeType
    || typeof entry.remote_verified !== 'boolean'
  ) {
    fail(`${descriptor.artifactKey} has an invalid hosting receipt entry`);
  }
  const mediaUrl = validateBase44MediaUrl(
    entry.media_url,
    mediaPathPrefix,
    descriptor.filename,
  );
  return receiptEntry(descriptor, mediaUrl, entry.remote_verified);
}

async function parseAndValidateReceipt(
  raw,
  context,
  mediaPathPrefix,
  hostedResultFilename,
  cryptoImpl,
) {
  const receipt = parseJson(raw, 'The Base44 hosting receipt');
  if (!exactKeys(receipt, RECEIPT_KEYS)) {
    fail('The Base44 hosting receipt has an unsupported shape');
  }
  const {
    receipt_sha256: receiptSha256,
    ...payload
  } = receipt;
  const computedSha256 = await sha256Text(
    canonicalStringify(payload),
    cryptoImpl,
  );
  const artifacts = Array.isArray(receipt.artifacts)
    ? receipt.artifacts
    : [];
  if (
    !SHA256_PATTERN.test(receiptSha256)
    || receiptSha256 !== computedSha256
    || receipt.schema_version !== HOSTING_RECEIPT_SCHEMA
    || ![
      'in_progress',
      'uploaded_pending_verification',
      'hosted',
    ].includes(receipt.status)
    || receipt.source_result_sha256 !== context.sourceResultSha256
    || receipt.batch_id !== context.batchId
    || receipt.pack_sha256 !== context.packSha256
    || receipt.hosting_authorization_review_id
      !== context.hostingAuthorizationReviewId
    || receipt.hosting_authorization_review_sha256
      !== context.hostingAuthorizationReviewSha256
    || receipt.media_origin !== BASE44_MEDIA_ORIGIN
    || receipt.media_path_prefix !== mediaPathPrefix
    || receipt.publish_candidate_count !== context.descriptors.length
    || receipt.hosted_result_filename !== hostedResultFilename
    || artifacts.length > context.descriptors.length
    || (
      receipt.status === 'hosted'
      && (
        artifacts.length !== context.descriptors.length
        || !SHA256_PATTERN.test(receipt.hosted_result_sha256)
        || artifacts.some((entry) => entry?.remote_verified !== true)
      )
    )
    || (
      receipt.status === 'in_progress'
      && (
        receipt.hosted_result_sha256 !== null
        || artifacts.some((entry) => entry?.remote_verified !== true)
      )
    )
    || (
      receipt.status === 'uploaded_pending_verification'
      && (
        receipt.hosted_result_sha256 !== null
        || artifacts.length < 1
        || artifacts.at(-1)?.remote_verified !== false
        || artifacts
          .slice(0, -1)
          .some((entry) => entry?.remote_verified !== true)
      )
    )
  ) {
    fail('The Base44 hosting receipt does not match this render result');
  }
  const entries = artifacts.map((entry, index) => (
    validateReceiptEntry(
      entry,
      context.descriptors[index],
      mediaPathPrefix,
    )
  ));
  if (raw !== prettyJson(receipt)) {
    fail('The Base44 hosting receipt is not in deterministic serialized form');
  }
  return { receipt, entries };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildHostedResult(sourceResult, context, entries) {
  if (
    entries.length !== context.descriptors.length
    || entries.some((entry) => entry.remote_verified !== true)
  ) {
    fail('Cannot build a hosted result before every candidate is verified');
  }
  const hosted = cloneJson(sourceResult);
  const urlByArtifact = new Map(
    entries.map((entry) => [entry.artifact_key, entry.media_url]),
  );
  hosted.media_origin = BASE44_MEDIA_ORIGIN;
  for (const artifact of hosted.artifacts) {
    if (artifact.distribution_state !== 'publish_candidate') continue;
    const mediaUrl = urlByArtifact.get(artifact.artifact_key);
    if (!mediaUrl) {
      fail(`${artifact.artifact_key} has no verified hosted URL`);
    }
    artifact.media_url = mediaUrl;
    artifact.artifact_fields.media_url = mediaUrl;
  }
  return hosted;
}

function entriesFromHostedResult(
  hosted,
  sourceResult,
  context,
  mediaPathPrefix,
) {
  if (
    hosted?.schema_version !== RENDER_RESULT_SCHEMA
    || hosted?.batch_id !== context.batchId
    || hosted?.pack_sha256 !== context.packSha256
    || hosted?.media_origin !== BASE44_MEDIA_ORIGIN
    || !Array.isArray(hosted?.artifacts)
    || hosted.artifacts.length !== sourceResult.artifacts.length
  ) {
    fail('The existing hosted result does not match the unhosted input');
  }
  const hostedByKey = new Map(
    hosted.artifacts.map((artifact) => [artifact?.artifact_key, artifact]),
  );
  if (hostedByKey.size !== hosted.artifacts.length) {
    fail('The existing hosted result contains duplicate artifact keys');
  }
  const entries = context.descriptors.map((descriptor) => {
    const artifact = hostedByKey.get(descriptor.artifactKey);
    if (
      artifact?.artifact_fields?.media_url !== artifact?.media_url
      || artifact?.media_sha256 !== descriptor.sha256
      || artifact?.byte_size !== descriptor.byteSize
      || artifact?.mime_type !== descriptor.mimeType
      || artifact?.delivery_key !== descriptor.deliveryKey
    ) {
      fail(
        `${descriptor.artifactKey} existing hosted descriptor is invalid`,
      );
    }
    const mediaUrl = validateBase44MediaUrl(
      artifact.media_url,
      mediaPathPrefix,
      descriptor.filename,
    );
    return receiptEntry(descriptor, mediaUrl);
  });
  const expected = prettyJson(
    buildHostedResult(sourceResult, context, entries),
  );
  if (prettyJson(hosted) !== expected) {
    fail(
      'The existing hosted result changes fields other than the approved '
      + 'Base44 media URLs',
    );
  }
  return entries;
}

function assertMatchingEntryPrefixes(receiptEntries, hostedEntries) {
  for (let index = 0; index < receiptEntries.length; index += 1) {
    if (
      canonicalStringify(receiptEntries[index])
      !== canonicalStringify(hostedEntries[index])
    ) {
      fail('The hosted result and hosting receipt disagree');
    }
  }
}

function defaultFileFactory(bytes, filename, mimeType) {
  if (typeof globalThis.File !== 'function') {
    fail('The Base44 standalone runtime must provide the File Web API');
  }
  return new File([bytes], filename, {
    type: mimeType,
    lastModified: 0,
  });
}

function validateUploadFileObject(file, descriptor) {
  if (
    !file
    || file.name !== descriptor.filename
    || file.type !== descriptor.mimeType
    || file.size !== descriptor.byteSize
  ) {
    fail(
      `${descriptor.artifactKey} upload File did not preserve its exact `
      + 'name, MIME, and byte size',
    );
  }
}

async function uploadArtifact(
  descriptor,
  local,
  {
    base44Client,
    fileFactory,
    mediaPathPrefix,
  },
) {
  const uploadFile = base44Client?.integrations?.Core?.UploadFile;
  if (typeof uploadFile !== 'function') {
    fail(
      'Base44 standalone exec did not provide '
      + 'base44.integrations.Core.UploadFile',
    );
  }
  const file = fileFactory(
    local.bytes,
    descriptor.filename,
    descriptor.mimeType,
  );
  validateUploadFileObject(file, descriptor);
  let upload;
  try {
    upload = await uploadFile.call(
      base44Client.integrations.Core,
      { file },
    );
  } catch (error) {
    fail(
      `${descriptor.artifactKey} Base44 upload failed: ${errorMessage(error)}`,
    );
  }
  if (
    !upload
    || typeof upload !== 'object'
    || Array.isArray(upload)
    || typeof upload.file_url !== 'string'
  ) {
    fail(
      `${descriptor.artifactKey} Base44 UploadFile returned no file_url`,
    );
  }
  const mediaUrl = validateBase44MediaUrl(
    upload.file_url,
    mediaPathPrefix,
    descriptor.filename,
  );
  return receiptEntry(descriptor, mediaUrl, false);
}

function validateOutputDirectoryInfo(info) {
  if (!info || info.isSymlink || !info.isDirectory) {
    fail('The local render output must be an existing non-symlink directory');
  }
}

export async function hostGrowthMediaWithBase44({
  resultPath,
  reviewPath,
  outputDir,
  mediaPathPrefix,
  timeoutMs = 20000,
  base44Client = globalThis.base44,
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
  fileFactory = defaultFileFactory,
  io: suppliedIo,
} = {}) {
  const io = requireIo(suppliedIo || createDenoIo());
  if (!resultPath) fail('FIRSTKNOCK_RENDER_RESULT is required');
  if (!reviewPath) fail('FIRSTKNOCK_HOSTING_REVIEW_FILE is required');
  if (!outputDir) fail('FIRSTKNOCK_RENDER_OUTPUT is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    fail('FIRSTKNOCK_BASE44_HOST_TIMEOUT_MS must be 1-60000');
  }
  const normalizedPrefix = normalizeBase44MediaPathPrefix(mediaPathPrefix);
  const {
    sourceResult,
    context,
  } = await preflightHostingAuthorization({
    resultPath,
    reviewPath,
    cryptoImpl,
    io,
  });
  let outputInfo;
  try {
    outputInfo = await io.lstat(outputDir);
  } catch (error) {
    fail(`The local render output could not be inspected: ${errorMessage(error)}`);
  }
  validateOutputDirectoryInfo(outputInfo);
  let outputRoot;
  try {
    outputRoot = await io.realPath(outputDir);
  } catch (error) {
    fail(`The local render output could not be resolved: ${errorMessage(error)}`);
  }
  const hostedResultFilename =
    `${context.batchId}.hosted-render-result.json`;
  const receiptFilename =
    `${context.batchId}.base44-hosting-receipt.json`;
  const lockFilename = `${context.batchId}.base44-hosting.lock`;
  const hostedResultPath = joinPath(outputRoot, hostedResultFilename);
  const receiptPath = joinPath(outputRoot, receiptFilename);
  const lockPath = joinPath(outputRoot, lockFilename);
  const sourceRealPath = await io.realPath(resultPath);
  const reviewRealPath = await io.realPath(reviewPath);
  if (
    comparablePath(sourceRealPath) === comparablePath(hostedResultPath)
    || comparablePath(sourceRealPath) === comparablePath(receiptPath)
    || comparablePath(reviewRealPath) === comparablePath(hostedResultPath)
    || comparablePath(reviewRealPath) === comparablePath(receiptPath)
  ) {
    fail(
      'The hosted outputs cannot overwrite the unhosted render result '
      + 'or hosting authorization review',
    );
  }

  // Complete the entire local preflight before making the first external write.
  for (const descriptor of context.descriptors) {
    await verifyLocalArtifact(descriptor, outputRoot, io, cryptoImpl);
  }

  let lockAcquired = false;
  try {
    await io.createExclusiveText(
      lockPath,
      prettyJson({
        schema_version: 'growth-media-base44-hosting-lock.v1',
        source_result_sha256: context.sourceResultSha256,
        hosting_authorization_review_sha256:
          context.hostingAuthorizationReviewSha256,
      }),
    );
    lockAcquired = true;
  } catch (error) {
    if (isNotFound(error)) throw error;
    fail(
      'A Base44 hosting lock already exists or could not be created. '
      + 'Confirm no uploader is running before removing the .lock file.',
    );
  }

  try {
    const existingReceiptRaw = await readOptionalText(
      receiptPath,
      io,
      'The Base44 hosting receipt',
    );
    const existingHostedRaw = await readOptionalText(
      hostedResultPath,
      io,
      'The hosted render result',
    );
    let receiptState = null;
    let entries = [];
    if (existingReceiptRaw !== null) {
      receiptState = await parseAndValidateReceipt(
        existingReceiptRaw,
        context,
        normalizedPrefix,
        hostedResultFilename,
        cryptoImpl,
      );
      entries = receiptState.entries;
    }

    if (existingHostedRaw !== null) {
      const hosted = parseJson(existingHostedRaw, 'The hosted render result');
      const hostedEntries = entriesFromHostedResult(
        hosted,
        sourceResult,
        context,
        normalizedPrefix,
      );
      assertMatchingEntryPrefixes(entries, hostedEntries);
      entries = hostedEntries;
      const expectedHostedRaw = prettyJson(
        buildHostedResult(sourceResult, context, entries),
      );
      if (existingHostedRaw !== expectedHostedRaw) {
        fail('The hosted render result is not in deterministic serialized form');
      }
    }

    let receiptExists = existingReceiptRaw !== null;

    // Re-verify every checkpointed URL before trusting it or resuming. A URL
    // checkpointed immediately after UploadFile is promoted only after its
    // exact remote bytes pass verification.
    let resumedPendingVerification = false;
    for (let index = 0; index < entries.length; index += 1) {
      await fetchAndVerifyBase44Media(
        context.descriptors[index],
        entries[index].media_url,
        { fetchImpl, timeoutMs, cryptoImpl },
      );
      if (entries[index].remote_verified === false) {
        entries[index] = receiptEntry(
          context.descriptors[index],
          entries[index].media_url,
          true,
        );
        resumedPendingVerification = true;
      }
    }
    if (resumedPendingVerification) {
      const verifiedCheckpoint = await buildReceipt(
        context,
        normalizedPrefix,
        hostedResultFilename,
        entries,
        null,
        cryptoImpl,
      );
      await io.atomicWriteText(
        receiptPath,
        prettyJson(verifiedCheckpoint),
        { replace: receiptExists },
      );
      receiptExists = true;
    }

    let hostedExists = existingHostedRaw !== null;
    let uploadedCount = 0;
    for (
      let index = entries.length;
      index < context.descriptors.length;
      index += 1
    ) {
      const descriptor = context.descriptors[index];
      const local = await verifyLocalArtifact(
        descriptor,
        outputRoot,
        io,
        cryptoImpl,
      );
      const entry = await uploadArtifact(descriptor, local, {
        base44Client,
        fileFactory,
        mediaPathPrefix: normalizedPrefix,
      });
      entries.push(entry);
      uploadedCount += 1;
      const uploadedCheckpoint = await buildReceipt(
        context,
        normalizedPrefix,
        hostedResultFilename,
        entries,
        null,
        cryptoImpl,
      );
      await io.atomicWriteText(
        receiptPath,
        prettyJson(uploadedCheckpoint),
        { replace: receiptExists },
      );
      receiptExists = true;
      await fetchAndVerifyBase44Media(
        descriptor,
        entry.media_url,
        { fetchImpl, timeoutMs, cryptoImpl },
      );
      entries[index] = receiptEntry(descriptor, entry.media_url, true);
      const verifiedCheckpoint = await buildReceipt(
        context,
        normalizedPrefix,
        hostedResultFilename,
        entries,
        null,
        cryptoImpl,
      );
      await io.atomicWriteText(
        receiptPath,
        prettyJson(verifiedCheckpoint),
        { replace: true },
      );
    }

    const hostedResult = buildHostedResult(sourceResult, context, entries);
    const hostedResultRaw = prettyJson(hostedResult);
    const hostedResultSha256 = await sha256Text(
      hostedResultRaw,
      cryptoImpl,
    );
    if (!hostedExists) {
      await io.atomicWriteText(
        hostedResultPath,
        hostedResultRaw,
        { replace: false },
      );
      hostedExists = true;
    } else if (existingHostedRaw !== hostedResultRaw) {
      fail('The existing hosted result does not match verified hosted URLs');
    }
    const finalReceipt = await buildReceipt(
      context,
      normalizedPrefix,
      hostedResultFilename,
      entries,
      hostedResultSha256,
      cryptoImpl,
    );
    const finalReceiptRaw = prettyJson(finalReceipt);
    if (existingReceiptRaw !== finalReceiptRaw) {
      await io.atomicWriteText(
        receiptPath,
        finalReceiptRaw,
        { replace: receiptExists },
      );
    }
    return {
      status: uploadedCount
        ? 'hosted'
        : existingReceiptRaw === finalReceiptRaw && existingHostedRaw
          ? 'already_hosted'
          : 'recovered',
      batch_id: context.batchId,
      hosting_authorization_review_id:
        context.hostingAuthorizationReviewId,
      hosting_authorization_review_sha256:
        context.hostingAuthorizationReviewSha256,
      media_origin: BASE44_MEDIA_ORIGIN,
      media_path_prefix: normalizedPrefix,
      hosted_count: entries.length,
      uploaded_count: uploadedCount,
      hosted_result_path: hostedResultPath,
      receipt_path: receiptPath,
      hosted_result_sha256: hostedResultSha256,
      receipt_sha256: finalReceipt.receipt_sha256,
    };
  } finally {
    if (lockAcquired) {
      try {
        await io.removeFile(lockPath);
      } catch (error) {
        fail(
          'Hosting finished but the operation lock could not be removed: '
          + errorMessage(error),
        );
      }
    }
  }
}

export function createNodeIo(nodeFs) {
  if (
    !nodeFs?.lstat
    || !nodeFs?.realpath
    || !nodeFs?.readFile
    || !nodeFs?.writeFile
    || !nodeFs?.rename
    || !nodeFs?.rm
  ) {
    fail('The Node.js filesystem adapter is incomplete');
  }
  async function lstat(path) {
    try {
      const info = await nodeFs.lstat(path);
      return {
        isFile: info.isFile(),
        isDirectory: info.isDirectory(),
        isSymlink: info.isSymbolicLink(),
        size: info.size,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
  async function atomicWriteText(path, text, { replace }) {
    const temporary = `${path}.next`;
    await nodeFs.writeFile(
      temporary,
      text,
      { encoding: 'utf8', flag: 'wx' },
    );
    try {
      if (!replace && await lstat(path)) {
        fail(`Refusing to overwrite existing output ${path}`);
      }
      await nodeFs.rename(temporary, path);
    } catch (error) {
      await nodeFs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
  return {
    lstat,
    realPath: (path) => nodeFs.realpath(path),
    readBytes: (path) => nodeFs.readFile(path),
    readText: (path) => nodeFs.readFile(path, 'utf8'),
    atomicWriteText,
    createExclusiveText: (path, text) => (
      nodeFs.writeFile(path, text, { encoding: 'utf8', flag: 'wx' })
    ),
    removeFile: (path) => nodeFs.rm(path),
  };
}

export function createDenoIo(deno = globalThis.Deno) {
  if (!deno?.readFile || !deno?.lstat || !deno?.writeTextFile) {
    fail(
      'This command must run through Base44 standalone exec in its Deno runtime',
    );
  }
  async function lstat(path) {
    try {
      const info = await deno.lstat(path);
      return {
        isFile: info.isFile,
        isDirectory: info.isDirectory,
        isSymlink: info.isSymlink,
        size: info.size,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
  async function atomicWriteText(path, text, { replace }) {
    const temporary = `${path}.next`;
    try {
      await deno.writeTextFile(temporary, text, { createNew: true });
      if (!replace) {
        const existing = await lstat(path);
        if (existing) fail(`Refusing to overwrite existing output ${path}`);
      }
      await deno.rename(temporary, path);
    } catch (error) {
      try {
        await deno.remove(temporary);
      } catch {
        // Preserve the authoritative write failure.
      }
      throw error;
    }
  }
  return {
    lstat,
    realPath: (path) => deno.realPath(path),
    readBytes: (path) => deno.readFile(path),
    readText: (path) => deno.readTextFile(path),
    atomicWriteText,
    createExclusiveText: (path, text) => (
      deno.writeTextFile(path, text, { createNew: true })
    ),
    removeFile: (path) => deno.remove(path),
  };
}

function parseTimeout(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return 20000;
  }
  const timeoutMs = Number(value);
  if (
    !Number.isInteger(timeoutMs)
    || timeoutMs < 1000
    || timeoutMs > 60000
  ) {
    fail('FIRSTKNOCK_BASE44_HOST_TIMEOUT_MS must be 1000-60000');
  }
  return timeoutMs;
}

export function optionsFromEnvironment(deno = globalThis.Deno) {
  if (!deno?.env?.get) {
    fail('Base44 standalone Deno environment access is required');
  }
  return {
    resultPath: deno.env.get('FIRSTKNOCK_RENDER_RESULT') || '',
    reviewPath: deno.env.get('FIRSTKNOCK_HOSTING_REVIEW_FILE') || '',
    outputDir: deno.env.get('FIRSTKNOCK_RENDER_OUTPUT') || '',
    mediaPathPrefix:
      deno.env.get('GROWTH_MEDIA_PATH_PREFIX')
      || deno.env.get('FIRSTKNOCK_BASE44_MEDIA_PATH_PREFIX')
      || '',
    timeoutMs: parseTimeout(
      deno.env.get('FIRSTKNOCK_BASE44_HOST_TIMEOUT_MS'),
    ),
  };
}

export async function launchBase44Standalone({
  environment = globalThis.process?.env,
  nodeExecutable = globalThis.process?.execPath,
  argv = globalThis.process?.argv,
  io: suppliedIo,
  spawnImpl,
  spawnSyncImpl,
  readFileImpl,
  scriptPath: suppliedScriptPath,
} = {}) {
  if (!globalThis.process?.versions?.node) {
    fail('The Base44 launcher must start in Node.js');
  }
  assertBase44LauncherNodeVersion(globalThis.process.versions.node);
  const env = environment || {};
  let io = suppliedIo;
  let readFile = readFileImpl;
  if (!io || typeof readFile !== 'function') {
    const nodeFs = await import('node:fs/promises');
    if (!io) io = createNodeIo(nodeFs);
    if (typeof readFile !== 'function') readFile = nodeFs.readFile;
  }
  await preflightHostingAuthorization({
    resultPath: env.FIRSTKNOCK_RENDER_RESULT || '',
    reviewPath: env.FIRSTKNOCK_HOSTING_REVIEW_FILE || '',
    io,
  });
  const prefix = normalizeBase44MediaPathPrefix(
    env.GROWTH_MEDIA_PATH_PREFIX
    || env.FIRSTKNOCK_BASE44_MEDIA_PATH_PREFIX
    || '',
  );
  const appId = base44AppIdFromMediaPathPrefix(prefix);
  const npmExecPath = String(env.npm_execpath || '').trim();
  let spawn = spawnImpl;
  let spawnSync = spawnSyncImpl;
  if (typeof spawn !== 'function' || typeof spawnSync !== 'function') {
    const childProcess = await import('node:child_process');
    if (typeof spawn !== 'function') spawn = childProcess.spawn;
    if (typeof spawnSync !== 'function') spawnSync = childProcess.spawnSync;
  }
  const denoCheck = spawnSync('deno', ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'pipe',
  });
  if (denoCheck.error?.code === 'ENOENT' || denoCheck.status !== 0) {
    fail(
      'Deno is required by Base44 standalone exec but was not found. '
      + 'Install Deno, restart the terminal, and rerun the npm command.',
    );
  }
  const whoami = base44CliInvocation({
    npmExecPath,
    nodeExecutable,
    operation: 'whoami',
  });
  const authCheck = spawnSync(whoami.command, whoami.args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: 'pipe',
    env,
  });
  if (authCheck.error || authCheck.status !== 0) {
    fail(
      `Base44 CLI authentication is required for ${BASE44_CLI_PACKAGE}. `
      + `Run "npx --yes ${BASE44_CLI_PACKAGE} login" and retry.`
    );
  }
  let scriptPath = suppliedScriptPath;
  if (!scriptPath) {
    const { fileURLToPath } = await import('node:url');
    scriptPath = fileURLToPath(import.meta.url);
  }
  const source = await readFile(scriptPath);
  const invocation = base44CliInvocation({
    npmExecPath,
    nodeExecutable,
    operation: 'exec',
    appId,
  });
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(invocation.command, invocation.args, {
      windowsHide: true,
      stdio: ['pipe', 'inherit', 'inherit'],
      env,
    });
    let settled = false;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    child.once('error', (error) => {
      rejectOnce(new Error(`Base44 CLI could not start: ${errorMessage(error)}`));
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(
          `Base44 exec failed for app ${appId} `
          + `(exit ${String(code)}, signal ${String(signal || 'none')})`,
        ));
      }
    });
    child.stdin.on('error', (error) => {
      if (error?.code !== 'EPIPE') rejectOnce(error);
    });
    child.stdin.end(source);
  });
  return {
    status: 'base44_exec_completed',
    app_id: appId,
    cli_package: BASE44_CLI_PACKAGE,
    launcher_argv: Array.isArray(argv) ? argv.slice(2) : [],
  };
}

async function main() {
  const result = await hostGrowthMediaWithBase44(optionsFromEnvironment());
  console.log(JSON.stringify(result, null, 2));
}

const nodeLauncherMode = (
  Boolean(globalThis.process?.versions?.node)
  && globalThis.process.argv?.includes('--launch-base44')
);

if (nodeLauncherMode) {
  try {
    await launchBase44Standalone();
  } catch (error) {
    console.error(errorMessage(error));
    globalThis.process.exitCode = 1;
  }
} else if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(errorMessage(error));
    globalThis.Deno?.exit?.(1);
  }
}
