#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  growthBatchScheduleRequest,
  inspectGrowthBatchActivation,
} from '../src/lib/growthBatchActivation.js';
import {
  createGrowthBase44,
  invokeJson,
  loadGrowthHandler,
} from '../test/helpers/growthContentTestHarness.mjs';
import {
  canonicalStringify,
  validatePack,
} from './render-growth-pack.mjs';
import { sliceGrowthRenderResult } from './slice-growth-render-result.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const MANAGER_PATH = 'base44/functions/manageGrowthContentEngine/entry.ts';
const WORKER_PATH = 'base44/functions/processGrowthPublishQueue/entry.ts';
const SEED_PATH = resolve(
  'config/growth-media/firstknock-weekly-rights-safe-seed.json',
);
const START_AT = '2026-07-28T18:00:00.000Z';
const TARGET_DATES = [
  '2026-07-29',
  '2026-07-30',
  '2026-07-31',
  '2026-08-01',
  '2026-08-02',
  '2026-08-03',
  '2026-08-04',
];
const CHECKPOINT_DAYS = [1, 3, 7, 30];
const DAY_MS = 24 * 60 * 60 * 1000;
const MEDIA_ORIGIN = 'https://media.firstknock.online';
const MEDIA_PATH_PREFIX = '/files/public/app-firstknock/';
const MEDIA_NAMESPACE = `${MEDIA_ORIGIN}${MEDIA_PATH_PREFIX}`;
const WORKER_SECRET = 'local-dry-run-worker-secret-not-a-credential';
const BUFFER_API_KEY = 'local-dry-run-buffer-key-not-a-credential';
const PROCEDURAL_AUDIO_RECIPE = 'firstknock-procedural-ui-v1';
const RENDER_ENVIRONMENT = {
  profile_id: 'firstknock-h264-bitexact-v3',
  renderer_sha256: '1'.repeat(64),
  bold_font_sha256: '2'.repeat(64),
  regular_font_sha256: '3'.repeat(64),
  ffmpeg_build_sha256: '4'.repeat(64),
};

function fail(code, details = undefined) {
  const error = new Error(code);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function ensure(condition, code, details = undefined) {
  if (!condition) fail(code, details);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function objectSha256(value) {
  return sha256(canonicalStringify(value));
}

function controlledClock(startAt = START_AT) {
  let nowMs = Date.parse(startAt);
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
      const next = typeof value === 'number' ? value : Date.parse(value);
      ensure(Number.isFinite(next), 'dry_run_clock_invalid');
      nowMs = next;
    },
  };
}

function sourceRegistry(pack) {
  return pack.sources.map((source) => ({
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
    safe_summary:
      `Sanitized visible FirstKnock workflow for ${source.asset_key}.`,
    active: true,
    privacy_change_pending: false,
  }));
}

function renderResultForWeeklyPack(pack, renderEnvironmentSha256) {
  const packSha256 = objectSha256(pack);
  const artifacts = pack.artifacts.map((artifact) => {
    const source = pack.sources.find(
      (candidate) => candidate.asset_key === artifact.source_asset_key,
    );
    ensure(source, 'dry_run_render_source_missing', artifact.artifact_key);
    const durationMs = Number(artifact.render?.duration_ms);
    const thumbnailOffsetMs = Math.min(
      Number(pack.output.thumbnail_offset_ms),
      durationMs - 1,
    );
    const renderInputSha256 = objectSha256({
      schema_version: pack.schema_version,
      batch_id: pack.batch_id,
      template: pack.template,
      output: {
        ...pack.output,
        duration_ms: durationMs,
        thumbnail_offset_ms: thumbnailOffsetMs,
      },
      renderer: RENDER_ENVIRONMENT,
      source,
      artifact,
    });
    const mediaSha256 = sha256(`local-render:${artifact.artifact_key}`);
    const deliveryKey =
      `sha256/${mediaSha256}-${artifact.artifact_key}.mp4`;
    const mediaUrl = [
      MEDIA_NAMESPACE,
      'base44_opaque_',
      deliveryKey.slice('sha256/'.length),
    ].join('');
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
      template_id: pack.template.id,
      template_version: pack.template.version,
      render_profile_id: RENDER_ENVIRONMENT.profile_id,
      render_environment_sha256: renderEnvironmentSha256,
      render_input_sha256: renderInputSha256,
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
        audio_mode: pack.output.audio_mode,
        audio_recipe: pack.output.audio_recipe || 'silence',
        procedural_audio_generated:
          pack.output.audio_recipe === PROCEDURAL_AUDIO_RECIPE,
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
        ai_generated: artifact.ai_generated === true,
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
    batch_id: pack.batch_id,
    pack_sha256: packSha256,
    pack: structuredClone(pack),
    template: structuredClone(pack.template),
    renderer: {
      ...RENDER_ENVIRONMENT,
      environment_sha256: renderEnvironmentSha256,
    },
    media_origin: MEDIA_ORIGIN,
    artifact_count: artifacts.length,
    artifacts,
  };
}

function dailyShape(pack) {
  const concepts = [...new Set(
    pack.artifacts.map((artifact) => artifact.concept_id),
  )];
  const platforms = pack.artifacts.map((artifact) => artifact.platform);
  return {
    concept_count: concepts.length,
    artifact_count: pack.artifacts.length,
    instagram_count: platforms.filter(
      (platform) => platform === 'instagram',
    ).length,
    tiktok_count: platforms.filter(
      (platform) => platform === 'tiktok',
    ).length,
    source_count: pack.sources.length,
  };
}

function mediaReadyLocally(artifact) {
  return artifact?.format === 'video'
    && artifact?.mime_type === 'video/mp4'
    && artifact?.media_url?.startsWith(MEDIA_NAMESPACE)
    && /^[a-f0-9]{64}$/.test(String(artifact?.media_sha256 || ''))
    && Number(artifact?.duration_ms || 0) > 0
    && artifact?.render_result_schema === 'growth-render-result.v1';
}

function providerPostIdFromQuery(query) {
  const match = String(query).match(/post\(input:\{id:(\"(?:\\.|[^\"])*\")\}\)/);
  if (!match) return '';
  try {
    return JSON.parse(match[1]);
  } catch {
    return '';
  }
}

function providerMetrics(ordinal) {
  return [
    { type: 'reach', name: 'Reach', value: 100 + ordinal, unit: 'count' },
    { type: 'views', name: 'Views', value: 250 + ordinal, unit: 'count' },
    { type: 'shares', name: 'Shares', value: 3 + ordinal, unit: 'count' },
    { type: 'saves', name: 'Saves', value: 4 + ordinal, unit: 'count' },
    { type: 'comments', name: 'Comments', value: 2 + ordinal, unit: 'count' },
    { type: 'follows', name: 'Follows', value: 1 + ordinal, unit: 'count' },
  ];
}

function checkpointEventTimes(jobs) {
  const eventDays = new Set();
  for (const job of jobs) {
    const publishedMs = Date.parse(job.provider_sent_at);
    for (const days of CHECKPOINT_DAYS) {
      const due = new Date(publishedMs + days * DAY_MS);
      eventDays.add(due.toISOString().slice(0, 10));
    }
  }
  return [...eventDays]
    .sort()
    .map((day) => Date.parse(`${day}T22:30:00.000Z`));
}

function summarizeBy(values, keyFor) {
  const counts = {};
  for (const value of values) {
    const key = String(keyFor(value));
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => (
      left.localeCompare(right)
    )),
  );
}

export async function runSevenDayGrowthDryRun() {
  const weeklyPack = validatePack(JSON.parse(readFileSync(SEED_PATH, 'utf8')));
  const weeklyPackSha256 = objectSha256(weeklyPack);
  const renderEnvironmentSha256 = objectSha256(RENDER_ENVIRONMENT);
  const weeklyRenderResult = renderResultForWeeklyPack(
    weeklyPack,
    renderEnvironmentSha256,
  );
  ensure(
    weeklyRenderResult.artifacts.every((artifact) => (
      artifact.qc?.audio_mode === 'baked_owned_or_licensed'
      && artifact.qc?.audio_recipe === PROCEDURAL_AUDIO_RECIPE
      && artifact.qc?.procedural_audio_generated === true
    )),
    'dry_run_render_audio_qc_invalid',
  );
  const clock = controlledClock();
  const env = {
    GROWTH_PUBLISH_WORKER_SECRET: WORKER_SECRET,
    GROWTH_PUBLISH_ENABLED: 'true',
    BUFFER_API_KEY,
    BUFFER_ORGANIZATION_ID: 'local_dry_run_organization',
    BUFFER_INSTAGRAM_CHANNEL_ID: 'local_dry_run_instagram',
    BUFFER_TIKTOK_CHANNEL_ID: 'local_dry_run_tiktok',
    GROWTH_MEDIA_ORIGIN: MEDIA_ORIGIN,
    GROWTH_MEDIA_PATH_PREFIX: MEDIA_PATH_PREFIX,
    GROWTH_CONTENT_GENERATION_ENABLED: 'true',
    GROWTH_RENDER_PACK_SHA256S: weeklyPackSha256,
    GROWTH_RENDER_ENVIRONMENT_SHA256S: renderEnvironmentSha256,
  };
  const heartbeatRevision = sha256([
    'buffer-publisher',
    env.BUFFER_ORGANIZATION_ID,
    env.BUFFER_INSTAGRAM_CHANNEL_ID,
    env.BUFFER_TIKTOK_CHANNEL_ID,
    env.GROWTH_MEDIA_ORIGIN,
    env.GROWTH_MEDIA_PATH_PREFIX,
  ].join('|'));
  let llmCalls = 0;
  let managerFetchCalls = 0;
  let interceptedProviderReads = 0;
  let providerMutationAttempts = 0;
  const { base44, entities } = createGrowthBase44({
    sources: sourceRegistry(weeklyPack),
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
      fail('dry_run_llm_invocation_forbidden');
    },
  });
  const manager = loadGrowthHandler(MANAGER_PATH, {
    base44,
    env,
    dateImpl: clock.DateImpl,
    fetchImpl: async () => {
      managerFetchCalls += 1;
      fail('dry_run_manager_network_forbidden');
    },
  });

  const days = [];
  const reservedConcepts = new Set();
  const reservedSources = new Set();
  for (const targetDate of TARGET_DATES) {
    const built = await invokeJson(manager, {
      action: 'build_audited_bootstrap_batch',
      target_date: targetDate,
      content_profile: 'feature_explainer_video_v1',
      concept_count: 2,
      bootstrap_acknowledged: true,
      authorization_note:
        'Local deterministic seven-day dry run of the exact audited seed.',
      seed_pack: weeklyPack,
    });
    ensure(built.status === 201, 'dry_run_bootstrap_build_failed', built);
    ensure(
      built.body?.batch?.batch_input_mode === 'audited_seed_bootstrap',
      'dry_run_bootstrap_mode_invalid',
    );
    const shape = dailyShape(built.body.render_pack);
    ensure(
      canonicalStringify(shape) === canonicalStringify({
        concept_count: 2,
        artifact_count: 4,
        instagram_count: 2,
        tiktok_count: 2,
        source_count: 2,
      }),
      'dry_run_daily_shape_invalid',
      { targetDate, shape },
    );
    for (const artifact of built.body.render_pack.artifacts) {
      ensure(
        artifact.format === 'video',
        'dry_run_non_video_artifact',
        artifact.artifact_key,
      );
      reservedConcepts.add(artifact.concept_id);
    }
    for (const source of built.body.render_pack.sources) {
      reservedSources.add(source.asset_key);
    }
    days.push({
      target_date: targetDate,
      batch: built.body.batch,
      pack_sha256: built.body.pack_sha256,
      pack: built.body.render_pack,
    });
  }
  ensure(days.length === 7, 'dry_run_bootstrap_day_count_invalid');
  ensure(reservedConcepts.size === 14, 'dry_run_concept_reuse_detected');
  ensure(reservedSources.size === 14, 'dry_run_source_reuse_detected');
  ensure(llmCalls === 0, 'dry_run_llm_was_called');

  const eighth = await invokeJson(manager, {
    action: 'build_audited_bootstrap_batch',
    target_date: '2026-08-05',
    bootstrap_acknowledged: true,
    authorization_note:
      'This eighth local dry-run day must be rejected by the bootstrap cap.',
    seed_pack: weeklyPack,
  });
  ensure(
    eighth.status === 409
      && eighth.body?.error === 'bootstrap_batch_limit_reached',
    'dry_run_eighth_day_not_rejected',
    eighth,
  );

  const firstSlicedResult = sliceGrowthRenderResult(
    weeklyRenderResult,
    days[0].pack,
  );
  const prematureImport = await invokeJson(manager, {
    action: 'import_render_result',
    render_result: firstSlicedResult,
  });
  ensure(
    prematureImport.status >= 400,
    'dry_run_unauthorized_import_was_accepted',
    prematureImport,
  );
  ensure(
    entities.GrowthCreativeArtifact.records.length === 0,
    'dry_run_unauthorized_import_wrote_artifacts',
  );

  let preservedRenderDescriptors = 0;
  for (const day of days) {
    const authorized = await invokeJson(manager, {
      action: 'authorize_batch',
      batch_key: day.batch.batch_key,
      expected_pack_sha256: day.pack_sha256,
      inspection_acknowledged: true,
      note: `Locally inspected exact audited pack for ${day.target_date}.`,
    });
    ensure(
      authorized.status === 200
        && authorized.body?.batch?.state === 'render_authorized',
      'dry_run_batch_authorization_failed',
      { targetDate: day.target_date, authorized },
    );
    day.batch = authorized.body.batch;

    const sliced = sliceGrowthRenderResult(weeklyRenderResult, day.pack);
    ensure(
      sliced.pack_sha256 === day.pack_sha256
        && sliced.artifact_count === 4,
      'dry_run_sliced_result_invalid',
      day.target_date,
    );
    for (const rendered of sliced.artifacts) {
      const original = weeklyRenderResult.artifacts.find(
        (candidate) => candidate.artifact_key === rendered.artifact_key,
      );
      ensure(
        canonicalStringify(rendered) === canonicalStringify(original),
        'dry_run_slicer_changed_render_descriptor',
        rendered.artifact_key,
      );
      preservedRenderDescriptors += 1;
    }
    const imported = await invokeJson(manager, {
      action: 'import_render_result',
      render_result: sliced,
    });
    ensure(
      imported.status === 200
        && imported.body?.created === 4
        && imported.body?.imported === 4,
      'dry_run_render_import_failed',
      { targetDate: day.target_date, imported },
    );
  }
  ensure(
    preservedRenderDescriptors === 28,
    'dry_run_slicer_descriptor_count_invalid',
  );
  ensure(
    entities.GrowthCreativeArtifact.records.length === 28,
    'dry_run_imported_artifact_count_invalid',
  );

  for (const artifact of [...entities.GrowthCreativeArtifact.records]) {
    const reviewed = await invokeJson(manager, {
      action: 'review',
      artifact_id: artifact.id,
      privacy_cleared: true,
      demo_labeled: true,
      claims_supported: true,
      media_rights_confirmed: true,
    });
    ensure(
      reviewed.status === 200 && reviewed.body?.passed === true,
      'dry_run_artifact_review_failed',
      { artifact: artifact.artifact_key, reviewed },
    );
    const approved = await invokeJson(manager, {
      action: 'approve',
      artifact_id: artifact.id,
    });
    ensure(
      approved.status === 200
        && approved.body?.artifact?.approval_status === 'approved',
      'dry_run_artifact_approval_failed',
      { artifact: artifact.artifact_key, approved },
    );
  }

  const capabilities = {
    can_schedule: true,
    worker_healthy: true,
    planning_timezone: 'America/Phoenix',
    instagram: { delivery: 'buffer' },
    tiktok: { delivery: 'buffer' },
  };
  for (const day of days) {
    const artifacts = entities.GrowthCreativeArtifact.records.filter(
      (artifact) => artifact.growth_batch_key === day.batch.batch_key,
    );
    const activation = inspectGrowthBatchActivation({
      batch: day.batch,
      artifacts,
      jobs: entities.GrowthPublishJob.records,
      capabilities,
      isMediaReady: mediaReadyLocally,
      now: clock.now(),
    });
    ensure(
      activation.can_activate
        && activation.schedule_candidates.length === 4
        && activation.blockers.length === 0,
      'dry_run_batch_not_activatable',
      { targetDate: day.target_date, activation },
    );
    for (const candidate of activation.schedule_candidates) {
      const request = growthBatchScheduleRequest(candidate, {
        silentAutomaticConfirmed: true,
      });
      ensure(request, 'dry_run_schedule_request_invalid', candidate.artifact.id);
      const scheduled = await invokeJson(manager, request);
      ensure(
        scheduled.status === 201
          && scheduled.body?.job?.state === 'queued',
        'dry_run_schedule_failed',
        { artifact: candidate.artifact.artifact_key, scheduled },
      );
    }
  }
  ensure(managerFetchCalls === 0, 'dry_run_manager_fetch_detected');
  ensure(
    entities.GrowthPublishJob.records.length === 28,
    'dry_run_publish_job_count_invalid',
  );
  ensure(
    entities.GrowthContentPlan.records.length === 28,
    'dry_run_measurement_plan_count_invalid',
  );
  for (const targetDate of TARGET_DATES) {
    const jobs = entities.GrowthPublishJob.records.filter(
      (job) => job.due_at.startsWith(targetDate),
    );
    ensure(jobs.length === 4, 'dry_run_daily_job_count_invalid', targetDate);
    ensure(
      jobs.filter((job) => job.due_at.endsWith('T16:30:00.000Z')).length === 2
        && jobs.filter(
          (job) => job.due_at.endsWith('T20:30:00.000Z'),
        ).length === 2,
      'dry_run_phoenix_slot_count_invalid',
      targetDate,
    );
  }

  const jobsByProviderPostId = new Map();
  for (const [index, job] of entities.GrowthPublishJob.records.entries()) {
    const publishedAt = job.due_at;
    const providerPostId = `local_dry_run_post_${index + 1}`;
    Object.assign(job, {
      state: 'sent',
      provider_status: 'sent',
      provider_post_id: providerPostId,
      provider_sent_at: publishedAt,
      provider_external_link:
        `https://example.test/local-post/${index + 1}`,
      metrics_published_at: publishedAt,
      metrics_next_checkpoint_at: new Date(
        Date.parse(publishedAt) + DAY_MS,
      ).toISOString(),
      metrics_checkpoints: [],
      metrics_sync_attempt_count: 0,
      last_error_code: '',
      last_error_message: '',
    });
    jobsByProviderPostId.set(providerPostId, job);
    const plans = entities.GrowthContentPlan.records.filter((plan) => (
      plan.campaign === job.campaign
      && plan.content === job.platform_content_id
      && plan.platform === job.platform
    ));
    ensure(
      plans.length === 1,
      'dry_run_measurement_plan_identity_invalid',
      job.platform_content_id,
    );
    Object.assign(plans[0], {
      delivery_status: 'published',
      published_at: publishedAt,
    });
  }

  const workerFetch = async (url, options) => {
    ensure(
      String(url) === 'https://api.buffer.com',
      'dry_run_unexpected_fetch_target',
      String(url),
    );
    const document = JSON.parse(String(options?.body || '{}'));
    const query = String(document?.query || '');
    if (/mutation|createPost|updatePost|deletePost/.test(query)) {
      providerMutationAttempts += 1;
      fail('dry_run_provider_mutation_attempted');
    }
    ensure(
      /metricsUpdatedAt/.test(query) && /metrics\s*\{/.test(query),
      'dry_run_non_metric_provider_query',
    );
    ensure(
      options?.headers?.authorization === `Bearer ${BUFFER_API_KEY}`,
      'dry_run_provider_auth_fixture_invalid',
    );
    const providerPostId = providerPostIdFromQuery(query);
    const job = jobsByProviderPostId.get(providerPostId);
    ensure(job, 'dry_run_provider_post_identity_invalid', providerPostId);
    interceptedProviderReads += 1;
    const ordinal = Number(providerPostId.split('_').at(-1)) || 1;
    return Response.json({
      data: {
        post: {
          id: providerPostId,
          channelId: job.provider_channel_id,
          channelService: job.provider_service,
          status: 'sent',
          sentAt: job.provider_sent_at,
          metricsUpdatedAt: new clock.DateImpl().toISOString(),
          metrics: providerMetrics(ordinal),
        },
      },
    });
  };
  const worker = loadGrowthHandler(WORKER_PATH, {
    base44,
    env,
    dateImpl: clock.DateImpl,
    fetchImpl: workerFetch,
  });
  let workerInvocations = 0;
  for (const eventMs of checkpointEventTimes(
    entities.GrowthPublishJob.records,
  )) {
    clock.set(eventMs);
    for (let pass = 0; pass < 20; pass += 1) {
      const result = await invokeJson(
        worker,
        { limit: 5 },
        { secret: WORKER_SECRET },
      );
      workerInvocations += 1;
      ensure(
        result.status === 200,
        'dry_run_metric_worker_failed',
        result,
      );
      if (Number(result.body?.inspected || 0) === 0) break;
      ensure(
        pass < 19,
        'dry_run_metric_worker_did_not_drain',
        new clock.DateImpl().toISOString(),
      );
    }
  }
  const readsBeforeTerminalScan = interceptedProviderReads;
  clock.set(
    Math.max(...checkpointEventTimes(entities.GrowthPublishJob.records))
      + DAY_MS,
  );
  const terminalScan = await invokeJson(
    worker,
    { limit: 5 },
    { secret: WORKER_SECRET },
  );
  workerInvocations += 1;
  ensure(
    terminalScan.status === 200
      && terminalScan.body?.inspected === 0
      && interceptedProviderReads === readsBeforeTerminalScan,
    'dry_run_terminal_metric_scan_not_idle',
    terminalScan,
  );

  for (const job of entities.GrowthPublishJob.records) {
    ensure(
      job.state === 'sent'
        && Boolean(job.metrics_sync_completed_at)
        && canonicalStringify(
          job.metrics_checkpoints.map(
            (checkpoint) => checkpoint.snapshot_days,
          ),
        ) === canonicalStringify(CHECKPOINT_DAYS)
        && job.metrics_checkpoints.every(
          (checkpoint) => checkpoint.status === 'captured',
        ),
      'dry_run_metric_checkpoint_lifecycle_incomplete',
      job.platform_content_id,
    );
  }
  ensure(
    entities.GrowthContentMetric.records.length === 112,
    'dry_run_metric_count_invalid',
  );
  ensure(
    interceptedProviderReads === 112,
    'dry_run_provider_read_count_invalid',
  );
  ensure(
    providerMutationAttempts === 0,
    'dry_run_provider_mutation_detected',
  );

  const stableEvidence = {
    weekly_pack_sha256: weeklyPackSha256,
    render_environment_sha256: renderEnvironmentSha256,
    batch_keys: days.map((day) => day.batch.batch_key),
    scheduled_job_keys: entities.GrowthPublishJob.records.map(
      (job) => job.job_key,
    ).sort(),
    checkpoint_fingerprints: entities.GrowthContentMetric.records.map(
      (metric) => metric.snapshot_fingerprint,
    ).sort(),
  };
  return {
    schema_version: 'growth-seven-day-dry-run.v1',
    success: true,
    mode: 'local_in_memory',
    evidence_sha256: objectSha256(stableEvidence),
    bootstrap: {
      days: days.length,
      concepts_per_day: 2,
      total_concepts: reservedConcepts.size,
      artifacts_per_day: 4,
      total_artifacts: entities.GrowthCreativeArtifact.records.length,
      platform_artifacts: summarizeBy(
        entities.GrowthCreativeArtifact.records,
        (artifact) => artifact.platform,
      ),
      unique_sources: reservedSources.size,
      eighth_day_rejected: true,
      llm_calls: llmCalls,
    },
    render_result_slicing: {
      weekly_artifacts: weeklyRenderResult.artifact_count,
      daily_results: days.length,
      artifacts_per_result: 4,
      preserved_render_descriptors: preservedRenderDescriptors,
      audio_mode: weeklyPack.output.audio_mode,
      audio_recipe: weeklyPack.output.audio_recipe,
      procedural_audio_artifacts: weeklyRenderResult.artifacts.filter(
        (artifact) => artifact.qc?.procedural_audio_generated === true,
      ).length,
      pre_authorization_import_rejected: true,
      pre_authorization_error: prematureImport.body?.error || '',
    },
    activation: {
      authorized_batches: days.length,
      reviewed_artifacts: entities.GrowthCreativeArtifact.records.filter(
        (artifact) => artifact.review_status === 'passed',
      ).length,
      approved_artifacts: entities.GrowthCreativeArtifact.records.filter(
        (artifact) => artifact.approval_status === 'approved',
      ).length,
      scheduled_jobs: entities.GrowthPublishJob.records.length,
      measurement_plans: entities.GrowthContentPlan.records.length,
      timezone: 'America/Phoenix',
      daily_utc_slots: ['16:30', '20:30'],
    },
    metrics: {
      jobs_with_terminal_d30: entities.GrowthPublishJob.records.filter(
        (job) => Boolean(job.metrics_sync_completed_at),
      ).length,
      checkpoint_days: CHECKPOINT_DAYS,
      captured_checkpoints: entities.GrowthContentMetric.records.length,
      checkpoints_by_day: summarizeBy(
        entities.GrowthContentMetric.records,
        (metric) => metric.snapshot_days,
      ),
      checkpoints_by_platform: summarizeBy(
        entities.GrowthContentMetric.records,
        (metric) => metric.platform,
      ),
      provider_reads_intercepted_locally: interceptedProviderReads,
      worker_invocations: workerInvocations,
    },
    external_effects: {
      external_network_requests: 0,
      provider_mutations: providerMutationAttempts,
      durable_service_writes: 0,
      filesystem_writes: 0,
      manager_fetch_calls: managerFetchCalls,
    },
  };
}

const isCli = process.argv[1]
  && resolve(process.argv[1]) === resolve(SCRIPT_PATH);
if (isCli) {
  try {
    const result = await runSevenDayGrowthDryRun();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      success: false,
      error: String(error?.code || error?.message || 'dry_run_failed'),
      ...(error?.details === undefined ? {} : { details: error.details }),
    })}\n`);
    process.exitCode = 1;
  }
}
