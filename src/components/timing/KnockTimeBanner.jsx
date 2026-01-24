import React from 'react';
import { Clock, TrendingUp, Calendar, X } from 'lucide-react';
import { getKnockWindowLabel, getNextBestWindow, getDailySchedule } from '../logic/knockTimeOptimizer';

export default function KnockTimeBanner({ expanded = false, onToggle }) {
  const now = new Date();
  const knockWindow = getKnockWindowLabel(now);
  const nextWindows = getNextBestWindow(now);
  const schedule = getDailySchedule(now);
  
  const hour = now.getHours();
  const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  const ampm = hour >= 12 ? 'PM' : 'AM';

  // Always render the trigger button to maintain layout in the scroll bar
  return (
    <>
      <button
        onClick={onToggle}
        className="flex items-center gap-2 px-3 py-2 rounded-lg border transition-all hover:scale-105 active:scale-95"
        style={{ 
          background: `${knockWindow.color}20`, 
          borderColor: `${knockWindow.color}50`,
        }}
      >
        <Clock className="w-4 h-4" style={{ color: knockWindow.color }} />
        <span className="text-xs font-bold whitespace-nowrap" style={{ color: knockWindow.color }}>
          {knockWindow.emoji} {knockWindow.label}
        </span>
        <span className="text-[10px] text-gray-400 whitespace-nowrap">
          {displayHour}{ampm}
        </span>
      </button>

      {/* Expanded Overlay - Fixed Position (Modal) */}
      {expanded && (
        <div className="fixed inset-0 z-[3000] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onToggle} />
          
          <div 
            className="relative w-full max-w-sm bg-[#111] border border-[#333] rounded-2xl shadow-2xl p-5 animate-in zoom-in-95 duration-200"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div 
                  className="w-12 h-12 rounded-xl flex items-center justify-center shadow-lg"
                  style={{ background: `${knockWindow.color}20`, boxShadow: `0 0 20px ${knockWindow.color}20` }}
                >
                  <Clock className="w-6 h-6" style={{ color: knockWindow.color }} />
                </div>
                <div>
                  <h3 className="text-lg font-bold leading-none mb-1" style={{ color: knockWindow.color }}>
                    {knockWindow.emoji} {knockWindow.label}
                  </h3>
                  <p className="text-xs text-gray-400">
                    Current Time: {displayHour}:{String(now.getMinutes()).padStart(2, '0')} {ampm}
                  </p>
                </div>
              </div>
              <button 
                onClick={onToggle} 
                className="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Today's Schedule */}
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20">
                  <p className="text-[10px] text-red-400 font-bold mb-1 tracking-wider">AVOID</p>
                  <p className="text-xs text-gray-300 font-medium">{schedule.avoid}</p>
                </div>
                <div className="p-3 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
                  <p className="text-[10px] text-yellow-400 font-bold mb-1 tracking-wider">GOOD</p>
                  <p className="text-xs text-gray-300 font-medium">{schedule.good}</p>
                </div>
                <div className="p-3 rounded-xl bg-green-500/10 border border-green-500/20">
                  <p className="text-[10px] text-green-400 font-bold mb-1 tracking-wider">BEST</p>
                  <p className="text-xs text-gray-300 font-medium">{schedule.best}</p>
                </div>
              </div>

              {/* Next Best Windows */}
              {nextWindows.length > 0 && (
                <div className="bg-gray-900/50 rounded-xl p-4 border border-gray-800">
                  <p className="text-[10px] font-bold text-gray-500 mb-3 flex items-center gap-2 uppercase tracking-wider">
                    <TrendingUp className="w-3 h-3" /> Upcoming Prime Times
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {nextWindows.map((w, i) => (
                      <div 
                        key={i}
                        className="px-3 py-1.5 rounded-full text-xs font-bold bg-green-500/10 text-green-400 border border-green-500/20"
                      >
                        {w.label}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Pro Tip */}
              <div className="p-4 rounded-xl bg-blue-500/10 border border-blue-500/20 flex gap-3">
                <span className="text-xl">💡</span>
                <div>
                  <p className="text-[10px] font-bold text-blue-400 uppercase tracking-wider mb-1">Pro Tip</p>
                  <p className="text-xs text-blue-100/80 leading-relaxed">
                    {schedule.tip}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}