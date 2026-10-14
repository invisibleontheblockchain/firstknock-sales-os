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

test('unmatched road pins preserve the provider code and coordinate index without retrying', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
        calls++;
        return Response.json({ code: 'NoSegment', message: 'Could not find a matching segment for coordinate 12' }, { status: 400 });
    };
    try {
        await assert.rejects(fetchOsrmJson('https://router.example/table', { timeoutMs: 1000 }), error => {
            assert.equal(error.code, 'NoSegment'); assert.match(error.message, /coordinate 12/); return true;
        });
        assert.equal(calls, 1);
    } finally { globalThis.fetch = originalFetch; }
});
