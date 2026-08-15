import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import { precisionPolygonHash } from '../base44/functions/_shared/precisionActiveJobCriteria.js';

const endpointPath = 'base44/functions/resolveActivePrecisionJobs/entry.ts';
const sharedPath = 'base44/functions/_shared/precisionActiveJobCriteria.js';
const polygon = [
  { lat: 33.4, lng: -112.2 },
  { lat: 33.6, lng: -112.2 },
  { lat: 33.6, lng: -112.0 },
];
const routeFilters = {
  propertyTypes: ['Single Family'],
  excludeCommercial: true,
  excludeCondos: true,
  excludeLand: true,
};

async function activeJob(overrides = {}) {
  const hash = await precisionPolygonHash(polygon);
  const criteriaOverrides = overrides.criteria || {};
  return {
    id: 'active_1',
    status: 'running',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    include_mls: false,
    precision_usage_user_id: 'user_1',
    user_email: 'old-owner@example.com',
    precision_usage_reserved: 50,
    precision_usage_count: 0,
    created_date: '2026-07-25T12:00:00.000Z',
    started_at: '2026-07-25T12:00:01.000Z',
    polygon,
    polygon_hash: hash,
    dry_run_metadata: {
      criteria_reference_at: '2026-07-25T12:00:00.000Z',
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
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'criteria')),
  };
}

function loadHandler({ user, jobs }) {
  const transpiled = ts.transpileModule(readFileSync(endpointPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: endpointPath,
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error
  );
  assert.deepEqual(errors, []);

  const matches = (job, filter) =>
    Object.entries(filter).every(([key, value]) => job[key] === value);
  const base44 = {
    auth: { me: async () => user },
    asServiceRole: {
      entities: {
        FetchJob: {
          filter: async (filter, _sort, limit = 500, skip = 0) =>
            jobs.filter(job => matches(job, filter)).slice(skip, skip + limit),
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
  return handler;
}

async function invoke(handler, body = {}) {
  const response = await handler(new Request('https://app.example.com/resolve-active', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return { response, result: await response.json() };
}

test('direct owner resolves one verified active job using immutable identity after an email change', async () => {
  const job = await activeJob();
  const handler = loadHandler({
    user: {
      id: 'user_1',
      email: 'new-owner@example.com',
      team_manager_id: 'manager_1',
      role: 'user',
    },
    jobs: [job],
  });
  const { response, result } = await invoke(handler);
  assert.equal(response.status, 200);
  assert.equal(result.state, 'single');
  assert.equal(result.job.id, job.id);
  assert.equal(result.job.criteria.immutable_user_id, 'user_1');
  assert.equal(result.job.requested_properties, 50);
  assert.equal(result.job.criteria_verified, true);
  assert.equal(result.job.delivered_count, null);
});

test('resolver returns a visible multiple-job conflict without selecting one', async () => {
  const first = await activeJob();
  const second = await activeJob({
    id: 'active_2',
    status: 'pending',
    created_date: '2026-07-25T12:01:00.000Z',
  });
  const handler = loadHandler({
    user: {
      id: 'user_1',
      email: 'owner@example.com',
      team_manager_id: 'manager_1',
    },
    jobs: [first, second],
  });
  const { response, result } = await invoke(handler);
  assert.equal(response.status, 409);
  assert.equal(result.error, 'multiple_active_precision_jobs');
  assert.equal(result.state, 'multiple');
  assert.deepEqual(
    [...result.jobs.map(job => job.id)].sort(),
    ['active_1', 'active_2']
  );
});

test('resolver fails closed on unverifiable active criteria and identity scope', async () => {
  const legacy = await activeJob();
  delete legacy.dry_run_metadata.precision_criteria.force_full_refresh;
  const user = {
    id: 'user_1',
    email: 'owner@example.com',
    team_manager_id: 'manager_1',
  };
  const legacyResult = await invoke(loadHandler({ user, jobs: [legacy] }));
  assert.equal(legacyResult.response.status, 409);
  assert.equal(legacyResult.result.error, 'legacy_precision_criteria_unverifiable');

  const wrongUserCriteria = await activeJob({
    criteria: { immutable_user_id: 'other_user' },
  });
  const wrongUser = await invoke(loadHandler({ user, jobs: [wrongUserCriteria] }));
  assert.equal(wrongUser.response.status, 409);
  assert.equal(wrongUser.result.error, 'active_job_criteria_conflict');
  assert.ok(wrongUser.result.mismatched_fields.includes('immutable_user_id'));

  const wrongWorkspaceCriteria = await activeJob({
    criteria: { workspace_id: 'manager_other' },
  });
  const wrongWorkspace = await invoke(loadHandler({ user, jobs: [wrongWorkspaceCriteria] }));
  assert.equal(wrongWorkspace.response.status, 409);
  assert.equal(wrongWorkspace.result.error, 'active_job_criteria_conflict');
  assert.ok(wrongWorkspace.result.mismatched_fields.includes('workspace_id'));
});

test('resolver never resumes an active job unless include_mls is explicitly false', async () => {
  const user = {
    id: 'user_1',
    email: 'owner@example.com',
    team_manager_id: 'manager_1',
  };
  for (const includeMls of [undefined, null, true]) {
    const job = await activeJob();
    if (includeMls === undefined) delete job.include_mls;
    else job.include_mls = includeMls;
    const { response, result } = await invoke(loadHandler({ user, jobs: [job] }));
    assert.equal(response.status, 409, String(includeMls));
    assert.equal(result.error, 'precision_include_mls_invariant_violation');
  }
});

test('email hints and a distinct undelegated admin cannot select another user active job', async () => {
  const job = await activeJob();
  const adminHandler = loadHandler({
    user: {
      id: 'admin_1',
      email: 'admin@example.com',
      team_manager_id: 'admin_1',
      role: 'admin',
    },
    jobs: [job],
  });
  const { response, result } = await invoke(adminHandler, {
    user_email: job.user_email,
    immutable_user_id: job.precision_usage_user_id,
    workspace_id: 'manager_1',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(result, { state: 'none', jobs: [] });
});
