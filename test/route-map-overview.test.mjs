import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as core from '../src/components/logic/routeHydrationCore.js';
import { filterRoutesByStatus, isRenderableMapPoint } from '../src/components/map/mapLayerVisibility.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const groups = [];
const leaflet = {
    latLngBounds(points) {
        const stored = [...points];
        return { points: stored, isValid: () => stored.length > 0 };
    },
    layerGroup() {
        const layers = [];
        const group = { layers, addTo: () => group, addLayer: layer => layers.push(layer), removeLayer: layer => layers.splice(layers.indexOf(layer), 1) };
        groups.push(group);
        return group;
    },
    circleMarker: (point, options) => ({ point, options, on() {}, setRadius() {} }),
    marker: (point, options) => ({ point, options }),
    divIcon: options => options,
    polyline: (points, options) => ({ points, options, on() {} }),
    DomEvent: { stopPropagation() {} },
};
const storage = new Map();
const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) };
function moduleAt(path, imports) {
    const exports = {};
    vm.runInNewContext(ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
        exports, require: name => imports[name], localStorage,
    });
    return exports;
}
const workingArea = moduleAt('src/lib/accountWorkingArea.js', {
    '@/components/map/leafletPatches': { default: leaflet },
    '@/components/map/mapLayerVisibility.js': { isRenderableMapPoint },
    '@/components/logic/routeHydrationCore.js': core,
});
const layer = moduleAt('src/components/map/savedRouteLayer.js', {
    leaflet: { default: leaflet }, '@/components/logic/outcomeStatus': { outcomeColor: () => '#FFFFFF' },
});
const routes = Array.from({ length: 17 }, (_, index) => ({
    id: `route-${index}`, status: 'ACTIVE', property_hashes: [`house-${index}`],
    properties: [{ address_hash: `house-${index}`, lat: 25 + index / 2, lng: -82 }],
}));

test('the map opens on the working area, never zoomed out to every route', () => {
    storage.clear();
    const user = { id: 'owner' };
    const resolve = (hydratedSavedRoutes, extra = {}) => workingArea.computeAccountWorkingArea({
        user, savedRoutes: routes, hydratedSavedRoutes, savedRoutesReady: true, ...extra,
    });
    // No stored view: one route — the first active one — as soon as its pins load.
    assert.equal(resolve([]), null, 'waits for that route, not for all 17');
    const first = resolve(routes.slice(0, 1));
    assert.equal(first.type, 'bounds');
    assert.equal(JSON.stringify(first.bounds.points), '[[25,-82]]', 'one route, not the 17-route overview');
    assert.equal(workingArea.computeAccountWorkingArea({ user, savedRoutes: routes, savedRoutesReady: false, hydratedSavedRoutes: routes }), null,
        'waits for the route list');
    // A completed route is skipped for the active one.
    const withDone = [{ ...routes[0], status: 'COMPLETED' }, ...routes.slice(1)];
    assert.equal(JSON.stringify(workingArea.computeAccountWorkingArea({ user, savedRoutes: withDone, savedRoutesReady: true,
        hydratedSavedRoutes: withDone }).bounds.points), '[[25.5,-82]]');
    // The last view the person moved to wins, instantly, with no data loaded.
    workingArea.storeMapView(user, { lat: 35.4, lng: -80.8 }, 16);
    assert.equal(JSON.stringify(workingArea.computeAccountWorkingArea({ user, savedRoutesReady: false })),
        JSON.stringify({ type: 'center', center: [35.4, -80.8], zoom: 16 }));
    assert.deepEqual(workingArea.readStoredMapView({ id: 'someone-else' }), null, 'per user');
    // Nothing known at all: where the person is, when shared.
    storage.clear();
    assert.equal(JSON.stringify(workingArea.computeAccountWorkingArea({ user, savedRoutes: [], savedRoutesReady: true, gpsLocation: { lat: 35, lng: -81 } })),
        JSON.stringify({ type: 'center', center: [35, -81], zoom: 15 }));
});

test('the camera follows the person: only their own moves are remembered, and nothing moves it after they touch the map', () => {
    const home = read('src/pages/Home.jsx');
    assert.doesNotMatch(home, /preferSavedRoutes/, 'no automatic fit to every saved route');
    assert.match(home, /if \(hasCenteredAccountWorkingAreaRef\.current \|\| userMovedMapRef\.current \|\| !mapRef\.current\) return;/);
    assert.match(home, /<MapUserIntent onIntent=\{markUserMovedMap\} \/>/);
    assert.match(home, /if \(userMovedMapRef\.current\) storeMapView\(user, c, z\);/);
    assert.match(home, /center=\{initialMapView\.center\}[\s\S]{0,40}zoom=\{initialMapView\.zoom\}/);
    const toolbar = read('src/components/map/MapToolbar.jsx');
    assert.match(toolbar, /"Show all routes"/, 'seeing every route is an explicit button');
});

test('wide zoom keeps all 17 saved route markers without drawing thousands of door details', () => {
    groups.length = 0;
    const source = read('src/components/map/ManagerMapLayers.jsx');
    const ast = ts.createSourceFile('ManagerMapLayers.jsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    const functionNode = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'SavedRoutesLayer');
    const effects = [];
    let stateIndex = 0;
    const viewBox = { north: 40, south: 20, east: -70, west: -90 };
    const bounds = { getNorth: () => 40, getSouth: () => 20, getEast: () => -70, getWest: () => -90 };
    const map = { getBounds: () => bounds, on() {}, off() {} };
    const useMemo = fn => fn();
    const useEffect = fn => effects.push(fn);
    const sandbox = {
        L: leaflet, useMap: () => map, useMemo, useEffect, useRef: value => ({ current: value }),
        React: { useState: () => [stateIndex++ === 0 ? viewBox : null, () => {}], useEffect },
        createLabelCanvas: () => ({ circleMarker: leaflet.circleMarker }),
        zoomAdjustedPinSize: () => 2,
        savedRouteStyleKey: layer.savedRouteStyleKey, buildSavedRouteGroup: layer.buildSavedRouteGroup,
        isRenderableMapPoint, filterRoutesByStatus,
        getRouteColor: () => '#FFD700', getRouteLinePoints: (_route, properties) => properties,
        verifiedRouteSegments: () => [],
    };
    vm.createContext(sandbox);
    vm.runInContext(ts.transpileModule(functionNode.getText(ast), { compilerOptions: { module: ts.ModuleKind.None } }).outputText, sandbox);
    sandbox.SavedRoutesLayer({ mode: 'analyze', zoomLevel: 7, hydratedSavedRoutes: routes, allSavedRoutes: routes,
        analyzeZipFilter: 'all', quickFilter: 'all', showRouteDetails: true, showRouteLines: true,
        routeStatusView: 'all', pinSize: 2, mapSettings: {}, setActiveRoute() {} });
    effects.forEach(effect => effect());
    const container = groups[0];
    assert.equal(container.layers.length, 17);
    assert.ok(container.layers.every(group => group.layers.length === 2));
    const routeMarkers = container.layers.flatMap(group => group.layers).filter(marker => marker.options.icon);
    assert.equal(routeMarkers.length, 17);
    assert.ok(routeMarkers.some(marker => marker.options.icon.html.includes('#17')));
});

test('Home places the camera once, only when the working area is known, and never after the person moves the map', () => {
    const source = read('src/pages/Home.jsx');
    const ast = ts.createSourceFile('Home.jsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    let effect;
    function visit(node) {
        if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
            && node.arguments[0].getText(ast).includes('hasCenteredAccountWorkingAreaRef.current = true')) {
            effect = node.arguments[0].getText(ast);
        }
        ts.forEachChild(node, visit);
    }
    visit(ast);
    let fits = 0, known = false;
    const ref = { current: false }, moved = { current: false };
    const context = {
        activeRoute: null, window: { location: { search: '' } }, URLSearchParams,
        hasCenteredAccountWorkingAreaRef: ref, userMovedMapRef: moved,
        mapRef: { current: { _mapPane: {}, fitBounds() { fits++; } } },
        // The resolver returns null until the data it needs (the route list,
        // then that one route's pins) has loaded.
        resolveAccountWorkingArea: () => (known ? { type: 'bounds', bounds: { isValid: () => true } } : null),
    };
    vm.createContext(context);
    vm.runInContext(`(${effect})()`, context);
    assert.equal(fits, 0);
    assert.equal(ref.current, false);
    known = true;
    vm.runInContext(`(${effect})()`, context);
    assert.equal(fits, 1);
    assert.equal(ref.current, true);
    vm.runInContext(`(${effect})()`, context);
    assert.equal(fits, 1, 'once');
    // Someone who has already dragged or zoomed is never moved by a late load.
    ref.current = false; moved.current = true;
    vm.runInContext(`(${effect})()`, context);
    assert.equal(fits, 1);
});
