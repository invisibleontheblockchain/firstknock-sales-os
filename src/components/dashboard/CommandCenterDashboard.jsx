import React, { useState, useMemo } from 'react';
import { Button } from "@/components/ui/button";
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip as RechartsTooltip } from 'recharts';
import { Users, MapPin, TrendingUp, Target, X, Globe, Zap, Clock, Trophy, Medal, PieChart as PieChartIcon } from 'lucide-react';
import { format, subDays, parseISO, startOfDay, isAfter, isToday } from 'date-fns';

const COLORS = { gold: '#FFD700', green: '#22c55e', blue: '#3b82f6', purple: '#8b5cf6', red: '#ef4444', orange: '#f97316' };
const CHART_COLORS = [COLORS.blue, COLORS.green, COLORS.gold, COLORS.orange, COLORS.purple, COLORS.red];

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

        // Status Mix (Pie Chart Data)
        const statusMap = filteredLogs.reduce((acc, log) => {
            const s = log.parsed_status || 'UNKNOWN';
            acc[s] = (acc[s] || 0) + 1;
            return acc;
        }, {});
        const pieData = Object.keys(statusMap)
            .map(key => ({ name: key.replace(/_/g, ' '), value: statusMap[key] }))
            .filter(d => d.value > 0)
            .sort((a, b) => b.value - a.value);

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
            pieData, 
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
            <div className="bg-[#111] border border-white/[0.08] p-2 rounded-lg shadow-2xl text-[10px] backdrop-blur-md">
                <p className="font-bold text-white mb-1">{label || payload[0].name}</p>
                {payload.map((p, i) => <p key={i} style={{ color: p.color || p.payload.fill }} className="flex items-center justify-between gap-3">Value: <span className="font-bold">{p.value}</span></p>)}
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
            <div className="flex flex-col sm:flex-row sm:items-center justify-between px-3 sm:px-6 lg:px-8 py-2 sm:py-3 lg:py-4 border-b border-white/[0.04] bg-[#0A0A0A] shrink-0 gap-3">
                <div className="flex items-center gap-2 lg:gap-3">
                    <div className="w-8 h-8 lg:w-10 lg:h-10 rounded-lg bg-gradient-to-br from-yellow-400/20 to-yellow-600/5 border border-yellow-500/20 flex items-center justify-center shadow-[0_0_10px_rgba(250,204,21,0.1)]">
                        <Globe className="w-4 h-4 lg:w-5 lg:h-5 text-yellow-400" />
                    </div>
                    <div>
                        <h1 className="text-sm lg:text-base font-black tracking-tight text-white flex items-center gap-1.5">Command Center</h1>
                        <p className="text-[9px] lg:text-[11px] text-gray-500 font-medium">Analytics & Team Performance</p>
                    </div>
                </div>

                <div className="flex items-center gap-1.5 w-full sm:w-auto overflow-x-auto no-scrollbar pb-1 sm:pb-0">
                    <div className="flex bg-white/[0.03] p-0.5 rounded-lg border border-white/[0.05]">
                        {TIME_FILTERS.map(f => (
                            <button
                                key={f.id}
                                onClick={() => setTimeFilter(f.id)}
                                className={`px-2.5 py-1 lg:px-3 lg:py-1.5 rounded-md text-[10px] lg:text-xs font-bold whitespace-nowrap transition-all ${
                                    timeFilter === f.id 
                                        ? 'bg-white text-black shadow-sm' 
                                        : 'text-gray-500 hover:text-white hover:bg-white/[0.05]'
                                }`}
                            >
                                {f.label}
                            </button>
                        ))}
                    </div>
                    <Button variant="ghost" size="icon" onClick={onClose} className="rounded-lg hover:bg-white/[0.08] ml-1 shrink-0 bg-white/[0.03] border border-white/[0.05] w-7 h-7 lg:w-8 lg:h-8">
                        <X className="w-3.5 h-3.5 lg:w-4 lg:h-4 text-gray-400" />
                    </Button>
                </div>
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto custom-scrollbar">
                {/* Setting a relaxed max width and padding on desktop to create a happy medium zoom */}
                <div className="w-full mx-auto p-3 lg:p-5 lg:max-w-7xl flex flex-col gap-3 lg:gap-5 pb-20">

                    {/* KPI Cards */}
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3 lg:gap-4">
                        {kpis.map(k => (
                            <div key={k.label} className="relative overflow-hidden rounded-xl lg:rounded-2xl border border-white/[0.06] bg-[#0D0D11] p-3 lg:p-5 group">
                                <div className={`absolute -right-6 -top-6 w-20 h-20 lg:w-24 lg:h-24 bg-gradient-to-br ${k.bg} blur-xl rounded-full opacity-50 group-hover:opacity-100 transition-opacity`} />
                                <div className="relative z-10 flex items-start justify-between mb-1.5 lg:mb-2">
                                    <span className="text-[9px] lg:text-[11px] font-bold uppercase tracking-wider text-gray-400">{k.label}</span>
                                    <div className="w-6 h-6 lg:w-8 lg:h-8 rounded-md flex items-center justify-center bg-[#15151A] border border-white/[0.05] shadow-inner">
                                        <k.icon className="w-3 h-3 lg:w-4 lg:h-4" style={{ color: k.color }} />
                                    </div>
                                </div>
                                <p className="relative z-10 text-xl lg:text-2xl font-black text-white tracking-tight">{k.value}</p>
                            </div>
                        ))}
                    </div>

                    {/* Row 1: Leaderboard (wider) + Status Mix + Active Routes */}
                    <div className="grid grid-cols-1 lg:grid-cols-4 gap-3 lg:gap-4">
                        
                        {/* Rep Leaderboard */}
                        <div className="lg:col-span-2 rounded-xl lg:rounded-2xl border border-white/[0.06] bg-[#0A0A0E] overflow-hidden shadow-lg flex flex-col">
                            <div className="px-3 py-2 lg:px-4 lg:py-3 border-b border-white/[0.04] flex items-center gap-1.5 lg:gap-2 bg-[#0D0D12]">
                                <Trophy className="w-3.5 h-3.5 lg:w-4 lg:h-4 text-yellow-500" />
                                <span className="text-[10px] lg:text-xs font-bold text-white uppercase tracking-wider">Rep Leaderboard</span>
                            </div>
                            
                            {stats.leaderboard.length === 0 ? (
                                <div className="p-6 text-center text-gray-500 opacity-60">
                                    <p className="text-[11px] lg:text-xs font-bold">No activity in this timeframe</p>
                                </div>
                            ) : (
                                <div className="flex-1 overflow-x-auto custom-scrollbar">
                                    <table className="w-full text-left whitespace-nowrap min-w-[400px]">
                                        <thead className="text-[9px] lg:text-[11px] text-gray-500 uppercase bg-[#08080C] border-b border-white/[0.04]">
                                            <tr>
                                                <th className="px-3 py-2 lg:px-4 lg:py-2.5 font-bold w-10">Rank</th>
                                                <th className="px-3 py-2 lg:px-4 lg:py-2.5 font-bold">Rep Name</th>
                                                <th className="px-3 py-2 lg:px-4 lg:py-2.5 font-bold">Knocks</th>
                                                <th className="px-3 py-2 lg:px-4 lg:py-2.5 font-bold">Sales</th>
                                                <th className="px-3 py-2 lg:px-4 lg:py-2.5 font-bold">Conv %</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-white/[0.04]">
                                            {stats.leaderboard.map((rep, idx) => (
                                                <tr key={rep.email} className="hover:bg-white/[0.02] transition-colors">
                                                    <td className="px-3 py-1.5 lg:px-4 lg:py-3">
                                                        {idx === 0 ? <Medal className="w-4 h-4 lg:w-4.5 lg:h-4.5 text-yellow-400" /> : 
                                                         idx === 1 ? <Medal className="w-4 h-4 lg:w-4.5 lg:h-4.5 text-gray-300" /> : 
                                                         idx === 2 ? <Medal className="w-4 h-4 lg:w-4.5 lg:h-4.5 text-[#cd7f32]" /> : 
                                                         <span className="text-[10px] lg:text-xs font-bold text-gray-600 pl-1">{idx + 1}</span>}
                                                    </td>
                                                    <td className="px-3 py-1.5 lg:px-4 lg:py-3">
                                                        <p className="text-[11px] lg:text-[13px] font-bold text-white capitalize">{rep.name}</p>
                                                        <p className="text-[9px] lg:text-[11px] text-gray-600 truncate max-w-[100px] lg:max-w-[150px]">{rep.email}</p>
                                                    </td>
                                                    <td className="px-3 py-1.5 lg:px-4 lg:py-3 text-[11px] lg:text-[13px] font-bold text-blue-400">{rep.knocks}</td>
                                                    <td className="px-3 py-1.5 lg:px-4 lg:py-3 text-[11px] lg:text-[13px] font-bold text-green-400">{rep.sales}</td>
                                                    <td className="px-3 py-1.5 lg:px-4 lg:py-3 text-[10px] lg:text-xs font-bold text-gray-400">{rep.conversion}%</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>

                        {/* Status Mix Pie Chart */}
                        <div className="rounded-xl lg:rounded-2xl border border-white/[0.06] bg-[#0A0A0E] p-3 lg:p-4 flex flex-col shadow-lg">
                            <div className="flex items-center gap-1.5 lg:gap-2 mb-2 lg:mb-3">
                                <PieChartIcon className="w-3.5 h-3.5 lg:w-4 lg:h-4 text-blue-400" />
                                <span className="text-[10px] lg:text-xs font-bold text-white uppercase tracking-wider">Status Mix</span>
                            </div>
                            <div className="flex-1 min-h-[160px] lg:min-h-[180px] relative mt-1">
                                {stats.pieData.length === 0 ? (
                                    <div className="absolute inset-0 flex items-center justify-center text-[10px] text-gray-500 font-bold">No logs</div>
                                ) : (
                                    <ResponsiveContainer width="100%" height="100%">
                                        <PieChart>
                                            <Pie 
                                                data={stats.pieData} 
                                                cx="50%" cy="50%" 
                                                innerRadius={40} outerRadius={60} 
                                                paddingAngle={3} dataKey="value"
                                                stroke="none"
                                            >
                                                {stats.pieData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                                            </Pie>
                                            <RechartsTooltip content={CustomTooltip} />
                                        </PieChart>
                                    </ResponsiveContainer>
                                )}
                                {stats.pieData.length > 0 && (
                                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                        <div className="text-center">
                                            <p className="text-sm lg:text-xl font-black text-white">{stats.knocks.toLocaleString()}</p>
                                            <p className="text-[7px] lg:text-[9px] font-bold text-gray-500 tracking-wider">KNOCKS</p>
                                        </div>
                                    </div>
                                )}
                            </div>
                            {/* Scrollable mini legend */}
                            <div className="grid grid-cols-2 gap-x-2 lg:gap-x-3 gap-y-1 lg:gap-y-1.5 mt-2 lg:mt-3 max-h-[40px] lg:max-h-[60px] overflow-y-auto custom-scrollbar pr-1">
                                {stats.pieData.map((d, i) => (
                                    <div key={d.name} className="flex items-center gap-1 lg:gap-1.5 text-[8px] lg:text-[10px] font-medium text-gray-400">
                                        <span className="w-1.5 h-1.5 lg:w-2 lg:h-2 rounded-full shrink-0" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
                                        <span className="truncate max-w-[50px] lg:max-w-[70px]">{d.name}</span>
                                        <span className="ml-auto font-bold text-gray-300">{d.value}</span>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Active Routes Panel */}
                        <div className="rounded-xl lg:rounded-2xl border border-white/[0.06] bg-[#0A0A0E] p-3 lg:p-4 flex flex-col shadow-lg">
                            <div className="flex items-center gap-1.5 lg:gap-2 mb-3 lg:mb-4">
                                <MapPin className="w-3.5 h-3.5 lg:w-4 lg:h-4 text-purple-400" />
                                <span className="text-[10px] lg:text-xs font-bold text-white uppercase tracking-wider">Active Routes</span>
                                <span className="ml-auto text-[9px] lg:text-[11px] font-bold text-gray-500 bg-white/[0.05] px-1.5 py-0.5 lg:px-2 lg:py-1 rounded-md">{stats.activeRoutes.length}</span>
                            </div>
                            
                            <div className="flex-1 overflow-y-auto space-y-2 lg:space-y-3 pr-1 custom-scrollbar min-h-[140px] lg:min-h-[160px] max-h-[160px] lg:max-h-[200px]">
                                {stats.activeRoutes.length === 0 ? (
                                    <div className="h-full flex flex-col items-center justify-center text-center p-2 opacity-50">
                                        <Clock className="w-5 h-5 lg:w-6 lg:h-6 text-gray-500 mb-1 lg:mb-2" />
                                        <p className="text-[10px] lg:text-[11px] font-bold text-gray-400">No active routes</p>
                                    </div>
                                ) : (
                                    stats.activeRoutes.map(route => {
                                        const total = route.metrics?.house_count || 0;
                                        const done = route.metrics?.knocked_count || 0;
                                        const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
                                        
                                        return (
                                            <div key={route.id} className="p-2 lg:p-3 rounded-xl lg:rounded-2xl bg-[#121216] border border-white/[0.03] hover:border-white/[0.08] transition-colors group cursor-pointer">
                                                <div className="flex justify-between items-start mb-1.5 lg:mb-2">
                                                    <div className="overflow-hidden pr-2">
                                                        <h4 className="text-[10px] lg:text-[13px] font-bold text-white truncate max-w-[120px] lg:max-w-[160px]">{route.name}</h4>
                                                        <p className="text-[8px] lg:text-[10px] text-purple-400/80 font-medium">Rep: {route.assigned_to_name || 'Unassigned'}</p>
                                                    </div>
                                                    <span className="text-[9px] lg:text-[11px] font-bold text-gray-400 shrink-0">{pct}%</span>
                                                </div>
                                                <div className="h-1 lg:h-1.5 w-full bg-black rounded-full overflow-hidden mt-0.5 lg:mt-1.5">
                                                    <div className="h-full bg-purple-500 rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
                                                </div>
                                            </div>
                                        )
                                    })
                                )}
                            </div>
                        </div>

                    </div>

                    {/* Row 2: Top Zip Codes (spans 4 on lg) or maybe just 2 */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 lg:gap-4">
                        {/* Top Zip Codes Table */}
                        <div className="rounded-xl lg:rounded-2xl border border-white/[0.06] bg-[#0A0A0E] overflow-hidden shadow-lg flex flex-col">
                            <div className="px-3 py-2 lg:px-4 lg:py-3 border-b border-white/[0.04] flex items-center gap-1.5 lg:gap-2 bg-[#0D0D12]">
                                <Globe className="w-3.5 h-3.5 lg:w-4 lg:h-4 text-emerald-500" />
                                <span className="text-[10px] lg:text-xs font-bold text-white uppercase tracking-wider">Top Territories</span>
                            </div>
                            
                            <div className="flex-1 overflow-x-auto custom-scrollbar">
                                <table className="w-full text-left whitespace-nowrap min-w-[300px]">
                                    <thead className="text-[9px] lg:text-[11px] text-gray-500 uppercase bg-[#08080C] border-b border-white/[0.04]">
                                        <tr>
                                            <th className="px-3 py-2 lg:px-4 lg:py-2.5 font-bold">Zip Code</th>
                                            <th className="px-3 py-2 lg:px-4 lg:py-2.5 font-bold">Total Doors</th>
                                            <th className="px-3 py-2 lg:px-4 lg:py-2.5 font-bold">Penetration</th>
                                            <th className="px-3 py-2 lg:px-4 lg:py-2.5 font-bold">Sales</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-white/[0.04]">
                                        {stats.zipData.map((z, idx) => (
                                            <tr key={z.zip} className="hover:bg-white/[0.02] transition-colors">
                                                <td className="px-3 py-1.5 lg:px-4 lg:py-3 text-[11px] lg:text-[13px] font-bold text-white">{z.zip}</td>
                                                <td className="px-3 py-1.5 lg:px-4 lg:py-3 text-[10px] lg:text-[12px] font-medium text-gray-400">{z.total.toLocaleString()}</td>
                                                <td className="px-3 py-1.5 lg:px-4 lg:py-3">
                                                    <div className="flex items-center gap-2 lg:gap-3">
                                                        <div className="w-12 h-1 lg:w-16 lg:h-1.5 bg-[#1A1A22] rounded-full overflow-hidden shrink-0">
                                                            <div className="h-full bg-blue-500 rounded-full" style={{ width: `${z.penetration}%` }} />
                                                        </div>
                                                        <span className="text-[9px] lg:text-[11px] font-bold text-blue-400">{z.penetration}%</span>
                                                    </div>
                                                </td>
                                                <td className="px-3 py-1.5 lg:px-4 lg:py-3 text-[11px] lg:text-[13px] font-bold text-green-400">{z.sales}</td>
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