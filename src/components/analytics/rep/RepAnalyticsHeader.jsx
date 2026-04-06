import React from 'react';
import { Flame, BarChart3 } from 'lucide-react';

const ranges = [
  { value: 1, label: 'Today' },
  { value: 7, label: '7D' },
  { value: 30, label: '30D' },
  { value: 90, label: '90D' },
  { value: 99999, label: 'All' },
];

export default function RepAnalyticsHeader({ dateDays, onChangeDays, streak }) {
  return (
    <div className="px-3 md:px-6 pt-4 pb-3 max-w-7xl mx-auto">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 md:w-10 md:h-10 rounded-xl bg-gradient-to-br from-white/10 to-white/5 border border-white/10 flex items-center justify-center shrink-0">
            <BarChart3 className="w-4 h-4 md:w-5 md:h-5 text-white" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg md:text-xl font-black text-white tracking-tight leading-tight">Analytics</h1>
            <p className="text-[10px] md:text-xs text-gray-500 font-medium truncate">Performance dashboard</p>
          </div>
          {streak > 0 && (
            <div className="hidden sm:flex items-center gap-1 bg-orange-500/10 border border-orange-500/20 rounded-full px-2.5 py-1 shrink-0">
              <Flame className="w-3 h-3 text-orange-400" />
              <span className="text-[10px] font-black text-orange-300">{streak}d</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-0.5 bg-white/[0.04] border border-white/[0.06] rounded-lg p-0.5 shrink-0">
          {ranges.map((r) => (
            <button
              key={r.value}
              onClick={() => onChangeDays(r.value)}
              className={`px-2 md:px-3 py-1.5 rounded-md text-[10px] md:text-xs font-bold transition-all duration-200 whitespace-nowrap ${
                dateDays === r.value
                  ? 'bg-white text-black shadow-lg shadow-white/10'
                  : 'text-gray-500 hover:text-white hover:bg-white/5'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}