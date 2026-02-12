import React from 'react';
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { WifiOff, MapPin, Navigation, ChevronDown } from 'lucide-react';

export default function RepHeader({ user, isOffline, activeRoute, stats, knockWindow, routes, onShowMap, onShowRouteList, routeProperties }) {
    return (
        <div className="sticky top-0 z-30 bg-black/95 backdrop-blur-md border-b border-gray-800 px-4 py-3 space-y-3">
            {/* Top row: avatar + route name + quick actions */}
            <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-yellow-500 flex items-center justify-center text-black font-bold text-sm shrink-0">
                    {user?.full_name?.[0] || 'U'}
                </div>
                
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <h2 className="font-bold text-sm text-white truncate">{activeRoute.name}</h2>
                        {routes.length > 1 && (
                            <button onClick={onShowRouteList} className="shrink-0">
                                <ChevronDown className="w-4 h-4 text-gray-500" />
                            </button>
                        )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                        {isOffline ? (
                            <span className="flex items-center gap-1 text-[10px] text-red-500 font-bold">
                                <WifiOff className="w-3 h-3" /> OFFLINE
                            </span>
                        ) : (
                            <span className="text-[10px] text-gray-500">{knockWindow.emoji} {knockWindow.label}</span>
                        )}
                    </div>
                </div>

                {/* Quick action buttons */}
                <div className="flex gap-1.5 shrink-0">
                    <button
                        onClick={onShowMap}
                        className="w-9 h-9 rounded-lg bg-gray-800 border border-gray-700 flex items-center justify-center active:bg-gray-700"
                    >
                        <MapPin className="w-4 h-4 text-blue-400" />
                    </button>
                    <button
                        onClick={() => {
                            if (routeProperties.length > 0) {
                                const first = routeProperties[0];
                                window.open(`https://maps.apple.com/?daddr=${first.lat},${first.lng}&dirflg=w`, '_blank');
                            }
                        }}
                        className="w-9 h-9 rounded-lg bg-green-600 flex items-center justify-center active:bg-green-700"
                    >
                        <Navigation className="w-4 h-4 text-white" />
                    </button>
                </div>
            </div>

            {/* Progress bar */}
            <div className="flex items-center gap-3">
                <Progress value={stats.percent} className="h-2.5 bg-gray-800 flex-1" indicatorClassName="bg-yellow-500" />
                <span className="text-xs font-bold text-gray-400 tabular-nums shrink-0">{stats.done}/{stats.total}</span>
            </div>
        </div>
    );
}