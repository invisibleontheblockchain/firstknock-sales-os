import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';
import { TrendingUp } from 'lucide-react';
import { format, subDays, addDays, startOfDay, parseISO, differenceInDays } from 'date-fns';

export default function AppointmentForecast({ appointments }) {
    const { historyData, forecastData, combined, avgDaily, trend } = useMemo(() => {
        if (appointments.length === 0) return { historyData: [], forecastData: [], combined: [], avgDaily: 0, trend: 'flat' };

        // Build daily appointment counts for last 30 days
        const today = startOfDay(new Date());
        const days30 = [];
        for (let i = 29; i >= 0; i--) {
            const d = subDays(today, i);
            const key = format(d, 'yyyy-MM-dd');
            const dayAppts = appointments.filter(a => {
                if (!a.scheduled_date) return false;
                return format(new Date(a.scheduled_date), 'yyyy-MM-dd') === key;
            });
            days30.push({ date: key, label: format(d, 'MMM d'), count: dayAppts.length, type: 'actual' });
        }

        // Simple linear regression for trend
        const counts = days30.map(d => d.count);
        const n = counts.length;
        const sumX = (n * (n - 1)) / 2;
        const sumY = counts.reduce((a, b) => a + b, 0);
        const sumXY = counts.reduce((acc, y, x) => acc + x * y, 0);
        const sumX2 = Array.from({ length: n }, (_, i) => i * i).reduce((a, b) => a + b, 0);
        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        const intercept = (sumY - slope * sumX) / n;

        const dailyAvg = sumY / n;
        const trendDir = slope > 0.1 ? 'up' : slope < -0.1 ? 'down' : 'flat';

        // Forecast next 14 days
        const forecast = [];
        for (let i = 1; i <= 14; i++) {
            const d = addDays(today, i);
            const predicted = Math.max(0, Math.round(intercept + slope * (n + i - 1)));
            forecast.push({
                date: format(d, 'yyyy-MM-dd'),
                label: format(d, 'MMM d'),
                forecast: predicted,
                type: 'forecast',
            });
        }

        // Combine for chart (actual + forecast merged into one dataset)
        const combinedData = [
            ...days30.map(d => ({ ...d, forecast: null })),
            // Bridge point: last actual day also has forecast
            { ...days30[days30.length - 1], forecast: days30[days30.length - 1].count },
            ...forecast.map(d => ({ ...d, count: null })),
        ];

        return {
            historyData: days30,
            forecastData: forecast,
            combined: combinedData,
            avgDaily: Math.round(dailyAvg * 10) / 10,
            trend: trendDir,
        };
    }, [appointments]);

    const CustomTooltip = ({ active, payload, label }) => {
        if (!active || !payload?.length) return null;
        return (
            <div className="bg-black/95 border border-gray-700 p-3 rounded-xl shadow-xl text-xs">
                <p className="font-bold text-white mb-1">{label}</p>
                {payload.map((p, i) => (
                    <p key={i} style={{ color: p.color }}>
                        {p.name}: {p.value}
                    </p>
                ))}
            </div>
        );
    };

    const trendLabel = trend === 'up' ? '📈 Trending Up' : trend === 'down' ? '📉 Trending Down' : '➡️ Stable';
    const trendColor = trend === 'up' ? 'text-green-400' : trend === 'down' ? 'text-red-400' : 'text-gray-400';

    return (
        <Card className="bg-[#151515] border-gray-800">
            <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                    <CardTitle className="text-xs font-bold text-gray-400 flex items-center gap-2 uppercase">
                        <TrendingUp className="w-3.5 h-3.5" /> Appointment Volume Forecast
                    </CardTitle>
                    <div className="flex items-center gap-3">
                        <span className="text-[10px] text-gray-500">Avg: <span className="text-white font-bold">{avgDaily}/day</span></span>
                        <span className={`text-[10px] font-bold ${trendColor}`}>{trendLabel}</span>
                    </div>
                </div>
            </CardHeader>
            <CardContent className="h-[280px]">
                <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={combined}>
                        <defs>
                            <linearGradient id="actualGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                            </linearGradient>
                            <linearGradient id="forecastGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#FFD700" stopOpacity={0.3} />
                                <stop offset="95%" stopColor="#FFD700" stopOpacity={0} />
                            </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                        <XAxis dataKey="label" stroke="#555" fontSize={9} tickLine={false} interval="preserveStartEnd" />
                        <YAxis stroke="#555" fontSize={10} tickLine={false} allowDecimals={false} />
                        <Tooltip content={<CustomTooltip />} />
                        <Area type="monotone" dataKey="count" stroke="#3b82f6" strokeWidth={2} fill="url(#actualGrad)" name="Actual" connectNulls={false} />
                        <Area type="monotone" dataKey="forecast" stroke="#FFD700" strokeWidth={2} strokeDasharray="6 3" fill="url(#forecastGrad)" name="Forecast" connectNulls={false} />
                    </AreaChart>
                </ResponsiveContainer>
            </CardContent>
        </Card>
    );
}