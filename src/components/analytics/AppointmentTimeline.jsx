import React, { useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { Activity } from 'lucide-react';
import { format, subDays, startOfDay } from 'date-fns';

export default function AppointmentTimeline({ appointments, days = 30 }) {
  const data = useMemo(() => {
    const today = startOfDay(new Date());
    const d = Math.min(days, 90);
    return Array.from({ length: d }, (_, i) => {
      const date = subDays(today, d - 1 - i);
      const key = format(date, 'yyyy-MM-dd');
      const dayAppts = appointments.filter(a => a.scheduled_date && format(new Date(a.scheduled_date), 'yyyy-MM-dd') === key);
      return {
        date: format(date, d <= 14 ? 'EEE' : 'M/d'),
        scheduled: dayAppts.length,
        completed: dayAppts.filter(a => a.status === 'completed').length,
        sold: dayAppts.filter(a => a.outcome === 'sold').length,
      };
    });
  }, [appointments, days]);

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    return (
      <div className="bg-[#0a0a0a] border border-white/10 p-2.5 rounded-lg text-[10px] shadow-2xl">
        <p className="font-bold text-white mb-1">{label}</p>
        {payload.map((p, i) => (
          <p key={i} style={{ color: p.color }}>{p.name}: <span className="font-bold">{p.value}</span></p>
        ))}
      </div>
    );
  };

  return (
    <div className="rounded-xl border border-white/[0.06] bg-[#111113] p-3 md:p-4 relative overflow-hidden">
      <div className="absolute -top-20 -left-20 w-40 h-40 bg-indigo-500/5 blur-[60px] rounded-full pointer-events-none" />
      <div className="relative z-10">
        <div className="flex items-center gap-2 mb-2">
          <div className="p-1 rounded-md bg-indigo-500/15">
            <Activity className="w-3 h-3 text-indigo-400" />
          </div>
          <h3 className="text-xs md:text-sm font-black text-white">Appointment Timeline</h3>
        </div>
        <div className="h-[140px] md:h-[180px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 5, right: 0, left: -25, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff06" vertical={false} />
              <XAxis dataKey="date" stroke="#444" fontSize={8} tickLine={false} interval="preserveStartEnd" dy={6} />
              <YAxis stroke="#333" fontSize={8} tickLine={false} allowDecimals={false} axisLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Line type="monotone" dataKey="scheduled" stroke="#3b82f6" strokeWidth={2} dot={false} name="Scheduled" />
              <Line type="monotone" dataKey="completed" stroke="#22c55e" strokeWidth={2} dot={false} name="Completed" />
              <Line type="monotone" dataKey="sold" stroke="#FFD700" strokeWidth={2} dot={false} name="Sold" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}