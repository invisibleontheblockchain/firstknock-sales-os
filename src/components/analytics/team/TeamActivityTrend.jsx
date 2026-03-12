import React, { useMemo } from 'react';
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { ActivitySquare } from 'lucide-react';
import { format, subDays } from 'date-fns';

const SALES = ['SOLD', 'QUALIFIED'];

export default function TeamActivityTrend({ logs }) {
  const data = useMemo(() => {
    return Array.from({ length: 14 }, (_, index) => {
      const day = subDays(new Date(), 13 - index);
      const key = format(day, 'yyyy-MM-dd');
      const dayLogs = logs.filter((log) => log.created_date?.startsWith(key));
      return {
        date: format(day, 'MMM d'),
        knocks: dayLogs.length,
        sales: dayLogs.filter((log) => SALES.includes(log.parsed_status)).length,
      };
    });
  }, [logs]);

  return (
    <div className="rounded-2xl border border-white/5 bg-gradient-to-b from-[#151515] to-[#0A0A0A] p-5 shadow-2xl">
      <div className="flex items-center gap-2 mb-4">
        <ActivitySquare className="w-4 h-4 text-cyan-400" />
        <div>
          <h3 className="text-lg font-black text-white tracking-tight">Team Activity Trend</h3>
          <p className="text-sm text-gray-500">14-day volume and wins across the team</p>
        </div>
      </div>
      <div className="h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
            <XAxis dataKey="date" stroke="#888" fontSize={11} tickLine={false} dy={10} />
            <YAxis yAxisId="left" stroke="#666" fontSize={11} tickLine={false} axisLine={false} />
            <YAxis yAxisId="right" orientation="right" stroke="#22c55e" fontSize={11} tickLine={false} axisLine={false} />
            <Tooltip contentStyle={{ background: '#050505', border: '1px solid #222', borderRadius: 12 }} />
            <Legend wrapperStyle={{ fontSize: '11px', paddingTop: '12px' }} />
            <Bar yAxisId="left" dataKey="knocks" name="Knocks" fill="#2a2a2a" radius={[4, 4, 0, 0]} barSize={22} />
            <Line yAxisId="right" type="monotone" dataKey="sales" name="Sales / Qualified" stroke="#22c55e" strokeWidth={3} dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}