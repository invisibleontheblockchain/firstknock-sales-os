import React, { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts';
import { Briefcase } from 'lucide-react';
import { getIndustryLabel } from '../appointments/EligibilityScorer';

const COLORS = ['#FFD700', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#06b6d4', '#ef4444', '#84cc16', '#f43f5e'];

export default function ConversionByIndustry({ appointments }) {
    const data = useMemo(() => {
        const byIndustry = {};
        appointments.forEach(a => {
            const ind = a.industry || 'other';
            if (!byIndustry[ind]) byIndustry[ind] = { total: 0, sold: 0, followUp: 0, notInterested: 0 };
            byIndustry[ind].total++;
            if (a.outcome === 'sold') byIndustry[ind].sold++;
            if (a.outcome === 'follow_up') byIndustry[ind].followUp++;
            if (a.outcome === 'not_interested') byIndustry[ind].notInterested++;
        });

        return Object.entries(byIndustry)
            .map(([key, val]) => ({
                industry: getIndustryLabel(key),
                key,
                total: val.total,
                convRate: val.total > 0 ? Math.round((val.sold / val.total) * 100) : 0,
                followUpRate: val.total > 0 ? Math.round((val.followUp / val.total) * 100) : 0,
                sold: val.sold,
            }))
            .sort((a, b) => b.total - a.total);
    }, [appointments]);

    const CustomTooltip = ({ active, payload, label }) => {
        if (!active || !payload?.length) return null;
        const d = payload[0]?.payload;
        return (
            <div className="bg-black/95 border border-gray-700 p-3 rounded-xl shadow-xl text-xs">
                <p className="font-bold text-white mb-1">{label}</p>
                <p className="text-gray-400">Total: {d?.total}</p>
                <p className="text-green-400">Sold: {d?.sold} ({d?.convRate}%)</p>
                <p className="text-yellow-400">Follow-up: {d?.followUpRate}%</p>
            </div>
        );
    };

    if (data.length === 0) return null;

    return (
        <div className="relative bg-gradient-to-b from-[#151515] to-[#0A0A0A] border border-white/5 rounded-2xl p-5 shadow-2xl overflow-hidden">
            <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            <div className="absolute -bottom-24 -right-24 w-64 h-64 bg-emerald-500/10 blur-[100px] rounded-full pointer-events-none" />
            
            <div className="flex items-center justify-between mb-4 relative z-10">
                <h3 className="text-base font-black text-transparent bg-clip-text bg-gradient-to-r from-white to-gray-400 tracking-tight flex items-center gap-2">
                    <div className="p-1.5 rounded-lg bg-emerald-500/20 border border-emerald-500/40">
                        <Briefcase className="w-4 h-4 text-emerald-400 drop-shadow-[0_0_10px_rgba(16,185,129,0.5)]" />
                    </div>
                    Conversion by Industry
                </h3>
            </div>
            
            <div className="h-[240px] relative z-10 mt-2">
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data} layout="vertical" margin={{ top: 0, right: 20, left: 10, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" horizontal={false} />
                        <XAxis type="number" stroke="#888" fontSize={11} fontWeight={600} tickLine={false} unit="%" domain={[0, 100]} dx={5} />
                        <YAxis type="category" dataKey="industry" stroke="#888" fontSize={11} fontWeight={600} width={90} tickLine={false} />
                        <Tooltip content={<CustomTooltip />} cursor={{ fill: '#ffffff0a' }} />
                        <Bar dataKey="convRate" name="Conv %" radius={[0, 6, 6, 0]} barSize={24}>
                            {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} style={{ filter: 'drop-shadow(0 0 4px rgba(255,255,255,0.2))' }} />)}
                        </Bar>
                    </BarChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}