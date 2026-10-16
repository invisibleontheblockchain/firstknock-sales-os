import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as visibility from '../src/components/map/mapLayerVisibility.js';

const doors = [{ address_hash: 'west', lat: 35.8, lng: -80.9 },
    { address_hash: 'east', lat: 35.8, lng: -80.89 }, { address_hash: 'south', lat: 35.79, lng: -80.9 }];
const road = [{ lat: 35.8, lng: -80.895 }, { lat: 35.795, lng: -80.895 }, { lat: 35.79, lng: -80.895 }];
const positions = doors.map(p => [p.lat, p.lng]);
const plain = value => JSON.parse(JSON.stringify(value));

function renderModule(path) {
    const source = readFileSync(new URL('../' + path, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    const imports = {}, effects = [], groups = [];
    for (const declaration of ast.statements.filter(ts.isImportDeclaration)) {
        const values = {};
        if (declaration.importClause?.name) values.default = declaration.importClause.name.text;
        for (const binding of declaration.importClause?.namedBindings?.elements || []) {
            values[binding.propertyName?.text || binding.name.text] = binding.name.text;
        }
        imports[declaration.moduleSpecifier.text] = values;
    }
    const hooks = { useMemo: fn => fn(), useEffect: fn => effects.push(fn), useRef: value => ({ current: value }),
        useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}] };
    const react = { ...hooks, memo: component => component,
        createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
    const bounds = { getNorth: () => 40, getSouth: () => 30, getEast: () => -70, getWest: () => -90, pad() { return this; } };
    const map = { getZoom: () => 18, getBounds: () => bounds, on() {}, off() {} };
    const leaflet = { Map: { prototype: {} }, DomUtil: {}, DomEvent: { stopPropagation() {} }, canvas: () => ({}),
        layerGroup() {
            const group = { layers: [], addTo: () => group, addLayer: item => group.layers.push(item), removeLayer() {} };
            groups.push(group); return group;
        },
        polyline: (points, options) => ({ type: 'line', points, options, on() {}, bringToBack() {} }),
    };
    imports.react = { ...hooks, default: react };
    imports.leaflet = { default: leaflet };
    imports['react-leaflet'] = { ...imports['react-leaflet'], useMap: () => map };
    imports['./mapLayerVisibility.js'] = visibility;
    imports['./labelCanvas'] = { createLabelCanvas: () => ({}) };
    imports['./densePinSize'] = { resolvePinSize: () => 3, zoomAdjustedPinSize: () => 3 };
    imports['@/components/map/mapPinThemes'] = { DEFAULT_PIN_THEME: { settings: { lineStyle: 'dashed' } } };
    const exports = {};
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React,
    } }).outputText, { exports, require: name => imports[name], localStorage: { getItem: () => null },
        clearTimeout() {}, setTimeout() {}, console });
    return { exports, effects, groups };
}

function flatten(element) {
    if (Array.isArray(element)) return element.flatMap(flatten);
    if (!element || typeof element !== 'object') return [];
    return [element, ...flatten(element.props?.children)];
}

for (const beta of [false, true]) {
    const route = { property_hashes: doors.map(p => p.address_hash), properties: doors,
        metadata: { road_path_validated: true, road_geometry: road, road_geometry_segments: [{ points: road }],
            routing: { road_aware_routing_beta: beta } } };
    test(`manager active ${beta ? 'beta' : 'standard'} route connects house pins directly despite stored road geometry`, () => {
        const { exports, effects, groups } = renderModule('src/components/map/ManagerMapLayers.jsx');
        exports.ActiveRouteLayer({ activeRoute: route, mapSettings: {}, pinSize: 3 });
        effects.forEach(effect => effect());
        const line = groups.flatMap(group => group.layers).find(item => item.type === 'line');
        assert.deepEqual(plain(line.points), positions);
        assert.equal(line.options.dashArray, '4,6');
    });

    test(`manager preview ${beta ? 'beta' : 'standard'} route keeps the same direct stop-order display`, () => {
        const { exports } = renderModule('src/components/map/ManagerMapLayers.jsx');
        const tree = exports.default({ mode: 'analyze', routeMode: 'precision', previewRoute: route,
            zoomLevel: 18, viewMode: 'pins', darkRoomProperties: [], darkRoomClusters: [], BRAND: { gold: 'yellow' } });
        const line = flatten(tree).find(element => element.type === 'Polyline');
        assert.deepEqual(plain(line.props.positions), positions);
        assert.equal(line.props.pathOptions.dashArray, '5,10');
    });

    test(`rep ${beta ? 'beta' : 'standard'} route displays crow-flies order without road-shape substitution`, () => {
        const { exports } = renderModule('src/components/rep/RepMapView.jsx');
        const tree = exports.default({ properties: doors, roadMetadata: route.metadata, roadGeometry: road });
        const lines = flatten(tree).filter(element => element.type === 'Polyline');
        assert.equal(lines.length, 1);
        assert.deepEqual(plain(lines[0].props.positions), positions);
        assert.equal(lines[0].props.pathOptions.dashArray, '8,6');
    });
}

test('saved-route overview ignores road segments and draws direct dashed stop connectors', () => {
    const { exports } = renderModule('src/components/map/savedRouteLayer.js');
    const { group } = exports.buildSavedRouteGroup({ doors: [], linePoints: doors, lineSegments: [road],
        color: 'yellow', style: { showRouteLines: true }, onSelect() {} });
    const line = group.layers.find(item => item.type === 'line' && item.options.color === 'yellow');
    assert.deepEqual(plain(line.points), positions);
    assert.equal(line.options.dashArray, '4,6');
});

test('route-line legend describes stop order without implying road verification failed', () => {
    const { exports } = renderModule('src/components/map/RoutePathLegend.jsx');
    const rendered = exports.default();
    const text = JSON.stringify(rendered);
    assert.ok(text.includes('Lines connect stops in order'));
    assert.equal(text.includes('not available'), false);
    assert.equal(text.includes('hasDrivingGeometry'), false);
});

test('recorded decision filters still suppress manager route connectors', () => {
    const { exports, effects, groups } = renderModule('src/components/map/ManagerMapLayers.jsx');
    exports.ActiveRouteLayer({ activeRoute: { properties: doors }, mapSettings: {}, pinSize: 3, decisionFilterActive: true });
    effects.forEach(effect => effect());
    assert.equal(groups.flatMap(group => group.layers).filter(item => item.type === 'line').length, 0);
});
