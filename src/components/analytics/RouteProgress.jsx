import React, { useMemo } from 'react';
import { Badge } from "@/components/ui/badge";
import { Navigation, MapPin } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { useTheme } from '@/components/theme/ThemeProvider';

const STATUS_STYLES = {
    IN_PROGRESS: { bg: '#3b82f620', border: '#3b82f640', color: '#3b82f6', label: 'In Progress' },
    ACTIVE: { bg: '#eab30820', border: '#eab30840', color: '#eab308', label: 'Active' },
    PENDING: { bg: '#f9731620', border: '#f9731640', color: '#f97316', label: 'Pending' },
    COMPLETED: { bg: '#22c55e20', border: '#22c55e40', color: '#22c55e', label: 'Completed' },
};

export default function RouteProgress({ routes, logs }) {
    const { accent } = useTheme();

    const routeStats = useMemo(() => {
        return routes
            .filter(r => r.status !== 'ARCHIVED')
            .map(route => {
                const hashes = route.property_hashes || [];
                const routeLogs = logs.filter(l => hashes.includes(l.address_hash));
                const uniqueKnocked = new Set(routeLogs.map(l => l.address_hash)).size;
                const total = hashes.length;
                const percent = total > 0 ? Math.round((uniqueKnocked / total) * 100) : 0;
                const sales = routeLogs.filter(l => ['SOLD', 'QUALIFIED'].includes(l.parsed_status)).length;
                return { ...route, uniqueKnocked, total, percent, sales, logCount: routeLogs.length };
            })
            .sort((a, b) => {
                const order = { IN_PROGRESS: 0, ACTIVE: 1, PENDING: 2, COMPLETED: 3 };
                return (order[a.status] ?? 4) - (order[b.status] ?? 4);
            });
    }, [routes, logs]);

    if (routeStats.length === 0) {
        return (
            <div className="bg-[#111] border border-gray-800/60 rounded-2xl p-8 text-center">
                <Navigation className="w-8 h-8 text-gray-700 mx-auto mb-3" />
                <p className="text-gray-500 text-sm">No routes created yet</p>
                <p className="text-[10px] text-gray-600 mt-1">Routes will appear here once generated</p>
            </div>
        );
    }

    return (
        <div className="bg-[#111] border border-gray-800/60 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-800/50 flex items-center justify-between">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <Navigation className="w-4 h-4" style={{ color: accent }} />
                    Route Progress
                </h3>
                <span className="text-[10px] text-gray-500 bg-gray-800/50 px-2 py-0.5 rounded-full">{routeStats.length} routes</span>
            </div>
            <div className="divide-y divide-gray-800/30 max-h-[420px] overflow-y-auto">
                {routeStats.map(route => {
                    const style = STATUS_STYLES[route.status] || STATUS_STYLES.PENDING;
                    return (
                        <Link
                            key={route.id}
                            to={`${createPageUrl('Home')}?savedRoute=${route.id}`}
                            className="flex items-center gap-3.5 px-5 py-3.5 hover:bg-white/[0.02] transition-colors"
                        >
                            {/* Progress ring */}
                            <div className="relative w-11 h-11 shrink-0">
                                <svg className="w-11 h-11 -rotate-90" viewBox="0 0 36 36">
                                    <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#222" strokeWidth="3" />
                                    <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke={style.color} strokeWidth="3" strokeDasharray={`${route.percent}, 100`} strokeLinecap="round" />
                                </svg>
                                <span className="absolute inset-0 flex items-center justify-center text-[9px] font-extrabold text-white">{route.percent}%</span>
                            </div>

                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-0.5">
                                    <p className="text-sm font-bold text-white truncate">{route.name}</p>
                                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0" style={{ background: style.bg, color: style.color, border: `1px solid ${style.border}` }}>
                                        {style.label}
                                    </span>
                                </div>
                                <div className="flex items-center gap-2 text-[10px] text-gray-500">
                                    <span>{route.assigned_to_name || 'Unassigned'}</span>
                                    <span className="text-gray-700">·</span>
                                    <span>{route.total} doors</span>
                                    <span className="text-gray-700">·</span>
                                    <span className="text-green-500 font-semibold">{route.sales} sales</span>
                                </div>
                            </div>
                        </Link>
                    );
                })}
            </div>
        </div>
    );
}