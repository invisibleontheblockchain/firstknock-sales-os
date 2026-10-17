import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as core from '../src/components/logic/routeHydrationCore.js';
import { mapWithConcurrency } from '../src/lib/mapWithConcurrency.js';
import { ANALYTICS_ROUTE_FIELDS, ANALYTICS_ROUTE_SCOPE_FIELDS, fetchAnalyticsRouteRows } from '../src/lib/analyticsLoading.js';

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
        savedRoutes: savedRoutes(), savedRouteMapManifestKey: 'manifest', effectiveProperties: [],
        effectivePropertiesRef: { current: [] },
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
    sandbox.effectivePropertiesRef.current = overviewHomes();
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
        savedRoutes: savedRoutes(), savedRouteMapManifestKey: 'manifest', effectiveProperties: [],
        effectivePropertiesRef: { current: [] }, territoryOverviewLoading: true,
        setServerHydratedSavedRoutes: () => {}, ...core, hydrateRoutesForMap: module.hydrateRoutesForMap,
    };
    vm.runInNewContext('globalThis.query = ' + homeRouteQuery(), sandbox);
    const routes = await sandbox.query.queryFn({ signal: new AbortController().signal });
    assert.equal(routes.length, 4);
    assert.ok(sandbox.query.queryKey.includes(true));
});

test('Home wires the overview state into saved-route hydration', () => {
    const source = read('src/pages/Home.jsx');
    assert.match(source, /isLoadingOverview: territoryOverviewLoading/);
    assert.match(source, /selectRoutesToHydrate\(savedRoutes, \{ overviewLoading: territoryOverviewLoading \}\)/);
    assert.match(source, /if \(incompleteCount && !territoryOverviewLoading\)/);
    // Deferred routes render from territory homes while they wait.
    assert.match(source, /hydratedProps\.length > 0 \? hydratedProps : routeHashes\s*\.map\(hash => propsByHash\.get\(hash\)\)/);
    // A selected route also starts from the homes already on the map.
    assert.match(source, /loadSavedRouteSelection\(activeRoute, effectivePropertiesRef\.current, route => hydrateRouteForMap\(route, user\.email\)\)/);
});

// --- Analytics (List.jsx) saved-route reads ---------------------------------

const user = { id: 'manager', email: 'boss@example.com' };
const repIds = ['manager', 'member-1'];
const analyticsRoutes = [
    { id: 'tenant-1', manager_id: 'manager', assigned_to: 'member-1', created_by: 'boss@example.com', created_date: '2026-10-05', property_hashes: ['a', 'b'] },
    { id: 'tenant-2', manager_id: 'manager', assigned_to: 'other', created_by: 'boss@example.com', created_date: '2026-10-04', property_hashes: ['c'] },
    // Legacy rows the tenant read cannot see.
    { id: 'legacy-assigned', assigned_to: 'member-1', created_by: 'rep@example.com', created_date: '2026-10-03', property_hashes: ['d'] },
    { id: 'legacy-created', created_by: 'boss@example.com', created_date: '2026-10-02', property_hashes: ['e'] },
    // Another tenant's routes are never shown.
    { id: 'foreign-assigned', manager_id: 'foreign', assigned_to: 'member-1', created_by: 'x@example.com', created_date: '2026-10-01', property_hashes: ['f'] },
    { id: 'foreign-created', manager_id: 'foreign', created_by: 'boss@example.com', created_date: '2026-09-30', property_hashes: ['g'] },
];
const listFilters = () => {
    const tenantFilter = { manager_id: 'manager' };
    return { filters: [{ assigned_to: repIds }, tenantFilter, { created_by: user.email }], tenantFilter };
};
// Same rule List.jsx applies after dedupe.
const belongs = route => route.manager_id === 'manager' || (!route.manager_id && route.created_by === user.email);
const isVisible = route => {
    const assignedToMe = route.assigned_to && repIds.includes(route.assigned_to);
    if (assignedToMe && (!route.manager_id || belongs(route))) return true;
    return belongs(route);
};

function routeStore(rows = analyticsRoutes) {
    const reads = [];
    const matches = (route, filter) => Object.entries(filter).every(([key, value]) => (
        Array.isArray(value) ? value.includes(route[key]) : value?.$in ? value.$in.includes(route[key]) : route[key] === value
    ));
    const readRoutes = async (filter, limit, fields) => {
        const out = rows.filter(route => matches(route, filter)).slice(0, limit)
            .map(route => Object.fromEntries(fields.filter(field => field in route).map(field => [field, route[field]])));
        reads.push({ filter, limit, fields, bytes: JSON.stringify(out).length });
        return out;
    };
    return { reads, readRoutes };
}

const dedupe = rows => [...new Map(rows.map(row => [row.id, row])).values()];

test('analytics route reads return the same routes as three full reads', async () => {
    const naive = routeStore();
    const { filters } = listFilters();
    const fullRows = (await Promise.all(filters.map(filter => naive.readRoutes(filter, 500, ANALYTICS_ROUTE_FIELDS)))).flat();
    const trimmed = routeStore();
    const rows = await fetchAnalyticsRouteRows(trimmed.readRoutes, { ...listFilters(), isVisible });

    assert.deepEqual(dedupe(rows).filter(isVisible), dedupe(fullRows).filter(isVisible));
    assert.deepEqual(dedupe(rows).filter(isVisible).map(route => route.id), ['tenant-1', 'legacy-assigned', 'tenant-2', 'legacy-created']);
    // Only the tenant read and the by-id fill-in carry full rows.
    assert.deepEqual(trimmed.reads.map(read => read.fields === ANALYTICS_ROUTE_FIELDS), [false, true, false, true]);
    assert.deepEqual(trimmed.reads[0].fields, ANALYTICS_ROUTE_SCOPE_FIELDS);
    assert.deepEqual(trimmed.reads[3].filter, { id: { $in: ['legacy-assigned', 'legacy-created'] } });
    assert.ok(trimmed.reads.reduce((sum, read) => sum + read.bytes, 0) < naive.reads.reduce((sum, read) => sum + read.bytes, 0));
});

test('analytics route reads skip the fill-in when the tenant read already has every route', async () => {
    const store = routeStore(analyticsRoutes.filter(route => !route.id.startsWith('legacy')));
    const rows = await fetchAnalyticsRouteRows(store.readRoutes, { ...listFilters(), isVisible });
    assert.equal(store.reads.length, 3);
    assert.deepEqual(dedupe(rows).filter(isVisible).map(route => route.id), ['tenant-1', 'tenant-2']);
    assert.ok(rows.every(route => 'property_hashes' in route));
});

test('analytics route reads keep a group whole when a visible row has no id, and reps read in full', async () => {
    const noId = { manager_id: 'manager', assigned_to: 'member-1', created_by: 'boss@example.com', created_date: '2026-10-06', property_hashes: ['z'] };
    const store = routeStore([...analyticsRoutes, noId]);
    const rows = await fetchAnalyticsRouteRows(store.readRoutes, { ...listFilters(), isVisible });
    assert.ok(rows.some(route => !route.id && route.property_hashes?.[0] === 'z'));
    assert.deepEqual(store.reads.map(read => read.fields === ANALYTICS_ROUTE_FIELDS), [false, true, false, true, true]);

    const rep = routeStore();
    const repRows = await fetchAnalyticsRouteRows(rep.readRoutes, { filters: [{ assigned_to: repIds }], tenantFilter: null, isVisible });
    assert.equal(rep.reads.length, 1);
    assert.equal(rep.reads[0].fields, ANALYTICS_ROUTE_FIELDS);
    assert.ok(repRows.every(route => 'property_hashes' in route));
});

test('List reads saved routes through the trimmed helper with its visibility rule', () => {
    const source = read('src/pages/List.jsx');
    assert.match(source, /fetchAnalyticsRouteRows\(\(filter, limit, fields\) => withReadDeadline\(\(\) => \(\s*base44\.entities\.SavedRoute\.filter\(filter, '-created_date', limit, 0, fields\)/);
    assert.match(source, /if \(tenantManagerId\) filters\.push\(tenantFilter = \{ manager_id: tenantManagerId \}\);/);
    assert.match(source, /return dedupeEntities\(rows\)\.filter\(isVisible\);/);
    assert.doesNotMatch(source, /SavedRoute\.filter\(\{ created_by: user\.email \}/);
});
