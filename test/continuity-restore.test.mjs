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

const RESTORE_SECRET = 'restore-secret-value';
const functionPath = 'base44/functions/restoreFieldData/entry.ts';

function createSqlRecorder(responder = () => []) {
  const calls = [];
  const sql = (query, params = []) => {
    const text = Array.isArray(query) ? query.join('?') : String(query);
    calls.push({ text, params });
    return Promise.resolve(responder(text, params) ?? []);
  };
  return { sql, calls };
}

function loadRestore({ base44, env = {}, neon }) {
  const transpiled = ts.transpileModule(readSource(functionPath), {
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
    Date, Math, Map, Set, JSON, Promise, Number, String, Object, Array, Boolean, Error,
    URL, Request, Response, crypto, TextEncoder, setTimeout,
    Deno: {
      env: { get: (key) => env[key] ?? null },
      serve: (registered) => { handler = registered; },
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(transpiled.outputText.replace(/^import .*;\s*$/gm, ''), sandbox, {
    filename: functionPath,
  });
  return handler;
}

// Tracks every write the restore attempts against the live store.
function createStore(existingByEntity = {}) {
  const writes = [];
  let nextId = 100;
  const entities = new Proxy({}, {
    get: (_target, name) => ({
      get: (id) => Promise.resolve((existingByEntity[name] || {})[id] || null),
      create: (record) => {
        writes.push({ op: 'create', entity: name, record });
        nextId += 1;
        return Promise.resolve({ ...record, id: `restored-${nextId}` });
      },
      update: (id, record) => {
        writes.push({ op: 'update', entity: name, id, record });
        return Promise.resolve({ ...record, id });
      },
      delete: (id) => {
        writes.push({ op: 'delete', entity: name, id });
        return Promise.resolve(true);
      },
    }),
  });
  return { base44: { auth: { me: async () => ({ role: 'admin', email: 'admin@example.com' }) }, asServiceRole: { entities } }, writes };
}

function restoreRequest(body, headers = {}) {
  return new Request('https://example.test/api/functions/restoreFieldData', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('a restore is a dry run unless dry_run is explicitly false', async () => {
  const { base44, writes } = createStore();
  const { sql } = createSqlRecorder((text) => {
    if (text.includes('FROM continuity.record_current')) {
      return [{ record_id: 'log-1', manager_id: 'mgr-1', payload: { id: 'log-1', parsed_status: 'SOLD' }, deleted_detected_at: null }];
    }
    return [];
  });
  const handler = loadRestore({
    base44,
    neon: () => sql,
    env: { DATABASE_URL: 'postgres://stub', CONTINUITY_RESTORE_SECRET: RESTORE_SECRET },
  });

  // No dry_run key at all: must still be treated as a preview.
  const response = await handler(restoreRequest({ entity: 'InteractionLog' }));
  const payload = await response.json();

  assert.equal(payload.dry_run, true);
  assert.deepEqual(writes, [], 'a dry run must not write anything');
  assert.ok(payload.planned > 0, 'a dry run still reports what it would do');
});

test('a live restore is refused without the restore secret even for an admin', async () => {
  const { base44, writes } = createStore();
  const handler = loadRestore({
    base44,
    neon: () => createSqlRecorder().sql,
    env: { DATABASE_URL: 'postgres://stub', CONTINUITY_RESTORE_SECRET: RESTORE_SECRET },
  });

  const response = await handler(restoreRequest({ entity: 'InteractionLog', dry_run: false }));
  assert.equal(response.status, 403);
  const payload = await response.json();
  assert.equal(payload.code, 'continuity_restore_secret_required');
  assert.deepEqual(writes, []);
});

test('a live restore recreates missing records and leaves existing ones alone', async () => {
  const { base44, writes } = createStore({
    InteractionLog: { 'log-existing': { id: 'log-existing', parsed_status: 'SOLD' } },
  });
  const { sql } = createSqlRecorder((text) => {
    if (text.includes('RETURNING restore_id')) return [{ restore_id: 42 }];
    if (text.includes('FROM continuity.record_current')) {
      return [
        { record_id: 'log-existing', manager_id: 'mgr-1', payload: { id: 'log-existing', parsed_status: 'SOLD' }, deleted_detected_at: null },
        { record_id: 'log-gone', manager_id: 'mgr-1', payload: { id: 'log-gone', parsed_status: 'QUALIFIED', address_hash: 'abc' }, deleted_detected_at: '2026-07-24T00:00:00.000Z' },
      ];
    }
    return [];
  });
  const handler = loadRestore({
    base44,
    neon: () => sql,
    env: { DATABASE_URL: 'postgres://stub', CONTINUITY_RESTORE_SECRET: RESTORE_SECRET },
  });

  const response = await handler(
    restoreRequest(
      { entity: 'InteractionLog', dry_run: false },
      { 'x-continuity-restore-secret': RESTORE_SECRET },
    ),
  );
  const payload = await response.json();

  assert.equal(payload.created, 1, 'the deleted record is recreated');
  assert.equal(payload.skipped, 1, 'the surviving record is left untouched');
  assert.equal(writes.filter((write) => write.op === 'create').length, 1);
  assert.equal(writes.filter((write) => write.op === 'delete').length, 0, 'restore must never delete');

  const created = writes.find((write) => write.op === 'create');
  assert.equal(created.record.id, undefined, 'server-owned id must be stripped before recreate');
  assert.equal(created.record.created_date, undefined, 'the audit timestamp must not be forged');
  assert.equal(created.record.address_hash, 'abc', 'the house link must survive the restore');
});

test('a restore rewrites foreign keys onto the new ids of restored parents', async () => {
  // A route is recreated with a fresh id. An outcome that pointed at the old
  // route id must be retargeted, or the restored history detaches from its
  // route and the data comes back meaningless.
  const { base44, writes } = createStore();
  const { sql } = createSqlRecorder((text, params) => {
    if (text.includes('RETURNING restore_id')) return [{ restore_id: 43 }];
    if (text.includes('FROM continuity.restore_id_map')) return [];
    if (text.includes('FROM continuity.record_current')) {
      if (params[0] === 'SavedRoute') {
        return [{ record_id: 'route-old', manager_id: 'mgr-1', payload: { id: 'route-old', name: 'Elm St' }, deleted_detected_at: null }];
      }
      if (params[0] === 'InteractionLog') {
        return [{ record_id: 'log-1', manager_id: 'mgr-1', payload: { id: 'log-1', route_id: 'route-old', parsed_status: 'SOLD' }, deleted_detected_at: null }];
      }
      return [];
    }
    return [];
  });
  const handler = loadRestore({
    base44,
    neon: () => sql,
    env: { DATABASE_URL: 'postgres://stub', CONTINUITY_RESTORE_SECRET: RESTORE_SECRET },
  });

  const response = await handler(
    restoreRequest({ dry_run: false }, { 'x-continuity-restore-secret': RESTORE_SECRET }),
  );
  await response.json();

  const routeCreate = writes.find((write) => write.entity === 'SavedRoute' && write.op === 'create');
  const logCreate = writes.find((write) => write.entity === 'InteractionLog' && write.op === 'create');

  assert.ok(routeCreate, 'the route is restored first');
  assert.ok(logCreate, 'the outcome is restored after its route');
  assert.notEqual(logCreate.record.route_id, 'route-old', 'the stale route id must not survive');
  assert.match(logCreate.record.route_id, /^restored-/, 'the outcome points at the recreated route');
});

test('a non-admin cannot preview or run a restore', async () => {
  const base44 = {
    auth: { me: async () => ({ role: 'user', email: 'rep@example.com' }) },
    asServiceRole: { entities: {} },
  };
  const handler = loadRestore({
    base44,
    neon: () => createSqlRecorder().sql,
    env: { DATABASE_URL: 'postgres://stub', CONTINUITY_RESTORE_SECRET: RESTORE_SECRET },
  });

  const response = await handler(restoreRequest({ entity: 'InteractionLog' }));
  assert.equal(response.status, 403);
});
