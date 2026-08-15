import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_GROWTH_TARGET,
  DEFAULT_REPOSITORY_ROOT,
  READINESS_SCHEMA,
  evaluateGrowthProductionReadiness,
  evaluateHostingAuthorization,
  evaluateLocalImmutableMedia,
  evaluateRepositoryContract,
} from '../scripts/check-growth-production-readiness.mjs';
import {
  HOSTING_AUTHORIZATION_SCHEMA,
  canonicalStringify,
} from '../scripts/host-growth-media-base44.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, '..');
const checkerPath = join(
  repositoryRoot,
  'scripts',
  'check-growth-production-readiness.mjs',
);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function mp4Bytes(label = 'growth-readiness') {
  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0);
  ftyp.write('ftyp', 4, 'ascii');
  ftyp.write('isom', 8, 'ascii');
  ftyp.writeUInt32BE(0x200, 12);
  ftyp.write('isom', 16, 'ascii');
  ftyp.write('iso2', 20, 'ascii');
  return Buffer.concat([ftyp, Buffer.from(label)]);
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'growth-readiness-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputDir = join(root, 'render-output');
  await mkdir(join(outputDir, 'sha256'), { recursive: true });

  const batchId = 'growth-readiness-fixture';
  const artifactKey = 'ig-growth-readiness-01';
  const bytes = mp4Bytes();
  const mediaSha256 = sha256(bytes);
  const filename = `${mediaSha256}-${artifactKey}.mp4`;
  const rendererEnvironment = {
    profile_id: 'firstknock-h264-bitexact-v3',
    ffmpeg_version: 'fixture',
    font_sha256: 'a'.repeat(64),
  };
  const rendererEnvironmentSha256 = sha256(
    canonicalStringify(rendererEnvironment),
  );
  const pack = {
    schema_version: 'growth-render-pack.v1',
    batch_id: batchId,
    template: { id: 'firstknock-test', version: '1.0.0' },
    output: { mime_type: 'video/mp4' },
    sources: [],
    artifacts: [{
      artifact_key: artifactKey,
      distribution_state: 'publish_candidate',
    }],
  };
  const packSha256 = sha256(canonicalStringify(pack));
  const artifact = {
    artifact_key: artifactKey,
    distribution_state: 'publish_candidate',
    delivery_key: `sha256/${filename}`,
    media_url: null,
    media_sha256: mediaSha256,
    mime_type: 'video/mp4',
    byte_size: bytes.byteLength,
    render_environment_sha256: rendererEnvironmentSha256,
    qc: { ready_for_content_engine_import: true },
    artifact_fields: {
      artifact_key: artifactKey,
      format: 'video',
      media_url: null,
      media_sha256: mediaSha256,
      mime_type: 'video/mp4',
    },
  };
  const result = {
    schema_version: 'growth-render-result.v1',
    batch_id: batchId,
    pack_sha256: packSha256,
    pack,
    template: pack.template,
    renderer: {
      ...rendererEnvironment,
      environment_sha256: rendererEnvironmentSha256,
    },
    media_origin: null,
    artifact_count: 1,
    artifacts: [artifact],
  };
  const resultRaw = `${JSON.stringify(result, null, 2)}\n`;
  const resultSha256 = sha256(resultRaw);
  const resultPath = join(outputDir, `${batchId}.render-result.json`);
  const mediaPath = join(outputDir, 'sha256', filename);
  await writeFile(resultPath, resultRaw, 'utf8');
  await writeFile(mediaPath, bytes);

  const review = {
    schema_version: HOSTING_AUTHORIZATION_SCHEMA,
    review_id: `${batchId}-hosting-review`,
    review_status: 'authorized',
    authorization_scope: 'base44_hosting_only',
    batch_id: batchId,
    render_result_sha256: resultSha256,
    pack_sha256: packSha256,
    renderer_environment_sha256: rendererEnvironmentSha256,
    hosting_authorized: true,
    reviewed_at: '2026-07-29T12:00:00.000Z',
    reviewed_by: 'growth-readiness-test',
    unresolved_blockers: [],
    artifacts: [{
      artifact_key: artifactKey,
      media_sha256: mediaSha256,
    }],
  };
  const reviewPath = join(root, `${batchId}.hosting-review.json`);
  await writeFile(
    reviewPath,
    `${JSON.stringify(review, null, 2)}\n`,
    'utf8',
  );
  const expected = {
    batchId,
    packSha256,
    renderResultSha256: resultSha256,
    rendererEnvironmentSha256,
    sourceCount: 0,
    conceptCount: 1,
    artifactCount: 1,
    instagramCount: 1,
    tiktokCount: 0,
  };
  return {
    root,
    outputDir,
    resultPath,
    mediaPath,
    reviewPath,
    review,
    pack,
    expected,
  };
}

function gate(report, id) {
  return report.gates.find((item) => item.id === id);
}

test('canonical repository contract validates the exact weekly pack and workflow', async () => {
  const result = await evaluateRepositoryContract({
    repositoryRoot: DEFAULT_REPOSITORY_ROOT,
    trackedFileCheck: () => true,
  });
  assert.equal(result.gate.status, 'pass');
  assert.equal(result.pack.batch_id, CANONICAL_GROWTH_TARGET.batchId);
  assert.equal(result.pack.artifacts.length, 28);
  assert.equal(
    result.gate.checks.find(
      (item) => item.id === 'growth_generator_workflow_contract',
    ).status,
    'pass',
  );
  assert.equal(
    result.gate.checks.find(
      (item) => item.id === 'growth_generator_workflow_tracked',
    ).status,
    'pass',
  );
  assert.equal(
    result.gate.checks.find(
      (item) => item.id === 'reviewed_generation_policy_contract',
    ).code,
    'reviewed_generation_policy_contract_verified',
  );
});

test('repository contract fails until the generator workflow is tracked', async () => {
  const checkedPaths = [];
  const result = await evaluateRepositoryContract({
    repositoryRoot: DEFAULT_REPOSITORY_ROOT,
    trackedFileCheck: (_root, relativePath) => {
      checkedPaths.push(relativePath);
      return relativePath !== '.github/workflows/growth-generator.yml';
    },
  });
  assert.equal(result.gate.status, 'fail');
  assert.deepEqual(checkedPaths.sort(), [
    '.github/workflows/growth-generator.yml',
    '.github/workflows/growth-publisher.yml',
  ]);
  assert.equal(
    result.gate.checks.find(
      (item) => item.id === 'growth_generator_workflow_tracked',
    ).code,
    'growth_generator_workflow_not_tracked',
  );
});

test('local immutable-media gate verifies the exact result and every local byte without writes', async (t) => {
  const built = await fixture(t);
  const before = (await readdir(built.outputDir, {
    recursive: true,
  })).sort();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('network access is forbidden');
  };
  try {
    const result = await evaluateLocalImmutableMedia({
      renderResultPath: built.resultPath,
      renderOutput: built.outputDir,
      canonicalPack: built.pack,
      expected: built.expected,
    });
    assert.equal(result.gate.status, 'pass');
    assert.equal(
      result.gate.checks.find((item) => item.id === 'local_media_bytes')
        .evidence.verified_count,
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  const after = (await readdir(built.outputDir, {
    recursive: true,
  })).sort();
  assert.deepEqual(after, before);
});

test('local immutable-media gate fails closed when an approved MP4 changes', async (t) => {
  const built = await fixture(t);
  await writeFile(built.mediaPath, mp4Bytes('tampered'));
  const result = await evaluateLocalImmutableMedia({
    renderResultPath: built.resultPath,
    renderOutput: built.outputDir,
    canonicalPack: built.pack,
    expected: built.expected,
  });
  assert.equal(result.gate.status, 'fail');
  assert.equal(
    result.gate.checks.find((item) => item.id === 'local_media_bytes').code,
    'local_media_bytes_invalid',
  );
});

test('hosting gate distinguishes exact authorization from an exact pending review', async (t) => {
  const built = await fixture(t);
  const local = await evaluateLocalImmutableMedia({
    renderResultPath: built.resultPath,
    renderOutput: built.outputDir,
    canonicalPack: built.pack,
    expected: built.expected,
  });
  const authorized = await evaluateHostingAuthorization({
    renderResultPath: built.resultPath,
    hostingReviewPath: built.reviewPath,
    expected: built.expected,
    localContext: local.context,
  });
  assert.equal(authorized.status, 'pass');

  const pending = {
    ...built.review,
    review_status: 'pending',
    hosting_authorized: false,
    reviewed_at: null,
    reviewed_by: null,
    unresolved_blockers: ['owner_hosting_authorization_required'],
  };
  await writeFile(
    built.reviewPath,
    `${JSON.stringify(pending, null, 2)}\n`,
    'utf8',
  );
  const pendingResult = await evaluateHostingAuthorization({
    renderResultPath: built.resultPath,
    hostingReviewPath: built.reviewPath,
    expected: built.expected,
    localContext: local.context,
  });
  assert.equal(pendingResult.status, 'not_proven');
  assert.equal(
    pendingResult.checks[0].code,
    'hosting_authorization_pending',
  );
});

test('offline report is deterministic and labels every production-only gate not proven', async () => {
  const options = {
    trackedFileCheck: () => true,
  };
  const first = await evaluateGrowthProductionReadiness(options);
  const second = await evaluateGrowthProductionReadiness(options);
  assert.deepEqual(second, first);
  assert.equal(first.overall, 'blocked');
  assert.equal(gate(first, 'repository_contract').status, 'pass');
  assert.equal(gate(first, 'local_immutable_media').status, 'not_proven');
  assert.equal(gate(first, 'hosting_authorization').status, 'not_proven');
  assert.equal(gate(first, 'hosted_media').status, 'not_proven');
  assert.equal(gate(first, 'production_runtime').status, 'not_proven');
  assert.equal(
    gate(first, 'scheduler_default_branch').status,
    'not_proven',
  );
  assert.equal(
    gate(first, 'scheduled_generation_runtime').status,
    'not_proven',
  );
  assert.deepEqual(
    gate(first, 'scheduled_generation_runtime').checks.map(
      (item) => item.code,
    ),
    [
      'growth_generator_default_branch_not_proven',
      'scheduled_generation_enablement_not_proven',
      'scheduled_generation_runtime_not_proven',
    ],
  );
  assert.equal(gate(first, 'activatable_batch').status, 'not_proven');
  assert.deepEqual(first.blockers, [...first.blockers].sort());
});

test('CLI emits JSON only on stdout, human status on stderr, blocks safely, and never echoes secrets or paths', () => {
  const canary = 'readiness-secret+do-not-print';
  const result = spawnSync(
    process.execPath,
    [checkerPath, '--render-result', join(tmpdir(), canary, 'missing.json')],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        BUFFER_API_KEY: canary,
        GROWTH_PUBLISH_WORKER_SECRET: canary,
      },
    },
  );
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema_version, READINESS_SCHEMA);
  assert.equal(report.overall, 'blocked');
  assert.match(result.stderr, /Growth production readiness: BLOCKED/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(canary));
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    new RegExp(encodeURIComponent(canary)),
  );
});

test('invalid CLI is stable JSON and exits 2 without echoing the rejected value', () => {
  const rejected = 'never-print-this-value';
  const result = spawnSync(
    process.execPath,
    [checkerPath, '--unknown', rejected],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  assert.equal(result.status, 2);
  assert.deepEqual(JSON.parse(result.stdout), {
    schema_version: READINESS_SCHEMA,
    overall: 'invalid',
    error: 'unknown_argument',
  });
  assert.equal(result.stderr, 'Growth production readiness: INVALID\n');
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /never-print/);
});

test('package exposes the one-command production-readiness check', async () => {
  const packageJson = JSON.parse(
    await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
  );
  assert.equal(
    packageJson.scripts['check:growth-production'],
    'node scripts/check-growth-production-readiness.mjs',
  );
});
