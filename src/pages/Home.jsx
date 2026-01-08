import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { MapContainer, TileLayer, CircleMarker, Polyline, useMap, Circle } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Loader2, Navigation, Locate, List, Play, ChevronRight, X, Check, Phone, Ban, Home, Clock } from 'lucide-react';
import { determineEffectiveStatus } from '../components/logic/territoryLogic';
import { generateOptimizedRoutes } from '../components/logic/routeOptimizer';
import RouteChecklist from '../components/routes/RouteChecklist';

// Status colors for CircleMarkers (more performant than custom icons)
const STATUS_COLORS = {
    ELIGIBLE: '#22c55e',
    SOLD: '#ef4444',
    HARD_NO: '#ef4444',
    CALLBACK: '#eab308',
    NO_ANSWER: '#6b7280',
    QUALIFIED: '#3b82f6',
    OTHER: '#94a3b8'
};

// Route colors
const ROUTE_COLORS = ['#6366f1', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#f97316'];

function LocationMarker() {
    const [position, setPosition] = useState(null);
    const map = useMap();

    useEffect(() => {
        map.locate().on("locationfound", (e) => setPosition(e.latlng));
    }, [map]);

    return position ? (
        <Circle center={position} radius={15} pathOptions={{ fillColor: '#3b82f6', fillOpacity: 0.3, color: '#3b82f6', weight: 2 }} />
    ) : null;
}

function MapController({ center, fitBounds }) {
    const map = useMap();
    
    useEffect(() => {
        if (fitBounds && fitBounds.length > 0) {
            try {
                const bounds = L.latLngBounds(fitBounds);
                if (bounds.isValid()) {
                    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 17 });
                }
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
    const mapRef = useRef(null);

    // Fetch data with limits for performance
    const { data: properties = [], isLoading: propsLoading } = useQuery({
        queryKey: ['masterProperties'],
        queryFn: () => base44.entities.MasterProperty.list('-created_date', 3000),
    });

    const { data: logs = [], isLoading: logsLoading } = useQuery({
        queryKey: ['interactionLogs'],
        queryFn: () => base44.entities.InteractionLog.list('-created_date', 5000),
    });

    // Log mutation
    const createLogMutation = useMutation({
        mutationFn: (logData) => base44.entities.InteractionLog.create(logData),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['interactionLogs'] }),
    });

    // Memoize effective properties - LIMIT processing for performance
    const effectiveProperties = useMemo(() => {
        const limited = properties.slice(0, 2000);
        return limited
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

    // Generate routes - debounced
    const [routes, setRoutes] = useState([]);
    const [routesGenerating, setRoutesGenerating] = useState(false);

    useEffect(() => {
        if (effectiveProperties.length === 0) {
            setRoutes([]);
            return;
        }
        setRoutesGenerating(true);
        const timer = setTimeout(() => {
            try {
                const generated = generateOptimizedRoutes(effectiveProperties.slice(0, 1000), 40);
                setRoutes(generated.slice(0, 15));
            } catch (e) {
                console.error(e);
            }
            setRoutesGenerating(false);
        }, 300);
        return () => clearTimeout(timer);
    }, [effectiveProperties]);

    // Map bounds
    const fitBounds = useMemo(() => {
        if (activeRoute?.properties?.length > 0) {
            return activeRoute.properties.map(p => [p.lat, p.lng]);
        }
        if (effectiveProperties.length > 0) {
            return effectiveProperties.slice(0, 500).map(p => [p.lat, p.lng]);
        }
        return null;
    }, [activeRoute, effectiveProperties]);

    const center = effectiveProperties[0] 
        ? [effectiveProperties[0].lat, effectiveProperties[0].lng] 
        : [34.0522, -118.2437];

    const handleLogResult = useCallback((property, status) => {
        createLogMutation.mutate({
            address_hash: property.address_hash,
            raw_input_text: status,
            parsed_status: status,
            gps_proof_lat: property.lat,
            gps_proof_lng: property.lng
        });
    }, [createLogMutation]);

    const isLoading = propsLoading || logsLoading;

    if (isLoading) {
        return (
            <div className="h-full bg-slate-900 flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
            </div>
        );
    }

    return (
        <div className="h-full relative bg-slate-900">
            {/* Clean Fullscreen Map */}
            <MapContainer
                ref={mapRef}
                center={center}
                zoom={15}
                style={{ height: '100%', width: '100%' }}
                zoomControl={false}
                className="z-0"
            >
                <TileLayer
                    url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                    attribution='&copy; <a href="https://carto.com/">CARTO</a>'
                />
                <LocationMarker />
                <MapController center={center} fitBounds={fitBounds} />

                {/* Render markers - use CircleMarker for performance */}
                {!activeRoute && effectiveProperties.slice(0, 800).map(p => (
                    <CircleMarker
                        key={p.address_hash}
                        center={[p.lat, p.lng]}
                        radius={6}
                        pathOptions={{
                            fillColor: STATUS_COLORS[p.effective_status] || STATUS_COLORS.OTHER,
                            fillOpacity: 0.9,
                            color: '#fff',
                            weight: 1.5
                        }}
                    />
                ))}

                {/* Active Route */}
                {activeRoute && (
                    <>
                        <Polyline
                            positions={activeRoute.properties.map(p => [p.lat, p.lng])}
                            pathOptions={{ color: ROUTE_COLORS[0], weight: 4, opacity: 0.8 }}
                        />
                        {activeRoute.properties.map((p, idx) => (
                            <CircleMarker
                                key={p.address_hash}
                                center={[p.lat, p.lng]}
                                radius={idx === 0 ? 10 : 7}
                                pathOptions={{
                                    fillColor: STATUS_COLORS[p.effective_status] || ROUTE_COLORS[0],
                                    fillOpacity: 1,
                                    color: '#fff',
                                    weight: 2
                                }}
                            />
                        ))}
                    </>
                )}
            </MapContainer>

            {/* Minimal Top Bar */}
            <div className="absolute top-4 left-4 right-4 z-[1000] flex justify-between items-start pointer-events-none">
                <div className="pointer-events-auto flex gap-2">
                    <div className="bg-slate-900/90 backdrop-blur-sm rounded-lg px-3 py-2 border border-slate-700/50">
                        <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                            <span className="text-xs font-medium text-slate-300">{effectiveProperties.length}</span>
                        </div>
                    </div>
                    {activeRoute && (
                        <div className="bg-indigo-600/90 backdrop-blur-sm rounded-lg px-3 py-2 flex items-center gap-2">
                            <Navigation className="w-4 h-4 text-white" />
                            <span className="text-xs font-bold text-white">{activeRoute.name}</span>
                            <button onClick={() => setActiveRoute(null)} className="ml-1">
                                <X className="w-4 h-4 text-white/70 hover:text-white" />
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* Bottom Action Bar */}
            <div className="absolute bottom-6 left-4 right-4 z-[1000]">
                <div className="flex justify-center gap-3">
                    {/* Routes Button */}
                    <Button
                        onClick={() => setShowRoutePanel(true)}
                        className="bg-slate-900/90 hover:bg-slate-800 border border-slate-700 text-white rounded-full px-5 h-12 shadow-xl backdrop-blur-sm"
                    >
                        <Navigation className="w-5 h-5 mr-2" />
                        Routes
                        {routesGenerating && <Loader2 className="w-4 h-4 ml-2 animate-spin" />}
                        {!routesGenerating && routes.length > 0 && (
                            <Badge className="ml-2 bg-indigo-600 text-white">{routes.length}</Badge>
                        )}
                    </Button>

                    {/* Checklist Button - only when route active */}
                    {activeRoute && (
                        <Button
                            onClick={() => setShowChecklist(true)}
                            className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-full px-5 h-12 shadow-xl"
                        >
                            <List className="w-5 h-5 mr-2" />
                            Checklist
                            <ChevronRight className="w-4 h-4 ml-1" />
                        </Button>
                    )}

                    {/* GPS Button */}
                    <Button
                        size="icon"
                        className="bg-slate-900/90 hover:bg-slate-800 border border-slate-700 text-white rounded-full w-12 h-12 shadow-xl backdrop-blur-sm"
                    >
                        <Locate className="w-5 h-5" />
                    </Button>
                </div>
            </div>

            {/* Routes Panel */}
            <Sheet open={showRoutePanel} onOpenChange={setShowRoutePanel}>
                <SheetContent side="bottom" className="bg-slate-900 border-t-slate-700 h-[70vh] rounded-t-2xl">
                    <SheetHeader className="pb-4">
                        <SheetTitle className="text-white flex items-center gap-2">
                            <Navigation className="w-5 h-5 text-indigo-400" />
                            Optimized Routes
                        </SheetTitle>
                    </SheetHeader>
                    <div className="space-y-3 overflow-y-auto max-h-[calc(70vh-100px)] pb-6">
                        {routes.length === 0 ? (
                            <div className="text-center py-8 text-slate-500">
                                {routesGenerating ? 'Generating routes...' : 'No routes available'}
                            </div>
                        ) : (
                            routes.map((route, idx) => (
                                <button
                                    key={route.id}
                                    onClick={() => {
                                        setActiveRoute(route);
                                        setShowRoutePanel(false);
                                    }}
                                    className={`w-full p-4 rounded-xl border transition-all text-left ${
                                        activeRoute?.id === route.id
                                            ? 'bg-indigo-600/20 border-indigo-500'
                                            : 'bg-slate-800/50 border-slate-700 hover:border-slate-600'
                                    }`}
                                >
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="font-bold text-white">{route.name}</span>
                                        <Badge className={
                                            route.competitivenessScore >= 150 ? 'bg-green-600' :
                                            route.competitivenessScore >= 100 ? 'bg-yellow-600' : 'bg-slate-600'
                                        }>
                                            Score: {route.competitivenessScore}
                                        </Badge>
                                    </div>
                                    <div className="flex gap-4 text-xs text-slate-400">
                                        <span>{route.houseCount} houses</span>
                                        <span>{route.totalDistance} mi</span>
                                    </div>
                                </button>
                            ))
                        )}
                    </div>
                </SheetContent>
            </Sheet>

            {/* Route Checklist */}
            <Sheet open={showChecklist} onOpenChange={setShowChecklist}>
                <SheetContent side="right" className="bg-slate-900 border-l-slate-700 w-full sm:max-w-lg p-0">
                    {activeRoute && (
                        <RouteChecklist
                            route={activeRoute}
                            logs={logs}
                            onLogResult={handleLogResult}
                            onClose={() => setShowChecklist(false)}
                        />
                    )}
                </SheetContent>
            </Sheet>
        </div>
    );
}