import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clock, TrendingUp, X } from 'lucide-react';
import { getKnockWindowLabel, getNextBestWindow, getDailySchedule } from '../logic/knockTimeOptimizer';

export default function KnockTimeBanner({ expanded = false, onToggle }) {
  const [mounted, setMounted] = useState(false);
  const now = new Date();
  const knockWindow = getKnockWindowLabel(now);
  const nextWindows = getNextBestWindow(now);
  const schedule = getDailySchedule(now);
  
  const hour = now.getHours();
  const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  const ampm = hour >= 12 ? 'PM' : 'AM';

  useEffect(() => {
    setMounted(true);
  }, []);

  const Modal = () => (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" 
        onClick={onToggle} 
      />
      
      {/* Content */}
      <div 
        className="relative w-[95%] max-w-sm bg-[#111] border border-[#333] rounded-2xl shadow-2xl p-5 animate-in zoom-in-95 slide-in-from-bottom-5 duration-200 overflow-y-auto max-h-[80vh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div 
              className="w-10 h-10 rounded-xl flex items-center justify-center shadow-lg shrink-0"
              style={{ background: `${knockWindow.color}20`, boxShadow: `0 0 15px ${knockWindow.color}10` }}
            >
              <Clock className="w-5 h-5" style={{ color: knockWindow.color }} />
            </div>
            <div>
              <h3 className="text-base font-bold leading-none mb-1" style={{ color: knockWindow.color }}>
                {knockWindow.emoji} {knockWindow.label}
              </h3>
              <p className="text-[10px] text-gray-400 font-medium">
                Current Time: {displayHour}:{String(now.getMinutes()).padStart(2, '0')} {ampm}
              </p>
            </div>
          </div>
          <button 
            onClick={onToggle} 
            className="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-700 transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-3">
          {/* Schedule Grid */}
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="p-2.5 rounded-xl bg-red-500/10 border border-red-500/20">
              <p className="text-[9px] text-red-400 font-bold mb-1 tracking-wider uppercase">AVOID</p>
              <p className="text-[10px] sm:text-xs text-gray-300 font-medium leading-tight">{schedule.avoid}</p>
            </div>
            <div className="p-2.5 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
              <p className="text-[9px] text-yellow-400 font-bold mb-1 tracking-wider uppercase">GOOD</p>
              <p className="text-[10px] sm:text-xs text-gray-300 font-medium leading-tight">{schedule.good}</p>
            </div>
            <div className="p-2.5 rounded-xl bg-green-500/10 border border-green-500/20">
              <p className="text-[9px] text-green-400 font-bold mb-1 tracking-wider uppercase">BEST</p>
              <p className="text-[10px] sm:text-xs text-gray-300 font-medium leading-tight">{schedule.best}</p>
            </div>
          </div>

          {/* Next Windows */}
          {nextWindows.length > 0 && (
            <div className="bg-gray-900/50 rounded-xl p-3 border border-gray-800">
              <p className="text-[10px] font-bold text-gray-500 mb-2 flex items-center gap-1.5 uppercase tracking-wider">
                <TrendingUp className="w-3 h-3" /> Upcoming Prime Times
              </p>
              <div className="flex flex-wrap gap-2">
                {nextWindows.map((w, i) => (
                  <div 
                    key={i}
                    className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-green-500/10 text-green-400 border border-green-500/20"
                  >
                    {w.label}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tip */}
          <div className="p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 flex gap-3 items-start">
            <span className="text-lg shrink-0">💡</span>
            <div>
              <p className="text-[10px] font-bold text-blue-400 uppercase tracking-wider mb-0.5">Pro Tip</p>
              <p className="text-[11px] text-blue-100/90 leading-relaxed">
                {schedule.tip}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <button
        onClick={onToggle}
        className="flex items-center gap-2 px-3 py-2 rounded-lg border transition-all active:scale-95 h-full max-h-[42px]"
        style={{ 
          background: `${knockWindow.color}20`, 
          borderColor: `${knockWindow.color}50`,
        }}
      >
        <Clock className="w-3.5 h-3.5" style={{ color: knockWindow.color }} />
        <div className="flex flex-col items-start leading-none gap-0.5">
           <span className="text-[11px] font-bold whitespace-nowrap" style={{ color: knockWindow.color }}>
             {knockWindow.emoji} {knockWindow.label}
           </span>
           <span className="text-[9px] text-gray-400 whitespace-nowrap opacity-80">
             {displayHour}{ampm}
           </span>
        </div>
      </button>

      {expanded && mounted && createPortal(<Modal />, document.body)}
    </>
  );
}