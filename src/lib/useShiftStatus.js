import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';

// The signed-in account's verified time-clock shift. Mileage and location sharing
// both run only while it is active; the time clock invalidates ['timeClock'] on
// every clock-in and clock-out, so both start and stop at once.
export function useShiftStatus(user, enabled) {
    return useQuery({
        queryKey: ['timeClock', 'autoDriving', user?.id, 'status'],
        enabled: !!enabled,
        queryFn: async () => {
            const response = await base44.functions.invoke('autoDriving', { action: 'status' });
            if (!response.data?.success || typeof response.data.manager_id !== 'string') throw new Error('Your work shift could not be verified.');
            return response.data;
        },
        refetchInterval: query => query.state.data?.eligible === true && !query.state.error ? 30000 : false,
        refetchIntervalInBackground: false, refetchOnWindowFocus: true, refetchOnReconnect: true, retry: false,
    });
}

export function activeShiftFor(status, user) {
    const shift = status.data?.current_shift;
    return !status.isError && shift?.status === 'active' && shift.rep_user_id === user?.id ? shift : null;
}
