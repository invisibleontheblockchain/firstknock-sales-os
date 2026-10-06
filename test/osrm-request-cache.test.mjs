import test from 'node:test';
import assert from 'node:assert/strict';
import { createOsrmRequestCache } from '../base44/shared/osrmRequestCache.js';
import { createRoadCostCache } from '../base44/shared/roadCostCache.js';

const url = 'https://engine.example/route/v1/car/-81,35;-80.99,35?radiuses=100;100&continue_straight=true';
const answer = () => ({ code: 'Ok', data_version: 'one', routes: [{ duration: 123, distance: 456 }] });

test('identical concurrent road questions are requested once and each consumer receives independent data', async () => {
    let calls = 0;
    const cache = createOsrmRequestCache(async () => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); return answer(); });
    const [a, b] = await Promise.all([cache.fetchJson(url), cache.fetchJson(url)]);
    assert.equal(calls, 1); assert.equal(cache.stats().coalesced, 1);
    a.routes[0].duration = 999;
    assert.equal(b.routes[0].duration, 123);
    assert.equal((await cache.fetchJson(url)).routes[0].duration, 123);
    assert.equal(calls, 1);
});

test('order, graph endpoint, profile, snap policy and timeout identity cannot alias', async () => {
    let calls = 0;
    const cache = createOsrmRequestCache(async () => { calls++; return answer(); });
    const questions = [url, url.replace('car', 'driving'), url.replace('engine.example', 'other.example'),
        url.replace('-81,35;-80.99,35', '-80.99,35;-81,35'), url.replace('100;100', '40;40'), `${url}&bearings=90,45;90,45`];
    for (const question of questions) await cache.fetchJson(question);
    await cache.fetchJson(url, { timeoutMs: 1000 });
    assert.equal(calls, 7);
    const otherGeneration = createOsrmRequestCache(async () => { calls++; return answer(); });
    await otherGeneration.fetchJson(url); assert.equal(calls, 8);
});

test('failed and invalid responses are retried rather than reused; changing graph versions fails closed', async () => {
    let calls = 0;
    const cache = createOsrmRequestCache(async () => {
        calls++; if (calls === 1) throw new Error('Provider unavailable');
        if (calls === 2) return { code: 'NoRoute' };
        return { ...answer(), data_version: calls === 3 ? 'one' : 'two' };
    });
    await assert.rejects(cache.fetchJson(url), /unavailable/);
    await assert.rejects(cache.fetchJson(url), /unsuccessful/);
    assert.equal((await cache.fetchJson(url)).data_version, 'one');
    await assert.rejects(cache.fetchJson(`${url}&steps=true`), /graph identity changed/);
    assert.equal(cache.stats().pending, 0);
});

test('response storage remains bounded and an eviction only adds requests, never changes road truth', async () => {
    let calls = 0;
    const cache = createOsrmRequestCache(async () => { calls++; return answer(); }, { maxEntries: 1, maxBytes: 1024 });
    const first = await cache.fetchJson(url);
    await cache.fetchJson(`${url}&steps=true`);
    assert.deepEqual(await cache.fetchJson(url), first);
    assert.equal(calls, 3); assert.equal(cache.stats().entries, 1);
    const noStorage = createOsrmRequestCache(async () => answer(), { maxBytes: 1 });
    assert.deepEqual(await noStorage.fetchJson(url), answer());
    assert.equal(noStorage.stats().entries, 0); assert.equal(noStorage.stats().skippedLargeResponses, 1);
});

test('path reuse keys the actual service access point, and concurrent measurements coalesce', async () => {
    let measured = 0;
    const cache = createRoadCostCache({ measurePath: async () => {
        measured++; await new Promise(resolve => setTimeout(resolve, 5)); return { ok: true, totalMiles: measured };
    } });
    const stops = [{ lat: 35, lng: -81 }, { lat: 35, lng: -80.99 }];
    const [a, b] = await Promise.all([cache.measurePath(stops), cache.measurePath(stops)]);
    assert.equal(measured, 1); assert.equal(a.totalMiles, b.totalMiles);
    const changedAccess = stops.map(p => ({ ...p, routing_access: { resolution_status: 'resolved', point: { lat: p.lat, lng: p.lng + 0.001 } } }));
    await cache.measurePath(changedAccess); assert.equal(measured, 2);
    await cache.measurePath([...stops].reverse()); assert.equal(measured, 3);
});
