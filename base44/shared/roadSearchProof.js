import { roadSearchWindowDescriptor } from './roadSearchCoverage.js';
import { isValidRoutePoint } from './routeBounds.js';
import { trustedAccess } from './streetSideRouting.js';

// These are authenticated, short-lived observations from one optimization, not
// a claim that an unversioned provider graph is immutable. The endpoint owns
// signature/user/action/expiry validation and the fresh full-route witness.
export const ROAD_SEARCH_PROOF_VERSION = 1;
export const MAX_ROAD_SEARCH_PROOF_STOPS = 2500;
export const MAX_ROAD_SEARCH_PROOF_RECEIPTS = 8192;
export const MAX_ROAD_SEARCH_PROOF_BYTES = 2 * 1024 * 1024;
const proofs = new WeakSet();
const identity = stop => String(stop?.address_hash || stop?.legacy_hash || stop?.id || '');
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 1024;
const validReceipt = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validScope = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function canonical(value, seen = new Set(), depth = 0) {
    if (depth > 20) throw new Error('Road search proof value is too deeply nested.');
    if (value === undefined || value === null) return null;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('Road search proof requires finite numbers.');
        return value;
    }
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if ((!Array.isArray(value) && !plain(value)) || seen.has(value)) throw new Error('Road search proof requires plain JSON values.');
    seen.add(value);
    const result = Array.isArray(value) ? value.map(item => canonical(item, seen, depth + 1))
        : Object.fromEntries(Object.keys(value).sort().filter(key => typeof value[key] !== 'function')
            .map(key => [key, canonical(value[key], seen, depth + 1)]));
    seen.delete(value);
    return result;
}

export function validateRoadSearchProofSnapshot(value) {
    try {
        if (!plain(value) || Object.keys(value).some(key => !['version', 'providerIdentity', 'policyVersion',
            'inferredAccess', 'discovered', 'receipts'].includes(key))
            || value.version !== ROAD_SEARCH_PROOF_VERSION || !validScope(value.providerIdentity) || !validScope(value.policyVersion)
            || !Array.isArray(value.inferredAccess) || value.inferredAccess.length > MAX_ROAD_SEARCH_PROOF_STOPS
            || !Array.isArray(value.discovered) || value.discovered.length > MAX_ROAD_SEARCH_PROOF_STOPS
            || !value.discovered.every(validId) || new Set(value.discovered).size !== value.discovered.length
            || !Array.isArray(value.receipts) || value.receipts.length > MAX_ROAD_SEARCH_PROOF_RECEIPTS
            || !value.receipts.every(validReceipt) || new Set(value.receipts).size !== value.receipts.length) return null;
        const inferredIds = new Set();
        for (const item of value.inferredAccess) {
            if (!Array.isArray(item) || item.length !== 2 || !validId(item[0]) || inferredIds.has(item[0])) return null;
            const access = item[1];
            if (!plain(access) || !trustedAccess(access) || !isValidRoutePoint(access.point)
                || !Number.isFinite(access.serviceBearing) || access.serviceBearing < 0 || access.serviceBearing >= 360
                || !['osrm-named-road-side', 'osrm-unnamed-road-side'].includes(access.source)) return null;
            inferredIds.add(item[0]);
        }
        if (new Set([...inferredIds, ...value.discovered]).size > MAX_ROAD_SEARCH_PROOF_STOPS) return null;
        const serialized = JSON.stringify(canonical(value));
        if (new TextEncoder().encode(serialized).length > MAX_ROAD_SEARCH_PROOF_BYTES) return null;
        return JSON.parse(serialized);
    } catch { return null; }
}

export function isRoadSearchProof(value) {
    return Boolean(value && proofs.has(value));
}

export function createRoadSearchProof(snapshot = null, { providerIdentity, policyVersion } = {}) {
    if (!validScope(providerIdentity) || !validScope(policyVersion)) throw new Error('Road search proof requires its provider and policy scope.');
    const restored = snapshot == null ? null : validateRoadSearchProofSnapshot(snapshot);
    if (snapshot != null && (!restored || restored.providerIdentity !== providerIdentity || restored.policyVersion !== policyVersion)) {
        throw new Error('Road search proof snapshot is invalid or belongs to a different scope.');
    }
    const inferredAccess = new Map(restored?.inferredAccess || []);
    const discovered = new Set(restored?.discovered || []);
    const receipts = new Set(restored?.receipts || []);
    const proof = {
        inferredAccess, discovered,
        async key(order, window, options = {}) {
            const descriptor = roadSearchWindowDescriptor(order, window, options, policyVersion);
            const section = order.slice(Math.max(0, window.start - 2), window.end + 2);
            const encoded = new TextEncoder().encode(JSON.stringify(canonical({ version: ROAD_SEARCH_PROOF_VERSION,
                providerIdentity, policyVersion, question: descriptor,
                // Candidate defaults are bound by policyVersion; explicit
                // settings and effective access remain part of each question.
                servicePolicy: options.servicePolicy || null,
                shortDrivingCleanup: options.shortDrivingCleanup === true,
                examined: section.map(stop => [identity(stop), discovered.has(identity(stop))]),
            })));
            const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded);
            return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
        },
        has(key) { return receipts.has(key); },
        complete(key) {
            if (validReceipt(key) && receipts.size < MAX_ROAD_SEARCH_PROOF_RECEIPTS) receipts.add(key);
        },
        prune(keys) {
            const eligible = new Set(keys);
            for (const key of receipts) if (!eligible.has(key)) receipts.delete(key);
        },
        exportSnapshot() {
            const snapshot = validateRoadSearchProofSnapshot({ version: ROAD_SEARCH_PROOF_VERSION, providerIdentity, policyVersion,
                inferredAccess: [...inferredAccess].sort(([a], [b]) => a.localeCompare(b)),
                discovered: [...discovered].sort(), receipts: [...receipts].sort() });
            if (!snapshot) throw new Error('Road search proof exceeded its bounded snapshot contract.');
            return snapshot;
        },
    };
    proofs.add(proof);
    return Object.freeze(proof);
}
