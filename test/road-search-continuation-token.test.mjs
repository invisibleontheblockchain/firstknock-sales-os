import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createRoadSearchContinuationCodec, stableCanonicalString, sha256RoadSearch,
    ROAD_SEARCH_CONTINUATION_TTL_MS, MAX_ROAD_SEARCH_CONTINUATION_CHARS,
    MAX_ROAD_SEARCH_CONTINUATION_BYTES } from '../base44/shared/roadSearchContinuation.js';

globalThis.crypto ||= webcrypto;
const secret = 'test-only-road-search-secret-with-more-than-32-characters';
const configuration = { secret, appId: 'app-a', userId: 'user-a', provider: 'https://roads.test/driving', optimizerVersion: 'v21' };
const fingerprint = 'action-a:original-input-and-current-order-sha256';
const state = () => ({ entries: [{ key: 'window-1', graph: 'graph-a' }],
    curb: { 'door-1': { confidence: 'high', point: { lat: 35.2, lng: -80.8 }, serviceBearing: 90 } } });
const fixture = () => {
    let time = 1000;
    return { codec: createRoadSearchContinuationCodec({ ...configuration, now: () => time }), setTime: value => { time = value; } };
};
const readPayload = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
const rawToken = payload => {
    const encoded = Buffer.from(stableCanonicalString(payload)).toString('base64url');
    const signed = `rsc1.${encoded}`;
    return `${signed}.${createHmac('sha256', secret).update(signed).digest('base64url')}`;
};

test('canonical digests preserve JSON meaning and order without depending on object insertion order', async () => {
    assert.equal(stableCanonicalString({ z: undefined, a: [undefined, -0, 'é'] }), '{"a":[null,0,"é"],"z":null}');
    assert.equal(await sha256RoadSearch({ b: 2, a: 1 }), await sha256RoadSearch({ a: 1, b: 2 }));
    assert.notEqual(await sha256RoadSearch(['a', 'b']), await sha256RoadSearch(['b', 'a']));
    assert.match(await sha256RoadSearch(state()), /^[a-f0-9]{64}$/);
});

test('canonical JSON accepts cross-realm and null-prototype maps without invoking getters', () => {
    assert.equal(stableCanonicalString(vm.runInNewContext('({ b: 2, a: [1] })')), '{"a":[1],"b":2}');
    assert.equal(stableCanonicalString(Object.assign(Object.create(null), { b: 2 })), '{"b":2}');
    let called = false;
    assert.throws(() => stableCanonicalString({ get data() { called = true; return 'unsafe'; } }), /getters/);
    assert.equal(called, false);
});

test('canonical JSON rejects nonfinite, executable, cyclic, and excessively deep values', () => {
    for (const value of [NaN, Infinity, -Infinity, 1n, () => 1, Symbol('x'), new Date()]) {
        assert.throws(() => stableCanonicalString({ value }), TypeError);
    }
    const cycle = {}; cycle.self = cycle;
    assert.throws(() => stableCanonicalString(cycle), /cycles/);
    let deep = {}; for (let i = 0; i < 35; i++) deep = { next: deep };
    assert.throws(() => stableCanonicalString(deep), /complex/);
});

test('round trip authenticates a bounded JSON snapshot with a fixed server-issued lifetime', async () => {
    const { codec } = fixture();
    const token = await codec.seal(state(), fingerprint);
    assert.equal(typeof token, 'string');
    assert.ok(token.length < MAX_ROAD_SEARCH_CONTINUATION_CHARS);
    const opened = await codec.open(token, fingerprint);
    assert.deepEqual(opened.state, state());
    assert.equal(opened.issuedAt, 1000);
    assert.equal(opened.expiresAt, 1000 + ROAD_SEARCH_CONTINUATION_TTL_MS);
    assert.match(opened.actionId, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(Object.isFrozen(opened), true);
});

test('begin fixes the action lifetime before expensive work and generates a distinct action identity', async () => {
    const { codec, setTime } = fixture();
    const beginning = codec.begin();
    assert.equal(beginning.issuedAt, 1000);
    assert.equal(beginning.expiresAt, 301000);
    assert.notEqual(codec.begin().actionId, beginning.actionId);
    setTime(81000);
    const opened = await codec.open(await codec.seal(state(), fingerprint, beginning), fingerprint);
    assert.equal(opened.actionId, beginning.actionId);
    assert.equal(opened.issuedAt, 1000);
    assert.equal(opened.expiresAt, 301000);
    setTime(301000);
    assert.equal(await codec.seal(state(), fingerprint, beginning), null);
});

test('payload or signature tampering cannot restore search state', async () => {
    const { codec } = fixture();
    const token = await codec.seal(state(), fingerprint);
    const parts = token.split('.');
    const changed = readPayload(token); changed.state.entries.push({ key: 'forged-complete' });
    assert.equal(await codec.open(`${parts[0]}.${Buffer.from(JSON.stringify(changed)).toString('base64url')}.${parts[2]}`, fingerprint), null);
    assert.equal(await codec.open(`${parts[0]}.${parts[1]}.${parts[2][0] === 'a' ? 'b' : 'a'}${parts[2].slice(1)}`, fingerprint), null);
    assert.equal(await createRoadSearchContinuationCodec({ ...configuration, secret: `${secret}-rotated`, now: () => 1000 }).open(token, fingerprint), null);
});

for (const [field, value] of Object.entries({ appId: 'app-b', userId: 'user-b', provider: 'https://another.test/driving', optimizerVersion: 'v22' })) {
    test(`receipt cannot cross its ${field} binding`, async () => {
        const { codec } = fixture();
        const token = await codec.seal(state(), fingerprint);
        const other = createRoadSearchContinuationCodec({ ...configuration, [field]: value, now: () => 1000 });
        assert.equal(await other.open(token, fingerprint), null);
    });
}

test('new action, changed route input, or changed current order requires fresh search', async () => {
    const { codec } = fixture();
    const token = await codec.seal(state(), fingerprint);
    for (const changed of ['action-b:original-input-and-current-order-sha256', 'action-a:changed-input', 'action-a:changed-order']) {
        assert.equal(await codec.open(token, changed), null);
    }
});

test('expiry is inclusive at five minutes and future issuance is rejected', async () => {
    const { codec, setTime } = fixture();
    const token = await codec.seal(state(), fingerprint);
    setTime(999); assert.equal(await codec.open(token, fingerprint), null);
    setTime(1000 + ROAD_SEARCH_CONTINUATION_TTL_MS - 1); assert.ok(await codec.open(token, fingerprint));
    setTime(1000 + ROAD_SEARCH_CONTINUATION_TTL_MS); assert.equal(await codec.open(token, fingerprint), null);
});

test('a verified continuation may change state and output binding but cannot extend its original expiry', async () => {
    const { codec, setTime } = fixture();
    const first = await codec.seal(state(), fingerprint);
    setTime(120000);
    const opened = await codec.open(first, fingerprint);
    const nextState = state(); nextState.entries.push({ key: 'window-2', graph: 'graph-a' });
    const next = await codec.seal(nextState, 'action-a:next-output-order', opened);
    const result = await codec.open(next, 'action-a:next-output-order');
    assert.deepEqual(result.state, nextState);
    assert.equal(result.issuedAt, 1000);
    assert.equal(result.expiresAt, 301000);
    assert.equal(result.actionId, opened.actionId);
    setTime(301000);
    assert.equal(await codec.seal(nextState, fingerprint, opened), null);
    assert.equal(await codec.open(next, 'action-a:next-output-order'), null);
});

test('lifetime inheritance requires a handle actually verified by this codec instance', async () => {
    const { codec } = fixture();
    const token = await codec.seal(state(), fingerprint);
    const opened = await codec.open(token, fingerprint);
    assert.equal(await codec.seal(state(), fingerprint, { ...opened, expiresAt: 999999 }), null);
    assert.equal(await codec.seal(state(), fingerprint, {}), null);
    const nextRequest = createRoadSearchContinuationCodec({ ...configuration, now: () => 2000 });
    assert.equal(await nextRequest.seal(state(), fingerprint, opened), null);
    const reverified = await nextRequest.open(token, fingerprint);
    assert.equal(readPayload(await nextRequest.seal(state(), fingerprint, reverified)).expiresAt, 301000);
});

test('even a valid MAC cannot bypass version, purpose, binding shape, or maximum lifetime checks', async () => {
    const { codec } = fixture();
    const payload = readPayload(await codec.seal(state(), fingerprint));
    for (const change of [{ purpose: 'another-purpose' }, { version: 2 }, { expiresAt: 301001 },
        { issuedAt: -1 }, { issuedAt: 1001, expiresAt: 301001 }, { extra: true }, { actionId: '' },
        { actionId: 'x'.repeat(22) },
        { binding: { ...payload.binding, extra: true } }]) {
        assert.equal(await codec.open(rawToken({ ...payload, ...change }), fingerprint), null);
    }
});

test('malformed or oversized browser tokens fail softly without usable state', async () => {
    const { codec } = fixture();
    for (const token of [null, {}, '', 'rsc1', 'rsc1.a.b', 'rsc2.a.b', 'rsc1.***.***',
        'a'.repeat(MAX_ROAD_SEARCH_CONTINUATION_CHARS + 1)]) {
        assert.equal(await codec.open(token, fingerprint), null);
    }
    const payload = readPayload(await codec.seal(state(), fingerprint));
    const signed = `rsc1.${Buffer.from(`${stableCanonicalString(payload)} `).toString('base64url')}`;
    assert.equal(await codec.open(`${signed}.${createHmac('sha256', secret).update(signed).digest('base64url')}`, fingerprint), null);
});

test('missing secrets or invalid identity bindings disable reuse without preventing a fresh search', async () => {
    const { codec } = fixture();
    const token = await codec.seal(state(), fingerprint);
    for (const change of [{ secret: '' }, { secret: 'short' }, { secret: 'x'.repeat(4097) }, { appId: '' },
        { userId: 'bad\nuser' }, { provider: 'x'.repeat(2049) }, { optimizerVersion: '' }]) {
        const disabled = createRoadSearchContinuationCodec({ ...configuration, ...change, now: () => 1000 });
        assert.equal(await disabled.open(token, fingerprint), null);
        assert.equal(await disabled.seal(state(), fingerprint), null);
    }
    assert.equal(await codec.seal(state(), ''), null);
    assert.equal(await codec.open(token, 'x'.repeat(257)), null);
});

test('unserializable and oversized snapshots never issue a receipt, including multibyte payloads', async () => {
    const { codec } = fixture();
    const cycle = {}; cycle.self = cycle;
    for (const snapshot of [cycle, { bad: NaN }, { run: () => true }, { huge: 'a'.repeat(MAX_ROAD_SEARCH_CONTINUATION_BYTES) },
        { huge: '界'.repeat(Math.ceil(MAX_ROAD_SEARCH_CONTINUATION_BYTES / 3)) }]) assert.equal(await codec.seal(snapshot, fingerprint), null);
    const token = await codec.seal({ text: '界'.repeat(1000), empty: undefined }, fingerprint);
    assert.deepEqual((await codec.open(token, fingerprint)).state, { text: '界'.repeat(1000), empty: null });
});

test('377 real-shaped inferred records exceed raw transport bounds but compress without changing any field', async () => {
    const { codec } = fixture();
    const fixtureData = JSON.parse(fs.readFileSync(new URL('./fixtures/troutman-area-305-317.json', import.meta.url), 'utf8'));
    const samples = fixtureData.stops.filter(stop => stop.routing_access).map(stop => stop.routing_access);
    const snapshot = { inferredAccess: Array.from({ length: 377 }, (_, index) => [`door-${index}`, samples[index % samples.length]]),
        discovered: Array.from({ length: 377 }, (_, index) => `door-${index}`), receipts: Array.from({ length: 123 }, (_, index) => index.toString(16).padStart(64, '0')) };
    assert.ok(Buffer.from(stableCanonicalString(snapshot)).toString('base64url').length > MAX_ROAD_SEARCH_CONTINUATION_CHARS);
    const token = await codec.seal(snapshot, fingerprint);
    assert.ok(token.startsWith('rsc1z.'));
    assert.ok(token.length < MAX_ROAD_SEARCH_CONTINUATION_CHARS);
    assert.deepEqual((await codec.open(token, fingerprint)).state, snapshot);
});

test('signed compressed expansions and malformed gzip fail softly at a strict decoded-byte limit', async () => {
    const { codec } = fixture();
    for (const bytes of [gzipSync(Buffer.alloc(MAX_ROAD_SEARCH_CONTINUATION_BYTES + 1, 32)), Buffer.from('invalid gzip')]) {
        const signed = `rsc1z.${bytes.toString('base64url')}`;
        const token = `${signed}.${createHmac('sha256', secret).update(signed).digest('base64url')}`;
        assert.equal(await codec.open(token, fingerprint), null);
    }
});

test('compression still rejects oversized incompressible payloads and authenticates its format marker', async () => {
    const { codec } = fixture();
    const bytes = new Uint8Array(196000);
    for (let offset = 0; offset < bytes.length; offset += 65536) crypto.getRandomValues(bytes.subarray(offset, offset + 65536));
    assert.equal(await codec.seal({ random: Buffer.from(bytes).toString('base64url') }, fingerprint), null);
    const token = await codec.seal({ text: 'x'.repeat(210000) }, fingerprint);
    assert.ok(token.startsWith('rsc1z.'));
    assert.equal(await codec.open(token.replace('rsc1z.', 'rsc1.'), fingerprint), null);
    assert.equal((await codec.open(token, fingerprint)).state.text.length, 210000);
});

test('invalid server clocks cannot issue or accept trusted state', async () => {
    const { codec } = fixture();
    const token = await codec.seal(state(), fingerprint);
    for (const time of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
        const invalid = createRoadSearchContinuationCodec({ ...configuration, now: () => time });
        assert.equal(await invalid.seal(state(), fingerprint), null);
        assert.equal(await invalid.open(token, fingerprint), null);
    }
});
