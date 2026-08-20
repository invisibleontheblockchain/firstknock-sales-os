import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  filterRoutesByStatus,
  isRenderableMapPoint,
  shouldRenderPrecisionMapLayers,
} from '../src/components/map/mapLayerVisibility.js';

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('Canvas mode hides every Precision layer, Precision mode shows them', () => {
  assert.equal(shouldRenderPrecisionMapLayers({ mode: 'analyze', routeMode: 'canvas' }), false);
  assert.equal(shouldRenderPrecisionMapLayers({ mode: 'generate', routeMode: 'canvas' }), false);
  assert.equal(shouldRenderPrecisionMapLayers({
    mode: 'generate',
    routeMode: 'canvas',
    activeRoute: { id: 'saved-route' },
  }), false);
  assert.equal(shouldRenderPrecisionMapLayers({ mode: 'analyze', routeMode: 'precision' }), true);
});

test('saved-route status views hide archived source routes without hiding completed work', () => {
  const routes = [
    { id: 'active', status: 'ACTIVE' },
    { id: 'pending', status: 'PENDING' },
    { id: 'legacy-without-status' },
    { id: 'done', status: 'COMPLETED' },
    { id: 'archived-source', status: 'ARCHIVED' },
  ];

  assert.deepEqual(filterRoutesByStatus(routes, 'all').map(route => route.id), ['active', 'pending', 'legacy-without-status', 'done']);
  assert.deepEqual(filterRoutesByStatus(routes, 'active').map(route => route.id), ['active', 'pending', 'legacy-without-status']);
  assert.deepEqual(filterRoutesByStatus(routes, 'completed').map(route => route.id), ['done']);
});

test('one malformed coordinate cannot abort the entire saved-route layer', () => {
  assert.equal(isRenderableMapPoint({ lat: 33.45, lng: -112.07 }), true);
  assert.equal(isRenderableMapPoint({ lat: '33.45', lng: '-112.07' }), true);
  assert.equal(isRenderableMapPoint({ lat: null, lng: -112.07 }), false);
  assert.equal(isRenderableMapPoint({ lat: Number.NaN, lng: -112.07 }), false);
  assert.equal(isRenderableMapPoint({ lat: 91, lng: -112.07 }), false);
  assert.equal(isRenderableMapPoint({ lat: 33.45, lng: -181 }), false);
});

test('Home map has discovery, legacy-hash, visibility, and camera recovery paths', () => {
  const home = source('src/pages/Home.jsx');
  const layers = source('src/components/map/ManagerMapLayers.jsx');
  const toolbar = source('src/components/map/MapToolbar.jsx');

  assert.match(home, /buildSavedRouteQueryFilters\(savedRouteScope\)/);
  assert.match(home, /filterRoutesByStatus\(allSavedRoutes, 'all'\)/);
  assert.match(home, /if \(p\.legacy_hash\) propsByHash\.set\(p\.legacy_hash, p\)/);
  assert.match(home, /savedRouteOverviewPoints/);
  assert.match(home, /fitBounds\(bounds, \{ padding: \[50, 50\], maxZoom: 16, animate: false \}\)/);
  assert.match(home, /localStorage\.getItem\('fk_routeStatusView'\) \|\| 'all'/);
  assert.match(layers, /shouldRenderPrecisionMapLayers\(\{ routeMode \}\)/);
  assert.match(layers, /activeRoute\?\.properties\?\.some\(isRenderableMapPoint\)/);
  assert.match(layers, /isRenderableMapPoint\(p\) && inView\(p\)/);
  assert.match(layers, /pinPropertyStyleKey\(p\)/);
  assert.match(layers, /decisionFingerprint/);
  assert.match(toolbar, /routeStatusView === 'all'/);
  assert.match(toolbar, /'All routes visible'/);
  assert.match(toolbar, /customAreaControlsBlocked = mode === 'generate'.*routeMode === 'precision'.*hasDrawnArea.*!drawingMode.*!activeRoute/);
  assert.equal((toolbar.match(/customAreaControlsBlocked \? 'pointer-events-none'/g) || []).length, 3);
});