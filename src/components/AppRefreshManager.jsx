import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { checkForPublishedRelease } from '@/lib/pwaRelease';

export default function AppRefreshManager() {
  const queryClient = useQueryClient();

  React.useEffect(() => {
    const refreshApp = () => {
      queryClient.invalidateQueries({ queryKey: ['user'] });
      queryClient.invalidateQueries({ queryKey: ['precisionUsage'] });
      checkForPublishedRelease(window.__FK_PWA_RELEASE__);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshApp();
    };

    refreshApp();
    window.addEventListener('pageshow', refreshApp);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pageshow', refreshApp);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [queryClient]);

  return null;
}