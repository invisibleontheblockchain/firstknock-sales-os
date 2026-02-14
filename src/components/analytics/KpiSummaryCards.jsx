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
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {cards.map(c => (
                <Card key={c.title} className="bg-[#151515] border-gray-800 hover:border-gray-700 transition-colors">
                    <CardContent className="p-4">
                        <div className="flex items-center justify-between mb-3">
                            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">{c.title}</span>
                            <div className={`p-1.5 rounded-lg ${c.bg}`}>
                                <c.icon className={`w-3.5 h-3.5 ${c.color}`} />
                            </div>
                        </div>
                        <p className="text-2xl font-bold text-white">{c.value}</p>
                        {c.sub && <p className="text-[10px] text-gray-600 mt-0.5">{c.sub}</p>}
                    </CardContent>
                </Card>
            ))}
        </div>
    );
}