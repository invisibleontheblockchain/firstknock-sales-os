import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('map settings preview without persistence until Save Settings', () => {
  const home = source('src/pages/Home.jsx');
  const panel = source('src/components/map/MapSettingsPanel.jsx');
  const boundaries = source('src/components/map/boundaryOverlayPrefs.js');

  assert.match(home, /setShowMapSettings/);
  assert.match(panel, /const handleCancel =/);
  assert.match(panel, /persistedSnapshotRef/);
  assert.match(panel, /if \(!committedRef\.current\) restorePersistedSnapshot\(\)/);
  assert.match(panel, /saveBoundaryOverlays\(overlays\)/);
  assert.match(panel, /localStorage\.setItem\('fk_routeMode', local\.routeMode\)/);
  assert.match(panel, /Save Settings/);
  assert.match(boundaries, /previewBoundaryOverlays/);
  assert.match(boundaries, /saveBoundaryOverlays/);
});