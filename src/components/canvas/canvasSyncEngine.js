const DEFAULT_BATCH_SIZE = 25;
const MAX_BATCH_SIZE = 100;
const DEFAULT_BASE_RETRY_MS = 1_000;
const DEFAULT_MAX_RETRY_MS = 5 * 60_000;

export class CanvasSyncError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CanvasSyncError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new CanvasSyncError(code, message, details);
}

function requiredId(value, field) {
  const normalized = String(value || '').trim();
  if (!normalized) fail('CANVAS_SYNC_INVALID_SCOPE', `${field} is required.`, { field });
  return normalized;
}

function normalizedScope(input = {}) {
  return {
    actorUserId: requiredId(input.actorUserId, 'actorUserId'),
    campaignId: requiredId(input.campaignId, 'campaignId'),
    zoneId: requiredId(input.zoneId, 'zoneId'),
    packageVersion: String(input.packageVersion || '').trim(),
  };
}

function asTime(value, field) {
  const timestamp = typeof value === 'number' ? value : new Date(value).valueOf();
  if (!Number.isFinite(timestamp)) fail('CANVAS_SYNC_INVALID_TIME', `${field} must be a valid timestamp.`, { field, value });
  return timestamp;
}

function boundedInteger(value, fallback, maximum) {
  const candidate = Number.isSafeInteger(value) && value >= 1 ? value : fallback;
  return Math.min(candidate, maximum);
}

function safeError(error) {
  if (!error) return { code: 'CANVAS_SYNC_FAILED', message: 'Canvas sync failed.' };
  return {
    code: String(error.code || error.name || 'CANVAS_SYNC_FAILED').slice(0, 128),
    message: String(error.message || 'Canvas sync failed.').slice(0, 512),
  };
}

function safeResultError(result) {
  const nested = result?.error;
  const code = typeof nested === 'string'
    ? nested
    : nested?.code || result?.code || 'CANVAS_SYNC_ITEM_FAILED';
  const message = typeof nested === 'object' && nested?.message
    ? nested.message
    : result?.message || 'This Canvas decision needs review.';
  return {
    code: String(code).slice(0, 128),
    message: String(message).slice(0, 512),
  };
}

export function canvasRetryDelayMs(attempt, {
  baseRetryMs = DEFAULT_BASE_RETRY_MS,
  maxRetryMs = DEFAULT_MAX_RETRY_MS,
  jitterRatio = 0.2,
  random = Math.random,
} = {}) {
  const safeAttempt = Math.max(1, Number.isSafeInteger(attempt) ? attempt : 1);
  const base = Math.max(1, Number(baseRetryMs) || DEFAULT_BASE_RETRY_MS);
  const maximum = Math.max(base, Number(maxRetryMs) || DEFAULT_MAX_RETRY_MS);
  const exponential = Math.min(maximum, base * (2 ** Math.min(30, safeAttempt - 1)));
  const jitter = Math.max(0, Math.min(1, Number(jitterRatio) || 0));
  const randomValue = Math.max(0, Math.min(1, Number(random()) || 0));
  return Math.round(Math.min(maximum, exponential * (1 - jitter + (2 * jitter * randomValue))));
}

function responseResults(response) {
  if (Array.isArray(response?.results)) return response.results;
  if (response?.results && typeof response.results === 'object') {
    return Object.entries(response.results).map(([idempotencyKey, result]) => ({
      ...(result && typeof result === 'object' ? result : { status: result }),
      idempotency_key: idempotencyKey,
    }));
  }
  return [];
}

function resultId(result) {
  return String(result?.idempotencyKey ?? result?.idempotency_key ?? '').trim();
}

function resultState(result) {
  const status = String(result?.state ?? result?.status ?? '').trim().toLowerCase();
  if (['committed', 'success', 'applied', 'duplicate', 'already_applied'].includes(status)) return 'committed';
  if (['rejected', 'invalid', 'forbidden', 'permanent_failure'].includes(status)) return 'rejected';
  return 'retry';
}

function readNextCursor(response) {
  if (Object.prototype.hasOwnProperty.call(response || {}, 'nextCursor')) return response.nextCursor;
  if (Object.prototype.hasOwnProperty.call(response || {}, 'next_cursor')) return response.next_cursor;
  if (Object.prototype.hasOwnProperty.call(response?.delta || {}, 'cursor')) return response.delta.cursor;
  return undefined;
}

function scopeKey(scope) {
  return `${scope.actorUserId}\u0000${scope.campaignId}\u0000${scope.zoneId}\u0000${scope.packageVersion}`;
}

function deltaWithAcknowledgedPins(delta, outcomes) {
  const acknowledgedPins = outcomes
    .filter((outcome) => outcome.state === 'committed' && outcome.serverResult?.pin)
    .map((outcome) => outcome.serverResult.pin);
  if (!acknowledgedPins.length) return delta || {};
  const current = delta && typeof delta === 'object' ? delta : {};
  const pins = current.pins && typeof current.pins === 'object' ? current.pins : {};
  return {
    ...current,
    pins: {
      ...pins,
      upserts: [...(pins.upserts || pins.upsert || []), ...acknowledgedPins],
    },
  };
}

/**
 * Creates a transport-neutral Canvas sync engine. `transport.syncBatch` is the
 * only network boundary; everything else reads and writes the offline cache.
 */
export function createCanvasSyncEngine({
  store,
  transport,
  now = Date.now,
  random = Math.random,
  batchSize = DEFAULT_BATCH_SIZE,
  maxBatchSize = MAX_BATCH_SIZE,
  baseRetryMs = DEFAULT_BASE_RETRY_MS,
  maxRetryMs = DEFAULT_MAX_RETRY_MS,
  jitterRatio = 0.2,
  outboxLeaseMs = 60_000,
} = {}) {
  if (!store || typeof store !== 'object') fail('CANVAS_SYNC_STORE_REQUIRED', 'A Canvas offline store is required.');
  const syncBatch = typeof transport === 'function' ? transport : transport?.syncBatch;
  if (typeof syncBatch !== 'function') fail('CANVAS_SYNC_TRANSPORT_REQUIRED', 'A Canvas syncBatch transport is required.');
  const maximum = boundedInteger(maxBatchSize, MAX_BATCH_SIZE, MAX_BATCH_SIZE);
  const boundedBatchSize = boundedInteger(batchSize, DEFAULT_BATCH_SIZE, maximum);
  const activeFlushes = new Map();

  function currentTime() {
    return asTime(now(), 'now');
  }

  function retryAt(record, result) {
    const explicitDelay = Number(result?.retryAfterMs ?? result?.retry_after_ms);
    const delay = Number.isFinite(explicitDelay) && explicitDelay >= 0
      ? Math.min(maxRetryMs, explicitDelay)
      : canvasRetryDelayMs(record.attemptCount, { baseRetryMs, maxRetryMs, jitterRatio, random });
    return new Date(currentTime() + delay).toISOString();
  }

  async function assertDncReady(scope) {
    const ready = await store.isDncReady(scope);
    if (!ready) {
      fail('CANVAS_DNC_NOT_READY', 'Canvas sync is blocked until the assigned package has a complete, verified DNC snapshot.', {
        campaignId: scope.campaignId,
        zoneId: scope.zoneId,
      });
    }
  }

  async function queue(input) {
    const scope = normalizedScope(input);
    await assertDncReady(scope);
    return store.enqueueOutbox({
      ...scope,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      queuedAt: input.queuedAt,
    });
  }

  async function scheduleRetry(scope, claimed, error) {
    const normalizedError = safeError(error);
    const outcomes = claimed.map((record) => ({
      idempotencyKey: record.idempotencyKey,
      attemptCount: record.attemptCount,
      state: 'retry',
      nextAttemptAt: retryAt(record),
      error: normalizedError,
    }));
    await store.applySyncResult({ ...scope, outcomes });
    return outcomes;
  }

  async function flushOnce(input) {
    const scope = normalizedScope(input);
    await assertDncReady(scope);
    const startedAt = currentTime();
    const due = await store.listOutbox({
      ...scope,
      states: ['pending', 'retry'],
      dueBefore: startedAt,
      limit: boundedBatchSize,
    });
    if (due.length === 0) {
      return Object.freeze({ ok: true, sent: 0, committed: 0, retried: 0, rejected: 0, hasMore: false });
    }
    const claimed = await store.claimOutbox({
      ...scope,
      idempotencyKeys: due.map((record) => record.idempotencyKey),
      leaseMs: outboxLeaseMs,
    });
    if (claimed.length === 0) {
      return Object.freeze({ ok: true, sent: 0, committed: 0, retried: 0, rejected: 0, hasMore: false });
    }

    const cursor = await store.getCursor(scope);
    let response;
    try {
      response = await syncBatch({
        actorUserId: scope.actorUserId,
        campaignId: scope.campaignId,
        zoneId: scope.zoneId,
        packageVersion: scope.packageVersion || undefined,
        cursor,
        items: claimed.map((record) => ({
          idempotencyKey: record.idempotencyKey,
          idempotency_key: record.idempotencyKey,
          attempt: record.attemptCount,
          payload: record.payload,
        })),
        signal: input.signal,
      });
    } catch (error) {
      const outcomes = await scheduleRetry(scope, claimed, error);
      return Object.freeze({
        ok: false,
        offline: true,
        error: safeError(error),
        sent: claimed.length,
        committed: 0,
        retried: outcomes.length,
        rejected: 0,
        hasMore: false,
        issues: outcomes.map((outcome) => ({ idempotencyKey: outcome.idempotencyKey, state: outcome.state, error: outcome.error })),
      });
    }

    const byIdempotencyKey = new Map(responseResults(response).map((result) => [resultId(result), result]));
    const outcomes = claimed.map((record) => {
      const result = byIdempotencyKey.get(record.idempotencyKey);
      const state = result ? resultState(result) : 'retry';
      return {
        idempotencyKey: record.idempotencyKey,
        attemptCount: record.attemptCount,
        state,
        nextAttemptAt: state === 'retry' ? retryAt(record, result) : undefined,
        error: state === 'committed'
          ? null
          : result
            ? safeResultError(result)
            : safeError(new Error('Canvas server omitted this item result.')),
        serverResult: result?.result ?? result?.server_result ?? null,
      };
    });

    try {
      await store.applySyncResult({
        ...scope,
        expectedCursor: cursor,
        outcomes,
        delta: deltaWithAcknowledgedPins(response?.delta, outcomes),
        nextCursor: readNextCursor(response),
      });
    } catch (error) {
      await scheduleRetry(scope, claimed, error);
      return Object.freeze({
        ok: false,
        offline: false,
        error: safeError(error),
        sent: claimed.length,
        committed: 0,
        retried: claimed.length,
        rejected: 0,
        hasMore: false,
        issues: claimed.map((record) => ({ idempotencyKey: record.idempotencyKey, state: 'retry', error: safeError(error) })),
      });
    }

    const counts = outcomes.reduce((result, outcome) => ({
      ...result,
      [outcome.state]: result[outcome.state] + 1,
    }), { committed: 0, retry: 0, rejected: 0 });
    const remaining = await store.listOutbox({
      ...scope,
      states: ['pending', 'retry'],
      dueBefore: currentTime(),
      limit: 1,
    });
    const responseCursor = readNextCursor(response);
    return Object.freeze({
      ok: counts.retry === 0 && counts.rejected === 0,
      sent: claimed.length,
      committed: counts.committed,
      retried: counts.retry,
      rejected: counts.rejected,
      hasMore: remaining.length > 0,
      cursor: responseCursor === undefined ? cursor : responseCursor,
      issues: outcomes
        .filter((outcome) => outcome.state !== 'committed')
        .map((outcome) => ({
          idempotencyKey: outcome.idempotencyKey,
          state: outcome.state,
          error: outcome.error,
        })),
    });
  }

  function flush(input = {}) {
    const scope = normalizedScope(input);
    const key = scopeKey(scope);
    const existing = activeFlushes.get(key);
    if (existing) return existing;
    const operation = flushOnce({ ...input, ...scope }).finally(() => {
      if (activeFlushes.get(key) === operation) activeFlushes.delete(key);
    });
    activeFlushes.set(key, operation);
    return operation;
  }

  async function flushAvailable(input = {}) {
    const maxBatches = boundedInteger(input.maxBatches, 10, 100);
    const totals = { sent: 0, committed: 0, retried: 0, rejected: 0, batches: 0 };
    const issues = [];
    let last = null;
    for (let index = 0; index < maxBatches; index += 1) {
      last = await flush(input);
      totals.batches += last.sent > 0 ? 1 : 0;
      totals.sent += last.sent;
      totals.committed += last.committed;
      totals.retried += last.retried;
      totals.rejected += last.rejected;
      issues.push(...(last.issues || []));
      if (!last.hasMore || last.sent === 0 || !last.ok) break;
    }
    return Object.freeze({
      ...totals,
      ok: totals.retried === 0 && totals.rejected === 0 && (last?.ok ?? true),
      offline: last?.offline === true,
      error: last?.error || null,
      hasMore: last?.hasMore ?? false,
      cursor: last?.cursor,
      issues: issues.slice(0, 100),
    });
  }

  return Object.freeze({
    batchSize: boundedBatchSize,
    queue,
    flush,
    flushAvailable,
  });
}
