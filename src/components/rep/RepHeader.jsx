import React from 'react';
import { WifiOff, MapPin, Navigation, ChevronDown, CheckCircle2, RefreshCw } from 'lucide-react';
import { useIsMutating } from '@tanstack/react-query';

export default function RepHeader({ user, isOffline, activeRoute, stats, knockWindow, routes, onShowMap, onShowRouteList, routeProperties }) {
  const progressPct = stats.total > 0 ? stats.done / stats.total * 100 : 0;
  const isMutating = useIsMutating();

  // Sync UI Logic
  const syncState = isOffline ?
  { dot: 'bg-[#FF6B6B]', text: 'text-[#FF6B6B]', label: 'OFFLINE', icon: WifiOff } :
  isMutating > 0 ?
  { dot: 'bg-[#39FF4A]', text: 'text-[#39FF4A]', label: `SYNCING (${isMutating})`, icon: RefreshCw } :
  { dot: 'bg-[#2EEB57]', text: 'text-[#2EEB57]', label: 'LIVE', icon: CheckCircle2 };

  return (
    <div className="sticky top-0 z-30 px-3 pt-2 pb-2 bg-black/95 backdrop-blur-2xl border-b border-white/10 shadow-[0_12px_42px_rgba(0,0,0,0.48)]">
            <div className="absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent via-[#2EEB57]/45 to-transparent" />
            <div className="rounded-2xl border border-white/10 bg-white/[0.035] px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] space-y-2">
            {/* Top row */}
            <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 shadow-[0_0_18px_rgba(46,235,87,0.24)] border border-[#2EEB57]/35" style={{ background: 'linear-gradient(135deg, rgba(46,235,87,0.22), rgba(255,255,255,0.08))' }}>
                    <Navigation className="w-4 h-4 text-[#39FF4A]" />
                </div>

                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                        <h2 className="font-extrabold text-[15px] text-white truncate tracking-tight">{activeRoute.name}</h2>
                        {routes.length > 1 &&
            <button onClick={onShowRouteList} className="shrink-0">
                                <ChevronDown className="w-3.5 h-3.5 text-gray-600" />
                            </button>
            }
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-[9px] font-semibold text-white/45 tracking-wide">{stats.total} STOPS</span>
                        <div className="w-1 h-1 rounded-full bg-white/15" />
                        <span className={`flex items-center gap-1 text-[8px] font-black tracking-[0.16em] ${syncState.text}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${syncState.dot} ${isMutating > 0 ? 'animate-pulse' : 'shadow-[0_0_10px_rgba(46,235,87,0.9)]'}`} />
                            {syncState.label}
                        </span>
                    </div>
                </div>

                {/* Action buttons removed as requested */}
            </div>

            {/* Progress */}
            <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 rounded-full overflow-hidden bg-black/60 border border-white/10">
                    <div className="h-full rounded-full transition-all duration-500 shadow-[0_0_14px_rgba(46,235,87,0.55)]" style={{ width: `${progressPct}%`, background: 'linear-gradient(90deg, #2EEB57, #39FF4A)' }} />
                </div>
                <span className="text-[10px] font-mono font-black text-white shrink-0">{stats.done}<span className="text-white/35">/{stats.total}</span></span>
            </div>
            </div>
        </div>);

}