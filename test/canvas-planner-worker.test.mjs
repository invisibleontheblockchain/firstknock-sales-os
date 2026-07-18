import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { planCanvasTerritories } from '../src/components/logic/canvasStreetTerritoryPlanner.js';
import {
  canvasStreetTerritoryPlannerAsyncInternals,
  planCanvasTerritoriesAsync,
} from '../src/components/logic/canvasStreetTerritoryPlannerAsync.js';

const polygon = [
  { lat: 34.999, lng: -82.011 },
  { lat: 34.999, lng: -81.989 },
  { lat: 35.011, lng: -81.989 },
  { lat: 35.011, lng: -82.011 },
];

const plannerInput = {
  polygon,
  roadNetwork: {
    elements: [
      { type: 'node', id: 1, lat: 35, lon: -82.01 },
      { type: 'node', id: 2, lat: 35, lon: -81.99 },
      { type: 'way', id: 100, nodes: [1, 2], tags: { highway: 'residential', name: 'Main Street' } },
    ],
  },
  requested_zone_count: 1,
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

test('falls back to the same deterministic planner only when Worker is unavailable', async () => {
  await withWorker(undefined, async () => {
    const expected = planCanvasTerritories(plannerInput);
    const actual = await planCanvasTerritoriesAsync(plannerInput);
    assert.deepEqual(actual, expected);
    assert.equal(actual.qa.exclusive_work_unit_coverage, true);
    assert.equal(actual.qa.connected_zones, true);
    assert.equal(actual.qa.protected_units_intact, true);
  });
});

test('uses a module worker and terminates it after a successful response', async () => {
  const instances = [];
  const workerResult = { ok: true, zones: [{ zone_id: 'zone-1' }], algorithm_version: 'worker-test' };
  class SuccessfulWorker {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.terminated = 0;
      instances.push(this);
    }

    postMessage(message) {
      this.request = message;
      queueMicrotask(() => this.onmessage?.({ data: { requestId: message.requestId, ok: true, result: workerResult } }));
    }

    terminate() {
      this.terminated += 1;
    }
  }

  await withWorker(SuccessfulWorker, async () => {
    const result = await planCanvasTerritoriesAsync({ marker: 'input' });
    const [worker] = instances;
    assert.deepEqual(result, workerResult);
    assert.equal(worker.options.type, 'module');
    assert.equal(worker.options.name, 'firstknock-canvas-territory-planner');
    assert.match(worker.url.href, /canvasStreetTerritoryPlanner\.worker\.js$/);
    assert.deepEqual(worker.request.input, { marker: 'input' });
    assert.equal(worker.terminated, 1);
    assert.equal(worker.onmessage, null);
    assert.equal(worker.onerror, null);
    assert.equal(worker.onmessageerror, null);
  });
});

test('propagates serialized worker planner failures and terminates the worker', async () => {
  let instance;
  class FailedWorker {
    constructor() {
      this.terminated = 0;
      instance = this;
    }

    postMessage(message) {
      queueMicrotask(() => this.onmessage?.({
        data: {
          requestId: message.requestId,
          ok: false,
          error: { name: 'CanvasFixtureError', message: 'fixture planner failed', code: 'FIXTURE_FAILED' },
        },
      }));
    }

    terminate() {
      this.terminated += 1;
    }
  }

  await withWorker(FailedWorker, async () => {
    await assert.rejects(planCanvasTerritoriesAsync({}), (error) => {
      assert.equal(error.name, 'CanvasFixtureError');
      assert.equal(error.message, 'fixture planner failed');
      assert.equal(error.code, 'FIXTURE_FAILED');
      return true;
    });
    assert.equal(instance.terminated, 1);
  });
});

test('propagates module worker runtime errors without invoking the fallback', async () => {
  let instance;
  let prevented = false;
  class RuntimeErrorWorker {
    constructor() {
      this.terminated = 0;
      instance = this;
    }

    postMessage() {
      queueMicrotask(() => this.onerror?.({
        message: 'worker module could not load',
        preventDefault: () => { prevented = true; },
      }));
    }

    terminate() {
      this.terminated += 1;
    }
  }

  await withWorker(RuntimeErrorWorker, async () => {
    await assert.rejects(planCanvasTerritoriesAsync(plannerInput), (error) => {
      assert.equal(error.name, 'CanvasPlannerWorkerError');
      assert.equal(error.message, 'worker module could not load');
      assert.equal(error.code, 'CANVAS_PLANNER_WORKER_FAILED');
      return true;
    });
    assert.equal(prevented, true);
    assert.equal(instance.terminated, 1);
  });
});

test('times out and terminates an unresponsive worker within bounded limits', async () => {
  let instance;
  class SilentWorker {
    constructor() {
      this.terminated = 0;
      instance = this;
    }

    postMessage() {}

    terminate() {
      this.terminated += 1;
    }
  }

  const { DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, normalizedTimeoutMs } = canvasStreetTerritoryPlannerAsyncInternals;
  assert.equal(normalizedTimeoutMs(undefined), DEFAULT_TIMEOUT_MS);
  assert.equal(normalizedTimeoutMs(1), MIN_TIMEOUT_MS);
  assert.equal(normalizedTimeoutMs(Number.MAX_SAFE_INTEGER), MAX_TIMEOUT_MS);

  await withWorker(SilentWorker, async () => {
    await assert.rejects(planCanvasTerritoriesAsync({}, { timeoutMs: 1 }), (error) => {
      assert.equal(error.name, 'CanvasPlannerTimeoutError');
      assert.equal(error.code, 'CANVAS_PLANNER_TIMEOUT');
      return true;
    });
    assert.equal(instance.terminated, 1);
  });
});

test('aborts and terminates an obsolete live-preview calculation', async () => {
  let instance;
  class SilentWorker {
    constructor() {
      this.terminated = 0;
      instance = this;
    }

    postMessage() {}

    terminate() {
      this.terminated += 1;
    }
  }

  await withWorker(SilentWorker, async () => {
    const controller = new AbortController();
    const pending = planCanvasTerritoriesAsync({}, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error) => {
      assert.equal(error.name, 'AbortError');
      assert.equal(error.code, 'CANVAS_PLANNER_ABORTED');
      return true;
    });
    assert.equal(instance.terminated, 1);
  });
});

test('does not hide worker construction failures behind the synchronous fallback', async () => {
  class BrokenWorker {
    constructor() {
      throw new Error('worker construction blocked');
    }
  }

  await withWorker(BrokenWorker, async () => {
    await assert.rejects(planCanvasTerritoriesAsync(plannerInput), /worker construction blocked/);
  });
});

test('worker and adapter sources preserve the existing planner as the sole algorithm', () => {
  const worker = readFileSync(new URL('../src/components/logic/canvasStreetTerritoryPlanner.worker.js', import.meta.url), 'utf8');
  const adapter = readFileSync(new URL('../src/components/logic/canvasStreetTerritoryPlannerAsync.js', import.meta.url), 'utf8');
  assert.match(worker, /import \{ planCanvasTerritories \} from '\.\/canvasStreetTerritoryPlanner\.js'/);
  assert.match(worker, /const result = planCanvasTerritories\(event\?\.data\?\.input \|\| \{\}\)/);
  assert.match(adapter, /new Worker\([\s\S]*?new URL\('\.\/canvasStreetTerritoryPlanner\.worker\.js', import\.meta\.url\)[\s\S]*?type: 'module'/);
  assert.doesNotMatch(worker, /door|walking|homes_per_area|square grid/i);
});
