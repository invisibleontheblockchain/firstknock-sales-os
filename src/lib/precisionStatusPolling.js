// How the Precision import poll reacts when a status read fails.
//
// Before this, every failure (a lost connection, an expired sign-in, a job the
// server no longer has) showed "Connection interrupted — retrying automatically"
// and retried every 10 seconds for up to 30 minutes, then started again on the
// next visit. A failure that can never succeed now stops at once with its real
// reason; a passing outage backs off and pauses after a few minutes with a way
// to check again, instead of looping.
//
// Kept free of React and Base44 imports so it runs under node:test.

export const POLL_BASE_DELAY_MS = 5_000;
export const POLL_MAX_DELAY_MS = 60_000;
export const RATE_LIMITED_DELAY_MS = 30_000;
// A status endpoint that has failed for this long is not "interrupted"; stop
// and let the rep check again rather than polling into the background forever.
export const POLL_GIVE_UP_AFTER_MS = 5 * 60_000;

function errorStatus(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  return Number.isFinite(status) ? status : 0;
}

/** The server's own words for a failed status read, never a generic label. */
export function statusErrorMessage(error) {
  const data = error?.response?.data || error?.data || {};
  const text = [data.message, data.error, error?.message]
    .find(value => typeof value === 'string' && value.trim());
  return text ? text.trim().slice(0, 300) : 'No response from the import status service.';
}

/**
 * kind:
 *  - 'gone'         the job no longer exists or is not this account's: forget it.
 *  - 'auth'         the sign-in expired: stop, keep the job for after sign-in.
 *  - 'rate_limited' the platform asked us to slow down.
 *  - 'transient'    anything else (network, 5xx, timeouts): back off and retry.
 */
export function classifyStatusPollError(error) {
  const status = errorStatus(error);
  const message = statusErrorMessage(error);
  if (status === 429 || /traffic volume|rate limit/i.test(message)) return { kind: 'rate_limited', status, message };
  if (status === 401) return { kind: 'auth', status, message };
  if (status === 403 || status === 404 || status === 400) return { kind: 'gone', status, message };
  return { kind: 'transient', status, message };
}

/** Delay before the next read after `failures` consecutive failed reads. */
export function nextPollDelayMs(failures, { rateLimited = false } = {}) {
  if (rateLimited) return RATE_LIMITED_DELAY_MS;
  const count = Math.max(1, Math.floor(Number(failures) || 1));
  return Math.min(POLL_MAX_DELAY_MS, POLL_BASE_DELAY_MS * 2 ** count);
}

/** True once failures have gone on long enough that polling should pause. */
export function shouldPausePolling(firstFailureAt, now = Date.now(), giveUpAfterMs = POLL_GIVE_UP_AFTER_MS) {
  const started = Number(firstFailureAt);
  return Number.isFinite(started) && started > 0 && now - started >= giveUpAfterMs;
}

/** What the progress panel says while it is still retrying. */
export function retryingStatusText(classification, failures) {
  if (classification?.kind === 'rate_limited') return 'Service is busy — checking again shortly';
  const attempt = Math.max(1, Math.floor(Number(failures) || 1));
  return attempt === 1
    ? 'Import status did not answer — checking again'
    : `Import status did not answer (${attempt} tries) — checking again`;
}
