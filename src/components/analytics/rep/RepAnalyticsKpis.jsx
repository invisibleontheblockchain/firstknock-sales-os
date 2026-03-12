import React from 'react';
import { Calendar, DoorOpen, MapPin, PhoneCall, Target, TrendingUp } from 'lucide-react';

export default function RepAnalyticsKpis({ metrics, dateDays }) {
  const cards = [
    { label: 'Today Knocks', value: metrics.todayKnocks, sub: 'doors logged today', icon: DoorOpen, color: 'text-blue-400' },
    { label: `${dateDays} Day Knocks`, value: metrics.periodKnocks, sub: 'activity in range', icon: Calendar, color: 'text-white' },
    { label: 'Contact Rate', value: `${metrics.contactRate}%`, sub: `${metrics.contacts} contacts`, icon: PhoneCall, color: 'text-cyan-400' },
    { label: 'Conversion', value: `${metrics.conversionRate}%`, sub: `${metrics.sales} sold / qualified`, icon: TrendingUp, color: 'text-green-400' },
    { label: 'Coverage', value: `${metrics.coveragePct}%`, sub: `${metrics.workedDoors} worked doors`, icon: MapPin, color: 'text-purple-400' },
    { label: 'Upcoming', value: metrics.upcomingAppointments, sub: 'appointments ahead', icon: Target, color: 'text-yellow-400' },
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