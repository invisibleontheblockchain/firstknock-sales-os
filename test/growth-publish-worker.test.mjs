import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  createGrowthBase44 as createGrowthBase44Harness,
  growthHelpers,
  invokeJson,
  loadGrowthHandler,
} from './helpers/growthContentTestHarness.mjs';

const workerPath = 'base44/functions/processGrowthPublishQueue/entry.ts';
const managePath = 'base44/functions/manageGrowthContentEngine/entry.ts';
const workerSecret = 'worker-secret-that-is-at-least-32-characters';
const apiKey = 'buffer-api-token-sentinel-never-persist';
const mediaOrigin = 'https://media.firstknock.online';
const mediaPathPrefix = '/files/public/app-firstknock/';
const mediaNamespace = `${mediaOrigin}${mediaPathPrefix}`;
const env = {
  GROWTH_PUBLISH_WORKER_SECRET: workerSecret,
  GROWTH_PUBLISH_ENABLED: 'true',
  BUFFER_API_KEY: apiKey,
  BUFFER_ORGANIZATION_ID: 'org_firstknock',
  BUFFER_INSTAGRAM_CHANNEL_ID: 'channel_instagram',
  BUFFER_TIKTOK_CHANNEL_ID: 'channel_tiktok',
  GROWTH_MEDIA_ORIGIN: mediaOrigin,
  GROWTH_MEDIA_PATH_PREFIX: mediaPathPrefix,
};

function createGrowthBase44(options = {}) {
  const resolved = { ...options };
  if (resolved.heartbeats === undefined) {
    resolved.heartbeats = [{
      heartbeat_key: 'buffer-publisher',
      config_revision: createHash('sha256')
        .update([
          'buffer-publisher',
          env.BUFFER_ORGANIZATION_ID,
          env.BUFFER_INSTAGRAM_CHANNEL_ID,
          env.BUFFER_TIKTOK_CHANNEL_ID,
          env.GROWTH_MEDIA_ORIGIN,
          env.GROWTH_MEDIA_PATH_PREFIX,
        ].join('|'))
        .digest('hex'),
      observed_at: new Date().toISOString(),
      status: 'ready',
      invocation_generation: 1,
      last_batch_inspected: 0,
      last_batch_processed: 0,
    }];
  }
  return createGrowthBase44Harness(resolved);
}
const mediaBytes = new TextEncoder().encode('firstknock-approved-media-fixture-v1');
const mediaSha256 = await growthHelpers.sha256BytesHex(mediaBytes);
const sourceSha256 = 'a'.repeat(64);

const source = {
  id: 'source_1',
  asset_key: 'safe-product-proof',
  title: 'Safe source',
  source_reference: 'safe-product-proof.mp4',
  source_sha256: sourceSha256,
  media_kind: 'video',
  privacy_status: 'safe',
  safe_summary: 'Sanitized route workflow.',
  active: true,
};
const sourceLineageSnapshot = [{
  asset_key: source.asset_key,
  source_reference: source.source_reference,
  source_sha256: source.source_sha256,
}];

async function fixture(overrides = {}) {
  const artifact = {
    id: 'artifact_1',
    artifact_key: 'ig-route-proof-01',
    concept_id: 'route-proof-01',
    revision: 1,
    campaign: '1000-users',
    platform: 'instagram',
    platform_content_id: 'ig-route-proof-01',
    title: 'Build a route from one area',
    pillar: 'Product proof',
    format: 'video',
    source_asset_keys: ['safe-product-proof'],
    generation_status: 'draft_ready',
    hook: 'One area. One clean route.',
    caption: 'Draw an area, pull the right homes, and build the route. Demo data shown.',
    overlay_text: ['Draw the area', 'Build the route'],
    shot_list: ['Show the custom area', 'Show the finished route'],
    cta_label: 'Try FirstKnock',
    cta_url: 'https://firstknock.online',
    disclosure: 'Demo data shown.',
    ai_generated: true,
    media_url:
      `${mediaNamespace}base44_opaque_${mediaSha256}-route-proof.mp4`,
    media_sha256: mediaSha256,
    mime_type: 'video/mp4',
    width: 1080,
    height: 1920,
    duration_ms: 15000,
    thumbnail_offset_ms: 2000,
    review_status: 'passed',
    privacy_cleared: true,
    demo_labeled: true,
    claims_supported: true,
    media_rights_confirmed: true,
    approval_status: 'approved',
  };
  artifact.provider_text = growthHelpers.socialPostText(artifact);
  artifact.approved_hash = await growthHelpers.artifactApprovalHash(artifact);
  const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const configRevision = await growthHelpers.sha256Hex([
    'buffer',
    env.BUFFER_ORGANIZATION_ID,
    env.BUFFER_INSTAGRAM_CHANNEL_ID,
    'instagram',
    env.GROWTH_MEDIA_ORIGIN,
    env.GROWTH_MEDIA_PATH_PREFIX,
  ].join('|'));
  const request = {
    provider: 'buffer',
    provider_organization_id: env.BUFFER_ORGANIZATION_ID,
    provider_channel_id: env.BUFFER_INSTAGRAM_CHANNEL_ID,
    provider_service: 'instagram',
    config_revision: configRevision,
    media_origin: env.GROWTH_MEDIA_ORIGIN,
    media_path_prefix: env.GROWTH_MEDIA_PATH_PREFIX,
    artifact_id: artifact.id,
    artifact_hash: artifact.approved_hash,
    platform: 'instagram',
    platform_content_id: artifact.platform_content_id,
    due_at: dueAt,
    scheduling_type: 'automatic',
    timezone: 'America/Phoenix',
    source_lineage_snapshot: sourceLineageSnapshot,
    hook_snapshot: artifact.hook,
  };
  const job = {
    id: 'job_1',
    job_key: await growthHelpers.publishJobKey(request),
    request_hash: await growthHelpers.publishJobRequestHash(request),
    ...request,
    artifact_key: artifact.artifact_key,
    concept_id: artifact.concept_id,
    campaign: artifact.campaign,
    state: 'queued',
    attempt_count: 0,
    reconciliation_count: 0,
    schedule_cutoff_at: new Date(new Date(dueAt).getTime() - 10 * 60 * 1000).toISOString(),
    lease_generation: 0,
  };
  return {
    artifact: { ...artifact, ...(overrides.artifact || {}) },
    job: { ...job, ...(overrides.job || {}) },
    dueAt,
  };
}

async function renderedFixture(overrides = {}) {
  const original = await fixture();
  const artifact = {
    ...original.artifact,
    render_result_schema: 'growth-render-result.v1',
    render_source_lineage: [{
      asset_key: source.asset_key,
      source_reference: source.source_reference,
      source_sha256: source.source_sha256,
    }],
    ...(overrides.artifact || {}),
  };
  artifact.provider_text = growthHelpers.socialPostText(artifact);
  artifact.approved_hash = await growthHelpers.artifactApprovalHash(artifact);
  const job = {
    ...original.job,
    artifact_id: artifact.id,
    artifact_key: artifact.artifact_key,
    artifact_hash: artifact.approved_hash,
    ...(overrides.job || {}),
  };
  job.job_key = await growthHelpers.publishJobKey(job);
  job.request_hash = await growthHelpers.publishJobRequestHash(job);
  return { artifact, job, dueAt: job.due_at };
}

async function tiktokFixture(overrides = {}) {
  const original = await fixture();
  const artifact = {
    ...original.artifact,
    id: 'artifact_tiktok',
    artifact_key: 'tt-route-proof-01',
    platform: 'tiktok',
    platform_content_id: 'tt-route-proof-01',
    cta_url: growthHelpers.platformTrackedUrl(
      'tiktok',
      original.artifact.campaign,
      'tt-route-proof-01',
    ),
    ...(overrides.artifact || {}),
  };
  artifact.provider_text = growthHelpers.socialPostText(artifact);
  artifact.approved_hash = await growthHelpers.artifactApprovalHash(artifact);
  const configRevision = await growthHelpers.sha256Hex([
    'buffer',
    env.BUFFER_ORGANIZATION_ID,
    env.BUFFER_TIKTOK_CHANNEL_ID,
    'tiktok',
    env.GROWTH_MEDIA_ORIGIN,
    env.GROWTH_MEDIA_PATH_PREFIX,
  ].join('|'));
  const job = {
    ...original.job,
    id: 'job_tiktok',
    provider_channel_id: env.BUFFER_TIKTOK_CHANNEL_ID,
    provider_service: 'tiktok',
    config_revision: configRevision,
    artifact_id: artifact.id,
    artifact_hash: artifact.approved_hash,
    artifact_key: artifact.artifact_key,
    platform: 'tiktok',
    platform_content_id: artifact.platform_content_id,
    campaign: artifact.campaign,
    ...(overrides.job || {}),
  };
  job.job_key = await growthHelpers.publishJobKey(job);
  job.request_hash = await growthHelpers.publishJobRequestHash(job);
  return { artifact, job, dueAt: job.due_at };
}

function bufferPost(fx, overrides = {}) {
  return {
    id: 'buffer_post_1',
    channelId: fx.job.provider_channel_id,
    channelService: fx.job.provider_service,
    schedulingType: fx.job.scheduling_type,
    status: 'scheduled',
    dueAt: fx.dueAt,
    sentAt: null,
    externalLink: null,
    text: fx.artifact.provider_text,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    assets: [{
      source: fx.artifact.media_url,
      mimeType: fx.artifact.mime_type,
      type: 'video',
    }],
    error: null,
    ...overrides,
  };
}

function measurementPlan(fx, overrides = {}) {
  return {
    id: `growth_plan_${fx.job.id}`,
    campaign: fx.artifact.campaign,
    content: fx.artifact.platform_content_id,
    sprint: 'content-engine',
    format: 'reel',
    cta_label: fx.artifact.cta_label,
    planned_publish_at: fx.dueAt,
    delivery_managed_by: 'buffer',
    delivery_status: 'planned',
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function withApprovedMedia(bufferFetch, bytes = mediaBytes, channelOverrides = {}) {
  return async (url, options) => {
    if (String(url).startsWith(`${env.GROWTH_MEDIA_ORIGIN}/`)) {
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(bytes.byteLength),
        },
      });
    }
    const query = JSON.parse(String(options?.body || '{}'))?.query || '';
    if (String(url) === 'https://api.buffer.com' && query.includes('channel(input:')) {
      return Response.json({
        data: {
          channel: {
            id: env.BUFFER_INSTAGRAM_CHANNEL_ID,
            organizationId: env.BUFFER_ORGANIZATION_ID,
            service: 'instagram',
            isDisconnected: false,
            isLocked: false,
            isQueuePaused: false,
            ...channelOverrides,
          },
        },
      });
    }
    return bufferFetch(url, options);
  };
}

const dayMs = 24 * 60 * 60 * 1000;

async function sentMetricsFixture({
  publishedAt = new Date(Date.now() - dayMs - 60_000).toISOString(),
  checkpoints = [],
  job = {},
} = {}) {
  const fx = await fixture();
  const providerPostId = job.provider_post_id || 'buffer_post_metrics_1';
  fx.job = {
    ...fx.job,
    state: 'sent',
    provider_status: 'sent',
    provider_post_id: providerPostId,
    provider_sent_at: publishedAt,
    provider_external_link: 'https://www.instagram.com/p/metrics-1/',
    metrics_published_at: publishedAt,
    metrics_next_checkpoint_at: new Date(
      new Date(publishedAt).getTime()
        + ([1, 3, 7, 30].find(
          (days) => !checkpoints.some(
            (checkpoint) => checkpoint.snapshot_days === days,
          ),
        ) || 30) * dayMs,
    ).toISOString(),
    metrics_checkpoints: checkpoints,
    metrics_sync_attempt_count: 0,
    ...job,
  };
  return {
    ...fx,
    publishedAt,
    plan: measurementPlan(fx, {
      platform: fx.job.platform,
      published_at: publishedAt,
      delivery_status: 'published',
    }),
  };
}

function bufferMetricsPost(fx, overrides = {}) {
  return {
    id: fx.job.provider_post_id,
    channelId: fx.job.provider_channel_id,
    channelService: fx.job.provider_service,
    status: 'sent',
    sentAt: fx.job.provider_sent_at,
    metricsUpdatedAt: new Date().toISOString(),
    metrics: [
      { type: 'reach', name: 'Reach', value: 120, unit: 'count' },
      { type: 'views', name: 'Views', value: 450, unit: 'count' },
      { type: 'shares', name: 'Shares', value: 7, unit: 'count' },
      { type: 'saves', name: 'Saves', value: 8, unit: 'count' },
      { type: 'comments', name: 'Comments', value: 9, unit: 'count' },
      { type: 'follows', name: 'Follows', value: 10, unit: 'count' },
      { type: 'clicks', name: 'Clicks', value: 11, unit: 'count' },
    ],
    ...overrides,
  };
}

function bufferMetricsFetch(fx, overrides = {}, onQuery) {
  return async (url, options) => {
    assert.equal(String(url), 'https://api.buffer.com');
    assert.equal(options.headers.authorization, `Bearer ${apiKey}`);
    const query = JSON.parse(String(options.body || '{}')).query;
    assert.match(query, /metricsUpdatedAt/);
    assert.match(query, /metrics\s*\{/);
    assert.doesNotMatch(query, /createPost|assets\s*\{|channel\(input:|posts\(first:/);
    onQuery?.(query);
    return Response.json({
      data: { post: bufferMetricsPost(fx, overrides) },
    });
  };
}

function metricFingerprintPayload(metric) {
  const metricFields = [
    'reach',
    'views',
    'shares',
    'saves',
    'comments',
    'follows',
    'profile_visits',
    'link_clicks',
    'dm_intents',
  ];
  const payload = {
    campaign: String(metric.campaign || '1000-users').trim().toLowerCase(),
    content: String(metric.content || '').trim().toLowerCase(),
    snapshot_days: Number(metric.snapshot_days || 7),
    snapshot_captured_at: new Date(metric.snapshot_captured_at).toISOString(),
    published_at: metric.published_at
      ? new Date(metric.published_at).toISOString()
      : '',
  };
  for (const field of metricFields) {
    payload[field] = Math.max(0, Number(metric[field] || 0));
  }
  const manualFields = Array.isArray(metric.observed_metric_fields)
    ? metric.observed_metric_fields
    : null;
  const providerFields = String(metric.metric_source || '').trim().toLowerCase() === 'buffer'
      && Array.isArray(metric.provider_observed_metric_types)
    ? metric.provider_observed_metric_types
    : null;
  const observedFields = manualFields || providerFields;
  if (observedFields) {
    const observed = new Set(
      observedFields.map((field) => String(field || '').trim().toLowerCase()),
    );
    payload.observed_fields = metricFields.filter((field) => observed.has(field));
  }
  return JSON.stringify(payload);
}

async function testProviderMetricsHash(
  fx,
  metricsUpdatedAt,
  values,
  observedTypes = [
    'comments',
    'follows',
    'reach',
    'saves',
    'shares',
    'views',
  ],
) {
  return growthHelpers.sha256Hex(growthHelpers.canonicalStringify({
    provider: 'buffer',
    provider_post_id: fx.job.provider_post_id,
    provider_channel_id: fx.job.provider_channel_id,
    provider_channel_service: fx.job.provider_service,
    metrics_updated_at: metricsUpdatedAt,
    observed_metric_types: observedTypes,
    metrics: values,
  }));
}

async function resealStoredMetric(fx, metric) {
  const observedTypes = Array.isArray(metric.provider_observed_metric_types)
    ? metric.provider_observed_metric_types
    : [];
  const providerValues = {};
  for (const field of observedTypes) {
    if (Object.hasOwn(metric, field)) providerValues[field] = metric[field];
  }
  metric.provider_metrics_hash = await testProviderMetricsHash(
    fx,
    metric.provider_metrics_updated_at,
    providerValues,
    observedTypes,
  );
  metric.snapshot_fingerprint = createHash('sha256')
    .update(metricFingerprintPayload(metric))
    .digest('hex');
  return metric;
}

async function exactStoredMetric(fx, {
  id = 'metric_from_lost_fence',
  days = 1,
  capturedAt = new Date(
    new Date(fx.publishedAt).getTime() + days * dayMs + 60_000,
  ).toISOString(),
  observedTypes = [
    'comments',
    'follows',
    'reach',
    'saves',
    'shares',
    'views',
  ],
  values = {
    reach: 120,
    views: 450,
    shares: 7,
    saves: 8,
    comments: 9,
    follows: 10,
  },
  overrides = {},
} = {}) {
  const metric = {
    id,
    platform: fx.job.platform,
    campaign: fx.job.campaign,
    content: fx.job.platform_content_id,
    format: fx.plan.format,
    hook: String(fx.job.hook_snapshot || '').trim().replace(/\s+/g, ' ').slice(0, 300),
    cta_variant: String(fx.plan.cta_label || '').trim().replace(/\s+/g, ' ').slice(0, 120),
    published_at: fx.publishedAt,
    snapshot_days: days,
    snapshot_captured_at: capturedAt,
    ...values,
    metric_source: 'buffer',
    provider_post_id: String(fx.job.provider_post_id || '').slice(0, 300),
    provider_channel_id: String(fx.job.provider_channel_id || '').slice(0, 300),
    provider_metrics_updated_at: capturedAt,
    provider_observed_metric_types: [...observedTypes],
    artifact_key: String(fx.job.artifact_key || '').slice(0, 120),
    concept_id: String(fx.job.concept_id || '').slice(0, 120),
    ...(/^[a-f0-9]{64}$/.test(
      String(fx.job.growth_batch_key || '').trim().toLowerCase(),
    )
      ? { growth_batch_key: String(fx.job.growth_batch_key).trim().toLowerCase() }
      : {}),
    ...overrides,
  };
  return resealStoredMetric(fx, metric);
}

function checkpointRecord(publishedAt, days, status = 'captured') {
  const dueAt = new Date(new Date(publishedAt).getTime() + days * dayMs).toISOString();
  return {
    snapshot_days: days,
    due_at: dueAt,
    window_closes_at: new Date(new Date(dueAt).getTime() + dayMs).toISOString(),
    status,
    recorded_at: dueAt,
    ...(status === 'captured'
      ? {
        metric_id: `metric_${days}`,
        snapshot_captured_at: dueAt,
        snapshot_fingerprint: String(days).padStart(64, 'a').slice(-64),
        provider_metrics_updated_at: dueAt,
        provider_metrics_hash: String(days).padStart(64, 'b').slice(-64),
      }
      : { error_code: 'test_review_needed' }),
  };
}

function fixedDateAt(isoValue) {
  const fixedMs = new Date(isoValue).getTime();
  return class FixedDate extends Date {
    constructor(value) {
      super(value === undefined ? fixedMs : value);
    }

    static now() {
      return fixedMs;
    }
  };
}

test('new immutable fields are conditional and media namespaces bind request hashes', async () => {
  const legacyRequest = {
    provider: 'buffer',
    provider_organization_id: 'org_firstknock',
    provider_channel_id: 'channel_instagram',
    provider_service: 'instagram',
    config_revision: 'a'.repeat(64),
    media_origin: 'https://media.firstknock.online',
    artifact_hash: 'b'.repeat(64),
    platform: 'instagram',
    platform_content_id: 'ig-example',
    due_at: '2026-07-29T16:30:00.000Z',
    scheduling_type: 'automatic',
    timezone: 'America/Phoenix',
  };
  const legacyHash =
    '6c8e1b8cb0e961f32fe985d1d08aaa1d357085a5d1c58585538d873bf150609a';
  assert.equal(
    await growthHelpers.publishJobRequestHash(legacyRequest),
    legacyHash,
  );
  assert.equal(
    await growthHelpers.publishJobRequestHash({
      ...legacyRequest,
      source_lineage_snapshot: [],
      hook_snapshot: '   ',
      render_pack_sha256: '',
      growth_batch_key: '',
      media_path_prefix: '',
    }),
    legacyHash,
  );
  const boundRequest = {
    ...legacyRequest,
    source_lineage_snapshot: sourceLineageSnapshot,
    hook_snapshot: 'One area. One clean route.',
    render_pack_sha256: 'c'.repeat(64),
    growth_batch_key: 'd'.repeat(64),
    media_path_prefix: env.GROWTH_MEDIA_PATH_PREFIX,
  };
  const boundHash = await growthHelpers.publishJobRequestHash(boundRequest);
  assert.notEqual(boundHash, legacyHash);
  assert.notEqual(
    await growthHelpers.publishJobRequestHash({
      ...boundRequest,
      source_lineage_snapshot: [{
        ...sourceLineageSnapshot[0],
        source_reference: 'replacement-proof.mp4',
      }],
    }),
    boundHash,
  );
  assert.notEqual(
    await growthHelpers.publishJobRequestHash({
      ...boundRequest,
      media_path_prefix: '/files/public/different-app/',
    }),
    boundHash,
  );
});

test('publish-job schema admits reservation_pending but the worker never claims it', async () => {
  const schema = JSON.parse(readFileSync(
    new URL('../base44/entities/GrowthPublishJob.jsonc', import.meta.url),
    'utf8',
  ));
  assert.equal(
    schema.properties.state.enum.includes('reservation_pending'),
    true,
  );
  assert.equal(schema.required.includes('media_path_prefix'), true);
  assert.match(
    env.GROWTH_MEDIA_PATH_PREFIX,
    new RegExp(schema.properties.media_path_prefix.pattern),
  );
  const fx = await fixture({
    job: {
      state: 'reservation_pending',
      lease_token: 'active-scheduler-reservation',
      lease_generation: 2,
      lease_acquired_at: new Date().toISOString(),
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
  });
  let fetches = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      fetches += 1;
      throw new Error('reservation_pending must not reach provider or media');
    },
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(result.body.inspected, 0);
  assert.equal(result.body.processed, 0);
  assert.equal(fetches, 0);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'reservation_pending');
  assert.equal(entities.GrowthPublishJob.records[0].attempt_count, 0);
  assert.equal(entities.GrowthPublishJob.counters.updateMany, 0);
});

test('an expired scheduler reservation is canceled with its planned measurement and no provider access', async () => {
  const fx = await fixture({
    job: {
      state: 'reservation_pending',
      lease_token: 'expired-scheduler-reservation',
      lease_generation: 3,
      lease_acquired_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      lease_expires_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  let fetches = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      fetches += 1;
      throw new Error('expired reservation cleanup must remain local');
    },
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(result.body.inspected, 1);
  assert.equal(result.body.processed, 1);
  assert.equal(result.body.states.canceled, 1);
  assert.equal(fetches, 0);
  const saved = entities.GrowthPublishJob.records[0];
  assert.equal(saved.state, 'canceled');
  assert.equal(saved.attempt_count, 0);
  assert.equal(saved.last_error_code, 'schedule_reservation_expired');
  assert.equal(saved.lease_token, undefined);
  assert.equal(saved.lease_expires_at, undefined);
  assert.equal(saved.delivery_reconcile_target, undefined);
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'canceled');
  assert.equal(entities.GrowthSourceAsset.counters.filter, 0);
  assert.equal(entities.GrowthCreativeArtifact.counters.get, 0);
});

test('an expired reservation plan-CAS failure enters durable local delivery repair', async () => {
  const fx = await fixture({
    job: {
      state: 'reservation_pending',
      lease_token: 'expired-scheduler-repair',
      lease_generation: 4,
      lease_acquired_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      lease_expires_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  const originalPlanUpdateMany = entities.GrowthContentPlan.updateMany;
  let failPlanCancellation = true;
  entities.GrowthContentPlan.updateMany = async (...args) => {
    if (failPlanCancellation) {
      return { success: true, updated: 0, has_more: false };
    }
    return originalPlanUpdateMany(...args);
  };
  let fetches = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      fetches += 1;
      throw new Error('reservation measurement repair must remain local');
    },
  });

  let result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(result.body.states.delivery_reconcile, 1);
  assert.equal(fetches, 0);
  let saved = entities.GrowthPublishJob.records[0];
  assert.equal(saved.state, 'delivery_reconcile');
  assert.equal(saved.delivery_reconcile_target, 'canceled');
  assert.equal(saved.last_error_code, 'schedule_reservation_expired');
  assert.equal(saved.attempt_count, 0);
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'planned');

  failPlanCancellation = false;
  saved.next_retry_at = new Date(Date.now() - 1000).toISOString();
  result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(result.body.states.canceled, 1);
  assert.equal(fetches, 0);
  saved = entities.GrowthPublishJob.records[0];
  assert.equal(saved.state, 'canceled');
  assert.equal(saved.delivery_reconcile_target, undefined);
  assert.equal(saved.attempt_count, 0);
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'canceled');
});

test('an expired reservation sweep loses safely to a fresh scheduler lease', async () => {
  const fx = await fixture({
    job: {
      state: 'reservation_pending',
      lease_token: 'expired-scheduler-cas',
      lease_generation: 5,
      lease_acquired_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      lease_expires_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  const originalJobUpdateMany = entities.GrowthPublishJob.updateMany;
  let raced = false;
  entities.GrowthPublishJob.updateMany = async (query, operations) => {
    if (!raced && query?.state === 'reservation_pending') {
      raced = true;
      Object.assign(entities.GrowthPublishJob.records[0], {
        lease_token: 'fresh-scheduler-cas',
        lease_generation: 6,
        lease_acquired_at: new Date().toISOString(),
        lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
      return { success: true, updated: 0, has_more: false };
    }
    return originalJobUpdateMany(query, operations);
  };
  let fetches = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      fetches += 1;
      throw new Error('a lost cleanup CAS must not access providers');
    },
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(result.body.inspected, 1);
  assert.equal(result.body.processed, 0);
  assert.equal(fetches, 0);
  const saved = entities.GrowthPublishJob.records[0];
  assert.equal(saved.state, 'reservation_pending');
  assert.equal(saved.lease_token, 'fresh-scheduler-cas');
  assert.equal(saved.lease_generation, 6);
  assert.ok(new Date(saved.lease_expires_at).getTime() > Date.now());
  assert.equal(saved.last_error_code, undefined);
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'planned');
});

test('worker rejects missing configuration and bad secrets before storage or provider access', async () => {
  const { base44, entities } = createGrowthBase44();
  let clientCreates = 0;
  let fetches = 0;
  let handler = loadGrowthHandler(workerPath, {
    base44,
    env: {},
    onClientCreate: () => { clientCreates += 1; },
    fetchImpl: async () => { fetches += 1; },
  });
  let result = await invokeJson(handler, {}, { secret: 'wrong' });
  assert.equal(result.status, 503);
  assert.equal(clientCreates, 0);

  handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    onClientCreate: () => { clientCreates += 1; },
    fetchImpl: async () => { fetches += 1; },
  });
  result = await invokeJson(handler, {}, { secret: 'wrong-secret-value' });
  assert.equal(result.status, 401);
  assert.equal(clientCreates, 0);
  assert.equal(fetches, 0);
  assert.equal(entities.GrowthPublishJob.counters.filter, 0);

  handler = loadGrowthHandler(workerPath, {
    base44,
    env: { ...env, GROWTH_MEDIA_PATH_PREFIX: '' },
    onClientCreate: () => { clientCreates += 1; },
    fetchImpl: async () => { fetches += 1; },
  });
  result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'buffer_not_configured');
  assert.equal(clientCreates, 0);
  assert.equal(fetches, 0);
  assert.equal(entities.GrowthPublishJob.counters.filter, 0);
});

test('disabled kill switch performs no entity or provider work', async () => {
  const { base44, entities } = createGrowthBase44();
  let fetches = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env: { ...env, GROWTH_PUBLISH_ENABLED: 'false' },
    fetchImpl: async () => { fetches += 1; },
  });
  const result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'growth_publishing_disabled');
  assert.equal(entities.GrowthPublishJob.counters.filter, 0);
  assert.equal(fetches, 0);
});

test('a due queued job is leased once, created in Buffer once, and never blindly replayed', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
  });
  const outbound = [];
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async (url, options) => {
      outbound.push({ url, options });
      return Response.json({
        data: {
          createPost: {
            __typename: 'PostActionSuccess',
            post: bufferPost(fx),
          },
        },
      });
    }),
  });
  const [first, concurrent] = await Promise.all([
    invokeJson(handler, { limit: 5 }, { secret: workerSecret }),
    invokeJson(handler, { limit: 5 }, { secret: workerSecret }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(concurrent.status, 200);
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].url, 'https://api.buffer.com');
  assert.equal(outbound[0].options.headers.authorization, `Bearer ${apiKey}`);
  assert.equal(outbound[0].options.body.includes(workerSecret), false);
  assert.match(outbound[0].options.body, /createPost/);
  assert.match(outbound[0].options.body, new RegExp(fx.dueAt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const createQuery = JSON.parse(outbound[0].options.body).query;
  assert.match(createQuery, /schedulingType:automatic/);
  assert.match(createQuery, /mode:customScheduled/);
  assert.match(createQuery, /instagram:\{type:reel,/);
  assert.doesNotMatch(createQuery, /schedulingType:"automatic"/);
  assert.doesNotMatch(createQuery, /mode:"customScheduled"/);
  assert.equal(createQuery.includes(JSON.stringify(fx.artifact.provider_text)), true);

  const saved = entities.GrowthPublishJob.records[0];
  assert.equal(saved.state, 'scheduled');
  assert.equal(saved.provider_post_id, 'buffer_post_1');
  assert.equal(saved.attempt_count, 1);
  assert.equal(JSON.stringify(saved).includes(apiKey), false);
  assert.equal(JSON.stringify(saved).includes(workerSecret), false);

  const replay = await invokeJson(handler, { limit: 5 }, { secret: workerSecret });
  assert.equal(replay.status, 200);
  assert.equal(outbound.length, 1);
});

test('artifact tampering after approval blocks provider access', async () => {
  const fx = await fixture({
    artifact: { caption: 'A changed, unapproved caption.' },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  let fetches = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      fetches += 1;
      throw new Error('must not call provider');
    },
  });
  const result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  assert.equal(fetches, 0);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
  assert.equal(entities.GrowthPublishJob.records[0].last_error_code, 'artifact_approval_changed');
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'canceled');
});

test('shared-origin media from another Base44 app namespace fails closed', async () => {
  const fx = await fixture();
  fx.artifact.media_url = [
    env.GROWTH_MEDIA_ORIGIN,
    '/files/public/another-app/',
    `opaque_${mediaSha256}-route-proof.mp4`,
  ].join('');
  fx.artifact.approved_hash =
    await growthHelpers.artifactApprovalHash(fx.artifact);
  fx.job.artifact_hash = fx.artifact.approved_hash;
  fx.job.request_hash = await growthHelpers.publishJobRequestHash(fx.job);
  fx.job.job_key = await growthHelpers.publishJobKey(fx.job);
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  let fetches = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      fetches += 1;
      throw new Error('cross-app media must fail before network access');
    },
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(fetches, 0);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'media_namespace_mismatch',
  );
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'canceled');
});

test('immutable publish-job namespace drift cannot bypass request hashing', async () => {
  const fx = await fixture();
  fx.job.media_path_prefix = '/files/public/another-app/';
  fx.job.config_revision = await growthHelpers.sha256Hex([
    'buffer',
    env.BUFFER_ORGANIZATION_ID,
    env.BUFFER_INSTAGRAM_CHANNEL_ID,
    'instagram',
    fx.job.media_origin,
    fx.job.media_path_prefix,
  ].join('|'));
  fx.job.request_hash = await growthHelpers.publishJobRequestHash(fx.job);
  fx.job.job_key = await growthHelpers.publishJobKey(fx.job);
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  let fetches = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      fetches += 1;
      throw new Error('namespace drift must fail before network access');
    },
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(fetches, 0);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'publish_job_configuration_changed',
  );
});

test('approval revoked after the earlier worker check is fenced before createPost', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  const originalArtifactGet = entities.GrowthCreativeArtifact.get;
  let artifactReads = 0;
  entities.GrowthCreativeArtifact.get = async (...args) => {
    artifactReads += 1;
    if (artifactReads === 3) {
      Object.assign(entities.GrowthCreativeArtifact.records[0], {
        approval_status: 'revoked',
        revoked_at: new Date().toISOString(),
        revocation_note: 'Approval was revoked during worker verification.',
      });
    }
    return originalArtifactGet(...args);
  };
  let createCalls = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => {
      createCalls += 1;
      throw new Error('createPost must not run after the final approval fence');
    }),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(artifactReads, 3);
  assert.equal(createCalls, 0);
  assert.equal(
    entities.GrowthCreativeArtifact.records[0].approval_status,
    'revoked',
  );
  assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'artifact_approval_changed',
  );
  assert.equal(
    entities.GrowthContentPlan.records[0].delivery_status,
    'canceled',
  );
});

test('a lost final lease renewal prevents provider submission', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  const originalJobUpdateMany = entities.GrowthPublishJob.updateMany;
  let renewalAttempts = 0;
  entities.GrowthPublishJob.updateMany = async (query, operations) => {
    if (
      query?.state === 'processing'
      && operations?.$set?.lease_expires_at
      && Object.keys(operations.$set).length === 1
    ) {
      renewalAttempts += 1;
      Object.assign(entities.GrowthPublishJob.records[0], {
        lease_token: 'replacement-worker-lease',
        lease_expires_at: new Date(Date.now() + 90 * 1000).toISOString(),
        updated_date: new Date().toISOString(),
      });
    }
    return originalJobUpdateMany(query, operations);
  };
  let createCalls = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => {
      createCalls += 1;
      throw new Error('createPost must not run after lease ownership is lost');
    }),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(renewalAttempts, 1);
  assert.equal(createCalls, 0);
  assert.equal(result.body.states.lease_lost, 1);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'processing');
  assert.equal(
    entities.GrowthPublishJob.records[0].lease_token,
    'replacement-worker-lease',
  );
  assert.equal(
    entities.GrowthContentPlan.records[0].delivery_status,
    'planned',
  );
});

test('expired-lease recovery loses its stale snapshot after a concurrent renewal', async () => {
  const expiredAt = new Date(Date.now() - 1000).toISOString();
  const fx = await fixture({
    job: {
      state: 'processing',
      attempt_count: 1,
      lease_source_state: 'queued',
      lease_token: 'still-active-worker',
      lease_generation: 4,
      lease_acquired_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      lease_expires_at: expiredAt,
    },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  const originalJobUpdateMany = entities.GrowthPublishJob.updateMany;
  let recoveryAttempts = 0;
  let renewedSnapshot;
  entities.GrowthPublishJob.updateMany = async (query, operations) => {
    if (
      query?.state === 'processing'
      && query?.lease_expires_at === expiredAt
      && operations?.$set?.state === 'create_reconcile'
    ) {
      recoveryAttempts += 1;
      Object.assign(entities.GrowthPublishJob.records[0], {
        lease_expires_at: new Date(Date.now() + 90 * 1000).toISOString(),
        updated_date: new Date().toISOString(),
      });
      renewedSnapshot = structuredClone(entities.GrowthPublishJob.records[0]);
    }
    return originalJobUpdateMany(query, operations);
  };
  let providerFetches = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      providerFetches += 1;
      throw new Error('stale lease recovery must not reach Buffer');
    },
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(result.body.inspected, 1);
  assert.equal(result.body.processed, 0);
  assert.deepEqual(result.body.states, {});
  assert.equal(recoveryAttempts, 1);
  assert.equal(providerFetches, 0);
  assert.deepEqual(entities.GrowthPublishJob.records[0], renewedSnapshot);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'processing');
  assert.equal(
    entities.GrowthPublishJob.records[0].lease_token,
    'still-active-worker',
  );
  assert.ok(
    new Date(entities.GrowthPublishJob.records[0].lease_expires_at).getTime()
      > Date.now(),
  );
  assert.equal(
    entities.GrowthContentPlan.records[0].delivery_status,
    'planned',
  );
});

test('stale duplicate suppression cannot erase a renewed processing lease', async () => {
  const fx = await fixture();
  const now = Date.now();
  const canonical = {
    ...fx.job,
    id: 'job_duplicate_canonical',
    created_date: new Date(now - 5 * 60 * 1000).toISOString(),
  };
  const expiredAt = new Date(now - 1000).toISOString();
  const duplicate = {
    ...fx.job,
    id: 'job_duplicate_processing',
    state: 'processing',
    attempt_count: 1,
    lease_source_state: 'queued',
    lease_token: 'renewing-worker-lease',
    lease_generation: 4,
    lease_acquired_at: new Date(now - 2 * 60 * 1000).toISOString(),
    lease_expires_at: expiredAt,
    created_date: new Date(now - 60 * 1000).toISOString(),
  };
  const { base44, entities } = createGrowthBase44({
    jobs: [canonical, duplicate],
  });
  const canonicalBefore = structuredClone(
    entities.GrowthPublishJob.records.find((job) => job.id === canonical.id),
  );
  const originalJobUpdateMany = entities.GrowthPublishJob.updateMany;
  let suppressionAttempts = 0;
  let renewedSnapshot;
  entities.GrowthPublishJob.updateMany = async (query, operations) => {
    if (
      query?.id === duplicate.id
      && query?.state === 'processing'
      && operations?.$set?.last_error_code
        === 'duplicate_publish_job_suppressed'
    ) {
      suppressionAttempts += 1;
      const live = entities.GrowthPublishJob.records.find(
        (job) => job.id === duplicate.id,
      );
      const renewedAt = new Date().toISOString();
      Object.assign(live, {
        lease_acquired_at: renewedAt,
        lease_expires_at: new Date(Date.now() + 90 * 1000).toISOString(),
        last_attempt_at: renewedAt,
        last_error_code: 'active_worker_renewed',
        last_error_message: 'The active worker renewed this lease.',
        updated_date: renewedAt,
      });
      renewedSnapshot = structuredClone(live);
    }
    return originalJobUpdateMany(query, operations);
  };
  let providerFetches = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      providerFetches += 1;
      throw new Error('duplicate suppression must finish before provider access');
    },
  });

  const result = await invokeJson(
    handler,
    { limit: 1 },
    { secret: workerSecret },
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.inspected, 1);
  assert.equal(result.body.processed, 1);
  assert.equal(result.body.states.lease_lost, 1);
  assert.equal(suppressionAttempts, 1);
  assert.equal(providerFetches, 0);
  assert.deepEqual(
    entities.GrowthPublishJob.records.find((job) => job.id === duplicate.id),
    renewedSnapshot,
  );
  assert.deepEqual(
    entities.GrowthPublishJob.records.find((job) => job.id === canonical.id),
    canonicalBefore,
  );
  assert.equal(renewedSnapshot.state, 'processing');
  assert.equal(renewedSnapshot.lease_token, 'renewing-worker-lease');
  assert.equal(renewedSnapshot.last_error_code, 'active_worker_renewed');
  assert.notEqual(
    renewedSnapshot.last_error_code,
    'duplicate_publish_job_suppressed',
  );
  assert.ok(new Date(renewedSnapshot.lease_expires_at).getTime() > Date.now());
});

test('mismatched fetched media bytes fail before any Buffer request', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
  });
  let mediaFetches = 0;
  let bufferFetches = 0;
  const mismatchedBytes = new TextEncoder().encode('tampered-media-bytes');
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async (url) => {
      if (String(url).startsWith(`${env.GROWTH_MEDIA_ORIGIN}/`)) {
        mediaFetches += 1;
        return new Response(mismatchedBytes, {
          status: 200,
          headers: {
            'content-type': fx.artifact.mime_type,
            'content-length': String(mismatchedBytes.byteLength),
          },
        });
      }
      bufferFetches += 1;
      throw new Error('Buffer must not be called for mismatched media bytes');
    },
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(mediaFetches, 1);
  assert.equal(bufferFetches, 0);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'media_hash_mismatch',
  );
});

test('a mis-scoped Buffer channel fails before createPost', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
  });
  let createCalls = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => {
      createCalls += 1;
      throw new Error('createPost must not run for the wrong channel service');
    }, mediaBytes, { service: 'tiktok' }),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(createCalls, 0);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'provider_channel_mismatch',
  );
});

test('a paused Buffer channel blocks createPost and cancels planned measurement', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  let createCalls = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => {
      createCalls += 1;
      throw new Error('createPost must not run while the channel queue is paused');
    }, mediaBytes, { isQueuePaused: true }),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(createCalls, 0);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'provider_channel_paused',
  );
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'canceled');
});

test('source privacy withdrawal on the immediate pre-create reread fails closed', async (t) => {
  const cases = [
    {
      name: 'source becomes blocked',
      changedSource: { ...source, privacy_status: 'blocked', active: true },
    },
    {
      name: 'source becomes inactive',
      changedSource: { ...source, privacy_status: 'safe', active: false },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const fx = await fixture();
      const { base44, entities } = createGrowthBase44({
        sources: [source],
        artifacts: [fx.artifact],
        jobs: [fx.job],
        plans: [measurementPlan(fx)],
      });
      const originalSourceFilter = entities.GrowthSourceAsset.filter;
      let sourceReads = 0;
      entities.GrowthSourceAsset.filter = async (...args) => {
        sourceReads += 1;
        if (sourceReads === 1) return originalSourceFilter(...args);
        return [structuredClone(item.changedSource)];
      };
      let createCalls = 0;
      const handler = loadGrowthHandler(workerPath, {
        base44,
        env,
        fetchImpl: withApprovedMedia(async () => {
          createCalls += 1;
          throw new Error('createPost must not run after privacy withdrawal');
        }),
      });

      const result = await invokeJson(handler, {}, { secret: workerSecret });

      assert.equal(result.status, 200);
      assert.equal(sourceReads, 2);
      assert.equal(createCalls, 0);
      assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
      assert.equal(
        entities.GrowthPublishJob.records[0].last_error_code,
        'source_privacy_clearance_changed',
      );
      assert.equal(
        entities.GrowthContentPlan.records[0].delivery_status,
        'canceled',
      );
    });
  }
});

test('manual source lineage snapshot drift fails preflight and cancels measurement', async (t) => {
  const cases = [
    {
      name: 'source SHA changes',
      changedSource: { ...source, source_sha256: 'b'.repeat(64) },
    },
    {
      name: 'source reference changes',
      changedSource: { ...source, source_reference: 'replacement-proof.mp4' },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const fx = await fixture();
      const { base44, entities } = createGrowthBase44({
        sources: [item.changedSource],
        artifacts: [fx.artifact],
        jobs: [fx.job],
        plans: [measurementPlan(fx)],
      });
      let providerCalls = 0;
      const handler = loadGrowthHandler(workerPath, {
        base44,
        env,
        fetchImpl: async () => {
          providerCalls += 1;
          throw new Error('provider access must not run after source lineage drift');
        },
      });

      const result = await invokeJson(handler, {}, { secret: workerSecret });

      assert.equal(result.status, 200);
      assert.equal(providerCalls, 0);
      assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
      assert.equal(
        entities.GrowthPublishJob.records[0].last_error_code,
        'source_render_lineage_changed',
      );
      assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'canceled');
    });
  }
});

test('manual source lineage drift on the immediate pre-create reread fails closed', async (t) => {
  const cases = [
    {
      name: 'source SHA changes',
      changedSource: { ...source, source_sha256: 'b'.repeat(64) },
    },
    {
      name: 'source reference changes',
      changedSource: { ...source, source_reference: 'replacement-proof.mp4' },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const fx = await fixture();
      const { base44, entities } = createGrowthBase44({
        sources: [source],
        artifacts: [fx.artifact],
        jobs: [fx.job],
        plans: [measurementPlan(fx)],
      });
      const originalSourceFilter = entities.GrowthSourceAsset.filter;
      let sourceReads = 0;
      entities.GrowthSourceAsset.filter = async (...args) => {
        sourceReads += 1;
        if (sourceReads === 1) return originalSourceFilter(...args);
        return [structuredClone(item.changedSource)];
      };
      let createCalls = 0;
      const handler = loadGrowthHandler(workerPath, {
        base44,
        env,
        fetchImpl: withApprovedMedia(async () => {
          createCalls += 1;
          throw new Error('createPost must not run after source lineage drift');
        }),
      });

      const result = await invokeJson(handler, {}, { secret: workerSecret });

      assert.equal(result.status, 200);
      assert.equal(sourceReads, 2);
      assert.equal(createCalls, 0);
      assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
      assert.equal(
        entities.GrowthPublishJob.records[0].last_error_code,
        'source_render_lineage_changed',
      );
      assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'canceled');
    });
  }
});

test('legacy manual jobs without a source snapshot fail closed explicitly', async () => {
  const fx = await fixture();
  delete fx.job.source_lineage_snapshot;
  fx.job.request_hash = await growthHelpers.publishJobRequestHash(fx.job);
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  let providerCalls = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error('legacy manual jobs must not reach provider or media');
    },
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(providerCalls, 0);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'source_lineage_snapshot_missing',
  );
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'canceled');
});

test('legacy rendered jobs may fall back to approval-bound render lineage', async () => {
  const fx = await renderedFixture();
  delete fx.job.source_lineage_snapshot;
  fx.job.request_hash = await growthHelpers.publishJobRequestHash(fx.job);
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  let createCalls = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => {
      createCalls += 1;
      return Response.json({
        data: {
          createPost: {
            __typename: 'PostActionSuccess',
            post: bufferPost(fx),
          },
        },
      });
    }),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(createCalls, 1);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'scheduled');
});

test('rendered source lineage drift fails preflight and cancels measurement', async (t) => {
  const cases = [
    {
      name: 'source SHA changes',
      changedSource: { ...source, source_sha256: 'b'.repeat(64) },
    },
    {
      name: 'source reference changes',
      changedSource: { ...source, source_reference: 'replacement-proof.mp4' },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const fx = await renderedFixture();
      const { base44, entities } = createGrowthBase44({
        sources: [item.changedSource],
        artifacts: [fx.artifact],
        jobs: [fx.job],
        plans: [measurementPlan(fx)],
      });
      let providerCalls = 0;
      const handler = loadGrowthHandler(workerPath, {
        base44,
        env,
        fetchImpl: async () => {
          providerCalls += 1;
          throw new Error('provider access must not run after source lineage drift');
        },
      });

      const result = await invokeJson(handler, {}, { secret: workerSecret });

      assert.equal(result.status, 200);
      assert.equal(providerCalls, 0);
      assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
      assert.equal(
        entities.GrowthPublishJob.records[0].last_error_code,
        'source_render_lineage_changed',
      );
      assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'canceled');
    });
  }
});

test('rendered source lineage drift on the immediate pre-create reread fails closed', async (t) => {
  const cases = [
    {
      name: 'source SHA changes',
      changedSource: { ...source, source_sha256: 'b'.repeat(64) },
    },
    {
      name: 'source reference changes',
      changedSource: { ...source, source_reference: 'replacement-proof.mp4' },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const fx = await renderedFixture();
      const { base44, entities } = createGrowthBase44({
        sources: [source],
        artifacts: [fx.artifact],
        jobs: [fx.job],
        plans: [measurementPlan(fx)],
      });
      const originalSourceFilter = entities.GrowthSourceAsset.filter;
      let sourceReads = 0;
      entities.GrowthSourceAsset.filter = async (...args) => {
        sourceReads += 1;
        if (sourceReads === 1) return originalSourceFilter(...args);
        return [structuredClone(item.changedSource)];
      };
      let createCalls = 0;
      const handler = loadGrowthHandler(workerPath, {
        base44,
        env,
        fetchImpl: withApprovedMedia(async () => {
          createCalls += 1;
          throw new Error('createPost must not run after source lineage drift');
        }),
      });

      const result = await invokeJson(handler, {}, { secret: workerSecret });

      assert.equal(result.status, 200);
      assert.equal(sourceReads, 2);
      assert.equal(createCalls, 0);
      assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
      assert.equal(
        entities.GrowthPublishJob.records[0].last_error_code,
        'source_render_lineage_changed',
      );
      assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'canceled');
    });
  }
});

test('a transient pre-create source reread outage retries without creating in Buffer', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  const originalSourceFilter = entities.GrowthSourceAsset.filter;
  let sourceReads = 0;
  entities.GrowthSourceAsset.filter = async (...args) => {
    sourceReads += 1;
    if (sourceReads === 1) return originalSourceFilter(...args);
    throw new Error('temporary source read outage');
  };
  let createCalls = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => {
      createCalls += 1;
      throw new Error('createPost must not run during privacy-read outage');
    }),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(sourceReads, 2);
  assert.equal(createCalls, 0);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'retry_wait');
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'source_privacy_clearance_unavailable',
  );
  assert.ok(
    new Date(entities.GrowthPublishJob.records[0].next_retry_at).getTime()
      > Date.now(),
  );
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'planned');
});

test('a failed plan-cancel CAS enters delivery reconciliation and completes without createPost', async () => {
  const fx = await fixture({
    artifact: { caption: 'A changed, unapproved caption.' },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
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
  let providerFetches = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      providerFetches += 1;
      throw new Error('delivery reconciliation must not call Buffer');
    },
  });

  let result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'delivery_reconcile');
  assert.equal(
    entities.GrowthPublishJob.records[0].delivery_reconcile_target,
    'failed',
  );
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'artifact_approval_changed',
  );
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'planned');
  assert.equal(providerFetches, 0);

  entities.GrowthPublishJob.records[0].next_retry_at = new Date(
    Date.now() - 1000,
  ).toISOString();
  result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
  assert.notEqual(entities.GrowthPublishJob.records[0].state, 'canceled');
  assert.equal(entities.GrowthPublishJob.records[0].attempt_count, 1);
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'canceled');
  assert.equal(providerFetches, 0);
});

test('owner cancel and provider resolution repair plan-CAS failures to canceled without Buffer', async (t) => {
  const cases = [
    {
      name: 'cancel_job',
      job: {
        id: 'job_owner_cancel_repair',
        artifact_id: 'artifact_owner_cancel_repair',
        campaign: '1000-users',
        platform: 'instagram',
        platform_content_id: 'ig-owner-cancel-repair',
        state: 'queued',
        lease_generation: 0,
      },
      request: {
        action: 'cancel_job',
        job_id: 'job_owner_cancel_repair',
      },
      errorCode: 'owner_canceled',
    },
    {
      name: 'resolve_job',
      job: {
        id: 'job_owner_resolve_repair',
        artifact_id: 'artifact_owner_resolve_repair',
        campaign: '1000-users',
        platform: 'instagram',
        platform_content_id: 'ig-owner-resolve-repair',
        state: 'review_required',
        provider_post_id: 'buffer_post_owner_verified_canceled',
        provider_status: 'scheduled',
        lease_generation: 2,
      },
      request: {
        action: 'resolve_job',
        job_id: 'job_owner_resolve_repair',
        provider_cancellation_verified: true,
        resolution_evidence_note: 'Verified canceled in Buffer before local repair.',
      },
      errorCode: 'owner_verified_provider_canceled',
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const plan = {
        id: `plan_${item.job.id}`,
        campaign: item.job.campaign,
        content: item.job.platform_content_id,
        sprint: 'content-engine',
        delivery_managed_by: 'buffer',
        delivery_status: 'planned',
      };
      const { base44, entities } = createGrowthBase44({
        jobs: [item.job],
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
      const manager = loadGrowthHandler(managePath, { base44, env });

      const managerResult = await invokeJson(manager, item.request);

      assert.equal(managerResult.status, 202);
      assert.equal(managerResult.body.success, true);
      assert.equal(managerResult.body.measurement_repair_pending, true);
      assert.equal(managerResult.body.job.state, 'delivery_reconcile');
      assert.equal(
        managerResult.body.job.delivery_reconcile_target,
        'canceled',
      );
      assert.equal(entities.GrowthPublishJob.records[0].state, 'delivery_reconcile');
      assert.equal(
        entities.GrowthPublishJob.records[0].delivery_reconcile_target,
        'canceled',
      );
      assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'planned');

      let providerFetches = 0;
      const worker = loadGrowthHandler(workerPath, {
        base44,
        env,
        fetchImpl: async () => {
          providerFetches += 1;
          throw new Error('canceled delivery repair must not call Buffer');
        },
      });
      const workerResult = await invokeJson(
        worker,
        {},
        { secret: workerSecret },
      );

      assert.equal(workerResult.status, 200);
      assert.equal(entities.GrowthPublishJob.records[0].state, 'canceled');
      assert.equal(
        entities.GrowthPublishJob.records[0].last_error_code,
        item.errorCode,
      );
      assert.equal(
        entities.GrowthContentPlan.records[0].delivery_status,
        'canceled',
      );
      assert.equal(providerFetches, 0);
    });
  }
});

test('an expired delivery-reconcile lease recovers locally and never enters provider reconciliation', async () => {
  const fx = await fixture({
    job: {
      state: 'processing',
      attempt_count: 1,
      reconciliation_count: 0,
      lease_token: 'expired-delivery-lease',
      lease_source_state: 'delivery_reconcile',
      lease_generation: 3,
      lease_acquired_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      lease_expires_at: new Date(Date.now() - 1000).toISOString(),
      last_error_code: 'artifact_approval_changed',
      last_error_message:
        'Approval changed. Measurement-plan cancellation will retry.',
    },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  let providerFetches = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      providerFetches += 1;
      throw new Error('expired delivery cleanup must not query Buffer');
    },
  });

  let result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'delivery_reconcile');
  assert.equal(
    entities.GrowthPublishJob.records[0].lease_source_state,
    undefined,
  );
  assert.equal(entities.GrowthPublishJob.records[0].reconciliation_count, 0);
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'planned');
  assert.equal(providerFetches, 0);

  result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
  assert.equal(entities.GrowthPublishJob.records[0].attempt_count, 1);
  assert.equal(entities.GrowthPublishJob.records[0].reconciliation_count, 0);
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'canceled');
  assert.equal(providerFetches, 0);
});

test('a missed scheduling cutoff cancels its Instagram measurement plan', async () => {
  const fx = await fixture({
    job: {
      schedule_cutoff_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  let providerFetches = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      providerFetches += 1;
      throw new Error('a missed cutoff must fail before Buffer');
    },
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(providerFetches, 0);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'missed_schedule_window',
  );
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'canceled');
});

test('a missed TikTok scheduling cutoff cancels only its platform measurement plan', async () => {
  const fx = await tiktokFixture({
    job: {
      schedule_cutoff_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  const instagramPlan = measurementPlan(fx, {
    id: 'growth_plan_instagram_collision',
    platform: 'instagram',
  });
  const tiktokPlan = measurementPlan(fx, {
    id: 'growth_plan_tiktok_collision',
    platform: 'tiktok',
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [instagramPlan, tiktokPlan],
  });
  const planQueries = [];
  const originalPlanFilter = entities.GrowthContentPlan.filter;
  entities.GrowthContentPlan.filter = async (query, ...args) => {
    planQueries.push(structuredClone(query));
    return originalPlanFilter(query, ...args);
  };
  let providerFetches = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      providerFetches += 1;
      throw new Error('a missed cutoff must fail before Buffer');
    },
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(providerFetches, 0);
  assert.ok(planQueries.some((query) => query.platform === 'tiktok'));
  assert.equal(
    entities.GrowthContentPlan.records.find(
      (plan) => plan.platform === 'tiktok',
    ).delivery_status,
    'canceled',
  );
  assert.equal(
    entities.GrowthContentPlan.records.find(
      (plan) => plan.platform === 'instagram',
    ).delivery_status,
    'planned',
  );
});

test('every failed review gate blocks provider access after approval', async (t) => {
  const cases = [
    ['review_status', 'changes_requested'],
    ['privacy_cleared', false],
    ['demo_labeled', false],
    ['claims_supported', false],
    ['media_rights_confirmed', false],
  ];
  for (const [field, value] of cases) {
    await t.test(field, async () => {
      const fx = await fixture({
        artifact: { [field]: value },
      });
      const { base44, entities } = createGrowthBase44({
        sources: [source],
        artifacts: [fx.artifact],
        jobs: [fx.job],
      });
      let fetches = 0;
      const handler = loadGrowthHandler(workerPath, {
        base44,
        env,
        fetchImpl: async () => {
          fetches += 1;
          return Response.json({
            data: {
              createPost: {
                __typename: 'PostActionSuccess',
                post: bufferPost(fx),
              },
            },
          });
        },
      });

      const result = await invokeJson(handler, {}, { secret: workerSecret });
      assert.equal(result.status, 200);
      assert.equal(fetches, 0);
      assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
      assert.equal(
        entities.GrowthPublishJob.records[0].last_error_code,
        'artifact_approval_changed',
      );
    });
  }
});

test('mismatched create successes fail closed while retaining the provider id', async (t) => {
  const cases = [
    ['channel', (fx) => ({ channelId: 'wrong_channel' })],
    ['channel service', () => ({ channelService: 'tiktok' })],
    ['publishing mode', () => ({ schedulingType: 'notification' })],
    ['time', (fx) => ({
      dueAt: new Date(new Date(fx.dueAt).getTime() + 60 * 1000).toISOString(),
    })],
    ['text', () => ({ text: 'Different provider text.' })],
    ['media', (fx) => ({
      assets: [{
        source: 'https://media.firstknock.online/sha256/unapproved-media.mp4',
        mimeType: fx.artifact.mime_type,
        type: 'video',
      }],
    })],
  ];
  for (const [name, mismatch] of cases) {
    await t.test(name, async () => {
      const fx = await fixture();
      const { base44, entities } = createGrowthBase44({
        sources: [source],
        artifacts: [fx.artifact],
        jobs: [fx.job],
      });
      const handler = loadGrowthHandler(workerPath, {
        base44,
        env,
      fetchImpl: withApprovedMedia(async () => Response.json({
        data: {
            createPost: {
              __typename: 'PostActionSuccess',
              post: bufferPost(fx, mismatch(fx)),
          },
        },
      })),
      });

      const result = await invokeJson(handler, {}, { secret: workerSecret });
      assert.equal(result.status, 200);
      const saved = entities.GrowthPublishJob.records[0];
      assert.equal(saved.state, 'review_required');
      assert.equal(saved.provider_post_id, 'buffer_post_1');
      assert.notEqual(saved.last_error_code, '');
    });
  }
});

test('a mismatched known provider post fails closed without losing its id', async () => {
  const fx = await fixture({
    job: {
      state: 'scheduled',
      provider_status: 'scheduled',
      provider_post_id: 'buffer_post_1',
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
  });
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => Response.json({
      data: {
        post: bufferPost(fx, {
          channelId: 'wrong_channel',
          text: 'Wrong post returned for the durable provider id.',
        }),
      },
    })),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  const saved = entities.GrowthPublishJob.records[0];
  assert.equal(saved.state, 'review_required');
  assert.equal(saved.provider_post_id, 'buffer_post_1');
  assert.notEqual(saved.last_error_code, '');
});

test('worker persists only public HTTPS provider external links', async (t) => {
  const cases = [
    {
      name: 'HTTP link',
      externalLink: 'http://www.instagram.com/p/insecure/',
      expected: undefined,
    },
    {
      name: 'credentialed HTTPS link',
      externalLink:
        'https://username:password@www.instagram.com/p/credentialed/',
      expected: undefined,
    },
    {
      name: 'public Instagram HTTPS link',
      externalLink: 'https://www.instagram.com/p/public-firstknock/',
      expected: 'https://www.instagram.com/p/public-firstknock/',
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const fx = await fixture({
        job: {
          state: 'scheduled',
          provider_status: 'scheduled',
          provider_post_id: 'buffer_post_1',
          next_retry_at: new Date(Date.now() - 1000).toISOString(),
        },
      });
      const { base44, entities } = createGrowthBase44({
        sources: [source],
        artifacts: [fx.artifact],
        jobs: [fx.job],
      });
      const handler = loadGrowthHandler(workerPath, {
        base44,
        env,
        fetchImpl: async () => Response.json({
          data: {
            post: bufferPost(fx, {
              status: 'scheduled',
              externalLink: item.externalLink,
            }),
          },
        }),
      });

      const result = await invokeJson(handler, {}, { secret: workerSecret });

      assert.equal(result.status, 200);
      assert.equal(entities.GrowthPublishJob.records[0].state, 'scheduled');
      assert.equal(
        entities.GrowthPublishJob.records[0].provider_external_link,
        item.expected,
      );
    });
  }
});

test('a typed Buffer mutation rejection becomes a repairable terminal failure', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
  });
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => Response.json({
      data: {
        createPost: {
          __typename: 'InvalidInputError',
          message: 'The provider rejected the exact publish request.',
        },
      },
    })),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  const saved = entities.GrowthPublishJob.records[0];
  assert.equal(saved.state, 'failed');
  assert.notEqual(saved.state, 'create_reconcile');
  assert.equal(saved.reconciliation_count, 0);
  assert.equal(saved.provider_post_id, undefined);
});

test('a typed terminal rejection can be re-reviewed and retried through the manager', async () => {
  const fx = await fixture({
    artifact: {
      schedule_lock_generation: 0,
      schedule_lock_token: '',
    },
  });
  fx.artifact.campaign = 'provider-retry-test';
  fx.artifact.provider_text = growthHelpers.socialPostText(fx.artifact);
  fx.artifact.approved_hash =
    await growthHelpers.artifactApprovalHash(fx.artifact);
  fx.job.campaign = fx.artifact.campaign;
  fx.job.artifact_hash = fx.artifact.approved_hash;
  fx.job.job_key = await growthHelpers.publishJobKey(fx.job);
  fx.job.request_hash = await growthHelpers.publishJobRequestHash(fx.job);
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
  });
  const workerHandler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => Response.json({
      data: {
        createPost: {
          __typename: 'InvalidInputError',
          message: 'The provider rejected the exact publish request.',
        },
      },
    })),
  });
  let result = await invokeJson(workerHandler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'failed');
  assert.equal(entities.GrowthPublishJob.records[0].attempt_count, 1);

  const manageHandler = loadGrowthHandler(managePath, { base44, env });
  result = await invokeJson(manageHandler, {
    action: 'revoke',
    artifact_id: fx.artifact.id,
    note: 'Repair the provider-rejected request before retrying.',
  });
  assert.equal(result.status, 200);
  result = await invokeJson(manageHandler, {
    action: 'review',
    artifact_id: fx.artifact.id,
    privacy_cleared: true,
    demo_labeled: true,
    claims_supported: true,
    media_rights_confirmed: true,
    note: 'The provider rejection was repaired and the exact rendition rechecked.',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.passed, true);
  result = await invokeJson(manageHandler, {
    action: 'approve',
    artifact_id: fx.artifact.id,
  });
  assert.equal(result.status, 200);

  result = await invokeJson(manageHandler, {
    action: 'schedule',
    artifact_id: fx.artifact.id,
    due_at: fx.dueAt,
    timezone: 'America/Phoenix',
    scheduling_type: 'automatic',
    retry_terminal: true,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.retried, true);
  assert.equal(result.body.job.id, fx.job.id);
  assert.equal(entities.GrowthPublishJob.records.length, 1);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'queued');
  assert.equal(entities.GrowthPublishJob.records[0].attempt_count, 0);
  assert.equal(entities.GrowthPublishJob.records[0].last_error_code, undefined);
});

test('future polls cannot starve a due queued job beyond the first 100 active rows', async () => {
  const fx = await fixture();
  const now = Date.now();
  const futureJobs = Array.from({ length: 100 }, (_, index) => ({
    ...fx.job,
    id: `future_job_${index}`,
    job_key: index.toString(16).padStart(64, '0'),
    state: 'scheduled',
    provider_status: 'scheduled',
    provider_post_id: `future_buffer_post_${index}`,
    next_retry_at: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    created_date: new Date(now - (200 - index) * 60 * 1000).toISOString(),
  }));
  const dueJob = {
    ...fx.job,
    created_date: new Date(now).toISOString(),
  };
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [...futureJobs, dueJob],
  });
  let fetches = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => {
      fetches += 1;
      return Response.json({
        data: {
          createPost: {
            __typename: 'PostActionSuccess',
            post: bufferPost(fx),
          },
        },
      });
    }),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  assert.equal(fetches, 1);
  const saved = entities.GrowthPublishJob.records.find((job) => job.id === dueJob.id);
  assert.equal(saved.state, 'scheduled');
  assert.equal(saved.provider_post_id, 'buffer_post_1');
});

test('an ambiguous create enters reconciliation and adopts the one exact provider post', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
  });
  const operations = [];
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.query.includes('createPost')) {
        operations.push('create');
        throw new Error(`network reset ${apiKey} ${workerSecret}`);
      }
      operations.push('reconcile');
      return Response.json({
        data: {
          posts: {
            edges: [{ node: bufferPost(fx) }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }),
  });
  let result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  let saved = entities.GrowthPublishJob.records[0];
  assert.equal(saved.state, 'create_reconcile');
  assert.equal(JSON.stringify(saved).includes(apiKey), false);
  assert.equal(JSON.stringify(saved).includes(workerSecret), false);

  saved.next_retry_at = new Date(Date.now() - 1000).toISOString();
  result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  saved = entities.GrowthPublishJob.records[0];
  assert.deepEqual(operations, ['create', 'reconcile']);
  assert.equal(saved.state, 'scheduled');
  assert.equal(saved.provider_post_id, 'buffer_post_1');
  assert.equal(saved.reconciliation_count, 1);
});

test('malformed reconciliation candidates are never adopted and never trigger another create', async (t) => {
  const cases = [
    {
      name: 'missing durable post id',
      postOverrides: { id: undefined },
    },
    {
      name: 'unsupported provider status',
      postOverrides: { status: 'deleted' },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const fx = await fixture();
      const { base44, entities } = createGrowthBase44({
        sources: [source],
        artifacts: [fx.artifact],
        jobs: [fx.job],
      });
      const operations = [];
      let createCalls = 0;
      const handler = loadGrowthHandler(workerPath, {
        base44,
        env,
        fetchImpl: withApprovedMedia(async (_url, options) => {
          const query = JSON.parse(options.body).query;
          if (query.includes('createPost')) {
            operations.push('create');
            createCalls += 1;
            throw new Error('ambiguous create response');
          }
          operations.push('reconcile');
          assert.match(query, /posts\(first:50/);
          return Response.json({
            data: {
              posts: {
                edges: [{
                  node: bufferPost(fx, item.postOverrides),
                }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          });
        }),
      });

      let result = await invokeJson(handler, {}, { secret: workerSecret });
      assert.equal(result.status, 200);
      assert.equal(entities.GrowthPublishJob.records[0].state, 'create_reconcile');
      assert.equal(createCalls, 1);

      for (let retry = 1; retry <= 2; retry += 1) {
        entities.GrowthPublishJob.records[0].next_retry_at = new Date(
          Date.now() - 1000,
        ).toISOString();
        result = await invokeJson(handler, {}, { secret: workerSecret });

        assert.equal(result.status, 200);
        const saved = entities.GrowthPublishJob.records[0];
        assert.equal(saved.state, 'create_reconcile');
        assert.equal(saved.provider_post_id, undefined);
        assert.equal(saved.provider_response_hash, undefined);
        assert.equal(saved.last_error_code, 'provider_match_not_visible');
        assert.equal(saved.reconciliation_count, retry);
        assert.equal(createCalls, 1);
      }
      assert.deepEqual(operations, ['create', 'reconcile', 'reconcile']);
    });
  }
});

test('a privacy-read outage during create reconciliation can never reopen createPost', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  const originalSourceFilter = entities.GrowthSourceAsset.filter;
  let sourceReads = 0;
  entities.GrowthSourceAsset.filter = async (...args) => {
    sourceReads += 1;
    if (sourceReads === 3) {
      throw new Error('temporary privacy read outage during reconciliation');
    }
    return originalSourceFilter(...args);
  };
  const operations = [];
  let createCalls = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async (_url, options) => {
      const query = JSON.parse(options.body).query;
      if (query.includes('createPost')) {
        operations.push('create');
        createCalls += 1;
        throw new Error('ambiguous create response');
      }
      operations.push('reconcile');
      assert.match(query, /posts\(first:50/);
      return Response.json({
        data: {
          posts: {
            edges: [{ node: bufferPost(fx) }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }),
  });

  let result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'create_reconcile');
  assert.equal(createCalls, 1);

  entities.GrowthPublishJob.records[0].next_retry_at = new Date(
    Date.now() - 1000,
  ).toISOString();
  result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'create_reconcile');
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'source_privacy_clearance_unavailable',
  );
  assert.deepEqual(operations, ['create']);
  assert.equal(createCalls, 1);

  entities.GrowthPublishJob.records[0].next_retry_at = new Date(
    Date.now() - 1000,
  ).toISOString();
  result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.deepEqual(operations, ['create', 'reconcile']);
  assert.equal(createCalls, 1);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'scheduled');
  assert.equal(
    entities.GrowthPublishJob.records[0].provider_post_id,
    'buffer_post_1',
  );
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'planned');
});

test('untyped Buffer create HTTP failures reconcile before any second create', async (t) => {
  for (const status of [408, 409]) {
    await t.test(`HTTP ${status}`, async () => {
      const fx = await fixture();
      const { base44, entities } = createGrowthBase44({
        sources: [source],
        artifacts: [fx.artifact],
        jobs: [fx.job],
        plans: [measurementPlan(fx)],
      });
      const operations = [];
      let createCalls = 0;
      const handler = loadGrowthHandler(workerPath, {
        base44,
        env,
        fetchImpl: withApprovedMedia(async (_url, options) => {
          const query = JSON.parse(options.body).query;
          if (query.includes('createPost')) {
            operations.push('create');
            createCalls += 1;
            return Response.json(
              { message: 'No typed durable create result was returned.' },
              { status },
            );
          }
          operations.push('reconcile');
          assert.match(query, /posts\(first:50/);
          return Response.json({
            data: {
              posts: {
                edges: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          });
        }),
      });

      let result = await invokeJson(handler, {}, { secret: workerSecret });
      assert.equal(result.status, 200);
      assert.equal(entities.GrowthPublishJob.records[0].state, 'create_reconcile');
      assert.equal(
        entities.GrowthPublishJob.records[0].last_error_code,
        'provider_create_http_unconfirmed',
      );
      assert.equal(
        entities.GrowthPublishJob.records[0].provider_post_id,
        undefined,
      );
      assert.equal(
        entities.GrowthContentPlan.records[0].delivery_status,
        'planned',
      );

      entities.GrowthPublishJob.records[0].next_retry_at = new Date(
        Date.now() - 1000,
      ).toISOString();
      result = await invokeJson(handler, {}, { secret: workerSecret });

      assert.equal(result.status, 200);
      assert.deepEqual(operations, ['create', 'reconcile']);
      assert.equal(createCalls, 1);
      assert.equal(entities.GrowthPublishJob.records[0].state, 'create_reconcile');
      assert.equal(
        entities.GrowthPublishJob.records[0].provider_post_id,
        undefined,
      );
      assert.equal(entities.GrowthPublishJob.records[0].reconciliation_count, 1);
      assert.equal(
        entities.GrowthContentPlan.records[0].delivery_status,
        'planned',
      );
    });
  }
});

test('duplicate reconciliation matches fail closed for manual review', async () => {
  const fx = await fixture({
    job: {
      state: 'create_reconcile',
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
  });
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => Response.json({
      data: {
        posts: {
          edges: [
            { node: bufferPost(fx, { id: 'buffer_a' }) },
            { node: bufferPost(fx, { id: 'buffer_b' }) },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    })),
  });
  const result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'review_required');
  assert.equal(entities.GrowthPublishJob.records[0].last_error_code, 'provider_duplicate_match');
});

test('cancel_job loses its stale CAS safely after a worker claim', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
  });
  const staleReadCaptured = deferred();
  const releaseStaleRead = deferred();
  const providerCallStarted = deferred();
  const releaseProviderCall = deferred();
  const originalGet = entities.GrowthPublishJob.get;
  let firstJobRead = true;
  entities.GrowthPublishJob.get = async (id) => {
    const snapshot = await originalGet(id);
    if (firstJobRead) {
      firstJobRead = false;
      staleReadCaptured.resolve();
      await releaseStaleRead.promise;
    }
    return snapshot;
  };

  const manageHandler = loadGrowthHandler(managePath, { base44, env });
  const workerHandler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => {
      providerCallStarted.resolve();
      await releaseProviderCall.promise;
      return Response.json({
        data: {
          createPost: {
            __typename: 'PostActionSuccess',
            post: bufferPost(fx),
          },
        },
      });
    }),
  });

  const cancelPromise = invokeJson(manageHandler, {
    action: 'cancel_job',
    job_id: fx.job.id,
  });
  await staleReadCaptured.promise;

  const workerPromise = invokeJson(
    workerHandler,
    {},
    { secret: workerSecret },
  );
  await providerCallStarted.promise;

  releaseStaleRead.resolve();
  const cancelResult = await cancelPromise;
  releaseProviderCall.resolve();
  const workerResult = await workerPromise;

  assert.equal(cancelResult.status, 409);
  assert.equal(workerResult.status, 200);
  const saved = entities.GrowthPublishJob.records[0];
  assert.equal(saved.state, 'scheduled');
  assert.equal(saved.provider_post_id, 'buffer_post_1');
});

test('create adopts partial GraphQL success even when top-level errors are present', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
  });
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => Response.json({
      data: {
        createPost: {
          __typename: 'PostActionSuccess',
          post: bufferPost(fx),
        },
      },
      errors: [{
        message: 'A nullable response field could not be resolved.',
        extensions: { code: 'UNEXPECTED' },
      }],
    })),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  const saved = entities.GrowthPublishJob.records[0];
  assert.equal(saved.state, 'scheduled');
  assert.equal(saved.provider_post_id, 'buffer_post_1');
});

test('create top-level errors without a post ID enter reconciliation', async () => {
  const fx = await fixture();
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
  });
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: withApprovedMedia(async () => Response.json({
      data: { createPost: null },
      errors: [{
        message: 'The create result could not be confirmed.',
        extensions: { code: 'FORBIDDEN' },
      }],
    })),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  const saved = entities.GrowthPublishJob.records[0];
  assert.equal(saved.state, 'create_reconcile');
  assert.equal(saved.provider_post_id, undefined);
});

test('a known Buffer post returning NOT_FOUND requires review', async () => {
  const fx = await fixture({
    job: {
      state: 'scheduled',
      provider_post_id: 'buffer_post_missing',
      provider_status: 'scheduled',
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
  });
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => Response.json({
      data: { post: null },
      errors: [{
        message: 'Post not found.',
        extensions: { code: 'NOT_FOUND' },
      }],
    }),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'review_required');
});

test('a sent Instagram post starts the matching measurement-plan clock', async () => {
  const sentAt = new Date(Date.now() - 1000).toISOString();
  const fx = await fixture({
    job: {
      state: 'scheduled',
      provider_post_id: 'buffer_post_1',
      provider_status: 'scheduled',
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  const plan = {
    id: 'growth_plan_1',
    campaign: fx.artifact.campaign,
    content: fx.artifact.platform_content_id,
    planned_publish_at: fx.dueAt,
  };
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [plan],
  });
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => Response.json({
      data: {
        post: bufferPost(fx, {
          status: 'sent',
          sentAt,
          externalLink: 'https://www.instagram.com/p/firstknock/',
        }),
      },
    }),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'sent');
  assert.equal(entities.GrowthPublishJob.records[0].provider_sent_at, sentAt);
  assert.equal(entities.GrowthContentPlan.records[0].published_at, sentAt);
});

test('a sent TikTok post starts only its matching platform measurement clock', async () => {
  const sentAt = new Date(Date.now() - 1000).toISOString();
  const fx = await tiktokFixture({
    job: {
      state: 'scheduled',
      provider_post_id: 'buffer_post_tiktok',
      provider_status: 'scheduled',
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  const instagramPlan = measurementPlan(fx, {
    id: 'growth_plan_instagram_collision',
    platform: 'instagram',
  });
  const tiktokPlan = measurementPlan(fx, {
    id: 'growth_plan_tiktok_collision',
    platform: 'tiktok',
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [instagramPlan, tiktokPlan],
  });
  const planQueries = [];
  const originalPlanFilter = entities.GrowthContentPlan.filter;
  entities.GrowthContentPlan.filter = async (query, ...args) => {
    planQueries.push(structuredClone(query));
    return originalPlanFilter(query, ...args);
  };
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => Response.json({
      data: {
        post: bufferPost(fx, {
          id: 'buffer_post_tiktok',
          status: 'sent',
          sentAt,
          externalLink: 'https://www.tiktok.com/@firstknock/video/123456789',
        }),
      },
    }),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'sent');
  assert.ok(planQueries.some((query) => query.platform === 'tiktok'));
  const savedInstagram = entities.GrowthContentPlan.records.find(
    (plan) => plan.platform === 'instagram',
  );
  const savedTikTok = entities.GrowthContentPlan.records.find(
    (plan) => plan.platform === 'tiktok',
  );
  assert.equal(savedInstagram.published_at, undefined);
  assert.equal(savedInstagram.delivery_status, 'planned');
  assert.equal(savedTikTok.published_at, sentAt);
  assert.equal(savedTikTok.delivery_managed_by, 'buffer');
  assert.equal(savedTikTok.delivery_status, 'published');
});

test('fallback publication clock survives a lost job fence and the next sent poll', async () => {
  const fx = await fixture({
    job: {
      state: 'scheduled',
      provider_post_id: 'buffer_post_without_sent_at',
      provider_status: 'scheduled',
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  const originalJobUpdateMany = entities.GrowthPublishJob.updateMany;
  let loseSentFenceOnce = true;
  entities.GrowthPublishJob.updateMany = async (query, operations) => {
    if (
      loseSentFenceOnce
      && query?.state === 'processing'
      && operations?.$set?.state === 'sent'
    ) {
      loseSentFenceOnce = false;
      Object.assign(entities.GrowthPublishJob.records[0], {
        state: 'scheduled',
        lease_token: '',
        lease_expires_at: new Date().toISOString(),
        next_retry_at: new Date(Date.now() - 1000).toISOString(),
        updated_date: new Date().toISOString(),
      });
    }
    return originalJobUpdateMany(query, operations);
  };
  let providerPolls = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      providerPolls += 1;
      return Response.json({
        data: {
          post: bufferPost(fx, {
            id: fx.job.provider_post_id,
            status: 'sent',
            sentAt: null,
            externalLink: 'https://www.instagram.com/p/fallback-clock/',
          }),
        },
      });
    },
  });

  let result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(result.body.states.lease_lost, 1);
  assert.equal(loseSentFenceOnce, false);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'scheduled');
  const firstPublishedAt =
    entities.GrowthContentPlan.records[0].published_at;
  assert.ok(Number.isFinite(new Date(firstPublishedAt).getTime()));
  assert.equal(
    entities.GrowthContentPlan.records[0].delivery_managed_by,
    'buffer',
  );
  assert.equal(
    entities.GrowthContentPlan.records[0].delivery_status,
    'published',
  );
  assert.equal(entities.GrowthContentPlan.counters.updateMany, 1);

  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(providerPolls, 2);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'sent');
  assert.equal(
    entities.GrowthPublishJob.records[0].provider_post_id,
    fx.job.provider_post_id,
  );
  assert.equal(
    entities.GrowthPublishJob.records[0].provider_sent_at,
    undefined,
  );
  assert.equal(
    entities.GrowthContentPlan.records[0].published_at,
    firstPublishedAt,
  );
  assert.equal(entities.GrowthContentPlan.counters.updateMany, 1);
});

test('provider sentAt corrects a stale published clock and is idempotent once matched', async (t) => {
  const sentAt = new Date(Date.now() - 60_000).toISOString();
  const cases = [
    {
      name: 'stale clock is corrected',
      publishedAt: new Date(
        new Date(sentAt).getTime() - 24 * 60 * 60 * 1000,
      ).toISOString(),
      expectedWrites: 1,
    },
    {
      name: 'matching clock is idempotent',
      publishedAt: sentAt,
      expectedWrites: 0,
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const fx = await fixture({
        job: {
          state: 'scheduled',
          provider_post_id: 'buffer_post_1',
          provider_status: 'scheduled',
          next_retry_at: new Date(Date.now() - 1000).toISOString(),
        },
      });
      const plan = measurementPlan(fx, {
        published_at: item.publishedAt,
        delivery_managed_by: 'buffer',
        delivery_status: 'published',
      });
      const { base44, entities } = createGrowthBase44({
        sources: [source],
        artifacts: [fx.artifact],
        jobs: [fx.job],
        plans: [plan],
      });
      const handler = loadGrowthHandler(workerPath, {
        base44,
        env,
        fetchImpl: async () => Response.json({
          data: {
            post: bufferPost(fx, {
              status: 'sent',
              sentAt,
              externalLink: 'https://www.instagram.com/p/authoritative-clock/',
            }),
          },
        }),
      });

      const result = await invokeJson(handler, {}, { secret: workerSecret });

      assert.equal(result.status, 200);
      assert.equal(entities.GrowthPublishJob.records[0].state, 'sent');
      assert.equal(entities.GrowthPublishJob.records[0].provider_sent_at, sentAt);
      assert.equal(entities.GrowthContentPlan.records[0].published_at, sentAt);
      assert.equal(
        entities.GrowthContentPlan.records[0].delivery_managed_by,
        'buffer',
      );
      assert.equal(
        entities.GrowthContentPlan.records[0].delivery_status,
        'published',
      );
      assert.equal(
        entities.GrowthContentPlan.counters.updateMany,
        item.expectedWrites,
      );
    });
  }
});

test('measurement sync failure retries the plan clock locally without another provider request', async () => {
  const sentAt = new Date(Date.now() - 1000).toISOString();
  const fx = await fixture({
    job: {
      state: 'scheduled',
      provider_post_id: 'buffer_post_1',
      provider_status: 'scheduled',
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  const plan = {
    id: 'growth_plan_retry',
    campaign: fx.artifact.campaign,
    content: fx.artifact.platform_content_id,
    planned_publish_at: fx.dueAt,
    delivery_managed_by: 'buffer',
    delivery_status: 'planned',
  };
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [plan],
  });
  const originalPlanUpdateMany = entities.GrowthContentPlan.updateMany;
  let failMeasurementOnce = true;
  entities.GrowthContentPlan.updateMany = async (...args) => {
    if (failMeasurementOnce) {
      failMeasurementOnce = false;
      return { success: true, updated: 0, has_more: false };
    }
    return originalPlanUpdateMany(...args);
  };
  const operations = [];
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      operations.push(body.query.includes('createPost') ? 'create' : 'poll');
      return Response.json({
        data: {
          post: bufferPost(fx, {
            status: 'sent',
            sentAt,
            externalLink: 'https://www.instagram.com/p/firstknock-retry/',
          }),
        },
      });
    },
  });

  let result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'measurement_retry');
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'content_plan_changed_before_publish',
  );
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_message,
    'Buffer published the post, but its platform measurement clock could not be started.',
  );
  assert.equal(entities.GrowthContentPlan.records[0].published_at, undefined);

  entities.GrowthPublishJob.records[0].next_retry_at = new Date(
    Date.now() - 1000,
  ).toISOString();
  result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.deepEqual(operations, ['poll']);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'sent');
  assert.equal(entities.GrowthPublishJob.records[0].provider_sent_at, sentAt);
  assert.equal(entities.GrowthContentPlan.records[0].published_at, sentAt);
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'published');
});

test('measurement_retry repairs locally without depending on Buffer availability', async () => {
  const sentAt = new Date(Date.now() - 60_000).toISOString();
  const fx = await fixture({
    job: {
      state: 'measurement_retry',
      provider_post_id: 'buffer_post_measurement_retry',
      provider_status: 'sent',
      provider_sent_at: sentAt,
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  let reads = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async (_url, options) => {
      const query = JSON.parse(options.body).query;
      assert.doesNotMatch(query, /createPost/);
      reads += 1;
      return Response.json(
        { errors: [{ message: 'Buffer is temporarily unavailable.' }] },
        { status: 503 },
      );
    },
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(reads, 0);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'sent');
  assert.equal(
    entities.GrowthPublishJob.records[0].provider_post_id,
    'buffer_post_measurement_retry',
  );
  assert.equal(
    entities.GrowthContentPlan.records[0].published_at,
    sentAt,
  );
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'published');
});

test('measurement_retry repairs from durable sent evidence despite source and config drift', async (t) => {
  const sentAt = new Date(Date.now() - 60_000).toISOString();
  const oldChannelId = 'channel_instagram_previous';
  const oldConfigRevision = await growthHelpers.sha256Hex([
    'buffer',
    env.BUFFER_ORGANIZATION_ID,
    oldChannelId,
    'instagram',
    env.GROWTH_MEDIA_ORIGIN,
    env.GROWTH_MEDIA_PATH_PREFIX,
  ].join('|'));
  const cases = [
    {
      name: 'blocked source',
      changedSource: { ...source, privacy_status: 'blocked', active: true },
    },
    {
      name: 'inactive source',
      changedSource: { ...source, privacy_status: 'safe', active: false },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const fx = await fixture({
        job: {
          state: 'measurement_retry',
          provider_channel_id: oldChannelId,
          config_revision: oldConfigRevision,
          provider_post_id: 'buffer_post_durably_sent',
          provider_status: 'sent',
          provider_sent_at: sentAt,
          provider_external_link:
            'https://www.instagram.com/p/durable-measurement-evidence/',
          provider_response_hash: 'd'.repeat(64),
          next_retry_at: new Date(Date.now() - 1000).toISOString(),
        },
      });
      fx.job.request_hash = await growthHelpers.publishJobRequestHash(fx.job);
      fx.job.job_key = await growthHelpers.publishJobKey(fx.job);
      const { base44, entities } = createGrowthBase44({
        sources: [item.changedSource],
        artifacts: [fx.artifact],
        jobs: [fx.job],
        plans: [measurementPlan(fx)],
      });
      let providerFetches = 0;
      const handler = loadGrowthHandler(workerPath, {
        base44,
        env,
        fetchImpl: async () => {
          providerFetches += 1;
          throw new Error('durable measurement repair must remain local');
        },
      });

      const result = await invokeJson(handler, {}, { secret: workerSecret });

      assert.equal(result.status, 200);
      assert.equal(providerFetches, 0);
      assert.equal(entities.GrowthSourceAsset.counters.filter, 0);
      assert.equal(entities.GrowthPublishJob.records[0].state, 'sent');
      assert.equal(
        entities.GrowthPublishJob.records[0].provider_post_id,
        'buffer_post_durably_sent',
      );
      assert.equal(
        entities.GrowthContentPlan.records[0].published_at,
        sentAt,
      );
      assert.equal(
        entities.GrowthContentPlan.records[0].delivery_status,
        'published',
      );
    });
  }
});

test('an expired measurement-retry lease recovers to local measurement repair', async () => {
  const sentAt = new Date(Date.now() - 60_000).toISOString();
  const fx = await fixture({
    job: {
      state: 'processing',
      provider_post_id: 'buffer_post_expired_measurement',
      provider_status: 'sent',
      provider_sent_at: sentAt,
      provider_response_hash: 'e'.repeat(64),
      attempt_count: 2,
      reconciliation_count: 0,
      lease_token: 'expired-measurement-lease',
      lease_source_state: 'measurement_retry',
      lease_generation: 5,
      lease_acquired_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      lease_expires_at: new Date(Date.now() - 1000).toISOString(),
      last_error_code: 'content_plan_changed_before_publish',
      last_error_message:
        'Buffer published the post, but its measurement clock needs repair.',
    },
  });
  const { base44, entities } = createGrowthBase44({
    sources: [source],
    artifacts: [fx.artifact],
    jobs: [fx.job],
    plans: [measurementPlan(fx)],
  });
  let providerFetches = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      providerFetches += 1;
      throw new Error('expired measurement recovery must not query Buffer');
    },
  });

  let result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'measurement_retry');
  assert.notEqual(entities.GrowthPublishJob.records[0].state, 'create_reconcile');
  assert.equal(
    entities.GrowthPublishJob.records[0].lease_source_state,
    undefined,
  );
  assert.equal(entities.GrowthPublishJob.records[0].reconciliation_count, 0);
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'planned');
  assert.equal(providerFetches, 0);

  result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'sent');
  assert.equal(entities.GrowthContentPlan.records[0].published_at, sentAt);
  assert.equal(entities.GrowthContentPlan.records[0].delivery_status, 'published');
  assert.equal(providerFetches, 0);
});

test('fresh Buffer count metrics preserve plan dimensions and ignore generic clicks', async () => {
  const fx = await sentMetricsFixture();
  fx.plan.format = 'carousel';
  fx.plan.cta_label = 'SEE THE FEATURE';
  const metricsUpdatedAt = new Date().toISOString();
  const { base44, entities } = createGrowthBase44({
    jobs: [fx.job],
    plans: [fx.plan],
  });
  let queries = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: bufferMetricsFetch(
      fx,
      {
        metricsUpdatedAt,
        metrics: [
          { type: 'reach', name: 'Reach', value: 123, unit: 'count' },
          { type: 'views', name: 'Views', value: 456, unit: 'count' },
          { type: 'shares', name: 'Shares', value: 7, unit: 'count' },
          { type: 'saves', name: 'Saves', value: 8, unit: 'count' },
          { type: 'comments', name: 'Comments', value: 9, unit: 'count' },
          { type: 'follows', name: 'Follows', value: 10, unit: 'count' },
          { type: 'clicks', name: 'Clicks', value: 11, unit: 'count' },
          { type: 'impressions', name: 'Impressions', value: 999, unit: 'count' },
          { type: 'engagementRate', name: 'Engagement', value: 42, unit: 'percentage' },
        ],
      },
      () => { queries += 1; },
    ),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(result.body.states.sent, 1);
  assert.equal(queries, 1);
  assert.equal(entities.GrowthSourceAsset.counters.filter, 0);
  assert.equal(entities.GrowthCreativeArtifact.counters.get, 0);
  assert.equal(entities.GrowthContentMetric.records.length, 1);
  const metric = entities.GrowthContentMetric.records[0];
  assert.equal(metric.platform, 'instagram');
  assert.equal(metric.campaign, fx.job.campaign);
  assert.equal(metric.content, fx.job.platform_content_id);
  assert.equal(metric.snapshot_days, 1);
  assert.ok(
    new Date(metric.snapshot_captured_at).getTime()
      >= new Date(fx.publishedAt).getTime() + dayMs,
  );
  assert.equal(metric.reach, 123);
  assert.equal(metric.views, 456);
  assert.equal(metric.shares, 7);
  assert.equal(metric.saves, 8);
  assert.equal(metric.comments, 9);
  assert.equal(metric.follows, 10);
  assert.equal(metric.link_clicks, undefined);
  assert.equal(metric.profile_visits, undefined);
  assert.equal(metric.dm_intents, undefined);
  assert.deepEqual(
    metric.provider_observed_metric_types,
    ['comments', 'follows', 'reach', 'saves', 'shares', 'views'],
  );
  assert.equal(metric.format, 'carousel');
  assert.equal(metric.cta_variant, 'SEE THE FEATURE');
  assert.equal(metric.metric_source, 'buffer');
  assert.equal(metric.provider_post_id, fx.job.provider_post_id);
  assert.equal(metric.provider_channel_id, fx.job.provider_channel_id);
  assert.equal(metric.provider_metrics_updated_at, metricsUpdatedAt);
  assert.match(metric.provider_metrics_hash, /^[a-f0-9]{64}$/);
  assert.equal(
    metric.snapshot_fingerprint,
    createHash('sha256').update(metricFingerprintPayload(metric)).digest('hex'),
  );
  const savedJob = entities.GrowthPublishJob.records[0];
  assert.equal(savedJob.state, 'sent');
  assert.equal(savedJob.attempt_count, 0);
  assert.equal(savedJob.metrics_sync_attempt_count, 1);
  assert.equal(savedJob.metrics_checkpoints.length, 1);
  assert.equal(savedJob.metrics_checkpoints[0].status, 'captured');
  assert.equal(savedJob.metrics_checkpoints[0].snapshot_days, 1);
  assert.equal(
    savedJob.provider_metrics_hash,
    metric.provider_metrics_hash,
  );
  assert.equal(
    savedJob.metrics_next_checkpoint_at,
    new Date(new Date(fx.publishedAt).getTime() + 3 * dayMs).toISOString(),
  );

  const jobSchema = JSON.parse(
    readFileSync('base44/entities/GrowthPublishJob.jsonc', 'utf8'),
  );
  const metricSchema = JSON.parse(
    readFileSync('base44/entities/GrowthContentMetric.jsonc', 'utf8'),
  );
  assert.ok(jobSchema.properties.lease_source_state.enum.includes('sent'));
  assert.deepEqual(
    jobSchema.properties.metrics_checkpoints.items.properties.status.enum,
    ['captured', 'review_needed'],
  );
  assert.equal(
    metricSchema.properties.metric_source.enum.includes('buffer'),
    true,
  );
});

test('stale Buffer refresh evidence retries inside the D1 window and later captures once fresh', async () => {
  const fx = await sentMetricsFixture();
  const dueAt = new Date(new Date(fx.publishedAt).getTime() + dayMs).toISOString();
  const staleUpdatedAt = new Date(new Date(dueAt).getTime() - 1000).toISOString();
  const freshUpdatedAt = new Date().toISOString();
  const { base44, entities } = createGrowthBase44({
    jobs: [fx.job],
    plans: [fx.plan],
  });
  let reads = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async (...args) => {
      reads += 1;
      return bufferMetricsFetch(fx, {
        metricsUpdatedAt: reads === 1 ? staleUpdatedAt : freshUpdatedAt,
      })(...args);
    },
  });

  let result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(entities.GrowthContentMetric.records.length, 0);
  let savedJob = entities.GrowthPublishJob.records[0];
  assert.equal(savedJob.state, 'sent');
  assert.equal(savedJob.metrics_checkpoints.length, 0);
  assert.equal(savedJob.last_error_code, 'buffer_metrics_refresh_stale');
  assert.equal(savedJob.provider_metrics_updated_at, staleUpdatedAt);
  assert.match(savedJob.provider_metrics_hash, /^[a-f0-9]{64}$/);
  assert.ok(new Date(savedJob.metrics_next_checkpoint_at).getTime() > Date.now());

  savedJob.metrics_next_checkpoint_at = new Date(Date.now() - 1000).toISOString();
  result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(reads, 2);
  assert.equal(entities.GrowthContentMetric.records.length, 1);
  savedJob = entities.GrowthPublishJob.records[0];
  assert.equal(savedJob.metrics_checkpoints[0].status, 'captured');
  assert.equal(savedJob.provider_metrics_updated_at, freshUpdatedAt);
});

test('an exact provider checkpoint is adopted before any advanced Buffer read', async () => {
  const fx = await sentMetricsFixture();
  const existingMetric = await exactStoredMetric(fx);
  const { base44, entities } = createGrowthBase44({
    jobs: [fx.job],
    plans: [fx.plan],
    metrics: [existingMetric],
  });
  let reads = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      reads += 1;
      throw new Error('an exact local checkpoint must win before Buffer');
    },
  });

  let result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  assert.equal(entities.GrowthContentMetric.records.length, 1);
  assert.equal(entities.GrowthContentMetric.counters.create, 0);
  assert.equal(entities.GrowthContentMetric.counters.update, 0);
  assert.equal(entities.GrowthPublishJob.records[0].metrics_checkpoints[0].metric_id,
    'metric_from_lost_fence');

  Object.assign(entities.GrowthPublishJob.records[0], {
    metrics_checkpoints: [],
    metrics_next_checkpoint_at: new Date(Date.now() - 1000).toISOString(),
  });
  result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(reads, 0);
  assert.equal(entities.GrowthContentMetric.records.length, 1);
  assert.equal(entities.GrowthContentMetric.counters.create, 0);
  assert.equal(entities.GrowthPublishJob.records[0].metrics_checkpoints.length, 1);
});

test('an orphaned in-window checkpoint is recovered after its final-read tolerance', async () => {
  const publishedAt = '2026-03-01T00:00:00.000Z';
  const invokedAt = '2026-03-03T00:11:00.000Z';
  const fx = await sentMetricsFixture({ publishedAt });
  const existingMetric = await exactStoredMetric(fx, {
    capturedAt: '2026-03-02T12:00:00.000Z',
  });
  const { base44, entities } = createGrowthBase44({
    jobs: [fx.job],
    plans: [fx.plan],
    metrics: [existingMetric],
  });
  let providerReads = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    dateImpl: fixedDateAt(invokedAt),
    fetchImpl: async () => {
      providerReads += 1;
      throw new Error('an overdue orphan must reconcile before Buffer');
    },
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(providerReads, 0);
  assert.equal(entities.GrowthContentMetric.counters.create, 0);
  const savedJob = entities.GrowthPublishJob.records[0];
  assert.equal(savedJob.metrics_checkpoints.length, 1);
  assert.equal(savedJob.metrics_checkpoints[0].status, 'captured');
  assert.equal(savedJob.metrics_checkpoints[0].metric_id, existingMetric.id);
  assert.equal(
    savedJob.metrics_checkpoints[0].snapshot_captured_at,
    existingMetric.snapshot_captured_at,
  );
  assert.equal(savedJob.last_error_code, '');
  assert.equal(
    savedJob.metrics_next_checkpoint_at,
    '2026-03-04T00:00:00.000Z',
  );
});

test('a future-dated orphan row cannot be adopted early', async () => {
  const publishedAt = '2026-03-01T00:00:00.000Z';
  const invokedAt = '2026-03-02T00:01:00.000Z';
  const fx = await sentMetricsFixture({ publishedAt });
  const futureMetric = await exactStoredMetric(fx, {
    capturedAt: '2026-03-02T00:07:00.000Z',
  });
  const { base44, entities } = createGrowthBase44({
    jobs: [fx.job],
    plans: [fx.plan],
    metrics: [futureMetric],
  });
  let providerReads = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    dateImpl: fixedDateAt(invokedAt),
    fetchImpl: async () => {
      providerReads += 1;
      throw new Error('future local evidence must fail before Buffer');
    },
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(providerReads, 0);
  const checkpoint = entities.GrowthPublishJob.records[0].metrics_checkpoints[0];
  assert.equal(checkpoint.status, 'review_needed');
  assert.equal(checkpoint.error_code, 'content_snapshot_conflict');
});

test('orphan checkpoint recovery rejects every non-exact candidate without Buffer', async (t) => {
  const publishedAt = '2026-03-01T00:00:00.000Z';
  const invokedAt = '2026-03-03T00:11:00.000Z';
  const cases = [
    {
      name: 'manual row',
      mutate: async (metric, fx) => {
        delete metric.metric_source;
        metric.observed_metric_fields = [...metric.provider_observed_metric_types];
        await resealStoredMetric(fx, metric);
      },
    },
    {
      name: 'duplicate automated rows',
      rows: async (metric) => [
        metric,
        { ...structuredClone(metric), id: 'duplicate_metric' },
      ],
    },
    {
      name: 'plan format mismatch',
      mutate: async (metric) => {
        metric.format = 'carousel';
      },
    },
    {
      name: 'plan CTA mismatch',
      mutate: async (metric) => {
        metric.cta_variant = 'A different CTA';
      },
    },
    {
      name: 'hook mismatch',
      mutate: async (metric) => {
        metric.hook = 'A different hook';
      },
    },
    {
      name: 'artifact attribution mismatch',
      mutate: async (metric) => {
        metric.artifact_key = 'different-artifact';
      },
    },
    {
      name: 'concept attribution mismatch',
      mutate: async (metric) => {
        metric.concept_id = 'different-concept';
      },
    },
    {
      name: 'unexpected batch attribution',
      mutate: async (metric) => {
        metric.growth_batch_key = 'd'.repeat(64);
      },
    },
    {
      name: 'provider post mismatch',
      mutate: async (metric) => {
        metric.provider_post_id = 'different-provider-post';
      },
    },
    {
      name: 'provider channel mismatch',
      mutate: async (metric) => {
        metric.provider_channel_id = 'different-provider-channel';
      },
    },
    {
      name: 'immutable job request mismatch',
      mutate: async (_metric, fx) => {
        fx.job.provider_organization_id = 'different-provider-org';
      },
    },
    {
      name: 'publication clock mismatch',
      mutate: async (metric, fx) => {
        metric.published_at = '2026-03-01T00:00:01.000Z';
        await resealStoredMetric(fx, metric);
      },
    },
    {
      name: 'capture before due',
      mutate: async (metric, fx) => {
        metric.snapshot_captured_at = '2026-03-01T23:59:59.000Z';
        metric.provider_metrics_updated_at = metric.snapshot_captured_at;
        await resealStoredMetric(fx, metric);
      },
    },
    {
      name: 'capture after close',
      mutate: async (metric, fx) => {
        metric.snapshot_captured_at = '2026-03-03T00:00:01.000Z';
        metric.provider_metrics_updated_at = metric.snapshot_captured_at;
        await resealStoredMetric(fx, metric);
      },
    },
    {
      name: 'observed field missing',
      mutate: async (metric, fx) => {
        delete metric.reach;
        await resealStoredMetric(fx, metric);
      },
    },
    {
      name: 'unobserved generic field present',
      mutate: async (metric, fx) => {
        metric.profile_visits = 0;
        await resealStoredMetric(fx, metric);
      },
    },
    {
      name: 'observed types are not canonical',
      mutate: async (metric, fx) => {
        metric.provider_observed_metric_types.reverse();
        await resealStoredMetric(fx, metric);
      },
    },
    {
      name: 'invalid observed value',
      mutate: async (metric, fx) => {
        metric.views = -1;
        await resealStoredMetric(fx, metric);
      },
    },
    {
      name: 'provider evidence hash mismatch',
      mutate: async (metric) => {
        metric.provider_metrics_hash = 'f'.repeat(64);
      },
    },
    {
      name: 'snapshot fingerprint mismatch',
      mutate: async (metric) => {
        metric.snapshot_fingerprint = 'f'.repeat(64);
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const fx = await sentMetricsFixture({ publishedAt });
      const metric = await exactStoredMetric(fx, {
        capturedAt: '2026-03-02T00:01:00.000Z',
      });
      await item.mutate?.(metric, fx);
      const metrics = item.rows ? await item.rows(metric, fx) : [metric];
      const { base44, entities } = createGrowthBase44({
        jobs: [fx.job],
        plans: [fx.plan],
        metrics,
      });
      let providerReads = 0;
      const handler = loadGrowthHandler(workerPath, {
        base44,
        env,
        dateImpl: fixedDateAt(invokedAt),
        fetchImpl: async () => {
          providerReads += 1;
          throw new Error('a conflicting orphan must fail before Buffer');
        },
      });

      const result = await invokeJson(handler, {}, { secret: workerSecret });

      assert.equal(result.status, 200);
      assert.equal(providerReads, 0);
      assert.equal(entities.GrowthContentMetric.counters.create, 0);
      assert.equal(entities.GrowthContentMetric.records.length, metrics.length);
      const savedJob = entities.GrowthPublishJob.records[0];
      assert.equal(savedJob.metrics_checkpoints.length, 1);
      assert.equal(savedJob.metrics_checkpoints[0].status, 'review_needed');
      assert.equal(
        savedJob.metrics_checkpoints[0].error_code,
        'content_snapshot_conflict',
      );
      assert.equal(savedJob.last_error_code, 'content_snapshot_conflict');
    });
  }
});

test('create-race adoption uses the same exact plan-dimension contract', async (t) => {
  const cases = [
    { name: 'exact row', expectedStatus: 'captured' },
    {
      name: 'format mismatch',
      expectedStatus: 'review_needed',
      mutate: (metric) => { metric.format = 'carousel'; },
    },
    {
      name: 'CTA mismatch',
      expectedStatus: 'review_needed',
      mutate: (metric) => { metric.cta_variant = 'A different CTA'; },
    },
    {
      name: 'hook mismatch',
      expectedStatus: 'review_needed',
      mutate: (metric) => { metric.hook = 'A different hook'; },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const fx = await sentMetricsFixture();
      const metricsUpdatedAt = new Date().toISOString();
      const racedMetric = await exactStoredMetric(fx, {
        id: 'metric_from_create_race',
        capturedAt: metricsUpdatedAt,
      });
      item.mutate?.(racedMetric);
      const { base44, entities } = createGrowthBase44({
        jobs: [fx.job],
        plans: [fx.plan],
      });
      entities.GrowthContentMetric.create = async () => {
        entities.GrowthContentMetric.counters.create += 1;
        entities.GrowthContentMetric.records.push(structuredClone(racedMetric));
        throw new Error('simulated unique checkpoint race');
      };
      let providerReads = 0;
      const handler = loadGrowthHandler(workerPath, {
        base44,
        env,
        fetchImpl: bufferMetricsFetch(
          fx,
          { metricsUpdatedAt },
          () => { providerReads += 1; },
        ),
      });

      const result = await invokeJson(handler, {}, { secret: workerSecret });

      assert.equal(result.status, 200);
      assert.equal(providerReads, 1);
      assert.equal(entities.GrowthContentMetric.counters.create, 1);
      assert.equal(entities.GrowthContentMetric.records.length, 1);
      const checkpoint = entities.GrowthPublishJob.records[0].metrics_checkpoints[0];
      assert.equal(checkpoint.status, item.expectedStatus);
      if (item.expectedStatus === 'captured') {
        assert.equal(checkpoint.metric_id, racedMetric.id);
      } else {
        assert.equal(checkpoint.error_code, 'content_snapshot_conflict');
      }
    });
  }
});

test('D1, D3, D7, and D30 advance cumulatively and terminal D30 stops all scans', async () => {
  const publishedAt = '2026-01-01T00:00:00.000Z';
  const fx = await sentMetricsFixture({ publishedAt });
  const { base44, entities } = createGrowthBase44({
    jobs: [fx.job],
    plans: [fx.plan],
  });
  let reads = 0;

  for (const days of [1, 3, 7, 30]) {
    const nowAt = new Date(
      new Date(publishedAt).getTime() + days * dayMs + 60 * 60 * 1000,
    ).toISOString();
    const handler = loadGrowthHandler(workerPath, {
      base44,
      env,
      dateImpl: fixedDateAt(nowAt),
      fetchImpl: bufferMetricsFetch(
        fx,
        { metricsUpdatedAt: nowAt },
        () => { reads += 1; },
      ),
    });
    const result = await invokeJson(handler, {}, { secret: workerSecret });
    assert.equal(result.status, 200);
    assert.equal(result.body.states.sent, 1);
    assert.deepEqual(
      entities.GrowthPublishJob.records[0].metrics_checkpoints.map(
        (checkpoint) => checkpoint.snapshot_days,
      ),
      [1, 3, 7, 30].filter((value) => value <= days),
    );
  }

  const savedJob = entities.GrowthPublishJob.records[0];
  assert.equal(savedJob.state, 'sent');
  assert.ok(savedJob.metrics_sync_completed_at);
  assert.equal(savedJob.metrics_checkpoints.length, 4);
  assert.ok(savedJob.metrics_checkpoints.every(
    (checkpoint) => checkpoint.status === 'captured',
  ));
  assert.equal(entities.GrowthContentMetric.records.length, 4);
  assert.equal(reads, 4);

  const terminalHandler = loadGrowthHandler(workerPath, {
    base44,
    env,
    dateImpl: fixedDateAt('2026-02-02T00:00:00.000Z'),
    fetchImpl: async () => {
      throw new Error('terminal D30 must not query Buffer');
    },
  });
  const terminalResult = await invokeJson(
    terminalHandler,
    {},
    { secret: workerSecret },
  );
  assert.equal(terminalResult.status, 200);
  assert.equal(terminalResult.body.inspected, 0);
  assert.equal(terminalResult.body.processed, 0);
  assert.equal(reads, 4);
});

test('all missed fixed-age windows become durable review-needed checkpoints without fabricated metrics', async () => {
  const publishedAt = new Date(Date.now() - 32 * dayMs).toISOString();
  const fx = await sentMetricsFixture({ publishedAt });
  const { base44, entities } = createGrowthBase44({
    jobs: [fx.job],
    plans: [fx.plan],
  });
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => {
      throw new Error('closed metric windows must not query Buffer');
    },
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(entities.GrowthContentMetric.records.length, 0);
  const savedJob = entities.GrowthPublishJob.records[0];
  assert.equal(savedJob.state, 'sent');
  assert.ok(savedJob.metrics_sync_completed_at);
  assert.deepEqual(
    savedJob.metrics_checkpoints.map((checkpoint) => checkpoint.snapshot_days),
    [1, 3, 7, 30],
  );
  assert.ok(savedJob.metrics_checkpoints.every(
    (checkpoint) => (
      checkpoint.status === 'review_needed'
      && checkpoint.error_code === 'buffer_metrics_checkpoint_window_missed'
    ),
  ));
});

test('missing metrics at the grace boundary become review-needed without a zero snapshot', async () => {
  const publishedAt = '2026-03-01T00:00:00.000Z';
  const closeAt = '2026-03-03T00:00:00.000Z';
  const fx = await sentMetricsFixture({ publishedAt });
  const { base44, entities } = createGrowthBase44({
    jobs: [fx.job],
    plans: [fx.plan],
  });
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    dateImpl: fixedDateAt(closeAt),
    fetchImpl: bufferMetricsFetch(fx, {
      metricsUpdatedAt: null,
      metrics: null,
    }),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(entities.GrowthContentMetric.records.length, 0);
  const savedJob = entities.GrowthPublishJob.records[0];
  assert.equal(savedJob.state, 'sent');
  assert.equal(savedJob.metrics_checkpoints.length, 1);
  assert.equal(savedJob.metrics_checkpoints[0].snapshot_days, 1);
  assert.equal(savedJob.metrics_checkpoints[0].status, 'review_needed');
  assert.equal(savedJob.metrics_checkpoints[0].error_code, 'buffer_metrics_unavailable');
  assert.equal(
    savedJob.metrics_next_checkpoint_at,
    '2026-03-04T00:00:00.000Z',
  );
});

test('a final provider refresh survives five-minute cron jitter when its evidence is in-window', async () => {
  const publishedAt = '2026-03-01T00:00:00.000Z';
  const invokedAt = '2026-03-03T00:05:00.000Z';
  const metricsUpdatedAt = '2026-03-02T23:59:00.000Z';
  const fx = await sentMetricsFixture({ publishedAt });
  const { base44, entities } = createGrowthBase44({
    jobs: [fx.job],
    plans: [fx.plan],
  });
  let reads = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    dateImpl: fixedDateAt(invokedAt),
    fetchImpl: bufferMetricsFetch(
      fx,
      { metricsUpdatedAt },
      () => { reads += 1; },
    ),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(reads, 1);
  assert.equal(entities.GrowthContentMetric.records.length, 1);
  assert.equal(
    entities.GrowthContentMetric.records[0].snapshot_captured_at,
    metricsUpdatedAt,
  );
  const savedJob = entities.GrowthPublishJob.records[0];
  assert.equal(savedJob.metrics_checkpoints[0].status, 'captured');
  assert.equal(savedJob.metrics_checkpoints[0].snapshot_days, 1);
  assert.notEqual(
    savedJob.metrics_checkpoints[0].error_code,
    'buffer_metrics_checkpoint_window_missed',
  );
});

test('comments without observed reach or views never create a fabricated exposure checkpoint', async () => {
  const fx = await sentMetricsFixture();
  const { base44, entities } = createGrowthBase44({
    jobs: [fx.job],
    plans: [fx.plan],
  });
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: bufferMetricsFetch(fx, {
      metrics: [
        { type: 'comments', name: 'Comments', value: 4, unit: 'count' },
        { type: 'shares', name: 'Shares', value: 2, unit: 'count' },
      ],
    }),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(entities.GrowthContentMetric.records.length, 0);
  const savedJob = entities.GrowthPublishJob.records[0];
  assert.equal(savedJob.state, 'sent');
  assert.equal(savedJob.metrics_checkpoints.length, 0);
  assert.equal(
    savedJob.last_error_code,
    'buffer_metrics_exposure_unavailable',
  );
  assert.ok(new Date(savedJob.metrics_next_checkpoint_at).getTime() > Date.now());
});

test('provider evidence hashes distinguish an absent exposure metric from a reported zero', async () => {
  const fx = await sentMetricsFixture();
  const dueMs = new Date(fx.publishedAt).getTime() + dayMs;
  const staleUpdatedAt = new Date(dueMs - 1000).toISOString();
  const { base44, entities } = createGrowthBase44({
    jobs: [fx.job],
    plans: [fx.plan],
  });
  let reads = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async (...args) => {
      reads += 1;
      return bufferMetricsFetch(fx, {
        metricsUpdatedAt: staleUpdatedAt,
        metrics: reads === 1
          ? [{ type: 'views', name: 'Views', value: 0, unit: 'count' }]
          : [
            { type: 'reach', name: 'Reach', value: 0, unit: 'count' },
            { type: 'views', name: 'Views', value: 0, unit: 'count' },
          ],
      })(...args);
    },
  });

  let result = await invokeJson(handler, {}, { secret: workerSecret });
  assert.equal(result.status, 200);
  const viewsOnlyHash =
    entities.GrowthPublishJob.records[0].provider_metrics_hash;
  assert.match(viewsOnlyHash, /^[a-f0-9]{64}$/);
  entities.GrowthPublishJob.records[0].metrics_next_checkpoint_at =
    new Date(Date.now() - 1000).toISOString();

  result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(reads, 2);
  const reachReportedZeroHash =
    entities.GrowthPublishJob.records[0].provider_metrics_hash;
  assert.match(reachReportedZeroHash, /^[a-f0-9]{64}$/);
  assert.notEqual(reachReportedZeroHash, viewsOnlyHash);
  assert.equal(entities.GrowthContentMetric.records.length, 0);
});

test('snapshot fingerprints distinguish an absent exposure metric from a provider-observed zero', async () => {
  const fx = await sentMetricsFixture();
  const metricsUpdatedAt = new Date().toISOString();
  const captureMetric = async (metrics) => {
    const { base44, entities } = createGrowthBase44({
      jobs: [structuredClone(fx.job)],
      plans: [structuredClone(fx.plan)],
    });
    const handler = loadGrowthHandler(workerPath, {
      base44,
      env,
      fetchImpl: bufferMetricsFetch(fx, { metricsUpdatedAt, metrics }),
    });

    const result = await invokeJson(handler, {}, { secret: workerSecret });
    assert.equal(result.status, 200);
    assert.equal(entities.GrowthContentMetric.records.length, 1);
    return entities.GrowthContentMetric.records[0];
  };

  const viewsOnly = await captureMetric([
    { type: 'views', name: 'Views', value: 0, unit: 'count' },
  ]);
  const reachReportedZero = await captureMetric([
    { type: 'reach', name: 'Reach', value: 0, unit: 'count' },
    { type: 'views', name: 'Views', value: 0, unit: 'count' },
  ]);

  assert.deepEqual(viewsOnly.provider_observed_metric_types, ['views']);
  assert.deepEqual(
    reachReportedZero.provider_observed_metric_types,
    ['reach', 'views'],
  );
  assert.notEqual(
    viewsOnly.snapshot_fingerprint,
    reachReportedZero.snapshot_fingerprint,
  );
  for (const metric of [viewsOnly, reachReportedZero]) {
    assert.equal(
      metric.snapshot_fingerprint,
      createHash('sha256').update(metricFingerprintPayload(metric)).digest('hex'),
    );
  }
});

test('sent metric reads fail closed when active Buffer identity or immutable job config drifts', async (t) => {
  const cases = [
    {
      name: 'active channel differs',
      job: { provider_channel_id: 'retired_instagram_channel' },
    },
    {
      name: 'active organization differs',
      job: { provider_organization_id: 'retired_buffer_org' },
    },
    {
      name: 'immutable config revision differs',
      job: { config_revision: 'f'.repeat(64) },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const fx = await sentMetricsFixture({ job: item.job });
      const { base44, entities } = createGrowthBase44({
        jobs: [fx.job],
        plans: [fx.plan],
      });
      let providerReads = 0;
      const handler = loadGrowthHandler(workerPath, {
        base44,
        env,
        fetchImpl: async () => {
          providerReads += 1;
          throw new Error('configuration drift must fail before Buffer');
        },
      });

      const result = await invokeJson(handler, {}, { secret: workerSecret });

      assert.equal(result.status, 200);
      assert.equal(providerReads, 0);
      assert.equal(entities.GrowthContentMetric.records.length, 0);
      const savedJob = entities.GrowthPublishJob.records[0];
      assert.equal(savedJob.state, 'sent');
      assert.equal(savedJob.provider_post_id, fx.job.provider_post_id);
      assert.equal(savedJob.metrics_checkpoints[0].status, 'review_needed');
      assert.equal(
        savedJob.metrics_checkpoints[0].error_code,
        'buffer_metrics_configuration_mismatch',
      );
    });
  }
});

test('a metrics-only provider identity mismatch is recorded for review while delivery remains sent', async () => {
  const fx = await sentMetricsFixture();
  const { base44, entities } = createGrowthBase44({
    jobs: [fx.job],
    plans: [fx.plan],
  });
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: bufferMetricsFetch(fx, {
      channelId: 'different_channel',
    }),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(entities.GrowthContentMetric.records.length, 0);
  const savedJob = entities.GrowthPublishJob.records[0];
  assert.equal(savedJob.state, 'sent');
  assert.equal(savedJob.provider_post_id, fx.job.provider_post_id);
  assert.equal(savedJob.provider_status, 'sent');
  assert.equal(savedJob.metrics_checkpoints[0].status, 'review_needed');
  assert.equal(
    savedJob.metrics_checkpoints[0].error_code,
    'buffer_metrics_provider_mismatch',
  );
});

test('concurrent metric workers share the sent-job lease and create only one checkpoint', async () => {
  const fx = await sentMetricsFixture();
  const { base44, entities } = createGrowthBase44({
    jobs: [fx.job],
    plans: [fx.plan],
  });
  const enteredProvider = deferred();
  const releaseProvider = deferred();
  let reads = 0;
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async (...args) => {
      reads += 1;
      enteredProvider.resolve();
      await releaseProvider.promise;
      return bufferMetricsFetch(fx)(...args);
    },
  });

  const first = invokeJson(handler, {}, { secret: workerSecret });
  await enteredProvider.promise;
  const second = await invokeJson(handler, {}, { secret: workerSecret });
  releaseProvider.resolve();
  const firstResult = await first;

  assert.equal(firstResult.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.processed, 0);
  assert.equal(reads, 1);
  assert.equal(entities.GrowthContentMetric.records.length, 1);
  assert.equal(entities.GrowthPublishJob.records[0].state, 'sent');
  assert.equal(entities.GrowthPublishJob.records[0].metrics_checkpoints.length, 1);
});

test('Buffer error bodies and API credentials are never persisted by metric retries', async () => {
  const fx = await sentMetricsFixture();
  const { base44, entities } = createGrowthBase44({
    jobs: [fx.job],
    plans: [fx.plan],
  });
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    fetchImpl: async () => Response.json({
      data: { post: null },
      errors: [{
        message: `${workerSecret} ${apiKey}`,
        extensions: { code: apiKey },
      }],
    }),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  const persisted = JSON.stringify({
    jobs: entities.GrowthPublishJob.records,
    metrics: entities.GrowthContentMetric.records,
    response: result.body,
  });
  assert.doesNotMatch(persisted, new RegExp(workerSecret));
  assert.doesNotMatch(persisted, new RegExp(apiKey));
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'buffer_metrics_provider_error',
  );
  assert.equal(entities.GrowthPublishJob.records[0].state, 'sent');
});

test('the Buffer timeout remains armed through response-body parsing', async () => {
  const fx = await sentMetricsFixture();
  const { base44, entities } = createGrowthBase44({
    jobs: [fx.job],
    plans: [fx.plan],
  });
  let timerHandle;
  let clearCalls = 0;
  let bodyReads = 0;
  const setTimeoutImpl = (callback) => {
    timerHandle = { active: true, callback };
    return timerHandle;
  };
  const clearTimeoutImpl = (handle) => {
    handle.active = false;
    clearCalls += 1;
  };
  const handler = loadGrowthHandler(workerPath, {
    base44,
    env,
    setTimeoutImpl,
    clearTimeoutImpl,
    fetchImpl: async (_url, options) => ({
      status: 200,
      headers: new Headers(),
      json: async () => {
        bodyReads += 1;
        assert.equal(timerHandle.active, true);
        timerHandle.callback();
        assert.equal(options.signal.aborted, true);
        throw new Error('simulated stalled response body');
      },
    }),
  });

  const result = await invokeJson(handler, {}, { secret: workerSecret });

  assert.equal(result.status, 200);
  assert.equal(bodyReads, 1);
  assert.equal(clearCalls, 1);
  assert.equal(timerHandle.active, false);
  assert.equal(entities.GrowthContentMetric.records.length, 0);
  assert.equal(
    entities.GrowthPublishJob.records[0].last_error_code,
    'provider_invalid_response',
  );
});
