import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { projectEntityFields } from './helpers/projectEntityFields.mjs';
import { selectOwnedPrecisionJobs } from '../base44/shared/precisionOrderSafety.js';

const source = readFileSync(new URL('../base44/functions/fetchJobStatus/entry.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\s*$/gm, '');
const user = { id: 'owner', email: 'owner@example.test' };
const now = Date.parse('2026-10-16T12:09:08Z');
const largeJob = {
  id: 'job-184', status: 'running', precision_usage_user_id: user.id, user_email: user.email,
  provider: 'batchdata', mode_tag: 'PRECISION_TARGET', phase: 'batchdata_scanning', progress_pct: 80,
  created_date: new Date(now - 5000).toISOString(), updated_date: new Date(now - 1000).toISOString(),
  total_expected: 997134, total_fetched: 184, sold_months: 12,
  polygon: [{ lat: 33, lng: -112 }, { lat: 34, lng: -112 }, { lat: 33, lng: -111 }],
  dry_run_metadata: {
    count_mode: 'max_available', processor_token: 'server-only', ownership_range_mode: 'quick',
    excluded_route_hashes: Array.from({ length: 22404 }, (_, i) => `existing-property-${String(i).padStart(6, '0')}`),
    filters: { min_price: 100000 }, route_bounds: { enabled: false },
    completion_reason: 'provider_exhausted', batchdata_summary: { provider_total: 184, active: 184 },
    unrelated_checkpoint: { keep: true }
  }
};

function endpoint({ job = largeJob, actor = user, latest } = {}) {
  const stored = structuredClone(job);
  const reads = [], writes = [], invocations = [];
  let fullReads = 0, handler;
  const client = { auth: { me: async () => actor }, asServiceRole: {
    entities: {
      FetchJob: {
        filter: async (_query, _sort, _limit, _skip, fields) => {
          const projected = projectEntityFields(stored, fields);
          reads.push(projected);
          return [projected];
        },
        get: async () => { fullReads++; return structuredClone(latest || stored); },
        update: async (_id, patch) => { writes.push(structuredClone(patch)); Object.assign(stored, structuredClone(patch)); }
      },
      PipelineLock: { filter: async () => [], delete: async () => {} }
    },
    functions: { invoke: async (name, body) => { invocations.push({ name, body }); } }
  } };
  vm.runInNewContext(source, {
    createClientFromRequest: () => client, Response,
    console: { warn() {}, error() {} }, setTimeout: callback => { queueMicrotask(callback); },
    Date: class extends Date { static now() { return now; } },
    Deno: { env: { get: () => 'test-db' }, serve: value => { handler = value; } },
    neon: () => async () => [{ active_count: 184 }]
  });
  return { reads, writes, invocations, fullReads: () => fullReads, stored,
    invoke: async () => {
      const response = await handler(new Request('https://test/status', {
        method: 'POST', body: JSON.stringify({ job_id: stored.id })
      }));
      return { status: response.status, body: await response.json() };
    }
  };
}

test('polling a 600 KB job reads only a small status snapshot and preserves generation context', async () => {
  assert.ok(JSON.stringify(largeJob).length > 500000);
  const api = endpoint();
  const { status, body } = await api.invoke();
  assert.equal(status, 200);
  assert.ok(JSON.stringify(api.reads[0]).length < 3000, 'Polling must not reread the exclusion list');
  assert.equal(api.fullReads(), 0);
  assert.equal(body.total_fetched, 184);
  assert.equal(body.active_count, 184);
  assert.equal(body.diagnostics.count_mode, 'max_available');
  assert.deepEqual(body.polygon, largeJob.polygon);
  assert.deepEqual(body.diagnostics.filters, largeJob.dry_run_metadata.filters);
  assert.equal(body.diagnostics.processor_token, undefined);
  assert.equal(body.diagnostics.excluded_route_hashes, undefined);
  assert.equal(api.invocations.length, 0);
  assert.equal(api.writes.length, 0);
});

test('recovery reads full metadata once and retains every exclusion and checkpoint', async () => {
  const api = endpoint({ job: { ...largeJob, status: 'pending', total_fetched: 0, progress_pct: 0,
    created_date: new Date(now - 20000).toISOString() } });
  const { status, body } = await api.invoke();
  assert.equal(status, 200);
  assert.equal(api.fullReads(), 1);
  assert.equal(body.diagnostics.processor_rekick_requested, true);
  assert.deepEqual(api.stored.dry_run_metadata.excluded_route_hashes, largeJob.dry_run_metadata.excluded_route_hashes);
  assert.deepEqual(api.stored.dry_run_metadata.unrelated_checkpoint, { keep: true });
  assert.equal(api.invocations.length, 1);
  assert.equal(api.invocations[0].body.processor_token, 'server-only');
});

test('a job that completes during recovery discovery is never re-invoked', async () => {
  const api = endpoint({ job: { ...largeJob, status: 'pending', total_fetched: 0,
    created_date: new Date(now - 20000).toISOString() }, latest: { ...largeJob, status: 'completed' } });
  assert.equal((await api.invoke()).body.status, 'completed');
  assert.equal(api.invocations.length, 0);
  assert.equal(api.writes.length, 0);
});

test('projected identity still refuses a matching-email account with a different immutable owner', async () => {
  const api = endpoint({ actor: { ...user, id: 'other', role: 'admin' } });
  assert.equal((await api.invoke()).status, 403);
  assert.equal(api.fullReads(), 0);
  assert.equal(api.invocations.length, 0);
});

function historyHelpers(file) {
  const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const names = ['ALLOWANCE_JOB_FIELDS', 'USAGE_JOB_FIELDS', 'ROUTE_HASH_FIELDS', 'asArray', 'listAll',
    'getPrecisionJobs', 'getUserPrecisionJobs', 'getPrecisionRouteHomeStats', 'precisionRouteHashStats'];
  const declarations = ast.statements.filter(node =>
    (ts.isFunctionDeclaration(node) && names.includes(node.name.text))
    || (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => names.includes(d.name.getText(ast)))));
  const compiled = ts.transpileModule(declarations.map(node => node.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const sandbox = { selectOwnedPrecisionJobs, withRateLimitRetry: operation => operation() };
  vm.runInNewContext(compiled, sandbox);
  return sandbox;
}

test('both start paths and the usage check keep allowance history small without changing ownership or counts', async () => {
  for (const file of ['startBatchDataPull', 'fetchAreaProperties', 'getPrecisionUsage']) {
    const helpers = historyHelpers(`base44/functions/${file}/entry.ts`);
    const jobs = [largeJob, { ...largeJob, id: 'foreign', precision_usage_user_id: 'other' }];
    const snapshots = [];
    const client = { asServiceRole: { entities: { FetchJob: {
      filter: async (query, _sort, limit, skip, fields) => {
        const page = jobs.filter(job => Object.entries(query).every(([key, value]) => job[key] === value))
          .slice(skip, skip + limit).map(job => projectEntityFields(job, fields));
        snapshots.push(page);
        return page;
      }
    } } } };
    const getJobs = helpers.getPrecisionJobs || helpers.getUserPrecisionJobs;
    const result = await getJobs(client, user);
    assert.equal(result.length, 1, file);
    assert.equal(result[0].id, largeJob.id, file);
    assert.equal(result[0].total_expected, 997134, file);
    assert.equal(result[0].dry_run_metadata.batchdata_summary.active, 184, file);
    assert.ok(snapshots.every(page => JSON.stringify(page).length < 3000), file);
  }
});

test('pre-import saved-route checks read only exclusion hashes and still skip Canvas and duplicate homes', async () => {
  for (const file of ['startBatchDataPull', 'fetchAreaProperties']) {
    const helpers = historyHelpers(`base44/functions/${file}/entry.ts`);
    const heavyProperties = Array.from({ length: 2000 }, (_, i) => ({ address_hash: `home-${i}`, payload: 'x'.repeat(500) }));
    const saved = [
      { id: 'precision-route', manager_id: user.id, created_by: user.email,
        property_hashes: ['a', 'b', 'a'], properties: heavyProperties },
      { id: 'canvas-route', manager_id: user.id, created_by: user.email, route_mode: 'canvas',
        property_hashes: ['canvas-home'], properties: heavyProperties }
    ];
    const snapshots = [];
    const client = { asServiceRole: { entities: { SavedRoute: {
      filter: async (_query, _sort, limit, skip, fields) => {
        const page = saved.slice(skip, skip + limit).map(route => projectEntityFields(route, fields));
        snapshots.push(page);
        return page;
      }
    } } } };
    const stats = await helpers.getPrecisionRouteHomeStats(client, user);
    assert.equal(stats.count, 2, file);
    assert.deepEqual(Array.from(stats.hashes).sort(), ['a', 'b'], file);
    assert.ok(snapshots.every(page => JSON.stringify(page).length < 1000), file);
  }
});
