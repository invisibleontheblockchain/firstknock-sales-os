import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  evaluateGrowthDecisionSufficiency,
  GROWTH_DECISION_POLICY_ID,
  GROWTH_REVIEW_SCHEMA_VERSION,
  isNontrivialGrowthDecisionOverride,
} from '../base44/functions/_shared/growthDecisionSufficiency.js';
import {
  canonicalStringify,
} from '../base44/functions/_shared/growthContentEngine.js';
import {
  createGrowthBase44,
  invokeJson,
  loadGrowthHandler,
} from './helpers/growthContentTestHarness.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const planManagerPath = 'base44/functions/manageGrowthContentPlan/entry.ts';
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

function exactConversion(overrides = {}) {
  return {
    schema_version: 'growth-conversion-evidence.v2',
    post_conversion_eligible: true,
    conversion_counters_available: true,
    attribution_method: 'declared_content_link',
    conversion_conclusion: 'exact_declared_link',
    activated_workspaces: 0,
    activated_users: 0,
    activated_reps: 0,
    paid_users: 0,
    activation_timing_complete: true,
    paid_timing_complete: true,
    retention_mature: false,
    retention_eligible_users: 0,
    retained_users: 0,
    retention_rate: null,
    ...overrides,
  };
}

function socialOnlyConversion() {
  return {
    schema_version: 'growth-conversion-evidence.v2',
    post_conversion_eligible: false,
    conversion_counters_available: false,
    attribution_method: 'social_evidence_only',
    conversion_conclusion: 'inconclusive_no_declared_link',
    activated_workspaces: null,
    activated_users: null,
    activated_reps: null,
    paid_users: null,
    retention_mature: false,
    retention_eligible_users: null,
    retained_users: null,
    retention_rate: null,
  };
}

function policyInput(overrides = {}) {
  return {
    decision: 'iterate',
    fixed_age_snapshot_valid: true,
    social_evidence_hash: 'a'.repeat(64),
    snapshot_days: 7,
    snapshot_captured_at: '2026-08-01T12:00:00.000Z',
    observed_platform_native_exposure_fields: ['reach'],
    platform_native_exposure: { reach: 400, views: null },
    conversion_evidence: socialOnlyConversion(),
    comparable_fixed_age_snapshots: 1,
    override_note: '',
    override_hash: '',
    ...overrides,
  };
}

test('base policy needs a canonical fixed-age snapshot and observed native exposure', () => {
  const result = evaluateGrowthDecisionSufficiency(policyInput({
    fixed_age_snapshot_valid: false,
    social_evidence_hash: '',
    observed_platform_native_exposure_fields: ['shares'],
    platform_native_exposure: { reach: null, views: null },
  }));
  assert.equal(result.supported, false);
  assert.deepEqual(result.reason_codes, [
    'canonical_social_evidence_required',
    'fixed_age_snapshot_required',
    'platform_native_exposure_required',
  ]);
});

test('Iterate is supported by base social evidence, including social-only conversion', () => {
  const result = evaluateGrowthDecisionSufficiency(policyInput());
  assert.equal(result.policy_id, GROWTH_DECISION_POLICY_ID);
  assert.equal(result.supported, true);
  assert.deepEqual(result.reason_codes, [
    'base_social_evidence_supported',
    'iterate_supported_by_social_evidence',
  ]);
});

test('Repeat needs a positive exact activation, mature retained outcome, or paid outcome', () => {
  const zero = evaluateGrowthDecisionSufficiency(policyInput({
    decision: 'repeat',
    conversion_evidence: exactConversion(),
  }));
  assert.equal(zero.supported, false);
  assert.ok(zero.reason_codes.includes('repeat_positive_exact_outcome_required'));

  for (const conversion of [
    exactConversion({ activated_workspaces: 1 }),
    exactConversion({
      retention_mature: true,
      retention_eligible_users: 2,
      retained_users: 1,
      retention_rate: 0.5,
    }),
    exactConversion({ paid_users: 1 }),
  ]) {
    const result = evaluateGrowthDecisionSufficiency(policyInput({
      decision: 'repeat',
      conversion_evidence: conversion,
    }));
    assert.equal(result.supported, true, JSON.stringify(result));
  }
});

test('social-only Repeat needs and binds a separate nontrivial override', () => {
  const unsupported = evaluateGrowthDecisionSufficiency(policyInput({
    decision: 'repeat',
  }));
  assert.equal(unsupported.supported, false);
  assert.ok(unsupported.reason_codes.includes('repeat_social_only_override_required'));

  const note = 'Strong reach and saves justify one controlled repeat without a conversion claim.';
  assert.equal(isNontrivialGrowthDecisionOverride(note), true);
  const overrideHash = createHash('sha256').update(note).digest('hex');
  const supported = evaluateGrowthDecisionSufficiency(policyInput({
    decision: 'repeat',
    override_note: note,
    override_hash: overrideHash,
  }));
  assert.equal(supported.supported, true);
  assert.equal(supported.override_note, note);
  assert.equal(supported.override_hash, overrideHash);
  assert.equal(supported.evidence.override_hash, overrideHash);
});

test('Hold uses three comparable snapshots and preserves null conversion as unknown', () => {
  const two = evaluateGrowthDecisionSufficiency(policyInput({
    decision: 'hold',
    comparable_fixed_age_snapshots: 2,
  }));
  assert.equal(two.supported, false);
  assert.ok(two.reason_codes.includes('hold_three_comparable_snapshots_required'));
  assert.equal(two.evidence.conversion_evidence.activated_users, null);

  const three = evaluateGrowthDecisionSufficiency(policyInput({
    decision: 'hold',
    comparable_fixed_age_snapshots: 3,
  }));
  assert.equal(three.supported, true);
  assert.equal(three.evidence.conversion_evidence.paid_users, null);
  assert.ok(three.reason_codes.includes('hold_supported_by_three_comparable_snapshots'));
});

function snapshotFingerprint(metric) {
  const payload = {
    campaign: metric.campaign,
    content: metric.content,
    snapshot_days: metric.snapshot_days,
    snapshot_captured_at: metric.snapshot_captured_at,
    published_at: metric.published_at,
  };
  for (const field of metricFields) payload[field] = Number(metric[field] || 0);
  payload.observed_fields = metricFields.filter(
    (field) => metric.observed_metric_fields.includes(field),
  );
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function reviewedFixture({
  content = 'ig-policy-parent',
  ctaChannel = 'story_link',
  observedFields = ['reach'],
  comparisonGroup = 'feature-proof',
  offsetMinutes = 60,
} = {}) {
  const capturedAt = new Date(Date.now() - offsetMinutes * 60 * 1000).toISOString();
  const publishedAt = new Date(Date.parse(capturedAt) - 7 * DAY_MS).toISOString();
  const plan = {
    platform: 'instagram',
    campaign: '1000-users',
    content,
    sprint: 'policy-test',
    sequence: 1,
    format: 'reel',
    audience: 'door-to-door managers',
    hook: 'See the route before the first knock',
    script: 'Show the route workflow.',
    cta_label: 'Start free',
    cta_channel: ctaChannel,
    primary_metric: 'reach',
    hypothesis: 'A direct workflow demonstration creates intent.',
    comparison_group: comparisonGroup,
    major_variable: 'opening hook',
    planned_publish_at: publishedAt,
    published_at: publishedAt,
    snapshot_days: 7,
  };
  const metric = {
    platform: 'instagram',
    campaign: '1000-users',
    content,
    format: 'reel',
    published_at: publishedAt,
    snapshot_days: 7,
    snapshot_captured_at: capturedAt,
    reach: 800,
    views: 0,
    shares: 10,
    saves: 20,
    comments: 2,
    follows: 3,
    profile_visits: 15,
    link_clicks: 4,
    dm_intents: 1,
    observed_metric_fields: observedFields,
  };
  metric.snapshot_fingerprint = snapshotFingerprint(metric);
  return { plan, metric, capturedAt };
}

function producerContext(fixtures) {
  const { base44, entities } = createGrowthBase44({
    plans: fixtures.map((fixture) => fixture.plan),
    metrics: fixtures.map((fixture) => fixture.metric),
  });
  return {
    entities,
    handler: loadGrowthHandler(planManagerPath, { base44 }),
  };
}

function reviewRequest(fixture, overrides = {}) {
  return {
    action: 'review',
    platform: 'instagram',
    campaign: '1000-users',
    content: fixture.plan.content,
    decision: 'repeat',
    note: 'Keep the proof pattern and change only the opening hook.',
    decision_policy_id: GROWTH_DECISION_POLICY_ID,
    expected_social_evidence_hash: fixture.metric.snapshot_fingerprint,
    expected_snapshot_captured_at: fixture.capturedAt,
    ...overrides,
  };
}

test('review producer persists the server-owned policy and growth-review.v3 identity', async () => {
  const fixture = reviewedFixture();
  const context = producerContext([fixture]);
  const result = await invokeJson(context.handler, reviewRequest(fixture));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const saved = context.entities.GrowthContentPlan.records[0];
  assert.equal(saved.review_schema_version, GROWTH_REVIEW_SCHEMA_VERSION);
  assert.equal(saved.review_decision_policy_id, GROWTH_DECISION_POLICY_ID);
  assert.deepEqual(Array.from(saved.review_decision_policy_reason_codes), [
    'base_social_evidence_supported',
    'repeat_supported_by_exact_activation',
  ]);
  const expectedPolicy = evaluateGrowthDecisionSufficiency({
    decision: 'repeat',
    fixed_age_snapshot_valid: true,
    social_evidence_hash: fixture.metric.snapshot_fingerprint,
    snapshot_days: 7,
    snapshot_captured_at: fixture.capturedAt,
    observed_platform_native_exposure_fields: ['reach'],
    platform_native_exposure: { reach: 800, views: null },
    conversion_evidence: result.body.conversion_evidence,
    comparable_fixed_age_snapshots: 0,
    override_note: '',
    override_hash: '',
  });
  const expectedPolicyHash = createHash('sha256')
    .update(canonicalStringify(expectedPolicy.evidence))
    .digest('hex');
  assert.equal(saved.review_decision_policy_evidence_hash, expectedPolicyHash);
  assert.equal(saved.review_comparable_fixed_age_snapshots, 0);
  const expectedIdentityHash = createHash('sha256')
    .update(canonicalStringify({
      review_schema_version: GROWTH_REVIEW_SCHEMA_VERSION,
      evidence_hash: saved.review_evidence_hash,
      conversion_evidence_hash: saved.review_conversion_evidence_hash,
      conversion_cutoff_at: saved.review_conversion_cutoff_at,
      decision: 'repeat',
      decision_note: saved.review_note,
      reviewed_at: saved.reviewed_at,
      review_snapshot_captured_at: saved.review_snapshot_captured_at,
      decision_policy_id: saved.review_decision_policy_id,
      decision_policy_reason_codes: saved.review_decision_policy_reason_codes,
      decision_policy_evidence_hash: saved.review_decision_policy_evidence_hash,
      decision_override_note: '',
      decision_override_hash: '',
    }))
    .digest('hex');
  assert.equal(saved.review_identity_hash, expectedIdentityHash);
  assert.equal(saved.review_decision_override_note, undefined);
  assert.equal(saved.review_decision_override_hash, undefined);
});

test('review producer rejects stale client policy identity before writing', async () => {
  const fixture = reviewedFixture();
  const context = producerContext([fixture]);
  const forgedPolicy = await invokeJson(context.handler, reviewRequest(fixture, {
    decision_policy_id: 'growth-decision-sufficiency.client-forged',
  }));
  assert.equal(forgedPolicy.status, 409);
  assert.equal(forgedPolicy.body.error, 'invalid_growth_decision_policy');
  const result = await invokeJson(context.handler, reviewRequest(fixture, {
    expected_social_evidence_hash: 'f'.repeat(64),
  }));
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'growth_decision_policy_stale');
  assert.equal(context.entities.GrowthContentPlan.counters.updateMany, 0);
});

test('review producer rejects a checkpoint with no observed reach or views', async () => {
  const fixture = reviewedFixture({ observedFields: ['shares'] });
  const context = producerContext([fixture]);
  const result = await invokeJson(context.handler, reviewRequest(fixture, {
    decision: 'iterate',
  }));
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'growth_decision_not_supported');
  assert.ok(result.body.reason_codes.includes('platform_native_exposure_required'));
  assert.equal(context.entities.GrowthContentPlan.counters.updateMany, 0);
});

test('review producer binds the explicit social-only Repeat override note and hash', async () => {
  const fixture = reviewedFixture({ ctaChannel: 'caption_url' });
  const context = producerContext([fixture]);
  const withoutOverride = await invokeJson(context.handler, reviewRequest(fixture));
  assert.equal(withoutOverride.status, 409);
  assert.equal(withoutOverride.body.error, 'growth_decision_not_supported');
  assert.ok(withoutOverride.body.reason_codes.includes(
    'repeat_social_only_override_required',
  ));

  const overrideNote = 'Strong native reach and saves justify one controlled repeat without claiming conversion.';
  const accepted = await invokeJson(context.handler, reviewRequest(fixture, {
    override_note: overrideNote,
  }));
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const saved = context.entities.GrowthContentPlan.records[0];
  assert.equal(saved.review_decision_override_note, overrideNote);
  assert.equal(
    saved.review_decision_override_hash,
    createHash('sha256').update(overrideNote).digest('hex'),
  );
  assert.ok(saved.review_decision_policy_reason_codes.includes(
    'repeat_supported_by_social_only_override',
  ));
});

test('review producer counts only comparable canonical snapshots with observed exposure', async () => {
  const fixtures = [
    reviewedFixture({ content: 'ig-hold-1', offsetMinutes: 60 }),
    reviewedFixture({ content: 'ig-hold-2', offsetMinutes: 61 }),
    reviewedFixture({ content: 'ig-hold-3', offsetMinutes: 62 }),
  ];
  const context = producerContext(fixtures);
  const result = await invokeJson(context.handler, reviewRequest(fixtures[0], {
    decision: 'hold',
    expected_comparable_fixed_age_snapshots: 3,
  }));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(
    Array.from(context.entities.GrowthContentPlan.records[0]
      .review_decision_policy_reason_codes),
    [
      'base_social_evidence_supported',
      'hold_supported_by_three_comparable_snapshots',
    ],
  );
  assert.equal(
    context.entities.GrowthContentPlan.records[0]
      .review_comparable_fixed_age_snapshots,
    3,
  );
});

test('dashboard exposes policy evidence and sends displayed checkpoint identity', () => {
  const queue = readFileSync(
    resolve('src/components/acquisition/GrowthActionQueue.jsx'),
    'utf8',
  );
  const dashboard = readFileSync(resolve('src/pages/GrowthDashboard.jsx'), 'utf8');
  assert.match(queue, /Social-only Repeat override/);
  assert.match(queue, /observed_platform_native_exposure_fields/);
  assert.match(queue, /!repeatSupported/);
  assert.match(queue, /!policyBaseSupported/);
  assert.match(queue, /comparableSnapshots >= 3/);
  assert.match(dashboard, /decision_policy_id: item\.decision_policy_id/);
  assert.match(dashboard, /expected_social_evidence_hash: item\.social_evidence_hash/);
  assert.match(dashboard, /expected_snapshot_captured_at: item\.fixed_snapshot_captured_at/);
  assert.match(dashboard, /expected_comparable_fixed_age_snapshots/);
});

test('plan and batch schemas carry the versioned policy lineage', () => {
  const plan = JSON.parse(readFileSync(
    resolve('base44/entities/GrowthContentPlan.jsonc'),
    'utf8',
  ));
  const batch = JSON.parse(readFileSync(
    resolve('base44/entities/GrowthContentBatch.jsonc'),
    'utf8',
  ));
  assert.deepEqual(plan.properties.review_schema_version.enum, [
    GROWTH_REVIEW_SCHEMA_VERSION,
  ]);
  assert.deepEqual(plan.properties.review_decision_policy_id.enum, [
    GROWTH_DECISION_POLICY_ID,
  ]);
  assert.equal(plan.properties.review_decision_override_note.minLength, 24);
  assert.equal(plan.properties.review_comparable_fixed_age_snapshots.minimum, 0);
  assert.deepEqual(batch.properties.review_schema_version.enum, [
    'growth-review.v2',
    GROWTH_REVIEW_SCHEMA_VERSION,
  ]);
  assert.deepEqual(batch.properties.decision_policy_id.enum, [
    GROWTH_DECISION_POLICY_ID,
  ]);
  assert.equal(batch.properties.comparable_fixed_age_snapshots.minimum, 0);
});
