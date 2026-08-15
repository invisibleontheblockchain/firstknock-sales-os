import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  canonicalStringify,
  validatePack,
} from '../scripts/render-growth-pack.mjs';
import {
  runSliceGrowthRenderResult,
  sliceGrowthRenderResult,
} from '../scripts/slice-growth-render-result.mjs';

const weeklyPack = validatePack(JSON.parse(await readFile(resolve(
  'config/growth-media/firstknock-weekly-rights-safe-seed.json',
), 'utf8')));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sourceRenderResult(pack = weeklyPack) {
  return {
    schema_version: 'growth-render-result.v1',
    batch_id: pack.batch_id,
    pack_sha256: sha256(canonicalStringify(pack)),
    pack: structuredClone(pack),
    template: structuredClone(pack.template),
    renderer: {
      profile_id: 'firstknock-h264-bitexact-v3',
      environment_sha256: 'a'.repeat(64),
    },
    media_origin: 'https://media.firstknock.online',
    artifact_count: pack.artifacts.length,
    artifacts: pack.artifacts.map((artifact) => ({
      artifact_key: artifact.artifact_key,
      concept_id: artifact.concept_id,
      platform: artifact.platform,
      platform_content_id: artifact.platform_content_id,
      distribution_state: artifact.distribution_state,
      render_input_sha256: sha256(`input:${artifact.artifact_key}`),
      media_sha256: sha256(`media:${artifact.artifact_key}`),
      media_url:
        `https://media.firstknock.online/${artifact.artifact_key}.mp4`,
      mime_type: 'video/mp4',
      artifact_fields: {
        artifact_key: artifact.artifact_key,
      },
    })),
  };
}

function dailyPack(pack = weeklyPack) {
  const conceptIds = [...new Set(
    pack.artifacts.map((artifact) => artifact.concept_id),
  )].sort().slice(0, 2);
  const artifacts = pack.artifacts.filter(
    (artifact) => conceptIds.includes(artifact.concept_id),
  );
  const sourceKeys = new Set(
    artifacts.map((artifact) => artifact.source_asset_key),
  );
  return {
    schema_version: pack.schema_version,
    batch_id: pack.batch_id,
    template: structuredClone(pack.template),
    output: structuredClone(pack.output),
    sources: structuredClone(pack.sources
      .filter((source) => sourceKeys.has(source.asset_key))
      .sort((left, right) => (
        conceptIds.indexOf(
          artifacts.find(
            (artifact) => artifact.source_asset_key === left.asset_key,
          )?.concept_id,
        ) - conceptIds.indexOf(
          artifacts.find(
            (artifact) => artifact.source_asset_key === right.asset_key,
          )?.concept_id,
        )
      ))),
    artifacts: structuredClone(conceptIds.flatMap((conceptId) => (
      artifacts.filter((artifact) => artifact.concept_id === conceptId)
    ))),
  };
}

test('slicer creates an exact four-artifact daily result without changing media descriptors', () => {
  const source = sourceRenderResult();
  const pack = dailyPack();
  const sliced = sliceGrowthRenderResult(source, pack);
  assert.equal(sliced.schema_version, 'growth-render-result.v1');
  assert.equal(sliced.batch_id, weeklyPack.batch_id);
  assert.equal(sliced.artifact_count, 4);
  assert.deepEqual(sliced.pack, pack);
  assert.equal(
    sliced.pack_sha256,
    sha256(canonicalStringify(pack)),
  );
  assert.deepEqual(
    sliced.artifacts,
    pack.artifacts.map((artifact) => (
      source.artifacts.find(
        (candidate) => candidate.artifact_key === artifact.artifact_key,
      )
    )),
  );
});

test('slicer rejects any daily source or creative that is not an exact subset', () => {
  const source = sourceRenderResult();
  const changedSource = dailyPack();
  changedSource.sources[0].source_sha256 = 'f'.repeat(64);
  assert.throws(
    () => sliceGrowthRenderResult(source, changedSource),
    /daily_pack_source_not_exact_subset/,
  );

  const changedArtifact = dailyPack();
  changedArtifact.artifacts[0].caption = 'Changed after the trusted render.';
  assert.throws(
    () => sliceGrowthRenderResult(source, changedArtifact),
    /daily_pack_artifact_not_exact_subset/,
  );
});

test('CLI write is deterministic, idempotent, and never overwrites a conflict', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'growth-slice-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, 'source.json');
  const packPath = join(root, 'daily-pack.json');
  const outputPath = join(root, 'daily-result.json');
  await writeFile(
    sourcePath,
    `${JSON.stringify(sourceRenderResult(), null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    packPath,
    `${JSON.stringify(dailyPack(), null, 2)}\n`,
    'utf8',
  );
  const args = [
    '--source-result',
    sourcePath,
    '--batch-pack',
    packPath,
    '--output',
    outputPath,
  ];
  const created = await runSliceGrowthRenderResult(args);
  assert.equal(created.success, true);
  assert.equal(created.created, true);
  assert.equal(created.artifact_count, 4);
  const retry = await runSliceGrowthRenderResult(args);
  assert.equal(retry.created, false);
  assert.equal(retry.result_sha256, created.result_sha256);

  await writeFile(outputPath, '{}\n', 'utf8');
  await assert.rejects(
    runSliceGrowthRenderResult(args),
    /output_conflict/,
  );
});
