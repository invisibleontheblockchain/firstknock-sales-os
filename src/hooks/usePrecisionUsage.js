// @ts-check

import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { normalizePrecisionUsageResponse } from '@/lib/precisionUsage';
import { withReadDeadline } from '@/lib/readRequest';

export function precisionUsageQueryKey(userId) {
  return ['precisionUsage', userId || null];
}

export function usePrecisionUsage(user) {
  return useQuery({
    queryKey: precisionUsageQueryKey(user?.id),
    queryFn: async () => normalizePrecisionUsageResponse(
      await withReadDeadline(() => base44.functions.invoke('getPrecisionUsage', {}))
    ),
    enabled: !!user?.id,
    // This is a presentation meter. Purchases and pulls explicitly refresh it;
    // their server-side access checks remain authoritative for every action.
    staleTime: 2 * 60_000,
    retry: (failureCount, error) => {
      const failure = /** @type {Error & {status?: number, response?: {status?: number}}} */ (error);
      return failureCount < 1 && Number(failure?.status || failure?.response?.status) !== 429;
    },
    refetchOnMount: true,
    refetchOnWindowFocus: false
  });
}
