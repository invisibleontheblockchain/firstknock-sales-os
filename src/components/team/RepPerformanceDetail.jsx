import React, { useMemo } from 'react';
import { 
    LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip, ResponsiveContainer,
    BarChart, Bar, Legend
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { base44 } from '@/api/base44Client';
import { Loader2, Lightbulb, TrendingUp, Target, Award } from 'lucide-react';

const BRAND = {
    gold: '#FFD700',
    charcoal: '#1F1F1F',
    voidBlack: '#0A0A0A',
    green: '#22c55e',
    blue: '#3b82f6'
};

export default function RepPerformanceDetail({ member, logs, teamAverage, onClose }) {
    
    // 1. Coaching Tips Query
    const { data: coaching, isLoading: tipsLoading } = useQuery({
        queryKey: ['coachingTips', member.id],
        queryFn: async () => {
            const res = await base44.functions.invoke('generateCoachingTips', { 
                repEmail: member.email, 
                repName: member.name 
            });
            return res.data;
        },
        staleTime: 1000 * 60 * 60 // 1 hour
    });

    // 2. Process Logs for Charts
    const chartData = useMemo(() => {
        // Group logs by date
        const grouped = {};
        logs
            .filter(l => l.created_by === member.email)
            .forEach(log => {
                const date = log.created_date.split('T')[0];
                if (!grouped[date]) grouped[date] = { date, knocks: 0, sales: 0 };
                grouped[date].knocks++;
                if (['SOLD', 'QUALIFIED'].includes(log.parsed_status)) grouped[date].sales++;
            });

        return Object.values(grouped)
            .sort((a, b) => new Date(a.date) - new Date(b.date))
            .map(d => ({
                ...d,
                conversion: d.knocks > 0 ? ((d.sales / d.knocks) * 100).toFixed(1) : 0
            }));
    }, [logs, member]);

    // 3. Stats vs Team Average
    const myStats = useMemo(() => {
        const myLogs = logs.filter(l => l.created_by === member.email);
        const total = myLogs.length;
        const sales = myLogs.filter(l => ['SOLD', 'QUALIFIED'].includes(l.parsed_status)).length;
        return {
            total,
            sales,
            conversion: total > 0 ? (sales / total * 100) : 0
        };
    }, [logs, member]);

    // 4. Completed Routes (History)
    const { data: completedRoutes = [] } = useQuery({
        queryKey: ['completedRoutes', member.id],
        queryFn: async () => {
            const res = await base44.entities.SavedRoute.filter({ 
                assigned_to: member.id,
                status: 'COMPLETED'
            }, '-updated_date', 50);
            return Array.isArray(res) ? res : (res?.items || []);
        }
    });

    return (
        <div className="space-y-3 md:space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-lg md:text-2xl font-bold text-white flex items-center gap-2">
                        {member.name}
                        <Badge variant="outline" className="text-yellow-500 border-yellow-500 text-[9px] md:text-xs">
                            {member.role.toUpperCase()}
                        </Badge>
                    </h2>
                    <p className="text-gray-400 text-xs md:text-sm">Performance Analysis</p>
                </div>
                <Button variant="ghost" onClick={onClose} className="text-gray-400 text-xs h-8">Close</Button>
            </div>

            {/* KPI Cards */}
            <div className="grid grid-cols-3 gap-2 md:gap-4">
                <Card className="bg-[#111] border-gray-800">
                    <CardContent className="p-2.5 md:p-4 flex items-center gap-2 md:gap-4">
                        <div className="p-2 md:p-3 bg-blue-500/10 rounded-full text-blue-500 shrink-0">
                            <Target className="w-4 h-4 md:w-6 md:h-6" />
                        </div>
                        <div className="min-w-0">
                            <p className="text-[9px] md:text-sm text-gray-400 truncate">Knocks</p>
                            <p className="text-lg md:text-2xl font-bold text-white">{myStats.total}</p>
                        </div>
                    </CardContent>
                </Card>
                <Card className="bg-[#111] border-gray-800">
                    <CardContent className="p-2.5 md:p-4 flex items-center gap-2 md:gap-4">
                        <div className="p-2 md:p-3 bg-green-500/10 rounded-full text-green-500 shrink-0">
                            <Award className="w-4 h-4 md:w-6 md:h-6" />
                        </div>
                        <div className="min-w-0">
                            <p className="text-[9px] md:text-sm text-gray-400 truncate">Sales</p>
                            <p className="text-lg md:text-2xl font-bold text-white">{myStats.sales}</p>
                        </div>
                    </CardContent>
                </Card>
                <Card className="bg-[#111] border-gray-800">
                    <CardContent className="p-2.5 md:p-4 flex items-center gap-2 md:gap-4">
                        <div className="p-2 md:p-3 bg-yellow-500/10 rounded-full text-yellow-500 shrink-0">
                            <TrendingUp className="w-4 h-4 md:w-6 md:h-6" />
                        </div>
                        <div className="min-w-0">
                            <p className="text-[9px] md:text-sm text-gray-400 truncate">Conv %</p>
                            <div className="flex items-baseline gap-1 md:gap-2 flex-wrap">
                                <p className="text-lg md:text-2xl font-bold text-white">{myStats.conversion.toFixed(1)}%</p>
                                <span className={`text-[8px] md:text-xs hidden md:inline ${myStats.conversion >= teamAverage.conversion ? 'text-green-500' : 'text-red-500'}`}>
                                    {myStats.conversion >= teamAverage.conversion ? '↑' : '↓'} Avg ({teamAverage.conversion.toFixed(1)}%)
                                </span>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Progress Chart */}
            <Card className="bg-[#111] border-gray-800">
                <CardHeader className="px-3 md:px-6 py-3 md:py-4">
                    <CardTitle className="text-xs md:text-sm font-bold text-gray-400 uppercase">Performance Trend</CardTitle>
                </CardHeader>
                <CardContent className="h-[200px] md:h-[300px] px-2 md:px-6">
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
                            <XAxis dataKey="date" stroke="#666" fontSize={10} interval="preserveStartEnd" />
                            <YAxis yAxisId="left" stroke="#666" fontSize={10} />
                            <YAxis yAxisId="right" orientation="right" stroke="#666" fontSize={10} />
                            <ReTooltip 
                                contentStyle={{ backgroundColor: '#000', border: '1px solid #333' }}
                                labelStyle={{ color: '#fff' }}
                            />
                            <Legend wrapperStyle={{ fontSize: '10px' }} />
                            <Line yAxisId="left" type="monotone" dataKey="knocks" stroke="#3b82f6" name="Knocks" strokeWidth={2} />
                            <Line yAxisId="right" type="monotone" dataKey="conversion" stroke="#22c55e" name="Conv %" strokeWidth={2} />
                        </LineChart>
                    </ResponsiveContainer>
                </CardContent>
            </Card>

            {/* AI Coaching */}
            <Card className="bg-gradient-to-br from-[#111] to-[#1a1a1a] border-yellow-500/30">
                <CardHeader className="px-3 md:px-6 py-3 md:py-4">
                    <CardTitle className="text-xs md:text-sm font-bold text-yellow-500 uppercase flex items-center gap-2">
                        <Lightbulb className="w-3.5 h-3.5 md:w-4 md:h-4" /> AI Coaching
                    </CardTitle>
                </CardHeader>
                <CardContent className="px-3 md:px-6 pb-3 md:pb-6">
                    {tipsLoading ? (
                        <div className="flex items-center gap-2 text-gray-400 text-xs">
                            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Analyzing...
                        </div>
                    ) : (
                        <ul className="space-y-2 md:space-y-3">
                            {coaching?.tips?.map((tip, idx) => (
                                <li key={idx} className="flex gap-2 md:gap-3 text-xs md:text-sm text-gray-300">
                                    <span className="w-4 h-4 md:w-5 md:h-5 rounded-full bg-yellow-500/20 text-yellow-500 flex items-center justify-center text-[9px] md:text-xs font-bold flex-shrink-0">
                                        {idx + 1}
                                    </span>
                                    {tip}
                                </li>
                            ))}
                        </ul>
                    )}
                </CardContent>
            </Card>

            {/* Completed Routes History */}
            <Card className="bg-[#111] border-gray-800">
                <CardHeader className="px-3 md:px-6 py-3 md:py-4">
                    <CardTitle className="text-xs md:text-sm font-bold text-gray-400 uppercase">Routes ({completedRoutes.length} Done)</CardTitle>
                </CardHeader>
                <CardContent className="px-3 md:px-6 pb-3 md:pb-6">
                    {completedRoutes.length === 0 ? (
                        <p className="text-xs text-gray-500 italic">No completed routes yet.</p>
                    ) : (
                        <div className="space-y-1.5 md:space-y-2 max-h-[250px] md:max-h-[300px] overflow-y-auto">
                            {completedRoutes.map(route => (
                                <div key={route.id} className="flex items-center justify-between p-2 md:p-3 bg-[#151515] rounded border border-gray-800">
                                    <div className="min-w-0">
                                        <p className="text-xs md:text-sm font-bold text-white truncate">{route.name}</p>
                                        <p className="text-[9px] md:text-xs text-gray-500">{new Date(route.updated_date).toLocaleDateString()} • {route.metrics?.house_count} doors</p>
                                    </div>
                                    <Badge variant="outline" className="border-green-900 text-green-500 bg-green-900/10 text-[8px] md:text-xs shrink-0">
                                        DONE
                                    </Badge>
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}