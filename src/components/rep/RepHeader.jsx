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
    <div className="sticky top-0 z-30 px-4 pt-4 pb-4 bg-black/95 backdrop-blur-2xl border-b border-white/10 shadow-[0_18px_60px_rgba(0,0,0,0.55)]">
            <div className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-[#2EEB57]/45 to-transparent" />
            <div className="rounded-3xl border border-white/10 bg-white/[0.035] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] space-y-3">
            {/* Top row */}
            <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 shadow-[0_0_24px_rgba(46,235,87,0.28)] border border-[#2EEB57]/35" style={{ background: 'linear-gradient(135deg, rgba(46,235,87,0.22), rgba(255,255,255,0.08))' }}>
                    <Navigation className="w-5 h-5 text-[#39FF4A]" />
                </div>

                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                        <h2 className="font-extrabold text-[17px] text-white truncate tracking-tight">{activeRoute.name}</h2>
                        {routes.length > 1 &&
            <button onClick={onShowRouteList} className="shrink-0">
                                <ChevronDown className="w-3.5 h-3.5 text-gray-600" />
                            </button>
            }
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] font-semibold text-white/45 tracking-wide">{stats.total} STOPS</span>
                        <div className="w-1 h-1 rounded-full bg-white/15" />
                        <span className="text-[10px] font-semibold text-white/45">{knockWindow.emoji} {knockWindow.label}</span>
                        <div className="w-1 h-1 rounded-full bg-white/15" />
                        <span className={`flex items-center gap-1.5 text-[9px] font-black tracking-[0.18em] ${syncState.text}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${syncState.dot} ${isMutating > 0 ? 'animate-pulse' : 'shadow-[0_0_10px_rgba(46,235,87,0.9)]'}`} />
                            {syncState.label}
                        </span>
                    </div>
                </div>

                {/* Action buttons removed as requested */}
            </div>

            {/* Progress */}
            <div className="flex items-center gap-3">
                <div className="flex-1 h-2 rounded-full overflow-hidden bg-black/60 border border-white/10">
                    <div className="h-full rounded-full transition-all duration-500 shadow-[0_0_18px_rgba(46,235,87,0.6)]" style={{ width: `${progressPct}%`, background: 'linear-gradient(90deg, #2EEB57, #39FF4A)' }} />
                </div>
                <span className="text-[11px] font-mono font-black text-white shrink-0">{stats.done}<span className="text-white/35">/{stats.total}</span></span>
            </div>
            </div>
        </div>);

}