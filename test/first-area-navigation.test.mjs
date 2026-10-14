import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';
import { getInitialMapMode, claimFirstAreaRouteHandoff } from '../src/components/onboarding/firstAreaNavigation.js';

const manager = { id: 'new-manager', app_role: 'manager', has_seen_onboarding: false };
const walkthroughKey = `fk_firstAreaWalkthrough_${manager.id}`;
function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

const home = readFileSync(new URL('../src/pages/Home.jsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('Home.jsx', home, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
let entryEffect;
let modeInitializer;
let completion;
let finishRouteBuild;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'finishRouteBuild') {
    finishRouteBuild = node.initializer.arguments[0].getText(ast);
  }
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === '[mode, setModeRaw]') {
    modeInitializer = node.initializer.getText(ast);
  }
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
    && node.arguments[0].getText(ast).includes("params.get('startDraw')")) {
    entryEffect = node.arguments[0].getText(ast);
  }
  if (ts.isBlock(node)) {
    const declares = (statement, name) => ts.isVariableStatement(statement)
      && statement.declarationList.declarations.some(declaration => declaration.name.getText(ast) === name);
    const start = node.statements.findIndex(statement => declares(statement, 'firstRoute'));
    const end = node.statements.findIndex(statement => declares(statement, 'skippedDueToAssigned'));
    if (start >= 0 && end > start) completion = node.statements.slice(start, end).map(statement => statement.getText(ast)).join('\n');
  }
  ts.forEachChild(node, visit);
}
visit(ast);

function pageSandbox(search, storage = memoryStorage(), user = manager) {
  const state = {};
  const location = { pathname: '/Home', search, hash: '#map' };
  const sandbox = { URLSearchParams, getInitialMapMode, claimFirstAreaRouteHandoff, localStorage: storage, user,
    generated: [{ id: 'generated-1', name: 'First route', properties: [{ address_hash: 'door-1' }], houseCount: 1 }],
    savedByGeneratedRoute: new Map(),
    window: { location, history: { replaceState: (_, __, url) => {
      state.url = url;
      location.search = new URL(url, 'https://example.com').search;
    } } },
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  };
  for (const name of ['ModeRaw', 'ShowCompare', 'ShowRoutePanel', 'ShowChecklist', 'ShowMapSettings', 'DrawnPolygon', 'DraftPolygon', 'DrawShape', 'DrawingMode', 'ActiveRoute', 'PreviewRoute']) {
    sandbox[`set${name}`] = value => { state[name] = value; };
  }
  sandbox.finishRouteBuild = vm.runInNewContext(`(${finishRouteBuild})`, sandbox);
  return { sandbox, state };
}

test('the actual map initializer enters Builder for tutorial links and keeps ordinary visits in Routes', () => {
  for (const [search, expected] of [['?startDraw=true&onboarding=precision', 'generate'], ['?onboarding=precision', 'generate'], ['', 'analyze'], ['?runRoute=1', 'analyze']]) {
    const { sandbox } = pageSandbox(search);
    assert.equal(vm.runInNewContext(modeInitializer, sandbox)[0], expected);
  }
});

test('drawing setup activates Builder and preserves tutorial and unrelated URL state', () => {
  const { sandbox, state } = pageSandbox('?startDraw=true&onboarding=precision&drawShape=square&keep=1');
  vm.runInNewContext(`(${entryEffect})()`, sandbox);
  assert.equal(state.ModeRaw, 'generate');
  assert.equal(state.DrawingMode, true);
  assert.equal(state.DrawShape, 'square');
  assert.equal(state.ShowRoutePanel, false);
  assert.equal(state.DrawnPolygon, null);
  assert.equal(state.url, '/Home?onboarding=precision&keep=1#map');
});

test('successful tutorial generation opens the full route map, including after a refresh', () => {
  const storage = memoryStorage({ [walkthroughKey]: 'active' });
  for (let attempt = 0; attempt < 2; attempt++) {
    const { sandbox, state } = pageSandbox('?onboarding=precision&keep=1', storage);
    vm.runInNewContext(completion, sandbox);
    assert.equal(state.ModeRaw, 'analyze');
    assert.equal(state.ShowRoutePanel, false);
    assert.equal(state.ActiveRoute.id, 'generated-1');
    assert.equal(state.ShowCompare, false);
    assert.equal(state.DrawingMode, false);
    assert.equal(state.DrawnPolygon, null);
    assert.equal(state.DraftPolygon.length, 0);
    assert.equal(state.ShowChecklist, false);
    assert.equal(state.ShowMapSettings, false);
    assert.equal(state.url, '/Home?keep=1#map');
  }
});

test('the handoff selects the remote saved route, while offline saves retain the generated route', () => {
  for (const [savedId, expectedId, expectedSaved] of [['remote-1', 'remote-1', true], ['local_1', 'generated-1', false]]) {
    const { sandbox, state } = pageSandbox('', memoryStorage({ [walkthroughKey]: 'active' }));
    sandbox.savedByGeneratedRoute.set(sandbox.generated[0], { id: savedId, status: 'ACTIVE' });
    vm.runInNewContext(completion, sandbox);
    assert.equal(state.ActiveRoute.id, expectedId);
    assert.equal(state.ActiveRoute.isSaved, expectedSaved);
    assert.equal(state.ShowRoutePanel, false);
    assert.equal(state.ModeRaw, 'analyze');
  }
});

test('ordinary generations, returning users, and reps do not trigger the tutorial handoff', () => {
  for (const [user, initial] of [[manager, {}], [{ ...manager, has_seen_onboarding: true }, { [walkthroughKey]: 'active' }], [{ ...manager, app_role: 'rep' }, { [walkthroughKey]: 'active' }]]) {
    const { sandbox, state } = pageSandbox('', memoryStorage(initial), user);
    vm.runInNewContext(completion, sandbox);
    assert.equal(state.ShowRoutePanel, false);
    assert.equal(state.ActiveRoute.id, 'generated-1');
  }
});

let vite;
let RouteCommandPanel;
before(async () => {
  vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent',
    plugins: [{ name: 'ssr-iframe-probe', enforce: 'pre', load(id) {
      // Route Command does not mount the split map until SPLIT is clicked.
      if (id.replaceAll('\\', '/').endsWith('/SplitRoutePreviewMap.jsx')) {
        return 'export const previewColor = () => "#2EEB57"; export default function SplitRoutePreviewMap() { return null; }';
      }
      if (id.replaceAll('\\', '/').endsWith('/src/lib/utils.js')) {
        return readFileSync(id, 'utf8').replace('window.self !== window.top', 'false');
      }
    } }],
  });
  ({ default: RouteCommandPanel } = await vite.ssrLoadModule('/src/components/routes/RouteCommandPanel.jsx'));
});
after(async () => { await vite?.close(); });

function renderPanel(props) {
  const client = new QueryClient();
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, React.createElement(RouteCommandPanel, props)));
  } finally { client.clear(); }
}

const saved = { id: 'saved-1', name: 'Saved first route', status: 'ACTIVE', isSaved: true, houseCount: 1,
  property_hashes: ['door-1'], properties: [], created_date: new Date().toISOString(), metadata: { newly_generated: true } };

test('Route Command opens the regular list with New badges and no separate New Routes tab', () => {
  const html = renderPanel({ savedRoutes: [saved], activeRouteId: saved.id });
  assert.match(html, /Saved first route/);
  assert.match(html, />New<\/span>/);
  assert.match(html, /START ROUTE/);
  assert.doesNotMatch(html, /NEW ROUTES|No New Routes/);
  assert.doesNotMatch(html, /disabled=""/);
});

test('unsaved generated routes remain in the regular tab with a save action and no remote rename', () => {
  const html = renderPanel({ generatedRoutes: [{ ...saved, id: 'pending-1', name: 'Pending first route' }], onSaveRoute: () => {} });
  assert.match(html, /Pending first route/);
  assert.match(html, /SAVE ROUTE/);
  assert.match(html, />New<\/span>/);
  assert.doesNotMatch(html, /NEW ROUTES|title="Rename"/);
});

test('a route present in both generation state and saved state appears once', () => {
  const html = renderPanel({ savedRoutes: [saved], generatedRoutes: [saved] });
  assert.equal((html.match(/Saved first route/g) || []).length, 1);
  assert.doesNotMatch(html, /SAVE ROUTE/);
});
