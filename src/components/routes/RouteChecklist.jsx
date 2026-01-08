import React, { useState, useMemo } from 'react';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Check, X, Phone, Ban, Clock, Home, ChevronDown, ChevronUp, MapPin } from 'lucide-react';

const STATUS_OPTIONS = [
    { id: 'SOLD', label: 'Sold', icon: Check, color: 'bg-green-600 hover:bg-green-700' },
    { id: 'NO_ANSWER', label: 'No Answer', icon: Home, color: 'bg-slate-600 hover:bg-slate-700' },
    { id: 'CALLBACK', label: 'Callback', icon: Phone, color: 'bg-yellow-600 hover:bg-yellow-700' },
    { id: 'HARD_NO', label: 'Not Interested', icon: Ban, color: 'bg-red-600 hover:bg-red-700' },
];

const STATUS_COLORS = {
    ELIGIBLE: 'bg-green-500',
    SOLD: 'bg-green-600',
    HARD_NO: 'bg-red-500',
    CALLBACK: 'bg-yellow-500',
    NO_ANSWER: 'bg-slate-500',
    QUALIFIED: 'bg-blue-500'
};

export default function RouteChecklist({ route, logs, onLogResult, onClose }) {
    const [expandedId, setExpandedId] = useState(null);
    const [filter, setFilter] = useState('all'); // all, pending, done

    // Get latest status for each property from logs
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

    // Filter properties
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
        <div className="h-full flex flex-col">
            {/* Header */}
            <div className="p-4 border-b border-slate-700">
                <div className="flex items-center justify-between mb-3">
                    <div>
                        <h2 className="text-lg font-bold text-white">{route.name}</h2>
                        <p className="text-xs text-slate-400">{route.houseCount} properties</p>
                    </div>
                    <Button variant="ghost" size="icon" onClick={onClose}>
                        <X className="w-5 h-5 text-slate-400" />
                    </Button>
                </div>

                {/* Progress */}
                <div className="mb-3">
                    <div className="flex justify-between text-xs text-slate-400 mb-1">
                        <span>Progress</span>
                        <span>{stats.done}/{stats.total}</span>
                    </div>
                    <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                        <div 
                            className="h-full bg-indigo-500 transition-all duration-300"
                            style={{ width: `${(stats.done / stats.total) * 100}%` }}
                        />
                    </div>
                </div>

                {/* Filters */}
                <div className="flex gap-2">
                    {[
                        { id: 'all', label: 'All' },
                        { id: 'pending', label: `Pending (${stats.pending})` },
                        { id: 'done', label: `Done (${stats.done})` }
                    ].map(f => (
                        <button
                            key={f.id}
                            onClick={() => setFilter(f.id)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                                filter === f.id 
                                    ? 'bg-indigo-600 text-white' 
                                    : 'bg-slate-800 text-slate-400 hover:text-white'
                            }`}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Property List */}
            <ScrollArea className="flex-1">
                <div className="p-3 space-y-2">
                    {filteredProperties.map((prop, idx) => {
                        const currentStatus = propertyStatuses[prop.address_hash];
                        const isExpanded = expandedId === prop.address_hash;
                        const isDone = currentStatus && currentStatus !== 'ELIGIBLE';

                        return (
                            <div 
                                key={prop.address_hash}
                                className={`rounded-xl border transition-all ${
                                    isDone 
                                        ? 'bg-slate-800/30 border-slate-700/50' 
                                        : 'bg-slate-800 border-slate-700'
                                }`}
                            >
                                <button
                                    onClick={() => setExpandedId(isExpanded ? null : prop.address_hash)}
                                    className="w-full p-3 flex items-center gap-3 text-left"
                                >
                                    {/* Sequence Number */}
                                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                                        isDone ? 'bg-slate-700 text-slate-500' : 'bg-indigo-600 text-white'
                                    }`}>
                                        {idx + 1}
                                    </div>

                                    {/* Address */}
                                    <div className="flex-1 min-w-0">
                                        <p className={`font-medium truncate ${isDone ? 'text-slate-500' : 'text-white'}`}>
                                            {prop.full_address}
                                        </p>
                                        <p className="text-xs text-slate-500">{prop.street_name}</p>
                                    </div>

                                    {/* Status Badge */}
                                    {currentStatus && (
                                        <Badge className={`${STATUS_COLORS[currentStatus]} text-white text-xs`}>
                                            {currentStatus}
                                        </Badge>
                                    )}

                                    {/* Expand Icon */}
                                    {isExpanded ? (
                                        <ChevronUp className="w-5 h-5 text-slate-500" />
                                    ) : (
                                        <ChevronDown className="w-5 h-5 text-slate-500" />
                                    )}
                                </button>

                                {/* Expanded Actions */}
                                {isExpanded && (
                                    <div className="px-3 pb-3 pt-1 border-t border-slate-700/50">
                                        <p className="text-xs text-slate-500 mb-3">Select outcome:</p>
                                        <div className="grid grid-cols-2 gap-2">
                                            {STATUS_OPTIONS.map(opt => (
                                                <Button
                                                    key={opt.id}
                                                    onClick={() => handleSelectStatus(prop, opt.id)}
                                                    className={`${opt.color} text-white h-10 text-sm`}
                                                >
                                                    <opt.icon className="w-4 h-4 mr-2" />
                                                    {opt.label}
                                                </Button>
                                            ))}
                                        </div>
                                        
                                        {/* Google Maps Link */}
                                        <Button
                                            variant="outline"
                                            className="w-full mt-2 border-slate-700 text-slate-400 hover:text-white"
                                            onClick={() => window.open(`https://www.google.com/maps?q=${prop.lat},${prop.lng}`, '_blank')}
                                        >
                                            <MapPin className="w-4 h-4 mr-2" />
                                            Open in Maps
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