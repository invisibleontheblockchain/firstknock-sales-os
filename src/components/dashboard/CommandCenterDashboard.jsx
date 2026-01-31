import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line, CartesianGrid } from 'recharts';
import { Users, MapPin, TrendingUp, DollarSign, Activity, Target, X, Globe, Calendar } from 'lucide-react';
import { format, subDays, isAfter, startOfDay, parseISO } from 'date-fns';

const COLORS = {
    gold: '#FFD700',
    green: '#22c55e',
    blue: '#3b82f6',
    purple: '#8b5cf6',
    red: '#ef4444',
    gray: '#6b7280',
    dark: '#1A1A1A'
};

const CHART_COLORS = [COLORS.gold, COLORS.green, COLORS.blue, COLORS.purple, COLORS.red];

export default function CommandCenterDashboard({ properties, logs, routes, teamMembers, onClose }) {
    
    const stats = useMemo(() => {
        const totalProperties = properties.length;
        if (totalProperties === 0) return null;

        // 1. Status Breakdown
        const statusCounts = properties.reduce((acc, p) => {
            const s = p.effective_status || 'ELIGIBLE';
            acc[s] = (acc[s] || 0) + 1;
            return acc;
        }, {});

        const knockedCount = totalProperties - (statusCounts['ELIGIBLE'] || 0);
        const penetrationRate = ((knockedCount / totalProperties) * 100).toFixed(1);

        const salesCount = (statusCounts['SOLD'] || 0) + (statusCounts['QUALIFIED'] || 0);
        const conversionRate = knockedCount > 0 ? ((salesCount / knockedCount) * 100).toFixed(1) : 0;

        const pieData = Object.keys(statusCounts).map(key => ({
            name: key.replace('_', ' '),
            value: statusCounts[key]
        })).filter(d => d.value > 0);

        // 2. Activity Trends (Last 14 Days)
        const last14Days = Array.from({ length: 14 }, (_, i) => {
            const d = subDays(new Date(), 13 - i);
            return format(d, 'yyyy-MM-dd');
        });

        const activityMap = logs.reduce((acc, log) => {
            const day = format(new Date(log.created_date), 'yyyy-MM-dd');
            if (!acc[day]) acc[day] = { knocks: 0, sales: 0 };
            acc[day].knocks++;
            if (['SOLD', 'QUALIFIED'].includes(log.parsed_status)) acc[day].sales++;
            return acc;
        }, {});

        const trendData = last14Days.map(day => ({
            date: format(parseISO(day), 'MMM d'),
            knocks: activityMap[day]?.knocks || 0,
            sales: activityMap[day]?.sales || 0
        }));

        // 3. Zip Code Performance
        const zipStats = properties.reduce((acc, p) => {
            const zip = p.zip_code ? p.zip_code.slice(0, 5) : 'Unknown';
            if (!acc[zip]) acc[zip] = { zip, total: 0, knocked: 0, sales: 0 };
            
            acc[zip].total++;
            if (p.effective_status !== 'ELIGIBLE') acc[zip].knocked++;
            if (['SOLD', 'QUALIFIED'].includes(p.effective_status)) acc[zip].sales++;
            return acc;
        }, {});

        const zipData = Object.values(zipStats)
            .sort((a, b) => b.total - a.total)
            .slice(0, 5) // Top 5 Zips
            .map(z => ({
                ...z,
                penetration: ((z.knocked / z.total) * 100).toFixed(0),
                conversion: z.knocked > 0 ? ((z.sales / z.knocked) * 100).toFixed(0) : 0
            }));

        // 4. Team Velocity
        const activeReps = new Set(logs.map(l => l.created_by)).size;
        const totalKnocks = logs.length;
        
        return {
            totalProperties,
            knockedCount,
            penetrationRate,
            salesCount,
            conversionRate,
            activeReps,
            pieData,
            trendData,
            zipData,
            totalRoutes: routes.length,
            activeRoutes: routes.filter(r => r.status === 'IN_PROGRESS' || r.status === 'ACTIVE').length
        };

    }, [properties, logs, routes]);

    if (!stats) return <div className="p-10 text-center text-white">Loading Dashboard Data...</div>;

    const CustomTooltip = ({ active, payload, label }) => {
        if (active && payload && payload.length) {
            return (
                <div className="bg-black/90 border border-gray-800 p-2 rounded-lg shadow-xl text-xs">
                    <p className="font-bold text-white mb-1">{label}</p>
                    {payload.map((p, idx) => (
                        <p key={idx} style={{ color: p.color }}>
                            {p.name}: {p.value}
                        </p>
                    ))}
                </div>
            );
        }
        return null;
    };

    return (
        <div className="fixed inset-0 z-[5000] flex flex-col bg-[#0A0A0A] text-white overflow-hidden animate-in fade-in duration-300">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 bg-black/50 backdrop-blur">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
                        <Globe className="w-6 h-6 text-yellow-500" />
                        COMMAND CENTER DASHBOARD
                    </h1>
                    <p className="text-sm text-gray-500">
                        Real-time territory intelligence • {stats.totalProperties.toLocaleString()} Properties Monitored
                    </p>
                </div>
                <Button variant="ghost" size="icon" onClick={onClose} className="rounded-full hover:bg-gray-800">
                    <X className="w-6 h-6" />
                </Button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 scrollbar-hide">
                <div className="max-w-7xl mx-auto space-y-6">
                    
                    {/* Top KPIs */}
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                        <KpiCard 
                            title="Market Penetration" 
                            value={`${stats.penetrationRate}%`} 
                            subtitle={`${stats.knockedCount.toLocaleString()} / ${stats.totalProperties.toLocaleString()} Doors`}
                            icon={Target}
                            color="text-blue-500"
                        />
                        <KpiCard 
                            title="Conversion Rate" 
                            value={`${stats.conversionRate}%`} 
                            subtitle={`${stats.salesCount} Sales / Qualified`}
                            icon={TrendingUp}
                            color="text-green-500"
                        />
                        <KpiCard 
                            title="Active Force" 
                            value={stats.activeReps} 
                            subtitle="Reps with activity"
                            icon={Users}
                            color="text-yellow-500"
                        />
                        <KpiCard 
                            title="Route Coverage" 
                            value={`${stats.activeRoutes} / ${stats.totalRoutes}`} 
                            subtitle="Active vs Total Routes"
                            icon={MapPin}
                            color="text-purple-500"
                        />
                    </div>

                    {/* Main Charts Row */}
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                        
                        {/* Activity Trend */}
                        <Card className="col-span-1 lg:col-span-2 bg-[#151515] border-gray-800">
                            <CardHeader>
                                <CardTitle className="text-sm font-bold text-gray-400 flex items-center gap-2">
                                    <Activity className="w-4 h-4" /> 14-DAY ACTIVITY VELOCITY
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="h-[300px]">
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart data={stats.trendData}>
                                        <CartesianGrid strokeDasharray="3 3" stroke="#333" vertical={false} />
                                        <XAxis dataKey="date" stroke="#666" fontSize={10} tickLine={false} axisLine={false} />
                                        <YAxis stroke="#666" fontSize={10} tickLine={false} axisLine={false} />
                                        <RechartsTooltip content={<CustomTooltip />} />
                                        <Line type="monotone" dataKey="knocks" stroke={COLORS.blue} strokeWidth={3} dot={{r: 4, fill: '#151515', strokeWidth: 2}} activeDot={{r: 6}} name="Knocks" />
                                        <Line type="monotone" dataKey="sales" stroke={COLORS.green} strokeWidth={3} dot={{r: 4, fill: '#151515', strokeWidth: 2}} activeDot={{r: 6}} name="Sales/Leads" />
                                    </LineChart>
                                </ResponsiveContainer>
                            </CardContent>
                        </Card>

                        {/* Status Distribution */}
                        <Card className="bg-[#151515] border-gray-800">
                            <CardHeader>
                                <CardTitle className="text-sm font-bold text-gray-400">INVENTORY STATUS</CardTitle>
                            </CardHeader>
                            <CardContent className="h-[300px] relative">
                                <ResponsiveContainer width="100%" height="100%">
                                    <PieChart>
                                        <Pie
                                            data={stats.pieData}
                                            cx="50%"
                                            cy="50%"
                                            innerRadius={60}
                                            outerRadius={80}
                                            paddingAngle={5}
                                            dataKey="value"
                                        >
                                            {stats.pieData.map((entry, index) => (
                                                <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                                            ))}
                                        </Pie>
                                        <RechartsTooltip content={<CustomTooltip />} />
                                    </PieChart>
                                </ResponsiveContainer>
                                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                                    <div className="text-center">
                                        <p className="text-3xl font-bold text-white">{stats.totalProperties}</p>
                                        <p className="text-xs text-gray-500">TOTAL</p>
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    </div>

                    {/* Bottom Row: Zip Performance */}
                    <Card className="bg-[#151515] border-gray-800">
                        <CardHeader>
                            <CardTitle className="text-sm font-bold text-gray-400">TERRITORY BREAKDOWN (TOP 5 AREAS)</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm text-left">
                                    <thead className="text-xs text-gray-500 uppercase bg-black/20">
                                        <tr>
                                            <th className="px-4 py-3 rounded-l-lg">Zip Code</th>
                                            <th className="px-4 py-3">Total Doors</th>
                                            <th className="px-4 py-3">Visited</th>
                                            <th className="px-4 py-3">Penetration</th>
                                            <th className="px-4 py-3">Conversions</th>
                                            <th className="px-4 py-3 rounded-r-lg">Conv. Rate</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-800">
                                        {stats.zipData.map((zip) => (
                                            <tr key={zip.zip} className="hover:bg-white/5 transition-colors">
                                                <td className="px-4 py-3 font-bold text-white">{zip.zip}</td>
                                                <td className="px-4 py-3 text-gray-300">{zip.total.toLocaleString()}</td>
                                                <td className="px-4 py-3 text-gray-300">{zip.knocked.toLocaleString()}</td>
                                                <td className="px-4 py-3">
                                                    <div className="flex items-center gap-2">
                                                        <div className="w-16 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                                                            <div className="h-full bg-blue-500 rounded-full" style={{ width: `${zip.penetration}%` }} />
                                                        </div>
                                                        <span className="text-xs text-blue-400">{zip.penetration}%</span>
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3 text-green-400 font-medium">{zip.sales}</td>
                                                <td className="px-4 py-3 text-gray-300">{zip.conversion}%</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </CardContent>
                    </Card>

                </div>
            </div>
        </div>
    );
}

function KpiCard({ title, value, subtitle, icon: Icon, color }) {
    return (
        <Card className="bg-[#151515] border-gray-800 hover:border-gray-700 transition-colors">
            <CardContent className="p-6">
                <div className="flex items-center justify-between mb-4">
                    <p className="text-sm font-medium text-gray-400 uppercase tracking-wide">{title}</p>
                    <div className={`p-2 rounded-lg bg-white/5 ${color}`}>
                        <Icon className="w-5 h-5" />
                    </div>
                </div>
                <div>
                    <h3 className="text-3xl font-bold text-white mb-1">{value}</h3>
                    <p className="text-xs text-gray-500 font-medium">{subtitle}</p>
                </div>
            </CardContent>
        </Card>
    );
}