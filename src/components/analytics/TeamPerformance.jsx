import React, { useMemo } from 'react';
import { Badge } from "@/components/ui/badge";
import { Trophy, TrendingUp, Target } from 'lucide-react';

export default function TeamPerformance({ teamMembers, logs, routes }) {
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
            const completedRoutes = routes.filter(r => r.assigned_to === member.id && r.status === 'COMPLETED');
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
                completedRoutes: completedRoutes.length,
            };
        }).sort((a, b) => b.weeklyKnocks - a.weeklyKnocks);
    }, [teamMembers, logs, routes]);

    if (repStats.length === 0) {
        return (
            <div className="bg-[#151515] border border-gray-800 rounded-xl p-6 text-center">
                <p className="text-gray-500 text-sm">No team members yet</p>
            </div>
        );
    }

    return (
        <div className="bg-[#151515] border border-gray-800 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-gray-800 flex items-center justify-between">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <Trophy className="w-4 h-4 text-yellow-500" /> Team Leaderboard
                </h3>
                <span className="text-[10px] text-gray-500">This week</span>
            </div>

            <div className="divide-y divide-gray-800/50">
                {repStats.map((rep, idx) => (
                    <div key={rep.id} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-800/30 transition-colors">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                            idx === 0 ? 'bg-yellow-500 text-black' : idx === 1 ? 'bg-gray-300 text-black' : idx === 2 ? 'bg-orange-700 text-white' : 'bg-gray-800 text-gray-400'
                        }`}>
                            {idx + 1}
                        </div>

                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-bold text-white truncate">{rep.name}</p>
                            <div className="flex items-center gap-3 mt-0.5">
                                <span className="text-[10px] text-gray-500">{rep.todayKnocks} today</span>
                                <span className="text-[10px] text-gray-500">{rep.activeRoutes} routes</span>
                            </div>
                        </div>

                        <div className="text-right shrink-0">
                            <div className="flex items-center gap-2">
                                <div className="text-center">
                                    <p className="text-lg font-bold text-white">{rep.weeklyKnocks}</p>
                                    <p className="text-[9px] text-gray-600">KNOCKS</p>
                                </div>
                                <div className="text-center border-l border-gray-800 pl-2">
                                    <p className="text-lg font-bold text-green-500">{rep.weeklySales}</p>
                                    <p className="text-[9px] text-gray-600">SALES</p>
                                </div>
                                <div className="text-center border-l border-gray-800 pl-2">
                                    <p className="text-lg font-bold text-yellow-500">{rep.conversionRate}%</p>
                                    <p className="text-[9px] text-gray-600">CONV</p>
                                </div>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}