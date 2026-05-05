import React from 'react';
import { WifiOff, MapPin, Navigation, ChevronDown, CheckCircle2, RefreshCw } from 'lucide-react';
import { useIsMutating } from '@tanstack/react-query';

export default function RepHeader({ user, isOffline, activeRoute, stats, knockWindow, routes, onShowMap, onShowRouteList, routeProperties }) {
  const progressPct = stats.total > 0 ? stats.done / stats.total * 100 : 0;
  const isMutating = useIsMutating();

  // Sync UI Logic
  const syncState = isOffline ?
  { dot: 'bg-[#FF6B6B]', text: 'text-[#FF6B6B]', label: 'OFFLINE (QUEUED)', icon: WifiOff } :
  isMutating > 0 ?
  { dot: 'bg-[#FFD93D]', text: 'text-[#FFD93D]', label: `SYNCING (${isMutating})...`, icon: RefreshCw } :
  { dot: 'bg-[#00F5A0]', text: 'text-[#00F5A0]', label: 'SYNCED', icon: CheckCircle2 };

  return (
    <div className="sticky top-0 z-30 backdrop-blur-md border-b border-white/5 px-4 pt-4 pb-4 space-y-3 bg-[#030303]">
            {/* Top row */}
            <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 shadow-[0_0_15px_rgba(108,92,231,0.4)]" style={{ background: 'linear-gradient(135deg, #6C5CE7, #A29BFE)' }}>
                    <Navigation className="w-4 h-4 text-white" />
                </div>

                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                        <h2 className="font-bold text-[15px] text-white truncate">{activeRoute.name}</h2>
                        {routes.length > 1 &&
            <button onClick={onShowRouteList} className="shrink-0">
                                <ChevronDown className="w-3.5 h-3.5 text-gray-600" />
                            </button>
            }
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] text-[#8888A0]">{stats.total} stops • {knockWindow.emoji} {knockWindow.label}</span>
                        <div className="w-1 h-1 rounded-full bg-white/10" />
                        <span className={`flex items-center gap-1 text-[9px] font-bold tracking-wider ${syncState.text}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${syncState.dot} ${isMutating > 0 ? 'animate-pulse' : ''}`} />
                            {syncState.label}
                        </span>
                    </div>
                </div>

                {/* Action buttons removed as requested */}
            </div>

            {/* Progress */}
            <div className="flex items-center gap-3">
                <div className="flex-1 h-1.5 rounded-full overflow-hidden bg-white/10">
                    <div className="h-full rounded-full transition-all duration-500 shadow-[0_0_10px_rgba(0,245,160,0.5)]" style={{ width: `${progressPct}%`, background: '#00F5A0' }} />
                </div>
                <span className="text-[11px] font-mono font-bold text-[#00F5A0] shrink-0">{stats.done}/{stats.total}</span>
            </div>
        </div>);

}