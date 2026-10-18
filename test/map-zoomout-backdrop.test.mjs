import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { BACKDROP_LEVELS, BACKDROP_RING_TILES, backdropLayerOptions } from '../src/components/map/zoomOutBackdropConfig.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('zoom-out backdrop covers every zoom band below the real basemap', () => {
  assert.deepEqual(BACKDROP_LEVELS.map((level) => [level.nativeZoom, level.minZoom]), [[11, 12], [8, 9]]);
  assert.equal(BACKDROP_RING_TILES, 1);
  for (const level of BACKDROP_LEVELS) {
    const options = backdropLayerOptions(level);
    assert.equal(options.maxNativeZoom, level.nativeZoom);
    assert.equal(options.minZoom, level.minZoom);
    assert.equal(options.zIndex, 0, 'drawn under the real tiles (zIndex 1) and labels');
    assert.equal(options.attribution, '', 'the real layer already credits the provider');
    assert.equal(options.ringTiles, 1);
  }
});

test('the manager and rep maps mount the backdrop once their first view of real tiles loads', () => {
  const shared = read('src/components/map/BaseMapTiles.jsx');
  assert.match(shared, /\{firstViewLoaded && <ZoomOutBackdrop url=\{url\} \/>\}/);
  assert.match(shared, /load: \(\) => \{ setFirstTileShown\(true\); setFirstViewLoaded\(true\);/);
  assert.match(shared, /eventHandlers=\{basemapEvents\}/);
  assert.match(shared, /setTimeout\(\(\) => setFirstViewLoaded\(true\), 6000\)/);
  const rep = read('src/components/rep/RepMapView.jsx');
  assert.match(rep, /\{imageryLoaded && <ZoomOutBackdrop url=\{REP_IMAGERY_URL\} \/>\}/);
  assert.match(rep, /eventHandlers=\{imageryEvents\}/);
  const backdrop = read('src/components/map/ZoomOutBackdrop.jsx');
  assert.match(backdrop, /multiplyBy\(this\.options\.ringTiles \|\| 0\)/);
});

test('phones keep a smaller tile budget so Safari does not paint the map black', async () => {
  const { basemapTileOptions } = await import('../src/components/map/basemapUrls.js');
  assert.deepEqual(basemapTileOptions(), { keepBuffer: 3, updateWhenZooming: true, updateWhenIdle: false, maxNativeZoom: 19, maxZoom: 20 });
  // Phones keep a one-tile ring but still load the next level mid-pinch and
  // tiles mid-pan; waiting for the finger to lift left the map blocky.
  assert.deepEqual(basemapTileOptions({ phone: true }), { keepBuffer: 1, updateWhenZooming: true, updateWhenIdle: false, maxNativeZoom: 19, maxZoom: 20 });
  // Desktop backdrop unchanged: both levels up to zoom 20, whole-session buffer.
  for (const level of BACKDROP_LEVELS) {
    const desktop = backdropLayerOptions(level);
    assert.equal(desktop.maxZoom, 20);
    assert.equal(desktop.keepBuffer, 6);
  }
  // Phones: one backdrop level per zoom band, and only the ring around the view.
  const [fine, coarse] = BACKDROP_LEVELS.map((level) => backdropLayerOptions(level, { phone: true }));
  assert.deepEqual([fine.minZoom, fine.maxZoom], [12, 20]);
  assert.deepEqual([coarse.minZoom, coarse.maxZoom], [9, 11]);
  for (const options of [fine, coarse]) assert.equal(options.keepBuffer, 1);
  const backdrop = read('src/components/map/ZoomOutBackdrop.jsx');
  assert.match(backdrop, /backdropLayerOptions\(level, \{ phone \}\)/);
});
