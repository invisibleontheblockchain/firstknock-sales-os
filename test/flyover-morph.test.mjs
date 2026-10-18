import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { aerialStillOpacity, aerialStillScale, flyoverVideoTime, MORPH_FROM, MORPH_TO } from '../src/components/marketing/flyoverMorph.js';

const FRAME = 1 / 24;
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url));

test('no scroll position shows a frame where the clip redraws the house', () => {
  assert.equal(MORPH_FROM * 24, 30, 'whole frames of the 24 fps clip');
  assert.equal(MORPH_TO * 24, 84);
  for (let frame = 0; frame <= 8 * 24; frame++) {
    const shown = flyoverVideoTime(frame / 24);
    assert.ok(shown <= MORPH_FROM || shown >= MORPH_TO, `scroll at ${frame / 24}s shows ${shown}s`);
  }
  assert.equal(flyoverVideoTime(0.5), 0.5, 'the front view plays as before');
  assert.equal(flyoverVideoTime(2), MORPH_FROM, 'held on the last front-view frame');
  assert.equal(flyoverVideoTime(5), 5, 'the aerial plays as before');
});

test('the aerial still dissolves in over the held front-view frame and hands over to the same video frame', () => {
  assert.equal(aerialStillOpacity(0, 0), 0, 'the hero at rest is untouched');
  assert.equal(aerialStillOpacity(MORPH_FROM, MORPH_FROM), 0);
  let last = 0;
  for (let t = MORPH_FROM; t < MORPH_TO; t += 0.05) {
    const opacity = aerialStillOpacity(t, MORPH_FROM);
    assert.ok(opacity >= last, 'only ever fades in on the way down');
    last = opacity;
  }
  assert.ok(last > 0.99);
  // Past the redraw the still stays up until the video is really showing 3.5 s or later.
  assert.equal(aerialStillOpacity(MORPH_TO, MORPH_FROM), 1, 'video still seeking from the held frame');
  assert.equal(aerialStillOpacity(MORPH_TO, MORPH_TO), 0, 'same frame underneath: the still drops out unseen');
  assert.equal(aerialStillOpacity(6, MORPH_TO + 10 * FRAME), 0);
  // Before the video has loaded at all (it shows nothing), the still carries the aerial alone.
  assert.equal(aerialStillOpacity(6, 0), 1);
});

test('the still keeps the camera rising: it settles from 1.15x to exactly the video frame', () => {
  assert.equal(aerialStillScale(MORPH_FROM), 1.15);
  assert.equal(aerialStillScale(MORPH_TO), 1, 'same size as the video frame at the handover');
  assert.equal(aerialStillScale(7), 1);
  let last = Infinity;
  for (let t = MORPH_FROM; t <= MORPH_TO; t += 0.05) { const s = aerialStillScale(t); assert.ok(s <= last); last = s; }
});

test('a video lagging on a redrawn frame is always covered by the still', () => {
  const redrawn = (MORPH_FROM + MORPH_TO) / 2;
  assert.equal(aerialStillOpacity(MORPH_FROM + 0.1, redrawn), 1, 'scrolling back into the dissolve from the aerial');
  assert.equal(aerialStillOpacity(MORPH_FROM + 0.1, MORPH_TO + 1), 1);
  assert.equal(aerialStillOpacity(0.5, redrawn), 1, 'scrolling back past it faster than the video seeks');
  assert.equal(aerialStillOpacity(0.5, 0.5), 0, 'and gone once the front view is back');
  assert.equal(aerialStillOpacity(MORPH_FROM + 0.1, MORPH_FROM) < 0.1, true);
});

test('the landing wires the still behind the video logic and loads it after the hero photo', () => {
  const jsx = read('src/components/marketing/SatelliteLanding.jsx').toString();
  assert.match(jsx, /<video id="fly"[^>]*><\/video>\s*\{\/\*[^}]*\*\/\}\s*<picture>\s*<source type="image\/avif" data-srcset="\/landing\/flyover-roof-consistent-3500ms\.avif" \/>\s*<img id="flyAerial" alt="" data-src="\/landing\/flyover-roof-consistent-3500ms\.webp" decoding="async" \/>\s*<\/picture>\s*<img id="sat"/);
  const css = read('src/components/marketing/SatelliteLanding.css').toString();
  assert.match(css, /#flyAerial \{ opacity: 0; transform-origin: 51% 39%; \}/);
  const scene = read('src/components/marketing/satelliteScene.js').toString();
  assert.match(scene, /const videoWant = flyoverVideoTime\(want\);\s*if \([^)]*fly\.currentTime - videoWant\)[^;]*fly\.currentTime = videoWant;/);
  assert.match(scene, /flyAerial\.style\.opacity = aerialStillOpacity\(flyTime, shownTime, videoFrame\);/);
  assert.match(scene, /flyAerial\.style\.transform = `scale\(\$\{aerialStillScale\(flyTime\)\}\)`;/);
  assert.match(scene, /const onSeeked = \(\) => \{ shownTime = fly\.currentTime;/);
  const startExtras = scene.match(/const startExtras = \(\) => \{[\s\S]*?\n {2}\};/)[0];
  assert.match(startExtras, /source\.srcset = source\.dataset\.srcset/);
  assert.ok(startExtras.indexOf('source.srcset') < startExtras.indexOf('img.src'), 'sources first, so the AVIF is chosen');
});

test('the still is the clip\'s own 1920 x 1080 frame, small enough to load behind the hero', () => {
  const avif = read('public/landing/flyover-roof-consistent-3500ms.avif');
  const ispe = avif.indexOf('ispe');
  assert.deepEqual([avif.readUInt32BE(ispe + 8), avif.readUInt32BE(ispe + 12)], [1920, 1080]);
  const webp = read('public/landing/flyover-roof-consistent-3500ms.webp');
  assert.equal(webp.toString('latin1', 12, 16), 'VP8 ');
  assert.deepEqual([webp.readUInt16LE(26) & 0x3fff, webp.readUInt16LE(28) & 0x3fff], [1920, 1080]);
  assert.ok(avif.length < 200_000 && webp.length < 220_000);
  assert.match(read('src/components/marketing/satelliteScene.js').toString(), /fly\.src = '\/landing\/flyover-roof-consistent\.mp4'/, 'MORPH times belong to this clip');
});
