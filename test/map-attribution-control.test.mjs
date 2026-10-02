import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');

test('CARTO map views retain visible provider attribution', () => {
  const indexCss = readSource('src/index.css');
  assert.doesNotMatch(indexCss, /\.leaflet-control-attribution\s*\{[^}]*display:\s*none/s);

  [
    'src/components/map/BaseMapTiles.jsx',
    'src/components/routes/SplitRoutePreviewMap.jsx',
    'src/components/find/FindMap.jsx',
  ].forEach((path) => {
    const source = readSource(path);
    assert.match(source, /<MapAttributionControl\s*\/>/);
    assert.match(source, /CARTO_ATTRIBUTION/);
    assert.doesNotMatch(source, /attribution=""/);
  });
});
