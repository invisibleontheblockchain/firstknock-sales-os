// @ts-check

import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { normalizePrecisionUsageResponse } from '@/lib/precisionUsage';

export function precisionUsageQueryKey(userId) {
  return ['precisionUsage', userId || null];
}

export function usePrecisionUsage(user) {
  return useQuery({
    queryKey: precisionUsageQueryKey(user?.id),
    queryFn: async () => normalizePrecisionUsageResponse(
      await base44.functions.invoke('getPrecisionUsage', {})
    ),
    enabled: !!user?.id,
    staleTime: 10_000,
    retry: 1,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always'
  });
}
