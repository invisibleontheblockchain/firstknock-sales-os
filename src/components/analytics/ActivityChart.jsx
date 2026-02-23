import React, { useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { format, subDays, startOfDay } from 'date-fns';
import { useTheme } from '@/components/theme/ThemeProvider';

const RANGE_OPTIONS = [
    { label: '7d', days: 7 },
    { label: '14d', days: 14 },
    { label: '30d', days: 30 },
];

export default function ActivityChart({ logs }) {
    const { accent } = useTheme();
    const [range, setRange] = useState(14);

    const chartData = useMemo(() => {
        const now = new Date();
        const data = [];
        for (let i = range - 1; i >= 0; i--) {
            const day = startOfDay(subDays(now, i));
            const nextDay = new Date(day.getTime() + 86400000);
            const dayLogs = logs.filter(l => {
                const d = new Date(l.created_date);
                return d >= day && d < nextDay;
            });
            const sales = dayLogs.filter(l => ['SOLD', 'QUALIFIED'].includes(l.parsed_status)).length;
            const callbacks = dayLogs.filter(l => l.parsed_status === 'CALLBACK').length;
            const noAnswer = dayLogs.filter(l => l.parsed_status === 'NO_ANSWER').length;
            const hardNo = dayLogs.filter(l => l.parsed_status === 'HARD_NO').length;
            const other = Math.max(0, dayLogs.length - sales - callbacks - noAnswer - hardNo);

            data.push({
                date: format(day, 'MMM d'),
                shortDate: range <= 14 ? format(day, 'EEE') : format(day, 'd'),
                total: dayLogs.length,
                sales, callbacks, noAnswer, hardNo, other,
            });
        }
        return data;
    }, [logs, range]);

    const totalKnocks = chartData.reduce((s, d) => s + d.total, 0);
    const totalSales = chartData.reduce((s, d) => s + d.sales, 0);

    const CustomTooltip = ({ active, payload, label }) => {
        if (!active || !payload) return null;
        const total = payload.reduce((s, p) => s + (p.value || 0), 0);
        return (
            <div className="bg-[#1A1A1A] border border-gray-700/50 rounded-xl p-3 shadow-2xl backdrop-blur-sm">
                <p className="text-xs font-bold text-white mb-1.5">{label} — {total} total</p>
                {payload.filter(p => p.value > 0).map((p, i) => (
                    <div key={i} className="flex items-center gap-2 text-[10px]">
                        <div className="w-2 h-2 rounded-full" style={{ background: p.color }} />
                        <span className="text-gray-400">{p.name}</span>
                        <span className="ml-auto font-bold text-white">{p.value}</span>
                    </div>
                ))}
            </div>
        );
    };

    return (
        <div className="relative bg-gradient-to-b from-[#151515] to-[#0A0A0A] border border-white/5 rounded-3xl p-6 shadow-2xl overflow-hidden">
            {/* Ambient glow */}
            <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            <div className="absolute -top-24 -left-24 w-64 h-64 bg-green-500/10 blur-[100px] rounded-full pointer-events-none" />
            
            <div className="flex items-center justify-between mb-6 relative z-10">
                <div>
                    <h3 className="text-lg font-black text-transparent bg-clip-text bg-gradient-to-r from-white to-gray-400 tracking-tight">Daily Activity</h3>
                    <p className="text-xs text-gray-500 mt-1 font-medium tracking-wide">
                        <span className="text-white">{totalKnocks}</span> knocks · <span className="text-green-400">{totalSales}</span> sales
                    </p>
                </div>
                <div className="flex p-1 bg-black/60 backdrop-blur-md rounded-xl border border-white/10 shadow-inner">
                    {RANGE_OPTIONS.map(opt => (
                        <button
                            key={opt.days}
                            onClick={() => setRange(opt.days)}
                            className={`px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all duration-300 ${
                                range === opt.days
                                    ? 'text-black shadow-[0_0_15px_rgba(255,215,0,0.3)]'
                                    : 'text-gray-400 hover:text-white hover:bg-white/5'
                            }`}
                            style={range === opt.days ? { background: accent } : {}}
                        >
                            {opt.label}
                        </button>
                    ))}
                </div>
            </div>
            
            <div className="h-[240px] relative z-10 mt-4">
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} barCategoryGap="20%" margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
                        <XAxis dataKey="shortDate" tick={{ fill: '#888', fontSize: 11, fontWeight: 600 }} axisLine={false} tickLine={false} dy={10} />
                        <YAxis tick={{ fill: '#888', fontSize: 11, fontWeight: 600 }} axisLine={false} tickLine={false} dx={-10} />
                        <Tooltip content={<CustomTooltip />} cursor={{ fill: '#ffffff0a' }} />
                        <Bar dataKey="sales" name="Sales" fill="#22c55e" stackId="a" />
                        <Bar dataKey="callbacks" name="Callbacks" fill="#eab308" stackId="a" />
                        <Bar dataKey="noAnswer" name="No Answer" fill="#6b7280" stackId="a" />
                        <Bar dataKey="hardNo" name="Hard No" fill="#ef4444" stackId="a" />
                        <Bar dataKey="other" name="Other" fill="#3b82f6" stackId="a" radius={[4, 4, 0, 0]} />
                    </BarChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}