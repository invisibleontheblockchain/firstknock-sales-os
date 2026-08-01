import React from 'react';
import { Route as RouteIcon, Flame, Clock } from 'lucide-react';

export default function CommandRoutePulse({ routeCounts, bestRoutes, activeRoutes }) {
    return (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 lg:gap-4">
            {/* Route overview + best performing routes */}
            <div className="flex flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <div className="flex items-center gap-2">
                    <RouteIcon className="h-4 w-4 text-[#39FF4A]" />
                    <span className="text-[10px] font-black uppercase tracking-[0.16em] text-white lg:text-[11px]">Route Overview</span>
                </div>

                <div className="mt-3 grid grid-cols-4 gap-2">
                    {routeCounts.map(c => (
                        <div key={c.label} className="rounded-xl border border-white/[0.07] bg-black/40 px-2 py-2.5 text-center">
                            <p className="font-mono text-lg font-black tabular-nums text-white lg:text-xl" style={{ color: c.color }}>{c.value}</p>
                            <p className="mt-0.5 text-[8px] font-black uppercase tracking-[0.1em] text-white/40 lg:text-[9px]">{c.label}</p>
                        </div>
                    ))}
                </div>

                <div className="mt-4 flex items-center gap-2">
                    <Flame className="h-3.5 w-3.5 text-[#39FF4A]" />
                    <span className="text-[9px] font-black uppercase tracking-[0.16em] text-white/70">Best Performing Routes</span>
                </div>

                {bestRoutes.length === 0 ? (
                    <p className="mt-3 text-[11px] font-bold text-white/35">No route activity yet</p>
                ) : (
                    <div className="mt-2 space-y-1.5">
                        {bestRoutes.map((r, idx) => (
                            <div key={r.id} className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-black/40 px-3 py-2">
                                <span className="font-mono text-[11px] font-black text-white/30">{idx + 1}</span>
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-[12px] font-bold text-white">{r.name}</p>
                                    <p className="truncate text-[9px] font-bold text-white/35">{r.assigned_to_name || 'Unassigned'}</p>
                                </div>
                                <div className="shrink-0 text-right">
                                    <p className="font-mono text-[12px] font-black tabular-nums text-[#39FF4A]">{r.sales} sales</p>
                                    <p className="text-[9px] font-bold text-white/35">{r.knocks} knocks · {r.conversion}%</p>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Active route progress */}
            <div className="flex flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-[#39FF4A]" />
                    <span className="text-[10px] font-black uppercase tracking-[0.16em] text-white lg:text-[11px]">Live Route Progress</span>
                    <span className="ml-auto rounded-full bg-white/[0.06] px-2 py-0.5 text-[9px] font-bold text-white/50">{activeRoutes.length}</span>
                </div>

                {activeRoutes.length === 0 ? (
                    <div className="flex flex-1 items-center justify-center py-8 text-[11px] font-bold text-white/35">
                        No active routes
                    </div>
                ) : (
                    <div className="mt-3 max-h-[260px] space-y-2 overflow-y-auto pr-1">
                        {activeRoutes.map(route => (
                            <div key={route.id} className="rounded-xl border border-white/[0.06] bg-black/40 p-3">
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <p className="truncate text-[12px] font-bold text-white">{route.name}</p>
                                        <p className="truncate text-[9px] font-bold text-white/35">{route.assigned_to_name || 'Unassigned'}</p>
                                    </div>
                                    <span className="font-mono text-[11px] font-black tabular-nums text-[#39FF4A]">{route.pct}%</span>
                                </div>
                                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-black/70">
                                    <div
                                        className="h-full rounded-full transition-all duration-500"
                                        style={{ width: `${route.pct}%`, background: 'linear-gradient(90deg,#2EEB57,#39FF4A)' }}
                                    />
                                </div>
                                <p className="mt-1.5 text-[9px] font-bold text-white/35">{route.done} of {route.total} doors knocked</p>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}