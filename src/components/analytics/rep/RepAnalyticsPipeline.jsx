import React from 'react';
import { Clock3, Phone, Route, Calendar } from 'lucide-react';

const FUNNEL_COLORS = ['#ffffff', '#06b6d4', '#f59e0b', '#3b82f6', '#22c55e'];

export default function RepAnalyticsPipeline({ metrics }) {
  const funnel = [
    { label: 'Knocks', value: metrics.periodKnocks, note: 'total attempts' },
    { label: 'Contacts', value: metrics.contacts, note: `${metrics.contactRate}% rate` },
    { label: 'Callbacks', value: metrics.callbacks, note: 'follow-ups' },
    { label: 'Appointments', value: metrics.upcomingAppointments, note: 'meetings' },
    { label: 'Wins', value: metrics.sales, note: 'closed' },
  ];
  const maxValue = Math.max(...funnel.map((i) => i.value), 1);

  const signals = [
    { label: 'Best Hour', value: metrics.bestHourLabel, sub: `${metrics.bestHourRate}% contact`, icon: Clock3, color: '#f59e0b' },
    { label: 'Callbacks', value: metrics.callbacks, sub: 'to revisit', icon: Phone, color: '#06b6d4' },
    { label: 'Routes', value: `${metrics.activeRoutes}/${metrics.totalRoutes}`, sub: 'active', icon: Route, color: '#22c55e' },
    { label: 'No-Show', value: `${metrics.noShowRate}%`, sub: `${metrics.upcomingAppointments} appts`, icon: Calendar, color: '#ef4444' },
  ];

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1.1fr,0.9fr] gap-2 md:gap-3">
      {/* Funnel */}
      <div className="rounded-xl border border-white/[0.06] bg-[#111113] p-3 md:p-4">
        <h3 className="text-xs md:text-sm font-black text-white mb-0.5">Sales Funnel</h3>
        <p className="text-[9px] md:text-[10px] text-gray-500 mb-3">Activity → Wins</p>
        <div className="space-y-2.5">
          {funnel.map((item, idx) => {
            const pct = (item.value / maxValue) * 100;
            return (
              <div key={item.label}>
                <div className="flex items-baseline justify-between mb-1">
                  <span className="text-[10px] md:text-xs font-semibold text-gray-400">{item.label}</span>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-sm md:text-lg font-black text-white">{item.value.toLocaleString()}</span>
                    <span className="text-[8px] md:text-[9px] text-gray-600">{item.note}</span>
                  </div>
                </div>
                <div className="h-2 rounded-full bg-white/[0.04] overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-700" style={{ width: `${Math.max(pct, 2)}%`, background: `linear-gradient(90deg, ${FUNNEL_COLORS[idx]}50, ${FUNNEL_COLORS[idx]})` }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Signals */}
      <div className="rounded-xl border border-white/[0.06] bg-[#111113] p-3 md:p-4">
        <h3 className="text-xs md:text-sm font-black text-white mb-0.5">Focus Signals</h3>
        <p className="text-[9px] md:text-[10px] text-gray-500 mb-3">What to prioritize</p>
        <div className="grid grid-cols-2 gap-1.5 md:gap-2">
          {signals.map((s) => {
            const Icon = s.icon;
            return (
              <div key={s.label} className="rounded-lg bg-white/[0.02] border border-white/[0.04] p-2.5 md:p-3 hover:bg-white/[0.04] transition-colors">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[8px] md:text-[9px] font-bold uppercase tracking-[0.1em] text-gray-500">{s.label}</span>
                  <div className="w-5 h-5 rounded-md flex items-center justify-center" style={{ background: `${s.color}15` }}>
                    <Icon className="w-2.5 h-2.5" style={{ color: s.color }} />
                  </div>
                </div>
                <div className="text-base md:text-xl font-black text-white leading-none">{s.value}</div>
                <p className="text-[8px] md:text-[9px] text-gray-500 mt-0.5">{s.sub}</p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}