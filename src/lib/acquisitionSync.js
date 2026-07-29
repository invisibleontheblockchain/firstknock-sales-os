import {
  markStoredAcquisitionSynced,
  shouldSyncStoredAcquisition,
} from './acquisitionTracking.js';

export const ACQUISITION_SYNC_MAX_ATTEMPTS = 3;
export const ACQUISITION_SYNC_RETRY_DELAY_MS = 500;

function errorStatus(error) {
  return Number(
    error?.response?.status
      || error?.response?.statusCode
      || error?.status
      || error?.statusCode
      || 0,
  );
}

function retryableError(error) {
  const status = errorStatus(error);
  return !status
    || status === 408
    || status === 409
    || status === 429
    || status >= 500;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function syncAcquisitionAttribution({
  invoke,
  userId,
  stored,
  identity,
  storage = globalThis.localStorage,
  shouldCancel = () => false,
  sleep = delay,
  maxAttempts = ACQUISITION_SYNC_MAX_ATTEMPTS,
  retryDelayMs = ACQUISITION_SYNC_RETRY_DELAY_MS,
  onRetry = () => {},
} = {}) {
  if (typeof invoke !== 'function') {
    throw new TypeError('An attribution sync invoker is required.');
  }
  const normalizedUserId = String(userId || '').trim();
  if (
    !normalizedUserId
    || !shouldSyncStoredAcquisition(stored, normalizedUserId)
  ) {
    return { status: 'skipped', attempts: 0 };
  }

  const attemptsLimit = Math.max(
    1,
    Math.min(ACQUISITION_SYNC_MAX_ATTEMPTS, Math.trunc(Number(maxAttempts) || 1)),
  );
  const payload = {
    first_touch: stored.first_touch,
    last_touch: stored.last_touch || stored.first_touch,
    anonymous_id: identity?.anonymous_id,
    session_id: identity?.session_id,
  };

  for (let attempt = 1; attempt <= attemptsLimit; attempt += 1) {
    if (shouldCancel()) return { status: 'canceled', attempts: attempt - 1 };
    try {
      await invoke('captureAcquisitionAttribution', payload);
      if (shouldCancel()) return { status: 'canceled', attempts: attempt };
      markStoredAcquisitionSynced(normalizedUserId, storage);
      return { status: 'synced', attempts: attempt };
    } catch (error) {
      if (attempt >= attemptsLimit || !retryableError(error)) throw error;
      onRetry(error, attempt);
      await sleep(retryDelayMs * (2 ** (attempt - 1)));
    }
  }
  return { status: 'canceled', attempts: attemptsLimit };
}
