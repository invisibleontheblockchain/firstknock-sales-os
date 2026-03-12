import React, { useMemo } from 'react';
import { Activity, Phone, Route, TrendingUp, Users, Clock3 } from 'lucide-react';
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
    return {
      reps: members.length,
      activeReps,
      knocks: recentLogs.length,
      contactRate: recentLogs.length ? Math.round((contacts / recentLogs.length) * 100) : 0,
      conversion: recentLogs.length ? Math.round((sales / recentLogs.length) * 100) : 0,
      callbacks,
      activeRoutes,
    };
  }, [members, logs, routes]);

  const cards = [
    { label: 'Team Size', value: stats.reps, sub: 'active roster', icon: Users, color: 'text-white' },
    { label: 'Active Reps', value: stats.activeReps, sub: 'worked in last 7d', icon: Activity, color: 'text-cyan-400' },
    { label: '7D Knocks', value: stats.knocks, sub: 'team activity', icon: TrendingUp, color: 'text-yellow-400' },
    { label: 'Contact Rate', value: `${stats.contactRate}%`, sub: 'based on team logs', icon: Phone, color: 'text-green-400' },
    { label: 'Open Callbacks', value: stats.callbacks, sub: 'follow-ups waiting', icon: Clock3, color: 'text-orange-400' },
    { label: 'Active Routes', value: stats.activeRoutes, sub: `${stats.conversion}% conversion`, icon: Route, color: 'text-purple-400' },
  ];

  return (
    <div className="grid grid-cols-2 xl:grid-cols-6 gap-3">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <div key={card.label} className="rounded-2xl border border-white/5 bg-gradient-to-b from-[#16161D] to-[#0D0D12] p-4 shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-gray-500">{card.label}</span>
              <Icon className={`w-4 h-4 ${card.color}`} />
            </div>
            <div className="text-3xl font-black text-white tracking-tight">{card.value}</div>
            <p className="text-xs text-gray-500 mt-1">{card.sub}</p>
          </div>
        );
      })}
    </div>
  );
}