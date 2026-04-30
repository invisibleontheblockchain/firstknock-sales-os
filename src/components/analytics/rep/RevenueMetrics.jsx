import React, { useMemo } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { format, subDays } from 'date-fns';
import { DollarSign, TrendingUp, Percent } from 'lucide-react';

const SALES = ['SOLD', 'QUALIFIED'];

export default function RevenueMetrics({ logs, dateDays }) {
  const revenueData = useMemo(() => {
    const salesLogs = logs.filter(l => SALES.includes(l.parsed_status) && l.sale_amount > 0);
    const totalRevenue = salesLogs.reduce((s, l) => s + (l.sale_amount || 0), 0);
    const totalDeals = salesLogs.length;
    const avgDeal = totalDeals > 0 ? Math.round(totalRevenue / totalDeals) : 0;

    const weeks = Math.max(Math.ceil(dateDays / 7), 1);
    const weeklyData = Array.from({ length: Math.min(weeks, 12) }, (_, i) => {
      const weekEnd = subDays(new Date(), i * 7);
      const weekStart = subDays(new Date(), (i + 1) * 7);
      const weekLogs = salesLogs.filter(l => {
        const d = new Date(l.created_date);
        return d >= weekStart && d <= weekEnd;
      });
      return {
        week: `W${Math.min(weeks, 12) - i}`,
        label: format(weekStart, 'MMM d'),
        revenue: weekLogs.reduce((s, l) => s + (l.sale_amount || 0), 0),
        deals: weekLogs.length,
      };
    }).reverse();

    const thisWeekRev = weeklyData[weeklyData.length - 1]?.revenue || 0;
    const lastWeekRev = weeklyData[weeklyData.length - 2]?.revenue || 0;
    const velocityPct = lastWeekRev > 0 ? Math.round(((thisWeekRev - lastWeekRev) / lastWeekRev) * 100) : 0;

    return { totalRevenue, totalDeals, avgDeal, weeklyData, velocityPct, thisWeekRev };
  }, [logs, dateDays]);

  const fmt = (v) => v >= 1000000 ? `$${(v / 1000000).toFixed(1)}M` : v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v}`;

  const CustomTooltip = ({ active, payload }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0]?.payload;
    return (
      <div className="bg-[#0a0a0a] border border-white/10 p-2.5 rounded-lg text-[10px] shadow-2xl">
        <p className="font-bold text-white mb-1">{d?.label}</p>
        <p className="text-gray-400">Revenue: <span className="text-green-400 font-bold">{fmt(d?.revenue)}</span></p>
        <p className="text-gray-400">Deals: <span className="text-white font-bold">{d?.deals}</span></p>
      </div>
    );
  };

  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-gradient-to-br from-[#121216] via-[#0d0d11] to-[#070708] p-4 md:p-5 shadow-2xl shadow-black/30">
      <div className="absolute -right-12 -top-12 h-32 w-32 rounded-full bg-green-500/10 blur-3xl" />
      <div className="relative">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-gray-500">Revenue</p>
            <h3 className="mt-1 text-2xl md:text-3xl font-black text-white tracking-tight">{fmt(revenueData.totalRevenue)}</h3>
            <p className="mt-1 text-[11px] text-gray-500">{revenueData.totalDeals} closed deals in this period</p>
          </div>
          <div className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[10px] md:text-xs font-bold border ${
            revenueData.velocityPct >= 0 ? 'bg-green-500/10 text-green-300 border-green-400/20' : 'bg-red-500/10 text-red-300 border-red-400/20'
          }`}>
            <TrendingUp className="w-3 h-3" />
            {revenueData.velocityPct >= 0 ? '+' : ''}{revenueData.velocityPct}% WoW
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5 mb-4">
          {[
            { icon: Percent, value: fmt(revenueData.avgDeal), label: 'Average Deal', color: '#f59e0b' },
            { icon: TrendingUp, value: fmt(revenueData.thisWeekRev), label: 'This Week', color: '#60a5fa' },
          ].map((s) => {
            const Icon = s.icon;
            return (
              <div key={s.label} className="rounded-xl border border-white/[0.06] bg-white/[0.035] p-3">
                <div className="flex items-center gap-2 mb-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-black/25">
                    <Icon className="w-3.5 h-3.5" style={{ color: s.color }} />
                  </div>
                  <p className="text-[10px] font-semibold text-gray-500">{s.label}</p>
                </div>
                <div className="text-lg md:text-xl font-black text-white">{s.value}</div>
              </div>
            );
          })}
        </div>

        <div className="rounded-xl border border-white/[0.06] bg-black/20 p-3">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gray-500">Weekly trend</p>
            <DollarSign className="w-3.5 h-3.5 text-green-400" />
          </div>
          <div className="h-[140px] md:h-[180px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={revenueData.weeklyData} margin={{ top: 8, right: 6, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#ffffff08" vertical={false} />
                <XAxis dataKey="week" stroke="#6b7280" fontSize={10} tickLine={false} axisLine={false} dy={6} />
                <YAxis stroke="#4b5563" fontSize={9} tickLine={false} axisLine={false} tickFormatter={(v) => v >= 1000 ? `${v/1000}k` : v} />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                <Bar dataKey="revenue" fill="#22c55e" radius={[6, 6, 2, 2]} maxBarSize={34} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}