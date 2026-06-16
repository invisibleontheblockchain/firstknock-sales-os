import React from 'react';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { X, Home as HomeIcon, Shield, DollarSign, Calendar, Ruler, User, Navigation } from 'lucide-react';
import { format } from 'date-fns';
import { DarkRoomClient } from '@/components/logic/neonClient';
import PropertyHistory from '@/components/rep/PropertyHistory';
import QuickMarkButtons from '@/components/rep/QuickMarkButtons';
import { buildFullAddress, openInMaps } from '@/components/logic/navigation';
import ConfidenceBadge from '@/components/map/ConfidenceBadge';

function numberValue(...values) {
    for (const value of values) {
        if (value === undefined || value === null || value === '') continue;
        if (typeof value === 'object') {
            const nested = numberValue(value.amount, value.value, value.estimatedValue, value.total);
            if (nested !== null) return nested;
            continue;
        }
        const parsed = Number(String(value).replace(/[^0-9.-]/g, ''));
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function dateValue(...values) {
    for (const value of values) {
        if (value === undefined || value === null || value === '') continue;
        if (typeof value === 'object') {
            const nested = dateValue(value.date, value.value, value.recordingDate, value.saleDate);
            if (nested) return nested;
            continue;
        }
        const parsed = new Date(value);
        if (!isNaN(parsed.getTime())) return parsed;
    }
    return null;
}

export default function ManagerPropertyDetailSheet({
    selectedProperty,
    setSelectedProperty,
    STATUS_COLORS,
    navigationApp,
    selectedPropertyLogs,
    handleLogResult,
    toast
}) {
    if (!selectedProperty) return null;

    const estimatedValue = numberValue(selectedProperty.price, selectedProperty.estimated_value, selectedProperty.estimatedValue, selectedProperty.valuation?.estimatedValue, selectedProperty.valuation?.value);
    const builtYear = numberValue(selectedProperty.year_built, selectedProperty.yearBuilt, selectedProperty.building?.yearBuilt);
    const squareFeet = numberValue(selectedProperty.sqft, selectedProperty.squareFootage, selectedProperty.livingAreaSquareFeet, selectedProperty.building?.livingAreaSquareFeet, selectedProperty.building?.squareFeet);
    const soldDate = dateValue(selectedProperty.sold_date, selectedProperty.soldDate, selectedProperty.lastSaleDate, selectedProperty.sale?.lastSaleDate);
    const ownerName = selectedProperty.owner_full_name || selectedProperty.ownerFullName || selectedProperty.owner_name || selectedProperty.owner?.fullName || selectedProperty.owner?.ownerName || null;
    const beds = numberValue(selectedProperty.beds, selectedProperty.bedrooms, selectedProperty.building?.bedroomCount);
    const baths = numberValue(selectedProperty.baths, selectedProperty.bathrooms, selectedProperty.building?.bathroomCount);

    return (
        <div className="fixed inset-0 z-[3000] flex flex-col justify-end sm:justify-center sm:items-center">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setSelectedProperty(null)} />
            <div className="relative w-full max-w-md bg-[#151515] sm:rounded-2xl rounded-t-2xl border border-gray-800 shadow-2xl overflow-hidden animate-in slide-in-from-bottom duration-300 max-h-[85vh] flex flex-col">

                {/* Header */}
                <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between bg-[#0A0A0A]">
                    <div>
                        <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">PROPERTY DETAILS</p>
                        <h3 className="font-bold text-lg text-white truncate max-w-[200px]">{selectedProperty.house_number} {selectedProperty.street_name}</h3>
                    </div>
                    <Button 
                        variant="ghost" 
                        size="icon"
                        onClick={() => setSelectedProperty(null)}
                        className="text-gray-400 hover:text-white"
                    >
                        <X className="w-5 h-5" />
                    </Button>
                </div>

                <ScrollArea className="flex-1">
                    <div className="p-6 space-y-6">
                        {/* Status Badge */}
                        <div className="flex items-center justify-between p-4 bg-black rounded-xl border border-gray-800">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-full flex items-center justify-center" 
                                    style={{ background: STATUS_COLORS[selectedProperty.effective_status] || '#333' }}>
                                    <HomeIcon className="w-5 h-5 text-white" />
                                </div>
                                <div>
                                    <p className="text-xs text-gray-400">Current Status</p>
                                    <p className="font-bold text-white">{selectedProperty.effective_status}</p>
                                </div>
                            </div>
                            {selectedProperty.next_eligible_date && (
                                <div className="text-right">
                                    <p className="text-xs text-gray-400">Eligible</p>
                                    <p className="font-bold text-white text-xs">
                                        {format(new Date(selectedProperty.next_eligible_date), 'MMM d')}
                                    </p>
                                </div>
                            )}
                        </div>

                        {/* Confidence Tier */}
                        {selectedProperty.sale_confidence && (
                            <div className="flex items-center justify-between p-3 bg-black/60 rounded-xl border border-gray-800">
                                <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Data Confidence</span>
                                <ConfidenceBadge confidence={selectedProperty.sale_confidence} />
                            </div>
                        )}

                        {/* Intel Grid */}
                        <div>
                            <h4 className="text-xs font-bold text-gray-500 uppercase mb-3 flex items-center gap-2">
                                <Shield className="w-3 h-3" /> Property Intel
                                {selectedProperty.is_dark_room && (
                                    <Badge className="ml-2 bg-purple-600 text-white text-[8px]">DARK ROOM</Badge>
                                )}
                            </h4>

                            {/* Smart Score (Dark Room) */}
                            {selectedProperty.is_dark_room && selectedProperty.smart_score > 0 && (
                                <div className="mb-3 p-3 rounded-lg border" style={{ 
                                    background: `${DarkRoomClient.getScoreColor(selectedProperty.smart_score)}15`,
                                    borderColor: DarkRoomClient.getScoreColor(selectedProperty.smart_score)
                                }}>
                                    <div className="flex items-center justify-between">
                                        <span className="text-xs font-bold text-gray-400">SMART SCORE</span>
                                        <span className="text-2xl font-bold" style={{ color: DarkRoomClient.getScoreColor(selectedProperty.smart_score) }}>
                                            {selectedProperty.smart_score.toFixed(0)}
                                        </span>
                                    </div>
                                    {selectedProperty.turnover_prob > 0 && (
                                        <p className="text-[10px] text-gray-500 mt-1">
                                            Turnover Probability: {(selectedProperty.turnover_prob * 100).toFixed(1)}%
                                        </p>
                                    )}
                                </div>
                            )}

                            <div className="grid grid-cols-2 gap-3">
                                {ownerName && (
                                    <div className="col-span-2 p-3 bg-black/40 rounded-lg border border-gray-800">
                                        <p className="text-[10px] text-gray-500 uppercase mb-1 flex items-center gap-1">
                                            <User className="w-3 h-3" /> Current Owner
                                        </p>
                                        <p className="font-bold text-white text-sm truncate">{ownerName}</p>
                                    </div>
                                )}
                                <div className="p-3 bg-black/40 rounded-lg border border-gray-800">
                                    <p className="text-[10px] text-gray-500 uppercase mb-1 flex items-center gap-1">
                                        <DollarSign className="w-3 h-3" /> Est. Value
                                    </p>
                                    <p className="font-bold text-white">{estimatedValue ? `$${(estimatedValue / 1000).toFixed(0)}k` : '-'}</p>
                                </div>
                                <div className="p-3 bg-black/40 rounded-lg border border-gray-800">
                                    <p className="text-[10px] text-gray-500 uppercase mb-1 flex items-center gap-1">
                                        <Calendar className="w-3 h-3" /> Built
                                    </p>
                                    <p className="font-bold text-white">{builtYear || 'N/A'}</p>
                                </div>
                                <div className="p-3 bg-black/40 rounded-lg border border-gray-800">
                                    <p className="text-[10px] text-gray-500 uppercase mb-1 flex items-center gap-1">
                                        <Ruler className="w-3 h-3" /> SqFt
                                    </p>
                                    <p className="font-bold text-white">{squareFeet ? squareFeet.toLocaleString() : '-'}</p>
                                </div>
                                <div className="p-3 bg-black/40 rounded-lg border border-gray-800">
                                    <p className="text-[10px] text-gray-500 uppercase mb-1 flex items-center gap-1">
                                        <User className="w-3 h-3" /> Last Sold
                                    </p>
                                    <p className="font-bold text-white text-xs">
                                        {soldDate ? format(soldDate, 'MMM d, yyyy') : '-'}
                                    </p>
                                </div>
                                {beds && (
                                    <div className="p-3 bg-black/40 rounded-lg border border-gray-800">
                                        <p className="text-[10px] text-gray-500 uppercase mb-1">Beds/Baths</p>
                                        <p className="font-bold text-white">{beds}bd / {baths || '-'}ba</p>
                                    </div>
                                )}
                                {selectedProperty.equity && (
                                    <div className="p-3 bg-black/40 rounded-lg border border-gray-800">
                                        <p className="text-[10px] text-gray-500 uppercase mb-1">Est. Equity</p>
                                        <p className="font-bold text-green-500">${(selectedProperty.equity / 1000).toFixed(0)}k</p>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Interaction History */}
                        <div>
                            <h4 className="text-xs font-bold text-gray-500 uppercase mb-3 flex items-center gap-2">
                                <span className="w-4 h-4 text-yellow-500">📋</span> Interaction History
                            </h4>
                            <PropertyHistory logs={selectedPropertyLogs} />
                        </div>

                    </div>
                </ScrollArea>

                {/* Sticky Footer Actions */}
                <div className="p-4 border-t border-gray-800 bg-[#0A0A0A] space-y-3 z-10 shrink-0 shadow-[0_-5px_15px_-5px_rgba(0,0,0,0.5)]">
                    {/* Quick Mark Buttons */}
                    <div>
                        <h4 className="text-xs font-bold text-gray-500 uppercase mb-2">Quick Log</h4>
                        <QuickMarkButtons
                            size="large"
                            onMark={(status) => {
                                handleLogResult(selectedProperty, status);
                                setSelectedProperty(null);
                                toast.success(`Logged as ${status}`);
                            }}
                        />
                    </div>

                    {/* Map Link */}
                    <Button 
                        onClick={() => openInMaps(selectedProperty.lat, selectedProperty.lng, buildFullAddress(selectedProperty), navigationApp)}
                        className="block w-full py-3 bg-gray-800 hover:bg-gray-700 rounded-xl text-center font-bold text-sm text-white transition-colors flex items-center justify-center gap-2 h-auto shrink-0"
                    >
                        <Navigation className="w-4 h-4 text-yellow-500" />
                        Navigate ({navigationApp === 'google' ? 'Google Maps' : 'Apple Maps'})
                    </Button>
                </div>
            </div>
        </div>
    );
}