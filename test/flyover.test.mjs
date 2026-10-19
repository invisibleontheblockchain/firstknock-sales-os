import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { SATELLITE_STILLS, FLYOVER_SRC, HANDOFF_AT, PORTRAIT_QUERY, SAT_MATCH_FRAMES, flyoverOpacity, satelliteOpacity } from '../src/components/marketing/flyover.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url));
const pub = (url) => read(`public${url}`);
const smooth = (v) => { v = Math.min(1, Math.max(0, v)); return v * v * (3 - 2 * v); };

// Just enough MP4 to check what the scroll scrubbing relies on.
function mp4(bytes) {
  const box = (type) => bytes.indexOf(Buffer.from(type, 'latin1'));
  const stsz = box('stsz'), stss = box('stss'), tkhd = box('tkhd');
  const frames = bytes.readUInt32BE(stsz + 12);
  return {
    h264: box('avc1') > 0,
    frames,
    keyframes: stss < 0 ? frames : bytes.readUInt32BE(stss + 8), // no stss: every sample is a sync sample
    width: bytes.readUInt32BE(tkhd - 4 + 84) / 65536,
    height: bytes.readUInt32BE(tkhd - 4 + 88) / 65536,
  };
}

test('the flyover is H.264 with every frame a keyframe, a few MB, and both sizes carry the same frames', () => {
  const wide = mp4(pub(FLYOVER_SRC.wide)), portrait = mp4(pub(FLYOVER_SRC.portrait));
  assert.deepEqual([wide.h264, wide.width, wide.height], [true, 1912, 1080]);
  assert.deepEqual([portrait.h264, portrait.width, portrait.height], [true, 864, 1080]);
  assert.equal(wide.keyframes, wide.frames, 'scroll can seek to any frame without decoding others');
  assert.equal(portrait.keyframes, portrait.frames);
  assert.equal(wide.frames, portrait.frames);
  assert.ok(wide.frames >= 96 && wide.frames <= 160, `${wide.frames} frames`);
  // The phone file is the larger one: it is shown on 3x screens, so it is encoded at much higher quality.
  assert.ok(pub(FLYOVER_SRC.wide).length < 6_000_000 && pub(FLYOVER_SRC.portrait).length < 8_000_000);
});

test('the video takes over from the photo on its first frame, which is the photo', () => {
  assert.equal(flyoverOpacity(0.5, false), 0, 'nothing to show until it has a frame');
  assert.equal(flyoverOpacity(0, true), 0, 'the photo at rest');
  assert.equal(flyoverOpacity(0.08, true), 0);
  assert.equal(flyoverOpacity(0.1, true), 1);
  for (let cur = 0; cur <= 2; cur += 0.001) {
    assert.ok([0, 1].includes(flyoverOpacity(cur, true)), 'a swap, never a fade: no frame shows two copies of the house');
  }
  assert.equal(flyoverOpacity(HANDOFF_AT - 0.001, true), 0);
  assert.equal(flyoverOpacity(HANDOFF_AT, true), 1);
  assert.equal(flyoverOpacity(0.085, true, false), 1, 'a later frame is never blended over the photo');
  assert.equal(flyoverOpacity(0.085, false, false), 0);
  let last = 0;
  for (let cur = 0; cur <= 0.2; cur += 0.002) { const o = flyoverOpacity(cur, true); assert.ok(o >= last); last = o; }
  // The scene shows frame 1 once band(0.08, 1.7, cur) * duration reaches half a frame.
  const frames = mp4(pub(FLYOVER_SRC.wide)).frames, duration = frames / 24;
  let cur = 0.08;
  while (smooth((cur - 0.08) / 1.62) * duration < 0.5 / 24) cur += 0.0005;
  assert.equal(flyoverOpacity(cur, true), 1, `fully faded in before the camera moves (frame 1 at ${cur.toFixed(3)} screens)`);
});

test('#sat fades in over the video only while it shows its last frames, and covers any other frame at once', () => {
  assert.equal(satelliteOpacity(0, true, 60), 0);
  assert.equal(satelliteOpacity(0.5, true, 0), 0.5);
  assert.equal(satelliteOpacity(0.5, true, SAT_MATCH_FRAMES - 1), 0.5);
  assert.equal(satelliteOpacity(0.5, true, SAT_MATCH_FRAMES), 1, 'a flick outran the seeks: no earlier frame shows through the still');
  assert.equal(satelliteOpacity(0.01, false, 0), 1, 'not loaded yet: the still, not the photo under it');
  // While #sat fades (1.55-1.75 screens) the scene asks for frames well inside that window,
  // so a steady scroll keeps the fade even with a seek or two still landing.
  const frames = mp4(pub(FLYOVER_SRC.wide)).frames;
  for (let cur = 1.55; cur <= 1.75; cur += 0.001) {
    const want = Math.min(frames - 1, Math.round(smooth((cur - 0.08) / 1.62) * frames));
    assert.ok(frames - 1 - want <= SAT_MATCH_FRAMES - 3, `${cur.toFixed(3)} screens wants frame ${want}`);
  }
});

test('upright phones get the middle of the frame, placed exactly where it sits in the full frame', () => {
  const css = read('src/components/marketing/SatelliteLanding.css').toString();
  const [, left, width] = css.match(/#fly\.portrait \{ left: ([\d.]+)%; width: ([\d.]+)%; object-fit: fill; \}/);
  const scale = Math.max(2688 / 1912, 1520 / 1080); // the 1912 x 1080 frame covering the 2688 x 1520 layer
  const cropWidth = (864 * scale) / 2688;
  assert.ok(Math.abs(Number(width) / 100 - cropWidth) < 1e-4);
  assert.ok(Math.abs(Number(left) / 100 - (1 - cropWidth) / 2) < 1e-4);
  // The widest "portrait" screen sees this much of the layer until #sat covers the video
  // (fully opaque at 1.75 screens, when the pull-back has zoomed out by 0.596^smooth(0.4)).
  const aspect = 3 / 5;
  assert.equal(PORTRAIT_QUERY, '(max-aspect-ratio: 3/5)');
  const seen = (aspect / (2688 / 1520)) / Math.pow(0.596, smooth(0.4));
  assert.ok(seen < cropWidth, `sees ${seen.toFixed(3)} of the layer, crop is ${cropWidth.toFixed(3)}`);
});

test('the daylight satellite stills are full size in AVIF, WebP and JPEG; #sat has the sharp 4K re-render', () => {
  const candidates = (srcset) => srcset.split(', ').map((entry) => { const [url, w] = entry.split(' '); return { url, w: w ? Number.parseInt(w, 10) : 2688 }; });
  for (const [name, still] of Object.entries(SATELLITE_STILLS)) {
    for (const { url, w } of candidates(still.avif)) {
      const avif = pub(url), ispe = avif.indexOf('ispe');
      const [width, height] = [avif.readUInt32BE(ispe + 8), avif.readUInt32BE(ispe + 12)];
      assert.equal(width, w, url);
      assert.ok(Math.abs(width / height - 2688 / 1520) < 0.002, `${url} keeps the layer's aspect`);
      assert.ok(avif.length < 1_500_000, url);
    }
    for (const { url } of candidates(still.webp)) assert.equal(pub(url).toString('latin1', 8, 12), 'WEBP');
    assert.equal(pub(still.jpg).readUInt16BE(0), 0xffd8);
    if (name === 'tight') {
      assert.deepEqual(candidates(still.avif).map((c) => c.w), [2688, 3820], '3x phones get the 3820-wide still');
      assert.equal(still.sizes, '(max-aspect-ratio: 2688/1520) 177vh, 100vw');
    }
  }
});

test('the cloud move, the dissolve still, the dusk set, the tilt and the older flyover assets are gone', () => {
  for (const old of ['flyover-golden-v3-desktop.mp4', 'flyover-golden-v3-phone.mp4', 'flyover-golden-v2-desktop.mp4', 'flyover-golden-v2-phone.mp4', 'satellite-hero-day.avif', 'satellite-hero-day.jpg', 'flyover-golden-desktop.mp4', 'flyover-golden-phone.mp4', 'flyover-hero-desktop.mp4', 'flyover-hero-phone.mp4', 'satellite-hero-dusk.avif', 'satellite-zoom-hero-dusk.avif', 'house-lux.jpg', 'house-lux-2688.avif', 'flyover-roof-consistent.mp4', 'flyover-roof-consistent-3500ms.avif', 'flyover-roof-consistent-3500ms.webp', 'satellite-roof-consistent.jpg', 'satellite-zoom-roof-consistent.jpg', 'flyover-lux.mp4', 'satellite-lux.jpg', 'satellite-zoom-lux.jpg']) {
    assert.equal(existsSync(new URL(`../public/landing/${old}`, import.meta.url)), false, old);
  }
  assert.equal(existsSync(new URL('../src/components/marketing/skyTransition.js', import.meta.url)), false);
  const jsx = read('src/components/marketing/SatelliteLanding.jsx').toString();
  const css = read('src/components/marketing/SatelliteLanding.css').toString();
  const scene = read('src/components/marketing/satelliteScene.js').toString();
  for (const source of [jsx, css, scene, read('src/components/marketing/flyover.js').toString(), read('src/components/marketing/heroImage.js').toString(), read('index.html').toString()]) {
    assert.doesNotMatch(source, /heroCam|clouds|flyAerial|skyTransition|roof-consistent|-dusk|house-lux/);
  }
});

test('the scene scrubs the flyover from the photo and loads the right size after the photo', () => {
  const jsx = read('src/components/marketing/SatelliteLanding.jsx').toString();
  assert.match(jsx, /<img id="housePhoto"[^>]*\/>\s*<\/picture>\s*\{\/\*[^}]*\*\/\}\s*<video id="fly" muted playsInline preload="auto"><\/video>\s*<SatelliteStill still=\{SATELLITE_STILLS\.tight\} id="sat" \/>/);
  const scene = read('src/components/marketing/satelliteScene.js').toString();
  assert.match(scene, /const src = portrait \? FLYOVER_SRC\.portrait : FLYOVER_SRC\.wide;/);
  assert.match(scene, /if \(!reduce\) loadFlyover\(\);/, 'reduced motion: the photo, then the fade to the final still');
  assert.match(scene, /fly\.currentTime = want;/);
  // iOS Safari shows a later frame after loading until something seeks it.
  assert.match(scene, /const onLoaded = \(\) => \{ fly\.currentTime = 0\.001; \};/);
  assert.match(scene, /fly\.addEventListener\('loadeddata', onLoaded\);/);
  assert.match(scene, /const satFade = band\(1\.55, 1\.75, cur\);/);
  assert.match(scene, /sat\.style\.opacity = reduce \? satFade : satelliteOpacity\(satFade, hasFrame, /);
});
