#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createGrowthBase44,
  invokeJson,
  loadGrowthHandler,
} from '../test/helpers/growthContentTestHarness.mjs';
import {
  GROWTH_DECISION_POLICY_ID,
} from '../base44/functions/_shared/growthDecisionSufficiency.js';
import {
  canonicalStringify,
  validatePack,
} from './render-growth-pack.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const MANAGER_PATH = 'base44/functions/manageGrowthContentEngine/entry.ts';
const PLAN_MANAGER_PATH = 'base44/functions/manageGrowthContentPlan/entry.ts';
const SEED_PATH = resolve(
  'config/growth-media/firstknock-weekly-rights-safe-seed.json',
);
const REVIEW_AT = '2026-08-05T17:00:00.000Z';
const PUBLISHED_AT = '2026-07-29T16:30:00.000Z';
const D7_CAPTURED_AT = '2026-08-05T16:30:00.000Z';
const TARGET_DATES = [
  '2026-08-06',
  '2026-08-07',
  '2026-08-08',
  '2026-08-09',
  '2026-08-10',
  '2026-08-11',
  '2026-08-12',
];
const PARENT = {
  platform: 'instagram',
  campaign: '1000-users',
  content: 'ig-local-synthetic-d7-winner',
};
const WINNING_HOOK = 'Turn follow-ups into the next route';
const WINNING_VARIABLE = 'Problem to visible behavior to benefit';
const REVIEW_NOTE = [
  'Repeat the concrete problem, visible FirstKnock behavior, and practical',
  'benefit pattern while changing each opening hook.',
].join(' ');
const SOCIAL_ONLY_REPEAT_OVERRIDE_NOTE = [
  'Repeat this local synthetic social pattern once because the observed native reach',
  'and engagement justify a controlled test without claiming post-level conversion.',
].join(' ');
const OBSERVED_FIELDS = [
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
const SYNTHETIC_METRICS = {
  reach: 3200,
  views: 4800,
  shares: 32,
  saves: 45,
  comments: 11,
  follows: 38,
  profile_visits: 190,
  link_clicks: 84,
  dm_intents: 9,
};
const WEEK_TWO_HOOKS = [
  'Start followups from visible outcomes',
  'Keep door outcomes in context',
  'Command route work from one view',
  'Combine selected routes with clarity',
  'Queue missed doors for another pass',
  'Turn followups into planned fieldwork',
  'Carry stop details into followups',
  'Correct a sale entry carefully',
  'Focus analytics on one day',
  'See field stages before coaching',
  'Compare matching signals side by side',
  'Keep property controls easy to scan',
  'Refresh old areas with intent',
  'Set route inputs before generating',
];

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

function controlledClock(startAt = REVIEW_AT) {
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
  };
}

function sourceRegistry(pack) {
  return pack.sources.map((source) => {
    const instagram = pack.artifacts.find((artifact) => (
      artifact.source_asset_key === source.asset_key
      && artifact.platform === 'instagram'
    ));
    return {
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
      safe_summary: [
        'Sanitized FirstKnock-owned product demo.',
        `Audited visible behavior: ${instagram?.title || source.asset_key}.`,
        `Audited product hook: ${instagram?.hook || 'FirstKnock workflow'}.`,
      ].join(' '),
      active: true,
      privacy_change_pending: false,
    };
  });
}

function parentPlan() {
  return {
    id: 'plan_local_synthetic_d7_winner',
    ...PARENT,
    sprint: 'content-engine',
    sequence: 1,
    format: 'reel',
    audience: 'Field sales teams',
    hook: WINNING_HOOK,
    script: 'Show the audited FirstKnock workflow and its next action.',
    cta_label: 'See FirstKnock',
    cta_channel: 'caption_url',
    primary_metric: 'Qualified product interest',
    hypothesis:
      'Concrete product proof can create qualified product interest.',
    comparison_group: 'local-synthetic-week-one',
    major_variable: WINNING_VARIABLE,
    planned_publish_at: PUBLISHED_AT,
    published_at: PUBLISHED_AT,
    delivery_managed_by: 'local_simulation',
    delivery_status: 'published',
    snapshot_days: 7,
    simulation_only: true,
  };
}

function matureMetric() {
  return {
    id: 'metric_local_synthetic_d7_winner',
    ...PARENT,
    snapshot_days: 7,
    snapshot_captured_at: D7_CAPTURED_AT,
    published_at: PUBLISHED_AT,
    metric_source: 'manual',
    observed_metric_fields: [...OBSERVED_FIELDS],
    ...SYNTHETIC_METRICS,
    simulation_only: true,
    evidence_classification: 'local_synthetic_fixture',
    production_eligible: false,
    source_note:
      'Deterministic local fixture only; never production performance.',
  };
}

function orderedConceptIds(pack) {
  return [...new Set(
    pack.artifacts.map((artifact) => artifact.concept_id),
  )];
}

function conceptPairs(pack) {
  const ids = orderedConceptIds(pack);
  ensure(ids.length === 14, 'week_two_seed_concept_count_invalid', ids.length);
  return Array.from(
    { length: 7 },
    (_, index) => ids.slice(index * 2, index * 2 + 2),
  );
}

function generatedConcept(pack, conceptId, hook, index) {
  const donor = pack.artifacts.find((artifact) => (
    artifact.concept_id === conceptId
    && artifact.platform === 'instagram'
  ));
  ensure(donor, 'week_two_donor_missing', conceptId);
  const feature = String(donor.title || donor.hook || 'FirstKnock workflow');
  return {
    donor_concept_id: conceptId,
    title: hook,
    hook,
    overlay_text: [
      'Name the workflow friction',
      `FirstKnock demo: ${feature}`,
      'Show the practical next step',
    ],
    shot_list: [
      'Open on the audited source.',
      'Show only the visible FirstKnock behavior.',
      'Finish on the inspected product CTA.',
    ],
    overlay_cta: 'Inspect the FirstKnock workflow',
    variants: ['instagram', 'tiktok'].map((platform) => ({
      platform,
      problem: platform === 'instagram'
        ? 'A busy field workflow can hide the next useful action.'
        : 'Busy field work can hide the next action.',
      visible_feature_behavior:
        `FirstKnock visibly demonstrates ${feature} in this product demo.`,
      practical_benefit: platform === 'instagram'
        ? 'Give the team a clearer next workflow step.'
        : 'Keep the next workflow step clear.',
      cta_label: index % 2 === 0
        ? 'Inspect FirstKnock'
        : 'See the workflow',
    })),
  };
}

function generationFor(pack, ids, hooks) {
  ensure(
    ids.length === 2 && hooks.length === 2,
    'week_two_generation_shape_invalid',
  );
  return {
    concepts: ids.map((conceptId, index) => (
      generatedConcept(pack, conceptId, hooks[index], index)
    )),
  };
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

function policyDays(managerSource, constantName) {
  const match = managerSource.match(
    new RegExp(`const ${constantName} = (\\d+);`),
  );
  const days = Number(match?.[1]);
  ensure(Number.isSafeInteger(days) && days > 0, 'week_two_policy_missing', {
    constant_name: constantName,
  });
  return days;
}

function promptEvidenceBindings(prompt, ids) {
  const value = String(prompt || '');
  return {
    decision: value.includes('Reviewed direction: repeat'),
    winning_hook: value.includes(
      `Winning hook or variable: ${WINNING_HOOK}`,
    ),
    major_variable: value.includes(
      `Major variable: ${WINNING_VARIABLE}`,
    ),
    exact_donors: ids.every((id) => value.includes(id)),
    repeat_rule: /For Repeat, preserve the proven problem\/benefit pattern/i
      .test(value),
  };
}

async function createReviewedFixture({
  pack,
  invokeLlm,
  networkAttempt,
}) {
  const clock = controlledClock();
  const { base44, entities } = createGrowthBase44({
    sources: sourceRegistry(pack),
    plans: [parentPlan()],
    metrics: [matureMetric()],
    invokeLlm,
  });
  const fetchImpl = async (...args) => {
    networkAttempt(args);
    fail('week_two_external_network_forbidden');
  };
  const planManager = loadGrowthHandler(PLAN_MANAGER_PATH, {
    base44,
    dateImpl: clock.DateImpl,
    fetchImpl,
  });
  const manager = loadGrowthHandler(MANAGER_PATH, {
    base44,
    env: {
      GROWTH_CONTENT_GENERATION_ENABLED: 'true',
      GROWTH_RENDER_PACK_SHA256S: objectSha256(pack),
    },
    dateImpl: clock.DateImpl,
    fetchImpl,
  });
  const reviewed = await invokeJson(planManager, {
    action: 'review',
    ...PARENT,
    decision: 'repeat',
    note: REVIEW_NOTE,
    decision_policy_id: GROWTH_DECISION_POLICY_ID,
    override_note: SOCIAL_ONLY_REPEAT_OVERRIDE_NOTE,
  });
  ensure(
    reviewed.status === 200
      && reviewed.body?.success === true
      && reviewed.body?.decision === 'repeat'
      && /^[a-f0-9]{64}$/.test(String(reviewed.body?.evidence_hash || '')),
    'week_two_evidence_review_failed',
    reviewed,
  );
  const plan = entities.GrowthContentPlan.records[0];
  const metric = entities.GrowthContentMetric.records[0];
  ensure(
    plan.review_evidence_hash === reviewed.body.evidence_hash
      && metric.snapshot_fingerprint === reviewed.body.evidence_hash
      && plan.review_snapshot_captured_at === D7_CAPTURED_AT
      && plan.reviewed_at === REVIEW_AT,
    'week_two_review_binding_invalid',
  );
  return {
    clock,
    entities,
    manager,
    plan,
    metric,
    review: reviewed.body,
  };
}

export async function runWeekTwoGrowthDryRun() {
  const pack = validatePack(JSON.parse(readFileSync(SEED_PATH, 'utf8')));
  const managerSource = readFileSync(resolve(MANAGER_PATH), 'utf8');
  const sourceCooldownDays = policyDays(
    managerSource,
    'SOURCE_COOLDOWN_DAYS',
  );
  const hookCooldownDays = policyDays(managerSource, 'HOOK_DEDUPE_DAYS');
  const pairs = conceptPairs(pack);
  ensure(
    WEEK_TWO_HOOKS.length === pairs.length * 2,
    'week_two_hook_fixture_count_invalid',
  );

  let externalNetworkRequests = 0;
  let pendingGeneration = null;
  let llmCalls = 0;
  const promptAudits = [];
  const localGenerator = async (request) => {
    llmCalls += 1;
    ensure(
      pendingGeneration,
      'week_two_unexpected_llm_invocation',
      { llm_call: llmCalls },
    );
    const spec = pendingGeneration;
    pendingGeneration = null;
    const bindings = promptEvidenceBindings(request?.prompt, spec.ids);
    ensure(
      Object.values(bindings).every(Boolean),
      'week_two_prompt_not_bound_to_evidence',
      { bindings, ids: spec.ids },
    );
    ensure(
      request?.add_context_from_internet === false,
      'week_two_internet_context_enabled',
    );
    promptAudits.push({
      kind: spec.kind,
      target_date: spec.targetDate,
      prompt_sha256: sha256(String(request?.prompt || '')),
      bindings,
    });
    return generationFor(pack, spec.ids, spec.hooks);
  };
  const fixture = await createReviewedFixture({
    pack,
    invokeLlm: localGenerator,
    networkAttempt: () => {
      externalNetworkRequests += 1;
    },
  });

  async function build(targetDate, ids, hooks, kind = 'week_two') {
    ensure(!pendingGeneration, 'week_two_generation_fixture_contended');
    pendingGeneration = { targetDate, ids, hooks, kind };
    const result = await invokeJson(fixture.manager, {
      action: 'build_next_batch',
      parent: PARENT,
      target_date: targetDate,
      content_profile: 'feature_explainer_video_v1',
      concept_count: 2,
      seed_concept_ids: ids,
      seed_pack: pack,
    });
    ensure(
      !pendingGeneration,
      'week_two_expected_llm_not_invoked',
      { target_date: targetDate, result },
    );
    return result;
  }

  const days = [];
  const sourceKeys = new Set();
  const sourceHashes = new Set();
  const generatedHooks = new Set();
  const artifactKeys = new Set();
  const platformArtifacts = [];

  for (let index = 0; index < TARGET_DATES.length; index += 1) {
    const targetDate = TARGET_DATES[index];
    const ids = pairs[index];
    const hooks = WEEK_TWO_HOOKS.slice(index * 2, index * 2 + 2);

    if (index === 1) {
      const sourceProbeCallsBefore = llmCalls;
      const sourceProbe = await invokeJson(fixture.manager, {
        action: 'build_next_batch',
        parent: PARENT,
        target_date: targetDate,
        content_profile: 'feature_explainer_video_v1',
        concept_count: 2,
        seed_concept_ids: pairs[0],
        seed_pack: pack,
      });
      ensure(
        sourceProbe.status === 409
          && sourceProbe.body?.error
            === 'insufficient_eligible_video_donors'
          && sourceProbe.body?.source_cooldown_days === sourceCooldownDays
          && llmCalls === sourceProbeCallsBefore,
        'week_two_source_cooldown_not_enforced',
        sourceProbe,
      );

      const hookProbe = await build(
        targetDate,
        ids,
        WEEK_TWO_HOOKS.slice(0, 2),
        'duplicate_hook_probe',
      );
      ensure(
        hookProbe.status === 502
          && hookProbe.body?.error === 'invalid_generated_batch',
        'week_two_hook_cooldown_not_enforced',
        hookProbe,
      );
      const failed = fixture.entities.GrowthContentBatch.records.find(
        (batch) => batch.target_date === targetDate,
      );
      ensure(
        failed?.state === 'failed'
          && failed?.last_error_code === 'invalid_generated_batch',
        'week_two_hook_failure_not_durable',
        failed,
      );
    }

    const built = await build(targetDate, ids, hooks);
    ensure(
      built.status === 201
        && built.body?.batch?.state === 'ready'
        && built.body?.batch?.batch_input_mode === 'reviewed_evidence'
        && built.body?.batch?.review_decision === 'repeat'
        && built.body?.batch?.evidence_hash
          === fixture.review.evidence_hash,
      'week_two_batch_build_failed',
      { target_date: targetDate, built },
    );
    const dayPack = validatePack(structuredClone(built.body.render_pack));
    ensure(
      objectSha256(dayPack) === built.body.pack_sha256
        && dayPack.sources.length === 2
        && dayPack.artifacts.length === 4
        && dayPack.artifacts.filter(
          (artifact) => artifact.platform === 'instagram',
        ).length === 2
        && dayPack.artifacts.filter(
          (artifact) => artifact.platform === 'tiktok',
        ).length === 2,
      'week_two_daily_pack_shape_invalid',
      targetDate,
    );
    for (const source of dayPack.sources) {
      ensure(
        !sourceKeys.has(source.asset_key)
          && !sourceHashes.has(source.source_sha256),
        'week_two_source_reuse_detected',
        source.asset_key,
      );
      sourceKeys.add(source.asset_key);
      sourceHashes.add(source.source_sha256);
    }
    for (const artifact of dayPack.artifacts) {
      ensure(
        artifact.format === 'video'
          && !artifactKeys.has(artifact.artifact_key)
          && artifact.caption.split(/\n{2,}/).length === 5
          && /\bFirstKnock\b/.test(artifact.caption),
        'week_two_artifact_pattern_invalid',
        artifact.artifact_key,
      );
      artifactKeys.add(artifact.artifact_key);
      generatedHooks.add(artifact.hook);
      platformArtifacts.push(artifact);
    }
    days.push({
      target_date: targetDate,
      batch_key: built.body.batch.batch_key,
      review_hash: built.body.batch.review_hash,
      evidence_hash: built.body.batch.evidence_hash,
      pack_sha256: built.body.pack_sha256,
      source_asset_keys: dayPack.sources.map((source) => source.asset_key),
      hooks,
      concept_count: new Set(
        dayPack.artifacts.map((artifact) => artifact.concept_id),
      ).size,
      artifact_count: dayPack.artifacts.length,
    });
  }

  ensure(days.length === 7, 'week_two_day_count_invalid');
  ensure(
    new Set(days.map((day) => day.batch_key)).size === 7
      && new Set(days.map((day) => day.pack_sha256)).size === 7
      && new Set(days.map((day) => day.review_hash)).size === 1
      && days.every(
        (day) => day.evidence_hash === fixture.review.evidence_hash,
      ),
    'week_two_pack_lineage_invalid',
  );
  ensure(
    sourceKeys.size === 14
      && sourceHashes.size === 14
      && artifactKeys.size === 28
      && generatedHooks.size === 14,
    'week_two_uniqueness_invalid',
  );
  ensure(
    fixture.entities.GrowthContentBatch.records.length === 7
      && fixture.entities.GrowthContentBatch.records.every(
        (batch) => batch.state === 'ready',
      )
      && fixture.entities.GrowthContentBatch.records.filter(
        (batch) => Number(batch.attempt_count) === 2,
      ).length === 1,
    'week_two_batch_retry_lifecycle_invalid',
  );
  ensure(
    fixture.entities.GrowthCreativeArtifact.records.length === 0
      && fixture.entities.GrowthPublishJob.records.length === 0,
    'week_two_crossed_human_review_gate',
  );
  ensure(
    externalNetworkRequests === 0 && !pendingGeneration,
    'week_two_external_effect_detected',
  );

  const stableEvidence = {
    evidence_hash: fixture.review.evidence_hash,
    review_hash: days[0].review_hash,
    target_dates: [...TARGET_DATES],
    batch_keys: days.map((day) => day.batch_key),
    pack_sha256s: days.map((day) => day.pack_sha256),
    prompt_sha256s: promptAudits.map((audit) => audit.prompt_sha256),
  };
  return {
    schema_version: 'growth-week-two-dry-run.v1',
    success: true,
    mode: 'local_in_memory',
    evidence_sha256: objectSha256(stableEvidence),
    decision_evidence: {
      classification: 'local_synthetic_fixture',
      production_eligible: false,
      production_performance_claimed: false,
      parent: { ...PARENT },
      published_at: PUBLISHED_AT,
      snapshot_days: 7,
      snapshot_captured_at: D7_CAPTURED_AT,
      captured_exactly_at_due: (
        Date.parse(D7_CAPTURED_AT)
          === Date.parse(PUBLISHED_AT) + 7 * 24 * 60 * 60 * 1000
      ),
      observed_metric_fields: [...OBSERVED_FIELDS],
      metrics: { ...SYNTHETIC_METRICS },
      decision: fixture.plan.review_decision,
      winning_hook: fixture.plan.hook,
      major_variable: fixture.plan.major_variable,
      review_note: fixture.plan.review_note,
      decision_policy_id: fixture.plan.review_decision_policy_id,
      decision_policy_reason_codes: [
        ...(fixture.plan.review_decision_policy_reason_codes || []),
      ],
      decision_policy_evidence_hash:
        fixture.plan.review_decision_policy_evidence_hash,
      decision_override_note: fixture.plan.review_decision_override_note,
      decision_override_hash: fixture.plan.review_decision_override_hash,
      reviewed_at: fixture.plan.reviewed_at,
      evidence_hash: fixture.review.evidence_hash,
      review_hash: days[0].review_hash,
      batches_bound_to_exact_evidence: days.length,
      prompts_bound_to_exact_evidence: promptAudits.length,
    },
    week_two: {
      days: days.length,
      concepts_per_day: 2,
      total_concepts: generatedHooks.size,
      artifacts_per_day: 4,
      total_pack_artifacts: platformArtifacts.length,
      platform_artifacts: summarizeBy(
        platformArtifacts,
        (artifact) => artifact.platform,
      ),
      distinct_batch_keys: new Set(
        days.map((day) => day.batch_key),
      ).size,
      distinct_pack_sha256s: new Set(
        days.map((day) => day.pack_sha256),
      ).size,
      unique_source_keys: sourceKeys.size,
      unique_source_bytes: sourceHashes.size,
      unique_hooks: generatedHooks.size,
      ready_for_human_review_batches:
        fixture.entities.GrowthContentBatch.records.filter(
          (batch) => batch.state === 'ready',
        ).length,
      render_authorized_batches: 0,
      persisted_creative_artifacts: 0,
      publish_jobs: 0,
    },
    decision_influence: {
      repeated_pattern:
        'problem -> visible FirstKnock behavior -> practical benefit',
      successful_batches_with_repeat_decision: days.filter(
        (day) => Boolean(day.review_hash),
      ).length,
      prompt_bindings: {
        decision: promptAudits.filter(
          (audit) => audit.bindings.decision,
        ).length,
        winning_hook: promptAudits.filter(
          (audit) => audit.bindings.winning_hook,
        ).length,
        major_variable: promptAudits.filter(
          (audit) => audit.bindings.major_variable,
        ).length,
        exact_donors: promptAudits.filter(
          (audit) => audit.bindings.exact_donors,
        ).length,
        repeat_rule: promptAudits.filter(
          (audit) => audit.bindings.repeat_rule,
        ).length,
      },
      generation_calls: llmCalls,
      successful_generation_calls: 7,
      rejected_generation_calls: 1,
    },
    cooldowns: {
      source_cooldown_days: sourceCooldownDays,
      hook_dedupe_days: hookCooldownDays,
      source_reuse_probe: {
        target_date: TARGET_DATES[1],
        days_after_first_use: 1,
        rejected_before_generation: true,
        error: 'insufficient_eligible_video_donors',
      },
      hook_reuse_probe: {
        target_date: TARGET_DATES[1],
        days_after_first_use: 1,
        rejected: true,
        error: 'invalid_generated_batch',
        same_batch_retry_succeeded: true,
      },
    },
    external_effects: {
      external_network_requests: externalNetworkRequests,
      provider_mutations: 0,
      durable_service_writes: 0,
      filesystem_writes: 0,
      production_artifact_writes: 0,
      production_publish_job_writes: 0,
    },
  };
}

const isCli = process.argv[1]
  && resolve(process.argv[1]) === resolve(SCRIPT_PATH);
if (isCli) {
  try {
    const result = await runWeekTwoGrowthDryRun();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      success: false,
      error: String(error?.code || error?.message || 'week_two_dry_run_failed'),
      ...(error?.details === undefined ? {} : { details: error.details }),
    })}\n`);
    process.exitCode = 1;
  }
}
