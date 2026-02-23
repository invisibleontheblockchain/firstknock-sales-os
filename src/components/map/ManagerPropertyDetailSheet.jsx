import React from 'react';
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { X, Home as HomeIcon, Shield, DollarSign, Calendar, Ruler, User, Navigation } from 'lucide-react';
import { format } from 'date-fns';
import { DarkRoomClient } from '@/components/logic/neonClient';
import PropertyHistory from '@/components/rep/PropertyHistory';
import QuickMarkButtons from '@/components/rep/QuickMarkButtons';
import { openInMaps } from '@/components/logic/navigation';

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
                                <div className="p-3 bg-black/40 rounded-lg border border-gray-800">
                                    <p className="text-[10px] text-gray-500 uppercase mb-1 flex items-center gap-1">
                                        <DollarSign className="w-3 h-3" /> Est. Value
                                    </p>
                                    <p className="font-bold text-white">{selectedProperty.price ? `$${(selectedProperty.price / 1000).toFixed(0)}k` : '-'}</p>
                                </div>
                                <div className="p-3 bg-black/40 rounded-lg border border-gray-800">
                                    <p className="text-[10px] text-gray-500 uppercase mb-1 flex items-center gap-1">
                                        <Calendar className="w-3 h-3" /> Built
                                    </p>
                                    <p className="font-bold text-white">{selectedProperty.year_built || 'N/A'}</p>
                                </div>
                                <div className="p-3 bg-black/40 rounded-lg border border-gray-800">
                                    <p className="text-[10px] text-gray-500 uppercase mb-1 flex items-center gap-1">
                                        <Ruler className="w-3 h-3" /> SqFt
                                    </p>
                                    <p className="font-bold text-white">{selectedProperty.sqft?.toLocaleString() || '-'}</p>
                                </div>
                                <div className="p-3 bg-black/40 rounded-lg border border-gray-800">
                                    <p className="text-[10px] text-gray-500 uppercase mb-1 flex items-center gap-1">
                                        <User className="w-3 h-3" /> Last Sold
                                    </p>
                                    <p className="font-bold text-white">
                                        {selectedProperty.sold_date ? format(new Date(selectedProperty.sold_date), 'yyyy') : '-'}
                                    </p>
                                </div>
                                {selectedProperty.beds && (
                                    <div className="p-3 bg-black/40 rounded-lg border border-gray-800">
                                        <p className="text-[10px] text-gray-500 uppercase mb-1">Beds/Baths</p>
                                        <p className="font-bold text-white">{selectedProperty.beds}bd / {selectedProperty.baths || '-'}ba</p>
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

                        {/* Quick Mark Buttons */}
                        <div>
                            <h4 className="text-xs font-bold text-gray-500 uppercase mb-3">Quick Log</h4>
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
                            onClick={() => {
                                let address = "";
                                if (selectedProperty.full_address) {
                                    address = selectedProperty.full_address;
                                    if (selectedProperty.city) address += `, ${selectedProperty.city}`;
                                    if (selectedProperty.state) address += `, ${selectedProperty.state}`;
                                    if (selectedProperty.zip_code) address += ` ${selectedProperty.zip_code}`;
                                }
                                openInMaps(selectedProperty.lat, selectedProperty.lng, address, navigationApp);
                            }}
                            className="block w-full py-3 bg-gray-800 hover:bg-gray-700 rounded-xl text-center font-bold text-sm text-white transition-colors flex items-center justify-center gap-2 h-auto"
                        >
                            <Navigation className="w-4 h-4 text-yellow-500" />
                            Navigate ({navigationApp === 'google' ? 'Google Maps' : 'Apple Maps'})
                        </Button>
                    </div>
                </ScrollArea>
            </div>
        </div>
    );
}