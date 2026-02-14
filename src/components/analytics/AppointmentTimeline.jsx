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
        <Card className="bg-[#151515] border-gray-800">
            <CardHeader className="pb-2">
                <CardTitle className="text-xs font-bold text-gray-400 flex items-center gap-2 uppercase">
                    <Activity className="w-3.5 h-3.5" /> Appointment Activity Timeline
                </CardTitle>
            </CardHeader>
            <CardContent className="h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={data}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                        <XAxis dataKey="date" stroke="#555" fontSize={9} tickLine={false} interval="preserveStartEnd" />
                        <YAxis stroke="#555" fontSize={10} tickLine={false} allowDecimals={false} />
                        <Tooltip content={<CustomTooltip />} />
                        <Legend wrapperStyle={{ fontSize: '10px', color: '#888' }} />
                        <Line type="monotone" dataKey="scheduled" stroke="#3b82f6" strokeWidth={2} dot={false} name="Scheduled" />
                        <Line type="monotone" dataKey="completed" stroke="#22c55e" strokeWidth={2} dot={false} name="Completed" />
                        <Line type="monotone" dataKey="sold" stroke="#FFD700" strokeWidth={2} dot={false} name="Sold" />
                        <Line type="monotone" dataKey="noShow" stroke="#ef4444" strokeWidth={1.5} dot={false} name="No-Show" />
                    </LineChart>
                </ResponsiveContainer>
            </CardContent>
        </Card>
    );
}