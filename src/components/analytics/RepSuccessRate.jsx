import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, Cell } from 'recharts';
import { Users } from 'lucide-react';

export default function RepSuccessRate({ appointments, teamMembers }) {
    const data = useMemo(() => {
        const byRep = {};
        appointments.forEach(a => {
            const repId = a.assigned_rep || 'unassigned';
            const repName = a.assigned_rep_name || 'Unassigned';
            if (!byRep[repId]) byRep[repId] = { name: repName, total: 0, completed: 0, sold: 0, noShow: 0, cancelled: 0 };
            byRep[repId].total++;
            if (a.status === 'completed') byRep[repId].completed++;
            if (a.outcome === 'sold') byRep[repId].sold++;
            if (a.status === 'no_show') byRep[repId].noShow++;
            if (a.status === 'cancelled') byRep[repId].cancelled++;
        });

        return Object.values(byRep)
            .map(r => ({
                ...r,
                successRate: r.total > 0 ? Math.round((r.sold / r.total) * 100) : 0,
                completionRate: r.total > 0 ? Math.round((r.completed / r.total) * 100) : 0,
                noShowRate: r.total > 0 ? Math.round((r.noShow / r.total) * 100) : 0,
            }))
            .sort((a, b) => b.successRate - a.successRate);
    }, [appointments, teamMembers]);

    const CustomTooltip = ({ active, payload, label }) => {
        if (!active || !payload?.length) return null;
        const d = payload[0]?.payload;
        return (
            <div className="bg-black/95 border border-gray-700 p-3 rounded-xl shadow-xl text-xs">
                <p className="font-bold text-white mb-1">{label}</p>
                <p className="text-gray-400">Appointments: {d?.total}</p>
                <p className="text-green-400">Sold: {d?.sold} ({d?.successRate}%)</p>
                <p className="text-blue-400">Completed: {d?.completionRate}%</p>
                <p className="text-red-400">No-Show: {d?.noShowRate}%</p>
            </div>
        );
    };

    if (data.length === 0) return null;

    return (
        <Card className="bg-[#151515] border-gray-800">
            <CardHeader className="pb-2">
                <CardTitle className="text-xs font-bold text-gray-400 flex items-center gap-2 uppercase">
                    <Users className="w-3.5 h-3.5" /> Appointment Success by Rep
                </CardTitle>
            </CardHeader>
            <CardContent className="h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                        <XAxis dataKey="name" stroke="#555" fontSize={10} tickLine={false} />
                        <YAxis stroke="#555" fontSize={10} tickLine={false} unit="%" domain={[0, 100]} />
                        <Tooltip content={<CustomTooltip />} />
                        <Legend wrapperStyle={{ fontSize: '10px', color: '#888' }} />
                        <Bar dataKey="successRate" name="Sold %" fill="#22c55e" radius={[4, 4, 0, 0]} barSize={20} />
                        <Bar dataKey="completionRate" name="Completed %" fill="#3b82f6" radius={[4, 4, 0, 0]} barSize={20} />
                        <Bar dataKey="noShowRate" name="No-Show %" fill="#ef4444" radius={[4, 4, 0, 0]} barSize={20} />
                    </BarChart>
                </ResponsiveContainer>
            </CardContent>
        </Card>
    );
}