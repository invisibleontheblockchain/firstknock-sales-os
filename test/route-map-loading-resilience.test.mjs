import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { QueryClient } from '@tanstack/react-query';
import * as core from '../src/components/logic/routeHydrationCore.js';
import { mapWithConcurrency } from '../src/lib/mapWithConcurrency.js';
import { loadSavedRouteSelection } from '../src/components/logic/routeMapSelection.js';
import { filterRoutesByStatus, isRenderableMapPoint } from '../src/components/map/mapLayerVisibility.js';

const route = (id) => ({ id, manager_id: 'manager', property_hashes: [`${id}-house`] });
const property = (hash) => ({ address_hash: hash, lat: 28.7, lng: -81.3 });
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function hydrationModule(invoke) {
    const compiled = ts.transpileModule(read('src/components/logic/routeHydration.jsx'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText;
    const exports = {};
    vm.runInNewContext(compiled, {
        exports,
        require: name => ({
            '@/api/base44Client': { base44: { functions: { invoke } } },
            '@/lib/readRequest': { retryRead: read => read(), withReadDeadline: read => read() },
            '@/lib/mapWithConcurrency': { mapWithConcurrency },
            './routeHydrationCore.js': core,
        })[name],
    });
    return exports;
}

test('map publishes healthy routes before a slow route finishes', async () => {
    let release;
    const slow = new Promise(resolve => { release = resolve; });
    const loaded = [];
    const module = hydrationModule(async (_name, request) => {
        if (request.route_id === 'slow') await slow;
        return { data: { properties: request.address_hashes.map(property) } };
    });
    let settled = false;
    const pending = module.hydrateRoutesForMap([route('slow'), route('healthy')], 'manager@example.com', [], {
        onRouteHydrated: loadedRoute => loaded.push(loadedRoute.id),
    }).then(result => { settled = true; return result; });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(loaded, ['healthy']);
    assert.equal(settled, false);
    release();
    const result = await pending;
    assert.deepEqual(Array.from(result, item => item.id), ['slow', 'healthy']);
    assert.ok(result.every(core.hasCompleteRouteMapPoints));
});

test('failed map routes are repairable and do not reload healthy cached routes', async () => {
    let outage = true;
    const calls = [];
    const module = hydrationModule(async (_name, request) => {
        calls.push(request);
        const missing = request.address_hashes.includes('missing-house');
        return { data: { properties: outage && missing ? [] : request.address_hashes.map(property) } };
    });
    const routes = [route('healthy'), route('missing')];
    const first = await module.hydrateRoutesForMap(routes, 'manager@example.com');
    assert.equal(core.hasCompleteRouteMapPoints(first[0]), true);
    assert.equal(core.hasCompleteRouteMapPoints(first[1]), false);
    outage = false;
    const second = await module.hydrateRoutesForMap(routes, 'manager@example.com');
    assert.ok(second.every(core.hasCompleteRouteMapPoints));
    assert.equal(calls.filter(request => request.route_id === 'healthy').length, 1);
});

test('map preserves partial local pins while requesting only missing homes', async () => {
    const calls = [];
    const module = hydrationModule(async (_name, request) => {
        calls.push(request);
        return { data: { properties: request.address_hashes.map(property) } };
    });
    const saved = { ...route('partial'), property_hashes: ['local', 'remote'] };
    const result = await module.hydrateRoutesForMap([saved], 'manager@example.com', [
        { ...property('local'), effective_status: 'SOLD' },
    ]);
    assert.deepEqual(Array.from(calls[0].address_hashes), ['remote']);
    assert.deepEqual(result[0].properties.map(item => item.address_hash), ['local', 'remote']);
    assert.equal(result[0].properties[0].effective_status, 'SOLD');
});

test('cancelling map hydration stops queued requests and stale progress', async () => {
    let release;
    let continueLoading = true;
    const gate = new Promise(resolve => { release = resolve; });
    const calls = [];
    const progress = [];
    const module = hydrationModule(async (_name, request) => {
        calls.push(request);
        await gate;
        return { data: { properties: request.address_hashes.map(property) } };
    });
    const pending = module.hydrateRoutesForMap(Array.from({ length: 8 }, (_, index) => route(`route-${index}`)), 'manager@example.com', [], {
        shouldContinue: () => continueLoading,
        onRouteHydrated: loaded => progress.push(loaded.id),
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 4);
    continueLoading = false;
    release();
    await pending;
    assert.equal(calls.length, 4);
    assert.equal(progress.length, 0);
});

test('hydrated route caches remain viewer-scoped and publish progress on cache hits', async () => {
    const calls = [];
    const module = hydrationModule(async (_name, request) => {
        calls.push(request);
        return { data: { properties: request.address_hashes.map(property) } };
    });
    const routes = [route('shared')];
    await module.hydrateRoutesForMap(routes, 'manager@example.com');
    const progress = [];
    await module.hydrateRoutesForMap(routes, 'manager@example.com', [], { onRouteHydrated: loaded => progress.push(loaded.id) });
    assert.deepEqual(progress, ['shared']);
    assert.equal(calls.length, 1);
    await module.hydrateRoutesForMap(routes, 'rep@example.com');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].user_email, 'rep@example.com');
});

function queryDescriptor(text, name) {
    const ast = ts.createSourceFile('component.jsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    let descriptor;
    function visit(node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast).includes(name)
            && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(ast) === 'useQuery') {
            descriptor = node.initializer.getText(ast);
        }
        ts.forEachChild(node, visit);
    }
    visit(ast);
    return descriptor;
}

test('Home retries incomplete collections while keeping loaded map pins', async () => {
    let attempt = 0;
    let displayed = [];
    const routes = [route('healthy'), route('missing')];
    const sandbox = {
        useQuery: config => config,
        user: { id: 'manager', email: 'manager@example.com' }, savedRoutes: routes,
        savedRouteMapManifestKey: 'healthy|missing', effectiveProperties: [], effectivePropertiesRef: { current: [] },
        setServerHydratedSavedRoutes: update => { displayed = update(displayed); },
        ...core,
        hydrateRoutesForMap: async (_routes, _email, _properties, { onRouteHydrated }) => {
            const currentAttempt = ++attempt;
            const hydrated = routes.map(saved => currentAttempt === 1 && saved.id === 'missing'
                ? saved : core.orderRouteProperties(saved, saved.property_hashes.map(property)));
            hydrated.forEach(onRouteHydrated);
            return hydrated;
        },
    };
    vm.runInNewContext('globalThis.query = ' + queryDescriptor(read('src/pages/Home.jsx'), 'savedRoutePinsLoading'), sandbox);
    const client = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } });
    try {
        const result = await client.fetchQuery(sandbox.query);
        assert.equal(attempt, 2);
        assert.ok(result.every(core.hasCompleteRouteMapPoints));
        assert.ok(displayed.every(core.hasCompleteRouteMapPoints));
    } finally { client.clear(); }
});

test('Route Command keeps the route list open when homes cannot load', async () => {
    const text = read('src/components/routes/RouteCommandPanel.jsx');
    const ast = ts.createSourceFile('RouteCommandPanel.jsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    let handler;
    function visit(node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'selectRouteForMapAndKnock') handler = node.initializer.getText(ast);
        ts.forEachChild(node, visit);
    }
    visit(ast);
    const messages = [];
    const sandbox = {
        loadSavedRouteSelection, viewerEmail: 'manager@example.com',
        hydrateRouteForMap: async saved => saved,
        toast: { error: message => messages.push(message) },
        localStorage: { setItem: () => assert.fail('Failed opens must not change the selected route') },
        onSelectRoute: () => assert.fail('Failed opens must not close Route Command'),
    };
    vm.runInNewContext('globalThis.select = ' + handler, sandbox);
    await sandbox.select(route('unavailable'));
    assert.equal(messages.length, 1);
    assert.match(messages[0], /could not be loaded/);
});

test('returning to the map immediately displays pins from a warm query cache', () => {
    const text = read('src/pages/Home.jsx');
    const ast = ts.createSourceFile('Home.jsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    let derive;
    function visit(node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'hydratedSavedRoutes') derive = node.initializer.getText(ast);
        ts.forEachChild(node, visit);
    }
    visit(ast);
    const saved = route('cached');
    const cached = core.orderRouteProperties(saved, saved.property_hashes.map(property));
    const sandbox = {
        useMemo: callback => callback(), savedRoutes: [saved], serverHydratedSavedRoutes: [],
        cachedHydratedSavedRoutes: [cached], effectiveProperties: [], logs: [], repFilter: 'all',
        buildLogsByAddress: () => new Map(), withDerivedStatus: properties => properties,
        ...core, filterRoutesByStatus, isRenderableMapPoint,
    };
    vm.runInNewContext('globalThis.displayed = ' + derive, sandbox);
    assert.equal(sandbox.displayed.length, 1);
    assert.equal(sandbox.displayed[0].properties.length, 1);
    assert.equal(sandbox.displayed[0].properties[0].address_hash, 'cached-house');
});
