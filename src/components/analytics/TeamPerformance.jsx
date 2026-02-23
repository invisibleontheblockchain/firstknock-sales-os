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
        <div className="bg-gradient-to-b from-[#151515] to-[#0A0A0A] border border-white/5 rounded-3xl overflow-hidden shadow-2xl relative">
            <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            <div className="px-6 py-5 border-b border-white/5 flex items-center justify-between relative z-10">
                <h3 className="text-lg font-black text-transparent bg-clip-text bg-gradient-to-r from-white to-gray-400 tracking-tight flex items-center gap-3">
                    <div className="p-2 rounded-xl" style={{ background: `${accent}20`, border: `1px solid ${accent}40` }}>
                        <Trophy className="w-5 h-5 drop-shadow-[0_0_10px_rgba(255,215,0,0.5)]" style={{ color: accent }} />
                    </div>
                    Team Leaderboard
                </h3>
                <span className="text-[11px] font-bold text-gray-400 uppercase tracking-widest bg-white/5 px-3 py-1.5 rounded-lg border border-white/5 shadow-inner">This week</span>
            </div>

            <div className="divide-y divide-white/[0.02]">
                {repStats.map((rep, idx) => (
                    <div key={rep.id} className="group relative px-6 py-4 hover:bg-white/[0.03] transition-all duration-300">
                        {idx === 0 && <div className="absolute inset-0 bg-gradient-to-r from-yellow-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />}
                        
                        <div className="flex items-center gap-4 relative z-10">
                            {/* Rank */}
                            <div className={`w-10 h-10 rounded-2xl flex items-center justify-center text-sm font-black shrink-0 transition-transform duration-300 group-hover:scale-110 shadow-lg ${
                                MEDAL_STYLES[idx] ? `${MEDAL_STYLES[idx]} border border-white/20 shadow-[0_0_15px_rgba(255,215,0,0.2)]` : 'bg-gray-800/80 text-gray-400 border border-gray-700/50'
                            }`}>
                                #{idx + 1}
                            </div>

                            {/* Name + meta */}
                            <div className="flex-1 min-w-0">
                                <p className="text-base font-bold text-white truncate drop-shadow-md">{rep.name}</p>
                                <div className="flex items-center gap-2 mt-1 text-[11px] font-medium text-gray-500">
                                    <span className="bg-white/5 px-2 py-0.5 rounded-md">{rep.todayKnocks} today</span>
                                    <span className="text-gray-700">·</span>
                                    <span className="bg-white/5 px-2 py-0.5 rounded-md">{rep.activeRoutes} route{rep.activeRoutes !== 1 ? 's' : ''}</span>
                                </div>
                            </div>

                            {/* Stats pills */}
                            <div className="flex items-center gap-2 shrink-0">
                                <div className="text-center bg-black/40 backdrop-blur-md border border-white/5 rounded-xl px-4 py-2 transition-colors group-hover:border-white/10">
                                    <p className="text-lg font-black text-white leading-none">{rep.weeklyKnocks}</p>
                                    <p className="text-[9px] font-bold text-gray-500 uppercase tracking-wider mt-1">Knocks</p>
                                </div>
                                <div className="text-center bg-green-500/10 backdrop-blur-md border border-green-500/20 rounded-xl px-4 py-2 transition-colors group-hover:bg-green-500/20">
                                    <p className="text-lg font-black text-green-400 leading-none drop-shadow-[0_0_8px_rgba(34,197,94,0.4)]">{rep.weeklySales}</p>
                                    <p className="text-[9px] font-bold text-green-600/80 uppercase tracking-wider mt-1">Sales</p>
                                </div>
                                <div className="text-center bg-yellow-500/10 backdrop-blur-md border border-yellow-500/20 rounded-xl px-4 py-2 transition-colors group-hover:bg-yellow-500/20">
                                    <p className="text-lg font-black leading-none drop-shadow-[0_0_8px_rgba(255,215,0,0.4)]" style={{ color: accent }}>{rep.conversionRate}%</p>
                                    <p className="text-[9px] font-bold text-yellow-600/80 uppercase tracking-wider mt-1">Conv</p>
                                </div>
                            </div>
                        </div>

                        {/* Activity bar */}
                        {maxKnocks > 0 && (
                            <div className="mt-3 ml-14 h-1.5 bg-black/60 rounded-full overflow-hidden shadow-inner border border-white/5 relative z-10">
                                <div 
                                    className="h-full rounded-full transition-all duration-1000 ease-out relative" 
                                    style={{ width: `${(rep.weeklyKnocks / maxKnocks) * 100}%`, background: `linear-gradient(90deg, ${accent}80, ${accent})` }} 
                                >
                                    <div className="absolute inset-0 bg-white/20 w-1/2 -skew-x-12 animate-[shimmer_2s_infinite]" />
                                </div>
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}