import {
  canonicalCanvasPackageJson,
  sha256CanvasArtifact,
  verifyCanvasPackageArtifact,
  verifyCanvasPackageArtifacts,
  verifyCanvasPackageManifest,
} from './canvasPackageVerifier.js';

export class CanvasOfflinePackageError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CanvasOfflinePackageError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new CanvasOfflinePackageError(code, message, details);
}

function requiredString(value, field) {
  const normalized = String(value || '').trim();
  if (!normalized) fail('CANVAS_OFFLINE_PACKAGE_INVALID', `${field} is required.`, { field });
  return normalized;
}

function pinnedSigningKey(value) {
  if (!value || typeof value !== 'object') {
    fail('CANVAS_PACKAGE_TRUST_NOT_CONFIGURED', 'This app build does not contain a pinned Canvas package verification key.');
  }
  const algorithm = requiredString(value.algorithm || 'Ed25519', 'trustedSigningKey.algorithm');
  const keyId = requiredString(value.keyId ?? value.key_id, 'trustedSigningKey.keyId');
  const format = requiredString(value.format || 'spki', 'trustedSigningKey.format').toLowerCase();
  const keyData = value.keyData ?? value.data ?? value.key;
  if (algorithm !== 'Ed25519' || !['raw', 'spki', 'jwk'].includes(format) || !keyData) {
    fail('CANVAS_PACKAGE_TRUST_NOT_CONFIGURED', 'The pinned Canvas package verification key is invalid.');
  }
  return Object.freeze({ algorithm, keyId, format, keyData });
}

function assignmentIndexContract(indexAssignment, now) {
  const assignmentId = requiredString(indexAssignment?.assignment_id, 'indexAssignment.assignment_id');
  const packageId = requiredString(indexAssignment?.package_id, 'indexAssignment.package_id');
  const campaignId = requiredString(indexAssignment?.campaign_id ?? indexAssignment?.session_id, 'indexAssignment.campaign_id');
  const zoneId = requiredString(indexAssignment?.zone?.zone_id ?? indexAssignment?.zone_id, 'indexAssignment.zone_id');
  const packageVersion = String(indexAssignment?.package_version || '').trim();
  if (!/^[1-9][0-9]*$/.test(packageVersion)) {
    fail('CANVAS_OFFLINE_PACKAGE_INDEX_INVALID', 'The assignment index package version is invalid.');
  }
  const manifestHash = String(indexAssignment?.manifest_hash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(manifestHash)) {
    fail('CANVAS_OFFLINE_PACKAGE_INDEX_INVALID', 'The assignment index manifest hash is invalid.');
  }
  const validUntil = String(indexAssignment?.valid_until || '').trim();
  const validUntilTime = Date.parse(validUntil);
  const current = typeof now === 'number' ? now : new Date(now).valueOf();
  if (!Number.isFinite(validUntilTime) || validUntilTime <= current) {
    fail('CANVAS_OFFLINE_PACKAGE_INDEX_EXPIRED', 'The assignment index authorization has expired.');
  }
  return Object.freeze({ assignmentId, packageId, campaignId, zoneId, packageVersion, manifestHash, validUntil });
}

function authoritativePackageRejection(error) {
  const status = Number(error?.status);
  if (Number.isFinite(status) && status >= 400 && status < 500 && ![408, 425, 429].includes(status)) return true;
  const code = String(error?.code || '');
  if (/^(CANVAS_PACKAGE_|CANVAS_ARTIFACT_|CANVAS_DNC_|CANVAS_OFFLINE_TERRITORY_|CANVAS_OFFLINE_PACKAGE_SCOPE_)/.test(code)) return true;
  return new Set([
    'canvas_assignment_forbidden',
    'team_membership_required',
    'ambiguous_team_membership',
    'campaign_recalled',
    'campaign_not_active',
    'assignment_revoked',
    'assignment_not_ready',
    'assignment_expired',
    'package_not_ready',
    'package_version_mismatch',
  ]).has(code.toLowerCase());
}

function bytesFromBase64Url(value) {
  const encoded = requiredString(value, 'artifact.bytes');
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)) {
    fail('CANVAS_OFFLINE_ARTIFACT_ENCODING_INVALID', 'Canvas artifact bytes are not valid base64url.');
  }
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/u, '');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  let binary;
  try {
    binary = globalThis.atob(padded);
  } catch {
    fail('CANVAS_OFFLINE_ARTIFACT_ENCODING_INVALID', 'Canvas artifact bytes are not valid base64url.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function parseArtifact(bytes, descriptor) {
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail('CANVAS_OFFLINE_ARTIFACT_JSON_INVALID', `Canvas artifact ${descriptor.artifact_id} is not valid JSON.`, {
      artifactId: descriptor.artifact_id,
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('CANVAS_OFFLINE_ARTIFACT_JSON_INVALID', `Canvas artifact ${descriptor.artifact_id} must contain a JSON object.`);
  }
  return parsed;
}

function descriptorMap(manifest) {
  return new Map((manifest?.artifacts || []).map((descriptor) => [String(descriptor.artifact_id), descriptor]));
}

function artifactsOfKind(parsedArtifacts, manifest, kind) {
  return (manifest.artifacts || [])
    .filter((descriptor) => descriptor.artifact_kind === kind)
    .sort((left, right) => Number(left.artifact_ordinal || 0) - Number(right.artifact_ordinal || 0))
    .map((descriptor) => parsedArtifacts.get(descriptor.artifact_id));
}

function artifactItems(parsedArtifacts, manifest, kind) {
  return artifactsOfKind(parsedArtifacts, manifest, kind).flatMap((artifact) => {
    if (!Array.isArray(artifact?.items)) {
      fail('CANVAS_OFFLINE_ARTIFACT_SHARD_INVALID', `Canvas ${kind} artifact is missing its items array.`);
    }
    return artifact.items;
  });
}

async function assertDncCompleteness({ manifest, parsedArtifacts }) {
  const dncManifest = parsedArtifacts.get(manifest?.dnc?.artifact_id);
  if (!dncManifest || dncManifest.schema !== 'firstknock.canvas-dnc-manifest' || dncManifest.complete !== true) {
    fail('CANVAS_DNC_INCOMPLETE', 'The signed Canvas package does not contain a complete DNC manifest.');
  }
  const shardDescriptors = (manifest.artifacts || [])
    .filter((descriptor) => descriptor.artifact_kind === 'dnc_shard')
    .sort((left, right) => Number(left.artifact_ordinal || 0) - Number(right.artifact_ordinal || 0));
  const expectedShardIds = shardDescriptors.map((descriptor) => descriptor.artifact_id);
  if (canonicalCanvasPackageJson(dncManifest.shard_artifact_ids || []) !== canonicalCanvasPackageJson(expectedShardIds)) {
    fail('CANVAS_DNC_INCOMPLETE', 'The DNC shard inventory does not match the signed package manifest.');
  }
  const highWaterCursor = String(manifest.dnc.high_water_cursor ?? manifest.baseline_cursor ?? '');
  if (!highWaterCursor || String(dncManifest.high_water_cursor) !== highWaterCursor) {
    fail('CANVAS_DNC_INCOMPLETE', 'The DNC high-water cursor does not match the signed package manifest.');
  }
  const rootPayload = {
    high_water_cursor: highWaterCursor,
    shards: shardDescriptors.map((descriptor) => ({
      artifact_id: descriptor.artifact_id,
      sha256: descriptor.sha256,
      byte_size: Number(descriptor.byte_size ?? descriptor.byte_length),
    })),
  };
  const rootHash = await sha256CanvasArtifact(canonicalCanvasPackageJson(rootPayload));
  if (rootHash !== manifest.dnc.root_hash || rootHash !== dncManifest.root_hash) {
    fail('CANVAS_DNC_INCOMPLETE', 'The DNC root hash does not match the signed package.');
  }
  const entries = artifactItems(parsedArtifacts, manifest, 'dnc_shard');
  if (entries.length !== Number(manifest.dnc.total_count) || entries.length !== Number(dncManifest.total_count)) {
    fail('CANVAS_DNC_INCOMPLETE', 'The complete DNC entry count does not match the signed package.');
  }
  return { entries, highWaterCursor, rootHash };
}

function normalizePin(pin) {
  const point = pin?.point || {};
  return {
    ...pin,
    lat: Number(pin?.lat ?? point.lat),
    lng: Number(pin?.lng ?? point.lng),
  };
}

function normalizedIndexAssignment(indexAssignment, manifest, territory, workUnits) {
  const zone = indexAssignment?.zone || {};
  const display = territory.display_geometry || {};
  return {
    ...indexAssignment,
    session_id: manifest.campaign_id,
    campaign_id: manifest.campaign_id,
    territory_model: 'residential_street_territory_v2',
    assignment_id: manifest.assignment_id,
    package_id: manifest.package_id,
    package_version: Number(manifest.package_version),
    package_valid_until: manifest.valid_until,
    campaign_boundary: [],
    zone: {
      ...zone,
      zone_id: manifest.zone_id,
      zone_number: zone.zone_number ?? 1,
      geometry: display.geometry || null,
      parts: display.parts || null,
      center: display.center || null,
      drop_point: display.drop_point || null,
      work_unit_ids: territory.work_unit_ids || [],
      street_work_unit_ids: territory.work_unit_ids || [],
      workload_score: territory.workload?.score ?? zone.workload_score ?? 0,
      opportunity_expected: territory.workload?.opportunity_expected ?? zone.opportunity_expected ?? 0,
      street_length_meters: territory.workload?.street_length_meters ?? zone.street_length_meters ?? 0,
    },
    work_units: workUnits,
  };
}

async function hydrateVerifiedArtifacts({ manifest, artifacts }) {
  const parsedArtifacts = new Map();
  for (const descriptor of manifest.artifacts || []) {
    const bytes = artifacts.get(descriptor.artifact_id);
    if (bytes === undefined) {
      if (descriptor.required !== false) fail('CANVAS_OFFLINE_ARTIFACT_MISSING', `Canvas artifact ${descriptor.artifact_id} is missing.`);
      continue;
    }
    parsedArtifacts.set(descriptor.artifact_id, parseArtifact(bytes, descriptor));
  }
  const territories = artifactsOfKind(parsedArtifacts, manifest, 'territory');
  if (territories.length !== 1 || territories[0]?.schema !== 'firstknock.canvas-territory') {
    fail('CANVAS_OFFLINE_TERRITORY_INVALID', 'The Canvas package must contain exactly one territory artifact.');
  }
  const territory = territories[0];
  if (String(territory.campaign_id) !== String(manifest.campaign_id) || String(territory.zone_id) !== String(manifest.zone_id)) {
    fail('CANVAS_OFFLINE_PACKAGE_SCOPE_MISMATCH', 'The territory artifact belongs to a different Canvas assignment.');
  }
  const workUnits = artifactItems(parsedArtifacts, manifest, 'context_streets');
  const ownedIds = new Set(territory.work_unit_ids || []);
  const packagedOwnedIds = workUnits.filter((unit) => unit?.ownership === 'owned_knock').map((unit) => String(unit.id)).sort();
  if (canonicalCanvasPackageJson([...ownedIds].sort()) !== canonicalCanvasPackageJson(packagedOwnedIds)) {
    fail('CANVAS_OFFLINE_TERRITORY_INVALID', 'The packaged street ownership does not match the signed territory.');
  }
  const pins = artifactItems(parsedArtifacts, manifest, 'pins').map(normalizePin);
  const dnc = await assertDncCompleteness({ manifest, parsedArtifacts });
  return { parsedArtifacts, territory, workUnits, pins, dnc };
}

async function verifiedNetworkPackage({ indexContract, actorUserId, store, fetchPackage, fetchArtifact, trustedSigningKey, now }) {
  const { assignmentId, campaignId, zoneId, packageVersion } = indexContract;
  const response = await fetchPackage({ assignmentId, campaignId, zoneId, packageVersion: Number(packageVersion) });
  const manifest = response?.package?.manifest;
  if (!manifest) fail('CANVAS_OFFLINE_PACKAGE_INVALID', 'Canvas did not return a signed assignment package.');
  const verification = await verifyCanvasPackageManifest({
    manifest,
    publicKey: trustedSigningKey,
    expected: {
      actorUserId,
      assignmentId,
      packageId: indexContract.packageId,
      packageVersion,
      campaignId,
      zoneId,
      keyId: trustedSigningKey.keyId,
    },
    now,
  });
  if (verification.manifestDigest !== indexContract.manifestHash) {
    fail('CANVAS_OFFLINE_PACKAGE_INDEX_MISMATCH', 'The signed package does not match the manifest hash authorized by the assignment index.');
  }
  if (Date.parse(verification.expiresAt) < Date.parse(indexContract.validUntil)) {
    fail('CANVAS_OFFLINE_PACKAGE_INDEX_MISMATCH', 'The assignment index validity exceeds the signed package validity.');
  }
  const cachedPackage = await store.getPackage({ actorUserId, campaignId, zoneId, packageVersion });
  if (cachedPackage?.verification?.manifestDigest === verification.manifestDigest) {
    try {
      const cached = await verifiedCachedPackage({
        indexContract,
        actorUserId,
        store,
        trustedSigningKey,
        now,
      });
      return { ...cached, manifest, verification, reusedCachedArtifacts: true };
    } catch {
      // A missing or corrupt local artifact is recoverable while online. Fall
      // through to exact-version artifact download and full hash verification.
    }
  }
  const descriptors = descriptorMap(manifest);
  const artifacts = new Map();
  for (const descriptor of manifest.artifacts || []) {
    if (descriptor.required === false) continue;
    const artifactResponse = await fetchArtifact({
      campaignId,
      zoneId,
      assignmentId,
      packageVersion: Number(packageVersion),
      artifactId: descriptor.artifact_id,
    });
    const returned = artifactResponse?.artifact;
    if (!returned || String(returned?.descriptor?.artifact_id || descriptor.artifact_id) !== String(descriptor.artifact_id)
      || returned.encoding !== 'base64url') {
      fail('CANVAS_OFFLINE_ARTIFACT_INVALID', `Canvas returned an invalid artifact response for ${descriptor.artifact_id}.`);
    }
    const bytes = bytesFromBase64Url(returned.bytes);
    await verifyCanvasPackageArtifact({ descriptor: descriptors.get(descriptor.artifact_id), bytes });
    artifacts.set(descriptor.artifact_id, bytes);
  }
  await verifyCanvasPackageArtifacts({ manifest, artifacts });
  const hydrated = await hydrateVerifiedArtifacts({ manifest, artifacts });
  return { manifest, verification, artifacts, ...hydrated };
}

async function verifiedCachedPackage({ indexContract, actorUserId, store, trustedSigningKey, now }) {
  const { campaignId, zoneId, packageVersion } = indexContract;
  const workspace = await store.readCachedWorkspace({ actorUserId, campaignId, zoneId, packageVersion });
  if (!workspace.ready) {
    fail('CANVAS_OFFLINE_CACHE_NOT_READY', 'No complete, unexpired Canvas package is cached on this device.', workspace.reasons);
  }
  const { manifest } = workspace.package;
  const verification = await verifyCanvasPackageManifest({
    manifest,
    publicKey: trustedSigningKey,
    expected: {
      actorUserId,
      assignmentId: indexContract.assignmentId,
      packageId: indexContract.packageId,
      packageVersion,
      campaignId,
      zoneId,
      keyId: trustedSigningKey.keyId,
    },
    now,
  });
  if (verification.manifestDigest !== indexContract.manifestHash) {
    fail('CANVAS_OFFLINE_PACKAGE_INDEX_MISMATCH', 'The cached package does not match the manifest hash authorized by the assignment index.');
  }
  const cachedArtifacts = await store.listArtifacts({ actorUserId, campaignId, zoneId, packageVersion: verification.packageVersion, includeBytes: true });
  const artifacts = new Map(cachedArtifacts.map((entry) => [entry.artifactId, entry.bytes]));
  await verifyCanvasPackageArtifacts({ manifest, artifacts });
  const hydrated = await hydrateVerifiedArtifacts({ manifest, artifacts });
  return { manifest, verification, artifacts, ...hydrated };
}

async function cacheVerifiedPackage({ actorUserId, indexAssignment, store, loaded }) {
  const campaignId = loaded.verification.campaignId;
  const zoneId = loaded.verification.zoneId;
  const packageVersion = loaded.verification.packageVersion;
  for (const descriptor of loaded.manifest.artifacts || []) {
    const bytes = loaded.artifacts.get(descriptor.artifact_id);
    if (bytes === undefined) continue;
    await store.putArtifact({
      actorUserId,
      campaignId,
      zoneId,
      packageVersion,
      artifactId: descriptor.artifact_id,
      metadata: descriptor,
      bytes,
      verified: true,
    });
  }
  await store.putPins({ actorUserId, campaignId, zoneId, pins: loaded.pins, replace: true });
  await store.putDncSnapshot({
    actorUserId,
    campaignId,
    zoneId,
    packageVersion,
    entries: loaded.dnc.entries,
    complete: true,
    verified: true,
    sourceCursor: loaded.dnc.highWaterCursor,
    digest: loaded.dnc.rootHash,
  });
  await store.setCursor({ actorUserId, campaignId, zoneId, cursor: loaded.dnc.highWaterCursor });
  await store.quarantineOutboxPackageMismatches({
    actorUserId,
    campaignId,
    zoneId,
    currentPackageVersion: packageVersion,
  });
  await store.putPackage({
    actorUserId,
    campaignId,
    zoneId,
    packageVersion,
    manifest: loaded.manifest,
    verification: loaded.verification,
  });
  return normalizedIndexAssignment(indexAssignment, loaded.manifest, loaded.territory, loaded.workUnits);
}

export async function loadCanvasOfflineAssignment({
  indexAssignment,
  actorUserId,
  store,
  fetchPackage,
  fetchArtifact,
  trustedSigningKey,
  now = Date.now(),
} = {}) {
  if (!store) fail('CANVAS_OFFLINE_STORE_REQUIRED', 'Canvas offline storage is unavailable.');
  const trustAnchor = pinnedSigningKey(trustedSigningKey);
  const indexContract = assignmentIndexContract(indexAssignment, now);
  const networkAvailable = typeof fetchPackage === 'function' && typeof fetchArtifact === 'function'
    && !(typeof navigator !== 'undefined' && navigator.onLine === false);
  let networkError = null;
  if (networkAvailable) {
    try {
      const loaded = await verifiedNetworkPackage({
        indexContract,
        actorUserId,
        store,
        fetchPackage,
        fetchArtifact,
        trustedSigningKey: trustAnchor,
        now,
      });
      await store.clearAssignmentUnavailable({
        actorUserId,
        campaignId: loaded.verification.campaignId,
        zoneId: loaded.verification.zoneId,
      });
      const assignment = loaded.reusedCachedArtifacts
        ? normalizedIndexAssignment(indexAssignment, loaded.manifest, loaded.territory, loaded.workUnits)
        : await cacheVerifiedPackage({ actorUserId, indexAssignment, store, loaded });
      return { assignment, source: 'network', offline: false, verification: loaded.verification };
    } catch (error) {
      networkError = error;
      if (authoritativePackageRejection(error)) {
        const campaignId = requiredString(indexAssignment?.campaign_id ?? indexAssignment?.session_id, 'campaignId');
        const zoneId = requiredString(indexAssignment?.zone?.zone_id ?? indexAssignment?.zone_id, 'zoneId');
        await store.markAssignmentUnavailable({
          actorUserId,
          campaignId,
          zoneId,
          code: error?.code,
          message: error?.message,
        });
        throw error;
      }
    }
  }
  try {
    const campaignId = requiredString(indexAssignment?.campaign_id ?? indexAssignment?.session_id, 'campaignId');
    const zoneId = requiredString(indexAssignment?.zone?.zone_id ?? indexAssignment?.zone_id, 'zoneId');
    const unavailable = await store.getAssignmentUnavailable({ actorUserId, campaignId, zoneId });
    if (unavailable) {
      fail(unavailable.code || 'CANVAS_ASSIGNMENT_UNAVAILABLE', unavailable.message || 'This Canvas assignment is no longer available.');
    }
    const loaded = await verifiedCachedPackage({
      indexContract,
      actorUserId,
      store,
      trustedSigningKey: trustAnchor,
      now,
    });
    return {
      assignment: normalizedIndexAssignment(indexAssignment, loaded.manifest, loaded.territory, loaded.workUnits),
      source: 'cache',
      offline: true,
      verification: loaded.verification,
      networkError,
    };
  } catch (cacheError) {
    if (networkError && cacheError?.code === 'CANVAS_OFFLINE_CACHE_NOT_READY') throw networkError;
    throw cacheError;
  }
}

export async function loadCanvasOfflineAssignments({
  indexAssignments = [],
  concurrency = 3,
  ...options
} = {}) {
  if (!Array.isArray(indexAssignments)) {
    fail('CANVAS_OFFLINE_PACKAGE_INVALID', 'Canvas assignment index must be an array.');
  }
  const workerCount = Math.max(1, Math.min(4, Number.isSafeInteger(concurrency) ? concurrency : 3));
  const results = new Array(indexAssignments.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < indexAssignments.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = {
          index,
          loaded: await loadCanvasOfflineAssignment({ ...options, indexAssignment: indexAssignments[index] }),
        };
      } catch (error) {
        results[index] = { index, error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(workerCount, indexAssignments.length) }, () => worker()));
  return results;
}

export function canvasChangesToOfflineDelta(changes = []) {
  const pinUpserts = [];
  const pinDeletes = [];
  const dncUpserts = [];
  const dncDeletes = [];
  for (const change of changes) {
    const payload = change?.payload || {};
    if (change?.change_type === 'pin_upsert') pinUpserts.push(normalizePin(payload));
    else if (change?.change_type === 'pin_delete') pinDeletes.push(String(change.entity_id));
    else if (change?.change_type === 'dnc_upsert') dncUpserts.push(payload);
    else if (change?.change_type === 'dnc_revoke') dncDeletes.push(String(change.entity_id));
  }
  return {
    pins: { upserts: pinUpserts, deletes: pinDeletes },
    dnc: { upserts: dncUpserts, deletes: dncDeletes, complete: true, verified: true },
  };
}
