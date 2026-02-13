import React, { useMemo } from 'react';
import { useTheme } from '@/components/theme/ThemeProvider';

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
    const { accent } = useTheme();

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
                pct: properties.length > 0 ? ((count / properties.length) * 100) : 0,
            }))
            .sort((a, b) => b.value - a.value);
    }, [properties]);

    const maxVal = data.length > 0 ? data[0].value : 0;

    return (
        <div className="bg-[#111] border border-gray-800/60 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-white">Status Breakdown</h3>
                <span className="text-[10px] text-gray-500">{properties.length.toLocaleString()} properties</span>
            </div>
            <div className="space-y-2.5">
                {data.map(d => (
                    <div key={d.name} className="group">
                        <div className="flex items-center justify-between mb-1">
                            <div className="flex items-center gap-2">
                                <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: d.color }} />
                                <span className="text-xs text-gray-300 font-medium">{d.name}</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="text-xs font-bold text-white">{d.value.toLocaleString()}</span>
                                <span className="text-[10px] text-gray-600 w-10 text-right">{d.pct.toFixed(1)}%</span>
                            </div>
                        </div>
                        <div className="h-1.5 bg-gray-800/50 rounded-full overflow-hidden">
                            <div
                                className="h-full rounded-full transition-all duration-500"
                                style={{ width: `${maxVal > 0 ? (d.value / maxVal) * 100 : 0}%`, background: d.color }}
                            />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}