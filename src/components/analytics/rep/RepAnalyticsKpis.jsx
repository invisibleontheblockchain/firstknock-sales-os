import React from 'react';
import { DoorOpen, PhoneCall, TrendingUp, MapPin, Target, Calendar, DollarSign, Zap } from 'lucide-react';

export default function RepAnalyticsKpis({ metrics, dateDays }) {
  const revenue = metrics.totalRevenue || 0;
  const revenueDisplay = revenue >= 1000000
    ? `$${(revenue / 1000000).toFixed(1)}M`
    : revenue >= 1000
    ? `$${(revenue / 1000).toFixed(1)}k`
    : `$${revenue.toLocaleString()}`;

  const avgDealSize = metrics.sales > 0 ? Math.round(revenue / metrics.sales) : 0;
  const avgDealDisplay = avgDealSize >= 1000 ? `$${(avgDealSize / 1000).toFixed(1)}k` : `$${avgDealSize}`;

  const primaryCards = [
    { label: 'Revenue', value: revenueDisplay, sub: `${metrics.sales} closed deals`, icon: DollarSign, accent: '#22c55e', highlight: true },
    { label: 'Today', value: metrics.todayKnocks, sub: 'doors knocked', icon: DoorOpen, accent: '#3b82f6' },
    { label: `${dateDays}D Knocks`, value: metrics.periodKnocks.toLocaleString(), sub: 'total activity', icon: Calendar, accent: '#8b5cf6' },
  ];

  const secondaryCards = [
    { label: 'Contact Rate', value: `${metrics.contactRate}%`, sub: `${metrics.contacts} contacts`, icon: PhoneCall, accent: '#06b6d4' },
    { label: 'Conversion', value: `${metrics.conversionRate}%`, sub: `${metrics.sales} wins`, icon: TrendingUp, accent: '#f59e0b' },
    { label: 'Avg Deal', value: avgDealDisplay, sub: 'per closed sale', icon: Zap, accent: '#ec4899' },
    { label: 'Coverage', value: `${metrics.coveragePct}%`, sub: `${metrics.workedDoors} doors`, icon: MapPin, accent: '#a855f7' },
    { label: 'Appointments', value: metrics.upcomingAppointments, sub: 'upcoming', icon: Target, accent: '#ef4444' },
  ];

  return (
    <div className="space-y-2 md:space-y-3">
      {/* Primary row — revenue hero + today + period */}
      <div className="grid grid-cols-3 gap-2 md:gap-3">
        {primaryCards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.label}
              className={`group relative rounded-2xl border bg-[#111113] overflow-hidden transition-all duration-300 ${
                card.highlight
                  ? 'border-green-500/20 p-3 md:p-5'
                  : 'border-white/[0.06] p-2.5 md:p-4 hover:border-white/10'
              }`}
            >
              {card.highlight && (
                <div className="absolute inset-0 bg-gradient-to-br from-green-500/[0.06] to-transparent pointer-events-none" />
              )}
              <div
                className="absolute -top-12 -right-12 w-24 h-24 rounded-full blur-[40px] opacity-0 group-hover:opacity-20 transition-opacity duration-500 pointer-events-none"
                style={{ background: card.accent }}
              />
              <div className="relative z-10">
                <div className="flex items-center justify-between mb-1.5 md:mb-3">
                  <span className="text-[9px] md:text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-500 truncate">
                    {card.label}
                  </span>
                  <div
                    className="w-6 h-6 md:w-8 md:h-8 rounded-lg flex items-center justify-center shrink-0"
                    style={{ background: `${card.accent}15` }}
                  >
                    <Icon className="w-3 h-3 md:w-4 md:h-4" style={{ color: card.accent }} />
                  </div>
                </div>
                <div className={`font-black text-white tracking-tight leading-none ${
                  card.highlight ? 'text-xl md:text-4xl' : 'text-lg md:text-3xl'
                }`}>
                  {card.value}
                </div>
                <p className="text-[9px] md:text-xs text-gray-500 mt-1 md:mt-2 font-medium truncate">{card.sub}</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Secondary row — rates & metrics */}
      <div className="grid grid-cols-3 md:grid-cols-5 gap-2 md:gap-3">
        {secondaryCards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.label}
              className="group relative rounded-xl md:rounded-2xl border border-white/[0.06] bg-[#111113] p-2.5 md:p-4 hover:border-white/10 transition-all duration-300 overflow-hidden"
            >
              <div
                className="absolute -top-10 -right-10 w-20 h-20 rounded-full blur-[30px] opacity-0 group-hover:opacity-20 transition-opacity duration-500 pointer-events-none"
                style={{ background: card.accent }}
              />
              <div className="relative z-10">
                <div className="flex items-center justify-between mb-1 md:mb-2">
                  <span className="text-[8px] md:text-[10px] font-semibold uppercase tracking-[0.1em] text-gray-500 truncate">
                    {card.label}
                  </span>
                  <div
                    className="w-5 h-5 md:w-6 md:h-6 rounded-md flex items-center justify-center shrink-0"
                    style={{ background: `${card.accent}15` }}
                  >
                    <Icon className="w-2.5 h-2.5 md:w-3 md:h-3" style={{ color: card.accent }} />
                  </div>
                </div>
                <div className="text-base md:text-2xl font-black text-white tracking-tight leading-none">{card.value}</div>
                <p className="text-[8px] md:text-[10px] text-gray-500 mt-0.5 md:mt-1 font-medium truncate">{card.sub}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}