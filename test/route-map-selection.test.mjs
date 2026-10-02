import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { loadSavedRouteSelection, getReadyRouteMapPoints } from '../src/components/logic/routeMapSelection.js';
import { hydrateRouteWithLookup, orderRouteProperties } from '../src/components/logic/routeHydrationCore.js';
import { savePropertyImport } from '../src/components/import/savePropertyImport.js';

const properties = Array.from({ length: 39 }, (_, index) => ({
    address_hash: `tampa-${index}`, lat: 27.95 + index / 1000, lng: -82.46 - index / 1000,
}));
const route = { id: 'tampa-route', property_hashes: properties.map(p => p.address_hash), metrics: { house_count: 3 } };

test('opening 39 homes with only 3 cached waits for all pins and excludes other cities', async () => {
    const partial = orderRouteProperties(route, properties.slice(0, 3));
    assert.equal(partial.houseCount, 39);
    assert.equal(getReadyRouteMapPoints(partial), null);
    let release;
    const delayed = new Promise(resolve => { release = resolve; });
    let requested;
    let settled = false;
    const loading = loadSavedRouteSelection(route, [
        ...properties.slice(0, 3), { address_hash: 'north-carolina', lat: 35.78, lng: -78.64 },
    ], candidate => hydrateRouteWithLookup(candidate, async request => {
        requested = request;
        await delayed;
        return properties.slice(3).toReversed();
    })).then(selected => { settled = true; return selected; });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(requested.routeId, route.id);
    assert.equal(requested.hashes.length, 36);
    release();
    const selected = await loading;
    assert.equal(selected.houseCount, 39);
    assert.deepEqual(selected.properties.map(p => p.address_hash), route.property_hashes);
    assert.deepEqual(getReadyRouteMapPoints(selected), properties.map(p => [p.lat, p.lng]));
});

test('import hands every saved pin to route opening without another network lookup', async () => {
    const saved = await savePropertyImport({ properties, fileName: 'Tampa.xlsx', routeName: 'Tampa' }, {
        user: { id: 'manager', email: 'manager@example.com' },
        client: { entities: { SavedRoute: { create: async payload => ({ ...payload, id: route.id }) } } },
        persistProperties: async batch => batch,
    });
    const selected = await loadSavedRouteSelection(saved.route, [], () => assert.fail('Imported pins should already be ready'));
    assert.equal(selected.houseCount, 39);
    assert.equal(selected.properties.length, 39);
    assert.deepEqual(selected.allProperties, properties);
});

test('incomplete or invalid map pins cannot become a successfully opened route', async () => {
    const invalid = [
        ...properties.slice(0, 3),
        ...properties.slice(3).map(p => ({ ...p, lat: null })),
    ];
    await assert.rejects(loadSavedRouteSelection(route, invalid,
        candidate => hydrateRouteWithLookup(candidate, async () => invalid)), /could not be loaded/);
    assert.equal(getReadyRouteMapPoints({ ...route, properties: invalid }), null);
    assert.equal(getReadyRouteMapPoints({ ...route, properties: properties.map(p => ({ ...p, lat: 91 })) }), null);
});

test('route bounds preserve the full route during filtering and include configured endpoints', () => {
    const selected = {
        ...route, properties: properties.slice(0, 2), allProperties: properties,
        route_origin_mode: 'home_round_trip', start_location: { lat: 27.9, lng: -82.4 },
        end_location: { lat: 27.9, lng: -82.4 },
    };
    const points = getReadyRouteMapPoints(selected);
    assert.equal(points.length, 41);
    assert.deepEqual(points[0], [27.9, -82.4]);
    assert.deepEqual(points.at(-1), [27.9, -82.4]);
    assert.deepEqual(points.slice(1, -1), properties.map(p => [p.lat, p.lng]));
});

test('MapController fits after hydration, stays put on status updates, and fits again on reopening', () => {
    const calls = [];
    const refs = [];
    let hookIndex;
    const map = { _mapPane: {}, on() {}, off() {}, fitBounds: bounds => calls.push(bounds) };
    const react = {
        useEffect: effect => effect(),
        useRef: value => refs[hookIndex++] ||= { current: value },
    };
    const leaflet = { latLngBounds: points => ({
        isValid: () => points.length > 0,
        getSouthWest: () => ({ lat: Math.min(...points.map(p => p[0])), lng: Math.min(...points.map(p => p[1])) }),
        getNorthEast: () => ({ lat: Math.max(...points.map(p => p[0])), lng: Math.max(...points.map(p => p[1])) }),
    }) };
    const source = fs.readFileSync(new URL('../src/components/map/MapHelpers.jsx', import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
    const exports = {};
    vm.runInNewContext(compiled, {
        exports,
        require: name => ({ react, 'react-leaflet': { useMap: () => map }, leaflet: { default: leaflet } })[name],
        setTimeout, clearTimeout,
    });
    const render = selected => {
        hookIndex = 0;
        exports.MapController({ fitBounds: getReadyRouteMapPoints(selected) });
    };
    render(orderRouteProperties(route, properties.slice(0, 3)));
    assert.equal(calls.length, 0);
    render(orderRouteProperties(route, properties));
    assert.equal(calls.length, 1);
    render(orderRouteProperties(route, properties.map(p => ({ ...p, effective_status: 'NO_ANSWER' }))));
    assert.equal(calls.length, 1);
    render(null);
    render(orderRouteProperties(route, properties));
    assert.equal(calls.length, 2);
});

test('initial account viewport cannot overwrite an imported route or a pending route link', () => {
    const text = fs.readFileSync(new URL('../src/pages/Home.jsx', import.meta.url), 'utf8');
    const source = ts.createSourceFile('Home.jsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    let cameraEffect;
    const visit = node => {
        if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect'
            && node.arguments[0]?.getText(source).includes('const workingArea = resolveAccountWorkingArea();')) {
            cameraEffect = node.arguments[0].getText(source);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    assert.ok(cameraEffect);
    let defaultLookups = 0;
    let cameraMoves = 0;
    const context = {
        activeRoute: null,
        window: { location: { search: '' } }, URLSearchParams,
        hasCenteredAccountWorkingAreaRef: { current: false },
        mapRef: { current: { _mapPane: {}, setView: () => { cameraMoves++; } } },
        resolveAccountWorkingArea: () => {
            defaultLookups++;
            return { type: 'center', center: [35.78, -78.64], zoom: 15 };
        },
    };
    const run = () => vm.runInNewContext(`(${cameraEffect})()`, context);
    context.window.location.search = '?savedRoute=tampa-route';
    run();
    assert.equal(defaultLookups, 0);
    assert.equal(cameraMoves, 0);
    context.activeRoute = orderRouteProperties(route, properties);
    context.window.location.search = '';
    run();
    assert.equal(cameraMoves, 0);
    context.activeRoute = null; // Closing the route keeps the user's current view.
    run();
    assert.equal(cameraMoves, 0);
    context.hasCenteredAccountWorkingAreaRef.current = false;
    run(); // Ordinary map opening still restores the account's previous position.
    assert.equal(defaultLookups, 1);
    assert.equal(cameraMoves, 1);
});
