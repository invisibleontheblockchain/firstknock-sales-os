#!/usr/bin/env node
// MODEL 1 / PR A — read-only workflow fixture generator.
//
//   node scripts/precision-order-audit/generate-fixtures.mjs
//   node scripts/precision-order-audit/generate-fixtures.mjs --check
//
// Every fixture is produced by EXECUTING the real production handlers in
// base44/functions/*/entry.ts through the audit harness. Nothing is hand
// written. `--check` regenerates in memory and diffs against the committed
// corpus without writing, which is what the replay test uses.
//
// This tool performs no network access, contacts no provider, and mutates no
// production record. See docs/precision/pr-a-model-1/EVIDENCE_REGISTER.md.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUDIT_USER,
  FIXED_NOW_ISO,
  FIXED_NOW_MS,
  PATHS,
  SQUARE_MILE_POLYGON,
  TRIANGLE_POLYGON,
  Trace,
  activeFetchJob,
  callHandler,
  loadPrecisionHandler,
  makeBase44,
  makeStripe,
  orderBody,
  paidSubscription,
  plain,
  runConcurrentStarts,
  runStartPath,
  settledFetchJob,
  trialingSubscription
} from '../../test/helpers/precisionOrderHarness.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CORPUS_DIR = join(rootDir, 'test', 'fixtures', 'precision', 'order-to-fetchjob');

const GENERATION_COMMAND = 'node scripts/precision-order-audit/generate-fixtures.mjs';

const AUDITED_SOURCE_FILES = [
  'base44/functions/startBatchDataPull/entry.ts',
  'base44/functions/fetchAreaProperties/entry.ts',
  'base44/functions/previewBatchDataArea/entry.ts'
];

/**
 * Identifies the code that produced a fixture by the git blob hash of each
 * audited source file, NOT by `git rev-parse HEAD`.
 *
 * HEAD is self-referential here: the commit that contains a fixture cannot be
 * known while generating it, so recording HEAD makes the corpus drift on every
 * commit to this branch. Blob hashes change only when the audited code changes,
 * which is exactly the provenance a reviewer needs.
 */
function sourceBlobs() {
  const blobs = {};
  for (const path of AUDITED_SOURCE_FILES) {
    try {
      blobs[path] = execFileSync('git', ['hash-object', path], { cwd: rootDir, encoding: 'utf8' }).trim();
    } catch {
      blobs[path] = 'unknown';
    }
  }
  return blobs;
}

const paidUser = { ...AUDIT_USER, stripe_customer_id: 'cus_1' };

/* ------------------------------------------------------------- scenarios */

/**
 * Each scenario declares its C0 intent in plain language, then runs the real
 * handlers. `run` returns the raw observation; the wrapper adds provenance.
 */
const SCENARIOS = [
  {
    id: 'fixed-below-allowance',
    c0_user_intent: 'Free user draws a 1 sq mi area and types a Fixed Count of 25 with 50 available.',
    browser_state: { propertyCountMode: 'fixed', displayedRemaining: 50, typedCount: 25 },
    async run() {
      return runStartPath(PATHS.startBatchDataPull, { body: orderBody({ requested_properties: 25 }) });
    }
  },
  {
    id: 'fixed-equal-allowance',
    c0_user_intent: 'Free user types a Fixed Count exactly equal to the 50 remaining.',
    browser_state: { propertyCountMode: 'fixed', displayedRemaining: 50, typedCount: 50 },
    async run() {
      return runStartPath(PATHS.startBatchDataPull, { body: orderBody({ requested_properties: 50 }) });
    }
  },
  {
    id: 'fixed-above-allowance',
    c0_user_intent: 'Free user with 20 remaining submits a Fixed Count of 45; the server caps to 20.',
    browser_state: { propertyCountMode: 'fixed', displayedRemaining: 20, typedCount: 45 },
    async run() {
      return runStartPath(PATHS.startBatchDataPull, {
        body: orderBody({ requested_properties: 45 }),
        fetchJobs: [settledFetchJob({ id: 'job_prior', count: 30 })]
      });
    }
  },
  {
    id: 'max-available-partial',
    c0_user_intent: 'Free user picks Max Available with 30 of 50 remaining.',
    browser_state: { propertyCountMode: 'max_available', displayedRemaining: 30 },
    async run() {
      return runStartPath(PATHS.startBatchDataPull, {
        body: orderBody({ requested_properties: 30, count_mode: 'max_available' }),
        fetchJobs: [settledFetchJob({ id: 'job_prior', count: 20 })]
      });
    }
  },
  {
    id: 'max-available-concurrent-change',
    c0_user_intent: 'Max Available submitted with a stale browser snapshot of 50 after 35 were consumed.',
    browser_state: { propertyCountMode: 'max_available', displayedRemaining: 50, staleSnapshot: true },
    async run() {
      return runStartPath(PATHS.startBatchDataPull, {
        body: orderBody({ requested_properties: 50, count_mode: 'max_available' }),
        fetchJobs: [settledFetchJob({ id: 'job_prior', count: 35 })]
      });
    }
  },
  {
    id: 'fixed-quick-range',
    c0_user_intent: 'Free user selects the 6-month quick sold-date range with a Fixed Count of 20.',
    browser_state: { propertyCountMode: 'fixed', soldMonths: 6, ownershipRangeMode: 'quick' },
    async run() {
      return runStartPath(PATHS.startBatchDataPull, {
        body: orderBody({ requested_properties: 20, sold_months: 6 })
      });
    }
  },
  {
    id: 'fixed-custom-range',
    c0_user_intent: 'Pro user selects a custom 30-180 day recorded-sale window with a Fixed Count of 20.',
    browser_state: { propertyCountMode: 'fixed', ownershipRangeMode: 'custom', ownershipRangeDays: [30, 180] },
    async run() {
      return runStartPath(PATHS.startBatchDataPull, {
        user: paidUser,
        subscriptions: [trialingSubscription({})],
        body: orderBody({
          requested_properties: 20,
          ownership_range_mode: 'custom',
          ownership_min_days: 30,
          ownership_max_days: 180
        })
      });
    }
  },
  {
    id: 'max-custom-range',
    c0_user_intent: 'Paid Pro user selects Max Available with a custom 59-365 day window.',
    browser_state: { propertyCountMode: 'max_available', ownershipRangeMode: 'custom', ownershipRangeDays: [59, 365] },
    async run() {
      return runStartPath(PATHS.startBatchDataPull, {
        user: paidUser,
        subscriptions: [paidSubscription({})],
        body: orderBody({
          requested_properties: 1000,
          count_mode: 'max_available',
          ownership_range_mode: 'custom',
          ownership_min_days: 59,
          ownership_max_days: 365
        })
      });
    }
  },
  {
    id: 'home-round-trip',
    c0_user_intent: 'Free user enables Route From Home starting and ending at the saved Home Base.',
    browser_state: { routeFromHomeEnabled: true, startPointMode: 'home' },
    async run() {
      return runStartPath(PATHS.startBatchDataPull, {
        body: orderBody({
          requested_properties: 20,
          route_bounds: {
            enabled: true,
            mode: 'home_round_trip',
            startLocation: { lat: 33.9, lng: -83.4 },
            endLocation: { lat: 33.9, lng: -83.4 }
          }
        })
      });
    }
  },
  {
    id: 'current-to-home',
    c0_user_intent: 'Free user starts the route at their GPS position and ends at Home Base.',
    browser_state: { routeFromHomeEnabled: true, startPointMode: 'current' },
    async run() {
      return runStartPath(PATHS.startBatchDataPull, {
        body: orderBody({
          requested_properties: 20,
          route_bounds: {
            enabled: true,
            mode: 'current_to_home',
            startLocation: { lat: 33.951, lng: -83.357 },
            endLocation: { lat: 33.9, lng: -83.4 }
          }
        })
      });
    }
  },
  {
    id: 'exact-active-job',
    c0_user_intent: 'User resubmits the identical order while their own identical pull is still running.',
    browser_state: { propertyCountMode: 'fixed', typedCount: 25 },
    async run() {
      return runStartPath(PATHS.startBatchDataPull, {
        body: orderBody({ requested_properties: 25 }),
        fetchJobs: [activeFetchJob({ id: 'job_identical', precision_usage_reserved: 1, total_expected: 1 })]
      });
    }
  },
  {
    id: 'active-job-conflict',
    c0_user_intent: 'User submits a NEW area and criteria while an unrelated pull is still running.',
    browser_state: { propertyCountMode: 'fixed', typedCount: 40 },
    async run() {
      return runStartPath(PATHS.startBatchDataPull, {
        body: orderBody({ requested_properties: 40, sold_months: 3, min_price: null }),
        fetchJobs: [activeFetchJob({
          id: 'job_unrelated',
          polygon: TRIANGLE_POLYGON.map((point) => ({ ...point })),
          sold_months: 12,
          precision_usage_reserved: 1,
          total_expected: 1,
          dry_run_metadata: {
            requested_properties: 5,
            requested_properties_before_cap: 5,
            count_mode: 'fixed',
            filters: { min_price: 500000, max_price: 900000 },
            ownership_range_mode: 'quick',
            ownership_range_days: null,
            route_bounds: { enabled: false }
          }
        })]
      });
    }
  },
  {
    id: 'multiple-active-jobs',
    c0_user_intent: 'User submits an order while three of their pulls are simultaneously active.',
    browser_state: { propertyCountMode: 'fixed', typedCount: 20 },
    async run() {
      return runStartPath(PATHS.startBatchDataPull, {
        body: orderBody({ requested_properties: 20 }),
        fetchJobs: [
          activeFetchJob({ id: 'job_active_x', precision_usage_reserved: 1, total_expected: 1 }),
          activeFetchJob({ id: 'job_active_y', precision_usage_reserved: 1, total_expected: 1 }),
          activeFetchJob({ id: 'job_active_z', status: 'pending', precision_usage_reserved: 1, total_expected: 1 })
        ]
      });
    }
  },
  {
    id: 'fixed-below-allowance-fetchareaproperties',
    c0_user_intent: 'The SAME 25-home Fixed Count order submitted through the second start endpoint.',
    browser_state: { propertyCountMode: 'fixed', displayedRemaining: 50, typedCount: 25 },
    async run() {
      return runStartPath(PATHS.fetchAreaProperties, { body: orderBody({ requested_properties: 25 }) });
    }
  },
  {
    id: 'repull-max-since-last',
    c0_user_intent: 'User refreshes a previously pulled area in Max Since Last mode.',
    browser_state: { repullMode: 'max_since_last', isPreviousAreaPull: true },
    async run() {
      return runStartPath(PATHS.startBatchDataPull, {
        body: orderBody({
          requested_properties: 40,
          count_mode: 'max_available',
          repull_mode: 'max_since_last',
          previous_pull_date: '2026-05-01T00:00:00.000Z',
          include_unresolved_followups: true,
          sold_months: 3
        })
      });
    }
  }
];

const CONCURRENT_SCENARIOS = [
  {
    id: 'concurrent-max-available',
    c0_user_intent: 'Two tabs both submit Max Available with only 5 units left.',
    browser_state: { tabs: 2, propertyCountMode: 'max_available' },
    async run() {
      return runConcurrentStarts({
        paths: [PATHS.startBatchDataPull, PATHS.startBatchDataPull],
        bodies: [
          orderBody({ requested_properties: 50, count_mode: 'max_available' }),
          orderBody({ requested_properties: 50, count_mode: 'max_available' })
        ],
        fetchJobs: [settledFetchJob({ id: 'job_prior', count: 45 })]
      });
    }
  }
];

const PREVIEW_USAGE = {
  success: true, complete: true, version: 2, kind: 'trial',
  paid_access: false, pro_access: false, limit: 50, used: 10, reserved: 0,
  meter_used: 10, remaining: 40, lifetime_used: 10, trial_used: 10,
  trial_remaining: 40, period_start: null
};

function previewFetchResponder(url) {
  return new Response(
    JSON.stringify(url.includes('geo.fcc.gov')
      ? { County: { FIPS: '13221', name: 'Oconee' }, State: { code: 'GA', name: 'Georgia' } }
      : { results: { properties: [{}, {}, {}] } }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

async function runPreview(callCount) {
  const trace = new Trace();
  const base44 = makeBase44({
    trace,
    user: AUDIT_USER,
    invokeHandlers: { getPrecisionUsage: async () => ({ data: PREVIEW_USAGE }) }
  });
  const { handler } = loadPrecisionHandler(PATHS.previewBatchDataArea, {
    trace,
    base44,
    stripeApi: makeStripe(trace, {}),
    env: { BATCH_DATA_SANDBOX_KEY: 'sandbox_key_value' },
    fetchResponder: async (url) => previewFetchResponder(url)
  });
  const responses = [];
  for (let index = 0; index < callCount; index += 1) {
    responses.push(await callHandler(handler, {
      polygon: SQUARE_MILE_POLYGON.map((point) => ({ ...point })),
      requested_properties: 40,
      sandbox: true,
      sandbox_probe: true
    }));
  }
  return { responses, trace };
}

/* ------------------------------------------------------------ generation */

function traceDigest(trace) {
  return {
    authority_reads: trace.reads.map((event) => ({
      entity: event.name,
      filter_keys: event.detail.filter_keys,
      sort: event.detail.sort,
      limit: event.detail.limit
    })),
    writes: trace.writes.map((event) => ({
      op: event.name,
      id: event.detail.id ?? null,
      patch_keys: event.detail.patch ? Object.keys(event.detail.patch).sort() : null
    })),
    external_hosts: [...new Set(trace.externalFetches.map((event) => event.detail.host))],
    provider_requests: trace.externalFetches
      .filter((event) => event.detail.host === 'api.batchdata.com')
      .map((event) => ({ url: event.detail.url, method: event.detail.method, body: event.detail.body })),
    stripe_calls: trace.stripeCalls.map((event) => event.name),
    lock_keys: trace.named('lock', 'db.query')
      .filter((event) => String(event.detail.sql).includes('pg_advisory_xact_lock'))
      .map((event) => event.detail.params[0]),
    processor_invocations: trace.invocations.map((event) => event.name)
  };
}

function envelope(scenario, payload, blobs) {
  return {
    fixture_id: `PRA-F-${scenario.id}`,
    scenario_id: scenario.id,
    evidence_type: 'production_code_characterization',
    hand_edited: false,
    audited_source_blobs: blobs,
    generation_command: GENERATION_COMMAND,
    source_files: AUDITED_SOURCE_FILES,
    source_functions: ['Deno.serve handler', 'withPrecisionUsageLock', 'getPrecisionAllowance', 'resolvePrecisionEntitlement'],
    frozen_clock: FIXED_NOW_ISO,
    timezone: 'UTC',
    c0_user_intent: scenario.c0_user_intent,
    browser_state: scenario.browser_state,
    what_it_proves:
      'What the production Stage 0-4 code does with this exact submitted order, including the authority fields it read, the writes it made and the canonical FetchJob it persisted.',
    what_it_does_not_prove:
      'It does not prove Base44 result ordering, real Stripe responses, real BatchData behaviour, or that the browser produced this submitted request.',
    ...payload
  };
}

export async function buildCorpus() {
  const blobs = sourceBlobs();
  const files = new Map();
  const manifestEntries = [];

  for (const scenario of SCENARIOS) {
    const result = await scenario.run();
    const payload = {
      submitted_request: result.submittedBody ?? null,
      authenticated_actor: { id: AUDIT_USER.id, email: AUDIT_USER.email },
      usage_subject: result.createdJob?.precision_usage_user_id ?? null,
      workspace: null,
      response_status: result.status,
      response: plain(result.body),
      c1_effective_target: result.createdJob
        ? {
          count_mode: result.createdJob.dry_run_metadata.count_mode,
          entered_count: result.createdJob.dry_run_metadata.requested_properties_before_cap,
          effective_count: result.createdJob.precision_usage_reserved,
          polygon_hash: result.createdJob.polygon_hash,
          sold_months: result.createdJob.sold_months,
          min_price: result.createdJob.dry_run_metadata.filters.min_price,
          max_price: result.createdJob.dry_run_metadata.filters.max_price,
          ownership_range_mode: result.createdJob.dry_run_metadata.ownership_range_mode,
          ownership_range_days: result.createdJob.dry_run_metadata.ownership_range_days,
          route_bounds: result.createdJob.dry_run_metadata.route_bounds,
          reservation: result.createdJob.precision_usage_reserved
        }
        : null,
      canonical_fetch_job: result.createdJob,
      trace: traceDigest(result.trace)
    };
    const record = envelope(scenario, payload, blobs);
    files.set(`workflows/${scenario.id}.json`, record);
    if (result.createdJob) files.set(`fetchjobs/${scenario.id}.fetchjob.json`, result.createdJob);

    // Expected-output oracle: the C0 -> C1 conservation claims a reviewer can
    // check without re-reading the whole workflow record.
    files.set(`expected/${scenario.id}.expected.json`, {
      fixture_id: record.fixture_id,
      scenario_id: scenario.id,
      oracle_version: 1,
      response_status: result.status,
      response_state: result.body?.status ?? result.body?.error ?? null,
      created_fetch_job: Boolean(result.createdJob),
      submitted_count: result.submittedBody?.requested_properties ?? null,
      submitted_count_mode: result.submittedBody?.count_mode ?? null,
      persisted_entered_count: result.createdJob?.dry_run_metadata?.requested_properties_before_cap ?? null,
      persisted_effective_count: result.createdJob?.precision_usage_reserved ?? null,
      entered_count_equals_submitted:
        result.createdJob
          ? result.createdJob.dry_run_metadata.requested_properties_before_cap === result.submittedBody?.requested_properties
          : null,
      polygon_point_count_preserved:
        result.createdJob ? result.createdJob.polygon.length === result.submittedBody?.polygon?.length : null,
      persisted_min_price: result.createdJob?.dry_run_metadata?.filters?.min_price ?? null,
      persisted_sold_months: result.createdJob?.sold_months ?? null,
      persisted_ownership_range_days: result.createdJob?.dry_run_metadata?.ownership_range_days ?? null,
      persisted_route_bounds: result.createdJob?.dry_run_metadata?.route_bounds ?? null,
      persisted_repull_mode: result.createdJob?.dry_run_metadata?.repull_mode ?? null,
      criteria_schema_version_present: Boolean(result.createdJob?.dry_run_metadata?.criteria_schema_version),
      provider_contract_version_present: Boolean(result.createdJob?.dry_run_metadata?.provider_contract_version),
      workspace_id_present: Boolean(result.createdJob?.dry_run_metadata?.workspace_id),
      reservation_writes: result.trace.writes.filter((event) => event.name === 'FetchJob.create').length,
      job_mutations: result.trace.writes.filter((event) => event.name === 'FetchJob.update').length,
      processor_invocations: result.trace.invocations.length
    });

    manifestEntries.push({
      fixture_id: record.fixture_id,
      scenario_id: scenario.id,
      kind: 'start_path_workflow',
      created_fetch_job: Boolean(result.createdJob),
      response_status: result.status
    });
  }

  for (const scenario of CONCURRENT_SCENARIOS) {
    const result = await scenario.run();
    const record = envelope(scenario, {
      submitted_request: null,
      authenticated_actor: { id: AUDIT_USER.id, email: AUDIT_USER.email },
      response_statuses: result.responses.map((response) => response.status),
      responses: result.responses.map((response) => plain(response.body)),
      canonical_fetch_jobs: result.createdJobs,
      total_reserved: result.createdJobs.reduce((sum, job) => sum + Number(job.precision_usage_reserved || 0), 0),
      trace: traceDigest(result.trace)
    }, blobs);
    files.set(`workflows/${scenario.id}.json`, record);
    manifestEntries.push({
      fixture_id: record.fixture_id,
      scenario_id: scenario.id,
      kind: 'concurrent_start_workflow',
      created_fetch_job: result.createdJobs.length > 0,
      response_status: null
    });
  }

  for (const [id, callCount, intent] of [
    ['preview-single', 1, 'User clicks Preview once on a drawn area.'],
    ['preview-identical-repeat', 3, 'User clicks Preview three times on the same unchanged area.']
  ]) {
    const { responses, trace } = await runPreview(callCount);
    const scenario = { id, c0_user_intent: intent, browser_state: { previewClicks: callCount } };
    const record = envelope(scenario, {
      submitted_request: {
        polygon: SQUARE_MILE_POLYGON.map((point) => ({ ...point })),
        requested_properties: 40,
        sandbox: true,
        sandbox_probe: true
      },
      authenticated_actor: { id: AUDIT_USER.id, email: AUDIT_USER.email },
      response_statuses: responses.map((response) => response.status),
      responses: responses.map((response) => plain(response.body)),
      canonical_fetch_job: null,
      reservation: null,
      trace: traceDigest(trace)
    }, blobs);
    files.set(`workflows/${id}.json`, record);
    manifestEntries.push({
      fixture_id: record.fixture_id,
      scenario_id: id,
      kind: 'preview_workflow',
      created_fetch_job: false,
      response_status: responses[0].status
    });
  }

  files.set('manifest.json', {
    manifest_version: 1,
    audited_source_blobs: blobs,
    generation_command: GENERATION_COMMAND,
    frozen_clock: FIXED_NOW_ISO,
    frozen_clock_ms: FIXED_NOW_MS,
    evidence_type: 'production_code_characterization',
    hand_edited: false,
    redactions: 'none — no real user, subscription, address or provider record is present',
    audited_paths: [PATHS.startBatchDataPull, PATHS.fetchAreaProperties, PATHS.previewBatchDataArea],
    fixtures: manifestEntries
  });

  return files;
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function main() {
  const check = process.argv.includes('--check');
  const files = await buildCorpus();

  if (check) {
    const problems = [];
    for (const [relative, value] of files) {
      const target = join(CORPUS_DIR, relative);
      if (!existsSync(target)) {
        problems.push(`missing: ${relative}`);
        continue;
      }
      if (readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== stableStringify(value)) {
        problems.push(`drifted: ${relative}`);
      }
    }
    if (problems.length > 0) {
      console.error(`fixture corpus is out of date:\n${problems.join('\n')}`);
      process.exit(1);
    }
    console.log(`fixture corpus matches production behaviour (${files.size} files)`);
    return;
  }

  rmSync(CORPUS_DIR, { recursive: true, force: true });
  for (const [relative, value] of files) {
    const target = join(CORPUS_DIR, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, stableStringify(value), 'utf8');
  }
  console.log(`wrote ${files.size} fixture files to ${CORPUS_DIR}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}
