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

const WORKER_SECRET = 'worker-secret-value';
const RESTORE_SECRET = 'restore-secret-value';

// Records every statement so a test can assert on what the function actually
// asked the database to do, and lets a test script specific return values.
function createSqlRecorder(responder = () => []) {
  const calls = [];
  const sql = (query, params = []) => {
    const text = Array.isArray(query) ? query.join('?') : String(query);
    calls.push({ text, params });
    return Promise.resolve(responder(text, params) ?? []);
  };
  return { sql, calls };
}

function loadFunction(functionPath, { base44, env = {}, neon, expose = '' } = {}) {
  const source = `${readSource(functionPath)}\n${expose}`;
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: functionPath,
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics || []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.deepEqual(errors, [], `${functionPath} contains TypeScript errors`);

  let handler;
  const sandbox = {
    console: { ...console, error: () => {} },
    createClientFromRequest: () => base44,
    neon: neon || (() => async () => []),
    Stripe: class { constructor() { return { subscriptions: {}, customers: {}, invoices: {} }; } },
    Date,
    Math,
    Map,
    Set,
    JSON,
    Promise,
    Number,
    String,
    Object,
    Array,
    Boolean,
    Error,
    URL,
    Request,
    Response,
    Blob,
    CompressionStream,
    crypto,
    TextEncoder,
    Uint8Array,
    ArrayBuffer,
    setTimeout,
    clearTimeout,
    globalThis: undefined,
    Deno: {
      env: { get: (key) => env[key] ?? null },
      serve: (registered) => { handler = registered; },
    },
  };
  sandbox.globalThis = sandbox;
  const executable = transpiled.outputText.replace(/^import .*;\s*$/gm, '');
  vm.runInNewContext(executable, sandbox, { filename: functionPath });
  return { handler, sandbox };
}

// A live-store stub that fails loudly on any write. The replication worker must
// be strictly read-only against customer data.
function createReadOnlyEntities(recordsByEntity) {
  const writes = [];
  const entities = {};
  for (const [name, records] of Object.entries(recordsByEntity)) {
    entities[name] = {
      filter: (_query, _sort, limit = 500, skip = 0) =>
        Promise.resolve(records.slice(skip, skip + limit)),
      list: (_sort, limit = 500, skip = 0) => Promise.resolve(records.slice(skip, skip + limit)),
      get: (id) => Promise.resolve(records.find((record) => record.id === id) || null),
      create: (...args) => { writes.push(['create', name, args]); throw new Error('write attempted'); },
      update: (...args) => { writes.push(['update', name, args]); throw new Error('write attempted'); },
      delete: (...args) => { writes.push(['delete', name, args]); throw new Error('write attempted'); },
      bulkCreate: (...args) => { writes.push(['bulkCreate', name, args]); throw new Error('write attempted'); },
      updateMany: (...args) => { writes.push(['updateMany', name, args]); throw new Error('write attempted'); },
    };
  }
  return { base44: { asServiceRole: { entities } }, writes };
}

function workerRequest(body = {}, headers = {}) {
  return new Request('https://example.test/api/functions/replicateFieldData', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('replication worker rejects a request without the worker secret', async () => {
  const { base44 } = createReadOnlyEntities({});
  const { handler } = loadFunction('base44/functions/replicateFieldData/entry.ts', {
    base44,
    env: { DATABASE_URL: 'postgres://stub', CONTINUITY_WORKER_SECRET: WORKER_SECRET },
  });

  const response = await handler(workerRequest({ mode: 'sweep' }));
  assert.equal(response.status, 401);
});

test('replication worker refuses to run when no worker secret is configured', async () => {
  const { base44 } = createReadOnlyEntities({});
  const { handler } = loadFunction('base44/functions/replicateFieldData/entry.ts', {
    base44,
    env: { DATABASE_URL: 'postgres://stub' },
  });

  const response = await handler(
    workerRequest({ mode: 'sweep' }, { 'x-continuity-worker-secret': '' }),
  );
  assert.equal(response.status, 401);
});

test('a sweep mirrors outcomes without writing to the live store', async () => {
  const outcomes = [
    { id: 'log-1', manager_id: 'mgr-1', created_by: 'rep@example.com', parsed_status: 'SOLD', updated_date: '2026-07-20T10:00:00.000Z' },
    { id: 'log-2', manager_id: 'mgr-1', created_by: 'rep@example.com', parsed_status: 'NO_ANSWER', updated_date: '2026-07-20T11:00:00.000Z' },
  ];
  const { base44, writes } = createReadOnlyEntities({ InteractionLog: outcomes });
  const { sql, calls } = createSqlRecorder((text) => {
    if (text.includes('RETURNING run_id')) return [{ run_id: 7 }];
    if (text.includes('RETURNING version_id')) return [{ version_id: 1 }, { version_id: 2 }];
    return [];
  });

  const { handler } = loadFunction('base44/functions/replicateFieldData/entry.ts', {
    base44,
    neon: () => sql,
    env: { DATABASE_URL: 'postgres://stub', CONTINUITY_WORKER_SECRET: WORKER_SECRET },
  });

  const response = await handler(
    workerRequest(
      { mode: 'sweep', entities: ['InteractionLog'] },
      { 'x-continuity-worker-secret': WORKER_SECRET },
    ),
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.deepEqual(writes, [], 'replication must never write to the live entity store');

  const entityResult = payload.results.find((row) => row.entity === 'InteractionLog');
  assert.equal(entityResult.scanned, 2);

  const versionInsert = calls.find((call) => call.text.includes('INSERT INTO continuity.record_versions'));
  assert.ok(versionInsert, 'a sweep must append to the version ledger');
  assert.ok(versionInsert.text.includes('ON CONFLICT DO NOTHING'), 'ledger appends must be idempotent');
  assert.ok(versionInsert.params.includes('log-1'));
  assert.ok(versionInsert.params.includes('log-2'));
});

test('a sweep advances its cursor so a large backfill can finish', async () => {
  // More rows than one invocation can page through. If the cursor did not
  // advance on a truncated pass, the worker would re-read the same oldest rows
  // forever and never reach the newest ones.
  const many = Array.from({ length: 6000 }, (_, index) => ({
    id: `log-${index}`,
    manager_id: 'mgr-1',
    updated_date: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
  }));
  const { base44 } = createReadOnlyEntities({ InteractionLog: many });
  const { sql, calls } = createSqlRecorder((text) => {
    if (text.includes('RETURNING run_id')) return [{ run_id: 1 }];
    if (text.includes('RETURNING version_id')) return [{ version_id: 1 }];
    return [];
  });

  const { handler } = loadFunction('base44/functions/replicateFieldData/entry.ts', {
    base44,
    neon: () => sql,
    env: { DATABASE_URL: 'postgres://stub', CONTINUITY_WORKER_SECRET: WORKER_SECRET },
  });

  await handler(
    workerRequest(
      { mode: 'sweep', entities: ['InteractionLog'] },
      { 'x-continuity-worker-secret': WORKER_SECRET },
    ),
  );

  const cursorWrite = calls.find((call) => call.text.includes('INSERT INTO continuity.replication_cursor')
    && call.text.includes('last_sweep_at'));
  assert.ok(cursorWrite, 'the sweep must record a cursor');
  const cursorValue = cursorWrite.params[1];
  assert.ok(cursorValue, 'the cursor must advance even when the pass is truncated');
  assert.ok(
    new Date(cursorValue).getTime() > Date.UTC(2026, 0, 1),
    'the cursor must move past the first page',
  );
  assert.ok(cursorWrite.text.includes('GREATEST'), 'a cursor must never move backwards');
});

test('reconcile tombstones a small number of genuinely deleted records', async () => {
  const live = [{ id: 'route-1', manager_id: 'mgr-1', updated_date: '2026-07-20T10:00:00.000Z' }];
  const { base44 } = createReadOnlyEntities({ SavedRoute: live });
  const mirrored = [{ record_id: 'route-1', manager_id: 'mgr-1' }, { record_id: 'route-2', manager_id: 'mgr-1' }];
  const { sql, calls } = createSqlRecorder((text) => {
    if (text.includes('RETURNING run_id')) return [{ run_id: 3 }];
    if (text.includes('FROM continuity.record_current')) return mirrored;
    if (text.includes('UPDATE continuity.record_current SET deleted_detected_at')) return [{ record_id: 'route-2' }];
    return [];
  });

  const { handler } = loadFunction('base44/functions/replicateFieldData/entry.ts', {
    base44,
    neon: () => sql,
    env: { DATABASE_URL: 'postgres://stub', CONTINUITY_WORKER_SECRET: WORKER_SECRET },
  });

  const response = await handler(
    workerRequest(
      { mode: 'reconcile', entities: ['SavedRoute'] },
      { 'x-continuity-worker-secret': WORKER_SECRET },
    ),
  );
  const payload = await response.json();
  const result = payload.results.find((row) => row.entity === 'SavedRoute');

  assert.equal(result.missing, 1);
  assert.equal(result.tombstoned, 1);
  assert.ok(
    calls.some((call) => call.text.includes('UPDATE continuity.record_current SET deleted_detected_at')),
    'a genuine deletion is tombstoned',
  );
  assert.ok(
    !calls.some((call) => call.text.includes('DELETE FROM continuity')),
    'the mirror must never delete its own history',
  );
});

test('reconcile refuses to tombstone a mass deletion and raises an alarm instead', async () => {
  // The live store returns almost nothing while the mirror holds hundreds of
  // records. This is the shape of the incident the mirror exists to survive.
  const live = [{ id: 'log-1', manager_id: 'mgr-1', updated_date: '2026-07-20T10:00:00.000Z' }];
  const { base44 } = createReadOnlyEntities({ InteractionLog: live });
  const mirrored = Array.from({ length: 400 }, (_, index) => ({
    record_id: `log-${index}`,
    manager_id: 'mgr-1',
  }));
  const { sql, calls } = createSqlRecorder((text) => {
    if (text.includes('RETURNING run_id')) return [{ run_id: 4 }];
    if (text.includes('FROM continuity.record_current')) return mirrored;
    return [];
  });

  const { handler } = loadFunction('base44/functions/replicateFieldData/entry.ts', {
    base44,
    neon: () => sql,
    env: { DATABASE_URL: 'postgres://stub', CONTINUITY_WORKER_SECRET: WORKER_SECRET },
  });

  const response = await handler(
    workerRequest(
      { mode: 'reconcile', entities: ['InteractionLog'] },
      { 'x-continuity-worker-secret': WORKER_SECRET },
    ),
  );
  const payload = await response.json();
  const result = payload.results.find((row) => row.entity === 'InteractionLog');

  assert.equal(result.alarm, 'blocked');
  assert.equal(result.tombstoned, 0, 'a suspected mass deletion must not be accepted');
  assert.equal(payload.alarms_raised, 1);
  assert.ok(
    calls.some((call) => call.text.includes('INSERT INTO continuity.deletion_alarms')),
    'the mass-deletion canary must file an alarm',
  );
  assert.ok(
    !calls.some((call) => call.text.includes('SET deleted_detected_at')),
    'no record may be marked deleted while the alarm is unacknowledged',
  );
});

test('an acknowledged mass deletion is allowed through', async () => {
  const live = [{ id: 'log-1', manager_id: 'mgr-1', updated_date: '2026-07-20T10:00:00.000Z' }];
  const { base44 } = createReadOnlyEntities({ InteractionLog: live });
  const mirrored = Array.from({ length: 400 }, (_, index) => ({ record_id: `log-${index}`, manager_id: 'mgr-1' }));
  const { sql } = createSqlRecorder((text) => {
    if (text.includes('RETURNING run_id')) return [{ run_id: 5 }];
    if (text.includes('FROM continuity.record_current')) return mirrored;
    if (text.includes('SET deleted_detected_at')) return [{ record_id: 'x' }];
    return [];
  });

  const { handler } = loadFunction('base44/functions/replicateFieldData/entry.ts', {
    base44,
    neon: () => sql,
    env: { DATABASE_URL: 'postgres://stub', CONTINUITY_WORKER_SECRET: WORKER_SECRET },
  });

  const response = await handler(
    workerRequest(
      {
        mode: 'reconcile',
        entities: ['InteractionLog'],
        acknowledge_mass_deletion: true,
        acknowledged_by: 'owner@example.com',
      },
      { 'x-continuity-worker-secret': WORKER_SECRET },
    ),
  );
  const payload = await response.json();
  const result = payload.results.find((row) => row.entity === 'InteractionLog');

  assert.equal(result.alarm, 'acknowledged');
  assert.ok(result.tombstoned > 0);
});

test('the realtime journal and the sweeper agree on the content hash', async () => {
  // If these digests ever diverge, every sweep would append a duplicate version
  // of a record the journal already stored, and the health probe would report
  // false mismatches on data that is correctly mirrored.
  const record = {
    id: 'log-1',
    manager_id: 'mgr-1',
    parsed_status: 'SOLD',
    nested: { b: 2, a: [3, { d: 4, c: 5 }] },
    created_date: '2026-07-20T10:00:00.000Z',
    updated_date: '2026-07-20T12:00:00.000Z',
  };

  const sweeper = loadFunction('base44/functions/replicateFieldData/entry.ts', {
    base44: { asServiceRole: { entities: {} } },
    env: { DATABASE_URL: 'postgres://stub', CONTINUITY_WORKER_SECRET: WORKER_SECRET },
    expose: 'globalThis.__hash = sha256;',
  });

  const knock = loadFunction('base44/functions/recordKnockOutcome/entry.ts', {
    base44: { asServiceRole: { entities: {} } },
    env: {},
    expose: 'globalThis.__hash = continuityHash;',
  });

  const health = loadFunction('base44/functions/continuityHealth/entry.ts', {
    base44: { asServiceRole: { entities: {} } },
    env: {},
    expose: 'globalThis.__hash = sha256;',
  });

  const [sweeperHash, journalHash, healthHash] = await Promise.all([
    sweeper.sandbox.__hash(record),
    knock.sandbox.__hash(record),
    health.sandbox.__hash(record),
  ]);

  assert.equal(journalHash, sweeperHash, 'journal and sweep digests must match');
  assert.equal(healthHash, sweeperHash, 'the health probe must use the same digest');

  const touched = await sweeper.sandbox.__hash({ ...record, updated_date: '2026-07-21T09:00:00.000Z' });
  assert.equal(touched, sweeperHash, 'a touch that changed no content must not append a version');

  const changed = await sweeper.sandbox.__hash({ ...record, parsed_status: 'HARD_NO' });
  assert.notEqual(changed, sweeperHash, 'a real content change must append a version');
});
