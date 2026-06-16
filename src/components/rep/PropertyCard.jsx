import React from 'react';
import { Check, Navigation } from 'lucide-react';
import { formatPropertyAge } from '@/utils';
import { buildFullAddress, openInMaps } from '@/components/logic/navigation';

const STATUS_COLORS = {
    ELIGIBLE: '#FFFFFF',
    SOLD: '#2EEB57',
    HARD_NO: '#FF6B6B',
    CALLBACK: '#39FF4A',
    NO_ANSWER: '#9CA3AF',
    QUALIFIED: '#2EEB57',
    RECENT_OFF_MARKET: '#39FF4A',
    NOT_MOVED_IN: '#F97316',
    DM_NOT_HOME: '#D1D5DB'
};

export default function PropertyCard({ property, index, onSelect, navigationApp = 'apple' }) {
    const isDone = property.effective_status !== 'ELIGIBLE';
    const statusColor = STATUS_COLORS[property.effective_status] || '#555';
    const age = formatPropertyAge(property.sold_date);

    return (
        <div
            onClick={() => onSelect(property, index)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(property, index); }}
            className={`w-full flex items-center gap-3 px-4 py-3.5 rounded-3xl transition-all duration-300 active:scale-[0.985] group cursor-pointer ${!isDone ? 'hover:bg-white/[0.07] hover:shadow-[0_16px_45px_rgba(0,0,0,0.45)] hover:border-[#2EEB57]/35' : ''}`}
            style={{
                background: isDone ? 'rgba(255,255,255,0.025)' : 'linear-gradient(135deg, rgba(255,255,255,0.075), rgba(255,255,255,0.025))',
                border: `1px solid ${isDone ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.11)'}`,
                boxShadow: isDone ? 'none' : 'inset 0 1px 0 rgba(255,255,255,0.05)'
            }}
        >
            {/* Number / Check */}
            <div
                className="w-9 h-9 rounded-2xl flex items-center justify-center text-[12px] font-black shrink-0 transition-all duration-300"
                style={{
                    background: isDone ? statusColor + '22' : '#FFFFFF',
                    color: isDone ? statusColor : '#000000',
                    border: isDone ? `1px solid ${statusColor}33` : '1px solid rgba(255,255,255,0.85)',
                    opacity: isDone ? 0.72 : 1,
                    boxShadow: isDone ? 'none' : '0 10px 25px rgba(255,255,255,0.12)'
                }}
            >
                {isDone ? <Check className="w-4 h-4" /> : index + 1}
            </div>

            {/* Address */}
            <div className="flex-1 min-w-0 text-left">
                <div className="flex items-center gap-2">
                    <p className={`text-[15px] font-extrabold truncate leading-tight tracking-tight transition-all duration-300 ${isDone ? 'line-through opacity-40 text-gray-500' : 'text-white group-hover:text-[#39FF4A]'}`}>
                        {property.house_number} {property.street_name}
                    </p>
                    {age && (
                        <span className="text-[10px] font-black text-[#39FF4A] shrink-0 rounded-full bg-[#2EEB57]/10 border border-[#2EEB57]/20 px-1.5 py-0.5">
                            {age}
                        </span>
                    )}
                </div>
                {property.city && (
                    <p className="text-[11px] truncate leading-tight mt-1 text-white/35 transition-colors duration-300 group-hover:text-white/55">
                        {property.city}, {property.state} {property.zip_code}
                    </p>
                )}

            </div>

            {/* Status tag */}
            {isDone && (
                <span className="text-[10px] font-bold px-2 py-1 rounded-full shrink-0"
                    style={{ background: statusColor + '20', color: statusColor }}>
                    {property.effective_status === 'NO_ANSWER' ? 'N/A' : property.effective_status === 'HARD_NO' ? 'NO' : property.effective_status === 'NOT_MOVED_IN' ? 'NMI' : property.effective_status === 'DM_NOT_HOME' ? 'DM' : property.effective_status}
                </span>
            )}

            {/* Navigate shortcut */}
            {!isDone && (
                <button
                    onClick={(e) => {
                        e.stopPropagation();
                        openInMaps(property.lat, property.lng, buildFullAddress(property), navigationApp);
                    }}
                    className="w-8 h-8 rounded-2xl flex items-center justify-center shrink-0 transition-all active:scale-95 bg-[#2EEB57]/10 border border-[#2EEB57]/25 hover:bg-[#2EEB57]"
                >
                    <Navigation className="w-3.5 h-3.5 text-[#39FF4A]" />
                </button>
            )}
        </div>
    );
}