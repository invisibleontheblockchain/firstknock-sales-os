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
const precisionUsage = readSource('src/lib/precisionUsage.js');
const precisionIdentity = readSource('src/lib/precisionIdentity.js');

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
  const schemaStart = territory.indexOf('const PRECISION_CRITERIA_SCHEMA_VERSION');
  const schemaEnd = territory.indexOf('function hasOwn', schemaStart);
  assert.ok(defaultsStart >= 0 && defaultsEnd > defaultsStart);
  assert.ok(schemaStart >= 0 && schemaEnd > schemaStart);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`
    ${territory.slice(defaultsStart, defaultsEnd)}
    ${territory.slice(schemaStart, schemaEnd)}
    ${extractFunction(territory, 'normalizeOwnershipRangeDays')}
    ${extractFunction(territory, 'defaultSoldMonthsForUser')}
    ${extractFunction(territory, 'normalizeRouteFilters')}
    ${extractFunction(territory, 'normalizeRouteBounds')}
    ${extractFunction(territory, 'hasOwn')}
    ${extractFunction(territory, 'isPositiveInteger')}
    ${extractFunction(territory, 'isPositiveNumber')}
    ${extractFunction(territory, 'isStrictOwnershipRangeDays')}
    ${extractFunction(territory, 'isStrictRouteFilters')}
    ${extractFunction(territory, 'isStrictRoutePoint')}
    ${extractFunction(territory, 'isStrictRouteBounds')}
    ${extractFunction(territory, 'isValidTimestamp')}
    ${extractFunction(territory, 'isCompleteServerPrecisionCriteria')}
    ${extractFunction(territory, 'precisionCriteriaToUi')}
    ${extractFunction(territory, 'normalizedHistoryCriteria')}
    this.normalizeHistory = normalizedHistoryCriteria;
  `, context);
  return (history) => {
    const result = context.normalizeHistory(history);
    return result === null ? null : JSON.parse(JSON.stringify(result));
  };
}

function loadHomeCountReader() {
  const schemaStart = home.indexOf('const PRECISION_CRITERIA_SCHEMA_VERSION');
  const schemaEnd = home.indexOf('function hasOwn', schemaStart);
  const countHelpersStart = home.indexOf('function getServerPrecisionCriteria');
  const countHelpersEnd = home.indexOf('function getPrecisionCandidateCriteria', countHelpersStart);
  assert.ok(schemaStart >= 0 && schemaEnd > schemaStart);
  assert.ok(countHelpersStart >= 0 && countHelpersEnd > countHelpersStart);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`
    ${home.slice(schemaStart, schemaEnd)}
    ${extractFunction(home, 'hasOwn')}
    ${extractFunction(home, 'isPositiveInteger')}
    ${extractFunction(home, 'isPositiveNumber')}
    ${extractFunction(home, 'isStrictOwnershipRangeDays')}
    ${extractFunction(home, 'isStrictRouteFilters')}
    ${extractFunction(home, 'isStrictRoutePoint')}
    ${extractFunction(home, 'isStrictRouteBounds')}
    ${extractFunction(home, 'isCompleteServerPrecisionCriteria')}
    ${home.slice(countHelpersStart, countHelpersEnd)}
    this.readCounts = getPrecisionCounts;
  `, context);
  return (job) => JSON.parse(JSON.stringify(context.readCounts(job)));
}

function loadPrecisionSaveEvidencePredicate() {
  const schemaStart = home.indexOf('const PRECISION_CRITERIA_SCHEMA_VERSION');
  const schemaEnd = home.indexOf('function hasOwn', schemaStart);
  assert.ok(schemaStart >= 0 && schemaEnd > schemaStart);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`
    ${home.slice(schemaStart, schemaEnd)}
    ${extractFunction(home, 'normalizeHistoryPolygon')}
    ${extractFunction(home, 'hasOwn')}
    ${extractFunction(home, 'isPositiveInteger')}
    ${extractFunction(home, 'isPositiveNumber')}
    ${extractFunction(home, 'isStrictOwnershipRangeDays')}
    ${extractFunction(home, 'isStrictRouteFilters')}
    ${extractFunction(home, 'isStrictRoutePoint')}
    ${extractFunction(home, 'isStrictRouteBounds')}
    ${extractFunction(home, 'isCompleteServerPrecisionCriteria')}
    ${extractFunction(home, 'hasValidPrecisionSaveEvidence')}
    this.hasValidPrecisionSaveEvidence = hasValidPrecisionSaveEvidence;
  `, context);
  return context.hasValidPrecisionSaveEvidence;
}

function loadResolvedHomeHistoryNormalizer() {
  const schemaStart = home.indexOf('const PRECISION_CRITERIA_SCHEMA_VERSION');
  const schemaEnd = home.indexOf('function hasOwn', schemaStart);
  const historyHelpersStart = home.indexOf('function getServerPrecisionCriteria');
  const historyHelpersEnd = home.indexOf('function getPrecisionCandidateCriteria', historyHelpersStart);
  assert.ok(schemaStart >= 0 && schemaEnd > schemaStart);
  assert.ok(historyHelpersStart >= 0 && historyHelpersEnd > historyHelpersStart);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`
    ${home.slice(schemaStart, schemaEnd)}
    ${extractFunction(home, 'normalizeHistoryPolygon')}
    ${extractFunction(home, 'hasOwn')}
    ${extractFunction(home, 'isPositiveInteger')}
    ${extractFunction(home, 'isPositiveNumber')}
    ${extractFunction(home, 'isStrictOwnershipRangeDays')}
    ${extractFunction(home, 'isStrictRouteFilters')}
    ${extractFunction(home, 'isStrictRoutePoint')}
    ${extractFunction(home, 'isStrictRouteBounds')}
    ${extractFunction(home, 'normalizeServerPrecisionPolygon')}
    ${extractFunction(home, 'getVerifiedServerPrecisionPolygon')}
    ${extractFunction(home, 'isCompleteServerPrecisionCriteria')}
    ${extractFunction(precisionIdentity, 'getPrecisionWorkspaceId')}
    ${home.slice(historyHelpersStart, historyHelpersEnd)}
    this.normalizeResolvedPrecisionHistoryEntries = normalizeResolvedPrecisionHistoryEntries;
  `, context);
  return (resolution, user) => JSON.parse(JSON.stringify(
    context.normalizeResolvedPrecisionHistoryEntries(resolution, user)
  ));
}

function loadResolvedHistorySelectionHelpers() {
  const defaultsStart = territory.indexOf('const DEFAULT_PRECISION_PROPERTY_COUNT');
  const defaultsEnd = territory.indexOf('function formatWholeNumber');
  const schemaStart = territory.indexOf('const PRECISION_CRITERIA_SCHEMA_VERSION');
  const schemaEnd = territory.indexOf('function hasOwn', schemaStart);
  const selectionHelpersStart = territory.indexOf('function getServerPrecisionCriteria');
  const selectionHelpersEnd = territory.indexOf('function precisionFunctionErrorDetails', selectionHelpersStart);
  assert.ok(defaultsStart >= 0 && defaultsEnd > defaultsStart);
  assert.ok(schemaStart >= 0 && schemaEnd > schemaStart);
  assert.ok(selectionHelpersStart >= 0 && selectionHelpersEnd > selectionHelpersStart);
  const context = {};
  vm.createContext(context);
  vm.runInContext(`
    ${territory.slice(defaultsStart, defaultsEnd)}
    ${territory.slice(schemaStart, schemaEnd)}
    ${extractFunction(territory, 'normalizeOwnershipRangeDays')}
    ${extractFunction(territory, 'normalizeRouteFilters')}
    ${extractFunction(territory, 'normalizeRouteBounds')}
    ${extractFunction(territory, 'hasOwn')}
    ${extractFunction(territory, 'isPositiveInteger')}
    ${extractFunction(territory, 'isPositiveNumber')}
    ${extractFunction(territory, 'isStrictOwnershipRangeDays')}
    ${extractFunction(territory, 'isStrictRouteFilters')}
    ${extractFunction(territory, 'isStrictRoutePoint')}
    ${extractFunction(territory, 'isStrictRouteBounds')}
    ${extractFunction(territory, 'normalizeServerPrecisionPolygon')}
    ${extractFunction(territory, 'getVerifiedServerPrecisionPolygon')}
    ${extractFunction(territory, 'isValidTimestamp')}
    ${extractFunction(territory, 'isCompleteServerPrecisionCriteria')}
    ${extractFunction(precisionIdentity, 'getPrecisionWorkspaceId')}
    ${territory.slice(selectionHelpersStart, selectionHelpersEnd)}
    this.precisionHistoryFetchJobId = precisionHistoryFetchJobId;
    this.resolvedPrecisionHistorySelection = resolvedPrecisionHistorySelection;
  `, context);
  return {
    eventJobId: context.precisionHistoryFetchJobId,
    select: (resolution, jobId, user) => {
      const result = context.resolvedPrecisionHistorySelection(resolution, jobId, user);
      return result === null ? null : JSON.parse(JSON.stringify(result));
    }
  };
}

const canonicalCriteria = (overrides = {}) => ({
  criteria_schema_version: 1,
  polygon_hash: '0123456789abcdef',
  count_mode: 'fixed',
  entered_count: 1000,
  effective_count: 839,
  min_price: 100000,
  max_price: null,
  sold_months: 12,
  ownership_range_mode: 'quick',
  ownership_range_days: null,
  route_filters: {
    propertyTypes: ['Single Family'],
    excludeCommercial: true,
    excludeCondos: true,
    excludeLand: true
  },
  repull_mode: 'new_area',
  previous_pull_date: null,
  force_full_refresh: false,
  include_unresolved_followups: false,
  route_bounds: { enabled: false },
  immutable_user_id: 'user-1',
  workspace_id: 'workspace-1',
  ...overrides
});

test('legacy and browser-authored history criteria fail closed instead of restoring inferred defaults', () => {
  const normalizeHistory = loadHistoryNormalizer();
  assert.equal(normalizeHistory({
    criteria_status: 'criteria_unverified',
    criteria_verified: false,
    criteria: { requested_properties: 73, min_price: null }
  }), null);
  assert.equal(normalizeHistory({
    criteria_status: 'server_verified',
    criteria_verified: false,
    criteria: { requested_properties: 73, min_price: null }
  }), null);
  assert.equal(normalizeHistory({
    criteria_status: 'server_verified',
    criteria_verified: true,
    criteria: { requested_properties: 73, min_price: null }
  }), null);
});

test('one complete server-verified canonical snapshot restores atomically with entered/effective semantics', () => {
  const normalizeHistory = loadHistoryNormalizer();
  const restored = normalizeHistory({
    criteria_status: 'server_verified',
    criteria_verified: true,
    criteria: canonicalCriteria({
      count_mode: 'max_available',
      entered_count: 839,
      effective_count: 839,
      min_price: 225000,
      max_price: 900000,
      sold_months: 6,
      ownership_range_mode: 'custom',
      ownership_range_days: { min: 45, max: 210 },
      include_unresolved_followups: false,
      route_filters: {
        propertyTypes: ['Single Family'],
        excludeCommercial: true,
        excludeCondos: true,
        excludeLand: true
      },
      route_bounds: {
        enabled: true,
        mode: 'current_to_home',
        start_location: { lat: 33.45, lng: -112.07 },
        end_location: { lat: 33.4, lng: -112.1 }
      },
      repull_mode: 'max_since_last',
      previous_pull_date: '2025-01-01T00:00:00.000Z'
    })
  });

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
    propertyTypes: ['Single Family'],
    excludeCommercial: true,
    excludeCondos: true,
    excludeLand: true
  });
  assert.deepEqual(restored.routeBounds, {
    enabled: true,
    mode: 'current_to_home',
    startLocation: { lat: 33.45, lng: -112.07 },
    endLocation: { lat: 33.4, lng: -112.1 }
  });
});

test('schema-v1 criteria reject coercion, widened route filters, malformed hashes, and noncanonical bounds', () => {
  const normalizeHistory = loadHistoryNormalizer();
  const readCounts = loadHomeCountReader();
  const restore = (criteria) => normalizeHistory({
    criteria_status: 'server_verified',
    criteria_verified: true,
    criteria
  });
  const malformed = [
    canonicalCriteria({ criteria_schema_version: '1' }),
    canonicalCriteria({ polygon_hash: 'sha256:verified-polygon' }),
    canonicalCriteria({ entered_count: '1000' }),
    canonicalCriteria({ effective_count: 839.5 }),
    canonicalCriteria({ min_price: '100000' }),
    canonicalCriteria({ sold_months: '12' }),
    canonicalCriteria({
      ownership_range_mode: 'custom',
      ownership_range_days: { min: '30', max: 180 }
    }),
    canonicalCriteria({
      route_filters: {
        propertyTypes: ['Townhouse'],
        excludeCommercial: true,
        excludeCondos: true,
        excludeLand: true
      }
    }),
    canonicalCriteria({
      route_filters: {
        propertyTypes: ['Single Family'],
        excludeCommercial: false,
        excludeCondos: true,
        excludeLand: true
      }
    }),
    canonicalCriteria({
      route_bounds: {
        enabled: true,
        mode: 'current_to_home',
        startLocation: { lat: 33.45, lng: -112.07 },
        endLocation: { lat: 33.4, lng: -112.1 }
      }
    }),
    canonicalCriteria({ immutable_user_id: 123 }),
    canonicalCriteria({ force_full_refresh: 'false' })
  ];

  malformed.forEach((criteria) => {
    assert.equal(restore(criteria), null);
    assert.equal(readCounts({ criteria_verified: true, criteria, delivered_count: 0 }), null);
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
  assert.match(territory, /precisionControlErrorMessage\(details\.code, details\.message\)/);
  assert.doesNotMatch(territory, /details\.status === 409/);
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

test('saved Precision routes preserve canonical entered, effective, delivered, and saved-route counts separately', () => {
  const saveStart = home.indexOf('const currentPrecisionCriteria =');
  const saveEnd = home.indexOf('// No "New', saveStart);
  const savedPrecisionArea = home.slice(saveStart, saveEnd);

  assert.ok(saveStart >= 0 && saveEnd > saveStart);
  assert.match(savedPrecisionArea, /precision_area:\s*\{/);
  assert.match(savedPrecisionArea, /criteria: currentPrecisionCriteria,/);
  assert.match(savedPrecisionArea, /canonicalCountRefsMatch/);
  assert.match(savedPrecisionArea, /count_mode: currentPrecisionCriteria\.count_mode/);
  assert.match(savedPrecisionArea, /entered_count: currentPrecisionCriteria\.entered_count/);
  assert.match(savedPrecisionArea, /effective_count: currentPrecisionCriteria\.effective_count/);
  assert.match(savedPrecisionArea, /delivered_count: currentBatchDataDeliveredCountRef\.current/);
  assert.match(savedPrecisionArea, /saved_route_property_count: route\.properties\.length/);
  assert.doesNotMatch(home, /criteria:\s*\{\s*\.\.\.\(entry\.criteria \|\| \{\}\),/);
  assert.doesNotMatch(polygonHistory, /criteria:\s*\{\s*\.\.\.\(entry\.criteria \|\| \{\}\),/);
  assert.match(home, /incomingVerified && !existingVerified/);
  assert.match(polygonHistory, /incomingVerified && !existingVerified/);
});

test('Precision route saving rejects property sets larger than the authoritative delivered count', () => {
  const hasValidEvidence = loadPrecisionSaveEvidencePredicate();
  const baseEvidence = {
    isGeneratedRoute: true,
    routeMode: 'precision',
    jobId: 'job-1',
    criteria: canonicalCriteria(),
    polygon: [
      { lat: 33.4, lng: -112.1 },
      { lat: 33.5, lng: -112.1 },
      { lat: 33.5, lng: -112.0 }
    ],
    canonicalCountRefsMatch: true,
    deliveredCount: 612
  };

  assert.equal(hasValidEvidence({ ...baseEvidence, savedRoutePropertyCount: 612 }), true);
  assert.equal(hasValidEvidence({ ...baseEvidence, savedRoutePropertyCount: 613 }), false);
  assert.equal(hasValidEvidence({ ...baseEvidence, savedRoutePropertyCount: 0 }), false);
  assert.equal(hasValidEvidence({ ...baseEvidence, deliveredCount: null, savedRoutePropertyCount: 1 }), false);
  assert.equal(hasValidEvidence({
    ...baseEvidence,
    isGeneratedRoute: false,
    deliveredCount: null,
    savedRoutePropertyCount: 999
  }), true);
});

test('the 1000 entered, 839 effective, 612 delivered example remains three distinct values', () => {
  const readCounts = loadHomeCountReader();
  assert.deepEqual(readCounts({
    criteria_verified: true,
    criteria: canonicalCriteria(),
    delivered_count: 612
  }), {
    count_mode: 'fixed',
    entered_count: 1000,
    effective_count: 839,
    delivered_count: 612
  });
});

test('an explicit null delivered count remains unverifiable even when a legacy alias is populated', () => {
  const readCounts = loadHomeCountReader();
  assert.deepEqual(readCounts({
    criteria_verified: true,
    criteria: canonicalCriteria(),
    delivered_count: null,
    precision_usage_count: 612
  }), {
    count_mode: 'fixed',
    entered_count: 1000,
    effective_count: 839,
    delivered_count: null
  });
});

test('retry sends only the failed FetchJob id and truthfully starts a new verified attempt', () => {
  const retryStart = territory.indexOf('const retryRecoverableJob');
  const retryEnd = territory.indexOf('const handleFetchData', retryStart);
  const retry = territory.slice(retryStart, retryEnd);

  assert.match(retry, /fetchAreaProperties', \{\s*retry_fetch_job_id: retryFetchJobId\s*\}/);
  assert.doesNotMatch(retry, /latitude:|longitude:|radius:|requested_properties:|sold_months:|route_filters:/);
  assert.doesNotMatch(retry, /validEnteredRequestedPropertyCount|if \(propertyCountMode/);
  assert.match(retry, /Starting a new attempt using the verified original criteria/);
  assert.doesNotMatch(retry, /last checkpoint|resume from checkpoint/i);
});

test('reload uses the server active-job resolver and distinguishes fail-closed states', () => {
  const reloadStart = territory.indexOf('// Auto-resume only from the server-owned Precision resolver');
  const reloadEnd = territory.indexOf('// Clear unqueried restored areas', reloadStart);
  const reload = territory.slice(reloadStart, reloadEnd);
  const persistedContextStart = home.indexOf('function readPersistedPrecisionJobContext');
  const persistedContextEnd = home.indexOf('function persistPrecisionJobContext', persistedContextStart);
  const persistedContextReader = home.slice(persistedContextStart, persistedContextEnd);

  assert.ok(reloadStart >= 0 && reloadEnd > reloadStart);
  assert.match(reload, /resolveActivePrecisionJobs/);
  assert.doesNotMatch(reload, /entities\.FetchJob\.(?:get|filter)/);
  assert.match(territory, /multiple_active_precision_jobs/);
  assert.match(territory, /precision_reservation_unsettled/);
  assert.match(territory, /legacy_precision_criteria_unverifiable/);
  assert.match(territory, /precision_retry_polygon_unverifiable/);
  assert.match(home, /base44\.functions\.invoke\('fetchJobStatus', \{ job_id: cachedContext\.jobId \}\)/);
  assert.match(home, /currentBatchDataContextHydratingRef\.current/);
  assert.match(persistedContextReader, /return jobId \? \{ jobId, userEmail \} : null/);
  assert.doesNotMatch(persistedContextReader, /criteria|polygon|deliveredCount/);
});

test('unsettled all-period reservations block the UI early but the start endpoint remains authoritative', () => {
  const previewStart = territory.indexOf('const handleFetchData');
  const paidStart = territory.indexOf('const handlePaidBatchDataPull', previewStart);
  const preview = territory.slice(previewStart, paidStart);
  const paidEnd = territory.indexOf('  return (', paidStart);
  const paid = territory.slice(paidStart, paidEnd);
  const refreshIndex = paid.indexOf('await refetchPrecisionUsage()');
  const reservationIndex = paid.indexOf('hasUnsettledPrecisionReservation(freshUsage)');
  const serverStartIndex = paid.indexOf("base44.functions.invoke('startBatchDataPull'");

  assert.match(precisionUsage, /startAvailable: data\.start_available/);
  assert.match(precisionUsage, /startBlockerCode,/);
  assert.match(precisionUsage, /startBlockerJobIds,/);
  assert.match(precisionUsage, /unsettledReservationCount,/);
  assert.match(precisionUsage, /unsettledJobIds/);
  assert.match(preview, /hasUnsettledPrecisionReservation\(precisionUsage\)/);
  assert.match(preview, /precisionControlErrorMessage\('precision_reservation_unsettled'\)/);
  assert.ok(refreshIndex >= 0);
  assert.ok(reservationIndex > refreshIndex, 'the reservation decision must use a freshly fetched server snapshot');
  assert.ok(serverStartIndex > reservationIndex, 'the provider start must remain behind the fail-early check');
  assert.match(paid, /precisionControlErrorMessage\('precision_reservation_unsettled'\)/);
  assert.match(territory, /startAvailable=\{precisionUsage\?\.startAvailable === true\}/);
  assert.match(territory, /startBlockerMessage=\{precisionStartBlockerMessage\}/);
  assert.match(panel, /const canStartPrecision = usageReady && startAvailable === true && Number\(maxProperties\) > 0/);
  assert.match(panel, /disabled=\{!canStartPrecision \|\| generating/);
  assert.match(panel, /startBlockerTitle \|\| 'Precision generation paused'/);
  assert.match(panel, /Number\(maxProperties\)/);
  assert.doesNotMatch(panel, /FREE_PRECISION_HOME_LIMIT - Number\(savedRouteHomeCount/);
});

test('Home accepts only whole service-verified history snapshots and downgrades malformed ones atomically', () => {
  const normalizeHistory = loadResolvedHomeHistoryNormalizer();
  const user = { id: 'user-1', team_manager_id: 'workspace-1' };
  const verified = {
    id: 'job-1',
    job_id: 'job-1',
    source_fetch_job_id: 'job-1',
    criteria_source_fetch_job_id: 'job-1',
    criteria_schema_version: 1,
    criteria_timestamp: '2026-07-25T12:00:00.000Z',
    criteria_status: 'server_verified',
    criteria_verified: true,
    polygon: [
      { lat: 33.4, lng: -112.1 },
      { lat: 33.5, lng: -112.1 },
      { lat: 33.5, lng: -112.0 }
    ],
    polygon_hash: '0123456789abcdef',
    criteria: canonicalCriteria(),
    status: 'completed',
    date: '2026-07-25T12:05:00.000Z',
    last_pull_date: '2026-07-25T12:05:00.000Z',
    entered_count: 1000,
    effective_count: 839,
    delivered_count: 612
  };

  const accepted = normalizeHistory({ state: 'ok', entries: [verified] }, user);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].criteria_verified, true);
  assert.equal(accepted[0].criteria_source_fetch_job_id, 'job-1');
  assert.deepEqual(accepted[0].criteria, canonicalCriteria());
  const nestedWorkspaceAccepted = normalizeHistory(
    { state: 'ok', entries: [verified] },
    { id: 'user-1', data: { team_manager_id: 'workspace-1' } }
  );
  assert.equal(nestedWorkspaceAccepted[0].criteria_verified, true);

  for (const malformed of [
    { ...verified, criteria_verified: false },
    { ...verified, criteria: canonicalCriteria({ immutable_user_id: 'other-user' }) },
    { ...verified, delivered_count: 840 },
    { ...verified, criteria_source_fetch_job_id: 'job-2' }
  ]) {
    const [downgraded] = normalizeHistory({ state: 'ok', entries: [malformed] }, user);
    assert.equal(downgraded.criteria_verified, false);
    assert.equal(downgraded.criteria_status, 'criteria_unverified');
    assert.equal(downgraded.criteria, null);
    assert.equal(downgraded.delivered_count, null);
  }
  assert.deepEqual(normalizeHistory({ state: 'single', entries: [verified] }, user), []);
});

test('history clicks carry only an opaque job id and require an exact server re-resolution', () => {
  const { eventJobId, select } = loadResolvedHistorySelectionHelpers();
  const user = { id: 'user-1', team_manager_id: 'workspace-1' };
  const job = {
    job_id: 'job-1',
    criteria_source_fetch_job_id: 'job-1',
    criteria_schema_version: 1,
    criteria_timestamp: '2026-07-25T12:00:00.000Z',
    criteria_status: 'server_verified',
    criteria_verified: true,
    polygon: [
      { lat: 33.4, lng: -112.1 },
      { lat: 33.5, lng: -112.1 },
      { lat: 33.5, lng: -112.0 }
    ],
    polygon_hash: '0123456789abcdef',
    criteria: canonicalCriteria(),
    status: 'completed',
    entered_count: 1000,
    effective_count: 839,
    delivered_count: 612
  };

  assert.equal(eventJobId({
    criteria_status: 'server_verified',
    criteria_verified: true,
    criteria: canonicalCriteria(),
    polygon: job.polygon
  }), null);
  assert.equal(eventJobId({ fetch_job_id: ' job-1 ', criteria: { forged: true } }), 'job-1');
  assert.equal(select({ state: 'single', job }, 'job-1', user)?.job.job_id, 'job-1');
  assert.equal(select({ state: 'single', job }, 'job-2', user), null);
  assert.equal(select({
    state: 'single',
    job: { ...job, criteria_verified: false }
  }, 'job-1', user), null);
  assert.equal(select(
    { state: 'single', job },
    'job-1',
    { id: 'user-1', data: { team_manager_id: 'workspace-1' } }
  )?.job.job_id, 'job-1');
});

test('Precision workspace identity accepts both supported Base44 user shapes', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`
    ${extractFunction(precisionIdentity, 'getPrecisionWorkspaceId')}
    this.getPrecisionWorkspaceId = getPrecisionWorkspaceId;
  `, context);
  assert.equal(context.getPrecisionWorkspaceId({
    id: 'rep-1',
    team_manager_id: 'workspace-top',
    data: { team_manager_id: 'workspace-nested' }
  }), 'workspace-top');
  assert.equal(context.getPrecisionWorkspaceId({
    id: 'rep-1',
    data: { team_manager_id: 'workspace-nested' }
  }), 'workspace-nested');
  assert.equal(context.getPrecisionWorkspaceId({ id: 'manager-1' }), 'manager-1');
});

test('Fixed Count preserves entered intent while Max Available sends mode without an old numeric ceiling', () => {
  assert.match(territory, /const fixedEnteredCount = Number\(requestedPropertyCount\)/);
  assert.match(territory, /!Number\.isSafeInteger\(fixedEnteredCount\) \|\| fixedEnteredCount <= 0/);
  assert.match(territory, /\? \{ allowance_estimate: freshMaxProperties \}\s*: \{ requested_properties: fixedEnteredCount \}/);
  assert.doesNotMatch(panel, /setRequestedPropertyCount\(maxProperties\)/);
  assert.doesNotMatch(panel, /Math\.min\(Number\(requestedPropertyCount\).+maxProperties/);
  assert.doesNotMatch(panel, /max=\{Math\.max\(1, Number\(maxProperties\)/);
});

test('legacy polygon history stays visible but is display-only and cannot self-assert verification', () => {
  assert.match(polygonHistory, /criteria_status: 'criteria_unverified'/);
  assert.match(polygonHistory, /criteria_verified: false/);
  assert.match(polygonHistory, /interactive: isBuilder && criteriaVerified/);
  assert.match(polygonHistory, /Criteria unverified · display only/);
  assert.match(polygonHistory, /detail:\s*\{\s*fetch_job_id: entry\.criteria_source_fetch_job_id\s*\}/);
  assert.doesNotMatch(polygonHistory, /detail: entry/);
  assert.match(territory, /resolvePrecisionHistory', \{\s*fetch_job_id: fetchJobId\s*\}/);
  assert.match(home, /base44\.functions\.invoke\('resolvePrecisionHistory', \{\}\)/);
  assert.doesNotMatch(home, /base44\.entities\.FetchJob\.filter/);
});

test('server polygon evidence is mandatory for history, completion, and automatic generation', () => {
  const completionPolling = territory.slice(
    territory.indexOf("if (d.status === 'completed')"),
    territory.indexOf("} else if (d.status === 'cancelled')")
  );
  const completionStart = home.indexOf('onPullComplete={async');
  const completionHandler = home.slice(
    completionStart,
    home.indexOf('\n            />', completionStart)
  );

  assert.match(home, /normalizeResolvedPrecisionHistoryEntries\(precisionHistoryResolution, user\)/);
  assert.match(home, /const verifiedPolygon = getVerifiedServerPrecisionPolygon\(entry, criteria\)/);
  assert.match(home, /entry\.criteria_verified !== true \|\| entry\.criteria_status !== 'server_verified'/);
  assert.match(completionPolling, /const completedPolygon = getVerifiedServerPrecisionPolygon\(d, canonicalCriteria\)/);
  assert.match(completionPolling, /d\.criteria_verified !== true/);
  assert.match(completionPolling, /polygon: completedPolygon/);
  assert.doesNotMatch(completionPolling, /intent\.polygon/);
  assert.match(completionHandler, /getVerifiedServerPrecisionPolygon\(jobStatus, completedCandidateCriteria\)/);
  assert.doesNotMatch(completionHandler, /drawnPullPolygon|statusPolygon\.length/);
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
