import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { alongNearestPoint, dashScaleAt, liveZoomBackoffMs, liveZoomCanvasClass, pathNearView, pivotDashOffset, regriddedDashZoom,
  scaledDashArray, LIVE_ZOOM_FRAME_BUDGET_MS } from '../src/components/map/liveZoomCanvas.js';

// The owner's iPhone: zooming in fast made route dots and stop numbers "super
// big and out of focus" until release, because Leaflet CSS-scales its canvas
// mid-zoom and only redraws at zoomend.

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Just enough of Leaflet for the renderer: extend(), bounds, frames.
function fakeLeaflet() {
  const frames = [];
  const extend = function (props) {
    const Parent = this;
    function Child(options) { this.options = { ...(Parent.prototype.options || {}), ...(options || {}) }; this._layers = {}; }
    Child.prototype = Object.create(Parent.prototype);
    Object.assign(Child.prototype, props);
    Child.prototype.constructor = Child;
    Child.extend = extend;
    return Child;
  };
  const bounds = (min, max) => ({ min: { x: min[0] ?? min.x, y: min[1] ?? min.y }, max: { x: max[0] ?? max.x, y: max[1] ?? max.y },
    getSize() { return { x: this.max.x - this.min.x, y: this.max.y - this.min.y }; } });
  const calls = { baseZoom: 0, baseZoomEnd: 0, redraw: [], removed: 0, styled: 0 };
  function Canvas() {}
  Canvas.prototype = {
    options: { padding: 0.1 },
    _onZoom() { calls.baseZoom++; },
    _onZoomEnd() { calls.baseZoomEnd++; for (const id in this._layers) this._layers[id]._project(); },
    _redraw() { calls.redraw.push(this._redrawBounds); },
    _removePath() { calls.removed++; },
    _updateStyle(layer) { calls.styled++; layer.options._dashArray = layer.options.dashArray; },
    onRemove() {},
  };
  Canvas.extend = extend;
  const L = {
    Canvas,
    Renderer: { prototype: { _update() { this._bounds = bounds([0, 0], [100, 200]); this._zoom = this._map._zoom; } } },
    Util: { requestAnimFrame: (fn, ctx) => { frames.push(() => fn.call(ctx)); return frames.length; }, cancelAnimFrame: () => {} },
    DomUtil: { setPosition: () => {} },
    Browser: { retina: false },
    bounds,
  };
  return { L, frames, calls };
}

const view = { contains: p => p.inView, intersects: b => b.inView };

function fakeLayer(inView, kind = 'point') {
  const layer = { projected: 0, updated: 0, _pxBounds: 'stale-zoom-13-bounds', options: {} };
  if (kind === 'line') { layer._latlngs = [[0, 0]]; layer.getBounds = () => ({ inView, isValid: () => true }); }
  else layer.getLatLng = () => ({ inView });
  layer._project = () => { layer.projected++; layer._pxBounds = 'live-zoom-bounds'; };
  layer._update = () => { layer.updated++; };
  return layer;
}

test('only paths on or near the screen count as visible mid-zoom', () => {
  assert.equal(pathNearView(fakeLayer(true), view), true);
  assert.equal(pathNearView(fakeLayer(false), view), false);
  assert.equal(pathNearView(fakeLayer(true, 'line'), view), true);
  assert.equal(pathNearView(fakeLayer(false, 'line'), view), false);
});

test('a cheap redraw runs every frame; an expensive one backs off so the gesture stays smooth', () => {
  assert.equal(liveZoomBackoffMs(2), 0);
  assert.equal(liveZoomBackoffMs(LIVE_ZOOM_FRAME_BUDGET_MS), 0);
  assert.equal(liveZoomBackoffMs(40), 80);
  assert.equal(liveZoomBackoffMs(500), 250, 'capped');
});

test('mid-pinch the renderer redraws at the live zoom: near paths re-projected, the rest hidden until zoomend', () => {
  const { L, frames, calls } = fakeLeaflet();
  const Live = liveZoomCanvasClass(L);
  const renderer = new Live({ padding: 0.1 });
  const near = fakeLayer(true), far = fakeLayer(false), nearLine = fakeLayer(true, 'line');
  renderer._layers = { a: near, b: far, c: nearLine };
  renderer._container = { width: 0, height: 0, style: {} };
  renderer._ctx = { setTransform() {}, translate() {} };
  renderer._map = { _zoom: 15, _animatingZoom: false, getBounds: () => ({ pad: () => view }),
    getZoom: () => 15, getZoomScale: (to, from) => 2 ** (to - from) };

  // Several zoom events in one frame schedule one redraw.
  renderer._onZoom(); renderer._onZoom(); renderer._onZoom();
  assert.equal(calls.baseZoom, 3, 'Leaflet still positions the canvas on every zoom event');
  assert.equal(frames.length, 1);
  frames.shift()();

  assert.deepEqual([near.projected, near.updated, nearLine.projected], [1, 1, 1]);
  assert.equal(far.projected, 0, 'offscreen paths are not re-projected mid-zoom');
  assert.equal(far._pxBounds.min.x, -1e9, 'and are left out of the frame (offscreen bounds)');
  assert.equal(calls.redraw.length, 1);
  assert.equal(renderer._zoom, 15, 'drawn at the live zoom');

  // A CSS zoom animation (buttons, double tap) keeps Leaflet's behaviour.
  renderer._map._animatingZoom = true;
  renderer._onZoom();
  frames.shift()();
  assert.equal(calls.redraw.length, 1);

  // Zoom end: Leaflet re-projects every path, hidden ones included.
  renderer._map._animatingZoom = false;
  renderer._onZoomEnd();
  assert.equal(calls.baseZoomEnd, 1);
  assert.equal(far.projected, 1);
  assert.equal(far._pxBounds, 'live-zoom-bounds');
  assert.equal(Object.getOwnPropertySymbols(far).length, 0, 'hidden flag cleared');
});

test('route dots, stop numbers, route lines and territory pins all use the live renderer', () => {
  const label = read('src/components/map/labelCanvas.js');
  assert.match(label, /const Renderer = liveZoomCanvasClass\(L\)\.extend\(\{/);
  const home = read('src/pages/Home.jsx');
  assert.match(home, /const mapRenderer = useMemo\(\(\) => liveZoomCanvas\(L, \{ padding: 0\.1 \}\), \[\]\);/);
  assert.match(home, /preferCanvas=\{true\}\s*renderer=\{mapRenderer\}/);
  const rep = read('src/components/rep/RepMapView.jsx');
  assert.match(rep, /const renderer = useMemo\(\(\) => liveZoomCanvas\(L, \{ padding: 0\.25 \}\), \[\]\);/);
  assert.match(rep, /preferCanvas=\{true\}\s*renderer=\{renderer\}/);
});

// ---- Dashed route lines ("the route lines between the dots are accelerating") ----

test('dash lengths follow the ground and re-grid by a factor of 2 only past half a zoom level', () => {
  assert.equal(dashScaleAt(14, 13), 2);
  assert.equal(dashScaleAt(12, 13), 0.5);
  assert.equal(regriddedDashZoom(13.3, 13), 13, 'small pinch: nothing changes at rest');
  assert.equal(regriddedDashZoom(12.6, 13), 13);
  assert.equal(regriddedDashZoom(14.2, 13), 14);
  assert.equal(regriddedDashZoom(11.4, 13), 11);
  assert.deepEqual(scaledDashArray([4, 6], 0.5), [2, 3]);
  assert.equal(scaledDashArray(undefined, 2), undefined, 'solid lines stay solid');
});

test('a re-grid keeps the dash pattern in place where the screen centre crosses the line', () => {
  const phase = (along, offset, period) => { const t = (along + offset) / period; return t - Math.floor(t); };
  for (const [along, offset, oldPeriod, newPeriod] of [[1234.5, 3, 20, 10], [87.25, 0, 10, 20], [4000, 7.5, 28.3, 7.07]]) {
    const next = pivotDashOffset(along, offset, oldPeriod, newPeriod);
    assert.ok(next >= 0 && next < newPeriod);
    assert.ok(Math.abs(phase(along, next, newPeriod) - phase(along, offset, oldPeriod)) < 1e-9);
  }
  const ring = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }];
  assert.equal(alongNearestPoint(ring, { x: 40, y: 7 }), 40);
  assert.equal(alongNearestPoint(ring, { x: 130, y: 20 }), 120);
});

// Enough Leaflet for the dashed-line paths of the renderer.
function dashedLineHarness() {
  const strokes = [];
  function LatLng(lat, lng) { this.lat = lat; this.lng = lng; }
  const point = (x, y) => ({ x, y, _subtract(o) { return point(this.x - o.x, this.y - o.y); } });
  let zoom = 13;
  function Canvas() {}
  Canvas.prototype = {
    options: {},
    onAdd() {},
    _initPath(layer) { layer.initialized = true; },
    _updateStyle(layer) { layer.options._dashArray = layer.options.dashArray ? layer.options.dashArray.split(',').map(Number) : null; },
    _removePath() {},
    _onZoomEnd() { for (const id in this._layers) this._layers[id]._project(); },
    _fillStroke(ctx, layer) { strokes.push({ dash: layer.options._dashArray, offset: ctx.lineDashOffset }); },
  };
  Canvas.extend = function (props) {
    const Parent = this;
    function Child(options) { this.options = { ...options }; this._layers = {}; }
    Child.prototype = Object.create(Parent.prototype);
    Object.assign(Child.prototype, props);
    Child.extend = Canvas.extend;
    return Child;
  };
  const L = { Canvas, LatLng, Renderer: { prototype: { _update() {} } }, Util: { requestAnimFrame() {}, cancelAnimFrame() {} },
    DomUtil: { setPosition() {} }, Browser: { retina: false }, bounds: () => ({}) };
  // A straight line along x; zoom z puts 100 * 2^(z - 13) px between its points (+0.4 px, so rounding shows).
  const map = {
    getZoom: () => zoom, getCenter: () => new LatLng(0, 1.5),
    getPixelOrigin: () => point(0, 0),
    project: latlng => point(latlng.lng * 100 * 2 ** (zoom - 13) + 0.4, 0),
  };
  const Live = liveZoomCanvasClass(L);
  const renderer = new Live({});
  renderer._map = map;
  renderer.onAdd(map);
  const line = (dashArray) => {
    const layer = { _latlngs: [new LatLng(0, 0), new LatLng(0, 1), new LatLng(0, 2), new LatLng(0, 3)], _map: map,
      options: { dashArray, _dashArray: dashArray ? dashArray.split(',').map(Number) : null, smoothFactor: 1 } };
    layer._project = () => { layer._rings = []; layer._projectLatlngs(layer._latlngs, layer._rings, { extend() {} }); };
    // Leaflet's own projection rounds every vertex to a whole pixel.
    layer._projectLatlngs = function (latlngs, result) { result.push(latlngs.map(ll => { const p = map.project(ll); return point(Math.round(p.x), p.y); })); };
    layer._update = () => {};
    return layer;
  };
  return { renderer, strokes, line, setZoom: z => { zoom = z; }, ctx: { lineDashOffset: 0 } };
}

test('dashed lines are drawn unclipped, unsimplified and unrounded; solid lines and dots keep Leaflet\'s rules', () => {
  const { renderer, line } = dashedLineHarness();
  const dashed = line('4,6');
  const solid = line(null);
  const dot = { options: { radius: 4 }, getLatLng() {} };
  renderer._initPath(dashed);
  renderer._initPath(solid);
  renderer._initPath(dot);
  assert.equal(dashed.options.noClip, true);
  assert.equal(dashed.options.smoothFactor, 0);
  dashed._project();
  assert.equal(dashed._rings[0][1].x, 100.4, 'not rounded to a whole pixel');
  assert.equal(solid.options.noClip, undefined);
  assert.equal(solid.options.smoothFactor, 1);
  solid._project();
  assert.equal(solid._rings[0][1].x, 100, 'solid lines keep Leaflet\'s rounding');
  assert.deepEqual(dot.options, { radius: 4 }, 'dots are untouched');

  // Becoming solid restores Leaflet's rules.
  dashed.options.dashArray = null;
  renderer._updateStyle(dashed);
  assert.equal(dashed.options.noClip, undefined);
  assert.equal(dashed.options.smoothFactor, 1);
  dashed._project();
  assert.equal(dashed._rings[0][1].x, 100);
});

test('mid-zoom the dashes scale with the map (pinned to the ground) and only re-grid at rest past half a level', () => {
  const { renderer, strokes, line, setZoom, ctx } = dashedLineHarness();
  const dashed = line('4,6');
  renderer._initPath(dashed);
  renderer._layers = { dashed };
  const draw = () => { renderer._fillStroke(ctx, dashed); return strokes.at(-1); };

  assert.deepEqual(draw().dash, [4, 6], 'at rest: today\'s dashes');
  setZoom(13.5);
  assert.deepEqual(draw().dash, [4 * 2 ** 0.5, 6 * 2 ** 0.5], 'mid-pinch: dashes grow with the ground');
  assert.deepEqual(dashed.options._dashArray, [4, 6], 'the resting style is restored after drawing');
  assert.equal(ctx.lineDashOffset, 0);

  // A 0.3-level pinch: nothing changes at rest.
  setZoom(13.3);
  dashed._project();
  renderer._onZoomEnd();
  assert.ok(Math.abs(draw().dash[0] - 4 * 2 ** 0.3) < 1e-9);

  // A 1.2-level pinch: halve the dashes, keeping the pattern still at the screen centre.
  setZoom(14.2);
  const phaseAtCentre = () => {
    const centre = 150 * 2 ** (14.2 - 13) + 0.4;
    const along = alongNearestPoint(dashed._rings[0], { x: centre, y: 0 });
    const stroke = draw();
    const period = stroke.dash[0] + stroke.dash[1];
    const turns = (along + stroke.offset) / period;
    return { period, phase: turns - Math.floor(turns) };
  };
  dashed._project();
  const before = phaseAtCentre();
  renderer._onZoomEnd();
  const after = phaseAtCentre();
  assert.ok(Math.abs(after.period - before.period / 2) < 1e-9, 're-gridded by a factor of 2');
  assert.ok(Math.abs(after.phase - before.phase) < 1e-9, 'the dash under the screen centre does not move');
});
