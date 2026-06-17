import React, { useState } from 'react';
import { Navigation, Camera, Loader2, Phone, Clock, ChevronUp, ChevronLeft, Check, Home, Ban, MapPin, UserX } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { format } from 'date-fns';
import PropertyHistory from './PropertyHistory';
import { buildFullAddress, openInMaps } from '@/components/logic/navigation';

const STATUS_OPTIONS = [
    { id: 'SOLD', label: 'Sold', icon: Check, color: '#39FF4A' },
    { id: 'NO_ANSWER', label: 'No Answer', icon: Home, color: '#FFFFFF' },
    { id: 'CALLBACK', label: 'Callback', icon: Phone, color: '#2EEB57' },
    { id: 'HARD_NO', label: 'Not Int.', icon: Ban, color: '#FF6B6B' },
    { id: 'NOT_MOVED_IN', label: 'Not Moved In', icon: Clock, color: '#F97316' },
    { id: 'DM_NOT_HOME', label: 'DM Not Home', icon: UserX, color: '#D1D5DB' },
];

export default function PropertyDetailSheet({ property, logs, onLog, outcomeDisabled = false, onBlockedAttempt, onClearDecision, onPhotoUpload, uploading, onClose, onViewOnMap, routePosition, totalStops, navigationApp = 'apple' }) {
    const [showMore, setShowMore] = useState(false);
    const [logNote, setLogNote] = useState('');
    const [callbackTime, setCallbackTime] = useState('');
    const [callbackPhone, setCallbackPhone] = useState('');
    const [showSaleAmount, setShowSaleAmount] = useState(false);
    const [saleAmount, setSaleAmount] = useState('');

    const handleMark = (status) => {
        // Free-limit gate: when disabled, every tap re-fires the upgrade prompt
        // and never saves an outcome.
        if (outcomeDisabled) {
            onBlockedAttempt?.();
            return;
        }

        if (status === 'SOLD' && !showSaleAmount) {
            setShowSaleAmount(true);
            return;
        }

        let noteText = `Marked as ${status}`;
        if (logNote) noteText += ` | Note: ${logNote}`;
        if (callbackPhone) noteText += ` | Phone: ${callbackPhone}`;
        if (callbackTime) noteText += ` | Time: ${callbackTime}`;
        if (saleAmount) noteText += ` | Sale: $${saleAmount}`;

        let nextDate = null;
        if (status === 'CALLBACK' && callbackTime) {
            const today = new Date();
            const [hours, minutes] = callbackTime.split(':');
            today.setHours(parseInt(hours), parseInt(minutes));
            nextDate = today.toISOString();
        }

        const logData = {
            address_hash: property.address_hash,
            raw_input_text: noteText,
            parsed_status: status,
            next_eligible_date: nextDate
        };

        if (status === 'SOLD' && saleAmount) {
            logData.sale_amount = parseFloat(saleAmount);
        }

        onLog(logData);
        setShowSaleAmount(false);
        setSaleAmount('');
    };

    return (
        <div className="fixed inset-0 z-[60] flex flex-col justify-end bg-black/70 backdrop-blur-sm" onClick={onClose}>
            <div 
                className="bg-[#050505]/95 backdrop-blur-2xl rounded-t-[2rem] border-t border-white/10 max-h-[86vh] flex flex-col animate-in slide-in-from-bottom duration-300 shadow-[0_-24px_80px_rgba(0,0,0,0.75)]"
                onClick={e => e.stopPropagation()}
            >
                <header className="sticky top-0 z-50 border-b border-white/10 bg-[#050505]/95 px-3 py-3 backdrop-blur-2xl">
                    <div className="flex items-center gap-3">
                        <button onClick={onClose} className="flex h-10 shrink-0 items-center gap-1 rounded-full bg-white/[0.06] px-3 text-xs font-bold text-white/85 active:scale-95 transition-all hover:bg-white/[0.10]">
                            <ChevronLeft className="w-4 h-4" /> Back
                        </button>
                        <div className="min-w-0 flex-1 selectable-text">
                            {routePosition > 0 && (
                                <p className="mb-0.5 text-[9px] font-black uppercase tracking-[0.16em] text-[#39FF4A]">
                                    Stop #{routePosition}{totalStops ? ` of ${totalStops}` : ''}
                                </p>
                            )}
                            <h2 className="truncate text-base font-black leading-tight text-white">
                                {property.house_number} {property.street_name}
                            </h2>
                            <p className="truncate text-[11px] text-white/40">
                                {property.city}{property.state ? `, ${property.state}` : ''} {property.zip_code}
                            </p>
                        </div>
                    </div>
                </header>

                {/* Quick Outcome - 4 column grid matching checklist style */}
                <div className="px-5 pb-3">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] font-black uppercase text-white/45 tracking-[0.2em]">Log outcome</span>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                        {STATUS_OPTIONS.map(opt => (
                            <button
                                key={opt.id}
                                onClick={() => handleMark(opt.id)}
                                className={`flex flex-col items-center gap-1 py-3.5 rounded-2xl text-center transition-all ${outcomeDisabled ? 'opacity-40 cursor-not-allowed' : 'active:scale-95'} ${showSaleAmount && opt.id === 'SOLD' ? 'ring-2 ring-[#2EEB57]' : ''}`}
                                style={{ background: opt.color === '#FFFFFF' ? 'rgba(255,255,255,0.055)' : opt.color + '14', border: `1px solid ${opt.color === '#FFFFFF' ? 'rgba(255,255,255,0.14)' : opt.color + '2e'}`, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)' }}
                            >
                                <opt.icon className="w-5 h-5" style={{ color: opt.color }} />
                                <span className="text-[9px] font-bold leading-tight" style={{ color: opt.color }}>{opt.label}</span>
                            </button>
                        ))}
                    </div>

                    {showSaleAmount && (
                        <div className="mt-2 flex gap-2 items-center animate-in slide-in-from-top-2 duration-200">
                            <div className="flex-1 relative">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-green-400 text-sm font-bold">$</span>
                                <input
                                    type="number"
                                    value={saleAmount}
                                    onChange={(e) => setSaleAmount(e.target.value)}
                                    placeholder="Sale amount"
                                    autoFocus
                                    className="w-full bg-black/70 border border-[#2EEB57]/30 rounded-xl pl-7 pr-3 py-2.5 text-sm text-white focus:border-[#39FF4A] focus:outline-none"
                                />
                            </div>
                            <button
                                onClick={() => handleMark('SOLD')}
                                className="px-4 py-2.5 rounded-xl bg-[#2EEB57] text-black font-black text-xs active:scale-95 transition-all"
                            >
                                Confirm
                            </button>
                            <button
                                onClick={() => { setShowSaleAmount(false); setSaleAmount(''); }}
                                className="px-3 py-2.5 rounded-lg bg-white/5 text-gray-400 font-bold text-xs"
                            >
                                Skip
                            </button>
                        </div>
                    )}
                </div>

                {/* Navigate */}
                <div className="px-5 pb-3 space-y-2">
                    <button
                        onClick={onViewOnMap}
                        className="flex items-center justify-center gap-1.5 w-full py-2.5 rounded-xl text-[11px] font-bold transition-all active:scale-95"
                        style={{ background: 'rgba(46,235,87,0.11)', color: '#39FF4A', border: '1px solid rgba(46,235,87,0.28)' }}
                    >
                        <MapPin className="w-3.5 h-3.5" />
                        View on FirstKnock Map
                    </button>
                    <button
                        onClick={() => openInMaps(property.lat, property.lng, buildFullAddress(property), navigationApp)}
                        className="flex items-center justify-center gap-1.5 w-full py-2.5 rounded-xl text-[11px] font-bold transition-all active:scale-95"
                        style={{ background: 'rgba(255,255,255,0.055)', color: '#FFFFFF', border: '1px solid rgba(255,255,255,0.1)' }}
                    >
                        <Navigation className="w-3.5 h-3.5" />
                        Open in {navigationApp === 'google' ? 'Google' : 'Apple'} Maps
                    </button>
                </div>

                {/* Scrollable extras */}
                <div className="flex-1 overflow-y-auto px-5 pb-8 space-y-3">
                    {/* Add Details toggle */}
                    <button 
                        onClick={() => setShowMore(!showMore)}
                        className="w-full flex items-center justify-between py-2 text-[10px] font-black text-white/35 uppercase tracking-[0.18em]"
                    >
                        <span>Add Details</span>
                        <ChevronUp className={`w-3.5 h-3.5 transition-transform ${showMore ? '' : 'rotate-180'}`} />
                    </button>

                    {showMore && (
                        <div className="space-y-3 animate-in slide-in-from-top-2 duration-200">
                            <textarea
                                value={logNote}
                                onChange={(e) => setLogNote(e.target.value)}
                                placeholder="Quick note..."
                                className="selectable-text w-full bg-black/70 border border-white/10 rounded-xl p-3 text-sm text-white resize-none h-16 focus:border-[#2EEB57] focus:outline-none"
                            />
                            <div className="flex gap-2">
                                <div className="flex-1">
                                    <label className="text-[9px] font-bold text-gray-700 uppercase mb-1 block">Phone</label>
                                    <input
                                        type="tel"
                                        value={callbackPhone}
                                        onChange={(e) => setCallbackPhone(e.target.value)}
                                        placeholder="(555) 555-5555"
                                        className="w-full bg-black/70 border border-white/10 rounded-xl p-2.5 text-sm text-white focus:border-[#2EEB57] focus:outline-none"
                                    />
                                </div>
                                <div className="flex-1">
                                    <label className="text-[9px] font-bold text-gray-700 uppercase mb-1 block">Callback</label>
                                    <input
                                        type="time"
                                        value={callbackTime}
                                        onChange={(e) => setCallbackTime(e.target.value)}
                                        className="w-full bg-black/70 border border-white/10 rounded-xl p-2.5 text-sm text-white focus:border-[#2EEB57] focus:outline-none"
                                    />
                                </div>
                            </div>
                            <div className="relative">
                                <input type="file" accept="image/*" capture="environment" onChange={onPhotoUpload} className="hidden" id="camera-input-sheet" disabled={uploading} />
                                <label 
                                    htmlFor="camera-input-sheet"
                                    className="flex items-center justify-center w-full h-10 rounded-xl font-bold text-[11px] cursor-pointer bg-white/5 text-gray-400 active:bg-white/10"
                                >
                                    {uploading ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Camera className="w-3.5 h-3.5 mr-1.5" />}
                                    {uploading ? 'Uploading...' : 'Photo Proof'}
                                </label>
                            </div>
                        </div>
                    )}

                    {/* Property intel chips */}
                    {(property.price || property.sqft || property.year_built) && (
                        <div className="flex gap-2 flex-wrap">
                            {property.price > 0 && (
                                <span className="text-[10px] bg-white/5 text-gray-500 px-2 py-1 rounded-lg">
                                    ${(property.price / 1000).toFixed(0)}k
                                </span>
                            )}
                            {property.sqft > 0 && (
                                <span className="text-[10px] bg-white/5 text-gray-500 px-2 py-1 rounded-lg">
                                    {property.sqft.toLocaleString()} sqft
                                </span>
                            )}
                            {property.year_built > 0 && (
                                <span className="text-[10px] bg-white/5 text-gray-500 px-2 py-1 rounded-lg">
                                    Built {property.year_built}
                                </span>
                            )}
                            {property.sold_date && (
                                <span className="text-[10px] bg-white/5 text-gray-500 px-2 py-1 rounded-lg">
                                    Sold {format(new Date(property.sold_date), 'yyyy')}
                                </span>
                            )}
                        </div>
                    )}

                    {/* History */}
                    {logs?.length > 0 && (
                        <div className="space-y-2">
                            <p className="text-[10px] font-bold text-gray-700 uppercase tracking-wider">History</p>
                            <PropertyHistory logs={logs} onClearDecision={onClearDecision} />
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}