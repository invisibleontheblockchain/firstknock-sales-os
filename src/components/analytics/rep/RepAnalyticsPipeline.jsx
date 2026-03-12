import React from 'react';

export default function RepAnalyticsPipeline({ metrics }) {
  const items = [
    { label: 'Knocks', value: metrics.periodKnocks, note: 'total attempts', color: 'bg-white' },
    { label: 'Contacts', value: metrics.contacts, note: `${metrics.contactRate}% contact rate`, color: 'bg-cyan-400' },
    { label: 'Callbacks', value: metrics.callbacks, note: 'follow-up opportunities', color: 'bg-yellow-400' },
    { label: 'Appointments', value: metrics.upcomingAppointments, note: 'future meetings set', color: 'bg-blue-400' },
    { label: 'Wins', value: metrics.sales, note: 'sold or qualified', color: 'bg-green-400' },
  ];
  const maxValue = Math.max(...items.map((item) => item.value), 1);

  return (
    <div className="rounded-2xl border border-white/5 bg-gradient-to-b from-[#151515] to-[#0A0A0A] p-5 shadow-2xl">
      <div className="mb-4">
        <h3 className="text-lg font-black text-white tracking-tight">Rep Funnel</h3>
        <p className="text-sm text-gray-500">How your activity is turning into real opportunities</p>
      </div>

      <div className="space-y-4">
        {items.map((item) => (
          <div key={item.label}>
            <div className="flex items-end justify-between mb-2">
              <div>
                <div className="text-sm font-bold text-white">{item.label}</div>
                <div className="text-xs text-gray-500">{item.note}</div>
              </div>
              <div className="text-2xl font-black text-white">{item.value}</div>
            </div>
            <div className="h-2.5 rounded-full bg-white/5 overflow-hidden border border-white/5">
              <div className={`h-full ${item.color} rounded-full`} style={{ width: `${(item.value / maxValue) * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}