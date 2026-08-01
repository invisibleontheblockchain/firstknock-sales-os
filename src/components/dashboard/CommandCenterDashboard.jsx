import React, { useState, useMemo } from 'react';
import { Button } from "@/components/ui/button";
import { Users, TrendingUp, Target, X, Zap, Gauge } from 'lucide-react';
import { subDays, parseISO, startOfDay, isAfter, isToday } from 'date-fns';
import { isKnockActivityLog } from '@/lib/interactionLogs';
import CommandKpiGrid from './CommandKpiGrid';
import CommandLeaderboard from './CommandLeaderboard';
import CommandStatusMix from './CommandStatusMix';
import CommandRoutePulse from './CommandRoutePulse';

const TIME_FILTERS = [
    { id: 'today', label: 'Today' },
    { id: '7d', label: '7 Days' },
    { id: '30d', label: '30 Days' },
    { id: 'all', label: 'All Time' }
];

const SALE_STATUSES = ['SOLD', 'QUALIFIED'];

export default function CommandCenterDashboard({ logs, routes, teamMembers = [], onSelectRoute, onClose }) {
    const [timeFilter, setTimeFilter] = useState('30d');

    const stats = useMemo(() => {
        const startOfToday = startOfDay(new Date());
        const startOf7d = subDays(startOfToday, 7);
        const startOf30d = subDays(startOfToday, 30);

        const filteredLogs = logs.filter(log => {
            if (!isKnockActivityLog(log)) return false;
            if (!log.created_date) return false;
            const logDate = parseISO(log.created_date);
            if (timeFilter === 'today') return isToday(logDate);
            if (timeFilter === '7d') return isAfter(logDate, startOf7d);
            if (timeFilter === '30d') return isAfter(logDate, startOf30d);
            return true;
        });

        const knocks = filteredLogs.length;
        const sales = filteredLogs.filter(l => SALE_STATUSES.includes(l.parsed_status)).length;
        const conversionRate = knocks > 0 ? ((sales / knocks) * 100).toFixed(1) : '0.0';
        const activeRepsCount = new Set(filteredLogs.map(l => l.created_by)).size;

        // Rep leaderboard
        const repStatsMap = {};
        filteredLogs.forEach(log => {
            const email = log.created_by || 'Unknown';
            if (!repStatsMap[email]) {
                const member = teamMembers.find(m => m.email === email);
                repStatsMap[email] = { email, name: member ? member.name : email.split('@')[0], knocks: 0, sales: 0 };
            }
            repStatsMap[email].knocks++;
            if (SALE_STATUSES.includes(log.parsed_status)) repStatsMap[email].sales++;
        });
        const leaderboard = Object.values(repStatsMap)
            .map(rep => ({ ...rep, conversion: rep.knocks > 0 ? ((rep.sales / rep.knocks) * 100).toFixed(1) : '0.0' }))
            .sort((a, b) => b.sales - a.sales || b.knocks - a.knocks);

        // Outcome mix
        const statusMap = filteredLogs.reduce((acc, log) => {
            const s = log.parsed_status || 'UNKNOWN';
            acc[s] = (acc[s] || 0) + 1;
            return acc;
        }, {});
        const pieData = Object.keys(statusMap)
            .map(key => ({ name: key.replace(/_/g, ' '), value: statusMap[key] }))
            .sort((a, b) => b.value - a.value);

        // Route rollups
        const activeRouteRecords = routes.filter(r => ['IN_PROGRESS', 'ACTIVE'].includes(r.status));
        const routeCounts = [
            { label: 'Total', value: routes.length, color: '#FFFFFF' },
            { label: 'Active', value: activeRouteRecords.length, color: '#39FF4A' },
            { label: 'Queued', value: routes.filter(r => r.status === 'PENDING').length, color: '#3b82f6' },
            { label: 'Done', value: routes.filter(r => r.status === 'COMPLETED').length, color: '#8b5cf6' }
        ];

        // Knocked doors per route, derived from logs so progress reflects real outcomes
        const routeActivity = new Map();
        logs.forEach(log => {
            if (!log.route_id || !isKnockActivityLog(log)) return;
            if (!routeActivity.has(log.route_id)) routeActivity.set(log.route_id, { doors: new Set(), knocks: 0, sales: 0 });
            const entry = routeActivity.get(log.route_id);
            if (log.address_hash) entry.doors.add(log.address_hash);
            entry.knocks++;
            if (SALE_STATUSES.includes(log.parsed_status)) entry.sales++;
        });

        const activeRoutes = activeRouteRecords.map(route => {
            const total = route.metrics?.house_count || route.property_hashes?.length || 0;
            const done = routeActivity.get(route.id)?.doors.size || 0;
            return {
                id: route.id,
                name: route.name,
                assigned_to_name: route.assigned_to_name,
                total,
                done,
                pct: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
            };
        }).sort((a, b) => b.pct - a.pct);

        const bestRoutes = routes
            .map(route => {
                const activity = routeActivity.get(route.id);
                if (!activity) return null;
                return {
                    id: route.id,
                    name: route.name,
                    assigned_to_name: route.assigned_to_name,
                    knocks: activity.knocks,
                    sales: activity.sales,
                    conversion: activity.knocks > 0 ? ((activity.sales / activity.knocks) * 100).toFixed(0) : '0'
                };
            })
            .filter(Boolean)
            .sort((a, b) => b.sales - a.sales || b.knocks - a.knocks)
            .slice(0, 5);

        return { knocks, sales, conversionRate, activeRepsCount, leaderboard, pieData, routeCounts, activeRoutes, bestRoutes };
    }, [logs, routes, timeFilter, teamMembers]);

    const kpis = [
        { label: 'Total Knocks', value: stats.knocks.toLocaleString(), icon: Target, color: '#2EEB57' },
        { label: 'Sales / Leads', value: stats.sales.toLocaleString(), icon: Zap, color: '#39FF4A' },
        { label: 'Conversion', value: `${stats.conversionRate}%`, icon: TrendingUp, color: '#3b82f6' },
        { label: 'Active Reps', value: stats.activeRepsCount, icon: Users, color: '#8b5cf6' }
    ];

    return (
        <div className="fixed inset-0 z-[5000] flex flex-col overflow-hidden bg-black pt-[env(safe-area-inset-top)] text-white animate-in fade-in duration-200">
            {/* Header */}
            <div className="shrink-0 border-b border-white/10 bg-black/80 px-3 py-2.5 backdrop-blur-xl sm:px-6 lg:px-8">
                <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-2.5">
                        <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-[#2EEB57]/30 bg-[#2EEB57]/10">
                            <Gauge className="h-4 w-4 text-[#39FF4A]" />
                        </div>
                        <div>
                            <h1 className="text-sm font-black tracking-tight text-white lg:text-base">Command Center</h1>
                            <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-white/35 lg:text-[10px]">Team &amp; Route Performance</p>
                        </div>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={onClose}
                            className="ml-auto h-8 w-8 shrink-0 rounded-full border border-white/10 bg-white/[0.04] hover:bg-white/10 sm:hidden"
                        >
                            <X className="h-4 w-4 text-white/60" />
                        </Button>
                    </div>

                    <div className="flex items-center gap-2">
                        <div className="grid flex-1 grid-cols-4 gap-1 rounded-xl border border-white/10 bg-white/[0.04] p-1 sm:flex sm:flex-none">
                            {TIME_FILTERS.map(f => (
                                <button
                                    key={f.id}
                                    onClick={() => setTimeFilter(f.id)}
                                    className={`min-h-8 rounded-lg px-2.5 text-[10px] font-black uppercase tracking-[0.08em] transition-colors lg:text-[11px] ${
                                        timeFilter === f.id
                                            ? 'border border-[#2EEB57]/30 bg-[#2EEB57]/12 text-[#86efac]'
                                            : 'border border-transparent text-white/45 hover:text-white'
                                    }`}
                                >
                                    {f.label}
                                </button>
                            ))}
                        </div>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={onClose}
                            className="hidden h-8 w-8 shrink-0 rounded-full border border-white/10 bg-white/[0.04] hover:bg-white/10 sm:flex"
                        >
                            <X className="h-4 w-4 text-white/60" />
                        </Button>
                    </div>
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto custom-scrollbar">
                <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 p-3 pb-24 lg:gap-5 lg:p-6">
                    <CommandKpiGrid items={kpis} />

                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3 lg:gap-4">
                        <div className="lg:col-span-2">
                            <CommandLeaderboard leaderboard={stats.leaderboard} />
                        </div>
                        <CommandStatusMix data={stats.pieData} total={stats.knocks} />
                    </div>

                    <CommandRoutePulse
                        routeCounts={stats.routeCounts}
                        bestRoutes={stats.bestRoutes}
                        activeRoutes={stats.activeRoutes}
                        onSelectRoute={onSelectRoute}
                    />
                </div>
            </div>
        </div>
    );
}