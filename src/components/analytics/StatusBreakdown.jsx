import React, { useMemo } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';

const STATUS_CONFIG = {
    ELIGIBLE: { color: '#6b7280', label: 'Eligible' },
    SOLD: { color: '#22c55e', label: 'Sold' },
    QUALIFIED: { color: '#10b981', label: 'Qualified' },
    HARD_NO: { color: '#ef4444', label: 'Hard No' },
    CALLBACK: { color: '#eab308', label: 'Callback' },
    NO_ANSWER: { color: '#8b5cf6', label: 'No Answer' },
    OTHER: { color: '#3b82f6', label: 'Other' },
};

export default function StatusBreakdown({ properties }) {
    const data = useMemo(() => {
        const counts = {};
        properties.forEach(p => {
            const s = p.effective_status || 'ELIGIBLE';
            counts[s] = (counts[s] || 0) + 1;
        });

        return Object.entries(counts)
            .map(([status, count]) => ({
                name: STATUS_CONFIG[status]?.label || status,
                value: count,
                color: STATUS_CONFIG[status]?.color || '#666',
            }))
            .sort((a, b) => b.value - a.value);
    }, [properties]);

    const CustomTooltip = ({ active, payload }) => {
        if (!active || !payload?.[0]) return null;
        const d = payload[0];
        return (
            <div className="bg-[#1A1A1A] border border-gray-700 rounded-lg p-2 shadow-xl">
                <p className="text-xs font-bold" style={{ color: d.payload.color }}>{d.name}</p>
                <p className="text-[10px] text-gray-400">{d.value} properties ({((d.value / properties.length) * 100).toFixed(1)}%)</p>
            </div>
        );
    };

    return (
        <div className="bg-[#151515] border border-gray-800 rounded-xl p-4">
            <h3 className="text-sm font-bold text-white mb-4">Status Breakdown</h3>
            <div className="h-[200px]">
                <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                        <Pie data={data} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={2} dataKey="value">
                            {data.map((d, i) => <Cell key={i} fill={d.color} />)}
                        </Pie>
                        <Tooltip content={<CustomTooltip />} />
                    </PieChart>
                </ResponsiveContainer>
            </div>
            <div className="flex flex-wrap gap-2 mt-2 justify-center">
                {data.map(d => (
                    <div key={d.name} className="flex items-center gap-1.5">
                        <div className="w-2 h-2 rounded-full" style={{ background: d.color }} />
                        <span className="text-[10px] text-gray-400">{d.name} ({d.value})</span>
                    </div>
                ))}
            </div>
        </div>
    );
}