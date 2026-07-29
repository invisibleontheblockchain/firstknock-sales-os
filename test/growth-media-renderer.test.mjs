import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  DETERMINISTIC_FFMPEG_CODEC_ARGS,
  DETERMINISTIC_FFMPEG_GLOBAL_ARGS,
  buildRenderedArtifactFields,
  canonicalStringify as rendererCanonicalStringify,
  renderPack,
  snapshotVerifiedSource,
  validatePack,
} from '../scripts/render-growth-pack.mjs';
import { validateRemoteArtifactDescriptor } from '../scripts/verify-growth-media-origin.mjs';
import { FIRSTKNOCK_AUDITED_SOURCES } from '../src/data/firstKnockAuditedSources.js';

const PACK_PATH = resolve(
  'config',
  'growth-media',
  'firstknock-safe-starter.json',
);
const VIDEO_PILOT_PACK_PATH = resolve(
  'config',
  'growth-media',
  'firstknock-video-pilot-seed.json',
);
const VIDEO_PILOT_REVIEW_PATH = resolve(
  'config',
  'growth-media',
  'firstknock-video-pilot-review.json',
);

async function starterPack() {
  return JSON.parse(await readFile(PACK_PATH, 'utf8'));
}

async function videoPilotPack() {
  return JSON.parse(await readFile(VIDEO_PILOT_PACK_PATH, 'utf8'));
}

function clone(value) {
  return structuredClone(value);
}

test('starter render pack provides ten importable renditions plus two fenced video previews', async () => {
  const pack = validatePack(await starterPack());
  assert.equal(pack.sources.length, 6);
  assert.equal(pack.artifacts.length, 12);
  assert.equal(
    pack.artifacts.filter((item) => item.distribution_state === 'publish_candidate').length,
    10,
  );
  assert.equal(
    pack.artifacts.filter((item) => item.distribution_state === 'sanitized_preview_only').length,
    2,
  );
  assert.deepEqual(
    [...new Set(pack.artifacts.map((item) => item.platform))].sort(),
    ['instagram', 'tiktok'],
  );
  for (const source of pack.sources.filter((item) => item.privacy_status === 'safe')) {
    assert.match(source.source_sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(pack.artifacts.every((item) => item.ai_generated === undefined), true);
  assert.deepEqual(
    validatePack(structuredClone(pack)),
    pack,
    'a normalized trusted pack must remain valid renderer input',
  );
  assert.equal(
    createHash('sha256')
      .update(rendererCanonicalStringify(pack))
      .digest('hex'),
    '144fa73c2d35cf850dacd84c16c7ace14e8e02bb6cd50495f3a915ab89e36a59',
  );
});

test('reviewed video pilot provides seven safe paired feature donors', async () => {
  const pack = validatePack(await videoPilotPack());
  const review = JSON.parse(
    await readFile(VIDEO_PILOT_REVIEW_PATH, 'utf8'),
  );
  const packSha256 = createHash('sha256')
    .update(rendererCanonicalStringify(pack))
    .digest('hex');
  assert.equal(pack.sources.length, 7);
  assert.equal(pack.artifacts.length, 14);
  assert.equal(
    pack.sources.every((source) => (
      source.media_kind === 'video'
      && source.mime_type === 'video/mp4'
      && source.codec === 'h264'
      && source.privacy_status === 'safe'
      && source.rights_status === 'firstknock_owned'
    )),
    true,
  );
  assert.equal(
    pack.artifacts.every((artifact) => (
      artifact.format === 'video'
      && artifact.distribution_state === 'publish_candidate'
      && artifact.render.duration_ms <= artifact.render.trim_end_ms
    )),
    true,
  );
  const platformsByConcept = new Map();
  for (const artifact of pack.artifacts) {
    if (!platformsByConcept.has(artifact.concept_id)) {
      platformsByConcept.set(artifact.concept_id, []);
    }
    platformsByConcept.get(artifact.concept_id).push(artifact.platform);
  }
  assert.equal(platformsByConcept.size, 7);
  for (const platforms of platformsByConcept.values()) {
    assert.deepEqual(platforms.sort(), ['instagram', 'tiktok']);
  }
  assert.equal(review.approved_count, 7);
  assert.equal(review.rejected_count, 1);
  assert.equal(review.publication_authorized, false);
  assert.equal(review.trusted_seed_pack.canonical_sha256, packSha256);
  assert.equal(
    packSha256,
    '6234aa57662eaec2b8ad46279d1f37ee3a855686fbd083347dfa2b4a101e6d81',
  );
  const approvedByKey = new Map(
    review.decisions
      .filter((decision) => decision.decision === 'approved_as_safe_donor')
      .map((decision) => [decision.asset_key, decision]),
  );
  assert.deepEqual(
    pack.sources.map((source) => source.asset_key).sort(),
    [...approvedByKey.keys()].sort(),
  );
  for (const source of pack.sources) {
    const decision = approvedByKey.get(source.asset_key);
    assert.equal(decision.source_reference, source.source_reference);
    assert.equal(decision.source_sha256, source.source_sha256);
    assert.equal(decision.duration_ms, source.duration_ms);
  }
  assert.equal(
    review.decisions.some((decision) => (
      decision.asset_key === 'video-pilot-refresh-area-safe-v1'
      && decision.decision === 'rejected'
      && decision.privacy_status === 'blocked'
    )),
    true,
  );
});

test('renderer preserves exact AI provenance and rejects truthy substitutes', async () => {
  const raw = await starterPack();
  raw.artifacts[0].ai_generated = true;
  const pack = validatePack(raw);
  const artifact = pack.artifacts[0];
  assert.equal(artifact.ai_generated, true);

  const artifactFields = buildRenderedArtifactFields({
    artifact,
    technical: {
      mime_type: 'video/mp4',
      width: 1080,
      height: 1920,
      duration_ms: 8000,
    },
    mediaUrl: 'https://media.firstknock.online/sha256/example.mp4',
    mediaSha256: 'a'.repeat(64),
    thumbnailOffsetMs: 1000,
  });
  assert.equal(artifactFields.ai_generated, true);

  const manualArtifact = validatePack(await starterPack()).artifacts[0];
  assert.equal(buildRenderedArtifactFields({
    artifact: manualArtifact,
    technical: {
      mime_type: 'video/mp4',
      width: 1080,
      height: 1920,
      duration_ms: 8000,
    },
    mediaUrl: null,
    mediaSha256: 'b'.repeat(64),
    thumbnailOffsetMs: 1000,
  }).ai_generated, false);

  for (const invalid of ['true', 1, null]) {
    const invalidPack = await starterPack();
    invalidPack.artifacts[0].ai_generated = invalid;
    assert.throws(
      () => validatePack(invalidPack),
      /ai_generated must be a boolean/,
    );
  }
});

test('growth content batches are bounded service-only provenance records', async () => {
  const schema = JSON.parse(
    await readFile(resolve('base44', 'entities', 'GrowthContentBatch.jsonc'), 'utf8'),
  );
  assert.equal(schema.name, 'GrowthContentBatch');
  for (const operation of ['create', 'read', 'update', 'delete']) {
    assert.equal(
      schema.rls[operation].user_condition.id,
      '__service_role_only__',
    );
  }
  assert.deepEqual(schema.properties.state.enum, [
    'generating',
    'ready',
    'render_authorized',
    'failed',
    'superseded',
    'revoked',
  ]);
  assert.deepEqual(schema.properties.concept_count.enum, [2, 3]);
  assert.deepEqual(schema.properties.content_profile.enum, [
    'measured-next-batch-v1',
    'feature_explainer_video_v1',
  ]);
  assert.deepEqual(schema.properties.slot_count.enum, [2, 3]);
  assert.equal(schema.properties.slot_keys.maxItems, 3);
  assert.equal(schema.properties.source_lineage.maxItems, 3);
  assert.equal(schema.properties.seed_lineage.maxItems, 3);
  assert.equal(schema.properties.canonical_pack_json.maxLength, 100000);
  for (const hashField of [
    'batch_key',
    'request_hash',
    'review_hash',
    'evidence_hash',
    'prompt_source_sha256',
    'generated_hooks_sha256',
    'seed_pack_sha256',
    'canonical_pack_sha256',
  ]) {
    assert.equal(
      schema.properties[hashField].pattern,
      '^[a-f0-9]{64}$',
      `${hashField} must store a complete canonical SHA-256`,
    );
  }
  assert.equal(
    Object.keys(schema.properties).some(
      (field) => /(api.?key|worker.?secret|buffer.?token)/i.test(field),
    ),
    false,
  );
});

test('safe dashboard registry stays hash-aligned with the render pack', async () => {
  const packs = [
    validatePack(await starterPack()),
    validatePack(await videoPilotPack()),
  ];
  const safePackSources = new Map(
    packs.flatMap((pack) => pack.sources)
      .filter((source) => source.privacy_status === 'safe')
      .map((source) => [source.asset_key, source.source_sha256]),
  );
  assert.equal(safePackSources.size, FIRSTKNOCK_AUDITED_SOURCES.length);
  for (const source of FIRSTKNOCK_AUDITED_SOURCES) {
    assert.equal(safePackSources.get(source.asset_key), source.source_sha256);
  }
});

test('visible disclosure contract rejects demo labels that would be truncated away', async () => {
  const raw = await starterPack();
  raw.artifacts[0].disclosure =
    'Customer-safe illustrative material with a long preface that pushes demo beyond the visible line';
  assert.throws(
    () => validatePack(raw),
    /fit completely in the visible demo-label line/,
  );
});

test('FFmpeg contract pins bit-exact filter, video, and audio threading', () => {
  assert.deepEqual(DETERMINISTIC_FFMPEG_GLOBAL_ARGS, [
    '-fflags',
    '+bitexact',
    '-filter_threads',
    '1',
    '-filter_complex_threads',
    '1',
  ]);
  assert.deepEqual(DETERMINISTIC_FFMPEG_CODEC_ARGS, [
    '-threads:v',
    '1',
    '-threads:a',
    '1',
    '-flags:v',
    '+bitexact',
    '-flags:a',
    '+bitexact',
  ]);
});

test('renderer snapshots and re-verifies source bytes before FFmpeg can reopen them', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'firstknock-source-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, 'source.png');
  const expectedBytes = Buffer.from('verified-source');
  await writeFile(sourcePath, expectedBytes);
  const source = {
    source_reference: 'source.png',
    source_sha256: createHash('sha256').update(expectedBytes).digest('hex'),
  };
  const stagedPath = await snapshotVerifiedSource({
    sourcePath,
    source,
    workDir: root,
  });
  await writeFile(sourcePath, 'mutated-after-snapshot');
  assert.deepEqual(await readFile(stagedPath), expectedBytes);

  await assert.rejects(
    () => snapshotVerifiedSource({
      sourcePath,
      source,
      workDir: root,
    }),
    /changed before rendering/,
  );
});

test('redaction-required source can only create an exact-recipe preview', async () => {
  const raw = await starterPack();
  const videoArtifact = raw.artifacts.find(
    (item) => item.source_asset_key === 'analytics-date-picker-demo',
  );
  videoArtifact.distribution_state = 'publish_candidate';
  assert.throws(
    () => validatePack(raw),
    /immutable source bounds/,
  );

  const missingRecipe = await starterPack();
  delete missingRecipe.artifacts.find(
    (item) => item.source_asset_key === 'analytics-date-picker-demo',
  ).render.privacy_recipe_id;
  assert.throws(
    () => validatePack(missingRecipe),
    /immutable source bounds/,
  );
});

test('platform CTA attribution is exactly bound to the rendition identity', async (t) => {
  const cases = [
    {
      name: 'wrong content',
      mutate: (url) => {
        url.searchParams.set('utm_content', 'tt-ce-field-funnel-01');
      },
      error: /canonical \/start attribution/,
    },
    {
      name: 'wrong source',
      mutate: (url) => {
        url.searchParams.set('utm_source', 'tiktok');
      },
      error: /canonical \/start attribution/,
    },
    {
      name: 'wrong campaign',
      mutate: (url) => {
        url.searchParams.set('utm_campaign', 'other-campaign');
      },
      error: /canonical \/start attribution/,
    },
    {
      name: 'wrong path',
      mutate: (url) => {
        url.pathname = '/instagram';
      },
      error: /canonical \/start attribution/,
    },
    {
      name: 'duplicate parameter',
      mutate: (url) => {
        url.searchParams.append('utm_content', 'ig-ce-field-funnel-01');
      },
      error: /exactly once/,
    },
    {
      name: 'extra parameter',
      mutate: (url) => {
        url.searchParams.set('campaign_id', 'untrusted');
      },
      error: /unsupported query parameter/,
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const raw = await starterPack();
      const artifact = raw.artifacts[0];
      const url = new URL(artifact.cta_url);
      item.mutate(url);
      artifact.cta_url = url.toString();
      assert.throws(() => validatePack(raw), item.error);
    });
  }
});

test('one source cannot exceed the three-active-rendition cap', async () => {
  const raw = await starterPack();
  const originals = raw.artifacts.slice(0, 2);
  raw.artifacts.push(
    ...originals.map((artifact) => {
      const platformPrefix = artifact.platform === 'instagram' ? 'ig' : 'tt';
      const next = clone(artifact);
      next.concept_id = 'fk-ce-field-funnel-02';
      next.artifact_key = `${platformPrefix}-ce-field-funnel-02`;
      next.platform_content_id = next.artifact_key;
      next.cta_url = new URL(next.cta_url);
      next.cta_url.searchParams.set('utm_content', next.platform_content_id);
      next.cta_url = next.cta_url.toString();
      return next;
    }),
  );
  assert.throws(
    () => validatePack(raw),
    /three-active-rendition source cap/,
  );
});

test('validate-only mode verifies private source bytes without persisting their path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'firstknock-render-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, 'sources');
  const outputDir = join(root, 'output');
  const sourcePath = join(sourceDir, 'fixture.png');
  await mkdir(sourceDir, { recursive: true });
  const bytes = Buffer.from('private-source-fixture');
  await writeFile(sourcePath, bytes);
  const raw = await starterPack();
  raw.batch_id = 'renderer-validate-fixture';
  raw.sources = [{
    ...raw.sources[0],
    source_reference: 'fixture.png',
    source_sha256: createHash('sha256').update(bytes).digest('hex'),
  }];
  raw.artifacts = raw.artifacts.slice(0, 2);
  const manifestPath = join(root, 'pack.json');
  await writeFile(manifestPath, `${JSON.stringify(raw)}\n`);

  const result = await renderPack({
    manifestPath,
    sourceDir,
    outputDir,
    repoDir: root,
    validateOnly: true,
  });
  assert.equal(result.status, 'validated');
  assert.equal(result.source_count, 1);
  assert.equal(result.artifact_count, 2);
  assert.equal(JSON.stringify(result).includes(root), false);

  await writeFile(sourcePath, 'changed-private-source');
  await assert.rejects(
    () => renderPack({
      manifestPath,
      sourceDir,
      outputDir,
      repoDir: root,
      validateOnly: true,
    }),
    /Source SHA-256 mismatch: fixture\.png/,
  );
});

test('remote verification binds the exact origin, delivery key, hash, MIME, and byte count', () => {
  const sha256 = 'a'.repeat(64);
  const descriptor = validateRemoteArtifactDescriptor({
    artifact_key: 'ig-test-01',
    media_sha256: sha256,
    delivery_key: `sha256/${sha256}-ig-test-01.mp4`,
    media_url: `https://media.firstknock.online/sha256/${sha256}-ig-test-01.mp4`,
    mime_type: 'video/mp4',
    byte_size: 100,
  }, 'https://media.firstknock.online');
  assert.equal(descriptor.sha256, sha256);
  assert.equal(descriptor.byteSize, 100);

  assert.throws(
    () => validateRemoteArtifactDescriptor({
      artifact_key: 'ig-test-01',
      media_sha256: sha256,
      delivery_key: `sha256/${sha256}-ig-test-01.mp4`,
      media_url: `https://other.example/sha256/${sha256}-ig-test-01.mp4`,
      mime_type: 'video/mp4',
      byte_size: 100,
    }, 'https://media.firstknock.online'),
    /invalid content-addressed descriptor/,
  );
});

test('opt-in real FFmpeg render is byte-identical across concurrent reruns', {
  skip: process.env.FIRSTKNOCK_RENDER_DETERMINISM_TEST !== '1',
  timeout: 240_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'firstknock-render-determinism-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, 'sources');
  await mkdir(sourceDir, { recursive: true });
  const sourceBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR42mNkYGD4z8DAwMDEAAUADikBA9Q6Qj8AAAAASUVORK5CYII=',
    'base64',
  );
  const sourcePath = join(sourceDir, 'fixture.png');
  await writeFile(sourcePath, sourceBytes);
  const raw = await starterPack();
  raw.batch_id = 'renderer-determinism-fixture';
  raw.output.duration_ms = 5000;
  raw.sources = [{
    ...raw.sources[0],
    source_reference: 'fixture.png',
    source_sha256: createHash('sha256').update(sourceBytes).digest('hex'),
    mime_type: 'image/png',
    width: 2,
    height: 2,
  }];
  raw.artifacts = raw.artifacts.slice(0, 2).map((artifact) => ({
    ...artifact,
    render: { duration_ms: 5000 },
  }));
  const manifestPath = join(root, 'pack.json');
  await writeFile(manifestPath, `${JSON.stringify(raw)}\n`);
  const options = {
    manifestPath,
    sourceDir,
    repoDir: root,
    only: ['ig-ce-field-funnel-01'],
  };
  const [left, right] = await Promise.all([
    renderPack({ ...options, outputDir: join(root, 'left') }),
    renderPack({ ...options, outputDir: join(root, 'right') }),
  ]);
  assert.equal(left.artifacts[0].media_sha256, right.artifacts[0].media_sha256);
  assert.equal(left.artifacts[0].byte_size, right.artifacts[0].byte_size);
  assert.equal(
    left.artifacts[0].render_input_sha256,
    right.artifacts[0].render_input_sha256,
  );
  assert.equal(left.renderer.profile_id, 'firstknock-h264-bitexact-v2');
  assert.match(left.renderer.environment_sha256, /^[a-f0-9]{64}$/);
  assert.equal(left.pack.schema_version, 'growth-render-pack.v1');
  assert.equal(
    createHash('sha256')
      .update(rendererCanonicalStringify(left.pack))
      .digest('hex'),
    left.pack_sha256,
  );
});
