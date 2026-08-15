import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import {
  precisionPolygonHash,
  precisionProcessorTokenHash,
} from '../base44/functions/_shared/precisionActiveJobCriteria.js';

const endpointPath = 'base44/functions/fetchJobStatus/entry.ts';
const sharedPath = 'base44/functions/_shared/precisionActiveJobCriteria.js';
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

async function precisionJob(overrides = {}) {
  const hash = await precisionPolygonHash(polygon);
  return {
    id: 'job_1',
    status: 'running',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    include_mls: false,
    precision_usage_user_id: 'user_1',
    precision_usage_reserved: 50,
    precision_usage_count: 0,
    processor_claim_id: null,
    user_email: 'prior@example.com',
    created_date: new Date().toISOString(),
    updated_date: new Date().toISOString(),
    polygon,
    polygon_hash: hash,
    dry_run_metadata: {
      criteria_reference_at: '2026-07-25T12:00:00.000Z',
      workspace_id: 'manager_1',
      processor_token: 'processor_secret',
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
      },
    },
    ...overrides,
  };
}

function loadHandler(job, {
  updateError = null,
  invokeError = null,
  additionalJobs = [],
} = {}) {
  const transpiled = ts.transpileModule(readFileSync(endpointPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: endpointPath,
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error
  );
  assert.deepEqual(errors, []);

  let handler;
  const updates = [];
  const invocations = [];
  const jobs = [job, ...additionalJobs];
  const base44 = {
    auth: {
      me: async () => ({
        id: 'user_1',
        email: 'current@example.com',
        team_manager_id: 'manager_1',
      }),
    },
    asServiceRole: {
      entities: {
        FetchJob: {
          get: async id => jobs.find(candidate => candidate.id === id) || null,
          filter: async (filter, _sort, limit = 500, skip = 0) => jobs
            .filter(candidate => Object.entries(filter).every(
              ([key, value]) => candidate[key] === value
            ))
            .slice(skip, skip + limit),
          update: async (_id, values) => {
            updates.push(values);
            if (updateError) throw updateError;
            return Object.assign(job, values);
          },
          updateMany: async (filter, mutation) => {
            if (updateError) throw updateError;
            const candidate = jobs.find(item => Object.entries(filter).every(
              ([key, value]) => item[key] === value
            ));
            if (!candidate) return { success: true, updated: 0 };
            updates.push(mutation.$set || {});
            Object.assign(candidate, mutation.$set || {});
            return { success: true, updated: 1 };
          },
        },
        PipelineLock: {
          filter: async () => [],
          delete: async () => {},
        },
      },
      functions: {
        invoke: async (name, body) => {
          invocations.push({ name, body });
          if (invokeError) throw invokeError;
          return { data: { accepted: true } };
        },
      },
    },
  };
  const shared = readFileSync(sharedPath, 'utf8').replace(/^export\s+/gm, '');
  const endpoint = transpiled.outputText.replace(/^import .*;\s*$/gm, '');
  vm.runInNewContext(`${shared}\n${endpoint}`, {
    console,
    createClientFromRequest: () => base44,
    neon: () => async () => [{ active_count: 0 }],
    Deno: {
      env: { get: () => null },
      serve: callback => { handler = callback; },
    },
    Request,
    Response,
    TextEncoder,
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
  }, { filename: endpointPath });
  handler.testState = { updates, invocations };
  return handler;
}

async function invoke(job) {
  const handler = loadHandler(job);
  const response = await handler(new Request('https://app.example.com/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ job_id: job.id }),
  }));
  return { response, result: await response.json() };
}

test('polling never publishes provisional delivered usage for unsettled jobs', async () => {
  for (const status of ['pending', 'running', 'failed']) {
    const job = await precisionJob({ status });
    const { response, result } = await invoke(job);

    assert.equal(response.status, 200, status);
    assert.equal(result.delivered_count, null, status);
    assert.equal(result.precision_usage_count, null, status);
    assert.equal(result.diagnostics.delivered_count, null, status);
    assert.equal(typeof result.active_count, 'number', status);
  }
});

test('polling preserves ordered strict criteria reasons in top-level and nested diagnostics', async () => {
  const job = await precisionJob({ status: 'failed' });
  delete job.dry_run_metadata.precision_criteria.force_full_refresh;
  job.dry_run_metadata.precision_criteria.polygon_hash = 'not-a-hash';

  const { response, result } = await invoke(job);
  const expectedReasons = [
    { field: 'precision_criteria.force_full_refresh', reason: 'missing' },
    { field: 'precision_criteria.polygon_hash', reason: 'malformed' },
  ];

  assert.equal(response.status, 200);
  assert.deepEqual(result.criteria_invalid_fields, expectedReasons.map(item => item.field));
  assert.deepEqual(result.criteria_invalid_reasons, expectedReasons);
  assert.deepEqual(result.diagnostics.criteria_invalid_fields, expectedReasons.map(item => item.field));
  assert.deepEqual(result.diagnostics.criteria_invalid_reasons, expectedReasons);
  assert.doesNotMatch(JSON.stringify(result.criteria_invalid_reasons), /not-a-hash/);
});

test('polling rejects final-looking counts without exact terminal zero-reservation evidence', async () => {
  const recordedAt = '2026-07-25T12:30:00.000Z';
  const cases = [
    {
      name: 'terminal positive reservation',
      status: 'completed',
      precision_usage_reserved: 50,
    },
    {
      name: 'active zero reservation',
      status: 'running',
      precision_usage_reserved: 0,
    },
    {
      name: 'settled count exceeds canonical effective target',
      status: 'completed',
      precision_usage_reserved: 0,
      precision_usage_count: 51,
    },
  ];
  for (const scenario of cases) {
    const job = await precisionJob({
      status: scenario.status,
      precision_usage_reserved: scenario.precision_usage_reserved,
      precision_usage_count: scenario.precision_usage_count ?? 7,
      precision_usage_recorded_at: recordedAt,
    });
    const { response, result } = await invoke(job);

    assert.equal(response.status, 200, scenario.name);
    assert.equal(result.delivered_count, null, scenario.name);
    assert.equal(result.precision_usage_count, null, scenario.name);
    assert.equal(result.diagnostics.delivered_count, null, scenario.name);
  }
});

test('polling preserves an exact settled terminal zero as final delivered usage', async () => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    const settledAt = '2026-07-25T12:30:00.000Z';
    const job = await precisionJob({
      status,
      precision_usage_reserved: 0,
      precision_usage_count: 0,
      precision_usage_recorded_at: settledAt,
      completed_at: settledAt,
    });
    const { response, result } = await invoke(job);

    assert.equal(response.status, 200, status);
    assert.equal(result.delivered_count, 0, status);
    assert.equal(result.precision_usage_count, 0, status);
    assert.equal(result.diagnostics.delivered_count, 0, status);
  }
});

test('stale status re-kicks rotate a hashed credential before invocation without exposing the raw token', async () => {
  const job = await precisionJob({
    status: 'pending',
    created_date: new Date(Date.now() - 60_000).toISOString(),
    updated_date: new Date(Date.now() - 60_000).toISOString(),
  });
  const handler = loadHandler(job);
  const response = await handler(new Request('https://app.example.com/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ job_id: job.id }),
  }));
  const result = await response.json();
  const rawToken = handler.testState.invocations[0].body.processor_token;

  assert.equal(response.status, 200);
  assert.equal(handler.testState.invocations.length, 1);
  assert.equal(job.dry_run_metadata.processor_token, null);
  assert.match(job.dry_run_metadata.processor_token_hash, /^[a-f0-9]{64}$/);
  assert.equal(await precisionProcessorTokenHash(rawToken), job.dry_run_metadata.processor_token_hash);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(rawToken));
  assert.equal(result.diagnostics.processor_rekick_error, null);
});

test('status credential-update failure performs no invoke and exposes only a stable error', async () => {
  const job = await precisionJob({
    status: 'pending',
    created_date: new Date(Date.now() - 60_000).toISOString(),
    updated_date: new Date(Date.now() - 60_000).toISOString(),
  });
  const handler = loadHandler(job, {
    updateError: new Error('secret persistence detail'),
  });
  const response = await handler(new Request('https://app.example.com/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ job_id: job.id }),
  }));
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(handler.testState.invocations.length, 0);
  assert.equal(result.diagnostics.processor_rekick_requested, false);
  assert.equal(result.diagnostics.processor_rekick_error, 'processor_rekick_unavailable');
  assert.doesNotMatch(JSON.stringify(result), /secret persistence detail/);
});

test('polling preserves a distinct fail-closed legacy ownership error', async () => {
  const job = await precisionJob();
  const legacyJob = {
    id: 'legacy_precision_job',
    status: 'failed',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    user_email: 'current@example.com',
    precision_usage_reserved: 50,
    precision_usage_count: 0,
  };
  const handler = loadHandler(job, { additionalJobs: [legacyJob] });
  const response = await handler(new Request('https://app.example.com/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ job_id: job.id }),
  }));
  const result = await response.json();

  assert.equal(response.status, 409);
  assert.equal(result.error, 'legacy_precision_ownership_unverifiable');
  assert.deepEqual(result.unverifiable_job_ids, ['legacy_precision_job']);
});
