import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { MapContainer, TileLayer, CircleMarker, Polyline, useMap, Circle, LayerGroup, FeatureGroup, Tooltip } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix leaflet marker icons
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { storage } from '@/lib/storage';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

import { Slider } from "@/components/ui/slider";
import { Loader2, Navigation, Locate, List, ChevronRight, X, BarChart3, Filter, MapPin, User, Shield, Layers, Flame, Home as HomeIcon, Calendar, DollarSign, Ruler, ArrowRight } from 'lucide-react';
import { determineEffectiveStatus } from '../components/logic/territoryLogic';
import { ScrollArea } from "@/components/ui/scroll-area";
import { format } from 'date-fns';
import { generateOptimizedRoutes } from '../components/logic/routeOptimizer';
import { generateHeatmapGrid, generateStateClusters, getHeatColor } from '../components/logic/heatmapLogic';
import RouteChecklist from '../components/routes/RouteChecklist';
import NearbyHotLeads from '../components/nearby/NearbyHotLeads';
import KnockTimeBanner from '../components/timing/KnockTimeBanner';
import { darkRoom, DarkRoomClient } from '@/components/logic/neonClient';

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
    HARD_NO: '#8B5CF6',       // Purple - couldn't sell
    CALLBACK: '#eab308',      // Yellow - callback
    NO_ANSWER: '#6b7280',     // Gray - not visited yet
    QUALIFIED: '#22c55e',     // Green - qualified/sold
    OTHER: '#6b7280'          // Gray - default
};

const ROUTE_COLORS = ['#FFD700', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#f97316', '#a855f7'];

function LocationMarker() {
    const [position, setPosition] = useState(null);
    const map = useMap();
    useEffect(() => {
        const handleLocationFound = (e) => setPosition(e.latlng);
        map.locate().on("locationfound", handleLocationFound);
        return () => {
            map.off("locationfound", handleLocationFound);
        };
    }, [map]);
    return position ? (
        <Circle center={position} radius={15} pathOptions={{ fillColor: BRAND.gold, fillOpacity: 0.3, color: BRAND.gold, weight: 2 }} />
    ) : null;
}

// Component to capture map instance for external control
function MapRefHandler({ mapRef }) {
    const map = useMap();
    useEffect(() => {
        if (mapRef) mapRef.current = map;
    }, [map, mapRef]);
    return null;
}

function MapController({ fitBounds, onZoomChange, onMoveEnd }) {
    const map = useMap();
    
    // Track zoom & move
    useEffect(() => {
        const handleZoom = () => onZoomChange(map.getZoom());
        const handleMove = () => onMoveEnd(map.getBounds());
        
        map.on('zoomend', handleZoom);
        map.on('moveend', handleMove);
        
        return () => {
            map.off('zoomend', handleZoom);
            map.off('moveend', handleMove);
        };
    }, [map, onZoomChange, onMoveEnd]);

    // Use a ref to prevent aggressive re-fitting on data updates
    const lastBoundsRef = useRef(null);

    useEffect(() => {
        if (fitBounds?.length > 0) {
            try {
                // Only fit bounds if they have significantly changed (e.g. new route selected)
                // or if it's the very first load
                const bounds = L.latLngBounds(fitBounds);
                const boundsKey = JSON.stringify(fitBounds.slice(0, 1)); // Simple check on first point to detect route switch

                if (bounds.isValid() && lastBoundsRef.current !== boundsKey) {
                    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 17 });
                    lastBoundsRef.current = boundsKey;
                }
            } catch (e) { }
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
    const [repFilter, setRepFilter] = useState('all');
    const [previewRoute, setPreviewRoute] = useState(null);
    const [startLocation, setStartLocation] = useState(null); // { lat, lng, address }
    const [startAddressInput, setStartAddressInput] = useState("");
    const [showAllProperties, setShowAllProperties] = useState(false);
    const [viewMode, setViewMode] = useState('pins'); // 'pins' or 'heatmap'
    const [showTimingPanel, setShowTimingPanel] = useState(false);
    const [selectedProperty, setSelectedProperty] = useState(null);
    const [zoomLevel, setZoomLevel] = useState(15);
    const [darkRoomProperties, setDarkRoomProperties] = useState([]);
    const [darkRoomClusters, setDarkRoomClusters] = useState([]);
    const [darkRoomCount, setDarkRoomCount] = useState(0);
    const [isLoadingDarkRoom, setIsLoadingDarkRoom] = useState(false);
    const [darkRoomEnabled, setDarkRoomEnabled] = useState(false);
    const mapRef = useRef(null);
    const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me() });

    // Dark Room Manager Component - only active when enabled
    const DarkRoomManager = () => {
        const map = useMap();

        useEffect(() => {
            if (!darkRoomEnabled) return;

            let debounceTimer = null;

            const fetchDarkRoomData = async () => {
                const bounds = map.getBounds();
                const zoom = map.getZoom();

                setIsLoadingDarkRoom(true);

                try {
                    const data = await darkRoom.fetchPropertiesInViewport(bounds, zoom);

                    // Separate clusters from individual properties
                    const clusters = data.filter(d => d.isCluster);
                    const properties = data.filter(d => !d.isCluster);

                    setDarkRoomClusters(clusters);
                    setDarkRoomProperties(properties);

                } catch (e) {
                    console.error("Failed to fetch Dark Room stream:", e);
                } finally {
                    setIsLoadingDarkRoom(false);
                }
            };

            const debouncedFetch = () => {
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(fetchDarkRoomData, 300);
            };

            map.on('moveend', debouncedFetch);
            map.on('zoomend', debouncedFetch);

            // Initial fetch
            fetchDarkRoomData();

            return () => {
                map.off('moveend', debouncedFetch);
                map.off('zoomend', debouncedFetch);
                if (debounceTimer) clearTimeout(debounceTimer);
            };
        }, [map, darkRoomEnabled]);

        return null;
    };

    // Connection check on mount
    useEffect(() => {
        darkRoom.testConnection().then(result => {
            if (result.connected) {
                setDarkRoomCount(result.totalProperties);
            }
        });
    }, []);

    // Fetch Properties - support both user-specific and fallback for mobile auth
    const { data: userProperties = [], isLoading: propsLoading } = useQuery({
        queryKey: ['masterProperties', user?.email],
        queryFn: async () => {
            if (!user?.email) return [];
            
            try {
                const result = await base44.entities.MasterProperty.filter({ created_by: user.email }, '-created_date', 1000);
                return Array.isArray(result) ? result : (result?.items || []);
            } catch (e) {
                console.log('[Home] Error fetching properties:', e);
                return [];
            }
        },
        enabled: !!user?.email
    });



    // Local Storage query (Offline support)
    const { data: localProperties = [] } = useQuery({
        queryKey: ['localProperties'],
        queryFn: async () => {
            const items = await storage.getProperties();
            console.log('[Home] Local properties count:', items.length);
            return items;
        }
    });

    // Combine all sources and deduplicate by address_hash
    const properties = useMemo(() => {
        // Merge Dark Room properties with User/Local properties
        // Dark Room properties are mapped to have similar structure
        const combined = [...userProperties, ...localProperties, ...darkRoomProperties];
        const seen = new Set();
        return combined.filter(p => {
            // Use id as fallback for address_hash if missing (Dark Room props might rely on ID)
            const id = p.address_hash || p.id;
            if (!id || seen.has(id)) return false;
            seen.add(id);
            return true;
        });
    }, [userProperties, localProperties, darkRoomProperties]);

    const { data: savedRoutesRaw = [] } = useQuery({
        queryKey: ['savedRoutes'],
        queryFn: () => base44.entities.SavedRoute.list('-created_date', 500)
    });
    const savedRoutes = Array.isArray(savedRoutesRaw) ? savedRoutesRaw : (savedRoutesRaw?.items || []);

    // Identify properties already assigned to saved routes
    const assignedHashes = useMemo(() => {
        const hashes = new Set();
        // Look at ALL saved routes to exclude assigned properties, regardless of filter
        savedRoutes.forEach(r => {
            if (r.property_hashes && Array.isArray(r.property_hashes)) {
                r.property_hashes.forEach(h => hashes.add(h));
            }
        });
        return hashes;
    }, [savedRoutes]);

    const createRouteMutation = useMutation({
        mutationFn: async (routeData) => {
            // Save locally first (Optimistic / Offline First)
            // We give it a temporary ID so it has a unique key
            const localRoute = { ...routeData, id: `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}` };
            await storage.saveRoute(localRoute);
            console.log('[Home] Saved route locally');

            // Try backend (might fail if offline/auth issue)
            try {
                return await base44.entities.SavedRoute.create(routeData);
            } catch (e) {
                console.warn('[Home] Failed to save route to backend, but saved locally:', e);
                return localRoute;
            }
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['savedRoutes'] });
            queryClient.invalidateQueries({ queryKey: ['localRoutes'] }); // Ensure local readers update
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

    const { data: logsRaw = [], isLoading: logsLoading } = useQuery({
        queryKey: ['interactionLogs', user?.email],
        queryFn: () => user ? base44.entities.InteractionLog.filter({ created_by: user.email }, '-created_date', 1000) : [],
        enabled: !!user
    });
    const logs = Array.isArray(logsRaw) ? logsRaw : (logsRaw?.items || []);

    const createLogMutation = useMutation({
        mutationFn: (logData) => base44.entities.InteractionLog.create(logData),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['interactionLogs'] }),
    });

    // Process ALL properties with territory filter
    const effectiveProperties = useMemo(() => {
        const propsArray = Array.isArray(properties) ? properties : (properties?.items || []);
        const territoryZips = user?.territory_zip_codes || [];
        
        return propsArray
            .filter(p => {
                if (!p?.lat || !p?.lng || isNaN(p.lat) || isNaN(p.lng)) return false;
                
                // Apply territory filter if user has zip codes configured
                if (territoryZips.length > 0) {
                    const propZip = String(p.zip_code || '').trim().slice(0, 5);
                    if (!territoryZips.includes(propZip)) return false;
                }
                
                return true;
            })
            .map(p => {
                const propLogs = logs.filter(l => (p.address_hash && l.address_hash === p.address_hash));
                return {
                    ...p,
                    address_hash: p.address_hash || p.id,
                    lat: parseFloat(p.lat),
                    lng: parseFloat(p.lng),
                    effective_status: p.is_dark_room ? (p.effective_status || 'ELIGIBLE') : determineEffectiveStatus(p, propLogs)
                };
            });
    }, [properties, logs, user?.territory_zip_codes]);

    // Filter out properties that are already in saved routes for generation
    const availableProperties = useMemo(() => {
        return effectiveProperties.filter(p => !assignedHashes.has(p.address_hash));
    }, [effectiveProperties, assignedHashes]);

    // Hydrate Saved Routes for Map Display
    const hydratedSavedRoutes = useMemo(() => {
        return savedRoutes
            .filter(r => repFilter === 'all' || (r.assigned_to_name && r.assigned_to_name.includes(repFilter)))
            .map(route => {
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
        }).filter(r => r.properties.length > 0)
        .sort((a, b) => (b.competitivenessScore || 0) - (a.competitivenessScore || 0));
    }, [savedRoutes, effectiveProperties, repFilter]);

    // Extract unique reps from saved routes for filter
    const uniqueReps = useMemo(() => {
        const reps = new Set(savedRoutes.map(r => r.assigned_to_name).filter(Boolean));
        return Array.from(reps);
    }, [savedRoutes]);

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

    // Heatmap Data (High Zoom)
    const heatmapData = useMemo(() => {
        if (viewMode !== 'heatmap' || zoomLevel < 10) return [];
        return generateHeatmapGrid(effectiveProperties);
    }, [effectiveProperties, viewMode, zoomLevel]);

    // State Cluster Data (Low Zoom)
    const stateClusters = useMemo(() => {
        // Show state clusters if zoomed out, regardless of view mode (unless active route)
        if (activeRoute || zoomLevel >= 10) return [];
        return generateStateClusters(effectiveProperties);
    }, [effectiveProperties, zoomLevel, activeRoute]);

    const generateRoutes = useCallback(() => {
        if (availableProperties.length === 0) {
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
                // IMPORTANT: Use availableProperties (excluding saved routes)
                const generated = generateOptimizedRoutes(
                    availableProperties,
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
    }, [availableProperties, housesPerRoute, startLocation, logs, streetCooldownDays]);

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
        if (availableProperties.length > 0) return availableProperties.slice(0, 1000).map(p => [p.lat, p.lng]);
        if (effectiveProperties.length > 0) return effectiveProperties.slice(0, 1000).map(p => [p.lat, p.lng]);
        return null;
    }, [activeRoute, availableProperties, effectiveProperties]);

    const center = availableProperties[0] ? [availableProperties[0].lat, availableProperties[0].lng] : 
                  (effectiveProperties[0] ? [effectiveProperties[0].lat, effectiveProperties[0].lng] : [34.0522, -118.2437]);

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
                center={center}
                zoom={15}
                style={{ height: '100%', width: '100%' }}
                zoomControl={false}
            >
                <MapRefHandler mapRef={mapRef} />
                <TileLayer
                    url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                    attribution='&copy; CARTO'
                />
                <LocationMarker />
                <DarkRoomManager />
                <MapController 
                    fitBounds={fitBounds} 
                    onZoomChange={setZoomLevel} 
                    onMoveEnd={() => {}}
                />



                {/* Display Saved Routes */}
                <LayerGroup>
                    {!activeRoute && zoomLevel >= 8 && hydratedSavedRoutes.map((route) => {
                        const isAssignedToMe = route.assigned_to === user?.id || route.assigned_to_name === user?.email; 
                        const baseColor = isAssignedToMe ? BRAND.gold : (route.assigned_to ? '#3b82f6' : '#666');

                        return route.properties.map((p, idx) => (
                            <CircleMarker
                                key={`saved-${route.id}-${p.address_hash || 'no-hash'}-${idx}`}
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
                        ));
                    })}
                </LayerGroup>

                {/* Display Generated Routes */}
                <LayerGroup>
                    {!activeRoute && routes.length > 0 && routes.map((route, rIdx) => {
                        const routeColor = ROUTE_COLORS[rIdx % ROUTE_COLORS.length];
                        return route.properties.map((p, idx) => (
                            <CircleMarker
                                key={`generated-${route.id}-${p.address_hash || 'no-hash'}-${idx}`}
                                center={[p.lat, p.lng]}
                                radius={6}
                                eventHandlers={{
                                    click: (e) => {
                                        L.DomEvent.stopPropagation(e);
                                        setActiveRoute(route);
                                    }
                                }}
                                pathOptions={{
                                    fillColor: routeColor,
                                    fillOpacity: 0.7,
                                    color: routeColor,
                                    weight: 1
                                }}
                            />
                        ));
                    })}
                </LayerGroup>

                {/* HEATMAP LAYER (Only at Zoom >= 10) */}
                {viewMode === 'heatmap' && zoomLevel >= 10 && heatmapData.map(cell => (
                    <Circle
                        key={cell.id}
                        center={[cell.lat, cell.lng]}
                        radius={200} // ~200 meters
                        pathOptions={{
                            fillColor: getHeatColor(cell.avgScore),
                            fillOpacity: 0.5 + (cell.intensity * 0.3),
                            color: 'transparent',
                            weight: 0
                        }}
                    />
                ))}

                {/* DARK ROOM CLUSTER LAYER (Very Low Zoom Only) */}
                <LayerGroup>
                    {zoomLevel < 10 && darkRoomClusters.map(cluster => (
                        <CircleMarker
                            key={cluster.id}
                            center={[cluster.lat, cluster.lng]}
                            radius={Math.min(25, 8 + Math.sqrt(cluster.count) * 2)}
                            eventHandlers={{
                                click: () => {
                                    // Zoom in on cluster click
                                    if (mapRef.current) {
                                        mapRef.current.setView([cluster.lat, cluster.lng], Math.min(zoomLevel + 3, 16));
                                    }
                                }
                            }}
                            pathOptions={{
                                fillColor: DarkRoomClient.getScoreColor(cluster.avgScore),
                                fillOpacity: 0.7,
                                color: '#000',
                                weight: 2
                            }}
                        >
                            <Tooltip permanent direction="center" className="route-number-tooltip">
                                <span style={{ color: '#fff', fontWeight: 'bold', fontSize: '10px', textShadow: '0 0 3px #000' }}>
                                    {cluster.count}
                                </span>
                            </Tooltip>
                        </CircleMarker>
                    ))}
                </LayerGroup>

                {/* DARK ROOM INDIVIDUAL PINS (Zoom 10+) */}
                <LayerGroup>
                    {zoomLevel >= 10 && darkRoomProperties.map(p => (
                        <CircleMarker
                            key={p.id}
                            center={[p.lat, p.lng]}
                            radius={5}
                            eventHandlers={{
                                click: async (e) => {
                                    L.DomEvent.stopPropagation(e);
                                    // Lazy load full details
                                    const details = await darkRoom.fetchPropertyDetails(p.id);
                                    setSelectedProperty(details || p);
                                }
                            }}
                            pathOptions={{
                                fillColor: DarkRoomClient.getScoreColor(p.smart_score),
                                fillOpacity: 0.85,
                                color: '#000',
                                weight: 1
                            }}
                        />
                    ))}
                </LayerGroup>

                {/* USER PROPERTIES PIN LAYER */}
                <LayerGroup>
                    {viewMode === 'pins' && zoomLevel >= 13 && !activeRoute && routes.length === 0 && hydratedSavedRoutes.length === 0 && showAllProperties && effectiveProperties
                        .filter(p => !p.is_dark_room) // Exclude dark room from this layer
                        .filter(p => {
                            if (quickFilter === 'all') return true;
                            if (quickFilter === 'eligible') return p.effective_status === 'ELIGIBLE' || p.effective_status === 'NO_ANSWER';
                            if (quickFilter === 'sold') return p.effective_status === 'SOLD' || p.effective_status === 'QUALIFIED';
                            if (quickFilter === 'rejected') return p.effective_status === 'HARD_NO';
                            return true;
                        })
                        .map(p => (
                            <CircleMarker
                                key={p.address_hash || p.id}
                                center={[p.lat, p.lng]}
                                radius={6}
                                eventHandlers={{
                                    click: (e) => {
                                        L.DomEvent.stopPropagation(e);
                                        setSelectedProperty(p);
                                    }
                                }}
                                pathOptions={{
                                    fillColor: STATUS_COLORS[p.effective_status] || STATUS_COLORS.OTHER,
                                    fillOpacity: 0.9,
                                    color: '#333',
                                    weight: 1
                                }}
                            />
                        ))}
                </LayerGroup>

                {/* Preview Route (hover/tap from list) */}
                {previewRoute && !activeRoute && (
                    <Polyline
                        positions={previewRoute.properties.map(p => [p.lat, p.lng])}
                        pathOptions={{ color: BRAND.gold, weight: 3, opacity: 0.6, dashArray: '5,10' }}
                    />
                )}

                {/* Active Route - Simple numbered markers */}
                {activeRoute && (
                    <>
                        {activeRoute.properties.map((p, idx) => (
                            <CircleMarker
                                key={p.address_hash}
                                center={[p.lat, p.lng]}
                                radius={12}
                                eventHandlers={{
                                    click: (e) => {
                                        L.DomEvent.stopPropagation(e);
                                        setSelectedProperty(p);
                                    }
                                }}
                                pathOptions={{
                                    fillColor: idx === 0 ? BRAND.gold : '#333',
                                    fillOpacity: 1,
                                    color: BRAND.gold,
                                    weight: 2
                                }}
                            >
                                <Tooltip permanent direction="center" className="route-number-tooltip">
                                    <span style={{ 
                                        color: idx === 0 ? '#000' : BRAND.gold, 
                                        fontWeight: 'bold', 
                                        fontSize: '10px' 
                                    }}>
                                        {idx + 1}
                                    </span>
                                </Tooltip>
                            </CircleMarker>
                        ))}
                    </>
                )}
            </MapContainer>

            {/* Top Stats Bar */}
            <div className="absolute top-4 left-4 right-4 z-[1000] flex flex-col gap-2 pointer-events-none">
                <div className="flex items-start gap-2 overflow-hidden">
                    {/* Scrollable Stats Row */}
                    <div className="pointer-events-auto flex-1 overflow-x-auto no-scrollbar pb-1">
                        <div className="flex gap-2 whitespace-nowrap">
                            <div className="rounded-lg px-3 py-2 border shrink-0" style={{ background: `${BRAND.voidBlack}ee`, borderColor: BRAND.charcoal }}>
                                        <div className="flex items-center gap-2">
                                            <div className="w-2 h-2 rounded-full animate-pulse" style={{ background: BRAND.gold, boxShadow: `0 0 8px ${BRAND.gold}` }} />
                                            <span className="text-sm font-bold tracking-wide" style={{ color: BRAND.offWhite }}>
                                                {effectiveProperties.length.toLocaleString()}
                                            </span>
                                            {darkRoomCount > 0 && (
                                                <span className="text-[10px] text-gray-500">
                                                    + {(darkRoomCount / 1000).toFixed(0)}k Dark Room
                                                </span>
                                            )}
                                            {isLoadingDarkRoom && (
                                                <Loader2 className="w-3 h-3 animate-spin text-yellow-500" />
                                            )}
                                        </div>
                                    </div>
                            
                            <div className="shrink-0">
                                <KnockTimeBanner 
                                    expanded={showTimingPanel} 
                                    onToggle={() => setShowTimingPanel(!showTimingPanel)} 
                                />
                            </div>


                        </div>
                    </div>

                    <div className="pointer-events-auto shrink-0">
                        <Button
                            onClick={() => setShowCompare(true)}
                            size="icon"
                            className="rounded-lg h-10 w-10 font-bold tracking-wide shadow-lg"
                            style={{ background: BRAND.charcoal, color: BRAND.gold, border: `1px solid ${BRAND.gold}40` }}
                        >
                            <BarChart3 className="w-5 h-5" />
                        </Button>
                    </div>
                </div>

                {/* Active Route Persistent Banner */}
                {activeRoute && (
                    <div className="pointer-events-auto rounded-xl px-4 py-3 flex items-center justify-between shadow-2xl border border-yellow-600/50 animate-in slide-in-from-top-2 mx-1" style={{ background: BRAND.gold }}>
                        <div className="flex items-center gap-3 min-w-0">
                            <div className="w-10 h-10 rounded-full bg-black/10 flex items-center justify-center shrink-0">
                                <Navigation className="w-5 h-5" style={{ color: BRAND.voidBlack }} />
                            </div>
                            <div className="truncate">
                                <span className="text-sm font-bold block leading-tight truncate" style={{ color: BRAND.voidBlack }}>{activeRoute.name}</span>
                                <span className="text-[10px] font-bold opacity-75 block leading-none mt-1 truncate" style={{ color: BRAND.voidBlack }}>
                                    {activeRoute.assigned_to_name ? activeRoute.assigned_to_name : 'Active Route'}
                                </span>
                            </div>
                        </div>
                        <button 
                            onClick={() => setActiveRoute(null)} 
                            className="w-10 h-10 flex items-center justify-center bg-black/10 hover:bg-black/20 active:bg-black/30 rounded-full transition-colors ml-3 shrink-0"
                        >
                            <X className="w-6 h-6" style={{ color: BRAND.voidBlack }} />
                        </button>
                    </div>
                )}

                {/* Quick Filter Bar */}
                {!activeRoute && (
                    <div className="pointer-events-auto flex gap-2 justify-center flex-wrap">
                        {[
                            { id: 'all', label: 'ALL', color: BRAND.offWhite },
                            { id: 'eligible', label: 'NOT VISITED', color: '#6b7280' },
                            { id: 'sold', label: 'SOLD', color: '#22c55e' },
                            { id: 'rejected', label: 'UNDECIDED', color: '#8B5CF6' },
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
            <div className="absolute bottom-6 left-4 right-4 z-[1000] pointer-events-none">
                <div className="flex items-end gap-2">
                    <div className="flex-1 flex gap-2 overflow-x-auto no-scrollbar pb-1 pointer-events-auto">
                        <Button
                            onClick={() => setShowRoutePanel(true)}
                            className="rounded-full flex-1 px-4 h-12 sm:h-14 text-xs sm:text-sm font-bold tracking-wide shadow-[0_0_20px_rgba(255,215,0,0.3)] hover:shadow-[0_0_30px_rgba(255,215,0,0.5)] transition-all duration-300 transform active:scale-95 whitespace-nowrap min-w-[100px]"
                            style={{ background: 'linear-gradient(135deg, #FFD700 0%, #F59E0B 100%)', color: BRAND.voidBlack }}
                        >
                            <Navigation className="w-4 h-4 sm:w-5 sm:h-5 mr-2" />
                            ROUTES
                            {routesGenerating && <Loader2 className="w-3 h-3 ml-2 animate-spin" />}
                            {!routesGenerating && (hydratedSavedRoutes.length > 0 || routes.length > 0) && (
                                <Badge className="ml-2 h-5 min-w-[20px] px-1" style={{ background: BRAND.voidBlack, color: BRAND.gold }}>
                                    {hydratedSavedRoutes.length > 0 ? hydratedSavedRoutes.length : routes.length}
                                </Badge>
                            )}
                        </Button>

                        {activeRoute && (
                            <Button
                                onClick={() => setShowChecklist(true)}
                                className="rounded-full flex-1 px-4 h-12 sm:h-14 text-xs sm:text-sm font-bold tracking-wide shadow-2xl backdrop-blur-md transition-all duration-300 transform active:scale-95 whitespace-nowrap min-w-[100px]"
                                style={{ background: 'rgba(31, 31, 31, 0.8)', color: BRAND.gold, border: `1px solid ${BRAND.gold}` }}
                            >
                                <List className="w-4 h-4 sm:w-5 sm:h-5 mr-2" />
                                CHECKLIST
                                <ChevronRight className="w-3 h-3 ml-1" />
                            </Button>
                        )}
                    </div>

                    <div className="flex flex-col gap-2 shrink-0 pointer-events-auto">
                         <Button
                            onClick={() => setViewMode(viewMode === 'pins' ? 'heatmap' : 'pins')}
                            size="icon"
                            className="rounded-full w-14 h-14 shadow-2xl backdrop-blur-md transition-all duration-300"
                            style={{ 
                                background: viewMode === 'heatmap' ? BRAND.gold : 'rgba(31, 31, 31, 0.8)', 
                                color: viewMode === 'heatmap' ? BRAND.voidBlack : BRAND.gold, 
                                border: `1px solid ${BRAND.gold}40` 
                            }}
                        >
                            {viewMode === 'heatmap' ? <Flame className="w-6 h-6 animate-pulse" /> : <Layers className="w-6 h-6" />}
                        </Button>
                        <Button
                            onClick={() => {
                                if (mapRef.current) {
                                    mapRef.current.locate({ setView: true, maxZoom: 16 });
                                }
                            }}
                            size="icon"
                            className="rounded-full w-14 h-14 shadow-2xl backdrop-blur-md"
                            style={{ background: 'rgba(31, 31, 31, 0.8)', color: BRAND.gold, border: `1px solid ${BRAND.gold}40` }}
                        >
                            <Locate className="w-5 h-5" />
                        </Button>
                    </div>
                </div>
            </div>

            {/* Routes Panel - using Dialog-style overlay */}
            {showRoutePanel && (
                <div className="fixed inset-0 z-[2000]">
                    <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowRoutePanel(false)} />
                    <div
                        className="fixed bottom-0 left-0 right-0 h-[70vh] rounded-t-3xl overflow-hidden flex flex-col z-[3000] pb-safe backdrop-blur-xl shadow-2xl animate-in slide-in-from-bottom duration-300"
                        style={{ background: 'rgba(10, 10, 10, 0.9)', borderTop: '1px solid rgba(255, 255, 255, 0.1)', boxShadow: '0 -10px 40px rgba(0,0,0,0.5)' }}
                    >
                        <div className="p-5 border-b flex justify-between items-center" style={{ borderColor: BRAND.charcoal }}>
                            <div>
                                <h2 className="flex items-center gap-2 text-lg font-bold tracking-wide" style={{ color: BRAND.gold }}>
                                <Navigation className="w-5 h-5" />
                                ROUTES & CAMPAIGNS
                                </h2>
                                <p className="text-xs mt-1" style={{ color: '#888' }}>
                                    {filteredRoutes.length} New Opportunities • {hydratedSavedRoutes.length} Active
                                </p>
                                </div>
                                <button onClick={() => setShowRoutePanel(false)} className="p-2">
                                <X className="w-5 h-5" style={{ color: BRAND.offWhite }} />
                                </button>
                                </div>

                                {/* TABS / SECTIONS */}
                                <div className="flex-1 overflow-y-auto bg-[#0A0A0A] overscroll-contain pb-20">
                                {/* Generated Routes (Priority Display) */}
                                {routes.length > 0 && (
                                <div className="p-4 space-y-3">
                                    <div className="flex items-center gap-2 mb-2">
                                        <Badge className="bg-yellow-500 text-black font-bold">NEW</Badge>
                                        <span className="text-xs font-bold text-gray-400">OPTIMIZED ROUTES (UNASSIGNED)</span>
                                    </div>

                                    {/* Scoring Legend */}
                                    <div className="px-4 py-3 rounded-lg text-[10px] space-y-1 mb-4" style={{ color: '#888', background: '#151515', border: '1px solid #333' }}>
                                        <p className="font-bold text-gray-400 mb-1">SCORING CRITERIA:</p>
                                        <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                                            <div><span style={{ color: BRAND.gold }}>+200</span> Sold &lt; 7 days</div>
                                            <div><span style={{ color: BRAND.gold }}>+180</span> Sold &lt; 30 days</div>
                                            <div><span style={{ color: '#22c55e' }}>+40</span> High Value</div>
                                            <div><span style={{ color: '#ef4444' }}>Excl.</span> Cooldown ({streetCooldownDays}d)</div>
                                        </div>
                                    </div>

                                    {filteredRoutes.map((route) => (
                                        <button
                                            key={route.id}
                                            onClick={() => { setActiveRoute(route); setPreviewRoute(null); setShowRoutePanel(false); }}
                                            className="w-full p-4 rounded-xl border transition-all text-left group"
                                            style={{
                                                background: activeRoute?.id === route.id ? `${BRAND.gold}20` : BRAND.charcoal,
                                                borderColor: activeRoute?.id === route.id ? BRAND.gold : '#333'
                                            }}
                                        >
                                            <div className="flex items-center justify-between mb-2">
                                                <span className="font-bold group-hover:text-yellow-400 transition-colors" style={{ color: BRAND.offWhite }}>{route.name}</span>
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
                                                className="mt-3 w-full h-8 text-[10px] font-bold bg-[#333] hover:bg-yellow-500 hover:text-black text-white transition-all"
                                            >
                                                SAVE TO MY ROUTES
                                            </Button>
                                        </button>
                                    ))}
                                </div>
                                )}

                                {/* Saved Routes (Secondary Display) */}
                                {hydratedSavedRoutes.length > 0 && (
                                <div className="p-4 pt-0 space-y-3">
                                    <div className="flex items-center gap-2 mb-2 mt-4 pt-4 border-t border-[#333]">
                                        <Badge variant="outline" className="text-gray-400 border-gray-600">ACTIVE</Badge>
                                        <span className="text-xs font-bold text-gray-400">SAVED CAMPAIGNS</span>
                                    </div>
                                    {hydratedSavedRoutes.map((route) => {
                                        const isAssignedToMe = route.assigned_to === user?.id || route.assigned_to_name === user?.email;
                                        return (
                                            <button
                                                key={route.id}
                                                onClick={() => { setActiveRoute(route); setPreviewRoute(null); setShowRoutePanel(false); }}
                                                className="w-full p-4 rounded-xl border transition-all text-left opacity-75 hover:opacity-100"
                                                style={{
                                                    background: activeRoute?.id === route.id ? `${BRAND.gold}20` : '#151515',
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
                                </div>
                    </div>
                </div>
            )}

            {/* Filter Panel */}
            {showCompare && (
                <div className="fixed inset-0 z-[2000]">
                    <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowCompare(false)} />
                    <div
                        className="absolute top-0 right-0 bottom-0 w-full max-w-md overflow-hidden pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] backdrop-blur-xl shadow-2xl animate-in slide-in-from-right duration-300"
                        style={{ background: 'rgba(10, 10, 10, 0.95)', borderLeft: '1px solid rgba(255, 255, 255, 0.1)' }}
                    >
                        <div className="p-5 border-b flex justify-between items-center" style={{ borderColor: BRAND.charcoal }}>
                            <h2 className="flex items-center gap-2 font-bold tracking-wide" style={{ color: BRAND.gold }}>
                                <BarChart3 className="w-5 h-5" />
                                ROUTE FILTERS
                            </h2>
                            <button onClick={() => setShowCompare(false)} className="p-4 -mr-2 hover:bg-[#333] rounded-full transition-colors">
                                <X className="w-6 h-6" style={{ color: BRAND.offWhite }} />
                            </button>
                        </div>

                        <div className="p-5 space-y-6 overflow-y-auto h-[calc(100%-70px)]">
                            <div>
                                <label className="text-xs font-bold tracking-wide mb-3 block" style={{ color: BRAND.offWhite }}>
                                    FILTER BY REP
                                </label>
                                <select
                                    value={repFilter}
                                    onChange={(e) => setRepFilter(e.target.value)}
                                    className="w-full px-3 py-2 rounded-lg text-sm bg-[#1F1F1F] text-white border border-[#333]"
                                >
                                    <option value="all">All Reps</option>
                                    {uniqueReps.map(rep => (
                                        <option key={rep} value={rep}>{rep}</option>
                                    ))}
                                </select>
                            </div>

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
                    <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowChecklist(false)} />
                    <div
                        className="absolute top-0 right-0 bottom-0 w-full max-w-lg overflow-hidden shadow-2xl animate-in slide-in-from-right duration-300"
                        style={{ background: 'transparent' }}
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

            {/* Property Details Drawer */}
            {selectedProperty && (
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

                                {/* Map Link */}
                                <a 
                                    href={`https://maps.apple.com/?q=${selectedProperty.lat},${selectedProperty.lng}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="block w-full py-3 bg-gray-800 hover:bg-gray-700 rounded-xl text-center font-bold text-sm text-white transition-colors flex items-center justify-center gap-2"
                                >
                                    <Navigation className="w-4 h-4 text-yellow-500" />
                                    Open in Maps
                                </a>
                            </div>
                        </ScrollArea>
                    </div>
                </div>
            )}
            </div>
            );
            }