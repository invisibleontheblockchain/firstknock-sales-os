import React from 'react';
import { WifiOff, MapPin, Navigation, ChevronDown } from 'lucide-react';

export default function RepHeader({ user, isOffline, activeRoute, stats, knockWindow, routes, onShowMap, onShowRouteList, routeProperties }) {
    const progressPct = stats.total > 0 ? (stats.done / stats.total) * 100 : 0;

    return (
        <div className="sticky top-0 z-30 bg-[#0A0A0F]/95 backdrop-blur-md border-b border-white/5 px-4 pt-4 pb-4 space-y-3">
            {/* Top row */}
            <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 shadow-[0_0_15px_rgba(108,92,231,0.4)]" style={{ background: 'linear-gradient(135deg, #6C5CE7, #A29BFE)' }}>
                    <Navigation className="w-4 h-4 text-white" />
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
                        className="h-8 px-2.5 rounded-xl bg-white/5 border border-white/10 flex items-center gap-1.5 hover:bg-white/10 active:scale-95 transition-all"
                    >
                        <MapPin className="w-3.5 h-3.5 text-[#00D2FF]" />
                        <span className="text-[10px] font-bold text-[#F0F0F5]">MAP</span>
                    </button>
                    <button
                        onClick={() => {
                            if (routeProperties.length > 0) {
                                const first = routeProperties[0];
                                window.open(`https://maps.apple.com/?daddr=${first.lat},${first.lng}&dirflg=w`, '_blank');
                            }
                        }}
                        className="h-8 px-2.5 rounded-xl flex items-center gap-1.5 active:scale-95 transition-all shadow-[0_0_10px_rgba(0,210,255,0.3)]"
                        style={{ background: '#00D2FF', color: '#0A0A0F' }}
                    >
                        <Navigation className="w-3.5 h-3.5" />
                        <span className="text-[10px] font-bold">START</span>
                    </button>
                </div>
            </div>

            {/* Progress */}
            <div className="flex items-center gap-3">
                <div className="flex-1 h-1.5 rounded-full overflow-hidden bg-white/10">
                    <div className="h-full rounded-full transition-all duration-500 shadow-[0_0_10px_rgba(0,245,160,0.5)]" style={{ width: `${progressPct}%`, background: '#00F5A0' }} />
                </div>
                <span className="text-[11px] font-mono font-bold text-[#00F5A0] shrink-0">{stats.done}/{stats.total}</span>
            </div>
        </div>
    );
}