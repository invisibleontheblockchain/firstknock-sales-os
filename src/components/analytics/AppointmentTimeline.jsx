import React, { useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { Activity } from 'lucide-react';
import { format, subDays, startOfDay } from 'date-fns';
import { getAnalyticsDateWindow, isWithinAnalyticsDateWindow } from '@/lib/analyticsDateFilter';

export default function AppointmentTimeline({ appointments, days = 30, selectedDate = null }) {
  const data = useMemo(() => {
    const anchorDate = startOfDay(selectedDate || new Date());
    const d = selectedDate ? 1 : Math.min(days, 90);
    return Array.from({ length: d }, (_, i) => {
      const date = subDays(anchorDate, d - 1 - i);
      const dayWindow = getAnalyticsDateWindow({ selectedDate: date });
      const matchedAppointments = appointments.filter((appointment) =>
        isWithinAnalyticsDateWindow(appointment.scheduled_date, dayWindow)
      );
      const dayAppts = selectedDate
        ? matchedAppointments.filter((appointment) => !['canceled', 'cancelled'].includes(appointment.status))
        : matchedAppointments;
      return {
        date: format(date, selectedDate ? 'MMM d' : d <= 14 ? 'EEE' : 'M/d'),
        scheduled: dayAppts.length,
        completed: dayAppts.filter(a => a.status === 'completed').length,
        noShows: dayAppts.filter(a => a.status === 'no_show').length,
        sold: dayAppts.filter(a => a.outcome === 'sold').length,
      };
    });
  }, [appointments, days, selectedDate]);

  const CustomTooltip = ({ active = false, payload = [], label = '' }) => {
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
          <div>
            <h3 className="text-xs md:text-sm font-black text-white">
              {selectedDate ? 'Appointments' : 'Appointment Timeline'}
            </h3>
            {selectedDate && (
              <p className="text-[9px] md:text-[10px] text-gray-400">{format(selectedDate, 'MMMM d, yyyy')}</p>
            )}
          </div>
        </div>
        {selectedDate ? (
          data[0]?.scheduled > 0 ? (
            <div className="grid grid-cols-2 gap-2 pt-1">
              {[
                { label: 'Total', value: data[0].scheduled, color: '#3b82f6' },
                { label: 'Completed', value: data[0].completed, color: '#22c55e' },
                { label: 'No-show', value: data[0].noShows, color: '#ef4444' },
                { label: 'Sold', value: data[0].sold, color: '#FFD700' },
              ].map((metric) => (
                <div key={metric.label} className="rounded-lg border border-white/[0.05] bg-white/[0.025] p-3">
                  <p className="text-[9px] font-bold uppercase tracking-[0.12em] text-gray-400">{metric.label}</p>
                  <p className="mt-1 text-xl font-black" style={{ color: metric.color }}>{metric.value}</p>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex min-h-[120px] items-center justify-center rounded-lg border border-dashed border-white/[0.08] bg-white/[0.015] px-4 text-center">
              <p className="text-[10px] md:text-xs text-gray-400">No appointments were recorded on this day.</p>
            </div>
          )
        ) : (
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
        )}
      </div>
    </div>
  );
}
