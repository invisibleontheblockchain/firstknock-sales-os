import React from 'react';
import { Check, Navigation, User, DollarSign, Ruler } from 'lucide-react';
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

const formatMoney = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n >= 1000000 ? `$${(n / 1000000).toFixed(1)}M` : `$${Math.round(n / 1000)}k`;
};

const formatNumber = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n.toLocaleString() : null;
};

export default function PropertyCard({ property, index, onSelect, navigationApp = 'apple' }) {
    const isDone = property.effective_status !== 'ELIGIBLE';
    const statusColor = STATUS_COLORS[property.effective_status] || '#555';
    const age = formatPropertyAge(property.sold_date);
    const ownerName = property.owner_full_name || property.owner_name || property.ownerFullName;
    const valueLabel = formatMoney(property.price || property.estimated_value || property.estimatedValue);
    const sqftLabel = formatNumber(property.sqft || property.squareFootage);
    const yearBuilt = Number(property.year_built || property.yearBuilt) || null;

    return (
        <div
            onClick={() => onSelect(property, index)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(property, index); }}
            className={`group relative w-full cursor-pointer overflow-hidden rounded-[30px] border p-[3px] text-left transition-all duration-300 active:scale-[0.985] ${!isDone ? 'hover:-translate-y-0.5 hover:shadow-[0_0_42px_rgba(46,235,87,0.34)]' : 'opacity-85'}`}
            style={{
                backgroundImage: `linear-gradient(135deg, rgba(46,235,87,0.72), rgba(255,255,255,0.11) 28%, rgba(46,235,87,0.42) 100%), url('https://media.base44.com/images/public/695eb764b077190880be21de/d37334add_generated_image.png')`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                borderColor: isDone ? 'rgba(46,235,87,0.22)' : 'rgba(46,235,87,0.58)',
                boxShadow: isDone ? '0 14px 32px rgba(0,0,0,0.35)' : '0 0 34px rgba(46,235,87,0.24), 0 18px 42px rgba(0,0,0,0.48)'
            }}
        >
            <div
                className="relative min-h-[186px] rounded-[26px] border px-7 py-6 overflow-hidden"
                style={{
                    backgroundImage: `linear-gradient(135deg, rgba(5,16,10,0.92), rgba(0,0,0,0.96) 62%), url('https://media.base44.com/images/public/695eb764b077190880be21de/d37334add_generated_image.png')`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                    borderColor: 'rgba(255,255,255,0.08)',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.10), inset 0 -18px 38px rgba(0,0,0,0.64)'
                }}
            >
                <div className="flex items-start justify-between gap-4">
                    <div className={`text-[42px] font-black leading-none tracking-tight ${isDone ? 'text-white/45 line-through' : 'text-white'}`}>
                        {index + 1}
                    </div>
                    {isDone && (
                        <div
                            className="flex h-10 w-10 items-center justify-center rounded-2xl shrink-0"
                            style={{ background: '#2EEB57', color: '#031008', boxShadow: '0 0 22px rgba(46,235,87,0.46)' }}
                        >
                            <Check className="h-6 w-6 stroke-[4]" />
                        </div>
                    )}
                </div>

                <div className="mt-5 min-w-0">
                    <p className={`truncate text-[20px] font-semibold leading-tight tracking-tight ${isDone ? 'text-white/45 line-through' : 'text-white'}`}>
                        {property.house_number} {property.street_name}
                    </p>
                    {property.city && (
                        <p className="mt-1 truncate text-[18px] leading-tight text-white/90">
                            {property.city}, {property.state} {property.zip_code}
                        </p>
                    )}
                </div>

                <div className="mt-8 grid grid-cols-2 gap-x-10 gap-y-5 text-[17px] leading-tight text-white/92">
                    <div className="min-w-0">
                        <p className="text-white/55 text-[10px] font-black uppercase tracking-[0.18em]">Owner</p>
                        <p className="mt-1 truncate">{ownerName || 'Owner'}</p>
                    </div>
                    <div>
                        <p className="text-white/55 text-[10px] font-black uppercase tracking-[0.18em]">Price</p>
                        <p className="mt-1">{valueLabel || 'Price'}</p>
                    </div>
                    <div>
                        <p className="text-white/55 text-[10px] font-black uppercase tracking-[0.18em]">Sqft</p>
                        <p className="mt-1">{sqftLabel ? `${sqftLabel} sqft` : 'Sqft'}</p>
                    </div>
                    <div>
                        <p className="text-white/55 text-[10px] font-black uppercase tracking-[0.18em]">Built year</p>
                        <p className="mt-1">{yearBuilt || 'Built year'}</p>
                    </div>
                </div>

                {!isDone && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            openInMaps(property.lat, property.lng, buildFullAddress(property), navigationApp);
                        }}
                        className="mt-6 text-left text-[20px] font-medium leading-tight text-[#39FF4A] transition-colors hover:text-[#86efac]"
                    >
                        Navigate shortcut
                    </button>
                )}

                <div className="mt-6 grid grid-cols-2 items-end gap-10 text-[17px] text-white/92">
                    <div>
                        <p className="text-white/55 text-[10px] font-black uppercase tracking-[0.18em]">Sold age</p>
                        <p className="mt-1">{age || 'Sold age'}</p>
                    </div>
                    <div>
                        <p className="text-white/55 text-[10px] font-black uppercase tracking-[0.18em]">Status</p>
                        <span
                            className="mt-1 inline-flex rounded-full px-3 py-1 text-[18px] font-semibold leading-none"
                            style={{ background: isDone ? statusColor : '#2EEB57', color: '#021006' }}
                        >
                            {isDone ? (property.effective_status === 'NO_ANSWER' ? 'N/A' : property.effective_status === 'HARD_NO' ? 'NO' : property.effective_status === 'NOT_MOVED_IN' ? 'NMI' : property.effective_status === 'DM_NOT_HOME' ? 'DM' : property.effective_status) : 'Status'}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
}