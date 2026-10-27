import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { projectEntityFields } from './helpers/projectEntityFields.mjs';
import { loadAuthoritativeUser } from '../base44/shared/accountIdentity.js';
import { selectOwnedPrecisionJobs } from '../base44/shared/precisionOrderSafety.js';
import { precisionTrialLimit } from '../base44/shared/precisionTrialLimit.js';
import { tenantManagerId } from '../base44/shared/accountTenancy.js';

const user = { id: 'manager-1', email: 'manager@example.com', app_role: 'manager' };
const job = { id: 'job-1', precision_usage_user_id: user.id, user_email: user.email,
  status: 'completed', mode_tag: 'PRECISION_TARGET', precision_usage_count: 50,
  created_date: new Date().toISOString(), dry_run_metadata: { final_delivery: {
    status: 'partial', generated_homes_reported: 50, saved_route_homes_verified: 0,
  } } };
function recovery({ actor = user, jobs = [job], routes = [], fail = false, updates = [] } = {}) {
  let handler;
  const matches = (row, query) => Object.entries(query).every(([key, value]) => key.includes('.') || row[key] === value);
  const base44 = { auth: { me: async () => actor }, asServiceRole: { entities: {
    User: { get: async () => actor },
    FetchJob: { filter: async (query, _, limit, offset, fields) => {
      if (fail) throw new Error('Database unavailable');
      return jobs.filter(row => matches(row, query)).slice(offset, offset + limit).map(row => projectEntityFields(row, fields));
    },
    get: async id => jobs.find(row => row.id === id) || null,
    update: async (id, patch) => {
      updates.push({ id, patch });
      const row = jobs.find(candidate => candidate.id === id);
      if (row) Object.assign(row, patch);
      return row;
    } },
    SavedRoute: { filter: async (query, _, limit, offset, fields) => routes.filter(row => matches(row, query))
      .slice(offset, offset + limit).map(row => projectEntityFields(row, fields)) },
  } } };
  const source = readFileSync(new URL('../base44/functions/getPrecisionRecovery/entry.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  vm.runInNewContext(compiled.replace(/^import .*;\s*$/gm, ''), {
    createClientFromRequest: () => base44, loadAuthoritativeUser, selectOwnedPrecisionJobs, tenantManagerId,
    console: { error() {} }, Response, Deno: { serve: callback => { handler = callback; } },
  });
  return async (body) => {
    const request = body === undefined
      ? new Request('https://test/recover')
      : new Request('https://test/recover', { method: 'POST', body: JSON.stringify(body) });
    const response = await handler(request);
    return { status: response.status, body: await response.json() };
  };
}

const rep = { id: 'rep-1', email: 'rep@example.com', app_role: 'rep', team_manager_id: user.id };
const repJob = (patch = {}) => ({ ...job, id: 'rep-job', precision_usage_user_id: rep.id, user_email: rep.email,
  dry_run_metadata: { final_delivery: { status: 'partial', generated_homes_reported: 3, saved_route_homes_verified: 0 } }, ...patch });

test('a rep import is delivered once its homes are on routes in the team workspace', async () => {
  const teamRoutes = [{ manager_id: user.id, metadata: { precision_area: { job_id: 'rep-job' } }, property_hashes: ['a', 'b', 'c'] }];
  const delivered = await recovery({ actor: rep, jobs: [repJob()], routes: teamRoutes })();
  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.job_id, null, 'saved in the team workspace, so nothing to recover');
  // Before, only routes under the rep's own id counted, so this import came back on every open.
  const partial = await recovery({ actor: rep, jobs: [repJob()], routes: [{ ...teamRoutes[0], property_hashes: ['a'] }] })();
  assert.equal(partial.body.job_id, 'rep-job');
  assert.equal(partial.body.remaining_homes, 2);
  // Another team's routes for the same job id never count.
  const foreign = await recovery({ actor: rep, jobs: [repJob()], routes: [{ ...teamRoutes[0], manager_id: 'other-team' }] })();
  assert.equal(foreign.body.saved_homes, 0);
});

test('a finished import can be dismissed so it stops coming back, keeping its other metadata', async () => {
  const jobs = [repJob({ dry_run_metadata: { count_mode: 'fixed', final_delivery: { status: 'partial', generated_homes_reported: 3 } } })];
  const updates = [];
  const run = recovery({ actor: rep, jobs, updates });
  assert.equal((await run()).body.job_id, 'rep-job');
  const dismissed = await run({ action: 'dismiss', job_id: 'rep-job' });
  assert.equal(dismissed.status, 200);
  assert.equal(dismissed.body.dismissed, true);
  const metadata = updates[0].patch.dry_run_metadata;
  assert.equal(metadata.count_mode, 'fixed');
  assert.equal(metadata.final_delivery.generated_homes_reported, 3);
  assert.equal(metadata.precision_recovery_dismissed_by, rep.id);
  assert.ok(metadata.precision_recovery_dismissed_at);
  assert.equal((await run()).body.job_id, null, 'never offered again');
  // Dismissing twice is harmless and does not rewrite the record.
  assert.equal((await run({ action: 'dismiss', job_id: 'rep-job' })).status, 200);
  assert.equal(updates.length, 1);
});

test('only the owner can dismiss, and only a finished import', async () => {
  const updates = [];
  const othersJob = repJob({ id: 'others', precision_usage_user_id: 'someone-else', user_email: 'else@example.com' });
  const running = repJob({ id: 'running', status: 'running' });
  const run = recovery({ actor: rep, jobs: [othersJob, running], updates });
  assert.equal((await run({ action: 'dismiss', job_id: 'others' })).status, 404);
  assert.equal((await run({ action: 'dismiss', job_id: 'missing' })).status, 404);
  assert.equal((await run({ action: 'dismiss', job_id: 'running' })).status, 409);
  assert.equal((await run({ action: 'dismiss' })).status, 400);
  assert.equal(updates.length, 0);
});

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
