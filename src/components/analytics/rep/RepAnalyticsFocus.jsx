import React from 'react';
import { Calendar, Clock3, Map, Phone, Route } from 'lucide-react';

export default function RepAnalyticsFocus({ metrics }) {
  const items = [
    { label: 'Best Hour', value: metrics.bestHourLabel, sub: `${metrics.bestHourRate}% contact rate`, icon: Clock3, color: 'text-yellow-400' },
    { label: 'Open Callbacks', value: metrics.callbacks, sub: 'people to revisit', icon: PhoneForwarded, color: 'text-cyan-400' },
    { label: 'Active Routes', value: metrics.activeRoutes, sub: `${metrics.totalRoutes} total assigned`, icon: Route, color: 'text-green-400' },
    { label: 'No-Show Rate', value: `${metrics.noShowRate}%`, sub: `${metrics.upcomingAppointments} upcoming appts`, icon: CalendarClock, color: 'text-red-400' },
  ];

  return (
    <div className="rounded-2xl border border-white/5 bg-gradient-to-b from-[#151515] to-[#0A0A0A] p-5 shadow-2xl">
      <div className="flex items-center gap-2 mb-4">
        <Map className="w-4 h-4 text-purple-400" />
        <div>
          <h3 className="text-lg font-black text-white tracking-tight">Focus Signals</h3>
          <p className="text-sm text-gray-500">What to prioritize on your next block</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.label} className="rounded-2xl border border-white/5 bg-black/20 p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-gray-500">{item.label}</span>
                <Icon className={`w-4 h-4 ${item.color}`} />
              </div>
              <div className="text-2xl font-black text-white">{item.value}</div>
              <p className="text-xs text-gray-500 mt-1">{item.sub}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}