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
        <Card className="bg-[#151515] border-gray-800">
            <CardHeader className="pb-2">
                <CardTitle className="text-xs font-bold text-gray-400 flex items-center gap-2 uppercase">
                    <Target className="w-3.5 h-3.5" /> Lead Score vs Outcome
                </CardTitle>
            </CardHeader>
            <CardContent>
                {/* Score Bucket Summary */}
                <div className="grid grid-cols-5 gap-2 mb-4">
                    {bucketData.map(b => (
                        <div key={b.range} className="bg-black/40 rounded-lg p-2 text-center border border-gray-800">
                            <p className="text-[10px] text-gray-500 font-bold">{b.range}</p>
                            <p className="text-sm font-bold text-white">{b.convRate}%</p>
                            <p className="text-[9px] text-gray-600">{b.total} appts</p>
                        </div>
                    ))}
                </div>

                {/* Scatter Plot */}
                <div className="h-[220px]">
                    <ResponsiveContainer width="100%" height="100%">
                        <ScatterChart margin={{ left: 0, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                            <XAxis type="number" dataKey="score" name="Score" stroke="#555" fontSize={10} domain={[0, 100]} label={{ value: 'Eligibility Score', position: 'insideBottom', offset: -3, style: { fontSize: 10, fill: '#666' } }} />
                            <YAxis type="category" dataKey="outcome" stroke="#555" fontSize={10} width={80} />
                            <ZAxis range={[40, 40]} />
                            <Tooltip content={<CustomTooltip />} />
                            {Object.keys(OUTCOME_COLORS).map(outcome => (
                                <Scatter
                                    key={outcome}
                                    data={scatterData.filter(d => d.outcome === outcome)}
                                    fill={OUTCOME_COLORS[outcome]}
                                    name={outcome.replace('_', ' ')}
                                    opacity={0.8}
                                />
                            ))}
                        </ScatterChart>
                    </ResponsiveContainer>
                </div>
            </CardContent>
        </Card>
    );
}