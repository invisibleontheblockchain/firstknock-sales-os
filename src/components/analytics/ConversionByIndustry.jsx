import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
        <Card className="bg-[#151515] border-gray-800">
            <CardHeader className="pb-2">
                <CardTitle className="text-xs font-bold text-gray-400 flex items-center gap-2 uppercase">
                    <Briefcase className="w-3.5 h-3.5" /> Conversion Rate by Industry
                </CardTitle>
            </CardHeader>
            <CardContent className="h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data} layout="vertical" margin={{ left: 10 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#222" horizontal={false} />
                        <XAxis type="number" stroke="#555" fontSize={10} tickLine={false} unit="%" domain={[0, 100]} />
                        <YAxis type="category" dataKey="industry" stroke="#555" fontSize={10} width={85} tickLine={false} />
                        <Tooltip content={<CustomTooltip />} />
                        <Bar dataKey="convRate" name="Conv %" radius={[0, 4, 4, 0]} barSize={18}>
                            {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                        </Bar>
                    </BarChart>
                </ResponsiveContainer>
            </CardContent>
        </Card>
    );
}