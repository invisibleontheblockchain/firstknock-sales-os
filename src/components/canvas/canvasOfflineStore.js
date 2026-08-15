import localforage from 'localforage';

const STORE_VERSION = 1;
const DEFAULT_NAMESPACE = 'firstknock-canvas-offline-v1';
const OUTBOX_STATES = new Set(['pending', 'sending', 'retry', 'committed', 'rejected']);

export class CanvasOfflineStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CanvasOfflineStoreError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new CanvasOfflineStoreError(code, message, details);
}

function requiredId(value, field) {
  const normalized = String(value || '').trim();
  if (!normalized) fail('CANVAS_OFFLINE_INVALID_SCOPE', `${field} is required.`, { field });
  return normalized;
}

function optionalId(value, fallback) {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function scopeOf({ actorUserId, campaignId, zoneId } = {}, { zoneRequired = true } = {}) {
  return {
    actorUserId: requiredId(actorUserId, 'actorUserId'),
    campaignId: requiredId(campaignId, 'campaignId'),
    zoneId: zoneRequired ? requiredId(zoneId, 'zoneId') : optionalId(zoneId, ''),
  };
}

function segment(value) {
  return encodeURIComponent(String(value));
}

function scopePrefix(kind, scope) {
  const base = `${kind}:${segment(scope.actorUserId)}:${segment(scope.campaignId)}`;
  return scope.zoneId ? `${base}:${segment(scope.zoneId)}` : base;
}

function asTimestamp(value, field) {
  const timestamp = typeof value === 'number' ? value : new Date(value).valueOf();
  if (!Number.isFinite(timestamp)) fail('CANVAS_OFFLINE_INVALID_TIME', `${field} must be a valid timestamp.`, { field, value });
  return timestamp;
}

function iso(timestamp) {
  return new Date(timestamp).toISOString();
}

function recordId(value, field = 'id') {
  const candidate = value?.pin_id
    ?? value?.suppression_id
    ?? value?.entry_id
    ?? value?.event_id
    ?? value?.id
    ?? value?.house_id;
  return requiredId(candidate, field);
}

function outboxPrefix(scope) {
  return `outbox:${segment(scope.actorUserId)}:`;
}

function outboxKey(scope, idempotencyKey) {
  return `${outboxPrefix(scope)}${segment(idempotencyKey)}`;
}

function stableValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('CANVAS_OFFLINE_INVALID_PAYLOAD', 'Offline payloads cannot contain non-finite numbers.');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') fail('CANVAS_OFFLINE_INVALID_PAYLOAD', 'Offline payload contains an unsupported value.');
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) fail('CANVAS_OFFLINE_INVALID_PAYLOAD', 'Offline payloads cannot contain undefined values.', { key });
    output[key] = stableValue(value[key]);
  }
  return output;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function normalizeItems(items, field) {
  if (!Array.isArray(items)) fail('CANVAS_OFFLINE_INVALID_COLLECTION', `${field} must be an array.`, { field });
  const unique = new Map();
  for (const item of items) unique.set(recordId(item, `${field}.id`), item);
  return [...unique.values()];
}

function mergeItems(existing, upserts = [], deletes = []) {
  const items = new Map(existing.map((item) => [recordId(item), item]));
  for (const id of deletes) items.delete(requiredId(id, 'deleteId'));
  for (const item of upserts) items.set(recordId(item), item);
  return [...items.values()].sort((left, right) => recordId(left).localeCompare(recordId(right)));
}

function cloneForMemory(value) {
  if (value === undefined) return undefined;
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function createMemoryCanvasStorage() {
  const values = new Map();
  return {
    async getItem(key) {
      return cloneForMemory(values.get(key));
    },
    async setItem(key, value) {
      values.set(key, cloneForMemory(value));
      return value;
    },
    async removeItem(key) {
      values.delete(key);
    },
    async iterate(callback) {
      let iteration = 1;
      for (const [key, value] of values) {
        const result = callback(cloneForMemory(value), key, iteration);
        iteration += 1;
        if (result !== undefined) return result;
      }
      return undefined;
    },
    async clear() {
      values.clear();
    },
  };
}

function createBrowserStorage(namespace) {
  return localforage.createInstance({
    name: 'firstknock-canvas',
    storeName: String(namespace).replace(/[^A-Za-z0-9_]/g, '_'),
    description: 'Verified Canvas field packages, map state, and sync outbox.',
  });
}

function normalizeCursor(value) {
  if (value === undefined) return null;
  return value;
}

function sameCursor(left, right) {
  return stableStringify(normalizeCursor(left)) === stableStringify(normalizeCursor(right));
}

/**
 * Creates an actor- and campaign-scoped Canvas cache. The supplied adapter only
 * needs the localForage getItem/setItem/removeItem/iterate surface, which keeps
 * the module usable in browsers, Capacitor, service workers, and deterministic tests.
 */
export function createCanvasOfflineStore({ storage, namespace = DEFAULT_NAMESPACE, now = Date.now } = {}) {
  const backingStore = storage || createBrowserStorage(namespace);
  let exclusiveTail = Promise.resolve();

  function currentTime() {
    return asTimestamp(now(), 'now');
  }

  function runExclusive(callback) {
    const result = exclusiveTail.then(callback, callback);
    exclusiveTail = result.catch(() => undefined);
    return result;
  }

  async function putAssignmentIndex(input) {
    const actorUserId = requiredId(input?.actorUserId, 'actorUserId');
    const assignments = Array.isArray(input?.assignments) ? input.assignments : [];
    const normalizedAssignments = assignments.map((assignment) => {
      const campaignId = requiredId(assignment?.campaign_id ?? assignment?.session_id, 'assignment.campaign_id');
      const zoneId = requiredId(assignment?.zone?.zone_id ?? assignment?.zone_id, 'assignment.zone_id');
      return {
        ...assignment,
        campaign_id: campaignId,
        session_id: String(assignment?.session_id || campaignId),
        zone: { ...(assignment?.zone || {}), zone_id: zoneId },
      };
    });
    const record = {
      schemaVersion: STORE_VERSION,
      actorUserId,
      assignments: normalizedAssignments,
      rejectedDeployments: Math.max(0, Number(input?.rejectedDeployments || 0)),
      serverTime: input?.serverTime || null,
      cachedAt: iso(currentTime()),
    };
    return runExclusive(async () => {
      const indexKey = `assignment-index:${segment(actorUserId)}`;
      if (input.authoritativeComplete === true) {
        const previous = await backingStore.getItem(indexKey);
        const currentScopes = new Set(normalizedAssignments.map((assignment) => (
          `${assignment.campaign_id}\u0000${assignment.zone.zone_id}`
        )));
        for (const assignment of previous?.assignments || []) {
          const campaignId = String(assignment?.campaign_id ?? assignment?.session_id ?? '').trim();
          const zoneId = String(assignment?.zone?.zone_id ?? assignment?.zone_id ?? '').trim();
          if (!campaignId || !zoneId || currentScopes.has(`${campaignId}\u0000${zoneId}`)) continue;
          const scope = { actorUserId, campaignId, zoneId };
          await backingStore.setItem(scopePrefix('assignment-unavailable', scope), {
            schemaVersion: STORE_VERSION,
            ...scope,
            code: 'CANVAS_ASSIGNMENT_REMOVED',
            message: 'This Canvas assignment is no longer present in the complete server assignment index.',
            markedAt: iso(currentTime()),
          });
        }
      }
      await backingStore.setItem(indexKey, record);
      return record;
    });
  }

  async function getAssignmentIndex(input) {
    const actorUserId = requiredId(input?.actorUserId, 'actorUserId');
    return (await backingStore.getItem(`assignment-index:${segment(actorUserId)}`)) || null;
  }

  async function markAssignmentUnavailable(input) {
    const scope = scopeOf(input);
    const record = {
      schemaVersion: STORE_VERSION,
      ...scope,
      code: optionalId(input.code, 'CANVAS_ASSIGNMENT_UNAVAILABLE'),
      message: optionalId(input.message, 'This Canvas assignment is no longer available.'),
      markedAt: iso(currentTime()),
    };
    await backingStore.setItem(scopePrefix('assignment-unavailable', scope), record);
    return record;
  }

  async function getAssignmentUnavailable(input) {
    const scope = scopeOf(input);
    return (await backingStore.getItem(scopePrefix('assignment-unavailable', scope))) || null;
  }

  async function clearAssignmentUnavailable(input) {
    const scope = scopeOf(input);
    await backingStore.removeItem(scopePrefix('assignment-unavailable', scope));
  }

  async function putPackage(input) {
    const scope = scopeOf(input);
    const packageVersion = requiredId(input.packageVersion ?? input.manifest?.package_version, 'packageVersion');
    if (!input.manifest || typeof input.manifest !== 'object') {
      fail('CANVAS_OFFLINE_INVALID_PACKAGE', 'A Canvas package manifest is required.');
    }
    if (input.verification?.verified !== true || input.verification?.dncComplete !== true) {
      fail('CANVAS_OFFLINE_UNVERIFIED_PACKAGE', 'Only a verified package with a complete DNC snapshot may be cached.');
    }
    const verifiedIdentity = {
      actorUserId: input.verification.actorUserId,
      campaignId: input.verification.campaignId,
      zoneId: input.verification.zoneId,
      packageVersion: input.verification.packageVersion,
    };
    for (const [field, actual] of Object.entries({ ...scope, packageVersion })) {
      if (String(verifiedIdentity[field] || '') !== actual) {
        fail('CANVAS_OFFLINE_PACKAGE_SCOPE_MISMATCH', 'Verified Canvas package identity does not match its cache scope.', {
          field,
          expected: actual,
          actual: verifiedIdentity[field],
        });
      }
    }
    const manifestIdentity = {
      actorUserId: input.manifest.assignee_user_id ?? input.manifest.actor_user_id,
      campaignId: input.manifest.campaign_id,
      zoneId: input.manifest.zone_id,
      packageVersion: String(input.manifest.package_version ?? ''),
    };
    for (const [field, actual] of Object.entries({ ...scope, packageVersion })) {
      if (String(manifestIdentity[field] || '') !== actual) {
        fail('CANVAS_OFFLINE_PACKAGE_SCOPE_MISMATCH', 'Canvas package manifest does not match its cache scope.', {
          field,
          expected: actual,
          actual: manifestIdentity[field],
        });
      }
    }
    const timestamp = currentTime();
    const record = {
      schemaVersion: STORE_VERSION,
      actorUserId: scope.actorUserId,
      campaignId: scope.campaignId,
      zoneId: scope.zoneId,
      packageVersion,
      manifest: input.manifest,
      verification: input.verification,
      trustKeyId: optionalId(input.verification?.keyId, ''),
      cachedAt: input.cachedAt || iso(timestamp),
      updatedAt: iso(timestamp),
    };
    return runExclusive(async () => {
      await backingStore.setItem(`${scopePrefix('package', scope)}:${segment(packageVersion)}`, record);
      await backingStore.setItem(scopePrefix('package-latest', scope), packageVersion);
      return record;
    });
  }

  async function getPackage(input) {
    const scope = scopeOf(input);
    const packageVersion = input.packageVersion
      ? requiredId(input.packageVersion, 'packageVersion')
      : await backingStore.getItem(scopePrefix('package-latest', scope));
    if (!packageVersion) return null;
    return (await backingStore.getItem(`${scopePrefix('package', scope)}:${segment(packageVersion)}`)) || null;
  }

  async function putArtifact(input) {
    const scope = scopeOf(input);
    const packageVersion = requiredId(input.packageVersion, 'packageVersion');
    const artifactId = requiredId(input.artifactId, 'artifactId');
    if (input.bytes === undefined || input.bytes === null) {
      fail('CANVAS_OFFLINE_INVALID_ARTIFACT', 'Canvas artifact bytes are required.', { artifactId });
    }
    const timestamp = currentTime();
    const record = {
      schemaVersion: STORE_VERSION,
      actorUserId: scope.actorUserId,
      campaignId: scope.campaignId,
      zoneId: scope.zoneId,
      packageVersion,
      artifactId,
      metadata: input.metadata || {},
      verified: input.verified === true,
      cachedAt: input.cachedAt || iso(timestamp),
      updatedAt: iso(timestamp),
    };
    const suffix = `${segment(packageVersion)}:${segment(artifactId)}`;
    return runExclusive(async () => {
      // Keep large immutable payloads separate from their small index records so
      // startup readiness checks never materialize every tile into memory.
      await backingStore.setItem(`${scopePrefix('artifact-bytes', scope)}:${suffix}`, input.bytes);
      await backingStore.setItem(`${scopePrefix('artifact-meta', scope)}:${suffix}`, record);
      return { ...record, bytes: input.bytes };
    });
  }

  async function getArtifact(input) {
    const scope = scopeOf(input);
    const packageVersion = requiredId(input.packageVersion, 'packageVersion');
    const artifactId = requiredId(input.artifactId, 'artifactId');
    const suffix = `${segment(packageVersion)}:${segment(artifactId)}`;
    const metadata = await backingStore.getItem(`${scopePrefix('artifact-meta', scope)}:${suffix}`);
    if (!metadata) return null;
    return {
      ...metadata,
      bytes: await backingStore.getItem(`${scopePrefix('artifact-bytes', scope)}:${suffix}`),
    };
  }

  async function listArtifacts(input) {
    const scope = scopeOf(input);
    const packageVersion = requiredId(input.packageVersion, 'packageVersion');
    const prefix = `${scopePrefix('artifact-meta', scope)}:${segment(packageVersion)}:`;
    const records = [];
    await backingStore.iterate((value, key) => {
      if (key.startsWith(prefix) && value) records.push(value);
    });
    records.sort((left, right) => left.artifactId.localeCompare(right.artifactId));
    if (input.includeBytes !== true) return records;
    return Promise.all(records.map((record) => getArtifact({ ...scope, packageVersion, artifactId: record.artifactId })));
  }

  async function putPins(input) {
    const scope = scopeOf(input);
    const incoming = normalizeItems(input.pins || [], 'pins');
    const key = scopePrefix('pins', scope);
    return runExclusive(async () => {
      const previous = (await backingStore.getItem(key)) || { pins: [] };
      const pins = input.replace === false ? mergeItems(previous.pins || [], incoming) : mergeItems([], incoming);
      const record = {
        schemaVersion: STORE_VERSION,
        ...scope,
        pins,
        updatedAt: iso(currentTime()),
      };
      await backingStore.setItem(key, record);
      return record;
    });
  }

  async function getPins(input) {
    const scope = scopeOf(input);
    const record = await backingStore.getItem(scopePrefix('pins', scope));
    return record?.pins || [];
  }

  async function putDncSnapshot(input) {
    const scope = scopeOf(input);
    const entries = normalizeItems(input.entries || [], 'dnc.entries');
    const timestamp = currentTime();
    const record = {
      schemaVersion: STORE_VERSION,
      ...scope,
      packageVersion: optionalId(input.packageVersion, ''),
      entries: mergeItems([], entries),
      complete: input.complete === true,
      verified: input.verified === true,
      sourceCursor: normalizeCursor(input.sourceCursor),
      digest: optionalId(input.digest, ''),
      cachedAt: input.cachedAt || iso(timestamp),
      updatedAt: iso(timestamp),
    };
    await backingStore.setItem(scopePrefix('dnc', scope), record);
    return record;
  }

  async function getDncSnapshot(input) {
    const scope = scopeOf(input);
    return (await backingStore.getItem(scopePrefix('dnc', scope))) || null;
  }

  async function isDncReady(input) {
    const snapshot = await getDncSnapshot(input);
    if (!snapshot || snapshot.complete !== true || snapshot.verified !== true) return false;
    if (input.packageVersion && snapshot.packageVersion !== String(input.packageVersion)) return false;
    return true;
  }

  async function setCursor(input) {
    const scope = scopeOf(input);
    const record = {
      schemaVersion: STORE_VERSION,
      ...scope,
      cursor: normalizeCursor(input.cursor),
      updatedAt: iso(currentTime()),
    };
    await backingStore.setItem(scopePrefix('cursor', scope), record);
    return record;
  }

  async function getCursor(input) {
    const scope = scopeOf(input);
    const record = await backingStore.getItem(scopePrefix('cursor', scope));
    return record?.cursor ?? null;
  }

  async function enqueueOutbox(input) {
    const scope = scopeOf(input);
    const idempotencyKey = requiredId(input.idempotencyKey, 'idempotencyKey');
    if (!input.payload || typeof input.payload !== 'object') {
      fail('CANVAS_OFFLINE_INVALID_PAYLOAD', 'An outbox payload object is required.');
    }
    const key = outboxKey(scope, idempotencyKey);
    return runExclusive(async () => {
      const existing = await backingStore.getItem(key);
      if (existing) {
        const sameScope = existing.campaignId === scope.campaignId && existing.zoneId === scope.zoneId;
        const samePackageVersion = existing.packageVersion === optionalId(input.packageVersion, '');
        if (!sameScope || !samePackageVersion || stableStringify(existing.payload) !== stableStringify(input.payload)) {
          fail('CANVAS_OFFLINE_IDEMPOTENCY_REUSE', 'An idempotency key cannot be reused for different Canvas data.', { idempotencyKey });
        }
        return existing;
      }
      const timestamp = currentTime();
      const record = {
        schemaVersion: STORE_VERSION,
        ...scope,
        packageVersion: optionalId(input.packageVersion, ''),
        idempotencyKey,
        payload: input.payload,
        state: 'pending',
        attemptCount: 0,
        queuedAt: input.queuedAt || iso(timestamp),
        nextAttemptAt: input.nextAttemptAt || iso(timestamp),
        lastAttemptAt: null,
        leaseExpiresAt: null,
        committedAt: null,
        rejectedAt: null,
        lastError: null,
        serverResult: null,
        updatedAt: iso(timestamp),
      };
      await backingStore.setItem(key, record);
      return record;
    });
  }

  async function listOutbox(input) {
    const scope = scopeOf(input);
    const acceptedStates = new Set(input.states || ['pending', 'retry']);
    for (const state of acceptedStates) {
      if (!OUTBOX_STATES.has(state)) fail('CANVAS_OFFLINE_INVALID_OUTBOX_STATE', `Unsupported outbox state: ${state}.`);
    }
    const dueBefore = input.dueBefore === undefined ? currentTime() : asTimestamp(input.dueBefore, 'dueBefore');
    const limit = Math.max(0, Math.min(1_000, Number.isSafeInteger(input.limit) ? input.limit : 100));
    const prefix = outboxPrefix(scope);
    const requestedPackageVersion = optionalId(input.packageVersion, '');
    const records = [];
    await backingStore.iterate((value, key) => {
      if (!key.startsWith(prefix) || !value) return;
      if (value.campaignId !== scope.campaignId || value.zoneId !== scope.zoneId) return;
      if (input.includeAllPackageVersions !== true && requestedPackageVersion
        && String(value.packageVersion || '') !== requestedPackageVersion) return;
      const expiredSending = value.state === 'sending'
        && value.leaseExpiresAt
        && asTimestamp(value.leaseExpiresAt, 'leaseExpiresAt') <= dueBefore;
      if (!acceptedStates.has(value.state) && !(expiredSending && acceptedStates.has('retry'))) return;
      const effectiveDueAt = value.state === 'sending' ? value.leaseExpiresAt : value.nextAttemptAt;
      if (effectiveDueAt && asTimestamp(effectiveDueAt, 'effectiveDueAt') > dueBefore) return;
      records.push(value);
    });
    records.sort((left, right) => {
      const leftDue = left.state === 'sending' ? left.leaseExpiresAt : left.nextAttemptAt;
      const rightDue = right.state === 'sending' ? right.leaseExpiresAt : right.nextAttemptAt;
      const due = asTimestamp(leftDue, 'leftDueAt') - asTimestamp(rightDue, 'rightDueAt');
      return due || String(left.queuedAt).localeCompare(String(right.queuedAt)) || left.idempotencyKey.localeCompare(right.idempotencyKey);
    });
    return records.slice(0, limit);
  }

  async function claimOutbox(input) {
    const scope = scopeOf(input);
    const keys = [...new Set((input.idempotencyKeys || []).map((key) => requiredId(key, 'idempotencyKey')))];
    const leaseMs = Number.isFinite(Number(input.leaseMs))
      ? Math.max(1_000, Math.min(10 * 60_000, Number(input.leaseMs)))
      : 60_000;
    return runExclusive(async () => {
      const claimed = [];
      const timestamp = currentTime();
      for (const idempotencyKey of keys) {
        const storageKey = outboxKey(scope, idempotencyKey);
        const record = await backingStore.getItem(storageKey);
        const leaseExpired = record?.state === 'sending'
          && record.leaseExpiresAt
          && asTimestamp(record.leaseExpiresAt, 'leaseExpiresAt') <= timestamp;
        if (!record || record.campaignId !== scope.campaignId || record.zoneId !== scope.zoneId
          || (input.packageVersion && String(record.packageVersion || '') !== String(input.packageVersion))
          || (!['pending', 'retry'].includes(record.state) && !leaseExpired)) continue;
        const updated = {
          ...record,
          state: 'sending',
          attemptCount: record.attemptCount + 1,
          lastAttemptAt: iso(timestamp),
          leaseExpiresAt: iso(timestamp + leaseMs),
          updatedAt: iso(timestamp),
        };
        await backingStore.setItem(storageKey, updated);
        claimed.push(updated);
      }
      return claimed;
    });
  }

  async function discardOutbox(input) {
    const scope = scopeOf(input);
    const idempotencyKey = requiredId(input.idempotencyKey, 'idempotencyKey');
    const storageKey = outboxKey(scope, idempotencyKey);
    return runExclusive(async () => {
      const record = await backingStore.getItem(storageKey);
      if (!record || record.campaignId !== scope.campaignId || record.zoneId !== scope.zoneId) return false;
      if (record.state === 'sending' || record.state === 'committed') {
        fail('CANVAS_OFFLINE_OUTBOX_IMMUTABLE', 'A sending or committed Canvas decision cannot be discarded.', { idempotencyKey });
      }
      await backingStore.removeItem(storageKey);
      return true;
    });
  }

  async function quarantineOutboxPackageMismatches(input) {
    const scope = scopeOf(input);
    const currentPackageVersion = requiredId(input.currentPackageVersion, 'currentPackageVersion');
    const prefix = outboxPrefix(scope);
    return runExclusive(async () => {
      const mismatches = [];
      await backingStore.iterate((value, key) => {
        if (!key.startsWith(prefix) || !value) return;
        if (value.campaignId !== scope.campaignId || value.zoneId !== scope.zoneId) return;
        if (!['pending', 'retry', 'sending'].includes(value.state)) return;
        if (String(value.packageVersion || '') === currentPackageVersion) return;
        mismatches.push({ key, value });
      });
      const timestamp = currentTime();
      for (const mismatch of mismatches) {
        await backingStore.setItem(mismatch.key, {
          ...mismatch.value,
          state: 'rejected',
          leaseExpiresAt: null,
          rejectedAt: iso(timestamp),
          lastError: {
            code: 'CANVAS_PACKAGE_VERSION_REQUIRES_REVIEW',
            message: `This decision was saved under Canvas package ${mismatch.value.packageVersion || 'unknown'} and was not sent under replacement package ${currentPackageVersion}. Review it against the current territory.`,
          },
          updatedAt: iso(timestamp),
        });
      }
      return mismatches.length;
    });
  }

  async function applySyncResult(input) {
    const scope = scopeOf(input);
    const outcomes = Array.isArray(input.outcomes) ? input.outcomes : [];
    const delta = input.delta && typeof input.delta === 'object' ? input.delta : {};
    return runExclusive(async () => {
      const cursorKey = scopePrefix('cursor', scope);
      const currentCursorRecord = await backingStore.getItem(cursorKey);
      const currentCursor = currentCursorRecord?.cursor ?? null;
      if (input.expectedCursor !== undefined && !sameCursor(currentCursor, input.expectedCursor)) {
        fail('CANVAS_OFFLINE_CURSOR_CONFLICT', 'Canvas delta is based on a different cursor.', {
          expected: input.expectedCursor,
          actual: currentCursor,
        });
      }

      if (delta.pins) {
        const pinsKey = scopePrefix('pins', scope);
        const previous = (await backingStore.getItem(pinsKey)) || { pins: [] };
        const upserts = delta.pins.upserts || delta.pins.upsert || [];
        const deletes = delta.pins.deletes || delta.pins.deleteIds || delta.pins.delete_ids || [];
        const pins = delta.pins.replace === true
          ? mergeItems([], normalizeItems(upserts, 'delta.pins.upserts'))
          : mergeItems(previous.pins || [], normalizeItems(upserts, 'delta.pins.upserts'), deletes);
        await backingStore.setItem(pinsKey, {
          schemaVersion: STORE_VERSION,
          ...scope,
          pins,
          updatedAt: iso(currentTime()),
        });
      }

      if (delta.dnc) {
        const dncKey = scopePrefix('dnc', scope);
        const previous = (await backingStore.getItem(dncKey)) || { entries: [], complete: false, verified: false };
        const upserts = delta.dnc.entries || delta.dnc.upserts || delta.dnc.upsert || [];
        const deletes = delta.dnc.deletes || delta.dnc.deleteIds || delta.dnc.delete_ids || [];
        const entries = delta.dnc.replace === true
          ? mergeItems([], normalizeItems(upserts, 'delta.dnc.entries'))
          : mergeItems(previous.entries || [], normalizeItems(upserts, 'delta.dnc.entries'), deletes);
        await backingStore.setItem(dncKey, {
          ...previous,
          schemaVersion: STORE_VERSION,
          ...scope,
          entries,
          complete: delta.dnc.complete === undefined ? previous.complete === true : delta.dnc.complete === true,
          verified: delta.dnc.verified === undefined ? previous.verified === true : delta.dnc.verified === true,
          sourceCursor: delta.dnc.sourceCursor ?? delta.dnc.source_cursor ?? previous.sourceCursor ?? null,
          digest: delta.dnc.digest ?? previous.digest ?? '',
          updatedAt: iso(currentTime()),
        });
      }

      const appliedOutcomes = [];
      for (const outcome of outcomes) {
        const idempotencyKey = requiredId(outcome.idempotencyKey, 'outcome.idempotencyKey');
        if (!OUTBOX_STATES.has(outcome.state) || !['retry', 'committed', 'rejected'].includes(outcome.state)) {
          fail('CANVAS_OFFLINE_INVALID_OUTBOX_STATE', `Unsupported sync outcome: ${outcome.state}.`);
        }
        const storageKey = outboxKey(scope, idempotencyKey);
        const record = await backingStore.getItem(storageKey);
        if (!record || record.campaignId !== scope.campaignId || record.zoneId !== scope.zoneId) continue;
        if (input.packageVersion && String(record.packageVersion || '') !== String(input.packageVersion)) continue;
        if (outcome.attemptCount !== undefined && record.attemptCount !== outcome.attemptCount) continue;
        if (record.state === 'committed' || record.state === 'rejected') {
          appliedOutcomes.push(record);
          continue;
        }
        if (record.state !== 'sending') continue;
        const timestamp = currentTime();
        const updated = {
          ...record,
          state: outcome.state,
          leaseExpiresAt: null,
          nextAttemptAt: outcome.state === 'retry'
            ? iso(asTimestamp(outcome.nextAttemptAt, 'outcome.nextAttemptAt'))
            : record.nextAttemptAt,
          lastError: outcome.error || null,
          serverResult: outcome.serverResult ?? null,
          committedAt: outcome.state === 'committed' ? iso(timestamp) : null,
          rejectedAt: outcome.state === 'rejected' ? iso(timestamp) : null,
          updatedAt: iso(timestamp),
        };
        await backingStore.setItem(storageKey, updated);
        appliedOutcomes.push(updated);
      }

      const nextCursor = input.nextCursor !== undefined
        ? input.nextCursor
        : delta.nextCursor !== undefined
          ? delta.nextCursor
          : delta.next_cursor !== undefined
            ? delta.next_cursor
            : delta.cursor;
      if (nextCursor !== undefined) {
        await backingStore.setItem(cursorKey, {
          schemaVersion: STORE_VERSION,
          ...scope,
          cursor: normalizeCursor(nextCursor),
          updatedAt: iso(currentTime()),
        });
      }
      return { outcomes: appliedOutcomes, cursor: nextCursor === undefined ? currentCursor : nextCursor };
    });
  }

  async function readCachedWorkspace(input) {
    const scope = scopeOf(input);
    const packageRecord = await getPackage({ ...scope, ...(input.packageVersion ? { packageVersion: input.packageVersion } : {}) });
    const packageVersion = packageRecord?.packageVersion || '';
    const [artifacts, pins, dnc, cursor] = await Promise.all([
      packageVersion ? listArtifacts({ ...scope, packageVersion }) : [],
      getPins(scope),
      getDncSnapshot(scope),
      getCursor(scope),
    ]);
    const expiresAt = packageRecord?.verification?.expiresAt;
    const expired = expiresAt ? asTimestamp(expiresAt, 'verification.expiresAt') <= currentTime() : false;
    const artifactIds = new Set(artifacts.filter((artifact) => artifact.verified).map((artifact) => artifact.artifactId));
    const requiredArtifacts = packageRecord?.verification?.requiredArtifactIds || [];
    const artifactsComplete = requiredArtifacts.every((artifactId) => artifactIds.has(artifactId));
    const dncReady = Boolean(dnc?.complete && dnc?.verified && (!packageVersion || dnc.packageVersion === packageVersion));
    return {
      package: packageRecord,
      artifacts,
      pins,
      dnc,
      cursor,
      ready: Boolean(packageRecord && !expired && artifactsComplete && dncReady),
      reasons: {
        packageMissing: !packageRecord,
        packageExpired: expired,
        artifactsIncomplete: !artifactsComplete,
        dncIncomplete: !dncReady,
      },
    };
  }

  return Object.freeze({
    putAssignmentIndex,
    getAssignmentIndex,
    markAssignmentUnavailable,
    getAssignmentUnavailable,
    clearAssignmentUnavailable,
    putPackage,
    getPackage,
    putArtifact,
    getArtifact,
    listArtifacts,
    putPins,
    getPins,
    putDncSnapshot,
    getDncSnapshot,
    isDncReady,
    setCursor,
    getCursor,
    enqueueOutbox,
    listOutbox,
    claimOutbox,
    discardOutbox,
    quarantineOutboxPackageMismatches,
    applySyncResult,
    readCachedWorkspace,
  });
}
