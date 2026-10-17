// One process-wide gate in front of OSRM.
//
// Every OSRM request in the codebase goes through `dispatchOsrm`, so one cap
// applies across every level of the road hierarchy instead of each level
// independently allowing its own burst.
//
// The engine is FirstKnock's private gateway (OSRM_BASE_URL + OSRM_GATEWAY_KEY),
// not the public demo. It is sized for this lane, so the defaults are 16 in
// flight with no artificial spacing; both stay configurable for an operator who
// needs to throttle. The gateway says when it is busy (429/503 + Retry-After)
// and the dispatcher waits exactly that long before the one retry it allows.
// A 400/401/403 is a definitive answer — a malformed request, a missing key, a
// refused key — and is never retried.
//
// Every call carries ONE end-to-end deadline that covers the queue wait, retry
// sleeps, the fetch and the body read. A slow body can no longer outlive its
// timeout, and a cancelled optimization stops spending engine capacity.

const DEFAULT_MAX_CONCURRENT_REQUESTS = 16;
const DEFAULT_DISPATCH_SPACING_MS = 0;
// Bounded retry. Beyond this the caller takes its labelled fallback rather than
// hammering a server that is already refusing work.
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;
// A Retry-After longer than this is treated as "not within this request".
const MAX_RETRY_AFTER_MS = 30000;

const settings = {
    maxConcurrent: DEFAULT_MAX_CONCURRENT_REQUESTS,
    spacingMs: DEFAULT_DISPATCH_SPACING_MS,
    gatewayOrigin: '',
    gatewayKey: ''
};

/** Thrown for a response the dispatcher considers worth retrying. */
class RetryableOsrmError extends Error {
    constructor(message, { status = null, retryAfterMs = null } = {}) {
        super(message);
        this.name = 'RetryableOsrmError';
        this.retryable = true;
        this.status = status;
        this.retryAfterMs = retryAfterMs;
    }
}

function timeoutError(timeoutMs) {
    const error = new Error(`OSRM request exceeded its ${timeoutMs} ms deadline.`);
    error.name = 'TimeoutError';
    error.code = 'OSRM_DEADLINE';
    return error;
}

function abortReason(signal) {
    if (signal.reason instanceof Error) return signal.reason;
    const error = new Error('OSRM request was cancelled.');
    error.name = 'AbortError';
    return error;
}

/** Resolve after `ms`, or reject the moment `signal` aborts. */
function abortableSleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(abortReason(signal));
        const onAbort = () => { clearTimeout(timer); reject(abortReason(signal)); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/** Race a promise against `signal`, so work that ignores the signal still stops the caller. */
function untilAborted(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(abortReason(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
            (error) => { signal.removeEventListener('abort', onAbort); reject(error); }
        );
    });
}

/** Retry-After as delay-seconds or an HTTP date, in milliseconds; null when absent. */
export function parseRetryAfterMs(value, now = Date.now()) {
    if (value == null || value === '') return null;
    const text = String(value).trim();
    if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
    const at = Date.parse(text);
    return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

const queue = [];
let inFlight = 0;
let lastDispatchAt = 0;
// The graph build that last answered, from the gateway's X-Road-Build header.
// Not reset with the counters: it describes the engine, not one optimization.
let lastRoadBuildId = null;

// What the road-awareness actually costs, so an optimization can report its own
// bill instead of it being guessed at. Counted here because this is the only
// place OSRM is reached from. Stage times say where a slow request spent it.
const counters = {
    requests: 0, retries: 0, rateLimited: 0, transportFailures: 0, timeouts: 0, cancelled: 0,
    rejected: 0, peakInFlight: 0, queuedMs: 0, headersMs: 0, bodyMs: 0
};

function pump() {
    while (inFlight < settings.maxConcurrent && queue.length) {
        const next = queue.shift();
        next.detach();
        inFlight += 1;
        if (inFlight > counters.peakInFlight) counters.peakInFlight = inFlight;
        const wait = Math.max(0, lastDispatchAt + settings.spacingMs - Date.now());
        lastDispatchAt = Date.now() + wait;
        abortableSleep(wait, next.signal)
            .then(() => {
                counters.queuedMs += Date.now() - next.enqueuedAt;
                return next.run();
            })
            .then(next.resolve, next.reject)
            .finally(() => {
                inFlight -= 1;
                pump();
            });
    }
}

/**
 * Run one OSRM request under the global cap.
 *
 * `run` must return a promise. Throw `RetryableOsrmError` from inside it (or use
 * `fetchOsrmJson`, which does) to opt a failure into backoff-and-retry. When
 * `signal` aborts while the request is still queued, it leaves the queue without
 * ever reaching the engine.
 */
export function dispatchOsrm(run, { signal = null } = {}) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(abortReason(signal));
        const entry = { run, resolve, reject, signal, enqueuedAt: Date.now(), detach: () => {} };
        if (signal) {
            const onAbort = () => {
                const index = queue.indexOf(entry);
                if (index >= 0) queue.splice(index, 1);
                reject(abortReason(signal));
            };
            signal.addEventListener('abort', onAbort, { once: true });
            entry.detach = () => signal.removeEventListener('abort', onAbort);
        }
        queue.push(entry);
        pump();
    });
}

/**
 * Configure the process-wide gateway. Only requests to `baseUrl`'s origin carry
 * the key, so a test server or any other host can never receive it.
 */
export function configureOsrmDispatcher({ maxConcurrent, spacingMs, baseUrl, gatewayKey } = {}) {
    if (maxConcurrent !== undefined) {
        const value = Math.floor(Number(maxConcurrent));
        settings.maxConcurrent = Number.isFinite(value) && value >= 1 ? Math.min(value, 64) : DEFAULT_MAX_CONCURRENT_REQUESTS;
    }
    if (spacingMs !== undefined) {
        const value = Number(spacingMs);
        settings.spacingMs = Number.isFinite(value) && value >= 0 ? Math.min(value, 5000) : DEFAULT_DISPATCH_SPACING_MS;
    }
    if (baseUrl !== undefined) {
        try { settings.gatewayOrigin = baseUrl ? new URL(baseUrl).origin : ''; } catch { settings.gatewayOrigin = ''; }
    }
    if (gatewayKey !== undefined) settings.gatewayKey = String(gatewayKey || '').trim();
    pump();
}

function authorizationFor(url) {
    if (!settings.gatewayKey || !settings.gatewayOrigin) return null;
    try { return new URL(url).origin === settings.gatewayOrigin ? `Bearer ${settings.gatewayKey}` : null; }
    catch { return null; }
}

/**
 * Fetch and parse one OSRM JSON response through the dispatcher.
 *
 * `timeoutMs` is the END-TO-END budget for this call: queue wait, every attempt,
 * every retry sleep and the body read all share it. `signal` cancels the call
 * from outside (an abandoned optimization).
 *
 * Transport failures and 5xx are retried with backoff. 429 and 503 are retried
 * only after waiting the server's Retry-After, and not at all when that wait
 * would outlive the deadline. 400/401/403 and any other 4xx fail immediately.
 * An OSRM payload whose `code` is not `Ok` is a definitive answer about the
 * coordinates, so it is not retried either.
 */
export async function fetchOsrmJson(url, { timeoutMs = 20000, signal = null } = {}) {
    const controller = new AbortController();
    const deadlineAt = Date.now() + timeoutMs;
    const timer = setTimeout(() => controller.abort(timeoutError(timeoutMs)), timeoutMs);
    const onExternalAbort = () => controller.abort(abortReason(signal));
    if (signal?.aborted) onExternalAbort();
    else signal?.addEventListener('abort', onExternalAbort, { once: true });
    const deadline = controller.signal;

    try {
        let lastError = null;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
            try {
                return await dispatchOsrm(() => attemptOnce(url, deadline), { signal: deadline });
            } catch (error) {
                lastError = deadline.aborted ? abortReason(deadline) : error;
                if (deadline.aborted) {
                    if (lastError.code === 'OSRM_DEADLINE') counters.timeouts += 1;
                    else counters.cancelled += 1;
                    throw lastError;
                }
                if (!error?.retryable || attempt === MAX_ATTEMPTS) throw error;
                const backoff = RETRY_BASE_DELAY_MS * attempt;
                const wait = error.retryAfterMs != null ? Math.max(error.retryAfterMs, 0) : backoff;
                if (wait > MAX_RETRY_AFTER_MS || Date.now() + wait >= deadlineAt) throw error;
                counters.retries += 1;
                await abortableSleep(wait, deadline);
            }
        }
        throw lastError;
    } catch (error) {
        if (deadline.aborted) throw abortReason(deadline);
        throw error;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onExternalAbort);
    }
}

async function attemptOnce(url, deadline) {
    counters.requests += 1;
    const headers = { 'Accept': 'application/json', 'User-Agent': 'FirstKnock-Routing/1.0' };
    const authorization = authorizationFor(url);
    if (authorization) headers['Authorization'] = authorization;

    const sentAt = Date.now();
    let response;
    try {
        response = await untilAborted(fetch(url, { signal: deadline, redirect: 'error', headers }), deadline);
    } catch (error) {
        if (deadline.aborted) throw abortReason(deadline);
        counters.transportFailures += 1;
        throw new RetryableOsrmError(`OSRM request failed: ${error.message}`);
    } finally {
        counters.headersMs += Date.now() - sentAt;
    }

    const build = response.headers?.get?.('x-road-build');
    if (build) lastRoadBuildId = build;

    const bodyStartedAt = Date.now();
    const readJson = () => untilAborted(response.json(), deadline);
    try {
        if (response.status === 429 || response.status === 503) {
            counters.rateLimited += 1;
            await response.body?.cancel?.().catch(() => {});
            throw new RetryableOsrmError(`OSRM request failed with status ${response.status}.`, {
                status: response.status,
                retryAfterMs: parseRetryAfterMs(response.headers?.get?.('retry-after'))
            });
        }
        if (response.status >= 500) {
            await response.body?.cancel?.().catch(() => {});
            throw new RetryableOsrmError(`OSRM request failed with status ${response.status}.`, { status: response.status });
        }
        if (!response.ok) {
            counters.rejected += 1;
            const payload = await readJson().catch((error) => {
                if (deadline.aborted) throw error;
                return null;
            });
            const error = new Error(`OSRM request failed with status ${response.status}${payload?.code ? ` (${payload.code})` : ''}. ${payload?.message || ''}`.trim());
            error.code = payload?.code;
            error.status = response.status;
            throw error;
        }
        const payload = await readJson();
        if (payload?.code !== 'Ok') {
            const error = new Error(`OSRM request rejected: ${payload?.code || 'unknown'}.`);
            error.code = payload?.code;
            throw error;
        }
        return payload;
    } finally {
        counters.bodyMs += Date.now() - bodyStartedAt;
    }
}

/** Test seam: current queue pressure, so a test can prove the cap is respected. */
export function osrmDispatcherState() {
    return { inFlight, queued: queue.length, maxConcurrent: settings.maxConcurrent, spacingMs: settings.spacingMs };
}

/** The X-Road-Build of the graph that last answered, or null before any answer. */
export function osrmRoadBuildId() {
    return lastRoadBuildId;
}

/**
 * Snapshot the request bill. Call `resetOsrmCounters()` at the start of one
 * optimization and read this at the end to report exactly what that route cost.
 */
export function osrmCounters() {
    return { ...counters, maxConcurrent: settings.maxConcurrent, roadBuildId: lastRoadBuildId };
}

export function resetOsrmCounters() {
    for (const key of Object.keys(counters)) counters[key] = 0;
}
