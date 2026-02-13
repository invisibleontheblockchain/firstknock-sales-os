import React from 'react';
import { Check, Navigation } from 'lucide-react';

const STATUS_COLORS = {
    ELIGIBLE: '#FFD700',
    SOLD: '#22c55e',
    HARD_NO: '#8B5CF6',
    CALLBACK: '#eab308',
    NO_ANSWER: '#6b7280',
    QUALIFIED: '#3b82f6'
};

export default function PropertyCard({ property, index, onSelect }) {
    const isDone = property.effective_status !== 'ELIGIBLE' && property.effective_status !== 'CALLBACK';
    const statusColor = STATUS_COLORS[property.effective_status] || '#555';

    return (
        <button
            onClick={() => onSelect(property)}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl transition-all active:scale-[0.98]"
            style={{
                background: isDone ? '#0f0f0f' : '#111',
                border: `1px solid ${isDone ? '#1a1a1a' : '#1f1f1f'}`,
            }}
        >
            {/* Number / Check */}
            <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
                style={{
                    background: isDone ? statusColor : '#FFD700',
                    color: isDone ? '#fff' : '#000',
                    opacity: isDone ? 0.6 : 1
                }}
            >
                {isDone ? <Check className="w-3.5 h-3.5" /> : index + 1}
            </div>

            {/* Address */}
            <div className="flex-1 min-w-0 text-left">
                <p className={`text-[13px] font-semibold truncate leading-tight ${isDone ? 'line-through opacity-40' : 'text-white'}`}>
                    {property.house_number} {property.street_name}
                </p>
                {property.city && (
                    <p className="text-[10px] truncate leading-tight mt-0.5 text-gray-600">
                        {property.city}, {property.state} {property.zip_code}
                    </p>
                )}
                {property.timeScore > 80 && !isDone && (
                    <p className="text-[9px] text-green-500 font-bold mt-0.5">⏰ BEST TIME</p>
                )}
            </div>

            {/* Status tag */}
            {isDone && (
                <span className="text-[9px] font-bold px-2 py-0.5 rounded-full shrink-0"
                    style={{ background: statusColor + '20', color: statusColor }}>
                    {property.effective_status === 'NO_ANSWER' ? 'N/A' : property.effective_status === 'HARD_NO' ? 'NO' : property.effective_status}
                </span>
            )}

            {/* Navigate shortcut */}
            {!isDone && (
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        window.open(`https://maps.apple.com/?daddr=${property.lat},${property.lng}&dirflg=w`, '_blank');
                    }}
                    className="w-7 h-7 rounded-full flex items-center justify-center shrink-0"
                    style={{ background: 'rgba(255,215,0,0.1)' }}
                >
                    <Navigation className="w-3 h-3 text-yellow-500" />
                </button>
            )}
        </button>
    );
}