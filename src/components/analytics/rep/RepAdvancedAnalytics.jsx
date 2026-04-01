import React, { useMemo } from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { format, subDays } from 'date-fns';
import { Activity, Repeat, Hash, CalendarDays } from 'lucide-react';

const SALES = ['SOLD', 'QUALIFIED'];
const NON_CONTACT = ['NO_ANSWER', 'ELIGIBLE'];

export default function RepAdvancedAnalytics({ logs, filteredLogs, properties, appointments, dateDays }) {
  const volumeTrend = useMemo(() => {
    const days = Math.min(dateDays, 90);
    return Array.from({ length: days }, (_, i) => {
      const day = subDays(new Date(), days - 1 - i);
      const key = format(day, 'yyyy-MM-dd');
      const dayLogs = filteredLogs.filter((l) => l.created_date?.startsWith(key));
      const contacts = dayLogs.filter((l) => !NON_CONTACT.includes(l.parsed_status)).length;
      return {
        date: format(day, days <= 14 ? 'EEE' : 'M/d'),
        knocks: dayLogs.length,
        contacts,
        sales: dayLogs.filter((l) => SALES.includes(l.parsed_status)).length,
      };
    });
  }, [filteredLogs, dateDays]);

  const dayOfWeek = useMemo(() => {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const buckets = days.map((d) => ({ day: d, knocks: 0, sales: 0 }));
    filteredLogs.forEach((log) => {
      const dow = new Date(log.created_date).getDay();
      buckets[dow].knocks++;
      if (SALES.includes(log.parsed_status)) buckets[dow].sales++;
    });
    return buckets.map((b) => ({ ...b, rate: b.knocks ? Math.round((b.sales / b.knocks) * 100) : 0 }));
  }, [filteredLogs]);

  const statusVelocity = useMemo(() => {
    const map = { SOLD: { label: 'Sold', color: '#22c55e' }, QUALIFIED: { label: 'Qualified', color: '#3b82f6' }, CALLBACK: { label: 'Callback', color: '#f59e0b' }, HARD_NO: { label: 'Not Interested', color: '#ef4444' }, NO_ANSWER: { label: 'No Answer', color: '#6b7280' } };
    return Object.entries(map).map(([s, cfg]) => {
      const count = filteredLogs.filter((l) => l.parsed_status === s).length;
      return { ...cfg, status: s, count };
    }).filter((s) => s.count > 0).sort((a, b) => b.count - a.count);
  }, [filteredLogs]);

  const maxStatus = statusVelocity[0]?.count || 1;

  const summaryStats = useMemo(() => {
    const uniqueDays = new Set(filteredLogs.map((l) => l.created_date?.split('T')[0]).filter(Boolean));
    const uniqueDoors = new Set(filteredLogs.map((l) => l.address_hash).filter(Boolean));
    return [
      { label: 'Avg/Day', value: uniqueDays.size ? Math.round(filteredLogs.length / uniqueDays.size) : 0, icon: Activity, color: '#6366f1' },
      { label: 'Active Days', value: uniqueDays.size, icon: CalendarDays, color: '#06b6d4' },
      { label: 'Unique Doors', value: uniqueDoors.size, icon: Hash, color: '#f59e0b' },
      { label: 'Repeat Visits', value: filteredLogs.length - uniqueDoors.size, icon: Repeat, color: '#ec4899' },
    ];
  }, [filteredLogs]);

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    const d = payload[0]?.payload;
    return (
      <div className="bg-[#0a0a0a] border border-white/10 p-2.5 rounded-lg text-[10px] shadow-2xl">
        <p className="font-bold text-white mb-1">{label}</p>
        <p className="text-gray-400">Knocks: <span className="text-white font-bold">{d?.knocks}</span></p>
        <p className="text-gray-400">Contacts: <span className="text-cyan-400 font-bold">{d?.contacts}</span></p>
        <p className="text-gray-400">Sales: <span className="text-green-400 font-bold">{d?.sales}</span></p>
      </div>
    );
  };

  const maxDow = Math.max(...dayOfWeek.map((x) => x.knocks), 1);

  return (
    <div className="space-y-2 md:space-y-3">
      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5 md:gap-2">
        {summaryStats.map((m) => {
          const Icon = m.icon;
          return (
            <div key={m.label} className="rounded-xl border border-white/[0.06] bg-[#111113] p-2.5 md:p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[8px] md:text-[9px] font-bold uppercase tracking-[0.1em] text-gray-500">{m.label}</span>
                <Icon className="w-3 h-3" style={{ color: m.color }} />
              </div>
              <div className="text-lg md:text-2xl font-black text-white leading-none">{m.value}</div>
            </div>
          );
        })}
      </div>

      {/* Volume trend */}
      <div className="rounded-xl border border-white/[0.06] bg-[#111113] p-3 md:p-4">
        <h3 className="text-xs md:text-sm font-black text-white mb-0.5">Volume Trend</h3>
        <p className="text-[9px] md:text-[10px] text-gray-500 mb-2">Knocks, contacts & sales over time</p>
        <div className="h-[160px] md:h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={volumeTrend} margin={{ top: 5, right: 0, left: -25, bottom: 0 }}>
              <defs>
                <linearGradient id="gK" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#ffffff" stopOpacity={0.12} />
                  <stop offset="100%" stopColor="#ffffff" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gC" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#06b6d4" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#06b6d4" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff06" vertical={false} />
              <XAxis dataKey="date" stroke="#444" fontSize={9} tickLine={false} dy={6} interval="preserveStartEnd" />
              <YAxis stroke="#333" fontSize={8} tickLine={false} axisLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="knocks" stroke="#ffffff30" strokeWidth={1.5} fill="url(#gK)" />
              <Area type="monotone" dataKey="contacts" stroke="#06b6d4" strokeWidth={1.5} fill="url(#gC)" />
              <Area type="monotone" dataKey="sales" stroke="#22c55e" strokeWidth={1.5} fill="transparent" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 md:gap-3">
        {/* Day of week */}
        <div className="rounded-xl border border-white/[0.06] bg-[#111113] p-3 md:p-4">
          <h3 className="text-xs md:text-sm font-black text-white mb-0.5">Day Performance</h3>
          <p className="text-[9px] md:text-[10px] text-gray-500 mb-2">Best days for results</p>
          <div className="space-y-1.5">
            {dayOfWeek.map((d) => (
              <div key={d.day} className="flex items-center gap-2">
                <span className="text-[10px] font-bold text-gray-500 w-7">{d.day}</span>
                <div className="flex-1 h-5 rounded-md bg-white/[0.03] overflow-hidden relative">
                  <div className="h-full rounded-md" style={{ width: `${(d.knocks / maxDow) * 100}%`, background: 'linear-gradient(90deg, #ffffff08, #ffffff18)' }} />
                  <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[8px] font-bold text-gray-500">{d.knocks}</span>
                </div>
                <span className={`text-[10px] font-black w-8 text-right ${d.rate > 5 ? 'text-green-400' : d.rate > 0 ? 'text-yellow-400' : 'text-gray-700'}`}>{d.rate}%</span>
              </div>
            ))}
          </div>
        </div>

        {/* Outcome velocity */}
        <div className="rounded-xl border border-white/[0.06] bg-[#111113] p-3 md:p-4">
          <h3 className="text-xs md:text-sm font-black text-white mb-0.5">Outcomes</h3>
          <p className="text-[9px] md:text-[10px] text-gray-500 mb-2">Result distribution</p>
          <div className="space-y-2">
            {statusVelocity.map((s) => (
              <div key={s.status}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full" style={{ background: s.color }} />
                    <span className="text-[10px] md:text-xs font-semibold text-gray-400">{s.label}</span>
                  </div>
                  <span className="text-[10px] md:text-xs font-black text-white">{s.count}</span>
                </div>
                <div className="h-1.5 rounded-full bg-white/[0.04] overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-500" style={{ width: `${(s.count / maxStatus) * 100}%`, background: s.color }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}