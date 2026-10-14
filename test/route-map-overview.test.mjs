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
function moduleAt(path, imports) {
    const exports = {};
    vm.runInNewContext(ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
        exports, require: name => imports[name], localStorage: { getItem: () => null },
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

test('route overview waits for all 17 manifests instead of centering on the first seven', () => {
    const resolve = hydratedSavedRoutes => workingArea.computeAccountWorkingArea({
        savedRoutes: routes, hydratedSavedRoutes, preferSavedRoutes: true,
        drawnPolygon: [[0, 1], [1, 1], [1, 2]],
    });
    assert.equal(resolve(routes.slice(0, 7)), null);
    const complete = resolve(routes);
    assert.equal(complete.type, 'bounds');
    assert.equal(complete.bounds.points.length, 17);
    assert.ok(complete.bounds.points.some(point => point[0] === 25));
    assert.ok(complete.bounds.points.some(point => point[0] === 33));
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
        verifiedBetaSegments: () => null,
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

