import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { checkForPublishedRelease, refreshToPublishedRelease } from '@/lib/pwaRelease';

const UPDATE_POLL_INTERVAL_MS = 5 * 60_000;

export default function AppRefreshManager() {
  const queryClient = useQueryClient();
  const [availableRelease, setAvailableRelease] = React.useState(null);
  const [isOnline, setIsOnline] = React.useState(() => navigator.onLine !== false);

  React.useEffect(() => {
    let mounted = true;
    let lastUserRefreshAt = null;
    let lastUsageRefreshAt = null;
    const checkForUpdate = (force = false) => {
      if (document.visibilityState !== 'visible' || navigator.onLine === false) return;
      Promise.resolve(checkForPublishedRelease(window.__FK_PWA_RELEASE__, { force })).then((release) => {
        if (mounted && release) setAvailableRelease(release);
      });
    };
    const refreshApp = () => {
      if (document.visibilityState !== 'visible' || navigator.onLine === false) return;
      const now = Date.now();
      // pageshow and visibilitychange can arrive together when returning from
      // Maps. Avoid starting the same account reads again for each event.
      if (lastUserRefreshAt === null || now - lastUserRefreshAt >= 30_000) {
        lastUserRefreshAt = now;
        queryClient.invalidateQueries({ queryKey: ['user'] });
      }
      // The billing meter can read Stripe/usage ledgers. Preserve its two-minute
      // presentation cache on routine foreground/Maps returns; explicit pulls
      // and purchases still invalidate their own authoritative usage result.
      if (lastUsageRefreshAt === null || now - lastUsageRefreshAt >= 120_000) {
        lastUsageRefreshAt = now;
        queryClient.invalidateQueries({ queryKey: ['precisionUsage'] });
      }
      checkForUpdate();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshApp();
    };
    const onOnline = () => {
      setIsOnline(true);
      // A reconnect should recover a failed/offline check immediately, even
      // when the previous foreground event was within the throttle window.
      refreshApp();
      checkForUpdate(true);
    };
    const onOffline = () => setIsOnline(false);

    refreshApp();
    window.addEventListener('pageshow', refreshApp);
    window.addEventListener('focus', refreshApp);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibilityChange);
    // Open installed PWAs can stay foregrounded all day without a new
    // pageshow event. Poll releases only; do not refetch territory/account data.
    const interval = window.setInterval(() => checkForUpdate(), UPDATE_POLL_INTERVAL_MS);
    return () => {
      mounted = false;
      window.clearInterval(interval);
      window.removeEventListener('pageshow', refreshApp);
      window.removeEventListener('focus', refreshApp);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [queryClient]);

  if (!availableRelease) return null;

  // This notice has its own place in the app: routine knock/sync toasts must
  // not hide the only way for an already-open PWA to adopt a new release.
  return (
    <aside role="status" aria-live="polite" className="fixed inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] z-[25000] mx-auto flex max-w-lg items-center gap-3 rounded-xl border border-[#2EEB57]/40 bg-[#101510] px-4 py-3 text-white shadow-xl">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold">App update available</p>
        <p className="mt-1 text-xs text-gray-300">
          {isOnline ? 'Save any open notes, then refresh to get the latest version.' : 'Reconnect to refresh. Your current work can continue.'}
        </p>
      </div>
      <button type="button" disabled={!isOnline} onClick={() => refreshToPublishedRelease(availableRelease)} className="shrink-0 rounded-lg bg-[#2EEB57] px-3 py-2 text-sm font-bold text-black disabled:cursor-not-allowed disabled:opacity-50">
        Refresh app
      </button>
    </aside>
  );
}
