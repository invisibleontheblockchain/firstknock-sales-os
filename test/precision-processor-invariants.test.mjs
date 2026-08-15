import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import {
  evaluatePrecisionStartSafety,
  loadAndValidatePrecisionRetry,
  precisionPolygonHash,
} from '../base44/functions/_shared/precisionActiveJobCriteria.js';

const processPath = 'base44/functions/processFetchChunk/entry.ts';
const sharedPath = 'base44/functions/_shared/precisionActiveJobCriteria.js';
const leasePath = 'base44/functions/_shared/precisionProcessorLease.js';
const polygon = [
  { lat: 33.4, lng: -112.2 },
  { lat: 33.6, lng: -112.2 },
  { lat: 33.6, lng: -112.0 },
  { lat: 33.4, lng: -112.0 },
];
const routeFilters = {
  propertyTypes: ['Single Family'],
  excludeCommercial: true,
  excludeCondos: true,
  excludeLand: true,
};

async function runningJob(overrides = {}) {
  const hash = await precisionPolygonHash(polygon);
  const criteriaOverrides = overrides.criteria || {};
  return {
    id: 'running_1',
    status: 'pending',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    phase: 'batchdata_precision',
    progress_pct: 0,
    include_mls: false,
    user_email: 'original@example.com',
    precision_usage_user_id: 'user_1',
    precision_usage_reserved: 50,
    precision_usage_count: 0,
    created_date: '2026-07-25T12:00:00.000Z',
    updated_date: '2026-07-25T12:01:00.000Z',
    polygon,
    polygon_hash: hash,
    total_expected: 50,
    estimated_record_count: 50,
    dry_run_metadata: {
      criteria_reference_at: '2026-07-25T12:00:00.000Z',
      processor_token_hash: '2869975ee89a6629ebabba07b896d9fe8114230f56a6531c49f05749a37bfe14',
      workspace_id: 'manager_1',
      precision_criteria: {
        criteria_schema_version: 1,
        polygon_hash: hash,
        count_mode: 'fixed',
        entered_count: 50,
        effective_count: 50,
        min_price: 100000,
        max_price: null,
        sold_months: 12,
        ownership_range_mode: 'quick',
        ownership_range_days: null,
        route_filters: routeFilters,
        repull_mode: 'new_area',
        previous_pull_date: null,
        force_full_refresh: false,
        include_unresolved_followups: false,
        route_bounds: { enabled: false },
        immutable_user_id: 'user_1',
        workspace_id: 'manager_1',
        ...criteriaOverrides,
      },
    },
    error_log: [],
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'criteria')),
  };
}

function loadHandler(job, {
  persistedCount = 0,
  claimUpdated = 1,
  additionalJobs = [],
  providerFetch = null,
  clientQueryHook = null,
} = {}) {
  let handler;
  let fetchCalls = 0;
  const updates = [];
  const userUpdates = [];
  let userFilterCalls = 0;
  const pipelineLocks = [];
  const clientQueries = [];
  const jobs = [job, ...additionalJobs];
  class FakeClient {
    async connect() {}
    async query(sql) {
      clientQueries.push(String(sql));
      if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ claimed: true }] };
      if (typeof clientQueryHook === 'function') {
        const result = await clientQueryHook(String(sql));
        if (result !== undefined) return result;
      }
      return { rows: [] };
    }
    async end() {}
  }
  const sql = async () => [{ count: persistedCount }];
  const base44 = {
    asServiceRole: {
      entities: {
        FetchJob: {
          get: async id => jobs.find(candidate => candidate.id === id) || null,
          filter: async (filter, _sort, limit = 500, skip = 0) => jobs
            .filter(candidate => Object.entries(filter).every(([key, value]) => candidate[key] === value))
            .slice(skip, skip + limit),
          update: async (id, values) => {
            updates.push(values);
            const target = jobs.find(candidate => candidate.id === id);
            Object.assign(target, values);
            return target;
          },
          updateMany: async (filter, mutation) => {
            const isPaidProviderClaim = (
              mutation?.$set?.status === 'running'
              && mutation?.$set?.phase === 'batchdata_requesting'
              && Boolean(mutation?.$set?.dry_run_metadata?.provider_attempt_id)
            );
            if (isPaidProviderClaim && claimUpdated !== 1) {
              return { success: true, updated: claimUpdated };
            }
            const target = jobs.find(candidate =>
              Object.entries(filter).every(([key, value]) => candidate[key] === value)
            );
            if (!target) return { success: true, updated: 0 };
            Object.assign(target, mutation.$set || {});
            return { success: true, updated: 1 };
          },
        },
        User: {
          get: async id => id === 'user_1'
            ? {
                id: 'user_1',
                email: 'current@example.com',
                team_manager_id: 'manager_1',
              }
            : null,
          filter: async () => {
            userFilterCalls += 1;
            return [];
          },
          update: async (id, values) => {
            userUpdates.push({ id, values });
          },
        },
        PipelineLock: {
          filter: async () => [],
          create: async values => {
            const lock = { id: `lock_${pipelineLocks.length + 1}`, ...values };
            pipelineLocks.push(lock);
            return lock;
          },
          delete: async id => {
            const index = pipelineLocks.findIndex(lock => lock.id === id);
            if (index >= 0) pipelineLocks.splice(index, 1);
          },
        },
      },
    },
  };
  const shared = readFileSync(sharedPath, 'utf8').replace(/^export\s+/gm, '');
  const lease = readFileSync(leasePath, 'utf8').replace(/^export\s+/gm, '');
  const process = readFileSync(processPath, 'utf8').replace(/^import[\s\S]*?;\r?\n/gm, '');
  vm.runInNewContext(`${shared}\n${lease}\n${process}`, {
    console,
    createClientFromRequest: () => base44,
    Client: FakeClient,
    neon: () => sql,
    Deno: {
      env: {
        get: key => {
          if (key === 'DATABASE_URL') return 'postgres://test';
          if (key === 'BATCH_DATA_API_KEY') return 'batchdata_test';
          if (key === 'PRECISION_DIAGNOSTIC_SECRET') return 'diagnostic_test';
          return null;
        },
      },
      serve: callback => { handler = callback; },
    },
    Request,
    Response,
    TextEncoder,
    crypto: globalThis.crypto,
    AbortController,
    fetch: async (...args) => {
      fetchCalls += 1;
      if (typeof providerFetch === 'function') {
        return providerFetch({ call: fetchCalls, args });
      }
      return new Response(JSON.stringify({ results: { properties: [] } }));
    },
    setTimeout,
    clearTimeout,
  }, { filename: processPath });
  return {
    handler,
    updates,
    userUpdates,
    clientQueries,
    userFilterCallCount: () => userFilterCalls,
    fetchCallCount: () => fetchCalls,
  };
}

async function invoke(handler, body = {}) {
  const response = await handler(new Request('https://app.example.com/process', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      job_id: 'running_1',
      expected_chunk: 0,
      processor_token: 'processor_secret',
      ...body,
    }),
  }));
  return { response, result: await response.json() };
}

test('invalid criteria, polygon, MLS, and reservation evidence settle without provider calls', async () => {
  const cases = [
    {
      name: 'include_mls enabled',
      mutate: job => { job.include_mls = true; },
      error: 'precision_include_mls_invariant_violation',
    },
    {
      name: 'criteria incomplete',
      mutate: job => { delete job.dry_run_metadata.precision_criteria.force_full_refresh; },
      error: 'legacy_precision_criteria_unverifiable',
    },
    {
      name: 'polygon hash mismatch',
      mutate: job => { job.polygon_hash = '0000000000000000'; },
      error: 'precision_job_polygon_unverifiable',
    },
    {
      name: 'reservation target mismatch',
      mutate: job => { job.precision_usage_reserved = 49; },
      error: 'precision_reservation_unverifiable',
    },
  ];

  for (const scenario of cases) {
    const job = await runningJob();
    scenario.mutate(job);
    const harness = loadHandler(job);
    const { response, result } = await invoke(harness.handler);

    assert.equal(response.status, 409, scenario.name);
    assert.equal(result.error, scenario.error, scenario.name);
    assert.equal(harness.fetchCallCount(), 0, scenario.name);
    assert.equal(job.status, 'failed', scenario.name);
    assert.equal(job.precision_usage_reserved, 0, scenario.name);
    assert.equal(job.precision_usage_count, 0, scenario.name);
    assert.ok(job.precision_usage_recorded_at, scenario.name);
    if (scenario.name === 'criteria incomplete') {
      assert.match(
        job.error_log.at(-1),
        /invalid_reasons=\[\{"field":"precision_criteria\.force_full_refresh","reason":"missing"\}\]/
      );
      assert.doesNotMatch(job.error_log.at(-1), /processor_secret|original@example\.com/);
    }
  }
});

test('live synthetic records are rejected even when a processor token is valid', async () => {
  const job = await runningJob();
  const harness = loadHandler(job);
  const { response, result } = await invoke(harness.handler, {
    synthetic_records: [{ fabricated: true }],
  });

  assert.equal(response.status, 400);
  assert.equal(result.error, 'live_synthetic_ingestion_forbidden');
  assert.equal(harness.fetchCallCount(), 0);
  assert.equal(job.status, 'pending');
  assert.equal(harness.updates.length, 0);
});

test('owner-readable plaintext or a wrong token cannot authorize the processor', async () => {
  const legacyPlaintextJob = await runningJob();
  legacyPlaintextJob.dry_run_metadata.processor_token = 'processor_secret';
  delete legacyPlaintextJob.dry_run_metadata.processor_token_hash;
  const legacyHarness = loadHandler(legacyPlaintextJob);
  const legacyResult = await invoke(legacyHarness.handler);
  assert.equal(legacyResult.response.status, 403);
  assert.equal(legacyHarness.fetchCallCount(), 0);
  assert.equal(legacyHarness.updates.length, 0);

  const hashedJob = await runningJob();
  const hashedHarness = loadHandler(hashedJob);
  const wrong = await invoke(hashedHarness.handler, { processor_token: 'wrong_secret' });
  assert.equal(wrong.response.status, 403);
  assert.equal(hashedHarness.fetchCallCount(), 0);
  assert.equal(hashedHarness.updates.length, 0);
});

test('anonymous diagnostic modes reveal no configuration state', async () => {
  const job = await runningJob();
  const harness = loadHandler(job);
  const { response, result } = await invoke(harness.handler, { self_test: true });

  assert.equal(response.status, 403);
  assert.equal(result.error, 'precision_diagnostic_unauthorized');
  assert.equal(Object.hasOwn(result, 'has_batchdata_key'), false);
  assert.equal(Object.hasOwn(result, 'has_database_url'), false);
  assert.equal(harness.fetchCallCount(), 0);
});

test('authorized self-test pins the paid provider dataset scope', async () => {
  const job = await runningJob();
  const harness = loadHandler(job);
  const response = await harness.handler(new Request('https://app.example.com/process', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-precision-diagnostic-secret': 'diagnostic_test',
    },
    body: JSON.stringify({ self_test: true }),
  }));
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.dataset_scope, 'basic_deed_owner_for_sale_evidence');
  assert.deepEqual(result.datasets, ['basic', 'deed', 'owner']);
  assert.equal(harness.fetchCallCount(), 0);
});

test('processor mapping excludes future quick and max-since sold dates', async () => {
  const futureRecord = {
    property: {
      ids: { propertyId: 'future_property' },
      address: {
        street: '100 Future Ave',
        city: 'Phoenix',
        state: 'AZ',
        zip: '85001',
        location: {
          latitude: 33.5,
          longitude: -112.1,
        },
      },
      intel: {
        lastSoldDate: '2026-07-26T00:00:00.000Z',
        estimatedValue: 250000,
      },
      general: {
        standardizedLandUseCode: 'R2',
        propertyType: 'Single Family',
      },
    },
  };
  const jobs = [
    await runningJob(),
    await runningJob({
      sold_months: 1 / 30,
      criteria: {
        sold_months: 1 / 30,
        repull_mode: 'max_since_last',
        previous_pull_date: '2026-07-24T12:00:00.000Z',
      },
    }),
  ];

  for (const job of jobs) {
    const harness = loadHandler(job);
    const response = await harness.handler(new Request('https://app.example.com/process', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-precision-diagnostic-secret': 'diagnostic_test',
      },
      body: JSON.stringify({
        map_preview: true,
        job,
        synthetic_records: [futureRecord],
      }),
    }));
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.mapped, 1);
    assert.equal(result.active, 0);
    assert.equal(result.properties[0].route_active, false);
    assert.equal(harness.fetchCallCount(), 0);
  }
});

test('successful completion updates the immutable subject after an email change', async () => {
  const job = await runningJob({
    user_email: 'persisted-old@example.com',
  });
  const harness = loadHandler(job);
  const { response, result } = await invoke(harness.handler);

  assert.equal(response.status, 200);
  assert.equal(result.status, 'completed');
  assert.equal(job.status, 'completed');
  assert.equal(harness.userFilterCallCount(), 0);
  assert.equal(harness.userUpdates.length, 1);
  assert.equal(harness.userUpdates[0].id, 'user_1');
  assert.equal(harness.userUpdates[0].values.has_pulled_data, true);
  assert.equal(harness.userUpdates[0].values.last_data_pull, job.completed_at);
});

test('inactive unsettled terminals exact-settle without another provider call', async () => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    const job = await runningJob({
      status,
      precision_usage_reserved: 50,
      precision_usage_count: 0,
    });
    const harness = loadHandler(job, { persistedCount: 7 });
    const { response, result } = await invoke(harness.handler);

    assert.equal(response.status, 200, status);
    assert.equal(harness.fetchCallCount(), 0, status);
    assert.equal(job.status, status, status);
    assert.equal(job.precision_usage_reserved, 0, status);
    assert.equal(job.precision_usage_count, 7, status);
    assert.ok(job.precision_usage_recorded_at, status);
    if (status === 'cancelled') {
      assert.equal(result.status, 'cancelled');
    } else {
      assert.equal(result.status, status);
      assert.equal(result.settlement_repaired, true);
    }
  }
});

test('recovery exact-settles preexisting job delivery without replaying the paid provider', async () => {
  const job = await runningJob();
  const originalRecordedAt = job.precision_usage_recorded_at;
  const harness = loadHandler(job, { persistedCount: 7 });
  const { response, result } = await invoke(harness.handler);

  assert.equal(response.status, 200);
  assert.equal(result.provider_replay_blocked, true);
  assert.equal(result.settlement_repaired, true);
  assert.equal(harness.fetchCallCount(), 0);
  assert.equal(job.status, 'failed');
  assert.equal(job.precision_usage_reserved, 0);
  assert.equal(job.precision_usage_count, 7);
  assert.ok(job.precision_usage_recorded_at);
  assert.notEqual(job.precision_usage_recorded_at, originalRecordedAt);
});

test('running or provider-progress jobs fail closed even when no persisted row survived', async () => {
  const scenarios = [
    { name: 'running status', overrides: { status: 'running' } },
    {
      name: 'pending provider phase',
      overrides: {
        status: 'pending',
        phase: 'batchdata_requesting',
        progress_pct: 5,
      },
    },
  ];
  for (const scenario of scenarios) {
    const job = await runningJob(scenario.overrides);
    const harness = loadHandler(job, { persistedCount: 0 });
    const { response, result } = await invoke(harness.handler);

    assert.equal(response.status, 200, scenario.name);
    assert.equal(result.provider_replay_blocked, true, scenario.name);
    assert.equal(harness.fetchCallCount(), 0, scenario.name);
    assert.equal(job.status, 'failed', scenario.name);
    assert.equal(job.precision_usage_reserved, 0, scenario.name);
    assert.equal(job.precision_usage_count, 0, scenario.name);
    assert.ok(job.precision_usage_recorded_at, scenario.name);
  }
});

test('a lost durable provider claim makes zero provider calls and preserves the reservation', async () => {
  const job = await runningJob();
  const harness = loadHandler(job, { claimUpdated: 0 });
  const { response, result } = await invoke(harness.handler);

  assert.equal(response.status, 409);
  assert.equal(result.reason, 'processor_claim_not_acquired');
  assert.equal(harness.fetchCallCount(), 0);
  assert.equal(job.status, 'pending');
  assert.equal(job.precision_usage_reserved, 50);
  assert.equal(job.precision_usage_recorded_at, undefined);
});

test('a repeated full provider page stops after two paid calls and creates a replay hold', async () => {
  const repeatedPage = Array.from({ length: 100 }, (_, index) => ({
    property: {
      ids: { propertyId: `repeated_${index}` },
    },
  }));
  const job = await runningJob();
  const harness = loadHandler(job, {
    providerFetch: async () => new Response(JSON.stringify({
      results: {
        properties: repeatedPage,
        totalRecordCount: 1000,
      },
    })),
  });

  const { response, result } = await invoke(harness.handler);

  assert.equal(response.status, 502);
  assert.equal(result.error, 'precision_provider_outcome_unverifiable');
  assert.equal(harness.fetchCallCount(), 2);
  assert.equal(job.status, 'failed');
  assert.equal(job.precision_usage_reserved, 0);
  assert.equal(job.precision_usage_count, 0);
  assert.ok(job.precision_usage_recorded_at);
  assert.ok(job.dry_run_metadata.provider_attempt_id);
  assert.ok(job.dry_run_metadata.provider_outcome_unverifiable_at);
});

test('contradictory provider totals fail closed without another paid pagination call', async () => {
  const scenarios = [
    {
      name: 'short page below declared total',
      pages: [{
        count: 10,
        prefix: 'short',
        total: 1000,
      }],
      expectedCalls: 1,
    },
    {
      name: 'declared total changes between pages',
      pages: [
        { count: 100, prefix: 'first', total: 1000 },
        { count: 100, prefix: 'second', total: 900 },
      ],
      expectedCalls: 2,
    },
    {
      name: 'declared total presence changes between pages',
      pages: [
        { count: 100, prefix: 'first_without_total', total: undefined },
        { count: 100, prefix: 'second_with_total', total: 900 },
      ],
      expectedCalls: 2,
    },
    {
      name: 'page exceeds requested take',
      pages: [{
        count: 101,
        prefix: 'oversized',
        total: 101,
      }],
      expectedCalls: 1,
    },
    {
      name: 'declared zero total includes records',
      pages: [{
        count: 1,
        prefix: 'impossible_zero_total',
        total: 0,
      }],
      expectedCalls: 1,
    },
    {
      name: 'cumulative records exceed declared total',
      pages: [
        { count: 100, prefix: 'within_total', total: 150 },
        { count: 60, prefix: 'beyond_total', total: 150 },
      ],
      expectedCalls: 2,
    },
  ];

  for (const scenario of scenarios) {
    const job = await runningJob();
    const harness = loadHandler(job, {
      providerFetch: async ({ call }) => {
        const page = scenario.pages[Math.min(call - 1, scenario.pages.length - 1)];
        return new Response(JSON.stringify({
          results: {
            properties: Array.from({ length: page.count }, (_, index) => ({
              property: {
                ids: { propertyId: `${page.prefix}_${index}` },
              },
            })),
            totalRecordCount: page.total,
          },
        }));
      },
    });

    const { response, result } = await invoke(harness.handler);

    assert.equal(response.status, 502, scenario.name);
    assert.equal(result.error, 'precision_provider_outcome_unverifiable', scenario.name);
    assert.equal(harness.fetchCallCount(), scenario.expectedCalls, scenario.name);
    assert.equal(job.status, 'failed', scenario.name);
    assert.equal(job.precision_usage_reserved, 0, scenario.name);
    assert.equal(job.precision_usage_count, 0, scenario.name);
    assert.ok(job.dry_run_metadata.provider_outcome_unverifiable_at, scenario.name);
  }
});

test('rejected provider samples never mutate an excluded saved-route property', async () => {
  const job = await runningJob();
  job.dry_run_metadata.excluded_route_hashes = ['100 TEST AVE|85001'];
  const rejectedSavedRouteRecord = {
    property: {
      ids: { propertyId: 'saved_route_property' },
      address: {
        street: '100 Test Ave',
        city: 'Phoenix',
        state: 'AZ',
        zip: '85001',
        location: {
          latitude: 33.5,
          longitude: -112.1,
        },
      },
      intel: {
        lastSoldDate: '2026-07-26T00:00:00.000Z',
        estimatedValue: 250000,
      },
      general: {
        standardizedLandUseCode: 'R2',
        propertyType: 'Single Family',
      },
    },
  };
  const harness = loadHandler(job, {
    providerFetch: async () => new Response(JSON.stringify({
      results: {
        properties: [rejectedSavedRouteRecord],
        totalRecordCount: 1,
      },
    })),
  });

  const { response, result } = await invoke(harness.handler);

  assert.equal(response.status, 200);
  assert.equal(result.status, 'completed');
  assert.equal(result.active, 0);
  assert.equal(job.precision_usage_count, 0);
  assert.equal(
    harness.clientQueries.some(query => (
      query.includes('INSERT INTO properties')
      || query.includes('UPDATE properties SET')
      || query.includes('INSERT INTO workspace_properties')
    )),
    false
  );
});

test('a mid-write database failure rolls back every property mutation before exact settlement', async () => {
  const job = await runningJob();
  const providerRecord = {
    property: {
      ids: { propertyId: 'rollback_property' },
      address: {
        street: '101 Rollback Ave',
        city: 'Phoenix',
        state: 'AZ',
        zip: '85001',
        location: {
          latitude: 33.5,
          longitude: -112.1,
        },
      },
      intel: {
        lastSoldDate: '2026-01-15T00:00:00.000Z',
        estimatedValue: 250000,
      },
      general: {
        standardizedLandUseCode: 'R2',
        propertyType: 'Single Family',
      },
    },
  };
  const harness = loadHandler(job, {
    providerFetch: async () => new Response(JSON.stringify({
      results: {
        properties: [providerRecord],
        totalRecordCount: 1,
      },
    })),
    clientQueryHook: async sql => {
      if (sql.includes('INSERT INTO properties')) {
        return { rows: [{ id: 42 }] };
      }
      if (sql.includes('INSERT INTO workspace_properties')) {
        throw new Error('simulated workspace link failure');
      }
      return undefined;
    },
  });

  const { response, result } = await invoke(harness.handler);
  const propertyInsert = harness.clientQueries.findIndex(
    query => query.includes('INSERT INTO properties')
  );
  const rollback = harness.clientQueries.findIndex(
    query => query.trim() === 'ROLLBACK'
  );

  assert.equal(response.status, 502);
  assert.equal(result.error, 'precision_provider_outcome_unverifiable');
  assert.equal(harness.fetchCallCount(), 1);
  assert.ok(propertyInsert >= 0);
  assert.ok(rollback > propertyInsert);
  assert.equal(
    harness.clientQueries.some(query => query.trim() === 'COMMIT'),
    false
  );
  assert.equal(job.status, 'failed');
  assert.equal(job.precision_usage_reserved, 0);
  assert.equal(job.precision_usage_count, 0);
  assert.ok(job.precision_usage_recorded_at);
});

test('recovery intent after paid dispatch creates a global fresh-start and retry hold', async () => {
  const job = await runningJob();
  const harness = loadHandler(job, {
    providerFetch: async () => {
      job.precision_watchdog_recovery_at = new Date().toISOString();
      return new Response(JSON.stringify({
        results: {
          properties: [],
          totalRecordCount: 0,
        },
      }));
    },
  });

  const { response, result } = await invoke(harness.handler);

  assert.equal(response.status, 502);
  assert.equal(result.error, 'precision_provider_outcome_unverifiable');
  assert.equal(harness.fetchCallCount(), 1);
  assert.equal(job.status, 'failed');
  assert.equal(job.precision_usage_reserved, 0);
  assert.equal(job.precision_usage_count, 0);
  assert.ok(job.dry_run_metadata.provider_attempt_id);
  assert.ok(job.dry_run_metadata.provider_outcome_unverifiable_at);

  const safety = evaluatePrecisionStartSafety([job]);
  assert.equal(safety.start_available, false);
  assert.equal(
    safety.start_blocker_code,
    'precision_provider_outcome_unverifiable'
  );
  await assert.rejects(
    () => loadAndValidatePrecisionRetry({
      asServiceRole: {
        entities: {
          FetchJob: {
            get: async id => id === job.id ? job : null,
            filter: async filter => (
              Object.entries(filter).every(([key, value]) => job[key] === value)
                ? [job]
                : []
            ),
          },
        },
      },
    }, {
      id: 'user_1',
      email: 'current@example.com',
      team_manager_id: 'manager_1',
    }, job.id),
    error => error.code === 'precision_retry_provider_outcome_unverifiable'
  );
});

test('multiple active jobs produce a visible conflict without selecting or mutating either job', async () => {
  const job = await runningJob({ id: 'running_1' });
  const other = await runningJob({ id: 'running_2' });
  const harness = loadHandler(job, {
    additionalJobs: [other],
  });
  const { response, result } = await invoke(harness.handler);

  assert.equal(response.status, 409);
  assert.equal(result.error, 'multiple_active_precision_jobs');
  assert.equal(harness.fetchCallCount(), 0);
  assert.deepEqual([...result.active_job_ids].sort(), ['running_1', 'running_2']);
  assert.equal(job.status, 'pending');
  assert.equal(job.precision_usage_reserved, 50);
  assert.equal(job.precision_usage_count, 0);
  assert.equal(job.precision_usage_recorded_at, undefined);
  assert.equal(other.status, 'pending');
});
