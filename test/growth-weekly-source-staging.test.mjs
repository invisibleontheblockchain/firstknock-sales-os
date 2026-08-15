import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  canonicalStringify,
  validatePack,
} from '../scripts/render-growth-pack.mjs';
import {
  WEEKLY_PACK_AUTHORIZATION,
  loadAuthorizedWeeklyInventory,
  stageVerifiedWeeklyInventory,
  validateActiveWeeklyRegistry,
} from '../scripts/stage-growth-weekly-sources.mjs';

const FIXTURE_TEMPLATE_PATH = resolve(
  'config',
  'growth-media',
  'firstknock-weekly-video-seed.json',
);
const BATCH_ID = 'firstknock-weekly-rights-safe-v2-2026-07';
const RECEIPT_FILENAME = `${BATCH_ID}.source-stage-receipt.json`;
const RELEASE_GATE =
  'blocked_until_sanitized_derivative_hash_and_frame_review';
const RIGHTS_SAFE_KEYS = [
  'video-weekly-route-start-finish-rights-safe-v1',
  'video-weekly-route-command-overview-rights-safe-v1',
  'video-weekly-merge-routes-rights-safe-v1',
  'video-weekly-bulk-reknock-rights-safe-v1',
  'video-weekly-outcome-controls-rights-safe-v1',
  'video-weekly-add-details-rights-safe-v1',
  'video-weekly-property-styling-rights-safe-v1',
  'video-weekly-refresh-area-rights-safe-v1',
];
const RIGHTS_SAFE_KEY_SET = new Set(RIGHTS_SAFE_KEYS);

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function bucket(source) {
  if (source.source_origin === 'repository_public') {
    return 'repository_public';
  }
  if (source.media_kind === 'image') return 'raw_asset_pack';
  if (RIGHTS_SAFE_KEY_SET.has(source.asset_key)) {
    return 'rights_safe_sanitizer';
  }
  if (source.asset_key.startsWith('video-pilot-')) {
    return 'pilot_sanitizer';
  }
  return 'supplement_sanitizer';
}

function makeRightsSafePack(rawPack) {
  rawPack.batch_id = BATCH_ID;
  const candidates = [
    ...rawPack.sources.filter((source) => (
      source.media_kind === 'video'
      && source.asset_key !== 'video-pilot-analytics-date-safe-v1'
      && source.asset_key
        !== 'video-supplement-remove-accidental-sale-safe-v1'
    )),
    ...rawPack.sources.filter((source) => (
      source.asset_key === 'manager-analytics-single-card'
      || source.asset_key === 'manager-leaderboard-mobile'
    )),
  ];
  assert.equal(candidates.length, RIGHTS_SAFE_KEYS.length);
  candidates.forEach((source, index) => {
    const oldKey = source.asset_key;
    const newKey = RIGHTS_SAFE_KEYS[index];
    const wasImage = source.media_kind === 'image';
    source.asset_key = newKey;
    source.source_origin = 'asset_pack';
    source.media_kind = 'video';
    source.mime_type = 'video/mp4';
    source.codec = 'h264';
    source.width = 1080;
    source.height = 1920;
    if (wasImage) source.duration_ms = 10021;
    for (const artifact of rawPack.artifacts) {
      if (artifact.source_asset_key !== oldKey) continue;
      artifact.source_asset_key = newKey;
      if (wasImage) {
        artifact.render = {
          duration_ms: 10000,
          trim_start_ms: 0,
          trim_end_ms: 10000,
        };
      }
    }
  });
  return rawPack;
}

function rightsSafePlan() {
  return {
    schema_version: 'firstknock-video-sanitize-plan.v1',
    plan_id: 'firstknock-weekly-rights-safe-8-donor-2026-07',
    purpose: 'Deterministic staging fixture for eight reviewed donors.',
    assets: RIGHTS_SAFE_KEYS.map((assetKey) => ({
      safe_derived_asset_key: assetKey,
      rights_status: 'firstknock_owned',
      release_state: RELEASE_GATE,
    })),
  };
}

function rightsSafeReview(pack, plan, bytesByKey) {
  const planSha256 = hash(canonicalStringify(plan));
  return {
    schema_version: 'firstknock-video-derivative-review.v1',
    review_id: 'firstknock-weekly-rights-safe-review-test',
    plan_id: plan.plan_id,
    plan_sha256: planSha256,
    sanitizer_environment_sha256: 'a'.repeat(64),
    sanitizer_script_sha256: 'b'.repeat(64),
    reviewed_at: '2026-07-29T12:00:00.000Z',
    review_scope:
      'Private staging donor review only; no publication authorization.',
    review_method: ['Every-frame fixture review.'],
    approved_count: 8,
    rejected_count: 0,
    publication_authorized: false,
    decisions: RIGHTS_SAFE_KEYS.map((assetKey) => {
      const source = pack.sources.find(
        (candidate) => candidate.asset_key === assetKey,
      );
      return {
        asset_key: assetKey,
        decision: 'approved_as_safe_donor',
        source_reference: source.source_reference,
        source_sha256: source.source_sha256,
        duration_ms: source.duration_ms,
        byte_size: bytesByKey.get(assetKey).length,
        privacy_status: 'safe',
        review_note: 'Fixture donor is approved for private staging.',
      };
    }),
  };
}

function sanitizerResult(pack, plan, review, bytesByKey) {
  return {
    schema_version: 'growth-video-sanitize-result.v1',
    plan_schema_version: plan.schema_version,
    plan_id: plan.plan_id,
    plan_sha256: review.plan_sha256,
    release_state: RELEASE_GATE,
    output_profile: {
      width: 1080,
      height: 1920,
      fps: 30,
    },
    sanitizer: {
      profile_id: 'firstknock-video-sanitizer-v1',
      script_sha256: review.sanitizer_script_sha256,
      environment_sha256: review.sanitizer_environment_sha256,
    },
    source_count: 8,
    sources: RIGHTS_SAFE_KEYS.map((assetKey) => {
      const source = pack.sources.find(
        (candidate) => candidate.asset_key === assetKey,
      );
      return {
        asset_key: assetKey,
        rights_status: 'firstknock_owned',
        release_state: RELEASE_GATE,
        privacy_status: 'redaction_required',
        active: false,
        source_reference: source.source_reference,
        source_sha256: source.source_sha256,
        delivery_key: `sha256/${source.source_reference}`,
        media_kind: 'video',
        mime_type: 'video/mp4',
        codec: 'h264',
        width: 1080,
        height: 1920,
        duration_ms: source.duration_ms,
        byte_size: bytesByKey.get(assetKey).length,
      };
    }),
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'firstknock-weekly-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = {
    root,
    raw: join(root, 'raw'),
    pilot: join(root, 'pilot'),
    pilotPayload: join(root, 'pilot', 'sha256'),
    supplement: join(root, 'supplement'),
    supplementPayload: join(root, 'supplement', 'sha256'),
    rightsSafe: join(root, 'rights-safe'),
    rightsSafePayload: join(root, 'rights-safe', 'sha256'),
    repo: join(root, 'repo'),
    public: join(root, 'repo', 'public'),
    output: join(root, 'weekly-output'),
  };
  await Promise.all([
    mkdir(paths.raw),
    mkdir(paths.pilotPayload, { recursive: true }),
    mkdir(paths.supplementPayload, { recursive: true }),
    mkdir(paths.rightsSafePayload, { recursive: true }),
    mkdir(paths.public, { recursive: true }),
  ]);

  const rawPack = makeRightsSafePack(
    JSON.parse(await readFile(FIXTURE_TEMPLATE_PATH, 'utf8')),
  );
  const bytesByKey = new Map();
  for (const [index, source] of rawPack.sources.entries()) {
    const extension = extname(source.source_reference).toLowerCase();
    const bytes = Buffer.from(`audited-weekly-fixture:${source.asset_key}`);
    const digest = hash(bytes);
    const filename = RIGHTS_SAFE_KEY_SET.has(source.asset_key)
      ? `${digest}-${source.asset_key}.mp4`
      : `fixture-${String(index + 1).padStart(2, '0')}${extension}`;
    source.source_reference = filename;
    source.source_sha256 = digest;
    bytesByKey.set(source.asset_key, bytes);
  }
  const pack = validatePack(rawPack);
  for (const source of pack.sources) {
    const directory = {
      raw_asset_pack: paths.raw,
      pilot_sanitizer: paths.pilotPayload,
      supplement_sanitizer: paths.supplementPayload,
      rights_safe_sanitizer: paths.rightsSafePayload,
      repository_public: paths.public,
    }[bucket(source)];
    await writeFile(
      join(directory, source.source_reference),
      bytesByKey.get(source.asset_key),
    );
  }
  await writeFile(
    join(paths.supplementPayload, 'rejected-supplement-donor.mp4'),
    'must-never-be-staged',
  );
  const plan = rightsSafePlan();
  const review = rightsSafeReview(pack, plan, bytesByKey);
  const result = sanitizerResult(pack, plan, review, bytesByKey);
  const resultPath = join(
    paths.rightsSafe,
    `${plan.plan_id}.sanitize-result.json`,
  );
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  return {
    pack,
    packSha256: hash(canonicalStringify(pack)),
    bytesByKey,
    plan,
    review,
    result,
    resultPath,
    paths,
  };
}

function options(item, patch = {}) {
  return {
    pack: item.pack,
    packSha256: item.packSha256,
    rightsSafePlan: item.plan,
    rightsSafeReview: item.review,
    rawSourceDir: item.paths.raw,
    pilotSourceDir: item.paths.pilot,
    supplementSourceDir: item.paths.supplement,
    rightsSafeSourceDir: item.paths.rightsSafe,
    repoDir: item.paths.repo,
    outputDir: item.paths.output,
    ...patch,
  };
}

function sourcePath(item, source) {
  const sourceBucket = bucket(source);
  const directory = {
    raw_asset_pack: item.paths.raw,
    pilot_sanitizer: item.paths.pilotPayload,
    supplement_sanitizer: item.paths.supplementPayload,
    rights_safe_sanitizer: item.paths.rightsSafePayload,
    repository_public: item.paths.public,
  }[sourceBucket];
  return join(directory, source.source_reference);
}

async function writeResult(item, result) {
  await writeFile(item.resultPath, `${JSON.stringify(result, null, 2)}\n`);
}

test('production authorization binds the exact reviewed v2 pack SHA', async () => {
  assert.equal(
    WEEKLY_PACK_AUTHORIZATION.pack_sha256,
    '00e06013561a34a7fc59a7be75093c262a78f83b52d5dff0371b1fdf30bd79d0',
  );
  const inventory = await loadAuthorizedWeeklyInventory();
  assert.equal(
    inventory.pack_sha256,
    WEEKLY_PACK_AUTHORIZATION.pack_sha256,
  );
  assert.equal(inventory.pack.batch_id, BATCH_ID);
  assert.equal(inventory.pack.sources.length, 14);
  assert.equal(inventory.pack.artifacts.length, 28);
  assert.equal(
    inventory.sources.filter((source) => source.media_kind === 'video').length,
    10,
  );
  assert.equal(
    inventory.sources.filter((source) => source.media_kind === 'image').length,
    4,
  );
  assert.equal(
    inventory.sources.filter(
      (source) => source.source_bucket === 'rights_safe_sanitizer',
    ).length,
    8,
  );
});

test('inactive registry history is ignored while active sources stay exact', async (t) => {
  const item = await fixture(t);
  const registry = item.pack.sources.map((source) => ({
    ...source,
    active: true,
  }));
  registry.push({
    ...registry[0],
    asset_key: 'inactive-map-rights-history',
    source_reference: 'inactive-history.mp4',
    source_sha256: 'f'.repeat(64),
    active: false,
  });
  assert.equal(validateActiveWeeklyRegistry(item.pack, registry).length, 14);

  registry[0].active = false;
  await assert.rejects(
    async () => validateActiveWeeklyRegistry(item.pack, registry),
    /active audited-source registry diverged/,
  );
});

test('validate-only is write-free and staging creates one bound flat inventory', async (t) => {
  const item = await fixture(t);
  const validated = await stageVerifiedWeeklyInventory(options(item, {
    validateOnly: true,
  }));
  assert.deepEqual(
    {
      status: validated.status,
      source_count: validated.source_count,
      output_state: validated.output_state,
      review_id: validated.rights_safe_review_id,
    },
    {
      status: 'validated',
      source_count: 14,
      output_state: 'absent',
      review_id: item.review.review_id,
    },
  );
  assert.match(
    validated.rights_safe_review_sha256,
    /^[a-f0-9]{64}$/,
  );
  assert.match(
    validated.rights_safe_sanitizer_result_sha256,
    /^[a-f0-9]{64}$/,
  );
  await assert.rejects(() => access(item.paths.output), /ENOENT/);

  const result = await stageVerifiedWeeklyInventory(options(item));
  assert.equal(result.status, 'staged');
  assert.equal(result.source_count, 14);
  assert.equal(result.receipt_file, RECEIPT_FILENAME);
  assert.match(result.receipt_sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes(item.paths.root), false);

  const entries = await readdir(item.paths.output);
  assert.equal(entries.length, 15);
  assert.equal(entries.includes(RECEIPT_FILENAME), true);
  assert.equal(entries.includes('rejected-supplement-donor.mp4'), false);
  const receipt = JSON.parse(await readFile(
    join(item.paths.output, RECEIPT_FILENAME),
    'utf8',
  ));
  assert.equal(
    receipt.schema_version,
    'firstknock-weekly-source-stage-receipt.v2',
  );
  assert.equal(receipt.source_count, 14);
  assert.equal(receipt.pack_sha256, item.packSha256);
  assert.equal(receipt.rights_safe_review_id, item.review.review_id);
  assert.equal(
    receipt.rights_safe_plan_sha256,
    item.review.plan_sha256,
  );
  assert.equal(
    receipt.rights_safe_review_sha256,
    result.rights_safe_review_sha256,
  );
  assert.equal(
    receipt.rights_safe_sanitizer_result_sha256,
    result.rights_safe_sanitizer_result_sha256,
  );
  assert.equal(JSON.stringify(receipt).includes(item.paths.root), false);
  assert.equal(
    receipt.sources.every((source) => (
      !source.staged_filename.includes('/')
      && !source.staged_filename.includes('\\')
    )),
    true,
  );
  assert.equal(
    receipt.sources.filter(
      (source) => source.source_bucket === 'rights_safe_sanitizer',
    ).length,
    8,
  );
  for (const source of item.pack.sources) {
    assert.equal(
      hash(await readFile(join(item.paths.output, source.source_reference))),
      source.source_sha256,
    );
  }

  await assert.rejects(
    () => stageVerifiedWeeklyInventory(options(item)),
    /new or empty/,
  );
});

test('an existing empty private output is accepted exactly once', async (t) => {
  const item = await fixture(t);
  await mkdir(item.paths.output);
  const result = await stageVerifiedWeeklyInventory(options(item));
  assert.equal(result.status, 'staged');
  assert.equal((await readdir(item.paths.output)).length, 15);
});

test('rights-safe review and sanitizer-result gates fail closed', async (t) => {
  await t.test('missing review', async (subtest) => {
    const item = await fixture(subtest);
    await assert.rejects(
      () => stageVerifiedWeeklyInventory(options(item, {
        rightsSafeReview: undefined,
        validateOnly: true,
      })),
      /rights-safe derivative review must be an object/,
    );
  });

  await t.test('pending review decision', async (subtest) => {
    const item = await fixture(subtest);
    const review = structuredClone(item.review);
    review.approved_count = 7;
    review.decisions[0].decision = 'pending';
    await assert.rejects(
      () => stageVerifiedWeeklyInventory(options(item, {
        rightsSafeReview: review,
        validateOnly: true,
      })),
      /missing, pending, or incomplete/,
    );
  });

  await t.test('review hash diverges from pack source', async (subtest) => {
    const item = await fixture(subtest);
    const review = structuredClone(item.review);
    review.decisions[0].source_sha256 = '0'.repeat(64);
    review.decisions[0].source_reference =
      `${'0'.repeat(64)}-${review.decisions[0].asset_key}.mp4`;
    await assert.rejects(
      () => stageVerifiedWeeklyInventory(options(item, {
        rightsSafeReview: review,
        validateOnly: true,
      })),
      /weekly pack source diverged/,
    );
  });

  await t.test('review plan binding changed', async (subtest) => {
    const item = await fixture(subtest);
    const plan = structuredClone(item.plan);
    plan.purpose = 'changed after review';
    await assert.rejects(
      () => stageVerifiedWeeklyInventory(options(item, {
        rightsSafePlan: plan,
        validateOnly: true,
      })),
      /does not bind the exact checked-in sanitizer plan/,
    );
  });

  await t.test('missing sanitizer result', async (subtest) => {
    const item = await fixture(subtest);
    await rm(item.resultPath);
    await assert.rejects(
      () => stageVerifiedWeeklyInventory(options(item, {
        validateOnly: true,
      })),
      /rights-safe sanitizer result must be one bounded regular JSON file/,
    );
  });

  await t.test('sanitizer environment changed', async (subtest) => {
    const item = await fixture(subtest);
    const result = structuredClone(item.result);
    result.sanitizer.environment_sha256 = 'c'.repeat(64);
    await writeResult(item, result);
    await assert.rejects(
      () => stageVerifiedWeeklyInventory(options(item, {
        validateOnly: true,
      })),
      /reviewed environment diverged/,
    );
  });

  await t.test('reviewed byte size changed', async (subtest) => {
    const item = await fixture(subtest);
    const review = structuredClone(item.review);
    const result = structuredClone(item.result);
    review.decisions[0].byte_size += 1;
    result.sources[0].byte_size += 1;
    await writeResult(item, result);
    await assert.rejects(
      () => stageVerifiedWeeklyInventory(options(item, {
        rightsSafeReview: review,
        validateOnly: true,
      })),
      /Reviewed source byte-size mismatch/,
    );
  });

  await t.test('sha256 child cannot replace explicit sanitizer root', async (subtest) => {
    const item = await fixture(subtest);
    await assert.rejects(
      () => stageVerifiedWeeklyInventory(options(item, {
        rightsSafeSourceDir: item.paths.rightsSafePayload,
        validateOnly: true,
      })),
      /explicit output root, not its sha256 child/,
    );
  });
});

test('staging fails closed on source and output boundary violations', async (t) => {
  await t.test('missing source', async (subtest) => {
    const item = await fixture(subtest);
    await rm(sourcePath(item, item.pack.sources[0]));
    await assert.rejects(
      () => stageVerifiedWeeklyInventory(options(item, {
        validateOnly: true,
      })),
      /Missing audited weekly source/,
    );
  });

  await t.test('changed source hash', async (subtest) => {
    const item = await fixture(subtest);
    await writeFile(
      sourcePath(item, item.pack.sources[0]),
      'changed-after-audit',
    );
    await assert.rejects(
      () => stageVerifiedWeeklyInventory(options(item, {
        validateOnly: true,
      })),
      /Source SHA-256 mismatch/,
    );
  });

  await t.test('duplicate source across explicit roots', async (subtest) => {
    const item = await fixture(subtest);
    const source = item.pack.sources.find(
      (candidate) => RIGHTS_SAFE_KEY_SET.has(candidate.asset_key),
    );
    await writeFile(
      join(item.paths.raw, source.source_reference),
      item.bytesByKey.get(source.asset_key),
    );
    await assert.rejects(
      () => stageVerifiedWeeklyInventory(options(item, {
        validateOnly: true,
      })),
      /Duplicate audited weekly source/,
    );
  });

  await t.test('source in the wrong root', async (subtest) => {
    const item = await fixture(subtest);
    const source = item.pack.sources.find(
      (candidate) => candidate.media_kind === 'image'
        && candidate.source_origin === 'asset_pack',
    );
    await rename(
      sourcePath(item, source),
      join(item.paths.supplementPayload, source.source_reference),
    );
    await assert.rejects(
      () => stageVerifiedWeeklyInventory(options(item, {
        validateOnly: true,
      })),
      /wrong explicit input root/,
    );
  });

  await t.test('source symlink', async (subtest) => {
    const item = await fixture(subtest);
    const source = item.pack.sources.find(
      (candidate) => candidate.media_kind === 'image'
        && candidate.source_origin === 'asset_pack',
    );
    const path = sourcePath(item, source);
    const target = join(item.paths.root, 'symlink-target.bin');
    await writeFile(target, item.bytesByKey.get(source.asset_key));
    await rm(path);
    try {
      await symlink(target, path, 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code)) {
        subtest.diagnostic(
          'File symlinks unavailable; runtime rejection remains implemented.',
        );
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => stageVerifiedWeeklyInventory(options(item, {
        validateOnly: true,
      })),
      /never a symlink/,
    );
  });

  await t.test('nonempty output', async (subtest) => {
    const item = await fixture(subtest);
    await mkdir(item.paths.output);
    await writeFile(join(item.paths.output, 'keep.txt'), 'preserve me');
    await assert.rejects(
      () => stageVerifiedWeeklyInventory(options(item)),
      /new or empty/,
    );
    assert.equal(
      await readFile(join(item.paths.output, 'keep.txt'), 'utf8'),
      'preserve me',
    );
    assert.deepEqual(await readdir(item.paths.output), ['keep.txt']);
  });

  await t.test('path traversal and flat filename collision', async (subtest) => {
    const item = await fixture(subtest);
    const traversal = structuredClone(item.pack);
    traversal.sources[0].source_reference = '../escaped.mp4';
    await assert.rejects(
      () => stageVerifiedWeeklyInventory(options(item, {
        pack: traversal,
        validateOnly: true,
      })),
      /weekly pack source diverged|opaque JPG, PNG, or MP4 filename/,
    );

    const collision = structuredClone(item.pack);
    collision.sources[1].source_reference =
      collision.sources[0].source_reference.toUpperCase();
    await assert.rejects(
      () => stageVerifiedWeeklyInventory(options(item, {
        pack: collision,
        validateOnly: true,
      })),
      /review decisions.*weekly pack source diverged|source references must be unique/,
    );
  });

  await t.test('pack SHA mismatch', async (subtest) => {
    const item = await fixture(subtest);
    await assert.rejects(
      () => stageVerifiedWeeklyInventory(options(item, {
        packSha256: '0'.repeat(64),
        validateOnly: true,
      })),
      /does not match the supplied inventory/,
    );
  });
});
