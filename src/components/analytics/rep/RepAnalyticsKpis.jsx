import React from 'react';
import { DoorOpen, PhoneCall, TrendingUp, MapPin, Target, Calendar } from 'lucide-react';

export default function RepAnalyticsKpis({ metrics, dateDays }) {
  const cards = [
    { label: 'Today', value: metrics.todayKnocks, sub: 'doors knocked', icon: DoorOpen, accent: '#3b82f6' },
    { label: `${dateDays}D Knocks`, value: metrics.periodKnocks, sub: 'total activity', icon: Calendar, accent: '#8b5cf6' },
    { label: 'Contact Rate', value: `${metrics.contactRate}%`, sub: `${metrics.contacts} contacts`, icon: PhoneCall, accent: '#06b6d4' },
    { label: 'Conversion', value: `${metrics.conversionRate}%`, sub: `${metrics.sales} wins`, icon: TrendingUp, accent: '#22c55e' },
    { label: 'Coverage', value: `${metrics.coveragePct}%`, sub: `${metrics.workedDoors} doors`, icon: MapPin, accent: '#a855f7' },
    { label: 'Upcoming', value: metrics.upcomingAppointments, sub: 'appointments', icon: Target, accent: '#f59e0b' },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <div
            key={card.label}
            className="group relative rounded-2xl border border-white/[0.06] bg-[#111113] p-4 hover:border-white/10 transition-all duration-300 overflow-hidden"
          >
            {/* Subtle glow on hover */}
            <div
              className="absolute -top-12 -right-12 w-24 h-24 rounded-full blur-[40px] opacity-0 group-hover:opacity-20 transition-opacity duration-500 pointer-events-none"
              style={{ background: card.accent }}
            />
            <div className="relative z-10">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-gray-500">{card.label}</span>
                <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: `${card.accent}15` }}>
                  <Icon className="w-3.5 h-3.5" style={{ color: card.accent }} />
                </div>
              </div>
              <div className="text-2xl md:text-3xl font-black text-white tracking-tight leading-none">{card.value}</div>
              <p className="text-[11px] text-gray-500 mt-1.5 font-medium">{card.sub}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}