import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { getManagerIdForAccount, isManagerAccount, isRepAccount } from '@/lib/roles';
import { leaderboardDayKey } from '../../base44/shared/teamLeaderboard.js';

export function useTeamLeaderboard(user, period = 'today') {
    const managerId = getManagerIdForAccount(user);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    return useQuery({
        queryKey: ['teamLeaderboard', managerId, user?.id, period, timeZone, leaderboardDayKey(new Date(), timeZone)],
        queryFn: async () => {
            const response = await base44.functions.invoke('getTeamLeaderboard', { period, time_zone: timeZone });
            if (!response.data?.success || response.data.manager_id !== managerId) throw new Error('Unable to verify team leaderboard.');
            return response.data.rows;
        },
        enabled: !!managerId && (isManagerAccount(user) || isRepAccount(user)),
        staleTime: 30000,
        refetchOnMount: 'always',
        refetchInterval: 60000,
    });
}

