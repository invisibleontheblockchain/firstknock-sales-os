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
        <div className="bg-gradient-to-b from-[#151515] to-[#0A0A0A] border border-white/5 rounded-3xl overflow-hidden shadow-2xl relative">
            <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            <div className="px-6 py-5 border-b border-white/5 flex items-center justify-between relative z-10">
                <h3 className="text-lg font-black text-transparent bg-clip-text bg-gradient-to-r from-white to-gray-400 tracking-tight flex items-center gap-3">
                    <div className="p-2 rounded-xl" style={{ background: `${accent}20`, border: `1px solid ${accent}40` }}>
                        <Navigation className="w-5 h-5 drop-shadow-[0_0_10px_rgba(255,215,0,0.5)]" style={{ color: accent }} />
                    </div>
                    Route Progress
                </h3>
                <span className="text-[11px] font-bold text-gray-400 uppercase tracking-widest bg-white/5 px-3 py-1.5 rounded-lg border border-white/5 shadow-inner">{routeStats.length} routes</span>
            </div>
            
            <div className="divide-y divide-white/[0.02] max-h-[500px] overflow-y-auto">
                {routeStats.map(route => {
                    const style = STATUS_STYLES[route.status] || STATUS_STYLES.PENDING;
                    return (
                        <Link
                            key={route.id}
                            to={`${createPageUrl('Home')}?savedRoute=${route.id}`}
                            className="group flex items-center gap-5 px-6 py-4 hover:bg-white/[0.03] transition-all duration-300 relative"
                        >
                            <div className="absolute inset-0 bg-gradient-to-r from-white/[0.01] to-transparent opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity" />
                            
                            {/* Progress ring */}
                            <div className="relative w-14 h-14 shrink-0 transition-transform duration-300 group-hover:scale-105">
                                <svg className="w-14 h-14 -rotate-90 drop-shadow-[0_0_8px_rgba(0,0,0,0.5)]" viewBox="0 0 36 36">
                                    <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#222" strokeWidth="3" />
                                    <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke={style.color} strokeWidth="3" strokeDasharray={`${route.percent}, 100`} strokeLinecap="round" className="transition-all duration-1000 ease-out" />
                                </svg>
                                <div className="absolute inset-0 flex items-center justify-center">
                                    <span className="text-[11px] font-black text-white drop-shadow-md">{route.percent}%</span>
                                </div>
                                <div className="absolute inset-0 rounded-full blur-[10px] opacity-30 group-hover:opacity-60 transition-opacity duration-500" style={{ background: style.color, zIndex: -1 }} />
                            </div>

                            <div className="flex-1 min-w-0 z-10">
                                <div className="flex items-center justify-between mb-1.5">
                                    <p className="text-base font-bold text-white truncate drop-shadow-sm group-hover:text-transparent group-hover:bg-clip-text group-hover:bg-gradient-to-r group-hover:from-white group-hover:to-gray-400 transition-all">{route.name}</p>
                                    <span className="text-[10px] font-bold px-2 py-1 rounded-md shrink-0 shadow-inner backdrop-blur-sm tracking-wide uppercase" style={{ background: style.bg, color: style.color, border: `1px solid ${style.border}` }}>
                                        {style.label}
                                    </span>
                                </div>
                                <div className="flex items-center gap-3 text-xs font-medium text-gray-500">
                                    <div className="flex items-center gap-1.5 bg-black/40 px-2 py-0.5 rounded-md border border-white/5">
                                        <div className={`w-1.5 h-1.5 rounded-full ${route.assigned_to_name ? 'bg-green-500 shadow-[0_0_5px_rgba(34,197,94,0.5)]' : 'bg-red-500 shadow-[0_0_5px_rgba(239,68,68,0.5)]'}`} />
                                        <span>{route.assigned_to_name || 'Unassigned'}</span>
                                    </div>
                                    <span className="flex items-center gap-1">
                                        <MapPin className="w-3 h-3 text-gray-600" />
                                        {route.total} doors
                                    </span>
                                    {route.sales > 0 && (
                                        <span className="text-green-400 font-bold bg-green-500/10 px-2 py-0.5 rounded-md border border-green-500/20 shadow-[0_0_10px_rgba(34,197,94,0.1)]">
                                            {route.sales} sales
                                        </span>
                                    )}
                                </div>
                            </div>
                        </Link>
                    );
                })}
            </div>
        </div>
    );
}