import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceSatelliteProgress as advance } from '../src/components/marketing/satelliteMotion.js';

test('fast scrolls cannot skip the opening camera move, even after a stalled frame', () => {
  assert.ok(advance(0, 6, 1 / 60) <= 0.015);
  assert.ok(advance(1.65, 6, 2) <= 1.695);
});

test('opening motion has the same speed at 60 and 120 Hz', () => {
  const simulate = (fps) => {
    let progress = 0;
    for (let frame = 0; frame < fps; frame++) progress = advance(progress, 6, 1 / fps);
    return progress;
  };
  assert.ok(Math.abs(simulate(60) - simulate(120)) < 1e-9);
  assert.ok(Math.abs(simulate(60) - 0.9) < 1e-9);
});

test('reverse scrolls enter the opening smoothly without slowing the rest of the map', () => {
  assert.ok(advance(6, 0, 1 / 60) < 5.9);
  assert.equal(advance(2.8, 0, 0.05), 2.75);
  assert.ok(advance(2.7, 0, 1 / 60) >= 2.685);
});

test('small movements converge without overshooting and reduced motion stays immediate', () => {
  let progress = 0;
  for (let frame = 0; frame < 120; frame++) {
    progress = advance(progress, 0.1, 1 / 60);
    assert.ok(progress <= 0.1);
  }
  assert.ok(progress > 0.099);
  assert.equal(advance(0, 4, 1 / 60, true), 4);
  assert.equal(advance(0, 20, 1 / 60, true), 6);
  assert.equal(advance(2, -1, 1 / 60, true), 0);
});
