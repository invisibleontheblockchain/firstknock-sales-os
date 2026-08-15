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

const planManagerPath = 'base44/functions/manageGrowthContentPlan/entry.ts';
const publishedAt = '2026-07-20T12:00:00.000Z';
const capturedAt = '2026-07-27T12:00:00.000Z';
const reportGeneratedAt = '2026-07-27T12:30:00.000Z';
const reviewAt = Date.parse('2026-07-27T13:00:00.000Z');
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

function fixedDate(nowMs = reviewAt) {
  const NativeDate = Date;
  return class FixedDate extends NativeDate {
    constructor(value) {
      super(value === undefined ? nowMs : value);
    }

    static now() {
      return nowMs;
    }
  };
}

function metricFingerprint(metric) {
  const payload = {
    campaign: metric.campaign,
    content: metric.content,
    snapshot_days: metric.snapshot_days,
    snapshot_captured_at: metric.snapshot_captured_at,
    published_at: metric.published_at,
  };
  for (const field of metricFields) payload[field] = Number(metric[field] || 0);
  const observed = metric.observed_metric_fields
    || (
      metric.metric_source === 'buffer'
        ? metric.provider_observed_metric_types
        : null
    );
  if (observed) {
    const names = new Set(observed);
    payload.observed_fields = metricFields.filter((field) => names.has(field));
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function fixture({ observedFields, ctaChannel = 'story_link' } = {}) {
  const metric = {
    id: 'metric_conversion_parent',
    platform: 'instagram',
    campaign: '1000-users',
    content: 'ig-conversion-parent',
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
    link_clicks: 0,
    dm_intents: 0,
    observed_metric_fields: observedFields || metricFields,
  };
  metric.snapshot_fingerprint = metricFingerprint(metric);
  const plan = {
    id: 'plan_conversion_parent',
    platform: metric.platform,
    campaign: metric.campaign,
    content: metric.content,
    sprint: 'content-engine',
    sequence: 1,
    format: 'reel',
    audience: 'Field sales managers',
    hook: 'See the exact field funnel',
    script: 'Show the measured FirstKnock workflow.',
    cta_label: 'See FirstKnock',
    cta_channel: ctaChannel,
    primary_metric: 'Activated users',
    hypothesis: 'Product proof creates qualified activation.',
    comparison_group: 'measured-feature-video',
    major_variable: 'Opening hook',
    planned_publish_at: publishedAt,
    published_at: publishedAt,
    delivery_managed_by: 'buffer',
    delivery_status: 'published',
    snapshot_days: 7,
  };
  return { plan, metric };
}

function eligibleRow(overrides = {}) {
  return {
    source: 'instagram',
    campaign: '1000-users',
    content: 'ig-conversion-parent',
    snapshot_days: 7,
    cohort_start_at: publishedAt,
    conversion_cutoff_at: capturedAt,
    attribution_granularity: 'content',
    attribution_method: 'declared_content_link',
    conversion_evidence: 'client_declared_content_first_touch',
    post_conversion_eligible: true,
    conversion_conclusion: 'exact_declared_link',
    conversion_counters_available: true,
    link_clicks: 0,
    dm_intents: 0,
    owned_intents: 0,
    landing_sessions: 18,
    signup_cta_sessions: 10,
    auth_completed: 7,
    decision_signups: 6,
    decision_activated_workspaces: 4,
    activated_users: 9,
    activated_reps: 5,
    paid_users: 2,
    activation_timing_complete: true,
    paid_timing_complete: true,
    first_activation_at: '2026-07-21T12:00:00.000Z',
    last_activation_at: '2026-07-25T12:00:00.000Z',
    retention_window_days: 30,
    retention_mature: false,
    retention_eligible_users: 0,
    retained_users: 0,
    retention_rate: null,
    missing_event_timestamps: 0,
    missing_user_timestamps: 0,
    activation_timing_missing_users: 0,
    paid_timing_missing_users: 0,
    excluded_prepublication_events: 0,
    excluded_post_cutoff_events: 0,
    excluded_synthetic_events: 0,
    excluded_prepublication_users: 0,
    excluded_post_cutoff_users: 0,
    excluded_invalid_timing_users: 0,
    excluded_synthetic_users: 0,
    ...overrides,
  };
}

function socialOnlyRow(overrides = {}) {
  return eligibleRow({
    attribution_method: 'social_evidence_only',
    conversion_evidence: 'social_metrics_only_no_declared_handoff',
    post_conversion_eligible: false,
    conversion_conclusion: 'inconclusive_no_declared_link',
    conversion_counters_available: false,
    landing_sessions: null,
    signup_cta_sessions: null,
    auth_completed: null,
    decision_signups: null,
    decision_activated_workspaces: null,
    activated_users: null,
    activated_reps: null,
    paid_users: null,
    activation_timing_complete: false,
    paid_timing_complete: false,
    first_activation_at: null,
    last_activation_at: null,
    retention_eligible_users: null,
    retained_users: null,
    retention_rate: null,
    ...overrides,
  });
}

function reviewContext({
  rows = [eligibleRow()],
  observedFields,
  ctaChannel = 'story_link',
} = {}) {
  const { plan, metric } = fixture({ observedFields, ctaChannel });
  let userScopedCalls = 0;
  let serviceScopedCalls = 0;
  const { base44, entities } = createGrowthBase44({
    plans: [plan],
    metrics: [metric],
    invokeFunction: async (functionName, body) => {
      userScopedCalls += 1;
      assert.equal(functionName, 'getAcquisitionReport');
      assert.equal(body.platform, 'instagram');
      assert.equal(body.campaign, '1000-users');
      assert.equal(body.content, 'ig-conversion-parent');
      assert.equal(body.snapshot_captured_at, capturedAt);
      assert.equal(body.conversion_cutoff_at, capturedAt);
      return {
        data: {
          success: true,
          generated_at: reportGeneratedAt,
          request_scope: {
            platform: 'instagram',
            campaign: '1000-users',
            content: 'ig-conversion-parent',
            cohort_start_at: publishedAt,
            conversion_cutoff_at: capturedAt,
          },
          by_content: structuredClone(rows),
        },
      };
    },
  });
  base44.asServiceRole.functions.invoke = async () => {
    serviceScopedCalls += 1;
    throw new Error('service-scoped function invocation is forbidden');
  };
  const handler = loadGrowthHandler(planManagerPath, {
    base44,
    dateImpl: fixedDate(),
  });
  return {
    entities,
    handler,
    calls: () => ({ userScopedCalls, serviceScopedCalls }),
  };
}

async function review(handler, decision = 'repeat') {
  return invokeJson(handler, {
    action: 'review',
    platform: 'instagram',
    campaign: '1000-users',
    content: 'ig-conversion-parent',
    decision,
    note: 'Keep the grounded workflow and change only the opening hook.',
  });
}

test('review freezes exact authenticated post-level conversion evidence', async () => {
  const context = reviewContext();
  const result = await review(context.handler);

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(context.calls(), {
    userScopedCalls: 1,
    serviceScopedCalls: 0,
  });
  const saved = context.entities.GrowthContentPlan.records[0];
  assert.equal(saved.review_conversion_cutoff_at, capturedAt);
  assert.equal(
    saved.review_conversion_evidence_hash,
    result.body.conversion_evidence_hash,
  );
  assert.deepEqual(
    saved.review_conversion_evidence,
    result.body.conversion_evidence,
  );
  assert.deepEqual(saved.review_conversion_evidence, {
    schema_version: 'growth-conversion-evidence.v2',
    platform: 'instagram',
    campaign: '1000-users',
    content: 'ig-conversion-parent',
    cohort_start_at: publishedAt,
    cutoff_at: capturedAt,
    snapshot_days: 7,
    snapshot_captured_at: capturedAt,
    social_evidence_hash: saved.review_evidence_hash,
    owned_intent_observed_fields: ['link_clicks', 'dm_intents'],
    link_clicks: 0,
    dm_intents: 0,
    owned_intents: 0,
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
    last_activation_at: '2026-07-25T12:00:00.000Z',
    retention_window_days: 30,
    retention_mature: false,
    retention_eligible_users: 0,
    retained_users: 0,
    retention_rate: null,
  });
  assert.equal(
    saved.review_conversion_evidence_hash,
    createHash('sha256')
      .update(growthHelpers.canonicalStringify(saved.review_conversion_evidence))
      .digest('hex'),
  );
  assert.equal(context.entities.GrowthContentPlan.counters.updateMany, 1);
});

test('ordinary feed post remains reviewable with social-only evidence and null conversions', async () => {
  const context = reviewContext({
    ctaChannel: 'caption_url',
    rows: [socialOnlyRow()],
  });
  const result = await review(context.handler, 'iterate');

  assert.equal(result.status, 200, JSON.stringify(result.body));
  const evidence = result.body.conversion_evidence;
  assert.equal(evidence.schema_version, 'growth-conversion-evidence.v2');
  assert.equal(evidence.conversion_conclusion, 'inconclusive_no_declared_link');
  assert.equal(evidence.attribution_method, 'social_evidence_only');
  assert.equal(evidence.post_conversion_eligible, false);
  assert.equal(evidence.conversion_counters_available, false);
  for (const field of [
    'landing_sessions',
    'signup_cta_sessions',
    'auth_completed',
    'signups',
    'activated_workspaces',
    'activated_users',
    'activated_reps',
    'paid_users',
    'retention_eligible_users',
    'retained_users',
    'retention_rate',
    'first_activation_at',
    'last_activation_at',
  ]) {
    assert.equal(evidence[field], null, field);
  }
  assert.equal(context.entities.GrowthContentPlan.records[0].review_decision, 'iterate');
});

test('exact zero-activation evidence uses zero counts with null activation dates', async () => {
  const context = reviewContext({
    rows: [eligibleRow({
      decision_activated_workspaces: 0,
      activated_users: 0,
      activated_reps: 0,
      paid_users: 0,
      first_activation_at: null,
      last_activation_at: null,
    })],
  });
  const result = await review(context.handler, 'iterate');

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.conversion_evidence.activated_users, 0);
  assert.equal(result.body.conversion_evidence.first_activation_at, null);
  assert.equal(result.body.conversion_evidence.last_activation_at, null);
});

test('retention evidence is covered by the canonical tamper-evident hash', async () => {
  const context = reviewContext();
  const result = await review(context.handler);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const frozen = structuredClone(result.body.conversion_evidence);
  frozen.retention_mature = true;
  const tamperedHash = createHash('sha256')
    .update(growthHelpers.canonicalStringify(frozen))
    .digest('hex');
  assert.notEqual(tamperedHash, result.body.conversion_evidence_hash);
});

test('missing, conflicting, mismatched, and ineligible conversion rows fail closed', async (t) => {
  const cases = [
    {
      name: 'missing exact row',
      rows: [],
      status: 503,
      error: 'conversion_evidence_unavailable',
    },
    {
      name: 'conflicting exact rows',
      rows: [eligibleRow(), eligibleRow({ paid_users: 3 })],
      status: 409,
      error: 'conversion_evidence_conflict',
    },
    {
      name: 'wrong platform row',
      rows: [eligibleRow({ source: 'tiktok' })],
      status: 503,
      error: 'conversion_evidence_unavailable',
    },
    {
      name: 'visitor assist is not post conversion evidence',
      rows: [eligibleRow({
        attribution_method: 'visitor_assist_only',
        conversion_evidence: 'visitor_self_report_only',
        post_conversion_eligible: false,
      })],
      status: 409,
      error: 'conversion_evidence_ineligible',
    },
    {
      name: 'static bio is not post conversion evidence',
      rows: [eligibleRow({
        attribution_granularity: 'platform',
        attribution_method: 'static_bio',
        conversion_evidence: 'client_declared_platform_first_touch',
        post_conversion_eligible: false,
      })],
      status: 409,
      error: 'conversion_evidence_ineligible',
    },
    {
      name: 'counter type mismatch',
      rows: [eligibleRow({ paid_users: '2' })],
      status: 409,
      error: 'conversion_evidence_mismatch',
    },
    {
      name: 'owned-intent mismatch',
      rows: [eligibleRow({ owned_intents: 1 })],
      status: 409,
      error: 'conversion_evidence_mismatch',
    },
  ];

  for (const spec of cases) {
    await t.test(spec.name, async () => {
      const context = reviewContext({ rows: spec.rows });
      const before = structuredClone(context.entities.GrowthContentPlan.records[0]);
      const result = await review(context.handler);
      assert.equal(result.status, spec.status);
      assert.equal(result.body.error, spec.error);
      assert.deepEqual(context.entities.GrowthContentPlan.records[0], before);
      assert.equal(context.entities.GrowthContentPlan.counters.updateMany, 0);
      assert.equal(context.entities.GrowthContentMetric.counters.update, 0);
    });
  }
});

test('observed zero owned intent hashes differently from unobserved intent', async () => {
  const observed = reviewContext({
    observedFields: ['reach', 'views', 'link_clicks'],
  });
  const unobserved = reviewContext({
    observedFields: ['reach', 'views'],
  });
  const observedResult = await review(observed.handler, 'iterate');
  const unobservedResult = await review(unobserved.handler, 'iterate');

  assert.equal(observedResult.status, 200);
  assert.equal(unobservedResult.status, 200);
  assert.deepEqual(
    observedResult.body.conversion_evidence.owned_intent_observed_fields,
    ['link_clicks'],
  );
  assert.deepEqual(
    unobservedResult.body.conversion_evidence.owned_intent_observed_fields,
    [],
  );
  assert.notEqual(
    observedResult.body.conversion_evidence_hash,
    unobservedResult.body.conversion_evidence_hash,
  );
});

test('conversion evidence entity schema is exact, bounded, and service-only', () => {
  const schema = JSON.parse(readFileSync(
    resolve('base44/entities/GrowthContentPlan.jsonc'),
    'utf8',
  ));
  const evidence = schema.properties.review_conversion_evidence;
  assert.equal(evidence.additionalProperties, false);
  assert.deepEqual(evidence.properties.schema_version.enum, [
    'growth-conversion-evidence.v2',
  ]);
  assert.deepEqual(evidence.properties.attribution_method.enum, [
    'declared_content_link',
    'social_evidence_only',
  ]);
  assert.equal(evidence.properties.post_conversion_eligible.type, 'boolean');
  assert.deepEqual(evidence.properties.owned_intent_observed_fields.items.enum, [
    'link_clicks',
    'dm_intents',
  ]);
  for (const field of [
    'link_clicks',
    'dm_intents',
    'owned_intents',
  ]) {
    assert.equal(evidence.properties[field].type, 'integer');
    assert.equal(evidence.properties[field].minimum, 0);
    assert.ok(evidence.required.includes(field));
  }
  for (const field of [
    'landing_sessions',
    'signup_cta_sessions',
    'auth_completed',
    'signups',
    'activated_workspaces',
    'activated_users',
    'activated_reps',
    'paid_users',
    'retention_eligible_users',
    'retained_users',
  ]) {
    assert.deepEqual(evidence.properties[field].type, ['integer', 'null']);
    assert.equal(evidence.properties[field].minimum, 0);
    assert.ok(evidence.required.includes(field));
  }
  assert.deepEqual(evidence.properties.retention_rate.type, ['number', 'null']);
  assert.ok(evidence.required.includes('retention_rate'));
  for (const operation of ['create', 'read', 'update', 'delete']) {
    assert.equal(
      schema.rls[operation].user_condition.id,
      '__service_role_only__',
    );
  }
});
