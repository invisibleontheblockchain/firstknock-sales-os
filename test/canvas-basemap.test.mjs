import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { getCanvasBasemapConfiguration } from '../src/components/canvas/canvasBasemapConfiguration.js';

test('Canvas basemap selects exactly one production source and fails closed on ambiguity', () => {
  const attribution = 'FirstKnock map data providers';
  // An empty env must still render the one Canvas basemap. Requiring an env file
  // here is what produced a fully black map when the file was absent or the dev
  // server had not reloaded it.
  const unconfigured = getCanvasBasemapConfiguration({ env: {} });
  assert.equal(unconfigured.mode, 'xyz');
  assert.equal(unconfigured.configured, true);
  assert.match(unconfigured.url, /basemaps\.cartocdn\.com\/rastertiles\/voyager/);
  assert.match(unconfigured.attribution, /OpenStreetMap/);

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

  // The resolved basemap must never depend on the build mode. A DEV-keyed branch
  // is what made the Base44 preview and phones render different maps.
  for (const env of [{}, { VITE_CANVAS_BASEMAP_TILE_URL: 'https://tiles.example.test/{z}/{x}/{y}.png' }]) {
    assert.deepEqual(
      getCanvasBasemapConfiguration({ env: { ...env, DEV: true } }),
      getCanvasBasemapConfiguration({ env: { ...env, DEV: false } }),
    );
  }
});

test('Canvas honours the same four Map Style choices as Precision', () => {
  const resolve = (theme, env = {}) => getCanvasBasemapConfiguration({ theme, env });

  // Dark and satellite are separate sources, so a street override must not
  // silently hand back light tiles for them.
  const streetOverride = { VITE_CANVAS_BASEMAP_TILE_URL: 'https://tiles.example.test/{z}/{x}/{y}.png' };
  assert.equal(resolve('light', streetOverride).url, streetOverride.VITE_CANVAS_BASEMAP_TILE_URL);
  assert.match(resolve('dark', streetOverride).url, /cartocdn\.com\/dark_all/);

  for (const theme of ['satellite', 'hybrid']) {
    const config = resolve(theme, streetOverride);
    assert.match(config.url, /World_Imagery/);
    assert.match(config.attribution, /Esri/);
  }

  // Every theme must render something; an unresolved style is the black map.
  for (const theme of ['light', 'dark', 'satellite', 'hybrid']) {
    assert.equal(resolve(theme).configured, true, `${theme} did not resolve a basemap`);
  }

  // A self-hosted archive already carries a dark palette, so Dark stays vector
  // instead of dropping back to metered raster tiles.
  const pmtiles = { VITE_CANVAS_BASEMAP_PMTILES_URL: 'https://r2.example.test/maps/conus.pmtiles' };
  assert.equal(resolve('dark', pmtiles).mode, 'pmtiles');
  assert.equal(resolve('dark', pmtiles).flavor, 'dark');
  assert.equal(resolve('light', pmtiles).flavor, 'carto');

  for (const theme of ['light_soft', 'light_warm', 'light_cool', 'light_vivid', 'light_contrast', 'light_mono']) {
    assert.equal(resolve(theme).url, resolve('light').url);
    assert.equal(resolve(theme, pmtiles).flavor, 'carto');
  }
});

test('the Canvas basemap never depends on an env file being present', () => {
  const config = readFileSync(new URL('../src/components/canvas/canvasBasemapConfiguration.js', import.meta.url), 'utf8');
  const productionEnv = readFileSync(new URL('../.env.production', import.meta.url), 'utf8');
  const activeKeys = (source) => source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('=')[0]);

  // The default is a plain constant, not a mode-conditional fallback.
  assert.match(config, /const DEFAULT_BASEMAP = Object\.freeze/);
  assert.doesNotMatch(config, /env\?\.DEV|import\.meta\.env\.DEV/);
  // A per-mode override is exactly what split the preview from mobile.
  assert.deepEqual(activeKeys(productionEnv).filter((key) => /BASEMAP|SATELLITE/.test(key)), []);
});

test('the self-hosted vector basemap defaults to the OSM-Carto theme', async () => {
  const { CANVAS_CARTO_FLAVOR } = await import('../src/components/canvas/canvasCartoFlavor.js');
  const tiles = readFileSync(new URL('../src/components/canvas/CanvasBaseMapTiles.jsx', import.meta.url), 'utf8');

  // Self-hosting is what keeps basemap cost flat per rep, so the vector path
  // must carry the Carto palette by default rather than a built-in flavor.
  const pmtiles = getCanvasBasemapConfiguration({ env: {
    VITE_CANVAS_BASEMAP_PMTILES_URL: 'https://r2.example.test/maps/conus.pmtiles',
  } });
  assert.equal(pmtiles.mode, 'pmtiles');
  assert.equal(pmtiles.flavor, 'carto');
  assert.match(tiles, /config\.flavor === 'carto' \? CANVAS_CARTO_FLAVOR/);

  // The road ramp is what makes the map legible while knocking; keep the
  // hierarchy distinct rather than collapsing to one road color.
  const roads = [CANVAS_CARTO_FLAVOR.highway, CANVAS_CARTO_FLAVOR.major, CANVAS_CARTO_FLAVOR.minor_a, CANVAS_CARTO_FLAVOR.minor_b];
  assert.equal(new Set(roads).size, roads.length);
  assert.equal(CANVAS_CARTO_FLAVOR.water, '#aad3df');
  assert.equal(CANVAS_CARTO_FLAVOR.earth, '#f2efe9');

  // A missing key renders that feature with an undefined color.
  for (const key of ['background', 'buildings', 'railway', 'boundaries', 'city_label', 'landcover', 'pois']) {
    assert.ok(CANVAS_CARTO_FLAVOR[key], `flavor is missing ${key}`);
  }
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