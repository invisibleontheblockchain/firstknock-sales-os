import React, { useMemo } from 'react';
import { Clock3, Target, CalendarCheck, MapPinned } from 'lucide-react';

function formatHour(hour) {
  const normalized = hour % 24;
  const suffix = normalized >= 12 ? 'PM' : 'AM';
  const display = normalized % 12 || 12;
  return `${display}:00 ${suffix}`;
}

export default function NextBestActionBanner({ logs = [], appointments = [], properties = [] }) {
  const insight = useMemo(() => {
    const knockedDoors = new Set(logs.map(log => log.address_hash).filter(Boolean)).size;
    const totalDoors = properties.length;
    const coverage = totalDoors > 0 ? Math.round((knockedDoors / totalDoors) * 100) : 0;
    const upcoming = appointments.filter(a => ['scheduled', 'confirmed'].includes(a.status)).length;

    const hourCounts = logs.reduce((acc, log) => {
      const hour = new Date(log.created_date).getHours();
      acc[hour] = (acc[hour] || 0) + 1;
      return acc;
    }, {});

    const bestHourEntry = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0];
    const bestHour = bestHourEntry ? Number(bestHourEntry[0]) : null;

    if (upcoming === 0 && logs.length >= 15) {
      return {
        icon: CalendarCheck,
        title: 'Push for appointments next',
        body: 'You have field activity but no upcoming appointments in the pipeline. The fastest win is turning your next strong conversations into booked follow-ups.',
        accent: 'text-emerald-300',
        chip: 'Pipeline gap'
      };
    }

    if (bestHour !== null && logs.length >= 10) {
      return {
        icon: Clock3,
        title: `Best contact window: ${formatHour(bestHour)}–${formatHour(bestHour + 1)}`,
        body: 'Your recent activity clusters around this hour. Use it as your prime knocking window and protect lower-value admin work for slower periods.',
        accent: 'text-cyan-300',
        chip: 'Time-of-day signal'
      };
    }

    if (totalDoors > 0 && coverage < 10) {
      return {
        icon: MapPinned,
        title: 'Increase territory penetration first',
        body: `Only ${coverage}% of your loaded territory has been worked. Stay focused on denser sections before expanding into new areas.`,
        accent: 'text-blue-300',
        chip: 'Coverage opportunity'
      };
    }

    return {
      icon: Target,
      title: 'Keep momentum on high-quality activity',
      body: 'Your dashboard is healthy enough to stay execution-focused. Use the sections below to tighten conversion, route efficiency, and appointment quality.',
      accent: 'text-yellow-300',
      chip: 'Execution focus'
    };
  }, [logs, appointments, properties]);

  const Icon = insight.icon;

  return (
    <div className="relative overflow-hidden rounded-2xl border border-yellow-500/20 bg-gradient-to-br from-yellow-500/10 via-[#151515] to-[#0A0A0A] p-5 md:p-6 shadow-[0_0_30px_rgba(234,179,8,0.08)]">
      <div className="absolute inset-y-0 right-0 w-40 bg-gradient-to-l from-yellow-500/10 to-transparent pointer-events-none" />
      <div className="relative flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-yellow-500/15 border border-yellow-500/20">
            <Icon className={`w-6 h-6 ${insight.accent}`} />
          </div>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-yellow-300">Next Best Action</span>
              <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[10px] font-semibold text-gray-300">{insight.chip}</span>
            </div>
            <h3 className="text-xl font-black tracking-tight text-white">{insight.title}</h3>
            <p className="max-w-3xl text-sm md:text-base leading-relaxed text-gray-300">{insight.body}</p>
          </div>
        </div>
      </div>
    </div>
  );
}