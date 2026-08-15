export const CANVAS_FIELD_PACKAGE_SCHEMA = Object.freeze({
  name: 'firstknock.canvas-field-package',
  version: 1,
});

export class CanvasPackageVerificationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CanvasPackageVerificationError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new CanvasPackageVerificationError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    fail('CANVAS_PACKAGE_INVALID_MANIFEST', `${field} must be a non-empty, trimmed string.`, { field });
  }
  return value;
}

function requiredPackageVersion(value) {
  if (Number.isSafeInteger(value) && value >= 1) return String(value);
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return value;
  fail('CANVAS_PACKAGE_INVALID_MANIFEST', 'package_version must be a positive canonical integer.', { value });
}

function canonicalize(value, path = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('CANVAS_PACKAGE_NON_CANONICAL', `${path} contains a non-finite number.`, { path });
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  if (!isRecord(value)) fail('CANVAS_PACKAGE_NON_CANONICAL', `${path} contains an unsupported value.`, { path });
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) fail('CANVAS_PACKAGE_NON_CANONICAL', `${path}.${key} is undefined.`, { path: `${path}.${key}` });
    output[key] = canonicalize(value[key], `${path}.${key}`);
  }
  return output;
}

export function canonicalCanvasPackageJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function unsignedCanvasPackageManifest(manifest) {
  if (!isRecord(manifest)) fail('CANVAS_PACKAGE_INVALID_MANIFEST', 'Canvas package manifest must be an object.');
  const { signature: _signature, ...unsigned } = manifest;
  return unsigned;
}

export function canonicalCanvasManifestPayload(manifest) {
  return new TextEncoder().encode(canonicalCanvasPackageJson(unsignedCanvasPackageManifest(manifest)));
}

function decodeBase64Url(value, field) {
  const encoded = requiredString(value, field);
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)) {
    fail('CANVAS_PACKAGE_INVALID_ENCODING', `${field} must use base64url encoding.`, { field });
  }
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/u, '');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  let binary;
  try {
    binary = globalThis.atob(padded);
  } catch {
    fail('CANVAS_PACKAGE_INVALID_ENCODING', `${field} is not valid base64url.`, { field });
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToHex(bytes) {
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function normalizeBytes(value, field = 'artifact') {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof Blob !== 'undefined' && value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  fail('CANVAS_PACKAGE_INVALID_ARTIFACT', `${field} must be a string, Blob, ArrayBuffer, or typed array.`, { field });
}

function getCrypto(cryptoImpl) {
  const candidate = cryptoImpl || globalThis.crypto;
  if (!candidate?.subtle) {
    fail('CANVAS_PACKAGE_CRYPTO_UNAVAILABLE', 'This device does not provide WebCrypto required for Canvas package verification.');
  }
  return candidate;
}

function parsePem(value) {
  const compact = value
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s/g, '');
  return decodeBase64Url(compact.replace(/\+/g, '-').replace(/\//g, '_'), 'publicKey');
}

async function importEd25519PublicKey(publicKey, cryptoImpl) {
  if (publicKey?.type === 'public' && publicKey?.algorithm?.name === 'Ed25519') return publicKey;
  const cryptoApi = getCrypto(cryptoImpl);
  let format = 'raw';
  let keyData = publicKey;
  if (isRecord(publicKey) && publicKey.format) {
    format = publicKey.format;
    keyData = publicKey.keyData ?? publicKey.data ?? publicKey.key;
  }
  if (format === 'jwk') {
    if (!isRecord(keyData)) fail('CANVAS_PACKAGE_INVALID_PUBLIC_KEY', 'A JWK public key must be an object.');
    return cryptoApi.subtle.importKey('jwk', keyData, { name: 'Ed25519' }, false, ['verify']);
  }
  if (typeof keyData === 'string') {
    if (keyData.includes('BEGIN PUBLIC KEY')) {
      format = 'spki';
      keyData = parsePem(keyData);
    } else {
      keyData = decodeBase64Url(keyData, 'publicKey');
    }
  }
  const bytes = await normalizeBytes(keyData, 'publicKey');
  if (!['raw', 'spki'].includes(format)) {
    fail('CANVAS_PACKAGE_INVALID_PUBLIC_KEY', `Unsupported public-key format: ${format}.`, { format });
  }
  try {
    return await cryptoApi.subtle.importKey(format, bytes, { name: 'Ed25519' }, false, ['verify']);
  } catch (error) {
    fail('CANVAS_PACKAGE_INVALID_PUBLIC_KEY', 'Canvas package public key could not be imported.', { cause: String(error?.message || error) });
  }
}

function readInstant(value, field) {
  requiredString(value, field);
  const timestamp = new Date(value).valueOf();
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail('CANVAS_PACKAGE_INVALID_MANIFEST', `${field} must be a canonical UTC ISO-8601 instant.`, { field, value });
  }
  return timestamp;
}

function artifactDescriptor(input, index) {
  if (!isRecord(input)) fail('CANVAS_PACKAGE_INVALID_MANIFEST', `artifacts[${index}] must be an object.`);
  const kind = input.artifact_kind ?? input.kind;
  const ordinal = input.artifact_ordinal ?? input.ordinal ?? 0;
  if (kind !== undefined) requiredString(kind, `artifacts[${index}].artifact_kind`);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    fail('CANVAS_PACKAGE_INVALID_MANIFEST', `artifacts[${index}].artifact_ordinal must be a non-negative integer.`);
  }
  const artifactId = requiredString(input.artifact_id ?? input.id ?? (kind ? `${kind}:${ordinal}` : ''), `artifacts[${index}].artifact_id`);
  const sha256 = requiredString(input.sha256, `artifacts[${index}].sha256`).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    fail('CANVAS_PACKAGE_INVALID_MANIFEST', `artifacts[${index}].sha256 must be a SHA-256 hex digest.`, { artifactId });
  }
  const byteLength = input.byte_length ?? input.byte_size ?? input.bytes;
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    fail('CANVAS_PACKAGE_INVALID_MANIFEST', `artifacts[${index}].byte_length must be a non-negative integer.`, { artifactId });
  }
  return {
    ...input,
    artifact_id: artifactId,
    artifact_kind: kind,
    artifact_ordinal: ordinal,
    sha256,
    byte_length: byteLength,
    required: input.required !== false,
  };
}

function validateManifestShape(manifest, expected = {}, now = Date.now(), maxClockSkewMs = 5 * 60_000) {
  if (!isRecord(manifest)) fail('CANVAS_PACKAGE_INVALID_MANIFEST', 'Canvas package manifest must be an object.');
  if (manifest.schema !== CANVAS_FIELD_PACKAGE_SCHEMA.name || manifest.schema_version !== CANVAS_FIELD_PACKAGE_SCHEMA.version) {
    fail('CANVAS_PACKAGE_UNSUPPORTED_SCHEMA', 'Canvas package manifest schema is unsupported.', {
      schema: manifest.schema,
      schemaVersion: manifest.schema_version,
    });
  }
  const identity = {
    packageId: requiredString(manifest.package_id, 'package_id'),
    packageVersion: requiredPackageVersion(manifest.package_version),
    managerId: requiredString(manifest.manager_id, 'manager_id'),
    assignmentId: requiredString(manifest.assignment_id, 'assignment_id'),
    actorUserId: requiredString(manifest.assignee_user_id ?? manifest.actor_user_id, 'assignee_user_id'),
    campaignId: requiredString(manifest.campaign_id, 'campaign_id'),
    zoneId: requiredString(manifest.zone_id, 'zone_id'),
  };
  const expectedFields = [
    ['packageId', identity.packageId],
    ['packageVersion', identity.packageVersion],
    ['managerId', identity.managerId],
    ['assignmentId', identity.assignmentId],
    ['actorUserId', identity.actorUserId],
    ['campaignId', identity.campaignId],
    ['zoneId', identity.zoneId],
  ];
  for (const [field, actual] of expectedFields) {
    if (expected[field] !== undefined && String(expected[field]) !== actual) {
      fail('CANVAS_PACKAGE_SCOPE_MISMATCH', `Canvas package ${field} does not match the requested assignment.`, {
        field,
        expected: String(expected[field]),
        actual,
      });
    }
  }

  const issuedAt = readInstant(manifest.issued_at, 'issued_at');
  const expirationValue = manifest.valid_until ?? manifest.expires_at;
  const expiresAt = readInstant(expirationValue, 'valid_until');
  const current = typeof now === 'number' ? now : new Date(now).valueOf();
  if (!Number.isFinite(current)) fail('CANVAS_PACKAGE_INVALID_TIME', 'Verification time is invalid.');
  if (expiresAt <= issuedAt) fail('CANVAS_PACKAGE_INVALID_MANIFEST', 'valid_until must be later than issued_at.');
  if (issuedAt > current + maxClockSkewMs) {
    fail('CANVAS_PACKAGE_NOT_YET_VALID', 'Canvas package was issued too far in the future.', { issuedAt: manifest.issued_at });
  }
  if (expiresAt <= current) {
    fail('CANVAS_PACKAGE_EXPIRED', 'Canvas package has expired and must be refreshed.', { expiresAt: expirationValue });
  }

  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    fail('CANVAS_PACKAGE_INVALID_MANIFEST', 'Canvas package must list at least one artifact.');
  }
  const artifacts = manifest.artifacts.map(artifactDescriptor);
  const artifactIds = artifacts.map((artifact) => artifact.artifact_id);
  if (new Set(artifactIds).size !== artifactIds.length) {
    fail('CANVAS_PACKAGE_DUPLICATE_ARTIFACT', 'Canvas package artifact identifiers must be unique.');
  }

  if (!isRecord(manifest.dnc) || manifest.dnc.complete !== true) {
    fail('CANVAS_DNC_INCOMPLETE', 'Canvas package must include a complete DNC snapshot before field use.');
  }
  const inferredDncArtifact = artifacts.filter((artifact) => ['dnc', 'dnc_manifest'].includes(artifact.artifact_kind));
  const dncArtifactId = requiredString(
    manifest.dnc.artifact_id ?? (inferredDncArtifact.length === 1 ? inferredDncArtifact[0].artifact_id : ''),
    'dnc.artifact_id',
  );
  const dncArtifact = artifacts.find((artifact) => artifact.artifact_id === dncArtifactId);
  if (!dncArtifact || dncArtifact.required !== true || (dncArtifact.artifact_kind && !['dnc', 'dnc_manifest'].includes(dncArtifact.artifact_kind))) {
    fail('CANVAS_DNC_ARTIFACT_MISSING', 'The complete DNC snapshot must be a required package artifact.', { dncArtifactId });
  }

  if (!isRecord(manifest.signature)) fail('CANVAS_PACKAGE_SIGNATURE_MISSING', 'Canvas package signature is required.');
  if (manifest.signature.algorithm !== 'Ed25519') {
    fail('CANVAS_PACKAGE_SIGNATURE_ALGORITHM', 'Canvas package signature algorithm must be Ed25519.');
  }
  const keyId = requiredString(manifest.signature.key_id, 'signature.key_id');
  if (expected.keyId !== undefined && String(expected.keyId) !== keyId) {
    fail('CANVAS_PACKAGE_KEY_MISMATCH', 'Canvas package was not signed by the expected key.', { expected: expected.keyId, actual: keyId });
  }
  const signature = decodeBase64Url(manifest.signature.value, 'signature.value');
  if (signature.byteLength !== 64) fail('CANVAS_PACKAGE_INVALID_SIGNATURE', 'Ed25519 signatures must be 64 bytes.');

  return { identity, artifacts, dncArtifactId, issuedAt, expiresAt, keyId, signature };
}

export async function sha256CanvasArtifact(value, { cryptoImpl } = {}) {
  const cryptoApi = getCrypto(cryptoImpl);
  const bytes = await normalizeBytes(value);
  return bytesToHex(new Uint8Array(await cryptoApi.subtle.digest('SHA-256', bytes)));
}

export async function verifyCanvasPackageManifest({
  manifest,
  publicKey,
  expected = {},
  now = Date.now(),
  maxClockSkewMs,
  cryptoImpl,
} = {}) {
  const validated = validateManifestShape(manifest, expected, now, maxClockSkewMs);
  const cryptoApi = getCrypto(cryptoImpl);
  const importedKey = await importEd25519PublicKey(publicKey, cryptoApi);
  let verified = false;
  try {
    verified = await cryptoApi.subtle.verify(
      { name: 'Ed25519' },
      importedKey,
      validated.signature,
      canonicalCanvasManifestPayload(manifest),
    );
  } catch (error) {
    fail('CANVAS_PACKAGE_SIGNATURE_INVALID', 'Canvas package signature verification failed.', { cause: String(error?.message || error) });
  }
  if (!verified) fail('CANVAS_PACKAGE_SIGNATURE_INVALID', 'Canvas package signature verification failed.');
  const manifestDigest = await sha256CanvasArtifact(canonicalCanvasPackageJson(manifest), { cryptoImpl: cryptoApi });
  return Object.freeze({
    verified: true,
    dncComplete: true,
    ...validated.identity,
    issuedAt: manifest.issued_at,
    expiresAt: manifest.valid_until ?? manifest.expires_at,
    keyId: validated.keyId,
    dncArtifactId: validated.dncArtifactId,
    requiredArtifactIds: validated.artifacts.filter((artifact) => artifact.required).map((artifact) => artifact.artifact_id),
    manifestDigest,
  });
}

export async function verifyCanvasPackageArtifact({ descriptor, bytes, cryptoImpl } = {}) {
  const normalizedDescriptor = artifactDescriptor(descriptor, 0);
  const normalizedBytes = await normalizeBytes(bytes, normalizedDescriptor.artifact_id);
  if (normalizedBytes.byteLength !== normalizedDescriptor.byte_length) {
    fail('CANVAS_ARTIFACT_LENGTH_MISMATCH', 'Canvas package artifact length does not match its manifest.', {
      artifactId: normalizedDescriptor.artifact_id,
      expected: normalizedDescriptor.byte_length,
      actual: normalizedBytes.byteLength,
    });
  }
  const actualDigest = await sha256CanvasArtifact(normalizedBytes, { cryptoImpl });
  if (actualDigest !== normalizedDescriptor.sha256) {
    fail('CANVAS_ARTIFACT_HASH_MISMATCH', 'Canvas package artifact digest does not match its manifest.', {
      artifactId: normalizedDescriptor.artifact_id,
      expected: normalizedDescriptor.sha256,
      actual: actualDigest,
    });
  }
  return Object.freeze({
    verified: true,
    artifactId: normalizedDescriptor.artifact_id,
    sha256: actualDigest,
    byteLength: normalizedBytes.byteLength,
    bytes: normalizedBytes,
  });
}

function artifactBytesFromCollection(artifacts, artifactId) {
  if (artifacts instanceof Map) return artifacts.get(artifactId);
  if (Array.isArray(artifacts)) {
    const entry = artifacts.find((candidate) => (candidate?.artifactId ?? candidate?.artifact_id ?? candidate?.id) === artifactId);
    return entry?.bytes ?? entry?.data ?? entry?.content;
  }
  if (isRecord(artifacts)) return artifacts[artifactId];
  return undefined;
}

export async function verifyCanvasPackageArtifacts({ manifest, artifacts, cryptoImpl } = {}) {
  if (!isRecord(manifest) || !Array.isArray(manifest.artifacts)) {
    fail('CANVAS_PACKAGE_INVALID_MANIFEST', 'A Canvas package manifest with artifacts is required.');
  }
  if (manifest.dnc?.complete !== true) {
    fail('CANVAS_DNC_INCOMPLETE', 'Canvas package must include a complete DNC snapshot before field use.');
  }
  const verifiedArtifacts = [];
  for (const [index, rawDescriptor] of manifest.artifacts.entries()) {
    const descriptor = artifactDescriptor(rawDescriptor, index);
    if (!descriptor.required) continue;
    const bytes = artifactBytesFromCollection(artifacts, descriptor.artifact_id);
    if (bytes === undefined) {
      fail('CANVAS_ARTIFACT_MISSING', 'A required Canvas package artifact is missing.', { artifactId: descriptor.artifact_id });
    }
    verifiedArtifacts.push(await verifyCanvasPackageArtifact({ descriptor, bytes, cryptoImpl }));
  }
  const descriptors = manifest.artifacts.map(artifactDescriptor);
  const inferredDncArtifact = descriptors.filter((artifact) => ['dnc', 'dnc_manifest'].includes(artifact.artifact_kind));
  const dncArtifactId = requiredString(
    manifest.dnc.artifact_id ?? (inferredDncArtifact.length === 1 ? inferredDncArtifact[0].artifact_id : ''),
    'dnc.artifact_id',
  );
  if (!verifiedArtifacts.some((artifact) => artifact.artifactId === dncArtifactId)) {
    fail('CANVAS_DNC_ARTIFACT_MISSING', 'The complete DNC snapshot artifact is missing.');
  }
  return Object.freeze({
    verified: true,
    dncComplete: true,
    artifacts: verifiedArtifacts,
  });
}
