#!/usr/bin/env node

import { constants as fsConstants, createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalStringify,
  validatePack,
} from './render-growth-pack.mjs';
import { FIRSTKNOCK_AUDITED_SOURCES } from '../src/data/firstKnockAuditedSources.js';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const WEEKLY_PACK_PATH = resolve(
  REPOSITORY_ROOT,
  'config',
  'growth-media',
  'firstknock-weekly-rights-safe-seed.json',
);
const RIGHTS_SAFE_PLAN_PATH = resolve(
  REPOSITORY_ROOT,
  'config',
  'growth-media',
  'firstknock-weekly-rights-safe-sanitize-plan.json',
);
const RIGHTS_SAFE_REVIEW_PATH = resolve(
  REPOSITORY_ROOT,
  'config',
  'growth-media',
  'firstknock-weekly-rights-safe-review.json',
);
const SUPPLEMENT_REVIEW_PATH = resolve(
  REPOSITORY_ROOT,
  'config',
  'growth-media',
  'firstknock-video-supplement-review.json',
);
const EXPECTED_BATCH_ID =
  'firstknock-weekly-rights-safe-v2-2026-07';
const EXPECTED_PACK_SHA256 =
  '00e06013561a34a7fc59a7be75093c262a78f83b52d5dff0371b1fdf30bd79d0';
const RECEIPT_SCHEMA = 'firstknock-weekly-source-stage-receipt.v2';
const LOCK_FILENAME = '.firstknock-weekly-source-stage.lock';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,239}$/;
const MAX_JSON_BYTES = 150_000;
const RIGHTS_SAFE_REVIEW_SCHEMA =
  'firstknock-video-derivative-review.v1';
const RIGHTS_SAFE_RESULT_SCHEMA = 'growth-video-sanitize-result.v1';
const RIGHTS_SAFE_RELEASE_GATE =
  'blocked_until_sanitized_derivative_hash_and_frame_review';
const EXPECTED_RIGHTS_SAFE_DONORS = 8;
const EXPECTED_RIGHTS_SAFE_ASSET_KEYS = Object.freeze([
  'video-weekly-route-start-finish-rights-safe-v1',
  'video-weekly-route-command-overview-rights-safe-v1',
  'video-weekly-merge-routes-rights-safe-v1',
  'video-weekly-bulk-reknock-rights-safe-v1',
  'video-weekly-outcome-controls-rights-safe-v1',
  'video-weekly-add-details-rights-safe-v1',
  'video-weekly-property-styling-rights-safe-v1',
  'video-weekly-refresh-area-rights-safe-v1',
]);

export const WEEKLY_PACK_AUTHORIZATION = Object.freeze({
  batch_id: EXPECTED_BATCH_ID,
  pack_path: WEEKLY_PACK_PATH,
  pack_sha256: EXPECTED_PACK_SHA256,
});

function fail(message) {
  const error = new Error(message);
  error.name = 'GrowthWeeklySourceStageError';
  throw error;
}

function pathKey(value) {
  const normalized = resolve(value).replace(/[\\/]+$/g, '');
  return process.platform === 'win32'
    ? normalized.toLowerCase()
    : normalized;
}

function inside(parent, candidate) {
  const remainder = relative(pathKey(parent), pathKey(candidate));
  return remainder === ''
    || (!remainder.startsWith('..') && !isAbsolute(remainder));
}

function overlaps(left, right) {
  return inside(left, right) || inside(right, left);
}

function opaqueFilename(value, label) {
  const filename = String(value || '').trim();
  if (
    !SOURCE_FILENAME_PATTERN.test(filename)
    || basename(filename) !== filename
    || filename === '.'
    || filename === '..'
    || filename.startsWith('.')
    || /[\\/:]/.test(filename)
    || /[\u0000-\u001f\u007f]/.test(filename)
    || !['.jpg', '.jpeg', '.png', '.mp4'].includes(
      extname(filename).toLowerCase(),
    )
  ) {
    fail(`${label} must be one opaque JPG, PNG, or MP4 filename`);
  }
  return filename;
}

function exactSha256(value, label) {
  const digest = String(value || '').trim();
  if (!SHA256_PATTERN.test(digest)) {
    fail(`${label} must be one complete lowercase SHA-256`);
  }
  return digest;
}

function exactAssetKey(value, label) {
  const key = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9._~-]{0,119}$/.test(key)) {
    fail(`${label} must be a stable lowercase asset key`);
  }
  return key;
}

function exactPositiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > maximum
  ) {
    fail(`${label} must be a positive bounded integer`);
  }
  return value;
}

function exactObjectKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const expected = [...keys].sort();
  const observed = Object.keys(value).sort();
  if (JSON.stringify(expected) !== JSON.stringify(observed)) {
    fail(`${label} must contain the exact reviewed fields`);
  }
}

function unique(values, label) {
  if (new Set(values).size !== values.length) {
    fail(`${label} must be unique`);
  }
}

function receiptFilename(batchId) {
  return `${exactAssetKey(batchId, 'batch_id')}.source-stage-receipt.json`;
}

function sourceBucket(source, rightsSafeAssetKeys) {
  if (source.source_origin === 'repository_public') {
    return 'repository_public';
  }
  if (source.media_kind === 'image') return 'raw_asset_pack';
  if (rightsSafeAssetKeys.has(source.asset_key)) {
    return 'rights_safe_sanitizer';
  }
  if (source.asset_key.startsWith('video-pilot-')) {
    return 'pilot_sanitizer';
  }
  if (source.asset_key.startsWith('video-supplement-')) {
    return 'supplement_sanitizer';
  }
  fail(`${source.asset_key} is outside the approved weekly source buckets`);
}

function validateStagingInventory(pack, rightsSafeAuthorization) {
  if (
    !pack
    || typeof pack !== 'object'
    || pack.batch_id !== EXPECTED_BATCH_ID
    || !Array.isArray(pack.sources)
    || !pack.sources.length
  ) {
    fail('weekly staging inventory must use the exact rights-safe v2 batch');
  }
  const rightsSafeAssetKeys = new Set(
    rightsSafeAuthorization.decisions.map((decision) => decision.asset_key),
  );
  const normalized = pack.sources.map((source, index) => {
    const label = `sources[${index}]`;
    const item = {
      asset_key: exactAssetKey(source.asset_key, `${label}.asset_key`),
      source_origin: source.source_origin || 'asset_pack',
      source_reference: opaqueFilename(
        source.source_reference,
        `${label}.source_reference`,
      ),
      source_sha256: exactSha256(
        source.source_sha256,
        `${label}.source_sha256`,
      ),
      media_kind: source.media_kind,
      privacy_status: source.privacy_status,
      rights_status: source.rights_status,
    };
    if (
      !['asset_pack', 'repository_public'].includes(item.source_origin)
      || !['image', 'video'].includes(item.media_kind)
      || item.privacy_status !== 'safe'
      || item.rights_status !== 'firstknock_owned'
    ) {
      fail(`${label} is outside the safe weekly staging boundary`);
    }
    if (/^IMG_1420(?:\.|$)/i.test(item.source_reference)) {
      fail('IMG_1420 is explicitly excluded from weekly staging');
    }
    return {
      ...item,
      source_bucket: sourceBucket(item, rightsSafeAssetKeys),
    };
  });
  unique(
    normalized.map((source) => source.asset_key),
    'weekly source asset keys',
  );
  unique(
    normalized.map((source) => source.source_sha256),
    'weekly source hashes',
  );
  unique(
    normalized.map((source) => source.source_reference.toLowerCase()),
    'flat staged source filenames',
  );
  return normalized;
}

function validateExactWeeklyComposition(sources) {
  if (
    sources.length !== 14
    || sources.filter((source) => source.media_kind === 'video').length !== 10
    || sources.filter((source) => source.media_kind === 'image').length !== 4
    || sources.filter(
      (source) => source.source_bucket === 'rights_safe_sanitizer',
    ).length !== EXPECTED_RIGHTS_SAFE_DONORS
  ) {
    fail('weekly staging requires exactly 10 videos and 4 images');
  }
}

async function boundedJson(path, label) {
  const info = await lstat(path).catch(() => null);
  if (
    !info
    || info.isSymbolicLink()
    || !info.isFile()
    || info.size < 2
    || info.size > MAX_JSON_BYTES
  ) {
    fail(`${label} must be one bounded regular JSON file`);
  }
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    fail(`${label} must contain valid JSON`);
  }
}

function validateRightsSafeDonorReview({
  pack,
  review,
  plan,
}) {
  if (!pack || typeof pack !== 'object' || !Array.isArray(pack.sources)) {
    fail('rights-safe review requires one validated weekly pack');
  }
  exactObjectKeys(review, new Set([
    'schema_version',
    'review_id',
    'plan_id',
    'plan_sha256',
    'sanitizer_environment_sha256',
    'sanitizer_script_sha256',
    'reviewed_at',
    'review_scope',
    'review_method',
    'approved_count',
    'rejected_count',
    'publication_authorized',
    'decisions',
  ]), 'rights-safe derivative review');
  if (
    review.schema_version !== RIGHTS_SAFE_REVIEW_SCHEMA
    || review.publication_authorized !== false
    || review.approved_count !== EXPECTED_RIGHTS_SAFE_DONORS
    || review.rejected_count !== 0
    || !Array.isArray(review.review_method)
    || !review.review_method.length
    || review.review_method.some(
      (method) => typeof method !== 'string' || !method.trim(),
    )
    || typeof review.review_scope !== 'string'
    || !review.review_scope.trim()
    || typeof review.reviewed_at !== 'string'
    || !review.reviewed_at.endsWith('Z')
    || !Number.isFinite(Date.parse(review.reviewed_at))
    || !Array.isArray(review.decisions)
    || review.decisions.length !== EXPECTED_RIGHTS_SAFE_DONORS
  ) {
    fail('rights-safe derivative review is missing, pending, or incomplete');
  }
  const reviewId = exactAssetKey(review.review_id, 'rights-safe review_id');
  const planId = exactAssetKey(review.plan_id, 'rights-safe review plan_id');
  const planSha256 = exactSha256(
    review.plan_sha256,
    'rights-safe review plan_sha256',
  );
  const sanitizerEnvironmentSha256 = exactSha256(
    review.sanitizer_environment_sha256,
    'rights-safe review sanitizer_environment_sha256',
  );
  const sanitizerScriptSha256 = exactSha256(
    review.sanitizer_script_sha256,
    'rights-safe review sanitizer_script_sha256',
  );
  if (
    !plan
    || typeof plan !== 'object'
    || Array.isArray(plan)
    || plan.schema_version !== 'firstknock-video-sanitize-plan.v1'
    || !Array.isArray(plan.assets)
    || plan.assets.length !== EXPECTED_RIGHTS_SAFE_DONORS
    || exactAssetKey(plan.plan_id, 'rights-safe plan_id') !== planId
    || createHash('sha256')
      .update(canonicalStringify(plan))
      .digest('hex') !== planSha256
  ) {
    fail('rights-safe review does not bind the exact checked-in sanitizer plan');
  }
  const plannedKeys = plan.assets.map((asset, index) => {
    const key = exactAssetKey(
      asset?.safe_derived_asset_key,
      `rights-safe plan assets[${index}].safe_derived_asset_key`,
    );
    if (
      asset?.rights_status !== 'firstknock_owned'
      || asset?.release_state !== RIGHTS_SAFE_RELEASE_GATE
    ) {
      fail('rights-safe sanitizer plan left its owned review-blocked boundary');
    }
    return key;
  });
  unique(plannedKeys, 'rights-safe sanitizer plan asset keys');
  if (
    JSON.stringify([...plannedKeys].sort())
    !== JSON.stringify([...EXPECTED_RIGHTS_SAFE_ASSET_KEYS].sort())
  ) {
    fail('rights-safe sanitizer plan changed its exact eight-donor boundary');
  }

  const sourceByKey = new Map(
    pack.sources.map((source) => [source.asset_key, source]),
  );
  const decisions = review.decisions.map((decision, index) => {
    const label = `rights-safe review decisions[${index}]`;
    exactObjectKeys(decision, new Set([
      'asset_key',
      'decision',
      'source_reference',
      'source_sha256',
      'duration_ms',
      'byte_size',
      'privacy_status',
      'review_note',
    ]), label);
    const normalized = {
      asset_key: exactAssetKey(decision.asset_key, `${label}.asset_key`),
      decision: decision.decision,
      source_reference: opaqueFilename(
        decision.source_reference,
        `${label}.source_reference`,
      ),
      source_sha256: exactSha256(
        decision.source_sha256,
        `${label}.source_sha256`,
      ),
      duration_ms: exactPositiveInteger(
        decision.duration_ms,
        `${label}.duration_ms`,
        3_600_000,
      ),
      byte_size: exactPositiveInteger(
        decision.byte_size,
        `${label}.byte_size`,
        64 * 1024 * 1024,
      ),
      privacy_status: decision.privacy_status,
      review_note: String(decision.review_note || '').trim(),
    };
    if (
      normalized.decision !== 'approved_as_safe_donor'
      || normalized.privacy_status !== 'safe'
      || !normalized.review_note
      || normalized.source_reference
        !== `${normalized.source_sha256}-${normalized.asset_key}.mp4`
    ) {
      fail(`${label} is not one exact approved safe donor`);
    }
    const source = sourceByKey.get(normalized.asset_key);
    if (
      !source
      || source.source_reference !== normalized.source_reference
      || source.source_sha256 !== normalized.source_sha256
      || source.duration_ms !== normalized.duration_ms
      || source.media_kind !== 'video'
      || source.mime_type !== 'video/mp4'
      || source.codec !== 'h264'
      || source.width !== 1080
      || source.height !== 1920
      || source.privacy_status !== 'safe'
      || source.rights_status !== 'firstknock_owned'
    ) {
      fail(`${label} and the weekly pack source diverged`);
    }
    return normalized;
  });
  unique(
    decisions.map((decision) => decision.asset_key),
    'rights-safe review asset keys',
  );
  unique(
    decisions.map((decision) => decision.source_reference.toLowerCase()),
    'rights-safe review source references',
  );
  unique(
    decisions.map((decision) => decision.source_sha256),
    'rights-safe review source hashes',
  );
  if (
    JSON.stringify(decisions.map((decision) => decision.asset_key).sort())
    !== JSON.stringify([...EXPECTED_RIGHTS_SAFE_ASSET_KEYS].sort())
  ) {
    fail('rights-safe review changed its exact eight-donor boundary');
  }
  return {
    review_id: reviewId,
    review_sha256: createHash('sha256')
      .update(canonicalStringify(review))
      .digest('hex'),
    plan_id: planId,
    plan_sha256: planSha256,
    sanitizer_environment_sha256: sanitizerEnvironmentSha256,
    sanitizer_script_sha256: sanitizerScriptSha256,
    decisions,
    decision_by_key: new Map(
      decisions.map((decision) => [decision.asset_key, decision]),
    ),
  };
}

function registryMatches(source, registrySource) {
  return registrySource
    && registrySource.active === true
    && registrySource.privacy_status === 'safe'
    && registrySource.asset_key === source.asset_key
    && registrySource.source_reference === source.source_reference
    && registrySource.source_sha256 === source.source_sha256
    && registrySource.media_kind === source.media_kind
    && registrySource.mime_type === source.mime_type
    && registrySource.width === source.width
    && registrySource.height === source.height
    && (
      source.media_kind !== 'video'
      || registrySource.duration_ms === source.duration_ms
    );
}

export function validateActiveWeeklyRegistry(
  pack,
  registry = FIRSTKNOCK_AUDITED_SOURCES,
) {
  if (!Array.isArray(registry)) {
    fail('audited-source registry must be an array');
  }
  const active = registry.filter((source) => source.active === true);
  const registryByKey = new Map(
    active.map((source) => [source.asset_key, source]),
  );
  if (
    active.length !== 14
    || registryByKey.size !== active.length
    || pack.sources.some(
      (source) => !registryMatches(source, registryByKey.get(source.asset_key)),
    )
    || active.some(
      (source) => !pack.sources.some(
        (item) => item.asset_key === source.asset_key,
      ),
    )
  ) {
    fail('weekly pack and active audited-source registry diverged');
  }
  return active;
}

function validateSupplementReview(pack, activeRegistry, review) {
  const approved = Array.isArray(review.decisions)
    ? review.decisions.filter(
      (decision) => decision.decision === 'approved_as_safe_donor',
    )
    : [];
  const rejected = Array.isArray(review.decisions)
    ? review.decisions.filter(
      (decision) => decision.decision === 'rejected',
    )
    : [];
  if (
    review.publication_authorized !== false
    || review.approved_count !== 1
    || review.rejected_count !== 2
    || approved.length !== 1
    || rejected.length !== 2
    || !pack.sources.some((source) => (
      source.asset_key === approved[0].asset_key
      && source.source_reference === approved[0].source_reference
      && source.source_sha256 === approved[0].source_sha256
      && source.duration_ms === approved[0].duration_ms
      && source.privacy_status === 'safe'
    ))
    || rejected.some((decision) => (
      pack.sources.some((source) => (
        source.asset_key === decision.asset_key
        || source.source_reference === decision.source_reference
        || source.source_sha256 === decision.source_sha256
      ))
      || activeRegistry.some((source) => (
        source.asset_key === decision.asset_key
        || source.source_reference === decision.source_reference
        || source.source_sha256 === decision.source_sha256
      ))
    ))
  ) {
    fail('supplement review no longer authorizes the exact weekly donor set');
  }
  return review.review_id;
}

export async function loadAuthorizedWeeklyInventory() {
  if (!SHA256_PATTERN.test(EXPECTED_PACK_SHA256)) {
    fail('trusted rights-safe v2 weekly pack SHA-256 pin is not finalized');
  }
  const pack = validatePack(await boundedJson(
    WEEKLY_PACK_PATH,
    'canonical rights-safe weekly pack',
  ));
  const packSha256 = createHash('sha256')
    .update(canonicalStringify(pack))
    .digest('hex');
  if (
    pack.batch_id !== EXPECTED_BATCH_ID
    || packSha256 !== EXPECTED_PACK_SHA256
    || pack.sources.length !== 14
    || pack.artifacts.length !== 28
  ) {
    fail('canonical weekly pack identity or exact inventory count changed');
  }
  const [rightsSafePlan, rightsSafeReview, supplementReview] =
    await Promise.all([
      boundedJson(
        RIGHTS_SAFE_PLAN_PATH,
        'rights-safe sanitizer plan',
      ),
      boundedJson(
        RIGHTS_SAFE_REVIEW_PATH,
        'rights-safe derivative review',
      ),
      boundedJson(
        SUPPLEMENT_REVIEW_PATH,
        'supplement derivative review',
      ),
    ]);
  const rightsSafeAuthorization = validateRightsSafeDonorReview({
    pack,
    review: rightsSafeReview,
    plan: rightsSafePlan,
  });
  const sources = validateStagingInventory(pack, rightsSafeAuthorization);
  validateExactWeeklyComposition(sources);
  if (
    pack.artifacts.some((artifact) => (
      artifact.distribution_state !== 'publish_candidate'
      || !sources.some(
        (source) => source.asset_key === artifact.source_asset_key,
      )
    ))
  ) {
    fail('canonical weekly pack left its approved source boundary');
  }

  const activeRegistry = validateActiveWeeklyRegistry(pack);
  const supplementReviewId = validateSupplementReview(
    pack,
    activeRegistry,
    supplementReview,
  );

  return {
    pack,
    pack_sha256: packSha256,
    sources,
    rights_safe_plan: rightsSafePlan,
    rights_safe_review: rightsSafeReview,
    rights_safe_review_id: rightsSafeAuthorization.review_id,
    rights_safe_review_sha256: rightsSafeAuthorization.review_sha256,
    supplement_review_id: supplementReviewId,
  };
}

async function sha256File(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const digest = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', rejectPromise);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('end', () => resolvePromise(digest.digest('hex')));
  });
}

async function exactDirectory(value, label) {
  if (!value) fail(`${label} is required`);
  const absolute = resolve(value);
  const info = await lstat(absolute).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) {
    fail(`${label} must be one existing real directory`);
  }
  return {
    label,
    canonical: await realpath(absolute),
  };
}

async function optionalDirectory(value, label) {
  const info = await lstat(value).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail(`${label} must be one real directory, never a symlink`);
  }
  return {
    label,
    canonical: await realpath(value),
  };
}

async function sanitizerPayloadDirectory(root, label) {
  if (basename(root.canonical).toLowerCase() === 'sha256') return root;
  const payload = await optionalDirectory(
    join(root.canonical, 'sha256'),
    `${label} sha256 directory`,
  );
  if (!payload || dirname(payload.canonical) !== root.canonical) {
    fail(`${label} must contain one real sha256 payload directory`);
  }
  return payload;
}

async function rightsSafeSanitizerBundle(root, authorization) {
  if (basename(root.canonical).toLowerCase() === 'sha256') {
    fail(
      'rights-safe sanitizer root must be the explicit output root, not its sha256 child',
    );
  }
  const payload = await sanitizerPayloadDirectory(
    root,
    'rights-safe sanitizer root',
  );
  const resultPath = join(
    root.canonical,
    `${authorization.plan_id}.sanitize-result.json`,
  );
  if (dirname(resultPath) !== root.canonical) {
    fail('rights-safe sanitizer result escaped its explicit output root');
  }
  const result = await boundedJson(
    resultPath,
    'rights-safe sanitizer result',
  );
  if (
    result.schema_version !== RIGHTS_SAFE_RESULT_SCHEMA
    || result.plan_id !== authorization.plan_id
    || result.plan_sha256 !== authorization.plan_sha256
    || result.release_state !== RIGHTS_SAFE_RELEASE_GATE
    || result.source_count !== EXPECTED_RIGHTS_SAFE_DONORS
    || !result.sanitizer
    || result.sanitizer.environment_sha256
      !== authorization.sanitizer_environment_sha256
    || result.sanitizer.script_sha256
      !== authorization.sanitizer_script_sha256
    || !Array.isArray(result.sources)
    || result.sources.length !== EXPECTED_RIGHTS_SAFE_DONORS
  ) {
    fail('rights-safe sanitizer result and reviewed environment diverged');
  }
  const resultKeys = [];
  for (const [index, source] of result.sources.entries()) {
    const label = `rights-safe sanitizer result sources[${index}]`;
    const assetKey = exactAssetKey(source.asset_key, `${label}.asset_key`);
    const decision = authorization.decision_by_key.get(assetKey);
    resultKeys.push(assetKey);
    if (
      !decision
      || source.source_reference !== decision.source_reference
      || source.source_sha256 !== decision.source_sha256
      || source.duration_ms !== decision.duration_ms
      || source.byte_size !== decision.byte_size
      || source.delivery_key !== `sha256/${decision.source_reference}`
      || source.release_state !== RIGHTS_SAFE_RELEASE_GATE
      || source.privacy_status !== 'redaction_required'
      || source.active !== false
      || source.rights_status !== 'firstknock_owned'
      || source.media_kind !== 'video'
      || source.mime_type !== 'video/mp4'
      || source.codec !== 'h264'
      || source.width !== 1080
      || source.height !== 1920
    ) {
      fail(`${label} does not match its exact approved review decision`);
    }
  }
  unique(resultKeys, 'rights-safe sanitizer result asset keys');
  if (
    JSON.stringify(resultKeys.sort())
    !== JSON.stringify(
      authorization.decisions.map((decision) => decision.asset_key).sort(),
    )
  ) {
    fail('rights-safe sanitizer result changed its reviewed donor set');
  }
  return {
    payload,
    result_sha256: createHash('sha256')
      .update(canonicalStringify(result))
      .digest('hex'),
  };
}

function ensureDistinctPrivateRoots(roots, repositoryRoot) {
  for (const root of roots) {
    if (overlaps(root.canonical, repositoryRoot.canonical)) {
      fail(`${root.label} must stay outside the repository`);
    }
  }
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (overlaps(roots[left].canonical, roots[right].canonical)) {
        fail('private input roots must be distinct and non-overlapping');
      }
    }
  }
}

function uniqueDirectories(directories) {
  const seen = new Set();
  return directories.filter((directory) => {
    const key = pathKey(directory.canonical);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function candidateFile(directory, filename) {
  const candidate = join(directory.canonical, filename);
  if (dirname(candidate) !== directory.canonical) {
    fail(`${filename} escaped an explicit input root`);
  }
  const info = await lstat(candidate).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile()) {
    fail(`${filename} must be a regular source file, never a symlink`);
  }
  const canonical = await realpath(candidate);
  if (dirname(canonical) !== directory.canonical) {
    fail(`${filename} escaped an explicit input root`);
  }
  return {
    path: canonical,
    byte_size: info.size,
    directory_kind: directory.kind,
    directory_canonical: directory.canonical,
  };
}

async function resolveVerifiedSources(
  sources,
  directories,
  rightsSafeAuthorization,
) {
  const verified = [];
  for (const source of sources) {
    const matches = [];
    for (const directory of directories) {
      const match = await candidateFile(directory, source.source_reference);
      if (match) matches.push(match);
    }
    if (!matches.length) {
      fail(`Missing audited weekly source: ${source.source_reference}`);
    }
    if (matches.length !== 1) {
      fail(`Duplicate audited weekly source: ${source.source_reference}`);
    }
    const match = matches[0];
    if (match.directory_kind !== source.source_bucket) {
      fail(`${source.source_reference} appeared in the wrong explicit input root`);
    }
    const digest = await sha256File(match.path);
    if (digest !== source.source_sha256) {
      fail(`Source SHA-256 mismatch: ${source.source_reference}`);
    }
    const reviewedDecision = rightsSafeAuthorization.decision_by_key
      .get(source.asset_key);
    if (
      source.source_bucket === 'rights_safe_sanitizer'
      && (
        !reviewedDecision
        || match.byte_size !== reviewedDecision.byte_size
      )
    ) {
      fail(
        `Reviewed source byte-size mismatch: ${source.source_reference}`,
      );
    }
    verified.push({
      ...source,
      source_path: match.path,
      source_directory: match.directory_canonical,
      byte_size: match.byte_size,
    });
  }
  return verified;
}

async function describeOutput(outputDir, protectedRoots) {
  if (!outputDir) fail('--output-dir is required');
  const absolute = resolve(outputDir);
  if (dirname(absolute) === absolute || basename(absolute).startsWith('.')) {
    fail('output directory must be one narrow, named private directory');
  }
  const info = await lstat(absolute).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  let descriptor;
  if (info) {
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail('output directory must be a real directory, never a symlink');
    }
    descriptor = {
      exists: true,
      canonical: await realpath(absolute),
    };
  } else {
    const parent = await exactDirectory(
      dirname(absolute),
      'output parent directory',
    );
    descriptor = {
      exists: false,
      canonical: join(parent.canonical, basename(absolute)),
    };
  }
  if (protectedRoots.some((root) => overlaps(
    descriptor.canonical,
    root.canonical,
  ))) {
    fail('output directory must not overlap the repository or an input root');
  }
  if (descriptor.exists && (await readdir(descriptor.canonical)).length) {
    fail('output directory must be new or empty; existing content is never overwritten');
  }
  return descriptor;
}

function assertNoAbsolutePaths(value) {
  if (typeof value === 'string' && isAbsolute(value)) {
    fail('stage receipt must not persist absolute paths');
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoAbsolutePaths(item);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) assertNoAbsolutePaths(item);
  }
}

async function stageFiles({
  output,
  verified,
  batchId,
  packSha256,
  rightsSafeAuthorization,
  rightsSafeResultSha256,
}) {
  if (!output.exists) {
    try {
      await mkdir(output.canonical, { mode: 0o700 });
    } catch {
      fail('new output directory could not be created exclusively');
    }
  }
  const outputInfo = await lstat(output.canonical).catch(() => null);
  if (
    !outputInfo
    || outputInfo.isSymbolicLink()
    || !outputInfo.isDirectory()
    || (await realpath(output.canonical)) !== output.canonical
    || (await readdir(output.canonical)).length
  ) {
    fail('output directory changed before staging began');
  }

  const lockPath = join(output.canonical, LOCK_FILENAME);
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch {
    fail('output directory is already being staged or is no longer empty');
  }
  try {
    const entriesWithLock = await readdir(output.canonical);
    if (
      entriesWithLock.length !== 1
      || entriesWithLock[0] !== LOCK_FILENAME
    ) {
      fail('unexpected output content appeared before staging');
    }
    const staged = [];
    for (const source of verified) {
      const destination = join(output.canonical, source.source_reference);
      try {
        await copyFile(
          source.source_path,
          destination,
          fsConstants.COPYFILE_EXCL,
        );
      } catch {
        fail(`staged filename collision: ${source.source_reference}`);
      }
      const destinationInfo = await lstat(destination).catch(() => null);
      const sourceInfoAfterCopy = await lstat(source.source_path)
        .catch(() => null);
      const [sourceDigestAfterCopy, destinationDigest] = await Promise.all([
        sha256File(source.source_path),
        sha256File(destination),
      ]);
      if (
        !destinationInfo
        || destinationInfo.isSymbolicLink()
        || !destinationInfo.isFile()
        || !sourceInfoAfterCopy
        || sourceInfoAfterCopy.isSymbolicLink()
        || !sourceInfoAfterCopy.isFile()
        || dirname(await realpath(source.source_path))
          !== source.source_directory
        || sourceDigestAfterCopy !== source.source_sha256
        || destinationDigest !== source.source_sha256
        || destinationInfo.size !== source.byte_size
      ) {
        fail(`source changed or copy verification failed: ${source.source_reference}`);
      }
      staged.push({
        asset_key: source.asset_key,
        source_origin: source.source_origin,
        source_bucket: source.source_bucket,
        staged_filename: source.source_reference,
        source_sha256: source.source_sha256,
        byte_size: source.byte_size,
      });
    }

    const expectedBeforeReceipt = [
      LOCK_FILENAME,
      ...staged.map((source) => source.staged_filename),
    ].sort((left, right) => left.localeCompare(right));
    const observedBeforeReceipt = (await readdir(output.canonical))
      .sort((left, right) => left.localeCompare(right));
    if (
      JSON.stringify(expectedBeforeReceipt)
      !== JSON.stringify(observedBeforeReceipt)
    ) {
      fail('unexpected output content appeared during staging');
    }

    const receipt = {
      schema_version: RECEIPT_SCHEMA,
      batch_id: batchId,
      pack_sha256: packSha256,
      rights_safe_review_id: rightsSafeAuthorization.review_id,
      rights_safe_review_sha256: rightsSafeAuthorization.review_sha256,
      rights_safe_plan_id: rightsSafeAuthorization.plan_id,
      rights_safe_plan_sha256: rightsSafeAuthorization.plan_sha256,
      rights_safe_sanitizer_result_sha256: rightsSafeResultSha256,
      staged_at: new Date().toISOString(),
      source_count: staged.length,
      sources: staged,
    };
    assertNoAbsolutePaths(receipt);
    const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
    const receiptPath = join(output.canonical, receiptFilename(batchId));
    try {
      await writeFile(receiptPath, serialized, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
    } catch {
      fail('stage receipt could not be written exclusively');
    }
    return {
      receipt,
      receipt_sha256: createHash('sha256').update(serialized).digest('hex'),
    };
  } finally {
    await lock?.close().catch(() => {});
    await rm(lockPath, { force: true });
  }
}

export async function stageVerifiedWeeklyInventory({
  pack,
  packSha256,
  rightsSafePlan,
  rightsSafeReview,
  rawSourceDir,
  pilotSourceDir,
  supplementSourceDir,
  rightsSafeSourceDir,
  repoDir,
  outputDir,
  validateOnly = false,
}) {
  const rightsSafeAuthorization = validateRightsSafeDonorReview({
    pack,
    review: rightsSafeReview,
    plan: rightsSafePlan,
  });
  const sources = validateStagingInventory(pack, rightsSafeAuthorization);
  validateExactWeeklyComposition(sources);
  const expectedPackSha256 = exactSha256(packSha256, 'weekly pack SHA-256');
  const observedPackSha256 = createHash('sha256')
    .update(canonicalStringify(pack))
    .digest('hex');
  if (observedPackSha256 !== expectedPackSha256) {
    fail('weekly pack SHA-256 does not match the supplied inventory');
  }
  const [
    rawRoot,
    pilotRoot,
    supplementRoot,
    rightsSafeRoot,
    repositoryRoot,
  ] = await Promise.all([
    exactDirectory(rawSourceDir, 'raw asset-pack root'),
    exactDirectory(pilotSourceDir, 'pilot sanitizer root'),
    exactDirectory(supplementSourceDir, 'supplement sanitizer root'),
    exactDirectory(
      rightsSafeSourceDir,
      'rights-safe sanitizer root',
    ),
    exactDirectory(repoDir, 'repository root'),
  ]);
  const privateRoots = [
    rawRoot,
    pilotRoot,
    supplementRoot,
    rightsSafeRoot,
  ];
  ensureDistinctPrivateRoots(privateRoots, repositoryRoot);
  const [
    pilotPayload,
    supplementPayload,
    rightsSafeBundle,
    publicRoot,
  ] = await Promise.all([
    sanitizerPayloadDirectory(pilotRoot, 'pilot sanitizer root'),
    sanitizerPayloadDirectory(
      supplementRoot,
      'supplement sanitizer root',
    ),
    rightsSafeSanitizerBundle(
      rightsSafeRoot,
      rightsSafeAuthorization,
    ),
    exactDirectory(
      join(repositoryRoot.canonical, 'public'),
      'repository public root',
    ),
  ]);
  const directories = uniqueDirectories([
    { ...rawRoot, kind: 'raw_asset_pack' },
    { ...pilotPayload, kind: 'pilot_sanitizer' },
    { ...pilotRoot, kind: 'pilot_root' },
    { ...supplementPayload, kind: 'supplement_sanitizer' },
    { ...supplementRoot, kind: 'supplement_root' },
    {
      ...rightsSafeBundle.payload,
      kind: 'rights_safe_sanitizer',
    },
    { ...rightsSafeRoot, kind: 'rights_safe_root' },
    { ...publicRoot, kind: 'repository_public' },
  ]);
  const protectedRoots = [
    ...privateRoots,
    repositoryRoot,
  ];
  const output = await describeOutput(outputDir, protectedRoots);
  const verified = await resolveVerifiedSources(
    sources,
    directories,
    rightsSafeAuthorization,
  );
  const outputRecheck = await describeOutput(outputDir, protectedRoots);
  if (
    output.exists !== outputRecheck.exists
    || pathKey(output.canonical) !== pathKey(outputRecheck.canonical)
  ) {
    fail('output directory changed during source verification');
  }
  if (validateOnly) {
    return {
      schema_version: RECEIPT_SCHEMA,
      status: 'validated',
      batch_id: pack.batch_id,
      pack_sha256: expectedPackSha256,
      source_count: verified.length,
      output_state: output.exists ? 'empty' : 'absent',
      rights_safe_review_id: rightsSafeAuthorization.review_id,
      rights_safe_review_sha256:
        rightsSafeAuthorization.review_sha256,
      rights_safe_sanitizer_result_sha256:
        rightsSafeBundle.result_sha256,
    };
  }
  const staged = await stageFiles({
    output,
    verified,
    batchId: pack.batch_id,
    packSha256: expectedPackSha256,
    rightsSafeAuthorization,
    rightsSafeResultSha256: rightsSafeBundle.result_sha256,
  });
  const finalReceiptFilename = receiptFilename(pack.batch_id);
  const expectedFinal = [
    finalReceiptFilename,
    ...verified.map((source) => source.source_reference),
  ].sort((left, right) => left.localeCompare(right));
  const observedFinal = (await readdir(output.canonical))
    .sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(expectedFinal) !== JSON.stringify(observedFinal)) {
    fail('staged output contains unexpected final content');
  }
  return {
    schema_version: RECEIPT_SCHEMA,
    status: 'staged',
    batch_id: pack.batch_id,
    pack_sha256: expectedPackSha256,
    source_count: verified.length,
    receipt_file: finalReceiptFilename,
    receipt_sha256: staged.receipt_sha256,
    rights_safe_review_id: rightsSafeAuthorization.review_id,
    rights_safe_review_sha256: rightsSafeAuthorization.review_sha256,
    rights_safe_sanitizer_result_sha256:
      rightsSafeBundle.result_sha256,
  };
}

export async function stageFirstKnockWeeklySources(options) {
  const inventory = await loadAuthorizedWeeklyInventory();
  return stageVerifiedWeeklyInventory({
    ...options,
    pack: inventory.pack,
    packSha256: inventory.pack_sha256,
    rightsSafePlan: inventory.rights_safe_plan,
    rightsSafeReview: inventory.rights_safe_review,
    repoDir: options?.repoDir || REPOSITORY_ROOT,
  });
}

function parseArgs(argv) {
  const options = {
    rawSourceDir: process.env.FIRSTKNOCK_RAW_ASSET_DIR || '',
    pilotSourceDir:
      process.env.FIRSTKNOCK_PILOT_SANITIZED_VIDEO_OUTPUT || '',
    supplementSourceDir:
      process.env.FIRSTKNOCK_SUPPLEMENT_SANITIZED_VIDEO_OUTPUT || '',
    rightsSafeSourceDir:
      process.env.FIRSTKNOCK_WEEKLY_RIGHTS_SAFE_VIDEO_OUTPUT || '',
    outputDir: process.env.FIRSTKNOCK_WEEKLY_SOURCE_DIR || '',
    repoDir: process.env.FIRSTKNOCK_REPO_DIR || REPOSITORY_ROOT,
    validateOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--validate-only') {
      options.validateOnly = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) fail(`${value} requires a value`);
    if (value === '--raw-source-dir') options.rawSourceDir = next;
    else if (value === '--pilot-source-dir') options.pilotSourceDir = next;
    else if (value === '--supplement-source-dir') {
      options.supplementSourceDir = next;
    } else if (value === '--rights-safe-source-dir') {
      options.rightsSafeSourceDir = next;
    } else if (value === '--output-dir') options.outputDir = next;
    else if (value === '--repo-dir') options.repoDir = next;
    else fail(`Unknown argument: ${value}`);
    index += 1;
  }
  return options;
}

async function main() {
  const result = await stageFirstKnockWeeklySources(
    parseArgs(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === SCRIPT_PATH
) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
