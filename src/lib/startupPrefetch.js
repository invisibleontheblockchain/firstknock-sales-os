import { base44 } from '@/api/base44Client';
import { mapTerritoryBootstrapOptions } from '@/components/map/mapTerritoryLoading';
import { fetchAccountInteractionLogs } from '@/lib/accountInteractionLogs';
import { withReadDeadline } from '@/lib/readRequest';
import { isManagerAccount, landingPageForAccount } from '@/lib/roles';
import { pageNameForPath, preloadPage } from '@/lib/pagePreload';
import { warmMapTiles } from '@/lib/mapTileWarmup';

// Pages that only route the account onward. Their destination is known as soon
// as the account loads, so its chunk and first reads can start right away.
const ROUTING_PAGES = new Set(['RoleSelect']);

function destinationPage(user, pathname) {
  const current = pageNameForPath(pathname);
  // "/" is the marketing page for browsers, so nothing is prefetched there.
  if (!current || !ROUTING_PAGES.has(current)) return current;
  // Signed-in roles skip RoleSelect; first-run accounts stay there.
  return user?.app_role ? landingPageForAccount(user) : current;
}

// Runs once sign-in resolves. The map used to issue its first reads only after
// its 300 KB chunk finished downloading; these share the exact query keys and
// fetches the map uses, so the map picks up the in-flight or cached result.
export function startLandingPrefetch(queryClient, user, pathname = globalThis.location?.pathname) {
  if (!user) return;
  const page = destinationPage(user, pathname);
  preloadPage(page);
  if (page !== 'Home' || !isManagerAccount(user)) return;
  // The saved view's basemap tiles download while the map chunk does.
  warmMapTiles(user);
  const invoke = (...args) => base44.functions.invoke(...args);
  queryClient.prefetchQuery(mapTerritoryBootstrapOptions(user, invoke, withReadDeadline));
  // Same key and read as Home's account outcomes query. Nothing is pending at
  // startup, so Home's pending-outcome merge would return these rows unchanged.
  queryClient.prefetchQuery({
    queryKey: ['interactionLogs', user.email],
    staleTime: 1000 * 60 * 2,
    queryFn: () => withReadDeadline(() => fetchAccountInteractionLogs(user)),
  });
}
