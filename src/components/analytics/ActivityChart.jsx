import React, { useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, AreaChart, Area } from 'recharts';
import { format, subDays, startOfDay } from 'date-fns';

export default function ActivityChart({ logs, days = 14 }) {
    const chartData = useMemo(() => {
        const now = new Date();
        const data = [];

        for (let i = days - 1; i >= 0; i--) {
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
            const other = dayLogs.length - sales - callbacks - noAnswer - hardNo;

            data.push({
                date: format(day, 'MMM d'),
                shortDate: format(day, 'E'),
                total: dayLogs.length,
                sales,
                callbacks,
                noAnswer,
                hardNo,
                other: Math.max(0, other),
            });
        }
        return data;
    }, [logs, days]);

    const CustomTooltip = ({ active, payload, label }) => {
        if (!active || !payload) return null;
        return (
            <div className="bg-[#1A1A1A] border border-gray-700 rounded-lg p-3 shadow-xl">
                <p className="text-xs font-bold text-white mb-1">{label}</p>
                {payload.map((p, i) => (
                    <p key={i} className="text-[10px]" style={{ color: p.color }}>
                        {p.name}: {p.value}
                    </p>
                ))}
            </div>
        );
    };

    return (
        <div className="bg-[#151515] border border-gray-800 rounded-xl p-4">
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-white">Daily Activity</h3>
                <span className="text-[10px] text-gray-500">Last {days} days</span>
            </div>
            <div className="h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} barCategoryGap="20%">
                        <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                        <XAxis dataKey="shortDate" tick={{ fill: '#666', fontSize: 10 }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fill: '#666', fontSize: 10 }} axisLine={false} tickLine={false} width={30} />
                        <Tooltip content={<CustomTooltip />} />
                        <Bar dataKey="sales" name="Sales" fill="#22c55e" stackId="a" radius={[0, 0, 0, 0]} />
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