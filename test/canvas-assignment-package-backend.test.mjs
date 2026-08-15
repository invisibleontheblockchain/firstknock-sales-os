import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  verifyCanvasPackageArtifact,
  verifyCanvasPackageManifest,
} from '../src/components/canvas/canvasPackageVerifier.js';
import {
  canvasStoredPlanForHash,
  signCanvasLifecycle,
} from './helpers/canvasLifecycleSignature.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const paths = {
  publish: 'base44/functions/canvasPublishAssignmentPackages/entry.ts',
  get: 'base44/functions/canvasGetAssignmentPackage/entry.ts',
  migration: 'base44/functions/setupCanvasOperationalStore/entry.ts',
};
const sources = Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, readFileSync(resolve(root, path), 'utf8')]));

function executable(name, appendix = '') {
  const result = ts.transpileModule(sources[name], {
    fileName: paths[name],
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], `${name} contains TypeScript syntax errors`);
  return `${result.outputText.replace(/^import .*;\s*$/gm, '').replace(/^export\s+/gm, '')}\n${appendix}`;
}

function loadFunction(name, { base44, neon, env = {}, appendix = '' } = {}) {
  let handler;
  const context = {
    console,
    createClientFromRequest: () => base44,
    neon: () => neon,
    Client: class {},
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
  };
  vm.runInNewContext(executable(name, appendix), context, { filename: paths[name] });
  return { handler, context };
}

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

async function packageFixture(overrides = {}) {
  const keys = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicRaw = new Uint8Array(await webcrypto.subtle.exportKey('raw', keys.publicKey));
  const artifactBytes = canonicalBytes({ complete: true, entries: [] });
  const issuedAt = new Date(Date.now() - 60_000).toISOString();
  const validUntil = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const unsigned = {
    schema: 'firstknock.canvas-field-package',
    schema_version: 1,
    package_id: 'package-2',
    package_version: 2,
    manager_id: 'manager-1',
    assignment_id: 'assignment-1',
    assignee_user_id: 'rep-1',
    team_member_id: 'member-1',
    campaign_id: 'campaign-1',
    zone_id: 'zone-1',
    issued_at: issuedAt,
    valid_until: validUntil,
    dnc: { complete: true, artifact_id: 'dnc_manifest:0' },
    artifacts: [{
      artifact_id: 'dnc_manifest:0',
      artifact_kind: 'dnc_manifest',
      artifact_ordinal: 0,
      required: true,
      content_type: 'application/json; charset=utf-8',
      byte_size: artifactBytes.byteLength,
      sha256: sha256Hex(artifactBytes),
    }],
  };
  const signature = await webcrypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, canonicalBytes(unsigned));
  const manifest = {
    ...unsigned,
    signature: { algorithm: 'Ed25519', key_id: 'package-key-1', value: base64Url(signature) },
  };
  const manifestBytes = canonicalBytes(manifest);
  const row = {
    assignment_id: 'assignment-1',
    manager_id: 'manager-1',
    campaign_id: 'campaign-1',
    zone_id: 'zone-1',
    assignee_user_id: 'rep-1',
    team_member_id: 'member-1',
    assignment_package_version: 2,
    assignment_package_status: 'ready',
    assignment_status: 'active',
    valid_from: issuedAt,
    valid_until: validUntil,
    revoked_at: null,
    deployment_status: 'active',
    package_id: 'package-2',
    package_version: 2,
    package_status: 'ready',
    manifest_hash: sha256Hex(manifestBytes),
    manifest_signature: manifest.signature.value,
    manifest_content: manifestBytes,
    manifest_byte_size: manifestBytes.byteLength,
    signing_key_id: 'package-key-1',
    issued_at: issuedAt,
    package_valid_until: validUntil,
    dnc_high_water_cursor: 0,
    total_bytes: manifestBytes.byteLength + artifactBytes.byteLength,
    ...overrides,
  };
  return { keys, publicRaw, artifactBytes, manifest, manifestBytes, row };
}

function repBase44({ managerId = 'manager-1' } = {}) {
  const user = { id: 'rep-1', role: 'user', app_role: 'rep', team_manager_id: managerId };
  return {
    user,
    client: {
      auth: { me: async () => user },
      entities: {
        TeamMember: {
          filter: async () => [{ id: 'member-1', user_id: 'rep-1', manager_id: managerId, status: 'active', role: 'rep' }],
        },
      },
    },
  };
}

function packageRequest(body) {
  return new Request('https://example.test/functions/canvasGetAssignmentPackage', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('assignment-package functions are self-contained and isolated from Precision storage and secrets', () => {
  for (const name of ['publish', 'get']) {
    executable(name);
    assert.doesNotMatch(sources[name], /from ['"]\.\.?\//);
    assert.match(sources[name], /CANVAS_DATABASE_URL/);
    assert.doesNotMatch(sources[name], /Deno\.env\.get\(["'](?:DATABASE_URL|NEON_DATABASE_URL)["']\)/);
    assert.doesNotMatch(sources[name], /SavedRoute|InteractionLog|MasterProperty|workspace_properties|STRIPE|BATCHDATA/);
  }
  assert.match(sources.publish, /CANVAS_PACKAGE_SIGNING_PRIVATE_KEY/);
  assert.match(sources.publish, /CANVAS_PACKAGE_SIGNING_PUBLIC_KEY/);
  assert.match(sources.publish, /CANVAS_PACKAGE_SIGNING_KEY_ID/);
  assert.doesNotMatch(sources.get, /CANVAS_PACKAGE_SIGNING_PRIVATE_KEY/);
});

test('publisher creates normalized, monotonically versioned, immutable package rows and bounded artifacts', () => {
  const source = sources.publish;
  assert.match(source, /verifyActiveLifecycle\(session\)/);
  assert.match(source, /verified_team_member_bindings/);
  assert.match(source, /TEAM_BATCH_SIZE = 100/);
  assert.match(source, /INSERT INTO canvas_deployments/);
  assert.match(source, /INSERT INTO canvas_assignments/);
  assert.match(source, /INSERT INTO canvas_work_unit_ownership/);
  assert.match(source, /ST_GeomFromGeoJSON/);
  assert.match(source, /MAX\(package_version\)::bigint/);
  assert.match(source, /Number\(result\.maximum\) \+ 1/);
  assert.match(source, /FROM jsonb_array_elements\(\$1::jsonb\) AS item/);
  assert.match(source, /WITH inserted_package AS \(/);
  assert.match(source, /CROSS JOIN jsonb_array_elements\(\$19::jsonb\) AS item/);
  assert.match(source, /publication_idempotency_key/);
  assert.match(source, /publication_request_hash/);
  assert.match(source, /BEGIN ISOLATION LEVEL SERIALIZABLE/);
  assert.match(source, /MAX_ARTIFACT_BYTES = 2_000_000/);
  assert.match(source, /MAX_PACKAGE_BYTES = 24_000_000/);
  assert.match(source, /MAX_PUBLICATION_BYTES = 192_000_000/);
  assert.match(source, /UPDATE canvas_assignment_packages[\s\S]*?status = 'revoked'/);
});

test('publisher builds 100 exact rep assignments without an area-by-area roster query', async () => {
  const { context } = loadFunction('publish', {
    base44: {},
    neon: async () => [],
    appendix: 'globalThis.__publisherHelpers = { normalizedAssignments, filterRowsByIds, nextPackageVersions };',
  });
  const zones = [];
  const units = [];
  const members = new Map();
  for (let index = 0; index < 100; index += 1) {
    const memberId = `member-${index}`;
    const unitId = `unit-${index}`;
    members.set(memberId, { id: memberId, user_id: `rep-${index}` });
    zones.push({ zone_id: `zone-${index}`, assigned_team_member_id: memberId, work_unit_ids: [unitId], workload_score: 10 });
    units.push({
      id: unitId,
      canvas_role: 'knock',
      neighbor_ids: [],
      segments: [{ start: { lat: 33 + index / 10_000, lng: -112 }, end: { lat: 33 + index / 10_000, lng: -111.9999 } }],
    });
  }
  const result = await context.__publisherHelpers.normalizedAssignments({
    id: 'campaign-100',
    manager_id: 'manager-1',
    territory_model: 'residential_street_territory_v2',
    plan_hash: 'a'.repeat(64),
    zones,
    work_units: units,
  }, members);
  assert.equal(result.assignments.length, 100);
  assert.equal(new Set(result.assignments.map((entry) => entry.assignmentId)).size, 100);
  assert.equal(result.assignments.flatMap((entry) => entry.ownedUnits).length, 100);

  let calls = 0;
  const rows = Array.from({ length: 100 }, (_, index) => ({ id: `member-${index}` }));
  const loaded = await context.__publisherHelpers.filterRowsByIds({
    filter: async ({ id }) => {
      calls += 1;
      return rows.filter((row) => id.$in.includes(row.id));
    },
  }, rows.map((row) => row.id), { manager_id: 'manager-1' });
  assert.equal(calls, 1);
  assert.equal(loaded.length, 100);

  let versionQueries = 0;
  let versionParameters;
  const versions = await context.__publisherHelpers.nextPackageVersions({
    query: async (_query, parameters) => {
      versionQueries += 1;
      versionParameters = parameters;
      return {
        rows: result.assignments.map((assignment, index) => ({
          assignment_id: assignment.assignmentId,
          maximum: index % 2 ? '4' : null,
          package_count: index % 2 ? '4' : '0',
        })),
      };
    },
  }, 'manager-1', result.assignments);
  assert.equal(versionQueries, 1);
  assert.equal(versionParameters[0], 'manager-1');
  assert.equal(versionParameters[1].length, 100);
  assert.equal(versions.size, 100);
  assert.equal(versions.get(result.assignments[0].assignmentId), 1);
  assert.equal(versions.get(result.assignments[1].assignmentId), 5);
});

test('manager publication denies a campaign owned by another tenant before database or signing access', async () => {
  let signingSecretReads = 0;
  const user = { id: 'manager-1', role: 'admin', app_role: 'manager' };
  const { handler } = loadFunction('publish', {
    base44: {
      auth: { me: async () => user },
      entities: { CanvasSession: { get: async () => ({ id: 'campaign-2', manager_id: 'manager-2' }) } },
    },
    neon: async () => { throw new Error('database must not be reached'); },
    env: new Proxy({}, { get: (_target, key) => { if (String(key).includes('SIGNING')) signingSecretReads += 1; return undefined; } }),
  });
  const response = await handler(packageRequest({ campaign_id: 'campaign-2', publication_idempotency_key: 'publish-1' }));
  assert.equal(response.status, 404);
  assert.equal(signingSecretReads, 0);
});

test('publisher verifies the exact lifecycle contract emitted by Canvas deployment', async () => {
  const secret = 'canvas-lifecycle-test-secret-at-least-32-bytes';
  const deployedAt = '2026-08-14T12:00:00.000Z';
  const session = {
    id: 'campaign-signed',
    manager_id: 'manager-1',
    status: 'deployed',
    lifecycle_state: 'active',
    version: 7,
    deployment_plan_version: 7,
    session_name: 'Signed campaign',
    territory_model: 'street_territory_v1',
    polygon: [{ lat: 33, lng: -112 }, { lat: 33.01, lng: -112 }, { lat: 33.01, lng: -111.99 }],
    rep_count: 1,
    planning_method: 'street_workload',
    assignment_basis: 'street_work_unit_ids',
    workload_basis: 'street_length',
    division_mode: 'fixed_area_count',
    target_workload: null,
    selected_team_member_ids: ['member-1'],
    zones: [{ zone_id: 'zone-1', assigned_team_member_id: 'member-1', work_unit_ids: ['unit-1'] }],
    work_units: [{ id: 'unit-1', segments: [{ start: { lat: 33, lng: -112 }, end: { lat: 33.001, lng: -112 } }] }],
    qa: {},
    algorithm_version: 'test-v1',
    data_version: 'test-data-v1',
    deployed_at: deployedAt,
    deployed_by_user_id: 'manager-1',
    deployment_idempotency_key: 'deploy-operation-1',
    lifecycle_evidence: {
      state: 'active',
      transition: 'deploy',
      schema_version: 1,
      transitioned_at: deployedAt,
      transitioned_by_user_id: 'manager-1',
      idempotency_key: 'deploy-operation-1',
      to_version: 7,
      from_version: 7,
      previous_signature: null,
    },
    closed_at: null,
    closed_by_user_id: null,
    close_action: null,
    close_idempotency_key: null,
  };
  session.deployment_qa = { lifecycle_state: 'active' };
  session.plan_hash = sha256Hex(canonicalBytes(canvasStoredPlanForHash(session)));
  session.deployment_signature = await signCanvasLifecycle(secret, session);
  const { context } = loadFunction('publish', {
    base44: {},
    neon: async () => [],
    env: { CANVAS_DEPLOYMENT_SIGNING_SECRET: secret },
    appendix: 'globalThis.__verifyActiveLifecycle = verifyActiveLifecycle;',
  });
  assert.equal(await context.__verifyActiveLifecycle(session), true);
});

test('rep retrieval is cross-tenant fail-closed and uses exact manager/user/member SQL parameters', async () => {
  const fixture = await packageFixture();
  const { client } = repBase44({ managerId: 'manager-other' });
  let observedParameters;
  const { handler } = loadFunction('get', {
    base44: client,
    neon: async (_query, parameters) => {
      observedParameters = parameters;
      return [];
    },
    env: {
      CANVAS_DATABASE_URL: 'postgres://canvas-only',
      CANVAS_PACKAGE_SIGNING_PUBLIC_KEY: base64Url(fixture.publicRaw),
      CANVAS_PACKAGE_SIGNING_PUBLIC_KEY_FORMAT: 'raw',
      CANVAS_PACKAGE_SIGNING_KEY_ID: 'package-key-1',
    },
  });
  const response = await handler(packageRequest({ campaign_id: 'campaign-1', zone_id: 'zone-1' }));
  assert.equal(response.status, 403);
  assert.deepEqual(Array.from(observedParameters), ['campaign-1', 'zone-1', 'manager-other', 'rep-1', 'member-1']);
});

test('rep retrieval verifies signed manifest bytes and rejects tampering', async () => {
  const fixture = await packageFixture();
  const tampered = new Uint8Array(fixture.manifestBytes);
  tampered[tampered.length - 2] ^= 1;
  const { client } = repBase44();
  const { handler } = loadFunction('get', {
    base44: client,
    neon: async () => [{ ...fixture.row, manifest_content: tampered }],
    env: {
      CANVAS_DATABASE_URL: 'postgres://canvas-only',
      CANVAS_PACKAGE_SIGNING_PUBLIC_KEY: base64Url(fixture.publicRaw),
      CANVAS_PACKAGE_SIGNING_PUBLIC_KEY_FORMAT: 'raw',
      CANVAS_PACKAGE_SIGNING_KEY_ID: 'package-key-1',
    },
  });
  const response = await handler(packageRequest({ assignment_id: 'assignment-1', package_version: 2 }));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'canvas_package_integrity_failed');
});

test('rep retrieval rejects stale and revoked packages before returning bytes', async () => {
  const fixture = await packageFixture();
  const { client } = repBase44();
  const env = {
    CANVAS_DATABASE_URL: 'postgres://canvas-only',
    CANVAS_PACKAGE_SIGNING_PUBLIC_KEY: base64Url(fixture.publicRaw),
    CANVAS_PACKAGE_SIGNING_PUBLIC_KEY_FORMAT: 'raw',
    CANVAS_PACKAGE_SIGNING_KEY_ID: 'package-key-1',
  };
  const stale = loadFunction('get', { base44: client, neon: async () => [fixture.row], env });
  const staleResponse = await stale.handler(packageRequest({ assignment_id: 'assignment-1', package_version: 1 }));
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json()).error, 'package_version_mismatch');

  const revoked = loadFunction('get', {
    base44: client,
    neon: async () => [{ ...fixture.row, package_status: 'revoked' }],
    env,
  });
  const revokedResponse = await revoked.handler(packageRequest({ assignment_id: 'assignment-1', package_version: 2 }));
  assert.equal(revokedResponse.status, 409);
  assert.equal((await revokedResponse.json()).error, 'package_revoked');
});

test('artifact retrieval rechecks current package ownership and revocation after manifest verification', async () => {
  const fixture = await packageFixture();
  const { client } = repBase44();
  let calls = 0;
  const { handler } = loadFunction('get', {
    base44: client,
    neon: async () => {
      calls += 1;
      return calls === 1 ? [fixture.row] : [];
    },
    env: {
      CANVAS_DATABASE_URL: 'postgres://canvas-only',
      CANVAS_PACKAGE_SIGNING_PUBLIC_KEY: base64Url(fixture.publicRaw),
      CANVAS_PACKAGE_SIGNING_PUBLIC_KEY_FORMAT: 'raw',
      CANVAS_PACKAGE_SIGNING_KEY_ID: 'package-key-1',
    },
  });
  const response = await handler(packageRequest({
    assignment_id: 'assignment-1',
    package_version: 2,
    artifact_id: 'dnc_manifest:0',
  }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'package_no_longer_current');
  assert.match(sources.get, /assignment\.package_version = package\.package_version/);
  assert.match(sources.get, /package\.status = 'ready'/);
  assert.match(sources.get, /deployment\.status = 'active'/);
});

test('rep retrieves a verifier-compatible manifest and one separately hashed base64url artifact', async () => {
  const fixture = await packageFixture();
  const { client } = repBase44();
  const env = {
    CANVAS_DATABASE_URL: 'postgres://canvas-only',
    CANVAS_PACKAGE_SIGNING_PUBLIC_KEY: base64Url(fixture.publicRaw),
    CANVAS_PACKAGE_SIGNING_PUBLIC_KEY_FORMAT: 'raw',
    CANVAS_PACKAGE_SIGNING_KEY_ID: 'package-key-1',
  };
  const manifestHandler = loadFunction('get', { base44: client, neon: async () => [fixture.row], env });
  const manifestResponse = await manifestHandler.handler(packageRequest({ campaign_id: 'campaign-1', zone_id: 'zone-1' }));
  assert.equal(manifestResponse.status, 200);
  const manifestPayload = await manifestResponse.json();
  assert.equal(manifestPayload.package.manifest.package_id, 'package-2');
  assert.equal(manifestPayload.package.signing_key.format, 'raw');
  assert.equal(manifestPayload.package.signing_key.keyData, base64Url(fixture.publicRaw));
  const verifiedManifest = await verifyCanvasPackageManifest({
    manifest: manifestPayload.package.manifest,
    publicKey: manifestPayload.package.signing_key,
    expected: {
      packageId: 'package-2',
      packageVersion: '2',
      managerId: 'manager-1',
      assignmentId: 'assignment-1',
      actorUserId: 'rep-1',
      campaignId: 'campaign-1',
      zoneId: 'zone-1',
      keyId: 'package-key-1',
    },
    cryptoImpl: webcrypto,
  });
  assert.equal(verifiedManifest.verified, true);

  let calls = 0;
  const artifactHandler = loadFunction('get', {
    base44: client,
    neon: async () => {
      calls += 1;
      if (calls === 1) return [fixture.row];
      return [{
        artifact_id: 'dnc_manifest:0',
        artifact_kind: 'dnc_manifest',
        artifact_ordinal: 0,
        sha256: sha256Hex(fixture.artifactBytes),
        byte_size: fixture.artifactBytes.byteLength,
        content_type: 'application/json; charset=utf-8',
        content: fixture.artifactBytes,
        required: true,
      }];
    },
    env,
  });
  const artifactResponse = await artifactHandler.handler(packageRequest({
    assignment_id: 'assignment-1',
    package_version: 2,
    artifact_id: 'dnc_manifest:0',
  }));
  assert.equal(artifactResponse.status, 200);
  const artifactPayload = await artifactResponse.json();
  assert.equal(artifactPayload.artifact.encoding, 'base64url');
  const downloadedBytes = Buffer.from(artifactPayload.artifact.bytes, 'base64url');
  assert.deepEqual(downloadedBytes, Buffer.from(fixture.artifactBytes));
  const verifiedArtifact = await verifyCanvasPackageArtifact({
    descriptor: artifactPayload.artifact.descriptor,
    bytes: downloadedBytes,
    cryptoImpl: webcrypto,
  });
  assert.equal(verifiedArtifact.verified, true);
});

test('migration stores immutable manifest/artifact bytes and complete sharded DNC metadata', () => {
  const source = sources.migration;
  assert.match(source, /manifest_content BYTEA/);
  assert.match(source, /manifest_byte_size BIGINT/);
  assert.match(source, /artifact_id TEXT NOT NULL/);
  assert.match(source, /content BYTEA NOT NULL/);
  assert.match(source, /OCTET_LENGTH\(content\) = byte_size/);
  assert.match(source, /'dnc_shard'/);
  assert.match(source, /canvas_guard_signed_package_mutation/);
  assert.match(source, /canvas_package_artifacts_immutable/);
  assert.match(source, /canvas_dnc_manifests/);
  assert.match(source, /canvas_dnc_manifest_shards/);
});
