import { createHash, timingSafeEqual } from 'node:crypto';

import { ServiceError } from './errors.mjs';

function canonicalize(value, path = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ServiceError(500, 'non_canonical_number', `${path} contains a non-finite number.`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  if (!value || typeof value !== 'object') throw new ServiceError(500, 'non_canonical_value', `${path} contains an unsupported value.`);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new ServiceError(500, 'undefined_value', `${path}.${key} is undefined.`);
    result[key] = canonicalize(value[key], `${path}.${key}`);
  }
  return result;
}

export function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(value) {
  return createHash('sha256').update(typeof value === 'string' ? Buffer.from(value, 'utf8') : value).digest('hex');
}

export function safeTokenEqual(actual, expected) {
  const actualDigest = createHash('sha256').update(String(actual || '')).digest();
  const expectedDigest = createHash('sha256').update(String(expected || '')).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

export async function readBoundedBytes(response, maxBytes, label = 'response') {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ServiceError(502, 'evidence_payload_too_large', `${label} exceeds its byte limit.`);
  }
  if (!response.body) throw new ServiceError(502, 'evidence_payload_missing', `${label} has no body.`);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ServiceError(502, 'evidence_payload_too_large', `${label} exceeds its byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const chunk of chunks) {
    Buffer.from(chunk).copy(bytes, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function parseJsonBytes(bytes, label = 'response') {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ServiceError(502, 'evidence_json_invalid', `${label} is not valid JSON.`);
  }
}
