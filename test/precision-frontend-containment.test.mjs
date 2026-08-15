import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..');
const readSource = (path) => readFileSync(resolve(rootDir, path), 'utf8');
const territory = readSource('src/components/map/TerritoryPrompt.jsx');
const panel = readSource('src/components/map/PrecisionPullPanel.jsx');
const home = readSource('src/pages/Home.jsx');
const polygonHistory = readSource('src/components/map/PolygonHistory.jsx');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const openingBrace = source.indexOf('{', start);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

function loadHistoryNormalizer() {
  const defaultsStart = territory.indexOf('const DEFAULT_PRECISION_PROPERTY_COUNT');
  const defaultsEnd = territory.indexOf('function formatWholeNumber');
  assert.ok(defaultsStart >= 0 && defaultsEnd > defaultsStart);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`
    ${territory.slice(defaultsStart, defaultsEnd)}
    ${extractFunction(territory, 'normalizeOwnershipRangeDays')}
    ${extractFunction(territory, 'defaultSoldMonthsForUser')}
    ${extractFunction(territory, 'normalizeRouteFilters')}
    ${extractFunction(territory, 'normalizeRouteBounds')}
    ${extractFunction(territory, 'normalizedHistoryCriteria')}
    this.normalizeHistory = normalizedHistoryCriteria;
  `, context);
  return (history, user) => JSON.parse(JSON.stringify(context.normalizeHistory(history, user)));
}

test('legacy Ghost criteria restore as a fixed count with the explicit $100k minimum', () => {
  const normalizeHistory = loadHistoryNormalizer();
  const restored = normalizeHistory({
    criteria: {
      requested_properties: 73,
      min_price: null
    }
  }, { pull_months_back: 6 });

  assert.equal(restored.requestedPropertyCount, 73);
  assert.equal(restored.propertyCountMode, 'fixed');
  assert.equal(restored.minHomeValue, 100000);
  assert.equal(restored.maxHomeValue, '');
  assert.equal(restored.soldMonths, 6);
  assert.equal(restored.ownershipRangeMode, 'quick');
  assert.deepEqual(restored.ownershipRangeDays, [30, 180]);
  assert.deepEqual(restored.routeFilters, {
    propertyTypes: ['Single Family'],
    excludeCommercial: true,
    excludeCondos: true,
    excludeLand: true
  });
  assert.deepEqual(restored.routeBounds, { enabled: false });
});

test('complete Ghost criteria restore count mode, filters, repull state, ownership, and route bounds together', () => {
  const normalizeHistory = loadHistoryNormalizer();
  const restored = normalizeHistory({
    repull_mode: 'max_since_last',
    criteria: {
      requested_properties: 839,
      count_mode: 'max_available',
      min_price: 225000,
      max_price: 900000,
      sold_months: 6,
      ownership_range_mode: 'custom',
      ownership_range_days: { min: 45, max: 210 },
      include_unresolved_followups: false,
      route_filters: {
        propertyTypes: ['Townhouse'],
        excludeCommercial: false,
        excludeCondos: false,
        excludeLand: true
      },
      route_bounds: {
        enabled: true,
        mode: 'current_to_home',
        startLocation: { lat: 33.45, lng: -112.07 },
        endLocation: { lat: 33.4, lng: -112.1 }
      }
    }
  }, {});

  assert.equal(restored.requestedPropertyCount, 839);
  assert.equal(restored.propertyCountMode, 'max_available');
  assert.equal(restored.minHomeValue, 225000);
  assert.equal(restored.maxHomeValue, 900000);
  assert.equal(restored.ownershipRangeMode, 'custom');
  assert.deepEqual(restored.ownershipRangeDays, [45, 210]);
  assert.equal(restored.repullMode, 'max_since_last');
  assert.equal(restored.forceFullRefresh, false);
  assert.equal(restored.includeUnresolvedFollowUps, false);
  assert.deepEqual(restored.routeFilters, {
    propertyTypes: ['Townhouse'],
    excludeCommercial: false,
    excludeCondos: false,
    excludeLand: true
  });
  assert.deepEqual(restored.routeBounds, {
    enabled: true,
    mode: 'current_to_home',
    startLocation: { lat: 33.45, lng: -112.07 },
    endLocation: { lat: 33.4, lng: -112.1 }
  });
});

test('new Precision areas reset all restored criteria to explicit defaults', () => {
  const resetStart = territory.indexOf('const resetPrecisionCriteriaForNewArea');
  const resetEnd = territory.indexOf('// Smooth progress animation', resetStart);
  const reset = territory.slice(resetStart, resetEnd);

  assert.match(reset, /setRequestedPropertyCount\(DEFAULT_PRECISION_PROPERTY_COUNT\)/);
  assert.match(reset, /setPropertyCountMode\(DEFAULT_PRECISION_COUNT_MODE\)/);
  assert.match(reset, /setMinHomeValue\(DEFAULT_PRECISION_MIN_HOME_VALUE\)/);
  assert.match(reset, /setMaxHomeValue\(DEFAULT_PRECISION_MAX_HOME_VALUE\)/);
  assert.match(reset, /setOwnershipRangeMode\('quick'\)/);
  assert.match(reset, /setOwnershipRangeDays\(DEFAULT_PRECISION_OWNERSHIP_RANGE_DAYS\)/);
  assert.match(reset, /setPrecisionRouteFilters\(normalizeRouteFilters\(\)\)/);
  assert.match(reset, /setRestoredRouteBounds\(\{ enabled: false \}\)/);
  assert.match(territory, /const DEFAULT_PRECISION_MIN_HOME_VALUE = 100000/);

  const drawingListener = territory.slice(
    territory.indexOf('const drawHandler'),
    territory.indexOf('const precisionPullHandler')
  );
  const confirmHandler = territory.slice(
    territory.indexOf('const confirmDraftPolygon'),
    territory.indexOf('const activeAreaPolygon')
  );
  assert.match(drawingListener, /resetPrecisionCriteriaForNewArea\(\)/);
  assert.match(confirmHandler, /resetPrecisionCriteriaForNewArea\(\)/);
});

test('poll responses are owned by both a monotonic token and an exact response job id', () => {
  const polling = territory.slice(
    territory.indexOf('const startPolling'),
    territory.indexOf('const handleCancelImport')
  );
  const statusAwait = polling.indexOf("await base44.functions.invoke('fetchJobStatus'");
  const postAwaitGuard = polling.indexOf(
    'if (!pollIsCurrent() || terminalPollTokenRef.current === pollToken) return;',
    statusAwait
  );
  const responseIdentity = polling.indexOf(
    'const responseJobId = d.job_id ?? d.fetch_job_id ?? d.id;',
    postAwaitGuard
  );
  const exactResponseGuard = polling.indexOf(
    'String(responseJobId) !== String(jobId)',
    responseIdentity
  );
  const firstProgressMutation = polling.indexOf('setPullPct(pct)', exactResponseGuard);

  assert.ok(statusAwait >= 0);
  assert.ok(postAwaitGuard > statusAwait, 'the request/poll/terminal guard must run immediately after status await');
  assert.ok(responseIdentity > postAwaitGuard, 'the response must identify its job');
  assert.ok(exactResponseGuard > responseIdentity, 'the response job id must exactly match');
  assert.ok(firstProgressMutation > exactResponseGuard, 'no progress state may mutate before identity validation');
  assert.match(territory, /pollTokenRef\.current === pollToken[\s\S]*String\(activeJobIdRef\.current \|\| ''\) === String\(jobId \|\| ''\)/);
  assert.match(polling, /if \(!claimTerminalPoll\(pollToken, jobId\)\) return;[\s\S]*await onPullComplete/);
  assert.match(polling, /await onPullComplete[\s\S]*if \(!pollIsCurrent\(\)\) return;[\s\S]*await refetchPrecisionUsage\(\);[\s\S]*if \(!pollIsCurrent\(\)\) return;/);
});

test('criteria conflicts are explained and never resume the older job', () => {
  assert.match(territory, /active_job_criteria_conflict/);
  assert.match(territory, /This request was not started, and FirstKnock will not resume the older job because its criteria do not match/);

  const resolvedConflictStart = territory.indexOf("if (data.error === 'active_job_criteria_conflict')");
  const resolvedConflictEnd = territory.indexOf('const isPlanGate', resolvedConflictStart);
  const resolvedConflict = territory.slice(resolvedConflictStart, resolvedConflictEnd);
  assert.ok(resolvedConflictStart >= 0 && resolvedConflictEnd > resolvedConflictStart);
  assert.doesNotMatch(resolvedConflict, /rememberActivePrecisionJob|startPolling/);
  assert.match(territory, /details\.code === 'active_job_criteria_conflict'/);
});

test('the panel discloses restored count/minimum criteria and reuses only valid restored route bounds', () => {
  assert.match(panel, /Restored from previous pull/);
  assert.match(panel, /Max Available:/);
  assert.match(panel, /Fixed Count:/);
  assert.match(panel, /Minimum value:/);
  assert.match(panel, /normalizeRouteBoundsIntent\(restoredRouteBounds\)/);
  assert.match(panel, /if \(activeRestoredRouteBounds\.enabled\) \{\s*return onGenerate\?\.\(activeRestoredRouteBounds\);/);
  assert.match(territory, /restoredRouteBounds=\{restoredRouteBounds\}/);
});

test('saved Precision route history keeps the complete verified job criteria for later atomic restore', () => {
  const saveStart = home.indexOf('const currentPrecisionCriteria = currentBatchDataCriteriaRef.current || {};');
  const saveEnd = home.indexOf('// No "New', saveStart);
  const savedPrecisionArea = home.slice(saveStart, saveEnd);

  assert.ok(saveStart >= 0 && saveEnd > saveStart);
  assert.match(savedPrecisionArea, /precision_area:\s*\{/);
  assert.match(savedPrecisionArea, /criteria:\s*\{\s*\.\.\.currentPrecisionCriteria,/);
  assert.match(savedPrecisionArea, /requested_properties_before_cap:/);
  assert.match(savedPrecisionArea, /ownership_range_days:/);
  assert.match(home, /criteria:\s*\{\s*\.\.\.\(entry\.criteria \|\| \{\}\),\s*\.\.\.\(existing\.criteria \|\| \{\}\)/);
  assert.match(polygonHistory, /criteria:\s*\{\s*\.\.\.\(entry\.criteria \|\| \{\}\),\s*\.\.\.\(existing\.criteria \|\| \{\}\)/);
});

test('exact-job route generation cannot append account-wide ZIP candidates', () => {
  assert.match(
    home,
    /if \(!isCurrentBatchDataRun && zipCodeFilter && zipCodeFilter\.trim\(\)\)/
  );
  assert.match(home, /const baseProps = isCurrentBatchDataRun \? \[\] : effectiveProperties/);
  assert.match(
    home,
    /returnedProperties\.some\(property => String\(property\?\.fetch_job_id \|\| ''\) !== String\(fetchJobId\)\)/
  );
  assert.match(
    home,
    /String\(currentBatchDataJobIdRef\.current \|\| ''\) !== String\(activeFetchJobId\)/
  );
  assert.match(
    home,
    /if \(frozenWorkingSet\?\.length > 0 && !precisionJobAtGenerationStart\)/
  );
});
