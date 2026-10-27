// Remembers which generated routes already went through the road pass in this
// session, so saving them does not run the whole road optimization again.
//
// Create Route and Reorder run every new route through the road optimizer
// before auto-saving. The save step then re-ran that optimizer on every route
// unless it carried the routing-beta marker, which only the beta sets, so with
// the beta off each route was optimized twice: the save took as long as the
// build, opened one more "Optimizing your route" screen per route, and competed
// with the first pass's background searches for the road server. A slow or
// interrupted save is what left routes sitting in the panel asking to be saved
// and the paid import waiting for recovery on the next visit.
//
// Routes are remembered by object identity together with their stop order, so
// a filtered copy, a split, an import, or a route whose stops changed still
// gets the road pass before it is saved.

import { routePropertyOrderFingerprint } from '../../base44/shared/routeFingerprint.js';

const completed = new WeakMap();

function orderOf(route) {
  return Array.isArray(route?.properties) && route.properties.length
    ? routePropertyOrderFingerprint(route.properties)
    : null;
}

/** Record that these routes just came out of the road pass. */
export function markRoadCompleted(routes) {
  for (const route of Array.isArray(routes) ? routes : []) {
    if (!route || typeof route !== 'object') continue;
    const fingerprint = orderOf(route);
    if (fingerprint) completed.set(route, fingerprint);
  }
  return routes;
}

export function isRoadCompleted(route) {
  if (!route || typeof route !== 'object' || !completed.has(route)) return false;
  return completed.get(route) === orderOf(route);
}

/**
 * Whether saving `route` must first run it through the road optimization.
 * Saved routes, routes with no stops, routes the beta already completed for
 * this exact order, and routes this session's road pass just produced are done.
 */
export function needsRoadCompletionBeforeSave(route) {
  if (!route || route.isSaved || !Array.isArray(route.properties) || route.properties.length === 0) return false;
  if (isRoadCompleted(route)) return false;
  const routing = route.metadata?.routing;
  if (routing?.road_aware_routing_beta && routing.property_order_fingerprint === orderOf(route)) return false;
  return true;
}
