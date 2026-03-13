import React from 'react';

const FUNNEL_COLORS = ['#ffffff', '#06b6d4', '#f59e0b', '#3b82f6', '#22c55e'];

export default function RepAnalyticsPipeline({ metrics }) {
  const items = [
    { label: 'Knocks', value: metrics.periodKnocks, note: 'total attempts' },
    { label: 'Contacts', value: metrics.contacts, note: `${metrics.contactRate}% rate` },
    { label: 'Callbacks', value: metrics.callbacks, note: 'follow-ups' },
    { label: 'Appointments', value: metrics.upcomingAppointments, note: 'meetings set' },
    { label: 'Wins', value: metrics.sales, note: 'sold / qualified' },
  ];
  const maxValue = Math.max(...items.map((i) => i.value), 1);

  return (
    <div className="rounded-xl md:rounded-2xl border border-white/[0.06] bg-[#111113] p-3 md:p-5">
      <h3 className="text-sm md:text-base font-black text-white tracking-tight mb-0.5 md:mb-1">Sales Funnel</h3>
      <p className="text-[10px] md:text-xs text-gray-500 mb-3 md:mb-5">Activity → Opportunities → Wins</p>

      <div className="space-y-3 md:space-y-4">
        {items.map((item, idx) => {
          const pct = (item.value / maxValue) * 100;
          const color = FUNNEL_COLORS[idx];
          return (
            <div key={item.label}>
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="text-xs md:text-sm font-semibold text-gray-300">{item.label}</span>
                <div className="flex items-baseline gap-1.5 md:gap-2">
                  <span className="text-base md:text-xl font-black text-white">{item.value.toLocaleString()}</span>
                  <span className="text-[9px] md:text-[10px] text-gray-500">{item.note}</span>
                </div>
              </div>
              <div className="h-2.5 md:h-3 rounded-full bg-white/[0.04] overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-700 ease-out"
                  style={{ width: `${Math.max(pct, 2)}%`, background: `linear-gradient(90deg, ${color}60, ${color})` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}