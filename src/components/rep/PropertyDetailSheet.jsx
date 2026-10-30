import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Navigation, Camera, Loader2, ChevronUp, ChevronLeft, MapPin, History } from 'lucide-react';
import { format } from 'date-fns';
import { base44 } from '@/api/base44Client';
import PropertyHistory from './PropertyHistory';
import RemoveRouteStopButton from '@/components/routes/RemoveRouteStopButton';
import { buildFullAddress, openInMaps } from '@/components/logic/navigation';
import { parseOptionalSaleAmount } from '@/components/analytics/salesManagement';

import { OUTCOME_OPTIONS as STATUS_OPTIONS, latestOutcomeNote } from '@/components/logic/outcomeStatus';

const NOTE_AUTOSAVE_MS = 800;

// The server checks a note's route against the house, so only name the route
// when this house is actually one of its stops.
const noteRouteId = (route, property) => {
    const hashes = Array.isArray(route?.property_hashes) ? route.property_hashes : [];
    const onRoute = [property?.address_hash, property?.legacy_hash].some((hash) => hash && hashes.includes(hash));
    return onRoute ? route.id || null : null;
};

export default function PropertyDetailSheet({
    property,
    logs,
    onLog,
    outcomeDisabled = false,
    onBlockedAttempt,
    onClearDecision,
    onPhotoUpload,
    uploading,
    onClose,
    onViewOnMap,
    routePosition,
    totalStops,
    route,
    onRouteUpdated,
    onNoteSaved,
    navigationApp = 'apple',
}) {
    const [showMore, setShowMore] = useState(false);
    // Add Details is the house note: it opens on whatever note the house already
    // has, and it saves on its own. It used to start blank and only travel with
    // the next outcome tap, so a note typed after the tap, or a door reopened
    // later, read as a note that never saved.
    const savedNote = latestOutcomeNote(logs);
    const [noteDraft, setNoteDraft] = useState(undefined);
    const [noteState, setNoteState] = useState(null);
    const [noteError, setNoteError] = useState('');
    const noteTimerRef = useRef(null);
    const noteDraftRef = useRef(undefined);
    const mountedRef = useRef(true);
    const logNote = noteDraft ?? savedNote;
    // Only a note the rep edited on this visit rides along with the outcome, so
    // a prefilled note from an earlier visit is not stamped onto every tap.
    const visitNote = noteDraft === undefined ? '' : noteDraft.trim();
    const [callbackTime, setCallbackTime] = useState('');
    const [callbackName, setCallbackName] = useState('');
    const [callbackPhone, setCallbackPhone] = useState('');
    const [callbackError, setCallbackError] = useState('');
    const [showCallbackPrompt, setShowCallbackPrompt] = useState(false);
    const [showSaleAmount, setShowSaleAmount] = useState(false);
    const [saleAmount, setSaleAmount] = useState('');
    const [saleAmountError, setSaleAmountError] = useState('');
    const [savingStatus, setSavingStatus] = useState(null);
    const [showHistory, setShowHistory] = useState(false);
    const isSavingOutcome = savingStatus !== null;

    const persistNote = useCallback(async (value) => {
        if (mountedRef.current) setNoteState('saving');
        try {
            await base44.functions.invoke('recordKnockOutcome', {
                action: 'save_house_note',
                address_hash: property.address_hash,
                note: value,
                route_id: noteRouteId(route, property)
            });
            onNoteSaved?.(property.address_hash);
            if (!mountedRef.current) return;
            setNoteState('saved');
            setNoteError('');
        } catch (error) {
            // Show what the server said; never imply a rejected note was stored.
            const reason = error?.response?.data?.error
                || error?.response?.data?.code
                || error?.message
                || 'Unknown error';
            console.error('[PropertyDetailSheet] House note save failed', error);
            if (!mountedRef.current) return;
            setNoteState('error');
            setNoteError(String(reason));
        }
    }, [onNoteSaved, property, route]);

    const handleNoteChange = (value) => {
        noteDraftRef.current = value;
        setNoteDraft(value);
        setNoteState('saving');
        clearTimeout(noteTimerRef.current);
        noteTimerRef.current = setTimeout(() => {
            noteTimerRef.current = null;
            persistNote(value);
        }, NOTE_AUTOSAVE_MS);
    };

    // A pending keystroke still commits when the field blurs or collapses.
    const flushNote = useCallback(() => {
        if (!noteTimerRef.current) return;
        clearTimeout(noteTimerRef.current);
        noteTimerRef.current = null;
        if (noteDraftRef.current !== undefined) persistNote(noteDraftRef.current);
    }, [persistNote]);

    // The sheet closes the moment an outcome is tapped or Back is pressed, so a
    // note still waiting on its pause is sent on the way out, not dropped.
    const flushNoteRef = useRef(flushNote);
    flushNoteRef.current = flushNote;
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            flushNoteRef.current();
        };
    }, []);

    const handleMark = async (status, { skipSaleAmount = false, skipCallbackDetails = false } = {}) => {
        if (isSavingOutcome) return;
        // Free-limit gate: when disabled, every tap re-fires the upgrade prompt
        // and never saves an outcome.
        if (outcomeDisabled) {
            onBlockedAttempt?.();
            return;
        }

        let parsedSaleAmount = null;
        if (status === 'SOLD') {
            if (!showSaleAmount && !skipSaleAmount) {
                setShowSaleAmount(true);
                setShowCallbackPrompt(false);
                setSaleAmountError('');
                return;
            }
            const parsed = parseOptionalSaleAmount(skipSaleAmount ? '' : saleAmount);
            if (parsed.error) {
                setSaleAmountError(parsed.error);
                return;
            }
            parsedSaleAmount = parsed.value;
        } else {
            setShowSaleAmount(false);
            setSaleAmount('');
            setSaleAmountError('');
        }

        if (status === 'CALLBACK') {
            setShowCallbackPrompt(true);
            if (!showCallbackPrompt && !skipCallbackDetails) {
                setCallbackError('');
                return;
            }
            if (!skipCallbackDetails && (!callbackName.trim() || !callbackPhone.trim() || !callbackTime)) {
                setCallbackError('Name, phone number, and callback date/time are required, or skip the details.');
                return;
            }
            setCallbackError('');
        }

        let noteText = `Marked as ${status}`;
        if (visitNote) noteText += ` | Note: ${visitNote}`;
        if (status === 'CALLBACK' && !skipCallbackDetails && callbackName.trim()) noteText += ` | Contact: ${callbackName.trim()}`;
        if (status === 'CALLBACK' && !skipCallbackDetails && callbackPhone) noteText += ` | Phone: ${callbackPhone}`;
        if (status === 'CALLBACK' && !skipCallbackDetails && callbackTime) noteText += ` | Callback: ${callbackTime}`;
        if (status === 'SOLD' && parsedSaleAmount !== null) noteText += ` | Sale: $${parsedSaleAmount}`;

        let nextDate = null;
        if (status === 'CALLBACK' && !skipCallbackDetails && callbackTime) {
            if (callbackTime.includes('T')) {
                nextDate = new Date(callbackTime).toISOString();
            } else {
                const today = new Date();
                const [hours, minutes] = callbackTime.split(':');
                today.setHours(parseInt(hours), parseInt(minutes));
                nextDate = today.toISOString();
            }
        }

        const logData = {
            address_hash: property.address_hash,
            raw_input_text: noteText,
            description: visitNote || null,
            parsed_status: status,
            next_eligible_date: nextDate,
            callback_contact_name: status === 'CALLBACK' && !skipCallbackDetails ? callbackName.trim() : null,
            callback_contact_phone: status === 'CALLBACK' && !skipCallbackDetails ? callbackPhone.trim() : null,
            callback_time: status === 'CALLBACK' && !skipCallbackDetails ? callbackTime : null
        };

        if (status === 'SOLD' && parsedSaleAmount !== null) {
            logData.sale_amount = parsedSaleAmount;
        }

        // The write waits on a GPS fix plus the server round-trip, so the tapped
        // button has to acknowledge instantly or the tap reads as a dead click.
        setSavingStatus(status);
        let saved = false;
        try {
            saved = await onLog(logData);
        } finally {
            setSavingStatus(null);
        }
        if (saved === false) return;
        setShowSaleAmount(false);
        setSaleAmount('');
        setSaleAmountError('');
        if (status === 'CALLBACK') {
            setShowCallbackPrompt(false);
            setCallbackName('');
            setCallbackPhone('');
            setCallbackTime('');
            setCallbackError('');
        }
    };

    return (
        <div className="fixed inset-x-0 top-0 bottom-20 z-[60] flex flex-col justify-end bg-black/70 backdrop-blur-sm" onClick={onClose}>
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

                <div className="flex-1 overflow-y-auto">

                {/* Quick Outcome */}
                <div className="px-5 pb-3">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] font-black uppercase text-white/45 tracking-[0.2em]">Log outcome</span>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                        {STATUS_OPTIONS.map(opt => {
                            const isPending = savingStatus === opt.id;
                            const isDimmed = isSavingOutcome && !isPending;
                            return (
                                <button
                                    key={opt.id}
                                    onClick={() => handleMark(opt.id)}
                                    disabled={isSavingOutcome}
                                    aria-busy={isPending}
                                    className={`relative flex items-center justify-center gap-1 rounded-2xl text-center transition-all ${opt.id === 'SOLD' ? 'col-span-2 flex-row min-h-16 gap-2 py-4' : 'flex-col py-3.5'} ${outcomeDisabled ? 'opacity-40 cursor-not-allowed' : 'active:scale-95'} ${isDimmed ? 'opacity-40' : ''} ${isPending ? 'scale-[0.97]' : ''} ${(showSaleAmount && opt.id === 'SOLD') || isPending ? 'ring-2 ring-[#2EEB57]' : ''}`}
                                    style={{ background: opt.color === '#FFFFFF' ? 'rgba(255,255,255,0.055)' : opt.color + '14', border: `1px solid ${opt.color === '#FFFFFF' ? 'rgba(255,255,255,0.14)' : opt.color + '2e'}`, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)' }}
                                >
                                    {isPending
                                        ? <Loader2 className="w-5 h-5 animate-spin" style={{ color: opt.color }} />
                                        : <opt.icon className="w-5 h-5" style={{ color: opt.color }} />}
                                    <span className={`${opt.id === 'SOLD' ? 'text-sm font-black' : 'text-[10px] font-bold'} leading-tight`} style={{ color: opt.color }}>
                                        {isPending ? 'Saving...' : opt.label}
                                    </span>
                                </button>
                            );
                        })}
                    </div>

                    {showCallbackPrompt && (
                        <div className="mt-2 rounded-2xl border border-purple-400/30 bg-purple-500/[0.08] p-3 animate-in slide-in-from-top-2 duration-200">
                            <p className="mb-2 text-[10px] font-black uppercase tracking-[0.18em] text-purple-300">Callback contact</p>
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                <input
                                    value={callbackName}
                                    onChange={(e) => { setCallbackName(e.target.value); setCallbackError(''); }}
                                    placeholder="Name"
                                    autoFocus
                                    className="selectable-text w-full bg-black/70 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white focus:border-[#2EEB57] focus:outline-none"
                                />
                                <input
                                    type="tel"
                                    value={callbackPhone}
                                    onChange={(e) => { setCallbackPhone(e.target.value); setCallbackError(''); }}
                                    placeholder="Phone number"
                                    className="selectable-text w-full bg-black/70 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white focus:border-[#2EEB57] focus:outline-none"
                                />
                            </div>
                            <div className="mt-2 flex gap-2">
                                <input
                                    type="datetime-local"
                                    value={callbackTime}
                                    onChange={(e) => setCallbackTime(e.target.value)}
                                    className="w-full bg-black/70 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white focus:border-[#2EEB57] focus:outline-none [color-scheme:dark]"
                                />
                                <button
                                    onClick={() => handleMark('CALLBACK')}
                                    disabled={isSavingOutcome}
                                    aria-busy={savingStatus === 'CALLBACK'}
                                    className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-purple-500 text-white font-black text-xs active:scale-95 transition-all whitespace-nowrap disabled:opacity-60"
                                >
                                    {savingStatus === 'CALLBACK' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                                    {savingStatus === 'CALLBACK' ? 'Saving...' : 'Save Callback'}
                                </button>
                            </div>
                            <button
                                type="button"
                                onClick={() => handleMark('CALLBACK', { skipCallbackDetails: true })}
                                disabled={isSavingOutcome}
                                className="mt-2 w-full rounded-xl border border-purple-400/20 bg-purple-500/[0.06] px-3 py-2.5 text-xs font-black text-purple-200 transition-colors active:bg-purple-500/15 disabled:opacity-60"
                            >
                                Record callback without details
                            </button>
                            {callbackError && <p className="mt-2 text-[10px] font-bold text-red-300">{callbackError}</p>}
                        </div>
                    )}

                    {showSaleAmount && (
                        <div className="mt-2 flex flex-wrap gap-2 items-center animate-in slide-in-from-top-2 duration-200">
                            <div className="min-w-[150px] flex-1 relative">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-green-400 text-sm font-bold">$</span>
                                <input
                                    type="number"
                                    inputMode="decimal"
                                    min="0"
                                    step="0.01"
                                    value={saleAmount}
                                    onChange={(e) => { setSaleAmount(e.target.value); setSaleAmountError(''); }}
                                    placeholder="Sale amount"
                                    autoFocus
                                    aria-label="Sale amount (optional)"
                                    aria-describedby={saleAmountError ? 'sale-amount-error' : undefined}
                                    className="w-full bg-black/70 border border-[#2EEB57]/30 rounded-xl pl-7 pr-3 py-2.5 text-sm text-white focus:border-[#39FF4A] focus:outline-none"
                                />
                            </div>
                            <button
                                onClick={() => handleMark('SOLD')}
                                disabled={isSavingOutcome}
                                aria-busy={savingStatus === 'SOLD'}
                                className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-[#2EEB57] text-black font-black text-xs active:scale-95 transition-all disabled:opacity-60"
                            >
                                {savingStatus === 'SOLD' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                                <span>Save</span>
                            </button>
                            <button
                                onClick={() => handleMark('SOLD', { skipSaleAmount: true })}
                                disabled={isSavingOutcome}
                                className="px-3 py-2.5 rounded-lg bg-white/5 text-gray-400 font-bold text-xs"
                            >
                                Skip
                            </button>
                            {saleAmountError && <p id="sale-amount-error" role="alert" className="w-full text-[10px] font-bold text-red-300">{saleAmountError}</p>}
                        </div>
                    )}
                </div>

                {/* Add Details */}
                <div className="px-5 pb-3">
                    <button
                        type="button"
                        onClick={() => {
                            if (showMore) flushNote();
                            setShowMore(!showMore);
                        }}
                        aria-expanded={showMore}
                        className="w-full flex items-center justify-between rounded-2xl border border-[#2EEB57]/35 bg-[#2EEB57]/10 px-4 py-3 text-left shadow-[0_10px_30px_rgba(46,235,87,0.10)] active:scale-[0.99] transition-all"
                    >
                        <span className="flex items-center gap-2">
                            <span className="block text-[11px] font-black uppercase tracking-[0.18em] text-white">Add Details</span>
                            {/* Named, not just tinted, so the state never rests on colour. */}
                            {(noteState || savedNote) && (
                                <span
                                    className="rounded-full px-1.5 py-0.5 text-[9px] font-bold"
                                    style={noteState === 'error'
                                        ? { background: 'rgba(255,107,107,0.15)', color: '#FF6B6B' }
                                        : { background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.7)' }}
                                >
                                    {noteState === 'error' ? 'Not saved' : noteState === 'saving' ? 'Saving' : 'Saved'}
                                </span>
                            )}
                        </span>
                        <ChevronUp className={`w-4 h-4 text-white transition-transform ${showMore ? '' : 'rotate-180'}`} />
                    </button>

                    {!showMore && savedNote && (
                        <p className="selectable-text mt-1.5 truncate px-1 text-[11px] italic text-white/50">"{savedNote}"</p>
                    )}

                    {showMore && (
                        <div className="mt-3 space-y-3 animate-in slide-in-from-top-2 duration-200">
                            <div className="space-y-1">
                                <textarea
                                    value={logNote}
                                    onChange={(e) => handleNoteChange(e.target.value)}
                                    onBlur={flushNote}
                                    readOnly={outcomeDisabled}
                                    placeholder="Quick note..."
                                    className="selectable-text w-full bg-black/70 border border-[#2EEB57]/25 rounded-xl p-3 text-sm text-white resize-none h-16 focus:border-[#39FF4A] focus:outline-none"
                                />
                                <p
                                    className="px-1 text-[9px]"
                                    role={noteState === 'error' ? 'alert' : undefined}
                                    style={{ color: noteState === 'error' ? '#FF6B6B' : 'rgba(255,255,255,0.4)' }}
                                >
                                    {noteState === 'error'
                                        ? `Not saved — ${noteError || 'the server rejected this note'}`
                                        : noteState === 'saving'
                                            ? 'Saving...'
                                            : 'Saved automatically to this house.'}
                                </p>
                            </div>
                            <div className="flex gap-2">
                                <div className="flex-1">
                                    <label className="text-[9px] font-bold text-white/45 uppercase mb-1 block">Phone</label>
                                    <input
                                        type="tel"
                                        value={callbackPhone}
                                        onChange={(e) => setCallbackPhone(e.target.value)}
                                        placeholder="(555) 555-5555"
                                        className="w-full bg-black/70 border border-white/10 rounded-xl p-2.5 text-sm text-white focus:border-[#2EEB57] focus:outline-none"
                                    />
                                </div>
                                <div className="flex-1">
                                    <label className="text-[9px] font-bold text-white/45 uppercase mb-1 block">Callback Date/Time</label>
                                    <input
                                        type="time"
                                        value={callbackTime}
                                        onChange={(e) => setCallbackTime(e.target.value)}
                                        className="w-full bg-black/70 border border-white/10 rounded-xl p-2.5 text-sm text-white focus:border-[#2EEB57] focus:outline-none [color-scheme:dark]"
                                    />
                                </div>
                            </div>
                            <div className="relative">
                                <input type="file" accept="image/*" capture="environment" onChange={onPhotoUpload} className="hidden" id="camera-input-sheet" disabled={uploading} />
                                <label 
                                    htmlFor="camera-input-sheet"
                                    className="flex items-center justify-center w-full h-10 rounded-xl font-bold text-[11px] cursor-pointer bg-white/5 text-white/70 border border-white/10 active:bg-white/10"
                                >
                                    {uploading ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Camera className="w-3.5 h-3.5 mr-1.5" />}
                                    {uploading ? 'Uploading...' : 'Photo Proof'}
                                </label>
                            </div>
                        </div>
                    )}
                </div>

                <div className="px-5 pb-3 space-y-3">
                    <RemoveRouteStopButton route={route} property={property} disabled={isSavingOutcome} onRemoved={(saved, nextStop) => {
                        if (onRouteUpdated) onRouteUpdated(saved, nextStop);
                        else onClose();
                    }} />
                    {/* History — collapsed by default so a long log never buries the outcome grid */}
                    {logs?.length > 0 && (
                        <div className="space-y-2">
                            <button
                                type="button"
                                onClick={() => setShowHistory(current => !current)}
                                aria-expanded={showHistory}
                                aria-controls="property-history-panel"
                                className="w-full flex items-center justify-between rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-left active:scale-[0.99] transition-all"
                            >
                                <span className="flex items-center gap-2">
                                    <History className="w-3.5 h-3.5 text-white/45" />
                                    <span className="text-[11px] font-black uppercase tracking-[0.18em] text-white/80">History</span>
                                    <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold text-white/70">
                                        {logs.length}
                                    </span>
                                </span>
                                <ChevronUp className={`w-4 h-4 text-white/60 transition-transform ${showHistory ? '' : 'rotate-180'}`} />
                            </button>

                            {showHistory && (
                                <div
                                    id="property-history-panel"
                                    className="max-h-[45vh] overflow-y-auto pr-0.5 animate-in slide-in-from-top-2 duration-200"
                                >
                                    <PropertyHistory logs={logs} onClearDecision={onClearDecision} />
                                </div>
                            )}
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

                {/* Property extras */}
                <div className="px-5 pb-8 space-y-3">
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

                </div>
                </div>
            </div>
        </div>
    );
}
