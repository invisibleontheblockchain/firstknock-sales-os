// Whether a route on screen exists in the account or only on this device.
//
// A generated route keeps the optimizer's temporary id ("route_1") until its
// save lands. Deleting one of those asked the server to remove a record that
// was never created, which failed with "Entity SavedRoute with ID route_1 not
// found" and left the route stuck on screen. Kept free of React and Base44
// imports so it runs under node:test.

const text = value => (value === undefined || value === null ? '' : String(value).trim());

/**
 * True when `route` was never saved to the account. `savedRouteIds`, when
 * given, is the set of ids the account actually has.
 */
export function isUnsavedRoute(route, savedRouteIds = null) {
  if (!route) return false;
  if (route.isSaved === false) return true;
  const id = text(route.id);
  if (!id || id.startsWith('local_')) return true;
  if (savedRouteIds && typeof savedRouteIds.has === 'function') return !savedRouteIds.has(id);
  return false;
}
