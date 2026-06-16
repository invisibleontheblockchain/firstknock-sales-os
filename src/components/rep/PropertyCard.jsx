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
            className={`relative w-full overflow-hidden rounded-[1.4rem] border px-4 py-4 text-left transition-all duration-300 active:scale-[0.985] group cursor-pointer ${!isDone ? 'hover:-translate-y-0.5 hover:border-[#2EEB57]/45 hover:shadow-[0_18px_55px_rgba(0,0,0,0.5)]' : 'opacity-80'}`}
            style={{
                background: isDone
                    ? 'linear-gradient(135deg, rgba(255,255,255,0.035), rgba(255,255,255,0.012))'
                    : 'linear-gradient(135deg, rgba(255,255,255,0.095), rgba(46,235,87,0.045), rgba(255,255,255,0.025))',
                borderColor: isDone ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.13)',
                boxShadow: isDone ? 'none' : 'inset 0 1px 0 rgba(255,255,255,0.08), 0 12px 35px rgba(0,0,0,0.28)'
            }}
        >
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            <div className="absolute bottom-0 left-0 top-0 w-1 bg-gradient-to-b from-[#39FF4A] via-[#2EEB57]/60 to-transparent opacity-70" />

            <div className="flex items-start gap-3">
                {/* Number / Check */}
                <div
                    className="mt-0.5 w-10 h-10 rounded-2xl flex items-center justify-center text-[12px] font-black shrink-0 transition-all duration-300"
                    style={{
                        background: isDone ? statusColor + '18' : 'linear-gradient(135deg, #FFFFFF, #D8FFE0)',
                        color: isDone ? statusColor : '#000000',
                        border: isDone ? `1px solid ${statusColor}33` : '1px solid rgba(255,255,255,0.9)',
                        boxShadow: isDone ? 'none' : '0 10px 28px rgba(46,235,87,0.16)'
                    }}
                >
                    {isDone ? <Check className="w-4 h-4" /> : index + 1}
                </div>

                {/* Address */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <p className={`text-[15px] font-extrabold truncate leading-tight tracking-tight transition-all duration-300 ${isDone ? 'line-through opacity-45 text-white/45' : 'text-white group-hover:text-[#39FF4A]'}`}>
                                {property.house_number} {property.street_name}
                            </p>
                            {property.city && (
                                <p className="text-[11px] truncate leading-tight mt-1.5 text-white/40 transition-colors duration-300 group-hover:text-white/60">
                                    {property.city}, {property.state} {property.zip_code}
                                </p>
                            )}
                        </div>

                        {/* Navigate shortcut */}
                        {!isDone && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    openInMaps(property.lat, property.lng, buildFullAddress(property), navigationApp);
                                }}
                                className="group/nav w-9 h-9 rounded-2xl flex items-center justify-center shrink-0 transition-all active:scale-95 bg-[#2EEB57]/12 border border-[#2EEB57]/25 hover:bg-[#2EEB57] hover:shadow-[0_0_22px_rgba(46,235,87,0.35)]"
                            >
                                <Navigation className="w-3.5 h-3.5 text-[#39FF4A] transition-colors group-hover/nav:text-black" />
                            </button>
                        )}
                    </div>

                    <div className="mt-3 flex items-center gap-2 min-h-[22px]">
                        {age && (
                            <span className="text-[10px] font-black text-[#39FF4A] shrink-0 rounded-full bg-[#2EEB57]/10 border border-[#2EEB57]/20 px-2 py-1 tracking-wide">
                                {age}
                            </span>
                        )}
                        {isDone && (
                            <span className="text-[10px] font-black px-2 py-1 rounded-full shrink-0 tracking-wide border"
                                style={{ background: statusColor + '18', color: statusColor, borderColor: statusColor + '30' }}>
                                {property.effective_status === 'NO_ANSWER' ? 'N/A' : property.effective_status === 'HARD_NO' ? 'NO' : property.effective_status === 'NOT_MOVED_IN' ? 'NMI' : property.effective_status === 'DM_NOT_HOME' ? 'DM' : property.effective_status}
                            </span>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}