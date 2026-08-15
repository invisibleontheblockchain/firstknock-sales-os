import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  runWeekTwoGrowthDryRun,
} from '../scripts/dry-run-growth-week-two.mjs';

test('week-two dry run turns honest local D7 evidence into seven reviewed packs', async (t) => {
  const script = readFileSync(
    resolve('scripts/dry-run-growth-week-two.mjs'),
    'utf8',
  );
  assert.doesNotMatch(
    script,
    /\b(?:appendFile|mkdir|rename|rm|unlink|writeFile)\s*\(/,
  );
  assert.doesNotMatch(script, /\bfetch\s*\(/);

  const originalFetch = globalThis.fetch;
  let nativeFetchCalls = 0;
  globalThis.fetch = async () => {
    nativeFetchCalls += 1;
    throw new Error('The local week-two dry run must never use native fetch.');
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const first = await runWeekTwoGrowthDryRun();
  const second = await runWeekTwoGrowthDryRun();

  assert.deepEqual(second, first, 'the week-two report must be deterministic');
  assert.equal(nativeFetchCalls, 0);
  assert.equal(first.success, true);
  assert.equal(first.mode, 'local_in_memory');
  assert.match(first.evidence_sha256, /^[a-f0-9]{64}$/);

  assert.equal(first.decision_evidence.classification,
    'local_synthetic_fixture');
  assert.equal(first.decision_evidence.production_eligible, false);
  assert.equal(first.decision_evidence.production_performance_claimed, false);
  assert.equal(first.decision_evidence.snapshot_days, 7);
  assert.equal(first.decision_evidence.captured_exactly_at_due, true);
  assert.deepEqual(
    first.decision_evidence.observed_metric_fields,
    [
      'reach',
      'views',
      'shares',
      'saves',
      'comments',
      'follows',
      'profile_visits',
      'link_clicks',
      'dm_intents',
    ],
  );
  assert.equal(first.decision_evidence.decision, 'repeat');
  assert.match(first.decision_evidence.evidence_hash, /^[a-f0-9]{64}$/);
  assert.match(first.decision_evidence.review_hash, /^[a-f0-9]{64}$/);
  assert.equal(first.decision_evidence.batches_bound_to_exact_evidence, 7);
  assert.equal(first.decision_evidence.prompts_bound_to_exact_evidence, 8);

  assert.deepEqual(first.week_two, {
    days: 7,
    concepts_per_day: 2,
    total_concepts: 14,
    artifacts_per_day: 4,
    total_pack_artifacts: 28,
    platform_artifacts: {
      instagram: 14,
      tiktok: 14,
    },
    distinct_batch_keys: 7,
    distinct_pack_sha256s: 7,
    unique_source_keys: 14,
    unique_source_bytes: 14,
    unique_hooks: 14,
    ready_for_human_review_batches: 7,
    render_authorized_batches: 0,
    persisted_creative_artifacts: 0,
    publish_jobs: 0,
  });

  assert.equal(
    first.decision_influence.repeated_pattern,
    'problem -> visible FirstKnock behavior -> practical benefit',
  );
  assert.equal(
    first.decision_influence.successful_batches_with_repeat_decision,
    7,
  );
  assert.deepEqual(first.decision_influence.prompt_bindings, {
    decision: 8,
    winning_hook: 8,
    major_variable: 8,
    exact_donors: 8,
    repeat_rule: 8,
  });
  assert.equal(first.decision_influence.generation_calls, 8);
  assert.equal(first.decision_influence.successful_generation_calls, 7);
  assert.equal(first.decision_influence.rejected_generation_calls, 1);

  assert.equal(first.cooldowns.source_cooldown_days, 7);
  assert.equal(first.cooldowns.hook_dedupe_days, 28);
  assert.deepEqual(first.cooldowns.source_reuse_probe, {
    target_date: '2026-08-07',
    days_after_first_use: 1,
    rejected_before_generation: true,
    error: 'insufficient_eligible_video_donors',
  });
  assert.deepEqual(first.cooldowns.hook_reuse_probe, {
    target_date: '2026-08-07',
    days_after_first_use: 1,
    rejected: true,
    error: 'invalid_generated_batch',
    same_batch_retry_succeeded: true,
  });

  assert.deepEqual(first.external_effects, {
    external_network_requests: 0,
    provider_mutations: 0,
    durable_service_writes: 0,
    filesystem_writes: 0,
    production_artifact_writes: 0,
    production_publish_job_writes: 0,
  });
});
