import React from 'react';
import { Target, Users } from 'lucide-react';

export default function RouteModeToggle({ routeMode, onChange }) {
  const modes = [
    { key: 'canvas', label: 'CANVAS', shortLabel: 'CAN', icon: Users, activeClass: 'bg-purple-600 text-white' },
    { key: 'precision', label: 'PRECISION', shortLabel: 'PRE', icon: Target, activeClass: 'bg-yellow-500 text-black' },
  ];

  return (
    <div className="bg-black/80 backdrop-blur-md rounded-lg sm:rounded-xl p-0.5 sm:p-1 border border-white/10 flex gap-0.5 shadow-xl shrink-0">
      {modes.map(({ key, label, shortLabel, icon: Icon, activeClass }) => (
        <button
          key={key}
          onClick={() => onChange(key)}
          aria-label={`${label} mode`}
          title={`${label} mode`}
          className={`h-7 sm:h-9 px-1.5 sm:px-2.5 lg:px-3 rounded-md sm:rounded-lg text-[9px] sm:text-[10px] font-bold flex items-center justify-center gap-1 transition-all whitespace-nowrap min-w-[34px] sm:min-w-[72px] lg:min-w-[92px] ${routeMode === key ? activeClass : 'text-gray-400 hover:text-white'}`}
        >
          <Icon className="w-3 h-3 shrink-0" />
          <span className="hidden sm:inline lg:hidden">{shortLabel}</span>
          <span className="hidden lg:inline">{label}</span>
        </button>
      ))}
    </div>
  );
}