import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  runSevenDayGrowthDryRun,
} from '../scripts/dry-run-growth-seven-day.mjs';

test('seven-day dry run proves the full local video acquisition lifecycle', async (t) => {
  const script = readFileSync(
    resolve('scripts/dry-run-growth-seven-day.mjs'),
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
    throw new Error('The local dry run must never use native fetch.');
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const first = await runSevenDayGrowthDryRun();
  const second = await runSevenDayGrowthDryRun();

  assert.deepEqual(second, first, 'the dry-run report must be deterministic');
  assert.equal(nativeFetchCalls, 0);
  assert.equal(first.success, true);
  assert.equal(first.mode, 'local_in_memory');
  assert.match(first.evidence_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.bootstrap, {
    days: 7,
    concepts_per_day: 2,
    total_concepts: 14,
    artifacts_per_day: 4,
    total_artifacts: 28,
    platform_artifacts: {
      instagram: 14,
      tiktok: 14,
    },
    unique_sources: 14,
    eighth_day_rejected: true,
    llm_calls: 0,
  });
  assert.deepEqual(first.render_result_slicing, {
    weekly_artifacts: 28,
    daily_results: 7,
    artifacts_per_result: 4,
    preserved_render_descriptors: 28,
    audio_mode: 'baked_owned_or_licensed',
    audio_recipe: 'firstknock-procedural-ui-v1',
    procedural_audio_artifacts: 28,
    pre_authorization_import_rejected: true,
    pre_authorization_error: 'invalid_render_result',
  });
  assert.deepEqual(first.activation, {
    authorized_batches: 7,
    reviewed_artifacts: 28,
    approved_artifacts: 28,
    scheduled_jobs: 28,
    measurement_plans: 28,
    timezone: 'America/Phoenix',
    daily_utc_slots: ['16:30', '20:30'],
  });
  assert.deepEqual(first.metrics.checkpoint_days, [1, 3, 7, 30]);
  assert.equal(first.metrics.jobs_with_terminal_d30, 28);
  assert.equal(first.metrics.captured_checkpoints, 112);
  assert.deepEqual(first.metrics.checkpoints_by_day, {
    1: 28,
    3: 28,
    30: 28,
    7: 28,
  });
  assert.deepEqual(first.metrics.checkpoints_by_platform, {
    instagram: 56,
    tiktok: 56,
  });
  assert.equal(first.metrics.provider_reads_intercepted_locally, 112);
  assert.deepEqual(first.external_effects, {
    external_network_requests: 0,
    provider_mutations: 0,
    durable_service_writes: 0,
    filesystem_writes: 0,
    manager_fetch_calls: 0,
  });
});
