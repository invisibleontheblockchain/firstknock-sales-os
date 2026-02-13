import React, { useMemo } from 'react';
import { Trophy } from 'lucide-react';
import { useTheme } from '@/components/theme/ThemeProvider';

const MEDAL_STYLES = [
    'bg-yellow-500 text-black',
    'bg-gray-400 text-black',
    'bg-orange-700 text-white',
];

export default function TeamPerformance({ teamMembers, logs, routes }) {
    const { accent } = useTheme();

    const repStats = useMemo(() => {
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const weekAgo = new Date(today.getTime() - 7 * 86400000);

        return teamMembers.map(member => {
            const memberLogs = logs.filter(l => l.created_by === member.email);
            const weekLogs = memberLogs.filter(l => new Date(l.created_date) >= weekAgo);
            const todayLogs = memberLogs.filter(l => new Date(l.created_date) >= today);
            const sales = memberLogs.filter(l => ['SOLD', 'QUALIFIED'].includes(l.parsed_status));
            const weeklySales = weekLogs.filter(l => ['SOLD', 'QUALIFIED'].includes(l.parsed_status));
            const activeRoutes = routes.filter(r => r.assigned_to === member.id && (r.status === 'ACTIVE' || r.status === 'IN_PROGRESS'));
            const convRate = memberLogs.length > 0 ? ((sales.length / memberLogs.length) * 100).toFixed(1) : '0';

            return {
                ...member,
                totalKnocks: memberLogs.length,
                weeklyKnocks: weekLogs.length,
                todayKnocks: todayLogs.length,
                totalSales: sales.length,
                weeklySales: weeklySales.length,
                conversionRate: parseFloat(convRate),
                activeRoutes: activeRoutes.length,
            };
        }).sort((a, b) => b.weeklyKnocks - a.weeklyKnocks);
    }, [teamMembers, logs, routes]);

    if (repStats.length === 0) {
        return (
            <div className="bg-[#111] border border-gray-800/60 rounded-2xl p-8 text-center">
                <Trophy className="w-8 h-8 text-gray-700 mx-auto mb-3" />
                <p className="text-gray-500 text-sm">No team members yet</p>
                <p className="text-[10px] text-gray-600 mt-1">Invite reps to see their stats here</p>
            </div>
        );
    }

    const maxKnocks = repStats.length > 0 ? repStats[0].weeklyKnocks : 1;

    return (
        <div className="bg-[#111] border border-gray-800/60 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-800/50 flex items-center justify-between">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <Trophy className="w-4 h-4" style={{ color: accent }} />
                    Team Leaderboard
                </h3>
                <span className="text-[10px] text-gray-500 bg-gray-800/50 px-2 py-0.5 rounded-full">This week</span>
            </div>

            <div className="divide-y divide-gray-800/30">
                {repStats.map((rep, idx) => (
                    <div key={rep.id} className="px-5 py-3.5 hover:bg-white/[0.02] transition-colors">
                        <div className="flex items-center gap-3">
                            {/* Rank */}
                            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-extrabold shrink-0 ${
                                MEDAL_STYLES[idx] || 'bg-gray-800/80 text-gray-500'
                            }`}>
                                {idx + 1}
                            </div>

                            {/* Name + meta */}
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-bold text-white truncate">{rep.name}</p>
                                <div className="flex items-center gap-2 mt-0.5 text-[10px] text-gray-500">
                                    <span>{rep.todayKnocks} today</span>
                                    <span className="text-gray-700">·</span>
                                    <span>{rep.activeRoutes} route{rep.activeRoutes !== 1 ? 's' : ''}</span>
                                </div>
                            </div>

                            {/* Stats pills */}
                            <div className="flex items-center gap-1.5 shrink-0">
                                <div className="text-center bg-white/[0.04] rounded-lg px-2.5 py-1.5">
                                    <p className="text-sm font-extrabold text-white leading-none">{rep.weeklyKnocks}</p>
                                    <p className="text-[8px] text-gray-600 uppercase mt-0.5">Knocks</p>
                                </div>
                                <div className="text-center bg-green-500/[0.06] rounded-lg px-2.5 py-1.5">
                                    <p className="text-sm font-extrabold text-green-400 leading-none">{rep.weeklySales}</p>
                                    <p className="text-[8px] text-gray-600 uppercase mt-0.5">Sales</p>
                                </div>
                                <div className="text-center bg-yellow-500/[0.06] rounded-lg px-2.5 py-1.5">
                                    <p className="text-sm font-extrabold leading-none" style={{ color: accent }}>{rep.conversionRate}%</p>
                                    <p className="text-[8px] text-gray-600 uppercase mt-0.5">Conv</p>
                                </div>
                            </div>
                        </div>

                        {/* Activity bar */}
                        {maxKnocks > 0 && (
                            <div className="mt-2 ml-10 h-1 bg-gray-800/50 rounded-full overflow-hidden">
                                <div className="h-full rounded-full transition-all duration-500" style={{ width: `${(rep.weeklyKnocks / maxKnocks) * 100}%`, background: accent }} />
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}