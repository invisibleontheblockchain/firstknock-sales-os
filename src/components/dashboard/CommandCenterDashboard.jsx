import React, { useMemo } from 'react';
import { Button } from "@/components/ui/button";
import { BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line, CartesianGrid } from 'recharts';
import { Users, MapPin, TrendingUp, Activity, Target, X, Globe, Zap } from 'lucide-react';
import { format, subDays, parseISO } from 'date-fns';

const COLORS = { gold: '#FFD700', green: '#22c55e', blue: '#3b82f6', purple: '#8b5cf6', red: '#ef4444' };
const CHART_COLORS = [COLORS.gold, COLORS.green, COLORS.blue, COLORS.purple, COLORS.red];

export default function CommandCenterDashboard({ properties, logs, routes, teamMembers, onClose }) {

    const stats = useMemo(() => {
        const totalProperties = properties.length;
        if (totalProperties === 0) return null;

        const statusCounts = properties.reduce((acc, p) => {
            const s = p.effective_status || 'ELIGIBLE';
            acc[s] = (acc[s] || 0) + 1;
            return acc;
        }, {});

        const knockedCount = totalProperties - (statusCounts['ELIGIBLE'] || 0);
        const penetrationRate = ((knockedCount / totalProperties) * 100).toFixed(1);
        const salesCount = (statusCounts['SOLD'] || 0) + (statusCounts['QUALIFIED'] || 0);
        const conversionRate = knockedCount > 0 ? ((salesCount / knockedCount) * 100).toFixed(1) : 0;

        const pieData = Object.keys(statusCounts).map(key => ({ name: key.replace('_', ' '), value: statusCounts[key] })).filter(d => d.value > 0);

        const last14Days = Array.from({ length: 14 }, (_, i) => format(subDays(new Date(), 13 - i), 'yyyy-MM-dd'));
        const activityMap = logs.reduce((acc, log) => {
            const day = format(new Date(log.created_date), 'yyyy-MM-dd');
            if (!acc[day]) acc[day] = { knocks: 0, sales: 0 };
            acc[day].knocks++;
            if (['SOLD', 'QUALIFIED'].includes(log.parsed_status)) acc[day].sales++;
            return acc;
        }, {});
        const trendData = last14Days.map(day => ({ date: format(parseISO(day), 'M/d'), knocks: activityMap[day]?.knocks || 0, sales: activityMap[day]?.sales || 0 }));

        const zipStats = properties.reduce((acc, p) => {
            const zip = p.zip_code ? p.zip_code.slice(0, 5) : 'Unknown';
            if (!acc[zip]) acc[zip] = { zip, total: 0, knocked: 0, sales: 0 };
            acc[zip].total++;
            if (p.effective_status !== 'ELIGIBLE') acc[zip].knocked++;
            if (['SOLD', 'QUALIFIED'].includes(p.effective_status)) acc[zip].sales++;
            return acc;
        }, {});
        const zipData = Object.values(zipStats).sort((a, b) => b.total - a.total).slice(0, 5).map(z => ({
            ...z, penetration: ((z.knocked / z.total) * 100).toFixed(0), conversion: z.knocked > 0 ? ((z.sales / z.knocked) * 100).toFixed(0) : 0
        }));

        const activeReps = new Set(logs.map(l => l.created_by)).size;

        return { totalProperties, knockedCount, penetrationRate, salesCount, conversionRate, activeReps, pieData, trendData, zipData, totalRoutes: routes.length, activeRoutes: routes.filter(r => ['IN_PROGRESS', 'ACTIVE'].includes(r.status)).length };
    }, [properties, logs, routes]);

    if (!stats) return <div className="fixed inset-0 z-[5000] flex items-center justify-center bg-black text-white"><span className="text-sm text-gray-500">No data loaded</span></div>;

    const CustomTooltip = ({ active, payload, label }) => {
        if (!active || !payload?.length) return null;
        return (
            <div className="bg-[#111] border border-white/[0.08] p-2.5 rounded-xl shadow-2xl text-xs">
                <p className="font-bold text-white mb-1">{label}</p>
                {payload.map((p, i) => <p key={i} style={{ color: p.color }}>{p.name}: <span className="font-bold">{p.value}</span></p>)}
            </div>
        );
    };

    const kpis = [
        { label: 'Penetration', value: `${stats.penetrationRate}%`, sub: `${stats.knockedCount.toLocaleString()} / ${stats.totalProperties.toLocaleString()}`, icon: Target, color: '#3b82f6' },
        { label: 'Conversion', value: `${stats.conversionRate}%`, sub: `${stats.salesCount} sales`, icon: TrendingUp, color: '#22c55e' },
        { label: 'Active Reps', value: stats.activeReps, sub: 'with activity', icon: Users, color: '#eab308' },
        { label: 'Routes', value: `${stats.activeRoutes}/${stats.totalRoutes}`, sub: 'active / total', icon: MapPin, color: '#8b5cf6' },
    ];

    return (
        <div className="fixed inset-0 z-[5000] flex flex-col bg-[#09090b] text-white overflow-hidden animate-in fade-in duration-200">
            {/* Header */}
            <div className="flex items-center justify-between px-4 sm:px-6 py-3 sm:py-4 border-b border-white/[0.04] bg-[#09090b] shrink-0">
                <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-yellow-500/10 border border-yellow-500/20 flex items-center justify-center">
                        <Globe className="w-4 h-4 text-yellow-400" />
                    </div>
                    <div>
                        <h1 className="text-sm sm:text-base font-black tracking-tight text-white">Command Center</h1>
                        <p className="text-[10px] text-gray-500 hidden sm:block">{stats.totalProperties.toLocaleString()} properties monitored</p>
                    </div>
                </div>
                <Button variant="ghost" size="icon" onClick={onClose} className="rounded-xl hover:bg-white/[0.06] h-8 w-8 sm:h-9 sm:w-9">
                    <X className="w-4 h-4 sm:w-5 sm:h-5 text-gray-400" />
                </Button>
            </div>

            <div className="flex-1 overflow-y-auto">
                <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-4 sm:space-y-6 pb-20">

                    {/* KPI Cards */}
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
                        {kpis.map(k => (
                            <div key={k.label} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3 sm:p-4">
                                <div className="flex items-center justify-between mb-2 sm:mb-3">
                                    <span className="text-[9px] sm:text-[10px] font-bold uppercase tracking-wider text-gray-500">{k.label}</span>
                                    <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center" style={{ background: `${k.color}15` }}>
                                        <k.icon className="w-3.5 h-3.5 sm:w-4 sm:h-4" style={{ color: k.color }} />
                                    </div>
                                </div>
                                <p className="text-xl sm:text-2xl font-black text-white leading-none">{k.value}</p>
                                <p className="text-[9px] sm:text-[10px] text-gray-600 mt-1">{k.sub}</p>
                            </div>
                        ))}
                    </div>

                    {/* Charts row */}
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">
                        {/* Activity Trend */}
                        <div className="lg:col-span-2 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
                            <div className="flex items-center gap-2 mb-3">
                                <Activity className="w-4 h-4 text-blue-400" />
                                <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">14-Day Activity</span>
                            </div>
                            <div className="h-[180px] sm:h-[220px]">
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart data={stats.trendData}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                                        <XAxis dataKey="date" stroke="#333" fontSize={9} tickLine={false} axisLine={false} />
                                        <YAxis stroke="#333" fontSize={9} tickLine={false} axisLine={false} width={30} />
                                        <RechartsTooltip content={<CustomTooltip />} />
                                        <Line type="monotone" dataKey="knocks" stroke={COLORS.blue} strokeWidth={2} dot={{ r: 2, fill: '#09090b', strokeWidth: 2 }} name="Knocks" />
                                        <Line type="monotone" dataKey="sales" stroke={COLORS.green} strokeWidth={2} dot={{ r: 2, fill: '#09090b', strokeWidth: 2 }} name="Sales" />
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>
                            <div className="flex items-center gap-4 mt-2 px-1">
                                <span className="flex items-center gap-1.5 text-[9px] text-gray-500"><span className="w-2 h-2 rounded-full bg-blue-500" />Knocks</span>
                                <span className="flex items-center gap-1.5 text-[9px] text-gray-500"><span className="w-2 h-2 rounded-full bg-green-500" />Sales</span>
                            </div>
                        </div>

                        {/* Status Pie */}
                        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
                            <div className="flex items-center gap-2 mb-3">
                                <Zap className="w-4 h-4 text-yellow-400" />
                                <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Status Mix</span>
                            </div>
                            <div className="h-[160px] sm:h-[180px] relative">
                                <ResponsiveContainer width="100%" height="100%">
                                    <PieChart>
                                        <Pie data={stats.pieData} cx="50%" cy="50%" innerRadius={45} outerRadius={65} paddingAngle={4} dataKey="value">
                                            {stats.pieData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                                        </Pie>
                                        <RechartsTooltip content={<CustomTooltip />} />
                                    </PieChart>
                                </ResponsiveContainer>
                                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                    <div className="text-center">
                                        <p className="text-lg font-black text-white">{stats.totalProperties.toLocaleString()}</p>
                                        <p className="text-[8px] text-gray-600">TOTAL</p>
                                    </div>
                                </div>
                            </div>
                            {/* Legend */}
                            <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2">
                                {stats.pieData.map((d, i) => (
                                    <div key={d.name} className="flex items-center gap-1.5 text-[9px] text-gray-500">
                                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
                                        <span className="truncate">{d.name}</span>
                                        <span className="ml-auto font-bold text-gray-400">{d.value}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* Territory Table */}
                    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
                        <div className="px-4 py-3 border-b border-white/[0.04]">
                            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Territory Breakdown</span>
                        </div>

                        {/* Mobile cards / Desktop table */}
                        <div className="hidden sm:block overflow-x-auto">
                            <table className="w-full text-xs text-left">
                                <thead className="text-[10px] text-gray-600 uppercase bg-white/[0.02]">
                                    <tr>
                                        <th className="px-4 py-3">Zip</th>
                                        <th className="px-4 py-3">Doors</th>
                                        <th className="px-4 py-3">Visited</th>
                                        <th className="px-4 py-3">Penetration</th>
                                        <th className="px-4 py-3">Sales</th>
                                        <th className="px-4 py-3">Conv %</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/[0.04]">
                                    {stats.zipData.map(z => (
                                        <tr key={z.zip} className="hover:bg-white/[0.02] transition-colors">
                                            <td className="px-4 py-3 font-bold text-white">{z.zip}</td>
                                            <td className="px-4 py-3 text-gray-400">{z.total.toLocaleString()}</td>
                                            <td className="px-4 py-3 text-gray-400">{z.knocked.toLocaleString()}</td>
                                            <td className="px-4 py-3">
                                                <div className="flex items-center gap-2">
                                                    <div className="w-12 h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
                                                        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${z.penetration}%` }} />
                                                    </div>
                                                    <span className="text-[10px] text-blue-400 font-bold">{z.penetration}%</span>
                                                </div>
                                            </td>
                                            <td className="px-4 py-3 text-green-400 font-bold">{z.sales}</td>
                                            <td className="px-4 py-3 text-gray-400">{z.conversion}%</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        {/* Mobile card view */}
                        <div className="sm:hidden p-3 space-y-2">
                            {stats.zipData.map(z => (
                                <div key={z.zip} className="rounded-xl border border-white/[0.04] bg-white/[0.02] p-3">
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="text-sm font-black text-white">{z.zip}</span>
                                        <span className="text-[10px] text-gray-500">{z.total.toLocaleString()} doors</span>
                                    </div>
                                    <div className="grid grid-cols-3 gap-2">
                                        <div>
                                            <p className="text-[9px] text-gray-600 uppercase">Visited</p>
                                            <p className="text-xs font-bold text-white">{z.knocked}</p>
                                        </div>
                                        <div>
                                            <p className="text-[9px] text-gray-600 uppercase">Penetration</p>
                                            <p className="text-xs font-bold text-blue-400">{z.penetration}%</p>
                                        </div>
                                        <div>
                                            <p className="text-[9px] text-gray-600 uppercase">Sales</p>
                                            <p className="text-xs font-bold text-green-400">{z.sales}</p>
                                        </div>
                                    </div>
                                    <div className="mt-2 h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
                                        <div className="h-full bg-blue-500 rounded-full" style={{ width: `${z.penetration}%` }} />
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                </div>
            </div>
        </div>
    );
}