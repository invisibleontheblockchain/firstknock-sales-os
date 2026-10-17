// FirstKnock's background route-optimization worker calls optimizeRouteRoadMatrix
// without a signed-in user. It proves it is FirstKnock's own worker acting for a
// route's owner with a short-lived HMAC over (owner, job, time), keyed from
// ROUTE_SEARCH_CONTINUATION_SECRET — the secret that already signs search
// continuations. The owner id also binds those continuations, as a user's would.

const MAX_AGE_MS = 15 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 1000;
const encoder = new TextEncoder();

async function sign(secret, text) {
    const key = await crypto.subtle.importKey('raw', encoder.encode(`route-optimization-worker:${secret}`),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(text)));
    return [...signature].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const usableSecret = secret => typeof secret === 'string' && secret.length >= 32;
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);

export async function signWorkerCredential(secret, { ownerUserId, jobId, now = Date.now() }) {
    if (!usableSecret(secret)) throw new Error('ROUTE_SEARCH_CONTINUATION_SECRET is not configured for the route worker.');
    if (!safeId(ownerUserId) || !safeId(jobId)) throw new Error('Route worker credential needs an owner and a job.');
    const issuedAt = Math.floor(now);
    return { owner_user_id: ownerUserId, job_id: jobId, issued_at: issuedAt,
        signature: await sign(secret, `${ownerUserId}|${jobId}|${issuedAt}`) };
}

/** The acting user ({ id, worker_job_id }) for a valid credential, else null. */
export async function verifyWorkerCredential(secret, credential, { now = Date.now() } = {}) {
    if (!usableSecret(secret) || !credential || typeof credential !== 'object') return null;
    const { owner_user_id: ownerUserId, job_id: jobId, issued_at: issuedAt, signature } = credential;
    if (!safeId(ownerUserId) || !safeId(jobId) || !Number.isSafeInteger(issuedAt) || typeof signature !== 'string') return null;
    if (issuedAt > now + MAX_CLOCK_SKEW_MS || now - issuedAt > MAX_AGE_MS) return null;
    const expected = await sign(secret, `${ownerUserId}|${jobId}|${issuedAt}`);
    if (expected.length !== signature.length) return null;
    let difference = 0;
    for (let i = 0; i < expected.length; i += 1) difference |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    return difference === 0 ? { id: ownerUserId, worker_job_id: jobId } : null;
}
