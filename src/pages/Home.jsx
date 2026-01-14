import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { MapContainer, TileLayer, CircleMarker, Polyline, useMap, Circle } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

import { Slider } from "@/components/ui/slider";
import { Loader2, Navigation, Locate, List, ChevronRight, X, BarChart3, ArrowUpDown, Filter, MapPin, User, Shield } from 'lucide-react';
import { determineEffectiveStatus } from '../components/logic/territoryLogic';
import { generateOptimizedRoutes } from '../components/logic/routeOptimizer';
import RouteChecklist from '../components/routes/RouteChecklist';
import NearbyHotLeads from '../components/nearby/NearbyHotLeads';

// Brand Colors
const BRAND = {
    voidBlack: '#0A0A0A',
    gold: '#FFD700',
    charcoal: '#1F1F1F',
    offWhite: '#E5E5E5'
};

// Status colors: Gray = not visited, Green = sold, Red = couldn't sell
const STATUS_COLORS = {
    ELIGIBLE: '#6b7280',      // Gray - not visited
    SOLD: '#22c55e',          // Green - sold
    HARD_NO: '#ef4444',       // Red - couldn't sell
    CALLBACK: '#eab308',      // Yellow - callback
    NO_ANSWER: '#6b7280',     // Gray - not visited yet
    QUALIFIED: '#22c55e',     // Green - qualified/sold
    OTHER: '#6b7280'          // Gray - default
};

const ROUTE_COLORS = [BRAND.gold, '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#f97316', '#a855f7'];

function LocationMarker() {
    const [position, setPosition] = useState(null);
    const map = useMap();
    useEffect(() => {
        map.locate().on("locationfound", (e) => setPosition(e.latlng));
    }, [map]);
    return position ? (
        <Circle center={position} radius={15} pathOptions={{ fillColor: BRAND.gold, fillOpacity: 0.3, color: BRAND.gold, weight: 2 }} />
    ) : null;
}

function MapController({ fitBounds }) {
    const map = useMap();
    useEffect(() => {
        if (fitBounds?.length > 0) {
            try {
                const bounds = L.latLngBounds(fitBounds);
                if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 17 });
            } catch (e) {}
        }
    }, [fitBounds, map]);
    return null;
}

export default function Home() {
    const queryClient = useQueryClient();
    const [activeRoute, setActiveRoute] = useState(null);
    const [showChecklist, setShowChecklist] = useState(false);
    const [showRoutePanel, setShowRoutePanel] = useState(false);
    const [showCompare, setShowCompare] = useState(false);
    const [housesPerRoute, setHousesPerRoute] = useState(50);
    const ROUTE_SIZE_OPTIONS = [25, 50, 75, 100];
    const [sortBy, setSortBy] = useState('score'); // score, houses, distance
    const [minScore, setMinScore] = useState(0);
    const [quickFilter, setQuickFilter] = useState('all'); // all, eligible, sold, rejected
    const [previewRoute, setPreviewRoute] = useState(null);
    const [startLocation, setStartLocation] = useState(null); // { lat, lng, address }
    const [startAddressInput, setStartAddressInput] = useState("");
    const [showAllProperties, setShowAllProperties] = useState(false);
    const mapRef = useRef(null);
    const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me() });

    // Fetch ALL 5000 properties (User Specific)
    const { data: properties = [], isLoading: propsLoading } = useQuery({
        queryKey: ['masterProperties', user?.email],
        queryFn: () => user ? base44.entities.MasterProperty.filter({ created_by: user.email }, '-created_date', 5000) : [],
        enabled: !!user
    });

    const { data: savedRoutes = [] } = useQuery({
        queryKey: ['savedRoutes', user?.email],
        queryFn: () => user ? base44.entities.SavedRoute.filter({ created_by: user.email }, '-created_date', 100) : [],
        enabled: !!user
    });

    const createRouteMutation = useMutation({
        mutationFn: (routeData) => base44.entities.SavedRoute.create(routeData),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['savedRoutes'] });
            alert("Route saved to My Routes!");
        }
    });

    const handleSaveRoute = (route) => {
        createRouteMutation.mutate({
            name: route.name,
            property_hashes: route.properties.map(p => p.address_hash),
            metrics: {
                distance: route.totalDistance,
                house_count: route.houseCount,
                score: route.competitivenessScore
            },
            status: 'ACTIVE',
            start_location: startLocation
        });
    };

    const { data: logs = [], isLoading: logsLoading } = useQuery({
        queryKey: ['interactionLogs', user?.email],
        queryFn: () => user ? base44.entities.InteractionLog.filter({ created_by: user.email }, '-created_date', 10000) : [],
        enabled: !!user
    });

    const createLogMutation = useMutation({
        mutationFn: (logData) => base44.entities.InteractionLog.create(logData),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['interactionLogs'] }),
    });

    // Process ALL properties
    const effectiveProperties = useMemo(() => {
        return properties
            .filter(p => p?.lat && p?.lng && !isNaN(p.lat) && !isNaN(p.lng))
            .map(p => {
                const propLogs = logs.filter(l => l.address_hash === p.address_hash);
                return {
                    ...p,
                    lat: parseFloat(p.lat),
                    lng: parseFloat(p.lng),
                    effective_status: determineEffectiveStatus(p, propLogs)
                };
            });
    }, [properties, logs]);

    // Hydrate Saved Routes for Map Display
    const hydratedSavedRoutes = useMemo(() => {
        return savedRoutes.map(route => {
            const routeProps = route.property_hashes
                .map(hash => effectiveProperties.find(p => p.address_hash === hash))
                .filter(Boolean);
            
            return {
                ...route,
                id: route.id,
                properties: routeProps,
                houseCount: route.metrics?.house_count || routeProps.length,
                totalDistance: route.metrics?.distance || 0,
                competitivenessScore: route.metrics?.score || 0,
                isSaved: true
            };
        }).filter(r => r.properties.length > 0);
    }, [savedRoutes, effectiveProperties]);

    // Handle Load Route from URL
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const savedRouteId = params.get('savedRoute');
        
        if (savedRouteId && savedRoutes.length > 0 && effectiveProperties.length > 0 && !activeRoute) {
            const saved = savedRoutes.find(r => r.id === savedRouteId);
            if (saved) {
                // Reconstruct route object
                const routeProps = saved.property_hashes
                    .map(hash => effectiveProperties.find(p => p.address_hash === hash))
                    .filter(Boolean);
                
                if (routeProps.length > 0) {
                    setActiveRoute({
                        id: saved.id,
                        name: saved.name,
                        properties: routeProps,
                        houseCount: saved.metrics?.house_count || routeProps.length,
                        totalDistance: saved.metrics?.distance || 0,
                        competitivenessScore: saved.metrics?.score || 0,
                        status: saved.status
                    });
                    // Clear param so we don't reload it if we navigate away and back without intent
                    window.history.replaceState({}, '', window.location.pathname);
                }
            }
        }
    }, [savedRoutes, effectiveProperties, activeRoute]);

    // Generate routes with configurable houses per route
    const [routes, setRoutes] = useState([]);
    const [routesGenerating, setRoutesGenerating] = useState(false);

    const [streetCooldownDays, setStreetCooldownDays] = useState(30);
    const [cooldownInfo, setCooldownInfo] = useState(null);

    const generateRoutes = useCallback(() => {
        if (effectiveProperties.length === 0) {
            setRoutes([]);
            return;
        }
        setRoutesGenerating(true);
        setTimeout(() => {
            try {
                // Use current map center as start location if not set
                const currentCenter = mapRef.current ? mapRef.current.getCenter() : null;
                const start = startLocation || (currentCenter ? { lat: currentCenter.lat, lng: currentCenter.lng } : null);
                
                // Pass logs for street cooldown filtering
                const generated = generateOptimizedRoutes(
                    effectiveProperties, 
                    housesPerRoute, 
                    start, 
                    logs, 
                    { streetCooldownDays, useStreetSweep: true }
                );
                
                // Extract cooldown info if available
                if (generated._cooldownInfo) {
                    setCooldownInfo(generated._cooldownInfo);
                }
                
                setRoutes(generated);
            } catch (e) {
                console.error(e);
            }
            setRoutesGenerating(false);
        }, 100);
    }, [effectiveProperties, housesPerRoute, startLocation, logs, streetCooldownDays]);

    // Filter and sort routes
    const filteredRoutes = useMemo(() => {
        let filtered = routes.filter(r => r.competitivenessScore >= minScore);
        if (sortBy === 'score') filtered.sort((a, b) => b.competitivenessScore - a.competitivenessScore);
        else if (sortBy === 'houses') filtered.sort((a, b) => b.houseCount - a.houseCount);
        else if (sortBy === 'distance') filtered.sort((a, b) => a.totalDistance - b.totalDistance);
        return filtered;
    }, [routes, sortBy, minScore]);

    const fitBounds = useMemo(() => {
        if (activeRoute?.properties?.length > 0) return activeRoute.properties.map(p => [p.lat, p.lng]);
        if (effectiveProperties.length > 0) return effectiveProperties.slice(0, 1000).map(p => [p.lat, p.lng]);
        return null;
    }, [activeRoute, effectiveProperties]);

    const center = effectiveProperties[0] ? [effectiveProperties[0].lat, effectiveProperties[0].lng] : [34.0522, -118.2437];

    const handleLogResult = useCallback((property, status, note = null) => {
        createLogMutation.mutate({
            address_hash: property.address_hash,
            raw_input_text: note || status,
            parsed_status: status,
            gps_proof_lat: property.lat,
            gps_proof_lng: property.lng
        });
    }, [createLogMutation]);

    const isLoading = propsLoading || logsLoading;

    if (isLoading) {
        return (
            <div className="h-full flex items-center justify-center" style={{ background: BRAND.voidBlack }}>
                <div className="text-center">
                    <Loader2 className="w-10 h-10 animate-spin mx-auto mb-3" style={{ color: BRAND.gold }} />
                    <p className="text-sm font-medium tracking-wide" style={{ color: BRAND.offWhite }}>LOADING TERRITORY</p>
                </div>
            </div>
        );
    }

    return (
        <div className="h-full relative" style={{ background: BRAND.voidBlack }}>
            {/* Map */}
            <MapContainer
                ref={mapRef}
                center={center}
                zoom={15}
                style={{ height: '100%', width: '100%' }}
                zoomControl={false}
                onMoveEnd={(e) => {
                    // Optional: Track center for dynamic start location
                }}
            >
                <TileLayer
                    url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                    attribution='&copy; CARTO'
                />
                <LocationMarker />
                <MapController fitBounds={fitBounds} />

                {/* Display Saved Routes (Clusters) - ALWAYS SHOW IF EXISTS & NO ACTIVE ROUTE */}
                {!activeRoute && hydratedSavedRoutes.length > 0 && hydratedSavedRoutes.map((route, rIdx) => {
                    const isAssignedToMe = route.assigned_to === user?.id || route.assigned_to_name === user?.email; // Approx check
                    const baseColor = isAssignedToMe ? BRAND.gold : (route.assigned_to ? '#3b82f6' : '#666');
                    
                    return (
                        <React.Fragment key={route.id}>
                            {/* Central Route Marker/Icon could go here, but for now just the dots */}
                            {route.properties.map(p => (
                                <CircleMarker
                                    key={`${route.id}-${p.address_hash}`}
                                    center={[p.lat, p.lng]}
                                    radius={4}
                                    eventHandlers={{
                                        click: (e) => {
                                            L.DomEvent.stopPropagation(e);
                                            setActiveRoute(route);
                                        }
                                    }}
                                    pathOptions={{
                                        fillColor: baseColor,
                                        fillOpacity: 0.6,
                                        color: baseColor,
                                        weight: 1
                                    }}
                                />
                            ))}
                        </React.Fragment>
                    );
                })}

                {/* Display Generated Routes (Clusters) - Only if no saved routes or explicitly generating */}
                {!activeRoute && hydratedSavedRoutes.length === 0 && routes.length > 0 && routes.map((route, rIdx) => {
                    const routeColor = ROUTE_COLORS[rIdx % ROUTE_COLORS.length];
                    return route.properties.map(p => (
                        <CircleMarker
                            key={`${route.id}-${p.address_hash}`}
                            center={[p.lat, p.lng]}
                            radius={6}
                            pathOptions={{
                                fillColor: routeColor,
                                fillOpacity: 0.7,
                                color: routeColor,
                                weight: 1
                            }}
                        />
                    ));
                })}

                {/* Display loose properties ONLY if toggled ON and no routes visible */}
                {!activeRoute && routes.length === 0 && hydratedSavedRoutes.length === 0 && showAllProperties && effectiveProperties
                    .filter(p => {
                        if (quickFilter === 'all') return true;
                        if (quickFilter === 'eligible') return p.effective_status === 'ELIGIBLE' || p.effective_status === 'NO_ANSWER';
                        if (quickFilter === 'sold') return p.effective_status === 'SOLD' || p.effective_status === 'QUALIFIED';
                        if (quickFilter === 'rejected') return p.effective_status === 'HARD_NO';
                        return true;
                    })
                    .map(p => (
                    <CircleMarker
                        key={p.address_hash}
                        center={[p.lat, p.lng]}
                        radius={5}
                        pathOptions={{
                            fillColor: STATUS_COLORS[p.effective_status] || STATUS_COLORS.OTHER,
                            fillOpacity: 0.9,
                            color: '#333',
                            weight: 1
                        }}
                    />
                ))}
                
                {/* Preview Route (hover/tap from list) */}
                {previewRoute && !activeRoute && (
                    <Polyline
                        positions={previewRoute.properties.map(p => [p.lat, p.lng])}
                        pathOptions={{ color: BRAND.gold, weight: 3, opacity: 0.6, dashArray: '5,10' }}
                    />
                )}

                {/* Active Route */}
                {activeRoute && (
                    <>
                        <Polyline
                            positions={activeRoute.properties.map(p => [p.lat, p.lng])}
                            pathOptions={{ color: BRAND.gold, weight: 4, opacity: 0.9 }}
                        />
                        {activeRoute.properties.map((p, idx) => (
                            <CircleMarker
                                key={p.address_hash}
                                center={[p.lat, p.lng]}
                                radius={idx === 0 ? 10 : 6}
                                pathOptions={{
                                    fillColor: idx === 0 ? BRAND.gold : STATUS_COLORS[p.effective_status],
                                    fillOpacity: 1,
                                    color: '#fff',
                                    weight: 2
                                }}
                            />
                        ))}
                    </>
                )}
            </MapContainer>

            {/* Top Stats Bar */}
            <div className="absolute top-4 left-4 right-4 z-[1000] flex flex-col gap-2 pointer-events-none">
                <div className="flex justify-between items-start">
                    <div className="pointer-events-auto flex gap-2">
                        <div className="rounded-lg px-4 py-2 border" style={{ background: `${BRAND.voidBlack}ee`, borderColor: BRAND.charcoal }}>
                            <div className="flex items-center gap-3">
                                <div className="w-2 h-2 rounded-full animate-pulse" style={{ background: BRAND.gold, boxShadow: `0 0 8px ${BRAND.gold}` }} />
                                <span className="text-sm font-bold tracking-wide" style={{ color: BRAND.offWhite }}>
                                    {effectiveProperties.length.toLocaleString()}
                                </span>
                            </div>
                        </div>
                        {activeRoute && (
                            <div className="rounded-lg px-4 py-2 flex items-center gap-2" style={{ background: BRAND.gold }}>
                                <Navigation className="w-4 h-4" style={{ color: BRAND.voidBlack }} />
                                <div>
                                    <span className="text-sm font-bold block leading-none" style={{ color: BRAND.voidBlack }}>{activeRoute.name}</span>
                                    {activeRoute.assigned_to_name && (
                                        <span className="text-[10px] font-bold opacity-75 block leading-none mt-0.5" style={{ color: BRAND.voidBlack }}>
                                            {activeRoute.assigned_to_name}
                                        </span>
                                    )}
                                </div>
                                <button onClick={() => setActiveRoute(null)} className="ml-1">
                                    <X className="w-4 h-4" style={{ color: BRAND.voidBlack }} />
                                </button>
                            </div>
                        )}
                    </div>
                    
                    <div className="pointer-events-auto">
                        <Button
                            onClick={() => setShowCompare(true)}
                            className="rounded-lg h-10 px-4 font-bold tracking-wide"
                            style={{ background: BRAND.charcoal, color: BRAND.gold, border: `1px solid ${BRAND.gold}40` }}
                        >
                            <BarChart3 className="w-4 h-4 mr-2" />
                            FILTER
                        </Button>
                    </div>
                </div>
                
                {/* Quick Filter Bar */}
                {!activeRoute && (
                    <div className="pointer-events-auto flex gap-2 justify-center">
                        {[
                            { id: 'all', label: 'ALL', color: BRAND.offWhite },
                            { id: 'eligible', label: 'NOT VISITED', color: '#6b7280' },
                            { id: 'sold', label: 'SOLD', color: '#22c55e' },
                            { id: 'rejected', label: 'REJECTED', color: '#ef4444' },
                        ].map(f => (
                            <button
                                key={f.id}
                                onClick={() => setQuickFilter(f.id)}
                                className="px-3 py-1.5 rounded-full text-[10px] font-bold tracking-wide transition-all flex items-center gap-1.5"
                                style={{ 
                                    background: quickFilter === f.id ? BRAND.gold : `${BRAND.voidBlack}dd`,
                                    color: quickFilter === f.id ? BRAND.voidBlack : BRAND.offWhite,
                                    border: `1px solid ${quickFilter === f.id ? BRAND.gold : '#333'}`
                                }}
                            >
                                <span className="w-2 h-2 rounded-full" style={{ background: f.color }} />
                                {f.label}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {/* Bottom Action Bar */}
            <div className="absolute bottom-6 left-4 right-4 z-[1000]">
                <div className="flex justify-center gap-3">
                    <Button
                        onClick={() => setShowRoutePanel(true)}
                        className="rounded-full px-6 h-14 font-bold tracking-wide shadow-2xl"
                        style={{ background: BRAND.gold, color: BRAND.voidBlack }}
                    >
                        <Navigation className="w-5 h-5 mr-2" />
                        ROUTES
                        {routesGenerating && <Loader2 className="w-4 h-4 ml-2 animate-spin" />}
                        {!routesGenerating && (hydratedSavedRoutes.length > 0 || routes.length > 0) && (
                            <Badge className="ml-2" style={{ background: BRAND.voidBlack, color: BRAND.gold }}>
                                {hydratedSavedRoutes.length > 0 ? hydratedSavedRoutes.length : routes.length}
                            </Badge>
                        )}
                    </Button>

                    {activeRoute && (
                        <Button
                            onClick={() => setShowChecklist(true)}
                            className="rounded-full px-6 h-14 font-bold tracking-wide shadow-2xl"
                            style={{ background: BRAND.charcoal, color: BRAND.gold, border: `2px solid ${BRAND.gold}` }}
                        >
                            <List className="w-5 h-5 mr-2" />
                            CHECKLIST
                            <ChevronRight className="w-4 h-4 ml-1" />
                        </Button>
                    )}

                    <Button
                        size="icon"
                        className="rounded-full w-14 h-14 shadow-2xl"
                        style={{ background: BRAND.charcoal, color: BRAND.gold, border: `1px solid ${BRAND.gold}40` }}
                    >
                        <Locate className="w-5 h-5" />
                    </Button>
                </div>
            </div>

            {/* Routes Panel - using Dialog-style overlay */}
            {showRoutePanel && (
                <div className="fixed inset-0 z-[2000]">
                    <div className="absolute inset-0 bg-black/60" onClick={() => setShowRoutePanel(false)} />
                    <div 
                        className="absolute bottom-0 left-0 right-0 h-[70vh] rounded-t-3xl overflow-hidden"
                        style={{ background: BRAND.voidBlack, borderTop: `1px solid ${BRAND.charcoal}` }}
                    >
                        <div className="p-5 border-b flex justify-between items-center" style={{ borderColor: BRAND.charcoal }}>
                            <div>
                                <h2 className="flex items-center gap-2 text-lg font-bold tracking-wide" style={{ color: BRAND.gold }}>
                                    <Navigation className="w-5 h-5" />
                                    {hydratedSavedRoutes.length > 0 ? 'ACTIVE CAMPAIGN ROUTES' : 'OPTIMIZED ROUTES'}
                                </h2>
                                <p className="text-xs mt-1" style={{ color: '#888' }}>
                                    {hydratedSavedRoutes.length > 0 
                                        ? `${hydratedSavedRoutes.length} saved routes loaded` 
                                        : `${filteredRoutes.length} routes from ${effectiveProperties.length} properties`
                                    }
                                </p>
                            </div>
                            <button onClick={() => setShowRoutePanel(false)} className="p-2">
                                <X className="w-5 h-5" style={{ color: BRAND.offWhite }} />
                            </button>
                        </div>

                        {/* Saved Routes List */}
                        {hydratedSavedRoutes.length > 0 && (
                            <div className="overflow-y-auto h-[calc(70vh-80px)] p-4 space-y-3">
                                {hydratedSavedRoutes.map((route) => {
                                    const isAssignedToMe = route.assigned_to === user?.id || route.assigned_to_name === user?.email;
                                    return (
                                        <button
                                            key={route.id}
                                            onClick={() => { setActiveRoute(route); setPreviewRoute(null); setShowRoutePanel(false); }}
                                            className="w-full p-4 rounded-xl border transition-all text-left"
                                            style={{ 
                                                background: activeRoute?.id === route.id ? `${BRAND.gold}20` : BRAND.charcoal,
                                                borderColor: isAssignedToMe ? BRAND.gold : (route.assigned_to ? '#3b82f6' : '#333')
                                            }}
                                        >
                                            <div className="flex items-center justify-between mb-2">
                                                <div>
                                                    <span className="font-bold block" style={{ color: BRAND.offWhite }}>{route.name}</span>
                                                    {route.assigned_to_name && (
                                                        <span className="text-[10px] font-bold flex items-center gap-1 mt-1" style={{ color: isAssignedToMe ? BRAND.gold : '#3b82f6' }}>
                                                            {isAssignedToMe ? <User className="w-3 h-3" /> : <Shield className="w-3 h-3" />}
                                                            {route.assigned_to_name}
                                                        </span>
                                                    )}
                                                </div>
                                                <Badge style={{ 
                                                    background: route.status === 'COMPLETED' ? '#22c55e' : 
                                                                route.status === 'IN_PROGRESS' ? '#3b82f6' : '#333',
                                                    color: '#fff'
                                                }}>
                                                    {route.status}
                                                </Badge>
                                            </div>
                                            <div className="flex gap-4 text-xs" style={{ color: '#888' }}>
                                                <span>{route.houseCount} houses</span>
                                                <span>{route.metrics?.score || 0} score</span>
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        )}

                        {/* Generated Routes List (Hidden if Saved Routes exist for simplicity, or we could toggle) */}
                        {hydratedSavedRoutes.length === 0 && (
                            <>
                        {/* Scoring Legend */}
                        <div className="px-5 py-2 text-[10px] space-y-1" style={{ color: '#888', background: '#151515' }}>
                            <p className="font-bold text-gray-400">SCORE CRITERIA (FRESHNESS FIRST):</p>
                            <ul className="list-disc pl-4 space-y-0.5">
                                <li><span style={{color: BRAND.gold}}>+200</span> Sold &lt; 7 days ago (Hot!)</li>
                                <li><span style={{color: BRAND.gold}}>+180-20</span> Sold 1-12 months ago</li>
                                <li><span style={{color: '#22c55e'}}>+20-40</span> High Value Property</li>
                                <li><span style={{color: '#fff'}}>+50</span> Eligible / <span style={{color: '#eab308'}}>+30</span> Callback</li>
                                <li>Street Sweep Mode: All houses per street</li>
                                <li><span style={{color: '#ef4444'}}>EXCLUDED:</span> Streets visited in last {streetCooldownDays} days (No Answer)</li>
                            </ul>
                            {cooldownInfo && cooldownInfo.streetsOnCooldown?.length > 0 && (
                                <div className="mt-2 pt-2 border-t border-[#333]">
                                    <p className="text-red-400 font-bold">
                                        {cooldownInfo.streetsOnCooldown.length} streets on cooldown ({cooldownInfo.propertiesExcluded} properties)
                                    </p>
                                </div>
                            )}
                        </div>
                        <div className="overflow-y-auto h-[calc(70vh-80px)] p-4 space-y-3">
                            {filteredRoutes.length === 0 ? (
                                <p className="text-center py-8" style={{ color: '#888' }}>No routes available</p>
                            ) : (
                                filteredRoutes.map((route) => (
                                    <button
                                        key={route.id}
                                        onClick={() => { setActiveRoute(route); setPreviewRoute(null); setShowRoutePanel(false); }}
                                        className="w-full p-4 rounded-xl border transition-all text-left"
                                        style={{ 
                                            background: activeRoute?.id === route.id ? `${BRAND.gold}20` : BRAND.charcoal,
                                            borderColor: activeRoute?.id === route.id ? BRAND.gold : '#333'
                                        }}
                                    >
                                        <div className="flex items-center justify-between mb-2">
                                            <span className="font-bold" style={{ color: BRAND.offWhite }}>{route.name}</span>
                                            <Badge style={{ 
                                                background: route.competitivenessScore >= 150 ? '#22c55e' : route.competitivenessScore >= 100 ? '#eab308' : '#666',
                                                color: '#000'
                                            }}>
                                                {route.competitivenessScore}
                                            </Badge>
                                        </div>
                                        <div className="flex gap-4 text-xs" style={{ color: '#888' }}>
                                        <span>{route.houseCount} houses</span>
                                        <span>{route.streetCount || '?'} streets</span>
                                        <span>{route.totalDistance} mi</span>
                                        </div>
                                        <Button 
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleSaveRoute(route);
                                        }}
                                        size="sm"
                                        className="mt-2 w-full h-8 text-[10px] bg-[#333] hover:bg-[#444] text-white"
                                        >
                                        SAVE TO MY ROUTES
                                        </Button>
                                        </button>
                                        ))
                                        )}
                                        </div>
                                        </>
                                        )}

                                    </div>
                                </div>
                            </div>
                        </div>
            )}

                                        {/* Filter Panel */}
            {showCompare && (
                <div className="fixed inset-0 z-[2000]">
                    <div className="absolute inset-0 bg-black/60" onClick={() => setShowCompare(false)} />
                    <div 
                        className="absolute top-0 right-0 bottom-0 w-full max-w-md overflow-hidden"
                        style={{ background: BRAND.voidBlack, borderLeft: `1px solid ${BRAND.charcoal}` }}
                    >
                        <div className="p-5 border-b flex justify-between items-center" style={{ borderColor: BRAND.charcoal }}>
                            <h2 className="flex items-center gap-2 font-bold tracking-wide" style={{ color: BRAND.gold }}>
                                <BarChart3 className="w-5 h-5" />
                                ROUTE FILTERS
                            </h2>
                            <button onClick={() => setShowCompare(false)} className="p-2">
                                <X className="w-5 h-5" style={{ color: BRAND.offWhite }} />
                            </button>
                        </div>
                        
                        <div className="p-5 space-y-6 overflow-y-auto h-[calc(100%-70px)]">
                            <div>
                                <label className="text-xs font-bold tracking-wide mb-3 block" style={{ color: BRAND.offWhite }}>
                                    STARTING LOCATION
                                </label>
                                <div className="flex gap-2">
                                    <input 
                                        type="text"
                                        placeholder="Enter start address..."
                                        value={startAddressInput}
                                        onChange={(e) => setStartAddressInput(e.target.value)}
                                        className="flex-1 px-3 py-2 rounded-lg text-sm bg-[#1F1F1F] text-white border border-[#333]"
                                    />
                                    <Button
                                        onClick={() => {
                                            // Mock geocoding for now or just store address
                                            // In real app, we'd geocode. Here we might just use map center if empty
                                            if (mapRef.current) {
                                                const c = mapRef.current.getCenter();
                                                setStartLocation({ lat: c.lat, lng: c.lng, address: startAddressInput || "Map Center" });
                                            }
                                        }}
                                        size="icon"
                                        className="bg-[#1F1F1F] hover:bg-[#333]"
                                    >
                                        <MapPin className="w-4 h-4" />
                                    </Button>
                                </div>
                                {startLocation && <p className="text-[10px] text-green-500 mt-1">✓ Set: {startLocation.address}</p>}
                            </div>

                            <div>
                                <label className="text-xs font-bold tracking-wide mb-3 block" style={{ color: BRAND.offWhite }}>
                                    HOUSES PER ROUTE
                                </label>
                                <div className="flex gap-2">
                                    {ROUTE_SIZE_OPTIONS.map(size => (
                                        <button
                                            key={size}
                                            onClick={() => setHousesPerRoute(size)}
                                            className="flex-1 py-3 rounded-lg text-sm font-bold tracking-wide transition-all"
                                            style={{ 
                                                background: housesPerRoute === size ? BRAND.gold : BRAND.charcoal,
                                                color: housesPerRoute === size ? BRAND.voidBlack : BRAND.offWhite
                                            }}
                                        >
                                            {size}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="flex gap-2">
                                <Button
                                    onClick={generateRoutes}
                                    disabled={routesGenerating}
                                    className="flex-1 h-12 font-bold tracking-wide"
                                    style={{ background: BRAND.gold, color: BRAND.voidBlack }}
                                >
                                    {routesGenerating ? (
                                        <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> GENERATING...</>
                                    ) : (
                                        <><Navigation className="w-4 h-4 mr-2" /> GENERATE</>
                                    )}
                                </Button>
                                <Button
                                    onClick={() => setShowAllProperties(!showAllProperties)}
                                    className="w-12 h-12"
                                    style={{ background: showAllProperties ? BRAND.gold : BRAND.charcoal, color: showAllProperties ? BRAND.voidBlack : BRAND.gold }}
                                >
                                    <List className="w-5 h-5" />
                                </Button>
                            </div>

                            <div>
                                <label className="text-xs font-bold tracking-wide mb-3 block" style={{ color: BRAND.offWhite }}>
                                    MIN SCORE: {minScore}
                                </label>
                                <Slider
                                    value={[minScore]}
                                    onValueChange={([v]) => setMinScore(v)}
                                    min={0}
                                    max={200}
                                    step={10}
                                    className="w-full"
                                />
                            </div>

                            <div>
                                <label className="text-xs font-bold tracking-wide mb-3 block" style={{ color: BRAND.offWhite }}>
                                    STREET COOLDOWN: {streetCooldownDays} DAYS
                                </label>
                                <p className="text-[10px] text-gray-500 mb-2">
                                    Skip streets with "No Answer" in the last X days
                                </p>
                                <Slider
                                    value={[streetCooldownDays]}
                                    onValueChange={([v]) => setStreetCooldownDays(v)}
                                    min={7}
                                    max={90}
                                    step={7}
                                    className="w-full"
                                />
                                <div className="flex justify-between text-[10px] text-gray-500 mt-1">
                                    <span>1 week</span>
                                    <span>1 month</span>
                                    <span>3 months</span>
                                </div>
                            </div>

                            <div>
                                <label className="text-xs font-bold tracking-wide mb-3 block" style={{ color: BRAND.offWhite }}>
                                    <Filter className="w-3 h-3 inline mr-1" /> SORT BY
                                </label>
                                <div className="flex gap-2">
                                    {[{ id: 'score', label: 'SCORE' }, { id: 'houses', label: 'HOUSES' }, { id: 'distance', label: 'DISTANCE' }].map(opt => (
                                        <button
                                            key={opt.id}
                                            onClick={() => setSortBy(opt.id)}
                                            className="px-3 py-2 rounded-lg text-xs font-bold tracking-wide transition-all"
                                            style={{ 
                                                background: sortBy === opt.id ? BRAND.gold : BRAND.charcoal,
                                                color: sortBy === opt.id ? BRAND.voidBlack : BRAND.offWhite
                                            }}
                                        >
                                            {opt.label}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="mt-6">
                                <h3 className="text-xs font-bold tracking-wide mb-3" style={{ color: BRAND.gold }}>
                                    TOP ROUTES ({filteredRoutes.length})
                                </h3>
                                <div className="space-y-2">
                                    {filteredRoutes.slice(0, 20).map((route, idx) => (
                                        <div 
                                            key={route.id}
                                            className="p-3 rounded-lg flex items-center justify-between cursor-pointer transition-all hover:opacity-80"
                                            style={{ background: BRAND.charcoal, borderLeft: `3px solid ${ROUTE_COLORS[idx % ROUTE_COLORS.length]}` }}
                                            onClick={() => { setActiveRoute(route); setShowCompare(false); }}
                                        >
                                            <div>
                                                <p className="font-bold text-sm" style={{ color: BRAND.offWhite }}>{route.name}</p>
                                                <p className="text-xs" style={{ color: '#888' }}>{route.houseCount} • {route.totalDistance}mi</p>
                                            </div>
                                            <div className="text-right">
                                                <p className="font-bold text-lg" style={{ color: BRAND.gold }}>{route.competitivenessScore}</p>
                                                <p className="text-xs" style={{ color: '#888' }}>score</p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Nearby Hot Leads Banner */}
                            <NearbyHotLeads 
                                properties={effectiveProperties} 
                                radiusMiles={1} 
                                maxLeads={5} 
                            />

                            {/* Route Checklist */}
                            {showChecklist && activeRoute && (
                <div className="fixed inset-0 z-[2000]">
                    <div className="absolute inset-0 bg-black/60" onClick={() => setShowChecklist(false)} />
                    <div 
                        className="absolute top-0 right-0 bottom-0 w-full max-w-lg overflow-hidden"
                        style={{ background: BRAND.voidBlack, borderLeft: `1px solid ${BRAND.charcoal}` }}
                    >
                        <RouteChecklist
                            route={activeRoute}
                            logs={logs}
                            onLogResult={handleLogResult}
                            onClose={() => setShowChecklist(false)}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}