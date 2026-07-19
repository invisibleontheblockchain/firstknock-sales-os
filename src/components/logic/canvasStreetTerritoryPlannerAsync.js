import { planCanvasTerritories } from './canvasStreetTerritoryPlanner.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120_000;

function normalizedTimeoutMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.round(numeric)));
}

function requestId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `canvas_planner_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
}

function plannerError(payload = {}) {
  const error = new Error(String(payload.message || 'Canvas territory planning failed in the background worker.'));
  error.name = String(payload.name || 'Error');
  if (payload.code !== undefined && payload.code !== null && payload.code !== '') error.code = String(payload.code);
  if (payload.details && typeof payload.details === 'object') error.details = payload.details;
  return error;
}

function unavailableWorkerFallback(input) {
  try {
    return Promise.resolve(planCanvasTerritories(input));
  } catch (error) {
    return Promise.reject(error);
  }
}

export function planCanvasTerritoriesAsync(input = {}, options = {}) {
  if (typeof Worker !== 'function') return unavailableWorkerFallback(input);

  const timeoutMs = normalizedTimeoutMs(options?.timeoutMs);
  const signal = options?.signal;
  const activeRequestId = requestId();

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error('Canvas territory planning was canceled.');
      error.name = 'AbortError';
      error.code = 'CANVAS_PLANNER_ABORTED';
      reject(error);
      return;
    }
    const worker = new Worker(
      new URL('./canvasStreetTerritoryPlanner.worker.js', import.meta.url),
      { type: 'module', name: 'firstknock-canvas-territory-planner' },
    );
    let settled = false;

    const cleanup = () => {
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      try { worker.terminate(); } catch {}
    };

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanup();
      callback(value);
    };

    const timeout = setTimeout(() => {
      const error = new Error(`Canvas territory planning exceeded the ${Math.round(timeoutMs / 1000)}-second safety limit.`);
      error.name = 'CanvasPlannerTimeoutError';
      error.code = 'CANVAS_PLANNER_TIMEOUT';
      settle(reject, error);
    }, timeoutMs);

    const onAbort = () => {
      const error = new Error('Canvas territory planning was canceled.');
      error.name = 'AbortError';
      error.code = 'CANVAS_PLANNER_ABORTED';
      settle(reject, error);
    };
    if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });

    worker.onmessage = (event) => {
      if (String(event?.data?.requestId || '') !== activeRequestId) return;
      if (event?.data?.ok === true) {
        settle(resolve, event.data.result);
        return;
      }
      settle(reject, plannerError(event?.data?.error));
    };

    worker.onerror = (event) => {
      if (typeof event?.preventDefault === 'function') event.preventDefault();
      const error = new Error(String(event?.message || 'Canvas territory planning worker failed.'));
      error.name = 'CanvasPlannerWorkerError';
      error.code = 'CANVAS_PLANNER_WORKER_FAILED';
      settle(reject, error);
    };

    worker.onmessageerror = () => {
      const error = new Error('Canvas territory planning returned an unreadable worker response.');
      error.name = 'CanvasPlannerWorkerError';
      error.code = 'CANVAS_PLANNER_WORKER_MESSAGE_INVALID';
      settle(reject, error);
    };

    try {
      worker.postMessage({ requestId: activeRequestId, input });
    } catch (error) {
      settle(reject, error);
    }
  });
}

export const canvasStreetTerritoryPlannerAsyncInternals = Object.freeze({
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  normalizedTimeoutMs,
});
