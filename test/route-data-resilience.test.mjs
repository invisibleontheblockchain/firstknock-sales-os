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

function loadHandler(path, { user, Client = class {}, neon = () => {} } = {}) {
  const transpiled = ts.transpileModule(readSource(path), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022
    },
    fileName: path,
    reportDiagnostics: true
  });
  const errors = (transpiled.diagnostics || [])
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], `${path} contains TypeScript syntax errors`);

  let handler;
  const executable = transpiled.outputText.replace(/^import .*;\s*$/gm, '');
  vm.runInNewContext(executable, {
    Client,
    Deno: {
      env: { get: () => 'postgres://test' },
      serve: (registeredHandler) => { handler = registeredHandler; }
    },
    Request,
    Response,
    TextEncoder,
    console,
    createClientFromRequest: () => ({
      auth: { me: async () => user },
      asServiceRole: { entities: {} }
    }),
    crypto: globalThis.crypto,
    neon
  }, { filename: path });
  assert.equal(typeof handler, 'function');
  return handler;
}

test('legacy cleanup endpoint is retired and cannot mutate saved routes', async () => {
  const path = 'base44/functions/cleanupRoutes/entry.ts';
  const source = readSource(path);
  assert.doesNotMatch(source, /asServiceRole/);
  assert.doesNotMatch(source, /SavedRoute\.(?:delete|update|create|bulkCreate)/);
  assert.match(source, /cleanup_routes_retired/);

  const nonAdmin = loadHandler(path, {
    user: { id: 'user_1', email: 'user@example.com', role: 'user' }
  });
  const denied = await nonAdmin(new Request('https://example.test'));
  assert.equal(denied.status, 403);

  const admin = loadHandler(path, {
    user: { id: 'admin_1', email: 'admin@example.com', role: 'admin' }
  });
  const retired = await admin(new Request('https://example.test'));
  assert.equal(retired.status, 410);
  assert.equal((await retired.json()).error, 'cleanup_routes_retired');
});

test('resilience schema is additive, versioned, tenant-scoped, and append-only', () => {
  const source = readSource('base44/functions/setupRouteResilienceTables/entry.ts');
  assert.match(source, /route_snapshot_versions/);
  assert.match(source, /route_snapshot_stops/);
  assert.match(source, /route_snapshot_heads/);
  assert.match(source, /interaction_snapshot_versions/);
  assert.match(source, /interaction_snapshot_heads/);
  assert.match(source, /tenant_key TEXT NOT NULL/);
  assert.match(source, /ordered_hashes JSONB NOT NULL/);
  assert.match(source, /manifest_sha256/);
  assert.match(source, /ON DELETE RESTRICT/g);
  assert.doesNotMatch(source, /\b(?:DROP|TRUNCATE)\b/i);
  assert.doesNotMatch(source, /DELETE\s+FROM/i);
});

test('reconciler is dry-run by default and never mutates Base44 source entities', async () => {
  const path = 'base44/functions/reconcileRouteResilience/entry.ts';
  const source = readSource(path);
  assert.match(source, /body\.apply === true/);
  assert.match(source, /SNAPSHOT_ONLY_NO_SOURCE_MUTATIONS/);
  assert.match(source, /source_records_changed:\s*0/);
  assert.match(source, /await client\.query\('BEGIN'\)/);
  assert.match(source, /await client\.query\('COMMIT'\)/);
  assert.match(source, /await client\.query\('ROLLBACK'\)/);
  assert.match(source, /did not persist its complete ordered stop manifest/);
  assert.doesNotMatch(
    source,
    /entities\.(?:SavedRoute|InteractionLog)\.(?:create|update|updateMany|delete|bulkCreate)/
  );

  const handler = loadHandler(path, {
    user: { id: 'admin_1', email: 'admin@example.com', role: 'admin' }
  });
  const response = await handler(new Request('https://example.test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apply: true })
  }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'confirmation_required');
});

test('resilience design requires authorization, reconciliation, and independent restore drills', () => {
  const design = readSource('documentation/route-data-resilience.md');
  assert.match(design, /must first authorize the\s+current Base44 route/i);
  assert.match(design, /must never query snapshots by\s+an unscoped property hash/i);
  assert.match(design, /does not create, update, or delete any Base44 entity/i);
  assert.match(design, /immutable object store in a separate provider\/account/i);
  assert.match(design, /restore drill/i);
});
