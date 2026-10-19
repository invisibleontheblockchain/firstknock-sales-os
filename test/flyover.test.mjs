import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { SATELLITE_STILLS, FLYOVER_SRC, FLYOVER_FRAMES, DOOR_FRAME, END_PATCH, END_MASK, MOVE_START, HANDOFF_AT, PORTRAIT_QUERY, SAT_MATCH_FRAMES, flyoverFrame, flyoverOpacity, satelliteOpacity } from '../src/components/marketing/flyover.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url));
const pub = (url) => read(`public${url}`);
// Where section 01's and 02's headings are fully on screen (screens of scroll), measured on the landing:
// iPhone 13 page, a taller phone, a 1440 x 900 desktop and a 1280 x 720 laptop.
const LAYOUTS = { phone: [0.907, 1.907], tallPhone: [0.929, 1.929], desktop: [0.72, 1.72], laptop: [0.737, 1.737] };

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
  assert.equal(wide.frames, FLYOVER_FRAMES);
  assert.equal(portrait.frames, FLYOVER_FRAMES);
  // The phone file is shown on 3x screens, so it is encoded at much higher quality.
  assert.ok(pub(FLYOVER_SRC.wide).length < 6_000_000 && pub(FLYOVER_SRC.portrait).length < 8_000_000);
});

test('scroll shows the ~80 degree view as section 01 is on screen and the whole subdivision as section 02 is, without a jump in speed', () => {
  for (const [name, [door, end]] of Object.entries(LAYOUTS)) {
    assert.equal(flyoverFrame(0, door, end), 0, name);
    assert.equal(flyoverFrame(MOVE_START, door, end), 0, name);
    assert.ok(Math.abs(flyoverFrame(door, door, end) - DOOR_FRAME) < 1e-9, `${name}: frame ${DOOR_FRAME} at the door`);
    assert.equal(flyoverFrame(end, door, end), FLYOVER_FRAMES - 1, name);
    assert.equal(flyoverFrame(end + 0.5, door, end), FLYOVER_FRAMES - 1, name);
    let last = 0, lastSlope = 0;
    const step = 0.0005;
    for (let cur = MOVE_START; cur <= end; cur += step) {
      const f = flyoverFrame(cur, door, end);
      assert.ok(f >= last - 1e-9, `${name}: never runs backwards (${cur.toFixed(4)})`);
      const slope = (f - last) / step;
      if (cur > MOVE_START + 2 * step) assert.ok(Math.abs(slope - lastSlope) < 4, `${name}: no jump in speed at ${cur.toFixed(4)} (${lastSlope.toFixed(1)} -> ${slope.toFixed(1)} frames per screen)`);
      last = f; lastSlope = slope;
    }
    // still at both ends: the move eases out of the photo and settles on the subdivision
    assert.ok(flyoverFrame(MOVE_START + 0.01, door, end) < 0.25, name);
    assert.ok(FLYOVER_FRAMES - 1 - flyoverFrame(end - 0.01, door, end) < 0.25, name);
  }
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
  // The scene asks for frame 1 once flyoverFrame reaches half a frame: by then the video is up.
  for (const [name, [door, end]] of Object.entries(LAYOUTS)) {
    let cur = MOVE_START;
    while (flyoverFrame(cur, door, end) < 0.5) cur += 0.0005;
    assert.equal(flyoverOpacity(cur, true), 1, `${name}: on before the camera moves (frame 1 at ${cur.toFixed(3)} screens)`);
  }
});

test('#sat, the still of the last frame, fades in only over that frame and covers any other at once', () => {
  assert.equal(SAT_MATCH_FRAMES, 1, 'the move does not slow to a stop: only the last frame is the still');
  assert.equal(satelliteOpacity(0, true, 60), 0);
  assert.equal(satelliteOpacity(0.5, true, 0), 0.5);
  assert.equal(satelliteOpacity(0.5, true, 1), 1, 'a flick outran the seeks: no earlier frame shows through the still');
  assert.equal(satelliteOpacity(0.01, false, 0), 1, 'not loaded yet: the still, not the photo under it');
  // The scene fades #sat in from `end`, where it already asks for the last frame.
  for (const [door, end] of Object.values(LAYOUTS)) {
    for (let cur = end; cur <= end + 0.05; cur += 0.001) assert.equal(Math.round(flyoverFrame(cur, door, end)), FLYOVER_FRAMES - 1);
  }
  const scene = read('src/components/marketing/satelliteScene.js').toString();
  assert.match(scene, /const satFade = reduce \? band\(end - 0\.2, end, cur\) : band\(end, end \+ 0\.05, cur\);/);
  assert.match(scene, /sat\.style\.opacity = reduce \? satFade : satelliteOpacity\(satFade, hasFrame, frames - 1 - Math\.round\(shownTime \/ videoFrame\)\);/);
  // and only pulls back once #sat is fully up
  assert.match(scene, /const pA = end \+ 0\.06, pB = Math\.max\(2\.12, pA \+ 0\.25\);/);
});

test('upright phones get the middle of the frame, placed exactly where it sits in the full frame', () => {
  const css = read('src/components/marketing/SatelliteLanding.css').toString();
  const [, left, width] = css.match(/#fly\.portrait \{ left: ([\d.]+)%; width: ([\d.]+)%; object-fit: fill; \}/);
  const scale = Math.max(2688 / 1912, 1520 / 1080); // the 1912 x 1080 frame covering the 2688 x 1520 layer
  const cropWidth = (864 * scale) / 2688;
  assert.ok(Math.abs(Number(width) / 100 - cropWidth) < 1e-4);
  assert.ok(Math.abs(Number(left) / 100 - (1 - cropWidth) / 2) < 1e-4);
  // The widest "portrait" screen sees this much of the layer while the video shows (the camera
  // only pulls back once #sat covers it).
  assert.equal(PORTRAIT_QUERY, '(max-aspect-ratio: 3/5)');
  const seen = (3 / 5) / (2688 / 1520);
  assert.ok(seen < cropWidth, `sees ${seen.toFixed(3)} of the layer, crop is ${cropWidth.toFixed(3)}`);
});

test('#sat is the last frame in the layer\'s aspect in AVIF, WebP and JPEG; the region map holds the same subdivision', () => {
  const still = SATELLITE_STILLS.end;
  const avif = pub(still.avif), ispe = avif.indexOf('ispe');
  const [width, height] = [avif.readUInt32BE(ispe + 8), avif.readUInt32BE(ispe + 12)];
  assert.deepEqual([width, height], [1910, 1080], 'the 1912-wide frame less the ~1 px the video cover-crops each side');
  assert.ok(Math.abs(width / height - 2688 / 1520) < 0.0002);
  assert.ok(avif.length < 1_500_000);
  assert.equal(pub(still.webp).toString('latin1', 8, 12), 'WEBP');
  assert.equal(pub(still.jpg).readUInt16BE(0), 0xffd8);
  const region = pub('/landing/satellite-region-house.jpg');
  assert.equal(region.readUInt16BE(0), 0xffd8);
  // the scene places the subdivision where the map has it, and masks the video layer with the map's ellipse
  assert.deepEqual(END_PATCH, { k: 0.12, cx: 1284.86, cy: 762.6 });
  assert.equal(END_MASK, 'radial-gradient(closest-side, #000 60%, rgba(0, 0, 0, .844) 70%, rgba(0, 0, 0, .5) 80%, rgba(0, 0, 0, .156) 90%, transparent 100%)');
  const scene = read('src/components/marketing/satelliteScene.js').toString();
  assert.match(scene, /const RT = \{ x: END_PATCH\.cx - IW \* KT \/ 2, y: END_PATCH\.cy - IH \* KT \/ 2, w: IW \* KT, h: IH \* KT \};/);
  assert.match(scene, /L\.tight\.style\.maskImage = L\.tight\.style\.webkitMaskImage = soften > 0 \? END_MASK : '';/);
});

test('the other house is gone: its stills, the roof hold, the wide layer and every older flyover', () => {
  for (const old of ['flyover-rise-desktop.mp4', 'flyover-rise-phone.mp4', 'satellite-hero-day-2688.avif', 'satellite-hero-day-2688.webp', 'satellite-hero-day-2688.jpg', 'satellite-hero-day-3820.avif', 'satellite-hero-day-3820.webp', 'satellite-zoom-hero-day.avif', 'satellite-zoom-hero-day.webp', 'satellite-zoom-hero-day.jpg', 'satellite-region.jpg', 'flyover-golden-v3-desktop.mp4', 'flyover-golden-v3-phone.mp4', 'flyover-golden-v2-desktop.mp4', 'flyover-golden-v2-phone.mp4', 'satellite-hero-day.avif', 'satellite-hero-day.jpg', 'flyover-golden-desktop.mp4', 'flyover-golden-phone.mp4', 'flyover-hero-desktop.mp4', 'flyover-hero-phone.mp4', 'satellite-hero-dusk.avif', 'satellite-zoom-hero-dusk.avif', 'house-lux.jpg', 'house-lux-2688.avif', 'flyover-roof-consistent.mp4', 'flyover-roof-consistent-3500ms.avif', 'flyover-roof-consistent-3500ms.webp', 'satellite-roof-consistent.jpg', 'satellite-zoom-roof-consistent.jpg', 'flyover-lux.mp4', 'satellite-lux.jpg', 'satellite-zoom-lux.jpg']) {
    assert.equal(existsSync(new URL(`../public/landing/${old}`, import.meta.url)), false, old);
  }
  assert.equal(existsSync(new URL('../src/components/marketing/skyTransition.js', import.meta.url)), false);
  const jsx = read('src/components/marketing/SatelliteLanding.jsx').toString();
  const css = read('src/components/marketing/SatelliteLanding.css').toString();
  const scene = read('src/components/marketing/satelliteScene.js').toString();
  for (const source of [jsx, css, scene, read('src/components/marketing/flyover.js').toString(), read('src/components/marketing/heroImage.js').toString(), read('index.html').toString()]) {
    assert.doesNotMatch(source, /heroCam|clouds|flyAerial|skyTransition|roof-consistent|-dusk|house-lux|satellite-hero-day|satellite-zoom|lHouse|lWide/);
  }
});

test('the scene scrubs the flyover from the photo and loads the right size after the photo', () => {
  const jsx = read('src/components/marketing/SatelliteLanding.jsx').toString();
  assert.match(jsx, /<img id="housePhoto"[^>]*\/>\s*<\/picture>\s*\{\/\*[^}]*\*\/\}\s*<video id="fly" muted playsInline preload="auto"><\/video>\s*<SatelliteStill still=\{SATELLITE_STILLS\.end\} id="sat" \/>/);
  const scene = read('src/components/marketing/satelliteScene.js').toString();
  assert.match(scene, /const src = portrait \? FLYOVER_SRC\.portrait : FLYOVER_SRC\.wide;/);
  assert.match(scene, /if \(!reduce\) loadFlyover\(\);/, 'reduced motion: the photo, then the fade to the final still');
  assert.match(scene, /fly\.currentTime = want;/);
  assert.match(scene, /Math\.round\(flyoverFrame\(cur, door, end, frames\)\) \* videoFrame/);
  // the door and the end come from where section 01's and 02's headings sit on this screen
  assert.match(scene, /const \[h1, h2\] = root\.querySelectorAll\('section h2'\);/);
  assert.match(scene, /function layout\(\) \{[^}]*measureAnchors\(\); \}/);
  // iOS Safari shows a later frame after loading until something seeks it.
  assert.match(scene, /const onLoaded = \(\) => \{ fly\.currentTime = 0\.001; \};/);
  assert.match(scene, /fly\.addEventListener\('loadeddata', onLoaded\);/);
});
