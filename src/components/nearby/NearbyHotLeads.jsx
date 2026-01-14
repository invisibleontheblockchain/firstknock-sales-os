import React, { useState, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { X, Navigation, Flame, MapPin, ChevronRight } from 'lucide-react';
import { scoreProperty } from '../logic/routeOptimizer';

// Haversine distance in miles
function getDistance(lat1, lng1, lat2, lng2) {
    const R = 3959;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Calculate days since sold
function getDaysSinceSold(soldDate) {
    if (!soldDate) return null;
    const sold = new Date(soldDate);
    const now = new Date();
    return Math.floor((now - sold) / (1000 * 60 * 60 * 24));
}

const BRAND = {
    voidBlack: '#0A0A0A',
    gold: '#FFD700',
    charcoal: '#1F1F1F',
    offWhite: '#E5E5E5'
};

export default function NearbyHotLeads({ properties, radiusMiles = 1, maxLeads = 3 }) {
    const [userLocation, setUserLocation] = useState(null);
    const [nearbyLeads, setNearbyLeads] = useState([]);
    const [dismissed, setDismissed] = useState(false);
    const [expanded, setExpanded] = useState(false);

    // Watch user's location
    useEffect(() => {
        if (!navigator.geolocation) return;

        const watchId = navigator.geolocation.watchPosition(
            (pos) => setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
            (err) => console.log('Geolocation error:', err),
            { enableHighAccuracy: true, maximumAge: 30000 }
        );

        return () => navigator.geolocation.clearWatch(watchId);
    }, []);

    // Find nearby hot leads when location or properties change
    useEffect(() => {
        if (!userLocation || !properties?.length) {
            setNearbyLeads([]);
            return;
        }

        const eligible = properties
            .filter(p => p.lat && p.lng && p.effective_status !== 'HARD_NO' && p.effective_status !== 'SOLD')
            .map(p => ({
                ...p,
                distance: getDistance(userLocation.lat, userLocation.lng, p.lat, p.lng),
                score: scoreProperty(p),
                daysSinceSold: getDaysSinceSold(p.sold_date)
            }))
            .filter(p => p.distance <= radiusMiles)
            .sort((a, b) => b.score - a.score) // Highest score first
            .slice(0, maxLeads);

        setNearbyLeads(eligible);
    }, [userLocation, properties, radiusMiles, maxLeads]);

    // Don't show if dismissed or no leads
    if (dismissed || nearbyLeads.length === 0) return null;

    const topLead = nearbyLeads[0];

    const openInMaps = (lead) => {
        window.open(`https://maps.apple.com/?daddr=${lead.lat},${lead.lng}&dirflg=w`, '_blank');
    };

    return (
        <div 
            className="absolute bottom-28 left-4 right-4 z-[1500] animate-in slide-in-from-bottom-4 duration-300"
        >
            {/* Collapsed: Single Hot Lead Banner */}
            {!expanded ? (
                <div 
                    className="rounded-xl p-4 border shadow-2xl cursor-pointer"
                    style={{ 
                        background: `linear-gradient(135deg, ${BRAND.charcoal} 0%, #1a1a1a 100%)`,
                        borderColor: BRAND.gold,
                        boxShadow: `0 0 20px ${BRAND.gold}40`
                    }}
                    onClick={() => setExpanded(true)}
                >
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div 
                                className="w-10 h-10 rounded-full flex items-center justify-center animate-pulse"
                                style={{ background: `${BRAND.gold}30` }}
                            >
                                <Flame className="w-5 h-5" style={{ color: BRAND.gold }} />
                            </div>
                            <div>
                                <div className="flex items-center gap-2">
                                    <span className="text-xs font-bold tracking-wider" style={{ color: BRAND.gold }}>
                                        HOT LEAD NEARBY
                                    </span>
                                    {topLead.daysSinceSold !== null && topLead.daysSinceSold <= 7 && (
                                        <Badge className="text-[9px] px-1.5 py-0" style={{ background: '#ef4444', color: '#fff' }}>
                                            {topLead.daysSinceSold === 0 ? 'TODAY' : `${topLead.daysSinceSold}d AGO`}
                                        </Badge>
                                    )}
                                </div>
                                <p className="text-sm font-medium truncate max-w-[200px]" style={{ color: BRAND.offWhite }}>
                                    {topLead.full_address}
                                </p>
                                <p className="text-xs" style={{ color: '#888' }}>
                                    {topLead.distance.toFixed(2)} mi • ${(topLead.price / 1000).toFixed(0)}K • Score: {topLead.score}
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <Button
                                size="sm"
                                onClick={(e) => { e.stopPropagation(); openInMaps(topLead); }}
                                className="h-9 px-3 font-bold"
                                style={{ background: BRAND.gold, color: BRAND.voidBlack }}
                            >
                                <Navigation className="w-4 h-4 mr-1" />
                                GO
                            </Button>
                            <button 
                                onClick={(e) => { e.stopPropagation(); setDismissed(true); }}
                                className="p-1"
                            >
                                <X className="w-4 h-4" style={{ color: '#666' }} />
                            </button>
                        </div>
                    </div>
                    {nearbyLeads.length > 1 && (
                        <div className="flex items-center justify-center mt-2 pt-2 border-t" style={{ borderColor: '#333' }}>
                            <span className="text-[10px]" style={{ color: '#666' }}>
                                +{nearbyLeads.length - 1} more nearby • Tap to expand
                            </span>
                            <ChevronRight className="w-3 h-3 ml-1" style={{ color: '#666' }} />
                        </div>
                    )}
                </div>
            ) : (
                /* Expanded: Show all nearby leads */
                <div 
                    className="rounded-xl border shadow-2xl overflow-hidden"
                    style={{ 
                        background: BRAND.charcoal,
                        borderColor: BRAND.gold,
                        boxShadow: `0 0 20px ${BRAND.gold}40`
                    }}
                >
                    <div className="p-3 flex items-center justify-between border-b" style={{ borderColor: '#333', background: BRAND.voidBlack }}>
                        <div className="flex items-center gap-2">
                            <Flame className="w-4 h-4" style={{ color: BRAND.gold }} />
                            <span className="text-xs font-bold tracking-wider" style={{ color: BRAND.gold }}>
                                {nearbyLeads.length} HOT LEADS WITHIN {radiusMiles} MI
                            </span>
                        </div>
                        <div className="flex gap-2">
                            <button onClick={() => setExpanded(false)} className="text-xs" style={{ color: '#888' }}>
                                COLLAPSE
                            </button>
                            <button onClick={() => setDismissed(true)}>
                                <X className="w-4 h-4" style={{ color: '#666' }} />
                            </button>
                        </div>
                    </div>
                    <div className="max-h-60 overflow-y-auto">
                        {nearbyLeads.map((lead, idx) => (
                            <div 
                                key={lead.address_hash}
                                className="p-3 flex items-center justify-between border-b last:border-0"
                                style={{ borderColor: '#222' }}
                            >
                                <div className="flex items-center gap-3">
                                    <div 
                                        className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold"
                                        style={{ background: idx === 0 ? BRAND.gold : '#333', color: idx === 0 ? BRAND.voidBlack : BRAND.offWhite }}
                                    >
                                        {idx + 1}
                                    </div>
                                    <div>
                                        <p className="text-sm font-medium truncate max-w-[180px]" style={{ color: BRAND.offWhite }}>
                                            {lead.full_address}
                                        </p>
                                        <div className="flex items-center gap-2 text-[10px]" style={{ color: '#888' }}>
                                            <span>{lead.distance.toFixed(2)} mi</span>
                                            <span>•</span>
                                            <span>${(lead.price / 1000).toFixed(0)}K</span>
                                            {lead.daysSinceSold !== null && (
                                                <>
                                                    <span>•</span>
                                                    <span style={{ color: lead.daysSinceSold <= 7 ? '#ef4444' : '#888' }}>
                                                        Sold {lead.daysSinceSold}d ago
                                                    </span>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                </div>
                                <Button
                                    size="sm"
                                    onClick={() => openInMaps(lead)}
                                    className="h-8 px-3 text-xs font-bold"
                                    style={{ background: BRAND.gold, color: BRAND.voidBlack }}
                                >
                                    <Navigation className="w-3 h-3 mr-1" />
                                    GO
                                </Button>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}