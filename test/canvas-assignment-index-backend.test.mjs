import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const functionPath = 'base44/functions/canvasGetAssignmentIndex/entry.ts';
const source = readFileSync(resolve(root, functionPath), 'utf8');

function executable() {
  const result = ts.transpileModule(source, {
    fileName: functionPath,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], 'canvasGetAssignmentIndex contains TypeScript syntax errors');
  return result.outputText.replace(/^import .*;\s*$/gm, '').replace(/^export\s+/gm, '');
}

function loadFunction({ base44, neonFactory = () => async () => [], env = {} } = {}) {
  let handler;
  const context = {
    console,
    createClientFromRequest: () => base44,
    neon: neonFactory,
    TextEncoder,
    Request,
    Response,
    Date,
    Deno: {
      env: { get: (key) => env[key] },
      serve: (value) => { handler = value; },
    },
  };
  vm.runInNewContext(executable(), context, { filename: functionPath });
  return handler;
}

function repBase44({ members, user: suppliedUser } = {}) {
  const user = suppliedUser || { id: 'rep-1', role: 'user', app_role: 'rep', team_manager_id: 'manager-1' };
  const rows = members || [{ id: 'member-1', user_id: 'rep-1', manager_id: 'manager-1', role: 'rep', status: 'active' }];
  const calls = [];
  return {
    calls,
    client: {
      auth: { me: async () => user },
      entities: {
        TeamMember: {
          filter: async (...args) => {
            calls.push(args);
            return rows;
          },
        },
      },
    },
  };
}

function request(body = {}, method = 'POST') {
  return new Request('https://example.test/functions/canvasGetAssignmentIndex', {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

function indexRow(overrides = {}) {
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const assignmentExpiry = new Date(Date.now() + 48 * 60 * 60_000).toISOString();
  const packageExpiry = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  return {
    assignment_id: 'assignment-1',
    manager_id: 'manager-1',
    campaign_id: 'campaign-1',
    zone_id: 'zone-1',
    assignee_user_id: 'rep-1',
    team_member_id: 'member-1',
    assignment_package_version: '3',
    assignment_package_status: 'ready',
    assignment_status: 'active',
    valid_from: issuedAt,
    valid_until: assignmentExpiry,
    revoked_at: null,
    deployment_status: 'active',
    assignment_index_version: '4',
    superseded_by_campaign_id: null,
    package_id: 'package-3',
    package_version: '3',
    package_status: 'ready',
    manifest_hash: 'a'.repeat(64),
    issued_at: issuedAt,
    package_valid_until: packageExpiry,
    effective_valid_until: packageExpiry,
    ...overrides,
  };
}

test('operational assignment index is self-contained, POST-only, capped, and Precision-isolated', async () => {
  executable();
  assert.doesNotMatch(source, /from ['"]\.\.?\//);
  assert.match(source, /const MAX_PAGE_SIZE = 100/);
  assert.match(source, /const MAX_BODY_BYTES = 8_192/);
  assert.match(source, /if \(req\.method !== "POST"\)/);
  assert.match(source, /Deno\.env\.get\("CANVAS_DATABASE_URL"\)/);
  assert.doesNotMatch(source, /Deno\.env\.get\(["'](?:DATABASE_URL|NEON_DATABASE_URL)["']\)/);
  assert.doesNotMatch(source, /SavedRoute|InteractionLog|MasterProperty|workspace_properties|recordKnockOutcome|entities\.CanvasSession/);

  let authCalls = 0;
  const handler = loadFunction({ base44: { auth: { me: async () => { authCalls += 1; return null; } } } });
  const response = await handler(request({}, 'GET'));
  assert.equal(response.status, 405);
  assert.equal(authCalls, 0);
});

test('rep resolution requires one exact active tenant TeamMember before database access', async () => {
  const { client, calls } = repBase44({
    members: [
      { id: 'member-1', user_id: 'rep-1', manager_id: 'manager-1', role: 'rep', status: 'active' },
      { id: 'member-2', user_id: 'rep-1', manager_id: 'manager-1', role: 'rep', status: 'active' },
    ],
  });
  let databaseCalls = 0;
  const handler = loadFunction({
    base44: client,
    neonFactory: () => {
      databaseCalls += 1;
      return async () => [];
    },
    env: { CANVAS_DATABASE_URL: 'postgres://canvas-only' },
  });
  const response = await handler(request());
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'ambiguous_team_membership');
  assert.equal(databaseCalls, 0);
  assert.equal(calls[0][0].user_id, 'rep-1');
  assert.equal(calls[0][0].status, 'active');
  assert.equal(calls[0][2], 20);
});

test('index query binds exact manager, user, member and returns only the bounded package index', async () => {
  const { client } = repBase44();
  let observedUrl;
  let observedQuery;
  let observedParameters;
  const first = indexRow();
  const second = indexRow({ assignment_id: 'assignment-2', package_id: 'package-4', package_version: '4', assignment_package_version: '4' });
  const handler = loadFunction({
    base44: client,
    neonFactory: (url) => {
      observedUrl = url;
      return async (queryText, parameters) => {
        observedQuery = queryText;
        observedParameters = parameters;
        return [first, second];
      };
    },
    env: { CANVAS_DATABASE_URL: 'postgres://canvas-only' },
  });
  const response = await handler(request({ limit: 1 }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.schema, 'firstknock.canvas-assignment-index');
  assert.equal(payload.assignments.length, 1);
  assert.deepEqual(payload.assignments[0], {
    assignment_id: 'assignment-1',
    package_id: 'package-3',
    package_version: 3,
    manifest_hash: 'a'.repeat(64),
    valid_until: first.effective_valid_until,
    campaign_id: 'campaign-1',
    zone_id: 'zone-1',
    assignment_index_version: 4,
  });
  assert.equal(payload.has_more, true);
  assert.equal(payload.next_cursor, 'assignment-1');
  assert.equal(observedUrl, 'postgres://canvas-only');
  assert.deepEqual(Array.from(observedParameters), ['manager-1', 'rep-1', 'member-1', null, 2]);
  assert.match(observedQuery, /a\.manager_id = \$1/);
  assert.match(observedQuery, /a\.assignee_user_id = \$2/);
  assert.match(observedQuery, /a\.team_member_id = \$3/);
});

test('SQL and runtime both fail closed on state, package, residential, and expiry boundaries', async () => {
  assert.match(source, /a\.status = 'active'/);
  assert.match(source, /a\.package_status = 'ready'/);
  assert.match(source, /a\.revoked_at IS NULL/);
  assert.match(source, /a\.valid_until IS NULL OR a\.valid_until > NOW\(\)/);
  assert.match(source, /d\.status = 'active'/);
  assert.match(source, /d\.closed_at IS NULL/);
  assert.match(source, /d\.superseded_by_campaign_id IS NULL/);
  assert.match(source, /d\.evidence_release_id IS NOT NULL/);
  assert.match(source, /p\.package_version = a\.package_version/);
  assert.match(source, /p\.status = 'ready'/);
  assert.match(source, /p\.valid_until > NOW\(\)/);
  assert.match(source, /LIMIT \$5/);

  const { client } = repBase44();
  const handler = loadFunction({
    base44: client,
    neonFactory: () => async () => [indexRow({ manager_id: 'manager-other' })],
    env: { CANVAS_DATABASE_URL: 'postgres://canvas-only' },
  });
  const response = await handler(request());
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'canvas_assignment_index_integrity_failed');
});

test('pagination cursor and page size are validated before any operational query', async () => {
  const { client } = repBase44();
  let queryCalls = 0;
  const handler = loadFunction({
    base44: client,
    neonFactory: () => async () => { queryCalls += 1; return []; },
    env: { CANVAS_DATABASE_URL: 'postgres://canvas-only' },
  });
  const tooLarge = await handler(request({ limit: 101 }));
  assert.equal(tooLarge.status, 400);
  assert.equal((await tooLarge.json()).error, 'invalid_assignment_index_limit');
  const emptyCursor = await handler(request({ cursor: '' }));
  assert.equal(emptyCursor.status, 400);
  assert.equal((await emptyCursor.json()).error, 'invalid_assignment_index_cursor');
  assert.equal(queryCalls, 0);
});
