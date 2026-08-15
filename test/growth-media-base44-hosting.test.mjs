import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BASE44_MEDIA_ORIGIN,
  BASE44_CLI_PACKAGE,
  BASE44_CLI_MINIMUM_NODE_VERSION,
  HOSTING_AUTHORIZATION_SCHEMA,
  HOSTING_RECEIPT_SCHEMA,
  assertBase44LauncherNodeVersion,
  base44AppIdFromMediaPathPrefix,
  base44CliInvocation,
  canonicalStringify,
  fetchAndVerifyBase44Media,
  hostGrowthMediaWithBase44,
  launchBase44Standalone,
  normalizeBase44MediaPathPrefix,
  preflightHostingAuthorization,
  sha256Bytes,
  validateBase44MediaUrl,
} from '../scripts/host-growth-media-base44.mjs';

const APP_ID = '695eb764b077190880be21de';
const MEDIA_PREFIX = `/files/public/${APP_ID}/`;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function mp4Bytes(label = 'firstknock-video') {
  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0);
  ftyp.write('ftyp', 4, 'ascii');
  ftyp.write('isom', 8, 'ascii');
  ftyp.writeUInt32BE(0x200, 12);
  ftyp.write('isom', 16, 'ascii');
  ftyp.write('iso2', 20, 'ascii');
  return Buffer.concat([ftyp, Buffer.from(label)]);
}

function nodeIo() {
  async function normalizedLstat(path) {
    try {
      const info = await lstat(path);
      return {
        isFile: info.isFile(),
        isDirectory: info.isDirectory(),
        isSymlink: info.isSymbolicLink(),
        size: info.size,
      };
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }
  async function atomicWriteText(path, text, { replace }) {
    const temporary = `${path}.next`;
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
    try {
      if (!replace && await normalizedLstat(path)) {
        throw new Error(`Refusing to overwrite ${path}`);
      }
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  return {
    lstat: normalizedLstat,
    realPath: (path) => realpath(path),
    readBytes: (path) => readFile(path),
    readText: (path) => readFile(path, 'utf8'),
    atomicWriteText,
    createExclusiveText: (path, text) => (
      writeFile(path, text, { encoding: 'utf8', flag: 'wx' })
    ),
    removeFile: (path) => rm(path),
  };
}

async function fixture(t, { artifactCount = 1 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'firstknock-base44-host-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputDir = join(root, 'render-output');
  await mkdir(join(outputDir, 'sha256'), { recursive: true });
  const batchId = `base44-host-fixture-${artifactCount}`;
  const pack = {
    schema_version: 'growth-render-pack.v1',
    batch_id: batchId,
    template: { id: 'firstknock-test', version: '1.0.0' },
    output: { mime_type: 'video/mp4' },
    sources: [],
    artifacts: [],
  };
  const rendererEnvironment = {
    profile_id: 'firstknock-h264-bitexact-v3',
    ffmpeg_version: 'fixture',
    font_sha256: 'a'.repeat(64),
  };
  const rendererEnvironmentSha256 = sha256(
    canonicalStringify(rendererEnvironment),
  );
  const artifacts = [];
  const mediaByArtifact = new Map();
  for (let index = 0; index < artifactCount; index += 1) {
    const number = String(index + 1).padStart(2, '0');
    const artifactKey = `ig-base44-proof-${number}`;
    const bytes = mp4Bytes(`firstknock-${number}`);
    const mediaSha256 = sha256(bytes);
    const filename = `${mediaSha256}-${artifactKey}.mp4`;
    const deliveryKey = `sha256/${filename}`;
    const artifact = {
      artifact_key: artifactKey,
      concept_id: `base44-proof-${number}`,
      platform: 'instagram',
      platform_content_id: artifactKey,
      distribution_state: 'publish_candidate',
      source_asset_keys: [`source-${number}`],
      source_lineage: [{
        asset_key: `source-${number}`,
        source_reference: `safe-${number}.mp4`,
        source_sha256: 'b'.repeat(64),
      }],
      template_id: 'firstknock-test',
      template_version: '1.0.0',
      render_profile_id: rendererEnvironment.profile_id,
      render_environment_sha256: rendererEnvironmentSha256,
      render_input_sha256: 'c'.repeat(64),
      delivery_key: deliveryKey,
      media_url: null,
      media_sha256: mediaSha256,
      mime_type: 'video/mp4',
      width: 1080,
      height: 1920,
      duration_ms: 8000,
      frame_rate: 30,
      video_codec: 'h264',
      pixel_format: 'yuv420p',
      audio_codec: 'aac',
      audio_sample_rate: 48000,
      audio_channels: 2,
      byte_size: bytes.byteLength,
      color_space: 'bt709',
      color_transfer: 'bt709',
      color_primaries: 'bt709',
      fast_start: true,
      thumbnail_offset_ms: 1000,
      qc: {
        source_sha256_verified: true,
        privacy_status: 'safe',
        rights_status: 'firstknock_owned',
        disclosure_burned_in: true,
        hook_first_frame: true,
        third_party_watermark: false,
        audio_mode: 'silent',
        ready_for_human_review: true,
        ready_for_content_engine_import: true,
      },
      artifact_fields: {
        artifact_key: artifactKey,
        concept_id: `base44-proof-${number}`,
        campaign: '1000-users',
        platform: 'instagram',
        platform_content_id: artifactKey,
        title: `FirstKnock proof ${number}`,
        pillar: 'route-builder',
        format: 'video',
        source_asset_keys: [`source-${number}`],
        hook: 'Build the route before the field day.',
        caption: 'FirstKnock shows the route builder.',
        overlay_text: ['Build the route'],
        shot_list: ['Show the route builder'],
        cta_label: 'Try FirstKnock',
        cta_url:
          `https://firstknock.online/start?utm_source=instagram`
          + '&utm_medium=organic_social&utm_campaign=1000-users'
          + `&utm_content=${artifactKey}`,
        disclosure: 'FIRSTKNOCK PRODUCT DEMO - NO CUSTOMER RESULT.',
        media_url: null,
        media_sha256: mediaSha256,
        mime_type: 'video/mp4',
        width: 1080,
        height: 1920,
        duration_ms: 8000,
        thumbnail_offset_ms: 1000,
        ai_generated: false,
      },
    };
    artifacts.push(artifact);
    pack.artifacts.push({
      artifact_key: artifactKey,
      distribution_state: 'publish_candidate',
    });
    mediaByArtifact.set(artifactKey, { bytes, filename, deliveryKey });
    await writeFile(join(outputDir, 'sha256', filename), bytes);
  }
  const result = {
    schema_version: 'growth-render-result.v1',
    batch_id: batchId,
    pack_sha256: sha256(canonicalStringify(pack)),
    pack,
    template: pack.template,
    renderer: {
      ...rendererEnvironment,
      environment_sha256: rendererEnvironmentSha256,
    },
    media_origin: null,
    artifact_count: artifacts.length,
    artifacts,
  };
  const resultPath = join(outputDir, `${batchId}.render-result.json`);
  const resultRaw = `${JSON.stringify(result, null, 2)}\n`;
  await writeFile(resultPath, resultRaw, 'utf8');
  const review = {
    schema_version: HOSTING_AUTHORIZATION_SCHEMA,
    review_id: `${batchId}-hosting-review`,
    review_status: 'authorized',
    authorization_scope: 'base44_hosting_only',
    batch_id: batchId,
    render_result_sha256: sha256(resultRaw),
    pack_sha256: result.pack_sha256,
    renderer_environment_sha256: rendererEnvironmentSha256,
    hosting_authorized: true,
    reviewed_at: '2026-07-29T12:00:00.000Z',
    reviewed_by: 'firstknock-test-reviewer',
    unresolved_blockers: [],
    artifacts: artifacts
      .map((artifact) => ({
        artifact_key: artifact.artifact_key,
        media_sha256: artifact.media_sha256,
      }))
      .sort((left, right) => (
        left.artifact_key.localeCompare(right.artifact_key)
      )),
  };
  const reviewPath = join(root, `${batchId}.hosting-review.json`);
  const reviewRaw = `${JSON.stringify(review, null, 2)}\n`;
  await writeFile(reviewPath, reviewRaw, 'utf8');
  return {
    root,
    outputDir,
    resultPath,
    result,
    resultRaw,
    review,
    reviewPath,
    reviewRaw,
    batchId,
    mediaByArtifact,
  };
}

function hostedUrl(filename, providerPrefix = 'a1b2c3d4e_') {
  return `${BASE44_MEDIA_ORIGIN}${MEDIA_PREFIX}${providerPrefix}${filename}`;
}

function responseFor(bytes, {
  status = 200,
  contentType = 'video/mp4',
  contentLength = bytes.byteLength,
  headers = {},
} = {}) {
  return new Response(bytes, {
    status,
    headers: {
      'content-type': contentType,
      'content-length': String(contentLength),
      ...headers,
    },
  });
}

function hostingMocks(mediaByArtifact, {
  failUploadFor = '',
  returnedUrl = null,
  remoteBytes = null,
} = {}) {
  const uploads = [];
  const fetches = [];
  const client = {
    integrations: {
      Core: {
        async UploadFile({ file }) {
          uploads.push(file);
          const artifact = [...mediaByArtifact.entries()]
            .find(([, media]) => media.filename === file.name);
          assert.ok(artifact, `unexpected upload ${file.name}`);
          const [artifactKey, media] = artifact;
          if (artifactKey === failUploadFor) {
            throw new Error('simulated upload interruption');
          }
          assert.equal(file.type, 'video/mp4');
          assert.equal(file.size, media.bytes.byteLength);
          assert.deepEqual(
            Buffer.from(await file.arrayBuffer()),
            media.bytes,
          );
          return {
            file_url: returnedUrl || hostedUrl(media.filename),
          };
        },
      },
    },
  };
  const fetchImpl = async (url, options) => {
    fetches.push({ url, options });
    const media = [...mediaByArtifact.values()]
      .find((candidate) => url.endsWith(candidate.filename));
    assert.ok(media, `unexpected remote URL ${url}`);
    return responseFor(remoteBytes || media.bytes);
  };
  return { client, fetchImpl, uploads, fetches };
}

test('Base44 path validation binds exact origin, app namespace, and filename suffix', () => {
  assert.equal(normalizeBase44MediaPathPrefix(MEDIA_PREFIX), MEDIA_PREFIX);
  assert.equal(
    normalizeBase44MediaPathPrefix(`${BASE44_MEDIA_ORIGIN}${MEDIA_PREFIX}`),
    MEDIA_PREFIX,
  );
  const filename = `${'a'.repeat(64)}-ig-proof.mp4`;
  const valid = hostedUrl(filename);
  assert.equal(validateBase44MediaUrl(valid, MEDIA_PREFIX, filename), valid);

  for (const invalid of [
    `http://media.base44.com${MEDIA_PREFIX}a1_${filename}`,
    `https://other.example${MEDIA_PREFIX}a1_${filename}`,
    `${BASE44_MEDIA_ORIGIN}/files/public/${'b'.repeat(24)}/a1_${filename}`,
    `${BASE44_MEDIA_ORIGIN}${MEDIA_PREFIX}nested/a1_${filename}`,
    `${BASE44_MEDIA_ORIGIN}${MEDIA_PREFIX}a1_${filename}?download=1`,
    `${BASE44_MEDIA_ORIGIN}${MEDIA_PREFIX}a1_${filename}.bak`,
  ]) {
    assert.throws(
      () => validateBase44MediaUrl(invalid, MEDIA_PREFIX, filename),
      /outside the configured FirstKnock path|valid URL/,
      invalid,
    );
  }
  for (const prefix of [
    '',
    '/files/public/',
    `/files/public/${APP_ID}`,
    `/files/private/${APP_ID}/`,
    `/files/public/${APP_ID}/nested/`,
  ]) {
    assert.throws(
      () => normalizeBase44MediaPathPrefix(prefix),
      /path prefix|required/,
    );
  }
});

test('cross-platform npm launcher pins the CLI and binds exec to the path-prefix app id', async () => {
  assert.equal(
    base44AppIdFromMediaPathPrefix(MEDIA_PREFIX),
    APP_ID,
  );
  assert.equal(BASE44_CLI_PACKAGE, 'base44@0.1.6');
  assert.equal(BASE44_CLI_MINIMUM_NODE_VERSION, '20.19.0');
  for (const supported of ['20.19.0', '20.19.1', '21.0.0', '23.11.0']) {
    assert.equal(assertBase44LauncherNodeVersion(supported), supported);
  }
  for (const unsupported of ['20.18.9', '19.99.99']) {
    assert.throws(
      () => assertBase44LauncherNodeVersion(unsupported),
      /base44@0\.1\.6 requires Node\.js >=20\.19\.0.*Upgrade Node\.js/,
    );
  }
  assert.throws(
    () => assertBase44LauncherNodeVersion('not-a-version'),
    /could not determine a valid Node\.js version/,
  );
  const npmExecPath = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
  const invocation = base44CliInvocation({
    npmExecPath,
    nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    operation: 'exec',
    appId: base44AppIdFromMediaPathPrefix(MEDIA_PREFIX),
  });
  assert.equal(invocation.command, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(invocation.args, [
    npmExecPath,
    'exec',
    '--yes',
    '--package=base44@0.1.6',
    '--',
    'base44',
    'exec',
    '--app-id',
    APP_ID,
  ]);
  assert.equal(
    invocation.args.includes('latest'),
    false,
    'the production launcher must never float to an unreviewed CLI version',
  );
  const packageJson = JSON.parse(
    await readFile(join(process.cwd(), 'package.json'), 'utf8'),
  );
  assert.equal(
    packageJson.scripts['host:growth-media:base44'],
    'node scripts/host-growth-media-base44.mjs --launch-base44',
  );
  assert.equal(
    packageJson.scripts['host:growth-media:base44'].includes('<'),
    false,
    'the npm command must not rely on unsupported PowerShell redirection',
  );
  assert.equal(
    packageJson.engines.node,
    '>=20.0.0',
    'the CLI-specific floor must stay in the launcher, not the whole app',
  );
});

test('rights-safe weekly hosting review binds the exact rendered batch and remains pending', async () => {
  const review = JSON.parse(
    await readFile(
      join(
        process.cwd(),
        'config',
        'growth-media',
        'firstknock-weekly-hosting-review.json',
      ),
      'utf8',
    ),
  );
  assert.equal(review.schema_version, HOSTING_AUTHORIZATION_SCHEMA);
  assert.equal(review.review_status, 'pending');
  assert.equal(review.authorization_scope, 'base44_hosting_only');
  assert.equal(review.hosting_authorized, false);
  assert.equal(review.reviewed_at, null);
  assert.equal(review.reviewed_by, null);
  assert.equal(
    review.batch_id,
    'firstknock-weekly-rights-safe-v2-2026-07',
  );
  assert.equal(
    review.render_result_sha256,
    'e3a37de4c9654e0b088021773506775cc0419fdc6e52c029c0b3cc302fbd6fff',
  );
  assert.equal(
    review.pack_sha256,
    '00e06013561a34a7fc59a7be75093c262a78f83b52d5dff0371b1fdf30bd79d0',
  );
  assert.equal(
    review.renderer_environment_sha256,
    '89e25ffdd2631e75d84dd9bbd70be8ecdfdc4c398e3f6a3fcc96b75bb1547c2f',
  );
  assert.deepEqual(review.unresolved_blockers, [
    'owner_hosting_authorization_required',
  ]);
  assert.equal(review.artifacts.length, 28);
  assert.equal(
    new Set(
      review.artifacts.map((artifact) => artifact.artifact_key),
    ).size,
    28,
  );
  assert.equal(
    review.artifacts.every(
      (artifact) => /^[a-f0-9]{64}$/.test(artifact.media_sha256),
    ),
    true,
  );
});

test('hosting authorization fence rejects absent, pending, mismatched, duplicate, and tampered reviews before contact', async (t) => {
  async function expectFenced({
    built,
    reviewPath = built.reviewPath,
    error,
  }) {
    let uploadCalls = 0;
    let fetchCalls = 0;
    await assert.rejects(
      () => hostGrowthMediaWithBase44({
        resultPath: built.resultPath,
        reviewPath,
        outputDir: built.outputDir,
        mediaPathPrefix: MEDIA_PREFIX,
        base44Client: {
          integrations: {
            Core: {
              async UploadFile() {
                uploadCalls += 1;
                throw new Error('authorization fence reached upload');
              },
            },
          },
        },
        fetchImpl: async () => {
          fetchCalls += 1;
          throw new Error('authorization fence reached fetch');
        },
        io: nodeIo(),
      }),
      error,
    );
    assert.equal(uploadCalls, 0);
    assert.equal(fetchCalls, 0);
    assert.equal(
      await readFile(
        join(
          built.outputDir,
          `${built.batchId}.base44-hosting-receipt.json`,
        ),
      ).catch((caught) => caught.code),
      'ENOENT',
    );
  }

  await t.test('absent external review', async (nested) => {
    const built = await fixture(nested);
    await expectFenced({
      built,
      reviewPath: '',
      error: /FIRSTKNOCK_HOSTING_REVIEW_FILE is required/,
    });
  });

  const cases = [
    {
      name: 'pending authorization',
      mutate(review) {
        review.review_status = 'pending';
        review.hosting_authorized = false;
        review.reviewed_at = null;
        review.reviewed_by = null;
        review.unresolved_blockers = ['complete_frame_review_pending'];
      },
      error: /pending or not authorized/,
    },
    {
      name: 'unresolved blocker',
      mutate(review) {
        review.unresolved_blockers = ['embedded_map_rights_pending'];
      },
      error: /unresolved blockers/,
    },
    {
      name: 'pack mismatch',
      mutate(review) {
        review.pack_sha256 = 'd'.repeat(64);
      },
      error: /does not match this render result/,
    },
    {
      name: 'renderer environment mismatch',
      mutate(review) {
        review.renderer_environment_sha256 = 'e'.repeat(64);
      },
      error: /does not match this render result/,
    },
    {
      name: 'artifact media SHA mismatch',
      mutate(review) {
        review.artifacts[0].media_sha256 = 'f'.repeat(64);
      },
      error: /does not bind every exact publish-candidate artifact/,
    },
    {
      name: 'duplicate artifact key',
      mutate(review) {
        review.artifacts.push({ ...review.artifacts[0] });
      },
      error: /duplicate artifact keys/,
    },
    {
      name: 'unsupported tampered field',
      mutate(review) {
        review.hosting_authorized_override = true;
      },
      error: /unsupported shape/,
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async (nested) => {
      const built = await fixture(nested);
      const changed = structuredClone(built.review);
      item.mutate(changed);
      await writeFile(
        built.reviewPath,
        `${JSON.stringify(changed, null, 2)}\n`,
      );
      await expectFenced({ built, error: item.error });
    });
  }

  await t.test('render-result tampering after review', async (nested) => {
    const built = await fixture(nested);
    built.result.artifacts[0].artifact_fields.caption += ' Tampered.';
    await writeFile(
      built.resultPath,
      `${JSON.stringify(built.result, null, 2)}\n`,
    );
    await expectFenced({
      built,
      error: /does not match this render result/,
    });
  });

  await t.test('non-deterministic review serialization', async (nested) => {
    const built = await fixture(nested);
    await writeFile(
      built.reviewPath,
      JSON.stringify(built.review),
    );
    await expectFenced({
      built,
      error: /not in deterministic serialized form/,
    });
  });
});

test('Node launcher fences every invalid review before Deno or Base44 authentication', async (t) => {
  const cases = [
    {
      name: 'absent',
      reviewPath: '',
      error: /FIRSTKNOCK_HOSTING_REVIEW_FILE is required/,
    },
    {
      name: 'false',
      mutate(review) {
        review.hosting_authorized = false;
      },
      error: /pending or not authorized/,
    },
    {
      name: 'mismatched',
      mutate(review) {
        review.pack_sha256 = 'd'.repeat(64);
      },
      error: /does not match this render result/,
    },
    {
      name: 'duplicate',
      mutate(review) {
        review.artifacts.push({ ...review.artifacts[0] });
      },
      error: /duplicate artifact keys/,
    },
    {
      name: 'tampered',
      mutate(review) {
        review.hosting_authorized_override = true;
      },
      error: /unsupported shape/,
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async (nested) => {
      const built = await fixture(nested);
      if (item.mutate) {
        const changed = structuredClone(built.review);
        item.mutate(changed);
        await writeFile(
          built.reviewPath,
          `${JSON.stringify(changed, null, 2)}\n`,
        );
      }
      let launcherCalls = 0;
      await assert.rejects(
        () => launchBase44Standalone({
          environment: {
            FIRSTKNOCK_RENDER_RESULT: built.resultPath,
            FIRSTKNOCK_HOSTING_REVIEW_FILE:
              item.reviewPath ?? built.reviewPath,
            GROWTH_MEDIA_PATH_PREFIX: MEDIA_PREFIX,
            npm_execpath: 'npm-cli.js',
          },
          io: nodeIo(),
          readFileImpl: readFile,
          spawnSyncImpl() {
            launcherCalls += 1;
            throw new Error('Deno or Base44 authentication ran before review');
          },
          spawnImpl() {
            launcherCalls += 1;
            throw new Error('Base44 exec ran before review');
          },
        }),
        item.error,
      );
      assert.equal(launcherCalls, 0);
    });
  }
});

test('Node launcher proceeds past an exact authorized review in a mocked handoff', async (t) => {
  const built = await fixture(t);
  const synchronousCalls = [];
  const asynchronousCalls = [];
  const result = await launchBase44Standalone({
    environment: {
      FIRSTKNOCK_RENDER_RESULT: built.resultPath,
      FIRSTKNOCK_HOSTING_REVIEW_FILE: built.reviewPath,
      GROWTH_MEDIA_PATH_PREFIX: MEDIA_PREFIX,
      npm_execpath: 'npm-cli.js',
    },
    io: nodeIo(),
    readFileImpl: async () => Buffer.from('mock Base44 script'),
    scriptPath: join(built.root, 'mock-host-script.mjs'),
    spawnSyncImpl(command, args) {
      synchronousCalls.push({ command, args });
      return { status: 0 };
    },
    spawnImpl(command, args) {
      asynchronousCalls.push({ command, args });
      const listeners = new Map();
      const child = {
        once(event, listener) {
          listeners.set(event, listener);
          return child;
        },
        stdin: {
          on() {
            return child.stdin;
          },
          end(source) {
            assert.deepEqual(
              Buffer.from(source),
              Buffer.from('mock Base44 script'),
            );
            queueMicrotask(() => listeners.get('exit')?.(0, null));
          },
        },
      };
      return child;
    },
  });
  assert.equal(result.status, 'base44_exec_completed');
  assert.equal(result.app_id, APP_ID);
  assert.equal(synchronousCalls.length, 2);
  assert.equal(synchronousCalls[0].command, 'deno');
  assert.equal(asynchronousCalls.length, 1);
});

test('uploader writes a new hosted result and deterministic receipt, then reruns without uploading', async (t) => {
  const built = await fixture(t, { artifactCount: 2 });
  const originalBytes = await readFile(built.resultPath);
  const authorized = await preflightHostingAuthorization({
    resultPath: built.resultPath,
    reviewPath: built.reviewPath,
    io: nodeIo(),
  });
  assert.equal(
    authorized.context.hostingAuthorizationReviewId,
    built.review.review_id,
  );
  assert.equal(authorized.context.descriptors.length, 2);
  const mocks = hostingMocks(built.mediaByArtifact);
  const options = {
    resultPath: built.resultPath,
    reviewPath: built.reviewPath,
    outputDir: built.outputDir,
    mediaPathPrefix: MEDIA_PREFIX,
    base44Client: mocks.client,
    fetchImpl: mocks.fetchImpl,
    io: nodeIo(),
  };
  const first = await hostGrowthMediaWithBase44(options);
  assert.equal(first.status, 'hosted');
  assert.equal(first.hosted_count, 2);
  assert.equal(first.uploaded_count, 2);
  assert.equal(mocks.uploads.length, 2);
  assert.deepEqual(
    mocks.uploads.map((file) => file.name),
    built.result.artifacts.map((artifact) => (
      built.mediaByArtifact.get(artifact.artifact_key).filename
    )),
  );
  assert.ok(
    mocks.fetches.every(({ options: request }) => (
      request.method === 'GET'
      && request.redirect === 'manual'
      && request.cache === 'no-store'
    )),
  );
  assert.deepEqual(await readFile(built.resultPath), originalBytes);

  const hostedRaw = await readFile(first.hosted_result_path, 'utf8');
  const hosted = JSON.parse(hostedRaw);
  assert.equal(hosted.schema_version, 'growth-render-result.v1');
  assert.equal(hosted.media_origin, BASE44_MEDIA_ORIGIN);
  for (const artifact of hosted.artifacts) {
    assert.equal(artifact.media_url, artifact.artifact_fields.media_url);
    assert.equal(
      artifact.media_url,
      hostedUrl(built.mediaByArtifact.get(artifact.artifact_key).filename),
    );
  }
  const receiptRaw = await readFile(first.receipt_path, 'utf8');
  const receipt = JSON.parse(receiptRaw);
  assert.equal(receipt.schema_version, HOSTING_RECEIPT_SCHEMA);
  assert.equal(receipt.status, 'hosted');
  assert.equal(receipt.artifacts.length, 2);
  assert.equal(
    receipt.hosting_authorization_review_id,
    built.review.review_id,
  );
  assert.equal(
    receipt.hosting_authorization_review_sha256,
    sha256(built.reviewRaw),
  );
  assert.equal(receipt.hosted_result_sha256, sha256(hostedRaw));
  const { receipt_sha256: receiptSha256, ...receiptPayload } = receipt;
  assert.equal(
    receiptSha256,
    sha256(canonicalStringify(receiptPayload)),
  );
  assert.equal(
    JSON.stringify(receipt).includes('hosted_at'),
    false,
    'the deterministic receipt must not contain wall-clock fields',
  );

  const noUploadClient = {
    integrations: {
      Core: {
        async UploadFile() {
          throw new Error('idempotent rerun attempted an upload');
        },
      },
    },
  };
  const second = await hostGrowthMediaWithBase44({
    ...options,
    base44Client: noUploadClient,
  });
  assert.equal(second.status, 'already_hosted');
  assert.equal(second.uploaded_count, 0);
  assert.equal(await readFile(first.hosted_result_path, 'utf8'), hostedRaw);
  assert.equal(await readFile(first.receipt_path, 'utf8'), receiptRaw);
  assert.deepEqual(await readFile(built.resultPath), originalBytes);
});

test('all local candidates pass byte, SHA, MIME, and delivery-key preflight before any upload', async (t) => {
  const built = await fixture(t, { artifactCount: 2 });
  const second = built.result.artifacts[1];
  const secondMedia = built.mediaByArtifact.get(second.artifact_key);
  const secondPath = join(
    built.outputDir,
    'sha256',
    secondMedia.filename,
  );
  const changed = Buffer.from(secondMedia.bytes);
  changed[changed.length - 1] ^= 0xff;
  await writeFile(secondPath, changed);
  let uploadCalls = 0;
  await assert.rejects(
    () => hostGrowthMediaWithBase44({
      resultPath: built.resultPath,
      reviewPath: built.reviewPath,
      outputDir: built.outputDir,
      mediaPathPrefix: MEDIA_PREFIX,
      base44Client: {
        integrations: {
          Core: {
            async UploadFile() {
              uploadCalls += 1;
              throw new Error('must not run');
            },
          },
        },
      },
      fetchImpl: async () => {
        throw new Error('must not fetch');
      },
      io: nodeIo(),
    }),
    /local SHA-256 does not match/,
  );
  assert.equal(uploadCalls, 0);
  assert.equal(
    await readFile(
      join(
        built.outputDir,
        `${built.batchId}.base44-hosting-receipt.json`,
      ),
      'utf8',
    ).catch((error) => error.code),
    'ENOENT',
  );
});

test('descriptor mismatches fail closed before Base44 is contacted', async (t) => {
  for (const mutation of [
    (artifact) => {
      artifact.delivery_key =
        `sha256/${artifact.media_sha256}-different-artifact.mp4`;
    },
    (artifact) => {
      artifact.mime_type = 'application/octet-stream';
    },
    (artifact) => {
      artifact.media_url = 'https://already-hosted.example/video.mp4';
    },
    (artifact) => {
      artifact.byte_size += 1;
    },
  ]) {
    await t.test(mutation.toString().slice(0, 55), async (nested) => {
      const built = await fixture(nested);
      mutation(built.result.artifacts[0]);
      await writeFile(
        built.resultPath,
        `${JSON.stringify(built.result, null, 2)}\n`,
      );
      let contacted = false;
      await assert.rejects(
        () => hostGrowthMediaWithBase44({
          resultPath: built.resultPath,
          reviewPath: built.reviewPath,
          outputDir: built.outputDir,
          mediaPathPrefix: MEDIA_PREFIX,
          base44Client: {
            integrations: {
              Core: {
                async UploadFile() {
                  contacted = true;
                },
              },
            },
          },
          fetchImpl: async () => {
            contacted = true;
          },
          io: nodeIo(),
        }),
        /invalid unhosted publish-candidate descriptor|must be unhosted|local byte size|authorization review does not match/,
      );
      assert.equal(contacted, false);
    });
  }
});

test('an invalid Base44 return URL is rejected before remote verification or output finalization', async (t) => {
  const built = await fixture(t);
  const media = [...built.mediaByArtifact.values()][0];
  const mocks = hostingMocks(built.mediaByArtifact, {
    returnedUrl:
      `https://other.example${MEDIA_PREFIX}prefix_${media.filename}`,
  });
  await assert.rejects(
    () => hostGrowthMediaWithBase44({
      resultPath: built.resultPath,
      reviewPath: built.reviewPath,
      outputDir: built.outputDir,
      mediaPathPrefix: MEDIA_PREFIX,
      base44Client: mocks.client,
      fetchImpl: mocks.fetchImpl,
      io: nodeIo(),
    }),
    /outside the configured FirstKnock path/,
  );
  assert.equal(mocks.uploads.length, 1);
  assert.equal(mocks.fetches.length, 0);
  assert.equal(
    await readFile(
      join(
        built.outputDir,
        `${built.batchId}.hosted-render-result.json`,
      ),
    ).catch((error) => error.code),
    'ENOENT',
  );
});

test('remote verification rejects redirects, MIME drift, length drift, and changed bytes', async (t) => {
  const bytes = mp4Bytes('remote-proof');
  const descriptor = {
    artifactKey: 'ig-remote-proof-01',
    filename: `${sha256(bytes)}-ig-remote-proof-01.mp4`,
    sha256: sha256(bytes),
    byteSize: bytes.byteLength,
    mimeType: 'video/mp4',
  };
  const mediaUrl = hostedUrl(descriptor.filename);
  await t.test('accepts exact remote bytes', async () => {
    const verified = await fetchAndVerifyBase44Media(
      descriptor,
      mediaUrl,
      { fetchImpl: async () => responseFor(bytes) },
    );
    assert.equal(verified.media_sha256, descriptor.sha256);
  });
  await t.test('accepts a streamed exact count when Content-Length is absent', async () => {
    const verified = await fetchAndVerifyBase44Media(
      descriptor,
      mediaUrl,
      {
        fetchImpl: async () => new Response(bytes, {
          status: 200,
          headers: { 'content-type': 'video/mp4' },
        }),
      },
    );
    assert.equal(verified.byte_size, descriptor.byteSize);
  });
  await t.test('rejects redirects', async () => {
    await assert.rejects(
      () => fetchAndVerifyBase44Media(descriptor, mediaUrl, {
        fetchImpl: async () => responseFor(bytes, { status: 302 }),
      }),
      /direct HTTP 200/,
    );
  });
  await t.test('rejects MIME drift', async () => {
    await assert.rejects(
      () => fetchAndVerifyBase44Media(descriptor, mediaUrl, {
        fetchImpl: async () => responseFor(bytes, {
          contentType: 'application/octet-stream',
        }),
      }),
      /instead of video\/mp4/,
    );
  });
  await t.test('rejects Content-Length drift', async () => {
    await assert.rejects(
      () => fetchAndVerifyBase44Media(descriptor, mediaUrl, {
        fetchImpl: async () => responseFor(bytes, {
          contentLength: bytes.byteLength + 1,
        }),
      }),
      /unexpected Content-Length/,
    );
  });
  await t.test('rejects changed bytes with the same length', async () => {
    const changed = Buffer.from(bytes);
    changed[changed.length - 1] ^= 0xff;
    await assert.rejects(
      () => fetchAndVerifyBase44Media(descriptor, mediaUrl, {
        fetchImpl: async () => responseFor(changed),
      }),
      /remote SHA-256 does not match/,
    );
  });
  await t.test('keeps the timeout active while reading the response body', async () => {
    const stalledFetch = async (_url, options) => {
      const body = new ReadableStream({
        start(controller) {
          options.signal.addEventListener('abort', () => {
            const error = new Error('remote body timed out');
            error.name = 'AbortError';
            controller.error(error);
          }, { once: true });
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(descriptor.byteSize),
        },
      });
    };
    await assert.rejects(
      Promise.race([
        fetchAndVerifyBase44Media(descriptor, mediaUrl, {
          fetchImpl: stalledFetch,
          timeoutMs: 20,
        }),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('timeout watchdog expired')), 500);
        }),
      ]),
      /could not be verified: AbortError/,
    );
  });
});

test('a verified partial receipt resumes without re-uploading its completed artifact', async (t) => {
  const built = await fixture(t, { artifactCount: 2 });
  const secondKey = built.result.artifacts[1].artifact_key;
  const interrupted = hostingMocks(built.mediaByArtifact, {
    failUploadFor: secondKey,
  });
  await assert.rejects(
    () => hostGrowthMediaWithBase44({
      resultPath: built.resultPath,
      reviewPath: built.reviewPath,
      outputDir: built.outputDir,
      mediaPathPrefix: MEDIA_PREFIX,
      base44Client: interrupted.client,
      fetchImpl: interrupted.fetchImpl,
      io: nodeIo(),
    }),
    /simulated upload interruption/,
  );
  assert.equal(interrupted.uploads.length, 2);
  const receiptPath = join(
    built.outputDir,
    `${built.batchId}.base44-hosting-receipt.json`,
  );
  const partial = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(partial.status, 'in_progress');
  assert.equal(partial.artifacts.length, 1);

  const resumed = hostingMocks(built.mediaByArtifact);
  const completed = await hostGrowthMediaWithBase44({
    resultPath: built.resultPath,
    reviewPath: built.reviewPath,
    outputDir: built.outputDir,
    mediaPathPrefix: MEDIA_PREFIX,
    base44Client: resumed.client,
    fetchImpl: resumed.fetchImpl,
    io: nodeIo(),
  });
  assert.equal(completed.status, 'hosted');
  assert.equal(completed.uploaded_count, 1);
  assert.equal(resumed.uploads.length, 1);
  assert.equal(resumed.uploads[0].name, built.mediaByArtifact.get(secondKey).filename);
  const finalReceipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(finalReceipt.status, 'hosted');
  assert.equal(finalReceipt.artifacts.length, 2);
});

test('a post-upload CDN failure resumes from its pending URL with zero additional uploads', async (t) => {
  const built = await fixture(t);
  const first = hostingMocks(built.mediaByArtifact);
  let failedVerificationCalls = 0;
  await assert.rejects(
    () => hostGrowthMediaWithBase44({
      resultPath: built.resultPath,
      reviewPath: built.reviewPath,
      outputDir: built.outputDir,
      mediaPathPrefix: MEDIA_PREFIX,
      base44Client: first.client,
      fetchImpl: async () => {
        failedVerificationCalls += 1;
        throw new Error('simulated CDN timeout after upload');
      },
      io: nodeIo(),
    }),
    /Base44 URL could not be verified: Error/,
  );
  assert.equal(first.uploads.length, 1);
  assert.equal(failedVerificationCalls, 1);

  const receiptPath = join(
    built.outputDir,
    `${built.batchId}.base44-hosting-receipt.json`,
  );
  const pendingRaw = await readFile(receiptPath, 'utf8');
  const pending = JSON.parse(pendingRaw);
  assert.equal(pending.status, 'uploaded_pending_verification');
  assert.equal(pending.hosted_result_sha256, null);
  assert.equal(pending.artifacts.length, 1);
  assert.equal(pending.artifacts[0].remote_verified, false);
  const {
    receipt_sha256: pendingReceiptSha256,
    ...pendingPayload
  } = pending;
  assert.equal(
    pendingReceiptSha256,
    sha256(canonicalStringify(pendingPayload)),
  );
  assert.equal(
    await readFile(
      join(
        built.outputDir,
        `${built.batchId}.hosted-render-result.json`,
      ),
    ).catch((error) => error.code),
    'ENOENT',
    'an unverified URL must never enter the hosted render result',
  );

  let retryUploadCalls = 0;
  const resumed = hostingMocks(built.mediaByArtifact);
  const completed = await hostGrowthMediaWithBase44({
    resultPath: built.resultPath,
    reviewPath: built.reviewPath,
    outputDir: built.outputDir,
    mediaPathPrefix: MEDIA_PREFIX,
    base44Client: {
      integrations: {
        Core: {
          async UploadFile() {
            retryUploadCalls += 1;
            throw new Error('pending URL retry attempted another upload');
          },
        },
      },
    },
    fetchImpl: resumed.fetchImpl,
    io: nodeIo(),
  });
  assert.equal(completed.status, 'recovered');
  assert.equal(completed.uploaded_count, 0);
  assert.equal(retryUploadCalls, 0);
  assert.equal(resumed.fetches.length, 1);
  const finalReceipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(finalReceipt.status, 'hosted');
  assert.equal(finalReceipt.artifacts[0].remote_verified, true);
  const hosted = JSON.parse(
    await readFile(completed.hosted_result_path, 'utf8'),
  );
  assert.equal(
    hosted.artifacts[0].media_url,
    pending.artifacts[0].media_url,
  );
});

test('a tampered pending receipt blocks verification and retry uploads', async (t) => {
  const built = await fixture(t);
  const first = hostingMocks(built.mediaByArtifact);
  await assert.rejects(
    () => hostGrowthMediaWithBase44({
      resultPath: built.resultPath,
      reviewPath: built.reviewPath,
      outputDir: built.outputDir,
      mediaPathPrefix: MEDIA_PREFIX,
      base44Client: first.client,
      fetchImpl: async () => {
        throw new Error('leave upload pending');
      },
      io: nodeIo(),
    }),
    /Base44 URL could not be verified/,
  );
  assert.equal(first.uploads.length, 1);
  const receiptPath = join(
    built.outputDir,
    `${built.batchId}.base44-hosting-receipt.json`,
  );
  const pending = JSON.parse(await readFile(receiptPath, 'utf8'));
  assert.equal(pending.status, 'uploaded_pending_verification');
  pending.artifacts[0].media_url = pending.artifacts[0].media_url.replace(
    'a1b2c3d4e_',
    'tampered_',
  );
  await writeFile(
    receiptPath,
    `${JSON.stringify(pending, null, 2)}\n`,
  );

  let uploadCalls = 0;
  let fetchCalls = 0;
  await assert.rejects(
    () => hostGrowthMediaWithBase44({
      resultPath: built.resultPath,
      reviewPath: built.reviewPath,
      outputDir: built.outputDir,
      mediaPathPrefix: MEDIA_PREFIX,
      base44Client: {
        integrations: {
          Core: {
            async UploadFile() {
              uploadCalls += 1;
            },
          },
        },
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('must not verify a tampered receipt');
      },
      io: nodeIo(),
    }),
    /receipt does not match this render result/,
  );
  assert.equal(uploadCalls, 0);
  assert.equal(fetchCalls, 0);
});

test('a tampered deterministic receipt blocks retries and causes no upload', async (t) => {
  const built = await fixture(t);
  const mocks = hostingMocks(built.mediaByArtifact);
  const options = {
    resultPath: built.resultPath,
    reviewPath: built.reviewPath,
    outputDir: built.outputDir,
    mediaPathPrefix: MEDIA_PREFIX,
    base44Client: mocks.client,
    fetchImpl: mocks.fetchImpl,
    io: nodeIo(),
  };
  const completed = await hostGrowthMediaWithBase44(options);
  const receipt = JSON.parse(await readFile(completed.receipt_path, 'utf8'));
  receipt.artifacts[0].byte_size += 1;
  await writeFile(
    completed.receipt_path,
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  let uploadCalls = 0;
  await assert.rejects(
    () => hostGrowthMediaWithBase44({
      ...options,
      base44Client: {
        integrations: {
          Core: {
            async UploadFile() {
              uploadCalls += 1;
            },
          },
        },
      },
    }),
    /receipt does not match|invalid hosting receipt entry/,
  );
  assert.equal(uploadCalls, 0);
});

test('SHA helper is Web-Crypto based and byte exact', async () => {
  const bytes = mp4Bytes('sha-proof');
  assert.equal(await sha256Bytes(bytes), sha256(bytes));
});
