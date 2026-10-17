import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as core from '../src/components/logic/routeHydrationCore.js';
import { mapWithConcurrency } from '../src/lib/mapWithConcurrency.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const home = (hash, extra = {}) => ({ address_hash: hash, lat: 28.7, lng: -81.3, ...extra });

function hydrationModule(invoke) {
    const compiled = ts.transpileModule(read('src/components/logic/routeHydration.jsx'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText;
    const exports = {};
    vm.runInNewContext(compiled, {
        exports,
        require: name => ({
            '@/api/base44Client': { base44: { functions: { invoke } } },
            '@/lib/readRequest': { withReadDeadline: read => read() },
            '@/lib/mapWithConcurrency': { mapWithConcurrency },
            './routeHydrationCore.js': core,
        })[name],
    });
    return exports;
}

function homeRouteQuery() {
    const text = read('src/pages/Home.jsx');
    const ast = ts.createSourceFile('Home.jsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    let descriptor;
    (function visit(node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast).includes('savedRoutePinsLoading')
            && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(ast) === 'useQuery') {
            descriptor = node.initializer.getText(ast);
        }
        ts.forEachChild(node, visit);
    })(ast);
    assert.ok(descriptor, 'Home saved-route map query not found');
    return descriptor;
}

// Six saved routes of 10 homes; the overview holds 8 of each route's homes.
const ROUTE_COUNT = 6;
const savedRoutes = () => Array.from({ length: ROUTE_COUNT }, (_, r) => ({
    id: `r${r}`, manager_id: 'manager', status: r === 4 ? 'IN_PROGRESS' : 'ACTIVE',
    property_hashes: Array.from({ length: 10 }, (_, k) => (k < 8 ? `r${r}-in-${k}` : `r${r}-out-${k}`)),
}));
const overviewHomes = () => savedRoutes().flatMap(route => route.property_hashes.filter(hash => hash.includes('-in-')).map(hash => home(hash, { source: 'overview' })));

function backend({ omit = new Set() } = {}) {
    const calls = [];
    const invoke = async (name, body) => {
        assert.equal(name, 'getRoutePropertiesByHashes');
        calls.push(body);
        return { data: { properties: body.address_hashes.filter(hash => !omit.has(hash)).map(hash => home(hash, { source: 'lookup' })) } };
    };
    return { calls, invoke };
}

// Runs Home's real saved-route query the way the map does: once while the
// overview loads (bootstrap homes only), then again once it settles.
async function openMap({ invoke, deferUntilOverview = true }) {
    const module = hydrationModule(invoke);
    let displayed = [];
    const sandbox = {
        useQuery: config => config,
        user: { id: 'manager', email: 'manager@example.com' },
        savedRoutes: savedRoutes(), savedRouteMapManifestKey: 'manifest', territoryMapRows: [],
        routeHomeRowsRef: { current: [] },
        territoryOverviewLoading: true,
        setServerHydratedSavedRoutes: update => { displayed = update(displayed); },
        ...core,
        hydrateRoutesForMap: module.hydrateRoutesForMap,
    };
    if (!deferUntilOverview) sandbox.selectRoutesToHydrate = routes => routes;
    vm.runInNewContext('globalThis.query = () => (' + homeRouteQuery() + ')', sandbox);
    const signal = new AbortController().signal;
    const early = await sandbox.query().queryFn({ signal });
    sandbox.territoryOverviewLoading = false;
    sandbox.routeHomeRowsRef.current = overviewHomes();
    const settled = sandbox.query();
    const result = await settled.queryFn({ signal }).then(routes => ({ routes }), error => ({ error }));
    return { early, ...result, displayed, queryKey: settled.queryKey };
}

test('before the overview settles only the newest, in-progress and imported routes are looked up', () => {
    const routes = [
        ...savedRoutes(),
        { id: 'import', status: 'ACTIVE', metadata: { source: 'csv_import' }, property_hashes: ['import_1'] },
        { id: 'redfin', status: 'ACTIVE', property_hashes: ['import_2'] },
    ];
    assert.deepEqual(core.selectRoutesToHydrate(routes, { overviewLoading: true }).map(route => route.id), ['r0', 'r1', 'r2', 'r4', 'import', 'redfin']);
    assert.equal(core.selectRoutesToHydrate(routes, { overviewLoading: false }), routes);
    assert.deepEqual(core.selectRoutesToHydrate(null, { overviewLoading: true }), []);
});

test('the map downloads only homes the territory overview does not already hold', async () => {
    const before = backend();
    const old = await openMap({ invoke: before.invoke, deferUntilOverview: false });
    const after = backend();
    const now = await openMap({ invoke: after.invoke });

    const requested = calls => calls.reduce((count, call) => count + call.address_hashes.length, 0);
    // Old behaviour: every route was looked up whole before the overview arrived.
    assert.equal(before.calls.length, ROUTE_COUNT);
    assert.equal(requested(before.calls), ROUTE_COUNT * 10);
    // Now: 4 early routes whole, then the 2 others ask only for their 2 homes outside the overview.
    assert.equal(after.calls.length, ROUTE_COUNT);
    assert.equal(requested(after.calls), 4 * 10 + 2 * 2);
    for (const call of after.calls.slice(4)) {
        assert.ok(call.address_hashes.every(hash => hash.includes('-out-')), call.address_hashes.join(','));
    }
    // Every lookup stays route-scoped.
    assert.deepEqual(after.calls.map(call => call.route_id).sort(), savedRoutes().map(route => route.id).sort());
    assert.ok(after.calls.every(call => call.user_email === 'manager@example.com'));

    // Same pins and counts as before.
    assert.ok(!now.error && !old.error);
    assert.deepEqual(now.early.map(route => route.id), ['r0', 'r1', 'r2', 'r4']);
    const pins = routes => Object.fromEntries(routes.map(route => [route.id, route.properties.map(property => property.address_hash)]));
    assert.deepEqual(pins(now.routes), pins(old.routes));
    assert.ok(now.routes.every(core.hasCompleteRouteMapPoints));
    assert.deepEqual(now.routes.map(route => route.houseCount), old.routes.map(route => route.houseCount));
    assert.deepEqual(pins(now.displayed), pins(old.displayed));
    // Deferred routes keep the overview's rows (the freshest in-memory status).
    const deferred = now.routes.find(route => route.id === 'r3');
    assert.ok(deferred.properties.filter(property => property.address_hash.includes('-in-')).every(property => property.source === 'overview'));
    assert.ok(now.queryKey.includes(false), 'the settled pass is a separate query');
});

test('a partial lookup still surfaces as an incomplete route and is retried for just its missing homes', async () => {
    const lost = 'r3-out-9';
    const first = backend({ omit: new Set([lost]) });
    const result = await openMap({ invoke: first.invoke });
    assert.match(result.error?.message || '', /1 route could not load all homes/);
    // The route-scoped read and its workspace fallback ask for r3's two outside homes only.
    const r3Calls = first.calls.filter(call => call.address_hashes.some(hash => hash.startsWith('r3-')));
    assert.deepEqual(r3Calls.map(call => [call.route_id ?? null, call.address_hashes]), [
        ['r3', ['r3-out-8', 'r3-out-9']],
        [null, ['r3-out-8', 'r3-out-9']],
    ]);
    // Loaded pins stay on the map; the partial result is not cached.
    const displayedR3 = result.displayed.find(route => route.id === 'r3');
    assert.equal(displayedR3.properties.length, 8);
    assert.equal(displayedR3.houseCount, 10);
});

test('the early pass does not report routes it has not looked up yet', async () => {
    const { invoke } = backend();
    const module = hydrationModule(invoke);
    const sandbox = {
        useQuery: config => config, user: { id: 'manager', email: 'early@example.com' },
        savedRoutes: savedRoutes(), savedRouteMapManifestKey: 'manifest', territoryMapRows: [],
        routeHomeRowsRef: { current: [] }, territoryOverviewLoading: true,
        setServerHydratedSavedRoutes: () => {}, ...core, hydrateRoutesForMap: module.hydrateRoutesForMap,
    };
    vm.runInNewContext('globalThis.query = ' + homeRouteQuery(), sandbox);
    const routes = await sandbox.query.queryFn({ signal: new AbortController().signal });
    assert.equal(routes.length, 4);
    assert.ok(sandbox.query.queryKey.includes(true));
});

function homeMemo(text, name) {
    const ast = ts.createSourceFile('Home.jsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    let found;
    (function visit(node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = node.getText(ast);
        ts.forEachChild(node, visit);
    })(ast);
    assert.ok(found, `${name} not found`);
    return found;
}

test('route hydration sees homes the map display dedupes by address', async () => {
    const source = read('src/pages/Home.jsx');
    const sandbox = {
        useMemo: fn => fn(), console: { log() {} }, determineEffectiveStatus: () => 'ELIGIBLE',
        user: { territory_zip_codes: [] }, drawnPolygon: null, zipCodeFilter: '', logs: [], assignedHashes: new Set(),
        properties: [
            // Two units at one number|street|zip, and a Phase1/Phase2 duplicate pair.
            home('unit-a', { house_number: '10', street_name: 'Oak St', zip_code: '32801', unit: 'A' }),
            home('unit-b', { house_number: '10', street_name: 'Oak St', zip_code: '32801', unit: 'B' }),
            home('phase1', { house_number: '22', street_name: 'Elm St', zip_code: '32801', sold_date: '2026-01-01' }),
            home('phase2', { house_number: '22', street_name: 'Elm St', zip_code: '32801', sold_date: '2026-02-01' }),
        ],
    };
    vm.runInNewContext(`${homeMemo(source, 'territoryMapRows')};\n${homeMemo(source, 'effectiveProperties')};\n`
        + 'globalThis.rows = territoryMapRows; globalThis.shown = effectiveProperties;', sandbox);
    assert.deepEqual(Array.from(sandbox.shown, p => p.address_hash), ['unit-a', 'phase2']);
    assert.deepEqual(Array.from(sandbox.rows, p => p.address_hash), ['unit-a', 'unit-b', 'phase1', 'phase2']);

    const { calls, invoke } = backend();
    const module = hydrationModule(invoke);
    const route = { id: 'dupes', property_hashes: ['unit-b', 'phase1'] };
    const fromRows = await module.hydrateRoutesForMap([route], 'manager@example.com', sandbox.rows);
    assert.equal(calls.length, 0, 'every route home was already on the map');
    assert.ok(core.hasCompleteRouteMapPoints(fromRows[0]));
    // The deduped display set would have sent both homes to the server.
    await hydrationModule(invoke).hydrateRoutesForMap([route], 'manager@example.com', sandbox.shown);
    assert.deepEqual(calls.map(call => call.address_hashes), [['unit-b', 'phase1']]);
});

test('Home wires the overview state into saved-route hydration', () => {
    const source = read('src/pages/Home.jsx');
    assert.match(source, /isLoadingOverview: territoryOverviewLoading/);
    assert.match(source, /selectRoutesToHydrate\(savedRoutes, \{ overviewLoading: territoryOverviewLoading \}\)/);
    assert.match(source, /if \(incompleteCount && !territoryOverviewLoading\)/);
    // Hydration reads the territory rows from before the address dedupe.
    assert.match(source, /hydrateRoutesForMap\(routesToHydrate, user\.email, routeHomeRowsRef\.current/);
    assert.match(source, /routeHomeRowsRef\.current = territoryMapRows;/);
    // Deferred routes render from territory homes while they wait.
    assert.match(source, /hydratedProps\.length > 0 \? hydratedProps : routeHashes\s*\.map\(hash => propsByHash\.get\(hash\)\)/);
    // A selected route also starts from the homes already on the map.
    assert.match(source, /loadSavedRouteSelection\(activeRoute, routeHomeRowsRef\.current, route => hydrateRouteForMap\(route, user\.email\)\)/);
});
