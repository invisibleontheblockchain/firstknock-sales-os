import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { liveZoomBackoffMs, liveZoomCanvasClass, pathNearView, LIVE_ZOOM_FRAME_BUDGET_MS } from '../src/components/map/liveZoomCanvas.js';

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
  const calls = { baseZoom: 0, baseZoomEnd: 0, redraw: [] };
  function Canvas() {}
  Canvas.prototype = {
    options: { padding: 0.1 },
    _onZoom() { calls.baseZoom++; },
    _onZoomEnd() { calls.baseZoomEnd++; for (const id in this._layers) this._layers[id]._project(); },
    _redraw() { calls.redraw.push(this._redrawBounds); },
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
  const layer = { projected: 0, updated: 0, _pxBounds: 'stale-zoom-13-bounds' };
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
  renderer._map = { _zoom: 15, _animatingZoom: false, getBounds: () => ({ pad: () => view }) };

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
