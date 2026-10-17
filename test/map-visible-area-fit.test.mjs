import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MAP_FIT_MARGIN, measureMapInsets, visibleAreaFitOptions } from '../src/components/map/mapInsets.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const element = (side, box) => ({ getAttribute: () => side, getBoundingClientRect: () => box });
const root = (elements) => ({ querySelectorAll: () => elements });

test('top and bottom overlays shrink the area a selected route is fitted into', () => {
  // Phone: map from y=64 to y=748; toolbar + route card end at y=184; Run Route starts at y=690.
  const map = { getBoundingClientRect: () => rect(0, 64, 375, 684) };
  const insets = measureMapInsets(map, root([
    element('top', rect(4, 68, 367, 116)),
    element('bottom', rect(0, 690, 375, 42)),
    element('top', rect(0, 0, 0, 0)), // hidden overlay
    element('bottom', rect(400, 690, 50, 40)), // outside the map
  ]));
  assert.deepEqual(insets, { top: 120, bottom: 58 });
  assert.deepEqual(visibleAreaFitOptions(insets), {
    paddingTopLeft: [MAP_FIT_MARGIN, 120 + MAP_FIT_MARGIN],
    paddingBottomRight: [MAP_FIT_MARGIN, 58 + MAP_FIT_MARGIN],
    maxZoom: 17,
    animate: false,
  });
});

test('overlays can never claim more than two thirds of the map', () => {
  const map = { getBoundingClientRect: () => rect(0, 0, 400, 300) };
  const insets = measureMapInsets(map, root([element('top', rect(0, 0, 400, 250)), element('bottom', rect(0, 200, 400, 100))]));
  assert.ok(insets.top + insets.bottom <= 200 + 1);
  assert.ok(insets.top > insets.bottom);
});

test('the selected-route fit uses the visible area after the route card settles', () => {
  const helpers = read('src/components/map/MapHelpers.jsx');
  assert.match(helpers, /requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => \{\s*try \{ fitBoundsToVisibleArea\(map, bounds, \{ maxZoom: 17 \}\); \}/);
  const toolbar = read('src/components/map/MapToolbar.jsx');
  assert.match(toolbar, /data-map-inset="top" className="absolute top-1 left-1 right-1/);
  assert.match(toolbar, /data-map-inset="bottom" className="absolute bottom-4 sm:bottom-6 left-0 right-0/);
  assert.match(toolbar, /fitBoundsToVisibleArea\(mapRef\.current, fitBounds, \{ maxZoom: 17, animate: true \}\)/);
});
