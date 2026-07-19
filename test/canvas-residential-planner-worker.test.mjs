import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { partitionCanvasResidentialTerritories } from '../src/components/logic/canvasResidentialTerritoryAnalysis.js';
import {
  canvasResidentialTerritoryPlannerAsyncInternals,
  partitionCanvasResidentialTerritoriesAsync,
} from '../src/components/logic/canvasResidentialTerritoryPlannerAsync.js';

const plannerInput = {
  area_count: 1,
  street_units: [{
    id: 'street:1',
    canvas_role: 'knock',
    neighbor_ids: [],
    protected: true,
    opportunity_expected: 4,
    opportunity: { low: 3, expected: 4, high: 5 },
  }],
};

async function withWorker(value, callback) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  if (value === undefined) delete globalThis.Worker;
  else Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value });
  try {
    return await callback();
  } finally {
    if (original) Object.defineProperty(globalThis, 'Worker', original);
    else delete globalThis.Worker;
  }
}

test('residential planner falls back to the same deterministic partition when Worker is unavailable', async () => {
  await withWorker(undefined, async () => {
    assert.deepEqual(
      await partitionCanvasResidentialTerritoriesAsync(plannerInput),
      partitionCanvasResidentialTerritories(plannerInput),
    );
  });
});

test('residential live preview uses a module worker and cleans it up', async () => {
  let instance;
  const workerResult = { ok: true, zones: [{ zone_id: 'zone:1' }] };
  class SuccessfulWorker {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.terminated = 0;
      instance = this;
    }

    postMessage(message) {
      this.request = message;
      queueMicrotask(() => this.onmessage?.({ data: { requestId: message.requestId, ok: true, result: workerResult } }));
    }

    terminate() { this.terminated += 1; }
  }

  await withWorker(SuccessfulWorker, async () => {
    assert.deepEqual(await partitionCanvasResidentialTerritoriesAsync(plannerInput), workerResult);
    assert.equal(instance.options.type, 'module');
    assert.equal(instance.options.name, 'firstknock-canvas-residential-territory-planner');
    assert.match(instance.url.href, /canvasResidentialTerritoryPlanner\.worker\.js$/);
    assert.equal(instance.terminated, 1);
    assert.equal(instance.onmessage, null);
    assert.equal(instance.onerror, null);
    assert.equal(instance.onmessageerror, null);
  });
});

test('residential live preview aborts and terminates obsolete calculations', async () => {
  let instance;
  class SilentWorker {
    constructor() { this.terminated = 0; instance = this; }
    postMessage() {}
    terminate() { this.terminated += 1; }
  }
  await withWorker(SilentWorker, async () => {
    const controller = new AbortController();
    const pending = partitionCanvasResidentialTerritoriesAsync(plannerInput, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error) => error.name === 'AbortError' && error.code === 'CANVAS_PLANNER_ABORTED');
    assert.equal(instance.terminated, 1);
  });
});

test('residential planner timeout remains bounded', () => {
  const { DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, normalizedTimeoutMs } = canvasResidentialTerritoryPlannerAsyncInternals;
  assert.equal(normalizedTimeoutMs(undefined), DEFAULT_TIMEOUT_MS);
  assert.equal(normalizedTimeoutMs(1), MIN_TIMEOUT_MS);
  assert.equal(normalizedTimeoutMs(Number.MAX_SAFE_INTEGER), MAX_TIMEOUT_MS);
});

test('residential worker preserves the deterministic partitioner as its sole algorithm', () => {
  const worker = readFileSync(new URL('../src/components/logic/canvasResidentialTerritoryPlanner.worker.js', import.meta.url), 'utf8');
  const adapter = readFileSync(new URL('../src/components/logic/canvasResidentialTerritoryPlannerAsync.js', import.meta.url), 'utf8');
  const builder = readFileSync(new URL('../src/components/map/CanvasBuilderSettings.jsx', import.meta.url), 'utf8');
  assert.match(worker, /import \{ partitionCanvasResidentialTerritories \} from '\.\/canvasResidentialTerritoryAnalysis\.js'/);
  assert.match(adapter, /new URL\('\.\/canvasResidentialTerritoryPlanner\.worker\.js', import\.meta\.url\)/);
  assert.match(builder, /await partitionCanvasResidentialTerritoriesAsync\(/);
  assert.doesNotMatch(worker, /square grid|rectangle|homes_per_area/i);
});

test('residential partitioner keeps a weighted 20,000-unit chain executable and balanced', () => {
  const unitCount = 20_000;
  const areaCount = 200;
  const idFor = (index) => `scale-unit-${String(index).padStart(5, '0')}`;
  const streetUnits = Array.from({ length: unitCount }, (_, index) => ({
    id: idFor(index),
    canvas_role: 'knock',
    neighbor_ids: [index > 0 ? idFor(index - 1) : null, index + 1 < unitCount ? idFor(index + 1) : null].filter(Boolean),
    opportunity_expected: (index % 20) + 1,
  }));
  const startedAt = performance.now();
  const result = partitionCanvasResidentialTerritories({ street_units: streetUnits, area_count: areaCount });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(result.ok, true);
  assert.equal(result.zones.length, areaCount);
  assert.equal(result.zones.flatMap((zone) => zone.work_unit_ids).length, unitCount);
  assert.equal(result.qa.max_opportunity_deviation_percent, 0);
  assert.ok(elapsedMs < 30_000, `20,000-unit planning took ${Math.round(elapsedMs)}ms`);
});

test('residential partitioner finds the exact connected solution for a weighted 100x200 street grid', () => {
  const rows = 100;
  const columns = 200;
  const areaCount = columns;
  const idFor = (row, column) => `weighted-grid-${String(row).padStart(3, '0')}-${String(column).padStart(3, '0')}`;
  const streetUnits = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      streetUnits.push({
        id: idFor(row, column),
        canvas_role: 'knock',
        neighbor_ids: [
          row > 0 ? idFor(row - 1, column) : null,
          row + 1 < rows ? idFor(row + 1, column) : null,
          column > 0 ? idFor(row, column - 1) : null,
          column + 1 < columns ? idFor(row, column + 1) : null,
        ].filter(Boolean),
        // Each column has exactly the global target workload, while a naive
        // simultaneous frontier expansion produces severely starved zones.
        opportunity_expected: (row % 20) + 1,
      });
    }
  }

  const startedAt = performance.now();
  const result = partitionCanvasResidentialTerritories({ street_units: streetUnits, area_count: areaCount });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(result.ok, true);
  assert.equal(result.zones.length, areaCount);
  assert.equal(result.qa.connected_zones, true);
  assert.equal(result.qa.exclusive_work_unit_coverage, true);
  assert.equal(result.qa.max_opportunity_deviation_percent, 0);
  assert.deepEqual(new Set(result.zones.map((zone) => zone.workload_score)), new Set([1_050]));
  assert.ok(elapsedMs < 30_000, `weighted grid planning took ${Math.round(elapsedMs)}ms`);
});
