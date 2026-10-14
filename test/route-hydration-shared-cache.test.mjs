import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRouteHydrationRuntime } from './helpers/routeHydrationRuntime.mjs';
import { hasCompleteRouteMapPoints, hydrateRouteWithLookup } from '../src/components/logic/routeHydrationCore.js';

const property = hash => ({ address_hash: hash, lat: 33.4, lng: -112.1, full_address: '1010 Main St' });
const route = { id: 'route-1', updated_date: '2026-10-14', property_hashes: ['house-1'] };

test('opening Run Route reuses a complete map lookup instead of downloading the homes again', async () => {
    let calls = 0;
    const runtime = createRouteHydrationRuntime({ functions: { invoke: async (_name, body) => {
        calls++;
        return { data: { properties: body.address_hashes.map(property) } };
    } } });
    await runtime.hydrateRouteForMap(route, 'manager@example.com');
    const selected = await runtime.hydrateRouteForMap({ ...route }, 'manager@example.com');
    assert.equal(hasCompleteRouteMapPoints(selected), true);
    assert.equal(calls, 1);
    await runtime.hydrateRouteForMap(route, 'other@example.com');
    assert.equal(calls, 2, 'a different viewer cannot inherit the first viewer cache');
});

test('simultaneous overview and selected-route requests share one lookup', async () => {
    let finish;
    let calls = 0;
    const pending = new Promise(resolve => { finish = resolve; });
    const runtime = createRouteHydrationRuntime({ functions: { invoke: async () => {
        calls++;
        await pending;
        return { data: { properties: [property('house-1')] } };
    } } });
    const overview = runtime.hydrateRouteForMap(route, 'rep@example.com');
    const selected = runtime.hydrateRouteForMap(route, 'rep@example.com');
    finish();
    const results = await Promise.all([overview, selected]);
    assert.equal(calls, 1);
    assert.ok(results.every(hasCompleteRouteMapPoints));
});

test('unidentified viewers never retain route data across later calls', async () => {
    let calls = 0;
    const runtime = createRouteHydrationRuntime({ functions: { invoke: async (_name, body) => {
        calls++;
        return { data: { properties: body.address_hashes.map(property) } };
    } } });
    await runtime.hydrateRoutesForMap([route]);
    await runtime.hydrateRoutesForMap([route]);
    await runtime.hydrateRouteForMap(route);
    assert.equal(calls, 3);
});

test('complete territory properties prime the same cache for later route opening', async () => {
    const runtime = createRouteHydrationRuntime({ functions: { invoke: async () => assert.fail('network is unnecessary') } });
    await runtime.hydrateRoutesForMap([route], 'rep@example.com', [property('house-1')]);
    const selected = await runtime.hydrateRouteForMap(route, 'rep@example.com');
    assert.equal(hasCompleteRouteMapPoints(selected), true);
});

test('large Run Route lookups respect the backend authorization batch cap', async () => {
    const sizes = [];
    const runtime = createRouteHydrationRuntime({ functions: { invoke: async (_name, body) => {
        sizes.push(body.address_hashes.length);
        assert.equal(body.route_id, route.id);
        return { data: { properties: body.address_hashes.map(property) } };
    } } });
    const large = { ...route, property_hashes: Array.from({ length: 6000 }, (_, index) => `house-${index}`) };
    const selected = await runtime.hydrateRouteForMap(large, 'rep@example.com');
    assert.equal(hasCompleteRouteMapPoints(selected), true);
    assert.deepEqual(sizes, [5000, 1000]);
});

test('timeouts and overload do not immediately retry the same endpoint through legacy workspace discovery', async () => {
    for (const status of [408, 429, 500, 503]) {
        let calls = 0;
        const result = await hydrateRouteWithLookup(route, async () => {
            calls++;
            throw Object.assign(new Error('Busy'), { status });
        });
        assert.equal(calls, 1);
        assert.equal(hasCompleteRouteMapPoints(result), false);
    }
});

test('offline network failures avoid a second expensive workspace lookup', async () => {
    for (const error of [Object.assign(new Error('Offline'), { code: 'ERR_NETWORK' }), new TypeError('Failed to fetch')]) {
        let calls = 0;
        const result = await hydrateRouteWithLookup(route, async () => { calls++; throw error; });
        assert.equal(calls, 1);
        assert.equal(hasCompleteRouteMapPoints(result), false);
    }
});

test('rep performance history is fetched on demand and has an explicit pending state', () => {
    const source = readFileSync(new URL('../src/pages/RepHome.jsx', import.meta.url), 'utf8');
    const analytics = source.slice(source.indexOf('// Fetch ALL logs by this rep for analytics'), source.indexOf('// The server mutation is authoritative'));
    assert.match(analytics, /enabled: !!user\?\.email && showAnalytics/);
    assert.match(source, /loading=\{analyticsLoading\}/);
    assert.match(source, /loadFailed=\{analyticsLoadFailed\}/);
});
