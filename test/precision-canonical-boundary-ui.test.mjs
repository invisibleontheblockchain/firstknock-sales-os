import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('PRECISION-CANONICAL-UI-01 preview, start, retry, and completion retain the server polygon', async () => {
  const territoryPrompt = await source('src/components/map/TerritoryPrompt.jsx');

  assert.match(territoryPrompt, /polygon:\s*canonicalResponsePolygon\(d\.polygon, intent\.polygon\)/,
    'completion must prefer the canonical status polygon over the raw client intent');
  assert.match(territoryPrompt, /savePolygonToHistory\(previewPolygon,/,
    'preview history must store the canonical response polygon');
  assert.match(territoryPrompt, /polygon:\s*startedPolygon,/,
    'new pull intent must use the canonical start response polygon');
  assert.match(territoryPrompt, /setDrawnPolygon\(startedPolygon, true\)/,
    'the visible map must switch to the exact imported polygon');
  assert.match(territoryPrompt, /polygon:\s*recoveryPolygon,/,
    'retry intent must use the canonical response polygon');
  assert.match(territoryPrompt, /polygon:\s*resumedPolygon,/,
    'automatic resume must canonicalize a legacy stored polygon before showing it');
  assert.doesNotMatch(territoryPrompt, /polygon:\s*intent\.polygon\s*\|\|\s*d\.polygon/,
    'raw client intent must never override server geometry');
});

test('PRECISION-CANONICAL-UI-02 route generation trusts active job geometry and exact identity', async () => {
  const [home, helpers] = await Promise.all([
    source('src/pages/Home.jsx'),
    source('src/components/map/homeMapHelpers.js')
  ]);

  assert.match(home, /activeGenerationPolygon = activeFetchJobId && currentJobPolygon\.length > 2\s*\? currentJobPolygon/,
    'an active job polygon must take precedence over stale drawn state');
  assert.match(home, /const activePolygonKey = activeGenerationPolygon\s*\? exactPolygonKey\(activeGenerationPolygon\)/,
    'active geometry identity must compare the full polygon');
  assert.match(home, /const currentJobPolygonKey = currentJobPolygon\.length > 2\s*\? exactPolygonKey\(currentJobPolygon\)/,
    'job identity must compare the full polygon');
  assert.doesNotMatch(home, /polygonHistoryKey/,
    'route generation and server history must not use first-point-plus-count identity');
  assert.match(helpers, /function polygonHistoryKey[\s\S]*?return exactPolygonKey\(polygon\) \|\| '';/,
    'the compatibility helper must also delegate to exact identity');
});
