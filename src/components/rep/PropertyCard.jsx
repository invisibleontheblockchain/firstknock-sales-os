import React from 'react';
import { Navigation, CheckCircle2, Circle, Clock, AlertTriangle, Home } from 'lucide-react';

const STATUS_ICON = {
    ELIGIBLE: Circle,
    SOLD: CheckCircle2,
    HARD_NO: AlertTriangle,
    CALLBACK: Clock,
    NO_ANSWER: Home,
};

const STATUS_COLOR = {
    ELIGIBLE: 'text-gray-500 bg-gray-500/10',
    SOLD: 'text-green-500 bg-green-500/10',
    HARD_NO: 'text-purple-500 bg-purple-500/10',
    CALLBACK: 'text-yellow-500 bg-yellow-500/10',
    NO_ANSWER: 'text-orange-500 bg-orange-500/10',
};

export default function PropertyCard({ property, index, onSelect }) {
    const isDone = property.effective_status !== 'ELIGIBLE' && property.effective_status !== 'CALLBACK';
    const Icon = STATUS_ICON[property.effective_status] || Circle;
    const colorClass = STATUS_COLOR[property.effective_status] || STATUS_COLOR.ELIGIBLE;

    return (
        <button
            onClick={() => onSelect(property)}
            className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all active:scale-[0.98] ${
                isDone 
                    ? 'bg-gray-900/30 border-gray-800/50 opacity-60' 
                    : 'bg-[#151515] border-gray-800 hover:border-yellow-500/40'
            }`}
        >
            {/* Order number */}
            <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${
                isDone ? 'bg-gray-800 text-gray-600' : 'bg-yellow-500/10 text-yellow-500'
            }`}>
                {index + 1}
            </div>

            {/* Address - the most important info */}
            <div className="flex-1 min-w-0 text-left">
                <p className={`font-bold text-sm truncate ${isDone ? 'text-gray-500 line-through' : 'text-white'}`}>
                    {property.house_number} {property.street_name}
                </p>
                {property.timeScore > 80 && !isDone && (
                    <p className="text-[10px] text-green-500 font-bold mt-0.5">⏰ BEST TIME NOW</p>
                )}
            </div>

            {/* Status indicator */}
            <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${colorClass}`}>
                <Icon className="w-4 h-4" />
            </div>

            {/* Navigate shortcut */}
            {!isDone && (
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        window.open(`https://maps.apple.com/?daddr=${property.lat},${property.lng}&dirflg=w`, '_blank');
                    }}
                    className="w-8 h-8 rounded-full bg-green-600/20 flex items-center justify-center shrink-0 active:bg-green-600/40"
                >
                    <Navigation className="w-3.5 h-3.5 text-green-500" />
                </button>
            )}
        </button>
    );
}