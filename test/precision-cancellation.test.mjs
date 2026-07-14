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
  const executable = transpiled.outputText.replace(/^import .*;\s*$/gm, '');
  vm.runInNewContext(executable, {
    console,
    createClientFromRequest: () => base44,
    Deno: { serve: (registeredHandler) => { handler = registeredHandler; } },
    Request,
    Response,
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
  const executable = transpiled.outputText.replace(/^import .*;\s*$/gm, '');
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

function watchdogBase44(job, invoke) {
  const updates = [];
  const invocations = [];
  const base44 = {
    auth: { me: async () => ({ id: 'admin_1', role: 'admin' }) },
    asServiceRole: {
      entities: {
        FetchJob: {
          filter: async ({ status }) => job.status === status ? [job] : [],
          get: async () => job,
          update: async (_id, value) => {
            updates.push(value);
            Object.assign(job, value, { updated_date: new Date().toISOString() });
          }
        }
      },
      functions: {
        invoke: async (name, body) => {
          invocations.push({ name, body });
          return invoke?.(job, body);
        }
      }
    }
  };
  return { base44, updates, invocations };
}

test('cancelling a running pull records durable intent without releasing its reservation', async () => {
  const job = {
    id: 'job_running',
    status: 'running',
    user_email: 'austenwaugh@gmail.com',
    precision_usage_user_id: 'user_1',
    precision_usage_reserved: 50,
    precision_usage_count: 0,
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
          }
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
  assert.equal(job.precision_usage_recorded_at, undefined);
  assert.equal(Object.hasOwn(updates[0], 'precision_usage_reserved'), false);
  assert.equal(Object.hasOwn(updates[0], 'precision_usage_count'), false);
  assert.equal(Object.hasOwn(updates[0], 'precision_usage_recorded_at'), false);
  assert.equal(invocations[0].name, 'processFetchChunk');
  assert.equal(invocations[0].body.processor_token, 'processor_secret');
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
    updated_date: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    precision_usage_reserved: 50,
    precision_usage_count: 0,
    chunk_number: 0,
    dry_run_metadata: { processor_token: 'processor_secret' },
    error_log: []
  };
  const { base44, updates, invocations } = watchdogBase44(job, async (current) => {
    Object.assign(current, {
      status: 'cancelled',
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
  assert.ok(job.precision_cancel_requested_at);
  assert.equal(invocations[0].name, 'processFetchChunk');
  assert.equal(invocations[0].body.processor_token, 'processor_secret');
  assert.equal(updates.some(update => Object.hasOwn(update, 'precision_usage_reserved')), false);
  assert.equal(updates.some(update => Object.hasOwn(update, 'precision_usage_count')), false);
  assert.equal(updates.some(update => Object.hasOwn(update, 'precision_usage_recorded_at')), false);
});

test('watchdog keeps and promptly retries a reservation when processor settlement is still pending', async () => {
  const job = {
    id: 'stale_retry',
    status: 'running',
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
  assert.ok(job.precision_cancel_requested_at);
});

test('watchdog retries an unsettled user cancellation without converting it to a failure', async () => {
  const job = {
    id: 'cancelled_retry',
    status: 'cancelled',
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

test('watchdog paginates terminal jobs so an old unsettled cancellation cannot be buried', async () => {
  const settled = Array.from({ length: 500 }, (_, index) => ({
    id: `settled_${index}`,
    status: 'cancelled',
    precision_usage_reserved: 0,
    precision_usage_count: 0,
    precision_usage_recorded_at: new Date().toISOString()
  }));
  const target = {
    id: 'old_unsettled_cancel',
    status: 'cancelled',
    precision_cancel_requested_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    precision_usage_reserved: 50,
    precision_usage_count: 0,
    chunk_number: 0,
    dry_run_metadata: { processor_token: 'processor_secret' },
    error_log: []
  };
  const cancelled = [...settled, target];
  const invocations = [];
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
          update: async (id, value) => Object.assign(cancelled.find(job => job.id === id), value)
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

test('legacy failure paths retain reservations instead of guessing zero', () => {
  const status = readSource('base44/functions/fetchJobStatus/entry.ts');
  const missingTokenStart = status.indexOf("if (rekickReason && !metadata.processor_token)");
  const missingTokenEnd = status.indexOf('} else if (rekickReason)', missingTokenStart);
  const missingTokenBlock = status.slice(missingTokenStart, missingTokenEnd);

  assert.doesNotMatch(missingTokenBlock, /precision_usage_reserved/);
  assert.doesNotMatch(missingTokenBlock, /precision_usage_recorded_at/);
});

test('FetchJob billing fields cannot be rewritten through a self-promoted admin role', () => {
  const schema = JSON.parse(readSource('base44/entities/FetchJob.jsonc'));
  assert.equal(schema.rls.create.user_condition.id, '__service_role_only__');
  assert.equal(schema.rls.update.user_condition.id, '__service_role_only__');
  assert.equal(schema.rls.delete.user_condition.id, '__service_role_only__');
  assert.equal(JSON.stringify(schema.rls).includes('"role":"admin"'), false);
  assert.equal(schema.properties.precision_watchdog_recovery_at.format, 'date-time');
});
