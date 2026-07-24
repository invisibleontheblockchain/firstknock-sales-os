import { buildLargeRouteManifests } from './largeRouteOptimizer.js';

function serializeError(error) {
  return {
    name: String(error?.name || 'Error'),
    message: String(error?.message || 'Large-route optimization failed in the background worker.'),
    code: error?.code === undefined || error?.code === null ? null : String(error.code),
  };
}

self.addEventListener('message', (event) => {
  const requestId = String(event?.data?.requestId || '');
  try {
    const result = buildLargeRouteManifests(event?.data?.input || {});
    self.postMessage({ requestId, ok: true, result });
  } catch (error) {
    self.postMessage({ requestId, ok: false, error: serializeError(error) });
  }
});
