import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createRoadSearchSession } from '../base44/shared/roadSearchSession.js';

globalThis.crypto ||= webcrypto;
const secret = 'test-only-search-session-secret-with-32-characters';
const id = stop => String(stop.address_hash || stop.id || `${stop.lat},${stop.lng}`);
const stops = () => ['a', 'b', 'c', 'd'].map((address_hash, i) => ({ address_hash,
    house_number: String(100 + i), street_name: 'Test Lane', city: 'Test City', state: 'NC', zip_code: '28117',
    lat: 35 + i / 10000, lng: -81, order_locked: false }));
const inferred = stop => ({ source: 'osrm-named-road-side', confidence: 'high', chainKey: 'chain-a',
    point: { lat: stop.lat, lng: stop.lng }, serviceBearing: 90, side: 'right', positionMeters: 10,
    resolution_status: 'resolved' });
const receipt = '1'.repeat(64);

function fixture() {
    const properties = stops();
    let time = 1000;
    const control = { version: null, changedCost: 0, geometryOffset: 0, fail: null, malformed: null };
    const contexts = [], calls = [];
    const createDrivingContext = async (order, access, options) => {
        contexts.push({ order, access, options });
        return { routeSequence: async (sequence, bounds) => {
            if (control.fail) throw control.fail;
            calls.push(sequence.map(id));
            const ordered = [bounds.startLocation, ...sequence, bounds.endLocation].filter(Boolean);
            const legs = ordered.slice(1).map((stop, i) => {
                const geometry = [ordered[i], stop].map(p => ({ lat: p.lat + control.geometryOffset, lng: p.lng }));
                return { from: id(ordered[i]), to: id(stop), driveSeconds: 10 + control.changedCost,
                    distanceMiles: 1, geometry, pathKey: JSON.stringify(geometry.map(p => [p.lng, p.lat])) };
            });
            if (control.malformed) control.malformed(legs);
            return { directedLegs: legs, dataVersion: control.version,
                driveSeconds: legs.reduce((sum, leg) => sum + leg.driveSeconds, 0), distanceMiles: legs.length };
        } };
    };
    const configuration = { secret, appId: 'app-a', userId: 'manager-a', optimizerVersion: 'v21', providerIdentity: 'roads-a|county-a',
        body: { search_continuation_version: 1, comparison_order: properties.map(id) },
        properties, displayProperties: properties, neighborhoodOptions: { vehicleProfile: 'driving', mailCarrierMode: true },
        startedAt: 1000, now: () => time, createDrivingContext };
    return { properties, control, contexts, calls, setTime: value => { time = value; }, configuration,
        create: changes => createRoadSearchSession({ ...configuration, ...changes }) };
}

async function issue(f, changes = {}) {
    const session = await f.create();
    session.proof.complete(receipt);
    session.proof.discovered.add('a');
    session.proof.inferredAccess.set('a', inferred(f.properties[0]));
    const token = await session.finish({ winningOrder: f.properties, eligible: true, ...changes });
    assert.equal(typeof token, 'string');
    return { session, token };
}

test('first pass collects trusted state; resumed unversioned provider requires a fresh matching original-route witness', async () => {
    const f = fixture(), { session, token } = await issue(f);
    assert.equal(session.diagnostic.issued, true);
    const resumed = await f.create({ body: { ...f.configuration.body, search_continuation: token } });
    assert.equal(resumed.diagnostic.status, 'restored');
    assert.equal(resumed.diagnostic.restored_windows, 1);
    assert.ok(resumed.proof.has(receipt));
    assert.deepEqual(resumed.proof.inferredAccess.get('a'), inferred(f.properties[0]));
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls, [['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd']]);
    const { options, access } = f.contexts.at(-1);
    assert.equal(options.routeOnly, true); assert.equal(options.sparseCosts, true); assert.equal(options.requireDirectedLegs, true);
    assert.equal(options.maxGeometryPoints, 100000);
    assert.deepEqual(options.servicePolicy, { enabled: false, parkingSecondsPerStop: 0 });
    assert.deepEqual(access.accessFor(f.properties[0]), inferred(f.properties[0]));
    assert.equal(JSON.stringify(resumed.diagnostic).includes('Test Lane'), false);
});

test('finish binds next raw property order and access overrides while the original comparison order remains fixed', async () => {
    const f = fixture();
    const recovered = f.properties.map(stop => ({ ...stop, lat: stop.lat + 0.00001,
        routing_access: { resolution_status: 'resolved', point: { lat: stop.lat + 0.00001, lng: stop.lng }, confidence: 'low' } }));
    const session = await f.create({ properties: recovered });
    session.proof.complete(receipt);
    const winning = [recovered[0], recovered[2], recovered[1], recovered[3]];
    const overrides = Object.fromEntries(recovered.map(stop => [id(stop), stop.routing_access]));
    const token = await session.finish({ winningOrder: winning, accessOverrides: overrides, eligible: true });
    const rawNext = winning.map(stop => ({ ...f.properties.find(raw => id(raw) === id(stop)), routing_access: overrides[id(stop)] }));
    const resumed = await f.create({ properties: winning, displayProperties: rawNext,
        body: { ...f.configuration.body, search_continuation: token } });
    assert.equal(resumed.diagnostic.status, 'restored');
    assert.deepEqual(f.calls.at(-1), ['a', 'b', 'c', 'd']);
});

for (const [name, change] of [['driving cost', c => { c.changedCost = 0.01; }],
    ['road geometry', c => { c.geometryOffset = 0.00001; }], ['graph stamp', c => { c.version = 'different-graph'; }]]) {
    test(`changed ${name} discards receipts and inferred curb state`, async () => {
        const f = fixture(), { token } = await issue(f); change(f.control);
        const resumed = await f.create({ body: { ...f.configuration.body, search_continuation: token } });
        assert.equal(resumed.diagnostic.status, 'discarded');
        assert.equal(resumed.diagnostic.reason, 'witness_changed');
        assert.equal(resumed.proof.has(receipt), false);
        assert.equal(resumed.proof.inferredAccess.size, 0);
        assert.equal(resumed.proof.discovered.size, 0);
    });
}

test('changed recovered access discards state before making a witness request', async () => {
    const f = fixture(), { token } = await issue(f), before = f.calls.length;
    const properties = f.properties.map((stop, i) => i ? stop : { ...stop, lat: stop.lat + 0.001 });
    const resumed = await f.create({ properties, body: { ...f.configuration.body, search_continuation: token } });
    assert.equal(resumed.diagnostic.reason, 'receipt_mismatch');
    assert.equal(resumed.proof.inferredAccess.size, 0);
    assert.equal(f.calls.length, before);
});

test('changed raw input, settings, user or provider cannot restore another receipt', async () => {
    const f = fixture(), { token } = await issue(f);
    const changes = [
        { displayProperties: f.properties.map((stop, i) => i ? stop : { ...stop, house_number: '999' }) },
        { neighborhoodOptions: { ...f.configuration.neighborhoodOptions, tieSeconds: 3 } },
        { userId: 'manager-b' }, { providerIdentity: 'roads-b' }, { startLocation: { lat: 35, lng: -81 } },
        { body: { ...f.configuration.body, comparison_order: [...f.configuration.body.comparison_order].reverse() } },
    ];
    const before = f.calls.length;
    for (const change of changes) {
        const resumed = await f.create({ ...change, body: { ...(change.body || f.configuration.body), search_continuation: token } });
        assert.equal(resumed.diagnostic.status, 'discarded');
        assert.equal(resumed.proof.has(receipt), false);
    }
    assert.equal(f.calls.length, before);
});

test('malformed or expired receipt falls back to new proof without using its inferred map', async () => {
    const f = fixture(), { token } = await issue(f);
    f.setTime(301000);
    for (const value of [token, `${token}tampered`]) {
        const resumed = await f.create({ startedAt: 301000, body: { ...f.configuration.body, search_continuation: value } });
        assert.equal(resumed.diagnostic.status, 'discarded'); assert.equal(resumed.proof.inferredAccess.size, 0);
    }
});

test('first request work consumes receipt lifetime and resumed passes cannot renew it', async () => {
    const f = fixture();
    f.setTime(81000);
    const { token } = await issue(f);
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    assert.equal(payload.issuedAt, 1000); assert.equal(payload.expiresAt, 301000);
    f.setTime(240000);
    const resumed = await f.create({ startedAt: 240000, body: { ...f.configuration.body, search_continuation: token } });
    const next = await resumed.finish({ winningOrder: f.properties, eligible: true });
    assert.equal(JSON.parse(Buffer.from(next.split('.')[1], 'base64url').toString('utf8')).expiresAt, 301000);
    f.setTime(301000);
    assert.equal(await resumed.finish({ winningOrder: f.properties, eligible: true }), null);
});

test('missing capability, walking, absent secret and invalid membership disable session reuse', async () => {
    const f = fixture();
    for (const change of [{ body: {} }, { body: { ...f.configuration.body, profile: 'walking' } },
        { properties: [...f.properties.slice(0, 3), f.properties[0]] }, { startedAt: 2000 }]) {
        const session = await f.create(change);
        assert.equal(session.proof, null); assert.equal(session.diagnostic.status, 'disabled');
        assert.equal(await session.finish({ winningOrder: f.properties, eligible: true }), null);
    }
    assert.equal(f.calls.length, 0);
});

test('a capable client without signing configuration still receives fresh proof and cannot trust unsigned history', async () => {
    const f = fixture(), { token } = await issue(f), before = f.calls.length;
    const session = await f.create({ secret: '', body: { ...f.configuration.body, search_continuation: token,
        search_coverage: { completed_window_keys: [receipt] } } });
    assert.equal(session.diagnostic.status, 'disabled');
    assert.equal(session.diagnostic.reason, 'unconfigured');
    assert.ok(session.proof);
    assert.equal(session.proof.has(receipt), false);
    assert.equal(session.proof.inferredAccess.size, 0);
    assert.equal(await session.finish({ winningOrder: f.properties, eligible: true }), null);
    assert.equal(f.calls.length, before);
});

test('an ineligible or membership-changing result cannot issue a token or make a witness call', async () => {
    const f = fixture(), session = await f.create();
    assert.equal(await session.finish({ winningOrder: f.properties, eligible: false }), null);
    assert.equal(await session.finish({ winningOrder: f.properties.slice(1), eligible: true }), null);
    assert.equal(f.calls.length, 0);
});

test('unresolved access disables session creation before restoring a valid receipt or making a witness call', async () => {
    const f = fixture(), { token } = await issue(f), before = f.calls.length;
    const session = await f.create({ eligible: false, body: { ...f.configuration.body, search_continuation: token } });
    assert.equal(session.proof, null);
    assert.equal(session.diagnostic.reason, 'ineligible');
    assert.equal(await session.finish({ winningOrder: f.properties, eligible: true }), null);
    assert.equal(f.calls.length, before);
});

test('malformed directed legs and ordinary witness outages fail softly without restored state', async () => {
    const f = fixture(), { token } = await issue(f);
    for (const corrupt of [legs => { legs[0].from = 'unrelated-stop'; }, legs => { legs[0].pathKey = 'fabricated'; },
        legs => { legs[0].geometry = []; }, legs => { legs[0].driveSeconds = NaN; }]) {
        f.control.malformed = corrupt;
        const session = await f.create({ body: { ...f.configuration.body, search_continuation: token } });
        assert.equal(session.diagnostic.reason, 'witness_unavailable');
        assert.equal(session.proof.has(receipt), false);
        assert.equal(await session.finish({ winningOrder: f.properties, eligible: true }), null);
    }
    f.control.malformed = null; f.control.fail = new Error('Provider is unavailable');
    const session = await f.create({ body: { ...f.configuration.body, search_continuation: token } });
    assert.equal(session.diagnostic.reason, 'witness_unavailable');
});

test('explicit graph identity changes and cancellation are propagated on restore and issue', async () => {
    const f = fixture(), { token } = await issue(f);
    for (const error of [new Error('Vehicle provider graph identity changed.'), new DOMException('Cancelled', 'AbortError')]) {
        f.control.fail = error;
        await assert.rejects(f.create({ body: { ...f.configuration.body, search_continuation: token } }), thrown => thrown === error);
        const fresh = await f.create();
        await assert.rejects(fresh.finish({ winningOrder: f.properties, eligible: true }), thrown => thrown === error);
    }
});

test('trusted property access takes precedence over restored inferred curb state', async () => {
    const f = fixture();
    const supplied = { ...inferred(f.properties[0]), serviceBearing: 270 };
    const properties = f.properties.map((stop, index) => index ? stop : { ...stop, routing_access: supplied });
    const session = await f.create({ properties, displayProperties: properties });
    session.proof.inferredAccess.set('a', inferred(properties[0]));
    await session.finish({ winningOrder: properties, eligible: true });
    assert.equal(f.contexts.at(-1).access.accessFor(properties[0]), supplied);
});

test('an unresolved stop is driven around by the witness and binds the proof to the same unresolved set', async () => {
    const f = fixture();
    const session = await f.create({ unresolvedStopIds: ['c'] });
    session.proof.complete(receipt);
    const token = await session.finish({ winningOrder: f.properties, eligible: true });
    assert.equal(typeof token, 'string', 'access-guarded routes can issue continuation proof');
    assert.ok(f.calls.every(call => !call.includes('c')), 'the unroutable stop is never sent to the witness');
    const body = { ...f.configuration.body, search_continuation: token };
    const resumed = await f.create({ body, unresolvedStopIds: ['c'] });
    assert.equal(resumed.diagnostic.status, 'restored');
    const changed = await f.create({ body, unresolvedStopIds: [] });
    assert.equal(changed.diagnostic.status, 'discarded', 'a different unresolved set cannot reuse the proof');
});
