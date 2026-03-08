import React from 'react';
import { Check, Navigation, Clock } from 'lucide-react';

const STATUS_COLORS = {
    ELIGIBLE: '#FFD700',
    SOLD: '#22c55e',
    HARD_NO: '#8B5CF6',
    CALLBACK: '#eab308',
    NO_ANSWER: '#6b7280',
    QUALIFIED: '#3b82f6'
};

/** Returns { daysAgo, label, color, bgColor } for a sold_date */
function getRecencyInfo(soldDate) {
    if (!soldDate) return null;
    const d = new Date(soldDate);
    if (isNaN(d.getTime())) return null;
    const daysAgo = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
    if (daysAgo < 0) return null;

    if (daysAgo <= 30)  return { daysAgo, label: `${daysAgo}d ago`, color: '#22c55e', bgColor: '#22c55e18' };  // green — hot lead
    if (daysAgo <= 60)  return { daysAgo, label: `${daysAgo}d ago`, color: '#eab308', bgColor: '#eab30818' };  // yellow — warm
    if (daysAgo <= 90)  return { daysAgo, label: `${daysAgo}d ago`, color: '#f97316', bgColor: '#f9731618' };  // orange — cooling
    if (daysAgo <= 180) return { daysAgo, label: `${daysAgo}d ago`, color: '#6b7280', bgColor: '#6b728018' };  // gray — old
    return { daysAgo, label: `${daysAgo}d ago`, color: '#4b5563', bgColor: '#4b556318' };                      // dark gray — stale
}

export default function PropertyCard({ property, index, onSelect }) {
    const isDone = property.effective_status !== 'ELIGIBLE' && property.effective_status !== 'CALLBACK';
    const statusColor = STATUS_COLORS[property.effective_status] || '#555';
    const recency = getRecencyInfo(property.sold_date);

    return (
        <button
            onClick={() => onSelect(property)}
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

            {/* Address + Recency */}
            <div className="flex-1 min-w-0 text-left">
                <p className={`text-[14px] font-bold truncate leading-tight transition-all duration-300 ${isDone ? 'line-through opacity-40 text-gray-500' : 'text-gray-200 group-hover:text-white group-hover:drop-shadow-[0_0_8px_rgba(255,255,255,0.8)]'}`}>
                    {property.house_number} {property.street_name}
                </p>
                <div className="flex items-center gap-2 mt-1">
                    {property.city && (
                        <p className="text-[11px] truncate leading-tight text-gray-600 transition-colors duration-300 group-hover:text-gray-400">
                            {property.city}, {property.state}
                        </p>
                    )}
                    {recency && !isDone && (
                        <span
                            className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded-md shrink-0"
                            style={{ background: recency.bgColor, color: recency.color }}
                        >
                            <Clock className="w-2.5 h-2.5" />
                            {recency.label}
                        </span>
                    )}
                </div>
                {property.timeScore > 80 && !isDone && (
                    <p className="text-[9px] text-green-500 font-bold mt-0.5">⏰ BEST TIME</p>
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
                        window.open(`https://maps.apple.com/?daddr=${property.lat},${property.lng}&dirflg=w`, '_blank');
                    }}
                    className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-all duration-300 shadow-[0_4px_12px_rgba(255,217,61,0.3)] hover:scale-105 active:scale-95 hover:shadow-[0_6px_16px_rgba(255,217,61,0.5)]"
                    style={{ background: '#FFD93D' }}
                >
                    <Navigation className="w-5 h-5 text-black fill-black" strokeWidth={2} />
                </button>
            )}
        </button>
    );
}