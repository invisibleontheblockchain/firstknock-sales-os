import React, { useState, useEffect } from 'react';
import { DollarSign, Percent, Calendar, DoorOpen, PhoneCall, TrendingUp, Zap, MapPin, Target, ChevronDown, ChevronUp } from 'lucide-react';
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";

export default function RepAnalyticsKpis({ metrics, dateDays }) {
  const [commissionPct, setCommissionPct] = useState(() => {
    const saved = localStorage.getItem('fk_commission_pct');
    return saved ? parseFloat(saved) : 10;
  });
  const [showCommission, setShowCommission] = useState(false);

  useEffect(() => {
    localStorage.setItem('fk_commission_pct', String(commissionPct));
  }, [commissionPct]);

  const revenue = metrics.totalRevenue || 0;
  const fmt = (v) => v >= 1000000 ? `$${(v / 1000000).toFixed(1)}M` : v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toLocaleString()}`;
  const avgDealSize = metrics.sales > 0 ? Math.round(revenue / metrics.sales) : 0;
  const myCommission = Math.round(revenue * (commissionPct / 100));
  const label = dateDays === 1 ? 'Today' : dateDays >= 99999 ? 'All Time' : `${dateDays}D`;

  const heroCards = [
    { label: 'Revenue', value: fmt(revenue), sub: `${metrics.sales} deals`, icon: DollarSign, color: '#22c55e' },
    { label: 'My Cut', value: fmt(myCommission), sub: `${commissionPct}%`, icon: Percent, color: '#a855f7' },
    { label: `${label} Knocks`, value: metrics.periodKnocks.toLocaleString(), sub: 'total', icon: Calendar, color: '#3b82f6' },
  ];

  const stats = [
    { label: 'Today', value: metrics.todayKnocks, icon: DoorOpen, color: '#6366f1' },
    { label: 'Contact', value: `${metrics.contactRate}%`, icon: PhoneCall, color: '#06b6d4' },
    { label: 'Conv.', value: `${metrics.conversionRate}%`, icon: TrendingUp, color: '#f59e0b' },
    { label: 'Avg Deal', value: fmt(avgDealSize), icon: Zap, color: '#ec4899' },
    { label: 'Coverage', value: `${metrics.coveragePct}%`, icon: MapPin, color: '#8b5cf6' },
    { label: 'Appts', value: metrics.upcomingAppointments, icon: Target, color: '#ef4444' },
  ];

  return (
    <div className="space-y-2">
      {/* Hero KPIs */}
      <div className="grid grid-cols-3 gap-1.5 md:gap-2">
        {heroCards.map((c) => {
          const Icon = c.icon;
          return (
            <div key={c.label} className="relative group rounded-xl border border-white/[0.06] bg-[#111113] p-2.5 md:p-4 overflow-hidden hover:border-white/10 transition-all">
              <div className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity" style={{ background: `radial-gradient(circle at top right, ${c.color}08, transparent 70%)` }} />
              <div className="relative z-10">
                <div className="flex items-center justify-between mb-1 md:mb-2">
                  <span className="text-[8px] md:text-[10px] font-bold uppercase tracking-[0.12em] text-gray-500">{c.label}</span>
                  <div className="w-5 h-5 md:w-7 md:h-7 rounded-lg flex items-center justify-center" style={{ background: `${c.color}15` }}>
                    <Icon className="w-2.5 h-2.5 md:w-3.5 md:h-3.5" style={{ color: c.color }} />
                  </div>
                </div>
                <div className="text-lg md:text-3xl font-black text-white tracking-tight leading-none">{c.value}</div>
                <p className="text-[8px] md:text-[10px] text-gray-500 mt-0.5 font-medium">{c.sub}</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Commission toggle */}
      <button
        onClick={() => setShowCommission(!showCommission)}
        className="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-purple-500/10 bg-[#111113] hover:bg-white/[0.03] transition-colors"
      >
        <span className="text-[10px] font-bold text-gray-400">Commission: {commissionPct}%</span>
        {showCommission ? <ChevronUp className="w-3 h-3 text-gray-500" /> : <ChevronDown className="w-3 h-3 text-gray-500" />}
      </button>
      {showCommission && (
        <div className="rounded-lg border border-purple-500/10 bg-[#111113] p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Slider value={[commissionPct]} onValueChange={([v]) => setCommissionPct(v)} min={1} max={50} step={0.5} className="flex-1" />
            <Input
              type="number" value={commissionPct}
              onChange={e => setCommissionPct(Math.min(100, Math.max(0, parseFloat(e.target.value) || 0)))}
              className="w-14 h-7 text-center text-xs bg-white/5 border-white/10 text-white"
            />
          </div>
        </div>
      )}

    </div>
  );
}