import React, { useMemo } from 'react';
import { ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { Clock } from 'lucide-react';
import { useTheme } from '@/components/theme/ThemeProvider';

export default function TimeOfDayEffectiveness({ logs }) {
    const { accent } = useTheme();

    const chartData = useMemo(() => {
        if (!logs || logs.length === 0) return [];
        
        const hourStats = {};
        // 8 AM to 8 PM
        for (let i = 8; i <= 20; i++) {
            hourStats[i] = { hour: i, knocks: 0, contacts: 0, sales: 0 };
        }

        logs.forEach(log => {
            if (!log.created_date) return;
            const d = new Date(log.created_date);
            const hour = d.getHours();
            
            if (hour >= 8 && hour <= 20) {
                hourStats[hour].knocks++;
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
            knocks: stat.knocks,
            contacts: stat.contacts,
            contactRate: stat.knocks > 0 ? Math.round((stat.contacts / stat.knocks) * 100) : 0,
            pitchConv: stat.contacts > 0 ? Math.round((stat.sales / stat.contacts) * 100) : 0,
        }));
    }, [logs]);

    const CustomTooltip = ({ active, payload, label }) => {
        if (!active || !payload?.length) return null;
        const d = payload[0]?.payload;
        return (
            <div className="bg-black/95 border border-gray-700 p-3 rounded-xl shadow-xl text-xs min-w-[160px]">
                <p className="font-bold text-white mb-2 pb-2 border-b border-gray-800">{label}</p>
                <div className="grid grid-cols-2 gap-y-1.5">
                    <span className="text-gray-400">Total Knocks:</span>
                    <span className="text-white font-bold text-right">{d?.knocks}</span>
                    
                    <span className="text-gray-400">Contacts:</span>
                    <span className="text-blue-400 font-bold text-right">{d?.contacts}</span>
                    
                    <span className="text-gray-400">Contact Rate:</span>
                    <span className="text-yellow-400 font-bold text-right">{d?.contactRate}%</span>
                    
                    <span className="text-gray-400">Pitch Conv:</span>
                    <span className="text-green-400 font-bold text-right">{d?.pitchConv}%</span>
                </div>
            </div>
        );
    };

    return (
        <div className="relative bg-gradient-to-b from-[#151515] to-[#0A0A0A] border border-white/5 rounded-xl md:rounded-2xl p-3 md:p-5 shadow-2xl overflow-hidden">
            <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            <div className="absolute -top-24 -left-24 w-64 h-64 bg-blue-500/10 blur-[100px] rounded-full pointer-events-none" />
            
            <div className="flex items-center justify-between mb-3 md:mb-4 relative z-10">
                <div>
                    <h3 className="text-sm md:text-base font-black text-transparent bg-clip-text bg-gradient-to-r from-white to-gray-400 tracking-tight flex items-center gap-2">
                        <div className="p-1 md:p-1.5 rounded-lg bg-blue-500/20 border border-blue-500/40">
                            <Clock className="w-3.5 h-3.5 md:w-4 md:h-4 text-blue-400 drop-shadow-[0_0_10px_rgba(59,130,246,0.5)]" />
                        </div>
                        Time of Day
                    </h3>
                    <p className="text-[10px] md:text-xs text-gray-500 mt-0.5 md:mt-1 font-medium tracking-wide">
                        Volume vs. Contact Rate by hour
                    </p>
                </div>
            </div>
            
            <div className="h-[180px] md:h-[240px] relative z-10 mt-1 md:mt-2">
                <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" vertical={false} />
                        <XAxis dataKey="timeLabel" stroke="#888" fontSize={10} fontWeight={600} tickLine={false} dy={10} />
                        
                        <YAxis yAxisId="left" stroke="#555" fontSize={10} fontWeight={600} tickLine={false} dx={-10} axisLine={false} />
                        <YAxis yAxisId="right" orientation="right" stroke="#eab308" fontSize={10} fontWeight={600} tickLine={false} unit="%" dx={10} axisLine={false} />
                        
                        <Tooltip content={<CustomTooltip />} cursor={{ fill: '#ffffff0a' }} />
                        <Legend wrapperStyle={{ fontSize: '11px', fontWeight: 600, color: '#aaa', paddingTop: '15px' }} />
                        
                        <Bar yAxisId="left" dataKey="knocks" name="Total Knocks" fill="#333333" radius={[4, 4, 0, 0]} barSize={24} />
                        <Line yAxisId="right" type="monotone" dataKey="contactRate" name="Contact Rate %" stroke="#eab308" strokeWidth={3} dot={{ r: 4, fill: '#eab308', strokeWidth: 2, stroke: '#000' }} activeDot={{ r: 6 }} style={{ filter: 'drop-shadow(0 4px 6px rgba(234,179,8,0.4))' }} />
                    </ComposedChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}