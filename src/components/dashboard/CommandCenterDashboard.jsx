import React, { useState, useMemo } from 'react';
import { Button } from "@/components/ui/button";
import { BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line, CartesianGrid } from 'recharts';
import { Users, MapPin, TrendingUp, Activity, Target, X, Globe, Zap, Calendar as CalendarIcon, Clock, ChevronRight, Award, Trophy, Medal } from 'lucide-react';
import { format, subDays, parseISO, startOfDay, isAfter, isThisWeek, isThisMonth, isThisYear, isToday } from 'date-fns';

const COLORS = { gold: '#FFD700', green: '#22c55e', blue: '#3b82f6', purple: '#8b5cf6', red: '#ef4444' };
const CHART_COLORS = [COLORS.gold, COLORS.green, COLORS.blue, COLORS.purple, COLORS.red];

const TIME_FILTERS = [
    { id: 'today', label: 'Today' },
    { id: '7d', label: '7 Days' },
    { id: '30d', label: '30 Days' },
    { id: 'all', label: 'All Time' }
];

export default function CommandCenterDashboard({ properties, logs, routes, teamMembers = [], onClose }) {
    const [timeFilter, setTimeFilter] = useState('30d');

    const stats = useMemo(() => {
        const now = new Date();
        const startOfToday = startOfDay(now);
        const startOf7d = subDays(startOfToday, 7);
        const startOf30d = subDays(startOfToday, 30);

        // Filter Logs based on time Filter
        const filteredLogs = logs.filter(log => {
            if (!log.created_date) return false;
            const logDate = parseISO(log.created_date);
            if (timeFilter === 'today') return isToday(logDate);
            if (timeFilter === '7d') return isAfter(logDate, startOf7d);
            if (timeFilter === '30d') return isAfter(logDate, startOf30d);
            return true;
        });

        // KPI calculations
        const knocks = filteredLogs.length;
        const sales = filteredLogs.filter(l => ['SOLD', 'QUALIFIED'].includes(l.parsed_status)).length;
        const conversionRate = knocks > 0 ? ((sales / knocks) * 100).toFixed(1) : '0.0';

        // Active Reps in this time period
        const activeRepEmails = new Set(filteredLogs.map(l => l.created_by));
        const activeRepsCount = activeRepEmails.size;

        // Route Metrics
        const activeRoutes = routes.filter(r => ['IN_PROGRESS', 'ACTIVE'].includes(r.status));
        const totalRoutes = routes.length;

        // Rep Leaderboard
        const repStatsMap = {};
        filteredLogs.forEach(log => {
            const email = log.created_by || 'Unknown';
            if (!repStatsMap[email]) {
                // Try to find name in team members
                const member = teamMembers.find(m => m.email === email);
                repStatsMap[email] = {
                    email,
                    name: member ? member.name : email.split('@')[0],
                    knocks: 0,
                    sales: 0
                };
            }
            repStatsMap[email].knocks++;
            if (['SOLD', 'QUALIFIED'].includes(log.parsed_status)) {
                repStatsMap[email].sales++;
            }
        });

        const leaderboard = Object.values(repStatsMap).map(rep => ({
            ...rep,
            conversion: rep.knocks > 0 ? ((rep.sales / rep.knocks) * 100).toFixed(1) : '0.0'
        })).sort((a, b) => b.sales - a.sales || b.knocks - a.knocks);

        // Trend line (Trailing 14 days, static for visual stability, independent of top filter but let's align it)
        // If filter is today or 7d, we still show 14 days for context, or scale it. We'll stick to a 14-day trailing view
        // to always have a clean chart.
        const last14Days = Array.from({ length: 14 }, (_, i) => format(subDays(new Date(), 13 - i), 'yyyy-MM-dd'));
        const activityMap = logs.reduce((acc, log) => {
            if (!log.created_date) return acc;
            const day = format(parseISO(log.created_date), 'yyyy-MM-dd');
            if (!acc[day]) acc[day] = { knocks: 0, sales: 0 };
            acc[day].knocks++;
            if (['SOLD', 'QUALIFIED'].includes(log.parsed_status)) acc[day].sales++;
            return acc;
        }, {});
        
        const trendData = last14Days.map(day => ({ 
            date: format(parseISO(day), 'M/d'), 
            knocks: activityMap[day]?.knocks || 0, 
            sales: activityMap[day]?.sales || 0 
        }));

        // Territory (All time for properties state, since property status is current state)
        const zipStats = properties.reduce((acc, p) => {
            const zip = p.zip_code ? p.zip_code.slice(0, 5) : 'Unknown';
            if (!acc[zip]) acc[zip] = { zip, total: 0, knocked: 0, sales: 0 };
            acc[zip].total++;
            if (p.effective_status !== 'ELIGIBLE') acc[zip].knocked++;
            if (['SOLD', 'QUALIFIED'].includes(p.effective_status)) acc[zip].sales++;
            return acc;
        }, {});
        const zipData = Object.values(zipStats).sort((a, b) => b.total - a.total).slice(0, 5).map(z => ({
            ...z, 
            penetration: z.total > 0 ? ((z.knocked / z.total) * 100).toFixed(0) : 0, 
            conversion: z.knocked > 0 ? ((z.sales / z.knocked) * 100).toFixed(0) : 0
        }));

        return { 
            knocks, 
            sales, 
            conversionRate, 
            activeRepsCount, 
            trendData, 
            zipData, 
            totalRoutes, 
            activeRoutes,
            leaderboard
        };
    }, [properties, logs, routes, timeFilter, teamMembers]);

    if (!stats) return <div className="fixed inset-0 z-[5000] flex items-center justify-center bg-black text-white"><span className="text-sm text-gray-500">No data loaded</span></div>;

    const CustomTooltip = ({ active, payload, label }) => {
        if (!active || !payload?.length) return null;
        return (
            <div className="bg-[#111] border border-white/[0.08] p-2.5 rounded-xl shadow-2xl text-xs backdrop-blur-md">
                <p className="font-bold text-white mb-1.5">{label}</p>
                {payload.map((p, i) => <p key={i} style={{ color: p.color }} className="flex items-center justify-between gap-4">{p.name}: <span className="font-bold">{p.value}</span></p>)}
            </div>
        );
    };

    const kpis = [
        { label: 'Total Knocks', value: stats.knocks.toLocaleString(), icon: Target, color: '#3b82f6', bg: 'from-blue-500/20 to-blue-500/5' },
        { label: 'Sales/Leads', value: stats.sales.toLocaleString(), icon: Zap, color: '#FFD700', bg: 'from-yellow-400/20 to-yellow-400/5' },
        { label: 'Conversion', value: `${stats.conversionRate}%`, icon: TrendingUp, color: '#22c55e', bg: 'from-green-500/20 to-green-500/5' },
        { label: 'Active Reps', value: stats.activeRepsCount, icon: Users, color: '#8b5cf6', bg: 'from-purple-500/20 to-purple-500/5' },
    ];

    return (
        <div className="fixed inset-0 z-[5000] flex flex-col bg-[#050505] text-white overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between px-4 sm:px-8 py-4 border-b border-white/[0.04] bg-[#0A0A0A] shrink-0 gap-4">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-yellow-400/20 to-yellow-600/5 border border-yellow-500/20 flex items-center justify-center shadow-[0_0_15px_rgba(250,204,21,0.1)]">
                        <Globe className="w-5 h-5 text-yellow-400" />
                    </div>
                    <div>
                        <h1 className="text-lg font-black tracking-tight text-white flex items-center gap-2">Command Center</h1>
                        <p className="text-[11px] text-gray-500 font-medium">Analytics & Team Performance</p>
                    </div>
                </div>

                <div className="flex items-center gap-2 w-full sm:w-auto overflow-x-auto no-scrollbar pb-1 sm:pb-0">
                    <div className="flex bg-white/[0.03] p-1 rounded-xl border border-white/[0.05]">
                        {TIME_FILTERS.map(f => (
                            <button
                                key={f.id}
                                onClick={() => setTimeFilter(f.id)}
                                className={`px-4 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap transition-all ${
                                    timeFilter === f.id 
                                        ? 'bg-white text-black shadow-sm' 
                                        : 'text-gray-500 hover:text-white hover:bg-white/[0.05]'
                                }`}
                            >
                                {f.label}
                            </button>
                        ))}
                    </div>
                    <Button variant="ghost" size="icon" onClick={onClose} className="rounded-xl hover:bg-white/[0.08] ml-2 shrink-0 bg-white/[0.03] border border-white/[0.05]">
                        <X className="w-4 h-4 text-gray-400" />
                    </Button>
                </div>
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto">
                <div className="max-w-7xl mx-auto p-4 sm:p-8 space-y-4 sm:space-y-6 pb-20">

                    {/* KPI Cards */}
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
                        {kpis.map(k => (
                            <div key={k.label} className={`relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0D0D11] p-4 sm:p-5 group`}>
                                <div className={`absolute -right-10 -top-10 w-32 h-32 bg-gradient-to-br ${k.bg} blur-2xl rounded-full opacity-50 group-hover:opacity-100 transition-opacity`} />
                                <div className="relative z-10 flex items-start justify-between mb-3">
                                    <span className="text-xs font-bold uppercase tracking-wider text-gray-400">{k.label}</span>
                                    <div className="w-8 h-8 rounded-xl flex items-center justify-center bg-[#15151A] border border-white/[0.05] shadow-inner">
                                        <k.icon className="w-4 h-4" style={{ color: k.color }} />
                                    </div>
                                </div>
                                <p className="relative z-10 text-3xl font-black text-white tracking-tight">{k.value}</p>
                            </div>
                        ))}
                    </div>

                    {/* Bento Grid layout */}
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
                        
                        {/* 14-Day Trailing Activity (Spans 2 columns) */}
                        <div className="lg:col-span-2 rounded-3xl border border-white/[0.08] bg-[#0A0A0E] p-5 sm:p-6 flex flex-col shadow-xl shadow-black/50">
                            <div className="flex items-center justify-between mb-6">
                                <div className="flex items-center gap-2">
                                    <Activity className="w-4 h-4 text-blue-400" />
                                    <span className="text-xs font-bold text-white uppercase tracking-wider">Trailing 14-Day Activity</span>
                                </div>
                                <div className="flex items-center gap-3">
                                    <span className="flex items-center gap-1.5 text-[10px] font-bold text-gray-400 uppercase"><span className="w-2 h-2 rounded-full shadow-[0_0_8px_rgba(59,130,246,0.8)] bg-blue-500" />Knocks</span>
                                    <span className="flex items-center gap-1.5 text-[10px] font-bold text-gray-400 uppercase"><span className="w-2 h-2 rounded-full shadow-[0_0_8px_rgba(250,204,21,0.8)] bg-yellow-400" />Sales</span>
                                </div>
                            </div>
                            <div className="flex-1 min-h-[220px]">
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart data={stats.trendData}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" vertical={false} />
                                        <XAxis dataKey="date" stroke="#444" fontSize={10} tickLine={false} axisLine={false} dy={10} />
                                        <YAxis stroke="#444" fontSize={10} tickLine={false} axisLine={false} width={25} />
                                        <RechartsTooltip content={CustomTooltip} cursor={{ stroke: 'rgba(255,255,255,0.1)', strokeWidth: 1, strokeDasharray: '4 4' }} />
                                        <Line type="monotone" dataKey="knocks" stroke={COLORS.blue} strokeWidth={3} dot={{ r: 0 }} activeDot={{ r: 5, fill: COLORS.blue, stroke: '#000', strokeWidth: 2 }} name="Knocks" />
                                        <Line type="monotone" dataKey="sales" stroke={COLORS.gold} strokeWidth={3} dot={{ r: 0 }} activeDot={{ r: 5, fill: COLORS.gold, stroke: '#000', strokeWidth: 2 }} name="Sales" />
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>
                        </div>

                        {/* Active Routes Panel */}
                        <div className="rounded-3xl border border-white/[0.08] bg-[#0A0A0E] p-5 flex flex-col shadow-xl shadow-black/50">
                            <div className="flex items-center gap-2 mb-5">
                                <MapPin className="w-4 h-4 text-purple-400" />
                                <span className="text-xs font-bold text-white uppercase tracking-wider">Active Routes</span>
                                <span className="ml-auto text-xs font-bold text-gray-500 bg-white/[0.05] px-2 py-0.5 rounded-full">{stats.activeRoutes.length} running</span>
                            </div>
                            
                            <div className="flex-1 overflow-y-auto space-y-3 pb-2 pr-1 custom-scrollbar">
                                {stats.activeRoutes.length === 0 ? (
                                    <div className="h-full flex flex-col items-center justify-center text-center p-4 opacity-50">
                                        <Clock className="w-8 h-8 text-gray-500 mb-2" />
                                        <p className="text-sm font-bold text-gray-400">No active routes</p>
                                    </div>
                                ) : (
                                    stats.activeRoutes.map(route => {
                                        const total = route.metrics?.house_count || 0;
                                        const done = route.metrics?.knocked_count || 0;
                                        const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
                                        
                                        return (
                                            <div key={route.id} className="p-3 rounded-2xl bg-[#121216] border border-white/[0.03] hover:border-white/[0.08] transition-colors group cursor-pointer">
                                                <div className="flex justify-between items-start mb-2">
                                                    <div>
                                                        <h4 className="text-sm font-bold text-white truncate max-w-[180px]">{route.name}</h4>
                                                        <p className="text-[10px] text-purple-400/80 font-medium">Rep: {route.assigned_to_name || 'Unassigned'}</p>
                                                    </div>
                                                    <span className="text-[10px] font-bold text-gray-400">{pct}%</span>
                                                </div>
                                                <div className="h-1.5 w-full bg-black rounded-full overflow-hidden">
                                                    <div className="h-full bg-purple-500 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
                                                </div>
                                            </div>
                                        )
                                    })
                                )}
                            </div>
                        </div>

                    </div>

                    {/* Bottom row: Rep Leaderboard & Territory */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-6">
                        
                        {/* Rep Leaderboard */}
                        <div className="rounded-3xl border border-white/[0.08] bg-[#0A0A0E] overflow-hidden shadow-xl shadow-black/50 flex flex-col">
                            <div className="px-5 py-4 border-b border-white/[0.04] flex items-center gap-2 bg-[#0D0D12]">
                                <Trophy className="w-4 h-4 text-yellow-500" />
                                <span className="text-xs font-bold text-white uppercase tracking-wider">Rep Leaderboard</span>
                            </div>
                            
                            {stats.leaderboard.length === 0 ? (
                                <div className="p-8 text-center text-gray-500 opacity-60">
                                    <p className="text-sm font-bold">No activity in this timeframe</p>
                                </div>
                            ) : (
                                <div className="flex-1 overflow-x-auto">
                                    <table className="w-full text-left whitespace-nowrap">
                                        <thead className="text-[10px] text-gray-500 uppercase bg-[#08080C] border-b border-white/[0.04]">
                                            <tr>
                                                <th className="px-5 py-3 font-bold">Rank</th>
                                                <th className="px-5 py-3 font-bold">Rep Name</th>
                                                <th className="px-5 py-3 font-bold">Knocks</th>
                                                <th className="px-5 py-3 font-bold">Sales</th>
                                                <th className="px-5 py-3 font-bold">Conv %</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-white/[0.04]">
                                            {stats.leaderboard.map((rep, idx) => (
                                                <tr key={rep.email} className="hover:bg-white/[0.02] transition-colors">
                                                    <td className="px-5 py-3.5">
                                                        {idx === 0 ? <Medal className="w-5 h-5 text-yellow-400" /> : 
                                                         idx === 1 ? <Medal className="w-5 h-5 text-gray-300" /> : 
                                                         idx === 2 ? <Medal className="w-5 h-5 text-[#cd7f32]" /> : 
                                                         <span className="text-xs font-bold text-gray-600 pl-1.5">{idx + 1}</span>}
                                                    </td>
                                                    <td className="px-5 py-3.5">
                                                        <p className="text-sm font-bold text-white capitalize">{rep.name}</p>
                                                        <p className="text-[10px] text-gray-600 truncate max-w-[120px]">{rep.email}</p>
                                                    </td>
                                                    <td className="px-5 py-3.5 text-sm font-bold text-blue-400">{rep.knocks}</td>
                                                    <td className="px-5 py-3.5 text-sm font-bold text-green-400">{rep.sales}</td>
                                                    <td className="px-5 py-3.5 text-xs font-bold text-gray-400">{rep.conversion}%</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>

                        {/* Top Zip Codes Table */}
                        <div className="rounded-3xl border border-white/[0.08] bg-[#0A0A0E] overflow-hidden shadow-xl shadow-black/50 flex flex-col">
                            <div className="px-5 py-4 border-b border-white/[0.04] flex items-center gap-2 bg-[#0D0D12]">
                                <Globe className="w-4 h-4 text-emerald-500" />
                                <span className="text-xs font-bold text-white uppercase tracking-wider">Top Territories (All Time)</span>
                            </div>
                            
                            <div className="flex-1 overflow-x-auto">
                                <table className="w-full text-left whitespace-nowrap">
                                    <thead className="text-[10px] text-gray-500 uppercase bg-[#08080C] border-b border-white/[0.04]">
                                        <tr>
                                            <th className="px-5 py-3 font-bold">Zip Code</th>
                                            <th className="px-5 py-3 font-bold">Total Doors</th>
                                            <th className="px-5 py-3 font-bold">Penetration</th>
                                            <th className="px-5 py-3 font-bold">Sales</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-white/[0.04]">
                                        {stats.zipData.map((z, idx) => (
                                            <tr key={z.zip} className="hover:bg-white/[0.02] transition-colors">
                                                <td className="px-5 py-3.5 text-sm font-bold text-white">{z.zip}</td>
                                                <td className="px-5 py-3.5 text-xs font-medium text-gray-400">{z.total.toLocaleString()}</td>
                                                <td className="px-5 py-3.5">
                                                    <div className="flex items-center gap-3">
                                                        <div className="w-16 h-1.5 bg-[#1A1A22] rounded-full overflow-hidden shrink-0">
                                                            <div className="h-full bg-blue-500 rounded-full" style={{ width: `${z.penetration}%` }} />
                                                        </div>
                                                        <span className="text-[11px] font-bold text-blue-400">{z.penetration}%</span>
                                                    </div>
                                                </td>
                                                <td className="px-5 py-3.5 text-sm font-bold text-green-400">{z.sales}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>

                    </div>
                </div>
            </div>
        </div>
    );
}