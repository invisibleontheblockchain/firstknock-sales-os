import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    configureOsrmDispatcher,
    describeRoadFailure,
    fetchOsrmJson,
    osrmCounters,
    osrmDispatcherState,
    osrmRoadBuildId,
    parseRetryAfterMs,
    resetOsrmCounters
} from '../base44/shared/osrmDispatcher.js';
import { readOsrmProvider } from '../base44/shared/osrmProvider.js';

const okPayload = { code: 'Ok', distances: [[0, 1], [1, 0]] };
const GATEWAY = 'https://gateway.example';
const originalFetch = globalThis.fetch;

function stubFetch(handler) {
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url: String(url), options, at: Date.now() });
        return handler(calls.length, url, options);
    };
    return calls;
}

afterEach(() => {
    globalThis.fetch = originalFetch;
    configureOsrmDispatcher({ maxConcurrent: 16, spacingMs: 0, baseUrl: '', gatewayKey: '' });
    resetOsrmCounters();
});

test('defaults are 16 in flight with no spacing, and both are configurable', () => {
    assert.equal(osrmDispatcherState().maxConcurrent, 16);
    assert.equal(osrmDispatcherState().spacingMs, 0);
    readOsrmProvider(name => ({ OSRM_BASE_URL: GATEWAY, OSRM_MAX_CONCURRENCY: '4', OSRM_DISPATCH_SPACING_MS: '25' })[name]);
    assert.equal(osrmDispatcherState().maxConcurrent, 4);
    assert.equal(osrmDispatcherState().spacingMs, 25);
});

test('the gateway key is sent as a bearer token to the gateway origin only', async () => {
    const provider = readOsrmProvider(name => ({ OSRM_BASE_URL: GATEWAY, OSRM_GATEWAY_KEY: 'fk-test-key' })[name]);
    assert.equal(provider.baseUrl, GATEWAY);
    const calls = stubFetch(() => Response.json(okPayload, { headers: { 'X-Road-Build': 'us-car-test' } }));
    assert.deepEqual(await fetchOsrmJson(`${GATEWAY}/table/v1/driving/1,2;3,4`), okPayload);
    await fetchOsrmJson('https://other.example/table/v1/driving/1,2;3,4');
    assert.equal(calls[0].options.headers['Authorization'], 'Bearer fk-test-key');
    assert.equal(calls[0].options.headers['User-Agent'], 'FirstKnock-Routing/1.0');
    assert.equal(calls[1].options.headers['Authorization'], undefined, 'another host never receives the key');
    assert.equal(osrmRoadBuildId(), 'us-car-test');
});

test('an unset, plain-HTTP or public-demo engine is not configured — no default engine is chosen', () => {
    for (const value of ['', 'http://gateway.example', 'https://router.project-osrm.org', 'not a url']) {
        const provider = readOsrmProvider(name => (name === 'OSRM_BASE_URL' ? value : ''));
        assert.equal(provider.baseUrl, '');
        assert.equal(provider.configured, false);
    }
});

for (const status of [400, 401, 403]) test(`a ${status} is definitive and never retried`, async () => {
    const calls = stubFetch(() => Response.json({ code: status === 400 ? 'NoSegment' : 'Unauthorized',
        message: 'Could not find a matching segment for coordinate 12' }, { status }));
    await assert.rejects(fetchOsrmJson(`${GATEWAY}/table`, { timeoutMs: 5000 }), (error) => {
        assert.equal(error.status, status);
        return true;
    });
    assert.equal(calls.length, 1);
    assert.equal(osrmCounters().retries, 0);
});

test('unmatched road pins preserve the provider code and coordinate index', async () => {
    stubFetch(() => Response.json({ code: 'NoSegment', message: 'Could not find a matching segment for coordinate 12' }, { status: 400 }));
    await assert.rejects(fetchOsrmJson(`${GATEWAY}/table`), (error) => {
        assert.equal(error.code, 'NoSegment');
        assert.match(error.message, /coordinate 12/);
        return true;
    });
});

test('429 is retried only after the server Retry-After has elapsed', async () => {
    const calls = stubFetch((n) => (n === 1
        ? new Response('busy', { status: 429, headers: { 'Retry-After': '1' } })
        : Response.json(okPayload)));
    assert.deepEqual(await fetchOsrmJson(`${GATEWAY}/table`, { timeoutMs: 5000 }), okPayload);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].at - calls[0].at >= 990, `retried after ${calls[1].at - calls[0].at} ms`);
    assert.equal(osrmCounters().rateLimited, 1);
    assert.equal(osrmCounters().retries, 1);
});

test('a 503 whose Retry-After outlives the deadline fails at once instead of sleeping', async () => {
    const calls = stubFetch(() => new Response('busy', { status: 503, headers: { 'Retry-After': '60' } }));
    const started = Date.now();
    await assert.rejects(fetchOsrmJson(`${GATEWAY}/table`, { timeoutMs: 2000 }), /status 503/);
    assert.equal(calls.length, 1);
    assert.ok(Date.now() - started < 500);
});

test('the deadline covers the body read, not just the headers', async () => {
    stubFetch(() => ({
        ok: true, status: 200, headers: new Headers(),
        json: () => new Promise(() => {}) // headers arrived, body never does
    }));
    const started = Date.now();
    await assert.rejects(fetchOsrmJson(`${GATEWAY}/route`, { timeoutMs: 150 }), { name: 'TimeoutError', code: 'OSRM_DEADLINE' });
    assert.ok(Date.now() - started < 1000);
    assert.equal(osrmCounters().timeouts, 1);
    assert.ok(osrmCounters().bodyMs >= 100, 'the stalled body is billed to the body stage');
});

test('the deadline covers queue wait and retry sleeps', async () => {
    configureOsrmDispatcher({ maxConcurrent: 1 });
    let release;
    const calls = stubFetch((n) => (n === 1
        ? new Promise((resolve) => { release = () => resolve(Response.json(okPayload)); })
        : Response.json(okPayload)));
    const first = fetchOsrmJson(`${GATEWAY}/a`, { timeoutMs: 5000 });
    await assert.rejects(fetchOsrmJson(`${GATEWAY}/b`, { timeoutMs: 100 }), { code: 'OSRM_DEADLINE' });
    assert.equal(calls.length, 1, 'a request that timed out in the queue never reaches the engine');
    assert.equal(osrmDispatcherState().queued, 0);
    release();
    await first;

    // Retry sleep: a 503 with a short Retry-After, but a deadline shorter still.
    stubFetch(() => new Response('busy', { status: 503, headers: { 'Retry-After': '0.4' } }));
    const started = Date.now();
    await assert.rejects(fetchOsrmJson(`${GATEWAY}/c`, { timeoutMs: 300 }), /503/);
    assert.ok(Date.now() - started < 300);
});

test('cancellation stops an in-flight request and drops a queued one', async () => {
    configureOsrmDispatcher({ maxConcurrent: 1 });
    const calls = stubFetch((_n, _url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));
    const controller = new AbortController();
    const inFlight = fetchOsrmJson(`${GATEWAY}/a`, { timeoutMs: 5000, signal: controller.signal });
    const queued = fetchOsrmJson(`${GATEWAY}/b`, { timeoutMs: 5000, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await assert.rejects(inFlight, { name: 'AbortError' });
    await assert.rejects(queued, { name: 'AbortError' });
    assert.equal(calls.length, 1);
    assert.equal(osrmCounters().cancelled, 2);
    assert.equal(osrmCounters().retries, 0, 'a cancelled request is not retried');
});

test('stage counters record queued, header and body time', async () => {
    stubFetch(() => Response.json(okPayload));
    await fetchOsrmJson(`${GATEWAY}/table`);
    const counters = osrmCounters();
    for (const key of ['queuedMs', 'headersMs', 'bodyMs']) assert.equal(typeof counters[key], 'number');
    assert.equal(counters.requests, 1);
});

test('Retry-After accepts seconds and HTTP dates', () => {
    assert.equal(parseRetryAfterMs('2'), 2000);
    assert.equal(parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000);
    assert.equal(parseRetryAfterMs(null), null);
    assert.equal(parseRetryAfterMs('soon'), null);
});

test('failures are classified so a manager can tell "never connected" from "refused"', async () => {
    readOsrmProvider(name => ({ OSRM_BASE_URL: GATEWAY })[name]);
    globalThis.fetch = async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND gateway.example'), { code: 'ENOTFOUND' }) });
    };
    const network = await fetchOsrmJson(`${GATEWAY}/table/v1/driving/-80.84,35.22;-80.85,35.23`, { timeoutMs: 200 }).catch(error => error);
    const detail = describeRoadFailure(network, { baseUrl: GATEWAY });
    assert.equal(detail.kind, 'network');
    assert.equal(detail.host, 'gateway.example');
    assert.match(detail.message, /fetch failed: ENOTFOUND/);
    assert.doesNotMatch(detail.message, /https?:|35\.22/, 'no URL or coordinates are stored');

    stubFetch(() => Response.json({ code: 'Unauthorized', message: 'A valid gateway key is required.' }, { status: 401 }));
    const auth = describeRoadFailure(await fetchOsrmJson(`${GATEWAY}/t`).catch(error => error), { baseUrl: GATEWAY });
    assert.deepEqual([auth.kind, auth.status], ['auth', 401]);

    stubFetch(() => Response.json({ code: 'NoSegment', message: 'Could not find a matching segment for coordinate 1' }, { status: 400 }));
    const osrm = describeRoadFailure(await fetchOsrmJson(`${GATEWAY}/t`).catch(error => error));
    assert.deepEqual([osrm.kind, osrm.status, osrm.osrm_code], ['osrm', 400, 'NoSegment']);

    stubFetch(() => ({ ok: true, status: 200, headers: new Headers(), json: () => new Promise(() => {}) }));
    const slow = describeRoadFailure(await fetchOsrmJson(`${GATEWAY}/t`, { timeoutMs: 50 }).catch(error => error));
    assert.equal(slow.kind, 'timeout');

    assert.equal(describeRoadFailure({ code: 'ROAD_PROVIDER_NOT_CONFIGURED', message: 'unset' }).kind, 'config');
});

test('an unclassified error is "other", never mistaken for a connection failure', () => {
    assert.equal(describeRoadFailure(new Error('Road matrix is incomplete: 3 unresolved cells.')).kind, 'other');
    assert.equal(describeRoadFailure(new TypeError('fetch failed')).kind, 'network');
    assert.equal(describeRoadFailure(new Error('error sending request: client error (Connect): dns error')).kind, 'network');
});

test('requests use an edge-supported redirect mode and refuse any redirect', async () => {
    // The Base44 edge runtime throws on redirect: 'error' before connecting.
    const calls = stubFetch((_n, _url, options) => {
        if (options.redirect === 'error') throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
        assert.equal(options.redirect, 'manual');
        return Response.json(okPayload);
    });
    assert.deepEqual(await fetchOsrmJson(`${GATEWAY}/table`), okPayload);
    assert.equal(calls.length, 1);

    stubFetch(() => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/' } }));
    const redirected = await fetchOsrmJson(`${GATEWAY}/table`).catch(error => error);
    assert.match(redirected.message, /redirect/);
    assert.equal(describeRoadFailure(redirected).kind, 'http');
});
