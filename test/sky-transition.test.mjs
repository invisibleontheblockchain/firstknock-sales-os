import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  AERIAL_VIDEO_TIME,
  DOOR,
  PHASES,
  SKY_START,
  aerialVideoTime,
  cloudAlpha,
  scrollAtFlyTime,
  skyFrame,
} from '../src/components/marketing/skyTransition.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const END = scrollAtFlyTime(AERIAL_VIDEO_TIME);
// The bank's lower half is opaque (SatelliteLanding.css); at -45% or higher it fills the screen.
const covered = (f) => (f.bank === 1 && f.bankY <= -45) || f.day >= 0.999;
const numbers = (f) => [f.scale, f.dx, f.ty, f.feather, f.bankY / 100, f.bank, f.day, f.ring, f.ringScale / 4, ...f.puffs.flatMap((p) => [p.y / 100, p.scale / 4, p.opacity])];

test('the move spans the flyover\'s first 3.5 s of scroll, as before', () => {
  const smooth = (v) => v * v * (3 - 2 * v);
  assert.ok(Math.abs(smooth((END - 0.08) / 1.62) * 8 - AERIAL_VIDEO_TIME) < 1e-6);
  assert.ok(END > 0.82 && END < 0.823);
  assert.equal(SKY_START, 0.08);
});

test('at rest the hero is untouched, and after the move only the aerial chain is left', () => {
  for (const cur of [0, 0.05, SKY_START]) {
    const f = skyFrame(cur);
    assert.deepEqual([f.scale, f.dx, f.ty, f.feather, f.clouds, f.aerial], [1, 0, 0, 0, false, false], `cur ${cur}`);
  }
  for (const cur of [END, 1, 1.6, 3]) {
    const f = skyFrame(cur);
    assert.equal(f.aerial, true);
    assert.equal(f.clouds, false, 'no cloud layer left over the aerial chain');
  }
});

test('the house changes only while the clouds cover the whole screen', () => {
  for (const reduce of [false, true]) {
    let last = skyFrame(0, { reduce });
    for (let cur = 0; cur <= 1.2; cur += 0.0005) {
      const f = skyFrame(cur, { reduce });
      if (f.aerial !== last.aerial) {
        assert.ok(covered(last) && covered(f), `swap at cur ${cur.toFixed(4)} (reduce ${reduce}) is under full cover`);
      }
      last = f;
    }
    // and the cover holds for a margin either side of the swap
    for (let u = PHASES.swap - 0.03; u <= PHASES.swap + 0.03; u += 0.002) {
      assert.ok(covered(skyFrame(SKY_START + u * (END - SKY_START), { reduce })), `u ${u.toFixed(3)}`);
    }
  }
});

test('nothing jumps between neighbouring scroll positions, so it plays smoothly both ways', () => {
  for (const reduce of [false, true]) {
    let prev = numbers(skyFrame(0, { reduce }));
    for (let cur = 0.001; cur <= 1.2; cur += 0.001) {
      const next = numbers(skyFrame(cur, { reduce }));
      const jump = Math.max(...next.map((v, i) => Math.abs(v - prev[i])));
      // bank opacity steps 1 -> 0 once, but only under the opaque day fog (checked below)
      assert.ok(jump < 0.03 || skyFrame(cur, { reduce }).day >= 0.999, `jump ${jump.toFixed(3)} at cur ${cur.toFixed(3)} (reduce ${reduce})`);
      prev = next;
    }
  }
});

test('the camera pushes toward the door, tilts up off the house, and the clouds part outward', () => {
  const at = (u) => skyFrame(SKY_START + u * (END - SKY_START));
  assert.ok(at(0.34).scale > 1.2 && at(0.34).dx > 0.04, 'pushed in, door drifting to the centre');
  assert.ok(at(0.6).ty >= 1, 'tilted up past the top of the photo');
  assert.ok(at(0.3).feather === 1, 'treetops dissolved into the sky before the edge shows');
  assert.ok(at(0.75).ring === 1 && at(0.75).day < 0.5 && at(0.75).ringScale > 1.2, 'clearing from the centre outward');
  assert.ok(at(0.99).ring < 0.05 && at(0.99).puffs.every((p) => p.opacity < 0.01));
  assert.equal(DOOR.x, 0.455);
  assert.match(read('src/components/marketing/SatelliteLanding.css'), /#heroCam \{ position: absolute; inset: 0; transform-origin: 45\.5% 52\.6%;/);
});

test('reduced motion is a plain fade through the cloud colour', () => {
  for (let cur = 0; cur <= 1.2; cur += 0.01) {
    const f = skyFrame(cur, { reduce: true });
    assert.deepEqual([f.scale, f.dx, f.ty, f.ring, f.puffs.length], [1, 0, 0, 0, 0]);
  }
});

test('the flyover never shows a frame before its settled aerial (no redrawn house)', () => {
  for (let t = 0; t <= 8; t += 1 / 24) assert.ok(aerialVideoTime(t) >= AERIAL_VIDEO_TIME);
  assert.equal(aerialVideoTime(6), 6);
});

test('cloud texture is soft, varied and the same every time', () => {
  const a = cloudAlpha(64, 11, 3), b = cloudAlpha(64, 11, 3), c = cloudAlpha(64, 18, 4);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  const clear = a.filter((v) => v < 20).length / a.length, dense = a.filter((v) => v > 200).length / a.length;
  assert.ok(clear > 0.1 && dense > 0.05, `clear ${clear.toFixed(2)} dense ${dense.toFixed(2)}`);
});

test('the landing wires the camera, the sky, the clouds and the aerial ground', () => {
  const jsx = read('src/components/marketing/SatelliteLanding.jsx');
  assert.match(jsx, /<div id="heroCam">\s*<div className="hero-sky"><\/div>\s*<div className="hero-placeholder" id="housePlaceholder"[^>]*><\/div>\s*<picture>[\s\S]*?<img id="housePhoto"[\s\S]*?<\/picture>\s*<div className="hero-feather" id="heroFeather"><\/div>\s*<\/div>/);
  assert.match(jsx, /<div id="clouds" aria-hidden="true">\s*<div className="bank"><\/div>\s*<div className="fog-day"><\/div>\s*<div className="ring"><\/div>\s*(<div className="puff"><\/div>\s*){3}<\/div>/);
  assert.match(jsx, /<img id="flyAerial" alt="" data-src="\/landing\/flyover-roof-consistent-3500ms\.webp"/);
  assert.doesNotMatch(jsx, /<img[^>]*src="[^"]*\.(png|jpe?g|webp|avif)"[^>]*cloud/i, 'no cloud images');

  const scene = read('src/components/marketing/satelliteScene.js');
  assert.match(scene, /const sky = skyFrame\(cur, \{ dur, reduce \}\);/);
  assert.match(scene, /const videoWant = aerialVideoTime\(want\);/);
  assert.match(scene, /heroCam\.style\.visibility = sky\.aerial \? 'hidden' : '';/);
  assert.match(scene, /flyAerial\.style\.opacity = sky\.aerial && !videoOnAerial \? 1 : 0;/);
  assert.match(scene, /const hold = sky\.aerial && !videoOnAerial && !stillReady && cur < 1\.6;/);
  assert.doesNotMatch(scene, /flyoverMorph|data-shown/);
});
