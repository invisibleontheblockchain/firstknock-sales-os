import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');

test('map views have attribution disabled as requested', () => {
  const indexCss = readSource('src/index.css');
  assert.match(indexCss, /\.leaflet-control-attribution\s*\{[^}]*display:\s*none\s*!important/s);

  [
    'src/pages/Home.jsx',
    'src/components/rep/RepMapView.jsx',
    'src/components/rep/CanvasFieldView.jsx',
    'src/pages/ZipCodeExplorer.jsx',
  ].forEach((path) => {
    const source = readSource(path);
    assert.match(source, /attribution=""/);
  });
});
