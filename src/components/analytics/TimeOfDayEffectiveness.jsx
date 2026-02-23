import React, { useMemo } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { Clock } from 'lucide-react';
import { useTheme } from '@/components/theme/ThemeProvider';

export default function TimeOfDayEffectiveness({ logs }) {
    const { accent } = useTheme();

    const chartData = useMemo(() => {
        if (!logs || logs.length === 0) return [];
        
        const hourStats = {};
        // 8 AM to 8 PM
        for (let i = 8; i <= 20; i++) {
            hourStats[i] = { hour: i, total: 0, contacts: 0, sales: 0 };
        }

        logs.forEach(log => {
            if (!log.created_date) return;
            const d = new Date(log.created_date);
            const hour = d.getHours();
            
            if (hour >= 8 && hour <= 20) {
                hourStats[hour].total++;
                if (!['NO_ANSWER', 'ELIGIBLE'].includes(log.parsed_status)) {
                    hourStats[hour].contacts++;
                }
                if (['SOLD', 'QUALIFIED'].includes(log.parsed_status)) {
                    hourStats[hour].sales++;
                }
            }
        });

        return Object.values(hourStats).map(stat => ({
            timeLabel: new Date(0, 0, 0, stat.hour, 0).toLocaleTimeString('en-US', { hour: 'numeric' }),
            total: stat.total,
            contactRate: stat.total > 0 ? Math.round((stat.contacts / stat.total) * 100) : 0,
            saleRate: stat.total > 0 ? Math.round((stat.sales / stat.total) * 100) : 0,
        }));
    }, [logs]);

    const CustomTooltip = ({ active, payload, label }) => {
        if (!active || !payload?.length) return null;
        const d = payload[0]?.payload;
        return (
            <div className="bg-black/95 border border-gray-700 p-3 rounded-xl shadow-xl text-xs">
                <p className="font-bold text-white mb-1">{label}</p>
                <p className="text-gray-400">Total Knocks: {d?.total}</p>
                <p className="text-blue-400">Contact Rate: {d?.contactRate}%</p>
                <p className="text-green-400">Conversion Rate: {d?.saleRate}%</p>
            </div>
        );
    };

    return (
        <div className="relative bg-gradient-to-b from-[#151515] to-[#0A0A0A] border border-white/5 rounded-3xl p-6 shadow-2xl overflow-hidden">
            <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            <div className="absolute -top-24 -left-24 w-64 h-64 bg-blue-500/10 blur-[100px] rounded-full pointer-events-none" />
            
            <div className="flex items-center justify-between mb-6 relative z-10">
                <div>
                    <h3 className="text-lg font-black text-transparent bg-clip-text bg-gradient-to-r from-white to-gray-400 tracking-tight flex items-center gap-3">
                        <div className="p-2 rounded-xl bg-blue-500/20 border border-blue-500/40">
                            <Clock className="w-5 h-5 text-blue-400 drop-shadow-[0_0_10px_rgba(59,130,246,0.5)]" />
                        </div>
                        Best Time to Knock
                    </h3>
                    <p className="text-xs text-gray-500 mt-1 font-medium tracking-wide">
                        Contact & Conversion rates by hour of day
                    </p>
                </div>
            </div>
            
            <div className="h-[240px] relative z-10 mt-4">
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} margin={{ top: 10, right: 0, left: -20, bottom: 0 }} barCategoryGap="20%">
                        <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
                        <XAxis dataKey="timeLabel" stroke="#888" fontSize={10} fontWeight={600} tickLine={false} dy={10} />
                        <YAxis stroke="#888" fontSize={11} fontWeight={600} tickLine={false} unit="%" dx={-10} />
                        <Tooltip content={<CustomTooltip />} cursor={{ fill: '#ffffff0a' }} />
                        <Bar dataKey="contactRate" name="Contact %" fill="#3b82f6" radius={[4, 4, 0, 0]} style={{ filter: 'drop-shadow(0 0 5px rgba(59,130,246,0.3))' }} />
                        <Bar dataKey="saleRate" name="Sale %" fill="#22c55e" radius={[4, 4, 0, 0]} style={{ filter: 'drop-shadow(0 0 5px rgba(34,197,94,0.3))' }} />
                    </BarChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}