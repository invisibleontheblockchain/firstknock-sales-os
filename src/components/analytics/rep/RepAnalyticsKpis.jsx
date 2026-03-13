import React, { useState, useEffect } from 'react';
import { DoorOpen, PhoneCall, TrendingUp, MapPin, Target, Calendar, DollarSign, Zap, Percent } from 'lucide-react';
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";

export default function RepAnalyticsKpis({ metrics, dateDays }) {
  const [commissionPct, setCommissionPct] = useState(() => {
    const saved = localStorage.getItem('fk_commission_pct');
    return saved ? parseFloat(saved) : 10;
  });

  useEffect(() => {
    localStorage.setItem('fk_commission_pct', String(commissionPct));
  }, [commissionPct]);

  const revenue = metrics.totalRevenue || 0;
  const fmt = (v) => v >= 1000000 ? `$${(v / 1000000).toFixed(1)}M` : v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toLocaleString()}`;

  const avgDealSize = metrics.sales > 0 ? Math.round(revenue / metrics.sales) : 0;
  const myCommission = Math.round(revenue * (commissionPct / 100));

  const primaryCards = [
    { label: 'Revenue', value: fmt(revenue), sub: `${metrics.sales} closed deals`, icon: DollarSign, accent: '#22c55e', highlight: true },
    { label: 'My Cut', value: fmt(myCommission), sub: `${commissionPct}% commission`, icon: Percent, accent: '#a855f7', highlight: true },
    { label: `${dateDays}D Knocks`, value: metrics.periodKnocks.toLocaleString(), sub: 'total activity', icon: Calendar, accent: '#8b5cf6' },
  ];

  const secondaryCards = [
    { label: 'Today', value: metrics.todayKnocks, sub: 'doors knocked', icon: DoorOpen, accent: '#3b82f6' },
    { label: 'Contact Rate', value: `${metrics.contactRate}%`, sub: `${metrics.contacts} contacts`, icon: PhoneCall, accent: '#06b6d4' },
    { label: 'Conversion', value: `${metrics.conversionRate}%`, sub: `${metrics.sales} wins`, icon: TrendingUp, accent: '#f59e0b' },
    { label: 'Avg Deal', value: fmt(avgDealSize), sub: 'per closed sale', icon: Zap, accent: '#ec4899' },
    { label: 'Coverage', value: `${metrics.coveragePct}%`, sub: `${metrics.workedDoors} doors`, icon: MapPin, accent: '#a855f7' },
    { label: 'Appointments', value: metrics.upcomingAppointments, sub: 'upcoming', icon: Target, accent: '#ef4444' },
  ];

  return (
    <div className="space-y-2 md:space-y-3">
      {/* Primary row */}
      <div className="grid grid-cols-3 gap-2 md:gap-3">
        {primaryCards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.label}
              className={`group relative rounded-2xl border bg-[#111113] overflow-hidden transition-all duration-300 ${
                card.highlight
                  ? card.accent === '#a855f7' ? 'border-purple-500/20 p-3 md:p-5' : 'border-green-500/20 p-3 md:p-5'
                  : 'border-white/[0.06] p-2.5 md:p-4 hover:border-white/10'
              }`}
            >
              {card.highlight && (
                <div className="absolute inset-0 pointer-events-none" style={{ background: `linear-gradient(135deg, ${card.accent}10, transparent)` }} />
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

      {/* Commission Config */}
      <div className="rounded-xl md:rounded-2xl border border-purple-500/10 bg-[#111113] p-3 md:p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] md:text-xs font-bold text-gray-400">Commission Rate</span>
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              value={commissionPct}
              onChange={e => setCommissionPct(Math.min(100, Math.max(0, parseFloat(e.target.value) || 0)))}
              className="w-14 h-7 text-center text-xs bg-white/5 border-white/10 text-white px-1"
            />
            <span className="text-[10px] text-gray-500">%</span>
          </div>
        </div>
        <Slider
          value={[commissionPct]}
          onValueChange={([v]) => setCommissionPct(v)}
          min={1} max={50} step={0.5}
          className="w-full"
        />
        <div className="flex justify-between text-[8px] md:text-[9px] text-gray-600 mt-1">
          <span>1%</span>
          <span>25%</span>
          <span>50%</span>
        </div>
      </div>

      {/* Secondary row */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-2 md:gap-3">
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