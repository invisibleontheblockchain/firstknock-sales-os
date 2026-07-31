import React from 'react';
import { Clock, Phone, CheckCircle2, AlertTriangle } from 'lucide-react';

// The page now opens on Today, so the summary is a focus strip: each tile is a
// shortcut into the view it counts instead of a decorative statistic.
export default function TodayFocusBar({ stats, timeFilter, sourceFilter, onFocusToday, onFocusCallbacks, onFocusStatus }) {
    const tiles = [
        {
            id: 'today',
            icon: Clock,
            label: 'Today',
            value: stats.today,
            color: '#39FF4A',
            active: timeFilter === 'today' && sourceFilter === 'all',
            onClick: onFocusToday,
        },
        {
            id: 'callbacks',
            icon: Phone,
            label: 'Callbacks',
            value: stats.callbacks,
            color: '#60a5fa',
            active: sourceFilter === 'callbacks',
            onClick: onFocusCallbacks,
        },
        {
            id: 'completed',
            icon: CheckCircle2,
            label: 'Done',
            value: stats.completed,
            color: '#34d399',
            active: false,
            onClick: () => onFocusStatus('completed'),
        },
        {
            id: 'no_show',
            icon: AlertTriangle,
            label: 'No-show',
            value: stats.noShow,
            color: '#fbbf24',
            active: false,
            onClick: () => onFocusStatus('no_show'),
        },
    ];

    return (
        <div className="grid grid-cols-4 gap-1.5 sm:gap-2">
            {tiles.map((tile) => (
                <button
                    key={tile.id}
                    onClick={tile.onClick}
                    className={`flex items-center gap-2 px-2 sm:px-3 py-2 rounded-xl border transition-all text-left ${
                        tile.active ? 'bg-white/[0.07] border-white/15' : 'bg-white/[0.02] border-white/[0.05] hover:bg-white/[0.05]'
                    }`}
                >
                    <tile.icon className="w-3.5 h-3.5 shrink-0" style={{ color: tile.color }} />
                    <div className="min-w-0">
                        <p className="text-sm sm:text-base font-black text-white leading-none">{tile.value}</p>
                        <p className="text-[9px] text-gray-500 font-medium truncate">{tile.label}</p>
                    </div>
                </button>
            ))}
        </div>
    );
}