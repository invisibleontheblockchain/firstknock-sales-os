import localforage from 'localforage';

const MAX_QUEUE_ITEMS = 200;
const AUTO_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const HARD_RETENTION_MS = 24 * 60 * 60 * 1000;

const inspectionQueue = localforage.createInstance({
  name: 'firstknock-fieldroutes',
  storeName: 'inspection_request_queue_v1',
  description: 'Actor and tenant scoped FieldRoutes inspection requests awaiting server ownership.',
});

function requiredScope(value, field) {
  const result = String(value || '').trim();
  if (!result) throw new Error(`${field} is required for a FieldRoutes offline request.`);
  return result;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function immutableFingerprint(intent) {
  return JSON.stringify(stableValue(intent));
}

function sourceIdentity(source = {}) {
  const mode = requiredScope(source.kind || source.mode || source.source_mode, 'source kind');
  const identity = source.source_key
    || source.property_key
    || source.address_hash
    || source.pin_id
    || [source.campaign_id, source.zone_id, source.point?.lat, source.point?.lng, source.unit].filter((value) => value !== undefined && value !== null && value !== '').join(':');
  return `${mode}:${requiredScope(identity, 'source identity')}`;
}

function actorScope({ actor_user_id, manager_id } = {}) {
  return `${requiredScope(actor_user_id, 'actor user')}:${requiredScope(manager_id, 'manager tenant')}`;
}

function effectiveExpiry(record, field, maximumWindowMs) {
  const queuedAt = Date.parse(record?.queued_at);
  if (!Number.isFinite(queuedAt)) return 0;
  const maximum = queuedAt + maximumWindowMs;
  const stored = Date.parse(record?.[field]);
  return Number.isFinite(stored) ? Math.min(stored, maximum) : maximum;
}

function recordScope(record) {
  const actor = String(record?.actor_user_id || '').trim();
  const manager = String(record?.manager_id || '').trim();
  return actor && manager ? `${actor}:${manager}` : '';
}

export async function activateFieldRoutesQueueScope({ actorUserId, managerId } = {}) {
  const scope = actorScope({ actor_user_id: actorUserId, manager_id: managerId });
  const now = Date.now();
  const entries = await allQueueEntries();
  const removable = entries.filter(({ value }) => (
    recordScope(value) !== scope
    || effectiveExpiry(value, 'hard_expires_at', HARD_RETENTION_MS) <= now
  ));
  await Promise.all(removable.map(({ key }) => inspectionQueue.removeItem(key)));
  return scope;
}

export async function clearFieldRoutesInspectionQueue() {
  await inspectionQueue.clear();
}

function queueKey(intent) {
  const idempotencyKey = requiredScope(intent?.idempotency_key, 'idempotency key');
  return `${actorScope(intent)}:${sourceIdentity(intent.source)}:${idempotencyKey}`;
}

async function allQueueEntries() {
  const entries = [];
  await inspectionQueue.iterate((value, key) => {
    if (value) entries.push({ key, value });
  });
  return entries;
}

async function pruneExpiredEntries(scope, now = Date.now()) {
  const entries = await allQueueEntries();
  const expired = entries.filter(({ value }) => (
    recordScope(value) !== scope
    || effectiveExpiry(value, 'hard_expires_at', HARD_RETENTION_MS) <= now
  ));
  await Promise.all(expired.map(({ key }) => inspectionQueue.removeItem(key)));
  return entries.filter(({ value }) => recordScope(value) === scope).length - expired.filter(({ value }) => recordScope(value) === scope).length;
}

export function makeFieldRoutesIdempotencyKey() {
  try {
    return `fr_inspection_${crypto.randomUUID()}`;
  } catch {
    return `fr_inspection_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
}

export async function queueFieldRoutesInspection(intent) {
  const scope = await activateFieldRoutesQueueScope({
    actorUserId: intent?.actor_user_id,
    managerId: intent?.manager_id,
  });
  const key = queueKey(intent);
  const existing = await inspectionQueue.getItem(key);
  const fingerprint = immutableFingerprint(intent);
  if (existing) {
    if (existing.immutable_fingerprint !== fingerprint) {
      throw new Error('This FieldRoutes idempotency key is already preserving a different inspection request.');
    }
    return existing;
  }

  const remaining = await pruneExpiredEntries(scope);
  if (remaining >= MAX_QUEUE_ITEMS) {
    throw new Error('This device already has too many unsent FieldRoutes inspections. Reconnect and sync them before adding another.');
  }

  const queuedAt = new Date().toISOString();
  const record = {
    intent: stableValue(intent),
    immutable_fingerprint: fingerprint,
    actor_user_id: requiredScope(intent.actor_user_id, 'actor user'),
    manager_id: requiredScope(intent.manager_id, 'manager tenant'),
    source_identity: sourceIdentity(intent.source),
    idempotency_key: requiredScope(intent.idempotency_key, 'idempotency key'),
    sync_state: 'pending',
    queued_at: queuedAt,
    last_attempt_at: null,
    last_error_code: null,
    last_error_message: null,
    auto_retry_until: new Date(Date.now() + AUTO_RETRY_WINDOW_MS).toISOString(),
    hard_expires_at: new Date(Date.now() + HARD_RETENTION_MS).toISOString(),
  };
  await inspectionQueue.setItem(key, record);
  return record;
}

export async function acknowledgeFieldRoutesInspection(intentOrRecord) {
  const intent = intentOrRecord?.intent || intentOrRecord;
  await inspectionQueue.removeItem(queueKey(intent));
}

export async function markFieldRoutesInspectionAttempt(intentOrRecord, update = {}) {
  const intent = intentOrRecord?.intent || intentOrRecord;
  const key = queueKey(intent);
  const current = await inspectionQueue.getItem(key);
  if (!current) return null;
  const next = {
    ...current,
    sync_state: update.sync_state || current.sync_state,
    last_attempt_at: new Date().toISOString(),
    last_error_code: update.error_code || null,
    last_error_message: update.error_message || null,
  };
  await inspectionQueue.setItem(key, next);
  return next;
}

export async function discardFieldRoutesAttentionBySource({ actorUserId, managerId, sourceKey } = {}) {
  const actor = requiredScope(actorUserId, 'actor user');
  const manager = requiredScope(managerId, 'manager tenant');
  const source = requiredScope(sourceKey, 'source key');
  const scope = `${actor}:${manager}`;
  await activateFieldRoutesQueueScope({ actorUserId: actor, managerId: manager });
  const now = Date.now();
  const entries = await allQueueEntries();
  const discardable = entries.filter(({ value }) => {
    if (!value || `${value.actor_user_id}:${value.manager_id}` !== scope) return false;
    if (String(value.intent?.source?.source_key || '') !== source) return false;
    const retryWindowExpired = effectiveExpiry(value, 'auto_retry_until', AUTO_RETRY_WINDOW_MS) <= now;
    return value.sync_state === 'needs_attention'
      || value.sync_state === 'pending' && retryWindowExpired;
  });
  await Promise.all(discardable.map(({ key }) => inspectionQueue.removeItem(key)));
  return discardable.length;
}

export async function listQueuedFieldRoutesInspections({ actorUserId, managerId, includeAttention = true } = {}) {
  const scope = `${requiredScope(actorUserId, 'actor user')}:${requiredScope(managerId, 'manager tenant')}`;
  const now = Date.now();
  const rows = [];
  await activateFieldRoutesQueueScope({ actorUserId, managerId });
  await pruneExpiredEntries(scope, now);
  await inspectionQueue.iterate((value) => {
    if (!value || `${value.actor_user_id}:${value.manager_id}` !== scope) return;
    const retryUntil = effectiveExpiry(value, 'auto_retry_until', AUTO_RETRY_WINDOW_MS);
    const syncState = retryUntil <= now && value.sync_state === 'pending'
      ? 'needs_attention'
      : value.sync_state;
    if (!includeAttention && syncState === 'needs_attention') return;
    rows.push({
      ...value,
      sync_state: syncState,
    });
  });
  return rows.sort((left, right) => String(left.queued_at).localeCompare(String(right.queued_at)));
}

export async function flushQueuedFieldRoutesInspections({
  actorUserId,
  managerId,
  send,
  isAcknowledged,
  onAcknowledged,
} = {}) {
  if (typeof send !== 'function' || typeof isAcknowledged !== 'function') {
    throw new Error('A FieldRoutes sender and acknowledgement verifier are required.');
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { attempted: 0, acknowledged: 0 };
  const queued = await listQueuedFieldRoutesInspections({ actorUserId, managerId, includeAttention: false });
  let acknowledged = 0;
  let attempted = 0;
  for (const record of queued) {
    if (record.actor_user_id !== String(actorUserId) || record.manager_id !== String(managerId)) continue;
    attempted += 1;
    try {
      const result = await send(record.intent);
      if (!isAcknowledged(result)) throw new Error('FieldRoutes did not confirm durable server ownership of this inspection request.');
      await acknowledgeFieldRoutesInspection(record);
      acknowledged += 1;
      await onAcknowledged?.(result, record.intent);
    } catch (error) {
      const status = Number(error?.status || error?.response?.status);
      const terminal = Number.isFinite(status)
        && status >= 400
        && status < 500
        && ![408, 425, 429].includes(status)
        && error?.retryable !== true;
      await markFieldRoutesInspectionAttempt(record, {
        sync_state: terminal ? 'needs_attention' : 'pending',
        error_code: error?.code || null,
        error_message: String(error?.message || 'Inspection sync failed.').slice(0, 500),
      });
      if (!terminal) break;
    }
  }
  return { attempted, acknowledged };
}
