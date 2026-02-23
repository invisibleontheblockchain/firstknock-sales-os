import React from 'react';
import { Card, CardContent } from "@/components/ui/card";
import { Calendar, CheckCircle, TrendingUp, AlertTriangle, Users, Target } from 'lucide-react';

export default function KpiSummaryCards({ appointments, teamMembers }) {
    const total = appointments.length;
    const completed = appointments.filter(a => a.status === 'completed').length;
    const sold = appointments.filter(a => a.outcome === 'sold').length;
    const noShow = appointments.filter(a => a.status === 'no_show').length;
    const upcoming = appointments.filter(a => a.status === 'scheduled' || a.status === 'confirmed').length;
    const avgScore = total > 0
        ? Math.round(appointments.reduce((sum, a) => sum + (a.eligibility_score || 0), 0) / total)
        : 0;
    const convRate = completed > 0 ? Math.round((sold / completed) * 100) : 0;
    const noShowRate = total > 0 ? Math.round((noShow / total) * 100) : 0;
    const activeReps = new Set(appointments.map(a => a.assigned_rep).filter(Boolean)).size;

    const cards = [
        { title: 'Total Appointments', value: total, icon: Calendar, color: 'text-blue-400', bg: 'bg-blue-500/10' },
        { title: 'Conversion Rate', value: `${convRate}%`, icon: TrendingUp, color: 'text-green-400', bg: 'bg-green-500/10', sub: `${sold} sold / ${completed} completed` },
        { title: 'Upcoming', value: upcoming, icon: CheckCircle, color: 'text-yellow-400', bg: 'bg-yellow-500/10' },
        { title: 'No-Show Rate', value: `${noShowRate}%`, icon: AlertTriangle, color: 'text-red-400', bg: 'bg-red-500/10', sub: `${noShow} no-shows` },
        { title: 'Active Reps', value: activeReps, icon: Users, color: 'text-purple-400', bg: 'bg-purple-500/10' },
        { title: 'Avg Lead Score', value: avgScore, icon: Target, color: 'text-cyan-400', bg: 'bg-cyan-500/10' },
    ];

    return (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            {cards.map(c => (
                <div key={c.title} className="group relative bg-gradient-to-b from-[#1a1a1a] to-[#0A0A0A] border border-white/5 rounded-2xl p-5 overflow-hidden transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl hover:border-white/10 shadow-lg">
                    <div className={`absolute -top-10 -right-10 w-24 h-24 blur-3xl opacity-10 group-hover:opacity-30 transition-opacity duration-500 rounded-full ${c.bg}`} />
                    <div className="flex items-center justify-between mb-3 relative z-10">
                        <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{c.title}</span>
                        <div className={`p-2 rounded-xl transition-transform duration-300 group-hover:scale-110 border border-white/5 shadow-inner ${c.bg}`}>
                            <c.icon className={`w-4 h-4 ${c.color} drop-shadow-md`} />
                        </div>
                    </div>
                    <p className="text-3xl font-black text-transparent bg-clip-text bg-gradient-to-br from-white to-gray-400 tracking-tight drop-shadow-sm relative z-10">{c.value}</p>
                    {c.sub && <p className="text-xs font-medium text-gray-500 mt-1 relative z-10">{c.sub}</p>}
                </div>
            ))}
        </div>
    );
}