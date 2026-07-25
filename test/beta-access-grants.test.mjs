import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

function grantDocument(userId, overrides = {}) {
  const now = Date.now();
  return JSON.stringify({
    version: 1,
    grants: {
      [userId]: {
        grant_id: 'beta-devin-001',
        status: 'active',
        precision_limit: 1000,
        starts_at: new Date(now - 60_000).toISOString(),
        ends_at: new Date(now + 3_600_000).toISOString(),
        canvas_seats: 1,
        ...overrides
      }
    }
  });
}

function loadFunction(path, { base44, env = {}, expose = '' } = {}) {
  const source = `${readSource(path)}\n${expose}`;
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: path,
    reportDiagnostics: true
  });
  const errors = (transpiled.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], `${path} contains TypeScript errors`);
  let handler;
  class UnexpectedStripe {
    constructor() {
      throw new Error('Stripe must not be consulted for a matching beta grant.');
    }
  }
  const sandbox = {
    console,
    createClientFromRequest: () => base44,
    Stripe: UnexpectedStripe,
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Request,
    Response,
    URL,
    URLSearchParams,
    AbortController,
    structuredClone,
    setTimeout,
    clearTimeout,
    Deno: {
      env: { get: (key) => env[key] ?? null },
      serve: (registered) => { handler = registered; }
    }
  };
  const executable = transpiled.outputText.replace(/^import .*;\s*$/gm, '');
  vm.runInNewContext(executable, sandbox, { filename: path });
  return { handler, sandbox };
}

async function invoke(handler, body) {
  const response = await handler(new Request('https://example.test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }));
  return { response, result: await response.json() };
}

test('active immutable-ID beta grant authorizes Canvas draft and returns finite beta deploy seats', async () => {
  const user = {
    id: 'immutable_user_1',
    email: 'devinfgalligan@gmail.com',
    role: 'user',
    app_role: 'manager',
    is_owner: true,
    subscription_tier: 'canvas',
    subscription_status: 'active',
    subscription_paid_confirmed: true
  };
  const env = { BETA_ACCESS_GRANTS: grantDocument(user.id) };
  const base44 = { auth: { me: async () => user } };
  const save = loadFunction('base44/functions/canvasSaveDraft/entry.ts', { base44, env });
  const attemptedSave = await invoke(save.handler, {});
  assert.equal(attemptedSave.response.status, 400);
  assert.equal(attemptedSave.result.error, 'invalid_plan', 'grant must pass entitlement before plan validation');

  const deploy = loadFunction('base44/functions/canvasDeployCampaign/entry.ts', {
    base44,
    env,
    expose: 'globalThis.__resolveCanvasEntitlement = resolveCanvasEntitlement;'
  });
  const entitlement = await deploy.sandbox.__resolveCanvasEntitlement(user);
  assert.equal(entitlement.kind, 'beta');
  assert.equal(entitlement.seats, 1);
  assert.equal(entitlement.canvas_seats, 1);
  assert.equal(Number.isFinite(entitlement.canvas_seats), true);
  assert.equal(entitlement.subscription_id, null);
  assert.equal(entitlement.grant_id, 'beta-devin-001');
});

test('matching expired or malformed beta grant cannot inherit Canvas access from display-cache fields', async () => {
  const user = {
    id: 'immutable_user_1',
    role: 'user',
    app_role: 'manager',
    is_owner: true,
    subscription_tier: 'canvas',
    subscription_status: 'active',
    subscription_paid_confirmed: true
  };
  const expired = grantDocument(user.id, {
    starts_at: new Date(Date.now() - 120_000).toISOString(),
    ends_at: new Date(Date.now() - 60_000).toISOString()
  });
  const base44 = { auth: { me: async () => user } };
  const save = loadFunction('base44/functions/canvasSaveDraft/entry.ts', {
    base44,
    env: { BETA_ACCESS_GRANTS: expired }
  });
  const attemptedSave = await invoke(save.handler, {});
  assert.equal(attemptedSave.response.status, 403);
  assert.equal(attemptedSave.result.error, 'canvas_entitlement_required');

  const deploy = loadFunction('base44/functions/canvasDeployCampaign/entry.ts', {
    base44,
    env: { BETA_ACCESS_GRANTS: grantDocument(user.id, { canvas_seats: '1' }) },
    expose: 'globalThis.__resolveCanvasEntitlement = resolveCanvasEntitlement;'
  });
  await assert.rejects(
    () => deploy.sandbox.__resolveCanvasEntitlement(user),
    (error) => error?.status === 403 && error?.code === 'canvas_entitlement_required'
  );
});

test('admin beta grant requires the caller built-in admin role', async () => {
  let filterCalled = false;
  const base44 = {
    auth: { me: async () => ({ id: 'actor_1', role: 'user', app_role: 'admin' }) },
    asServiceRole: {
      entities: {
        User: {
          filter: async () => { filterCalled = true; return []; },
          update: async () => { throw new Error('must not update'); }
        }
      }
    }
  };
  const loaded = loadFunction('base44/functions/adminSetOwner/entry.ts', {
    base44,
    env: { BETA_ACCESS_GRANTS: grantDocument('immutable_user_1') }
  });
  const attempted = await invoke(loaded.handler, { target_email: 'devinfgalligan@gmail.com' });
  assert.equal(attempted.response.status, 403);
  assert.equal(filterCalled, false);
});

test('admin beta grant normalizes an exact email, requires exactly one target, and writes only access cache fields', async () => {
  const queries = [];
  const updates = [];
  const target = { id: 'immutable_user_1', email: 'devinfgalligan@gmail.com', role: 'admin' };
  const base44 = {
    auth: { me: async () => ({ id: 'actor_admin', role: 'admin', app_role: 'rep' }) },
    asServiceRole: {
      entities: {
        User: {
          filter: async (query, sort, limit) => {
            queries.push({ query, sort, limit });
            return [target];
          },
          update: async (id, patch) => { updates.push({ id, patch }); return { ...target, ...patch }; }
        }
      }
    }
  };
  const loaded = loadFunction('base44/functions/adminSetOwner/entry.ts', {
    base44,
    env: { BETA_ACCESS_GRANTS: grantDocument(target.id) }
  });
  const granted = await invoke(loaded.handler, { target_email: '  DEVINFGALLIGAN@GMAIL.COM  ' });
  assert.equal(granted.response.status, 200);
  assert.deepEqual(plain(queries), [{ query: { email: 'devinfgalligan@gmail.com' }, sort: 'created_date', limit: 2 }]);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, target.id);
  assert.deepEqual(plain(updates[0].patch), {
    role: 'user',
    app_role: 'manager',
    is_owner: true,
    subscription_status: 'active',
    subscription_tier: 'canvas',
    subscription_paid_confirmed: true,
    stripe_card_on_file_confirmed: false,
    total_seats: 1
  });
  assert.equal(granted.result.target_user_id, target.id);
  assert.equal(granted.result.granted_by_user_id, 'actor_admin');
  assert.equal(granted.result.precision_limit, 1000);
  assert.equal(granted.result.canvas_seats, 1);
  assert.equal(Object.hasOwn(updates[0].patch, 'territory_property_count'), false);
  assert.equal(Object.hasOwn(updates[0].patch, 'routes'), false);
});

test('admin beta grant rejects ambiguous and non-exact target results before mutation', async () => {
  for (const rows of [
    [
      { id: 'immutable_user_1', email: 'devinfgalligan@gmail.com' },
      { id: 'immutable_user_2', email: 'devinfgalligan@gmail.com' }
    ],
    [{ id: 'immutable_user_1', email: 'devinfgalligan@gmail.com.evil' }]
  ]) {
    let updateCalled = false;
    const base44 = {
      auth: { me: async () => ({ id: 'actor_admin', role: 'admin' }) },
      asServiceRole: {
        entities: {
          User: {
            filter: async () => rows,
            update: async () => { updateCalled = true; }
          }
        }
      }
    };
    const loaded = loadFunction('base44/functions/adminSetOwner/entry.ts', {
      base44,
      env: { BETA_ACCESS_GRANTS: grantDocument('immutable_user_1') }
    });
    const attempted = await invoke(loaded.handler, { target_email: 'devinfgalligan@gmail.com' });
    assert.ok([404, 409].includes(attempted.response.status));
    assert.equal(updateCalled, false);
  }
});
