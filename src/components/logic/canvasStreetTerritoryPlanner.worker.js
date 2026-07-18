import { planCanvasTerritories } from './canvasStreetTerritoryPlanner.js';

function serializePlannerError(error) {
  return {
    name: String(error?.name || 'Error'),
    message: String(error?.message || 'Canvas territory planning failed in the background worker.'),
    code: error?.code === undefined || error?.code === null ? null : String(error.code),
    details: error?.details && typeof error.details === 'object' ? error.details : null,
  };
}

self.addEventListener('message', (event) => {
  const requestId = String(event?.data?.requestId || '');
  try {
    const result = planCanvasTerritories(event?.data?.input || {});
    self.postMessage({ requestId, ok: true, result });
  } catch (error) {
    self.postMessage({ requestId, ok: false, error: serializePlannerError(error) });
  }
});
