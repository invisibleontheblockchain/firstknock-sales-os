import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const listSource = readFileSync(new URL('../src/pages/List.jsx', import.meta.url), 'utf8');

test('mobile Analytics keeps the three primary views visible without a swipe strip', () => {
  assert.match(listSource, /const primaryTabs = \[\s*\{ id: 'performance'/);
  assert.match(listSource, /\{ id: 'advanced', label: 'Advanced', icon: Sparkles \}/);
  assert.match(listSource, /\{ id: 'sales', label: 'Sales', icon: DollarSign \}/);
  assert.match(listSource, /className="grid grid-cols-3 md:flex p-1/);
  assert.doesNotMatch(listSource, /max-w-7xl mx-auto flex p-1[^\n]*overflow-x-auto/);
});

test('Routes remains a desktop tab and uses a separate accessible mobile entry', () => {
  assert.match(listSource, /const routesTab = \{ id: 'routes', label: 'Routes', icon: Navigation \}/);
  assert.match(listSource, /tab\.id === routesTab\.id \? 'hidden md:flex' : 'flex'/);
  assert.match(listSource, /onClick=\{\(\) => setActiveTab\(routesTab\.id\)\}/);
  assert.match(listSource, /aria-pressed=\{activeTab === routesTab\.id\}/);
  assert.match(listSource, /md:hidden flex items-center/);
  assert.match(listSource, />\s*Route analytics\s*<\/button>/);
  assert.match(listSource, /id="analytics-results" role="region"/);
  assert.match(listSource, /activeTab === 'routes'/);
  assert.match(listSource, /<RouteProgress/);
});
