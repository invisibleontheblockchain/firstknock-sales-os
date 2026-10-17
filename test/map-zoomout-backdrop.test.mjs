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
  assert.match(shared, /load: \(\) => setFirstViewLoaded\(true\)/);
  assert.match(shared, /eventHandlers=\{basemapEvents\}/);
  assert.match(shared, /setTimeout\(\(\) => setFirstViewLoaded\(true\), 6000\)/);
  const rep = read('src/components/rep/RepMapView.jsx');
  assert.match(rep, /\{imageryLoaded && <ZoomOutBackdrop url=\{REP_IMAGERY_URL\} \/>\}/);
  assert.match(rep, /eventHandlers=\{imageryEvents\}/);
  const backdrop = read('src/components/map/ZoomOutBackdrop.jsx');
  assert.match(backdrop, /multiplyBy\(this\.options\.ringTiles \|\| 0\)/);
});
