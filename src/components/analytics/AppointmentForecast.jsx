import React, { useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { TrendingUp } from 'lucide-react';
import { format, subDays, addDays, startOfDay } from 'date-fns';

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
        <div className="relative bg-gradient-to-b from-[#151515] to-[#0A0A0A] border border-white/5 rounded-2xl p-5 shadow-2xl overflow-hidden">
            <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            <div className="absolute -top-24 -right-24 w-64 h-64 bg-yellow-500/10 blur-[100px] rounded-full pointer-events-none" />
            
            <div className="flex items-center justify-between mb-4 relative z-10">
                <h3 className="text-base font-black text-transparent bg-clip-text bg-gradient-to-r from-white to-gray-400 tracking-tight flex items-center gap-2">
                    <div className="p-1.5 rounded-lg bg-yellow-500/20 border border-yellow-500/40">
                        <TrendingUp className="w-4 h-4 text-yellow-400 drop-shadow-[0_0_10px_rgba(255,215,0,0.5)]" />
                    </div>
                    Volume Forecast
                </h3>
                <div className="flex items-center gap-3 bg-black/60 backdrop-blur-md rounded-lg border border-white/10 px-3 py-1.5 shadow-inner">
                    <span className="text-[10px] font-bold text-gray-400">Avg: <span className="text-white drop-shadow-sm">{avgDaily}/day</span></span>
                    <div className="w-px h-3 bg-white/20" />
                    <span className={`text-[10px] font-black drop-shadow-sm ${trendColor}`}>{trendLabel}</span>
                </div>
            </div>
            
            <div className="h-[240px] relative z-10 mt-2">
                <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={combined} margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
                        <defs>
                            <linearGradient id="actualGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4} />
                                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                            </linearGradient>
                            <linearGradient id="forecastGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#FFD700" stopOpacity={0.4} />
                                <stop offset="95%" stopColor="#FFD700" stopOpacity={0} />
                            </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
                        <XAxis dataKey="label" stroke="#888" fontSize={11} fontWeight={600} tickLine={false} interval="preserveStartEnd" dy={10} />
                        <YAxis stroke="#888" fontSize={11} fontWeight={600} tickLine={false} allowDecimals={false} dx={-10} />
                        <Tooltip content={<CustomTooltip />} />
                        <Area type="monotone" dataKey="count" stroke="#3b82f6" strokeWidth={3} fill="url(#actualGrad)" name="Actual" connectNulls={false} style={{ filter: 'drop-shadow(0 0 5px rgba(59,130,246,0.3))' }} />
                        <Area type="monotone" dataKey="forecast" stroke="#FFD700" strokeWidth={3} strokeDasharray="6 4" fill="url(#forecastGrad)" name="Forecast" connectNulls={false} style={{ filter: 'drop-shadow(0 0 5px rgba(255,215,0,0.3))' }} />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}