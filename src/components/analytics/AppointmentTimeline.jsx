import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { Activity } from 'lucide-react';
import { format, subDays, startOfDay } from 'date-fns';

export default function AppointmentTimeline({ appointments, days = 30 }) {
    const data = useMemo(() => {
        const today = startOfDay(new Date());
        const timeline = [];

        for (let i = (days - 1); i >= 0; i--) {
            const d = subDays(today, i);
            const key = format(d, 'yyyy-MM-dd');
            const dayAppts = appointments.filter(a => {
                if (!a.scheduled_date) return false;
                return format(new Date(a.scheduled_date), 'yyyy-MM-dd') === key;
            });

            timeline.push({
                date: format(d, 'MMM d'),
                scheduled: dayAppts.length,
                completed: dayAppts.filter(a => a.status === 'completed').length,
                sold: dayAppts.filter(a => a.outcome === 'sold').length,
                noShow: dayAppts.filter(a => a.status === 'no_show').length,
            });
        }

        return timeline;
    }, [appointments, days]);

    const CustomTooltip = ({ active, payload, label }) => {
        if (!active || !payload?.length) return null;
        return (
            <div className="bg-black/95 border border-gray-700 p-3 rounded-xl shadow-xl text-xs">
                <p className="font-bold text-white mb-1">{label}</p>
                {payload.map((p, i) => (
                    <p key={i} style={{ color: p.color }}>{p.name}: {p.value}</p>
                ))}
            </div>
        );
    };

    return (
        <div className="relative bg-gradient-to-b from-[#151515] to-[#0A0A0A] border border-white/5 rounded-3xl p-6 shadow-2xl overflow-hidden">
            <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            <div className="absolute -top-24 -left-24 w-64 h-64 bg-blue-500/10 blur-[100px] rounded-full pointer-events-none" />
            
            <div className="flex items-center justify-between mb-6 relative z-10">
                <h3 className="text-lg font-black text-transparent bg-clip-text bg-gradient-to-r from-white to-gray-400 tracking-tight flex items-center gap-3">
                    <div className="p-2 rounded-xl bg-blue-500/20 border border-blue-500/40">
                        <Activity className="w-5 h-5 text-blue-400 drop-shadow-[0_0_10px_rgba(59,130,246,0.5)]" />
                    </div>
                    Appointment Activity Timeline
                </h3>
            </div>
            
            <div className="h-[280px] relative z-10 mt-4">
                <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={data} margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
                        <XAxis dataKey="date" stroke="#888" fontSize={11} fontWeight={600} tickLine={false} interval="preserveStartEnd" dy={10} />
                        <YAxis stroke="#888" fontSize={11} fontWeight={600} tickLine={false} allowDecimals={false} dx={-10} />
                        <Tooltip content={<CustomTooltip />} />
                        <Legend wrapperStyle={{ fontSize: '11px', fontWeight: 600, color: '#aaa', paddingTop: '10px' }} />
                        <Line type="monotone" dataKey="scheduled" stroke="#3b82f6" strokeWidth={3} dot={false} name="Scheduled" style={{ filter: 'drop-shadow(0 0 5px rgba(59,130,246,0.5))' }} />
                        <Line type="monotone" dataKey="completed" stroke="#22c55e" strokeWidth={3} dot={false} name="Completed" style={{ filter: 'drop-shadow(0 0 5px rgba(34,197,94,0.5))' }} />
                        <Line type="monotone" dataKey="sold" stroke="#FFD700" strokeWidth={3} dot={false} name="Sold" style={{ filter: 'drop-shadow(0 0 5px rgba(255,215,0,0.5))' }} />
                        <Line type="monotone" dataKey="noShow" stroke="#ef4444" strokeWidth={2} strokeDasharray="5 5" dot={false} name="No-Show" style={{ filter: 'drop-shadow(0 0 3px rgba(239,68,68,0.3))' }} />
                    </LineChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}