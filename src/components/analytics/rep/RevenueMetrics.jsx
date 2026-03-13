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

    // Weekly revenue buckets
    const weeks = Math.ceil(dateDays / 7);
    const weeklyData = Array.from({ length: weeks }, (_, i) => {
      const weekEnd = subDays(new Date(), i * 7);
      const weekStart = subDays(new Date(), (i + 1) * 7);
      const weekLogs = salesLogs.filter(l => {
        const d = new Date(l.created_date);
        return d >= weekStart && d <= weekEnd;
      });
      const rev = weekLogs.reduce((s, l) => s + (l.sale_amount || 0), 0);
      return {
        week: `W${weeks - i}`,
        label: format(weekStart, 'MMM d'),
        revenue: rev,
        deals: weekLogs.length,
      };
    }).reverse();

    // Revenue velocity (this week vs last week)
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
      <div className="bg-[#0a0a0a] border border-white/10 p-3 rounded-xl text-xs shadow-2xl">
        <p className="font-bold text-white mb-1">{d?.label}</p>
        <p className="text-gray-400">Revenue: <span className="text-green-400 font-bold">{fmt(d?.revenue)}</span></p>
        <p className="text-gray-400">Deals: <span className="text-white font-bold">{d?.deals}</span></p>
      </div>
    );
  };

  return (
    <div className="rounded-xl md:rounded-2xl border border-white/[0.06] bg-[#111113] p-3 md:p-5">
      <div className="flex items-center justify-between mb-3 md:mb-4">
        <div>
          <h3 className="text-sm md:text-base font-black text-white tracking-tight">Revenue Tracker</h3>
          <p className="text-[10px] md:text-xs text-gray-500 mt-0.5">Weekly revenue breakdown</p>
        </div>
        <div className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] md:text-xs font-bold ${
          revenueData.velocityPct >= 0 ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
        }`}>
          <TrendingUp className="w-3 h-3" />
          {revenueData.velocityPct >= 0 ? '+' : ''}{revenueData.velocityPct}% WoW
        </div>
      </div>

      {/* Mini stat pills */}
      <div className="grid grid-cols-3 gap-2 mb-3 md:mb-4">
        <div className="bg-white/[0.03] rounded-lg p-2 md:p-2.5 text-center">
          <DollarSign className="w-3 h-3 text-green-400 mx-auto mb-1" />
          <div className="text-sm md:text-lg font-black text-white">{fmt(revenueData.totalRevenue)}</div>
          <p className="text-[8px] md:text-[9px] text-gray-500">Total</p>
        </div>
        <div className="bg-white/[0.03] rounded-lg p-2 md:p-2.5 text-center">
          <Percent className="w-3 h-3 text-yellow-400 mx-auto mb-1" />
          <div className="text-sm md:text-lg font-black text-white">{fmt(revenueData.avgDeal)}</div>
          <p className="text-[8px] md:text-[9px] text-gray-500">Avg Deal</p>
        </div>
        <div className="bg-white/[0.03] rounded-lg p-2 md:p-2.5 text-center">
          <TrendingUp className="w-3 h-3 text-blue-400 mx-auto mb-1" />
          <div className="text-sm md:text-lg font-black text-white">{fmt(revenueData.thisWeekRev)}</div>
          <p className="text-[8px] md:text-[9px] text-gray-500">This Week</p>
        </div>
      </div>

      {/* Chart */}
      <div className="h-[140px] md:h-[180px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={revenueData.weeklyData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#ffffff08" vertical={false} />
            <XAxis dataKey="week" stroke="#555" fontSize={10} tickLine={false} dy={5} />
            <YAxis stroke="#444" fontSize={9} tickLine={false} axisLine={false} tickFormatter={(v) => v >= 1000 ? `${v/1000}k` : v} />
            <Tooltip content={<CustomTooltip />} />
            <Bar dataKey="revenue" fill="#22c55e" radius={[4, 4, 0, 0]} maxBarSize={32} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}