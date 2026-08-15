import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import {
  canvasChangesToOfflineDelta,
  loadCanvasOfflineAssignment,
  loadCanvasOfflineAssignments,
} from '../src/components/canvas/canvasOfflinePackageRuntime.js';
import {
  createCanvasOfflineStore,
  createMemoryCanvasStorage,
} from '../src/components/canvas/canvasOfflineStore.js';
import {
  canonicalCanvasManifestPayload,
  canonicalCanvasPackageJson,
  sha256CanvasArtifact,
} from '../src/components/canvas/canvasPackageVerifier.js';

const encoder = new TextEncoder();

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

async function packageFixture() {
  const keys = await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKey = new Uint8Array(await webcrypto.subtle.exportKey('raw', keys.publicKey));
  const rootHash = await sha256CanvasArtifact(canonicalCanvasPackageJson({ high_water_cursor: '7', shards: [] }), { cryptoImpl: webcrypto });
  const content = {
    'territory:0': {
      schema: 'firstknock.canvas-territory',
      schema_version: 1,
      campaign_id: 'campaign-1',
      zone_id: 'zone-1',
      authoritative_ownership: 'street_work_units',
      work_unit_ids: ['street-1'],
      display_geometry: { geometry: [{ lat: 33, lng: -112 }, { lat: 33.01, lng: -112 }, { lat: 33, lng: -111.99 }] },
      workload: { score: 12, opportunity_expected: 12, street_length_meters: 800 },
    },
    'context_streets:0': {
      schema: 'firstknock.canvas-context-streets',
      schema_version: 1,
      campaign_id: 'campaign-1',
      zone_id: 'zone-1',
      shard_ordinal: 0,
      shard_count: 1,
      items: [{
        ownership: 'owned_knock',
        id: 'street-1',
        canvas_role: 'knock',
        segments: [{ start: { lat: 33, lng: -112 }, end: { lat: 33.001, lng: -112 }, length_meters: 111 }],
      }],
    },
    'opportunities:0': { schema: 'firstknock.canvas-evidence-pin', schema_version: 1, unresolved_unit_count: 0 },
    'pins:0': {
      schema: 'firstknock.canvas-pin-baseline',
      schema_version: 1,
      campaign_id: 'campaign-1',
      zone_id: 'zone-1',
      replace: true,
      baseline_cursor: '7',
      shard_ordinal: 0,
      shard_count: 1,
      items: [{ pin_id: 'pin-1', point: { lat: 33.0001, lng: -112 }, latest_outcome: 'not_home' }],
    },
    'dnc_manifest:0': {
      schema: 'firstknock.canvas-dnc-manifest',
      schema_version: 1,
      complete: true,
      manager_id: 'manager-1',
      campaign_id: 'campaign-1',
      zone_id: 'zone-1',
      high_water_cursor: '7',
      total_count: 0,
      root_hash: rootHash,
      shard_artifact_ids: [],
    },
  };
  const bytes = Object.fromEntries(Object.entries(content).map(([id, value]) => [id, encoder.encode(canonicalCanvasPackageJson(value))]));
  const kinds = ['territory', 'context_streets', 'opportunities', 'pins', 'dnc_manifest'];
  const descriptors = [];
  for (const kind of kinds) {
    const id = `${kind}:0`;
    descriptors.push({
      artifact_id: id,
      artifact_kind: kind,
      artifact_ordinal: 0,
      required: true,
      content_type: 'application/json; charset=utf-8',
      byte_size: bytes[id].byteLength,
      sha256: await sha256CanvasArtifact(bytes[id], { cryptoImpl: webcrypto }),
    });
  }
  descriptors.sort((left, right) => left.artifact_kind.localeCompare(right.artifact_kind));
  const manifest = {
    schema: 'firstknock.canvas-field-package',
    schema_version: 1,
    package_id: 'package-1',
    package_version: 1,
    manager_id: 'manager-1',
    assignment_id: 'assignment-1',
    assignee_user_id: 'rep-1',
    team_member_id: 'member-1',
    campaign_id: 'campaign-1',
    zone_id: 'zone-1',
    plan_hash: 'plan-hash',
    territory_hash: 'territory-hash',
    issued_at: '2026-08-14T12:00:00.000Z',
    valid_until: '2026-08-21T12:00:00.000Z',
    evidence: { evidence_id: 'evidence-1', evidence_release_id: 'release-1', snapshot_hash: 'snapshot-1', classification_revision_id: null },
    baseline_cursor: '7',
    dnc: { complete: true, artifact_id: 'dnc_manifest:0', high_water_cursor: '7', total_count: 0, root_hash: rootHash },
    artifacts: descriptors,
  };
  manifest.signature = {
    algorithm: 'Ed25519',
    key_id: 'package-key-1',
    value: base64Url(await webcrypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, canonicalCanvasManifestPayload(manifest))),
  };
  const manifestHash = await sha256CanvasArtifact(canonicalCanvasPackageJson(manifest), { cryptoImpl: webcrypto });
  return {
    manifest,
    manifestHash,
    bytes,
    signingKey: { algorithm: 'Ed25519', key_id: 'package-key-1', format: 'raw', keyData: base64Url(publicKey) },
  };
}

function indexAssignment(fixture, overrides = {}) {
  return {
    assignment_id: 'assignment-1',
    package_id: 'package-1',
    package_version: 1,
    manifest_hash: fixture.manifestHash,
    valid_until: fixture.manifest.valid_until,
    campaign_id: 'campaign-1',
    session_name: 'North Phoenix',
    territory_model: 'residential_street_territory_v2',
    zone: { zone_id: 'zone-1', zone_number: 4, color: '#A855F7' },
    ...overrides,
  };
}

test('network package is fully verified, cached, and reopens offline without campaign geometry polling', async () => {
  const fixture = await packageFixture();
  const store = createCanvasOfflineStore({
    storage: createMemoryCanvasStorage(),
    now: () => Date.parse('2026-08-15T00:00:00.000Z'),
  });
  const indexedAssignment = indexAssignment(fixture);
  let packageCalls = 0;
  let artifactCalls = 0;
  const fetchPackage = async () => {
    packageCalls += 1;
    return { package: { manifest: fixture.manifest, signing_key: fixture.signingKey } };
  };
  const fetchArtifact = async ({ artifactId }) => {
    artifactCalls += 1;
    return {
      artifact: {
        descriptor: fixture.manifest.artifacts.find((descriptor) => descriptor.artifact_id === artifactId),
        encoding: 'base64url',
        bytes: base64Url(fixture.bytes[artifactId]),
      },
    };
  };

  const network = await loadCanvasOfflineAssignment({
    indexAssignment: indexedAssignment,
    actorUserId: 'rep-1',
    store,
    trustedSigningKey: fixture.signingKey,
    fetchPackage,
    fetchArtifact,
    now: Date.parse('2026-08-15T00:00:00.000Z'),
  });
  assert.equal(network.source, 'network');
  assert.equal(network.assignment.assignment_id, 'assignment-1');
  assert.equal(network.assignment.zone.zone_number, 4);
  assert.deepEqual(network.assignment.zone.work_unit_ids, ['street-1']);
  assert.equal(network.assignment.work_units[0].ownership, 'owned_knock');
  assert.equal(packageCalls, 1);
  assert.equal(artifactCalls, fixture.manifest.artifacts.length);
  assert.equal((await store.getPins({ actorUserId: 'rep-1', campaignId: 'campaign-1', zoneId: 'zone-1' }))[0].pin_id, 'pin-1');
  assert.equal(await store.isDncReady({ actorUserId: 'rep-1', campaignId: 'campaign-1', zoneId: 'zone-1', packageVersion: '1' }), true);
  await store.putPins({ actorUserId: 'rep-1', campaignId: 'campaign-1', zoneId: 'zone-1', pins: [{ pin_id: 'pin-live', point: { lat: 33, lng: -112 } }], replace: false });
  await store.setCursor({ actorUserId: 'rep-1', campaignId: 'campaign-1', zoneId: 'zone-1', cursor: '9' });

  const unchanged = await loadCanvasOfflineAssignment({
    indexAssignment: indexedAssignment,
    actorUserId: 'rep-1',
    store,
    trustedSigningKey: fixture.signingKey,
    fetchPackage,
    fetchArtifact,
    now: Date.parse('2026-08-15T00:00:00.000Z'),
  });
  assert.equal(unchanged.source, 'network');
  assert.equal(packageCalls, 2);
  assert.equal(artifactCalls, fixture.manifest.artifacts.length, 'unchanged exact-version packages reuse verified local artifacts');
  assert.equal(await store.getCursor({ actorUserId: 'rep-1', campaignId: 'campaign-1', zoneId: 'zone-1' }), '9');
  assert.deepEqual((await store.getPins({ actorUserId: 'rep-1', campaignId: 'campaign-1', zoneId: 'zone-1' })).map((pin) => pin.pin_id), ['pin-1', 'pin-live']);

  const cached = await loadCanvasOfflineAssignment({
    indexAssignment: indexedAssignment,
    actorUserId: 'rep-1',
    store,
    trustedSigningKey: fixture.signingKey,
    fetchPackage: async () => { throw new Error('offline'); },
    fetchArtifact,
    now: Date.parse('2026-08-15T00:00:00.000Z'),
  });
  assert.equal(cached.source, 'cache');
  assert.equal(cached.offline, true);
  assert.equal(cached.assignment.package_version, 1);
});

test('tampered package artifacts fail closed before DNC readiness is cached', async () => {
  const fixture = await packageFixture();
  const store = createCanvasOfflineStore({ storage: createMemoryCanvasStorage() });
  const indexedAssignment = indexAssignment(fixture);
  await assert.rejects(loadCanvasOfflineAssignment({
    indexAssignment: indexedAssignment,
    actorUserId: 'rep-1',
    store,
    trustedSigningKey: fixture.signingKey,
    fetchPackage: async () => ({ package: { manifest: fixture.manifest, signing_key: fixture.signingKey } }),
    fetchArtifact: async ({ artifactId }) => ({
      artifact: {
        descriptor: fixture.manifest.artifacts.find((descriptor) => descriptor.artifact_id === artifactId),
        encoding: 'base64url',
        bytes: base64Url(artifactId === 'pins:0' ? encoder.encode('tampered') : fixture.bytes[artifactId]),
      },
    }),
    now: Date.parse('2026-08-15T00:00:00.000Z'),
  }), (error) => ['CANVAS_ARTIFACT_LENGTH_MISMATCH', 'CANVAS_ARTIFACT_HASH_MISMATCH'].includes(error.code));
  assert.equal(await store.isDncReady({ actorUserId: 'rep-1', campaignId: 'campaign-1', zoneId: 'zone-1', packageVersion: '1' }), false);
});

test('the signed package is bound to the exact operational index package ID, version, hash, and validity', async () => {
  const fixture = await packageFixture();
  const store = createCanvasOfflineStore({ storage: createMemoryCanvasStorage() });
  let artifactCalls = 0;
  await assert.rejects(loadCanvasOfflineAssignment({
    indexAssignment: indexAssignment(fixture, { manifest_hash: 'f'.repeat(64) }),
    actorUserId: 'rep-1',
    store,
    trustedSigningKey: fixture.signingKey,
    fetchPackage: async (request) => {
      assert.equal(request.assignmentId, 'assignment-1');
      assert.equal(request.packageVersion, 1);
      return { package: { manifest: fixture.manifest, signing_key: fixture.signingKey } };
    },
    fetchArtifact: async () => {
      artifactCalls += 1;
      throw new Error('index mismatch must fail before artifacts');
    },
    now: Date.parse('2026-08-15T00:00:00.000Z'),
  }), (error) => error.code === 'CANVAS_OFFLINE_PACKAGE_INDEX_MISMATCH');
  assert.equal(artifactCalls, 0);

  await assert.rejects(loadCanvasOfflineAssignment({
    indexAssignment: indexAssignment(fixture, { package_id: 'other-package' }),
    actorUserId: 'rep-1',
    store: createCanvasOfflineStore({ storage: createMemoryCanvasStorage() }),
    trustedSigningKey: fixture.signingKey,
    fetchPackage: async () => ({ package: { manifest: fixture.manifest, signing_key: fixture.signingKey } }),
    fetchArtifact: async () => { throw new Error('scope mismatch must fail before artifacts'); },
    now: Date.parse('2026-08-15T00:00:00.000Z'),
  }), (error) => error.code === 'CANVAS_PACKAGE_SCOPE_MISMATCH');
});

test('the API sibling key can never replace the independently pinned app trust anchor', async () => {
  const trusted = await packageFixture();
  const attacker = await packageFixture();
  const store = createCanvasOfflineStore({ storage: createMemoryCanvasStorage() });
  const indexedAssignment = indexAssignment(trusted);
  await assert.rejects(loadCanvasOfflineAssignment({
    indexAssignment: indexedAssignment,
    actorUserId: 'rep-1',
    store,
    trustedSigningKey: trusted.signingKey,
    fetchPackage: async () => ({ package: { manifest: attacker.manifest, signing_key: attacker.signingKey } }),
    fetchArtifact: async () => { throw new Error('artifacts must not be requested for an untrusted manifest'); },
    now: Date.parse('2026-08-15T00:00:00.000Z'),
  }), (error) => error.code === 'CANVAS_PACKAGE_SIGNATURE_INVALID');
  await assert.rejects(loadCanvasOfflineAssignment({
    indexAssignment: indexedAssignment,
    actorUserId: 'rep-1',
    store,
    fetchPackage: async () => ({ package: { manifest: trusted.manifest, signing_key: trusted.signingKey } }),
    fetchArtifact: async () => { throw new Error('artifacts must not be requested without a pinned key'); },
  }), (error) => error.code === 'CANVAS_PACKAGE_TRUST_NOT_CONFIGURED');
});

test('multiple assignment package loads use bounded concurrency', async () => {
  const fixture = await packageFixture();
  const store = createCanvasOfflineStore({ storage: createMemoryCanvasStorage() });
  let active = 0;
  let maximum = 0;
  const results = await loadCanvasOfflineAssignments({
    indexAssignments: Array.from({ length: 9 }, () => indexAssignment(fixture)),
    actorUserId: 'rep-1',
    store,
    trustedSigningKey: fixture.signingKey,
    concurrency: 3,
    fetchPackage: async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { package: { manifest: fixture.manifest, signing_key: fixture.signingKey } };
    },
    fetchArtifact: async ({ artifactId }) => ({ artifact: {
      descriptor: fixture.manifest.artifacts.find((descriptor) => descriptor.artifact_id === artifactId),
      encoding: 'base64url',
      bytes: base64Url(fixture.bytes[artifactId]),
    } }),
    now: Date.parse('2026-08-15T00:00:00.000Z'),
  });
  assert.equal(results.filter((result) => result.loaded).length, 9);
  assert.ok(maximum <= 3, `observed ${maximum} concurrent manifest downloads`);
});

test('an authoritative revocation tombstones the cached package until a new live package verifies', async () => {
  const fixture = await packageFixture();
  const store = createCanvasOfflineStore({
    storage: createMemoryCanvasStorage(),
    now: () => Date.parse('2026-08-15T00:00:00.000Z'),
  });
  const indexedAssignment = indexAssignment(fixture);
  const livePackage = async () => ({ package: { manifest: fixture.manifest, signing_key: fixture.signingKey } });
  const liveArtifact = async ({ artifactId }) => ({ artifact: {
    descriptor: fixture.manifest.artifacts.find((descriptor) => descriptor.artifact_id === artifactId),
    encoding: 'base64url',
    bytes: base64Url(fixture.bytes[artifactId]),
  } });
  await loadCanvasOfflineAssignment({ indexAssignment: indexedAssignment, actorUserId: 'rep-1', store, trustedSigningKey: fixture.signingKey, fetchPackage: livePackage, fetchArtifact: liveArtifact, now: Date.parse('2026-08-15T00:00:00.000Z') });

  const revoked = Object.assign(new Error('This assignment was recalled.'), { code: 'assignment_revoked', status: 409 });
  await assert.rejects(loadCanvasOfflineAssignment({
    indexAssignment: indexedAssignment,
    actorUserId: 'rep-1',
    store,
    trustedSigningKey: fixture.signingKey,
    fetchPackage: async () => { throw revoked; },
    fetchArtifact: liveArtifact,
    now: Date.parse('2026-08-15T00:00:00.000Z'),
  }), (error) => error.code === 'assignment_revoked');
  await assert.rejects(loadCanvasOfflineAssignment({
    indexAssignment: indexedAssignment,
    actorUserId: 'rep-1',
    store,
    trustedSigningKey: fixture.signingKey,
    fetchPackage: async () => { throw new Error('offline'); },
    fetchArtifact: liveArtifact,
    now: Date.parse('2026-08-15T00:00:00.000Z'),
  }), (error) => error.code === 'assignment_revoked');

  const recovered = await loadCanvasOfflineAssignment({ indexAssignment: indexedAssignment, actorUserId: 'rep-1', store, trustedSigningKey: fixture.signingKey, fetchPackage: livePackage, fetchArtifact: liveArtifact, now: Date.parse('2026-08-15T00:00:00.000Z') });
  assert.equal(recovered.source, 'network');
  assert.equal(await store.getAssignmentUnavailable({ actorUserId: 'rep-1', campaignId: 'campaign-1', zoneId: 'zone-1' }), null);
});

test('cursor changes become scoped pin and sticky-DNC deltas', () => {
  const delta = canvasChangesToOfflineDelta([
    { change_type: 'pin_upsert', entity_id: 'pin-2', payload: { pin_id: 'pin-2', point: { lat: 33, lng: -112 } } },
    { change_type: 'pin_delete', entity_id: 'pin-old', payload: {} },
    { change_type: 'dnc_upsert', entity_id: 'dnc-2', payload: { suppression_id: 'dnc-2', point: { lat: 33, lng: -112 }, active: true } },
    { change_type: 'progress_changed', entity_id: 'zone-1', payload: { event_count: 2 } },
  ]);
  assert.deepEqual(delta.pins.deletes, ['pin-old']);
  assert.deepEqual(delta.pins.upserts.map((pin) => pin.pin_id), ['pin-2']);
  assert.deepEqual(delta.dnc.upserts.map((entry) => entry.suppression_id), ['dnc-2']);
  assert.equal(delta.dnc.complete, true);
  assert.equal(delta.dnc.verified, true);
});
