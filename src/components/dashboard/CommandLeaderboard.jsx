import React from 'react';
import { Trophy, Medal } from 'lucide-react';

const RANK_COLORS = ['#2EEB57', '#d4d4d8', '#cd7f32'];

export default function CommandLeaderboard({ leaderboard }) {
    const topKnocks = Math.max(1, ...leaderboard.map(r => r.knocks));

    return (
        <div className="flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03]">
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
                <Trophy className="h-4 w-4 text-[#39FF4A]" />
                <span className="text-[10px] font-black uppercase tracking-[0.16em] text-white lg:text-[11px]">
                    Rep Leaderboard
                </span>
                <span className="ml-auto rounded-full bg-white/[0.06] px-2 py-0.5 text-[9px] font-bold text-white/50">
                    {leaderboard.length} active
                </span>
            </div>

            {leaderboard.length === 0 ? (
                <div className="p-8 text-center text-[11px] font-bold text-white/35">
                    No activity in this timeframe
                </div>
            ) : (
                <div className="divide-y divide-white/[0.06]">
                    {leaderboard.map((rep, idx) => (
                        <div key={rep.email} className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-white/[0.03] lg:px-4 lg:py-3">
                            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-white/10 bg-black/50">
                                {idx < 3
                                    ? <Medal className="h-3.5 w-3.5" style={{ color: RANK_COLORS[idx] }} />
                                    : <span className="text-[10px] font-black text-white/40">{idx + 1}</span>}
                            </div>

                            <div className="min-w-0 flex-1">
                                <p className="truncate text-[12px] font-bold capitalize text-white lg:text-[13px]">{rep.name}</p>
                                <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-black/60">
                                    <div
                                        className="h-full rounded-full"
                                        style={{
                                            width: `${Math.round((rep.knocks / topKnocks) * 100)}%`,
                                            background: 'linear-gradient(90deg,#2EEB57,#39FF4A)'
                                        }}
                                    />
                                </div>
                            </div>

                            <div className="grid shrink-0 grid-cols-3 gap-2 text-right lg:gap-4">
                                <div>
                                    <p className="font-mono text-[12px] font-black tabular-nums text-white lg:text-[13px]">{rep.knocks}</p>
                                    <p className="text-[8px] font-bold uppercase tracking-wide text-white/35">Knocks</p>
                                </div>
                                <div>
                                    <p className="font-mono text-[12px] font-black tabular-nums text-[#39FF4A] lg:text-[13px]">{rep.sales}</p>
                                    <p className="text-[8px] font-bold uppercase tracking-wide text-white/35">Sales</p>
                                </div>
                                <div>
                                    <p className="font-mono text-[12px] font-black tabular-nums text-white/70 lg:text-[13px]">{rep.conversion}%</p>
                                    <p className="text-[8px] font-bold uppercase tracking-wide text-white/35">Conv</p>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}