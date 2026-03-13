import React, { useMemo } from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { format, subDays, startOfDay } from 'date-fns';

const SALES = ['SOLD', 'QUALIFIED'];
const NON_CONTACT = ['NO_ANSWER', 'ELIGIBLE'];

export default function RepAdvancedAnalytics({ logs, filteredLogs, properties, appointments, dateDays }) {
  // Daily volume trend
  const volumeTrend = useMemo(() => {
    return Array.from({ length: dateDays }, (_, i) => {
      const day = subDays(new Date(), dateDays - 1 - i);
      const key = format(day, 'yyyy-MM-dd');
      const dayLogs = filteredLogs.filter((l) => l.created_date?.startsWith(key));
      const contacts = dayLogs.filter((l) => !NON_CONTACT.includes(l.parsed_status)).length;
      return {
        date: format(day, 'MMM d'),
        knocks: dayLogs.length,
        contacts,
        sales: dayLogs.filter((l) => SALES.includes(l.parsed_status)).length,
      };
    });
  }, [filteredLogs, dateDays]);

  // Conversion by day of week
  const dayOfWeek = useMemo(() => {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const buckets = days.map((d) => ({ day: d, knocks: 0, sales: 0 }));
    filteredLogs.forEach((log) => {
      const dow = new Date(log.created_date).getDay();
      buckets[dow].knocks++;
      if (SALES.includes(log.parsed_status)) buckets[dow].sales++;
    });
    return buckets.map((b) => ({
      ...b,
      rate: b.knocks ? Math.round((b.sales / b.knocks) * 100) : 0,
    }));
  }, [filteredLogs]);

  // Streak by status
  const statusVelocity = useMemo(() => {
    const statuses = ['SOLD', 'QUALIFIED', 'CALLBACK', 'HARD_NO', 'NO_ANSWER'];
    const colors = { SOLD: '#22c55e', QUALIFIED: '#3b82f6', CALLBACK: '#f59e0b', HARD_NO: '#ef4444', NO_ANSWER: '#6b7280' };
    const labels = { SOLD: 'Sold', QUALIFIED: 'Qualified', CALLBACK: 'Callback', HARD_NO: 'Not Interested', NO_ANSWER: 'No Answer' };
    return statuses.map((s) => {
      const count = filteredLogs.filter((l) => l.parsed_status === s).length;
      return { status: s, label: labels[s], count, color: colors[s] };
    }).filter((s) => s.count > 0).sort((a, b) => b.count - a.count);
  }, [filteredLogs]);

  const maxStatus = statusVelocity[0]?.count || 1;

  // Avg knocks per active day
  const avgPerDay = useMemo(() => {
    const uniqueDays = new Set(filteredLogs.map((l) => l.created_date?.split('T')[0]).filter(Boolean));
    return uniqueDays.size ? Math.round(filteredLogs.length / uniqueDays.size) : 0;
  }, [filteredLogs]);

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0]?.payload;
    return (
      <div className="bg-[#0a0a0a] border border-white/10 p-3 rounded-xl text-xs shadow-2xl">
        <p className="font-bold text-white mb-1.5">{label}</p>
        <div className="space-y-1">
          <p className="text-gray-400">Knocks: <span className="text-white font-bold">{d?.knocks}</span></p>
          <p className="text-gray-400">Contacts: <span className="text-cyan-400 font-bold">{d?.contacts}</span></p>
          <p className="text-gray-400">Sales: <span className="text-green-400 font-bold">{d?.sales}</span></p>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Top metrics row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
        {[
          { label: 'Avg / Active Day', value: avgPerDay, sub: 'knocks per day worked' },
          { label: 'Active Days', value: new Set(filteredLogs.map((l) => l.created_date?.split('T')[0]).filter(Boolean)).size, sub: `out of ${dateDays}` },
          { label: 'Unique Doors', value: new Set(filteredLogs.map((l) => l.address_hash).filter(Boolean)).size, sub: 'distinct properties' },
          { label: 'Repeat Visits', value: filteredLogs.length - new Set(filteredLogs.map((l) => l.address_hash).filter(Boolean)).size, sub: 'follow-up knocks' },
        ].map((m) => (
          <div key={m.label} className="rounded-xl md:rounded-2xl border border-white/[0.06] bg-[#111113] p-2.5 md:p-4">
            <span className="text-[8px] md:text-[10px] font-semibold uppercase tracking-[0.1em] text-gray-500 truncate">{m.label}</span>
            <div className="text-lg md:text-2xl font-black text-white mt-1 md:mt-2">{m.value}</div>
            <p className="text-[9px] md:text-[10px] text-gray-500 mt-0.5 md:mt-1 truncate">{m.sub}</p>
          </div>
        ))}
      </div>

      {/* Volume trend chart */}
      <div className="rounded-xl md:rounded-2xl border border-white/[0.06] bg-[#111113] p-3 md:p-5">
        <h3 className="text-sm md:text-base font-black text-white mb-0.5 md:mb-1">Volume Trend</h3>
        <p className="text-[10px] md:text-xs text-gray-500 mb-3 md:mb-4">Daily knock volume, contacts, and sales</p>
        <div className="h-[180px] md:h-[220px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={volumeTrend} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="gradKnocks" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#ffffff" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gradContacts" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#06b6d4" stopOpacity={0.2} />
                  <stop offset="100%" stopColor="#06b6d4" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff08" vertical={false} />
              <XAxis dataKey="date" stroke="#555" fontSize={10} tickLine={false} dy={8} interval="preserveStartEnd" />
              <YAxis stroke="#444" fontSize={10} tickLine={false} axisLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="knocks" stroke="#ffffff40" strokeWidth={2} fill="url(#gradKnocks)" />
              <Area type="monotone" dataKey="contacts" stroke="#06b6d4" strokeWidth={2} fill="url(#gradContacts)" />
              <Area type="monotone" dataKey="sales" stroke="#22c55e" strokeWidth={2} fill="transparent" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-6">
        {/* Day of week */}
        <div className="rounded-xl md:rounded-2xl border border-white/[0.06] bg-[#111113] p-3 md:p-5">
          <h3 className="text-sm md:text-base font-black text-white mb-0.5 md:mb-1">Day-of-Week Performance</h3>
          <p className="text-[10px] md:text-xs text-gray-500 mb-3 md:mb-4">Which days yield the best results</p>
          <div className="space-y-2 md:space-y-3">
            {dayOfWeek.map((d) => (
              <div key={d.day} className="flex items-center gap-3">
                <span className="text-xs font-bold text-gray-400 w-8">{d.day}</span>
                <div className="flex-1 h-6 rounded-lg bg-white/[0.03] overflow-hidden flex items-center relative">
                  <div
                    className="h-full rounded-lg"
                    style={{
                      width: `${(d.knocks / (Math.max(...dayOfWeek.map((x) => x.knocks)) || 1)) * 100}%`,
                      background: 'linear-gradient(90deg, #ffffff10, #ffffff20)',
                    }}
                  />
                  <span className="absolute right-2 text-[10px] font-bold text-gray-400">{d.knocks} knocks</span>
                </div>
                <div className="w-16 text-right">
                  <span className={`text-xs font-black ${d.rate > 5 ? 'text-green-400' : d.rate > 0 ? 'text-yellow-400' : 'text-gray-600'}`}>{d.rate}%</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Status velocity */}
        <div className="rounded-xl md:rounded-2xl border border-white/[0.06] bg-[#111113] p-3 md:p-5">
          <h3 className="text-sm md:text-base font-black text-white mb-0.5 md:mb-1">Outcome Velocity</h3>
          <p className="text-[10px] md:text-xs text-gray-500 mb-3 md:mb-4">Result distribution for the period</p>
          <div className="space-y-2 md:space-y-3">
            {statusVelocity.map((s) => (
              <div key={s.status}>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full" style={{ background: s.color }} />
                    <span className="text-sm font-semibold text-gray-300">{s.label}</span>
                  </div>
                  <span className="text-sm font-black text-white">{s.count}</span>
                </div>
                <div className="h-1.5 rounded-full bg-white/[0.04] overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-700" style={{ width: `${(s.count / maxStatus) * 100}%`, background: s.color }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}