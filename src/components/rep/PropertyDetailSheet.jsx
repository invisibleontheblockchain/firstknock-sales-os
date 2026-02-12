import React, { useState } from 'react';
import { X, Navigation, Camera, Loader2, Phone, Clock, ChevronUp } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { format } from 'date-fns';
import QuickMarkButtons from './QuickMarkButtons';
import PropertyHistory from './PropertyHistory';

export default function PropertyDetailSheet({ property, logs, onLog, onPhotoUpload, uploading, onClose }) {
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
                className="bg-[#111] rounded-t-3xl border-t border-gray-800 max-h-[92vh] flex flex-col animate-in slide-in-from-bottom duration-300"
                onClick={e => e.stopPropagation()}
            >
                {/* Drag handle */}
                <div className="flex justify-center pt-3 pb-1">
                    <div className="w-10 h-1 rounded-full bg-gray-700" />
                </div>

                {/* Address + Navigate - THE most important thing */}
                <div className="px-5 pb-4 pt-2">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                            <h2 className="text-2xl font-bold text-white leading-tight">
                                {property.house_number} {property.street_name}
                            </h2>
                            <p className="text-sm text-gray-500 mt-0.5">{property.city}{property.state ? `, ${property.state}` : ''}</p>
                        </div>
                        <a 
                            href={`https://maps.apple.com/?daddr=${property.lat},${property.lng}&dirflg=w`}
                            target="_blank"
                            rel="noreferrer"
                            className="shrink-0 w-12 h-12 rounded-2xl bg-green-600 flex items-center justify-center active:bg-green-700"
                        >
                            <Navigation className="w-5 h-5 text-white" />
                        </a>
                    </div>
                </div>

                {/* Quick Mark Buttons - THE main action */}
                <div className="px-5 pb-4">
                    <QuickMarkButtons
                        size="large"
                        onMark={handleMark}
                    />
                </div>

                {/* Scrollable extras */}
                <div className="flex-1 overflow-y-auto px-5 pb-8 space-y-4">
                    {/* Optional note - collapsed by default */}
                    <button 
                        onClick={() => setShowMore(!showMore)}
                        className="w-full flex items-center justify-between py-2 text-xs font-bold text-gray-500 uppercase tracking-wider"
                    >
                        <span>Add Details</span>
                        <ChevronUp className={`w-4 h-4 transition-transform ${showMore ? '' : 'rotate-180'}`} />
                    </button>

                    {showMore && (
                        <div className="space-y-3 animate-in slide-in-from-top-2 duration-200">
                            <textarea
                                value={logNote}
                                onChange={(e) => setLogNote(e.target.value)}
                                placeholder="Quick note..."
                                className="w-full bg-black/50 border border-gray-700 rounded-xl p-3 text-sm text-white resize-none h-20 focus:border-yellow-500 focus:outline-none"
                            />
                            <div className="flex gap-3">
                                <div className="flex-1">
                                    <label className="text-[10px] font-bold text-gray-600 uppercase mb-1 block">
                                        <Phone className="w-3 h-3 inline mr-1" />Phone
                                    </label>
                                    <input
                                        type="tel"
                                        value={callbackPhone}
                                        onChange={(e) => setCallbackPhone(e.target.value)}
                                        placeholder="(555) 555-5555"
                                        className="w-full bg-black/50 border border-gray-700 rounded-lg p-2.5 text-sm text-white focus:border-yellow-500 focus:outline-none"
                                    />
                                </div>
                                <div className="flex-1">
                                    <label className="text-[10px] font-bold text-gray-600 uppercase mb-1 block">
                                        <Clock className="w-3 h-3 inline mr-1" />Callback
                                    </label>
                                    <input
                                        type="time"
                                        value={callbackTime}
                                        onChange={(e) => setCallbackTime(e.target.value)}
                                        className="w-full bg-black/50 border border-gray-700 rounded-lg p-2.5 text-sm text-white focus:border-yellow-500 focus:outline-none"
                                    />
                                </div>
                            </div>

                            {/* Camera */}
                            <div className="relative">
                                <input
                                    type="file" accept="image/*" capture="environment"
                                    onChange={onPhotoUpload} className="hidden" id="camera-input-sheet" disabled={uploading}
                                />
                                <label 
                                    htmlFor="camera-input-sheet"
                                    className={`flex items-center justify-center w-full h-11 rounded-xl font-bold text-xs cursor-pointer transition-colors ${
                                        uploading ? 'bg-gray-800 text-gray-500' : 'bg-gray-800 hover:bg-gray-700 text-white'
                                    }`}
                                >
                                    {uploading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Camera className="w-4 h-4 mr-2" />}
                                    {uploading ? 'Uploading...' : 'Photo Proof'}
                                </label>
                            </div>
                        </div>
                    )}

                    {/* Property quick intel - minimal */}
                    {(property.price || property.sqft || property.year_built) && (
                        <div className="flex gap-3 flex-wrap">
                            {property.price > 0 && (
                                <span className="text-xs bg-gray-800 text-gray-400 px-2.5 py-1 rounded-lg">
                                    ${(property.price / 1000).toFixed(0)}k
                                </span>
                            )}
                            {property.sqft > 0 && (
                                <span className="text-xs bg-gray-800 text-gray-400 px-2.5 py-1 rounded-lg">
                                    {property.sqft.toLocaleString()} sqft
                                </span>
                            )}
                            {property.year_built > 0 && (
                                <span className="text-xs bg-gray-800 text-gray-400 px-2.5 py-1 rounded-lg">
                                    Built {property.year_built}
                                </span>
                            )}
                            {property.sold_date && (
                                <span className="text-xs bg-gray-800 text-gray-400 px-2.5 py-1 rounded-lg">
                                    Sold {format(new Date(property.sold_date), 'yyyy')}
                                </span>
                            )}
                        </div>
                    )}

                    {/* History */}
                    {logs.length > 0 && (
                        <div className="space-y-2">
                            <p className="text-[10px] font-bold text-gray-600 uppercase tracking-wider">History</p>
                            <PropertyHistory logs={logs} />
                        </div>
                    )}
                </div>

                {/* Close */}
                <button onClick={onClose} className="absolute top-4 right-4 w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center">
                    <X className="w-4 h-4 text-gray-400" />
                </button>
            </div>
        </div>
    );
}