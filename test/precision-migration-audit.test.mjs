import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const endpointPath = 'base44/functions/batchDataMigrationAudit/entry.ts';
const sharedPath = 'base44/functions/_shared/precisionActiveJobCriteria.js';

function loadHandler({ databaseUrl = 'postgres://test', fetchJobs = [], entityError = null } = {}) {
  const transpiled = ts.transpileModule(readFileSync(endpointPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: endpointPath,
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error
  );
  assert.deepEqual(errors, []);

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
  const matches = (record, filter) =>
    Object.entries(filter).every(([key, value]) =>
      matchesValue(record[key], value)
    );
  const page = (rows, filter, limit = 500, skip = 0) =>
    rows.filter(row => matches(row, filter)).slice(skip, skip + limit);
  const routes = [
    { id: 'upper', name: 'Upper Mount P', assigned_to_name: 'kevin@reifenvironmental.com' },
    { id: 'middle', name: 'Middle Mount P', assigned_to_name: 'kevin@reifenvironmental.com' },
    { id: 'lower', name: 'Lower Mount P', assigned_to_name: 'kevin@reifenvironmental.com' },
  ];
  const base44 = {
    auth: { me: async () => ({ id: 'admin_1', role: 'admin' }) },
    asServiceRole: {
      entities: {
        FetchJob: {
          filter: async (filter, _sort, limit, skip) =>
            page(fetchJobs, filter, limit, skip),
        },
        TeamMember: {
          filter: async () => {
            if (entityError) throw entityError;
            return [];
          },
        },
        SavedRoute: {
          filter: async (filter, _sort, limit, skip) => {
            if (entityError) throw entityError;
            return page(routes, filter, limit, skip);
          },
        },
        InteractionLog: {
          filter: async () => {
            if (entityError) throw entityError;
            return [];
          },
        },
      },
    },
  };
  const sql = async () => [{
    total: 0,
    rentcast_rows: 0,
    batchdata_rows: 0,
    rejected_rows: 0,
  }];
  let handler;
  const shared = readFileSync(sharedPath, 'utf8').replace(/^export\s+/gm, '');
  const endpoint = transpiled.outputText.replace(/^import .*;\s*$/gm, '');
  vm.runInNewContext(`${shared}\n${endpoint}`, {
    console,
    createClientFromRequest: () => base44,
    neon: () => sql,
    Deno: {
      env: { get: key => key === 'DATABASE_URL' ? databaseUrl : null },
      serve: callback => { handler = callback; },
    },
    Request,
    Response,
    TextEncoder,
    crypto: globalThis.crypto,
  }, { filename: endpointPath });
  return handler;
}

async function invoke(handler) {
  const response = await handler(new Request('https://app.example.com/audit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }));
  return { response, result: await response.json() };
}

test('migration audit paginates every active Precision job instead of a limit-20 sample', async () => {
  const jobs = Array.from({ length: 501 }, (_, index) => ({
    id: `running_${index}`,
    status: 'running',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    precision_usage_user_id: `user_${index}`,
  }));
  jobs.push({
    id: 'schema_default_unrelated',
    status: 'running',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    precision_usage_reserved: 0,
    precision_usage_count: 0,
  });
  const { response, result } = await invoke(loadHandler({ fetchJobs: jobs }));

  assert.equal(response.status, 200);
  assert.equal(result.audit_complete, true);
  assert.equal(result.safe_to_migrate_now, false);
  assert.equal(result.active_jobs.length, 501);
  assert.equal(
    result.active_jobs.some(job => job.id === 'schema_default_unrelated'),
    false
  );
});

test('migration audit cannot report safe when Neon or protected-entity discovery is unavailable', async () => {
  const missingDatabase = await invoke(loadHandler({ databaseUrl: null }));
  assert.equal(missingDatabase.response.status, 503);
  assert.equal(missingDatabase.result.audit_complete, false);
  assert.equal(missingDatabase.result.safe_to_migrate_now, false);

  const failedDiscovery = await invoke(loadHandler({
    entityError: new Error('protected route lookup unavailable'),
  }));
  assert.equal(failedDiscovery.response.status, 500);
  assert.equal(Object.hasOwn(failedDiscovery.result, 'safe_to_migrate_now'), false);
});
