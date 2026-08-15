import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  createGrowthBase44,
  growthHelpers,
  invokeJson,
  loadGrowthHandler,
} from './helpers/growthContentTestHarness.mjs';
import {
  evaluateGrowthDecisionSufficiency,
  GROWTH_DECISION_POLICY_ID,
  GROWTH_REVIEW_SCHEMA_VERSION,
} from '../base44/functions/_shared/growthDecisionSufficiency.js';

const managePath = 'base44/functions/manageGrowthContentEngine/entry.ts';
const workflowPath = '.github/workflows/growth-generator.yml';
const workerSecret = 'generation-worker-secret-with-more-than-32-characters';
const weeklySeedPack = JSON.parse(readFileSync(resolve(
  'config/growth-media/firstknock-weekly-rights-safe-seed.json',
), 'utf8'));
const weeklySeedPackSha256 = createHash('sha256')
  .update(growthHelpers.canonicalStringify(weeklySeedPack))
  .digest('hex');

function controlledDate(startMs) {
  return class ControlledDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [startMs]));
    }

    static now() {
      return startMs;
    }
  };
}

function weeklySourceRegistry() {
  return weeklySeedPack.sources.map((source) => ({
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
    safe_summary: `Sanitized visible FirstKnock workflow for ${source.asset_key}.`,
    active: true,
    privacy_change_pending: false,
  }));
}

function canonicalHash(value) {
  return createHash('sha256')
    .update(growthHelpers.canonicalStringify(value))
    .digest('hex');
}

function reviewedEvidence({
  id = 'primary',
  content = 'ig-scheduled-parent',
  reviewedAt = '2026-07-27T13:00:00.000Z',
} = {}) {
  const publishedAt = '2026-07-20T12:00:00.000Z';
  const capturedAt = '2026-07-27T12:00:00.000Z';
  const conversionCutoffAt = capturedAt;
  const metric = {
    id: `metric_${id}`,
    platform: 'instagram',
    campaign: '1000-users',
    content,
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
  };
  metric.snapshot_fingerprint = createHash('sha256').update(JSON.stringify({
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
  })).digest('hex');
  const conversionEvidence = {
    schema_version: 'growth-conversion-evidence.v2',
    platform: metric.platform,
    campaign: metric.campaign,
    content: metric.content,
    cohort_start_at: publishedAt,
    cutoff_at: conversionCutoffAt,
    snapshot_days: metric.snapshot_days,
    snapshot_captured_at: metric.snapshot_captured_at,
    social_evidence_hash: metric.snapshot_fingerprint,
    owned_intent_observed_fields: ['link_clicks', 'dm_intents'],
    link_clicks: metric.link_clicks,
    dm_intents: metric.dm_intents,
    owned_intents: metric.link_clicks + metric.dm_intents,
    attribution_method: 'declared_content_link',
    post_conversion_eligible: true,
    conversion_conclusion: 'exact_declared_link',
    conversion_counters_available: true,
    landing_sessions: 18,
    signup_cta_sessions: 10,
    auth_completed: 7,
    signups: 6,
    activated_workspaces: 4,
    activated_users: 9,
    activated_reps: 5,
    paid_users: 2,
    activation_timing_complete: true,
    paid_timing_complete: true,
    first_activation_at: '2026-07-21T12:00:00.000Z',
    last_activation_at: '2026-07-26T12:00:00.000Z',
    retention_window_days: 30,
    retention_mature: false,
    retention_eligible_users: 0,
    retained_users: 0,
    retention_rate: null,
  };
  const reviewDecision = 'repeat';
  const reviewNote = 'Keep the concrete workflow and vary the opening.';
  const decisionPolicy = evaluateGrowthDecisionSufficiency({
    decision: reviewDecision,
    fixed_age_snapshot_valid: true,
    social_evidence_hash: metric.snapshot_fingerprint,
    snapshot_days: metric.snapshot_days,
    snapshot_captured_at: capturedAt,
    observed_platform_native_exposure_fields: ['reach', 'views'],
    platform_native_exposure: {
      reach: metric.reach,
      views: metric.views,
    },
    conversion_evidence: conversionEvidence,
    comparable_fixed_age_snapshots: 0,
    override_note: '',
    override_hash: '',
  });
  assert.equal(decisionPolicy.supported, true);
  const conversionEvidenceHash = canonicalHash(conversionEvidence);
  const decisionPolicyEvidenceHash = canonicalHash(decisionPolicy.evidence);
  const reviewIdentityHash = canonicalHash({
    review_schema_version: GROWTH_REVIEW_SCHEMA_VERSION,
    evidence_hash: metric.snapshot_fingerprint,
    conversion_evidence_hash: conversionEvidenceHash,
    conversion_cutoff_at: conversionCutoffAt,
    decision: reviewDecision,
    decision_note: reviewNote,
    reviewed_at: reviewedAt,
    review_snapshot_captured_at: capturedAt,
    decision_policy_id: decisionPolicy.policy_id,
    decision_policy_reason_codes: decisionPolicy.reason_codes,
    decision_policy_evidence_hash: decisionPolicyEvidenceHash,
    decision_override_note: '',
    decision_override_hash: '',
  });
  const plan = {
    id: `plan_${id}`,
    platform: metric.platform,
    campaign: metric.campaign,
    content: metric.content,
    sprint: 'content-engine',
    sequence: 1,
    format: 'reel',
    audience: 'Field sales managers',
    hook: 'See the field funnel',
    script: 'Show the manager funnel.',
    cta_label: 'See FirstKnock',
    cta_channel: 'story_link',
    primary_metric: 'Activated users',
    hypothesis: 'Specific product proof will create qualified interest.',
    comparison_group: 'manager-analytics-video',
    major_variable: 'Field funnel hook',
    planned_publish_at: publishedAt,
    published_at: publishedAt,
    delivery_managed_by: 'buffer',
    delivery_status: 'published',
    snapshot_days: 7,
    review_schema_version: GROWTH_REVIEW_SCHEMA_VERSION,
    review_decision: reviewDecision,
    review_note: reviewNote,
    reviewed_at: reviewedAt,
    review_snapshot_captured_at: capturedAt,
    review_evidence_hash: metric.snapshot_fingerprint,
    review_conversion_cutoff_at: conversionCutoffAt,
    review_conversion_evidence_hash: conversionEvidenceHash,
    review_conversion_evidence: conversionEvidence,
    review_decision_policy_id: GROWTH_DECISION_POLICY_ID,
    review_decision_policy_reason_codes: decisionPolicy.reason_codes,
    review_decision_policy_evidence_hash: decisionPolicyEvidenceHash,
    review_comparable_fixed_age_snapshots: 0,
    review_identity_hash: reviewIdentityHash,
  };
  return { plan, metric };
}

function generatedFeatureExplainers(request) {
  const marker = 'Audited video donor context:\n';
  const donorLine = String(request?.prompt || '').split(marker)[1]?.split('\n')[0];
  assert.ok(donorLine, 'generation prompt must contain the bounded donor context');
  const donors = JSON.parse(donorLine);
  assert.equal(donors.length, 2);
  return {
    concepts: donors.map((donor, index) => ({
      donor_concept_id: donor.donor_concept_id,
      title: index === 0 ? 'Find the field bottleneck' : 'Own the route handoff',
      hook: index === 0 ? 'Find the field bottleneck' : 'Own every route handoff',
      overlay_text: index === 0
        ? ['See the field workflow', 'Choose the next question']
        : ['Build the route', 'Confirm the owner'],
      shot_list: [
        'Open on the audited source video.',
        'Show only the visible FirstKnock behavior.',
        'Finish on the workspace CTA.',
      ],
      overlay_cta: index === 0 ? 'See the field workflow' : 'See the route handoff',
      variants: ['instagram', 'tiktok'].map((platform) => ({
        platform,
        problem: index === 0
          ? 'Field activity can hide the coaching question.'
          : 'Route ownership can become unclear before field work.',
        visible_feature_behavior: index === 0
          ? 'FirstKnock shows the field funnel in one manager view.'
          : 'FirstKnock shows the route and its owner before the handoff.',
        practical_benefit: index === 0
          ? 'Managers can choose the next workflow question with context.'
          : 'The team can begin with a clear route handoff.',
        cta_label: index === 0 ? 'See FirstKnock' : 'Open FirstKnock',
      })),
    })),
  };
}

function schedulerEnv(overrides = {}) {
  return {
    GROWTH_GENERATION_WORKER_SECRET: workerSecret,
    GROWTH_SCHEDULED_GENERATION_ENABLED: 'true',
    GROWTH_CONTENT_GENERATION_ENABLED: 'true',
    GROWTH_RENDER_PACK_SHA256S: weeklySeedPackSha256,
    ...overrides,
  };
}

test('generation workflow is a guarded daily scheduler with a bounded review-only request', () => {
  const workflow = readFileSync(resolve(workflowPath), 'utf8');
  assert.match(workflow, /schedule:\s*\n\s*#.*\n\s*#.*\n\s*-\s*cron:\s*['"]15 7 \* \* \*['"]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.doesNotMatch(workflow, /\bpull_request(?:_target)?:/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.match(workflow, /GROWTH_GENERATION_WORKER_URL/);
  assert.match(workflow, /GROWTH_GENERATION_WORKER_SECRET/);
  assert.match(workflow, /GROWTH_SCHEDULED_GENERATION_ENABLED/);
  assert.match(
    workflow,
    /https:\/\/firstknock\.online\/api\/functions\/manageGrowthContentEngine/,
  );
  assert.doesNotMatch(workflow, /processGrowthPublishQueue/);
  assert.match(workflow, /action:\s*'run_scheduled_generation'/);
  assert.match(workflow, /seed_pack:\s*pack/);
  assert.match(workflow, /body\?\.scheduled_generation !== true/);
  assert.match(workflow, /body\?\.batch\?\.concept_count !== 2/);
  assert.match(workflow, /body\?\.batch\?\.pack_artifact_count !== 4/);
  assert.match(workflow, /growth-generation-handoff\.v1/);
  assert.match(workflow, /handoff\?\.state !== 'unrendered_ready'/);
  assert.match(workflow, /growth-review\.v3/);
  assert.match(workflow, /growth-decision-sufficiency\.v1/);
  assert.match(workflow, /handoff\?\.decision_policy_supported !== true/);
  assert.match(
    workflow,
    /handoff\?\.rendered_media_created_by_invocation !== 0/,
  );
  assert.match(workflow, /owner pack authorization, rendering, hosting, import/);
  assert.doesNotMatch(workflow, /--verbose|-v\b|set -x/);
});

test('scheduled generation secret and both kill switches fail before client or model access', async (t) => {
  const cases = [
    {
      name: 'missing server secret',
      env: schedulerEnv({ GROWTH_GENERATION_WORKER_SECRET: '' }),
      supplied: workerSecret,
      status: 503,
      error: 'growth_generation_worker_not_configured',
    },
    {
      name: 'wrong worker secret',
      env: schedulerEnv(),
      supplied: 'wrong-secret-that-is-still-at-least-32-characters',
      status: 401,
      error: 'worker_unauthorized',
    },
    {
      name: 'scheduler kill switch off',
      env: schedulerEnv({ GROWTH_SCHEDULED_GENERATION_ENABLED: 'false' }),
      supplied: workerSecret,
      status: 503,
      error: 'growth_scheduled_generation_disabled',
    },
    {
      name: 'global generation kill switch off',
      env: schedulerEnv({ GROWTH_CONTENT_GENERATION_ENABLED: 'false' }),
      supplied: workerSecret,
      status: 503,
      error: 'content_generation_not_configured',
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      let clients = 0;
      const { base44 } = createGrowthBase44({
        invokeLlm: async () => assert.fail('model must not be called'),
      });
      const handler = loadGrowthHandler(managePath, {
        base44,
        env: entry.env,
        onClientCreate: () => { clients += 1; },
      });
      const result = await invokeJson(handler, {
        action: 'run_scheduled_generation',
        seed_pack: weeklySeedPack,
      }, { secret: entry.supplied });
      assert.equal(result.status, entry.status);
      assert.equal(result.body.error, entry.error);
      assert.equal(clients, 0);
    });
  }
});

test('generation worker secret grants no owner, approval, scheduling, or publishing action', async () => {
  const { base44, entities } = createGrowthBase44({
    user: null,
    invokeLlm: async () => assert.fail('model must not be called'),
  });
  const handler = loadGrowthHandler(managePath, {
    base44,
    env: schedulerEnv(),
  });
  for (const body of [
    { action: 'build_next_batch' },
    { action: 'authorize_batch' },
    { action: 'approve' },
    { action: 'schedule' },
  ]) {
    const result = await invokeJson(handler, body, { secret: workerSecret });
    assert.equal(result.status, 401);
    assert.equal(result.body.error, 'unauthorized');
  }
  assert.equal(entities.GrowthContentBatch.records.length, 0);
  assert.equal(entities.GrowthCreativeArtifact.records.length, 0);
  assert.equal(entities.GrowthPublishJob.records.length, 0);
});

test('scheduled generation prepares exactly one two-concept review batch and retries idempotently', async () => {
  const { plan, metric } = reviewedEvidence();
  let authCalls = 0;
  let llmCalls = 0;
  const { base44, entities } = createGrowthBase44({
    user: null,
    sources: weeklySourceRegistry(),
    plans: [plan],
    metrics: [metric],
    invokeLlm: async (request) => {
      llmCalls += 1;
      return generatedFeatureExplainers(request);
    },
  });
  base44.auth.me = async () => {
    authCalls += 1;
    throw new Error('scheduled generation must not depend on a user session');
  };
  const handler = loadGrowthHandler(managePath, {
    base44,
    env: schedulerEnv(),
    dateImpl: controlledDate(Date.parse('2026-07-28T18:00:00.000Z')),
  });
  const request = {
    action: 'run_scheduled_generation',
    seed_pack: weeklySeedPack,
  };

  const created = await invokeJson(handler, request, { secret: workerSecret });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.success, true);
  assert.equal(created.body.scheduled_generation, true);
  assert.equal(created.body.idempotent, false);
  assert.equal(created.body.batch.target_date, '2026-07-29');
  assert.equal(created.body.batch.batch_input_mode, 'reviewed_evidence');
  assert.equal(created.body.batch.content_profile, 'feature_explainer_video_v1');
  assert.equal(created.body.batch.concept_count, 2);
  assert.deepEqual(Array.from(created.body.batch.slot_keys), ['morning', 'midday']);
  assert.equal(created.body.batch.pack_artifact_count, 4);
  assert.equal(created.body.batch.state, 'ready');
  assert.equal(
    created.body.batch.review_schema_version,
    GROWTH_REVIEW_SCHEMA_VERSION,
  );
  assert.equal(
    created.body.batch.decision_policy_id,
    GROWTH_DECISION_POLICY_ID,
  );
  assert.equal(
    created.body.batch.decision_policy_evidence_hash,
    plan.review_decision_policy_evidence_hash,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(created.body.generation_handoff)),
    {
      schema_version: 'growth-generation-handoff.v1',
      state: 'unrendered_ready',
      state_scope: 'scheduled_generation_output',
      batch_key: created.body.batch.batch_key,
      target_date: '2026-07-29',
      canonical_concept_count: 2,
      planned_rendition_count: 4,
      review_schema_version: GROWTH_REVIEW_SCHEMA_VERSION,
      decision_policy_id: GROWTH_DECISION_POLICY_ID,
      decision_policy_evidence_hash:
        plan.review_decision_policy_evidence_hash,
      decision_policy_reason_codes:
        Array.from(plan.review_decision_policy_reason_codes),
      decision_policy_supported: true,
      rendered_media_created_by_invocation: 0,
      creative_artifacts_created_by_invocation: 0,
      publish_jobs_created_by_invocation: 0,
      requires_human_approval: true,
      external_pipeline_gates: [
        'owner_pack_authorization',
        'render_media',
        'host_and_verify_media',
        'import_render_result',
        'rendition_review',
        'owner_rendition_approval',
        'schedule_activation',
      ],
    },
  );
  assert.equal(created.body.render_pack.artifacts.length, 4);
  assert.equal(new Set(
    created.body.render_pack.artifacts.map((artifact) => artifact.concept_id),
  ).size, 2);
  assert.deepEqual(new Set(
    created.body.render_pack.artifacts.map((artifact) => artifact.platform),
  ), new Set(['instagram', 'tiktok']));
  assert.equal(created.body.render_pack.artifacts.every(
    (artifact) => artifact.format === 'video',
  ), true);
  assert.equal(entities.GrowthContentBatch.records.length, 1);
  assert.equal(
    entities.GrowthContentBatch.records[0].requested_by,
    'growth-generation-scheduler',
  );
  assert.equal(entities.GrowthCreativeArtifact.records.length, 0);
  assert.equal(entities.GrowthPublishJob.records.length, 0);
  assert.equal(authCalls, 0);
  assert.equal(llmCalls, 1);

  const retry = await invokeJson(handler, request, { secret: workerSecret });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.success, true);
  assert.equal(retry.body.scheduled_generation, true);
  assert.equal(retry.body.idempotent, true);
  assert.equal(retry.body.generation_handoff.state, 'unrendered_ready');
  assert.equal(
    retry.body.generation_handoff.rendered_media_created_by_invocation,
    0,
  );
  assert.equal(retry.body.batch.batch_key, created.body.batch.batch_key);
  assert.equal(entities.GrowthContentBatch.records.length, 1);
  assert.equal(entities.GrowthCreativeArtifact.records.length, 0);
  assert.equal(entities.GrowthPublishJob.records.length, 0);
  assert.equal(authCalls, 0);
  assert.equal(llmCalls, 1);

  entities.GrowthContentBatch.records[0].state = 'failed';
  entities.GrowthContentBatch.records[0].attempt_count = 3;
  const exhausted = await invokeJson(handler, request, { secret: workerSecret });
  assert.equal(exhausted.status, 409);
  assert.equal(exhausted.body.error, 'scheduled_generation_attempts_exhausted');
  assert.equal(llmCalls, 1);
  entities.GrowthContentBatch.records[0].state = 'ready';
  entities.GrowthContentBatch.records[0].attempt_count = 1;

  entities.GrowthContentPlan.records[0].review_note = 'A changed reviewed direction.';
  const stale = await invokeJson(handler, request, { secret: workerSecret });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'reviewed_parent_decision_policy_stale');
  assert.equal(entities.GrowthContentBatch.records.length, 1);
  assert.equal(llmCalls, 1);
});

test('scheduled generation rejects caller overrides and ambiguous latest reviews', async () => {
  const first = reviewedEvidence({ id: 'first', content: 'ig-first-parent' });
  const second = reviewedEvidence({ id: 'second', content: 'ig-second-parent' });
  let llmCalls = 0;
  const { base44, entities } = createGrowthBase44({
    user: null,
    sources: weeklySourceRegistry(),
    plans: [first.plan, second.plan],
    metrics: [first.metric, second.metric],
    invokeLlm: async () => {
      llmCalls += 1;
      return {};
    },
  });
  const handler = loadGrowthHandler(managePath, {
    base44,
    env: schedulerEnv(),
    dateImpl: controlledDate(Date.parse('2026-07-28T18:00:00.000Z')),
  });

  const override = await invokeJson(handler, {
    action: 'run_scheduled_generation',
    seed_pack: weeklySeedPack,
    target_date: '2026-08-15',
    concept_count: 3,
    content_profile: 'measured-next-batch-v1',
    seed_concept_ids: ['caller-selected-concept'],
    parent: {
      platform: first.plan.platform,
      campaign: first.plan.campaign,
      content: first.plan.content,
    },
  }, { secret: workerSecret });
  assert.equal(override.status, 400);
  assert.equal(override.body.error, 'invalid_scheduled_generation_request');

  const ambiguous = await invokeJson(handler, {
    action: 'run_scheduled_generation',
    seed_pack: weeklySeedPack,
  }, { secret: workerSecret });
  assert.equal(ambiguous.status, 409);
  assert.equal(ambiguous.body.error, 'scheduled_generation_parent_conflict');
  assert.equal(entities.GrowthContentBatch.records.length, 0);
  assert.equal(entities.GrowthCreativeArtifact.records.length, 0);
  assert.equal(entities.GrowthPublishJob.records.length, 0);
  assert.equal(llmCalls, 0);
});

test('scheduled generation rejects a newest policy-stale review without falling back', async () => {
  const older = reviewedEvidence({
    id: 'older',
    content: 'ig-older-policy-parent',
    reviewedAt: '2026-07-27T12:00:00.000Z',
  });
  const newest = reviewedEvidence({
    id: 'newest',
    content: 'ig-newest-policy-parent',
    reviewedAt: '2026-07-27T13:00:00.000Z',
  });
  delete newest.plan.review_decision_policy_id;
  let llmCalls = 0;
  const { base44, entities } = createGrowthBase44({
    user: null,
    sources: weeklySourceRegistry(),
    plans: [older.plan, newest.plan],
    metrics: [older.metric, newest.metric],
    invokeLlm: async () => {
      llmCalls += 1;
      return {};
    },
  });
  const handler = loadGrowthHandler(managePath, {
    base44,
    env: schedulerEnv(),
    dateImpl: controlledDate(Date.parse('2026-07-28T18:00:00.000Z')),
  });

  const result = await invokeJson(handler, {
    action: 'run_scheduled_generation',
    seed_pack: weeklySeedPack,
  }, { secret: workerSecret });

  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'reviewed_parent_decision_policy_stale');
  assert.equal(entities.GrowthContentBatch.records.length, 0);
  assert.equal(llmCalls, 0);
});
