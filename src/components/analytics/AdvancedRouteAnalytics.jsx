import React, { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
    LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip,
    ResponsiveContainer, Legend, AreaChart, Area, ComposedChart
} from 'recharts';
import { TrendingUp, Users, Clock, Zap, AlertCircle, Calendar } from 'lucide-react';
import { format, parseISO, getHours, getDay } from 'date-fns';

const BRAND = {
    gold: '#FFD700',
    voidBlack: '#0A0A0A',
    charcoal: '#1F1F1F',
    green: '#22c55e',
    blue: '#3b82f6',
    red: '#ef4444',
    purple: '#a855f7'
};

export default function AdvancedRouteAnalytics({ logs = [], routes = [], teamMembers = [] }) {
    const [timeRange, setTimeRange] = useState('30'); // days

    // --- 1. PERFORMANCE OVER TIME DATA ---
    const performanceTrend = useMemo(() => {
        const data = {};
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - parseInt(timeRange));

        logs.forEach(log => {
            if (new Date(log.created_date) < cutoff) return;

            const date = log.created_date.split('T')[0];
            if (!data[date]) data[date] = { date, knocks: 0, sales: 0 };

            data[date].knocks++;
            if (['SOLD', 'QUALIFIED'].includes(log.parsed_status)) {
                data[date].sales++;
            }
        });

        return Object.values(data)
            .sort((a, b) => new Date(a.date) - new Date(b.date))
            .map(d => ({
                ...d,
                dateDisplay: format(parseISO(d.date), 'MMM d'),
                conversion: d.knocks > 0 ? ((d.sales / d.knocks) * 100).toFixed(1) : 0
            }));
    }, [logs, timeRange]);

    // --- 2. REP COMPARISON DATA ---
    const repComparison = useMemo(() => {
        return teamMembers.map(rep => {
            const repLogs = logs.filter(l => l.created_by === rep.email);
            const knocks = repLogs.length;
            const sales = repLogs.filter(l => ['SOLD', 'QUALIFIED'].includes(l.parsed_status)).length;
            return {
                name: rep.name,
                knocks,
                sales,
                conversion: knocks > 0 ? (sales / knocks) * 100 : 0,
                color: rep.color || BRAND.gold
            };
        }).sort((a, b) => b.sales - a.sales);
    }, [teamMembers, logs]);

    // --- 3. TIME OPTIMIZATION DATA (Best Times) ---
    const timeOptimization = useMemo(() => {
        const hours = Array(24).fill(0).map((_, i) => ({ hour: i, knocks: 0, sales: 0 }));

        logs.forEach(log => {
            const date = new Date(log.created_date);
            const hour = getHours(date);
            hours[hour].knocks++;
            if (['SOLD', 'QUALIFIED'].includes(log.parsed_status)) {
                hours[hour].sales++;
            }
        });

        // Filter out hours with very low activity to avoid skewing conversion
        return hours
            .filter(h => h.hour >= 8 && h.hour <= 21) // Focus on reasonable knocking hours
            .map(h => ({
                ...h,
                hourLabel: format(new Date().setHours(h.hour), 'h a'),
                conversion: h.knocks > 10 ? (h.sales / h.knocks) * 100 : 0
            }));
    }, [logs]);

    // --- 4. AUTO-ASSIGN IMPACT DATA ---
    const autoAssignImpact = useMemo(() => {
        const autoReps = teamMembers.filter(m => m.auto_assign_enabled);
        const manualReps = teamMembers.filter(m => !m.auto_assign_enabled);

        const getAvgMetrics = (reps) => {
            if (reps.length === 0) return { knocks: 0, sales: 0, conversion: 0 };

            let totalKnocks = 0;
            let totalSales = 0;

            reps.forEach(rep => {
                const repLogs = logs.filter(l => l.created_by === rep.email);
                totalKnocks += repLogs.length;
                totalSales += repLogs.filter(l => ['SOLD', 'QUALIFIED'].includes(l.parsed_status)).length;
            });

            const avgKnocks = totalKnocks / reps.length;
            const avgSales = totalSales / reps.length;

            return {
                knocks: avgKnocks.toFixed(0),
                sales: avgSales.toFixed(1),
                conversion: totalKnocks > 0 ? ((totalSales / totalKnocks) * 100).toFixed(1) : 0
            };
        };

        return {
            auto: getAvgMetrics(autoReps),
            manual: getAvgMetrics(manualReps),
            autoCount: autoReps.length,
            manualCount: manualReps.length
        };
    }, [teamMembers, logs]);

    // --- 5. ROUTE PERFORMANCE DATA (A/B Testing) ---
    const routePerformance = useMemo(() => {
        // Group logs by route_id to see per-route conversion
        const routeMap = {};

        logs.forEach(log => {
            const rid = log.route_id;
            if (!rid) return; // Skip logs without a route_id (pre-tracking)

            if (!routeMap[rid]) {
                // Find the matching saved route for metadata
                const matchedRoute = routes.find(r => r.id === rid);
                routeMap[rid] = {
                    route_id: rid,
                    name: matchedRoute?.name || `Route ${rid.slice(-4)}`,
                    assigned_to: matchedRoute?.assigned_to_name || 'Unknown',
                    total_doors: matchedRoute?.property_hashes?.length || 0,
                    knocks: 0,
                    sales: 0,
                    no_answer: 0,
                    callbacks: 0,
                    hard_no: 0,
                    golden_doors: 0, // Doors that were recently sold (anchors)
                };
            }

            routeMap[rid].knocks++;
            if (['SOLD', 'QUALIFIED'].includes(log.parsed_status)) routeMap[rid].sales++;
            if (log.parsed_status === 'NO_ANSWER') routeMap[rid].no_answer++;
            if (log.parsed_status === 'CALLBACK') routeMap[rid].callbacks++;
            if (log.parsed_status === 'HARD_NO') routeMap[rid].hard_no++;
        });

        return Object.values(routeMap)
            .map(r => ({
                ...r,
                completion: r.total_doors > 0 ? Math.round((r.knocks / r.total_doors) * 100) : 0,
                conversion: r.knocks > 0 ? ((r.sales / r.knocks) * 100).toFixed(1) : '0.0',
                callback_rate: r.knocks > 0 ? ((r.callbacks / r.knocks) * 100).toFixed(1) : '0.0',
            }))
            .sort((a, b) => parseFloat(b.conversion) - parseFloat(a.conversion));
    }, [logs, routes]);

    const CustomTooltip = ({ active, payload, label }) => {
        if (active && payload && payload.length) {
            return (
                <div className="bg-black/90 border border-gray-800 p-2 rounded-lg shadow-xl text-xs">
                    <p className="font-bold text-white mb-1">{label}</p>
                    {payload.map((p, idx) => (
                        <p key={idx} style={{ color: p.color }}>
                            {p.name}: {typeof p.value === 'number' ? p.value.toFixed(1) : p.value}
                            {p.name.includes('Conversion') || p.name.includes('Rate') ? '%' : ''}
                        </p>
                    ))}
                </div>
            );
        }
        return null;
    };

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center">
                <h3 className="text-xl font-bold text-white flex items-center gap-2">
                    <TrendingUp className="w-5 h-5 text-yellow-500" /> Advanced Analytics
                </h3>
                <Select value={timeRange} onValueChange={setTimeRange}>
                    <SelectTrigger className="w-[140px] bg-[#111] border-gray-800 text-xs h-8">
                        <SelectValue placeholder="Time Range" />
                    </SelectTrigger>
                    <SelectContent className="bg-[#1F1F1F] border-gray-800 text-white">
                        <SelectItem value="7">Last 7 Days</SelectItem>
                        <SelectItem value="14">Last 14 Days</SelectItem>
                        <SelectItem value="30">Last 30 Days</SelectItem>
                        <SelectItem value="90">Last 90 Days</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            <Tabs defaultValue="routes" className="w-full">
                <TabsList className="bg-[#111] border border-gray-800 w-full justify-start p-1 h-10 mb-4 overflow-x-auto">
                    <TabsTrigger value="routes" className="text-xs data-[state=active]:bg-yellow-500 data-[state=active]:text-black">Route A/B</TabsTrigger>
                    <TabsTrigger value="trends" className="text-xs data-[state=active]:bg-yellow-500 data-[state=active]:text-black">Trends</TabsTrigger>
                    <TabsTrigger value="compare" className="text-xs data-[state=active]:bg-yellow-500 data-[state=active]:text-black">Comparison</TabsTrigger>
                    <TabsTrigger value="time" className="text-xs data-[state=active]:bg-yellow-500 data-[state=active]:text-black">Optimization</TabsTrigger>
                    <TabsTrigger value="impact" className="text-xs data-[state=active]:bg-yellow-500 data-[state=active]:text-black">Auto-Assign Impact</TabsTrigger>
                </TabsList>

                {/* --- 5. ROUTE A/B TESTING TAB --- */}
                <TabsContent value="routes" className="space-y-4">
                    {routePerformance.length === 0 ? (
                        <Card className="bg-[#111] border-gray-800">
                            <CardContent className="py-12 text-center">
                                <AlertCircle className="w-8 h-8 text-gray-700 mx-auto mb-3" />
                                <p className="text-gray-400 text-sm font-bold">No Route-Tagged Logs Yet</p>
                                <p className="text-gray-600 text-xs mt-1">Once reps start knocking with the updated app, per-route conversion data will appear here.</p>
                            </CardContent>
                        </Card>
                    ) : (
                        <>
                            <Card className="bg-[#111] border-gray-800">
                                <CardHeader>
                                    <CardTitle className="text-sm font-bold text-gray-400">Route Conversion Leaderboard</CardTitle>
                                    <CardDescription className="text-xs text-gray-500">Sorted by knock-to-sale conversion rate. Higher = better routing algorithm.</CardDescription>
                                </CardHeader>
                                <CardContent className="h-[350px]">
                                    <ResponsiveContainer width="100%" height="100%">
                                        <BarChart data={routePerformance.slice(0, 10)} layout="vertical" margin={{ left: 30 }}>
                                            <CartesianGrid strokeDasharray="3 3" stroke="#333" horizontal={false} />
                                            <XAxis type="number" stroke="#666" fontSize={12} />
                                            <YAxis type="category" dataKey="name" stroke="#fff" fontSize={11} width={100} />
                                            <ReTooltip content={<CustomTooltip />} />
                                            <Legend />
                                            <Bar dataKey="sales" fill={BRAND.gold} name="Sales" radius={[0, 4, 4, 0]} barSize={16} />
                                            <Bar dataKey="callbacks" fill={BRAND.blue} name="Callbacks" radius={[0, 4, 4, 0]} barSize={16} />
                                            <Bar dataKey="hard_no" fill={BRAND.purple} name="Not Interested" radius={[0, 4, 4, 0]} barSize={16} />
                                        </BarChart>
                                    </ResponsiveContainer>
                                </CardContent>
                            </Card>

                            {/* Route Performance Table */}
                            <Card className="bg-[#111] border-gray-800">
                                <CardHeader>
                                    <CardTitle className="text-sm font-bold text-gray-400">Detailed Route Metrics</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-xs">
                                            <thead>
                                                <tr className="border-b border-gray-800">
                                                    <th className="text-left py-2 text-gray-500 font-bold">Route</th>
                                                    <th className="text-left py-2 text-gray-500 font-bold">Rep</th>
                                                    <th className="text-center py-2 text-gray-500 font-bold">Doors</th>
                                                    <th className="text-center py-2 text-gray-500 font-bold">Knocked</th>
                                                    <th className="text-center py-2 text-gray-500 font-bold">Completion</th>
                                                    <th className="text-center py-2 text-gray-500 font-bold">Sales</th>
                                                    <th className="text-center py-2 text-gray-500 font-bold">Conversion</th>
                                                    <th className="text-center py-2 text-gray-500 font-bold">Callbacks</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {routePerformance.map(r => (
                                                    <tr key={r.route_id} className="border-b border-gray-800/50 hover:bg-white/[0.02]">
                                                        <td className="py-2.5 text-white font-bold">{r.name}</td>
                                                        <td className="py-2.5 text-gray-400">{r.assigned_to}</td>
                                                        <td className="py-2.5 text-center text-gray-400">{r.total_doors}</td>
                                                        <td className="py-2.5 text-center text-white font-bold">{r.knocks}</td>
                                                        <td className="py-2.5 text-center">
                                                            <span className={`font-bold ${r.completion >= 80 ? 'text-green-400' : r.completion >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>
                                                                {r.completion}%
                                                            </span>
                                                        </td>
                                                        <td className="py-2.5 text-center">
                                                            <span className="text-green-400 font-bold bg-green-500/10 px-2 py-0.5 rounded">{r.sales}</span>
                                                        </td>
                                                        <td className="py-2.5 text-center">
                                                            <span className={`font-bold ${parseFloat(r.conversion) > 5 ? 'text-green-400' : parseFloat(r.conversion) > 2 ? 'text-yellow-400' : 'text-gray-400'}`}>
                                                                {r.conversion}%
                                                            </span>
                                                        </td>
                                                        <td className="py-2.5 text-center text-blue-400 font-bold">{r.callbacks}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </CardContent>
                            </Card>
                        </>
                    )}
                </TabsContent>

                {/* --- 1. TRENDS TAB --- */}
                <TabsContent value="trends" className="space-y-4">
                    <Card className="bg-[#111] border-gray-800">
                        <CardHeader>
                            <CardTitle className="text-sm font-bold text-gray-400">Sales & Activity Volume</CardTitle>
                        </CardHeader>
                        <CardContent className="h-[300px]">
                            <ResponsiveContainer width="100%" height="100%">
                                <ComposedChart data={performanceTrend}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
                                    <XAxis dataKey="dateDisplay" stroke="#666" fontSize={12} tickLine={false} axisLine={false} />
                                    <YAxis yAxisId="left" stroke="#666" fontSize={12} tickLine={false} axisLine={false} />
                                    <YAxis yAxisId="right" orientation="right" stroke="#666" fontSize={12} tickLine={false} axisLine={false} unit="%" />
                                    <ReTooltip content={<CustomTooltip />} />
                                    <Legend />
                                    <Bar yAxisId="left" dataKey="knocks" fill="#333" name="Knocks" barSize={20} radius={[4, 4, 0, 0]} />
                                    <Line yAxisId="right" type="monotone" dataKey="conversion" stroke={BRAND.green} strokeWidth={2} name="Conversion Rate" dot={false} />
                                    <Line yAxisId="left" type="monotone" dataKey="sales" stroke={BRAND.gold} strokeWidth={2} name="Sales" dot={{ r: 4 }} />
                                </ComposedChart>
                            </ResponsiveContainer>
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* --- 2. COMPARE TAB --- */}
                <TabsContent value="compare" className="space-y-4">
                    <Card className="bg-[#111] border-gray-800">
                        <CardHeader>
                            <CardTitle className="text-sm font-bold text-gray-400">Rep Performance Comparison</CardTitle>
                        </CardHeader>
                        <CardContent className="h-[350px]">
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={repComparison} layout="vertical" margin={{ left: 20 }}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#333" horizontal={false} />
                                    <XAxis type="number" stroke="#666" fontSize={12} />
                                    <YAxis type="category" dataKey="name" stroke="#fff" fontSize={12} width={100} />
                                    <ReTooltip content={<CustomTooltip />} />
                                    <Legend />
                                    <Bar dataKey="sales" fill={BRAND.gold} name="Total Sales" radius={[0, 4, 4, 0]} barSize={20} />
                                    <Bar dataKey="knocks" fill="#333" name="Total Knocks" radius={[0, 4, 4, 0]} barSize={20} />
                                </BarChart>
                            </ResponsiveContainer>
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* --- 3. TIME OPTIMIZATION TAB --- */}
                <TabsContent value="time" className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <Card className="bg-[#111] border-gray-800 md:col-span-2">
                            <CardHeader>
                                <CardTitle className="text-sm font-bold text-gray-400 flex items-center gap-2">
                                    <Clock className="w-4 h-4 text-blue-500" /> Best Time to Knock (Conversion Rate by Hour)
                                </CardTitle>
                                <CardDescription className="text-xs text-gray-500">Based on historical sales data</CardDescription>
                            </CardHeader>
                            <CardContent className="h-[300px]">
                                <ResponsiveContainer width="100%" height="100%">
                                    <AreaChart data={timeOptimization}>
                                        <defs>
                                            <linearGradient id="colorConv" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor={BRAND.green} stopOpacity={0.3} />
                                                <stop offset="95%" stopColor={BRAND.green} stopOpacity={0} />
                                            </linearGradient>
                                        </defs>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
                                        <XAxis dataKey="hourLabel" stroke="#666" fontSize={12} tickLine={false} axisLine={false} />
                                        <YAxis stroke="#666" fontSize={12} tickLine={false} axisLine={false} unit="%" />
                                        <ReTooltip content={<CustomTooltip />} />
                                        <Area type="monotone" dataKey="conversion" stroke={BRAND.green} fillOpacity={1} fill="url(#colorConv)" name="Conversion Rate" />
                                        <Line type="monotone" dataKey="knocks" stroke="#444" strokeDasharray="3 3" name="Activity Volume" dot={false} />
                                    </AreaChart>
                                </ResponsiveContainer>
                            </CardContent>
                        </Card>
                    </div>
                </TabsContent>

                {/* --- 4. AUTO-ASSIGN IMPACT TAB --- */}
                <TabsContent value="impact" className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {/* Auto-Assign Group */}
                        <Card className="bg-gradient-to-br from-yellow-900/10 to-black border-yellow-500/30">
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-bold text-yellow-500 flex items-center gap-2">
                                    <Zap className="w-4 h-4" /> Auto-Assign Enabled
                                </CardTitle>
                                <CardDescription className="text-xs text-gray-400">{autoAssignImpact.autoCount} Reps</CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div>
                                    <p className="text-3xl font-bold text-white">{autoAssignImpact.auto.knocks}</p>
                                    <p className="text-xs text-gray-500 uppercase">Avg Total Knocks</p>
                                </div>
                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <p className="text-xl font-bold text-white">{autoAssignImpact.auto.sales}</p>
                                        <p className="text-xs text-gray-500 uppercase">Avg Sales</p>
                                    </div>
                                    <div>
                                        <p className="text-xl font-bold text-green-500">{autoAssignImpact.auto.conversion}%</p>
                                        <p className="text-xs text-gray-500 uppercase">Conversion</p>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>

                        {/* Manual Group */}
                        <Card className="bg-[#111] border-gray-800">
                            <CardHeader className="pb-2">
                                <CardTitle className="text-sm font-bold text-gray-400 flex items-center gap-2">
                                    <Users className="w-4 h-4" /> Manual Assignment
                                </CardTitle>
                                <CardDescription className="text-xs text-gray-500">{autoAssignImpact.manualCount} Reps</CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div>
                                    <p className="text-3xl font-bold text-white">{autoAssignImpact.manual.knocks}</p>
                                    <p className="text-xs text-gray-500 uppercase">Avg Total Knocks</p>
                                </div>
                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <p className="text-xl font-bold text-white">{autoAssignImpact.manual.sales}</p>
                                        <p className="text-xs text-gray-500 uppercase">Avg Sales</p>
                                    </div>
                                    <div>
                                        <p className="text-xl font-bold text-gray-400">{autoAssignImpact.manual.conversion}%</p>
                                        <p className="text-xs text-gray-500 uppercase">Conversion</p>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    <div className="bg-blue-900/10 border border-blue-900/30 p-4 rounded-lg flex items-start gap-3">
                        <AlertCircle className="w-5 h-5 text-blue-500 mt-0.5" />
                        <div>
                            <h4 className="font-bold text-blue-400 text-sm">Productivity Insight</h4>
                            <p className="text-xs text-gray-400 mt-1">
                                {Number(autoAssignImpact.auto.knocks) > Number(autoAssignImpact.manual.knocks)
                                    ? "Reps with Auto-Assign enabled are averaging more knocks per person. This suggests reduced downtime between routes."
                                    : "Auto-Assign reps have similar or lower volume. Consider checking route inventory quality."}
                            </p>
                        </div>
                    </div>
                </TabsContent>
            </Tabs>
        </div>
    );
}