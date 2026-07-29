import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  createGrowthBase44,
  growthHelpers,
  invokeJson,
  loadGrowthHandler,
} from './helpers/growthContentTestHarness.mjs';
import { validatePack } from '../scripts/render-growth-pack.mjs';

const managePath = 'base44/functions/manageGrowthContentEngine/entry.ts';
const entityNames = [
  'GrowthSourceAsset',
  'GrowthCreativeArtifact',
  'GrowthPublishJob',
  'GrowthPublishHeartbeat',
  'GrowthContentBatch',
];

const safeSource = {
  asset_key: 'safe-product-proof',
  title: 'Safe product proof',
  source_reference: 'safe.png',
  source_sha256: '9'.repeat(64),
  media_kind: 'image',
  mime_type: 'image/png',
  width: 1080,
  height: 1920,
  privacy_status: 'safe',
  safe_summary: 'A sanitized FirstKnock product workflow with demo data.',
  active: true,
};

const draftInput = {
  concept_id: 'manager-proof-01',
  campaign: '1000-users',
  platform: 'instagram',
  platform_content_id: 'ig-manager-proof-01',
  title: 'Coach the behavior, not just the total',
  pillar: 'Manager coaching',
  format: 'photo',
  source_asset_keys: ['safe-product-proof'],
  hook: 'Doors do not explain the gap',
  caption: 'FirstKnock gives managers the context behind activity. Demo data shown.',
  overlay_text: ['Doors do not explain the gap'],
  shot_list: ['Show the sanitized analytics card'],
  cta_label: 'Try FirstKnock',
  cta_url: 'https://firstknock.online',
  disclosure: 'Demo data shown.',
  media_url: `https://media.firstknock.online/sha256/${'a'.repeat(64)}-manager-proof.png`,
  media_sha256: 'a'.repeat(64),
  mime_type: 'image/png',
  width: 1080,
  height: 1920,
};

const env = {
  GROWTH_PUBLISH_WORKER_SECRET: 'worker-secret-that-is-at-least-32-characters',
  GROWTH_PUBLISH_ENABLED: 'true',
  BUFFER_API_KEY: 'buffer-api-token-used-only-by-tests',
  BUFFER_ORGANIZATION_ID: 'org_firstknock',
  BUFFER_INSTAGRAM_CHANNEL_ID: 'channel_instagram',
  BUFFER_TIKTOK_CHANNEL_ID: 'channel_tiktok',
  GROWTH_MEDIA_ORIGIN: 'https://media.firstknock.online',
};

const renderSourceSha256 = 'b'.repeat(64);
const renderMediaSha256 = 'c'.repeat(64);
const renderArtifactKey = 'ig-render-proof-01';
const renderMediaUrl = [
  env.GROWTH_MEDIA_ORIGIN,
  'sha256',
  `${renderMediaSha256}-${renderArtifactKey}.mp4`,
].join('/');

const renderSource = {
  ...safeSource,
  source_sha256: renderSourceSha256,
};

const renderArtifactFields = {
  ...draftInput,
  artifact_key: renderArtifactKey,
  concept_id: 'render-proof-01',
  platform_content_id: renderArtifactKey,
  title: 'Rendered manager proof',
  format: 'video',
  hook: 'See the field funnel',
  caption: 'A hosted, rendered FirstKnock product proof. Demo data shown.',
  overlay_text: ['See the field funnel'],
  shot_list: ['Show the sanitized manager funnel'],
  cta_url: growthHelpers.platformTrackedUrl(
    'instagram',
    '1000-users',
    renderArtifactKey,
  ),
  media_url: renderMediaUrl,
  media_sha256: renderMediaSha256,
  mime_type: 'video/mp4',
  width: 1080,
  height: 1920,
  duration_ms: 12_000,
  thumbnail_offset_ms: 1_000,
  ai_generated: false,
};
const renderEnvironment = {
  profile_id: 'firstknock-h264-bitexact-v2',
  renderer_sha256: '1'.repeat(64),
  bold_font_sha256: '2'.repeat(64),
  regular_font_sha256: '3'.repeat(64),
  ffmpeg_build_sha256: '4'.repeat(64),
};
const trustedRenderArtifact = {
  artifact_key: renderArtifactKey,
  concept_id: renderArtifactFields.concept_id,
  platform: 'instagram',
  platform_content_id: renderArtifactKey,
  campaign: '1000-users',
  title: renderArtifactFields.title,
  pillar: renderArtifactFields.pillar,
  format: 'video',
  distribution_state: 'publish_candidate',
  source_asset_key: renderSource.asset_key,
  hook: renderArtifactFields.hook,
  overlay_text: [...renderArtifactFields.overlay_text],
  shot_list: [...renderArtifactFields.shot_list],
  caption: renderArtifactFields.caption,
  cta_label: renderArtifactFields.cta_label,
  cta_url: renderArtifactFields.cta_url,
  overlay_cta: 'Try FirstKnock',
  disclosure: renderArtifactFields.disclosure,
  render: {
    duration_ms: 12_000,
    trim_start_ms: 0,
    trim_end_ms: 0,
    crop: null,
    privacy_recipe_id: '',
  },
};
const trustedRenderPack = {
  schema_version: 'growth-render-pack.v1',
  batch_id: 'render-import-regression',
  template: {
    id: 'firstknock-product-proof',
    version: '1.1.0',
    brand: 'FirstKnock',
    accent_color: '0x39FF4A',
    background_color: '0x050705',
    hook_font_size: 76,
    cta_font_size: 42,
    disclosure_font_size: 25,
  },
  output: {
    width: 1080,
    height: 1920,
    fps: 30,
    duration_ms: 12_000,
    video_bitrate: '8M',
    max_video_bitrate: '10M',
    audio_bitrate: '128k',
    thumbnail_offset_ms: 1_000,
    audio_mode: 'silent',
  },
  sources: [{
    asset_key: renderSource.asset_key,
    source_origin: 'asset_pack',
    source_reference: renderSource.source_reference,
    source_sha256: renderSourceSha256,
    media_kind: 'image',
    mime_type: 'image/png',
    codec: '',
    width: 1080,
    height: 1920,
    duration_ms: 0,
    privacy_status: 'safe',
    rights_status: 'firstknock_owned',
  }],
  artifacts: [trustedRenderArtifact],
};

function fixtureSha256(value) {
  return createHash('sha256')
    .update(growthHelpers.canonicalStringify(value))
    .digest('hex');
}

const renderPackSha256 = fixtureSha256(trustedRenderPack);
const renderEnvironmentSha256 = fixtureSha256(renderEnvironment);
const renderInputSha256 = fixtureSha256({
  schema_version: trustedRenderPack.schema_version,
  batch_id: trustedRenderPack.batch_id,
  template: trustedRenderPack.template,
  output: trustedRenderPack.output,
  renderer: renderEnvironment,
  source: trustedRenderPack.sources[0],
  artifact: trustedRenderArtifact,
});
env.GROWTH_RENDER_PACK_SHA256S = renderPackSha256;
env.GROWTH_RENDER_ENVIRONMENT_SHA256S = renderEnvironmentSha256;

function renderImportResult() {
  const artifactFields = structuredClone(renderArtifactFields);
  return {
    schema_version: 'growth-render-result.v1',
    batch_id: 'render-import-regression',
    pack_sha256: renderPackSha256,
    pack: structuredClone(trustedRenderPack),
    template: {
      id: 'firstknock-product-proof',
      version: '1.1.0',
    },
    renderer: {
      ...renderEnvironment,
      environment_sha256: renderEnvironmentSha256,
    },
    media_origin: env.GROWTH_MEDIA_ORIGIN,
    artifact_count: 1,
    artifacts: [{
      artifact_key: renderArtifactKey,
      concept_id: artifactFields.concept_id,
      platform: artifactFields.platform,
      platform_content_id: artifactFields.platform_content_id,
      distribution_state: 'publish_candidate',
      source_asset_keys: [...artifactFields.source_asset_keys],
      source_lineage: [{
        asset_key: artifactFields.source_asset_keys[0],
        source_reference: renderSource.source_reference,
        source_sha256: renderSourceSha256,
      }],
      template_id: 'firstknock-product-proof',
      template_version: '1.1.0',
      render_profile_id: 'firstknock-h264-bitexact-v2',
      render_environment_sha256: renderEnvironmentSha256,
      render_input_sha256: renderInputSha256,
      delivery_key: `sha256/${renderMediaSha256}-${renderArtifactKey}.mp4`,
      media_url: renderMediaUrl,
      media_sha256: renderMediaSha256,
      mime_type: 'video/mp4',
      width: 1080,
      height: 1920,
      duration_ms: 12_000,
      frame_rate: 30,
      video_codec: 'h264',
      pixel_format: 'yuv420p',
      audio_codec: 'aac',
      audio_sample_rate: 48_000,
      audio_channels: 2,
      byte_size: 2_000_000,
      color_space: 'bt709',
      color_transfer: 'bt709',
      color_primaries: 'bt709',
      fast_start: true,
      thumbnail_offset_ms: 1_000,
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
      artifact_fields: artifactFields,
    }],
  };
}

const measuredSeedPack = validatePack(JSON.parse(readFileSync(
  resolve('config/growth-media/firstknock-safe-starter.json'),
  'utf8',
)));
const measuredSeedPackSha256 = fixtureSha256(measuredSeedPack);

function measuredSourceRegistry() {
  return measuredSeedPack.sources
    .filter((source) => (
      source.privacy_status === 'safe'
      && source.rights_status === 'firstknock_owned'
    ))
    .map((source) => ({
      asset_key: source.asset_key,
      title: `Trusted ${source.asset_key}`,
      source_reference: source.source_reference,
      source_sha256: source.source_sha256,
      media_kind: source.media_kind,
      mime_type: source.mime_type,
      width: source.width,
      height: source.height,
      duration_ms: source.duration_ms,
      privacy_status: 'safe',
      safe_summary: `Sanitized product proof for ${source.asset_key}.`,
      active: true,
      privacy_change_pending: false,
    }));
}

async function measuredReviewEvidence(overrides = {}) {
  const publishedAt = overrides.published_at || '2026-07-20T12:00:00.000Z';
  const capturedAt = overrides.snapshot_captured_at || '2026-07-27T12:00:00.000Z';
  const metric = {
    id: 'metric_measured_parent',
    platform: 'instagram',
    campaign: '1000-users',
    content: 'ig-ce-field-funnel-01',
    snapshot_days: 7,
    snapshot_captured_at: capturedAt,
    published_at: publishedAt,
    reach: 1200,
    views: 1500,
    shares: 20,
    saves: 30,
    comments: 4,
    follows: 10,
    profile_visits: 50,
    link_clicks: 25,
    dm_intents: 2,
    ...overrides.metric,
  };
  const snapshotPayload = JSON.stringify({
    campaign: metric.campaign,
    content: metric.content,
    snapshot_days: metric.snapshot_days,
    snapshot_captured_at: metric.snapshot_captured_at,
    published_at: metric.published_at,
    reach: metric.reach,
    views: metric.views,
    shares: metric.shares,
    saves: metric.saves,
    comments: metric.comments,
    follows: metric.follows,
    profile_visits: metric.profile_visits,
    link_clicks: metric.link_clicks,
    dm_intents: metric.dm_intents,
  });
  metric.snapshot_fingerprint = createHash('sha256')
    .update(snapshotPayload)
    .digest('hex');
  const plan = {
    id: 'plan_measured_parent',
    platform: 'instagram',
    campaign: metric.campaign,
    content: metric.content,
    sprint: 'content-engine',
    sequence: 1,
    format: 'reel',
    audience: 'Field sales managers',
    hook: 'See the field funnel',
    script: 'Show the manager funnel.',
    cta_label: 'See FirstKnock',
    cta_channel: 'caption_url',
    primary_metric: 'Activated users',
    hypothesis: 'Specific product proof will create qualified interest.',
    comparison_group: 'manager-analytics-video',
    major_variable: 'Field funnel hook',
    planned_publish_at: publishedAt,
    published_at: publishedAt,
    delivery_managed_by: 'buffer',
    delivery_status: 'published',
    snapshot_days: 7,
    review_decision: overrides.review_decision || 'repeat',
    review_note: overrides.review_note || 'Keep the concrete funnel pattern and vary the opening.',
    reviewed_at: '2026-07-27T13:00:00.000Z',
    review_snapshot_captured_at: capturedAt,
    review_evidence_hash: metric.snapshot_fingerprint,
    ...overrides.plan,
  };
  return { plan, metric };
}

function measuredGeneration(conceptIds) {
  return {
    concepts: conceptIds.map((conceptId, index) => ({
      donor_concept_id: conceptId,
      title: index === 0 ? 'Find the field bottleneck' : 'Own the route handoff',
      hook: index === 0 ? 'Find the field bottleneck' : 'Own every route handoff',
      overlay_text: index === 0
        ? ['Doors', 'Conversations', 'Sales']
        : ['Build', 'Assign', 'Send'],
      shot_list: ['Open on the safe product frame', 'Finish on the workspace CTA'],
      overlay_cta: index === 0 ? 'See the field workflow' : 'Build the clean handoff',
      variants: [
        {
          platform: 'instagram',
          caption: index === 0
            ? 'See where the field workflow changes, then coach the next step.'
            : 'Give every route a clear owner before the team starts knocking.',
          cta_label: 'See FirstKnock',
        },
        {
          platform: 'tiktok',
          caption: index === 0
            ? 'The useful field question is where the workflow changes.'
            : 'A clean field day starts with one clear route handoff.',
          cta_label: 'Open FirstKnock',
        },
      ],
    })),
  };
}

function generatedRenderResult(renderPack) {
  const packSha256 = fixtureSha256(renderPack);
  const artifacts = renderPack.artifacts.map((artifact) => {
    const source = renderPack.sources.find(
      (candidate) => candidate.asset_key === artifact.source_asset_key,
    );
    const durationMs = Number(artifact.render.duration_ms);
    const thumbnailOffsetMs = Math.min(
      Number(renderPack.output.thumbnail_offset_ms),
      durationMs - 1,
    );
    const renderInputHash = fixtureSha256({
      schema_version: renderPack.schema_version,
      batch_id: renderPack.batch_id,
      template: renderPack.template,
      output: {
        ...renderPack.output,
        duration_ms: durationMs,
        thumbnail_offset_ms: thumbnailOffsetMs,
      },
      renderer: renderEnvironment,
      source,
      artifact,
    });
    const mediaSha256 = createHash('sha256')
      .update(artifact.artifact_key)
      .digest('hex');
    const deliveryKey = `sha256/${mediaSha256}-${artifact.artifact_key}.mp4`;
    const mediaUrl = `${env.GROWTH_MEDIA_ORIGIN}/${deliveryKey}`;
    return {
      artifact_key: artifact.artifact_key,
      concept_id: artifact.concept_id,
      platform: artifact.platform,
      platform_content_id: artifact.platform_content_id,
      distribution_state: 'publish_candidate',
      source_asset_keys: [artifact.source_asset_key],
      source_lineage: [{
        asset_key: source.asset_key,
        source_reference: source.source_reference,
        source_sha256: source.source_sha256,
      }],
      template_id: renderPack.template.id,
      template_version: renderPack.template.version,
      render_profile_id: renderEnvironment.profile_id,
      render_environment_sha256: renderEnvironmentSha256,
      render_input_sha256: renderInputHash,
      delivery_key: deliveryKey,
      media_url: mediaUrl,
      media_sha256: mediaSha256,
      mime_type: 'video/mp4',
      width: 1080,
      height: 1920,
      duration_ms: durationMs,
      frame_rate: 30,
      video_codec: 'h264',
      pixel_format: 'yuv420p',
      audio_codec: 'aac',
      audio_sample_rate: 48_000,
      audio_channels: 2,
      byte_size: 2_000_000,
      color_space: 'bt709',
      color_transfer: 'bt709',
      color_primaries: 'bt709',
      fast_start: true,
      thumbnail_offset_ms: thumbnailOffsetMs,
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
        artifact_key: artifact.artifact_key,
        concept_id: artifact.concept_id,
        campaign: artifact.campaign,
        platform: artifact.platform,
        platform_content_id: artifact.platform_content_id,
        title: artifact.title,
        pillar: artifact.pillar,
        format: artifact.format,
        source_asset_keys: [artifact.source_asset_key],
        hook: artifact.hook,
        caption: artifact.caption,
        overlay_text: artifact.overlay_text,
        shot_list: artifact.shot_list,
        cta_label: artifact.cta_label,
        cta_url: artifact.cta_url,
        disclosure: artifact.disclosure,
        ai_generated: true,
        media_url: mediaUrl,
        media_sha256: mediaSha256,
        mime_type: 'video/mp4',
        width: 1080,
        height: 1920,
        duration_ms: durationMs,
        thumbnail_offset_ms: thumbnailOffsetMs,
      },
    };
  });
  return {
    schema_version: 'growth-render-result.v1',
    batch_id: renderPack.batch_id,
    pack_sha256: packSha256,
    pack: structuredClone(renderPack),
    template: {
      id: renderPack.template.id,
      version: renderPack.template.version,
    },
    renderer: {
      ...renderEnvironment,
      environment_sha256: renderEnvironmentSha256,
    },
    media_origin: env.GROWTH_MEDIA_ORIGIN,
    artifact_count: artifacts.length,
    artifacts,
  };
}

async function approvedArtifact(overrides = {}) {
  const artifact = {
    id: 'artifact_approved_1',
    artifact_key: draftInput.platform_content_id,
    concept_id: draftInput.concept_id,
    revision: 1,
    campaign: draftInput.campaign,
    platform: draftInput.platform,
    platform_content_id: draftInput.platform_content_id,
    title: draftInput.title,
    pillar: draftInput.pillar,
    format: draftInput.format,
    source_asset_keys: [...draftInput.source_asset_keys],
    generation_status: 'manual',
    hook: draftInput.hook,
    caption: draftInput.caption,
    overlay_text: [...draftInput.overlay_text],
    shot_list: [...draftInput.shot_list],
    cta_label: draftInput.cta_label,
    cta_url: growthHelpers.instagramTrackedUrl(
      draftInput.campaign,
      draftInput.platform_content_id,
    ),
    disclosure: draftInput.disclosure,
    ai_generated: false,
    media_url: draftInput.media_url,
    media_sha256: draftInput.media_sha256,
    mime_type: draftInput.mime_type,
    width: draftInput.width,
    height: draftInput.height,
    review_status: 'passed',
    privacy_cleared: true,
    demo_labeled: true,
    claims_supported: true,
    media_rights_confirmed: true,
    approval_status: 'approved',
    schedule_lock_generation: 0,
    schedule_lock_token: '',
  };
  const resolved = { ...artifact, ...overrides };
  resolved.provider_text = growthHelpers.socialPostText(resolved);
  resolved.approved_hash = await growthHelpers.artifactApprovalHash(resolved);
  return resolved;
}

async function pendingScheduleReservation(artifact, dueAt, overrides = {}) {
  const providerChannelId = artifact.platform === 'tiktok'
    ? env.BUFFER_TIKTOK_CHANNEL_ID
    : env.BUFFER_INSTAGRAM_CHANNEL_ID;
  const configRevision = await growthHelpers.sha256Hex([
    'buffer',
    env.BUFFER_ORGANIZATION_ID,
    providerChannelId,
    artifact.platform,
    env.GROWTH_MEDIA_ORIGIN,
  ].join('|'));
  const sourceLineageSnapshot = [{
    asset_key: safeSource.asset_key,
    source_reference: safeSource.source_reference,
    source_sha256: safeSource.source_sha256,
  }];
  const request = {
    provider: 'buffer',
    provider_organization_id: env.BUFFER_ORGANIZATION_ID,
    provider_channel_id: providerChannelId,
    provider_service: artifact.platform,
    config_revision: configRevision,
    media_origin: env.GROWTH_MEDIA_ORIGIN,
    artifact_id: artifact.id,
    artifact_hash: artifact.approved_hash,
    source_lineage_snapshot: sourceLineageSnapshot,
    hook_snapshot: artifact.hook,
    ...(artifact.render_pack_sha256
      ? { render_pack_sha256: artifact.render_pack_sha256 }
      : {}),
    ...(artifact.growth_batch_key
      ? { growth_batch_key: artifact.growth_batch_key }
      : {}),
    platform: artifact.platform,
    platform_content_id: artifact.platform_content_id,
    due_at: dueAt,
    scheduling_type: 'automatic',
    timezone: 'America/Phoenix',
  };
  return {
    id: `job_pending_${artifact.id}`,
    ...request,
    job_key: await growthHelpers.publishJobKey(request),
    request_hash: await growthHelpers.publishJobRequestHash(request),
    artifact_key: artifact.artifact_key,
    concept_id: artifact.concept_id,
    campaign: artifact.campaign,
    state: 'reservation_pending',
    attempt_count: 0,
    reconciliation_count: 0,
    schedule_cutoff_at: new Date(
      new Date(dueAt).getTime() - 15 * 60 * 1000,
    ).toISOString(),
    lease_token: `expired-${artifact.id}`,
    lease_generation: 1,
    lease_acquired_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    lease_expires_at: new Date(Date.now() - 60 * 1000).toISOString(),
    ...overrides,
  };
}

function manualSeedPlan(overrides = {}) {
  return {
    campaign: '1000-users',
    content: 'ig-manual-seed-plan',
    sprint: 'manual-sprint',
    sequence: 1,
    format: 'reel',
    audience: 'Door-to-door sales teams',
    hook: 'Turn one field lesson into a repeatable story.',
    script: 'Show the workflow, explain the lesson, then invite the viewer to try it.',
    cta_label: 'Try FirstKnock',
    cta_channel: 'caption_url',
    primary_metric: 'Activated users',
    hypothesis: 'Specific product proof will produce qualified activation.',
    comparison_group: 'product-proof-reel',
    major_variable: 'Opening hook',
    planned_publish_at: new Date(
      Date.now() + 24 * 60 * 60 * 1000,
    ).toISOString(),
    snapshot_days: 7,
    ...overrides,
  };
}

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolveDeferred) => {
    resolvePromise = resolveDeferred;
  });
  return { promise, resolve: resolvePromise };
}

function controlledClock(startMs = Date.now()) {
  let nowMs = startMs;
  class ControlledDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [nowMs]));
    }

    static now() {
      return nowMs;
    }
  }
  return {
    DateImpl: ControlledDate,
    now: () => nowMs,
    set: (value) => {
      nowMs = Number(value);
    },
  };
}

async function createReviewedDraft(handler, artifactOverrides = {}, reviewOverrides = {}) {
  let result = await invokeJson(handler, {
    action: 'create_draft',
    artifact: { ...draftInput, ...artifactOverrides },
  });
  assert.equal(result.status, 201);
  const artifactId = result.body.artifact.id;
  result = await invokeJson(handler, {
    action: 'review',
    artifact_id: artifactId,
    privacy_cleared: true,
    demo_labeled: true,
    claims_supported: true,
    media_rights_confirmed: true,
    ...reviewOverrides,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.passed, true);
  return artifactId;
}

test('content-engine entities are service-role-only and contain no secret fields', () => {
  for (const name of entityNames) {
    const schema = JSON.parse(readFileSync(resolve(`base44/entities/${name}.jsonc`), 'utf8'));
    for (const operation of ['create', 'read', 'update', 'delete']) {
      assert.equal(schema.rls[operation].user_condition.id, '__service_role_only__');
    }
    const keys = Object.keys(schema.properties);
    assert.equal(
      keys.some((key) => /(api.?key|worker.?secret|buffer.?token)/i.test(key)),
      false,
    );
  }
  const validator = readFileSync(resolve('scripts/validate-backend.mjs'), 'utf8');
  assert.match(validator, /readdirSync\(path\.resolve\('base44\/entities'\)\)/);
});

test('creative artifact schema persists constrained render provenance', () => {
  const schema = JSON.parse(
    readFileSync(resolve('base44/entities/GrowthCreativeArtifact.jsonc'), 'utf8'),
  );
  const properties = schema.properties;

  assert.deepEqual(properties.render_result_schema, {
    type: 'string',
    maxLength: 80,
  });
  assert.equal(properties.render_template_id.type, 'string');
  assert.equal(
    properties.render_template_id.pattern,
    '^[a-z0-9][a-z0-9._~-]{0,119}$',
  );
  assert.deepEqual(properties.render_template_version, {
    type: 'string',
    maxLength: 80,
  });
  assert.deepEqual(properties.render_input_sha256, {
    type: 'string',
    pattern: '^[a-f0-9]{64}$',
  });
  assert.equal(properties.render_pack_sha256.pattern, '^[a-f0-9]{64}$');
  assert.equal(properties.render_profile_id.type, 'string');
  assert.equal(properties.render_environment_sha256.pattern, '^[a-f0-9]{64}$');
  assert.equal(properties.render_source_lineage.type, 'array');
  assert.equal(properties.media_byte_size.type, 'integer');
  assert.deepEqual(properties.audio_mode.enum, [
    'silent',
    'baked_owned_or_licensed',
  ]);
  assert.equal(properties.growth_batch_key.pattern, '^[a-f0-9]{64}$');
  assert.equal(
    properties.growth_batch_target_date.pattern,
    '^\\d{4}-\\d{2}-\\d{2}$',
  );
  assert.deepEqual(properties.growth_batch_slot_key.enum, [
    'morning',
    'midday',
    'evening',
  ]);
});

test('manager list exposes only public HTTPS provider links', async () => {
  const jobs = [
    {
      id: 'job_insecure_link',
      state: 'sent',
      provider_external_link: 'http://www.instagram.com/p/insecure/',
    },
    {
      id: 'job_credentialed_link',
      state: 'sent',
      provider_external_link:
        'https://username:password@www.instagram.com/p/credentialed/',
    },
    {
      id: 'job_public_link',
      state: 'sent',
      provider_external_link: 'https://www.instagram.com/p/public-firstknock/',
    },
  ];
  const { base44 } = createGrowthBase44({ jobs });
  const handler = loadGrowthHandler(managePath, { base44, env });

  const result = await invokeJson(handler, { action: 'list' });

  assert.equal(result.status, 200);
  const listed = new Map(result.body.jobs.map((job) => [job.id, job]));
  assert.equal(
    Object.hasOwn(listed.get('job_insecure_link'), 'provider_external_link'),
    false,
  );
  assert.equal(
    Object.hasOwn(listed.get('job_credentialed_link'), 'provider_external_link'),
    false,
  );
  assert.equal(
    listed.get('job_public_link').provider_external_link,
    'https://www.instagram.com/p/public-firstknock/',
  );
});

test('manager list redacts source privacy ownership tokens but preserves fence status', async () => {
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const source = {
    ...safeSource,
    privacy_change_pending: true,
    privacy_change_generation: 4,
    privacy_change_token: 'service-only-source-fence-token',
    privacy_change_expires_at: expiresAt,
  };
  const { base44 } = createGrowthBase44({ sources: [source] });
  const handler = loadGrowthHandler(managePath, { base44, env });

  const result = await invokeJson(handler, { action: 'list' });

  assert.equal(result.status, 200);
  assert.equal(result.body.sources.length, 1);
  assert.equal(
    Object.hasOwn(result.body.sources[0], 'privacy_change_token'),
    false,
  );
  assert.equal(result.body.sources[0].privacy_change_pending, true);
  assert.equal(result.body.sources[0].privacy_change_expires_at, expiresAt);
});

test('approval hash is canonical and covers every public rendition field', async () => {
  const artifact = {
    artifact_key: 'ig-manager-proof-01',
    concept_id: 'manager-proof-01',
    revision: 2,
    campaign: '1000-users',
    platform: 'instagram',
    platform_content_id: 'ig-manager-proof-01',
    format: 'photo',
    title: 'Manager proof',
    pillar: 'Manager coaching',
    source_asset_keys: ['safe-product-proof'],
    hook: 'Hook',
    caption: 'Caption',
    overlay_text: ['One', 'Two'],
    shot_list: ['Shot one'],
    cta_label: 'Try it',
    cta_url: 'https://firstknock.online',
    disclosure: 'Demo data.',
    ai_generated: true,
    media_url: 'https://media.firstknock.online/proof.png',
    media_sha256: 'b'.repeat(64),
    mime_type: 'image/png',
    width: 1080,
    height: 1920,
    duration_ms: 0,
    thumbnail_offset_ms: 0,
    render_result_schema: 'growth-render-result.v1',
    render_pack_sha256: renderPackSha256,
    render_template_id: 'firstknock-product-proof',
    render_template_version: '1.1.0',
    render_input_sha256: renderInputSha256,
    render_profile_id: 'firstknock-h264-bitexact-v2',
    render_environment_sha256: renderEnvironmentSha256,
    render_delivery_key: `sha256/${'b'.repeat(64)}-ig-manager-proof-01.mp4`,
    render_source_lineage: [{
      asset_key: 'safe-product-proof',
      source_reference: 'safe.png',
      source_sha256: renderSourceSha256,
    }],
    media_byte_size: 2_000_000,
    audio_mode: 'silent',
    growth_batch_key: 'd'.repeat(64),
    growth_batch_target_date: '2026-07-29',
    growth_batch_slot_key: 'morning',
  };
  const reordered = Object.fromEntries(Object.entries(artifact).reverse());
  const baseline = await growthHelpers.artifactApprovalHash(artifact);
  assert.equal(await growthHelpers.artifactApprovalHash(reordered), baseline);

  const mutations = {
    caption: 'Different caption',
    disclosure: 'Different disclosure',
    cta_label: 'Different CTA',
    platform_content_id: 'ig-manager-proof-02',
    media_url: 'https://media.firstknock.online/other.png',
    media_sha256: 'c'.repeat(64),
    mime_type: 'image/jpeg',
    width: 1081,
    height: 1919,
    duration_ms: 1,
    revision: 3,
    render_result_schema: 'growth-render-result.v2',
    render_pack_sha256: 'f'.repeat(64),
    render_template_id: 'alternate-template',
    render_template_version: '1.0.1',
    render_input_sha256: 'e'.repeat(64),
    render_profile_id: 'alternate-renderer',
    render_environment_sha256: 'a'.repeat(64),
    render_delivery_key: `sha256/${'b'.repeat(64)}-different.mp4`,
    render_source_lineage: [{
      asset_key: 'safe-product-proof',
      source_reference: 'different.png',
      source_sha256: renderSourceSha256,
    }],
    media_byte_size: 2_000_001,
    audio_mode: 'baked_owned_or_licensed',
    growth_batch_key: 'e'.repeat(64),
    growth_batch_target_date: '2026-07-30',
    growth_batch_slot_key: 'midday',
  };
  for (const [field, value] of Object.entries(mutations)) {
    assert.notEqual(
      await growthHelpers.artifactApprovalHash({ ...artifact, [field]: value }),
      baseline,
      `${field} must change the approval hash`,
    );
  }
  assert.equal(
    await growthHelpers.artifactApprovalHash({
      ...artifact,
      approved_by: 'another-owner',
      approved_at: new Date().toISOString(),
      review_note: 'Lifecycle fields are outside the public payload.',
    }),
    baseline,
  );
});

test('content engine tracked URLs use the neutral path for both platforms', () => {
  for (const [platform, contentId] of [
    ['instagram', 'ig-neutral-proof-01'],
    ['tiktok', 'tt-neutral-proof-01'],
  ]) {
    const url = new URL(growthHelpers.platformTrackedUrl(
      platform,
      '1,000 Users',
      contentId,
    ));
    assert.equal(url.pathname, '/start');
    assert.equal(url.searchParams.get('utm_source'), platform);
    assert.equal(url.searchParams.get('utm_medium'), 'organic_social');
    assert.equal(url.searchParams.get('utm_campaign'), '1-000-users');
    assert.equal(url.searchParams.get('utm_content'), contentId);
  }

  assert.equal(
    new URL(growthHelpers.instagramTrackedUrl(
      '1000-users',
      'ig-legacy-link',
    )).pathname,
    '/instagram',
  );
});

test('TikTok drafts canonicalize arbitrary CTA URLs to their tracked /start link', async () => {
  const { base44, entities } = createGrowthBase44({ sources: [safeSource] });
  const handler = loadGrowthHandler(managePath, { base44, env });
  const result = await invokeJson(handler, {
    action: 'create_draft',
    artifact: {
      ...draftInput,
      platform: 'tiktok',
      platform_content_id: 'tt-manager-proof-01',
      cta_url: 'https://example.com/untracked',
    },
  });

  assert.equal(result.status, 201);
  const artifact = entities.GrowthCreativeArtifact.records[0];
  const url = new URL(artifact.cta_url);
  assert.equal(url.pathname, '/start');
  assert.equal(url.searchParams.get('utm_source'), 'tiktok');
  assert.equal(url.searchParams.get('utm_content'), 'tt-manager-proof-01');
  assert.equal(artifact.provider_text.includes('example.com'), false);
});

test('render-result import creates the exact hosted candidate with provenance and skips previews', async () => {
  const renderResult = renderImportResult();
  const preview = structuredClone(renderResult.artifacts[0]);
  preview.artifact_key = 'preview-render-proof-01';
  preview.distribution_state = 'sanitized_preview_only';
  preview.qc.ready_for_content_engine_import = false;
  renderResult.pack.artifacts.push({
    ...structuredClone(trustedRenderArtifact),
    artifact_key: preview.artifact_key,
    platform_content_id: preview.artifact_key,
    distribution_state: 'sanitized_preview_only',
  });
  renderResult.pack_sha256 = fixtureSha256(renderResult.pack);
  renderResult.artifacts.push(preview);
  renderResult.artifact_count = renderResult.artifacts.length;
  const { base44, entities } = createGrowthBase44({
    sources: [renderSource],
  });
  const handler = loadGrowthHandler(managePath, {
    base44,
    env: {
      ...env,
      GROWTH_RENDER_PACK_SHA256S: renderResult.pack_sha256,
    },
  });

  const result = await invokeJson(handler, {
    action: 'import_render_result',
    render_result: renderResult,
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    success: true,
    created: 1,
    updated: 0,
    idempotent: 0,
    preview_skipped: 1,
    imported: 1,
  });
  assert.equal(entities.GrowthCreativeArtifact.records.length, 1);
  const artifact = entities.GrowthCreativeArtifact.records[0];
  assert.equal(artifact.artifact_key, renderArtifactKey);
  assert.equal(artifact.media_url, renderMediaUrl);
  assert.equal(artifact.media_sha256, renderMediaSha256);
  assert.equal(artifact.render_result_schema, 'growth-render-result.v1');
  assert.equal(artifact.render_pack_sha256, renderResult.pack_sha256);
  assert.equal(artifact.render_template_id, 'firstknock-product-proof');
  assert.equal(artifact.render_template_version, '1.1.0');
  assert.equal(artifact.render_input_sha256, renderInputSha256);
  assert.equal(artifact.render_profile_id, 'firstknock-h264-bitexact-v2');
  assert.equal(artifact.render_environment_sha256, renderEnvironmentSha256);
  assert.equal(
    artifact.render_delivery_key,
    `sha256/${renderMediaSha256}-${renderArtifactKey}.mp4`,
  );
  assert.deepEqual(artifact.render_source_lineage, [{
    asset_key: renderSource.asset_key,
    source_reference: renderSource.source_reference,
    source_sha256: renderSourceSha256,
  }]);
  assert.equal(artifact.media_byte_size, 2_000_000);
  assert.equal(artifact.audio_mode, 'silent');
  assert.equal(artifact.review_status, 'pending');
  assert.equal(artifact.approval_status, 'not_approved');
  assert.equal(
    entities.GrowthCreativeArtifact.records.some(
      (item) => item.artifact_key === preview.artifact_key,
    ),
    false,
  );
});

test('render-result import rejects registered source SHA lineage mismatch without writes', async () => {
  const renderResult = renderImportResult();
  const { base44, entities } = createGrowthBase44({
    sources: [{
      ...renderSource,
      source_sha256: 'e'.repeat(64),
    }],
  });
  const handler = loadGrowthHandler(managePath, { base44, env });

  const result = await invokeJson(handler, {
    action: 'import_render_result',
    render_result: renderResult,
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'render_source_lineage_unavailable');
  assert.equal(entities.GrowthCreativeArtifact.records.length, 0);
  assert.equal(entities.GrowthCreativeArtifact.counters.create, 0);
  assert.equal(entities.GrowthCreativeArtifact.counters.updateMany, 0);
});

test('render-result import requires an allowlisted pack and coherent preview states', async (t) => {
  const cases = [
    {
      name: 'untrusted pack hash',
      mutate: (result) => {
        result.pack_sha256 = 'a'.repeat(64);
      },
    },
    {
      name: 'unknown distribution state',
      mutate: (result) => {
        result.artifacts[0].distribution_state = 'draft';
      },
    },
    {
      name: 'preview contradicts its import fence',
      mutate: (result) => {
        result.artifacts[0].distribution_state = 'sanitized_preview_only';
      },
    },
    {
      name: 'renderer envelope mismatch',
      mutate: (result) => {
        result.renderer.profile_id = 'untrusted-renderer';
      },
    },
    {
      name: 'untrusted render environment',
      mutate: (result) => {
        result.renderer.environment_sha256 = 'a'.repeat(64);
      },
    },
  ];
  for (const invalidCase of cases) {
    await t.test(invalidCase.name, async () => {
      const renderResult = renderImportResult();
      invalidCase.mutate(renderResult);
      const { base44, entities } = createGrowthBase44({
        sources: [renderSource],
      });
      const handler = loadGrowthHandler(managePath, { base44, env });
      const result = await invokeJson(handler, {
        action: 'import_render_result',
        render_result: renderResult,
      });
      assert.equal(result.status, 400);
      assert.equal(result.body.error, 'invalid_render_result');
      assert.equal(entities.GrowthCreativeArtifact.records.length, 0);
    });
  }

  await t.test('missing server allowlist', async () => {
    const { GROWTH_RENDER_PACK_SHA256S: _omitted, ...withoutPack } = env;
    const { base44, entities } = createGrowthBase44({
      sources: [renderSource],
    });
    const handler = loadGrowthHandler(managePath, {
      base44,
      env: withoutPack,
    });
    const result = await invokeJson(handler, {
      action: 'import_render_result',
      render_result: renderImportResult(),
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'invalid_render_result');
    assert.equal(entities.GrowthCreativeArtifact.records.length, 0);
  });

  await t.test('missing server render-environment allowlist', async () => {
    const {
      GROWTH_RENDER_ENVIRONMENT_SHA256S: _omitted,
      ...withoutEnvironment
    } = env;
    const { base44, entities } = createGrowthBase44({
      sources: [renderSource],
    });
    const handler = loadGrowthHandler(managePath, {
      base44,
      env: withoutEnvironment,
    });
    const result = await invokeJson(handler, {
      action: 'import_render_result',
      render_result: renderImportResult(),
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'invalid_render_result');
    assert.equal(entities.GrowthCreativeArtifact.records.length, 0);
  });
});

test('render-result import rejects codec, QC, and URL mismatches without writes', async (t) => {
  const invalidCases = [
    {
      name: 'video codec',
      mutate: (artifact) => {
        artifact.video_codec = 'hevc';
      },
    },
    {
      name: 'QC result',
      mutate: (artifact) => {
        artifact.qc.disclosure_burned_in = false;
      },
    },
    {
      name: 'missing byte size',
      mutate: (artifact) => {
        delete artifact.byte_size;
      },
    },
    {
      name: 'non-numeric byte size',
      mutate: (artifact) => {
        artifact.byte_size = 'not-a-number';
      },
    },
    {
      name: 'delivery key',
      mutate: (artifact) => {
        artifact.delivery_key =
          `sha256/${renderMediaSha256}-different-render.mp4`;
      },
    },
    {
      name: 'envelope dimensions',
      mutate: (artifact) => {
        artifact.width = 1079;
      },
    },
    {
      name: 'artifact source envelope',
      mutate: (artifact) => {
        artifact.source_asset_keys = ['different-source'];
      },
    },
    {
      name: 'template envelope',
      mutate: (artifact) => {
        artifact.template_version = '9.9.9';
      },
    },
    {
      name: 'creative fields differ from the trusted pack',
      mutate: (artifact) => {
        artifact.artifact_fields.caption = 'Hand-edited after rendering.';
      },
    },
    {
      name: 'render input hash differs from the trusted recipe',
      mutate: (artifact) => {
        artifact.render_input_sha256 = 'a'.repeat(64);
      },
    },
    {
      name: 'artifact envelope URL',
      mutate: (artifact) => {
        artifact.media_url = [
          env.GROWTH_MEDIA_ORIGIN,
          'sha256',
          `${renderMediaSha256}-different-render.mp4`,
        ].join('/');
      },
    },
    {
      name: 'configured media origin',
      mutate: (artifact) => {
        const otherOriginUrl = [
          'https://cdn.example.com',
          'sha256',
          `${renderMediaSha256}-${renderArtifactKey}.mp4`,
        ].join('/');
        artifact.media_url = otherOriginUrl;
        artifact.artifact_fields.media_url = otherOriginUrl;
      },
    },
    {
      name: 'content-addressed URL digest',
      mutate: (artifact) => {
        const wrongDigestUrl = [
          env.GROWTH_MEDIA_ORIGIN,
          'sha256',
          `${'f'.repeat(64)}-${renderArtifactKey}.mp4`,
        ].join('/');
        artifact.media_url = wrongDigestUrl;
        artifact.artifact_fields.media_url = wrongDigestUrl;
      },
    },
  ];

  for (const invalidCase of invalidCases) {
    await t.test(invalidCase.name, async () => {
      const renderResult = renderImportResult();
      invalidCase.mutate(renderResult.artifacts[0]);
      const { base44, entities } = createGrowthBase44({
        sources: [renderSource],
      });
      const handler = loadGrowthHandler(managePath, { base44, env });

      const result = await invokeJson(handler, {
        action: 'import_render_result',
        render_result: renderResult,
      });

      assert.equal(result.status, 400);
      assert.equal(result.body.error, 'invalid_render_result_artifact');
      assert.equal(entities.GrowthCreativeArtifact.records.length, 0);
      assert.equal(entities.GrowthCreativeArtifact.counters.create, 0);
      assert.equal(entities.GrowthCreativeArtifact.counters.updateMany, 0);
    });
  }
});

test('render-result import is idempotent on an exact retry', async () => {
  const renderResult = renderImportResult();
  const { base44, entities } = createGrowthBase44({
    sources: [renderSource],
  });
  const handler = loadGrowthHandler(managePath, { base44, env });

  const first = await invokeJson(handler, {
    action: 'import_render_result',
    render_result: renderResult,
  });
  const retry = await invokeJson(handler, {
    action: 'import_render_result',
    render_result: renderResult,
  });

  assert.equal(first.status, 200);
  assert.equal(first.body.created, 1);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body, {
    success: true,
    created: 0,
    updated: 0,
    idempotent: 1,
    preview_skipped: 0,
    imported: 1,
  });
  assert.equal(entities.GrowthCreativeArtifact.records.length, 1);
  assert.equal(entities.GrowthCreativeArtifact.counters.create, 1);
  assert.equal(entities.GrowthCreativeArtifact.counters.updateMany, 0);
});

test('concurrent exact render imports reconcile to one durable artifact', async () => {
  const renderResult = renderImportResult();
  const { base44, entities } = createGrowthBase44({
    sources: [renderSource],
  });
  const entity = entities.GrowthCreativeArtifact;
  const create = entity.create.bind(entity);
  let injected = false;
  entity.create = async (value) => {
    const saved = await create(value);
    if (!injected) {
      injected = true;
      entity.records.push({
        ...structuredClone(saved),
        id: 'growthcreativeartifact_0',
      });
    }
    return saved;
  };
  const handler = loadGrowthHandler(managePath, { base44, env });
  const result = await invokeJson(handler, {
    action: 'import_render_result',
    render_result: renderResult,
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.created, 0);
  assert.equal(result.body.idempotent, 1);
  assert.equal(entity.counters.delete, 1);
  assert.equal(entity.records.length, 1);
  assert.equal(entity.records[0].id, 'growthcreativeartifact_0');
  assert.equal(entity.records[0].artifact_key, renderArtifactKey);
});

test('render-result import cannot change an approved artifact', async () => {
  const renderResult = renderImportResult();
  const { base44, entities } = createGrowthBase44({
    sources: [renderSource],
  });
  const handler = loadGrowthHandler(managePath, { base44, env });
  const imported = await invokeJson(handler, {
    action: 'import_render_result',
    render_result: renderResult,
  });
  assert.equal(imported.status, 200);

  const artifact = entities.GrowthCreativeArtifact.records[0];
  Object.assign(artifact, {
    review_status: 'passed',
    privacy_cleared: true,
    demo_labeled: true,
    claims_supported: true,
    media_rights_confirmed: true,
    approval_status: 'approved',
    approved_by: 'owner_1',
    approved_at: new Date().toISOString(),
  });
  artifact.approved_hash = await growthHelpers.artifactApprovalHash(artifact);
  const before = structuredClone(artifact);
  const changedResult = structuredClone(renderResult);
  const changedMediaSha256 = 'a'.repeat(64);
  const changedMediaUrl = [
    env.GROWTH_MEDIA_ORIGIN,
    'sha256',
    `${changedMediaSha256}-${renderArtifactKey}.mp4`,
  ].join('/');
  changedResult.artifacts[0].media_sha256 = changedMediaSha256;
  changedResult.artifacts[0].media_url = changedMediaUrl;
  changedResult.artifacts[0].delivery_key =
    `sha256/${changedMediaSha256}-${renderArtifactKey}.mp4`;
  changedResult.artifacts[0].artifact_fields.media_sha256 =
    changedMediaSha256;
  changedResult.artifacts[0].artifact_fields.media_url = changedMediaUrl;

  const result = await invokeJson(handler, {
    action: 'import_render_result',
    render_result: changedResult,
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'approved_artifact_immutable');
  assert.deepEqual(entities.GrowthCreativeArtifact.records[0], before);
  assert.equal(entities.GrowthCreativeArtifact.counters.updateMany, 0);
});

test('rendered artifact cannot pass review after a safe source hash changes', async () => {
  const { base44, entities } = createGrowthBase44({
    sources: [renderSource],
  });
  const handler = loadGrowthHandler(managePath, { base44, env });
  const imported = await invokeJson(handler, {
    action: 'import_render_result',
    render_result: renderImportResult(),
  });
  assert.equal(imported.status, 200);
  entities.GrowthSourceAsset.records[0].source_sha256 = 'a'.repeat(64);

  const reviewed = await invokeJson(handler, {
    action: 'review',
    artifact_id: entities.GrowthCreativeArtifact.records[0].id,
    privacy_cleared: true,
    demo_labeled: true,
    claims_supported: true,
    media_rights_confirmed: true,
  });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.body.passed, false);
  assert.equal(reviewed.body.artifact.review_status, 'changes_requested');
});

test('reviewed evidence builds one durable daily batch and imports only after owner authorization', async () => {
  const { plan, metric } = await measuredReviewEvidence();
  const selectedConceptIds = [
    'fk-ce-field-funnel-01',
    'fk-ce-clean-routes-01',
  ];
  let llmCalls = 0;
  const { base44, entities, currentUser } = createGrowthBase44({
    sources: measuredSourceRegistry(),
    plans: [plan],
    metrics: [metric],
    invokeLlm: async () => {
      llmCalls += 1;
      return measuredGeneration(selectedConceptIds);
    },
  });
  const clock = controlledClock(Date.parse('2026-07-28T18:00:00.000Z'));
  const measuredEnv = {
    ...env,
    GROWTH_CONTENT_GENERATION_ENABLED: 'true',
    GROWTH_RENDER_PACK_SHA256S: measuredSeedPackSha256,
  };
  const handler = loadGrowthHandler(managePath, {
    base44,
    env: measuredEnv,
    dateImpl: clock.DateImpl,
  });
  const request = {
    action: 'build_next_batch',
    parent: {
      platform: plan.platform,
      campaign: plan.campaign,
      content: plan.content,
    },
    target_date: '2026-07-29',
    concept_count: 2,
    seed_concept_ids: selectedConceptIds,
    seed_pack: measuredSeedPack,
  };

  const built = await invokeJson(handler, request);
  assert.equal(built.status, 201);
  assert.equal(built.body.idempotent, false);
  assert.equal(built.body.batch.state, 'ready');
  assert.equal(built.body.batch.concept_count, 2);
  assert.equal(built.body.render_pack.artifacts.length, 4);
  assert.equal(built.body.render_pack.sources.length, 2);
  assert.equal(
    built.body.render_pack.artifacts.every((artifact) => artifact.ai_generated === true),
    true,
  );
  assert.deepEqual(
    built.body.render_pack.artifacts.map((artifact) => artifact.platform),
    ['instagram', 'tiktok', 'instagram', 'tiktok'],
  );
  for (const artifact of built.body.render_pack.artifacts) {
    assert.match(artifact.cta_url, /^https:\/\/firstknock\.online\/start\?/);
    assert.match(artifact.cta_url, new RegExp(`utm_source=${artifact.platform}`));
    assert.equal(
      artifact.disclosure,
      'DEMO DATA - no customer result or performance promise.',
    );
  }
  assert.doesNotThrow(() => validatePack(structuredClone(built.body.render_pack)));
  assert.equal(llmCalls, 1);
  assert.equal(entities.GrowthContentBatch.records.length, 1);
  assert.equal(entities.GrowthCreativeArtifact.records.length, 0);

  const retried = await invokeJson(handler, request);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.idempotent, true);
  assert.deepEqual(retried.body.render_pack, built.body.render_pack);
  assert.equal(llmCalls, 1, 'an exact ready retry must not invoke the LLM again');

  const prematureImport = await invokeJson(handler, {
    action: 'import_render_result',
    render_result: generatedRenderResult(built.body.render_pack),
  });
  assert.equal(prematureImport.status, 400);
  assert.equal(prematureImport.body.error, 'invalid_render_result');
  assert.equal(entities.GrowthCreativeArtifact.records.length, 0);

  currentUser.value = { id: 'admin_1', role: 'admin', is_owner: false };
  const adminAuthorization = await invokeJson(handler, {
    action: 'authorize_batch',
    batch_key: built.body.batch.batch_key,
    expected_pack_sha256: built.body.pack_sha256,
    inspection_acknowledged: true,
    note: 'An ordinary admin cannot authorize a generated render pack.',
  });
  assert.equal(adminAuthorization.status, 403);
  assert.equal(adminAuthorization.body.error, 'growth_owner_required');
  currentUser.value = { id: 'owner_1', role: 'admin', is_owner: true };

  const authorized = await invokeJson(handler, {
    action: 'authorize_batch',
    batch_key: built.body.batch.batch_key,
    expected_pack_sha256: built.body.pack_sha256,
    inspection_acknowledged: true,
    note: 'I reviewed the exact generated hooks, captions, sources, and render recipe.',
  });
  assert.equal(authorized.status, 200);
  assert.equal(authorized.body.idempotent, false);
  assert.equal(authorized.body.batch.state, 'render_authorized');
  const authorizationRetry = await invokeJson(handler, {
    action: 'authorize_batch',
    batch_key: built.body.batch.batch_key,
    expected_pack_sha256: built.body.pack_sha256,
    inspection_acknowledged: true,
    note: 'I reviewed the exact generated hooks, captions, sources, and render recipe.',
  });
  assert.equal(authorizationRetry.status, 200);
  assert.equal(authorizationRetry.body.idempotent, true);

  const imported = await invokeJson(handler, {
    action: 'import_render_result',
    render_result: generatedRenderResult(built.body.render_pack),
  });
  assert.equal(imported.status, 200);
  assert.equal(imported.body.created, 4);
  assert.equal(imported.body.imported, 4);
  assert.equal(entities.GrowthCreativeArtifact.records.length, 4);
  for (const [index, artifact] of entities.GrowthCreativeArtifact.records.entries()) {
    assert.equal(artifact.ai_generated, true);
    assert.equal(artifact.generation_status, 'draft_ready');
    assert.equal(artifact.review_status, 'pending');
    assert.equal(artifact.approval_status, 'not_approved');
    assert.equal(artifact.growth_batch_key, built.body.batch.batch_key);
    assert.equal(artifact.growth_batch_target_date, '2026-07-29');
    assert.equal(
      artifact.growth_batch_slot_key,
      index < 2 ? 'morning' : 'midday',
    );
  }
  const generatedArtifact = entities.GrowthCreativeArtifact.records[0];
  const edited = await invokeJson(handler, {
    action: 'update_draft',
    artifact_id: generatedArtifact.id,
    artifact: { caption: 'Copy changed after rendering.' },
  });
  assert.equal(edited.status, 409);
  assert.equal(edited.body.error, 'rendered_artifact_requires_rerender');
  const reviewedGeneratedArtifact = await invokeJson(handler, {
    action: 'review',
    artifact_id: generatedArtifact.id,
    privacy_cleared: true,
    demo_labeled: true,
    claims_supported: true,
    media_rights_confirmed: true,
  });
  assert.equal(reviewedGeneratedArtifact.status, 200);
  assert.equal(reviewedGeneratedArtifact.body.passed, true);
  const approvedGeneratedArtifact = await invokeJson(handler, {
    action: 'approve',
    artifact_id: generatedArtifact.id,
  });
  assert.equal(approvedGeneratedArtifact.status, 200);
  const wrongDaySchedule = await invokeJson(handler, {
    action: 'schedule',
    artifact_id: generatedArtifact.id,
    due_at: '2026-08-01T16:30:00.000Z',
    timezone: 'America/Phoenix',
    scheduling_type: 'notification',
  });
  assert.equal(wrongDaySchedule.status, 409);
  assert.equal(
    wrongDaySchedule.body.error,
    'growth_batch_schedule_slot_mismatch',
  );
  const revokedGeneratedArtifact = await invokeJson(handler, {
    action: 'revoke',
    artifact_id: generatedArtifact.id,
    note: 'Remove this rendition before revoking the measured batch.',
  });
  assert.equal(revokedGeneratedArtifact.status, 200);

  const revoked = await invokeJson(handler, {
    action: 'revoke_batch',
    batch_key: built.body.batch.batch_key,
    note: 'Withdraw this generated batch before any rendition is approved.',
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.batch.state, 'revoked');
  const reviewAfterRevoke = await invokeJson(handler, {
    action: 'review',
    artifact_id: generatedArtifact.id,
    privacy_cleared: true,
    demo_labeled: true,
    claims_supported: true,
    media_rights_confirmed: true,
  });
  assert.equal(reviewAfterRevoke.status, 409);
  assert.equal(reviewAfterRevoke.body.error, 'growth_batch_not_authorized');
  entities.GrowthContentBatch.records.splice(0);
  const reviewAfterMissingBatch = await invokeJson(handler, {
    action: 'review',
    artifact_id: generatedArtifact.id,
    privacy_cleared: true,
    demo_labeled: true,
    claims_supported: true,
    media_rights_confirmed: true,
  });
  assert.equal(reviewAfterMissingBatch.status, 409);
  assert.equal(reviewAfterMissingBatch.body.error, 'growth_batch_not_authorized');
});

test('published measured-batch history cannot be erased by later approval changes', async () => {
  const batchKey = 'd'.repeat(64);
  const packSha256 = 'e'.repeat(64);
  const artifactId = 'artifact_published_batch';
  const { base44, entities } = createGrowthBase44({
    batches: [{
      batch_key: batchKey,
      request_hash: 'f'.repeat(64),
      state: 'render_authorized',
      canonical_pack_sha256: packSha256,
      lease_generation: 1,
    }],
    artifacts: [{
      id: artifactId,
      artifact_key: 'ig-published-batch-proof',
      platform: 'instagram',
      platform_content_id: 'ig-published-batch-proof',
      render_pack_sha256: packSha256,
      approval_status: 'revoked',
    }],
    jobs: [{
      artifact_id: artifactId,
      platform: 'instagram',
      platform_content_id: 'ig-published-batch-proof',
      state: 'sent',
      due_at: '2026-07-27T16:30:00.000Z',
      provider_sent_at: '2026-07-27T16:31:00.000Z',
    }],
  });
  const handler = loadGrowthHandler(managePath, { base44, env });

  const result = await invokeJson(handler, {
    action: 'revoke_batch',
    batch_key: batchKey,
    note: 'Attempt to erase a batch after one rendition was published.',
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'growth_batch_published_history_immutable');
  assert.equal(entities.GrowthContentBatch.records[0].state, 'render_authorized');
});

test('measured batch generation fails closed on stale evidence, untrusted seeds, and exhausted donor capacity', async (t) => {
  const measuredEnv = {
    ...env,
    GROWTH_CONTENT_GENERATION_ENABLED: 'true',
    GROWTH_RENDER_PACK_SHA256S: measuredSeedPackSha256,
  };
  const clock = controlledClock(Date.parse('2026-07-28T18:00:00.000Z'));
  const requestFor = (plan, seedPack = measuredSeedPack) => ({
    action: 'build_next_batch',
    parent: {
      platform: plan.platform,
      campaign: plan.campaign,
      content: plan.content,
    },
    target_date: '2026-07-29',
    concept_count: 2,
    seed_pack: seedPack,
  });

  await t.test('hold decision', async () => {
    const { plan, metric } = await measuredReviewEvidence({
      review_decision: 'hold',
    });
    const { base44, entities } = createGrowthBase44({
      sources: measuredSourceRegistry(),
      plans: [plan],
      metrics: [metric],
    });
    const handler = loadGrowthHandler(managePath, {
      base44,
      env: measuredEnv,
      dateImpl: clock.DateImpl,
    });
    const result = await invokeJson(handler, requestFor(plan));
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'reviewed_parent_on_hold');
    assert.equal(entities.GrowthContentBatch.records.length, 0);
  });

  await t.test('late fixed-age evidence', async () => {
    const { plan, metric } = await measuredReviewEvidence({
      snapshot_captured_at: '2026-07-28T12:00:00.001Z',
    });
    const { base44, entities } = createGrowthBase44({
      sources: measuredSourceRegistry(),
      plans: [plan],
      metrics: [metric],
    });
    const handler = loadGrowthHandler(managePath, {
      base44,
      env: measuredEnv,
      dateImpl: clock.DateImpl,
    });
    const result = await invokeJson(handler, requestFor(plan));
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'fixed_age_snapshot_window_missed');
    assert.equal(entities.GrowthContentBatch.records.length, 0);
  });

  await t.test('untrusted seed pack', async () => {
    const { plan, metric } = await measuredReviewEvidence();
    const changedSeed = structuredClone(measuredSeedPack);
    changedSeed.batch_id = 'untrusted-seed-pack';
    const { base44, entities } = createGrowthBase44({
      sources: measuredSourceRegistry(),
      plans: [plan],
      metrics: [metric],
    });
    const handler = loadGrowthHandler(managePath, {
      base44,
      env: measuredEnv,
      dateImpl: clock.DateImpl,
    });
    const result = await invokeJson(handler, requestFor(plan, changedSeed));
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'untrusted_seed_render_pack');
    assert.equal(entities.GrowthContentBatch.records.length, 0);
  });

  await t.test('duplicate source bytes under different donor aliases', async () => {
    const { plan, metric } = await measuredReviewEvidence();
    const aliasedSeed = structuredClone(measuredSeedPack);
    const firstSource = aliasedSeed.sources.find(
      (source) => source.asset_key === 'manager-analytics-single-card',
    );
    const aliasedSource = aliasedSeed.sources.find(
      (source) => source.asset_key === 'manager-leaderboard-mobile',
    );
    aliasedSource.source_sha256 = firstSource.source_sha256;
    const registry = measuredSourceRegistry();
    registry.find(
      (source) => source.asset_key === aliasedSource.asset_key,
    ).source_sha256 = firstSource.source_sha256;
    let llmCalls = 0;
    const { base44, entities } = createGrowthBase44({
      sources: registry,
      plans: [plan],
      metrics: [metric],
      invokeLlm: async () => {
        llmCalls += 1;
        throw new Error('duplicate source bytes must fail before generation');
      },
    });
    const handler = loadGrowthHandler(managePath, {
      base44,
      env: {
        ...measuredEnv,
        GROWTH_RENDER_PACK_SHA256S: fixtureSha256(aliasedSeed),
      },
      dateImpl: clock.DateImpl,
    });
    const result = await invokeJson(handler, {
      ...requestFor(plan, aliasedSeed),
      seed_concept_ids: [
        'fk-ce-field-funnel-01',
        'fk-ce-coach-patterns-01',
      ],
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'duplicate_seed_source');
    assert.equal(llmCalls, 0);
    assert.equal(entities.GrowthContentBatch.records.length, 0);
  });

  await t.test('recent sent-post history reserves its immutable source', async () => {
    const { plan, metric } = await measuredReviewEvidence();
    const registry = measuredSourceRegistry();
    const source = registry.find(
      (candidate) => candidate.asset_key === 'manager-analytics-single-card',
    );
    let llmCalls = 0;
    const { base44, entities } = createGrowthBase44({
      sources: registry,
      plans: [plan],
      metrics: [metric],
      artifacts: [{
        id: 'artifact_recently_sent',
        artifact_key: 'ig-recently-sent',
        platform: 'instagram',
        platform_content_id: 'ig-recently-sent',
        source_asset_keys: [source.asset_key],
        render_source_lineage: [{
          asset_key: source.asset_key,
          source_reference: source.source_reference,
          source_sha256: source.source_sha256,
        }],
        approval_status: 'revoked',
        hook: 'A previously published hook',
      }],
      jobs: [{
        artifact_id: 'artifact_recently_sent',
        platform: 'instagram',
        platform_content_id: 'ig-recently-sent',
        state: 'sent',
        due_at: '2026-07-28T16:30:00.000Z',
        provider_sent_at: '2026-07-28T16:31:00.000Z',
      }],
      invokeLlm: async () => {
        llmCalls += 1;
        throw new Error('sent source history must fail before generation');
      },
    });
    const handler = loadGrowthHandler(managePath, {
      base44,
      env: measuredEnv,
      dateImpl: clock.DateImpl,
    });
    const result = await invokeJson(handler, {
      ...requestFor(plan),
      seed_concept_ids: [
        'fk-ce-field-funnel-01',
        'fk-ce-clean-routes-01',
      ],
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'seed_donor_unavailable');
    assert.equal(llmCalls, 0);
    assert.equal(entities.GrowthContentBatch.records.length, 0);
  });

  await t.test('queued job snapshot reserves aliased source bytes', async () => {
    const { plan, metric } = await measuredReviewEvidence();
    const registry = measuredSourceRegistry();
    const source = registry.find(
      (candidate) => candidate.asset_key === 'manager-analytics-single-card',
    );
    let llmCalls = 0;
    const { base44, entities } = createGrowthBase44({
      sources: registry,
      plans: [plan],
      metrics: [metric],
      jobs: [{
        id: 'job_queued_source_alias',
        artifact_id: 'deleted_artifact_source_alias',
        concept_id: 'older-queued-concept',
        platform: 'instagram',
        platform_content_id: 'ig-older-queued-concept',
        state: 'queued',
        due_at: '2026-07-28T16:30:00.000Z',
        source_lineage_snapshot: [{
          asset_key: 'same-bytes-under-another-key',
          source_reference: 'same-bytes-under-another-key.png',
          source_sha256: source.source_sha256,
        }],
        hook_snapshot: 'A different queued hook',
      }],
      invokeLlm: async () => {
        llmCalls += 1;
        throw new Error('queued source history must fail before generation');
      },
    });
    const handler = loadGrowthHandler(managePath, {
      base44,
      env: measuredEnv,
      dateImpl: clock.DateImpl,
    });
    const result = await invokeJson(handler, {
      ...requestFor(plan),
      seed_concept_ids: [
        'fk-ce-field-funnel-01',
        'fk-ce-clean-routes-01',
      ],
    });

    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'seed_donor_unavailable');
    assert.equal(llmCalls, 0);
    assert.equal(entities.GrowthContentBatch.records.length, 0);
  });

  await t.test('seven-day source cooldown capacity', async () => {
    const { plan, metric } = await measuredReviewEvidence();
    const safeSourceKeys = measuredSourceRegistry().map((source) => source.asset_key);
    assert.equal(safeSourceKeys.length, 5);
    let llmCalls = 0;
    const { base44, entities } = createGrowthBase44({
      sources: measuredSourceRegistry(),
      plans: [plan],
      metrics: [metric],
      batches: [
        {
          batch_key: 'd'.repeat(64),
          request_hash: 'e'.repeat(64),
          target_date: '2026-07-26',
          source_asset_keys: safeSourceKeys.slice(0, 2),
          state: 'ready',
        },
        {
          batch_key: 'f'.repeat(64),
          request_hash: '1'.repeat(64),
          target_date: '2026-07-28',
          source_asset_keys: safeSourceKeys.slice(2, 4),
          state: 'ready',
        },
      ],
      invokeLlm: async () => {
        llmCalls += 1;
        throw new Error('capacity failure must happen before generation');
      },
    });
    const handler = loadGrowthHandler(managePath, {
      base44,
      env: measuredEnv,
      dateImpl: clock.DateImpl,
    });
    const result = await invokeJson(handler, requestFor(plan));
    assert.equal(result.status, 409);
    assert.deepEqual(result.body, {
      error: 'insufficient_eligible_donors',
      required_donors: 2,
      eligible_donors: 1,
      source_cooldown_days: 7,
    });
    assert.equal(llmCalls, 0);
    assert.equal(entities.GrowthContentBatch.records.length, 2);
  });
});

test('measured batch leases block active duplicates and fence an expired generator', async () => {
  const { plan, metric } = await measuredReviewEvidence();
  const selectedConceptIds = [
    'fk-ce-field-funnel-01',
    'fk-ce-clean-routes-01',
  ];
  const firstGeneration = deferred();
  const firstEntered = deferred();
  let llmCalls = 0;
  const { base44, entities } = createGrowthBase44({
    sources: measuredSourceRegistry(),
    plans: [plan],
    metrics: [metric],
    invokeLlm: async () => {
      llmCalls += 1;
      if (llmCalls === 1) {
        firstEntered.resolve();
        return firstGeneration.promise;
      }
      return measuredGeneration(selectedConceptIds);
    },
  });
  const clock = controlledClock(Date.parse('2026-07-28T18:00:00.000Z'));
  const handler = loadGrowthHandler(managePath, {
    base44,
    env: {
      ...env,
      GROWTH_CONTENT_GENERATION_ENABLED: 'true',
      GROWTH_RENDER_PACK_SHA256S: measuredSeedPackSha256,
    },
    dateImpl: clock.DateImpl,
  });
  const request = {
    action: 'build_next_batch',
    parent: {
      platform: plan.platform,
      campaign: plan.campaign,
      content: plan.content,
    },
    target_date: '2026-07-29',
    concept_count: 2,
    seed_concept_ids: selectedConceptIds,
    seed_pack: measuredSeedPack,
  };

  const staleRequest = invokeJson(handler, request);
  await firstEntered.promise;
  assert.equal(entities.GrowthContentBatch.records[0].state, 'generating');

  const activeDuplicate = await invokeJson(handler, request);
  assert.equal(activeDuplicate.status, 409);
  assert.equal(activeDuplicate.body.error, 'growth_batch_generation_in_progress');
  assert.equal(llmCalls, 1);

  clock.set(clock.now() + 6 * 60 * 1000);
  const takeover = await invokeJson(handler, request);
  assert.equal(takeover.status, 201);
  assert.equal(takeover.body.batch.state, 'ready');
  assert.equal(llmCalls, 2);

  firstGeneration.resolve(measuredGeneration(selectedConceptIds));
  const staleCompletion = await staleRequest;
  assert.equal(staleCompletion.status, 409);
  assert.equal(staleCompletion.body.error, 'growth_batch_lease_expired');
  assert.equal(entities.GrowthContentBatch.records.length, 1);
  assert.equal(entities.GrowthContentBatch.records[0].state, 'ready');

  const exactRetry = await invokeJson(handler, request);
  assert.equal(exactRetry.status, 200);
  assert.equal(exactRetry.body.idempotent, true);
  assert.equal(llmCalls, 2);
});

test('an expired batch cannot supersede a fresh different-key daily winner', async () => {
  const first = await measuredReviewEvidence();
  const second = await measuredReviewEvidence({
    metric: {
      id: 'metric_measured_second_parent',
      content: 'ig-ce-coach-patterns-01',
    },
    plan: { id: 'plan_measured_second_parent' },
  });
  const firstConceptIds = [
    'fk-ce-field-funnel-01',
    'fk-ce-clean-routes-01',
  ];
  const secondConceptIds = [
    'fk-ce-coach-patterns-01',
    'fk-ce-one-coaching-loop-01',
  ];
  const firstGeneration = deferred();
  const firstEntered = deferred();
  let llmCalls = 0;
  const { base44, entities } = createGrowthBase44({
    sources: measuredSourceRegistry(),
    plans: [first.plan, second.plan],
    metrics: [first.metric, second.metric],
    invokeLlm: async () => {
      llmCalls += 1;
      if (llmCalls === 1) {
        firstEntered.resolve();
        return firstGeneration.promise;
      }
      return measuredGeneration(secondConceptIds);
    },
  });
  const clock = controlledClock(Date.parse('2026-07-28T18:00:00.000Z'));
  const handler = loadGrowthHandler(managePath, {
    base44,
    env: {
      ...env,
      GROWTH_CONTENT_GENERATION_ENABLED: 'true',
      GROWTH_RENDER_PACK_SHA256S: measuredSeedPackSha256,
    },
    dateImpl: clock.DateImpl,
  });
  const requestFor = (plan, seedConceptIds) => ({
    action: 'build_next_batch',
    parent: {
      platform: plan.platform,
      campaign: plan.campaign,
      content: plan.content,
    },
    target_date: '2026-07-29',
    concept_count: 2,
    seed_concept_ids: seedConceptIds,
    seed_pack: measuredSeedPack,
  });

  const expiredRequest = invokeJson(
    handler,
    requestFor(first.plan, firstConceptIds),
  );
  await firstEntered.promise;
  clock.set(clock.now() + 6 * 60 * 1000);

  const freshWinner = await invokeJson(
    handler,
    requestFor(second.plan, secondConceptIds),
  );
  assert.equal(freshWinner.status, 201);
  assert.equal(freshWinner.body.batch.state, 'ready');

  firstGeneration.resolve(measuredGeneration(firstConceptIds));
  const expiredResult = await expiredRequest;
  assert.equal(expiredResult.status, 409);
  assert.equal(expiredResult.body.error, 'growth_batch_lease_expired');
  assert.equal(
    entities.GrowthContentBatch.records.filter((batch) => batch.state === 'ready').length,
    1,
  );
  assert.equal(freshWinner.body.batch.batch_key, entities.GrowthContentBatch.records
    .find((batch) => batch.state === 'ready')?.batch_key);
});

test('concurrent generated batches durably reserve near-duplicate hooks', async () => {
  const { plan, metric } = await measuredReviewEvidence();
  const firstConceptIds = [
    'fk-ce-field-funnel-01',
    'fk-ce-clean-routes-01',
  ];
  const secondConceptIds = [
    'fk-ce-coach-patterns-01',
    'fk-ce-one-coaching-loop-01',
  ];
  const generations = [deferred(), deferred()];
  const entered = [deferred(), deferred()];
  let llmCalls = 0;
  const { base44, entities } = createGrowthBase44({
    sources: measuredSourceRegistry(),
    plans: [plan],
    metrics: [metric],
    invokeLlm: async () => {
      const index = llmCalls;
      llmCalls += 1;
      entered[index].resolve();
      return generations[index].promise;
    },
  });
  const clock = controlledClock(Date.parse('2026-07-28T18:00:00.000Z'));
  const handler = loadGrowthHandler(managePath, {
    base44,
    env: {
      ...env,
      GROWTH_CONTENT_GENERATION_ENABLED: 'true',
      GROWTH_RENDER_PACK_SHA256S: measuredSeedPackSha256,
    },
    dateImpl: clock.DateImpl,
  });
  const requestFor = (targetDate, seedConceptIds) => ({
    action: 'build_next_batch',
    parent: {
      platform: plan.platform,
      campaign: plan.campaign,
      content: plan.content,
    },
    target_date: targetDate,
    concept_count: 2,
    seed_concept_ids: seedConceptIds,
    seed_pack: measuredSeedPack,
  });
  const firstRequest = invokeJson(
    handler,
    requestFor('2026-07-29', firstConceptIds),
  );
  await entered[0].promise;
  const secondRequest = invokeJson(
    handler,
    requestFor('2026-08-05', secondConceptIds),
  );
  await entered[1].promise;

  generations[0].resolve(measuredGeneration(firstConceptIds));
  generations[1].resolve(measuredGeneration(secondConceptIds));
  const results = await Promise.all([firstRequest, secondRequest]);
  assert.deepEqual(
    results.map((result) => result.status).sort(),
    [201, 409],
  );
  assert.equal(
    results.find((result) => result.status === 409)?.body.error,
    'hook_dedupe_conflict',
  );
  assert.equal(
    entities.GrowthContentBatch.records.filter((batch) => batch.state === 'ready').length,
    1,
  );
  assert.equal(
    entities.GrowthContentBatch.records.filter(
      (batch) => batch.state === 'superseded',
    ).length,
    1,
  );
});

test('invalid measured generation records a safe failure and can retry the same claim', async () => {
  const { plan, metric } = await measuredReviewEvidence();
  const selectedConceptIds = [
    'fk-ce-field-funnel-01',
    'fk-ce-clean-routes-01',
  ];
  let llmCalls = 0;
  const { base44, entities } = createGrowthBase44({
    sources: measuredSourceRegistry(),
    plans: [plan],
    metrics: [metric],
    invokeLlm: async () => {
      llmCalls += 1;
      if (llmCalls === 1) {
        const invalid = measuredGeneration(selectedConceptIds);
        invalid.concepts[0].hook =
          'Double your close rate in seven days';
        return invalid;
      }
      return measuredGeneration(selectedConceptIds);
    },
  });
  const clock = controlledClock(Date.parse('2026-07-28T18:00:00.000Z'));
  const handler = loadGrowthHandler(managePath, {
    base44,
    env: {
      ...env,
      GROWTH_CONTENT_GENERATION_ENABLED: 'true',
      GROWTH_RENDER_PACK_SHA256S: measuredSeedPackSha256,
    },
    dateImpl: clock.DateImpl,
  });
  const request = {
    action: 'build_next_batch',
    parent: {
      platform: plan.platform,
      campaign: plan.campaign,
      content: plan.content,
    },
    target_date: '2026-07-29',
    concept_count: 2,
    seed_concept_ids: selectedConceptIds,
    seed_pack: measuredSeedPack,
  };

  const failed = await invokeJson(handler, request);
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error, 'invalid_generated_batch');
  assert.equal(entities.GrowthContentBatch.records.length, 1);
  assert.equal(entities.GrowthContentBatch.records[0].state, 'failed');
  assert.equal(
    entities.GrowthContentBatch.records[0].last_error_code,
    'invalid_generated_batch',
  );
  assert.equal(entities.GrowthContentBatch.records[0].canonical_pack_json, undefined);
  assert.equal(entities.GrowthCreativeArtifact.records.length, 0);

  const retried = await invokeJson(handler, request);
  assert.equal(retried.status, 201);
  assert.equal(retried.body.batch.state, 'ready');
  assert.equal(entities.GrowthContentBatch.records[0].attempt_count, 2);
  assert.equal(llmCalls, 2);
});

test('measured generation rejects bare domains, domain paths, and social handles', async (t) => {
  const selectedConceptIds = [
    'fk-ce-field-funnel-01',
    'fk-ce-clean-routes-01',
  ];
  const cases = [
    {
      name: 'bare domain in hook',
      mutate: (generation) => {
        generation.concepts[0].hook = 'See firstknock.com in the field';
      },
    },
    {
      name: 'bare subdomain path in caption',
      mutate: (generation) => {
        generation.concepts[0].variants[0].caption =
          'Open go.firstknock.online/path to see the workflow.';
      },
    },
    {
      name: 'social handle in CTA',
      mutate: (generation) => {
        generation.concepts[0].variants[1].cta_label = 'Follow @firstknock';
      },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const { plan, metric } = await measuredReviewEvidence();
      const invalid = measuredGeneration(selectedConceptIds);
      item.mutate(invalid);
      const { base44, entities } = createGrowthBase44({
        sources: measuredSourceRegistry(),
        plans: [plan],
        metrics: [metric],
        invokeLlm: async () => invalid,
      });
      const handler = loadGrowthHandler(managePath, {
        base44,
        env: {
          ...env,
          GROWTH_CONTENT_GENERATION_ENABLED: 'true',
          GROWTH_RENDER_PACK_SHA256S: measuredSeedPackSha256,
        },
        dateImpl: controlledClock(
          Date.parse('2026-07-28T18:00:00.000Z'),
        ).DateImpl,
      });
      const result = await invokeJson(handler, {
        action: 'build_next_batch',
        parent: {
          platform: plan.platform,
          campaign: plan.campaign,
          content: plan.content,
        },
        target_date: '2026-07-29',
        concept_count: 2,
        seed_concept_ids: selectedConceptIds,
        seed_pack: measuredSeedPack,
      });

      assert.equal(result.status, 502);
      assert.equal(result.body.error, 'invalid_generated_batch');
      assert.equal(entities.GrowthContentBatch.records[0].state, 'failed');
      assert.equal(
        entities.GrowthContentBatch.records[0].canonical_pack_json,
        undefined,
      );
    });
  }
});

test('measured batch finalization loses when its reviewed decision changes during generation', async () => {
  const { plan, metric } = await measuredReviewEvidence();
  const selectedConceptIds = [
    'fk-ce-field-funnel-01',
    'fk-ce-clean-routes-01',
  ];
  const generation = deferred();
  const generationEntered = deferred();
  const { base44, entities } = createGrowthBase44({
    sources: measuredSourceRegistry(),
    plans: [plan],
    metrics: [metric],
    invokeLlm: async () => {
      generationEntered.resolve();
      return generation.promise;
    },
  });
  const clock = controlledClock(Date.parse('2026-07-28T18:00:00.000Z'));
  const handler = loadGrowthHandler(managePath, {
    base44,
    env: {
      ...env,
      GROWTH_CONTENT_GENERATION_ENABLED: 'true',
      GROWTH_RENDER_PACK_SHA256S: measuredSeedPackSha256,
    },
    dateImpl: clock.DateImpl,
  });
  const pending = invokeJson(handler, {
    action: 'build_next_batch',
    parent: {
      platform: plan.platform,
      campaign: plan.campaign,
      content: plan.content,
    },
    target_date: '2026-07-29',
    concept_count: 2,
    seed_concept_ids: selectedConceptIds,
    seed_pack: measuredSeedPack,
  });
  await generationEntered.promise;
  entities.GrowthContentPlan.records[0].review_note =
    'The operator interpretation changed while the model was running.';
  generation.resolve(measuredGeneration(selectedConceptIds));

  const result = await pending;
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'growth_batch_inputs_changed');
  assert.equal(entities.GrowthContentBatch.records[0].state, 'failed');
  assert.equal(
    entities.GrowthContentBatch.records[0].last_error_code,
    'growth_batch_inputs_changed',
  );
  assert.equal(entities.GrowthContentBatch.records[0].canonical_pack_json, undefined);
});

test('measured batch request and finalization bind the exact sanitized source summaries', async () => {
  const { plan, metric } = await measuredReviewEvidence();
  const selectedConceptIds = [
    'fk-ce-field-funnel-01',
    'fk-ce-clean-routes-01',
  ];
  const generation = deferred();
  const generationEntered = deferred();
  const { base44, entities } = createGrowthBase44({
    sources: measuredSourceRegistry(),
    plans: [plan],
    metrics: [metric],
    invokeLlm: async () => {
      generationEntered.resolve();
      return generation.promise;
    },
  });
  const clock = controlledClock(Date.parse('2026-07-28T18:00:00.000Z'));
  const handler = loadGrowthHandler(managePath, {
    base44,
    env: {
      ...env,
      GROWTH_CONTENT_GENERATION_ENABLED: 'true',
      GROWTH_RENDER_PACK_SHA256S: measuredSeedPackSha256,
    },
    dateImpl: clock.DateImpl,
  });
  const pending = invokeJson(handler, {
    action: 'build_next_batch',
    parent: {
      platform: plan.platform,
      campaign: plan.campaign,
      content: plan.content,
    },
    target_date: '2026-07-29',
    concept_count: 2,
    seed_concept_ids: selectedConceptIds,
    seed_pack: measuredSeedPack,
  });
  await generationEntered.promise;
  assert.match(
    entities.GrowthContentBatch.records[0].prompt_source_sha256,
    /^[a-f0-9]{64}$/,
  );
  const changedSource = entities.GrowthSourceAsset.records.find(
    (source) => source.asset_key === 'manager-analytics-single-card',
  );
  changedSource.safe_summary = 'A different sanitized summary entered the prompt lineage.';
  generation.resolve(measuredGeneration(selectedConceptIds));

  const result = await pending;
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'growth_batch_inputs_changed');
  assert.equal(entities.GrowthContentBatch.records[0].state, 'failed');
  assert.equal(entities.GrowthContentBatch.records[0].canonical_pack_json, undefined);
});

test('stable media guard rejects local, private, signed, and credentialed URLs', () => {
  assert.equal(
    growthHelpers.isStablePublicHttpsUrl('https://media.firstknock.online/sha256/asset.mp4'),
    true,
  );
  for (const url of [
    'file:///tmp/asset.mp4',
    'http://media.firstknock.online/asset.mp4',
    'https://localhost/asset.mp4',
    'https://localhost./asset.mp4',
    'https://[::1]/asset.mp4',
    'https://[2001:db8::1]/asset.mp4',
    'https://127.0.0.1/asset.mp4',
    'https://10.0.0.1/asset.mp4',
    'https://user:pass@media.firstknock.online/asset.mp4',
    'https://media.firstknock.online/asset.mp4?signature=temporary',
  ]) {
    assert.equal(growthHelpers.isStablePublicHttpsUrl(url), false, url);
  }
  assert.equal(
    growthHelpers.isContentAddressedMediaUrl(
      `https://media.firstknock.online/${'a'.repeat(64)}-asset.mp4`,
      'a'.repeat(64),
    ),
    true,
  );
  assert.equal(
    growthHelpers.isContentAddressedMediaUrl(
      `https://media.firstknock.online/${'a'.repeat(16)}-asset.mp4`,
      'a'.repeat(64),
    ),
    false,
    'a truncated hash in the URL is not content addressing',
  );
  assert.equal(
    growthHelpers.isContentAddressedMediaUrl(
      `https://media.firstknock.online/${'a'.repeat(64)}-asset.mp4`,
      'a'.repeat(63),
    ),
    false,
    'the approved digest must contain all 64 hexadecimal characters',
  );
  assert.equal(
    growthHelpers.isContentAddressedMediaUrl(
      'https://media.firstknock.online/asset.mp4',
      'a'.repeat(64),
    ),
    false,
  );
});

test('silent rendition requires an explicit automatic-delivery decision', async () => {
  const artifact = await approvedArtifact({ audio_mode: 'silent' });
  const { base44, entities } = createGrowthBase44({
    sources: [safeSource],
    artifacts: [artifact],
  });
  const handler = loadGrowthHandler(managePath, { base44, env });
  const result = await invokeJson(handler, {
    action: 'schedule',
    artifact_id: entities.GrowthCreativeArtifact.records[0].id,
    due_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    scheduling_type: 'automatic',
    timezone: 'America/Phoenix',
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'silent_media_decision_required');
  assert.equal(entities.GrowthPublishJob.records.length, 0);
});

test('scheduling requires a ready publisher environment and a fresh matching worker heartbeat', async (t) => {
  const heartbeatRevision = await growthHelpers.sha256Hex([
    'buffer-publisher',
    env.BUFFER_ORGANIZATION_ID,
    env.BUFFER_INSTAGRAM_CHANNEL_ID,
    env.BUFFER_TIKTOK_CHANNEL_ID,
    env.GROWTH_MEDIA_ORIGIN,
  ].join('|'));
  const freshHeartbeat = {
    heartbeat_key: 'buffer-publisher',
    config_revision: heartbeatRevision,
    observed_at: new Date().toISOString(),
    status: 'ready',
    invocation_generation: 1,
    last_batch_inspected: 0,
    last_batch_processed: 0,
  };
  const cases = [
    {
      name: 'disabled publisher',
      environment: { ...env, GROWTH_PUBLISH_ENABLED: 'false' },
      heartbeats: [freshHeartbeat],
      error: 'publishing_not_configured',
    },
    {
      name: 'missing Buffer API key',
      environment: { ...env, BUFFER_API_KEY: '' },
      heartbeats: [freshHeartbeat],
      error: 'publishing_not_configured',
    },
    {
      name: 'short worker secret',
      environment: { ...env, GROWTH_PUBLISH_WORKER_SECRET: 'x'.repeat(31) },
      heartbeats: [freshHeartbeat],
      error: 'publishing_not_configured',
    },
    {
      name: 'missing heartbeat',
      environment: env,
      heartbeats: [],
      error: 'publisher_worker_unavailable',
    },
    {
      name: 'stale heartbeat',
      environment: env,
      heartbeats: [{
        ...freshHeartbeat,
        observed_at: new Date(Date.now() - 4 * 60 * 1000).toISOString(),
      }],
      error: 'publisher_worker_unavailable',
    },
    {
      name: 'heartbeat for a different configuration',
      environment: env,
      heartbeats: [{
        ...freshHeartbeat,
        config_revision: 'f'.repeat(64),
      }],
      error: 'publisher_worker_unavailable',
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const artifact = await approvedArtifact({
        id: `artifact_${item.name.replaceAll(' ', '_')}`,
      });
      const { base44, entities } = createGrowthBase44({
        sources: [safeSource],
        artifacts: [artifact],
        heartbeats: item.heartbeats,
      });
      const handler = loadGrowthHandler(managePath, {
        base44,
        env: item.environment,
      });
      const result = await invokeJson(handler, {
        action: 'schedule',
        artifact_id: artifact.id,
        due_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        timezone: 'America/Phoenix',
        scheduling_type: 'automatic',
      });

      assert.equal(result.status, 503);
      assert.equal(result.body.error, item.error);
      assert.equal(entities.GrowthPublishJob.records.length, 0);
      assert.equal(entities.GrowthContentPlan.records.length, 0);
    });
  }

  await t.test('fresh matching heartbeat', async () => {
    const artifact = await approvedArtifact({ id: 'artifact_ready_publisher' });
    const { base44, entities } = createGrowthBase44({
      sources: [safeSource],
      artifacts: [artifact],
      heartbeats: [freshHeartbeat],
    });
    const handler = loadGrowthHandler(managePath, { base44, env });
    const result = await invokeJson(handler, {
      action: 'schedule',
      artifact_id: artifact.id,
      due_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      timezone: 'America/Phoenix',
      scheduling_type: 'automatic',
    });

    assert.equal(result.status, 201);
    assert.equal(entities.GrowthPublishJob.records.length, 1);
    assert.equal(entities.GrowthContentPlan.records.length, 1);
  });
});

test('one canonical concept may schedule its paired Instagram and TikTok renditions', async () => {
  const pairPackSha256 = '7'.repeat(64);
  const conceptId = 'paired-cross-platform-proof';
  const pairLineage = [{
    asset_key: safeSource.asset_key,
    source_reference: safeSource.source_reference,
    source_sha256: safeSource.source_sha256,
  }];
  const instagram = await approvedArtifact({
    id: 'artifact_pair_instagram',
    artifact_key: 'ig-paired-cross-platform-proof',
    platform_content_id: 'ig-paired-cross-platform-proof',
    concept_id: conceptId,
    render_pack_sha256: pairPackSha256,
    render_source_lineage: pairLineage,
  });
  const tiktok = await approvedArtifact({
    id: 'artifact_pair_tiktok',
    artifact_key: 'tt-paired-cross-platform-proof',
    platform: 'tiktok',
    platform_content_id: 'tt-paired-cross-platform-proof',
    concept_id: conceptId,
    render_pack_sha256: pairPackSha256,
    render_source_lineage: pairLineage,
    cta_url: growthHelpers.platformTrackedUrl(
      'tiktok',
      draftInput.campaign,
      'tt-paired-cross-platform-proof',
    ),
  });
  const { base44, entities } = createGrowthBase44({
    sources: [safeSource],
    artifacts: [instagram, tiktok],
  });
  const handler = loadGrowthHandler(managePath, { base44, env });
  const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const instagramResult = await invokeJson(handler, {
    action: 'schedule',
    artifact_id: instagram.id,
    due_at: dueAt,
    timezone: 'America/Phoenix',
    scheduling_type: 'automatic',
  });
  const tiktokResult = await invokeJson(handler, {
    action: 'schedule',
    artifact_id: tiktok.id,
    due_at: dueAt,
    timezone: 'America/Phoenix',
    scheduling_type: 'automatic',
  });

  assert.equal(instagramResult.status, 201);
  assert.equal(tiktokResult.status, 201);
  assert.deepEqual(
    entities.GrowthPublishJob.records.map((job) => job.platform).sort(),
    ['instagram', 'tiktok'],
  );
  assert.equal(entities.GrowthContentPlan.records.length, 2);
});

test('schedule revalidates the global 28-day hook reservation', async () => {
  const first = await approvedArtifact({
    id: 'artifact_hook_reservation_first',
    artifact_key: 'ig-hook-reservation-first',
    platform_content_id: 'ig-hook-reservation-first',
  });
  const secondSource = {
    ...safeSource,
    id: 'source_hook_reservation_second',
    asset_key: 'safe-product-proof-second',
    source_reference: 'safe-second.png',
    source_sha256: '8'.repeat(64),
  };
  const second = await approvedArtifact({
    id: 'artifact_hook_reservation_second',
    artifact_key: 'ig-hook-reservation-second',
    platform_content_id: 'ig-hook-reservation-second',
    concept_id: 'hook-reservation-second',
    source_asset_keys: [secondSource.asset_key],
  });
  const { base44, entities } = createGrowthBase44({
    sources: [safeSource],
    artifacts: [first],
  });
  const handler = loadGrowthHandler(managePath, { base44, env });
  const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const firstResult = await invokeJson(handler, {
    action: 'schedule',
    artifact_id: first.id,
    due_at: dueAt,
    timezone: 'America/Phoenix',
    scheduling_type: 'automatic',
  });
  assert.equal(firstResult.status, 201);
  entities.GrowthSourceAsset.records.push({
    ...secondSource,
    created_date: new Date().toISOString(),
    updated_date: new Date().toISOString(),
  });
  entities.GrowthCreativeArtifact.records.push({
    ...second,
    created_date: new Date().toISOString(),
    updated_date: new Date().toISOString(),
  });

  const secondResult = await invokeJson(handler, {
    action: 'schedule',
    artifact_id: second.id,
    due_at: dueAt,
    timezone: 'America/Phoenix',
    scheduling_type: 'automatic',
  });

  assert.equal(secondResult.status, 409);
  assert.equal(secondResult.body.error, 'hook_dedupe_conflict');
  assert.equal(entities.GrowthPublishJob.records.length, 1);
  assert.equal(entities.GrowthContentPlan.records.length, 1);
});

test('sent job provenance overrides a later mutable artifact pairing', async () => {
  const currentPack = '6'.repeat(64);
  const current = await approvedArtifact({
    id: 'artifact_current_immutable_history',
    artifact_key: 'ig-current-immutable-history',
    platform_content_id: 'ig-current-immutable-history',
    concept_id: 'current-immutable-history',
    render_pack_sha256: currentPack,
  });
  const mutatedHistoricalArtifact = await approvedArtifact({
    id: 'artifact_mutated_historical_history',
    artifact_key: 'tt-mutated-historical-history',
    platform: 'tiktok',
    platform_content_id: 'tt-mutated-historical-history',
    concept_id: current.concept_id,
    render_pack_sha256: currentPack,
    approval_status: 'revoked',
    cta_url: growthHelpers.platformTrackedUrl(
      'tiktok',
      draftInput.campaign,
      'tt-mutated-historical-history',
    ),
  });
  const { base44, entities } = createGrowthBase44({
    sources: [safeSource],
    artifacts: [current, mutatedHistoricalArtifact],
    jobs: [{
      id: 'job_immutable_historical_history',
      artifact_id: mutatedHistoricalArtifact.id,
      concept_id: 'original-unpaired-history',
      platform: 'tiktok',
      platform_content_id: mutatedHistoricalArtifact.platform_content_id,
      state: 'sent',
      due_at: new Date(Date.now() - 60_000).toISOString(),
      provider_sent_at: new Date(Date.now() - 60_000).toISOString(),
      source_lineage_snapshot: [{
        asset_key: safeSource.asset_key,
        source_reference: safeSource.source_reference,
        source_sha256: safeSource.source_sha256,
      }],
      hook_snapshot: 'A completely different old hook',
      render_pack_sha256: '5'.repeat(64),
    }],
  });
  const handler = loadGrowthHandler(managePath, { base44, env });

  const result = await invokeJson(handler, {
    action: 'schedule',
    artifact_id: current.id,
    due_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    timezone: 'America/Phoenix',
    scheduling_type: 'automatic',
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'source_cooldown_conflict');
  assert.equal(entities.GrowthPublishJob.records.length, 1);
  assert.equal(entities.GrowthContentPlan.records.length, 0);
});

test('owner workflow registers sources, reviews, approves, and creates one idempotent job', async () => {
  const { base44, entities, currentUser } = createGrowthBase44();
  const handler = loadGrowthHandler(managePath, { base44, env });

  let result = await invokeJson(handler, {
    action: 'register_sources',
    sources: [safeSource],
  });
  assert.equal(result.status, 200);
  assert.equal(entities.GrowthSourceAsset.records.length, 1);

  result = await invokeJson(handler, { action: 'create_draft', artifact: draftInput });
  assert.equal(result.status, 201);
  const artifactId = result.body.artifact.id;

  result = await invokeJson(handler, {
    action: 'review',
    artifact_id: artifactId,
    privacy_cleared: true,
    demo_labeled: true,
    claims_supported: true,
    media_rights_confirmed: true,
    note: 'Sanitized demo asset and claim review complete.',
    reviewed_by: 'body_must_be_ignored',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.passed, true);
  assert.equal(entities.GrowthCreativeArtifact.records[0].reviewed_by, 'owner_1');

  result = await invokeJson(handler, {
    action: 'approve',
    artifact_id: artifactId,
    approved_hash: '0'.repeat(64),
    approved_by: 'body_must_be_ignored',
  });
  assert.equal(result.status, 200);
  const approved = entities.GrowthCreativeArtifact.records[0];
  assert.equal(approved.approval_status, 'approved');
  assert.equal(approved.approved_by, 'owner_1');
  assert.equal(approved.approved_hash, await growthHelpers.artifactApprovalHash(approved));
  assert.equal(approved.provider_text, growthHelpers.socialPostText(approved));
  assert.match(approved.provider_text, /Demo data shown\./);
  assert.match(approved.provider_text, /Try FirstKnock/);
  assert.match(approved.provider_text, /utm_source=instagram/);
  assert.match(approved.provider_text, /utm_content=ig-manager-proof-01/);
  assert.equal(new URL(approved.cta_url).pathname, '/start');

  const serviceReadsBeforeDeniedApproval = Object.values(entities)
    .reduce((sum, entity) => sum + entity.counters.get + entity.counters.filter + entity.counters.list, 0);
  currentUser.value = { id: 'admin_2', role: 'admin', is_owner: false };
  result = await invokeJson(handler, { action: 'approve', artifact_id: artifactId });
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'growth_owner_required');
  const serviceReadsAfterDeniedApproval = Object.values(entities)
    .reduce((sum, entity) => sum + entity.counters.get + entity.counters.filter + entity.counters.list, 0);
  assert.equal(serviceReadsAfterDeniedApproval, serviceReadsBeforeDeniedApproval);

  currentUser.value = { id: 'owner_1', role: 'admin', is_owner: true };
  const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  result = await invokeJson(handler, {
    action: 'schedule',
    artifact_id: artifactId,
    due_at: dueAt,
    timezone: 'America/Phoenix',
    scheduling_type: 'automatic',
  });
  assert.equal(result.status, 201);
  assert.equal(entities.GrowthPublishJob.records.length, 1);
  const firstJob = entities.GrowthPublishJob.records[0];
  assert.equal(firstJob.artifact_hash, approved.approved_hash);
  assert.equal(firstJob.provider_channel_id, env.BUFFER_INSTAGRAM_CHANNEL_ID);
  assert.equal(firstJob.state, 'queued');
  assert.equal(entities.GrowthContentPlan.records.length, 1);
  assert.equal(entities.GrowthContentPlan.records[0].content, approved.platform_content_id);
  assert.equal(entities.GrowthContentPlan.records[0].script, approved.provider_text);
  assert.equal(entities.GrowthContentPlan.records[0].planned_publish_at, dueAt);
  assert.equal(entities.GrowthContentPlan.records[0].cta_channel, 'caption_url');
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'planned');

  result = await invokeJson(handler, {
    action: 'schedule',
    artifact_id: artifactId,
    due_at: dueAt,
    timezone: 'America/Phoenix',
    scheduling_type: 'automatic',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.idempotent, true);
  assert.equal(entities.GrowthPublishJob.records.length, 1);

  result = await invokeJson(handler, {
    action: 'schedule',
    artifact_id: artifactId,
    due_at: new Date(new Date(dueAt).getTime() + 60 * 60 * 1000).toISOString(),
    timezone: 'America/Phoenix',
    scheduling_type: 'automatic',
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'publish_job_request_conflict');
  assert.equal(entities.GrowthPublishJob.records.length, 1);

  result = await invokeJson(handler, {
    action: 'cancel_job',
    job_id: firstJob.id,
  });
  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'canceled');
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'canceled');

  const retryDueAt = new Date(new Date(dueAt).getTime() + 2 * 60 * 60 * 1000).toISOString();
  result = await invokeJson(handler, {
    action: 'schedule',
    artifact_id: artifactId,
    due_at: retryDueAt,
    timezone: 'America/Phoenix',
    scheduling_type: 'automatic',
    retry_terminal: true,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.retried, true);
  assert.equal(result.body.job.id, firstJob.id);
  assert.equal(entities.GrowthPublishJob.records.length, 1);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'queued');
  assert.equal(entities.GrowthPublishJob.records[0].due_at, retryDueAt);
  assert.equal(entities.GrowthContentPlan.records[0].planned_publish_at, retryDueAt);
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'planned');
});

test('TikTok scheduling creates and cancels its own platform measurement plan', async () => {
  const contentId = 'tt-cross-platform-plan-01';
  const artifact = await approvedArtifact({
    id: 'artifact_tiktok_measurement_plan',
    artifact_key: contentId,
    platform: 'tiktok',
    platform_content_id: contentId,
    cta_url: growthHelpers.platformTrackedUrl(
      'tiktok',
      draftInput.campaign,
      contentId,
    ),
  });
  const legacyInstagramPlan = manualSeedPlan({
    id: 'legacy_instagram_same_content',
    content: contentId,
    delivery_managed_by: 'buffer',
    delivery_status: 'planned',
  });
  const { base44, entities } = createGrowthBase44({
    sources: [safeSource],
    artifacts: [artifact],
    plans: [legacyInstagramPlan],
  });
  const handler = loadGrowthHandler(managePath, { base44, env });
  const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  let result = await invokeJson(handler, {
    action: 'schedule',
    artifact_id: artifact.id,
    due_at: dueAt,
    timezone: 'America/Phoenix',
    scheduling_type: 'automatic',
  });

  assert.equal(result.status, 201);
  assert.equal(entities.GrowthPublishJob.records[0].provider_channel_id, env.BUFFER_TIKTOK_CHANNEL_ID);
  assert.equal(entities.GrowthContentPlan.records.length, 2);
  const tiktokPlan = entities.GrowthContentPlan.records.find(
    (plan) => plan.platform === 'tiktok',
  );
  assert.ok(tiktokPlan);
  assert.equal(tiktokPlan.content, contentId);
  assert.equal(tiktokPlan.planned_publish_at, dueAt);
  assert.equal(tiktokPlan.primary_metric, 'TikTok activated users');
  assert.equal(tiktokPlan.delivery_status, 'planned');
  assert.equal(
    entities.GrowthContentPlan.records.find(
      (plan) => plan.id === legacyInstagramPlan.id,
    ).delivery_status,
    'planned',
  );

  result = await invokeJson(handler, {
    action: 'cancel_job',
    job_id: entities.GrowthPublishJob.records[0].id,
  });

  assert.equal(result.status, 200);
  assert.equal(tiktokPlan.id, entities.GrowthContentPlan.records.find(
    (plan) => plan.platform === 'tiktok',
  ).id);
  assert.equal(
    entities.GrowthContentPlan.records.find(
      (plan) => plan.platform === 'tiktok',
    ).delivery_status,
    'canceled',
  );
  assert.equal(
    entities.GrowthContentPlan.records.find(
      (plan) => plan.id === legacyInstagramPlan.id,
    ).delivery_status,
    'planned',
  );
});

test('source safety downgrade cancels queued delivery and its plan before mutating the source', async (t) => {
  const cases = [
    {
      name: 'blocked source',
      sourcePatch: {
        privacy_status: 'blocked',
        active: true,
        privacy_note: 'Owner blocked this source from future publishing.',
      },
    },
    {
      name: 'inactive source',
      sourcePatch: {
        privacy_status: 'safe',
        active: false,
        privacy_note: 'Owner retired this source from future publishing.',
      },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const artifact = await approvedArtifact({
        id: `artifact_source_downgrade_${item.name.replaceAll(' ', '_')}`,
      });
      const job = {
        id: `job_source_downgrade_${item.name.replaceAll(' ', '_')}`,
        artifact_id: artifact.id,
        artifact_key: artifact.artifact_key,
        campaign: artifact.campaign,
        platform: artifact.platform,
        platform_content_id: artifact.platform_content_id,
        state: 'queued',
        lease_generation: 0,
      };
      const plan = {
        id: `plan_source_downgrade_${item.name.replaceAll(' ', '_')}`,
        campaign: artifact.campaign,
        content: artifact.platform_content_id,
        sprint: 'content-engine',
        delivery_managed_by: 'buffer',
        delivery_status: 'planned',
      };
      const { base44, entities } = createGrowthBase44({
        sources: [{ id: 'source_downgrade', ...safeSource }],
        artifacts: [artifact],
        jobs: [job],
        plans: [plan],
      });
      const originalSourceUpdateMany = entities.GrowthSourceAsset.updateMany;
      let fenceAcquired = false;
      let finalCommitObserved = false;
      entities.GrowthSourceAsset.updateMany = async (query, operations) => {
        if (operations?.$set?.privacy_change_pending === true) {
          assert.equal(entities.GrowthPublishJob.records[0].state, 'queued');
          assert.equal(
            entities.GrowthContentPlan.records[0].delivery_status,
            'planned',
          );
          const result = await originalSourceUpdateMany(query, operations);
          assert.equal(
            entities.GrowthSourceAsset.records[0].privacy_change_pending,
            true,
          );
          fenceAcquired = true;
          return result;
        }
        if (
          operations?.$set?.privacy_change_pending === false
          && Object.hasOwn(operations.$set, 'privacy_status')
        ) {
          assert.equal(fenceAcquired, true);
          assert.equal(entities.GrowthPublishJob.records[0].state, 'canceled');
          assert.equal(
            entities.GrowthContentPlan.records[0].delivery_status,
            'canceled',
          );
          finalCommitObserved = true;
        }
        return originalSourceUpdateMany(query, operations);
      };
      const handler = loadGrowthHandler(managePath, { base44, env });

      const result = await invokeJson(handler, {
        action: 'register_sources',
        sources: [{ ...safeSource, ...item.sourcePatch }],
      });

      assert.equal(result.status, 200);
      assert.deepEqual(result.body, {
        success: true,
        created: 0,
        updated: 1,
        total: 1,
      });
      assert.equal(fenceAcquired, true);
      assert.equal(finalCommitObserved, true);
      assert.equal(
        entities.GrowthPublishJob.records[0].last_error_code,
        'source_privacy_downgraded',
      );
      assert.equal(
        entities.GrowthContentPlan.records[0].delivery_status,
        'canceled',
      );
      assert.equal(
        entities.GrowthSourceAsset.records[0].privacy_status,
        item.sourcePatch.privacy_status,
      );
      assert.equal(
        entities.GrowthSourceAsset.records[0].active,
        item.sourcePatch.active,
      );
      assert.equal(
        entities.GrowthSourceAsset.records[0].privacy_change_pending,
        false,
      );
      assert.equal(
        entities.GrowthSourceAsset.records[0].privacy_change_generation,
        1,
      );
    });
  }
});

test('source render-identity drift cancels queued delivery before committing the new lineage', async (t) => {
  const originalSource = {
    ...safeSource,
    source_sha256: 'd'.repeat(64),
  };
  const cases = [
    {
      name: 'source SHA changes',
      sourcePatch: { source_sha256: 'e'.repeat(64) },
    },
    {
      name: 'source reference changes',
      sourcePatch: { source_reference: 'safe-replacement.png' },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const suffix = item.name.replaceAll(' ', '_').toLowerCase();
      const artifact = await approvedArtifact({
        id: `artifact_lineage_change_${suffix}`,
        render_result_schema: 'growth-render-result.v1',
        render_source_lineage: [{
          asset_key: originalSource.asset_key,
          source_reference: originalSource.source_reference,
          source_sha256: originalSource.source_sha256,
        }],
      });
      const job = {
        id: `job_lineage_change_${suffix}`,
        artifact_id: artifact.id,
        artifact_key: artifact.artifact_key,
        campaign: artifact.campaign,
        platform: artifact.platform,
        platform_content_id: artifact.platform_content_id,
        state: 'queued',
        lease_generation: 0,
      };
      const plan = {
        id: `plan_lineage_change_${suffix}`,
        platform: artifact.platform,
        campaign: artifact.campaign,
        content: artifact.platform_content_id,
        sprint: 'content-engine',
        delivery_managed_by: 'buffer',
        delivery_status: 'planned',
      };
      const { base44, entities } = createGrowthBase44({
        sources: [{ id: `source_lineage_change_${suffix}`, ...originalSource }],
        artifacts: [artifact],
        jobs: [job],
        plans: [plan],
      });
      const originalSourceUpdateMany = entities.GrowthSourceAsset.updateMany;
      let finalCommitObserved = false;
      entities.GrowthSourceAsset.updateMany = async (query, operations) => {
        if (
          operations?.$set?.privacy_change_pending === false
          && Object.hasOwn(operations.$set, 'source_sha256')
        ) {
          assert.equal(entities.GrowthPublishJob.records[0].state, 'canceled');
          assert.equal(
            entities.GrowthContentPlan.records[0].delivery_status,
            'canceled',
          );
          finalCommitObserved = true;
        }
        return originalSourceUpdateMany(query, operations);
      };
      const handler = loadGrowthHandler(managePath, { base44, env });
      const nextSource = { ...originalSource, ...item.sourcePatch };

      const result = await invokeJson(handler, {
        action: 'register_sources',
        sources: [nextSource],
      });

      assert.equal(result.status, 200);
      assert.equal(finalCommitObserved, true);
      assert.equal(
        entities.GrowthPublishJob.records[0].last_error_code,
        'source_render_lineage_changed',
      );
      assert.equal(
        entities.GrowthContentPlan.records[0].delivery_status,
        'canceled',
      );
      assert.equal(
        entities.GrowthSourceAsset.records[0].source_reference,
        nextSource.source_reference,
      );
      assert.equal(
        entities.GrowthSourceAsset.records[0].source_sha256,
        nextSource.source_sha256,
      );
      assert.equal(
        entities.GrowthSourceAsset.records[0].privacy_change_pending,
        false,
      );
      assert.equal(
        entities.GrowthSourceAsset.records[0].privacy_change_generation,
        1,
      );
    });
  }
});

test('expired source privacy fences are taken over safely while active fences remain exclusive', async (t) => {
  const expiredCases = [
    {
      name: 'blocked retry',
      sourcePatch: {
        privacy_status: 'blocked',
        active: true,
        privacy_note: 'Retry the crashed block operation.',
      },
    },
    {
      name: 'inactive retry',
      sourcePatch: {
        privacy_status: 'safe',
        active: false,
        privacy_note: 'Retry the crashed inactivation operation.',
      },
    },
  ];
  for (const item of expiredCases) {
    await t.test(item.name, async () => {
      const oldToken = `crashed-${item.name.replaceAll(' ', '-')}`;
      const oldGeneration = 8;
      const artifact = await approvedArtifact({
        id: `artifact_stale_source_fence_${item.name.replaceAll(' ', '_')}`,
      });
      const job = {
        id: `job_stale_source_fence_${item.name.replaceAll(' ', '_')}`,
        artifact_id: artifact.id,
        artifact_key: artifact.artifact_key,
        campaign: artifact.campaign,
        platform: artifact.platform,
        platform_content_id: artifact.platform_content_id,
        state: 'queued',
        lease_generation: 0,
      };
      const plan = {
        id: `plan_stale_source_fence_${item.name.replaceAll(' ', '_')}`,
        campaign: artifact.campaign,
        content: artifact.platform_content_id,
        sprint: 'content-engine',
        delivery_managed_by: 'buffer',
        delivery_status: 'planned',
      };
      const { base44, entities } = createGrowthBase44({
        sources: [{
          id: 'source_stale_privacy_fence',
          ...safeSource,
          privacy_change_pending: true,
          privacy_change_generation: oldGeneration,
          privacy_change_token: oldToken,
          privacy_change_expires_at: new Date(
            Date.now() - 60 * 1000,
          ).toISOString(),
        }],
        artifacts: [artifact],
        jobs: [job],
        plans: [plan],
      });
      const originalSourceUpdateMany = entities.GrowthSourceAsset.updateMany;
      let takeoverToken;
      let takeoverExpiry;
      let staleCommitAttempted = false;
      let finalCommitObserved = false;
      entities.GrowthSourceAsset.updateMany = async (query, operations) => {
        if (operations?.$inc?.privacy_change_generation === 1) {
          assert.equal(query.privacy_change_token, oldToken);
          assert.equal(query.privacy_change_generation, oldGeneration);
          const result = await originalSourceUpdateMany(query, operations);
          const locked = entities.GrowthSourceAsset.records[0];
          takeoverToken = locked.privacy_change_token;
          takeoverExpiry = locked.privacy_change_expires_at;
          assert.notEqual(takeoverToken, oldToken);
          assert.equal(locked.privacy_change_generation, oldGeneration + 1);
          assert.equal(locked.privacy_change_pending, true);

          const staleCommit = await originalSourceUpdateMany(
            {
              id: locked.id,
              privacy_change_pending: true,
              privacy_change_generation: oldGeneration,
              privacy_change_token: oldToken,
            },
            {
              $set: {
                privacy_status: 'blocked',
                active: false,
                privacy_change_pending: false,
                privacy_change_token: '',
              },
              $unset: { privacy_change_expires_at: true },
            },
          );
          staleCommitAttempted = true;
          assert.equal(staleCommit.updated, 0);
          assert.equal(locked.privacy_change_token, takeoverToken);
          assert.equal(locked.privacy_change_pending, true);
          return result;
        }
        if (
          operations?.$set?.privacy_change_pending === false
          && Object.hasOwn(operations.$set, 'privacy_status')
        ) {
          assert.equal(query.privacy_change_token, takeoverToken);
          assert.equal(
            query.privacy_change_generation,
            oldGeneration + 1,
          );
          assert.equal(entities.GrowthPublishJob.records[0].state, 'canceled');
          assert.equal(
            entities.GrowthContentPlan.records[0].delivery_status,
            'canceled',
          );
          finalCommitObserved = true;
        }
        return originalSourceUpdateMany(query, operations);
      };
      const handler = loadGrowthHandler(managePath, { base44, env });

      const result = await invokeJson(handler, {
        action: 'register_sources',
        sources: [{ ...safeSource, ...item.sourcePatch }],
      });

      assert.equal(result.status, 200);
      assert.equal(staleCommitAttempted, true);
      assert.equal(finalCommitObserved, true);
      assert.ok(
        new Date(takeoverExpiry).getTime() > Date.now(),
      );
      const saved = entities.GrowthSourceAsset.records[0];
      assert.equal(saved.privacy_status, item.sourcePatch.privacy_status);
      assert.equal(saved.active, item.sourcePatch.active);
      assert.equal(saved.privacy_change_pending, false);
      assert.equal(saved.privacy_change_generation, oldGeneration + 1);
      assert.equal(saved.privacy_change_token, '');
      assert.equal(saved.privacy_change_expires_at, undefined);
      assert.equal(entities.GrowthPublishJob.records[0].state, 'canceled');
      assert.equal(
        entities.GrowthContentPlan.records[0].delivery_status,
        'canceled',
      );
    });
  }

  await t.test('active unexpired fence', async () => {
    const activeFence = {
      id: 'source_active_privacy_fence',
      ...safeSource,
      privacy_change_pending: true,
      privacy_change_generation: 12,
      privacy_change_token: 'active-source-privacy-owner',
      privacy_change_expires_at: new Date(
        Date.now() + 5 * 60 * 1000,
      ).toISOString(),
    };
    const { base44, entities } = createGrowthBase44({
      sources: [activeFence],
    });
    const before = structuredClone(entities.GrowthSourceAsset.records[0]);
    const handler = loadGrowthHandler(managePath, { base44, env });

    const result = await invokeJson(handler, {
      action: 'register_sources',
      sources: [{
        ...safeSource,
        privacy_status: 'blocked',
        privacy_note: 'This must wait for the active fence owner.',
      }],
    });

    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'source_privacy_change_in_progress');
    assert.deepEqual(entities.GrowthSourceAsset.records[0], before);
    assert.equal(entities.GrowthSourceAsset.counters.updateMany, 0);
    assert.equal(entities.GrowthPublishJob.counters.list, 0);
  });
});

test('a pending privacy fence makes an empty dependency snapshot safe against a late publish job', async () => {
  const mediaBytes = new TextEncoder().encode(
    'source-pending-empty-snapshot-race-media',
  );
  const mediaSha256 = await growthHelpers.sha256BytesHex(mediaBytes);
  const artifact = await approvedArtifact({
    id: 'artifact_source_pending_empty_snapshot',
    media_url:
      `https://media.firstknock.online/sha256/${mediaSha256}-pending-race.png`,
    media_sha256: mediaSha256,
  });
  const { base44, entities } = createGrowthBase44({
    sources: [{ id: 'source_pending_empty_snapshot', ...safeSource }],
    artifacts: [artifact],
  });
  const manager = loadGrowthHandler(managePath, { base44, env });
  const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const scheduleRequest = {
    action: 'schedule',
    artifact_id: artifact.id,
    due_at: dueAt,
    timezone: 'America/Phoenix',
    scheduling_type: 'automatic',
  };

  const schedulerSourceSnapshot = deferred();
  const managerEmptyJobSnapshot = deferred();
  const workerFinished = deferred();
  const originalSourceFilter = entities.GrowthSourceAsset.filter;
  let sourceReads = 0;
  entities.GrowthSourceAsset.filter = async (...args) => {
    const snapshot = await originalSourceFilter(...args);
    sourceReads += 1;
    if (sourceReads === 1) {
      schedulerSourceSnapshot.resolve();
      await managerEmptyJobSnapshot.promise;
    }
    return snapshot;
  };
  const originalJobList = entities.GrowthPublishJob.list;
  let dependencySnapshotBlocked = false;
  entities.GrowthPublishJob.list = async (...args) => {
    const snapshot = await originalJobList(...args);
    if (!dependencySnapshotBlocked) {
      dependencySnapshotBlocked = true;
      assert.deepEqual(snapshot, []);
      assert.equal(
        entities.GrowthSourceAsset.records[0].privacy_change_pending,
        true,
      );
      managerEmptyJobSnapshot.resolve();
      await workerFinished.promise;
    }
    return snapshot;
  };

  const schedulePromise = invokeJson(manager, scheduleRequest);
  await schedulerSourceSnapshot.promise;
  const downgradePromise = invokeJson(manager, {
    action: 'register_sources',
    sources: [{
      ...safeSource,
      privacy_status: 'blocked',
      privacy_note: 'Block even if a stale scheduler creates after dependency scan.',
    }],
  });
  await managerEmptyJobSnapshot.promise;
  const scheduleResult = await schedulePromise;
  assert.equal(scheduleResult.status, 201);
  assert.equal(entities.GrowthPublishJob.records.length, 1);
  assert.equal(
    entities.GrowthSourceAsset.records[0].privacy_change_pending,
    true,
  );

  let providerFetches = 0;
  let createCalls = 0;
  const worker = loadGrowthHandler(
    'base44/functions/processGrowthPublishQueue/entry.ts',
    {
      base44,
      env,
      fetchImpl: async (_url, options) => {
        providerFetches += 1;
        const query = JSON.parse(String(options?.body || '{}')).query;
        if (query.includes('createPost')) createCalls += 1;
        throw new Error('pending source privacy must fail before provider access');
      },
    },
  );

  const workerResult = await invokeJson(
    worker,
    {},
    { secret: env.GROWTH_PUBLISH_WORKER_SECRET },
  );
  workerFinished.resolve();
  const downgradeResult = await downgradePromise;

  assert.equal(downgradeResult.status, 200);
  assert.equal(workerResult.status, 200);
  assert.equal(providerFetches, 0);
  assert.equal(createCalls, 0);
  assert.equal(
    entities.GrowthSourceAsset.records[0].privacy_status,
    'blocked',
  );
  assert.equal(entities.GrowthSourceAsset.records[0].active, true);
  assert.equal(
    entities.GrowthSourceAsset.records[0].privacy_change_pending,
    false,
  );
  assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'source_privacy_clearance_changed',
  );
  assert.equal(
    entities.GrowthPublishJob.records[0].provider_post_id,
    undefined,
  );
  assert.equal(
    entities.GrowthContentPlan.records[0].delivery_status,
    'canceled',
  );
});

test('a worker claim before the privacy fence blocks downgrade and proceeds only after release', async () => {
  const mediaBytes = new TextEncoder().encode(
    'source-claim-before-privacy-fence-media',
  );
  const mediaSha256 = await growthHelpers.sha256BytesHex(mediaBytes);
  const artifact = await approvedArtifact({
    id: 'artifact_claim_before_source_fence',
    media_url:
      `https://media.firstknock.online/sha256/${mediaSha256}-claim-first.png`,
    media_sha256: mediaSha256,
  });
  const { base44, entities } = createGrowthBase44({
    sources: [{ id: 'source_claim_before_fence', ...safeSource }],
    artifacts: [artifact],
  });
  const manager = loadGrowthHandler(managePath, { base44, env });
  const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const scheduled = await invokeJson(manager, {
    action: 'schedule',
    artifact_id: artifact.id,
    due_at: dueAt,
    timezone: 'America/Phoenix',
    scheduling_type: 'automatic',
  });
  assert.equal(scheduled.status, 201);

  const workerClaimed = deferred();
  const releaseWorker = deferred();
  const originalJobGet = entities.GrowthPublishJob.get;
  let claimObserved = false;
  entities.GrowthPublishJob.get = async (...args) => {
    const saved = await originalJobGet(...args);
    if (!claimObserved && saved?.state === 'processing') {
      claimObserved = true;
      workerClaimed.resolve();
      await releaseWorker.promise;
    }
    return saved;
  };

  let createCalls = 0;
  const worker = loadGrowthHandler(
    'base44/functions/processGrowthPublishQueue/entry.ts',
    {
      base44,
      env,
      fetchImpl: async (url, options) => {
        const liveSource = entities.GrowthSourceAsset.records[0];
        assert.equal(liveSource.privacy_status, 'safe');
        assert.equal(liveSource.active, true);
        assert.equal(liveSource.privacy_change_pending, false);
        if (String(url).startsWith(`${env.GROWTH_MEDIA_ORIGIN}/`)) {
          return new Response(mediaBytes, {
            status: 200,
            headers: {
              'content-type': artifact.mime_type,
              'content-length': String(mediaBytes.byteLength),
            },
          });
        }
        const query = JSON.parse(String(options?.body || '{}')).query;
        if (query.includes('channel(input:')) {
          return Response.json({
            data: {
              channel: {
                id: env.BUFFER_INSTAGRAM_CHANNEL_ID,
                organizationId: env.BUFFER_ORGANIZATION_ID,
                service: 'instagram',
                isDisconnected: false,
                isLocked: false,
                isQueuePaused: false,
              },
            },
          });
        }
        assert.match(query, /createPost/);
        createCalls += 1;
        return Response.json({
          data: {
            createPost: {
              __typename: 'PostActionSuccess',
              post: {
                id: 'buffer_claim_before_source_fence',
                channelId: env.BUFFER_INSTAGRAM_CHANNEL_ID,
                channelService: 'instagram',
                status: 'scheduled',
                dueAt,
                sentAt: null,
                externalLink: null,
                text: artifact.provider_text,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                assets: [{
                  source: artifact.media_url,
                  mimeType: artifact.mime_type,
                  type: 'image',
                }],
                error: null,
              },
            },
          },
        });
      },
    },
  );

  const workerPromise = invokeJson(
    worker,
    {},
    { secret: env.GROWTH_PUBLISH_WORKER_SECRET },
  );
  await workerClaimed.promise;
  const downgradeResult = await invokeJson(manager, {
    action: 'register_sources',
    sources: [{
      ...safeSource,
      privacy_status: 'blocked',
      privacy_note: 'Processing began before the privacy fence.',
    }],
  });

  assert.equal(downgradeResult.status, 409);
  assert.equal(
    downgradeResult.body.error,
    'source_privacy_cancellation_required',
  );
  assert.equal(entities.GrowthSourceAsset.records[0].privacy_status, 'safe');
  assert.equal(entities.GrowthSourceAsset.records[0].active, true);
  assert.equal(
    entities.GrowthSourceAsset.records[0].privacy_change_pending,
    false,
  );
  assert.equal(
    entities.GrowthSourceAsset.records[0].privacy_change_generation,
    1,
  );

  releaseWorker.resolve();
  const workerResult = await workerPromise;

  assert.equal(workerResult.status, 200);
  assert.equal(claimObserved, true);
  assert.equal(createCalls, 1);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'scheduled');
  assert.equal(
    entities.GrowthPublishJob.records[0].provider_post_id,
    'buffer_claim_before_source_fence',
  );
  assert.equal(
    entities.GrowthContentPlan.records[0].delivery_status,
    'planned',
  );
});

test('ambiguous or provider-known work blocks source downgrade without mutation', async (t) => {
  const cases = [
    {
      name: 'provider-known work',
      job: {
        state: 'scheduled',
        provider_post_id: 'buffer_provider_known_source',
        provider_status: 'scheduled',
      },
    },
    {
      name: 'create reconciliation',
      job: {
        state: 'create_reconcile',
        last_error_code: 'provider_create_unconfirmed',
      },
    },
    {
      name: 'manual review ambiguity',
      job: {
        state: 'review_required',
        last_error_code: 'provider_create_unresolved',
      },
    },
    {
      name: 'provider-known render identity change',
      job: {
        state: 'scheduled',
        provider_post_id: 'buffer_provider_known_lineage',
        provider_status: 'scheduled',
      },
      sourcePatch: {
        source_sha256: 'f'.repeat(64),
      },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const artifact = await approvedArtifact({
        id: `artifact_source_block_${item.name.replaceAll(' ', '_')}`,
      });
      const job = {
        id: `job_source_block_${item.name.replaceAll(' ', '_')}`,
        artifact_id: artifact.id,
        artifact_key: artifact.artifact_key,
        campaign: artifact.campaign,
        platform: artifact.platform,
        platform_content_id: artifact.platform_content_id,
        lease_generation: 2,
        ...item.job,
      };
      const plan = {
        id: `plan_source_block_${item.name.replaceAll(' ', '_')}`,
        campaign: artifact.campaign,
        content: artifact.platform_content_id,
        sprint: 'content-engine',
        delivery_managed_by: 'buffer',
        delivery_status: 'planned',
      };
      const { base44, entities } = createGrowthBase44({
        sources: [{ id: 'source_blocked_downgrade', ...safeSource }],
        artifacts: [artifact],
        jobs: [job],
        plans: [plan],
      });
      const before = {
        sources: structuredClone(entities.GrowthSourceAsset.records),
        artifacts: structuredClone(entities.GrowthCreativeArtifact.records),
        jobs: structuredClone(entities.GrowthPublishJob.records),
        plans: structuredClone(entities.GrowthContentPlan.records),
      };
      const handler = loadGrowthHandler(managePath, { base44, env });

      const result = await invokeJson(handler, {
        action: 'register_sources',
        sources: [{
          ...safeSource,
          ...(item.sourcePatch || {
            privacy_status: 'blocked',
            privacy_note:
              'This source must remain safe until ambiguity is resolved.',
          }),
        }],
      });

      assert.equal(result.status, 409);
      assert.equal(
        result.body.error,
        'source_privacy_cancellation_required',
      );
      const savedSource = entities.GrowthSourceAsset.records[0];
      assert.equal(savedSource.privacy_status, 'safe');
      assert.equal(savedSource.active, true);
      assert.equal(savedSource.privacy_change_pending, false);
      assert.equal(
        savedSource.privacy_change_generation,
        Number(before.sources[0].privacy_change_generation || 0) + 1,
      );
      for (const field of [
        'id',
        'asset_key',
        'title',
        'source_reference',
        'media_kind',
        'mime_type',
        'width',
        'height',
        'safe_summary',
        'privacy_note',
        'created_date',
      ]) {
        assert.equal(savedSource[field], before.sources[0][field], field);
      }
      assert.deepEqual(
        entities.GrowthCreativeArtifact.records,
        before.artifacts,
      );
      assert.deepEqual(entities.GrowthPublishJob.records, before.jobs);
      assert.deepEqual(entities.GrowthContentPlan.records, before.plans);
      assert.equal(entities.GrowthSourceAsset.counters.updateMany, 2);
      assert.equal(entities.GrowthPublishJob.counters.updateMany, 0);
      assert.equal(entities.GrowthContentPlan.counters.updateMany, 0);
    });
  }
});

test('concurrent schedule requests create at most one durable publish job', async () => {
  const { base44, entities } = createGrowthBase44();
  const handler = loadGrowthHandler(managePath, { base44, env });

  let result = await invokeJson(handler, {
    action: 'register_sources',
    sources: [safeSource],
  });
  assert.equal(result.status, 200);

  result = await invokeJson(handler, {
    action: 'create_draft',
    artifact: draftInput,
  });
  assert.equal(result.status, 201);
  const artifactId = result.body.artifact.id;

  result = await invokeJson(handler, {
    action: 'review',
    artifact_id: artifactId,
    privacy_cleared: true,
    demo_labeled: true,
    claims_supported: true,
    media_rights_confirmed: true,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.passed, true);

  result = await invokeJson(handler, {
    action: 'approve',
    artifact_id: artifactId,
  });
  assert.equal(result.status, 200);

  const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const request = {
    action: 'schedule',
    artifact_id: artifactId,
    due_at: dueAt,
    timezone: 'America/Phoenix',
    scheduling_type: 'automatic',
  };
  const originalFilter = entities.GrowthPublishJob.filter;
  let exactReads = 0;
  let releaseExactReads;
  const exactReadsReady = new Promise((resolve) => {
    releaseExactReads = resolve;
  });
  let relatedReads = 0;
  let releaseRelatedReads;
  const relatedReadsReady = new Promise((resolve) => {
    releaseRelatedReads = resolve;
  });
  entities.GrowthPublishJob.filter = async (...args) => {
    const [query] = args;
    const snapshot = await originalFilter(...args);
    if (query?.job_key) {
      exactReads += 1;
      if (exactReads === 2) releaseExactReads();
      await exactReadsReady;
    } else if (query?.platform_content_id) {
      relatedReads += 1;
      if (relatedReads === 2) releaseRelatedReads();
      await relatedReadsReady;
    }
    return snapshot;
  };
  const outcomes = await Promise.all([
    invokeJson(handler, request),
    invokeJson(handler, request),
  ]);

  assert.equal(
    outcomes.filter((outcome) => outcome.status === 201).length,
    1,
    'only one request may create the durable job',
  );
  assert.equal(
    outcomes.every((outcome) => [200, 201].includes(outcome.status)),
    true,
  );
  assert.equal(entities.GrowthPublishJob.records.length, 1);
  assert.equal(
    new Set(entities.GrowthPublishJob.records.map((job) => job.job_key)).size,
    1,
  );
});

test('duplicate approved artifact rows scheduled concurrently cannot create duplicate durable work', async () => {
  const firstArtifact = await approvedArtifact();
  const secondArtifact = {
    ...firstArtifact,
    id: 'artifact_approved_duplicate',
  };
  const { base44, entities } = createGrowthBase44({
    sources: [safeSource],
    artifacts: [firstArtifact, secondArtifact],
  });
  const handler = loadGrowthHandler(managePath, { base44, env });
  const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const originalFilter = entities.GrowthPublishJob.filter;
  let exactReads = 0;
  let releaseExactReads;
  const exactReadsReady = new Promise((resolvePromise) => {
    releaseExactReads = resolvePromise;
  });
  let relatedReads = 0;
  let releaseRelatedReads;
  const relatedReadsReady = new Promise((resolvePromise) => {
    releaseRelatedReads = resolvePromise;
  });
  entities.GrowthPublishJob.filter = async (...args) => {
    const [query] = args;
    const snapshot = await originalFilter(...args);
    if (query?.job_key) {
      exactReads += 1;
      if (exactReads === 2) releaseExactReads();
      await exactReadsReady;
    } else if (query?.platform_content_id) {
      relatedReads += 1;
      if (relatedReads === 2) releaseRelatedReads();
      await relatedReadsReady;
    }
    return snapshot;
  };

  const schedule = (artifactId) => invokeJson(handler, {
    action: 'schedule',
    artifact_id: artifactId,
    due_at: dueAt,
    timezone: 'America/Phoenix',
    scheduling_type: 'automatic',
  });
  const outcomes = await Promise.all([
    schedule(firstArtifact.id),
    schedule(secondArtifact.id),
  ]);

  assert.ok(
    outcomes.every((outcome) => [200, 201, 409].includes(outcome.status)),
  );
  assert.equal(
    outcomes.every(
      (outcome) => outcome.body.error === 'hook_dedupe_conflict',
    ),
    true,
    'duplicate same-platform hooks must fail before durable scheduling',
  );
  assert.equal(entities.GrowthPublishJob.records.length, 0);
  assert.equal(entities.GrowthContentPlan.records.length, 0);
  assert.equal(
    entities.GrowthCreativeArtifact.records.every(
      (artifact) => !artifact.schedule_lock_token,
    ),
    true,
  );
});

test('an expired exact schedule owner loses to a fresh scheduler or approval revoke', async (t) => {
  for (const mode of ['fresh scheduler takeover', 'approval revoke']) {
    await t.test(mode, async () => {
      const clock = controlledClock();
      const artifact = await approvedArtifact({
        id: `artifact_expired_schedule_${mode.replaceAll(' ', '_')}`,
        artifact_key: `ig-expired-schedule-${mode.replaceAll(' ', '-')}`,
        platform_content_id:
          `ig-expired-schedule-${mode.replaceAll(' ', '-')}`,
      });
      const { base44, entities } = createGrowthBase44({
        sources: [safeSource],
        artifacts: [artifact],
      });
      const handler = loadGrowthHandler(managePath, {
        base44,
        env,
        dateImpl: clock.DateImpl,
      });
      const dueAt = new Date(
        clock.now() + 60 * 60 * 1000,
      ).toISOString();
      const request = {
        action: 'schedule',
        artifact_id: artifact.id,
        due_at: dueAt,
        timezone: 'America/Phoenix',
        scheduling_type: 'automatic',
      };
      const staleCheckReached = deferred();
      const competingOwnerFinished = deferred();
      const originalArtifactFilter = entities.GrowthCreativeArtifact.filter;
      let artifactLockReads = 0;
      let staleExactSnapshot;
      entities.GrowthCreativeArtifact.filter = async (...args) => {
        const [query] = args;
        const snapshot = await originalArtifactFilter(...args);
        if (query?.artifact_key) {
          artifactLockReads += 1;
          if (artifactLockReads === 3) {
            staleExactSnapshot = structuredClone(snapshot[0]);
            staleCheckReached.resolve();
            await competingOwnerFinished.promise;
          }
        }
        return snapshot;
      };

      const staleSchedulePromise = invokeJson(handler, request);
      await staleCheckReached.promise;
      assert.ok(staleExactSnapshot.schedule_lock_token);
      assert.equal(staleExactSnapshot.schedule_lock_generation, 1);
      const staleExpiryMs = new Date(
        staleExactSnapshot.schedule_lock_expires_at,
      ).getTime();
      assert.ok(staleExpiryMs > clock.now());
      clock.set(staleExpiryMs + 1);

      let competingResult;
      if (mode === 'fresh scheduler takeover') {
        entities.GrowthPublishHeartbeat.records[0].observed_at = new Date(
          clock.now(),
        ).toISOString();
        competingResult = await invokeJson(handler, request);
        assert.equal(competingResult.status, 201);
      } else {
        competingResult = await invokeJson(handler, {
          action: 'revoke',
          artifact_id: artifact.id,
          note: 'Revoke after the stale scheduler lease expired.',
        });
        assert.equal(competingResult.status, 200);
      }
      competingOwnerFinished.resolve();
      const staleResult = await staleSchedulePromise;

      assert.equal(staleResult.status, 409);
      assert.equal(staleResult.body.error, 'publish_schedule_in_progress');
      assert.ok(
        new Date(staleExactSnapshot.schedule_lock_expires_at).getTime()
          <= clock.now(),
      );
      const savedArtifact = entities.GrowthCreativeArtifact.records[0];
      assert.equal(savedArtifact.schedule_lock_token, '');
      assert.equal(savedArtifact.schedule_lock_expires_at, undefined);
      if (mode === 'fresh scheduler takeover') {
        assert.equal(savedArtifact.approval_status, 'approved');
        assert.equal(savedArtifact.schedule_lock_generation, 2);
        assert.equal(entities.GrowthPublishJob.records.length, 1);
        assert.equal(entities.GrowthPublishJob.records[0].state, 'queued');
        assert.equal(entities.GrowthContentPlan.records.length, 1);
        assert.equal(
          entities.GrowthContentPlan.records[0].delivery_status,
          'planned',
        );
      } else {
        assert.equal(savedArtifact.approval_status, 'revoked');
        assert.equal(savedArtifact.schedule_lock_generation, 1);
        assert.equal(entities.GrowthPublishJob.records.length, 0);
        assert.equal(entities.GrowthContentPlan.records.length, 0);
      }
    });
  }
});

test('manager expiry durably reconciles the plan before final cancellation', async () => {
  const artifact = await approvedArtifact({
    id: 'artifact_expired_reservation_cleanup',
    artifact_key: 'ig-expired-reservation-cleanup',
    platform_content_id: 'ig-expired-reservation-cleanup',
  });
  const dueAt = new Date(Date.now() + 60 * 1000).toISOString();
  const reservation = await pendingScheduleReservation(artifact, dueAt);
  const plan = manualSeedPlan({
    platform: artifact.platform,
    campaign: artifact.campaign,
    content: artifact.platform_content_id,
    planned_publish_at: dueAt,
    delivery_managed_by: 'buffer',
    delivery_status: 'planned',
  });
  const { base44, entities } = createGrowthBase44({
    sources: [safeSource],
    artifacts: [artifact],
    jobs: [reservation],
    plans: [plan],
  });
  const events = [];
  const originalJobUpdateMany = entities.GrowthPublishJob.updateMany;
  entities.GrowthPublishJob.updateMany = async (query, operations) => {
    if (operations?.$set?.state === 'delivery_reconcile') {
      events.push('repair-persisted');
    }
    if (operations?.$set?.state === 'canceled') {
      events.push('job-canceled');
    }
    return originalJobUpdateMany(query, operations);
  };
  const originalPlanUpdateMany = entities.GrowthContentPlan.updateMany;
  entities.GrowthContentPlan.updateMany = async (query, operations) => {
    if (operations?.$set?.delivery_status === 'canceled') {
      assert.equal(
        entities.GrowthPublishJob.records[0].state,
        'delivery_reconcile',
        'repair ownership must be durable before the plan cancellation CAS',
      );
      events.push('plan-canceled');
    }
    return originalPlanUpdateMany(query, operations);
  };
  const handler = loadGrowthHandler(managePath, { base44, env });

  const result = await invokeJson(handler, {
    action: 'schedule',
    artifact_id: artifact.id,
    due_at: dueAt,
    timezone: 'America/Phoenix',
    scheduling_type: 'automatic',
  });

  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'invalid_publish_schedule');
  assert.deepEqual(events, [
    'repair-persisted',
    'plan-canceled',
    'job-canceled',
  ]);
  const savedJob = entities.GrowthPublishJob.records[0];
  assert.equal(savedJob.state, 'canceled');
  assert.equal(savedJob.delivery_reconcile_target, undefined);
  assert.equal(savedJob.next_retry_at, undefined);
  assert.equal(savedJob.last_error_code, 'schedule_reservation_expired');
  assert.equal(savedJob.lease_token, undefined);
  assert.equal(
    entities.GrowthContentPlan.records[0].delivery_status,
    'canceled',
  );
});

test('manager expiry leaves durable repair when plan cancellation loses CAS', async () => {
  const artifact = await approvedArtifact({
    id: 'artifact_expired_reservation_repair',
    artifact_key: 'ig-expired-reservation-repair',
    platform_content_id: 'ig-expired-reservation-repair',
  });
  const dueAt = new Date(Date.now() + 60 * 1000).toISOString();
  const reservation = await pendingScheduleReservation(artifact, dueAt);
  const plan = manualSeedPlan({
    platform: artifact.platform,
    campaign: artifact.campaign,
    content: artifact.platform_content_id,
    planned_publish_at: dueAt,
    delivery_managed_by: 'buffer',
    delivery_status: 'planned',
  });
  const { base44, entities } = createGrowthBase44({
    sources: [safeSource],
    artifacts: [artifact],
    jobs: [reservation],
    plans: [plan],
  });
  const originalPlanUpdateMany = entities.GrowthContentPlan.updateMany;
  let cancellationAttempts = 0;
  entities.GrowthContentPlan.updateMany = async (query, operations) => {
    if (operations?.$set?.delivery_status === 'canceled') {
      cancellationAttempts += 1;
      assert.equal(
        entities.GrowthPublishJob.records[0].state,
        'delivery_reconcile',
      );
      return { success: true, updated: 0, has_more: false };
    }
    return originalPlanUpdateMany(query, operations);
  };
  const handler = loadGrowthHandler(managePath, { base44, env });

  const result = await invokeJson(handler, {
    action: 'schedule',
    artifact_id: artifact.id,
    due_at: dueAt,
    timezone: 'America/Phoenix',
    scheduling_type: 'automatic',
  });

  assert.equal(result.status, 409);
  assert.equal(
    result.body.error,
    'content_plan_changed_before_delivery_update',
  );
  assert.equal(cancellationAttempts, 1);
  const savedJob = entities.GrowthPublishJob.records[0];
  assert.equal(savedJob.state, 'delivery_reconcile');
  assert.equal(savedJob.delivery_reconcile_target, 'canceled');
  assert.equal(savedJob.last_error_code, 'schedule_reservation_expired');
  assert.ok(new Date(savedJob.next_retry_at).getTime() > Date.now());
  assert.equal(savedJob.lease_token, undefined);
  assert.equal(
    entities.GrowthContentPlan.records[0].delivery_status,
    'planned',
  );

  const retry = await invokeJson(handler, {
    action: 'schedule',
    artifact_id: artifact.id,
    due_at: dueAt,
    timezone: 'America/Phoenix',
    scheduling_type: 'automatic',
  });
  assert.equal(retry.status, 409);
  assert.equal(retry.body.error, 'content_plan_cancellation_pending');
});

test('source downgrade and approval revoke fence expired reservation cleanup', async (t) => {
  for (const mode of ['source downgrade', 'approval revoke']) {
    for (const planCas of ['success', 'lost']) {
      await t.test(`${mode}; plan CAS ${planCas}`, async () => {
        const suffix = `${mode.replaceAll(' ', '-')}-${planCas}`;
        const artifact = await approvedArtifact({
          id: `artifact_expired_dependency_${suffix}`,
          artifact_key: `ig-expired-dependency-${suffix}`,
          platform_content_id: `ig-expired-dependency-${suffix}`,
        });
        const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const reservation = await pendingScheduleReservation(artifact, dueAt);
        const plan = manualSeedPlan({
          platform: artifact.platform,
          campaign: artifact.campaign,
          content: artifact.platform_content_id,
          planned_publish_at: dueAt,
          delivery_managed_by: 'buffer',
          delivery_status: 'planned',
        });
        const { base44, entities } = createGrowthBase44({
          sources: [safeSource],
          artifacts: [artifact],
          jobs: [reservation],
          plans: [plan],
        });
        if (planCas === 'lost') {
          const originalPlanUpdateMany = entities.GrowthContentPlan.updateMany;
          entities.GrowthContentPlan.updateMany = async (query, operations) => {
            if (operations?.$set?.delivery_status === 'canceled') {
              assert.equal(
                entities.GrowthPublishJob.records[0].state,
                'delivery_reconcile',
              );
              return { success: true, updated: 0, has_more: false };
            }
            return originalPlanUpdateMany(query, operations);
          };
        }
        const handler = loadGrowthHandler(managePath, { base44, env });
        const result = mode === 'source downgrade'
          ? await invokeJson(handler, {
            action: 'register_sources',
            sources: [{
              ...safeSource,
              privacy_status: 'blocked',
              privacy_note: 'Owner withdrew this source before delivery.',
            }],
          })
          : await invokeJson(handler, {
            action: 'revoke',
            artifact_id: artifact.id,
            note: 'Revoke after the scheduler reservation expired.',
          });

        const savedJob = entities.GrowthPublishJob.records[0];
        const savedPlan = entities.GrowthContentPlan.records[0];
        const savedArtifact = entities.GrowthCreativeArtifact.records[0];
        const savedSource = entities.GrowthSourceAsset.records[0];
        if (planCas === 'success') {
          assert.equal(result.status, 200);
          assert.equal(savedJob.state, 'canceled');
          assert.equal(savedJob.delivery_reconcile_target, undefined);
          assert.equal(savedPlan.delivery_status, 'canceled');
          if (mode === 'source downgrade') {
            assert.equal(savedSource.privacy_status, 'blocked');
            assert.equal(savedArtifact.approval_status, 'approved');
          } else {
            assert.equal(savedSource.privacy_status, 'safe');
            assert.equal(savedArtifact.approval_status, 'revoked');
          }
        } else {
          assert.equal(result.status, 409);
          assert.equal(
            result.body.error,
            'content_plan_changed_before_delivery_update',
          );
          assert.equal(savedJob.state, 'delivery_reconcile');
          assert.equal(savedJob.delivery_reconcile_target, 'canceled');
          assert.equal(savedPlan.delivery_status, 'planned');
          assert.equal(savedSource.privacy_status, 'safe');
          assert.equal(savedArtifact.approval_status, 'approved');
        }
      });
    }
  }
});

test('post-measurement schedule abort uses durable cancellation before plan cleanup', async () => {
  const artifact = await approvedArtifact({
    id: 'artifact_post_measurement_abort',
    artifact_key: 'ig-post-measurement-abort',
    platform_content_id: 'ig-post-measurement-abort',
  });
  const { base44, entities } = createGrowthBase44({
    sources: [safeSource],
    artifacts: [artifact],
  });
  const events = [];
  const originalJobUpdateMany = entities.GrowthPublishJob.updateMany;
  entities.GrowthPublishJob.updateMany = async (query, operations) => {
    if (operations?.$set?.state === 'queued') {
      return { success: true, updated: 0, has_more: false };
    }
    if (operations?.$set?.state === 'delivery_reconcile') {
      events.push('repair-persisted');
    }
    if (operations?.$set?.state === 'canceled') {
      events.push('job-canceled');
    }
    return originalJobUpdateMany(query, operations);
  };
  const originalPlanUpdateMany = entities.GrowthContentPlan.updateMany;
  entities.GrowthContentPlan.updateMany = async (query, operations) => {
    if (operations?.$set?.delivery_status === 'canceled') {
      assert.equal(
        entities.GrowthPublishJob.records[0].state,
        'delivery_reconcile',
      );
      events.push('plan-canceled');
    }
    return originalPlanUpdateMany(query, operations);
  };
  const handler = loadGrowthHandler(managePath, { base44, env });

  const result = await invokeJson(handler, {
    action: 'schedule',
    artifact_id: artifact.id,
    due_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    timezone: 'America/Phoenix',
    scheduling_type: 'automatic',
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'publish_schedule_in_progress');
  assert.deepEqual(events, [
    'repair-persisted',
    'plan-canceled',
    'job-canceled',
  ]);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'canceled');
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'schedule_reservation_aborted',
  );
  assert.equal(
    entities.GrowthContentPlan.records[0].delivery_status,
    'canceled',
  );
});

test('final schedule persistence requires renewing the exact prior lock expiry', async () => {
  const artifact = await approvedArtifact({
    id: 'artifact_schedule_renewal_fence',
    artifact_key: 'ig-schedule-renewal-fence',
    platform_content_id: 'ig-schedule-renewal-fence',
  });
  const { base44, entities } = createGrowthBase44({
    sources: [safeSource],
    artifacts: [artifact],
  });
  const originalArtifactUpdateMany =
    entities.GrowthCreativeArtifact.updateMany;
  let renewalAttempts = 0;
  let priorExpiry;
  let takeoverSnapshot;
  entities.GrowthCreativeArtifact.updateMany = async (query, operations) => {
    if (
      query?.schedule_lock_expires_at
      && operations?.$set?.schedule_lock_expires_at
      && !operations?.$inc
    ) {
      renewalAttempts += 1;
      const live = entities.GrowthCreativeArtifact.records[0];
      priorExpiry = live.schedule_lock_expires_at;
      assert.equal(query.schedule_lock_expires_at, priorExpiry);
      assert.equal(query.schedule_lock_token, live.schedule_lock_token);
      assert.equal(
        query.schedule_lock_generation,
        live.schedule_lock_generation,
      );
      Object.assign(live, {
        schedule_lock_generation: live.schedule_lock_generation + 1,
        schedule_lock_token: 'fresh-scheduler-takeover-token',
        schedule_lock_expires_at: new Date(
          Date.now() + 5 * 60 * 1000,
        ).toISOString(),
        updated_date: new Date().toISOString(),
      });
      takeoverSnapshot = structuredClone(live);
    }
    return originalArtifactUpdateMany(query, operations);
  };
  const handler = loadGrowthHandler(managePath, { base44, env });

  const result = await invokeJson(handler, {
    action: 'schedule',
    artifact_id: artifact.id,
    due_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    timezone: 'America/Phoenix',
    scheduling_type: 'automatic',
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'publish_schedule_in_progress');
  assert.equal(renewalAttempts, 1);
  assert.ok(priorExpiry);
  assert.deepEqual(
    entities.GrowthCreativeArtifact.records[0],
    takeoverSnapshot,
  );
  assert.equal(entities.GrowthPublishJob.records.length, 0);
  assert.equal(entities.GrowthPublishJob.counters.create, 0);
  assert.equal(entities.GrowthContentPlan.records.length, 0);
  assert.equal(
    entities.GrowthCreativeArtifact.records[0].schedule_lock_token,
    'fresh-scheduler-takeover-token',
  );
});

test('sent or provider-evidenced content IDs cannot be rescheduled under a new artifact hash', async (t) => {
  const artifact = await approvedArtifact({
    id: 'artifact_revised_content',
    revision: 2,
    caption: 'A revised rendition that intentionally has a different approval hash.',
  });
  const cases = [
    {
      name: 'sent evidence',
      job: {
        id: 'prior_sent_job',
        provider: 'buffer',
        platform: 'instagram',
        platform_content_id: artifact.platform_content_id,
        artifact_hash: 'b'.repeat(64),
        state: 'sent',
        provider_post_id: 'buffer_post_sent',
        provider_status: 'sent',
        provider_sent_at: new Date(Date.now() - 60_000).toISOString(),
      },
      error: 'platform_content_already_published',
    },
    {
      name: 'terminal provider evidence',
      job: {
        id: 'prior_provider_evidence_job',
        provider: 'buffer',
        platform: 'instagram',
        platform_content_id: artifact.platform_content_id,
        artifact_hash: 'c'.repeat(64),
        state: 'failed',
        provider_post_id: 'buffer_post_unresolved',
        provider_status: 'error',
      },
      error: 'terminal_job_has_provider_evidence',
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      assert.notEqual(item.job.artifact_hash, artifact.approved_hash);
      const { base44, entities } = createGrowthBase44({
        sources: [safeSource],
        artifacts: [artifact],
        jobs: [item.job],
      });
      const handler = loadGrowthHandler(managePath, { base44, env });
      const result = await invokeJson(handler, {
        action: 'schedule',
        artifact_id: artifact.id,
        due_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        timezone: 'America/Phoenix',
        scheduling_type: 'automatic',
      });

      assert.equal(result.status, 409);
      assert.equal(result.body.error, item.error);
      assert.equal(entities.GrowthPublishJob.records.length, 1);
      assert.equal(entities.GrowthContentPlan.records.length, 0);
    });
  }
});

test('revoke refuses provider-known or in-flight jobs without changing local state', async () => {
  const artifact = {
    id: 'artifact_with_live_provider_work',
    artifact_key: 'ig-live-provider-work',
    approval_status: 'approved',
  };
  const jobs = [
    {
      id: 'job_provider_known',
      artifact_id: artifact.id,
      state: 'scheduled',
      provider_post_id: 'buffer_post_live',
      provider_status: 'scheduled',
      lease_generation: 1,
    },
    {
      id: 'job_in_flight',
      artifact_id: artifact.id,
      state: 'processing',
      lease_token: 'worker-lease',
      lease_generation: 2,
    },
  ];
  const { base44, entities } = createGrowthBase44({
    artifacts: [artifact],
    jobs,
  });
  const handler = loadGrowthHandler(managePath, { base44, env });

  const result = await invokeJson(handler, {
    action: 'revoke',
    artifact_id: artifact.id,
    note: 'Do not publish this content.',
  });

  assert.equal(result.status, 409);
  assert.equal(
    entities.GrowthCreativeArtifact.records[0].approval_status,
    'approved',
  );
  assert.deepEqual(
    entities.GrowthPublishJob.records.map((job) => ({
      id: job.id,
      state: job.state,
      provider_post_id: job.provider_post_id,
      lease_token: job.lease_token,
      lease_generation: job.lease_generation,
    })),
    jobs.map((job) => ({
      id: job.id,
      state: job.state,
      provider_post_id: job.provider_post_id,
      lease_token: job.lease_token,
      lease_generation: job.lease_generation,
    })),
  );
});

test('revoke blocks an active scheduling lock without mutating artifact, job, or plan', async () => {
  const artifact = await approvedArtifact({
    id: 'artifact_active_schedule_lock',
    schedule_lock_generation: 7,
    schedule_lock_token: 'active-schedule-lock-token',
    schedule_lock_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });
  const job = {
    id: 'job_active_schedule_lock',
    artifact_id: artifact.id,
    artifact_key: artifact.artifact_key,
    campaign: artifact.campaign,
    platform: artifact.platform,
    platform_content_id: artifact.platform_content_id,
    state: 'queued',
    lease_generation: 0,
  };
  const plan = {
    id: 'plan_active_schedule_lock',
    campaign: artifact.campaign,
    content: artifact.platform_content_id,
    sprint: 'content-engine',
    delivery_managed_by: 'buffer',
    delivery_status: 'planned',
  };
  const { base44, entities } = createGrowthBase44({
    artifacts: [artifact],
    jobs: [job],
    plans: [plan],
  });
  const before = {
    artifacts: structuredClone(entities.GrowthCreativeArtifact.records),
    jobs: structuredClone(entities.GrowthPublishJob.records),
    plans: structuredClone(entities.GrowthContentPlan.records),
  };
  const handler = loadGrowthHandler(managePath, { base44, env });

  const result = await invokeJson(handler, {
    action: 'revoke',
    artifact_id: artifact.id,
    note: 'This revoke must wait for the scheduling owner.',
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'publish_schedule_in_progress');
  assert.deepEqual(entities.GrowthCreativeArtifact.records, before.artifacts);
  assert.deepEqual(entities.GrowthPublishJob.records, before.jobs);
  assert.deepEqual(entities.GrowthContentPlan.records, before.plans);
  assert.equal(entities.GrowthPublishJob.counters.filter, 0);
  assert.equal(entities.GrowthPublishJob.counters.updateMany, 0);
  assert.equal(entities.GrowthContentPlan.counters.updateMany, 0);
  assert.equal(entities.GrowthCreativeArtifact.counters.updateMany, 0);
});

test('revoke rejects duplicate artifact keys before inspecting or mutating provider work', async () => {
  const artifact = await approvedArtifact({
    id: 'artifact_duplicate_key_primary',
    artifact_key: 'ig-duplicate-revoke-key',
    platform_content_id: 'ig-duplicate-revoke-key',
  });
  const duplicate = {
    ...structuredClone(artifact),
    id: 'artifact_duplicate_key_secondary',
  };
  const jobs = [
    {
      id: 'job_duplicate_key_primary',
      artifact_id: artifact.id,
      artifact_key: artifact.artifact_key,
      campaign: artifact.campaign,
      platform: artifact.platform,
      platform_content_id: artifact.platform_content_id,
      state: 'queued',
      lease_generation: 0,
    },
    {
      id: 'job_duplicate_key_secondary_provider_work',
      artifact_id: duplicate.id,
      artifact_key: duplicate.artifact_key,
      campaign: duplicate.campaign,
      platform: duplicate.platform,
      platform_content_id: duplicate.platform_content_id,
      state: 'scheduled',
      provider_post_id: 'buffer_post_duplicate_key',
      provider_status: 'scheduled',
      lease_generation: 2,
    },
  ];
  const plans = [{
    id: 'plan_duplicate_key',
    campaign: artifact.campaign,
    content: artifact.platform_content_id,
    sprint: 'content-engine',
    delivery_managed_by: 'buffer',
    delivery_status: 'planned',
  }];
  const { base44, entities } = createGrowthBase44({
    artifacts: [artifact, duplicate],
    jobs,
    plans,
  });
  const before = {
    artifacts: structuredClone(entities.GrowthCreativeArtifact.records),
    jobs: structuredClone(entities.GrowthPublishJob.records),
    plans: structuredClone(entities.GrowthContentPlan.records),
  };
  const handler = loadGrowthHandler(managePath, { base44, env });

  const result = await invokeJson(handler, {
    action: 'revoke',
    artifact_id: artifact.id,
    note: 'A duplicate identity must fail closed.',
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'creative_artifact_conflict');
  assert.deepEqual(entities.GrowthCreativeArtifact.records, before.artifacts);
  assert.deepEqual(entities.GrowthPublishJob.records, before.jobs);
  assert.deepEqual(entities.GrowthContentPlan.records, before.plans);
  assert.equal(entities.GrowthPublishJob.counters.filter, 0);
  assert.equal(entities.GrowthPublishJob.counters.updateMany, 0);
  assert.equal(entities.GrowthContentPlan.counters.updateMany, 0);
  assert.equal(entities.GrowthCreativeArtifact.counters.updateMany, 0);
});

test('revoke repairs a failed no-provider job measurement plan before revoking approval', async () => {
  const artifact = await approvedArtifact({
    id: 'artifact_failed_without_provider',
  });
  const job = {
    id: 'job_failed_without_provider',
    artifact_id: artifact.id,
    campaign: artifact.campaign,
    platform: artifact.platform,
    platform_content_id: artifact.platform_content_id,
    state: 'failed',
    lease_generation: 1,
    last_error_code: 'provider_invalid_input',
  };
  const plan = {
    id: 'plan_failed_without_provider',
    campaign: artifact.campaign,
    content: artifact.platform_content_id,
    sprint: 'content-engine',
    delivery_managed_by: 'buffer',
    delivery_status: 'planned',
  };
  const { base44, entities } = createGrowthBase44({
    artifacts: [artifact],
    jobs: [job],
    plans: [plan],
  });
  const handler = loadGrowthHandler(managePath, { base44, env });
  const result = await invokeJson(handler, {
    action: 'revoke',
    artifact_id: artifact.id,
    note: 'Repair the stale measurement plan and withdraw approval.',
  });

  assert.equal(result.status, 200);
  assert.equal(
    entities.GrowthCreativeArtifact.records[0].approval_status,
    'revoked',
  );
  assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
  assert.equal(entities.GrowthPublishJob.records[0].provider_post_id, undefined);
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'canceled');
});

test('revoke accepts owner-verified provider evidence while preserving queued measurement repair', async () => {
  const artifact = await approvedArtifact({
    id: 'artifact_verified_provider_cancel',
  });
  const resolvedAt = new Date(Date.now() - 60_000).toISOString();
  const job = {
    id: 'job_verified_provider_cancel',
    artifact_id: artifact.id,
    campaign: artifact.campaign,
    platform: artifact.platform,
    platform_content_id: artifact.platform_content_id,
    state: 'delivery_reconcile',
    delivery_reconcile_target: 'canceled',
    provider_post_id: 'buffer_post_verified_canceled',
    provider_status: 'scheduled',
    lease_generation: 4,
    next_retry_at: new Date().toISOString(),
    last_error_code: 'owner_verified_provider_canceled',
    last_error_message:
      'Owner verified that no live or scheduled Buffer post remains.',
    resolved_by: 'owner_1',
    resolved_at: resolvedAt,
    resolution_evidence_note: 'Canceled in Buffer and independently verified.',
  };
  const plan = {
    id: 'plan_verified_provider_cancel',
    campaign: artifact.campaign,
    content: artifact.platform_content_id,
    sprint: 'content-engine',
    delivery_managed_by: 'buffer',
    delivery_status: 'planned',
  };
  const { base44, entities } = createGrowthBase44({
    artifacts: [artifact],
    jobs: [job],
    plans: [plan],
  });
  const originalPlanUpdateMany = entities.GrowthContentPlan.updateMany;
  let failCancellationOnce = true;
  entities.GrowthContentPlan.updateMany = async (...args) => {
    if (failCancellationOnce) {
      failCancellationOnce = false;
      return { success: true, updated: 0, has_more: false };
    }
    return originalPlanUpdateMany(...args);
  };
  const handler = loadGrowthHandler(managePath, { base44, env });

  const result = await invokeJson(handler, {
    action: 'revoke',
    artifact_id: artifact.id,
    note: 'Withdraw approval while preserving the verified cancellation.',
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.measurement_repair_pending, true);
  assert.equal(
    entities.GrowthCreativeArtifact.records[0].approval_status,
    'revoked',
  );
  const savedJob = entities.GrowthPublishJob.records[0];
  assert.equal(savedJob.state, 'delivery_reconcile');
  assert.equal(savedJob.delivery_reconcile_target, 'canceled');
  assert.equal(savedJob.provider_post_id, job.provider_post_id);
  assert.equal(savedJob.provider_status, job.provider_status);
  assert.equal(savedJob.resolved_by, job.resolved_by);
  assert.equal(savedJob.resolved_at, job.resolved_at);
  assert.equal(
    savedJob.resolution_evidence_note,
    job.resolution_evidence_note,
  );
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'planned');
});

test('revoke repairs an orphaned Instagram measurement plan before changing approval', async (t) => {
  const planFor = (artifact, id) => ({
    id,
    campaign: artifact.campaign,
    content: artifact.platform_content_id,
    sprint: 'content-engine',
    delivery_managed_by: 'buffer',
    delivery_status: 'planned',
  });

  await t.test('successful plan cancellation permits revoke', async () => {
    const artifact = await approvedArtifact({
      id: 'artifact_orphaned_plan_revoke',
    });
    const { base44, entities } = createGrowthBase44({
      artifacts: [artifact],
      plans: [planFor(artifact, 'plan_orphaned_revoke')],
    });
    const handler = loadGrowthHandler(managePath, { base44, env });

    const result = await invokeJson(handler, {
      action: 'revoke',
      artifact_id: artifact.id,
      note: 'Cancel the orphaned plan before withdrawing approval.',
    });

    assert.equal(result.status, 200);
    assert.equal(entities.GrowthPublishJob.records.length, 0);
    assert.equal(
      entities.GrowthContentPlan.records[0].delivery_status,
      'canceled',
    );
    assert.equal(
      entities.GrowthCreativeArtifact.records[0].approval_status,
      'revoked',
    );
  });

  await t.test('plan cancellation failure preserves active approval', async () => {
    const artifact = await approvedArtifact({
      id: 'artifact_orphaned_plan_conflict',
      platform_content_id: 'ig-orphaned-plan-conflict',
      artifact_key: 'ig-orphaned-plan-conflict',
    });
    const { base44, entities } = createGrowthBase44({
      artifacts: [artifact],
      plans: [planFor(artifact, 'plan_orphaned_conflict')],
    });
    entities.GrowthContentPlan.updateMany = async () => ({
      success: true,
      updated: 0,
      has_more: false,
    });
    const handler = loadGrowthHandler(managePath, { base44, env });

    const result = await invokeJson(handler, {
      action: 'revoke',
      artifact_id: artifact.id,
      note: 'This must not revoke until its plan cancellation is durable.',
    });

    assert.equal(result.status, 409);
    assert.equal(
      result.body.error,
      'content_plan_changed_before_delivery_update',
    );
    assert.equal(entities.GrowthPublishJob.records.length, 0);
    assert.equal(
      entities.GrowthContentPlan.records[0].delivery_status,
      'planned',
    );
    assert.equal(
      entities.GrowthCreativeArtifact.records[0].approval_status,
      'approved',
    );
    assert.equal(entities.GrowthCreativeArtifact.counters.updateMany, 0);
  });
});

test('editing a reviewed draft resets review and increments the revision', async () => {
  const { base44, entities } = createGrowthBase44({
    sources: [safeSource],
  });
  const handler = loadGrowthHandler(managePath, { base44, env });
  let result = await invokeJson(handler, { action: 'create_draft', artifact: draftInput });
  const artifactId = result.body.artifact.id;
  await invokeJson(handler, {
    action: 'review',
    artifact_id: artifactId,
    privacy_cleared: true,
    demo_labeled: true,
    claims_supported: true,
    media_rights_confirmed: true,
  });
  result = await invokeJson(handler, {
    action: 'update_draft',
    artifact_id: artifactId,
    artifact: { caption: 'A materially different caption.' },
  });
  assert.equal(result.status, 200);
  const saved = entities.GrowthCreativeArtifact.records[0];
  assert.equal(saved.revision, 2);
  assert.equal(saved.review_status, 'pending');
  assert.equal(saved.approval_status, 'not_approved');
  assert.equal(saved.caption, 'A materially different caption.');
});

test('approval cannot race a failed review and leave failed gates approved', async () => {
  const { base44, entities } = createGrowthBase44({
    sources: [safeSource],
  });
  const handler = loadGrowthHandler(managePath, { base44, env });
  const artifactId = await createReviewedDraft(handler);

  const originalSourceFilter = entities.GrowthSourceAsset.filter.bind(
    entities.GrowthSourceAsset,
  );
  let releaseApprovalLookup;
  const approvalLookupReleased = new Promise((resolvePromise) => {
    releaseApprovalLookup = resolvePromise;
  });
  let markApprovalLookupReached;
  const approvalLookupReached = new Promise((resolvePromise) => {
    markApprovalLookupReached = resolvePromise;
  });
  let blockNextSourceLookup = true;
  entities.GrowthSourceAsset.filter = async (...args) => {
    if (blockNextSourceLookup) {
      blockNextSourceLookup = false;
      markApprovalLookupReached();
      await approvalLookupReleased;
    }
    return originalSourceFilter(...args);
  };

  const approval = invokeJson(handler, {
    action: 'approve',
    artifact_id: artifactId,
  });
  await approvalLookupReached;
  const failedReview = await invokeJson(handler, {
    action: 'review',
    artifact_id: artifactId,
    privacy_cleared: false,
    demo_labeled: true,
    claims_supported: true,
    media_rights_confirmed: true,
    note: 'Privacy clearance was withdrawn during approval.',
  });
  assert.equal(failedReview.status, 200);
  assert.equal(failedReview.body.passed, false);
  releaseApprovalLookup();
  await approval;

  const saved = await entities.GrowthCreativeArtifact.get(artifactId);
  assert.equal(saved.review_status, 'changes_requested');
  assert.equal(saved.privacy_cleared, false);
  assert.notEqual(saved.approval_status, 'approved');
});

test('provider caption limits are enforced before owner approval', async () => {
  const { base44, entities } = createGrowthBase44({
    sources: [safeSource],
  });
  const handler = loadGrowthHandler(managePath, { base44, env });
  const result = await invokeJson(handler, {
    action: 'create_draft',
    artifact: {
      ...draftInput,
      caption: 'x'.repeat(2201),
    },
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'invalid_content_draft');
  assert.equal(entities.GrowthCreativeArtifact.records.length, 0);
});

test('CTA labels honor the 160-character artifact and measurement-plan schema boundary', async () => {
  const artifactSchema = JSON.parse(
    readFileSync(resolve('base44/entities/GrowthCreativeArtifact.jsonc'), 'utf8'),
  );
  const planSchema = JSON.parse(
    readFileSync(resolve('base44/entities/GrowthContentPlan.jsonc'), 'utf8'),
  );
  assert.equal(artifactSchema.properties.cta_label.maxLength, 160);
  assert.equal(planSchema.properties.cta_label.maxLength, 160);

  const { base44, entities } = createGrowthBase44({
    sources: [safeSource],
  });
  const handler = loadGrowthHandler(managePath, { base44, env });
  const ctaLabel = 'C'.repeat(160);
  const result = await invokeJson(handler, {
    action: 'create_draft',
    artifact: {
      ...draftInput,
      cta_label: ctaLabel,
    },
  });

  assert.equal(result.status, 201);
  assert.equal(entities.GrowthCreativeArtifact.records[0].cta_label, ctaLabel);
  assert.equal(entities.GrowthCreativeArtifact.records[0].cta_label.length, 160);
});

test('publish-job retry counters have schema headroom beyond 35,000 attempts', () => {
  const schema = JSON.parse(
    readFileSync(resolve('base44/entities/GrowthPublishJob.jsonc'), 'utf8'),
  );
  assert.ok(schema.properties.attempt_count.maximum > 35_000);
  assert.equal(schema.properties.attempt_count.minimum, 0);
});

test('owner resolution requires verification, cancels review work and its plan, and rejects sent evidence', async () => {
  const reviewJob = {
    id: 'job_review_required',
    artifact_id: 'artifact_review_required',
    campaign: '1000-users',
    platform: 'instagram',
    platform_content_id: 'ig-review-required',
    state: 'review_required',
    provider_post_id: 'buffer_review_required',
    provider_status: 'scheduled',
    lease_generation: 4,
  };
  const plan = {
    id: 'plan_review_required',
    campaign: reviewJob.campaign,
    content: reviewJob.platform_content_id,
    sprint: 'content-engine',
    delivery_managed_by: 'buffer',
    delivery_status: 'planned',
  };
  const { base44, entities } = createGrowthBase44({
    jobs: [reviewJob],
    plans: [plan],
  });
  const handler = loadGrowthHandler(managePath, { base44, env });

  let result = await invokeJson(handler, {
    action: 'resolve_job',
    job_id: reviewJob.id,
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'provider_resolution_confirmation_required');
  assert.equal(entities.GrowthPublishJob.records[0].state, 'review_required');
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'planned');

  result = await invokeJson(handler, {
    action: 'resolve_job',
    job_id: reviewJob.id,
    provider_cancellation_verified: true,
  });
  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'canceled');
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'owner_verified_provider_canceled',
  );
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'canceled');

  const sentEvidence = {
    ...reviewJob,
    id: 'job_review_required_but_sent',
    platform_content_id: 'ig-review-required-but-sent',
    provider_status: 'sent',
    provider_sent_at: new Date().toISOString(),
  };
  const sentContext = createGrowthBase44({
    jobs: [sentEvidence],
    plans: [{
      ...plan,
      id: 'plan_review_required_but_sent',
      content: sentEvidence.platform_content_id,
    }],
  });
  const sentHandler = loadGrowthHandler(managePath, {
    base44: sentContext.base44,
    env,
  });
  result = await invokeJson(sentHandler, {
    action: 'resolve_job',
    job_id: sentEvidence.id,
    provider_cancellation_verified: true,
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'provider_post_already_sent');
  assert.equal(
    sentContext.entities.GrowthPublishJob.records[0].state,
    'review_required',
  );
});

test('content-engine measurement plans cannot be manually marked published', async () => {
  const plan = {
    id: 'provider_managed_plan',
    campaign: '1000-users',
    content: 'ig-provider-managed',
    sprint: 'content-engine',
    delivery_managed_by: 'buffer',
    delivery_status: 'planned',
  };
  const { base44, entities } = createGrowthBase44({
    plans: [plan],
  });
  const handler = loadGrowthHandler(
    'base44/functions/manageGrowthContentPlan/entry.ts',
    { base44 },
  );
  const result = await invokeJson(handler, {
    action: 'publish',
    campaign: plan.campaign,
    content: plan.content,
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'provider_managed_publication');
  assert.equal(entities.GrowthContentPlan.records[0].published_at, undefined);
  assert.equal(entities.GrowthContentPlan.counters.update, 0);
});

test('manual publication loses CAS when scheduling concurrently establishes provider ownership', async () => {
  const plan = {
    id: 'manual_plan_schedule_race',
    ...manualSeedPlan({ content: 'ig-manual-publish-race' }),
    delivery_managed_by: 'manual',
    delivery_status: 'planned',
  };
  const { base44, entities } = createGrowthBase44({ plans: [plan] });
  const planEntity = entities.GrowthContentPlan;
  const originalUpdateMany = planEntity.updateMany;
  const concurrentlyScheduledAt = new Date(
    Date.now() + 2 * 24 * 60 * 60 * 1000,
  ).toISOString();
  let publishCasAttempts = 0;

  planEntity.updateMany = async (query, operations) => {
    if (Object.hasOwn(operations?.$set || {}, 'published_at')) {
      publishCasAttempts += 1;
      Object.assign(planEntity.records[0], {
        sprint: 'content-engine',
        delivery_managed_by: 'buffer',
        delivery_status: 'planned',
        planned_publish_at: concurrentlyScheduledAt,
        updated_date: '2099-01-01T00:00:00.000Z',
      });
      delete planEntity.records[0].published_at;
    }
    return originalUpdateMany(query, operations);
  };
  const handler = loadGrowthHandler(
    'base44/functions/manageGrowthContentPlan/entry.ts',
    { base44 },
  );

  const result = await invokeJson(handler, {
    action: 'publish',
    campaign: plan.campaign,
    content: plan.content,
    published_at: new Date(Date.now() - 1000).toISOString(),
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'provider_managed_publication');
  assert.equal(publishCasAttempts, 1);
  assert.equal(planEntity.counters.updateMany, 1);
  assert.equal(planEntity.records[0].sprint, 'content-engine');
  assert.equal(planEntity.records[0].delivery_managed_by, 'buffer');
  assert.equal(planEntity.records[0].delivery_status, 'planned');
  assert.equal(planEntity.records[0].planned_publish_at, concurrentlyScheduledAt);
  assert.equal(planEntity.records[0].published_at, undefined);
});

test('content-plan seed preserves unpublished provider-managed measurement contracts', async (t) => {
  const originalPublishAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const replacementPublishAt = new Date(
    Date.now() + 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const ownershipCases = [
    {
      name: 'content-engine sprint',
      sprint: 'content-engine',
      delivery_managed_by: 'manual',
    },
    {
      name: 'Buffer delivery owner',
      sprint: 'manual-sprint',
      delivery_managed_by: 'buffer',
    },
  ];
  for (const ownership of ownershipCases) {
    await t.test(ownership.name, async () => {
      const existing = {
        id: `provider_owned_${ownership.sprint}`,
        campaign: '1000-users',
        content: `ig-${ownership.sprint}`,
        sprint: ownership.sprint,
        sequence: 17,
        format: 'reel',
        audience: 'Door-to-door sales teams',
        hook: 'Original approved hook',
        script: 'Original approved provider text and CTA.',
        cta_label: 'Try FirstKnock',
        cta_channel: 'caption_url',
        primary_metric: 'Activated users',
        hypothesis: 'Original approved content will produce qualified activation.',
        comparison_group: 'product-proof-reel',
        major_variable: 'Original approved hook',
        planned_publish_at: originalPublishAt,
        snapshot_days: 7,
        delivery_managed_by: ownership.delivery_managed_by,
        delivery_status: 'planned',
      };
      const { base44, entities } = createGrowthBase44({
        plans: [existing],
      });
      const before = structuredClone(entities.GrowthContentPlan.records[0]);
      const handler = loadGrowthHandler(
        'base44/functions/manageGrowthContentPlan/entry.ts',
        { base44 },
      );
      const result = await invokeJson(handler, {
        action: 'seed',
        plans: [{
          campaign: existing.campaign,
          content: existing.content,
          sprint: 'replacement-sprint',
          sequence: 99,
          format: 'carousel',
          audience: 'A replacement audience',
          hook: 'Replacement hook must not overwrite approval',
          script: 'Replacement script must not overwrite approval.',
          cta_label: 'Replacement CTA',
          cta_channel: 'bio',
          primary_metric: 'Replacement metric',
          hypothesis: 'Replacement hypothesis must not overwrite approval.',
          comparison_group: 'replacement-comparison',
          major_variable: 'Replacement variable',
          planned_publish_at: replacementPublishAt,
          snapshot_days: 30,
        }],
      });

      assert.equal(result.status, 200);
      assert.deepEqual(result.body, {
        success: true,
        created: 0,
        updated: 0,
        preserved: 1,
        total: 1,
      });
      assert.deepEqual(entities.GrowthContentPlan.records[0], before);
      assert.equal(
        entities.GrowthContentPlan.records[0].planned_publish_at,
        originalPublishAt,
      );
      assert.equal(
        entities.GrowthContentPlan.records[0].hook,
        'Original approved hook',
      );
      assert.equal(
        entities.GrowthContentPlan.records[0].script,
        'Original approved provider text and CTA.',
      );
      assert.equal(entities.GrowthContentPlan.records[0].snapshot_days, 7);
      assert.equal(entities.GrowthContentPlan.counters.update, 0);
    });
  }
});

test('content-plan seed preserves a concurrent provider-managed conversion after losing CAS', async () => {
  const existing = {
    id: 'plan_seed_concurrent_conversion',
    ...manualSeedPlan({
      content: 'ig-seed-concurrent-conversion',
      hook: 'Original manual hook',
      script: 'Original manual script.',
    }),
    delivery_managed_by: 'manual',
    delivery_status: 'planned',
  };
  const replacement = manualSeedPlan({
    content: existing.content,
    sequence: 99,
    hook: 'Replacement seed hook',
    script: 'Replacement seed script must not overwrite concurrent ownership.',
    planned_publish_at: new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    ).toISOString(),
    snapshot_days: 30,
  });
  const { base44, entities } = createGrowthBase44({
    plans: [existing],
  });
  const originalUpdateMany = entities.GrowthContentPlan.updateMany;
  let concurrentSnapshot;
  let casAttempts = 0;
  entities.GrowthContentPlan.updateMany = async (...args) => {
    casAttempts += 1;
    Object.assign(entities.GrowthContentPlan.records[0], {
      sprint: 'content-engine',
      delivery_managed_by: 'buffer',
      hook: 'Concurrent provider-owned hook',
      script: 'Concurrent provider-owned script.',
      planned_publish_at: new Date(
        Date.now() + 2 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      updated_date: '2099-01-01T00:00:00.000Z',
    });
    concurrentSnapshot = structuredClone(
      entities.GrowthContentPlan.records[0],
    );
    return originalUpdateMany(...args);
  };
  const handler = loadGrowthHandler(
    'base44/functions/manageGrowthContentPlan/entry.ts',
    { base44 },
  );

  const result = await invokeJson(handler, {
    action: 'seed',
    plans: [replacement],
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    success: true,
    created: 0,
    updated: 0,
    preserved: 1,
    total: 1,
  });
  assert.equal(casAttempts, 1);
  assert.deepEqual(entities.GrowthContentPlan.records[0], concurrentSnapshot);
  assert.equal(
    entities.GrowthContentPlan.records[0].hook,
    'Concurrent provider-owned hook',
  );
  assert.notEqual(
    entities.GrowthContentPlan.records[0].script,
    replacement.script,
  );
});

test('content-plan seed does not create over an existing content-engine artifact key', async () => {
  const content = 'ig-artifact-owned-seed';
  const artifact = await approvedArtifact({
    id: 'artifact_owns_missing_seed_plan',
    artifact_key: content,
    platform_content_id: content,
  });
  const { base44, entities } = createGrowthBase44({
    artifacts: [artifact],
  });
  const handler = loadGrowthHandler(
    'base44/functions/manageGrowthContentPlan/entry.ts',
    { base44 },
  );

  const result = await invokeJson(handler, {
    action: 'seed',
    plans: [manualSeedPlan({ content })],
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    success: true,
    created: 0,
    updated: 0,
    preserved: 1,
    total: 1,
  });
  assert.deepEqual(entities.GrowthContentPlan.records, []);
  assert.equal(entities.GrowthContentPlan.counters.create, 0);
  assert.equal(entities.GrowthContentPlan.counters.updateMany, 0);
  assert.ok(entities.GrowthCreativeArtifact.counters.filter >= 1);
});

test('edit, review, and reapproval unset stale audit lifecycle fields', async () => {
  const { base44, entities } = createGrowthBase44({
    sources: [safeSource],
  });
  const handler = loadGrowthHandler(managePath, { base44, env });
  const artifactId = await createReviewedDraft(
    handler,
    {},
    { note: 'Original review evidence.' },
  );

  let result = await invokeJson(handler, {
    action: 'approve',
    artifact_id: artifactId,
  });
  assert.equal(result.status, 200);
  result = await invokeJson(handler, {
    action: 'revoke',
    artifact_id: artifactId,
    note: 'Withdrawn for a new edit.',
  });
  assert.equal(result.status, 200);

  result = await invokeJson(handler, {
    action: 'update_draft',
    artifact_id: artifactId,
    artifact: { caption: 'Revised copy after revocation.' },
  });
  assert.equal(result.status, 200);
  for (const field of [
    'review_note',
    'reviewed_by',
    'reviewed_at',
    'approved_hash',
    'approved_by',
    'approved_at',
    'revoked_at',
    'revocation_note',
  ]) {
    assert.equal(result.body.artifact[field], undefined, `${field} survived edit`);
  }

  result = await invokeJson(handler, {
    action: 'review',
    artifact_id: artifactId,
    privacy_cleared: true,
    demo_labeled: true,
    claims_supported: true,
    media_rights_confirmed: true,
    note: 'Replacement review evidence.',
  });
  assert.equal(result.status, 200);
  for (const field of [
    'approved_hash',
    'approved_by',
    'approved_at',
    'revoked_at',
    'revocation_note',
  ]) {
    assert.equal(result.body.artifact[field], undefined, `${field} survived review`);
  }

  result = await invokeJson(handler, {
    action: 'approve',
    artifact_id: artifactId,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.artifact.approval_status, 'approved');
  assert.equal(result.body.artifact.revoked_at, undefined);
  assert.equal(result.body.artifact.revocation_note, undefined);
  assert.notEqual(result.body.artifact.approved_hash, undefined);
});

test('all entity schemas remain parseable JSON', () => {
  for (const file of readdirSync(resolve('base44/entities')).filter((name) => name.endsWith('.jsonc'))) {
    assert.doesNotThrow(() => JSON.parse(readFileSync(resolve('base44/entities', file), 'utf8')));
  }
});

test('a measured batch beats a stale schedule snapshot and releases the losing provisional reservation', async () => {
  const { plan, metric } = await measuredReviewEvidence();
  const selectedConceptIds = [
    'fk-ce-field-funnel-01',
    'fk-ce-clean-routes-01',
  ];
  const selectedSeedArtifact = measuredSeedPack.artifacts.find((artifact) => (
    artifact.concept_id === selectedConceptIds[0]
    && artifact.platform === 'instagram'
  ));
  assert.ok(selectedSeedArtifact?.source_asset_key);
  const scheduledArtifact = await approvedArtifact({
    id: 'artifact_schedule_build_reservation_race',
    artifact_key: 'ig-schedule-build-reservation-race',
    platform_content_id: 'ig-schedule-build-reservation-race',
    concept_id: 'schedule-build-reservation-race',
    source_asset_keys: [selectedSeedArtifact.source_asset_key],
    hook: 'Map the clean field route',
  });
  const clock = controlledClock(Date.parse('2026-07-28T18:00:00.000Z'));
  const heartbeatRevision = await growthHelpers.sha256Hex([
    'buffer-publisher',
    env.BUFFER_ORGANIZATION_ID,
    env.BUFFER_INSTAGRAM_CHANNEL_ID,
    env.BUFFER_TIKTOK_CHANNEL_ID,
    env.GROWTH_MEDIA_ORIGIN,
  ].join('|'));
  let llmCalls = 0;
  const { base44, entities } = createGrowthBase44({
    sources: measuredSourceRegistry(),
    artifacts: [scheduledArtifact],
    plans: [plan],
    metrics: [metric],
    heartbeats: [{
      heartbeat_key: 'buffer-publisher',
      config_revision: heartbeatRevision,
      observed_at: new clock.DateImpl().toISOString(),
      status: 'ready',
      invocation_generation: 1,
      last_batch_inspected: 0,
      last_batch_processed: 0,
    }],
    invokeLlm: async () => {
      llmCalls += 1;
      return measuredGeneration(selectedConceptIds);
    },
  });
  const handler = loadGrowthHandler(managePath, {
    base44,
    env: {
      ...env,
      GROWTH_CONTENT_GENERATION_ENABLED: 'true',
      GROWTH_RENDER_PACK_SHA256S: measuredSeedPackSha256,
    },
    dateImpl: clock.DateImpl,
  });
  const staleBatchSnapshotTaken = deferred();
  const releaseScheduleSnapshot = deferred();
  const originalBatchList = entities.GrowthContentBatch.list;
  let heldScheduleSnapshot = false;
  entities.GrowthContentBatch.list = async (...args) => {
    const snapshot = await originalBatchList(...args);
    if (!heldScheduleSnapshot) {
      heldScheduleSnapshot = true;
      assert.deepEqual(snapshot, []);
      staleBatchSnapshotTaken.resolve();
      await releaseScheduleSnapshot.promise;
    }
    return snapshot;
  };
  const schedulePromise = invokeJson(handler, {
    action: 'schedule',
    artifact_id: scheduledArtifact.id,
    due_at: '2026-07-29T16:30:00.000Z',
    timezone: 'America/Phoenix',
    scheduling_type: 'automatic',
  });
  await staleBatchSnapshotTaken.promise;

  let built;
  try {
    built = await invokeJson(handler, {
      action: 'build_next_batch',
      parent: {
        platform: plan.platform,
        campaign: plan.campaign,
        content: plan.content,
      },
      target_date: '2026-07-29',
      concept_count: 2,
      seed_concept_ids: selectedConceptIds,
      seed_pack: measuredSeedPack,
    });
  } finally {
    releaseScheduleSnapshot.resolve();
  }
  const scheduled = await schedulePromise;

  assert.equal(built.status, 201);
  assert.equal(built.body.batch.state, 'ready');
  assert.equal(llmCalls, 1);
  assert.equal(scheduled.status, 409);
  assert.equal(scheduled.body.error, 'source_cooldown_conflict');
  assert.equal(
    entities.GrowthPublishJob.records.filter(
      (job) => job.state === 'reservation_pending',
    ).length,
    0,
  );
  assert.equal(entities.GrowthPublishJob.records.length, 1);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'canceled');
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'source_cooldown_conflict',
  );
  assert.equal(
    entities.GrowthContentPlan.records.filter(
      (candidate) => candidate.content === scheduledArtifact.platform_content_id,
    ).length,
    0,
  );
});

test('same-key first-create batch race leaves one ready winner and one durable superseded row', async () => {
  const { plan, metric } = await measuredReviewEvidence();
  const selectedConceptIds = [
    'fk-ce-field-funnel-01',
    'fk-ce-clean-routes-01',
  ];
  let llmCalls = 0;
  const { base44, entities } = createGrowthBase44({
    sources: measuredSourceRegistry(),
    plans: [plan],
    metrics: [metric],
    invokeLlm: async () => {
      llmCalls += 1;
      return measuredGeneration(selectedConceptIds);
    },
  });
  const clock = controlledClock(Date.parse('2026-07-28T18:00:00.000Z'));
  const handler = loadGrowthHandler(managePath, {
    base44,
    env: {
      ...env,
      GROWTH_CONTENT_GENERATION_ENABLED: 'true',
      GROWTH_RENDER_PACK_SHA256S: measuredSeedPackSha256,
    },
    dateImpl: clock.DateImpl,
  });
  const request = {
    action: 'build_next_batch',
    parent: {
      platform: plan.platform,
      campaign: plan.campaign,
      content: plan.content,
    },
    target_date: '2026-07-29',
    concept_count: 2,
    seed_concept_ids: selectedConceptIds,
    seed_pack: measuredSeedPack,
  };
  const emptyReadBarriers = [deferred(), deferred()];
  const originalBatchFilter = entities.GrowthContentBatch.filter;
  let emptyExactReads = 0;
  entities.GrowthContentBatch.filter = async (...args) => {
    const [query] = args;
    const snapshot = await originalBatchFilter(...args);
    if (query?.batch_key && emptyExactReads < 4) {
      assert.deepEqual(snapshot, []);
      const phase = Math.floor(emptyExactReads / 2);
      emptyExactReads += 1;
      if (emptyExactReads % 2 === 0) {
        emptyReadBarriers[phase].resolve();
      }
      await emptyReadBarriers[phase].promise;
    }
    return snapshot;
  };
  const bothRowsCreated = deferred();
  const originalBatchCreate = entities.GrowthContentBatch.create;
  let batchCreates = 0;
  entities.GrowthContentBatch.create = async (value) => {
    const saved = await originalBatchCreate(value);
    batchCreates += 1;
    if (batchCreates === 2) bothRowsCreated.resolve();
    await bothRowsCreated.promise;
    return saved;
  };

  const outcomes = await Promise.all([
    invokeJson(handler, request),
    invokeJson(handler, request),
  ]);

  assert.equal(emptyExactReads, 4);
  assert.equal(batchCreates, 2);
  assert.equal(llmCalls, 1);
  assert.equal(
    outcomes.filter((outcome) => outcome.status === 201).length,
    1,
  );
  assert.equal(
    outcomes.every((outcome) => [200, 201, 409].includes(outcome.status)),
    true,
  );
  assert.equal(entities.GrowthContentBatch.records.length, 2);
  const ready = entities.GrowthContentBatch.records.find(
    (batch) => batch.state === 'ready',
  );
  const superseded = entities.GrowthContentBatch.records.find(
    (batch) => batch.state === 'superseded',
  );
  assert.ok(ready);
  assert.ok(superseded);
  assert.equal(ready.batch_key, superseded.batch_key);
  assert.equal(superseded.superseded_by_batch_key, ready.batch_key);
  assert.match(superseded.superseded_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(superseded.lease_token, '');
  assert.equal(superseded.lease_expires_at, undefined);

  const fetched = await invokeJson(handler, {
    action: 'get_batch',
    batch_key: ready.batch_key,
  });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.batch.state, 'ready');
  assert.equal(fetched.body.pack_sha256, ready.canonical_pack_sha256);
  assert.equal(fetched.body.render_pack.artifacts.length, 4);

  const authorized = await invokeJson(handler, {
    action: 'authorize_batch',
    batch_key: ready.batch_key,
    expected_pack_sha256: ready.canonical_pack_sha256,
    inspection_acknowledged: true,
    note: 'Exact first-create race winner reviewed by the owner.',
  });
  assert.equal(authorized.status, 200);
  assert.equal(authorized.body.batch.state, 'render_authorized');
  assert.equal(
    entities.GrowthContentBatch.records.filter(
      (batch) => batch.state === 'superseded',
    ).length,
    1,
  );
});

test('growth batch attempt counters have schema headroom beyond 35,000 attempts', () => {
  const schema = JSON.parse(readFileSync(
    resolve('base44/entities/GrowthContentBatch.jsonc'),
    'utf8',
  ));
  assert.ok(schema.properties.attempt_count.maximum > 35_000);
  assert.equal(schema.properties.attempt_count.minimum, 0);
});

test('terminal retry reservation precedence uses its fresh lease time instead of its old row date', async () => {
  const clock = controlledClock(Date.parse('2026-07-28T18:00:00.000Z'));
  const dueAt = '2026-07-29T16:30:00.000Z';
  const retryArtifact = await approvedArtifact({
    id: 'artifact_terminal_retry_precedence',
    artifact_key: 'ig-terminal-retry-precedence',
    platform_content_id: 'ig-terminal-retry-precedence',
    concept_id: 'terminal-retry-precedence',
    hook: 'Retry the older field proof',
  });
  const freshArtifact = await approvedArtifact({
    id: 'artifact_fresh_reservation_precedence',
    artifact_key: 'ig-fresh-reservation-precedence',
    platform_content_id: 'ig-fresh-reservation-precedence',
    concept_id: 'fresh-reservation-precedence',
    hook: 'Queue the fresh field proof',
  });
  const configRevision = await growthHelpers.sha256Hex([
    'buffer',
    env.BUFFER_ORGANIZATION_ID,
    env.BUFFER_INSTAGRAM_CHANNEL_ID,
    'instagram',
    env.GROWTH_MEDIA_ORIGIN,
  ].join('|'));
  const sourceSnapshot = [{
    asset_key: safeSource.asset_key,
    source_reference: safeSource.source_reference,
    source_sha256: safeSource.source_sha256,
  }];
  const terminalRequest = {
    provider: 'buffer',
    provider_organization_id: env.BUFFER_ORGANIZATION_ID,
    provider_channel_id: env.BUFFER_INSTAGRAM_CHANNEL_ID,
    provider_service: 'instagram',
    config_revision: configRevision,
    media_origin: env.GROWTH_MEDIA_ORIGIN,
    artifact_id: retryArtifact.id,
    artifact_hash: retryArtifact.approved_hash,
    source_lineage_snapshot: sourceSnapshot,
    hook_snapshot: retryArtifact.hook,
    platform: 'instagram',
    platform_content_id: retryArtifact.platform_content_id,
    due_at: dueAt,
    scheduling_type: 'automatic',
    timezone: 'America/Phoenix',
  };
  const terminalJob = {
    id: 'job_terminal_retry_precedence',
    job_key: await growthHelpers.publishJobKey(terminalRequest),
    request_hash: await growthHelpers.publishJobRequestHash(terminalRequest),
    ...terminalRequest,
    artifact_key: retryArtifact.artifact_key,
    concept_id: retryArtifact.concept_id,
    campaign: retryArtifact.campaign,
    state: 'canceled',
    attempt_count: 0,
    reconciliation_count: 0,
    lease_generation: 7,
    last_error_code: 'owner_canceled',
    canceled_at: '2026-01-02T00:00:00.000Z',
    created_date: '2026-01-01T00:00:00.000Z',
  };
  const heartbeatRevision = await growthHelpers.sha256Hex([
    'buffer-publisher',
    env.BUFFER_ORGANIZATION_ID,
    env.BUFFER_INSTAGRAM_CHANNEL_ID,
    env.BUFFER_TIKTOK_CHANNEL_ID,
    env.GROWTH_MEDIA_ORIGIN,
  ].join('|'));
  const { base44, entities } = createGrowthBase44({
    sources: [safeSource],
    artifacts: [retryArtifact, freshArtifact],
    jobs: [terminalJob],
    heartbeats: [{
      heartbeat_key: 'buffer-publisher',
      config_revision: heartbeatRevision,
      observed_at: new clock.DateImpl().toISOString(),
      status: 'ready',
      invocation_generation: 1,
      last_batch_inspected: 0,
      last_batch_processed: 0,
    }],
  });
  const handler = loadGrowthHandler(managePath, {
    base44,
    env,
    dateImpl: clock.DateImpl,
  });
  const staleJobSnapshot = structuredClone(
    entities.GrowthPublishJob.records,
  );
  const originalJobList = entities.GrowthPublishJob.list;
  let dependencyReads = 0;
  entities.GrowthPublishJob.list = async (...args) => {
    dependencyReads += 1;
    if (dependencyReads === 2) return structuredClone(staleJobSnapshot);
    return originalJobList(...args);
  };
  const freshReservationCreated = deferred();
  const retryReservationCreated = deferred();
  const releaseReservations = deferred();
  const originalJobCreate = entities.GrowthPublishJob.create;
  entities.GrowthPublishJob.create = async (value) => {
    const saved = await originalJobCreate(value);
    if (
      value?.state === 'reservation_pending'
      && value?.artifact_id === freshArtifact.id
    ) {
      freshReservationCreated.resolve();
      await releaseReservations.promise;
    }
    return saved;
  };
  const originalJobUpdateMany = entities.GrowthPublishJob.updateMany;
  entities.GrowthPublishJob.updateMany = async (query, operations) => {
    const result = await originalJobUpdateMany(query, operations);
    if (
      query?.id === terminalJob.id
      && query?.state === 'canceled'
      && operations?.$set?.state === 'reservation_pending'
    ) {
      retryReservationCreated.resolve();
      await releaseReservations.promise;
    }
    return result;
  };

  const freshPromise = invokeJson(handler, {
    action: 'schedule',
    artifact_id: freshArtifact.id,
    due_at: dueAt,
    timezone: 'America/Phoenix',
    scheduling_type: 'automatic',
  });
  await freshReservationCreated.promise;
  clock.set(clock.now() + 1000);
  entities.GrowthPublishHeartbeat.records[0].observed_at =
    new clock.DateImpl().toISOString();
  const retryPromise = invokeJson(handler, {
    action: 'schedule',
    artifact_id: retryArtifact.id,
    due_at: dueAt,
    timezone: 'America/Phoenix',
    scheduling_type: 'automatic',
    retry_terminal: true,
  });
  await retryReservationCreated.promise;

  const freshPending = entities.GrowthPublishJob.records.find(
    (job) => job.artifact_id === freshArtifact.id,
  );
  const retryPending = entities.GrowthPublishJob.records.find(
    (job) => job.artifact_id === retryArtifact.id,
  );
  assert.equal(freshPending.state, 'reservation_pending');
  assert.equal(retryPending.state, 'reservation_pending');
  assert.ok(
    new Date(freshPending.lease_acquired_at).getTime()
      < new Date(retryPending.lease_acquired_at).getTime(),
  );
  assert.ok(
    new Date(retryPending.created_date).getTime()
      < new Date(freshPending.created_date).getTime(),
  );
  releaseReservations.resolve();
  const [freshResult, retryResult] = await Promise.all([
    freshPromise,
    retryPromise,
  ]);

  assert.equal(freshResult.status, 201);
  assert.equal(freshResult.body.job.state, 'queued');
  assert.equal(retryResult.status, 409);
  assert.equal(retryResult.body.error, 'source_cooldown_conflict');
  assert.equal(
    entities.GrowthPublishJob.records.filter((job) => job.state === 'queued')
      .length,
    1,
  );
  assert.equal(
    entities.GrowthPublishJob.records.filter(
      (job) => job.state === 'reservation_pending',
    ).length,
    0,
  );
  assert.equal(
    entities.GrowthPublishJob.records.find(
      (job) => job.artifact_id === retryArtifact.id,
    ).state,
    'canceled',
  );
  assert.deepEqual(
    entities.GrowthContentPlan.records.map((candidate) => candidate.content),
    [freshArtifact.platform_content_id],
  );
});
