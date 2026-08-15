import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const endpointPath = 'base44/functions/adminDiagnostics/entry.ts';
const sharedPath = 'base44/functions/_shared/precisionActiveJobCriteria.js';

function loadHandler(jobs) {
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
  const matchesValue = (actual, expected) => {
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if (Object.hasOwn(expected, '$ne')) {
        return expected.$ne === null
          ? actual !== null && actual !== undefined
          : actual !== expected.$ne;
      }
      if (Object.hasOwn(expected, '$gt')) {
        return typeof actual === 'number' && actual > expected.$gt;
      }
    }
    return actual === expected;
  };
  const matches = (job, filter) =>
    Object.entries(filter).every(([field, value]) =>
      matchesValue(job[field], value)
    );
  const base44 = {
    auth: {
      me: async () => ({
        id: 'admin_1',
        email: 'admin@example.com',
        role: 'admin',
      }),
    },
    asServiceRole: {
      entities: {
        FetchJob: {
          filter: async (filter, sort, limit = 500, skip = 0) => {
            calls.push({ filter, sort, limit, skip });
            return jobs
              .filter(job => matches(job, filter))
              .sort((left, right) =>
                new Date(right.updated_date).getTime() - new Date(left.updated_date).getTime()
              )
              .slice(skip, skip + limit);
          },
        },
      },
    },
  };
  let queryCount = 0;
  const sql = async () => {
    queryCount += 1;
    if (queryCount === 1) {
      return [{
        global_properties: 0,
        sold_last_30_days: 0,
        mls_properties: 0,
        rejected_properties: 0,
      }];
    }
    if (queryCount === 2) {
      return [{
        workspace_properties: 0,
        active_workspace_properties: 0,
        zip_count: 0,
      }];
    }
    return [];
  };

  let handler;
  const shared = readFileSync(sharedPath, 'utf8').replace(/^export\s+/gm, '');
  const endpoint = transpiled.outputText.replace(/^import .*;\s*$/gm, '');
  vm.runInNewContext(`${shared}\n${endpoint}`, {
    console,
    createClientFromRequest: () => base44,
    neon: () => sql,
    Deno: {
      env: { get: key => key === 'DATABASE_URL' ? 'postgres://test' : null },
      serve: callback => { handler = callback; },
    },
    Request,
    Response,
    TextEncoder,
    crypto: globalThis.crypto,
  }, { filename: endpointPath });
  return { handler, calls };
}

test('admin diagnostics paginates authoritative Precision candidates before taking recent 20', async () => {
  const jobs = Array.from({ length: 501 }, (_, index) => ({
    id: `precision_${String(index).padStart(3, '0')}`,
    status: index === 500 ? 'failed' : 'completed',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    precision_usage_user_id: `user_${index}`,
    updated_date: new Date(Date.UTC(2026, 6, 25, 0, index)).toISOString(),
  }));
  jobs.push({
    id: 'schema_default_unrelated',
    status: 'running',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    precision_usage_reserved: 0,
    precision_usage_count: 0,
    updated_date: '2028-01-01T00:00:00.000Z',
  });
  jobs.push(...Array.from({ length: 20 }, (_, index) => ({
    id: `unrelated_${index}`,
    status: 'running',
    provider: 'other-provider',
    updated_date: new Date(Date.UTC(2027, 0, 1, 0, index)).toISOString(),
  })));
  const { handler, calls } = loadHandler(jobs);
  const response = await handler(new Request('https://app.example.com/admin-diagnostics', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }));
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.jobs.precision_jobs_scanned, 501);
  assert.equal(result.jobs.discovery_complete, true);
  assert.equal(result.jobs.recent_count, 20);
  assert.equal(result.jobs.recent_truncated, true);
  assert.equal(result.jobs.recent[0].id, 'precision_500');
  assert.equal(result.jobs.failed_count, 1);
  assert.ok(calls.some(call => call.skip === 500));
  assert.equal(result.jobs.recent.some(job => job.id.startsWith('unrelated_')), false);
  assert.equal(
    result.jobs.recent.some(job => job.id === 'schema_default_unrelated'),
    false
  );
});
