// Apply only to reads: retrying a write can create duplicate records.
export function isTransientReadError(error) {
    const status = Number(error?.status || error?.response?.status || 0);
    return !status || status === 408 || status === 429 || status >= 500;
}

export function shouldRetryRead(failureCount, error) {
    return failureCount < 2 && isTransientReadError(error);
}

export function readRetryDelay(attempt) {
    // Jitter keeps simultaneous rep logins from retrying in lockstep.
    return Math.min(1000 * 2 ** attempt, 8000) + Math.floor(Math.random() * 500);
}

export async function withReadDeadline(read, timeoutMs = 15_000) {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(read),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const error = new Error('Loading took too long. Please try again.');
                    error.code = 'READ_TIMEOUT';
                    error.status = 408;
                    reject(error);
                }, timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

export async function retryRead(read, {
    retries = 2,
    timeoutMs = 15_000,
    delay = readRetryDelay,
    wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return await withReadDeadline(read, timeoutMs);
        } catch (error) {
            if (attempt >= retries || !isTransientReadError(error)) throw error;
            await wait(delay(attempt));
        }
    }
}
