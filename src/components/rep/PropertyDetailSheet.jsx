import React, { useState } from 'react';
import { X, Navigation, Camera, Loader2, Phone, Clock, ChevronUp, Mic, Check, Home, Ban, MapPin } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { format } from 'date-fns';
import PropertyHistory from './PropertyHistory';

const STATUS_OPTIONS = [
    { id: 'SOLD', label: 'Sold', icon: Check, color: '#22c55e' },
    { id: 'NO_ANSWER', label: 'No Answer', icon: Home, color: '#3b82f6' },
    { id: 'CALLBACK', label: 'Callback', icon: Phone, color: '#eab308' },
    { id: 'HARD_NO', label: 'Not Int.', icon: Ban, color: '#8B5CF6' },
];

export default function PropertyDetailSheet({ property, logs, onLog, onPhotoUpload, uploading, onClose, onViewOnMap }) {
    const [showMore, setShowMore] = useState(false);
    const [logNote, setLogNote] = useState('');
    const [callbackTime, setCallbackTime] = useState('');
    const [callbackPhone, setCallbackPhone] = useState('');

    const handleMark = (status) => {
        let noteText = `Marked as ${status}`;
        if (logNote) noteText += ` | Note: ${logNote}`;
        if (callbackPhone) noteText += ` | Phone: ${callbackPhone}`;
        if (callbackTime) noteText += ` | Time: ${callbackTime}`;

        let nextDate = null;
        if (status === 'CALLBACK' && callbackTime) {
            const today = new Date();
            const [hours, minutes] = callbackTime.split(':');
            today.setHours(parseInt(hours), parseInt(minutes));
            nextDate = today.toISOString();
        }

        onLog({
            address_hash: property.address_hash,
            raw_input_text: noteText,
            parsed_status: status,
            next_eligible_date: nextDate
        });
    };

    return (
        <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/70 backdrop-blur-sm" onClick={onClose}>
            <div 
                className="bg-[#0A0A0A] rounded-t-2xl border-t border-gray-800/50 max-h-[85vh] flex flex-col animate-in slide-in-from-bottom duration-300"
                onClick={e => e.stopPropagation()}
            >
                {/* Drag handle */}
                <div className="flex justify-center pt-3 pb-1">
                    <div className="w-8 h-1 rounded-full bg-gray-800" />
                </div>

                {/* Close */}
                <button onClick={onClose} className="absolute top-3 right-3 w-7 h-7 rounded-full bg-white/5 flex items-center justify-center">
                    <X className="w-3.5 h-3.5 text-gray-500" />
                </button>

                {/* Address */}
                <div className="px-5 pb-3 pt-1">
                    <h2 className="text-xl font-bold text-white leading-tight">
                        {property.house_number} {property.street_name}
                    </h2>
                    <p className="text-[12px] text-gray-600 mt-0.5">
                        {property.city}{property.state ? `, ${property.state}` : ''} {property.zip_code}
                    </p>
                </div>

                {/* Quick Outcome - 4 column grid matching checklist style */}
                <div className="px-5 pb-3">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] font-bold uppercase text-gray-600">Log outcome</span>
                    </div>
                    <div className="grid grid-cols-4 gap-1.5">
                        {STATUS_OPTIONS.map(opt => (
                            <button
                                key={opt.id}
                                onClick={() => handleMark(opt.id)}
                                className="flex flex-col items-center gap-1 py-3 rounded-xl text-center transition-all active:scale-95"
                                style={{ background: opt.color + '15', border: `1px solid ${opt.color}25` }}
                            >
                                <opt.icon className="w-5 h-5" style={{ color: opt.color }} />
                                <span className="text-[9px] font-bold leading-tight" style={{ color: opt.color }}>{opt.label}</span>
                            </button>
                        ))}
                    </div>
                </div>

                {/* Navigate */}
                <div className="px-5 pb-3 space-y-2">
                    <button
                        onClick={onViewOnMap}
                        className="flex items-center justify-center gap-1.5 w-full py-2.5 rounded-xl text-[11px] font-bold transition-all active:scale-95"
                        style={{ background: '#1A1A24', color: '#00D2FF', border: '1px solid rgba(0, 210, 255, 0.2)' }}
                    >
                        <MapPin className="w-3.5 h-3.5" />
                        View on FirstKnock Map
                    </button>
                    <a
                        href={`https://maps.apple.com/?daddr=${property.lat},${property.lng}&dirflg=w`}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center justify-center gap-1.5 w-full py-2.5 rounded-xl text-[11px] font-bold transition-all active:scale-95"
                        style={{ background: '#111', color: '#666' }}
                    >
                        <Navigation className="w-3.5 h-3.5" />
                        Open in Apple Maps
                    </a>
                </div>

                {/* Scrollable extras */}
                <div className="flex-1 overflow-y-auto px-5 pb-8 space-y-3">
                    {/* Add Details toggle */}
                    <button 
                        onClick={() => setShowMore(!showMore)}
                        className="w-full flex items-center justify-between py-2 text-[10px] font-bold text-gray-600 uppercase tracking-wider"
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
                                className="w-full bg-black border border-gray-800 rounded-xl p-3 text-sm text-white resize-none h-16 focus:border-yellow-500 focus:outline-none"
                            />
                            <div className="flex gap-2">
                                <div className="flex-1">
                                    <label className="text-[9px] font-bold text-gray-700 uppercase mb-1 block">Phone</label>
                                    <input
                                        type="tel"
                                        value={callbackPhone}
                                        onChange={(e) => setCallbackPhone(e.target.value)}
                                        placeholder="(555) 555-5555"
                                        className="w-full bg-black border border-gray-800 rounded-lg p-2.5 text-sm text-white focus:border-yellow-500 focus:outline-none"
                                    />
                                </div>
                                <div className="flex-1">
                                    <label className="text-[9px] font-bold text-gray-700 uppercase mb-1 block">Callback</label>
                                    <input
                                        type="time"
                                        value={callbackTime}
                                        onChange={(e) => setCallbackTime(e.target.value)}
                                        className="w-full bg-black border border-gray-800 rounded-lg p-2.5 text-sm text-white focus:border-yellow-500 focus:outline-none"
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
                            <PropertyHistory logs={logs} />
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}