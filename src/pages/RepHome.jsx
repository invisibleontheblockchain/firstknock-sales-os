import React, { useState, useMemo } from 'react';
import { MapContainer, TileLayer, CircleMarker, Tooltip, useMap, Circle } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Navigation, ChevronRight, MapPin, CheckCircle, Phone, X, ExternalLink } from 'lucide-react';
import { determineEffectiveStatus } from '../components/logic/territoryLogic';
import KnockTimeBanner from '../components/timing/KnockTimeBanner';

const BRAND = {
    voidBlack: '#0A0A0A',
    gold: '#FFD700',
    charcoal: '#1F1F1F',
    offWhite: '#E5E5E5'
};

const STATUS_COLORS = {
    ELIGIBLE: '#6b7280',
    SOLD: '#22c55e',
    HARD_NO: '#ef4444',
    CALLBACK: '#eab308',
    NO_ANSWER: '#6b7280',
    QUALIFIED: '#22c55e',
    OTHER: '#6b7280'
};

function LocationMarker() {
    const [position, setPosition] = useState(null);
    const map = useMap();
    React.useEffect(() => {
        const handleLocationFound = (e) => setPosition(e.latlng);
        map.locate().on("locationfound", handleLocationFound);
        return () => map.off("locationfound", handleLocationFound);
    }, [map]);
    return position ? <Circle center={position} radius={15} pathOptions={{ fillColor: BRAND.gold, fillOpacity: 0.3, color: BRAND.gold, weight: 2 }} /> : null;
}

export default function RepHome() {
    const queryClient = useQueryClient();
    const [activeProperty, setActiveProperty] = useState(null);
    const [showTimingPanel, setShowTimingPanel] = useState(false);
    
    const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me() });

    // Get routes assigned to this rep
    const { data: myRoutesRaw = [], isLoading: routesLoading } = useQuery({
        queryKey: ['myRoutes', user?.email],
        queryFn: async () => {
            if (!user?.email) return [];
            const all = await base44.entities.SavedRoute.list('-created_date', 100);
            const routes = Array.isArray(all) ? all : (all?.items || []);
            // Filter to routes assigned to me or unassigned
            return routes.filter(r => 
                r.assigned_to_name === user.email || 
                r.assigned_to === user.id ||
                (!r.assigned_to && r.status === 'ACTIVE')
            );
        },
        enabled: !!user
    });

    // Get properties for my routes
    const { data: properties = [], isLoading: propsLoading } = useQuery({
        queryKey: ['masterProperties', user?.email],
        queryFn: async () => {
            if (!user?.email) return [];
            const result = await base44.entities.MasterProperty.filter({ created_by: user.email }, '-created_date', 5000);
            return Array.isArray(result) ? result : (result?.items || []);
        },
        enabled: !!user?.email
    });

    const { data: logsRaw = [] } = useQuery({
        queryKey: ['interactionLogs', user?.email],
        queryFn: () => user ? base44.entities.InteractionLog.filter({ created_by: user.email }, '-created_date', 1000) : [],
        enabled: !!user
    });
    const logs = Array.isArray(logsRaw) ? logsRaw : (logsRaw?.items || []);

    const createLogMutation = useMutation({
        mutationFn: (logData) => base44.entities.InteractionLog.create(logData),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['interactionLogs'] }),
    });

    // Get current active route (first ACTIVE or IN_PROGRESS)
    const currentRoute = useMemo(() => {
        return myRoutesRaw.find(r => r.status === 'IN_PROGRESS') || myRoutesRaw.find(r => r.status === 'ACTIVE');
    }, [myRoutesRaw]);

    // Hydrate route properties
    const routeProperties = useMemo(() => {
        if (!currentRoute?.property_hashes) return [];
        return currentRoute.property_hashes
            .map(hash => properties.find(p => p.address_hash === hash))
            .filter(Boolean)
            .map(p => {
                const propLogs = logs.filter(l => l.address_hash === p.address_hash);
                return {
                    ...p,
                    lat: parseFloat(p.lat),
                    lng: parseFloat(p.lng),
                    effective_status: determineEffectiveStatus(p, propLogs)
                };
            });
    }, [currentRoute, properties, logs]);

    // Calculate progress
    const progress = useMemo(() => {
        const total = routeProperties.length;
        const visited = routeProperties.filter(p => 
            p.effective_status !== 'ELIGIBLE' && p.effective_status !== 'NO_ANSWER'
        ).length;
        return { total, visited, percent: total > 0 ? Math.round((visited / total) * 100) : 0 };
    }, [routeProperties]);

    const handleLogResult = (property, status) => {
        createLogMutation.mutate({
            address_hash: property.address_hash,
            raw_input_text: status,
            parsed_status: status,
            gps_proof_lat: property.lat,
            gps_proof_lng: property.lng
        });
        setActiveProperty(null);
    };

    const openInMaps = (property) => {
        const url = `https://maps.apple.com/?daddr=${property.lat},${property.lng}`;
        window.open(url, '_blank');
    };

    const center = routeProperties[0] ? [routeProperties[0].lat, routeProperties[0].lng] : [34.0522, -118.2437];
    const isLoading = routesLoading || propsLoading;

    if (isLoading) {
        return (
            <div className="h-full flex items-center justify-center" style={{ background: BRAND.voidBlack }}>
                <div className="text-center">
                    <Loader2 className="w-10 h-10 animate-spin mx-auto mb-3" style={{ color: BRAND.gold }} />
                    <p className="text-sm font-medium" style={{ color: BRAND.offWhite }}>Loading your route...</p>
                </div>
            </div>
        );
    }

    if (!currentRoute) {
        return (
            <div className="h-full flex items-center justify-center p-6" style={{ background: BRAND.voidBlack }}>
                <div className="text-center space-y-4">
                    <div className="w-16 h-16 bg-yellow-500/20 rounded-2xl flex items-center justify-center mx-auto">
                        <Navigation className="w-8 h-8 text-yellow-500" />
                    </div>
                    <h2 className="text-xl font-bold text-white">No Route Assigned</h2>
                    <p className="text-gray-400 text-sm max-w-xs">
                        Ask your manager to assign you a route, or check back later.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="h-full relative" style={{ background: BRAND.voidBlack }}>
            {/* Map */}
            <MapContainer center={center} zoom={16} style={{ height: '100%', width: '100%' }} zoomControl={false}>
                <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" />
                <LocationMarker />
                
                {routeProperties.map((p, idx) => (
                    <CircleMarker
                        key={p.address_hash}
                        center={[p.lat, p.lng]}
                        radius={14}
                        eventHandlers={{ click: () => setActiveProperty(p) }}
                        pathOptions={{
                            fillColor: p.effective_status === 'ELIGIBLE' ? '#333' : STATUS_COLORS[p.effective_status],
                            fillOpacity: 1,
                            color: p.effective_status === 'ELIGIBLE' ? BRAND.gold : '#fff',
                            weight: 2
                        }}
                    >
                        <Tooltip permanent direction="center" className="route-number-tooltip">
                            <span style={{ color: p.effective_status === 'ELIGIBLE' ? BRAND.gold : '#fff', fontWeight: 'bold', fontSize: '11px' }}>
                                {idx + 1}
                            </span>
                        </Tooltip>
                    </CircleMarker>
                ))}
            </MapContainer>

            {/* Top Bar - Route Info + Timing */}
            <div className="absolute top-4 left-4 right-4 z-[1000] flex justify-between items-start">
                <div className="rounded-xl px-4 py-3 border" style={{ background: `${BRAND.voidBlack}ee`, borderColor: BRAND.charcoal }}>
                    <p className="text-xs text-gray-400">YOUR ROUTE</p>
                    <p className="font-bold text-white">{currentRoute.name}</p>
                    <div className="flex items-center gap-2 mt-1">
                        <div className="h-1.5 w-24 bg-gray-700 rounded-full overflow-hidden">
                            <div className="h-full bg-green-500 rounded-full" style={{ width: `${progress.percent}%` }} />
                        </div>
                        <span className="text-xs text-gray-400">{progress.visited}/{progress.total}</span>
                    </div>
                </div>
                
                <KnockTimeBanner expanded={showTimingPanel} onToggle={() => setShowTimingPanel(!showTimingPanel)} />
            </div>

            {/* Bottom - Next House CTA */}
            <div className="absolute bottom-6 left-4 right-4 z-[1000]">
                {routeProperties.length > 0 && (
                    <div className="rounded-xl p-4 border" style={{ background: `${BRAND.voidBlack}f5`, borderColor: BRAND.gold }}>
                        {(() => {
                            const nextHouse = routeProperties.find(p => p.effective_status === 'ELIGIBLE');
                            const nextIdx = routeProperties.indexOf(nextHouse);
                            if (!nextHouse) {
                                return (
                                    <div className="text-center py-2">
                                        <CheckCircle className="w-8 h-8 text-green-500 mx-auto mb-2" />
                                        <p className="font-bold text-white">Route Complete! 🎉</p>
                                    </div>
                                );
                            }
                            return (
                                <>
                                    <div className="flex items-center justify-between mb-3">
                                        <div>
                                            <p className="text-xs text-gray-400">NEXT HOUSE #{nextIdx + 1}</p>
                                            <p className="font-bold text-white">{nextHouse.full_address || `${nextHouse.house_number} ${nextHouse.street_name}`}</p>
                                        </div>
                                        <Badge style={{ background: BRAND.gold, color: '#000' }}>
                                            {routeProperties.length - progress.visited} left
                                        </Badge>
                                    </div>
                                    <div className="flex gap-2">
                                        <Button
                                            onClick={() => openInMaps(nextHouse)}
                                            className="flex-1 h-12 font-bold"
                                            style={{ background: BRAND.gold, color: '#000' }}
                                        >
                                            <Navigation className="w-5 h-5 mr-2" />
                                            NAVIGATE
                                        </Button>
                                        <Button
                                            onClick={() => setActiveProperty(nextHouse)}
                                            className="h-12 px-4"
                                            style={{ background: BRAND.charcoal, color: BRAND.gold, border: `1px solid ${BRAND.gold}` }}
                                        >
                                            LOG
                                            <ChevronRight className="w-4 h-4 ml-1" />
                                        </Button>
                                    </div>
                                </>
                            );
                        })()}
                    </div>
                )}
            </div>

            {/* Property Action Sheet */}
            {activeProperty && (
                <div className="fixed inset-0 z-[2000]">
                    <div className="absolute inset-0 bg-black/60" onClick={() => setActiveProperty(null)} />
                    <div className="absolute bottom-0 left-0 right-0 rounded-t-3xl p-6 pb-10 animate-in slide-in-from-bottom" style={{ background: BRAND.voidBlack, borderTop: `2px solid ${BRAND.gold}` }}>
                        <div className="flex justify-between items-start mb-4">
                            <div>
                                <p className="text-xs text-gray-400">PROPERTY</p>
                                <p className="font-bold text-white text-lg">{activeProperty.full_address || `${activeProperty.house_number} ${activeProperty.street_name}`}</p>
                                {activeProperty.city && <p className="text-sm text-gray-400">{activeProperty.city}, {activeProperty.state}</p>}
                            </div>
                            <button onClick={() => setActiveProperty(null)} className="p-2"><X className="w-5 h-5 text-gray-400" /></button>
                        </div>

                        <p className="text-xs font-bold text-gray-500 mb-3">LOG RESULT:</p>
                        <div className="grid grid-cols-2 gap-3">
                            <Button onClick={() => handleLogResult(activeProperty, 'SOLD')} className="h-14 font-bold text-base bg-green-600 hover:bg-green-500 text-white">
                                ✅ SOLD
                            </Button>
                            <Button onClick={() => handleLogResult(activeProperty, 'CALLBACK')} className="h-14 font-bold text-base bg-yellow-600 hover:bg-yellow-500 text-black">
                                📞 CALLBACK
                            </Button>
                            <Button onClick={() => handleLogResult(activeProperty, 'NO_ANSWER')} className="h-14 font-bold text-base bg-gray-600 hover:bg-gray-500 text-white">
                                🚪 NO ANSWER
                            </Button>
                            <Button onClick={() => handleLogResult(activeProperty, 'HARD_NO')} className="h-14 font-bold text-base bg-red-600 hover:bg-red-500 text-white">
                                ❌ NOT INTERESTED
                            </Button>
                        </div>

                        <Button onClick={() => openInMaps(activeProperty)} variant="outline" className="w-full mt-4 h-12 border-gray-600 text-gray-300">
                            <ExternalLink className="w-4 h-4 mr-2" /> Open in Maps
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}