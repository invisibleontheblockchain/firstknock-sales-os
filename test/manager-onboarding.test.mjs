import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('new managers enter the real Precision workflow and receive the guided walkthrough', async () => {
  const [market, layout, wizard, pullPanel, toolbar, walkthrough] = await Promise.all([
    source('src/components/onboarding/MarketOnboarding.jsx'),
    source('src/Layout.jsx'),
    source('src/components/onboarding/OnboardingWizard.jsx'),
    source('src/components/map/PrecisionPullPanel.jsx'),
    source('src/components/map/MapToolbar.jsx'),
    source('src/components/onboarding/useFirstAreaWalkthrough.js'),
  ]);
  assert.match(market, /Precision/);
  assert.match(market, /fk_firstAreaWalkthrough_/);
  assert.doesNotMatch(market, /has_defined_market:\s*true/);
  assert.match(layout, /onboarding=precision/);
  assert.match(layout, /<FirstAreaWalkthrough user=\{user\}/);
  assert.match(wizard, /user\.app_role === 'manager'/);
  assert.match(pullPanel, /data-onboarding="precision-panel"/);
  assert.match(pullPanel, /fk-first-area-building/);
  assert.match(toolbar, /data-onboarding="route-checklist"/);
  assert.match(walkthrough, /has_seen_onboarding:\s*true/);
});