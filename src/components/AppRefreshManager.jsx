import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { checkForPublishedRelease, refreshToPublishedRelease } from '@/lib/pwaRelease';

export default function AppRefreshManager() {
  const queryClient = useQueryClient();

  React.useEffect(() => {
    let mounted = true;
    let announcedRelease = null;
    let lastDataRefreshAt = 0;
    const refreshApp = () => {
      const now = Date.now();
      // pageshow and visibilitychange can arrive together when returning from
      // Maps. Avoid starting the same account reads again for each event.
      if (!lastDataRefreshAt || now - lastDataRefreshAt >= 30_000) {
        lastDataRefreshAt = now;
        queryClient.invalidateQueries({ queryKey: ['user'] });
        queryClient.invalidateQueries({ queryKey: ['precisionUsage'] });
      }
      Promise.resolve(checkForPublishedRelease(window.__FK_PWA_RELEASE__)).then((release) => {
        if (!mounted || !release || release === announcedRelease) return;
        announcedRelease = release;
        toast('App update available', {
          id: 'firstknock-app-update',
          description: 'Refresh when you are ready to load the latest version.',
          duration: Infinity,
          action: { label: 'Refresh', onClick: () => refreshToPublishedRelease(release) },
        });
      });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshApp();
    };

    refreshApp();
    window.addEventListener('pageshow', refreshApp);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      mounted = false;
      window.removeEventListener('pageshow', refreshApp);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [queryClient]);

  return null;
}
