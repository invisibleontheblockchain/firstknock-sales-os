import React from 'react';
import { WifiOff, Navigation, ChevronDown, CheckCircle2, RefreshCw } from 'lucide-react';
import { useIsMutating } from '@tanstack/react-query';

export default function RepHeader({
  user,
  isOffline,
  activeRoute,
  stats,
  knockWindow,
  routes = [],
  onShowMap,
  onShowRouteList,
  routeListOpen = false,
  routeProperties,
  onStartNavigation,
  navigationDisabled = false,
  navigationButtonLabel = 'Start',
  navigationBatchLabel = '',
  navigationError = '',
}) {
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
            {/* Route identity and actions */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="flex min-w-0 items-center gap-2.5 sm:flex-1">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-[#2EEB57]/35 shadow-[0_0_18px_rgba(46,235,87,0.24)]" style={{ background: 'linear-gradient(135deg, rgba(46,235,87,0.22), rgba(255,255,255,0.08))' }}>
                        <Navigation className="h-4 w-4 text-[#39FF4A]" />
                    </div>

                    <div className="min-w-0 flex-1">
                        <h2 className="break-words text-[15px] font-extrabold leading-tight tracking-tight text-white sm:truncate">{activeRoute.name}</h2>
                        <div className="mt-0.5 flex items-center gap-1.5">
                            <span className="text-[9px] font-semibold tracking-wide text-white/45">{stats.total} STOPS</span>
                            <div className="h-1 w-1 rounded-full bg-white/15" />
                            <span className={`flex items-center gap-1 text-[8px] font-black tracking-[0.16em] ${syncState.text}`}>
                                <span className={`h-1.5 w-1.5 rounded-full ${syncState.dot} ${isMutating > 0 ? 'animate-pulse' : 'shadow-[0_0_10px_rgba(46,235,87,0.9)]'}`} />
                                {syncState.label}
                            </span>
                        </div>
                    </div>
                </div>

                <div className={`grid gap-2 sm:flex sm:shrink-0 ${routes.length > 0 ? 'grid-cols-[minmax(0,1fr)_auto]' : 'grid-cols-1 justify-items-end'}`}>
                    {routes.length > 0 &&
                    <button
                        type="button"
                        onClick={onShowRouteList}
                        aria-label={`Switch route. ${routes.length} route${routes.length === 1 ? '' : 's'} available`}
                        aria-expanded={routeListOpen}
                        aria-controls="rep-route-switcher"
                        className="flex min-h-10 min-w-0 items-center justify-between gap-1 rounded-xl border border-white/10 bg-white/[0.05] px-3 py-1 text-[9px] font-black uppercase tracking-[0.08em] text-white/55 transition hover:border-white/20 hover:text-white sm:shrink-0 sm:justify-center"
                    >
                        <span className="truncate">{routes.length} route{routes.length === 1 ? '' : 's'}</span>
                        <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${routeListOpen ? 'rotate-180' : ''}`} />
                    </button>
                    }

                    <button
                        type="button"
                        onClick={onStartNavigation}
                        disabled={navigationDisabled}
                        aria-label={`${navigationButtonLabel} route navigation${navigationBatchLabel ? `, ${navigationBatchLabel}` : ''}`}
                        className="flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-white/15 bg-white/[0.06] px-3 text-[10px] font-bold uppercase tracking-[0.08em] text-white/85 transition hover:border-white/25 hover:bg-white/[0.12] hover:text-white active:scale-95 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/5 disabled:text-white/30"
                    >
                        <Navigation className="h-3.5 w-3.5" />
                        <span>{navigationButtonLabel}</span>
                        {navigationBatchLabel && <span className="text-[8px] opacity-60">{navigationBatchLabel}</span>}
                    </button>
                </div>
            </div>

            {/* Progress */}
            <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 rounded-full overflow-hidden bg-black/60 border border-white/10">
                    <div className="h-full rounded-full transition-all duration-500 shadow-[0_0_14px_rgba(46,235,87,0.55)]" style={{ width: `${progressPct}%`, background: 'linear-gradient(90deg, #2EEB57, #39FF4A)' }} />
                </div>
                <span className="text-[10px] font-mono font-black text-white shrink-0">{stats.done}<span className="text-white/35">/{stats.total}</span></span>
            </div>
            {navigationError && <p role="alert" className="text-[10px] font-semibold text-red-300">{navigationError}</p>}
            </div>
        </div>);

}