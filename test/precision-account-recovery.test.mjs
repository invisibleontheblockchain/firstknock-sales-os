import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { projectEntityFields } from './helpers/projectEntityFields.mjs';
import { loadAuthoritativeUser } from '../base44/shared/accountIdentity.js';
import { selectOwnedPrecisionJobs } from '../base44/shared/precisionOrderSafety.js';
import { precisionTrialLimit } from '../base44/shared/precisionTrialLimit.js';

const user = { id: 'manager-1', email: 'manager@example.com', app_role: 'manager' };
const job = { id: 'job-1', precision_usage_user_id: user.id, user_email: user.email,
  status: 'completed', mode_tag: 'PRECISION_TARGET', precision_usage_count: 50,
  created_date: new Date().toISOString(), dry_run_metadata: { final_delivery: {
    status: 'partial', generated_homes_reported: 50, saved_route_homes_verified: 0,
  } } };
function recovery({ actor = user, jobs = [job], routes = [], fail = false } = {}) {
  let handler;
  const matches = (row, query) => Object.entries(query).every(([key, value]) => key.includes('.') || row[key] === value);
  const base44 = { auth: { me: async () => actor }, asServiceRole: { entities: {
    User: { get: async () => actor },
    FetchJob: { filter: async (query, _, limit, offset, fields) => {
      if (fail) throw new Error('Database unavailable');
      return jobs.filter(row => matches(row, query)).slice(offset, offset + limit).map(row => projectEntityFields(row, fields));
    } },
    SavedRoute: { filter: async (query, _, limit, offset, fields) => routes.filter(row => matches(row, query))
      .slice(offset, offset + limit).map(row => projectEntityFields(row, fields)) },
  } } };
  const source = readFileSync(new URL('../base44/functions/getPrecisionRecovery/entry.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  vm.runInNewContext(compiled.replace(/^import .*;\s*$/gm, ''), {
    createClientFromRequest: () => base44, loadAuthoritativeUser, selectOwnedPrecisionJobs,
    console: { error() {} }, Response, Deno: { serve: callback => { handler = callback; } },
  });
  return async () => { const response = await handler(new Request('https://test/recover')); return { status: response.status, body: await response.json() }; };
}

test('an imported but unsaved order is recoverable without any browser storage or new pull', async () => {
  const result = await recovery()(); assert.equal(result.status, 200);
  assert.equal(result.body.job_id, job.id); assert.equal(result.body.remaining_homes, 50);
});
test('partial save recovery counts distinct owned homes and excludes another tenant', async () => {
  const routes = [
    { manager_id: user.id, metadata: { precision_area: { job_id: job.id } }, property_hashes: ['a', 'a', 'b'] },
    { manager_id: 'other', metadata: { precision_area: { job_id: job.id } }, property_hashes: Array.from({ length: 50 }, (_, i) => `x${i}`) },
  ];
  const result = await recovery({ routes })(); assert.equal(result.body.saved_homes, 2); assert.equal(result.body.remaining_homes, 48);
});
test('a conflicting immutable owner, completed delivery, or support-retired job is never rebuilt', async () => {
  for (const patch of [
    { precision_usage_user_id: 'other' },
    { dry_run_metadata: { final_delivery: { status: 'completed', saved_route_homes_verified: 50 } } },
    { dry_run_metadata: { precision_route_delivery_confirmed_at: 'today' } },
    { dry_run_metadata: { support_allowance_adjustment: {} } },
    { dry_run_metadata: { support_route_recovery: {} } },
  ]) assert.equal((await recovery({ jobs: [{ ...job, ...patch }] })()).body.job_id, null);
});
test('active orders resume first; anonymous or unavailable recovery cannot masquerade as complete', async () => {
  const running = { ...job, id: 'running', status: 'running' };
  assert.equal((await recovery({ jobs: [job, running] })()).body.job_id, 'running');
  assert.equal((await recovery({ actor: null })()).status, 401);
  assert.equal((await recovery({ fail: true })()).status, 503);
});
test('one-time support credits extend lifetime included homes without recurring or paid access', () => {
  assert.equal(precisionTrialLimit({}), 50);
  assert.equal(precisionTrialLimit({ precision_trial_bonus_credits: 100 }), 150);
  for (const value of [-100, 0.5, Infinity, 'forged', 1000001]) assert.equal(precisionTrialLimit({ precision_trial_bonus_credits: value }), 50);
  const schema = JSON.parse(readFileSync(new URL('../base44/entities/User.jsonc', import.meta.url), 'utf8'));
  assert.equal(schema.properties.precision_trial_bonus_credits.rls.write.user_condition.role, 'admin');
});
