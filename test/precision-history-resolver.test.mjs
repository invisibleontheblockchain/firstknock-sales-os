import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import { precisionPolygonHash } from '../base44/functions/_shared/precisionActiveJobCriteria.js';

const endpointPath = 'base44/functions/resolvePrecisionHistory/entry.ts';
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

async function completedJob(overrides = {}) {
  const hash = await precisionPolygonHash(overrides.polygon || polygon);
  const criteriaOverrides = overrides.criteria || {};
  const created = overrides.created_date || '2026-07-25T12:00:00.000Z';
  const metadataOverrides = overrides.dry_run_metadata || {};
  return {
    id: overrides.id || 'completed_1',
    status: 'completed',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    include_mls: false,
    precision_usage_user_id: 'user_1',
    user_email: 'owner@example.com',
    precision_usage_reserved: 0,
    precision_usage_count: 25,
    precision_usage_recorded_at: '2026-07-25T12:05:00.000Z',
    created_date: created,
    started_at: created,
    completed_at: overrides.completed_at || '2026-07-25T12:05:00.000Z',
    polygon: overrides.polygon || polygon,
    polygon_hash: hash,
    dry_run_metadata: {
      criteria_reference_at: created,
      workspace_id: 'manager_1',
      precision_started_at: created,
      ...metadataOverrides,
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
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) =>
        !['criteria', 'dry_run_metadata', 'polygon'].includes(key)
      )
    ),
  };
}

function loadHandler({ user, jobs, filterOverride = null }) {
  const transpiled = ts.transpileModule(readFileSync(endpointPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: endpointPath,
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error
  );
  assert.deepEqual(errors, []);

  const calls = [];
  const matches = (job, filter) =>
    Object.entries(filter).every(([key, value]) => job[key] === value);
  const base44 = {
    auth: { me: async () => user },
    asServiceRole: {
      entities: {
        FetchJob: {
          filter: async (filter, sort, limit = 500, skip = 0) => {
            calls.push({ filter, sort, limit, skip });
            if (filterOverride) return filterOverride(filter, sort, limit, skip);
            return jobs.filter(job => matches(job, filter)).slice(skip, skip + limit);
          },
        },
      },
    },
  };
  let handler;
  const shared = readFileSync(sharedPath, 'utf8').replace(/^export\s+/gm, '');
  const endpoint = transpiled.outputText.replace(/^import .*;\s*$/gm, '');
  vm.runInNewContext(`${shared}\n${endpoint}`, {
    console,
    createClientFromRequest: () => base44,
    Deno: { serve: callback => { handler = callback; } },
    Request,
    Response,
    TextEncoder,
    crypto: globalThis.crypto,
  }, { filename: endpointPath });
  return { handler, calls };
}

async function invoke(handler, body = {}) {
  const response = await handler(new Request('https://app.example.com/precision-history', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { response, result: await response.json() };
}

const user = {
  id: 'user_1',
  email: 'owner@example.com',
  team_manager_id: 'manager_1',
  role: 'user',
};

test('history list returns one atomic server-verified completed snapshot', async () => {
  const older = await completedJob({
    id: 'older',
    created_date: '2026-07-20T12:00:00.000Z',
    completed_at: '2026-07-20T12:05:00.000Z',
    precision_usage_count: 10,
  });
  const newer = await completedJob({ id: 'newer', precision_usage_count: 25 });
  const { handler } = loadHandler({ user, jobs: [older, newer] });

  const { response, result } = await invoke(handler);
  assert.equal(response.status, 200);
  assert.equal(result.state, 'ok');
  assert.equal(result.entries.length, 1);
  assert.equal(result.verified_entries.length, 1);
  assert.equal(result.unverified_entries.length, 0);
  assert.equal(result.entries[0].job_id, 'newer');
  assert.equal(result.entries[0].criteria_verified, true);
  assert.equal(result.entries[0].criteria_status, 'server_verified');
  assert.equal(result.entries[0].criteria_source_fetch_job_id, 'newer');
  assert.equal(result.entries[0].entered_count, 50);
  assert.equal(result.entries[0].effective_count, 50);
  assert.equal(result.entries[0].delivered_count, 25);
  assert.deepEqual(result.entries[0].criteria.route_filters, routeFilters);
});

test('newer tampered evidence cannot replace an older complete verified snapshot', async () => {
  const verified = await completedJob({
    id: 'verified',
    created_date: '2026-07-20T12:00:00.000Z',
    completed_at: '2026-07-20T12:05:00.000Z',
  });
  const tampered = await completedJob({
    id: 'tampered',
    include_mls: true,
    completed_at: '2026-07-25T13:00:00.000Z',
  });
  const { handler } = loadHandler({ user, jobs: [verified, tampered] });

  const { result } = await invoke(handler);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].job_id, 'verified');
  assert.equal(result.entries[0].criteria_verified, true);
});

test('equal-time same-polygon history selection is deterministic by job id', async () => {
  const zeta = await completedJob({ id: 'zeta' });
  const alpha = await completedJob({ id: 'alpha' });
  const first = await invoke(loadHandler({ user, jobs: [zeta, alpha] }).handler);
  const second = await invoke(loadHandler({ user, jobs: [alpha, zeta] }).handler);

  assert.equal(first.result.entries[0].job_id, 'alpha');
  assert.equal(second.result.entries[0].job_id, 'alpha');
});

test('single-record restore re-authorizes opaque id and returns no unverified criteria', async () => {
  const valid = await completedJob();
  const { handler } = loadHandler({ user, jobs: [valid] });
  const verified = await invoke(handler, { fetch_job_id: valid.id });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.result.state, 'single');
  assert.equal(verified.result.job.job_id, valid.id);
  assert.equal(verified.result.job.criteria_verified, true);

  const invalid = await completedJob({ id: 'invalid', include_mls: true });
  const invalidHandler = loadHandler({ user, jobs: [invalid] }).handler;
  const rejected = await invoke(invalidHandler, { fetch_job_id: invalid.id });
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.result.error, 'precision_history_evidence_unverifiable');
  assert.equal(rejected.result.fetch_job_id, invalid.id);
  assert.equal(Object.hasOwn(rejected.result, 'criteria'), false);
  assert.equal(Object.hasOwn(rejected.result, 'polygon'), false);
});

test('history rejects browser identity/criteria fields and undelegated cross-account lookup', async () => {
  const job = await completedJob();
  const { handler } = loadHandler({ user, jobs: [job] });
  const injected = await invoke(handler, {
    fetch_job_id: job.id,
    user_email: 'other@example.com',
    criteria: job.dry_run_metadata.precision_criteria,
  });
  assert.equal(injected.response.status, 400);
  assert.equal(injected.result.error, 'precision_history_request_invalid');

  const admin = {
    id: 'admin_1',
    email: 'admin@example.com',
    team_manager_id: 'admin_1',
    role: 'admin',
  };
  const crossAccount = await invoke(
    loadHandler({ user: admin, jobs: [job] }).handler,
    { fetch_job_id: job.id }
  );
  assert.equal(crossAccount.response.status, 404);
  assert.equal(crossAccount.result.error, 'precision_history_job_not_found');
});

test('history rejects null, array, and primitive request bodies', async () => {
  const job = await completedJob();
  const { handler } = loadHandler({ user, jobs: [job] });

  for (const body of [null, [], 'fetch_job_id', 1, true]) {
    const rejected = await invoke(handler, body);
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.result.error, 'precision_history_request_invalid');
    assert.match(rejected.result.message, /JSON object/i);
  }
});

test('history discovery paginates authenticated jobs beyond the first 500', async () => {
  const jobs = [];
  for (let index = 0; index < 500; index += 1) {
    jobs.push(await completedJob({
      id: `other_${index}`,
      polygon: [
        { lat: 30 + index * 0.00001, lng: -110.2 },
        { lat: 30.1 + index * 0.00001, lng: -110.2 },
        { lat: 30.1 + index * 0.00001, lng: -110.1 },
      ],
    }));
  }
  const target = await completedJob({ id: 'page_two_target' });
  jobs.push(target);
  const { handler, calls } = loadHandler({ user, jobs });

  const { response, result } = await invoke(handler, { fetch_job_id: target.id });
  assert.equal(response.status, 200);
  assert.equal(result.job.job_id, target.id);
  assert.ok(calls.some(call => call.skip === 500));
});

test('history fails closed when authenticated discovery cannot prove completeness', async () => {
  const repeated = {
    id: 'repeated',
    status: 'completed',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    precision_usage_user_id: user.id,
    user_email: user.email,
  };
  const { handler } = loadHandler({
    user,
    jobs: [],
    filterOverride: async (_filter, _sort, limit) =>
      Array.from({ length: limit }, () => repeated),
  });

  const { response, result } = await invoke(handler);
  assert.equal(response.status, 503);
  assert.equal(result.error, 'precision_job_discovery_incomplete');
  assert.equal(Object.hasOwn(result, 'entries'), false);
});
