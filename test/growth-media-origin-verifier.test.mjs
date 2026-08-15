import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  exactMediaPathPrefix,
  fetchAndHash,
  validateRemoteArtifactDescriptor,
  verifyGrowthMediaOrigin,
} from '../scripts/verify-growth-media-origin.mjs';

function remoteArtifact(
  bytes = Buffer.from('verified-video'),
  {
    origin = 'https://media.firstknock.online',
    pathPrefix = '/sha256/',
    filenamePrefix = '',
  } = {},
) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const filename = `${sha256}-ig-verifier-proof-01.mp4`;
  return {
    artifact_key: 'ig-verifier-proof-01',
    media_sha256: sha256,
    delivery_key: `sha256/${filename}`,
    media_url: `${origin}${pathPrefix}${filenamePrefix}${filename}`,
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

test('media path prefix is a required canonical absolute pathname namespace', () => {
  assert.equal(
    exactMediaPathPrefix('/files/public/firstknock-app/'),
    '/files/public/firstknock-app/',
  );

  for (const prefix of [
    undefined,
    '',
    '/',
    'files/public/firstknock-app/',
    '/files/public/firstknock-app',
    'https://media.base44.com/files/public/firstknock-app/',
    '/files//firstknock-app/',
    '/files/-firstknock-app/',
    '/files/./firstknock-app/',
    '/files/../firstknock-app/',
    '/files/%66irstknock-app/',
    '/files\\public\\firstknock-app\\',
    '/files/public/firstknock-app/?download=1',
    '/files/public/firstknock-app/#media',
    `/${'a'.repeat(1024)}/`,
  ]) {
    assert.throws(
      () => exactMediaPathPrefix(prefix),
      /media path prefix/i,
      `${String(prefix)} must be rejected`,
    );
  }
});

test('descriptor accepts a Base44 direct-child filename only when its exact delivery basename is the suffix', () => {
  const mediaPathPrefix = '/files/public/firstknock-app/';
  const valid = remoteArtifact(Buffer.from('base44-video'), {
    origin: 'https://media.base44.com',
    pathPrefix: mediaPathPrefix,
    filenamePrefix: '1722199999_',
  });
  const descriptor = validateRemoteArtifactDescriptor(
    valid,
    'https://media.base44.com',
    mediaPathPrefix,
  );
  assert.equal(
    descriptor.hostedFilename,
    `1722199999_${valid.delivery_key.slice('sha256/'.length)}`,
  );
  assert.equal(descriptor.deliveryKey, valid.delivery_key);

  const invalidDescriptors = [
    {
      name: 'wrong configured namespace',
      value: {
        ...valid,
        media_url: valid.media_url.replace('/firstknock-app/', '/another-app/'),
      },
    },
    {
      name: 'nested object path',
      value: {
        ...valid,
        media_url: valid.media_url.replace(
          mediaPathPrefix,
          `${mediaPathPrefix}nested/`,
        ),
      },
    },
    {
      name: 'different delivery artifact key',
      value: {
        ...valid,
        delivery_key: valid.delivery_key.replace(
          'ig-verifier-proof-01',
          'tt-verifier-proof-01',
        ),
      },
    },
    {
      name: 'filename that does not end in the delivery basename',
      value: {
        ...valid,
        media_url: valid.media_url.replace('.mp4', '-changed.mp4'),
      },
    },
    {
      name: 'percent-encoded path',
      value: {
        ...valid,
        media_url: valid.media_url.replace('/files/', '/%66iles/'),
      },
    },
    {
      name: 'dot-segment path',
      value: {
        ...valid,
        media_url: valid.media_url.replace(
          mediaPathPrefix,
          `${mediaPathPrefix}../firstknock-app/`,
        ),
      },
    },
    {
      name: 'query string',
      value: {
        ...valid,
        media_url: `${valid.media_url}?download=1`,
      },
    },
  ];
  for (const fixture of invalidDescriptors) {
    assert.throws(
      () => validateRemoteArtifactDescriptor(
        fixture.value,
        'https://media.base44.com',
        mediaPathPrefix,
      ),
      /invalid content-addressed descriptor/,
      fixture.name,
    );
  }
});

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

test('origin verification requires the configured media namespace and reports it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'growth-origin-prefix-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('base44-origin-proof');
  const mediaPathPrefix = '/files/public/firstknock-app/';
  const artifact = {
    ...remoteArtifact(bytes, {
      origin: 'https://media.base44.com',
      pathPrefix: mediaPathPrefix,
      filenamePrefix: '1722199999_',
    }),
    distribution_state: 'publish_candidate',
  };
  const resultPath = join(root, 'render-result.json');
  await writeFile(resultPath, JSON.stringify({
    schema_version: 'growth-render-result.v1',
    media_origin: 'https://media.base44.com',
    artifact_count: 1,
    artifacts: [artifact],
  }));

  await assert.rejects(
    () => verifyGrowthMediaOrigin({
      resultPath,
      fetchImpl: async () => responseFor(bytes),
    }),
    /media path prefix/i,
  );

  const result = await verifyGrowthMediaOrigin({
    resultPath,
    mediaPathPrefix,
    timeoutMs: 1000,
    fetchImpl: async (url, options) => {
      assert.equal(url, artifact.media_url);
      assert.equal(options.redirect, 'manual');
      return responseFor(bytes);
    },
  });
  assert.equal(result.media_origin, 'https://media.base44.com');
  assert.equal(result.media_path_prefix, mediaPathPrefix);
  assert.equal(result.verified_count, 1);
  assert.deepEqual(result.verified, [{
    artifact_key: artifact.artifact_key,
    byte_size: bytes.byteLength,
    sha256: artifact.media_sha256,
  }]);
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
