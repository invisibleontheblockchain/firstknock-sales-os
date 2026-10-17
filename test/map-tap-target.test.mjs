import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isWithinTapTarget, TAP_AREA_SCALE, TAP_RADIUS_SCALE, tapRadius } from '../src/components/map/mapTapTarget.js';
import { createLabelCanvas } from '../src/components/map/labelCanvas.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const point = (x, y) => ({ x, y, distanceTo: (other) => Math.hypot(other.x - x, other.y - y) });


test('map dots accept taps over 7% more area without being drawn larger', () => {
  assert.equal(TAP_AREA_SCALE, 1.07);
  assert.ok(Math.abs(TAP_RADIUS_SCALE - Math.sqrt(1.07)) < 1e-12);
  // A 6 px dot with a 1 px stroke and the 12 px canvas tolerance: Leaflet's own
  // rule accepted taps within 6 + 0.5 + 12 = 18.5 px; the target is now ~19.14 px.
  const dot = { _radius: 6, _point: point(0, 0), _clickTolerance: () => 12.5, options: {} };
  assert.ok(Math.abs(tapRadius(dot) - 18.5 * Math.sqrt(1.07)) < 1e-9);
  assert.ok(Math.abs(Math.PI * tapRadius(dot) ** 2 / (Math.PI * 18.5 ** 2) - 1.07) < 1e-9, 'area grows by exactly 7%');
  assert.equal(isWithinTapTarget(dot, point(19.1, 0)), true, 'just inside the larger target');
  assert.equal(isWithinTapTarget(dot, point(19.2, 0)), false);
  assert.equal(isWithinTapTarget(dot, point(18.4, 0)), true, 'everything tappable before is still tappable');
  assert.equal(dot._radius, 6, 'the drawn radius is untouched');

  // Explicit touch radii (rep route stops) scale the same way.
  const stop = { _radius: 4, _point: point(0, 0), _clickTolerance: () => 0, options: { touchRadius: 22 } };
  assert.ok(Math.abs(tapRadius(stop) - 22 * Math.sqrt(1.07)) < 1e-9);
});

test('labelled route stops use the shared tap target', () => {
  const extend = (base = function Base() {}) => (props) => {
    function Extended(...args) { base.apply(this, args); }
    Extended.prototype = Object.create(base.prototype);
    Object.assign(Extended.prototype, props);
    Extended.extend = extend(Extended);
    return Extended;
  };
  function Canvas(options) { this.options = options; }
  Canvas.extend = extend(Canvas);
  function CircleMarker(latlng, options) { this.options = options; }
  CircleMarker.extend = extend(CircleMarker);
  const L = { Canvas, CircleMarker };
  const { circleMarker } = createLabelCanvas(L);
  const marker = circleMarker([0, 0], { radius: 6, touchRadius: 20 });
  marker._radius = 6;
  marker._point = point(0, 0);
  marker._clickTolerance = () => 12;
  assert.equal(marker._containsPoint(point(20 * Math.sqrt(1.07) - 0.01, 0)), true);
  assert.equal(marker._containsPoint(point(20 * Math.sqrt(1.07) + 0.01, 0)), false);
});

test('every circle dot on the manager map uses the shared tap target', () => {
  const patches = read('src/components/map/leafletPatches.js');
  assert.match(patches, /L\.Canvas\.mergeOptions\(\{ tolerance: 12 \}\)/);
  assert.match(patches, /L\.CircleMarker\.prototype\._containsPoint = function containsPointWithinTapTarget\(point\) \{\s*return isWithinTapTarget\(this, point\);/);
  assert.match(read('src/components/map/labelCanvas.js'), /_containsPoint\(point\) \{\s*return isWithinTapTarget\(this, point\);/);
});
