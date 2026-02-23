import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScatterChart, Scatter, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ZAxis } from 'recharts';
import { Target } from 'lucide-react';

const OUTCOME_COLORS = {
    sold: '#22c55e',
    follow_up: '#eab308',
    not_interested: '#ef4444',
    not_home: '#6b7280',
    pending: '#3b82f6',
};

export default function LeadScoringEffectiveness({ appointments }) {
    const { scatterData, bucketData } = useMemo(() => {
        const scatter = appointments
            .filter(a => a.eligibility_score != null)
            .map(a => ({
                score: a.eligibility_score,
                outcome: a.outcome || 'pending',
                address: a.full_address || '',
            }));

        // Bucket analysis: group by score ranges and show conversion
        const buckets = [
            { label: '0-20', min: 0, max: 20 },
            { label: '21-40', min: 21, max: 40 },
            { label: '41-60', min: 41, max: 60 },
            { label: '61-80', min: 61, max: 80 },
            { label: '81-100', min: 81, max: 100 },
        ];

        const bucketResults = buckets.map(b => {
            const inBucket = appointments.filter(a => a.eligibility_score >= b.min && a.eligibility_score <= b.max);
            const sold = inBucket.filter(a => a.outcome === 'sold').length;
            return {
                range: b.label,
                total: inBucket.length,
                sold,
                convRate: inBucket.length > 0 ? Math.round((sold / inBucket.length) * 100) : 0,
            };
        });

        return { scatterData: scatter, bucketData: bucketResults };
    }, [appointments]);

    const CustomTooltip = ({ active, payload }) => {
        if (!active || !payload?.length) return null;
        const d = payload[0]?.payload;
        return (
            <div className="bg-black/95 border border-gray-700 p-3 rounded-xl shadow-xl text-xs">
                <p className="font-bold text-white mb-1">Score: {d?.score}</p>
                <p style={{ color: OUTCOME_COLORS[d?.outcome] || '#fff' }}>
                    Outcome: {(d?.outcome || 'pending').replace('_', ' ')}
                </p>
                <p className="text-gray-500 truncate max-w-[180px]">{d?.address}</p>
            </div>
        );
    };

    return (
        <div className="relative bg-gradient-to-b from-[#151515] to-[#0A0A0A] border border-white/5 rounded-2xl p-5 shadow-2xl overflow-hidden">
            <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            <div className="absolute -top-24 -right-24 w-64 h-64 bg-cyan-500/10 blur-[100px] rounded-full pointer-events-none" />
            
            <div className="flex items-center justify-between mb-4 relative z-10">
                <h3 className="text-base font-black text-transparent bg-clip-text bg-gradient-to-r from-white to-gray-400 tracking-tight flex items-center gap-2">
                    <div className="p-1.5 rounded-lg bg-cyan-500/20 border border-cyan-500/40">
                        <Target className="w-4 h-4 text-cyan-400 drop-shadow-[0_0_10px_rgba(34,211,238,0.5)]" />
                    </div>
                    Score Effectiveness
                </h3>
            </div>
            
            <div className="relative z-10 mt-2">
                {/* Score Bucket Summary */}
                <div className="grid grid-cols-5 gap-2 mb-4">
                    {bucketData.map(b => (
                        <div key={b.range} className="group bg-gradient-to-b from-black/60 to-black/40 backdrop-blur-md rounded-lg p-2 text-center border border-white/5 hover:border-cyan-500/30 transition-all shadow-inner">
                            <p className="text-[9px] text-gray-500 font-bold uppercase tracking-wider">{b.range}</p>
                            <p className="text-lg font-black text-transparent bg-clip-text bg-gradient-to-br from-white to-gray-400 mt-0.5 mb-0.5 group-hover:from-cyan-400 group-hover:to-blue-400 transition-all">{b.convRate}%</p>
                            <p className="text-[8px] font-bold text-gray-600 uppercase tracking-widest">{b.total} appts</p>
                        </div>
                    ))}
                </div>

                {/* Scatter Plot */}
                <div className="h-[220px]">
                    <ResponsiveContainer width="100%" height="100%">
                        <ScatterChart margin={{ top: 10, right: 20, bottom: 10, left: 10 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
                            <XAxis type="number" dataKey="score" name="Score" stroke="#888" fontSize={11} fontWeight={600} domain={[0, 100]} label={{ value: 'Eligibility Score', position: 'insideBottom', offset: -10, style: { fontSize: 11, fontWeight: 600, fill: '#888' } }} />
                            <YAxis type="category" dataKey="outcome" stroke="#888" fontSize={11} fontWeight={600} width={90} />
                            <ZAxis range={[60, 60]} />
                            <Tooltip content={<CustomTooltip />} cursor={{ strokeDasharray: '3 3', stroke: '#fff', strokeOpacity: 0.1 }} />
                            {Object.keys(OUTCOME_COLORS).map(outcome => (
                                <Scatter
                                    key={outcome}
                                    data={scatterData.filter(d => d.outcome === outcome)}
                                    fill={OUTCOME_COLORS[outcome]}
                                    name={outcome.replace('_', ' ')}
                                    opacity={0.9}
                                    style={{ filter: `drop-shadow(0 0 6px ${OUTCOME_COLORS[outcome]}60)` }}
                                />
                            ))}
                        </ScatterChart>
                    </ResponsiveContainer>
                </div>
            </div>
        </div>
    );
}