import React, { useMemo } from 'react';
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Navigation, CheckCircle2, Clock, MapPin } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';

const STATUS_COLORS = {
    IN_PROGRESS: { bg: 'bg-blue-500/10', border: 'border-blue-500/30', text: 'text-blue-500', badge: '#3b82f6' },
    ACTIVE: { bg: 'bg-yellow-500/10', border: 'border-yellow-500/30', text: 'text-yellow-500', badge: '#eab308' },
    PENDING: { bg: 'bg-orange-500/10', border: 'border-orange-500/30', text: 'text-orange-500', badge: '#f97316' },
    COMPLETED: { bg: 'bg-green-500/10', border: 'border-green-500/30', text: 'text-green-500', badge: '#22c55e' },
};

export default function RouteProgress({ routes, logs }) {
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
            <div className="bg-[#151515] border border-gray-800 rounded-xl p-6 text-center">
                <Navigation className="w-8 h-8 text-gray-700 mx-auto mb-2" />
                <p className="text-gray-500 text-sm">No routes yet</p>
            </div>
        );
    }

    return (
        <div className="bg-[#151515] border border-gray-800 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-gray-800 flex items-center justify-between">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <Navigation className="w-4 h-4 text-yellow-500" /> Route Progress
                </h3>
                <span className="text-[10px] text-gray-500">{routeStats.length} routes</span>
            </div>

            <div className="divide-y divide-gray-800/50 max-h-[400px] overflow-y-auto">
                {routeStats.map(route => {
                    const style = STATUS_COLORS[route.status] || STATUS_COLORS.PENDING;
                    return (
                        <Link
                            key={route.id}
                            to={`${createPageUrl('Home')}?savedRoute=${route.id}`}
                            className="flex items-center gap-3 px-4 py-3 hover:bg-gray-800/30 transition-colors cursor-pointer"
                        >
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                    <p className="text-sm font-bold text-white truncate">{route.name}</p>
                                    <Badge className="text-[9px] h-4 px-1.5" style={{ background: style.badge, color: '#000' }}>
                                        {route.status}
                                    </Badge>
                                </div>
                                <div className="flex items-center gap-3 text-[10px] text-gray-500 mb-2">
                                    <span>{route.assigned_to_name || 'Unassigned'}</span>
                                    <span>•</span>
                                    <span>{route.total} doors</span>
                                    <span>•</span>
                                    <span className="text-green-500">{route.sales} sales</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <Progress value={route.percent} className="h-1.5 flex-1 bg-gray-800" />
                                    <span className="text-[10px] font-bold text-gray-400 w-8 text-right">{route.percent}%</span>
                                </div>
                            </div>
                        </Link>
                    );
                })}
            </div>
        </div>
    );
}