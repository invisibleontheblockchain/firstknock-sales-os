import React from 'react';
import { BarChart3, Flame, Sparkles } from 'lucide-react';

const ranges = [7, 30, 90];

export default function RepAnalyticsHeader({ dateDays, onChangeDays, streak, nextAction }) {
  return (
    <div className="sticky top-0 z-20 px-4 md:px-6 pt-4 pb-4 border-b border-white/5 backdrop-blur-xl bg-black/70">
      <div className="flex flex-col gap-4 max-w-7xl mx-auto">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center bg-white/5 border border-white/10 shadow-xl">
              <BarChart3 className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-black text-white tracking-tight">My Analytics</h1>
              <p className="text-sm text-gray-400">Personal performance, pipeline, and field timing</p>
            </div>
          </div>

          <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-2xl p-1 w-fit">
            {ranges.map((range) => (
              <button
                key={range}
                onClick={() => onChangeDays(range)}
                className={`px-3 py-2 rounded-xl text-xs font-bold transition-all ${dateDays === range ? 'bg-white text-black' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
              >
                {range}D
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[220px,1fr] gap-3">
          <div className="rounded-2xl border border-orange-500/20 bg-gradient-to-br from-orange-500/15 to-yellow-500/10 p-4">
            <div className="flex items-center gap-2 mb-2">
              <Flame className="w-4 h-4 text-orange-400" />
              <span className="text-[11px] font-bold uppercase tracking-[0.2em] text-orange-300">Streak</span>
            </div>
            <div className="text-3xl font-black text-white">{streak}</div>
            <p className="text-xs text-gray-300 mt-1">{streak === 1 ? 'active day' : 'active days'} in a row</p>
          </div>

          <div className="rounded-2xl border border-cyan-500/20 bg-gradient-to-br from-cyan-500/10 to-blue-500/10 p-4">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="w-4 h-4 text-cyan-300" />
              <span className="text-[11px] font-bold uppercase tracking-[0.2em] text-cyan-200">Next Best Action</span>
            </div>
            <div className="text-lg font-bold text-white">{nextAction.title}</div>
            <p className="text-sm text-gray-300 mt-1">{nextAction.body}</p>
          </div>
        </div>
      </div>
    </div>
  );
}