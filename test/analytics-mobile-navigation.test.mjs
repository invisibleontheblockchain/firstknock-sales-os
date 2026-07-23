import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const listSource = readFileSync(new URL('../src/pages/List.jsx', import.meta.url), 'utf8');
const headerSource = readFileSync(new URL('../src/components/analytics/rep/RepAnalyticsHeader.jsx', import.meta.url), 'utf8');

test('mobile Analytics keeps the three primary views visible without a swipe strip', () => {
  assert.match(listSource, /const primaryTabs = \[\s*\{ id: 'performance'/);
  assert.match(listSource, /\{ id: 'advanced', label: 'Advanced', icon: Sparkles \}/);
  assert.match(listSource, /\{ id: 'sales', label: 'Sales', icon: DollarSign \}/);
  assert.match(listSource, /className="grid grid-cols-3 md:flex p-1/);
  assert.doesNotMatch(listSource, /max-w-7xl mx-auto flex p-1[^\n]*overflow-x-auto/);
});

test('Routes remains a desktop tab and uses an accessible mobile title-row entry', () => {
  assert.match(listSource, /const routesTab = \{ id: 'routes', label: 'Routes', icon: Navigation \}/);
  assert.match(listSource, /tab\.id === routesTab\.id \? 'hidden md:flex' : 'flex'/);
  assert.match(listSource, /showDateControls=\{isAnalyticsTab\}/);
  assert.match(listSource, /onOpenRouteAnalytics=\{\(\) => setActiveTab\(routesTab\.id\)\}/);
  assert.match(listSource, /routeAnalyticsActive=\{activeTab === routesTab\.id\}/);
  assert.doesNotMatch(listSource, /className=\{`mt-1\.5 ml-auto/);

  assert.match(headerSource, /aria-pressed=\{routeAnalyticsActive\}/);
  assert.match(headerSource, /aria-controls="analytics-results"/);
  assert.match(headerSource, /className=\{`md:hidden min-h-10 shrink-0/);
  assert.match(headerSource, />\s*Route analytics\s*<\/button>/);
  assert.match(listSource, /id="analytics-results" role="region"/);
  assert.match(listSource, /activeTab === 'routes'/);
  assert.match(listSource, /<RouteProgress/);
});

test('mobile Analytics heading stays mounted across views while desktop behavior is unchanged', () => {
  assert.match(headerSource, /showDateControls = true/);
  assert.match(headerSource, /showDateControls \? '' : 'md:hidden'/);
  assert.match(headerSource, /\{showDateControls && \(\s*<div className="w-full md:w-auto overflow-x-auto no-scrollbar">/);
  assert.match(headerSource, /flex flex-col gap-3 md:flex-row md:items-center md:justify-between/);
  assert.match(headerSource, /showDateControls && selectedDate[\s\S]*'Performance dashboard'/);
});
