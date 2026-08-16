import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { getCanvasBasemapConfiguration } from '../src/components/canvas/canvasBasemapConfiguration.js';

test('Canvas basemap selects exactly one production source and fails closed on ambiguity', () => {
  const attribution = 'FirstKnock map data providers';
  assert.deepEqual(getCanvasBasemapConfiguration({ env: {} }), {
    url: null,
    mode: 'none',
    flavor: 'dark',
    attribution: '',
    configured: false,
    conflict: false,
    satelliteAvailable: false,
  });

  const xyz = getCanvasBasemapConfiguration({ env: {
    VITE_CANVAS_BASEMAP_TILE_URL: 'https://tiles.example.test/{z}/{x}/{y}.png',
    VITE_CANVAS_BASEMAP_ATTRIBUTION: attribution,
  } });
  assert.equal(xyz.mode, 'xyz');
  assert.equal(xyz.configured, true);
  assert.equal(xyz.attribution, attribution);

  const pmtiles = getCanvasBasemapConfiguration({ env: {
    VITE_CANVAS_BASEMAP_PMTILES_URL: 'https://r2.example.test/maps/conus.pmtiles',
    VITE_CANVAS_BASEMAP_ATTRIBUTION: attribution,
    VITE_CANVAS_BASEMAP_PMTILES_FLAVOR: 'grayscale',
  } });
  assert.equal(pmtiles.mode, 'pmtiles');
  assert.equal(pmtiles.flavor, 'grayscale');
  assert.equal(pmtiles.configured, true);

  const conflict = getCanvasBasemapConfiguration({ env: {
    VITE_CANVAS_BASEMAP_TILE_URL: 'https://tiles.example.test/{z}/{x}/{y}.png',
    VITE_CANVAS_BASEMAP_PMTILES_URL: 'https://r2.example.test/maps/conus.pmtiles',
    VITE_CANVAS_BASEMAP_ATTRIBUTION: attribution,
  } });
  assert.equal(conflict.mode, 'invalid');
  assert.equal(conflict.url, null);
  assert.equal(conflict.configured, false);
  assert.equal(conflict.conflict, true);
});

test('Canvas satellite is an explicit visual override and no mode ever substitutes its own basemap', () => {
  const satellite = getCanvasBasemapConfiguration({ satellite: true, env: {
    VITE_CANVAS_BASEMAP_PMTILES_URL: 'https://r2.example.test/maps/conus.pmtiles',
    VITE_CANVAS_BASEMAP_ATTRIBUTION: 'Street attribution',
    VITE_CANVAS_SATELLITE_TILE_URL: 'https://sat.example.test/{z}/{x}/{y}.jpg',
    VITE_CANVAS_SATELLITE_ATTRIBUTION: 'Satellite attribution',
  } });
  assert.equal(satellite.mode, 'xyz');
  assert.equal(satellite.url, 'https://sat.example.test/{z}/{x}/{y}.jpg');
  assert.equal(satellite.attribution, 'Satellite attribution');

  // A dev-only substitute basemap is a second visual variation: it rendered a
  // different map in the Base44 preview than on phones. Every mode must resolve
  // to the same configured source, and an unconfigured build must render
  // nothing rather than inventing a replacement.
  for (const DEV of [true, false]) {
    const unconfigured = getCanvasBasemapConfiguration({ env: { DEV } });
    assert.equal(unconfigured.mode, 'none');
    assert.equal(unconfigured.url, null);
    assert.equal(unconfigured.configured, false);
  }

  const shared = { VITE_CANVAS_BASEMAP_TILE_URL: 'https://tiles.example.test/{z}/{x}/{y}.png' };
  assert.deepEqual(
    getCanvasBasemapConfiguration({ env: { ...shared, DEV: true } }),
    getCanvasBasemapConfiguration({ env: { ...shared, DEV: false } }),
  );
});

test('the Canvas basemap is defined once in .env so every mode and device renders it', () => {
  const rootEnv = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  const productionEnv = readFileSync(new URL('../.env.production', import.meta.url), 'utf8');
  const activeKeys = (source) => source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('=')[0]);

  assert.ok(activeKeys(rootEnv).includes('VITE_CANVAS_BASEMAP_TILE_URL'));
  assert.ok(activeKeys(rootEnv).includes('VITE_CANVAS_BASEMAP_ATTRIBUTION'));
  // A per-mode override here is exactly what split the preview from mobile.
  assert.deepEqual(activeKeys(productionEnv).filter((key) => /BASEMAP|SATELLITE/.test(key)), []);
});

test('Canvas field maps keep visible provider attribution and PMTiles stays Canvas-only', () => {
  const basemap = readFileSync(new URL('../src/components/canvas/CanvasBaseMapTiles.jsx', import.meta.url), 'utf8');
  const residentialField = readFileSync(new URL('../src/components/rep/CanvasResidentialFieldView.jsx', import.meta.url), 'utf8');
  const legacyField = readFileSync(new URL('../src/components/rep/CanvasFieldView.jsx', import.meta.url), 'utf8');
  const sharedTiles = readFileSync(new URL('../src/components/map/BaseMapTiles.jsx', import.meta.url), 'utf8');

  assert.match(basemap, /from 'protomaps-leaflet'/);
  assert.match(basemap, /config\.mode === 'pmtiles'/);
  assert.match(basemap, /attribution: config\.attribution/);
  for (const source of [residentialField, legacyField]) {
    assert.doesNotMatch(source, /attributionControl=\{false\}/);
    assert.match(source, /<MapAttributionControl position="bottomleft"/);
  }
  assert.doesNotMatch(sharedTiles, /protomaps-leaflet|PMTILES/i);
});