import React from 'react';
import { Check, Navigation } from 'lucide-react';
import { formatPropertyAge } from '@/utils';

const STATUS_COLORS = {
    ELIGIBLE: '#FFD700',
    SOLD: '#22c55e',
    HARD_NO: '#8B5CF6',
    CALLBACK: '#eab308',
    NO_ANSWER: '#6b7280',
    QUALIFIED: '#3b82f6',
    RECENT_OFF_MARKET: '#FFD700'
};

export default function PropertyCard({ property, index, onSelect }) {
    const isDone = property.effective_status !== 'ELIGIBLE';
    const statusColor = STATUS_COLORS[property.effective_status] || '#555';
    const age = formatPropertyAge(property.sold_date);

    return (
        <button
            onClick={() => onSelect(property, index)}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-2xl transition-all duration-300 active:scale-[0.98] group ${!isDone ? 'hover:bg-[#1A1A24] hover:shadow-[0_0_20px_rgba(255,255,255,0.15)] hover:border-white/30' : ''}`}
            style={{
                background: isDone ? '#0A0A0F' : '#111',
                border: `1px solid ${isDone ? '#151515' : '#1F1F1F'}`,
            }}
        >
            {/* Number / Check */}
            <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold shrink-0 transition-all duration-300"
                style={{
                    background: isDone ? statusColor : '#222',
                    color: isDone ? '#fff' : '#fff',
                    border: isDone ? 'none' : '1px solid rgba(255,255,255,0.1)',
                    opacity: isDone ? 0.6 : 1
                }}
            >
                {isDone ? <Check className="w-4 h-4" /> : index + 1}
            </div>

            {/* Address */}
            <div className="flex-1 min-w-0 text-left">
                <div className="flex items-center gap-2">
                    <p className={`text-[14px] font-bold truncate leading-tight transition-all duration-300 ${isDone ? 'line-through opacity-40 text-gray-500' : 'text-gray-200 group-hover:text-white group-hover:drop-shadow-[0_0_8px_rgba(255,255,255,0.8)]'}`}>
                        {property.house_number} {property.street_name}
                    </p>
                    {age && (
                        <span className="text-[10px] font-bold text-yellow-500/80 shrink-0">
                            {age}
                        </span>
                    )}
                </div>
                {property.city && (
                    <p className="text-[11px] truncate leading-tight mt-1 text-gray-600 transition-colors duration-300 group-hover:text-gray-400">
                        {property.city}, {property.state} {property.zip_code}
                    </p>
                )}

            </div>

            {/* Status tag */}
            {isDone && (
                <span className="text-[10px] font-bold px-2 py-1 rounded-full shrink-0"
                    style={{ background: statusColor + '20', color: statusColor }}>
                    {property.effective_status === 'NO_ANSWER' ? 'N/A' : property.effective_status === 'HARD_NO' ? 'NO' : property.effective_status}
                </span>
            )}

            {/* Navigate shortcut */}
            {!isDone && (
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        window.location.href = `https://maps.apple.com/?daddr=${property.lat},${property.lng}&dirflg=w`;
                    }}
                    className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 transition-all active:scale-95 bg-white/10 border border-white/10"
                >
                    <Navigation className="w-3.5 h-3.5 text-gray-400" />
                </button>
            )}
        </button>
    );
}