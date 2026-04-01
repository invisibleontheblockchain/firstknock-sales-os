import React, { useMemo } from 'react';
import { ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { Clock } from 'lucide-react';

export default function TimeOfDayEffectiveness({ logs }) {
  const chartData = useMemo(() => {
    if (!logs || logs.length === 0) return [];
    const hourStats = {};
    for (let i = 8; i <= 20; i++) hourStats[i] = { hour: i, knocks: 0, contacts: 0 };

    logs.forEach(log => {
      if (!log.created_date) return;
      const hour = new Date(log.created_date).getHours();
      if (hour >= 8 && hour <= 20) {
        hourStats[hour].knocks++;
        if (!['NO_ANSWER', 'ELIGIBLE'].includes(log.parsed_status)) hourStats[hour].contacts++;
      }
    });

    return Object.values(hourStats).map(s => ({
      time: new Date(0, 0, 0, s.hour, 0).toLocaleTimeString('en-US', { hour: 'numeric' }),
      knocks: s.knocks,
      rate: s.knocks > 0 ? Math.round((s.contacts / s.knocks) * 100) : 0,
    }));
  }, [logs]);

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0]?.payload;
    return (
      <div className="bg-[#0a0a0a] border border-white/10 p-2.5 rounded-lg text-[10px] shadow-2xl">
        <p className="font-bold text-white mb-1">{label}</p>
        <p className="text-gray-400">Knocks: <span className="text-white font-bold">{d?.knocks}</span></p>
        <p className="text-gray-400">Contact Rate: <span className="text-yellow-400 font-bold">{d?.rate}%</span></p>
      </div>
    );
  };

  return (
    <div className="rounded-xl border border-white/[0.06] bg-[#111113] p-3 md:p-4 relative overflow-hidden">
      <div className="absolute -top-20 -left-20 w-40 h-40 bg-blue-500/5 blur-[60px] rounded-full pointer-events-none" />
      <div className="relative z-10">
        <div className="flex items-center gap-2 mb-2">
          <div className="p-1 rounded-md bg-blue-500/15">
            <Clock className="w-3 h-3 text-blue-400" />
          </div>
          <div>
            <h3 className="text-xs md:text-sm font-black text-white">Time of Day</h3>
            <p className="text-[8px] md:text-[9px] text-gray-500">Volume vs contact rate by hour</p>
          </div>
        </div>
        <div className="h-[150px] md:h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 5, right: 0, left: -25, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff06" vertical={false} />
              <XAxis dataKey="time" stroke="#444" fontSize={8} tickLine={false} dy={6} />
              <YAxis yAxisId="left" stroke="#333" fontSize={8} tickLine={false} axisLine={false} />
              <YAxis yAxisId="right" orientation="right" stroke="#eab308" fontSize={8} tickLine={false} unit="%" axisLine={false} />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: '#ffffff06' }} />
              <Bar yAxisId="left" dataKey="knocks" fill="#333" radius={[3, 3, 0, 0]} barSize={16} />
              <Line yAxisId="right" type="monotone" dataKey="rate" stroke="#eab308" strokeWidth={2} dot={{ r: 2.5, fill: '#eab308', stroke: '#000', strokeWidth: 1 }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}