import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

function loadSource(path, appendix, { env = {}, Client = class {} } = {}) {
  const source = read(path);
  const result = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], `${path} contains TypeScript errors`);
  const context = {
    console,
    Client,
    createClientFromRequest: () => ({}),
    Stripe: class {},
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    Request,
    Response,
    URL,
    atob,
    btoa,
    structuredClone,
    Deno: {
      env: { get: (key) => env[key] },
      serve: () => undefined,
    },
  };
  const executable = `${result.outputText.replace(/^import .*;\s*$/gm, '').replace(/^export\s+/gm, '')}\n${appendix}`;
  vm.runInNewContext(executable, context, { filename: path });
  return context;
}

function operationalState({ campaignId = 'campaign-old', status = 'active', includeDeployment = true } = {}) {
  return {
    deployments: includeDeployment ? new Map([[campaignId, {
      campaign_id: campaignId,
      manager_id: 'manager-1',
      plan_version: 4,
      plan_hash: 'a'.repeat(64),
      lifecycle_version: 4,
      assignment_index_version: 7,
      status,
      deployed_at: '2026-08-14T10:00:00.000Z',
      closed_at: null,
      lifecycle_action: null,
      lifecycle_idempotency_key: null,
      superseded_by_campaign_id: null,
    }]]) : new Map(),
    assignments: [{
      assignment_id: 'assignment-old', manager_id: 'manager-1', campaign_id: campaignId,
      status: 'active', package_status: 'ready', revoked_at: null, revocation_reason: null,
    }],
    packages: [{ package_id: 'package-old', manager_id: 'manager-1', assignment_id: 'assignment-old', status: 'ready' }],
    queries: [],
  };
}

function fakeClientFor(state) {
  return class FakeClient {
    constructor(url) { state.url = url; }
    async connect() { state.connected = true; }
    async end() { state.ended = true; }
    async query(statement, parameters = []) {
      const sql = String(statement).replace(/\s+/g, ' ').trim();
      state.queries.push(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
      if (sql.startsWith('INSERT INTO canvas_deployments')) {
        const campaignId = parameters[0];
        if (!state.deployments.has(campaignId)) {
          const isSupersession = sql.includes("'superseded'");
          state.deployments.set(campaignId, {
            campaign_id: campaignId,
            manager_id: parameters[1],
            plan_version: Number(parameters[2]),
            plan_hash: parameters[3],
            lifecycle_version: Number(parameters[4]),
            assignment_index_version: 1,
            status: isSupersession ? 'superseded' : parameters[8],
            deployed_at: isSupersession ? parameters[8] : parameters[9],
            closed_at: isSupersession ? parameters[9] : parameters[10],
            closed_by_user_id: isSupersession ? parameters[10] : parameters[11],
            lifecycle_action: isSupersession ? 'supersede' : parameters[12],
            lifecycle_idempotency_key: isSupersession ? parameters[11] : parameters[13],
            superseded_by_campaign_id: isSupersession ? parameters[12] : null,
          });
        }
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT * FROM canvas_deployments')) {
        const deployment = state.deployments.get(parameters[0]);
        return { rows: deployment ? [{ ...deployment }] : [], rowCount: deployment ? 1 : 0 };
      }
      if (sql.startsWith('UPDATE canvas_assignment_packages')) {
        let count = 0;
        for (const assignment of state.assignments.filter((row) => row.manager_id === parameters[0] && row.campaign_id === parameters[1])) {
          for (const packageRow of state.packages.filter((row) => row.manager_id === parameters[0] && row.assignment_id === assignment.assignment_id)) {
            if (['building', 'ready'].includes(packageRow.status)) { packageRow.status = 'revoked'; count += 1; }
          }
        }
        return { rows: [], rowCount: count };
      }
      if (sql.startsWith('UPDATE canvas_assignments')) {
        let count = 0;
        for (const assignment of state.assignments.filter((row) => row.manager_id === parameters[0] && row.campaign_id === parameters[1])) {
          assignment.status = sql.includes("status = 'superseded'") ? 'superseded' : parameters[2];
          assignment.package_status = 'revoked';
          assignment.revoked_at ||= parameters[2] === 'completed' || parameters[2] === 'revoked' ? parameters[3] : parameters[2];
          assignment.revocation_reason ||= parameters.at(-1);
          count += 1;
        }
        return { rows: [], rowCount: count };
      }
      if (sql.startsWith('UPDATE canvas_deployments')) {
        const deployment = state.deployments.get(parameters[0]);
        if (!deployment || deployment.manager_id !== parameters[1]) return { rows: [], rowCount: 0 };
        const previous = deployment.status;
        if (sql.includes("status = 'superseded'")) {
          deployment.status = 'superseded';
          deployment.closed_at ||= parameters[3];
          deployment.closed_by_user_id ||= parameters[4];
          deployment.lifecycle_action ||= 'supersede';
          deployment.lifecycle_idempotency_key ||= parameters[5];
          deployment.superseded_by_campaign_id ||= parameters[6];
          deployment.assignment_index_version += 1;
        } else {
          deployment.status = parameters[2];
          deployment.closed_at ||= parameters[4];
          deployment.closed_by_user_id ||= parameters[5];
          deployment.lifecycle_action ||= parameters[6];
          deployment.lifecycle_idempotency_key ||= parameters[7];
          if (previous !== deployment.status) deployment.assignment_index_version += 1;
        }
        return { rows: [{ ...deployment }], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
}

const v2Session = (overrides = {}) => ({
  id: 'campaign-old',
  manager_id: 'manager-1',
  territory_model: 'residential_street_territory_v2',
  deployment_plan_version: 4,
  version: 4,
  plan_hash: 'a'.repeat(64),
  evidence_release_id: 'release-1',
  revision_id: 'revision-1',
  algorithm_version: 'canvas-residential-v2',
  deployed_at: '2026-08-14T10:00:00.000Z',
  ...overrides,
});

test('complete and recall atomically revoke current v2 assignments and signed packages', async () => {
  for (const [action, targetState, assignmentStatus] of [
    ['complete', 'completed', 'completed'],
    ['recall', 'recalled', 'revoked'],
  ]) {
    const state = operationalState();
    const context = loadSource(
      'base44/functions/canvasCloseCampaign/entry.ts',
      'globalThis.__closeOperationalCampaign = closeOperationalCampaign;',
      { env: { CANVAS_DATABASE_URL: 'postgres://canvas-only' }, Client: fakeClientFor(state) },
    );
    const result = await context.__closeOperationalCampaign(v2Session(), {
      targetState,
      action,
      idempotencyKey: `${action}:request-123`,
      closedAt: '2026-08-14T12:00:00.000Z',
      closedByUserId: 'manager-1',
      lifecycleVersion: 5,
    });
    assert.equal(result.status, targetState);
    assert.equal(state.deployments.get('campaign-old').status, targetState);
    assert.equal(state.assignments[0].status, assignmentStatus);
    assert.equal(state.assignments[0].package_status, 'revoked');
    assert.equal(state.packages[0].status, 'revoked');
    assert.ok(state.queries.indexOf('BEGIN ISOLATION LEVEL SERIALIZABLE') < state.queries.indexOf('COMMIT'));
  }
});

test('v2 close creates a durable tombstone before any package exists and retries exactly once', async () => {
  const state = operationalState({ includeDeployment: false });
  state.assignments = [];
  state.packages = [];
  const context = loadSource(
    'base44/functions/canvasCloseCampaign/entry.ts',
    'globalThis.__closeOperationalCampaign = closeOperationalCampaign;',
    { env: { CANVAS_DATABASE_URL: 'postgres://canvas-only' }, Client: fakeClientFor(state) },
  );
  const request = {
    targetState: 'recalled', action: 'recall', idempotencyKey: 'recall:request-123',
    closedAt: '2026-08-14T12:00:00.000Z', closedByUserId: 'manager-1', lifecycleVersion: 5,
  };
  const first = await context.__closeOperationalCampaign(v2Session(), request);
  const version = first.assignment_index_version;
  const retry = await context.__closeOperationalCampaign(v2Session(), request);
  assert.equal(retry.assignment_index_version, version);
  assert.equal(state.deployments.get('campaign-old').status, 'recalled');
  await assert.rejects(
    context.__closeOperationalCampaign(v2Session(), { ...request, idempotencyKey: 'recall:different-456' }),
    (error) => error?.code === 'canvas_operational_lifecycle_conflict',
  );
});

test('legacy Canvas close never depends on the operational database', async () => {
  const context = loadSource(
    'base44/functions/canvasCloseCampaign/entry.ts',
    'globalThis.__closeOperationalCampaign = closeOperationalCampaign;',
  );
  const result = await context.__closeOperationalCampaign(
    v2Session({ territory_model: 'street_territory_v1' }),
    { targetState: 'completed', action: 'complete', idempotencyKey: 'legacy:close-1', closedAt: '2026-08-14T12:00:00.000Z' },
  );
  assert.equal(result.required, false);
});

test('replacement packages are built before predecessor revocation and both publish in one transaction', () => {
  const publish = read('base44/functions/canvasPublishAssignmentPackages/entry.ts');
  const migration = read('base44/functions/setupCanvasOperationalStore/entry.ts');
  const handler = publish.slice(publish.lastIndexOf('Deno.serve'));
  const store = handler.indexOf('const stored = await storePackage');
  const supersede = handler.indexOf('await supersedeOperationalPredecessors', store);
  const activate = handler.indexOf('await activateOperationalDeployment', supersede);
  const commit = handler.indexOf('await client.query("COMMIT")', activate);
  assert.ok(store > -1 && supersede > store && activate > supersede && commit > activate);
  assert.match(publish, /VALUES \(\$1, \$2, \$3, \$4, 1, 1, \$5, \$6, \$7, 'packaging', \$8\)/);
  assert.match(migration, /superseded_by_campaign_id TEXT/);
  assert.match(migration, /lifecycle_idempotency_key TEXT/);
  assert.doesNotMatch(read('base44/functions/canvasDeployCampaign/entry.ts'), /CANVAS_DATABASE_URL|supersedeOperationalCampaigns/);
});

test('publisher supersession revokes predecessor ownership and binds it to the exact successor', async () => {
  const state = operationalState();
  const context = loadSource(
    'base44/functions/canvasPublishAssignmentPackages/entry.ts',
    'globalThis.__supersede = supersedeOperationalPredecessors;',
  );
  const client = new (fakeClientFor(state))('postgres://canvas-only');
  const result = await context.__supersede(client, v2Session({ id: 'campaign-new' }), [v2Session()], {
    transitionedAt: '2026-08-14T12:00:00.000Z',
    transitionedByUserId: 'manager-1',
    publicationIdempotencyKey: 'publish:replacement-1',
  });
  assert.deepEqual([...result], ['campaign-old']);
  assert.equal(state.deployments.get('campaign-old').status, 'superseded');
  assert.equal(state.deployments.get('campaign-old').superseded_by_campaign_id, 'campaign-new');
  assert.equal(state.assignments[0].status, 'superseded');
  assert.equal(state.packages[0].status, 'revoked');
});

test('retrieval, decision sync, and delta sync all reject a closed operational deployment', () => {
  const getContext = loadSource(
    'base44/functions/canvasGetAssignmentPackage/entry.ts',
    'globalThis.__verify = verifyAssignmentState;',
  );
  const syncContext = loadSource(
    'base44/functions/canvasSyncDecisions/entry.ts',
    'globalThis.__verify = validateAssignmentRow;',
  );
  const changesContext = loadSource(
    'base44/functions/canvasGetChanges/entry.ts',
    'globalThis.__verify = validateAssignment;',
  );
  const row = {
    manager_id: 'manager-1', assignee_user_id: 'rep-user', team_member_id: 'member-1',
    deployment_status: 'completed', assignment_status: 'completed', assignment_package_status: 'revoked',
    package_status: 'revoked', package_record_status: 'revoked', package_version: 1,
  };
  const user = { id: 'rep-user' };
  const rep = { managerId: 'manager-1', teamMemberId: 'member-1' };
  const actor = { managerId: 'manager-1', teamMemberId: 'member-1', isManager: false };
  assert.throws(() => getContext.__verify(row, user, rep, 1), (error) => error?.code === 'campaign_not_active');
  assert.throws(() => syncContext.__verify(row, actor, user, 1), (error) => error?.code === 'campaign_not_active');
  assert.throws(() => changesContext.__verify(row, actor, user, 1), (error) => error?.code === 'campaign_not_active');
});
