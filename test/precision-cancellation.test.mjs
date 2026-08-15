import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');
const controlPlaneSource = readSource('base44/functions/_shared/precisionActiveJobCriteria.js')
  .replace(/^export\s+/gm, '');

function loadCancelHandler(base44) {
  const path = 'base44/functions/cancelFetchJob/entry.ts';
  const transpiled = ts.transpileModule(readSource(path), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: path,
    reportDiagnostics: true
  });
  const errors = (transpiled.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], 'cancelFetchJob contains TypeScript syntax errors');

  let handler;
  const executable = `${controlPlaneSource}\n${transpiled.outputText.replace(/^import .*;\s*$/gm, '')}`;
  vm.runInNewContext(executable, {
    console,
    createClientFromRequest: () => base44,
    Deno: { serve: (registeredHandler) => { handler = registeredHandler; } },
    Request,
    Response,
    TextEncoder,
    crypto: globalThis.crypto,
    setTimeout
  }, { filename: path });
  return handler;
}

function loadWatchdogHandler(base44) {
  const path = 'base44/functions/watchdogStaleJobs/entry.ts';
  const transpiled = ts.transpileModule(readSource(path), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: path,
    reportDiagnostics: true
  });
  const errors = (transpiled.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], 'watchdogStaleJobs contains TypeScript syntax errors');

  let handler;
  const executable = `${controlPlaneSource}\n${transpiled.outputText.replace(/^import .*;\s*$/gm, '')}`;
  vm.runInNewContext(executable, {
    console,
    createClientFromRequest: () => base44,
    crypto: globalThis.crypto,
    Deno: {
      env: { get: (name) => name === 'PRECISION_WATCHDOG_SECRET' ? 'watchdog_secret' : undefined },
      serve: (registeredHandler) => { handler = registeredHandler; }
    },
    Request,
    Response,
    TextEncoder,
    setTimeout
  }, { filename: path });
  return handler;
}

function watchdogRequest() {
  return new Request('https://app.example.com/watchdog', {
    method: 'POST',
    headers: { 'x-precision-watchdog-secret': 'watchdog_secret' }
  });
}

function matchesEntityFilter(record, filter) {
  return Object.entries(filter).every(([field, expected]) => {
    const actual = record[field];
    if (expected === null) return actual === null || actual === undefined;
    if (expected && typeof expected === 'object' && '$gt' in expected) {
      return typeof actual === 'number' && actual > expected.$gt;
    }
    if (expected && typeof expected === 'object' && '$ne' in expected) {
      return expected.$ne === null
        ? actual !== null && actual !== undefined
        : actual !== expected.$ne;
    }
    return actual === expected;
  });
}

function applyConditionalUpdate(records, filter, mutation, updates) {
  const target = records.find(record => matchesEntityFilter(record, filter));
  if (!target) return { success: true, updated: 0 };
  const values = mutation?.$set || {};
  updates.push(values);
  Object.assign(target, values, { updated_date: new Date().toISOString() });
  return { success: true, updated: 1 };
}

function watchdogBase44(jobOrJobs, invoke) {
  const updates = [];
  const invocations = [];
  const jobs = Array.isArray(jobOrJobs) ? jobOrJobs : [jobOrJobs];
  const base44 = {
    auth: { me: async () => ({ id: 'admin_1', role: 'admin' }) },
    asServiceRole: {
      entities: {
        FetchJob: {
          filter: async (filter, _sort, limit = 500, skip = 0) =>
            jobs
              .filter(candidate => matchesEntityFilter(candidate, filter))
              .slice(skip, skip + limit),
          get: async id => jobs.find(candidate => candidate.id === id) || null,
          update: async (id, value) => {
            updates.push(value);
            const target = jobs.find(candidate => candidate.id === id);
            if (!target) throw new Error(`Missing FetchJob ${id}`);
            Object.assign(target, value, { updated_date: new Date().toISOString() });
            return target;
          },
          updateMany: async (filter, mutation) =>
            applyConditionalUpdate(jobs, filter, mutation, updates),
        }
      },
      functions: {
        invoke: async (name, body) => {
          invocations.push({ name, body });
          const target = jobs.find(candidate => candidate.id === body?.job_id) || jobs[0];
          return invoke?.(target, body);
        }
      }
    }
  };
  return { base44, updates, invocations, jobs };
}

test('cancelling a running pull records durable intent without releasing its reservation', async () => {
  const job = {
    id: 'job_running',
    status: 'running',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    user_email: 'austenwaugh@gmail.com',
    precision_usage_user_id: 'user_1',
    precision_usage_reserved: 50,
    precision_usage_count: 0,
    processor_claim_id: 'claim_running',
    chunk_number: 0,
    dry_run_metadata: { processor_token: 'processor_secret' },
    error_log: []
  };
  const updates = [];
  const invocations = [];
  const base44 = {
    auth: { me: async () => ({ id: 'user_1', email: 'austenwaugh@gmail.com' }) },
    asServiceRole: {
      entities: {
        FetchJob: {
          filter: async () => [job],
          get: async () => job,
          update: async (_id, value) => {
            updates.push(value);
            Object.assign(job, value);
          },
          updateMany: async (filter, mutation) =>
            applyConditionalUpdate([job], filter, mutation, updates),
        }
      },
      functions: {
        invoke: async (name, body) => invocations.push({ name, body })
      }
    }
  };
  const handler = loadCancelHandler(base44);
  const response = await handler(new Request('https://app.example.com/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ job_id: job.id })
  }));
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.settlement_pending, true);
  assert.equal(job.status, 'cancelled');
  assert.ok(job.precision_cancel_requested_at);
  assert.equal(job.precision_usage_reserved, 50);
  assert.equal(job.precision_usage_count, 0);
  assert.equal(job.processor_claim_id, 'claim_running');
  assert.equal(job.precision_usage_recorded_at, undefined);
  assert.equal(Object.hasOwn(updates[0], 'precision_usage_reserved'), false);
  assert.equal(Object.hasOwn(updates[0], 'precision_usage_count'), false);
  assert.equal(Object.hasOwn(updates[0], 'precision_usage_recorded_at'), false);
  assert.equal(invocations[0].name, 'processFetchChunk');
  assert.notEqual(invocations[0].body.processor_token, 'processor_secret');
  assert.match(job.dry_run_metadata.processor_token_hash, /^[a-f0-9]{64}$/);
  assert.equal(job.dry_run_metadata.processor_token, null);
});

test('repeat cancellation preserves immutable exact settlement and partial truthy timestamps stay pending', async () => {
  const settledAt = '2026-07-25T12:05:00.000Z';
  for (const scenario of [
    {
      name: 'exactly settled',
      job: {
        id: 'cancelled_settled',
        status: 'cancelled',
        provider: 'batchdata',
        mode_tag: 'PRECISION_TARGET',
        precision_usage_user_id: 'user_1',
        user_email: 'owner@example.com',
        precision_usage_reserved: 0,
        precision_usage_count: 7,
        precision_usage_recorded_at: settledAt,
        completed_at: settledAt,
        dry_run_metadata: {},
        error_log: [],
      },
      expectedPending: false,
      expectedUpdates: 0,
      expectedInvocations: 0,
    },
    {
      name: 'truthy partial settlement',
      job: {
        id: 'cancelled_partial',
        status: 'cancelled',
        provider: 'batchdata',
        mode_tag: 'PRECISION_TARGET',
        precision_usage_user_id: 'user_1',
        user_email: 'owner@example.com',
        precision_usage_reserved: 50,
        precision_usage_count: 0,
        precision_usage_recorded_at: settledAt,
        dry_run_metadata: {},
        error_log: [],
      },
      expectedPending: true,
      expectedUpdates: 1,
      expectedInvocations: 1,
    },
  ]) {
    const updates = [];
    const invocations = [];
    const base44 = {
      auth: { me: async () => ({ id: 'user_1', email: 'owner@example.com' }) },
      asServiceRole: {
        entities: {
          FetchJob: {
            filter: async () => [scenario.job],
            get: async () => scenario.job,
            update: async (_id, values) => {
              updates.push(values);
              Object.assign(scenario.job, values);
            },
            updateMany: async (filter, mutation) =>
              applyConditionalUpdate([scenario.job], filter, mutation, updates),
          },
        },
        functions: {
          invoke: async (name, body) => invocations.push({ name, body }),
        },
      },
    };
    const response = await loadCancelHandler(base44)(new Request('https://app.example.com/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: scenario.job.id }),
    }));
    const result = await response.json();

    assert.equal(response.status, 200, scenario.name);
    assert.equal(result.settlement_pending, scenario.expectedPending, scenario.name);
    assert.equal(updates.length, scenario.expectedUpdates, scenario.name);
    assert.equal(invocations.length, scenario.expectedInvocations, scenario.name);
    assert.equal(scenario.job.precision_usage_count, scenario.name === 'exactly settled' ? 7 : 0);
    assert.equal(scenario.job.precision_usage_recorded_at, settledAt);
  }
});

test('the processor cooperatively checks cancellation before writes and settles cancellation in fatal paths', () => {
  const source = readSource('base44/functions/processFetchChunk/entry.ts');
  const afterLease = source.indexOf('Cancellation observed after claiming the processor lease.');
  const beforeWrite = source.indexOf('const beforeWriteJob');
  const neonWrite = source.indexOf('const result = await writePropertiesToNeon');
  const postWrite = source.indexOf('const latestJob = await base44.asServiceRole.entities.FetchJob.get(job.id);');
  const completionReread = source.indexOf('const afterCompletionJob');

  assert.ok(afterLease > 0);
  assert.ok(beforeWrite > afterLease);
  assert.ok(neonWrite > beforeWrite);
  assert.ok(postWrite > neonWrite);
  assert.ok(completionReread > postWrite);
  assert.match(source, /\|\| cancellationRequested\(failedJob\)/);
  assert.match(source, /status: wasCancelled \? 'cancelled' : 'failed'/);
});

test('watchdog settles a stale running reservation through the processor before failing the job', async () => {
  const job = {
    id: 'stale_running',
    status: 'running',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    precision_usage_user_id: 'user_1',
    updated_date: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    precision_usage_reserved: 50,
    precision_usage_count: 0,
    processor_claim_id: 'claim_stale_running',
    chunk_number: 0,
    dry_run_metadata: { processor_token: 'processor_secret' },
    error_log: []
  };
  const { base44, updates, invocations } = watchdogBase44(job, async (current) => {
    Object.assign(current, {
      status: 'cancelled',
      processor_claim_id: null,
      precision_usage_reserved: 0,
      precision_usage_count: 17,
      precision_usage_recorded_at: new Date().toISOString()
    });
  });
  const handler = loadWatchdogHandler(base44);
  const response = await handler(watchdogRequest());
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.stale_jobs_fixed, 1);
  assert.equal(job.status, 'failed');
  assert.equal(job.precision_usage_reserved, 0);
  assert.equal(job.precision_usage_count, 17);
  assert.ok(job.precision_usage_recorded_at);
  assert.ok(job.precision_watchdog_recovery_at);
  assert.equal(job.precision_cancel_requested_at, undefined);
  assert.equal(invocations[0].name, 'processFetchChunk');
  assert.notEqual(invocations[0].body.processor_token, 'processor_secret');
  assert.match(job.dry_run_metadata.processor_token_hash, /^[a-f0-9]{64}$/);
  assert.equal(job.dry_run_metadata.processor_token, null);
  assert.equal(updates[0].processor_claim_id, 'claim_stale_running');
  assert.equal(updates.some(update => Object.hasOwn(update, 'precision_usage_reserved')), false);
  assert.equal(updates.some(update => Object.hasOwn(update, 'precision_usage_count')), false);
  assert.equal(updates.some(update => Object.hasOwn(update, 'precision_usage_recorded_at')), false);
});

test('watchdog keeps and promptly retries a reservation when processor settlement is still pending', async () => {
  const job = {
    id: 'stale_retry',
    status: 'running',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    precision_usage_user_id: 'user_1',
    updated_date: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    precision_usage_reserved: 50,
    precision_usage_count: 0,
    chunk_number: 0,
    dry_run_metadata: { processor_token: 'processor_secret' },
    error_log: []
  };
  const { base44, invocations } = watchdogBase44(job, async () => {
    throw new Error('processor still locked');
  });
  const handler = loadWatchdogHandler(base44);

  const first = await handler(watchdogRequest());
  const firstResult = await first.json();
  const second = await handler(watchdogRequest());
  const secondResult = await second.json();

  assert.equal(firstResult.settlement_pending, 1);
  assert.equal(secondResult.settlement_pending, 1);
  assert.equal(invocations.length, 2);
  assert.equal(job.precision_usage_reserved, 50);
  assert.equal(job.precision_usage_recorded_at, undefined);
  assert.ok(job.precision_watchdog_recovery_at);
  assert.equal(job.precision_cancel_requested_at, undefined);
});

test('watchdog retries an unsettled user cancellation without converting it to a failure', async () => {
  const job = {
    id: 'cancelled_retry',
    status: 'cancelled',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    precision_usage_user_id: 'user_1',
    updated_date: new Date().toISOString(),
    precision_cancel_requested_at: new Date().toISOString(),
    precision_usage_reserved: 50,
    precision_usage_count: 0,
    chunk_number: 0,
    dry_run_metadata: { processor_token: 'processor_secret' },
    error_log: []
  };
  const { base44, invocations } = watchdogBase44(job, async (current) => {
    Object.assign(current, {
      precision_usage_reserved: 0,
      precision_usage_count: 0,
      precision_usage_recorded_at: new Date().toISOString()
    });
  });
  const handler = loadWatchdogHandler(base44);
  const response = await handler(watchdogRequest());
  const result = await response.json();

  assert.equal(result.stale_jobs_fixed, 1);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.precision_usage_reserved, 0);
  assert.equal(job.precision_usage_count, 0);
  assert.equal(job.precision_watchdog_recovery_at, undefined);
  assert.equal(invocations.length, 1);
});

test('a later watchdog sweep terminalizes asynchronously settled marked jobs without recount or provider work', async () => {
  for (const status of ['running', 'cancelled']) {
    const recordedAt = '2026-07-25T12:05:00.000Z';
    const job = {
      id: `watchdog_marked_${status}`,
      status,
      provider: 'batchdata',
      mode_tag: 'PRECISION_TARGET',
      precision_usage_user_id: 'user_1',
      updated_date: new Date().toISOString(),
      precision_watchdog_recovery_at: '2026-07-25T12:00:00.000Z',
      precision_cancel_requested_at: '2026-07-25T12:00:00.000Z',
      precision_usage_reserved: 0,
      precision_usage_count: 4,
      precision_usage_recorded_at: recordedAt,
      dry_run_metadata: {},
      error_log: [],
    };
    const { base44, invocations } = watchdogBase44(job);
    const response = await loadWatchdogHandler(base44)(watchdogRequest());
    const result = await response.json();

    assert.equal(response.status, 200, status);
    assert.equal(result.stale_jobs_fixed, 1, status);
    assert.equal(invocations.length, 0, status);
    assert.equal(job.status, 'failed', status);
    assert.equal(job.precision_usage_count, 4, status);
    assert.equal(job.precision_usage_recorded_at, recordedAt, status);
  }
});

test('an exactly settled genuine user cancellation stays cancelled without recovery', async () => {
  const job = {
    id: 'user_cancelled_settled',
    status: 'cancelled',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    precision_usage_user_id: 'user_1',
    precision_cancel_requested_at: '2026-07-25T12:00:00.000Z',
    precision_usage_reserved: 0,
    precision_usage_count: 2,
    precision_usage_recorded_at: '2026-07-25T12:05:00.000Z',
    dry_run_metadata: {},
    error_log: [],
  };
  const { base44, invocations, updates } = watchdogBase44(job);
  const response = await loadWatchdogHandler(base44)(watchdogRequest());
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.stale_jobs_fixed, 0);
  assert.equal(invocations.length, 0);
  assert.equal(updates.length, 0);
  assert.equal(job.status, 'cancelled');
});

test('watchdog recovers a terminal zero-reservation partial write instead of treating it as settled', async () => {
  const job = {
    id: 'failed_partial_settlement',
    status: 'failed',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    precision_usage_user_id: 'user_1',
    updated_date: new Date().toISOString(),
    precision_usage_reserved: 0,
    precision_usage_count: 0,
    precision_usage_recorded_at: null,
    chunk_number: 0,
    dry_run_metadata: { processor_token: 'processor_secret' },
    error_log: []
  };
  const { base44, invocations } = watchdogBase44(job, async (current) => {
    Object.assign(current, {
      precision_usage_reserved: 0,
      precision_usage_count: 4,
      precision_usage_recorded_at: new Date().toISOString()
    });
  });
  const handler = loadWatchdogHandler(base44);
  const response = await handler(watchdogRequest());
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.stale_jobs_fixed, 1);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].body.job_id, job.id);
  assert.equal(job.precision_usage_count, 4);
  assert.ok(job.precision_usage_recorded_at);
});

test('watchdog repairs truthy but incomplete terminal settlement evidence', async () => {
  const cases = [
    {
      name: 'positive reservation with valid timestamp',
      precision_usage_reserved: 50,
      precision_usage_recorded_at: new Date().toISOString(),
    },
    {
      name: 'zero reservation with malformed timestamp',
      precision_usage_reserved: 0,
      precision_usage_recorded_at: 'not-a-timestamp',
    },
  ];
  for (const [index, scenario] of cases.entries()) {
    const job = {
      id: `truthy_partial_${index}`,
      status: 'failed',
      provider: 'batchdata',
      mode_tag: 'PRECISION_TARGET',
      precision_usage_user_id: 'user_1',
      updated_date: new Date().toISOString(),
      precision_usage_reserved: scenario.precision_usage_reserved,
      precision_usage_count: 0,
      precision_usage_recorded_at: scenario.precision_usage_recorded_at,
      chunk_number: 0,
      dry_run_metadata: { processor_token: 'processor_secret' },
      error_log: [],
    };
    const { base44, invocations } = watchdogBase44(job, async current => {
      Object.assign(current, {
        precision_usage_reserved: 0,
        precision_usage_count: 5,
        precision_usage_recorded_at: new Date().toISOString(),
      });
    });
    const response = await loadWatchdogHandler(base44)(watchdogRequest());
    const result = await response.json();

    assert.equal(response.status, 200, scenario.name);
    assert.equal(result.stale_jobs_fixed, 1, scenario.name);
    assert.equal(invocations.length, 1, scenario.name);
    assert.equal(job.precision_usage_reserved, 0, scenario.name);
    assert.equal(job.precision_usage_count, 5, scenario.name);
    assert.equal(Number.isFinite(new Date(job.precision_usage_recorded_at).getTime()), true);
  }
});

test('watchdog repairs an incomplete completed-job settlement without changing completed status', async () => {
  const job = {
    id: 'completed_partial_settlement',
    status: 'completed',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    precision_usage_user_id: 'user_1',
    updated_date: new Date().toISOString(),
    precision_usage_reserved: 0,
    precision_usage_count: 0,
    precision_usage_recorded_at: null,
    chunk_number: 0,
    dry_run_metadata: { processor_token: 'processor_secret' },
    error_log: []
  };
  const { base44, invocations } = watchdogBase44(job, async (current) => {
    Object.assign(current, {
      precision_usage_reserved: 0,
      precision_usage_count: 6,
      precision_usage_recorded_at: new Date().toISOString()
    });
  });
  const handler = loadWatchdogHandler(base44);
  const response = await handler(watchdogRequest());
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.stale_jobs_fixed, 1);
  assert.equal(job.status, 'completed');
  assert.equal(job.precision_usage_count, 6);
  assert.ok(job.precision_usage_recorded_at);
  assert.equal(invocations.length, 1);
});

test('more than twenty thousand unrelated terminal jobs cannot disable active recovery', async () => {
  const unrelatedCompleted = Array.from({ length: 20001 }, (_, index) => ({
    id: `unrelated_${index}`,
    status: 'completed',
    provider: 'other-provider',
    mode_tag: 'UNRELATED',
  }));
  const active = {
    id: 'stale_active_target',
    status: 'running',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    precision_usage_user_id: 'user_1',
    updated_date: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    precision_usage_reserved: 50,
    precision_usage_count: 0,
    chunk_number: 0,
    dry_run_metadata: { processor_token: 'processor_secret' },
    error_log: []
  };
  const filters = [];
  const updates = [];
  const base44 = {
    asServiceRole: {
      entities: {
        FetchJob: {
          filter: async (filter, _sort, limit, skip = 0) => {
            filters.push(filter);
            let rows = [];
            if (filter.status === 'running') rows = [active];
            if (
              filter.status === 'completed'
              && filter.mode_tag === 'PRECISION_TARGET'
            ) {
              rows = unrelatedCompleted.filter(job => job.mode_tag === filter.mode_tag);
            }
            return rows.slice(skip, skip + limit);
          },
          get: async (id) => id === active.id ? active : null,
          update: async (_id, value) => {
            updates.push(value);
            return Object.assign(active, value);
          },
          updateMany: async (filter, mutation) =>
            applyConditionalUpdate([active], filter, mutation, updates),
        }
      },
      functions: {
        invoke: async () => Object.assign(active, {
          status: 'cancelled',
          precision_usage_reserved: 0,
          precision_usage_count: 8,
          precision_usage_recorded_at: new Date().toISOString()
        })
      }
    }
  };
  const handler = loadWatchdogHandler(base44);
  const response = await handler(watchdogRequest());
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.stale_jobs_fixed, 1);
  assert.equal(active.precision_usage_count, 8);
  assert.equal(
    filters.some(filter =>
      filter.status === 'completed'
      && Object.keys(filter).length === 1
    ),
    false,
    'terminal history must never be scanned by status alone'
  );
});

test('incomplete active discovery fails closed without mutating the visible Precision job', async () => {
  const unrelated = Array.from({ length: 20001 }, (_, index) => ({
    id: `unrelated_active_${index}`,
    status: 'running',
    provider: 'batchdata',
    mode_tag: 'UNRELATED',
    updated_date: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
  }));
  const target = {
    id: 'targeted_stale_precision',
    status: 'running',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    precision_usage_user_id: 'user_1',
    precision_usage_reserved: 50,
    precision_usage_count: 0,
    updated_date: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    chunk_number: 0,
    dry_run_metadata: { processor_token: 'processor_secret' },
    error_log: [],
  };
  const records = [...unrelated, target];
  const filters = [];
  const updates = [];
  const invocations = [];
  const matches = (job, filter) => Object.entries(filter).every(([field, expected]) => {
    const actual = job[field];
    if (expected && typeof expected === 'object' && '$gt' in expected) {
      return typeof actual === 'number' && actual > expected.$gt;
    }
    if (expected && typeof expected === 'object' && '$ne' in expected) {
      return expected.$ne === null ? actual !== null && actual !== undefined : actual !== expected.$ne;
    }
    return actual === expected;
  });
  const base44 = {
    asServiceRole: {
      entities: {
        FetchJob: {
          filter: async (filter, _sort, limit, skip = 0) => {
            filters.push(filter);
            if (
              filter.status === 'running'
              && filter.precision_usage_user_id
              && filter.precision_usage_user_id.$ne === null
            ) {
              const error = new Error('simulated incomplete active scan');
              error.code = 'precision_job_discovery_incomplete';
              throw error;
            }
            return records
              .filter(job => matches(job, filter))
              .slice(skip, skip + limit);
          },
          get: async id => records.find(job => job.id === id) || null,
          update: async (id, values) => {
            updates.push(values);
            return Object.assign(records.find(job => job.id === id), values);
          },
          updateMany: async (filter, mutation) =>
            applyConditionalUpdate(records, filter, mutation, updates),
        },
      },
      functions: {
        invoke: async (name, body) => {
          invocations.push({ name, body });
        },
      },
    },
  };
  const response = await loadWatchdogHandler(base44)(watchdogRequest());
  const result = await response.json();

  assert.equal(response.status, 503);
  assert.equal(result.status, 'partial');
  assert.equal(result.active_scan_complete, false);
  assert.equal(result.stale_jobs_fixed, 0);
  assert.equal(result.recovery_requested, 0);
  assert.equal(target.status, 'running');
  assert.equal(target.precision_usage_reserved, 50);
  assert.equal(target.precision_usage_count, 0);
  assert.equal(target.precision_watchdog_recovery_at, undefined);
  assert.equal(updates.length, 0);
  assert.equal(invocations.length, 0);
  assert.equal(
    filters.some(filter => (
      filter.status === 'running'
      && Object.keys(filter).length === 1
    )),
    false,
    'active discovery must never scan all statuses before applying the Precision predicate'
  );
});

test('watchdog reports multiple active jobs for one immutable subject with zero mutation', async () => {
  const staleAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  const jobs = ['first', 'second'].map((suffix, index) => ({
    id: `conflicting_${suffix}`,
    status: index === 0 ? 'running' : 'pending',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    phase: index === 0 ? 'batchdata_scanning' : 'batchdata_precision',
    precision_usage_user_id: 'user_conflict',
    precision_usage_reserved: index === 0 ? 50 : 25,
    precision_usage_count: 0,
    processor_claim_id: index === 0 ? 'claim_first' : null,
    updated_date: staleAt,
    chunk_number: 0,
    dry_run_metadata: {
      processor_token_hash: `${index + 1}`.repeat(64),
    },
    error_log: [],
  }));
  const before = structuredClone(jobs);
  const { base44, updates, invocations } = watchdogBase44(jobs);

  const response = await loadWatchdogHandler(base44)(watchdogRequest());
  const result = await response.json();

  assert.equal(response.status, 409);
  assert.equal(result.status, 'conflict');
  assert.equal(result.error, 'multiple_active_precision_jobs');
  assert.equal(result.recovery_requested, 0);
  assert.equal(result.stale_jobs_fixed, 0);
  assert.deepEqual(
    [...result.active_conflicts[0].active_job_ids].sort(),
    jobs.map(job => job.id).sort(),
  );
  assert.equal(updates.length, 0);
  assert.equal(invocations.length, 0);
  assert.deepEqual(jobs, before);
});

test('targeted terminal queries recover a real legacy Precision reservation without mode_tag', async () => {
  const legacy = {
    id: 'legacy_unsettled_failed',
    status: 'failed',
    provider: 'batchdata',
    phase: 'batchdata_precision',
    precision_usage_user_id: 'user_1',
    precision_usage_reserved: 50,
    precision_usage_count: 0,
    chunk_number: 0,
    dry_run_metadata: { processor_token: 'processor_secret' },
    error_log: []
  };
  const matches = (job, filter) => Object.entries(filter).every(([field, expected]) => {
    const actual = job[field];
    if (expected === null) return actual === null || actual === undefined;
    if (expected && typeof expected === 'object' && '$gt' in expected) {
      return typeof actual === 'number' && actual > expected.$gt;
    }
    if (expected && typeof expected === 'object' && '$ne' in expected) {
      return expected.$ne === null ? actual !== null && actual !== undefined : actual !== expected.$ne;
    }
    return actual === expected;
  });
  const invocations = [];
  const updates = [];
  const base44 = {
    asServiceRole: {
      entities: {
        FetchJob: {
          filter: async (filter, _sort, limit, skip = 0) =>
            (matches(legacy, filter) ? [legacy] : []).slice(skip, skip + limit),
          get: async id => id === legacy.id ? legacy : null,
          update: async (_id, value) => {
            updates.push(value);
            return Object.assign(legacy, value);
          },
          updateMany: async (filter, mutation) =>
            applyConditionalUpdate([legacy], filter, mutation, updates),
        }
      },
      functions: {
        invoke: async (_name, body) => {
          invocations.push(body);
          Object.assign(legacy, {
            precision_usage_reserved: 0,
            precision_usage_count: 3,
            precision_usage_recorded_at: new Date().toISOString()
          });
        }
      }
    }
  };
  const handler = loadWatchdogHandler(base44);
  const response = await handler(watchdogRequest());
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.stale_jobs_fixed, 1);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].job_id, legacy.id);
  assert.equal(legacy.precision_usage_count, 3);
});

test('watchdog paginates terminal jobs so an old unsettled cancellation cannot be buried', async () => {
  const settled = Array.from({ length: 500 }, (_, index) => ({
    id: `settled_${index}`,
    status: 'cancelled',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    precision_usage_user_id: `settled_user_${index}`,
    precision_usage_reserved: 0,
    precision_usage_count: 0,
    precision_usage_recorded_at: new Date().toISOString()
  }));
  const target = {
    id: 'old_unsettled_cancel',
    status: 'cancelled',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    precision_usage_user_id: 'user_1',
    precision_cancel_requested_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    precision_usage_reserved: 50,
    precision_usage_count: 0,
    chunk_number: 0,
    dry_run_metadata: { processor_token: 'processor_secret' },
    error_log: []
  };
  const cancelled = [...settled, target];
  const invocations = [];
  const updates = [];
  const base44 = {
    auth: { me: async () => ({ id: 'admin_1', role: 'admin' }) },
    asServiceRole: {
      entities: {
        FetchJob: {
          filter: async ({ status }, _sort, limit, skip = 0) => {
            const rows = status === 'cancelled' ? cancelled : [];
            return rows.slice(skip, skip + limit);
          },
          get: async (id) => cancelled.find(job => job.id === id),
          update: async (id, value) => {
            updates.push(value);
            return Object.assign(cancelled.find(job => job.id === id), value);
          },
          updateMany: async (filter, mutation) =>
            applyConditionalUpdate(cancelled, filter, mutation, updates),
        }
      },
      functions: {
        invoke: async (name, body) => {
          invocations.push({ name, body });
          Object.assign(target, {
            precision_usage_reserved: 0,
            precision_usage_count: 9,
            precision_usage_recorded_at: new Date().toISOString()
          });
        }
      }
    }
  };
  const handler = loadWatchdogHandler(base44);
  const response = await handler(watchdogRequest());
  const result = await response.json();

  assert.equal(result.stale_jobs_fixed, 1);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].body.job_id, target.id);
  assert.equal(target.precision_usage_count, 9);
  assert.equal(target.status, 'cancelled');
});

test('watchdog does not bury the oldest stale running job behind fifty newer jobs', async () => {
  const recent = Array.from({ length: 50 }, (_, index) => ({
    id: `recent_running_${index}`,
    status: 'running',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    precision_usage_user_id: `recent_user_${index}`,
    updated_date: new Date().toISOString(),
    precision_usage_reserved: 1,
    precision_usage_count: 0,
    dry_run_metadata: { processor_token: `recent_${index}` },
    error_log: []
  }));
  const target = {
    id: 'old_stale_running',
    status: 'running',
    provider: 'batchdata',
    mode_tag: 'PRECISION_TARGET',
    precision_usage_user_id: 'user_1',
    updated_date: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    precision_usage_reserved: 50,
    precision_usage_count: 0,
    chunk_number: 0,
    dry_run_metadata: { processor_token: 'processor_secret' },
    error_log: []
  };
  const running = [...recent, target];
  const invocations = [];
  const updates = [];
  const base44 = {
    asServiceRole: {
      entities: {
        FetchJob: {
          filter: async ({ status }, _sort, limit, skip = 0) => {
            const rows = status === 'running' ? running : [];
            return rows.slice(skip, skip + limit);
          },
          get: async (id) => running.find(job => job.id === id),
          update: async (id, value) => {
            updates.push(value);
            return Object.assign(running.find(job => job.id === id), value);
          },
          updateMany: async (filter, mutation) =>
            applyConditionalUpdate(running, filter, mutation, updates),
        }
      },
      functions: {
        invoke: async (name, body) => {
          invocations.push({ name, body });
          Object.assign(target, {
            status: 'cancelled',
            precision_usage_reserved: 0,
            precision_usage_count: 7,
            precision_usage_recorded_at: new Date().toISOString()
          });
        }
      }
    }
  };
  const handler = loadWatchdogHandler(base44);
  const response = await handler(watchdogRequest());
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.jobs_checked, 51);
  assert.equal(result.stale_jobs_fixed, 1);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].body.job_id, target.id);
  assert.equal(target.precision_usage_count, 7);
});

test('a self-promoted admin cannot run the cross-account watchdog without the server secret', async () => {
  let queried = false;
  const base44 = {
    auth: { me: async () => ({ id: 'attacker', role: 'admin' }) },
    asServiceRole: {
      entities: {
        FetchJob: {
          filter: async () => {
            queried = true;
            return [];
          }
        }
      }
    }
  };
  const handler = loadWatchdogHandler(base44);
  const response = await handler(new Request('https://app.example.com/watchdog', { method: 'POST' }));

  assert.equal(response.status, 403);
  assert.equal(queried, false);
});

test('processor fatal recovery rolls back mutable Neon work before conditionally fenced settlement', () => {
  const source = readSource('base44/functions/processFetchChunk/entry.ts');
  const fatalLog = source.indexOf('const referenceId = crypto.randomUUID();');
  const catchStart = source.lastIndexOf('} catch (error) {', fatalLog);
  const responseEnd = source.indexOf('if (fenceLost)', fatalLog);
  const fatalBlock = source.slice(catchStart, responseEnd);
  const abortIndex = fatalBlock.indexOf('await abortPrecisionProcessorLease(processorLease)');
  const countIndex = fatalBlock.indexOf('await countPersistedPrecisionProperties(failedJob.id)');
  const terminalUpdateIndex = fatalBlock.indexOf('const failureClaim = await updateMany.call');

  assert.ok(catchStart >= 0 && responseEnd > catchStart);
  assert.ok(abortIndex >= 0, 'fatal recovery must roll back the transaction that owns mutable Neon work');
  assert.ok(countIndex >= 0, 'fatal recovery must count persisted properties');
  assert.ok(countIndex > abortIndex, 'exact counting must happen after rollback completes');
  assert.ok(terminalUpdateIndex > countIndex, 'terminal update must follow exact counting');
  assert.match(fatalBlock, /status:\s*failedJob\.status,\s*processor_claim_id:\s*processorClaimId/);
  assert.match(fatalBlock, /Fatal settlement skipped because the durable processor fence changed/);
  assert.match(fatalBlock, /completed_at:\s*terminalAt/);
});

test('FetchJob billing fields cannot be rewritten through a self-promoted admin role', () => {
  const schema = JSON.parse(readSource('base44/entities/FetchJob.jsonc'));
  assert.equal(schema.rls.create.user_condition.id, '__service_role_only__');
  assert.equal(schema.rls.update.user_condition.id, '__service_role_only__');
  assert.equal(schema.rls.delete.user_condition.id, '__service_role_only__');
  assert.equal(JSON.stringify(schema.rls).includes('"role":"admin"'), false);
  assert.equal(schema.properties.precision_watchdog_recovery_at.format, 'date-time');
});
