import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the app shell loads the assistant and onboarding overlays only where they can appear', () => {
  const layout = read('src/Layout.jsx');
  assert.doesNotMatch(layout, /^import (AiAssistant|OnboardingWizard|MarketOnboarding) /m);
  assert.match(layout, /React\.lazy\(\(\) => import\('@\/components\/help\/AiAssistant'\)\)/);
  assert.match(layout, /React\.lazy\(\(\) => import\('@\/components\/onboarding\/OnboardingWizard'\)\)/);
  assert.match(layout, /React\.lazy\(\(\) => import\('@\/components\/onboarding\/MarketOnboarding'\)\)/);
  assert.match(layout, /<React\.Suspense fallback=\{null\}>[\s\S]*<AiAssistant \/>[\s\S]*<\/React\.Suspense>/);

  // Each outer gate must be implied by the component's own visibility rule.
  const assistant = read('src/components/help/AiAssistant.jsx');
  assert.match(assistant, /const isMapPage = path\.endsWith\('Home'\) \|\| path === '\/' \|\| path\.endsWith\('RepHome'\);/);
  assert.match(layout, /isAssistantHiddenPath = \(path\) => path\.endsWith\('Home'\) \|\| path === '\/' \|\| path\.endsWith\('RepHome'\)/);
  const wizard = read('src/components/onboarding/OnboardingWizard.jsx');
  assert.match(wizard, /if \(!user \|\| user\.has_seen_onboarding \|\| !user\.app_role \|\| !isOpen \|\| isNewManagerWithoutTerritory \|\| user\.app_role === 'manager'\) return null;/);
  const market = read('src/components/onboarding/MarketOnboarding.jsx');
  assert.match(market, /if \(!user \|\| user\.app_role !== 'manager'\) return null;/);
  assert.match(market, /const hasExistingTerritory = user\.has_pulled_data \|\| user\.has_defined_market \|\| user\.territory_zip_codes\?\.length > 0 \|\| user\.area_pulls_count > 0;/);
  assert.match(layout, /user\.has_pulled_data \|\| user\.has_defined_market \|\| user\.territory_zip_codes\?\.length > 0 \|\| user\.area_pulls_count > 0/);
});

test('the road-aware comparison map loads only when a comparison opens', () => {
  const host = read('src/components/routes/RoadAwareComparisonHost.jsx');
  assert.doesNotMatch(host, /react-leaflet|leafletPatches/);
  assert.match(host, /React\.lazy\(\(\) => import\('\.\/RoadAwareComparisonView'\)\)/);
  assert.match(read('src/components/routes/RoadAwareComparisonView.jsx'), /export function RoadAwareComparisonView/);
});

test('Canvas-only and builder-only code stays out of the map and Run Route downloads', () => {
  assert.match(read('src/components/map/RouteBuilderSettings.jsx'), /const CanvasBuilderSettings = React\.lazy\(loadCanvasBuilderSettings\)/);
  assert.match(read('src/pages/Home.jsx'), /if \(routeMode === 'canvas'\) preloadCanvasBuilderSettings\(\)/);
  assert.match(read('src/components/map/BaseMapTiles.jsx'), /React\.lazy\(\(\) => import\('@\/components\/canvas\/CanvasBaseMapTiles'\)\)/);
  const rep = read('src/pages/RepHome.jsx');
  assert.match(rep, /React\.lazy\(\(\) => import\('@\/components\/rep\/CanvasFieldView'\)\)/);
  assert.match(rep, /React\.lazy\(\(\) => import\('@\/components\/rep\/CanvasResidentialFieldView'\)\)/);
  const history = read('src/components/map/PolygonHistory.jsx');
  assert.doesNotMatch(history, /^import .*mergePulledAreas/m);
  assert.match(history, /import\('@\/components\/map\/mergePulledAreas'\)/);
  assert.match(history, /showAreas = isBuilder && ghostVisible && visibleHistory\.length > 0/);
});
