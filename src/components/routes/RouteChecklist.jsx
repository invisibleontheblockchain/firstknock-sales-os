import React, { useState, useMemo } from 'react';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Check, X, Phone, Ban, Clock, ChevronDown, ChevronUp, MapPin, Home, Navigation, Mic, FileText } from 'lucide-react';
import { getPropertyResultSummary } from '../logic/territoryLogic';
import { openInMaps } from '@/utils';

// Brand Colors
const BRAND = {
    voidBlack: '#0A0A0A',
    gold: '#FFD700',
    charcoal: '#1F1F1F',
    offWhite: '#E5E5E5'
};

const STATUS_OPTIONS = [
    { id: 'SOLD', label: 'SOLD', icon: Check, color: '#22c55e', textColor: '#fff' },
    { id: 'NO_ANSWER', label: 'NO ANSWER', icon: Home, color: '#3b82f6', textColor: '#fff' },
    { id: 'CALLBACK', label: 'CALLBACK', icon: Phone, color: '#FFFFFF', textColor: '#000' },
    { id: 'HARD_NO', label: 'NOT INTERESTED', icon: Ban, color: '#ef4444', textColor: '#fff' },
];

const STATUS_COLORS = {
    ELIGIBLE: '#22c55e',
    SOLD: '#22c55e', // Green for Sold
    HARD_NO: '#ef4444',
    CALLBACK: '#eab308',
    NO_ANSWER: '#6b7280',
    QUALIFIED: '#3b82f6'
};

export default function RouteChecklist({ route, logs, onLogResult, onClose }) {
    const [expandedId, setExpandedId] = useState(null);
    const [filter, setFilter] = useState('all');

    const propertyData = useMemo(() => {
        const dataMap = {};
        route.properties.forEach(p => {
            const propLogs = logs.filter(l => l.address_hash === p.address_hash);
            const summary = getPropertyResultSummary(propLogs);
            dataMap[p.address_hash] = summary;
        });
        return dataMap;
    }, [route.properties, logs]);

    // Legacy compatibility
    const propertyStatuses = useMemo(() => {
        const statusMap = {};
        Object.entries(propertyData).forEach(([hash, data]) => {
            if (data.hasResult) {
                statusMap[hash] = data.status;
            }
        });
        return statusMap;
    }, [propertyData]);

    const filteredProperties = useMemo(() => {
        return route.properties.filter(p => {
            const status = propertyStatuses[p.address_hash];
            if (filter === 'pending') return !status || status === 'ELIGIBLE';
            if (filter === 'done') return status && status !== 'ELIGIBLE';
            return true;
        });
    }, [route.properties, propertyStatuses, filter]);

    const stats = useMemo(() => {
        let pending = 0, done = 0;
        route.properties.forEach(p => {
            const status = propertyStatuses[p.address_hash];
            if (!status || status === 'ELIGIBLE') pending++;
            else done++;
        });
        return { pending, done, total: route.properties.length };
    }, [route.properties, propertyStatuses]);

    const [callbackPhone, setCallbackPhone] = useState('');
    const [selectedAction, setSelectedAction] = useState(null); // { propertyId, statusId }
    const [isListening, setIsListening] = useState(false);

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
        onLogResult(property, 'CALLBACK', note); // Pass note if supported by handler, else will be in text
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
            // Simple keyword matching for status
            let status = 'ELIGIBLE';
            let note = text;

            const lower = text.toLowerCase();
            if (lower.includes('sold') || lower.includes('bought')) status = 'SOLD';
            else if (lower.includes('not interested') || lower.includes('no') || lower.includes('go away')) status = 'HARD_NO';
            else if (lower.includes('call') || lower.includes('back') || lower.includes('busy')) status = 'CALLBACK';
            else if (lower.includes('no answer') || lower.includes('nobody')) status = 'NO_ANSWER';
            else if (lower.includes('yes') || lower.includes('interested')) status = 'QUALIFIED';

            if (confirm(`Heard: "${text}"\nParsed Status: ${status}\n\nSave this?`)) {
                onLogResult(property, status, note);
                setExpandedId(null);
            }
        };

        recognition.onerror = (event) => {
            console.error(event.error);
            setIsListening(false);
        };

        recognition.onend = () => {
            setIsListening(false);
        };

        recognition.start();
    };

    return (
        <div className="h-full flex flex-col backdrop-blur-2xl" style={{ background: 'rgba(10, 10, 10, 0.95)' }}>
            {/* Header */}
            <div className="p-6 border-b bg-gradient-to-b from-black/20 to-transparent" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
                <div className="flex items-center justify-between mb-4">
                    <div>
                        <h2 className="text-lg font-bold tracking-wide" style={{ color: BRAND.gold }}>{route.name}</h2>
                        <p className="text-xs" style={{ color: '#888' }}>
                            {route.assigned_to_name ? <span className="text-blue-400 font-bold mr-1">{route.assigned_to_name}</span> : null}
                            <span className="opacity-50">• {route.houseCount} properties</span>
                        </p>
                    </div>
                    <Button variant="ghost" size="icon" onClick={onClose}>
                        <X className="w-5 h-5" style={{ color: BRAND.offWhite }} />
                    </Button>
                </div>

                {/* Progress */}
                <div className="mb-4">
                    <div className="flex justify-between text-xs mb-2" style={{ color: '#888' }}>
                        <span>PROGRESS</span>
                        <span style={{ color: BRAND.gold }}>{stats.done}/{stats.total}</span>
                    </div>
                    <div className="h-2 rounded-full overflow-hidden" style={{ background: BRAND.charcoal }}>
                        <div
                            className="h-full transition-all duration-500"
                            style={{ width: `${(stats.done / stats.total) * 100}%`, background: BRAND.gold }}
                        />
                    </div>
                </div>

                {/* Filters */}
                <div className="flex gap-2 flex-wrap">
                    {[
                        { id: 'all', label: 'ALL' },
                        { id: 'pending', label: `PENDING (${stats.pending})` },
                        { id: 'done', label: `DONE (${stats.done})` }
                    ].map(f => (
                        <button
                            key={f.id}
                            onClick={() => setFilter(f.id)}
                            className="px-3 py-2 rounded-lg text-xs font-bold tracking-wide transition-colors"
                            style={{
                                background: filter === f.id ? BRAND.gold : BRAND.charcoal,
                                color: filter === f.id ? BRAND.voidBlack : BRAND.offWhite
                            }}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>

                {/* Open First Stop in Apple Maps */}
                <Button
                    className="w-full mt-4 h-12 font-bold tracking-wide"
                    style={{ background: BRAND.charcoal, color: BRAND.gold, border: `1px solid ${BRAND.gold}` }}
                    onClick={() => {
                        // Open Apple Maps to the first pending property
                        const nextProp = filteredProperties.find(p => {
                            const status = propertyStatuses[p.address_hash];
                            return !status || status === 'ELIGIBLE';
                        }) || filteredProperties[0];

                        if (nextProp) {
                            openInMaps(nextProp.lat, nextProp.lng);
                        }
                    }}
                >
                    <Navigation className="w-4 h-4 mr-2" />
                    START ROUTE IN APPLE MAPS
                </Button>
            </div>

            {/* Property List */}
            <ScrollArea className="flex-1">
                <div className="p-4 space-y-2">
                    {filteredProperties.map((prop, idx) => {
                        const propData = propertyData[prop.address_hash] || {};
                        const currentStatus = propertyStatuses[prop.address_hash];
                        const isExpanded = expandedId === prop.address_hash;
                        const isDone = currentStatus && currentStatus !== 'ELIGIBLE';

                        return (
                            <div
                                key={prop.address_hash}
                                className="rounded-xl border transition-all duration-300 overflow-hidden"
                                style={{
                                    background: isDone ? 'rgba(31, 31, 31, 0.4)' : 'rgba(31, 31, 31, 0.7)',
                                    borderColor: isExpanded ? BRAND.gold : 'rgba(255, 255, 255, 0.05)',
                                    boxShadow: isExpanded ? `0 0 20px -5px ${BRAND.gold}40` : 'none'
                                }}
                            >
                                <button
                                    onClick={() => setExpandedId(isExpanded ? null : prop.address_hash)}
                                    className="w-full p-4 flex items-start gap-3 text-left"
                                >
                                    <div
                                        className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                                        style={{
                                            background: isDone ? '#333' : BRAND.gold,
                                            color: isDone ? '#666' : BRAND.voidBlack
                                        }}
                                    >
                                        {idx + 1}
                                    </div>

                                    <div className="flex-1 min-w-0">
                                        <p className="font-bold truncate" style={{ color: isDone ? '#666' : BRAND.offWhite }}>
                                            {prop.full_address}
                                        </p>
                                        <p className="text-xs" style={{ color: '#666' }}>{prop.street_name}</p>

                                        {/* Show Result/Notes if available */}
                                        {propData.hasResult && propData.resultText && (
                                            <div className="mt-2 p-2 rounded-lg bg-black/30 border-l-2" style={{ borderColor: STATUS_COLORS[propData.status] }}>
                                                <div className="flex items-center gap-1 mb-1">
                                                    <FileText className="w-3 h-3" style={{ color: '#888' }} />
                                                    <span className="text-[10px] uppercase font-bold" style={{ color: '#888' }}>Result Notes</span>
                                                </div>
                                                <p className="text-xs" style={{ color: BRAND.offWhite }}>
                                                    "{propData.resultText}"
                                                </p>
                                            </div>
                                        )}
                                    </div>

                                    <div className="flex flex-col items-end gap-1 flex-shrink-0">
                                        {currentStatus && (
                                            <Badge style={{ background: STATUS_COLORS[currentStatus], color: currentStatus === 'SOLD' ? BRAND.voidBlack : '#fff' }}>
                                                {currentStatus}
                                            </Badge>
                                        )}

                                        {isExpanded ? (
                                            <ChevronUp className="w-5 h-5" style={{ color: '#666' }} />
                                        ) : (
                                            <ChevronDown className="w-5 h-5" style={{ color: '#666' }} />
                                        )}
                                    </div>
                                </button>

                                {isExpanded && (
                                    <div className="px-4 pb-4 pt-1 border-t" style={{ borderColor: '#333' }}>
                                        <div className="flex justify-between items-center mb-3">
                                            <p className="text-xs" style={{ color: '#888' }}>SELECT OUTCOME:</p>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => handleVoiceInput(prop)}
                                                className={`${isListening ? 'text-red-500 animate-pulse' : 'text-yellow-500'}`}
                                            >
                                                <Mic className="w-4 h-4 mr-1" />
                                                {isListening ? 'LISTENING...' : 'VOICE NOTE'}
                                            </Button>
                                        </div>
                                        <div className="grid grid-cols-2 gap-2">
                                            {selectedAction?.propertyId === prop.address_hash && selectedAction?.statusId === 'CALLBACK' ? (
                                                <div className="col-span-2 space-y-2">
                                                    <input
                                                        type="text"
                                                        placeholder="Enter Phone Number..."
                                                        value={callbackPhone}
                                                        onChange={(e) => setCallbackPhone(e.target.value)}
                                                        className="w-full p-2 rounded text-black text-sm"
                                                        autoFocus
                                                    />
                                                    <div className="flex gap-2">
                                                        <Button
                                                            onClick={() => confirmCallback(prop)}
                                                            className="flex-1 bg-yellow-500 text-black font-bold"
                                                        >
                                                            SAVE CALLBACK
                                                        </Button>
                                                        <Button
                                                            onClick={() => { setSelectedAction(null); setCallbackPhone(''); }}
                                                            className="bg-gray-700 text-white"
                                                        >
                                                            CANCEL
                                                        </Button>
                                                    </div>
                                                </div>
                                            ) : (
                                                STATUS_OPTIONS.map(opt => (
                                                    <Button
                                                        key={opt.id}
                                                        onClick={() => handleSelectStatus(prop, opt.id)}
                                                        className="h-11 text-xs font-bold tracking-wide"
                                                        style={{
                                                            background: opt.color,
                                                            color: opt.textColor
                                                        }}
                                                    >
                                                        <opt.icon className="w-4 h-4 mr-2" />
                                                        {opt.label}
                                                    </Button>
                                                ))
                                            )}
                                        </div>

                                        <Button
                                            variant="outline"
                                            className="w-full mt-3 text-xs font-bold tracking-wide"
                                            style={{ borderColor: '#333', color: BRAND.offWhite }}
                                            onClick={() => openInMaps(prop.lat, prop.lng)}
                                        >
                                            <MapPin className="w-4 h-4 mr-2" />
                                            OPEN IN APPLE MAPS
                                        </Button>
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