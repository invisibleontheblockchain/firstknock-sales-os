import React from 'react';
import { Clock, TrendingUp, Calendar } from 'lucide-react';
import { getKnockWindowLabel, getNextBestWindow, getDailySchedule } from '../logic/knockTimeOptimizer';

export default function KnockTimeBanner({ expanded = false, onToggle }) {
  const now = new Date();
  const window = getKnockWindowLabel(now);
  const nextWindows = getNextBestWindow(now);
  const schedule = getDailySchedule(now);
  
  const hour = now.getHours();
  const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  const ampm = hour >= 12 ? 'PM' : 'AM';

  if (!expanded) {
    // Compact banner
    return (
      <button
        onClick={onToggle}
        className="flex items-center gap-2 px-3 py-2 rounded-lg border transition-all hover:scale-105"
        style={{ 
          background: `${window.color}20`, 
          borderColor: `${window.color}50`,
        }}
      >
        <Clock className="w-4 h-4" style={{ color: window.color }} />
        <span className="text-xs font-bold" style={{ color: window.color }}>
          {window.emoji} {window.label}
        </span>
        <span className="text-[10px] text-gray-400">
          {displayHour}{ampm}
        </span>
      </button>
    );
  }

  // Expanded view
  return (
    <div 
      className="p-4 rounded-xl border space-y-3"
      style={{ background: '#111', borderColor: '#333' }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div 
            className="w-10 h-10 rounded-lg flex items-center justify-center"
            style={{ background: `${window.color}20` }}
          >
            <Clock className="w-5 h-5" style={{ color: window.color }} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold" style={{ color: window.color }}>
                {window.emoji} {window.label}
              </span>
            </div>
            <span className="text-xs text-gray-500">
              Current: {displayHour}:{String(now.getMinutes()).padStart(2, '0')} {ampm}
            </span>
          </div>
        </div>
        <button onClick={onToggle} className="text-gray-500 text-xs">
          Close
        </button>
      </div>

      {/* Today's Schedule */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="p-2 rounded-lg bg-red-500/10 border border-red-500/30">
          <p className="text-[10px] text-red-400 font-bold">AVOID</p>
          <p className="text-[10px] text-gray-400">{schedule.avoid}</p>
        </div>
        <div className="p-2 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
          <p className="text-[10px] text-yellow-400 font-bold">GOOD</p>
          <p className="text-[10px] text-gray-400">{schedule.good}</p>
        </div>
        <div className="p-2 rounded-lg bg-green-500/10 border border-green-500/30">
          <p className="text-[10px] text-green-400 font-bold">BEST</p>
          <p className="text-[10px] text-gray-400">{schedule.best}</p>
        </div>
      </div>

      {/* Next Best Windows */}
      {nextWindows.length > 0 && (
        <div>
          <p className="text-[10px] font-bold text-gray-500 mb-2 flex items-center gap-1">
            <TrendingUp className="w-3 h-3" /> NEXT PRIME WINDOWS
          </p>
          <div className="flex gap-2">
            {nextWindows.map((w, i) => (
              <div 
                key={i}
                className="px-3 py-1.5 rounded-full text-xs font-bold bg-green-500/20 text-green-400 border border-green-500/30"
              >
                {w.label}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pro Tip */}
      <div className="p-2 rounded-lg bg-blue-500/10 border border-blue-500/30">
        <p className="text-[10px] text-blue-400">
          <span className="font-bold">💡 TIP:</span> {schedule.tip}
        </p>
      </div>
    </div>
  );
}