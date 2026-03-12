import React from 'react';
import { Flame } from 'lucide-react';

const ranges = [7, 30, 90];

export default function RepAnalyticsHeader({ dateDays, onChangeDays, streak }) {
  return (
    <div className="px-4 md:px-6 pt-5 pb-4 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        {/* Title + Streak */}
        <div className="flex items-center gap-4">
          <div>
            <h1 className="text-2xl font-black text-white tracking-tight">Analytics</h1>
            <p className="text-sm text-gray-500 mt-0.5">Your personal performance dashboard</p>
          </div>
          {streak > 0 && (
            <div className="flex items-center gap-1.5 bg-orange-500/10 border border-orange-500/20 rounded-full px-3 py-1.5">
              <Flame className="w-3.5 h-3.5 text-orange-400" />
              <span className="text-xs font-black text-orange-300">{streak}d streak</span>
            </div>
          )}
        </div>

        {/* Date range toggle */}
        <div className="flex items-center gap-1 bg-white/[0.04] border border-white/[0.06] rounded-xl p-1">
          {ranges.map((r) => (
            <button
              key={r}
              onClick={() => onChangeDays(r)}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition-all duration-200 ${
                dateDays === r
                  ? 'bg-white text-black shadow-lg shadow-white/10'
                  : 'text-gray-500 hover:text-white hover:bg-white/5'
              }`}
            >
              {r}D
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}