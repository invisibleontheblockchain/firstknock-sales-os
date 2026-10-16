// Backend-only receipts for one bounded Optimize action. A receipt may restore
// previously checked search state; it never replaces fresh whole-route proof.
export const ROAD_SEARCH_CONTINUATION_TTL_MS = 300000;
export const MAX_ROAD_SEARCH_CONTINUATION_CHARS = 262144;
export const MAX_ROAD_SEARCH_CONTINUATION_BYTES = 2 * 1024 * 1024;
const PURPOSE = 'firstknock-road-search-continuation';
const PREFIX = 'rsc1';
const COMPRESSED_PREFIX = 'rsc1z';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function canonicalString(value, maxChars = 2 * 1024 * 1024) {
    const chunks = [], ancestors = new Set();
    let chars = 0, nodes = 0;
    const append = text => {
        chars += text.length;
        if (chars > maxChars) throw new TypeError('Road search state is too large.');
        chunks.push(text);
    };
    const visit = (item, depth) => {
        if (++nodes > 100000 || depth > 32) throw new TypeError('Road search state is too complex.');
        if (item === undefined || item === null) { append('null'); return; }
        if (typeof item === 'string' || typeof item === 'boolean') { append(JSON.stringify(item)); return; }
        if (typeof item === 'number' && Number.isFinite(item)) { append(JSON.stringify(item)); return; }
        if (typeof item !== 'object') throw new TypeError('Road search state must contain only JSON values.');
        if (ancestors.has(item)) throw new TypeError('Road search state must not contain cycles.');
        const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
        // Accept ordinary JSON objects across realms, plus null-prototype maps.
        if (!array && (Object.prototype.toString.call(item) !== '[object Object]'
            || (prototype !== null && Object.getPrototypeOf(prototype) !== null))) {
            throw new TypeError('Road search state must contain only plain JSON objects.');
        }
        ancestors.add(item);
        if (array) {
            append('[');
            for (let index = 0; index < item.length; index++) {
                if (index) append(',');
                const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
                if (descriptor && !Object.hasOwn(descriptor, 'value')) throw new TypeError('Road search state cannot contain getters.');
                visit(descriptor?.value, depth + 1);
            }
            append(']');
        } else {
            append('{');
            const keys = Object.keys(item).sort();
            for (let index = 0; index < keys.length; index++) {
                if (index) append(',');
                const descriptor = Object.getOwnPropertyDescriptor(item, keys[index]);
                if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Road search state cannot contain getters.');
                append(JSON.stringify(keys[index])); append(':');
                visit(descriptor.value, depth + 1);
            }
            append('}');
        }
        ancestors.delete(item);
    };
    visit(value, 0);
    return chunks.join('');
}

export function stableCanonicalString(value) { return canonicalString(value); }

export async function sha256RoadSearch(value) {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(stableCanonicalString(value)));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function encodeBytes(bytes) {
    let binary = '';
    for (let start = 0; start < bytes.length; start += 8192) {
        binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    }
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBytes(text) {
    if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) throw new TypeError('Invalid continuation encoding.');
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - text.length % 4) % 4));
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    if (encodeBytes(bytes) !== text) throw new TypeError('Noncanonical continuation encoding.');
    return bytes;
}

async function transformBytes(bytes, stream, limit) {
    const reader = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } })
        .pipeThrough(stream).getReader();
    const chunks = [];
    let length = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > limit) throw new TypeError('Road search continuation exceeds its decoded limit.');
            chunks.push(value);
        }
    } catch (error) { await reader.cancel(error).catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
}

const validBinding = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit
    && !/[\u0000-\u001f\u007f]/.test(value);
const timestamp = now => {
    const value = now();
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

export function createRoadSearchContinuationCodec({ secret, appId, userId, provider, optimizerVersion, now = Date.now } = {}) {
    const binding = { appId, userId, provider, optimizerVersion };
    const enabled = typeof secret === 'string' && secret.length >= 32 && secret.length <= 4096
        && validBinding(appId, 256) && validBinding(userId, 256) && validBinding(provider, 2048)
        && validBinding(optimizerVersion, 256) && typeof now === 'function';
    const verified = new WeakMap();
    let keyPromise;
    const key = () => keyPromise ||= crypto.subtle.importKey('raw', encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    const begin = () => {
        try {
            if (!enabled) return null;
            const issuedAt = timestamp(now), expiresAt = issuedAt + ROAD_SEARCH_CONTINUATION_TTL_MS;
            if (issuedAt === null || !Number.isSafeInteger(expiresAt)) return null;
            const lifetime = Object.freeze({ issuedAt, expiresAt,
                actionId: encodeBytes(crypto.getRandomValues(new Uint8Array(16))) });
            verified.set(lifetime, lifetime);
            return lifetime;
        } catch { return null; }
    };
    return Object.freeze({
        begin,
        async open(token, inputFingerprint) {
            try {
                if (!enabled || !validBinding(inputFingerprint, 256) || typeof token !== 'string'
                    || token.length > MAX_ROAD_SEARCH_CONTINUATION_CHARS) return null;
                const parts = token.split('.');
                if (parts.length !== 3 || ![PREFIX, COMPRESSED_PREFIX].includes(parts[0]) || parts[2].length !== 43) return null;
                const signature = decodeBytes(parts[2]);
                if (signature.length !== 32 || !await crypto.subtle.verify('HMAC', await key(), signature,
                    encoder.encode(`${parts[0]}.${parts[1]}`))) return null;
                // Verify the MAC before processing compressed bytes, then cap
                // streamed output so even a signed expansion cannot exhaust RAM.
                const encodedBytes = decodeBytes(parts[1]);
                const bytes = parts[0] === COMPRESSED_PREFIX
                    ? await transformBytes(encodedBytes, new DecompressionStream('gzip'), MAX_ROAD_SEARCH_CONTINUATION_BYTES)
                    : encodedBytes;
                const text = decoder.decode(bytes);
                const payload = JSON.parse(text);
                if (canonicalString(payload, MAX_ROAD_SEARCH_CONTINUATION_BYTES) !== text
                    || payload?.purpose !== PURPOSE || payload?.version !== 1
                    || payload?.inputFingerprint !== inputFingerprint
                    || Object.keys(payload).sort().join(',') !== 'actionId,binding,expiresAt,inputFingerprint,issuedAt,purpose,state,version'
                    || Object.keys(payload.binding || {}).sort().join(',') !== 'appId,optimizerVersion,provider,userId'
                    || Object.entries(binding).some(([name, value]) => payload.binding[name] !== value)) return null;
                const current = timestamp(now), { issuedAt, expiresAt, actionId } = payload;
                if (current === null || !Number.isSafeInteger(issuedAt) || issuedAt < 0 || !Number.isSafeInteger(expiresAt)
                    || expiresAt - issuedAt !== ROAD_SEARCH_CONTINUATION_TTL_MS
                    || current < issuedAt || current >= expiresAt || typeof actionId !== 'string'
                    || actionId.length !== 22 || decodeBytes(actionId).length !== 16) return null;
                const opened = Object.freeze({ state: payload.state, issuedAt, expiresAt, actionId });
                verified.set(opened, { issuedAt, expiresAt, actionId });
                return opened;
            } catch { return null; }
        },
        async seal(state, inputFingerprint, opened) {
            try {
                if (!enabled || !validBinding(inputFingerprint, 256)) return null;
                const current = timestamp(now);
                if (current === null) return null;
                // begin() runs before expensive optimization. Only a handle
                // started or verified by this instance can carry that lifetime.
                const lifetime = opened == null ? begin() : verified.get(opened);
                if (!lifetime || !Number.isSafeInteger(lifetime.expiresAt)
                    || current < lifetime.issuedAt || current >= lifetime.expiresAt) return null;
                const text = canonicalString({ purpose: PURPOSE, version: 1, binding, inputFingerprint, ...lifetime, state },
                    MAX_ROAD_SEARCH_CONTINUATION_BYTES);
                const bytes = encoder.encode(text);
                if (bytes.length > MAX_ROAD_SEARCH_CONTINUATION_BYTES) return null;
                let prefix = PREFIX, encoded = encodeBytes(bytes);
                if (prefix.length + encoded.length + 45 > MAX_ROAD_SEARCH_CONTINUATION_CHARS) {
                    prefix = COMPRESSED_PREFIX;
                    encoded = encodeBytes(await transformBytes(bytes, new CompressionStream('gzip'),
                        Math.floor((MAX_ROAD_SEARCH_CONTINUATION_CHARS - prefix.length - 45) * 3 / 4)));
                }
                if (prefix.length + encoded.length + 45 > MAX_ROAD_SEARCH_CONTINUATION_CHARS) return null;
                const signed = `${prefix}.${encoded}`;
                const signature = await crypto.subtle.sign('HMAC', await key(), encoder.encode(signed));
                return `${signed}.${encodeBytes(new Uint8Array(signature))}`;
            } catch { return null; }
        },
    });
}
