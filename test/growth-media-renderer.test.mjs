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
const WEEKLY_RIGHTS_SAFE_PACK_PATH = resolve(
  'config',
  'growth-media',
  'firstknock-weekly-rights-safe-seed.json',
);
const LEGACY_WEEKLY_VIDEO_PACK_PATH = resolve(
  'config',
  'growth-media',
  'firstknock-weekly-video-seed.json',
);
const WEEKLY_RIGHTS_SAFE_PLAN_PATH = resolve(
  'config',
  'growth-media',
  'firstknock-weekly-rights-safe-sanitize-plan.json',
);
const WEEKLY_RIGHTS_SAFE_REVIEW_PATH = resolve(
  'config',
  'growth-media',
  'firstknock-weekly-rights-safe-review.json',
);
const VIDEO_PILOT_REVIEW_PATH = resolve(
  'config',
  'growth-media',
  'firstknock-video-pilot-review.json',
);
const VIDEO_SUPPLEMENT_REVIEW_PATH = resolve(
  'config',
  'growth-media',
  'firstknock-video-supplement-review.json',
);

async function starterPack() {
  return JSON.parse(await readFile(PACK_PATH, 'utf8'));
}

async function videoPilotPack() {
  return JSON.parse(await readFile(VIDEO_PILOT_PACK_PATH, 'utf8'));
}

async function weeklyRightsSafePack() {
  return JSON.parse(await readFile(WEEKLY_RIGHTS_SAFE_PACK_PATH, 'utf8'));
}

async function legacyWeeklyVideoPack() {
  return JSON.parse(await readFile(LEGACY_WEEKLY_VIDEO_PACK_PATH, 'utf8'));
}

async function videoSupplementReview() {
  return JSON.parse(await readFile(VIDEO_SUPPLEMENT_REVIEW_PATH, 'utf8'));
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

test('legacy weekly seed remains canonical non-active audit history', async () => {
  const raw = await legacyWeeklyVideoPack();
  const pack = validatePack(clone(raw));
  const pilot = await videoPilotPack();
  const starter = await starterPack();
  const packSha256 = createHash('sha256')
    .update(rendererCanonicalStringify(pack))
    .digest('hex');

  assert.equal(pack.batch_id, 'firstknock-weekly-video-seed-2026-07');
  assert.deepEqual(pack.template, validatePack(clone(pilot)).template);
  assert.deepEqual(pack.output, validatePack(clone(pilot)).output);
  assert.equal(pack.sources.length, 14);
  assert.equal(new Set(pack.sources.map((source) => source.source_sha256)).size, 14);
  assert.equal(
    pack.sources.filter((source) => source.media_kind === 'video').length,
    8,
  );
  assert.equal(
    pack.sources.filter((source) => source.media_kind === 'image').length,
    6,
  );
  assert.equal(
    pack.sources.every((source) => (
      source.privacy_status === 'safe'
      && source.rights_status === 'firstknock_owned'
    )),
    true,
  );
  assert.equal(pack.artifacts.length, 28);
  assert.equal(
    pack.artifacts.every((artifact) => (
      artifact.format === 'video'
      && artifact.distribution_state === 'publish_candidate'
    )),
    true,
  );
  assert.equal(
    pack.artifacts.some(
      (artifact) => artifact.distribution_state === 'sanitized_preview_only',
    ),
    false,
  );

  const concepts = new Map();
  const sourceUsage = new Map();
  for (const artifact of pack.artifacts) {
    const siblings = concepts.get(artifact.concept_id) || [];
    siblings.push(artifact);
    concepts.set(artifact.concept_id, siblings);
    sourceUsage.set(
      artifact.source_asset_key,
      Number(sourceUsage.get(artifact.source_asset_key) || 0) + 1,
    );
    assert.equal(artifact.platform_content_id, artifact.artifact_key);
    assert.equal(
      artifact.cta_url,
      `https://firstknock.online/start?utm_source=${artifact.platform}`
        + '&utm_medium=organic_social&utm_campaign=1000-users'
        + `&utm_content=${artifact.platform_content_id}`,
    );
  }
  assert.equal(concepts.size, 14);
  assert.equal(sourceUsage.size, 14);
  assert.equal([...sourceUsage.values()].every((usage) => usage === 2), true);
  for (const siblings of concepts.values()) {
    assert.equal(siblings.length, 2);
    assert.deepEqual(
      siblings.map((artifact) => artifact.platform).sort(),
      ['instagram', 'tiktok'],
    );
    assert.equal(
      new Set(siblings.map((artifact) => artifact.source_asset_key)).size,
      1,
    );
  }

  const reusableSources = [
    ...pilot.sources,
    ...starter.sources.filter((source) => source.media_kind === 'image'),
  ];
  const weeklySourceByKey = new Map(
    raw.sources.map((source) => [source.asset_key, source]),
  );
  for (const source of reusableSources) {
    assert.deepEqual(weeklySourceByKey.get(source.asset_key), source);
  }
  const reusableArtifacts = [
    ...pilot.artifacts,
    ...starter.artifacts.filter(
      (artifact) => artifact.source_asset_key !== 'analytics-date-picker-demo',
    ),
  ];
  const weeklyArtifactByKey = new Map(
    raw.artifacts.map((artifact) => [artifact.artifact_key, artifact]),
  );
  for (const artifact of reusableArtifacts) {
    const weeklyArtifact = weeklyArtifactByKey.get(artifact.artifact_key);
    assert.ok(weeklyArtifact);
    for (const field of [
      'artifact_key',
      'concept_id',
      'platform',
      'platform_content_id',
      'campaign',
      'title',
      'pillar',
      'format',
      'source_asset_key',
      'hook',
      'overlay_text',
      'shot_list',
      'cta_label',
      'cta_url',
      'overlay_cta',
      'disclosure',
      'render',
    ]) {
      assert.deepEqual(
        weeklyArtifact[field],
        artifact[field],
        `${artifact.artifact_key}.${field} must preserve its trusted donor pair`,
      );
    }
  }

  assert.equal(
    pack.sources.some(
      (source) => source.asset_key === 'analytics-date-picker-demo',
    ),
    false,
  );
  assert.equal(
    pack.sources.some(
      (source) => (
        source.source_sha256
        === 'e341f9bfa3d5027c68981d686c8ff7a219d47bede377f86cca0066ed4ebef78f'
      ),
    ),
    false,
  );
  assert.equal(
    pack.artifacts.some(
      (artifact) => artifact.concept_id === 'fk-ce-pick-a-day-01',
    ),
    false,
  );
  const supplementReview = await videoSupplementReview();
  assert.equal(supplementReview.publication_authorized, false);
  assert.equal(supplementReview.approved_count, 1);
  assert.equal(supplementReview.rejected_count, 2);
  const approvedSupplement = supplementReview.decisions.find(
    (decision) => decision.decision === 'approved_as_safe_donor',
  );
  const supplementalSource = pack.sources.find(
    (source) => source.asset_key === approvedSupplement.asset_key,
  );
  assert.ok(supplementalSource);
  assert.equal(supplementalSource.source_reference, approvedSupplement.source_reference);
  assert.equal(supplementalSource.source_sha256, approvedSupplement.source_sha256);
  assert.equal(supplementalSource.duration_ms, approvedSupplement.duration_ms);
  assert.equal(supplementalSource.privacy_status, 'safe');
  assert.equal(
    supplementReview.decisions
      .filter((decision) => decision.decision === 'rejected')
      .every((decision) => (
        decision.privacy_status === 'blocked'
        && !pack.sources.some((source) => source.asset_key === decision.asset_key)
      )),
    true,
  );

  const settingsSource = pack.sources.find(
    (source) => source.asset_key === 'weekly-generation-settings-safe-v1',
  );
  assert.deepEqual(settingsSource, {
    asset_key: 'weekly-generation-settings-safe-v1',
    source_origin: 'asset_pack',
    source_reference: 'IMG_1421.PNG',
    source_sha256:
      'd9217b244b7761777f77be579608fa328828b9b69ba97d4a3279e0c89d20565b',
    media_kind: 'image',
    mime_type: 'image/png',
    codec: '',
    width: 1206,
    height: 2622,
    duration_ms: 0,
    privacy_status: 'safe',
    rights_status: 'firstknock_owned',
  });
  const settingsArtifacts = pack.artifacts.filter(
    (artifact) => (
      artifact.source_asset_key === 'weekly-generation-settings-safe-v1'
    ),
  );
  for (const artifact of settingsArtifacts) {
    assert.deepEqual(
      artifact.render.crop,
      { x: 60, y: 650, width: 1085, height: 1420 },
    );
    assert.equal(
      artifact.render.crop.x + artifact.render.crop.width <= 1145,
      true,
    );
    assert.equal(
      artifact.render.crop.y + artifact.render.crop.height <= 2070,
      true,
      'the settings crop must exclude the marketing footer below Generate',
    );
    assert.equal(
      artifact.disclosure,
      'DEMO SETTINGS - FIRSTKNOCK PRODUCT VIEW.',
    );
    assert.match(artifact.caption, /property count/i);
    assert.match(artifact.caption, /home-value range/i);
    assert.match(artifact.caption, /sold-window controls/i);
    assert.match(artifact.caption, /Generate/);
  }

  for (const artifact of pack.artifacts) {
    const sentences = artifact.caption.match(/[^.!?]+[.!?]/g)
      ?.map((sentence) => sentence.trim()) || [];
    assert.equal(
      sentences.length,
      3,
      `${artifact.artifact_key} must use problem -> behavior -> benefit`,
    );
    assert.match(
      sentences[0],
      /\b(?:not|hard|harder|hide|rarely|should|without|easier|separate|separated|crowded|same|can|unclear|scattered|apart|change|changes|needs)\b/i,
    );
    assert.match(sentences[1], /\bFirstKnock\b/);
    assert.match(
      sentences[1],
      /\b(?:shows|keeps|places|lets|displays|exposes|groups|puts)\b/i,
    );
    assert.match(
      sentences[2],
      /\b(?:set|see|review|inspect|turn|define|zoom|narrow|select|configure|adjust|move|compare|use|keep|frame|confirm)\b/i,
    );
  }

  const newConceptCopy = pack.artifacts
    .filter((artifact) => artifact.artifact_key.includes('-wv-'))
    .flatMap((artifact) => [
      artifact.title,
      artifact.hook,
      ...artifact.overlay_text,
      ...artifact.shot_list,
      artifact.caption,
      artifact.cta_label,
      artifact.overlay_cta,
    ])
    .join(' ');
  assert.doesNotMatch(
    newConceptCopy,
    /\b(?:better data|more deals|customer|location|address|revenue|conversion|performance|optimi[sz]\w*|faster|time saved)\b/i,
  );
  assert.equal(
    packSha256,
    '1323a3d47f2a92299bb76ad4ee5d352b6af6114a6b136833fda268fdf7bf4eca',
  );
});

test('rights-safe v2 weekly seed binds fourteen reviewed concepts and exact platform pairs', async () => {
  const raw = await weeklyRightsSafePack();
  const pack = validatePack(clone(raw));
  const plan = JSON.parse(
    await readFile(WEEKLY_RIGHTS_SAFE_PLAN_PATH, 'utf8'),
  );
  const review = JSON.parse(
    await readFile(WEEKLY_RIGHTS_SAFE_REVIEW_PATH, 'utf8'),
  );
  const packSha256 = createHash('sha256')
    .update(rendererCanonicalStringify(pack))
    .digest('hex');
  const planSha256 = createHash('sha256')
    .update(rendererCanonicalStringify(plan))
    .digest('hex');
  const expectedConcepts = [
    {
      slug: 'route-start-finish',
      source: 'video-weekly-route-start-finish-rights-safe-v1',
    },
    {
      slug: 'outcome-controls',
      source: 'video-weekly-outcome-controls-rights-safe-v1',
    },
    {
      slug: 'route-command',
      source: 'video-weekly-route-command-overview-rights-safe-v1',
    },
    {
      slug: 'merge-routes',
      source: 'video-weekly-merge-routes-rights-safe-v1',
    },
    {
      slug: 'bulk-reknock',
      source: 'video-weekly-bulk-reknock-rights-safe-v1',
    },
    {
      slug: 'rerun-followups',
      source: 'rerun-route-phone-demo',
    },
    {
      slug: 'add-details',
      source: 'video-weekly-add-details-rights-safe-v1',
    },
    {
      slug: 'sale-correction',
      source: 'video-supplement-remove-accidental-sale-safe-v1',
    },
    {
      slug: 'analytics-date',
      source: 'video-pilot-analytics-date-safe-v1',
    },
    {
      slug: 'manager-funnel',
      source: 'manager-analytics-single-card',
    },
    {
      slug: 'manager-comparison',
      source: 'manager-analytics-comparison',
    },
    {
      slug: 'property-styling',
      source: 'video-weekly-property-styling-rights-safe-v1',
    },
    {
      slug: 'refresh-area',
      source: 'video-weekly-refresh-area-rights-safe-v1',
    },
    {
      slug: 'generation-settings',
      source: 'weekly-generation-settings-safe-v1',
    },
  ];
  const reviewedSourceKeys = [
    'video-weekly-route-start-finish-rights-safe-v1',
    'video-weekly-route-command-overview-rights-safe-v1',
    'video-weekly-merge-routes-rights-safe-v1',
    'video-weekly-bulk-reknock-rights-safe-v1',
    'video-weekly-outcome-controls-rights-safe-v1',
    'video-weekly-add-details-rights-safe-v1',
    'video-weekly-property-styling-rights-safe-v1',
    'video-weekly-refresh-area-rights-safe-v1',
  ];

  assert.equal(
    pack.batch_id,
    'firstknock-weekly-rights-safe-v2-2026-07',
  );
  assert.equal(pack.output.duration_ms, 8000);
  assert.equal(pack.sources.length, 14);
  assert.equal(pack.artifacts.length, 28);
  assert.equal(
    pack.sources.filter((source) => source.media_kind === 'video').length,
    10,
  );
  assert.equal(
    pack.sources.filter((source) => source.media_kind === 'image').length,
    4,
  );
  assert.deepEqual(
    pack.sources.map((source) => source.asset_key),
    expectedConcepts.map((concept) => concept.source),
  );
  assert.equal(new Set(pack.sources.map((source) => source.source_sha256)).size, 14);
  assert.equal(
    pack.sources.every((source) => (
      source.privacy_status === 'safe'
      && source.rights_status === 'firstknock_owned'
    )),
    true,
  );
  assert.deepEqual(
    pack.artifacts.map((artifact) => artifact.artifact_key),
    expectedConcepts.flatMap(({ slug }) => [
      `ig-rs-${slug}-01`,
      `tt-rs-${slug}-01`,
    ]),
  );

  for (const { slug, source } of expectedConcepts) {
    const conceptId = `fk-rs-${slug}-01`;
    const pair = pack.artifacts.filter(
      (artifact) => artifact.concept_id === conceptId,
    );
    assert.deepEqual(
      pair.map((artifact) => artifact.platform),
      ['instagram', 'tiktok'],
    );
    assert.deepEqual(
      pair.map((artifact) => artifact.source_asset_key),
      [source, source],
    );
  }
  for (const artifact of pack.artifacts.filter(
    (candidate) => candidate.concept_id === 'fk-rs-route-command-01',
  )) {
    assert.deepEqual(
      artifact.render.crop,
      { x: 20, y: 890, width: 630, height: 560 },
      'the final card must omit the donor edge containing the clipped control',
    );
  }
  const routeCommandInstagram = pack.artifacts.find(
    (artifact) => artifact.artifact_key === 'ig-rs-route-command-01',
  );
  assert.match(routeCommandInstagram.caption, /demo route count/i);
  assert.doesNotMatch(routeCommandInstagram.caption, /\btabs?\b|delete all/i);
  for (const artifact of pack.artifacts.filter(
    (candidate) => candidate.concept_id === 'fk-rs-generation-settings-01',
  )) {
    assert.deepEqual(
      artifact.render.crop,
      { x: 60, y: 430, width: 1085, height: 1770 },
      'the settings modal must start above the complete header and end before the footer',
    );
  }
  for (const artifact of pack.artifacts) {
    assert.equal(artifact.format, 'video');
    assert.equal(artifact.distribution_state, 'publish_candidate');
    assert.equal(artifact.platform_content_id, artifact.artifact_key);
    assert.equal(
      artifact.cta_url,
      `https://firstknock.online/start?utm_source=${artifact.platform}`
        + '&utm_medium=organic_social&utm_campaign=1000-users'
        + `&utm_content=${artifact.platform_content_id}`,
    );
    const blocks = artifact.caption
      .split(/\n{2,}/)
      .map((block) => block.trim())
      .filter(Boolean);
    assert.equal(blocks.length, 5, `${artifact.artifact_key} provider blocks`);
    assert.equal(
      blocks.slice(0, 3).every(
        (block) => (block.match(/[.!?]/g) || []).length === 1,
      ),
      true,
      `${artifact.artifact_key} must keep one sentence per semantic block`,
    );
    assert.match(blocks[1], /\bFirstKnock\b/);
    assert.equal(blocks[3], artifact.disclosure);
    assert.equal(
      blocks[4],
      artifact.platform === 'tiktok'
        ? artifact.cta_label
        : `${artifact.cta_label}: ${artifact.cta_url}`,
    );
  }

  for (const artifact of pack.artifacts.filter(
    (candidate) => candidate.platform === 'tiktok',
  )) {
    const blocks = artifact.caption.split(/\n{2,}/);
    assert.equal(blocks[0].length <= 280, true, `${artifact.artifact_key}.problem`);
    assert.equal(
      blocks[1].length <= 400,
      true,
      `${artifact.artifact_key}.visible_feature_behavior`,
    );
    assert.equal(
      blocks[2].length <= 280,
      true,
      `${artifact.artifact_key}.practical_benefit`,
    );
    assert.equal(artifact.disclosure, 'Product demo.');
    assert.equal(blocks[3], 'Product demo.');
    assert.equal(blocks[4], artifact.cta_label);
    assert.equal(artifact.caption.length <= 2200, true);
    assert.doesNotMatch(artifact.caption, /https?:\/\//i);
  }

  assert.equal(review.schema_version, 'firstknock-video-derivative-review.v1');
  assert.equal(review.plan_id, plan.plan_id);
  assert.equal(review.plan_sha256, planSha256);
  assert.equal(review.approved_count, 8);
  assert.equal(review.rejected_count, 0);
  assert.equal(review.publication_authorized, false);
  assert.deepEqual(
    review.decisions.map((decision) => decision.asset_key),
    reviewedSourceKeys,
  );
  assert.equal(
    review.decisions.every((decision) => (
      decision.decision === 'approved_as_safe_donor'
      && decision.privacy_status === 'safe'
    )),
    true,
  );
  const sourceByKey = new Map(
    pack.sources.map((source) => [source.asset_key, source]),
  );
  for (const decision of review.decisions) {
    const source = sourceByKey.get(decision.asset_key);
    assert.ok(source);
    assert.equal(source.source_reference, decision.source_reference);
    assert.equal(source.source_sha256, decision.source_sha256);
    assert.equal(source.duration_ms, decision.duration_ms);
  }

  const supplementReview = await videoSupplementReview();
  const supplementDecision = supplementReview.decisions.find(
    (decision) => decision.decision === 'approved_as_safe_donor',
  );
  const supplementSource = sourceByKey.get(supplementDecision.asset_key);
  assert.ok(supplementSource);
  assert.equal(supplementSource.source_reference, supplementDecision.source_reference);
  assert.equal(supplementSource.source_sha256, supplementDecision.source_sha256);
  assert.equal(supplementSource.duration_ms, supplementDecision.duration_ms);

  const imageSourceKeys = new Set([
    'manager-analytics-single-card',
    'manager-analytics-comparison',
    'rerun-route-phone-demo',
    'weekly-generation-settings-safe-v1',
  ]);
  assert.equal(
    pack.artifacts
      .filter((artifact) => imageSourceKeys.has(artifact.source_asset_key))
      .every((artifact) => artifact.render.duration_ms === 8000),
    true,
  );
  assert.equal(
    pack.artifacts
      .filter(
        (artifact) => artifact.source_asset_key === 'video-pilot-analytics-date-safe-v1',
      )
      .every((artifact) => artifact.render.duration_ms === 10000),
    true,
  );
  assert.equal(
    pack.artifacts
      .filter(
        (artifact) => (
          artifact.source_asset_key
          === 'video-supplement-remove-accidental-sale-safe-v1'
        ),
      )
      .every((artifact) => artifact.render.duration_ms === 6500),
    true,
  );

  const instagramByConcept = new Map(
    pack.artifacts
      .filter((artifact) => artifact.platform === 'instagram')
      .map((artifact) => [artifact.concept_id, artifact.caption]),
  );
  assert.doesNotMatch(
    instagramByConcept.get('fk-rs-merge-routes-01'),
    /\b(?:handoff|merged successfully|merge completed)\b/i,
  );
  assert.doesNotMatch(
    instagramByConcept.get('fk-rs-bulk-reknock-01'),
    /\b(?:moved successfully|update completed|finished updating)\b/i,
  );
  assert.doesNotMatch(
    instagramByConcept.get('fk-rs-sale-correction-01'),
    /\b(?:deleted successfully|sale deleted|correction completed)\b/i,
  );
  assert.doesNotMatch(
    instagramByConcept.get('fk-rs-manager-comparison-01'),
    /\bteam averages?\b|\bFirstKnock compares\b/i,
  );
  assert.doesNotMatch(
    instagramByConcept.get('fk-rs-property-styling-01'),
    /\b(?:map|Apple|Google|satellite|geography|color scheme)\b/i,
  );

  assert.equal(
    packSha256,
    '00e06013561a34a7fc59a7be75093c262a78f83b52d5dff0371b1fdf30bd79d0',
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
    'conversion_evidence_hash',
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
  assert.deepEqual(schema.properties.review_schema_version.enum, [
    'growth-review.v2',
    'growth-review.v3',
  ]);
  assert.equal(schema.properties.conversion_cutoff_at.format, 'date-time');
  assert.equal(
    Object.keys(schema.properties).some(
      (field) => /(api.?key|worker.?secret|buffer.?token)/i.test(field),
    ),
    false,
  );
});

test('active dashboard registry matches v2 while inactive audit history stays excluded', async () => {
  const weekly = validatePack(await weeklyRightsSafePack());
  const activeRegistry = FIRSTKNOCK_AUDITED_SOURCES.filter(
    (source) => source.active === true,
  );
  const inactiveRegistry = FIRSTKNOCK_AUDITED_SOURCES.filter(
    (source) => source.active !== true,
  );
  const weeklySourceByKey = new Map(
    weekly.sources.map((source) => [source.asset_key, source]),
  );
  assert.equal(activeRegistry.length, 14);
  assert.equal(weeklySourceByKey.size, 14);
  for (const source of activeRegistry) {
    const weeklySource = weeklySourceByKey.get(source.asset_key);
    assert.ok(weeklySource, `${source.asset_key} must be in the v2 pack`);
    assert.equal(weeklySource.source_reference, source.source_reference);
    assert.equal(weeklySource.source_sha256, source.source_sha256);
    assert.equal(weeklySource.media_kind, source.media_kind);
    assert.equal(weeklySource.mime_type, source.mime_type);
    assert.equal(weeklySource.width, source.width);
    assert.equal(weeklySource.height, source.height);
    if (source.media_kind === 'video') {
      assert.equal(weeklySource.duration_ms, source.duration_ms);
    }
  }
  assert.equal(
    inactiveRegistry.every(
      (source) => !weeklySourceByKey.has(source.asset_key),
    ),
    true,
  );
  assert.equal(
    [
      'video-pilot-route-start-finish-safe-v1',
      'video-pilot-route-optimize-safe-v1',
      'video-pilot-territory-filters-safe-v1',
      'video-pilot-multi-route-map-safe-v1',
      'video-pilot-route-filtering-safe-v1',
      'video-pilot-map-settings-safe-v1',
      'manager-leaderboard-mobile',
      'route-handoff-og',
    ].every(
      (assetKey) => inactiveRegistry.some(
        (source) => source.asset_key === assetKey,
      ),
    ),
    true,
  );
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

test('renderer keeps the hook and CTA fully visible on edge frames', async () => {
  const rendererSource = await readFile(
    resolve('scripts', 'render-growth-pack.mjs'),
    'utf8',
  );
  assert.doesNotMatch(rendererSource, /fade=t=(?:in|out)/);
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

test('weekly seed completes full validate-only preflight with private fixture bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'firstknock-weekly-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, 'sources');
  const outputDir = join(root, 'output');
  const raw = await weeklyRightsSafePack();

  for (const source of raw.sources) {
    const bytes = Buffer.from(`weekly-private-fixture:${source.asset_key}`);
    const fixtureRoot = source.source_origin === 'repository_public'
      ? join(root, 'public')
      : sourceDir;
    await mkdir(fixtureRoot, { recursive: true });
    await writeFile(join(fixtureRoot, source.source_reference), bytes);
    source.source_sha256 = createHash('sha256').update(bytes).digest('hex');
  }
  const manifestPath = join(root, 'weekly-pack.json');
  await writeFile(manifestPath, `${JSON.stringify(raw)}\n`);

  const result = await renderPack({
    manifestPath,
    sourceDir,
    outputDir,
    repoDir: root,
    validateOnly: true,
  });
  assert.equal(result.status, 'validated');
  assert.equal(result.source_count, 14);
  assert.equal(result.artifact_count, 28);
  assert.equal(JSON.stringify(result).includes(root), false);
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
  assert.equal(left.renderer.profile_id, 'firstknock-h264-bitexact-v3');
  assert.match(left.renderer.environment_sha256, /^[a-f0-9]{64}$/);
  assert.equal(left.pack.schema_version, 'growth-render-pack.v1');
  assert.equal(
    createHash('sha256')
      .update(rendererCanonicalStringify(left.pack))
      .digest('hex'),
    left.pack_sha256,
  );
});
