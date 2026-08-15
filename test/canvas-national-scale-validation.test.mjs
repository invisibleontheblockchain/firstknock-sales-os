import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { canvasChangesToOfflineDelta } from '../src/components/canvas/canvasOfflinePackageRuntime.js';
import {
  createCanvasOfflineStore,
  createMemoryCanvasStorage,
} from '../src/components/canvas/canvasOfflineStore.js';
import { createCanvasSyncEngine } from '../src/components/canvas/canvasSyncEngine.js';
import { partitionCanvasResidentialTerritories } from '../src/components/logic/canvasResidentialTerritoryAnalysis.js';
import {
  canvasStoredPlanForHash,
  signCanvasLifecycle,
} from './helpers/canvasLifecycleSignature.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publisherPath = 'base44/functions/canvasPublishAssignmentPackages/entry.ts';
const publisherSource = readFileSync(resolve(root, publisherPath), 'utf8');
const fieldRuntimeSource = readFileSync(resolve(root, 'src/components/rep/CanvasResidentialFieldView.jsx'), 'utf8');
const syncSource = readFileSync(resolve(root, 'base44/functions/canvasSyncDecisions/entry.ts'), 'utf8');
const changeSource = readFileSync(resolve(root, 'base44/functions/canvasGetChanges/entry.ts'), 'utf8');

const SCALE = Object.freeze({
  reps: 100,
  workUnits: 20_000,
  areas: 250,
  decisionsPerRep: 100,
  changesPerRep: 501,
});

const GATES = Object.freeze({
  plannerMs: 30_000,
  publisherMs: 30_000,
  offlineCatchupMs: 30_000,
  publisherSqlQueries: 160,
  rosterQueries: 2,
  packageBytes: 24_000_000,
  publicationBytes: 192_000_000,
  launchScenarioPublicationBytes: 64_000_000,
  artifactBytes: 2_000_000,
  syncBodyBytes: 256_000,
  syncBatchItems: 100,
  runtimeSyncBatchItems: 25,
  changePageItems: 500,
  recoverySyncMs: 5 * 60_000,
  catchupRequestsPerRep: 6,
  catchupRequestsTeam: 600,
  idleRecoveryRequestsPerMinute: 20,
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalBytes(value) {
  return new TextEncoder().encode(JSON.stringify(canonicalize(value)));
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function executablePublisher() {
  const result = ts.transpileModule(publisherSource, {
    fileName: publisherPath,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], 'Canvas package publisher contains TypeScript syntax errors');
  return result.outputText.replace(/^import .*;\s*$/gm, '').replace(/^export\s+/gm, '');
}

function chainWorkUnits(count, { includeSegments = false } = {}) {
  const idFor = (index) => `national-unit-${String(index).padStart(5, '0')}`;
  return Array.from({ length: count }, (_, index) => {
    const unit = {
      id: idFor(index),
      canvas_role: 'knock',
      neighbor_ids: [
        index > 0 ? idFor(index - 1) : null,
        index + 1 < count ? idFor(index + 1) : null,
      ].filter(Boolean),
      opportunity_low: 1,
      opportunity_expected: 1,
      opportunity_high: 1,
    };
    if (!includeSegments) return unit;
    const row = index % 200;
    const column = Math.floor(index / 200);
    const lat = 32 + row / 100_000;
    const lng = -124 + column / 100_000;
    return {
      ...unit,
      street_names: [`Scale Street ${index}`],
      street_length_meters: 12,
      segments: [{
        edge_id: `edge-${index}`,
        start: { lat, lng },
        end: { lat, lng: lng + 0.00001 },
        street_names: [`Scale Street ${index}`],
        highway_types: ['residential'],
        length_meters: 12,
      }],
    };
  });
}

function partitionedZones(workUnits, zoneCount, members) {
  const unitsPerZone = workUnits.length / zoneCount;
  assert.equal(Number.isInteger(unitsPerZone), true, 'scale fixture must divide evenly');
  return Array.from({ length: zoneCount }, (_, index) => ({
    zone_id: `national-zone-${String(index).padStart(3, '0')}`,
    zone_number: index + 1,
    assigned_team_member_id: members[index].id,
    work_unit_ids: workUnits.slice(index * unitsPerZone, (index + 1) * unitsPerZone).map((unit) => unit.id),
    opportunity_expected: unitsPerZone,
    workload_score: unitsPerZone,
    street_length_meters: unitsPerZone * 12,
  }));
}

async function publisherFixture() {
  const deployedAt = '2026-08-14T12:00:00.000Z';
  const lifecycleSecret = 'national-scale-lifecycle-secret-at-least-32-bytes';
  const keys = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const privateKey = new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey));
  const publicKey = new Uint8Array(await webcrypto.subtle.exportKey('raw', keys.publicKey));
  const members = Array.from({ length: SCALE.reps }, (_, index) => ({
    id: `member-${String(index).padStart(3, '0')}`,
    user_id: `rep-${String(index).padStart(3, '0')}`,
    manager_id: 'manager-national',
    status: 'active',
    role: 'rep',
    email: `rep-${index}@national.example`,
  }));
  const users = members.map((member) => ({
    id: member.user_id,
    team_manager_id: member.manager_id,
    email: member.email,
  }));
  const workUnits = chainWorkUnits(SCALE.workUnits, { includeSegments: true });
  const zones = partitionedZones(workUnits, SCALE.reps, members);
  const session = {
    id: 'campaign-national-scale',
    manager_id: 'manager-national',
    status: 'deployed',
    lifecycle_state: 'active',
    version: 1,
    deployment_plan_version: 1,
    session_name: 'National scale validation',
    territory_model: 'residential_street_territory_v2',
    polygon: [
      { lat: 32, lng: -124 },
      { lat: 32.1, lng: -124 },
      { lat: 32.1, lng: -123.9 },
      { lat: 32, lng: -123.9 },
    ],
    rep_count: SCALE.reps,
    planning_method: 'residential_opportunity',
    assignment_basis: 'street_work_unit_ids',
    workload_basis: 'residential_opportunity',
    division_mode: 'fixed_area_count',
    target_workload: null,
    selected_team_member_ids: members.map((member) => member.id),
    zones,
    work_units: workUnits,
    qa: {
      connected_zones: true,
      protected_units_intact: true,
      exclusive_work_unit_coverage: true,
      unresolved_unit_count: 0,
    },
    algorithm_version: 'canvas-residential-territory-v2',
    data_version: 'national-scale-fixture-v1',
    evidence_id: 'canvas_evidence_national_scale',
    evidence_release_id: 'canvas_release_national_scale',
    revision_id: null,
    snapshot_hash: 'a'.repeat(64),
    evidence_schema_version: 1,
    unresolved_unit_count: 0,
    assignment_version: 1,
    deployed_at: deployedAt,
    deployed_by_user_id: 'manager-national',
    deployment_idempotency_key: 'deploy-national-scale',
    lifecycle_evidence: {
      state: 'active',
      transition: 'deploy',
      schema_version: 1,
      transitioned_at: deployedAt,
      transitioned_by_user_id: 'manager-national',
      idempotency_key: 'deploy-national-scale',
      to_version: 1,
      from_version: 1,
      previous_signature: null,
    },
    deployment_qa: {
      lifecycle_state: 'active',
      lifecycle_transition: 'deploy',
      lifecycle_transitioned_at: deployedAt,
      lifecycle_transitioned_by_user_id: 'manager-national',
      verified_team_member_bindings: members.map((member) => ({
        team_member_id: member.id,
        user_id: member.user_id,
        email: member.email,
      })),
    },
    closed_at: null,
    closed_by_user_id: null,
    close_action: null,
    close_idempotency_key: null,
  };
  session.plan_hash = sha256Hex(canonicalBytes(canvasStoredPlanForHash(session)));
  session.deployment_signature = await signCanvasLifecycle(lifecycleSecret, session);
  return {
    session,
    members,
    users,
    lifecycleSecret,
    packagePrivateKey: base64Url(privateKey),
    packagePublicKey: base64Url(publicKey),
  };
}

class PublicationDatabaseMock {
  constructor(session) {
    this.session = session;
    this.queryCount = 0;
    this.assignmentRows = [];
    this.ownershipCounts = new Map();
    this.artifactByteSizes = [];
    this.packageByteSizes = [];
  }

  async connect() {}

  async end() {}

  async query(statement, parameters = []) {
    this.queryCount += 1;
    const sql = String(statement).replace(/\s+/g, ' ').trim();
    if (['BEGIN ISOLATION LEVEL SERIALIZABLE', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('SELECT pg_advisory_xact_lock')) return { rows: [] };
    if (sql.startsWith('INSERT INTO canvas_deployments')) return { rows: [] };
    if (sql.startsWith('SELECT * FROM canvas_deployments')) {
      return { rows: [{
        campaign_id: this.session.id,
        manager_id: this.session.manager_id,
        plan_hash: this.session.plan_hash,
        plan_version: this.session.deployment_plan_version,
        status: 'active',
        assignment_index_version: 1,
      }] };
    }
    if (sql.startsWith('INSERT INTO canvas_assignments')) {
      this.assignmentRows = JSON.parse(parameters[0]).map((row) => ({ ...row, status: 'packaging' }));
      return { rows: [] };
    }
    if (sql.startsWith('SELECT * FROM canvas_assignments')) return { rows: this.assignmentRows };
    if (sql.startsWith('INSERT INTO canvas_work_unit_ownership')) {
      for (const row of JSON.parse(parameters[0])) {
        this.ownershipCounts.set(row.assignment_id, (this.ownershipCounts.get(row.assignment_id) || 0) + 1);
      }
      return { rows: [] };
    }
    if (sql.startsWith('SELECT assignment_id, COUNT(*)::bigint AS unit_count')) {
      return {
        rows: [...this.ownershipCounts].map(([assignment_id, unit_count]) => ({ assignment_id, unit_count })),
      };
    }
    if (sql.includes('FROM canvas_assignment_packages') && sql.includes('publication_idempotency_key')) return { rows: [] };
    if (sql.startsWith('SELECT COALESCE(MAX(cursor), 0) AS cursor')) return { rows: [{ cursor: 0 }] };
    if (sql.includes('FROM canvas_house_pins p')) return { rows: [] };
    if (sql.includes('FROM canvas_dnc_suppressions s')) return { rows: [] };
    if (sql.startsWith('SELECT requested.assignment_id')) {
      return { rows: parameters[1].map((assignment_id) => ({ assignment_id, maximum: null, package_count: 0 })) };
    }
    if (sql.startsWith('WITH inserted_package AS')) {
      const artifacts = JSON.parse(parameters[18]);
      const dncShards = JSON.parse(parameters[24]);
      this.artifactByteSizes.push(...artifacts.map((artifact) => Number(artifact.byte_size)));
      this.packageByteSizes.push(Number(parameters[15]));
      return { rows: [{
        package_count: 1,
        artifact_count: artifacts.length,
        dnc_manifest_count: 1,
        dnc_shard_count: dncShards.length,
        revoked_count: 0,
        assignment_count: 1,
      }] };
    }
    if (sql.startsWith('UPDATE canvas_deployments SET')) return { rows: [{ status: 'active', assignment_index_version: 2 }] };
    throw new Error(`National-scale database mock did not recognize query: ${sql.slice(0, 160)}`);
  }
}

function loadPublisher({ fixture, database, rosterCalls }) {
  let handler;
  const byMemberId = new Map(fixture.members.map((member) => [member.id, member]));
  const byUserId = new Map(fixture.users.map((user) => [user.id, user]));
  const filtered = (map) => async (filter) => {
    rosterCalls.count += 1;
    return (filter?.id?.$in || []).map((id) => map.get(id)).filter(Boolean);
  };
  const base44 = {
    auth: { me: async () => ({ id: fixture.session.manager_id, role: 'admin', app_role: 'manager' }) },
    entities: { CanvasSession: { get: async () => fixture.session } },
    asServiceRole: {
      entities: {
        TeamMember: { filter: filtered(byMemberId) },
        User: { filter: filtered(byUserId) },
      },
    },
  };
  const env = {
    CANVAS_DEPLOYMENT_SIGNING_SECRET: fixture.lifecycleSecret,
    CANVAS_DATABASE_URL: 'postgres://static-national-scale-mock',
    CANVAS_PACKAGE_SIGNING_PRIVATE_KEY: fixture.packagePrivateKey,
    CANVAS_PACKAGE_SIGNING_PRIVATE_KEY_FORMAT: 'pkcs8',
    CANVAS_PACKAGE_SIGNING_PUBLIC_KEY: fixture.packagePublicKey,
    CANVAS_PACKAGE_SIGNING_PUBLIC_KEY_FORMAT: 'raw',
    CANVAS_PACKAGE_SIGNING_KEY_ID: 'national-scale-test-key',
  };
  class ClientMock {
    constructor() { return database; }
  }
  vm.runInNewContext(executablePublisher(), {
    console,
    createClientFromRequest: () => base44,
    Client: ClientMock,
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
      serve: (value) => { handler = value; },
    },
  }, { filename: publisherPath });
  return handler;
}

test('national gate: 20,000 residential street units partition into 250 exact connected areas', (context) => {
  const input = chainWorkUnits(SCALE.workUnits);
  const startedAt = performance.now();
  const result = partitionCanvasResidentialTerritories({
    street_units: input,
    area_count: SCALE.areas,
  });
  const elapsedMs = performance.now() - startedAt;
  assert.equal(result.ok, true);
  assert.equal(result.zones.length, SCALE.areas);
  assert.equal(result.qa.connected_zones, true);
  assert.equal(result.qa.exclusive_work_unit_coverage, true);
  assert.equal(result.qa.max_opportunity_deviation_percent, 0);
  assert.equal(result.zones.flatMap((zone) => zone.work_unit_ids).length, SCALE.workUnits);
  assert.deepEqual(new Set(result.zones.map((zone) => zone.workload_score)), new Set([80]));
  assert.ok(elapsedMs < GATES.plannerMs, `national partition took ${Math.round(elapsedMs)}ms`);
  context.diagnostic(`partition_units=${SCALE.workUnits} areas=${SCALE.areas} elapsed_ms=${Math.round(elapsedMs)}`);
});

test('national gate: actual publisher packages 100 reps and 20,000 units within bounded queries and bytes', async (context) => {
  const fixture = await publisherFixture();
  const database = new PublicationDatabaseMock(fixture.session);
  const rosterCalls = { count: 0 };
  const handler = loadPublisher({ fixture, database, rosterCalls });
  const startedAt = performance.now();
  const response = await handler(new Request('https://firstknock.example/functions/canvasPublishAssignmentPackages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      campaign_id: fixture.session.id,
      publication_idempotency_key: 'national-scale-publication-1',
      valid_for_hours: 168,
    }),
  }));
  const elapsedMs = performance.now() - startedAt;
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.package_count, SCALE.reps);
  assert.equal(payload.packages.length, SCALE.reps);
  assert.equal(rosterCalls.count, GATES.rosterQueries);
  assert.ok(database.queryCount <= GATES.publisherSqlQueries, `publisher used ${database.queryCount} SQL queries`);
  assert.equal(database.ownershipCounts.size, SCALE.reps);
  assert.equal([...database.ownershipCounts.values()].reduce((sum, value) => sum + value, 0), SCALE.workUnits);
  assert.ok(Math.max(...database.artifactByteSizes) <= GATES.artifactBytes);
  assert.ok(Math.max(...database.packageByteSizes) <= GATES.packageBytes);
  assert.ok(payload.publication_bytes <= GATES.publicationBytes);
  assert.ok(payload.publication_bytes <= GATES.launchScenarioPublicationBytes,
    `launch fixture publication used ${payload.publication_bytes} bytes`);
  assert.ok(elapsedMs < GATES.publisherMs, `national publication took ${Math.round(elapsedMs)}ms`);
  context.diagnostic([
    `published_packages=${payload.package_count}`,
    `work_units=${SCALE.workUnits}`,
    `sql_queries=${database.queryCount}`,
    `roster_queries=${rosterCalls.count}`,
    `publication_bytes=${payload.publication_bytes}`,
    `largest_package_bytes=${Math.max(...database.packageByteSizes)}`,
    `largest_artifact_bytes=${Math.max(...database.artifactByteSizes)}`,
    `elapsed_ms=${Math.round(elapsedMs)}`,
  ].join(' '));
});

function decisionPayload(repIndex, decisionIndex) {
  return {
    client_recorded_at: '2026-08-14T12:00:00.000Z',
    point: { lat: 33 + repIndex / 100_000, lng: -112 + decisionIndex / 1_000_000 },
    outcome: decisionIndex % 25 === 0 ? 'do_not_knock' : 'no_answer',
    note: 'Deterministic offline scale decision.',
    address: `${decisionIndex + 1} Scale Street`,
    normalized_address: `${decisionIndex + 1} scale street`,
    unit_label: null,
    opportunity_id: `opportunity-${repIndex}-${decisionIndex}`,
  };
}

function backendSyncBody(scope, items) {
  return {
    assignment_id: `assignment-${scope.actorUserId}`,
    package_version: Number(scope.packageVersion),
    decisions: items.map((item) => ({
      ...item.payload,
      idempotency_key: item.idempotencyKey,
    })),
  };
}

async function simulateRepCatchup(repIndex, metrics) {
  const clock = Date.parse('2026-08-15T00:00:00.000Z');
  const store = createCanvasOfflineStore({
    storage: createMemoryCanvasStorage(),
    now: () => clock,
  });
  const scope = {
    actorUserId: `rep-${String(repIndex).padStart(3, '0')}`,
    campaignId: 'campaign-national-offline',
    zoneId: `zone-${String(repIndex).padStart(3, '0')}`,
    packageVersion: '1',
  };
  await store.putDncSnapshot({ ...scope, entries: [], complete: true, verified: true });
  let committedCursor = 0;
  const engine = createCanvasSyncEngine({
    store,
    now: () => clock,
    jitterRatio: 0,
    transport: {
      async syncBatch(request) {
        metrics.syncRequests += 1;
        metrics.syncRequestsByRep[repIndex] += 1;
        metrics.maxSyncBatchItems = Math.max(metrics.maxSyncBatchItems, request.items.length);
        const bodyBytes = canonicalBytes(backendSyncBody(scope, request.items)).byteLength;
        metrics.maxSyncBodyBytes = Math.max(metrics.maxSyncBodyBytes, bodyBytes);
        assert.ok(bodyBytes <= GATES.syncBodyBytes, `rep ${repIndex} emitted a ${bodyBytes}-byte sync body`);
        committedCursor += request.items.length;
        return {
          results: request.items.map((item) => ({ idempotency_key: item.idempotencyKey, status: 'committed' })),
          next_cursor: committedCursor,
        };
      },
    },
  });
  await Promise.all(Array.from({ length: SCALE.decisionsPerRep }, (_, decisionIndex) => engine.queue({
    ...scope,
    idempotencyKey: `decision-${repIndex}-${decisionIndex}`,
    payload: decisionPayload(repIndex, decisionIndex),
  })));
  const result = await engine.flushAvailable({ ...scope, maxBatches: 20 });
  assert.equal(result.committed, SCALE.decisionsPerRep);
  assert.equal(result.batches, 4);
  assert.equal(result.hasMore, false);
  const beforeEmptyFlush = metrics.syncRequests;
  assert.equal((await engine.flush(scope)).sent, 0);
  assert.equal(metrics.syncRequests, beforeEmptyFlush, 'committed decisions must not be resent');

  const changes = Array.from({ length: SCALE.changesPerRep }, (_, offset) => ({
    cursor: SCALE.decisionsPerRep + offset + 1,
    change_type: 'progress_changed',
    entity_id: scope.zoneId,
    payload: { event_count: offset + 1 },
  }));
  for (let page = 0; page < 20; page += 1) {
    const cursor = Number(await store.getCursor(scope) || 0);
    const available = changes.filter((change) => change.cursor > cursor);
    const rows = available.slice(0, GATES.changePageItems);
    const hasMore = available.length > rows.length;
    metrics.changeRequests += 1;
    metrics.changeRequestsByRep[repIndex] += 1;
    metrics.maxChangePageItems = Math.max(metrics.maxChangePageItems, rows.length);
    await store.applySyncResult({
      ...scope,
      expectedCursor: cursor,
      outcomes: [],
      delta: canvasChangesToOfflineDelta(rows),
      nextCursor: rows.length ? rows.at(-1).cursor : cursor,
    });
    if (!hasMore) break;
    if (page === 19) assert.fail('cursor catch-up exceeded the field runtime page guard');
  }
  assert.equal(await store.getCursor(scope), SCALE.decisionsPerRep + SCALE.changesPerRep);
}

test('national gate: 100 offline reps batch 10,000 decisions and page 50,100 changes within request guards', async (context) => {
  assert.match(syncSource, /const MAX_DECISIONS = 100/);
  assert.match(syncSource, /const MAX_BODY_BYTES = 256_000/);
  assert.match(changeSource, /const MAX_CHANGE_PAGE = 500/);
  assert.match(fieldRuntimeSource, /const RECOVERY_SYNC_MS = 5 \* 60_000/);
  assert.match(fieldRuntimeSource, /maxBatches: 20/);
  assert.match(fieldRuntimeSource, /for \(let page = 0; page < 20; page \+= 1\)/);

  const oneHundredItemBody = backendSyncBody(
    { actorUserId: 'rep-000', packageVersion: '1' },
    Array.from({ length: GATES.syncBatchItems }, (_, index) => ({
      idempotencyKey: `decision-compact-${index}`,
      payload: decisionPayload(0, index),
    })),
  );
  assert.ok(canonicalBytes(oneHundredItemBody).byteLength <= GATES.syncBodyBytes,
    'a representative 100-decision API batch must remain under the server body cap');

  const metrics = {
    syncRequests: 0,
    changeRequests: 0,
    syncRequestsByRep: Array(SCALE.reps).fill(0),
    changeRequestsByRep: Array(SCALE.reps).fill(0),
    maxSyncBatchItems: 0,
    maxSyncBodyBytes: 0,
    maxChangePageItems: 0,
  };
  const startedAt = performance.now();
  await Promise.all(Array.from({ length: SCALE.reps }, (_, index) => simulateRepCatchup(index, metrics)));
  const elapsedMs = performance.now() - startedAt;
  const totalRequests = metrics.syncRequests + metrics.changeRequests;
  const idleRecoveryRequestsPerMinute = SCALE.reps * 60_000 / GATES.recoverySyncMs;

  assert.equal(metrics.syncRequests, 400);
  assert.equal(metrics.changeRequests, 200);
  assert.equal(totalRequests, GATES.catchupRequestsTeam);
  assert.ok(metrics.syncRequestsByRep.every((count) => count === 4));
  assert.ok(metrics.changeRequestsByRep.every((count) => count === 2));
  assert.ok(metrics.syncRequestsByRep.every((count, index) =>
    count + metrics.changeRequestsByRep[index] <= GATES.catchupRequestsPerRep));
  assert.equal(metrics.maxSyncBatchItems, GATES.runtimeSyncBatchItems);
  assert.equal(metrics.maxChangePageItems, GATES.changePageItems);
  assert.ok(metrics.maxSyncBodyBytes <= GATES.syncBodyBytes);
  assert.equal(idleRecoveryRequestsPerMinute, GATES.idleRecoveryRequestsPerMinute);
  assert.ok(elapsedMs < GATES.offlineCatchupMs, `national offline catch-up took ${Math.round(elapsedMs)}ms`);
  context.diagnostic([
    `offline_reps=${SCALE.reps}`,
    `decisions=${SCALE.reps * SCALE.decisionsPerRep}`,
    `changes=${SCALE.reps * SCALE.changesPerRep}`,
    `sync_requests=${metrics.syncRequests}`,
    `change_requests=${metrics.changeRequests}`,
    `largest_sync_body_bytes=${metrics.maxSyncBodyBytes}`,
    `idle_recovery_requests_per_minute=${idleRecoveryRequestsPerMinute}`,
    `elapsed_ms=${Math.round(elapsedMs)}`,
  ].join(' '));
});
