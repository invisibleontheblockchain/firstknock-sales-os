import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  fetchAndHash,
  validateRemoteArtifactDescriptor,
} from '../scripts/verify-growth-media-origin.mjs';

function remoteArtifact(bytes = Buffer.from('verified-video')) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    artifact_key: 'ig-verifier-proof-01',
    media_sha256: sha256,
    delivery_key: `sha256/${sha256}-ig-verifier-proof-01.mp4`,
    media_url:
      `https://media.firstknock.online/sha256/${sha256}-ig-verifier-proof-01.mp4`,
    mime_type: 'video/mp4',
    byte_size: bytes.byteLength,
  };
}

function responseFor(bytes, {
  status = 200,
  contentType = 'video/mp4',
  contentLength = bytes.byteLength,
} = {}) {
  return new Response(bytes, {
    status,
    headers: {
      'content-type': contentType,
      'content-length': String(contentLength),
    },
  });
}

test('descriptor requires a finite positive integer byte_size', () => {
  const valid = remoteArtifact();
  assert.equal(
    validateRemoteArtifactDescriptor(
      valid,
      'https://media.firstknock.online',
    ).byteSize,
    valid.byte_size,
  );

  for (const byteSize of [
    undefined,
    null,
    '14',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0,
    -1,
    1.5,
  ]) {
    assert.throws(
      () => validateRemoteArtifactDescriptor(
        { ...valid, byte_size: byteSize },
        'https://media.firstknock.online',
      ),
      /invalid content-addressed descriptor/,
      `byte_size ${String(byteSize)} must be rejected`,
    );
  }
});

test('fetchAndHash preserves direct response, MIME, byte count, and SHA checks', async (t) => {
  const bytes = Buffer.from('verified-video');
  const descriptor = validateRemoteArtifactDescriptor(
    remoteArtifact(bytes),
    'https://media.firstknock.online',
  );

  await t.test('accepts exact hosted bytes', async () => {
    const result = await fetchAndHash(
      descriptor,
      1000,
      async () => responseFor(bytes),
    );
    assert.deepEqual(result, {
      artifact_key: descriptor.artifactKey,
      byte_size: bytes.byteLength,
      sha256: descriptor.sha256,
    });
  });

  await t.test('rejects a redirect response', async () => {
    await assert.rejects(
      () => fetchAndHash(
        descriptor,
        1000,
        async () => responseFor(bytes, { status: 302 }),
      ),
      /direct 200 required/,
    );
  });

  await t.test('rejects a non-video MIME type', async () => {
    await assert.rejects(
      () => fetchAndHash(
        descriptor,
        1000,
        async () => responseFor(bytes, { contentType: 'text/plain' }),
      ),
      /instead of video\/mp4/,
    );
  });

  await t.test('rejects bytes that do not match the approved hash', async () => {
    const changed = Buffer.from('changed-video!');
    assert.equal(changed.byteLength, bytes.byteLength);
    await assert.rejects(
      () => fetchAndHash(
        descriptor,
        1000,
        async () => responseFor(changed),
      ),
      /remote bytes do not match the render result/,
    );
  });
});

test('fetch timeout stays active while the response body is being read', async () => {
  const bytes = Buffer.from('x');
  const descriptor = validateRemoteArtifactDescriptor(
    remoteArtifact(bytes),
    'https://media.firstknock.online',
  );
  let headersReturned = false;
  const stalledFetch = async (_url, options) => {
    const stream = new ReadableStream({
      start(controller) {
        options.signal.addEventListener('abort', () => {
          const error = new Error('The media body timed out.');
          error.name = 'AbortError';
          controller.error(error);
        }, { once: true });
      },
    });
    headersReturned = true;
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'video/mp4',
        'content-length': String(bytes.byteLength),
      },
    });
  };

  await assert.rejects(
    Promise.race([
      fetchAndHash(descriptor, 30, stalledFetch),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('verifier watchdog expired')), 500);
      }),
    ]),
    /could not be fetched: AbortError/,
  );
  assert.equal(headersReturned, true);
});
