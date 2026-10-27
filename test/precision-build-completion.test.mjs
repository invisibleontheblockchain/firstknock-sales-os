import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { claimFirstAreaRouteHandoff } from '../src/components/onboarding/firstAreaNavigation.js';
import { savePrecisionRoutes } from '../src/lib/precisionDelivery.js';
import { getReadyRouteMapPoints } from '../src/components/logic/routeMapSelection.js';
import { markRoadCompleted } from '../src/lib/generatedRouteRoadCompletion.js';

const home = readFileSync(new URL('../src/pages/Home.jsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('Home.jsx', home, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
const callbacks = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
      && node.initializer.expression.getText(ast) === 'useCallback') {
    callbacks.set(node.name.getText(ast), node.initializer.arguments[0]);
  }
  ts.forEachChild(node, visit);
}
visit(ast);

// Execute the production road/save/completion path, retaining its catch/finally.
// Candidate retrieval and the expensive optimizer are outside this UI regression.
const generationTry = callbacks.get('generateRoutes').body.statements.find(ts.isTryStatement);
const roadStart = generationTry.tryBlock.statements.findIndex(statement =>
  ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration =>
    declaration.name.getText(ast) === 'roadMatrixPass'));
assert.ok(roadStart >= 0);
const completionTry = ts.factory.updateTryStatement(generationTry,
  ts.factory.updateBlock(generationTry.tryBlock, generationTry.tryBlock.statements.slice(roadStart)),
  generationTry.catchClause, generationTry.finallyBlock);
const completionSource = ts.createPrinter().printNode(ts.EmitHint.Unspecified, completionTry, ast);

const polygon = [{ lat: 33, lng: -112 }, { lat: 34, lng: -112 }, { lat: 33, lng: -111 }];
const route = { id: 'generated-route', houseCount: 3,
  properties: polygon.map((point, index) => ({ ...point, address_hash: `home-${index}` })) };

function buildSandbox({ roadPass, save = async () => ({ id: 'saved-route', status: 'ACTIVE' }), houseCount = 3 } = {}) {
  const memory = new Map([
    ['fk_drawnPolygon', JSON.stringify(polygon)], ['fk_drawnPolygonQueried', 'true'],
    ['fk_firstAreaWalkthrough_new-manager', 'active'],
  ]);
  const state = { ModeRaw: 'generate', DrawingMode: true, DrawnPolygon: polygon, DraftPolygon: polygon,
    ShowCompare: true, ShowRoutePanel: true, ShowChecklist: true, ShowMapSettings: true, RoutesGenerating: true };
  const rawGenerated = [{ ...route, houseCount }];
  const sandbox = {
    URLSearchParams, claimFirstAreaRouteHandoff, savePrecisionRoutes, markRoadCompleted, performance, t0: performance.now(),
    console: { log() {}, error() {}, warn() {} },
    toast: Object.fromEntries(['loading', 'dismiss', 'success', 'error', 'info', 'warning'].map(name => [name, () => {}])),
    localStorage: { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) },
    window: { __fkSuppressMapFitUntil: Date.now() + 8000,
      location: { pathname: '/Home', search: '?onboarding=precision&keep=1', hash: '#map' },
      history: { replaceState: (_, __, url) => { state.url = url; } } },
    user: { id: 'new-manager', app_role: 'manager', has_seen_onboarding: false },
    routesGeneratingRef: { current: true },
    rawGenerated, routingContext: {}, optStart: performance.now(), deliveryAttempt: null, precisionJob: null,
    finalCount: 3, initialCount: 3, effectiveRouteConfig: {}, isCurrentBatchDataRun: false,
    requestedPrecisionCount: null, buildPrecisionRouteShortfallMessage: () => '',
    lastGeneratedRouteBoundsRef: { current: null }, preparedRouteBounds: { enabled: false },
    buildRoadAwareGeneratedRoutes: roadPass || (async () => ({ routes: rawGenerated, appliedCount: 1, savedMiles: 0.5 })),
    handleSaveRoute: save,
  };
  for (const name of ['ModeRaw', 'DrawingMode', 'DrawnPolygonRaw', 'DraftPolygon', 'PreviewRoute', 'ShowRoutePanel',
    'ShowCompare', 'ShowChecklist', 'ShowMapSettings', 'ActiveRoute', 'Routes', 'GenerationStage', 'GenerationError', 'RoutesGenerating']) {
    sandbox[`set${name}`] = value => { state[name === 'DrawnPolygonRaw' ? 'DrawnPolygon' : name] = value; };
  }
  sandbox.setDrawnPolygon = vm.runInNewContext(`(${callbacks.get('setDrawnPolygon').getText(ast)})`, sandbox);
  sandbox.finishRouteBuild = vm.runInNewContext(`(${callbacks.get('finishRouteBuild').getText(ast)})`, sandbox);
  return { sandbox, state, memory,
    run: () => vm.runInNewContext(`(async () => { ${completionSource} })()`, sandbox) };
}

function assertFinished({ sandbox, state, memory }) {
  assert.equal(state.ModeRaw, 'analyze');
  assert.equal(state.DrawingMode, false);
  assert.equal(state.DrawnPolygon, null);
  assert.equal(state.DraftPolygon.length, 0);
  for (const key of ['ShowRoutePanel', 'ShowCompare', 'ShowChecklist', 'ShowMapSettings', 'RoutesGenerating']) {
    assert.equal(state[key], false, `${key} should be closed`);
  }
  assert.equal(memory.has('fk_drawnPolygon'), false);
  assert.equal(memory.has('fk_drawnPolygonQueried'), false);
  assert.equal(sandbox.window.__fkSuppressMapFitUntil, 0);
  assert.deepEqual(getReadyRouteMapPoints(state.ActiveRoute), polygon.map(point => [point.lat, point.lng]));
}

test('the initial build waits for road distances and saving, then clears the builder and opens the complete route', async () => {
  let releaseRoad;
  let releaseSave;
  const road = new Promise(resolve => { releaseRoad = resolve; });
  const saving = new Promise(resolve => { releaseSave = resolve; });
  let saveStarted = false;
  const build = buildSandbox({ roadPass: async () => { await road; return { routes: [route], appliedCount: 1, savedMiles: 0.5 }; },
    save: async () => { saveStarted = true; await saving; return { id: 'saved-route' }; } });
  const running = build.run();
  assert.equal(build.state.ModeRaw, 'generate');
  assert.equal(build.state.ActiveRoute, undefined);
  assert.equal(build.memory.has('fk_drawnPolygon'), true);
  releaseRoad();
  for (let attempt = 0; !saveStarted && attempt < 20; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(saveStarted, true);
  assert.equal(build.state.ModeRaw, 'generate');
  assert.equal(build.state.DrawnPolygon, polygon);
  releaseSave();
  assert.equal(await running, true);
  assertFinished(build);
  assert.equal(build.state.ActiveRoute.id, 'saved-route');
  assert.equal(build.state.ActiveRoute.isSaved, true);
  assert.equal(build.state.Routes.length, 0);
  assert.equal(build.state.url, '/Home?keep=1#map');
});

test('offline, rejected, and oversized saves still finish on the route map with the route available', async () => {
  for (const options of [
    { save: async () => ({ id: 'local_route' }) },
    { save: async () => { throw new Error('Save unavailable'); } },
    { houseCount: 10001, save: async () => assert.fail('Oversized route should not be saved') },
  ]) {
    const build = buildSandbox(options);
    assert.equal(await build.run(), false, 'The completed import must remain recoverable until its routes are remotely saved');
    assertFinished(build);
    assert.equal(build.state.ActiveRoute.id, 'generated-route');
    assert.equal(build.state.ActiveRoute.isSaved, false);
    assert.equal(build.state.Routes.length, 1);
    assert.match(build.state.GenerationError, /could not be saved to your account/);
  }
});

test('road failures and empty optimizer results preserve the selected area for retry', async () => {
  for (const roadPass of [
    async () => { throw new Error('Road calculation failed'); },
    async () => ({ routes: [], appliedCount: 0 }),
  ]) {
    const build = buildSandbox({ roadPass });
    assert.equal(await build.run(), false);
    assert.equal(build.state.ModeRaw, 'generate');
    assert.equal(build.state.DrawnPolygon, polygon);
    assert.equal(build.memory.has('fk_drawnPolygon'), true);
    assert.equal(build.state.ActiveRoute, undefined);
    assert.ok(build.state.GenerationError);
    assert.equal(build.state.RoutesGenerating, false);
  }
});

test('the actual drawing layer follows map mode without needing a separate mode event', () => {
  const source = readFileSync(new URL('../src/components/map/MapDrawTool.jsx', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  const react = { __esModule: true, default: { Fragment: 'Fragment', createElement: (type, props, ...children) => ({ type, props, children }) },
    useState: value => [value, () => {}], useRef: current => ({ current }), useEffect() {} };
  const modules = { react, 'react-leaflet': { useMap: () => ({}), useMapEvents() {}, Polygon: 'Polygon' },
    leaflet: {}, '@/components/logic/geoArea': { calculatePolygonAreaSqMiles: () => 1, formatSqMiles: () => '1 sq mi' } };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => modules[name] });
  const render = mode => exports.default({ mode, active: false, drawnPolygon: polygon });
  assert.equal(render('generate').children[0].type, 'Polygon', 'Precision and Canvas builders keep their confirmed boundary');
  assert.equal(render('analyze').children[0], false, 'A stored boundary cannot overlay the route map');
  assert.match(home, /<MapDrawTool\s+mode=\{mode\}/);
});
