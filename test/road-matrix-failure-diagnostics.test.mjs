import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

let vite, optimize;
before(async () => {
    vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
    optimize = (await vite.ssrLoadModule('/src/lib/roadMatrixOptimize.js')).tryRoadMatrixOptimize;
});
after(async () => { await vite?.close(); });
const properties = ['A', 'B', 'C'].map((address_hash, i) => ({ address_hash, lat: 35, lng: -81 + i / 10000 }));

async function rejectedOutcome(error, expectedCalls = 1) {
    let calls = 0, outcome;
    const result = await optimize(properties, {
        client: { functions: { invoke: async () => { calls++; throw error; } } },
        onOutcome: (reason, measurement) => { outcome = { reason, measurement }; },
    });
    assert.equal(result, null); assert.equal(calls, expectedCalls, 'a failed request must not start a duplicate optimization');
    assert.ok(Number.isFinite(outcome.measurement.diagnostic.elapsedMs));
    assert.ok(outcome.measurement.diagnostic.elapsedMs >= 0);
    assert.deepEqual(Object.keys(outcome.measurement.diagnostic).sort(), ['elapsedMs', 'errorCode', 'httpStatus']);
    assert.doesNotMatch(JSON.stringify(outcome), /https:|33\.45|-112\.01|private/);
    return outcome;
}

test('the actual Axios CPU-exceeded body takes precedence over HTTP 429 throttling', async () => {
    const outcome = await rejectedOutcome(Object.assign(new Error('https://provider/33.45,-112.01'), {
        response: { status: 429, data: { error: 'cpu-exceeded', detail: 'private processing detail' } },
    }));
    assert.equal(outcome.reason, 'backend_cpu_limit');
    assert.equal(outcome.measurement.diagnostic.httpStatus, 429);
    assert.equal(outcome.measurement.diagnostic.errorCode, 'cpu-exceeded');
});

test('Base44Error data survives wrapping that does not expose Axios response', async () => {
    const outcome = await rejectedOutcome(Object.assign(new Error('private processing detail'), {
        name: 'Base44Error', status: 429, data: { error: 'cpu-exceeded' },
    }));
    assert.equal(outcome.reason, 'backend_cpu_limit');
    assert.equal(outcome.measurement.diagnostic.errorCode, 'cpu-exceeded');
});

test('the original Axios response is used when the Base44 wrapper has no body', async () => {
    const outcome = await rejectedOutcome(Object.assign(new Error('private processing detail'), {
        name: 'Base44Error', originalError: { response: { status: 429, data: { error: 'cpu-exceeded' } } },
    }));
    assert.equal(outcome.reason, 'backend_cpu_limit');
    assert.equal(outcome.measurement.diagnostic.httpStatus, 429);
});

test('ordinary HTTP 429 is reported as busy and other failures remain errors', async () => {
    const busy = await rejectedOutcome({ response: { status: 429, data: { error: 'Too many requests' } } });
    assert.equal(busy.reason, 'backend_rate_limited');
    assert.equal(busy.measurement.diagnostic.errorCode, 'rate-limited');
    // A finished server error is sent once more, after the first request ended.
    const unavailable = await rejectedOutcome({ status: 503, data: { error: 'private provider URL https://provider' } }, 2);
    assert.equal(unavailable.reason, 'backend_unavailable');
    assert.equal(unavailable.measurement.diagnostic.httpStatus, 503);
    assert.equal(unavailable.measurement.diagnostic.errorCode, null);
});

test('resolved non-success responses forward the same sanitized failure diagnostic', async () => {
    let outcome;
    assert.equal(await optimize(properties, {
        client: { functions: { invoke: async () => ({ status: 429, data: {
            success: false, error: 'cpu-exceeded', detail: 'private processing detail',
        } }) } },
        onOutcome: (reason, measurement) => { outcome = { reason, measurement }; },
    }), null);
    assert.equal(outcome.reason, 'backend_cpu_limit');
    assert.equal(outcome.measurement.diagnostic.httpStatus, 429);
    assert.doesNotMatch(JSON.stringify(outcome), /detail|private/);
    assert.equal(await optimize(properties, {
        client: { functions: { invoke: async () => ({ success: false, error: 'private' }) } },
        onOutcome: (reason, measurement) => { outcome = { reason, measurement }; },
    }), null);
    assert.equal(outcome.reason, 'backend_reported_failure');
    assert.equal(outcome.measurement.diagnostic.httpStatus, null);
    assert.equal(outcome.measurement.diagnostic.errorCode, null);
});

test('a server-marked public reason reaches the outcome, sanitized; the private error never does', async () => {
    let outcome;
    await optimize(properties, {
        client: { functions: { invoke: async () => { throw { response: { status: 500, data: {
            error: 'private provider URL https://provider/33.45,-112.01',
            public_error: 'Vehicle route has inconsistent turn continuity at a chunk seam.' } } }; } } },
        onOutcome: (reason, measurement) => { outcome = { reason, measurement }; },
    });
    assert.equal(outcome.measurement.diagnostic.serverMessage, 'Vehicle route has inconsistent turn continuity at a chunk seam.');
    assert.doesNotMatch(JSON.stringify(outcome), /https:|33\.45|private/);
    await optimize(properties, {
        client: { functions: { invoke: async () => { throw { response: { status: 500, data: {
            error: 'x', public_error: 'near 33.45, -112.01 via https://provider/' } } }; } } },
        onOutcome: (reason, measurement) => { outcome = { reason, measurement }; },
    });
    assert.doesNotMatch(JSON.stringify(outcome), /https:|33\.45|-112\.01/);
});
