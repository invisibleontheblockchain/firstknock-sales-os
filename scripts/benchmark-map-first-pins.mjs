// Fixture benchmark: when do the map pins of the area the person works become
// visible on a cold load? Runs Home's real saved-route pin query and the real
// route hydration (src/components/logic/routeHydration.jsx) against a modeled
// throttled-mobile network. No account or server is involved.
//
//   node scripts/benchmark-map-first-pins.mjs [repoRoot]
//
// Model (Slow-4G-class phone, a manager like the owner's account):
// - 17 saved routes (184-1000 stops), newest first; the person works route 11.
// - The route list arrives at 1.5 s, the capped territory bootstrap at 2.5 s
//   (it holds none of these routes' homes), the 20K-home overview at 22 s
//   (it holds every route home).
// - Each home lookup costs 0.4 s + 1.2 s per 1,000 homes; 4 run at once.
// - Each route record carries its saved driving path (route metadata).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] || '.');
const read = file => readFileSync(path.join(root, file), 'utf8');
const core = await import(pathToFileURL(path.join(root, 'src/components/logic/routeHydrationCore.js')).href);
const { mapWithConcurrency } = await import(pathToFileURL(path.join(root, 'src/lib/mapWithConcurrency.js')).href);
const SCALE_MS = 10; // real milliseconds per simulated second
const sleep = seconds => new Promise(resolve => setTimeout(resolve, seconds * SCALE_MS));
let started = 0;
const now = () => (performance.now() - started) / SCALE_MS;

const working = { lat: 35.47, lng: -81.25 };
const sizes = [420, 1000, 260, 184, 610, 1000, 350, 290, 520, 800, 184, 700, 300, 450, 990, 220, 640];
const routes = sizes.map((size, i) => {
    const center = i === 10 ? working : { lat: 25 + i * 0.9, lng: -82 + i * 0.2 };
    return { id: `r${i}`, status: 'ACTIVE', updated_date: '2026-10-01', manager_id: 'manager',
        property_hashes: Array.from({ length: size }, (_, k) => `r${i}-${k}`),
        metadata: { road_geometry_segments: [{ points: [center, { lat: center.lat + 0.01, lng: center.lng }] }] },
        _center: center };
});
const homeOf = hash => {
    const route = routes[Number(hash.slice(1, hash.indexOf('-')))];
    return { address_hash: hash, lat: route._center.lat + Math.random() / 100, lng: route._center.lng + Math.random() / 100 };
};

function hydrationModule(invoke) {
    const exports = {};
    vm.runInNewContext(ts.transpileModule(read('src/components/logic/routeHydration.jsx'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
        exports, require: name => ({ '@/api/base44Client': { base44: { functions: { invoke } } },
            '@/lib/readRequest': { withReadDeadline: fn => fn() }, '@/lib/mapWithConcurrency': { mapWithConcurrency },
            './routeHydrationCore.js': core })[name] });
    return exports;
}
function homeQuery() {
    const text = read('src/pages/Home.jsx');
    const ast = ts.createSourceFile('Home.jsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    let descriptor;
    (function visit(node) {
        if (ts.isVariableDeclaration(node) && node.name.getText(ast).includes('savedRoutePinsLoading')
            && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(ast) === 'useQuery') descriptor = node.initializer.getText(ast);
        ts.forEachChild(node, visit);
    })(ast);
    return ts.transpileModule(`globalThis.query = ${descriptor}`, { compilerOptions: { jsx: ts.JsxEmit.React } }).outputText;
}

const invoke = async (name, body) => {
    await sleep(0.4 + 1.2 * body.address_hashes.length / 1000);
    return { data: { properties: body.address_hashes.map(homeOf) } };
};
const hydration = hydrationModule(invoke);
let displayed = [];
const visibleAt = new Map();
const sandbox = {
    useQuery: config => config, user: { id: 'manager', email: `manager-${Date.now()}@example.com` },
    savedRoutes: routes, savedRouteMapManifestKey: 'm', territoryMapRows: [], routeHomeRowsRef: { current: [] },
    mapRef: { current: { getCenter: () => working } }, readStoredMapView: () => ({ center: [working.lat, working.lng], zoom: 15 }),
    territoryOverviewLoading: true,
    setServerHydratedSavedRoutes: update => {
        displayed = update(displayed);
        for (const route of displayed) if (!visibleAt.has(route.id) && core.hasCompleteRouteMapPoints(route)) visibleAt.set(route.id, now());
    },
    ...core, hydrateRoutesForMap: hydration.hydrateRoutesForMap,
};
vm.runInNewContext(homeQuery(), sandbox);

started = performance.now();
await sleep(2.5); // route list + territory bootstrap
const early = sandbox.query.queryFn({ signal: new AbortController().signal }).catch(() => {});
await sleep(22 - 2.5); // the overview lands with every route home
sandbox.routeHomeRowsRef.current = routes.flatMap(route => route.property_hashes.map(homeOf));
// Home renders a route straight from territory homes once the overview holds them.
for (const route of routes) if (!visibleAt.has(route.id)) visibleAt.set(route.id, now());
sandbox.territoryOverviewLoading = false;
vm.runInNewContext(homeQuery(), sandbox);
await sandbox.query.queryFn({ signal: new AbortController().signal }).catch(() => {});
await early;
const workingAt = visibleAt.get('r10');
const all = Math.max(...visibleAt.values());
console.log(JSON.stringify({ root: path.basename(root), working_route_pins_visible_s: workingAt === undefined ? null : Math.round(workingAt * 10) / 10,
    routes_visible_before_overview: [...visibleAt.values()].filter(t => t < 22).length, all_routes_visible_s: Math.round(all * 10) / 10 }));
