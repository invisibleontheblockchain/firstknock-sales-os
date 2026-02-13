import React from 'react';
import { WifiOff, MapPin, Navigation, ChevronDown } from 'lucide-react';

export default function RepHeader({ user, isOffline, activeRoute, stats, knockWindow, routes, onShowMap, onShowRouteList, routeProperties }) {
    const progressPct = stats.total > 0 ? (stats.done / stats.total) * 100 : 0;

    return (
        <div className="sticky top-0 z-30 bg-[#0A0A0A] px-4 pt-3 pb-3 space-y-2.5">
            {/* Top row */}
            <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-yellow-500 flex items-center justify-center shrink-0">
                    <Navigation className="w-4 h-4 text-black" />
                </div>

                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                        <h2 className="font-bold text-[15px] text-white truncate">{activeRoute.name}</h2>
                        {routes.length > 1 && (
                            <button onClick={onShowRouteList} className="shrink-0">
                                <ChevronDown className="w-3.5 h-3.5 text-gray-600" />
                            </button>
                        )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                        {isOffline ? (
                            <span className="flex items-center gap-1 text-[10px] text-red-500 font-bold">
                                <WifiOff className="w-3 h-3" /> OFFLINE
                            </span>
                        ) : (
                            <span className="text-[10px] text-gray-600">{stats.total} stops • {knockWindow.emoji} {knockWindow.label}</span>
                        )}
                    </div>
                </div>

                {/* Action buttons */}
                <div className="flex gap-1.5 shrink-0">
                    <button
                        onClick={onShowMap}
                        className="h-8 px-2.5 rounded-lg bg-white/5 border border-white/10 flex items-center gap-1.5 active:bg-white/10"
                    >
                        <MapPin className="w-3.5 h-3.5 text-yellow-500" />
                        <span className="text-[10px] font-bold text-gray-400">MAP</span>
                    </button>
                    <button
                        onClick={() => {
                            if (routeProperties.length > 0) {
                                const first = routeProperties[0];
                                window.open(`https://maps.apple.com/?daddr=${first.lat},${first.lng}&dirflg=w`, '_blank');
                            }
                        }}
                        className="h-8 px-2.5 rounded-lg bg-yellow-500 flex items-center gap-1.5 active:bg-yellow-400"
                    >
                        <Navigation className="w-3.5 h-3.5 text-black" />
                        <span className="text-[10px] font-bold text-black">START</span>
                    </button>
                </div>
            </div>

            {/* Progress */}
            <div className="flex items-center gap-3">
                <div className="flex-1 h-1.5 rounded-full overflow-hidden bg-[#1a1a1a]">
                    <div className="h-full rounded-full transition-all duration-500 bg-yellow-500" style={{ width: `${progressPct}%` }} />
                </div>
                <span className="text-[11px] font-bold tabular-nums text-yellow-500 shrink-0">{stats.done}/{stats.total}</span>
            </div>
        </div>
    );
}