import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { attachZoomSmoothing, ZOOM_SMOOTHING_CLASS } from '../src/components/map/mapZoomSmoothing.js';

// The owner's iPhone showed hard square blocks while pinching: Leaflet stretches
// the previous level, and its Safari CSS scales tiles with nearest neighbour.

function fakeMap() {
  const handlers = {};
  const classes = new Set();
  const timers = [];
  return {
    classes, timers,
    map: {
      getContainer: () => ({ classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) } }),
      on: (event, fn) => { (handlers[event] = handlers[event] || []).push(fn); },
      off: (event, fn) => { handlers[event] = (handlers[event] || []).filter(h => h !== fn); },
      fire: event => (handlers[event] || []).forEach(fn => fn()),
      handlers,
    },
    options: {
      setTimer: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length - 1; },
      clearTimer: id => { if (timers[id]) timers[id].cleared = true; },
    },
  };
}

test('tiles scale smoothly from a zoom start until the new view\'s imagery has loaded', () => {
  const { map, classes, options } = fakeMap();
  const smoothing = attachZoomSmoothing(map, options);
  map.fire('zoomstart');
  assert.ok(classes.has(ZOOM_SMOOTHING_CLASS), 'smooth during the pinch');
  smoothing.tilesLoading();
  smoothing.tilesLoaded(); // an intermediate level finished mid-pinch
  assert.ok(classes.has(ZOOM_SMOOTHING_CLASS), 'still zooming');
  smoothing.tilesLoading();
  map.fire('zoomend');
  assert.ok(classes.has(ZOOM_SMOOTHING_CLASS), 'released, new tiles still loading: stretched tiles stay smooth');
  smoothing.tilesLoaded();
  assert.ok(!classes.has(ZOOM_SMOOTHING_CLASS), 'new imagery on screen: back to Leaflet\'s look');
});

test('a zoom with nothing left to load ends at once, and a stuck tile ends it after the cap', () => {
  const { map, classes, timers, options } = fakeMap();
  const smoothing = attachZoomSmoothing(map, options);
  map.fire('zoomstart');
  map.fire('zoomend');
  assert.ok(!classes.has(ZOOM_SMOOTHING_CLASS));

  map.fire('zoomstart');
  smoothing.tilesLoading();
  map.fire('zoomend');
  const timer = timers.at(-1);
  assert.equal(timer.ms, 4000);
  timer.fn();
  assert.ok(!classes.has(ZOOM_SMOOTHING_CLASS), 'a tile that never settles cannot leave zoom mode on');

  smoothing.detach();
  assert.deepEqual([map.handlers.zoomstart.length, map.handlers.zoomend.length], [0, 0]);
});

test('the basemap wires zoom smoothing to its tile events, and the CSS overrides Leaflet\'s Safari rule only while zooming', () => {
  const tiles = readFileSync(new URL('../src/components/map/BaseMapTiles.jsx', import.meta.url), 'utf8');
  assert.match(tiles, /const smoothing = attachZoomSmoothing\(map\);/);
  assert.match(tiles, /loading: \(\) => smoothingRef\.current\?\.tilesLoading\(\)/);
  assert.match(tiles, /smoothingRef\.current\?\.tilesLoaded\(\); \}/);
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  // Specificity (0,3,0) beats Leaflet's .leaflet-safari .leaflet-tile (0,2,0).
  assert.match(css, /\.leaflet-container\.fk-map-zooming \.leaflet-tile \{\s*image-rendering: auto;\s*\}/);
});
