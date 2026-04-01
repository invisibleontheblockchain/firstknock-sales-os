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
    <div className="rounded-xl border border-white/[0.06] bg-[#111113] p-3 md:p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs md:text-sm font-black text-white">Revenue</h3>
        <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] md:text-[10px] font-bold ${
          revenueData.velocityPct >= 0 ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
        }`}>
          <TrendingUp className="w-2.5 h-2.5" />
          {revenueData.velocityPct >= 0 ? '+' : ''}{revenueData.velocityPct}% WoW
        </div>
      </div>

      <div className="grid grid-cols-3 gap-1.5 mb-2">
        {[
          { icon: DollarSign, value: fmt(revenueData.totalRevenue), label: 'Total', color: '#22c55e' },
          { icon: Percent, value: fmt(revenueData.avgDeal), label: 'Avg Deal', color: '#f59e0b' },
          { icon: TrendingUp, value: fmt(revenueData.thisWeekRev), label: 'This Week', color: '#3b82f6' },
        ].map((s) => {
          const Icon = s.icon;
          return (
            <div key={s.label} className="bg-white/[0.03] rounded-lg p-2 text-center">
              <Icon className="w-2.5 h-2.5 mx-auto mb-0.5" style={{ color: s.color }} />
              <div className="text-xs md:text-sm font-black text-white">{s.value}</div>
              <p className="text-[7px] md:text-[8px] text-gray-500">{s.label}</p>
            </div>
          );
        })}
      </div>

      <div className="h-[120px] md:h-[160px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={revenueData.weeklyData} margin={{ top: 5, right: 0, left: -25, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#ffffff06" vertical={false} />
            <XAxis dataKey="week" stroke="#444" fontSize={9} tickLine={false} dy={5} />
            <YAxis stroke="#333" fontSize={8} tickLine={false} axisLine={false} tickFormatter={(v) => v >= 1000 ? `${v/1000}k` : v} />
            <Tooltip content={<CustomTooltip />} />
            <Bar dataKey="revenue" fill="#22c55e" radius={[3, 3, 0, 0]} maxBarSize={28} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}