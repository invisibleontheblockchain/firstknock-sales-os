import React from 'react';
import { useQueryClient } from '@tanstack/react-query';

export default function AppRefreshManager() {
  const queryClient = useQueryClient();

  React.useEffect(() => {
    const refreshEntitlement = () => {
      queryClient.invalidateQueries({ queryKey: ['user'] });
      queryClient.invalidateQueries({ queryKey: ['precisionUsage'] });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshEntitlement();
    };

    refreshEntitlement();
    window.addEventListener('pageshow', refreshEntitlement);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pageshow', refreshEntitlement);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [queryClient]);

  return null;
}