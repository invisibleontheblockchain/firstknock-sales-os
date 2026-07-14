import React, { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
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
        <div className="relative bg-gradient-to-b from-[#151515] to-[#0A0A0A] border border-white/5 rounded-2xl p-5 shadow-2xl overflow-hidden">
            <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            <div className="absolute -bottom-24 -left-24 w-64 h-64 bg-purple-500/10 blur-[100px] rounded-full pointer-events-none" />
            
            <div className="flex items-center justify-between mb-4 relative z-10">
                <h3 className="text-base font-black text-transparent bg-clip-text bg-gradient-to-r from-white to-gray-400 tracking-tight flex items-center gap-2">
                    <div className="p-1.5 rounded-lg bg-purple-500/20 border border-purple-500/40">
                        <Users className="w-4 h-4 text-purple-400 drop-shadow-[0_0_10px_rgba(168,85,247,0.5)]" />
                    </div>
                    Rep Success Rate
                </h3>
            </div>
            
            <div className="h-[240px] relative z-10 mt-2">
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data} margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
                        <XAxis dataKey="name" stroke="#888" fontSize={11} fontWeight={600} tickLine={false} dy={10} />
                        <YAxis stroke="#888" fontSize={11} fontWeight={600} tickLine={false} unit="%" domain={[0, 100]} dx={-5} />
                        <Tooltip content={<CustomTooltip />} cursor={{ fill: '#ffffff0a' }} />
                        <Legend wrapperStyle={{ fontSize: '11px', fontWeight: 600, color: '#aaa', paddingTop: '10px' }} />
                        <Bar dataKey="successRate" name="Sold %" fill="#22c55e" radius={[6, 6, 0, 0]} barSize={24} style={{ filter: 'drop-shadow(0 0 5px rgba(34,197,94,0.3))' }} />
                        <Bar dataKey="completionRate" name="Completed %" fill="#3b82f6" radius={[6, 6, 0, 0]} barSize={24} style={{ filter: 'drop-shadow(0 0 5px rgba(59,130,246,0.3))' }} />
                        <Bar dataKey="noShowRate" name="No-Show %" fill="#ef4444" radius={[6, 6, 0, 0]} barSize={24} style={{ filter: 'drop-shadow(0 0 5px rgba(239,68,68,0.3))' }} />
                    </BarChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}