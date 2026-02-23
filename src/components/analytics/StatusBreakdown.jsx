import React, { useMemo } from 'react';
import { useTheme } from '@/components/theme/ThemeProvider';

const STATUS_CONFIG = {
    ELIGIBLE: { color: '#8888A0', label: 'Eligible' },
    SOLD: { color: '#00F5A0', label: 'Sold' },
    QUALIFIED: { color: '#00D2FF', label: 'Qualified' },
    HARD_NO: { color: '#FF6B6B', label: 'Not Interested' },
    CALLBACK: { color: '#FFD93D', label: 'Follow Up' },
    NO_ANSWER: { color: '#8888A0', label: 'Not Home' },
    OTHER: { color: '#6C5CE7', label: 'Other' },
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
        <div className="bg-gradient-to-b from-[#151515] to-[#0A0A0A] border border-white/5 rounded-2xl p-5 shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            
            <div className="flex items-center justify-between mb-4 relative z-10">
                <h3 className="text-base font-black text-transparent bg-clip-text bg-gradient-to-r from-white to-gray-400 tracking-tight">Status Breakdown</h3>
                <div className="bg-white/5 border border-white/10 px-2 py-1 rounded-md shadow-inner">
                    <span className="text-[10px] font-bold text-gray-400 tracking-wide">{properties.length.toLocaleString()} doors</span>
                </div>
            </div>
            
            <div className="space-y-3 relative z-10">
                {data.map(d => (
                    <div key={d.name} className="group">
                        <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-3">
                                <div className="relative flex items-center justify-center">
                                    <div className="w-3 h-3 rounded-full shrink-0 relative z-10 border border-black/50 shadow-sm transition-transform duration-300 group-hover:scale-125" style={{ background: d.color }} />
                                    <div className="absolute inset-0 w-3 h-3 rounded-full blur-[4px] opacity-50 group-hover:opacity-100 transition-opacity duration-300" style={{ background: d.color }} />
                                </div>
                                <span className="text-sm font-bold text-gray-300 group-hover:text-white transition-colors tracking-wide">{d.name}</span>
                            </div>
                            <div className="flex items-center gap-3">
                                <span className="text-sm font-black text-white drop-shadow-sm">{d.value.toLocaleString()}</span>
                                <span className="text-[11px] font-bold text-gray-500 w-12 text-right bg-black/40 px-2 py-0.5 rounded-md border border-white/5">{d.pct.toFixed(1)}%</span>
                            </div>
                        </div>
                        <div className="h-2 bg-black/60 rounded-full overflow-hidden shadow-inner border border-white/5 relative">
                            <div
                                className="h-full rounded-full transition-all duration-1000 ease-out relative"
                                style={{ width: `${maxVal > 0 ? (d.value / maxVal) * 100 : 0}%`, background: `linear-gradient(90deg, ${d.color}aa, ${d.color})` }}
                            >
                                <div className="absolute inset-0 bg-white/20 w-1/2 -skew-x-12 animate-[shimmer_2s_infinite]" />
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}