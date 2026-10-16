import React, { useMemo } from 'react';
import { Activity, Phone, Route, TrendingUp, Users, DollarSign } from 'lucide-react';
import { getActiveTeamSize } from '@/lib/teamRoster';

export default function TeamAnalyticsSummary({ members, allTime, recent, routes }) {
  const stats = useMemo(() => {
    const totals = recent?.totals;
    const activeReps = recent?.rows?.filter((row) => row.metrics.knocks > 0).length;
    const activeRoutes = routes.filter((route) => ['ACTIVE', 'IN_PROGRESS'].includes(route.status)).length;
    return {
      teamSize: getActiveTeamSize(members),
      activeReps,
      knocks: totals?.knocks,
      contactRate: totals ? Math.round(totals.contactRate || 0) : undefined,
      conversion: totals ? Math.round(totals.conversion || 0) : undefined,
      activeRoutes,
      totalRevenue: allTime?.totals?.revenue,
    };
  }, [members, allTime, recent, routes]);

  const revenueDisplay = stats.totalRevenue === undefined ? '—' : stats.totalRevenue >= 1000
    ? `$${(stats.totalRevenue / 1000).toFixed(1)}k` : `$${stats.totalRevenue}`;

  const cards = [
    { label: 'Team Size', value: stats.teamSize, sub: 'manager + reps', icon: Users, color: 'text-white' },
    { label: 'Active Reps', value: stats.activeReps ?? '—', sub: 'worked in last 7d', icon: Activity, color: 'text-cyan-400' },
    { label: '7D Knocks', value: stats.knocks ?? '—', sub: 'last 7 calendar days', icon: TrendingUp, color: 'text-yellow-400' },
    { label: 'Revenue', value: revenueDisplay, sub: 'all-time sales', icon: DollarSign, color: 'text-green-400' },
    { label: '7D Contact Rate', value: stats.contactRate === undefined ? '—' : `${stats.contactRate}%`, sub: 'last 7 calendar days', icon: Phone, color: 'text-orange-400' },
    { label: 'Active Routes', value: stats.activeRoutes, sub: stats.conversion === undefined ? 'activity loading' : `${stats.conversion}% 7d conversion`, icon: Route, color: 'text-purple-400' },
  ];

  return (
    <div className="grid grid-cols-3 xl:grid-cols-6 gap-2 md:gap-3">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <div key={card.label} className="rounded-xl md:rounded-2xl border border-white/5 bg-gradient-to-b from-[#16161D] to-[#0D0D12] p-2.5 md:p-4 shadow-xl">
            <div className="flex items-center justify-between mb-1.5 md:mb-3">
              <span className="text-[8px] md:text-[10px] font-bold uppercase tracking-[0.1em] text-gray-500 truncate">{card.label}</span>
              <Icon className={`w-3 h-3 md:w-4 md:h-4 shrink-0 ${card.color}`} />
            </div>
            <div className="text-lg md:text-3xl font-black text-white tracking-tight">{card.value}</div>
            <p className="text-[9px] md:text-xs text-gray-500 mt-0.5 md:mt-1 truncate">{card.sub}</p>
          </div>
        );
      })}
    </div>
  );
}
