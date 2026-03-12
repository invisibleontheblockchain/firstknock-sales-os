import React from 'react';
import { Clock3, Phone, Route, Calendar } from 'lucide-react';

export default function RepAnalyticsFocus({ metrics }) {
  const items = [
    { label: 'Best Hour', value: metrics.bestHourLabel, sub: `${metrics.bestHourRate}% contact rate`, icon: Clock3, accent: '#f59e0b' },
    { label: 'Open Callbacks', value: metrics.callbacks, sub: 'people to revisit', icon: Phone, accent: '#06b6d4' },
    { label: 'Active Routes', value: metrics.activeRoutes, sub: `${metrics.totalRoutes} total`, icon: Route, accent: '#22c55e' },
    { label: 'No-Show Rate', value: `${metrics.noShowRate}%`, sub: `${metrics.upcomingAppointments} upcoming`, icon: Calendar, accent: '#ef4444' },
  ];

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-[#111113] p-5">
      <h3 className="text-base font-black text-white tracking-tight mb-1">Focus Signals</h3>
      <p className="text-xs text-gray-500 mb-5">What to prioritize next</p>

      <div className="grid grid-cols-2 gap-3">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.label} className="rounded-xl bg-white/[0.02] border border-white/[0.04] p-3.5 hover:bg-white/[0.04] transition-colors">
              <div className="flex items-center justify-between mb-2.5">
                <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-gray-500">{item.label}</span>
                <div className="w-6 h-6 rounded-md flex items-center justify-center" style={{ background: `${item.accent}15` }}>
                  <Icon className="w-3 h-3" style={{ color: item.accent }} />
                </div>
              </div>
              <div className="text-xl font-black text-white leading-none">{item.value}</div>
              <p className="text-[10px] text-gray-500 mt-1.5">{item.sub}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}