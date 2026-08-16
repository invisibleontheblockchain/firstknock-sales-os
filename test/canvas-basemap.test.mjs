import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { getCanvasBasemapConfiguration } from '../src/components/canvas/canvasBasemapConfiguration.js';

test('Canvas basemap selects exactly one production source and fails closed on ambiguity', () => {
  const attribution = 'FirstKnock map data providers';
  // An unconfigured Canvas map must still render tiles. Returning no source left
  // the deployed Canvas map black whenever VITE_ values did not reach the bundle.
  const unconfigured = getCanvasBasemapConfiguration({ env: {} });
  assert.equal(unconfigured.mode, 'xyz');
  assert.match(unconfigured.url, /basemaps\.cartocdn\.com/);
  assert.equal(unconfigured.usingDefaultBasemap, true);
  assert.equal(unconfigured.configured, false);
  assert.notEqual(unconfigured.attribution, '');

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

test('Canvas satellite is an explicit visual override and defaults keep the map visible', () => {
  const satellite = getCanvasBasemapConfiguration({ satellite: true, env: {
    VITE_CANVAS_BASEMAP_PMTILES_URL: 'https://r2.example.test/maps/conus.pmtiles',
    VITE_CANVAS_BASEMAP_ATTRIBUTION: 'Street attribution',
    VITE_CANVAS_SATELLITE_TILE_URL: 'https://sat.example.test/{z}/{x}/{y}.jpg',
    VITE_CANVAS_SATELLITE_ATTRIBUTION: 'Satellite attribution',
  } });
  assert.equal(satellite.mode, 'xyz');
  assert.equal(satellite.url, 'https://sat.example.test/{z}/{x}/{y}.jpg');
  assert.equal(satellite.attribution, 'Satellite attribution');

  const defaultSatellite = getCanvasBasemapConfiguration({ satellite: true, env: {} });
  assert.equal(defaultSatellite.mode, 'xyz');
  assert.match(defaultSatellite.url, /World_Imagery/);
  assert.equal(defaultSatellite.usingDefaultBasemap, true);

  const production = getCanvasBasemapConfiguration({ env: { DEV: false } });
  assert.equal(production.mode, 'xyz');
  assert.match(production.url, /basemaps\.cartocdn\.com/);
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