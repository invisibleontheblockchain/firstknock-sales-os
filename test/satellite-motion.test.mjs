import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceSatelliteProgress as advance, OPENING_CATCH_UP, OPENING_END } from '../src/components/marketing/satelliteMotion.js';

const run = (from, to, seconds, fps = 60) => {
  let progress = from;
  for (let frame = 0; frame < Math.round(seconds * fps); frame++) progress = advance(progress, to, 1 / fps);
  return progress;
};

test('the opening follows the scroll closely: no speed cap, only a short catch-up', () => {
  assert.ok(OPENING_CATCH_UP >= 0 && OPENING_CATCH_UP <= 0.04, 'well under 150 ms to catch up');
  assert.ok(advance(0, 1.6, 1 / 60) > 0.3, 'a flick moves the camera at once (the old cap allowed 0.015)');
  assert.ok(run(0, 1.6, 0.1) > 1.6 * 0.95, '95% of a jump within 100 ms');
  // a steady finger: the camera trails the page by at most OPENING_CATCH_UP seconds of scroll
  for (const fps of [60, 120]) {
    let progress = 0, target = 0;
    for (let frame = 0; frame < fps; frame++) { target += 0.64 / fps; progress = advance(progress, target, 1 / fps); }
    assert.ok(target - progress <= 0.64 * OPENING_CATCH_UP + 1e-9, `${fps} Hz trails by ${(target - progress).toFixed(4)}`);
  }
});

test('opening motion is the same at 60 and 120 Hz', () => {
  for (const seconds of [0.05, 0.1, 0.5]) assert.ok(Math.abs(run(0, 1.6, seconds, 60) - run(0, 1.6, seconds, 120)) < 1e-9);
});

test('the opening and the map views hand over at the end of the opening, both ways', () => {
  // forwards: a flick into the map views stops the fast catch-up where they start; they then ease in
  assert.equal(advance(2, 6, 1 / 60), OPENING_END);
  assert.ok(Math.abs(advance(OPENING_END, 6, 1 / 60) - (OPENING_END + (6 - OPENING_END) * (1 - Math.pow(0.004, 1 / 60)))) < 1e-12);
  // backwards: the map views keep their easing down to the opening, which then follows closely
  assert.ok(advance(6, 0, 1 / 60) < 5.9);
  assert.equal(advance(2.8, 0, 0.05), OPENING_END);
  assert.ok(advance(OPENING_END, 0, 1 / 60) < OPENING_END);
  assert.ok(run(OPENING_END, 0, 0.15) < 0.1);
  assert.equal(run(OPENING_END, OPENING_END, 0.5), OPENING_END, 'at rest where they meet');
});

test('small movements converge without overshooting and reduced motion stays immediate', () => {
  let progress = 0;
  for (let frame = 0; frame < 120; frame++) {
    progress = advance(progress, 0.1, 1 / 60);
    assert.ok(progress <= 0.1);
  }
  assert.ok(progress > 0.099);
  assert.ok(advance(0, 6, 2) <= OPENING_END, 'a stalled frame never jumps past the opening');
  assert.equal(advance(0, 4, 1 / 60, true), 4);
  assert.equal(advance(0, 20, 1 / 60, true), 6);
  assert.equal(advance(2, -1, 1 / 60, true), 0);
});
