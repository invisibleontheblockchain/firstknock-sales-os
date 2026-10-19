import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import test from 'node:test';
import {
  HERO_AVIF_SRCSET,
  HERO_JPEG_SRC,
  HERO_PLACEHOLDER,
  HERO_SIZES,
  HERO_WEBP_SRCSET,
  revealWhenDecoded,
} from '../src/components/marketing/heroImage.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const publicFile = (url) => new URL(`../public${url}`, import.meta.url);
const flush = () => new Promise((resolve) => setImmediate(resolve));

class FakeImage extends EventTarget {
  constructor({ complete = false, naturalWidth = 0, decode = () => Promise.resolve() } = {}) {
    super();
    this.complete = complete;
    this.naturalWidth = naturalWidth;
    this.decode = decode;
    this.attributes = new Set();
  }
  setAttribute(name) { this.attributes.add(name); }
  load() { this.complete = true; this.naturalWidth = 2688; this.dispatchEvent(new Event('load')); }
}

test('the house photo stays transparent until it is fully downloaded and decoded', async () => {
  let finishDecode;
  const img = new FakeImage({ decode: () => new Promise((resolve) => { finishDecode = resolve; }) });
  const settled = [];
  revealWhenDecoded(img, (ok) => settled.push(ok));

  await flush();
  assert.equal(img.attributes.has('data-ready'), false, 'nothing shows while bytes are still arriving');
  img.load();
  await flush();
  assert.equal(img.attributes.has('data-ready'), false, 'nothing shows while it decodes');
  assert.deepEqual(settled, []);
  finishDecode();
  await flush();
  assert.equal(img.attributes.has('data-ready'), true);
  assert.deepEqual(settled, [true]);
  img.load();
  await flush();
  assert.deepEqual(settled, [true], 'settles once');
});

test('a photo that is already in the cache is revealed at once; a broken one never is', async () => {
  const cached = new FakeImage({ complete: true, naturalWidth: 1440 });
  const cachedSettled = [];
  revealWhenDecoded(cached, (ok) => cachedSettled.push(ok));
  await flush();
  assert.deepEqual(cachedSettled, [true]);
  assert.equal(cached.attributes.has('data-ready'), true);

  const broken = new FakeImage({ complete: true, naturalWidth: 0 });
  const brokenSettled = [];
  revealWhenDecoded(broken, (ok) => brokenSettled.push(ok));
  assert.deepEqual(brokenSettled, [false], 'the rest of the landing still starts');
  assert.equal(broken.attributes.has('data-ready'), false);

  const failing = new FakeImage();
  const failingSettled = [];
  revealWhenDecoded(failing, (ok) => failingSettled.push(ok));
  failing.dispatchEvent(new Event('error'));
  assert.deepEqual(failingSettled, [false]);
});

test('a decode() rejection after a complete load still reveals the photo', async () => {
  const img = new FakeImage({ decode: () => Promise.reject(new Error('EncodingError')) });
  const settled = [];
  revealWhenDecoded(img, (ok) => settled.push(ok));
  img.load();
  await flush();
  assert.deepEqual(settled, [true]);
  assert.equal(img.attributes.has('data-ready'), true);
});

test('leaving the landing before the photo arrives cancels the reveal', async () => {
  const img = new FakeImage();
  const settled = [];
  const stop = revealWhenDecoded(img, (ok) => settled.push(ok));
  stop();
  img.load();
  await flush();
  assert.deepEqual(settled, []);
  assert.equal(img.attributes.has('data-ready'), false);
});

test('index.html preloads exactly the AVIF the landing picks, early, only on the landing, without outranking the app scripts', () => {
  const html = read('index.html');
  const head = html.slice(0, html.indexOf('</head>'));
  const preload = head.match(/<script id=\"fk-hero-preload\">\s*\/\/ Landing hero:[\s\S]*?<\/script>/)?.[0];
  assert.ok(preload, 'the preload runs from <head>, before the app bundle');
  assert.ok(head.indexOf(preload) < head.indexOf('<link rel="icon"'), 'it comes first in <head>');
  assert.equal(preload.match(/'imagesrcset', '([^']+)'/)[1], HERO_AVIF_SRCSET);
  assert.equal(preload.match(/'imagesizes', '([^']+)'/)[1], HERO_SIZES);
  assert.match(preload, /link\.rel = 'preload';\s*link\.as = 'image';\s*link\.type = 'image\/avif';/);
  assert.doesNotMatch(preload, /setAttribute\('fetchpriority'|\.fetchPriority =/, 'a high-priority preload would queue the app scripts behind the photo');
  // pwa-refresh-resilience.test.mjs runs the first plain <script> as the PWA script.
  assert.match(html.match(/<script>\s*([\s\S]*?)<\/script>/)[1], /FK_PWA_RELEASE/);
  assert.match(preload, /window\.location\.pathname !== '\/'/);
  assert.match(preload, /display-mode/);
  assert.doesNotMatch(preload, /setAttribute\('href'|link\.href/, 'no href: browsers without imagesrcset fetch nothing');
});

test('the landing shows the photo through <picture>, never as the video poster', () => {
  const jsx = read('src/components/marketing/SatelliteLanding.jsx');
  assert.doesNotMatch(jsx, /poster=/, 'a poster paints top-down as it downloads');
  assert.match(jsx, /<source type="image\/avif" srcSet=\{HERO_AVIF_SRCSET\} sizes=\{HERO_SIZES\} \/>\s*<source type="image\/webp" srcSet=\{HERO_WEBP_SRCSET\} sizes=\{HERO_SIZES\} \/>\s*(?:\{\/\*[^}]*\*\/\}\s*)?<img id="housePhoto" alt="" src=\{HERO_JPEG_SRC\} fetchpriority="high"/);
  assert.match(jsx, /id="housePlaceholder" style=\{\{ backgroundImage: HERO_PLACEHOLDER \}\}/);
  // Everything else on the landing waits for the photo (or the first scroll).
  assert.doesNotMatch(jsx, /<img[^>]* src="\/landing\//);
  assert.equal(jsx.match(/data-src="\/landing\/satellite-[\w-]+\.jpg"/g).length, 3);
  assert.match(jsx, /function SatelliteStill\(\{ still, id \}\) \{[\s\S]*?data-srcset=\{still\.avif\} sizes=\{still\.sizes\}[\s\S]*?data-srcset=\{still\.webp\} sizes=\{still\.sizes\}[\s\S]*?<img id=\{id\} alt="" data-src=\{still\.jpg\}/);
  assert.equal(jsx.match(/<SatelliteStill still=\{SATELLITE_STILLS\.end\} id="sat" \/>/g).length, 1, '#sat loads after the photo too');

  const css = read('src/components/marketing/SatelliteLanding.css');
  assert.match(css, /#housePhoto \{ opacity: 0; transition: opacity \.45s ease-out; \}/);
  assert.match(css, /#housePhoto\[data-ready\] \{ opacity: 1; \}/);
  // The video starts transparent over the photo; the scene fades it in on its first frame (flyover.js).
  assert.match(css, /#fly \{ opacity: 0; will-change: opacity; \}/);

  const scene = read('src/components/marketing/satelliteScene.js');
  const startExtras = scene.match(/const startExtras = \(\) => \{[\s\S]*?\n {2}\};/)[0];
  assert.match(startExtras, /img\.src = img\.dataset\.src/);
  assert.match(startExtras, /if \(!reduce\) loadFlyover\(\);/);
  assert.equal(scene.match(/fly\.src =/g).length, 1, 'the flyover loads only through loadFlyover');
  assert.match(scene, /revealWhenDecoded\(housePhoto, \(ok\) => \{[\s\S]*?startExtras\(\);\s*\}\)/);
  assert.match(scene, /if \(root\.scrollTop > 0\) startExtras\(\);/);
  assert.match(scene, /fly\.addEventListener\('seeked', onFrame\)/);
  assert.match(scene, /fly\.style\.opacity = flyoverOpacity\(cur, hasFrame, shownTime < videoFrame \/ 2\);/);
});

// Width of an AVIF (its 'ispe' box) or lossy WebP ('VP8 ' frame header).
function imageWidth(bytes) {
  const ispe = bytes.indexOf('ispe');
  if (ispe > 0) return bytes.readUInt32BE(ispe + 8);
  assert.equal(bytes.toString('latin1', 12, 16), 'VP8 ');
  return bytes.readUInt16LE(26) & 0x3fff;
}

test('every srcset candidate exists at its stated width and stays far below the old 1.2 MB JPEG', () => {
  for (const srcset of [HERO_AVIF_SRCSET, HERO_WEBP_SRCSET]) {
    const candidates = srcset.split(', ').map((entry) => entry.split(' '));
    assert.deepEqual(candidates.map(([, w]) => w), ['1440w', '1920w', '2688w']);
    for (const [url, w] of candidates) {
      const bytes = readFileSync(publicFile(url));
      assert.equal(imageWidth(bytes), Number.parseInt(w, 10), url);
      assert.ok(bytes.length < 650_000, `${url} is ${bytes.length} bytes`);
    }
  }
  assert.ok(statSync(publicFile(HERO_JPEG_SRC)).size > 0, 'JPEG fallback for browsers without AVIF or WebP');
  assert.ok(HERO_PLACEHOLDER.length < 1200, `inline placeholder is ${HERO_PLACEHOLDER.length} characters`);
  assert.match(decodeURIComponent(HERO_PLACEHOLDER), /feGaussianBlur/);
});
