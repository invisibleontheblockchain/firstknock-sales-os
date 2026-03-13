import React, { useMemo } from 'react';
import { Activity, Phone, Route, TrendingUp, Users, DollarSign } from 'lucide-react';
import { subDays } from 'date-fns';

const SALES = ['SOLD', 'QUALIFIED'];
const NON_CONTACT = ['NO_ANSWER', 'ELIGIBLE'];

export default function TeamAnalyticsSummary({ members, logs, routes }) {
  const stats = useMemo(() => {
    const cutoff = subDays(new Date(), 7);
    const recentLogs = logs.filter((log) => new Date(log.created_date) >= cutoff);
    const sales = recentLogs.filter((log) => SALES.includes(log.parsed_status)).length;
    const contacts = recentLogs.filter((log) => !NON_CONTACT.includes(log.parsed_status)).length;
    const callbacks = recentLogs.filter((log) => log.parsed_status === 'CALLBACK').length;
    const activeReps = new Set(recentLogs.map((log) => log.created_by).filter(Boolean)).size;
    const activeRoutes = routes.filter((route) => ['ACTIVE', 'IN_PROGRESS'].includes(route.status)).length;
    const totalRevenue = logs.reduce((sum, log) => sum + (log.sale_amount || 0), 0);
    return {
      reps: members.length,
      activeReps,
      knocks: recentLogs.length,
      contactRate: recentLogs.length ? Math.round((contacts / recentLogs.length) * 100) : 0,
      conversion: recentLogs.length ? Math.round((sales / recentLogs.length) * 100) : 0,
      callbacks,
      activeRoutes,
      totalRevenue,
    };
  }, [members, logs, routes]);

  const revenueDisplay = stats.totalRevenue >= 1000 ? `$${(stats.totalRevenue / 1000).toFixed(1)}k` : `$${stats.totalRevenue}`;

  const cards = [
    { label: 'Team Size', value: stats.reps, sub: 'active roster', icon: Users, color: 'text-white' },
    { label: 'Active Reps', value: stats.activeReps, sub: 'worked in last 7d', icon: Activity, color: 'text-cyan-400' },
    { label: '7D Knocks', value: stats.knocks, sub: 'team activity', icon: TrendingUp, color: 'text-yellow-400' },
    { label: 'Revenue', value: revenueDisplay, sub: 'total generated', icon: DollarSign, color: 'text-green-400' },
    { label: 'Contact Rate', value: `${stats.contactRate}%`, sub: 'team average', icon: Phone, color: 'text-orange-400' },
    { label: 'Active Routes', value: stats.activeRoutes, sub: `${stats.conversion}% conversion`, icon: Route, color: 'text-purple-400' },
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