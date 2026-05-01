import React, { useState, useMemo } from 'react';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Check, X, Phone, Ban, Home, Navigation, Mic, MapPin, UserX, Clock } from 'lucide-react';
import { getPropertyResultSummary } from '../logic/territoryLogic';
import { buildFullAddress, openInMaps } from '../logic/navigation';
import { formatPropertyAge } from '@/utils';

const BRAND = {
    voidBlack: '#0A0A0A',
    gold: '#FFD700',
    charcoal: '#1F1F1F',
    offWhite: '#E5E5E5'
};

const STATUS_OPTIONS = [
    { id: 'SOLD', label: 'Sold', icon: Check, color: '#22c55e', textColor: '#fff' },
    { id: 'NO_ANSWER', label: 'No Answer', icon: Home, color: '#3b82f6', textColor: '#fff' },
    { id: 'CALLBACK', label: 'Callback', icon: Phone, color: '#eab308', textColor: '#000' },
    { id: 'HARD_NO', label: 'Not Interested', icon: Ban, color: '#8B5CF6', textColor: '#fff' },
    { id: 'NOT_MOVED_IN', label: 'Not Moved In', icon: Clock, color: '#f97316', textColor: '#fff' },
    { id: 'DM_NOT_HOME', label: 'DM Not Home', icon: UserX, color: '#06b6d4', textColor: '#fff' },
];

const STATUS_COLORS = {
    ELIGIBLE: '#22c55e',
    SOLD: '#22c55e',
    HARD_NO: '#8B5CF6',
    CALLBACK: '#eab308',
    NO_ANSWER: '#6b7280',
    QUALIFIED: '#3b82f6',
    RECENT_OFF_MARKET: '#FFD700',
    NOT_MOVED_IN: '#f97316',
    DM_NOT_HOME: '#06b6d4'
};

export default function RouteChecklist({ route, logs, onLogResult, onClose, navigationApp = 'apple', activeRouteSoldFilter, setActiveRouteSoldFilter }) {
    const [expandedId, setExpandedId] = useState(null);
    const [filter, setFilter] = useState('all');
    const [decisionFilter, setDecisionFilter] = useState('all');
    const [callbackPhone, setCallbackPhone] = useState('');
    const [selectedAction, setSelectedAction] = useState(null);
    const [isListening, setIsListening] = useState(false);

    const propertyData = useMemo(() => {
        const dataMap = {};
        route.properties.forEach(p => {
            const propLogs = logs.filter(l => l.address_hash === p.address_hash);
            dataMap[p.address_hash] = getPropertyResultSummary(propLogs);
        });
        return dataMap;
    }, [route.properties, logs]);

    const propertyStatuses = useMemo(() => {
        const statusMap = {};
        Object.entries(propertyData).forEach(([hash, data]) => {
            if (data.hasResult) statusMap[hash] = data.status;
        });
        return statusMap;
    }, [propertyData]);

    const filteredProperties = useMemo(() => {
        return route.properties.filter(p => {
            const status = propertyStatuses[p.address_hash];
            if (filter === 'pending') return !status || status === 'ELIGIBLE';
            if (filter === 'done') {
                if (!status || status === 'ELIGIBLE') return false;
                return decisionFilter === 'all' || status === decisionFilter;
            }
            return true;
        });
    }, [route.properties, propertyStatuses, filter, decisionFilter]);

    const stats = useMemo(() => {
        let pending = 0, done = 0;
        route.properties.forEach(p => {
            const status = propertyStatuses[p.address_hash];
            if (!status || status === 'ELIGIBLE') pending++;
            else done++;
        });
        return { pending, done, total: route.properties.length };
    }, [route.properties, propertyStatuses]);

    const handleNavigate = (prop) => {
        openInMaps(prop.lat, prop.lng, buildFullAddress(prop), navigationApp);
    };

    const handleSelectStatus = (property, statusId) => {
        if (statusId === 'CALLBACK') {
            setSelectedAction({ propertyId: property.address_hash, statusId });
            return;
        }
        onLogResult(property, statusId);
        setExpandedId(null);
    };

    const confirmCallback = (property) => {
        const note = callbackPhone ? `Callback Phone: ${callbackPhone}` : 'Callback';
        onLogResult(property, 'CALLBACK', note);
        setCallbackPhone('');
        setSelectedAction(null);
        setExpandedId(null);
    };

    const handleVoiceInput = (property) => {
        if (!('webkitSpeechRecognition' in window)) {
            alert("Voice input not supported in this browser.");
            return;
        }
        const recognition = new window.webkitSpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = false;
        recognition.lang = 'en-US';
        setIsListening(true);

        recognition.onresult = (event) => {
            const text = event.results[0][0].transcript;
            setIsListening(false);
            let status = 'ELIGIBLE';
            const lower = text.toLowerCase();
            if (lower.includes('sold') || lower.includes('bought')) status = 'SOLD';
            else if (lower.includes('not interested') || lower.includes('no') || lower.includes('go away')) status = 'HARD_NO';
            else if (lower.includes('call') || lower.includes('back') || lower.includes('busy')) status = 'CALLBACK';
            else if (lower.includes('no answer') || lower.includes('nobody')) status = 'NO_ANSWER';
            else if (lower.includes('not moved in') || lower.includes('haven\'t moved')) status = 'NOT_MOVED_IN';
            else if (lower.includes('decision maker') || lower.includes('dm not home') || lower.includes('husband') || lower.includes('wife')) status = 'DM_NOT_HOME';
            else if (lower.includes('yes') || lower.includes('interested')) status = 'QUALIFIED';
            if (confirm(`Heard: "${text}"\nStatus: ${status}\n\nSave?`)) {
                onLogResult(property, status, text);
                setExpandedId(null);
            }
        };
        recognition.onerror = () => setIsListening(false);
        recognition.onend = () => setIsListening(false);
        recognition.start();
    };

    const progressPct = stats.total > 0 ? (stats.done / stats.total) * 100 : 0;

    return (
        <div className="h-full flex flex-col" style={{ background: BRAND.voidBlack }}>
            {/* Compact Header */}
            <div className="px-4 pt-4 pb-3 space-y-3">
                {/* Title Row */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5 min-w-0">
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: BRAND.gold }}>
                            <Navigation className="w-4 h-4" style={{ color: BRAND.voidBlack }} />
                        </div>
                        <div className="min-w-0">
                            <h2 className="text-base font-bold leading-tight truncate" style={{ color: BRAND.offWhite }}>{route.name}</h2>
                            <p className="text-[11px] leading-tight" style={{ color: '#666' }}>
                                {route.assigned_to_name && <span className="text-blue-400 mr-1">{route.assigned_to_name} •</span>}
                                {stats.total} stops
                            </p>
                        </div>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/10">
                        <X className="w-4 h-4 text-gray-500" />
                    </button>
                </div>

                {/* Progress Bar */}
                <div className="flex items-center gap-3">
                    <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: '#222' }}>
                        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${progressPct}%`, background: BRAND.gold }} />
                    </div>
                    <span className="text-[11px] font-bold tabular-nums shrink-0" style={{ color: BRAND.gold }}>
                        {stats.done}/{stats.total}
                    </span>
                </div>

                {/* Filters + Start Route */}
                <div className="flex items-center gap-2">
                    <div className="flex gap-1 flex-1">
                        {[
                            { id: 'all', label: 'All' },
                            { id: 'pending', label: `Todo ${stats.pending}` },
                            { id: 'done', label: `Done ${stats.done}` }
                        ].map(f => (
                            <button
                                key={f.id}
                                onClick={() => setFilter(f.id)}
                                className="px-2.5 py-1.5 rounded-lg text-[10px] font-bold tracking-wide transition-colors"
                                style={{
                                    background: filter === f.id ? BRAND.gold : '#1a1a1a',
                                    color: filter === f.id ? BRAND.voidBlack : '#888'
                                }}
                            >
                                {f.label}
                            </button>
                        ))}
                    </div>
                    {setActiveRouteSoldFilter && (
                        <select
                            value={activeRouteSoldFilter}
                            onChange={(e) => setActiveRouteSoldFilter(e.target.value)}
                            className="bg-[#1a1a1a] text-[#888] text-[10px] font-bold px-2 py-1.5 rounded-lg border-none outline-none cursor-pointer min-w-0"
                        >
                            <option value="all">All Time</option>
                            <option value="0.25">1 Week</option>
                            <option value="0.5">2 Weeks</option>
                            <option value="1">1 Month</option>
                            <option value="3">3 Months</option>
                            <option value="6">6 Months</option>
                            <option value="9">9 Months</option>
                            <option value="12">1 Year</option>
                        </select>
                    )}
                    {filter === 'done' && (
                        <select
                            value={decisionFilter}
                            onChange={(e) => setDecisionFilter(e.target.value)}
                            className="bg-[#1a1a1a] text-[#888] text-[10px] font-bold px-2 py-1.5 rounded-lg border-none outline-none cursor-pointer min-w-0"
                        >
                            <option value="all">All Decisions</option>
                            <option value="SOLD">Sold</option>
                            <option value="NO_ANSWER">No Answer</option>
                            <option value="CALLBACK">Callback</option>
                            <option value="HARD_NO">Not Interested</option>
                            <option value="NOT_MOVED_IN">Not Moved In</option>
                            <option value="DM_NOT_HOME">DM Not Home</option>
                        </select>
                    )}
                    <button
                        onClick={() => {
                            const nextProp = filteredProperties.find(p => {
                                const status = propertyStatuses[p.address_hash];
                                return !status || status === 'ELIGIBLE';
                            }) || filteredProperties[0];
                            if (nextProp) handleNavigate(nextProp);
                        }}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-bold tracking-wide"
                        style={{ background: BRAND.gold, color: BRAND.voidBlack }}
                    >
                        <Navigation className="w-3 h-3" />
                        START
                    </button>
                </div>
            </div>

            {/* Divider */}
            <div className="h-px" style={{ background: '#1a1a1a' }} />

            {/* Property List */}
            <ScrollArea className="flex-1">
                <div className="px-3 py-2 space-y-1.5">
                    {filteredProperties.map((prop, idx) => {
                        const propData = propertyData[prop.address_hash] || {};
                        const currentStatus = propertyStatuses[prop.address_hash];
                        const isExpanded = expandedId === prop.address_hash;
                        const isDone = currentStatus && currentStatus !== 'ELIGIBLE';

                        return (
                            <div
                                key={prop.address_hash}
                                className={`group rounded-xl overflow-hidden transition-all duration-300 border ${
                                    isExpanded 
                                        ? 'bg-[#181818] border-yellow-500/40 shadow-[0_0_15px_rgba(255,215,0,0.1)]' 
                                        : 'bg-[#111] border-[#1a1a1a] hover:border-white/20 hover:shadow-[0_0_10px_rgba(255,255,255,0.05)]'
                                }`}
                            >
                                {/* Property Row */}
                                <button
                                    onClick={() => setExpandedId(isExpanded ? null : prop.address_hash)}
                                    className="w-full px-3 py-2.5 flex items-center gap-2.5 text-left"
                                >
                                    <div
                                        className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0"
                                        style={{
                                            background: isDone ? (STATUS_COLORS[currentStatus] || '#333') : BRAND.gold,
                                            color: isDone ? '#fff' : BRAND.voidBlack,
                                            opacity: isDone ? 0.7 : 1
                                        }}
                                    >
                                        {isDone ? <Check className="w-3.5 h-3.5" /> : idx + 1}
                                    </div>

                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <p className={`text-[13px] font-semibold truncate leading-tight transition-all duration-300 ${isDone ? 'line-through opacity-40' : 'group-hover:drop-shadow-[0_0_8px_rgba(255,215,0,0.5)]'}`} style={{ color: BRAND.offWhite }}>
                                                {prop.house_number} {prop.street_name}
                                            </p>
                                            {prop.sold_date && (
                                                <span className="text-[9px] font-bold text-yellow-500/80 shrink-0">
                                                    {formatPropertyAge(prop.sold_date)}
                                                </span>
                                            )}
                                        </div>
                                        {prop.city && (
                                            <p className="text-[10px] truncate leading-tight mt-0.5" style={{ color: '#555' }}>
                                                {prop.city}, {prop.state} {prop.zip_code}
                                            </p>
                                        )}
                                    </div>

                                    {currentStatus && !isExpanded && (
                                        <span className="text-[9px] font-bold px-2 py-0.5 rounded-full shrink-0"
                                            style={{ background: STATUS_COLORS[currentStatus] + '20', color: STATUS_COLORS[currentStatus] }}>
                                            {currentStatus === 'NO_ANSWER' ? 'N/A' : currentStatus === 'HARD_NO' ? 'NO' : currentStatus === 'NOT_MOVED_IN' ? 'NMI' : currentStatus === 'DM_NOT_HOME' ? 'DM' : currentStatus}
                                        </span>
                                    )}
                                </button>

                                {/* Expanded Actions */}
                                {isExpanded && (
                                    <div className="px-3 pb-3 space-y-2">
                                        {/* Previous notes */}
                                        {propData.hasResult && propData.resultText && (
                                            <div className="px-2.5 py-1.5 rounded-lg text-[11px] border-l-2"
                                                style={{ background: '#0f0f0f', borderColor: STATUS_COLORS[propData.status], color: '#aaa' }}>
                                                "{propData.resultText}"
                                            </div>
                                        )}

                                        {/* Voice + Label */}
                                        <div className="flex items-center justify-between">
                                            <span className="text-[10px] font-bold uppercase" style={{ color: '#555' }}>Log outcome</span>
                                            <button
                                                onClick={() => handleVoiceInput(prop)}
                                                className={`flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-lg ${isListening ? 'text-red-400 bg-red-900/20 animate-pulse' : 'text-yellow-500 bg-yellow-500/10'}`}
                                            >
                                                <Mic className="w-3 h-3" />
                                                {isListening ? 'Listening...' : 'Voice'}
                                            </button>
                                        </div>

                                        {/* Status Buttons */}
                                        {selectedAction?.propertyId === prop.address_hash && selectedAction?.statusId === 'CALLBACK' ? (
                                            <div className="space-y-2">
                                                <input
                                                    type="tel"
                                                    placeholder="Phone number (optional)"
                                                    value={callbackPhone}
                                                    onChange={(e) => setCallbackPhone(e.target.value)}
                                                    className="w-full px-3 py-2 rounded-lg text-sm bg-black border border-gray-700 text-white"
                                                    autoFocus
                                                />
                                                <div className="flex gap-2">
                                                    <Button onClick={() => confirmCallback(prop)} className="flex-1 h-9 text-xs font-bold bg-yellow-500 text-black hover:bg-yellow-400">
                                                        Save Callback
                                                    </Button>
                                                    <Button onClick={() => { setSelectedAction(null); setCallbackPhone(''); }} variant="ghost" className="h-9 text-xs text-gray-400">
                                                        Cancel
                                                    </Button>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="grid grid-cols-3 gap-1.5">
                                                {STATUS_OPTIONS.map(opt => (
                                                    <button
                                                        key={opt.id}
                                                        onClick={() => handleSelectStatus(prop, opt.id)}
                                                        className="flex flex-col items-center gap-1 py-2.5 rounded-xl text-center transition-all active:scale-95"
                                                        style={{ background: opt.color + '18', border: `1px solid ${opt.color}30` }}
                                                    >
                                                        <opt.icon className="w-4 h-4" style={{ color: opt.color }} />
                                                        <span className="text-[9px] font-bold leading-tight" style={{ color: opt.color }}>{opt.label}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        )}

                                        {/* Navigate */}
                                        <button
                                            onClick={() => handleNavigate(prop)}
                                            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-[10px] font-bold"
                                            style={{ background: '#1a1a1a', color: '#666' }}
                                        >
                                            <MapPin className="w-3 h-3" />
                                            Open in {navigationApp === 'google' ? 'Google' : 'Apple'} Maps
                                        </button>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </ScrollArea>
        </div>
    );
}