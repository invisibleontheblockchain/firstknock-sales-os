import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

// The realtime journal sits directly in the path of a rep tapping an outcome.
// Mirroring is worth doing only if it can never cost a knock: every failure
// mode of the mirror must degrade to "the sweeper picks it up later", never to
// a failed or slow write. These tests pin that down.

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');

function loadJournal(functionPath, { neon, env = {}, expose }) {
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

  const sandbox = {
    console: { ...console, error: () => {} },
    createClientFromRequest: () => ({ asServiceRole: { entities: {} } }),
    neon,
    Stripe: class { constructor() { return { subscriptions: {}, customers: {}, invoices: {} }; } },
    Date, Math, Map, Set, JSON, Promise, Number, String, Object, Array, Boolean, Error,
    URL, Request, Response, crypto, TextEncoder, setTimeout, clearTimeout,
    Deno: { env: { get: (key) => env[key] ?? null }, serve: () => {} },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(transpiled.outputText.replace(/^import .*;\s*$/gm, ''), sandbox, {
    filename: functionPath,
  });
  return sandbox;
}

const OUTCOME = {
  id: 'log-1',
  manager_id: 'mgr-1',
  created_by: 'rep@example.com',
  parsed_status: 'SOLD',
  updated_date: '2026-07-20T10:00:00.000Z',
};

test('a database outage cannot fail a logged outcome', async () => {
  const sandbox = loadJournal('base44/functions/recordKnockOutcome/entry.ts', {
    neon: () => () => Promise.reject(new Error('connection refused')),
    env: { DATABASE_URL: 'postgres://stub' },
    expose: 'globalThis.__journal = journalToContinuity;',
  });

  await assert.doesNotReject(
    () => sandbox.__journal('InteractionLog', OUTCOME),
    'a mirror failure must never surface to the rep',
  );
});

test('an unconfigured mirror is a no-op rather than an error', async () => {
  let called = false;
  const sandbox = loadJournal('base44/functions/recordKnockOutcome/entry.ts', {
    neon: () => { called = true; return () => Promise.resolve([]); },
    env: {},
    expose: 'globalThis.__journal = journalToContinuity;',
  });

  await assert.doesNotReject(() => sandbox.__journal('InteractionLog', OUTCOME));
  assert.equal(called, false, 'no connection is attempted without DATABASE_URL');
});

test('a hung database does not hold the knock path open', async () => {
  const sandbox = loadJournal('base44/functions/recordKnockOutcome/entry.ts', {
    neon: () => () => new Promise(() => {}),
    env: { DATABASE_URL: 'postgres://stub' },
    expose: 'globalThis.__journal = journalToContinuity;',
  });

  const startedAt = Date.now();
  await sandbox.__journal('InteractionLog', OUTCOME);
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 3000, `the journal must time out, took ${elapsed}ms`);
});

test('a record with no id is never journalled', async () => {
  let called = false;
  const sandbox = loadJournal('base44/functions/recordKnockOutcome/entry.ts', {
    neon: () => { called = true; return () => Promise.resolve([]); },
    env: { DATABASE_URL: 'postgres://stub' },
    expose: 'globalThis.__journal = journalToContinuity;',
  });

  await sandbox.__journal('InteractionLog', { manager_id: 'mgr-1' });
  assert.equal(called, false);
});

test('the journal writes an append-only version and refreshes latest state', async () => {
  const statements = [];
  const sandbox = loadJournal('base44/functions/recordKnockOutcome/entry.ts', {
    neon: () => (query, params) => {
      statements.push({ text: String(query), params });
      return Promise.resolve([]);
    },
    env: { DATABASE_URL: 'postgres://stub' },
    expose: 'globalThis.__journal = journalToContinuity;',
  });

  await sandbox.__journal('InteractionLog', OUTCOME);

  assert.equal(statements.length, 2);
  assert.ok(statements[0].text.includes('INSERT INTO continuity.record_versions'));
  assert.ok(statements[0].text.includes("'realtime'"), 'the version records how it arrived');
  assert.ok(statements[0].text.includes('ON CONFLICT DO NOTHING'), 'a retry must not duplicate');
  assert.ok(statements[1].text.includes('INSERT INTO continuity.record_current'));
  assert.ok(
    statements.every((statement) => !/\bDELETE\b/i.test(statement.text)),
    'the journal must never delete',
  );
  assert.ok(statements[0].params.includes('log-1'));
  assert.ok(statements[0].params.includes('mgr-1'), 'the tenant key is carried into the mirror');
});

test('canvas stays isolated from the property database', () => {
  // Canvas decisions are mirrored by the replicateFieldData sweep, never by an
  // inline journal: canvasLogHouseDecision is deliberately kept free of
  // DATABASE_URL so Canvas cannot reach the Precision property database.
  // canvas-production-backend enforces the same boundary; this pins the reason
  // so the continuity work does not quietly reintroduce the coupling.
  const source = readSource('base44/functions/canvasLogHouseDecision/entry.ts');
  assert.doesNotMatch(source, /DATABASE_URL|neondatabase|continuity\./);
});

test('the batch journal mirrors every imported outcome', async () => {
  const statements = [];
  const sandbox = loadJournal('base44/functions/recordKnockOutcome/entry.ts', {
    neon: () => (query, params) => {
      statements.push({ text: String(query), params });
      return Promise.resolve([]);
    },
    env: { DATABASE_URL: 'postgres://stub' },
    expose: 'globalThis.__journal = journalManyToContinuity;',
  });

  const rows = Array.from({ length: 250 }, (_, index) => ({
    id: `log-${index}`,
    manager_id: 'mgr-1',
    parsed_status: 'NO_ANSWER',
    updated_date: '2026-07-20T10:00:00.000Z',
  }));
  await sandbox.__journal('InteractionLog', rows);

  const versionInserts = statements.filter((statement) =>
    statement.text.includes('INSERT INTO continuity.record_versions'));
  const mirroredIds = new Set(versionInserts.flatMap((statement) => statement.params));

  // 250 rows chunked at 100 means three round trips, not 250.
  assert.equal(versionInserts.length, 3);
  for (const row of rows) {
    assert.ok(mirroredIds.has(row.id), `${row.id} must reach the mirror`);
  }
});
