import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchOsrmJson, resetOsrmCounters, osrmCounters } from '../base44/shared/osrmDispatcher.js';

const okPayload = { code: 'Ok', distances: [[0, 1], [1, 0]] };

test('OSRM requests identify FirstKnock and retry a temporary 403 refusal', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    resetOsrmCounters();
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return calls.length === 1
            ? new Response('temporarily refused', { status: 403 })
            : Response.json(okPayload);
    };

    try {
        const result = await fetchOsrmJson('https://router.example/table', { timeoutMs: 1000 });
        assert.deepEqual(result, okPayload);
        assert.equal(calls.length, 2);
        assert.equal(calls[0].options.headers['Accept'], 'application/json');
        assert.equal(calls[0].options.headers['User-Agent'], 'FirstKnock-Routing/1.0');
        assert.equal(osrmCounters().rateLimited, 1);
        assert.equal(osrmCounters().retries, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});