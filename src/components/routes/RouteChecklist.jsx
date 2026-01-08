import React, { useState, useMemo } from 'react';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Check, X, Phone, Ban, Clock, ChevronDown, ChevronUp, MapPin, Home, Navigation } from 'lucide-react';

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
    SOLD: BRAND.gold,
    HARD_NO: '#ef4444',
    CALLBACK: '#eab308',
    NO_ANSWER: '#6b7280',
    QUALIFIED: '#3b82f6'
};

export default function RouteChecklist({ route, logs, onLogResult, onClose }) {
    const [expandedId, setExpandedId] = useState(null);
    const [filter, setFilter] = useState('all');

    const propertyStatuses = useMemo(() => {
        const statusMap = {};
        route.properties.forEach(p => {
            const propLogs = logs.filter(l => l.address_hash === p.address_hash);
            if (propLogs.length > 0) {
                const sorted = [...propLogs].sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
                statusMap[p.address_hash] = sorted[0].parsed_status;
            }
        });
        return statusMap;
    }, [route.properties, logs]);

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

    const handleSelectStatus = (property, statusId) => {
        onLogResult(property, statusId);
        setExpandedId(null);
    };

    return (
        <div className="h-full flex flex-col" style={{ background: BRAND.voidBlack }}>
            {/* Header */}
            <div className="p-5 border-b" style={{ borderColor: BRAND.charcoal }}>
                <div className="flex items-center justify-between mb-4">
                    <div>
                        <h2 className="text-lg font-bold tracking-wide" style={{ color: BRAND.gold }}>{route.name}</h2>
                        <p className="text-xs" style={{ color: '#888' }}>{route.houseCount} properties</p>
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

                {/* Export to Google Maps */}
                <Button
                    className="w-full mt-4 h-12 font-bold tracking-wide"
                    style={{ background: BRAND.charcoal, color: BRAND.gold, border: `1px solid ${BRAND.gold}` }}
                    onClick={() => {
                        const props = route.properties.slice(0, 10);
                        const origin = props[0];
                        const dest = props[props.length - 1];
                        const waypoints = props.slice(1, -1).map(p => `${p.lat},${p.lng}`).join('|');
                        let url = `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lng}&destination=${dest.lat},${dest.lng}&travelmode=walking`;
                        if (waypoints) url += `&waypoints=${waypoints}`;
                        window.open(url, '_blank');
                    }}
                >
                    <Navigation className="w-4 h-4 mr-2" />
                    EXPORT ROUTE TO GOOGLE MAPS
                </Button>
            </div>

            {/* Property List */}
            <ScrollArea className="flex-1">
                <div className="p-4 space-y-2">
                    {filteredProperties.map((prop, idx) => {
                        const currentStatus = propertyStatuses[prop.address_hash];
                        const isExpanded = expandedId === prop.address_hash;
                        const isDone = currentStatus && currentStatus !== 'ELIGIBLE';

                        return (
                            <div 
                                key={prop.address_hash}
                                className="rounded-xl border transition-all"
                                style={{ 
                                    background: isDone ? `${BRAND.charcoal}80` : BRAND.charcoal,
                                    borderColor: isExpanded ? BRAND.gold : '#333'
                                }}
                            >
                                <button
                                    onClick={() => setExpandedId(isExpanded ? null : prop.address_hash)}
                                    className="w-full p-4 flex items-center gap-3 text-left"
                                >
                                    <div 
                                        className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold"
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
                                    </div>

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
                                </button>

                                {isExpanded && (
                                    <div className="px-4 pb-4 pt-1 border-t" style={{ borderColor: '#333' }}>
                                        <p className="text-xs mb-3" style={{ color: '#888' }}>SELECT OUTCOME:</p>
                                        <div className="grid grid-cols-2 gap-2">
                                            {STATUS_OPTIONS.map(opt => (
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
                                            ))}
                                        </div>
                                        
                                        <Button
                                            variant="outline"
                                            className="w-full mt-3 text-xs font-bold tracking-wide"
                                            style={{ borderColor: '#333', color: BRAND.offWhite }}
                                            onClick={() => window.open(`https://www.google.com/maps?q=${prop.lat},${prop.lng}`, '_blank')}
                                        >
                                            <MapPin className="w-4 h-4 mr-2" />
                                            OPEN IN MAPS
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