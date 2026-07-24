import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');
const countMatches = (source, pattern) => [...source.matchAll(pattern)].length;

const openingTagContaining = (source, componentName, marker) => {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `${componentName} marker "${marker}" must exist`);

  const tagStart = source.lastIndexOf(`<${componentName}`, markerIndex);
  const tagEnd = source.indexOf('/>', markerIndex);
  assert.notEqual(tagStart, -1, `${marker} must belong to a ${componentName} opening tag`);
  assert.notEqual(tagEnd, -1, `${componentName} opening tag containing ${marker} must close`);

  return {
    start: tagStart,
    source: source.slice(tagStart, tagEnd + 2),
  };
};

test('every FirstKnock map removes Leaflet branding through the shared attribution control', () => {
  const controlSource = readSource('src/components/map/MapAttributionControl.jsx');
  assert.match(controlSource, /import \{ useLayoutEffect \} from 'react'/);
  assert.match(controlSource, /useLayoutEffect\(\(\) => \{/);
  assert.match(controlSource, /const control = map\?\.attributionControl/);
  assert.match(controlSource, /control\.setPrefix\(false\)/);
  assert.match(controlSource, /control\.setPosition\(safePosition\)/);
  assert.match(controlSource, /fk-map-attribution/);
  assert.match(controlSource, /translateY\(-\$\{safeBottomOffset\}px\)/);

  [
    'src/pages/Home.jsx',
    'src/components/rep/RepMapView.jsx',
    'src/components/rep/CanvasFieldView.jsx',
    'src/pages/ZipCodeExplorer.jsx',
  ].forEach((path) => {
    const source = readSource(path);
    const mapContainerCount = countMatches(source, /<MapContainer\b/g);
    const attributionControlCount = countMatches(source, /<MapAttributionControl\b[^>]*\/>/g);

    assert.match(source, /import MapAttributionControl\b/);
    assert.ok(mapContainerCount > 0, `${path} must render a MapContainer`);
    assert.equal(
      attributionControlCount,
      mapContainerCount,
      `${path} must wire one MapAttributionControl into every MapContainer`,
    );
  });

  const homeSource = readSource('src/pages/Home.jsx');
  const repMapSource = readSource('src/components/rep/RepMapView.jsx');
  const canvasFieldSource = readSource('src/components/rep/CanvasFieldView.jsx');
  assert.match(homeSource, /<MapAttributionControl position="bottomleft" bottomOffset=\{84\} \/>/);
  assert.match(repMapSource, /<MapAttributionControl bottomOffset=\{hudExpanded \? 280 : 76\} \/>/);
  assert.match(canvasFieldSource, /<MapAttributionControl position="bottomleft" bottomOffset=\{144\} \/>/);
});

test('Home satellite and hybrid labels retain their CARTO provider attribution', () => {
  const homeSource = readSource('src/pages/Home.jsx');
  const labelsLayer = openingTagContaining(homeSource, 'TileLayer', 'light_only_labels');
  const labelsCondition = homeSource.slice(Math.max(0, labelsLayer.start - 250), labelsLayer.start);

  assert.match(
    labelsCondition,
    /mapTheme\s*===\s*['"]hybrid['"][\s\S]*mapTheme\s*===\s*['"]satellite['"]/,
    'the CARTO labels layer must remain active for both hybrid and satellite maps',
  );
  assert.match(
    labelsLayer.source,
    /\battribution\s*=\s*\{CARTO_ATTRIBUTION\}/,
    'the light_only_labels TileLayer must declare the shared CARTO attribution',
  );
});

test('provider credits remain compact and visible instead of being hidden by CSS', () => {
  const layoutSource = readSource('src/Layout.jsx');
  const homeSource = readSource('src/pages/Home.jsx');
  const repMapSource = readSource('src/components/rep/RepMapView.jsx');
  const canvasFieldSource = readSource('src/components/rep/CanvasFieldView.jsx');
  const zipSource = readSource('src/pages/ZipCodeExplorer.jsx');
  const providerSource = readSource('src/components/map/mapAttribution.js');

  assert.match(layoutSource, /\.leaflet-control-attribution\.fk-map-attribution/);
  assert.doesNotMatch(
    layoutSource,
    /\.leaflet-control-attribution\.fk-map-attribution\s*\{[^}]*display\s*:\s*none/is,
  );
  assert.match(layoutSource, /background:\s*rgba\(0,\s*0,\s*0,\s*0\.82\)\s*!important/);
  assert.match(layoutSource, /font-size:\s*12px\s*!important/);
  assert.match(providerSource, /OpenStreetMap contributors/);
  assert.match(providerSource, /https:\/\/carto\.com\/attributions[^'"]*['"]>CARTO<\/a>/);
  assert.match(providerSource, /Powered by <a href="https:\/\/www\.esri\.com">Esri<\/a>/);
  assert.match(
    providerSource,
    /Source: Esri, Vantor, GeoEye, Earthstar Geographics, CNES\/Airbus DS, USDA, USGS, AeroGRID, IGN, and the GIS User Community/,
  );
  assert.match(homeSource, /\bESRI_IMAGERY_ATTRIBUTION\b/);
  assert.match(homeSource, /\bCARTO_ATTRIBUTION\b/);
  assert.match(repMapSource, /attribution=\{ESRI_IMAGERY_ATTRIBUTION\}/);
  assert.match(
    canvasFieldSource,
    /attribution=\{satellite\s*\?\s*ESRI_IMAGERY_ATTRIBUTION\s*:\s*OPENSTREETMAP_ATTRIBUTION\}/,
  );
  assert.match(zipSource, /attribution=\{OPENSTREETMAP_ATTRIBUTION\}/);
});
