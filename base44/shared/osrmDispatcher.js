// One process-wide gate in front of OSRM.
//
// Until now the only concurrency control was a batching loop inside
// `fetchRoadMatrix`: four table blocks at a time, for ONE matrix. The two-level
// road-aware hierarchy breaks that assumption — a 1,000-door route fetches the
// top-level cluster matrix, then a second bounded matrix per cluster, then the
// final route geometry. Each of those respecting "four at a time" on its own
// means dozens of simultaneous requests to a public demo server, which is how a
// rate limit turns into a route that silently falls back.
//
// So every OSRM request in the codebase goes through `dispatchOsrm`. The cap is
// global, the spacing is enforced between dispatches, and a 429/5xx is retried
// with backoff a bounded number of times before it is allowed to fail the caller.

// Requests in flight at once, across every level of the hierarchy.
const MAX_CONCURRENT_REQUESTS = 2;
// Minimum gap between two dispatches. The public server tolerates steady
// throughput far better than bursts.
const MIN_DISPATCH_SPACING_MS = 150;
// Bounded retry. Beyond this the caller takes its labelled fallback rather than
// hammering a server that is already refusing work.
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Thrown for a response the dispatcher considers worth retrying. */
class RetryableOsrmError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RetryableOsrmError';
        this.retryable = true;
    }
}

const queue = [];
let inFlight = 0;
let lastDispatchAt = 0;

// What the road-awareness actually costs, so an optimization can report its own
// bill instead of it being guessed at. Counted here because this is the only
// place OSRM is reached from.
const counters = { requests: 0, retries: 0, rateLimited: 0, transportFailures: 0, peakInFlight: 0 };

function pump() {
    if (inFlight >= MAX_CONCURRENT_REQUESTS) return;
    const next = queue.shift();
    if (!next) return;

    inFlight += 1;
    counters.requests += 1;
    if (inFlight > counters.peakInFlight) counters.peakInFlight = inFlight;
    const wait = Math.max(0, lastDispatchAt + MIN_DISPATCH_SPACING_MS - Date.now());
    lastDispatchAt = Date.now() + wait;
    sleep(wait)
        .then(next.run)
        .then(next.resolve, next.reject)
        .finally(() => {
            inFlight -= 1;
            pump();
        });
}

/**
 * Run one OSRM request under the global cap.
 *
 * `run` must return a promise. Throw `RetryableOsrmError` from inside it (or use
 * `fetchOsrmJson`, which does) to opt a failure into backoff-and-retry.
 */
export function dispatchOsrm(run) {
    return new Promise((resolve, reject) => {
        queue.push({ run, resolve, reject });
        pump();
    });
}

/**
 * Fetch and parse one OSRM JSON response through the dispatcher.
 *
 * Transport failures, 429 and 5xx are retried with backoff; a 4xx other than 429
 * is a request we built wrong, so it fails immediately rather than being retried
 * three times. An OSRM payload whose `code` is not `Ok` is a definitive answer
 * about the coordinates, not a transport problem, so it is not retried either.
 */
export async function fetchOsrmJson(url, { timeoutMs = 20000 } = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
            return await dispatchOsrm(async () => {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), timeoutMs);
                let response;
                try {
                    response = await fetch(url, {
                        signal: controller.signal,
                        headers: {
                            'Accept': 'application/json',
                            'User-Agent': 'FirstKnock-Routing/1.0'
                        }
                    });
                } catch (error) {
                    // Abort or network failure — worth another attempt.
                    throw new RetryableOsrmError(`OSRM request failed: ${error.message}`);
                } finally {
                    clearTimeout(timer);
                }
                if (response.status === 403 || response.status === 429 || response.status >= 500) {
                    if (response.status === 403 || response.status === 429) counters.rateLimited += 1;
                    throw new RetryableOsrmError(`OSRM request failed with status ${response.status}.`);
                }
                if (!response.ok) {
                    throw new Error(`OSRM request failed with status ${response.status}.`);
                }
                const payload = await response.json();
                if (payload?.code !== 'Ok') {
                    throw new Error(`OSRM request rejected: ${payload?.code || 'unknown'}.`);
                }
                return payload;
            });
        } catch (error) {
            lastError = error;
            if (!error?.retryable || attempt === MAX_ATTEMPTS) throw error;
            counters.retries += 1;
            await sleep(RETRY_BASE_DELAY_MS * attempt);
        }
    }
    throw lastError;
}

/** Test seam: current queue pressure, so a test can prove the cap is respected. */
export function osrmDispatcherState() {
    return { inFlight, queued: queue.length, maxConcurrent: MAX_CONCURRENT_REQUESTS };
}

/**
 * Snapshot the request bill. Call `resetOsrmCounters()` at the start of one
 * optimization and read this at the end to report exactly what that route cost.
 */
export function osrmCounters() {
    return { ...counters, maxConcurrent: MAX_CONCURRENT_REQUESTS };
}

export function resetOsrmCounters() {
    counters.requests = 0;
    counters.retries = 0;
    counters.rateLimited = 0;
    counters.transportFailures = 0;
    counters.peakInFlight = 0;
}