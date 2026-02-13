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
        <div className="bg-[#111] border border-gray-800/60 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-5">
                <div>
                    <h3 className="text-sm font-bold text-white">Daily Activity</h3>
                    <p className="text-[10px] text-gray-500 mt-0.5">{totalKnocks} knocks · {totalSales} sales</p>
                </div>
                <div className="flex p-0.5 bg-black/40 rounded-lg border border-gray-800/50">
                    {RANGE_OPTIONS.map(opt => (
                        <button
                            key={opt.days}
                            onClick={() => setRange(opt.days)}
                            className={`px-2.5 py-1 rounded-md text-[10px] font-bold transition-all ${
                                range === opt.days
                                    ? 'text-black shadow-sm'
                                    : 'text-gray-500 hover:text-white'
                            }`}
                            style={range === opt.days ? { background: accent } : {}}
                        >
                            {opt.label}
                        </button>
                    ))}
                </div>
            </div>
            <div className="h-[200px]">
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} barCategoryGap="25%">
                        <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" vertical={false} />
                        <XAxis dataKey="shortDate" tick={{ fill: '#555', fontSize: 10 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fill: '#555', fontSize: 10 }} axisLine={false} tickLine={false} width={28} />
                        <Tooltip content={<CustomTooltip />} cursor={{ fill: '#ffffff08' }} />
                        <Bar dataKey="sales" name="Sales" fill="#22c55e" stackId="a" />
                        <Bar dataKey="callbacks" name="Callbacks" fill="#eab308" stackId="a" />
                        <Bar dataKey="noAnswer" name="No Answer" fill="#6b7280" stackId="a" />
                        <Bar dataKey="hardNo" name="Hard No" fill="#ef4444" stackId="a" />
                        <Bar dataKey="other" name="Other" fill="#3b82f6" stackId="a" radius={[3, 3, 0, 0]} />
                    </BarChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}