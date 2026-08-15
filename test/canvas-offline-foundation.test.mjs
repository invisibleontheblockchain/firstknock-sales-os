import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import {
  CanvasOfflineStoreError,
  createCanvasOfflineStore,
  createMemoryCanvasStorage,
} from '../src/components/canvas/canvasOfflineStore.js';
import {
  CanvasPackageVerificationError,
  canonicalCanvasManifestPayload,
  sha256CanvasArtifact,
  verifyCanvasPackageArtifact,
  verifyCanvasPackageArtifacts,
  verifyCanvasPackageManifest,
} from '../src/components/canvas/canvasPackageVerifier.js';
import {
  CanvasSyncError,
  canvasRetryDelayMs,
  createCanvasSyncEngine,
} from '../src/components/canvas/canvasSyncEngine.js';

const encoder = new TextEncoder();

function base64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function signedPackageFixture() {
  const keys = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKey = new Uint8Array(await webcrypto.subtle.exportKey('raw', keys.publicKey));
  const artifacts = {
    streets: encoder.encode('{"streets":["street-1"]}'),
    dnc: encoder.encode('{"complete":true,"entries":["dnc-1"]}'),
  };
  const manifest = {
    schema: 'firstknock.canvas-field-package',
    schema_version: 1,
    package_id: 'package-1',
    package_version: 1,
    manager_id: 'manager-1',
    assignment_id: 'assignment-1',
    assignee_user_id: 'rep-1',
    campaign_id: 'campaign-1',
    zone_id: 'zone-1',
    issued_at: '2026-08-14T12:00:00.000Z',
    valid_until: '2026-08-21T12:00:00.000Z',
    dnc: { complete: true, artifact_id: 'dnc' },
    artifacts: [
      {
        artifact_id: 'streets',
        artifact_kind: 'context_streets',
        artifact_ordinal: 0,
        required: true,
        byte_size: artifacts.streets.byteLength,
        sha256: await sha256CanvasArtifact(artifacts.streets, { cryptoImpl: webcrypto }),
      },
      {
        artifact_id: 'dnc',
        artifact_kind: 'dnc_manifest',
        artifact_ordinal: 0,
        required: true,
        byte_size: artifacts.dnc.byteLength,
        sha256: await sha256CanvasArtifact(artifacts.dnc, { cryptoImpl: webcrypto }),
      },
    ],
  };
  const signature = await webcrypto.subtle.sign(
    { name: 'Ed25519' },
    keys.privateKey,
    canonicalCanvasManifestPayload(manifest),
  );
  manifest.signature = {
    algorithm: 'Ed25519',
    key_id: 'canvas-test-key-1',
    value: base64Url(signature),
  };
  return { manifest, artifacts, publicKey };
}

test('Canvas package verification checks Ed25519 scope, expiry, DNC completeness, and every required artifact', async () => {
  const fixture = await signedPackageFixture();
  const verification = await verifyCanvasPackageManifest({
    manifest: fixture.manifest,
    publicKey: fixture.publicKey,
    expected: {
      actorUserId: 'rep-1',
      campaignId: 'campaign-1',
      zoneId: 'zone-1',
      managerId: 'manager-1',
      assignmentId: 'assignment-1',
      keyId: 'canvas-test-key-1',
    },
    now: Date.parse('2026-08-15T00:00:00.000Z'),
    cryptoImpl: webcrypto,
  });
  assert.equal(verification.verified, true);
  assert.equal(verification.dncComplete, true);
  assert.deepEqual(verification.requiredArtifactIds, ['streets', 'dnc']);

  const artifacts = await verifyCanvasPackageArtifacts({
    manifest: fixture.manifest,
    artifacts: fixture.artifacts,
    cryptoImpl: webcrypto,
  });
  assert.equal(artifacts.verified, true);
  assert.deepEqual(artifacts.artifacts.map((artifact) => artifact.artifactId), ['streets', 'dnc']);

  const tamperedManifest = clone(fixture.manifest);
  tamperedManifest.campaign_id = 'campaign-2';
  await assert.rejects(
    verifyCanvasPackageManifest({
      manifest: tamperedManifest,
      publicKey: fixture.publicKey,
      now: Date.parse('2026-08-15T00:00:00.000Z'),
      cryptoImpl: webcrypto,
    }),
    (error) => error instanceof CanvasPackageVerificationError && error.code === 'CANVAS_PACKAGE_SIGNATURE_INVALID',
  );

  const incomplete = clone(fixture.manifest);
  incomplete.dnc.complete = false;
  await assert.rejects(
    verifyCanvasPackageManifest({
      manifest: incomplete,
      publicKey: fixture.publicKey,
      now: Date.parse('2026-08-15T00:00:00.000Z'),
      cryptoImpl: webcrypto,
    }),
    (error) => error.code === 'CANVAS_DNC_INCOMPLETE',
  );

  await assert.rejects(
    verifyCanvasPackageManifest({
      manifest: fixture.manifest,
      publicKey: fixture.publicKey,
      now: Date.parse('2026-08-22T00:00:00.000Z'),
      cryptoImpl: webcrypto,
    }),
    (error) => error.code === 'CANVAS_PACKAGE_EXPIRED',
  );

  await assert.rejects(
    verifyCanvasPackageArtifact({
      descriptor: fixture.manifest.artifacts[0],
      bytes: encoder.encode('{"streets":["tampered"]}'),
      cryptoImpl: webcrypto,
    }),
    (error) => ['CANVAS_ARTIFACT_LENGTH_MISMATCH', 'CANVAS_ARTIFACT_HASH_MISMATCH'].includes(error.code),
  );
});

test('offline store is cache-first, scope-isolated, and preserves idempotent per-item state', async () => {
  let clock = Date.parse('2026-08-15T00:00:00.000Z');
  const store = createCanvasOfflineStore({
    storage: createMemoryCanvasStorage(),
    now: () => clock,
  });
  const scope = { actorUserId: 'rep-1', campaignId: 'campaign-1', zoneId: 'zone-1' };
  const verification = {
    verified: true,
    dncComplete: true,
    actorUserId: 'rep-1',
    campaignId: 'campaign-1',
    zoneId: 'zone-1',
    packageVersion: '1',
    expiresAt: '2026-08-21T12:00:00.000Z',
    requiredArtifactIds: ['streets', 'dnc'],
  };
  await store.putPackage({
    ...scope,
    packageVersion: '1',
    manifest: {
      assignee_user_id: 'rep-1',
      campaign_id: 'campaign-1',
      zone_id: 'zone-1',
      package_version: 1,
    },
    verification,
  });
  await store.putArtifact({ ...scope, packageVersion: '1', artifactId: 'streets', bytes: new Uint8Array([1]), verified: true });
  await store.putArtifact({ ...scope, packageVersion: '1', artifactId: 'dnc', bytes: new Uint8Array([2]), verified: true });
  await store.putPins({ ...scope, pins: [{ pin_id: 'pin-1', result: 'not_home' }] });
  await store.putDncSnapshot({
    ...scope,
    packageVersion: '1',
    entries: [{ entry_id: 'dnc-1', address: '1 Main St' }],
    complete: true,
    verified: true,
  });
  await store.setCursor({ ...scope, cursor: 'cursor-1' });

  const cached = await store.readCachedWorkspace(scope);
  assert.equal(cached.ready, true);
  assert.deepEqual(cached.pins.map((pin) => pin.pin_id), ['pin-1']);
  assert.equal(cached.cursor, 'cursor-1');
  assert.equal(await store.getPackage({ ...scope, actorUserId: 'rep-2' }), null);
  assert.equal(await store.isDncReady({ ...scope, actorUserId: 'rep-2', packageVersion: '1' }), false);

  const first = await store.enqueueOutbox({
    ...scope,
    packageVersion: '1',
    idempotencyKey: 'decision-1',
    payload: { pin_id: 'pin-1', result: 'not_home' },
  });
  const duplicate = await store.enqueueOutbox({
    ...scope,
    packageVersion: '1',
    idempotencyKey: 'decision-1',
    payload: { result: 'not_home', pin_id: 'pin-1' },
  });
  assert.equal(first.queuedAt, duplicate.queuedAt);
  await assert.rejects(
    store.enqueueOutbox({
      ...scope,
      packageVersion: '2',
      idempotencyKey: 'decision-1',
      payload: { result: 'not_home', pin_id: 'pin-1' },
    }),
    (error) => error instanceof CanvasOfflineStoreError && error.code === 'CANVAS_OFFLINE_IDEMPOTENCY_REUSE',
  );
  await assert.rejects(
    store.enqueueOutbox({
      ...scope,
      idempotencyKey: 'decision-1',
      payload: { pin_id: 'pin-1', result: 'sale' },
    }),
    (error) => error instanceof CanvasOfflineStoreError && error.code === 'CANVAS_OFFLINE_IDEMPOTENCY_REUSE',
  );
  await assert.rejects(
    store.enqueueOutbox({
      ...scope,
      zoneId: 'zone-2',
      idempotencyKey: 'decision-1',
      payload: { pin_id: 'pin-1', result: 'not_home' },
    }),
    (error) => error instanceof CanvasOfflineStoreError && error.code === 'CANVAS_OFFLINE_IDEMPOTENCY_REUSE',
  );

  const [claimed] = await store.claimOutbox({ ...scope, idempotencyKeys: ['decision-1'] });
  assert.equal(claimed.state, 'sending');
  assert.equal(claimed.attemptCount, 1);
  clock += 1_000;
  await store.applySyncResult({
    ...scope,
    expectedCursor: 'cursor-1',
    nextCursor: 'cursor-2',
    outcomes: [{ idempotencyKey: 'decision-1', state: 'committed', serverResult: { pin_id: 'pin-1' } }],
    delta: {
      pins: {
        upserts: [{ pin_id: 'pin-2', result: 'sale' }],
        deletes: ['pin-1'],
      },
      dnc: {
        upserts: [{ entry_id: 'dnc-2', address: '2 Main St' }],
        complete: true,
        verified: true,
      },
    },
  });
  assert.equal(await store.getCursor(scope), 'cursor-2');
  assert.deepEqual((await store.getPins(scope)).map((pin) => pin.pin_id), ['pin-2']);
  assert.deepEqual((await store.getDncSnapshot(scope)).entries.map((entry) => entry.entry_id), ['dnc-1', 'dnc-2']);
  const committed = await store.listOutbox({
    ...scope,
    states: ['committed'],
    dueBefore: clock + 60_000,
  });
  assert.equal(committed.length, 1);
  assert.equal(committed[0].state, 'committed');

  await store.enqueueOutbox({
    ...scope,
    idempotencyKey: 'decision-abandoned',
    payload: { pin_id: 'pin-3', result: 'not_home' },
  });
  const [abandoned] = await store.claimOutbox({ ...scope, idempotencyKeys: ['decision-abandoned'], leaseMs: 1_000 });
  assert.equal(abandoned.attemptCount, 1);
  assert.equal((await store.listOutbox({ ...scope, dueBefore: clock })).length, 0);
  clock += 1_001;
  const recoverable = await store.listOutbox({ ...scope, dueBefore: clock });
  assert.deepEqual(recoverable.map((record) => record.idempotencyKey), ['decision-abandoned']);
  const [reclaimed] = await store.claimOutbox({ ...scope, idempotencyKeys: ['decision-abandoned'], leaseMs: 1_000 });
  assert.equal(reclaimed.attemptCount, 2);
  await store.applySyncResult({
    ...scope,
    outcomes: [{ idempotencyKey: 'decision-abandoned', attemptCount: 1, state: 'rejected' }],
  });
  const stillSending = await store.listOutbox({
    ...scope,
    states: ['sending'],
    dueBefore: clock + 1_000,
  });
  assert.equal(stillSending[0].state, 'sending');
});

test('sync engine bounds batches, applies deltas, never resends committed items, and retries each item exponentially', async () => {
  let clock = Date.parse('2026-08-15T00:00:00.000Z');
  const store = createCanvasOfflineStore({ storage: createMemoryCanvasStorage(), now: () => clock });
  const scope = {
    actorUserId: 'rep-1',
    campaignId: 'campaign-1',
    zoneId: 'zone-1',
    packageVersion: 'version-1',
  };
  await store.putDncSnapshot({ ...scope, entries: [], complete: true, verified: true });

  const sent = [];
  const engine = createCanvasSyncEngine({
    store,
    now: () => clock,
    random: () => 0.5,
    jitterRatio: 0,
    batchSize: 2,
    baseRetryMs: 1_000,
    maxRetryMs: 10_000,
    transport: {
      async syncBatch(request) {
        sent.push(request.items.map((item) => item.idempotencyKey));
        assert.ok(request.items.length <= 2);
        if (sent.length === 1) {
          return {
            results: [
              { idempotency_key: 'decision-1', status: 'committed' },
              { idempotency_key: 'decision-2', status: 'retry', error: { code: 'busy', message: 'Retry later.' } },
            ],
            next_cursor: 'cursor-1',
            delta: { pins: { upserts: [{ pin_id: 'pin-server-1', result: 'not_home' }] } },
          };
        }
        return {
          results: request.items.map((item) => ({ idempotency_key: item.idempotencyKey, status: 'committed' })),
          next_cursor: `cursor-${sent.length}`,
        };
      },
    },
  });

  await Promise.all([1, 2, 3].map((number) => engine.queue({
    ...scope,
    idempotencyKey: `decision-${number}`,
    payload: { pin_id: `pin-${number}`, result: 'not_home' },
  })));

  const first = await engine.flush(scope);
  assert.deepEqual(first, {
    ok: false,
    sent: 2,
    committed: 1,
    retried: 1,
    rejected: 0,
    hasMore: true,
    cursor: 'cursor-1',
    issues: [{
      idempotencyKey: 'decision-2',
      state: 'retry',
      error: { code: 'busy', message: 'Retry later.' },
    }],
  });
  assert.equal(await store.getCursor(scope), 'cursor-1');
  assert.deepEqual((await store.getPins(scope)).map((pin) => pin.pin_id), ['pin-server-1']);
  const retry = await store.listOutbox({ ...scope, states: ['retry'], dueBefore: clock + 1_000 });
  assert.equal(retry.length, 1);
  assert.equal(retry[0].nextAttemptAt, new Date(clock + 1_000).toISOString());

  const second = await engine.flush(scope);
  assert.equal(second.committed, 1);
  assert.deepEqual(sent[1], ['decision-3']);

  clock += 1_000;
  const third = await engine.flush(scope);
  assert.equal(third.committed, 1);
  assert.deepEqual(sent[2], ['decision-2']);
  assert.equal(sent.flat().filter((id) => id === 'decision-1').length, 1);
  assert.equal(sent.flat().filter((id) => id === 'decision-3').length, 1);

  const committed = await store.listOutbox({
    ...scope,
    states: ['committed'],
    dueBefore: clock + 60_000,
  });
  assert.deepEqual(committed.map((record) => record.idempotencyKey).sort(), ['decision-1', 'decision-2', 'decision-3']);
  assert.equal(canvasRetryDelayMs(1, { baseRetryMs: 1_000, maxRetryMs: 5_000, jitterRatio: 0 }), 1_000);
  assert.equal(canvasRetryDelayMs(2, { baseRetryMs: 1_000, maxRetryMs: 5_000, jitterRatio: 0 }), 2_000);
  assert.equal(canvasRetryDelayMs(20, { baseRetryMs: 1_000, maxRetryMs: 5_000, jitterRatio: 0 }), 5_000);
});

test('sync fails closed before queueing or transport when the verified DNC cache is incomplete', async () => {
  const store = createCanvasOfflineStore({ storage: createMemoryCanvasStorage() });
  let transportCalls = 0;
  const engine = createCanvasSyncEngine({
    store,
    transport: async () => {
      transportCalls += 1;
      return { results: [] };
    },
  });
  const scope = { actorUserId: 'rep-1', campaignId: 'campaign-1', zoneId: 'zone-1' };
  await store.putDncSnapshot({ ...scope, entries: [], complete: false, verified: true });
  await assert.rejects(
    engine.queue({ ...scope, idempotencyKey: 'decision-1', payload: { pin_id: 'pin-1' } }),
    (error) => error instanceof CanvasSyncError && error.code === 'CANVAS_DNC_NOT_READY',
  );
  await assert.rejects(
    engine.flush(scope),
    (error) => error instanceof CanvasSyncError && error.code === 'CANVAS_DNC_NOT_READY',
  );
  assert.equal(transportCalls, 0);
});

test('sync batch configuration remains bounded by both the requested and absolute maximum', () => {
  const store = createCanvasOfflineStore({ storage: createMemoryCanvasStorage() });
  const transport = async () => ({ results: [] });
  assert.equal(createCanvasSyncEngine({ store, transport, maxBatchSize: 10 }).batchSize, 10);
  assert.equal(createCanvasSyncEngine({ store, transport, batchSize: 1_000, maxBatchSize: 1_000 }).batchSize, 100);
});

test('package refresh quarantines stale outbox records without deleting or resubmitting their payloads', async () => {
  const store = createCanvasOfflineStore({ storage: createMemoryCanvasStorage() });
  const baseScope = { actorUserId: 'rep-1', campaignId: 'campaign-1', zoneId: 'zone-1' };
  const payload = { point: { lat: 33, lng: -112 }, outcome: 'callback', note: 'Keep this note.' };
  await store.enqueueOutbox({
    ...baseScope,
    packageVersion: '1',
    idempotencyKey: 'stale-decision',
    payload,
  });
  assert.equal(await store.quarantineOutboxPackageMismatches({
    ...baseScope,
    currentPackageVersion: '2',
  }), 1);
  const quarantined = await store.listOutbox({
    ...baseScope,
    packageVersion: '2',
    includeAllPackageVersions: true,
    states: ['rejected'],
    dueBefore: Date.now() + 60_000,
  });
  assert.equal(quarantined.length, 1);
  assert.equal(quarantined[0].packageVersion, '1');
  assert.deepEqual(quarantined[0].payload, payload);
  assert.equal(quarantined[0].lastError.code, 'CANVAS_PACKAGE_VERSION_REQUIRES_REVIEW');

  let transportCalls = 0;
  await store.putDncSnapshot({ ...baseScope, packageVersion: '2', entries: [], complete: true, verified: true });
  const engine = createCanvasSyncEngine({
    store,
    transport: async () => {
      transportCalls += 1;
      return { results: [] };
    },
  });
  const result = await engine.flush({ ...baseScope, packageVersion: '2' });
  assert.equal(result.sent, 0);
  assert.equal(transportCalls, 0);
  assert.deepEqual((await store.listOutbox({
    ...baseScope,
    packageVersion: '2',
    includeAllPackageVersions: true,
    states: ['rejected'],
    dueBefore: Date.now() + 60_000,
  }))[0].payload, payload);
});

test('partial sync rejection stays actionable while acknowledged pins apply immediately', async () => {
  const store = createCanvasOfflineStore({ storage: createMemoryCanvasStorage() });
  const scope = { actorUserId: 'rep-1', campaignId: 'campaign-1', zoneId: 'zone-1', packageVersion: '3' };
  await store.putDncSnapshot({ ...scope, entries: [], complete: true, verified: true });
  const engine = createCanvasSyncEngine({
    store,
    transport: async () => ({
      results: [
        { idempotency_key: 'accepted', status: 'applied', result: { pin: { pin_id: 'server-pin', lat: 33, lng: -112, latest_outcome: 'sale' } } },
        { idempotency_key: 'blocked', status: 'rejected', error: 'dnc_house_protected', message: 'This house is protected.' },
      ],
    }),
  });
  await engine.queue({ ...scope, idempotencyKey: 'accepted', payload: { outcome: 'sale' } });
  await engine.queue({ ...scope, idempotencyKey: 'blocked', payload: { outcome: 'no_answer' } });
  const result = await engine.flushAvailable(scope);
  assert.equal(result.ok, false);
  assert.equal(result.committed, 1);
  assert.equal(result.rejected, 1);
  assert.deepEqual(result.issues, [{
    idempotencyKey: 'blocked',
    state: 'rejected',
    error: { code: 'dnc_house_protected', message: 'This house is protected.' },
  }]);
  assert.deepEqual((await store.getPins(scope)).map((pin) => pin.pin_id), ['server-pin']);
  const rejected = await store.listOutbox({ ...scope, states: ['rejected'], dueBefore: Date.now() + 60_000 });
  assert.equal(rejected[0].lastError.code, 'dnc_house_protected');
  assert.equal(rejected[0].lastError.message, 'This house is protected.');
});

test('only a complete successful assignment index tombstones assignments that disappeared', async () => {
  const store = createCanvasOfflineStore({ storage: createMemoryCanvasStorage() });
  const actorUserId = 'rep-1';
  const first = { campaign_id: 'campaign-1', zone: { zone_id: 'zone-1' } };
  await store.putAssignmentIndex({ actorUserId, assignments: [first], authoritativeComplete: true });
  assert.equal(await store.getAssignmentUnavailable({ actorUserId, campaignId: 'campaign-1', zoneId: 'zone-1' }), null);
  await store.putAssignmentIndex({ actorUserId, assignments: [], authoritativeComplete: true });
  const tombstone = await store.getAssignmentUnavailable({ actorUserId, campaignId: 'campaign-1', zoneId: 'zone-1' });
  assert.equal(tombstone.code, 'CANVAS_ASSIGNMENT_REMOVED');
});
