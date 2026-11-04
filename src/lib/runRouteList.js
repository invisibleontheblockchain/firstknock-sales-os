import { collectKnockRoutes, fetchKnockRouteGroups } from '../components/rep/repRouteCollection.js';
import { withReadDeadline } from './readRequest.js';

// The Base44 SDK sends requests with no timeout. One stalled read on a weak
// signal used to leave Run Route blank until the app was reopened, because
// React Query will not start a new fetch while the stalled one is pending.
export const RUN_ROUTE_PAGE_DEADLINE_MS = 15_000;

export function runRouteListCacheKey(scope) {
  return [
    'fk_run_route_list',
    scope?.userId || '',
    scope?.managerId || '',
    scope?.managerAccount ? 'manager' : 'rep',
  ].join(':');
}

// Loads the Run Route list with a deadline on every page. A good result is
// saved on the device; when the network fails, the last good list for this
// same account is shown instead (marked fromCache) so the rep can keep working.
export async function loadRunRouteList({
  fetchFilterPage,
  scope,
  cache = null,
  deadlineMs = RUN_ROUTE_PAGE_DEADLINE_MS,
}) {
  if (!scope?.userId) return { items: [], fromCache: false };
  const cacheKey = runRouteListCacheKey(scope);
  try {
    const groups = await fetchKnockRouteGroups(
      (filter, limit, skip, fields) => withReadDeadline(() => fetchFilterPage(filter, limit, skip, fields), deadlineMs),
      scope,
    );
    const items = collectKnockRoutes(groups, scope);
    try {
      await cache?.setItem(cacheKey, items);
    } catch {
      // A full or blocked device store must not hide a good network result.
    }
    return { items, fromCache: false };
  } catch (error) {
    let cached = null;
    try {
      cached = await cache?.getItem(cacheKey);
    } catch {
      cached = null;
    }
    if (Array.isArray(cached)) {
      // Re-apply the tenant boundary to the snapshot before anything renders.
      return { items: collectKnockRoutes([cached], scope), fromCache: true };
    }
    throw error;
  }
}
