// One optimization owns this cache. The complete URL includes road profile,
// order, access points, bearings, radiuses and annotations. No cross-run reuse.
export function createOsrmRequestCache(fetchJson, { maxEntries = 32, maxBytes = 4 * 1024 * 1024 } = {}) {
    const ready = new Map(), pending = new Map();
    const versions = new Map();
    let bytes = 0;
    const counters = { requests: 0, hits: 0, coalesced: 0, skippedLargeResponses: 0 };
    return {
        async fetchJson(url, options = {}) {
            const key = `${options.timeoutMs ?? 20000}|${String(url)}`;
            const cached = ready.get(key);
            if (cached) {
                counters.hits++;
                ready.delete(key); ready.set(key, cached);
                return JSON.parse(cached.text);
            }
            let request = pending.get(key);
            if (request) counters.coalesced++;
            else {
                counters.requests++;
                request = Promise.resolve().then(() => fetchJson(url, options)).then(payload => {
                    if (payload?.code !== 'Ok') throw new Error('Road provider returned an unsuccessful response.');
                    const parsed = new URL(String(url));
                    const engine = parsed.origin + (parsed.pathname.match(/^(.*)\/(?:table|route|nearest)\/v1\/([^/]+)\//)?.slice(1).join('|') || parsed.pathname);
                    if (payload.data_version) {
                        if (versions.has(engine) && versions.get(engine) !== payload.data_version) {
                            throw new Error('Road provider graph identity changed during optimization.');
                        }
                        versions.set(engine, payload.data_version);
                    }
                    const text = JSON.stringify(payload), size = new TextEncoder().encode(text).length;
                    if (size <= maxBytes && maxEntries > 0) {
                        while (ready.size >= maxEntries || bytes + size > maxBytes) {
                            const oldest = ready.keys().next().value;
                            bytes -= ready.get(oldest).bytes; ready.delete(oldest);
                        }
                        ready.set(key, { text, bytes: size }); bytes += size;
                    } else counters.skippedLargeResponses++;
                    return text;
                }).finally(() => pending.delete(key));
                pending.set(key, request);
            }
            // Consumers receive independent data; mutation cannot poison reuse.
            return JSON.parse(await request);
        },
        stats: () => ({ ...counters, entries: ready.size, bytes, pending: pending.size }),
    };
}
