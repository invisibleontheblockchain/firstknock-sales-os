#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalStringify,
  validatePack,
} from './render-growth-pack.mjs';

const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SCRIPT_PATH = fileURLToPath(import.meta.url);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactObject(left, right) {
  return canonicalStringify(left) === canonicalStringify(right);
}

function uniqueBy(items, keyFor, code) {
  const values = new Map();
  for (const item of items) {
    const key = keyFor(item);
    if (!key || values.has(key)) fail(code);
    values.set(key, item);
  }
  return values;
}

function validateDailyPairPack(pack) {
  if (
    pack.sources.length !== 2
    || pack.artifacts.length !== 4
    || new Set(pack.sources.map((source) => source.asset_key)).size !== 2
  ) {
    fail('daily_pack_shape_invalid');
  }
  const byConcept = new Map();
  for (const artifact of pack.artifacts) {
    const current = byConcept.get(artifact.concept_id) || [];
    current.push(artifact);
    byConcept.set(artifact.concept_id, current);
  }
  if (
    byConcept.size !== 2
    || [...byConcept.values()].some((artifacts) => (
      artifacts.length !== 2
      || new Set(artifacts.map((artifact) => artifact.platform)).size !== 2
      || !artifacts.some((artifact) => artifact.platform === 'instagram')
      || !artifacts.some((artifact) => artifact.platform === 'tiktok')
      || new Set(
        artifacts.map((artifact) => artifact.source_asset_key),
      ).size !== 1
    ))
  ) {
    fail('daily_pack_pairing_invalid');
  }
}

export function sliceGrowthRenderResult(sourceValue, requestedPackValue) {
  if (
    sourceValue?.schema_version !== 'growth-render-result.v1'
    || !sourceValue?.pack
    || !Array.isArray(sourceValue?.artifacts)
    || sourceValue.artifacts.length < 4
    || Number(sourceValue?.artifact_count) !== sourceValue.artifacts.length
  ) {
    fail('source_render_result_invalid');
  }
  const sourcePack = validatePack(sourceValue.pack);
  const requestedPack = validatePack(
    requestedPackValue?.schema_version === 'growth-render-result.v1'
      ? requestedPackValue.pack
      : requestedPackValue,
  );
  if (
    !exactObject(sourcePack, sourceValue.pack)
    || !exactObject(requestedPack, (
      requestedPackValue?.schema_version === 'growth-render-result.v1'
        ? requestedPackValue.pack
        : requestedPackValue
    ))
  ) {
    fail('render_pack_not_canonical');
  }
  const sourcePackSha256 = sha256(canonicalStringify(sourcePack));
  if (
    sourceValue.batch_id !== sourcePack.batch_id
    || sourceValue.pack_sha256 !== sourcePackSha256
    || !exactObject(sourceValue.template, sourcePack.template)
    || requestedPack.batch_id !== sourcePack.batch_id
    || !exactObject(requestedPack.template, sourcePack.template)
    || !exactObject(requestedPack.output, sourcePack.output)
  ) {
    fail('source_render_result_lineage_invalid');
  }
  validateDailyPairPack(requestedPack);

  const sourceByKey = uniqueBy(
    sourcePack.sources,
    (source) => source.asset_key,
    'source_pack_duplicate_source',
  );
  for (const source of requestedPack.sources) {
    if (!exactObject(source, sourceByKey.get(source.asset_key))) {
      fail('daily_pack_source_not_exact_subset');
    }
  }
  const artifactByKey = uniqueBy(
    sourcePack.artifacts,
    (artifact) => artifact.artifact_key,
    'source_pack_duplicate_artifact',
  );
  for (const artifact of requestedPack.artifacts) {
    if (!exactObject(artifact, artifactByKey.get(artifact.artifact_key))) {
      fail('daily_pack_artifact_not_exact_subset');
    }
  }
  const resultArtifactByKey = uniqueBy(
    sourceValue.artifacts,
    (artifact) => artifact?.artifact_key,
    'source_result_duplicate_artifact',
  );
  const selectedArtifacts = requestedPack.artifacts.map((artifact) => {
    const rendered = resultArtifactByKey.get(artifact.artifact_key);
    if (
      !rendered
      || rendered.concept_id !== artifact.concept_id
      || rendered.platform !== artifact.platform
      || rendered.platform_content_id !== artifact.platform_content_id
      || rendered.distribution_state !== artifact.distribution_state
      || !SHA256_PATTERN.test(String(rendered.render_input_sha256 || ''))
      || !SHA256_PATTERN.test(String(rendered.media_sha256 || ''))
      || rendered.mime_type !== 'video/mp4'
      || rendered?.artifact_fields?.artifact_key !== artifact.artifact_key
    ) {
      fail('source_result_artifact_lineage_invalid');
    }
    return structuredClone(rendered);
  });
  const dailyPackSha256 = sha256(canonicalStringify(requestedPack));
  return {
    ...structuredClone(sourceValue),
    batch_id: requestedPack.batch_id,
    pack_sha256: dailyPackSha256,
    pack: requestedPack,
    template: requestedPack.template,
    artifact_count: selectedArtifacts.length,
    artifacts: selectedArtifacts,
  };
}

async function readRegularJson(path, label) {
  const absolute = resolve(path);
  const info = await lstat(absolute).catch(() => null);
  if (
    !info
    || !info.isFile()
    || info.isSymbolicLink()
    || !Number.isSafeInteger(info.size)
    || info.size < 1
    || info.size > MAX_INPUT_BYTES
  ) {
    fail(`${label}_file_invalid`);
  }
  const canonicalPath = await realpath(absolute);
  const bytes = await readFile(canonicalPath);
  if (bytes.byteLength !== info.size) fail(`${label}_changed_while_reading`);
  try {
    return {
      absolute,
      value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    };
  } catch {
    fail(`${label}_json_invalid`);
  }
}

function parseArguments(argv) {
  const known = new Set(['--source-result', '--batch-pack', '--output']);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!known.has(key)) fail('unknown_argument');
    if (values.has(key)) fail('duplicate_argument');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail('missing_argument_value');
    values.set(key, value);
    index += 1;
  }
  for (const key of known) {
    if (!values.has(key)) fail('required_argument_missing');
  }
  return Object.fromEntries(values);
}

async function writeIdempotentJson(outputPath, value) {
  const absolute = resolve(outputPath);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const existing = await lstat(absolute).catch(() => null);
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) {
      fail('output_path_invalid');
    }
    const current = await readFile(absolute, 'utf8');
    if (current !== serialized) fail('output_conflict');
    return { created: false, sha256: sha256(serialized) };
  }
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, serialized, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return { created: true, sha256: sha256(serialized) };
}

export async function runSliceGrowthRenderResult(argv) {
  const args = parseArguments(argv);
  const [source, batchPack] = await Promise.all([
    readRegularJson(args['--source-result'], 'source_result'),
    readRegularJson(args['--batch-pack'], 'batch_pack'),
  ]);
  const outputPath = resolve(args['--output']);
  if (
    outputPath === source.absolute
    || outputPath === batchPack.absolute
  ) {
    fail('output_must_be_new_path');
  }
  const result = sliceGrowthRenderResult(source.value, batchPack.value);
  const written = await writeIdempotentJson(outputPath, result);
  return {
    success: true,
    created: written.created,
    schema_version: result.schema_version,
    batch_id: result.batch_id,
    pack_sha256: result.pack_sha256,
    artifact_count: result.artifact_count,
    result_sha256: written.sha256,
  };
}

const isCli = process.argv[1]
  && resolve(process.argv[1]) === resolve(SCRIPT_PATH);
if (isCli) {
  try {
    const result = await runSliceGrowthRenderResult(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      success: false,
      error: String(error?.code || error?.message || 'slice_failed'),
    })}\n`);
    process.exitCode = 1;
  }
}
