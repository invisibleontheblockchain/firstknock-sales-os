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
import { Loader2, Navigation, Locate, List, ChevronRight, X, BarChart3, Filter, MapPin, User, Shield, Layers, Flame, Home as HomeIcon, Calendar, DollarSign, Ruler, ArrowRight, RefreshCw } from 'lucide-react';
import { toast } from "sonner";
import { determineEffectiveStatus } from '../components/logic/territoryLogic';
import { ScrollArea } from "@/components/ui/scroll-area";
import { format, subMonths, isAfter, parseISO } from 'date-fns';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { generateOptimizedRoutes } from '../components/logic/routeOptimizer';
import { generateHeatmapGrid, generateStateClusters, getHeatColor } from '../components/logic/heatmapLogic';
import RouteChecklist from '../components/routes/RouteChecklist';
import RouteCommandPanel from '../components/routes/RouteCommandPanel';
import NearbyHotLeads from '../components/nearby/NearbyHotLeads';
import KnockTimeBanner from '../components/timing/KnockTimeBanner';
import { darkRoom, DarkRoomClient } from '@/components/logic/neonClient';
import CommandCenterDashboard from '../components/dashboard/CommandCenterDashboard';
import MapSettingsPanel from '../components/map/MapSettingsPanel';
import RouteBuilderSettings from '../components/map/RouteBuilderSettings';
import TerritorySetupWizard from '../components/manager/TerritorySetupWizard';
import { LayoutDashboard, Settings, Crosshair } from 'lucide-react';
import { openInMaps } from '../components/logic/navigation';
import GpsTracker, { GpsMapLayer, GpsHud } from '../components/map/GpsTracker';
import QuickMarkButtons from '../components/rep/QuickMarkButtons';
import PropertyHistory from '../components/rep/PropertyHistory';

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
        if (!map) return;
        
        const handleZoom = () => {
            try {
                if (map && map.getZoom) onZoomChange(map.getZoom());
            } catch (e) { /* Map destroyed */ }
        };
        const handleMove = () => {
            try {
                if (map && map.getBounds) onMoveEnd(map.getBounds());
            } catch (e) { /* Map destroyed */ }
        };
        
        map.on('zoomend', handleZoom);
        map.on('moveend', handleMove);
        
        return () => {
            try {
                map.off('zoomend', handleZoom);
                map.off('moveend', handleMove);
            } catch (e) { /* Map already destroyed */ }
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

// GPS Tracker wrapper that renders inside MapContainer
function GpsTrackerMapLayers({ properties, isTracking, onSelectProperty }) {
    const [position, setPosition] = React.useState(null);
    const [accuracy, setAccuracy] = React.useState(50);
    const map = useMap();

    React.useEffect(() => {
        if (!isTracking) { setPosition(null); return; }
        let watchId = null;
        if (navigator.geolocation) {
            watchId = navigator.geolocation.watchPosition(
                (pos) => {
                    const newPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                    setPosition(newPos);
                    setAccuracy(pos.coords.accuracy || 50);
                },
                (err) => console.warn('GPS error:', err),
                { enableHighAccuracy: true, timeout: 10000, maximumAge: 2000 }
            );
        }
        return () => { if (watchId !== null) navigator.geolocation.clearWatch(watchId); };
    }, [isTracking]);

    const nearbyProps = React.useMemo(() => {
        if (!position || !properties?.length) return [];
        const haversine = (lat1, lng1, lat2, lng2) => {
            const R = 3959;
            const dLat = (lat2 - lat1) * Math.PI / 180;
            const dLng = (lng2 - lng1) * Math.PI / 180;
            const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
            return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        };
        return properties
            .map(p => ({ ...p, _dist: haversine(position.lat, position.lng, p.lat, p.lng) }))
            .filter(p => p._dist <= 0.1)
            .sort((a, b) => a._dist - b._dist)
            .slice(0, 10);
    }, [position, properties]);

    if (!isTracking || !position) return null;

    return (
        <>
            <Circle center={[position.lat, position.lng]} radius={accuracy}
                pathOptions={{ fillColor: BRAND.gold, fillOpacity: 0.08, color: BRAND.gold, weight: 1, dashArray: '4,4' }} />
            <CircleMarker center={[position.lat, position.lng]} radius={8}
                pathOptions={{ fillColor: BRAND.gold, fillOpacity: 1, color: '#000', weight: 3 }}>
                <Tooltip permanent direction="top" className="route-number-tooltip">
                    <span style={{ color: BRAND.gold, fontWeight: '900', fontSize: '9px', textShadow: '0 0 4px #000' }}>YOU</span>
                </Tooltip>
            </CircleMarker>
            {nearbyProps.slice(0, 3).map((p, i) => (
                <Polyline key={`gps-line-${i}`} positions={[[position.lat, position.lng], [p.lat, p.lng]]}
                    pathOptions={{ color: BRAND.gold, weight: 1, opacity: 0.3, dashArray: '3,6' }} />
            ))}
            {nearbyProps.map((p, i) => (
                <CircleMarker key={`nearby-hl-${i}`} center={[p.lat, p.lng]} radius={9}
                    pathOptions={{ fillColor: STATUS_COLORS[p.effective_status] || '#6b7280', fillOpacity: 0.95, color: BRAND.gold, weight: 2 }}
                    eventHandlers={{ click: () => onSelectProperty(p) }}>
                    <Tooltip direction="right" className="route-number-tooltip">
                        <span style={{ color: '#fff', fontSize: '9px', fontWeight: 'bold', textShadow: '0 0 3px #000' }}>
                            {p.house_number} {p.street_name?.split(' ').slice(0, 2).join(' ')}
                        </span>
                    </Tooltip>
                </CircleMarker>
            ))}
        </>
    );
}

// GPS HUD overlay outside MapContainer
function GpsTrackerHud({ properties, isTracking, onToggleTracking, onSelectProperty }) {
    const [position, setPosition] = React.useState(null);
    const [expanded, setExpanded] = React.useState(true);

    React.useEffect(() => {
        if (!isTracking) { setPosition(null); return; }
        let watchId = null;
        if (navigator.geolocation) {
            watchId = navigator.geolocation.watchPosition(
                (pos) => setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
                () => {},
                { enableHighAccuracy: true, timeout: 10000, maximumAge: 2000 }
            );
        }
        return () => { if (watchId !== null) navigator.geolocation.clearWatch(watchId); };
    }, [isTracking]);

    const nearbyProps = React.useMemo(() => {
        if (!position || !properties?.length) return [];
        const haversine = (lat1, lng1, lat2, lng2) => {
            const R = 3959;
            const dLat = (lat2 - lat1) * Math.PI / 180;
            const dLng = (lng2 - lng1) * Math.PI / 180;
            const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
            return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        };
        return properties
            .map(p => ({ ...p, _dist: haversine(position.lat, position.lng, p.lat, p.lng), _distFt: Math.round(haversine(position.lat, position.lng, p.lat, p.lng) * 5280) }))
            .filter(p => p._dist <= 0.1)
            .sort((a, b) => a._dist - b._dist)
            .slice(0, 8);
    }, [position, properties]);

    if (!isTracking || !position) return null;

    return (
        <div className="absolute bottom-24 left-4 right-4 z-[1100] pointer-events-none">
            <div className="pointer-events-auto bg-black/90 backdrop-blur-xl border border-yellow-500/30 rounded-2xl shadow-[0_0_30px_rgba(255,215,0,0.15)] overflow-hidden">
                <button onClick={() => setExpanded(!expanded)} className="w-full flex items-center justify-between px-4 py-3 border-b border-gray-800">
                    <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                        <span className="text-xs font-bold text-yellow-500 tracking-wider">LIVE TRACKING</span>
                        <Badge variant="outline" className="text-[9px] h-4 border-gray-700 text-gray-400">{nearbyProps.length} NEARBY</Badge>
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={(e) => { e.stopPropagation(); onToggleTracking(); }}
                            className="text-[9px] font-bold text-red-400 hover:text-red-300 px-2 py-1 rounded bg-red-900/20">STOP</button>
                    </div>
                </button>
                {expanded && nearbyProps.length > 0 && (
                    <div className="max-h-[180px] overflow-y-auto">
                        {nearbyProps.map((p, i) => (
                            <button key={`hud-${p.address_hash}-${i}`} onClick={() => onSelectProperty(p)}
                                className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-800/50 transition-colors border-b border-gray-800/50 last:border-0">
                                <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold"
                                    style={{ background: STATUS_COLORS[p.effective_status] || '#333', color: '#fff' }}>{i + 1}</div>
                                <div className="flex-1 text-left min-w-0">
                                    <p className="text-xs font-bold text-white truncate">{p.house_number} {p.street_name}</p>
                                    <p className="text-[10px] text-gray-500">{p.effective_status} • {p._distFt}ft</p>
                                </div>
                                <Navigation className="w-3.5 h-3.5 text-yellow-500 shrink-0" />
                            </button>
                        ))}
                    </div>
                )}
                {expanded && nearbyProps.length === 0 && (
                    <div className="px-4 py-6 text-center"><p className="text-xs text-gray-500">No properties within 500ft</p></div>
                )}
            </div>
        </div>
    );
}

export default function Home() {
    const queryClient = useQueryClient();
    const [activeRoute, setActiveRoute] = useState(null);
    const [showChecklist, setShowChecklist] = useState(false);
    const [showRoutePanel, setShowRoutePanel] = useState(false);
    const [showCompare, setShowCompare] = useState(false);
    const [housesPerRoute, setHousesPerRoute] = useState(50);
    const [maxRouteDistance, setMaxRouteDistance] = useState(10); // Default 10 miles
    const ROUTE_SIZE_OPTIONS = [25, 50, 75, 100];
    const [sortBy, setSortBy] = useState('score'); // score, houses, distance
    const [minScore, setMinScore] = useState(0);
    const [quickFilter, setQuickFilter] = useState('all'); // all, eligible, sold, rejected
    const [repFilter, setRepFilter] = useState('all');
    const [previewRoute, setPreviewRoute] = useState(null);
    const [startLocation, setStartLocation] = useState(null); // { lat, lng, address }
    const [startAddressInput, setStartAddressInput] = useState("");
    const [zipCodeFilter, setZipCodeFilter] = useState(''); // Comma separated string
    const [analyzeZipFilter, setAnalyzeZipFilter] = useState('all'); // Filter for Analyze mode
    const [soldDateFilter, setSoldDateFilter] = useState(null); // null = All Time, number = months
    const [showAllProperties, setShowAllProperties] = useState(false);
    const [viewMode, setViewMode] = useState('pins'); // 'pins' or 'heatmap'
    const [mode, setMode] = useState('analyze'); // 'analyze' or 'generate'
    const [showDashboard, setShowDashboard] = useState(false);
    const [showTimingPanel, setShowTimingPanel] = useState(false);
    const [selectedProperty, setSelectedProperty] = useState(null);
    const [zoomLevel, setZoomLevel] = useState(15);
    const [mapTheme, setMapTheme] = useState('dark'); // 'dark' or 'light'
    const [showRouteDetails, setShowRouteDetails] = useState(true); // Toggle individual dots vs just rank/number
    const [showMapSettings, setShowMapSettings] = useState(false);
    const [navigationApp, setNavigationApp] = useState('apple');
    const [pinSize, setPinSize] = useState(5);
    const [showRouteLines, setShowRouteLines] = useState(false);
    const [darkRoomProperties, setDarkRoomProperties] = useState([]);
    const [darkRoomClusters, setDarkRoomClusters] = useState([]);
    const [darkRoomCount, setDarkRoomCount] = useState(0);
    const [isLoadingDarkRoom, setIsLoadingDarkRoom] = useState(false);
    const [darkRoomEnabled, setDarkRoomEnabled] = useState(false);
    const [fetchedProperties, setFetchedProperties] = useState([]); // Dynamic fetch storage
    const [templateName, setTemplateName] = useState("");
    const [gpsTracking, setGpsTracking] = useState(false);
    const [routeConfig, setRouteConfig] = useState({
        walkingPattern: 'street_sweep',
        minimizeTurns: true,
        use2Opt: true,
        returnToStart: false,
        excludeTerminal: true,
        includeCallbacks: true,
        propertyTypes: [],
        minPrice: null,
        maxPrice: null,
        minYearBuilt: null,
        maxYearBuilt: null,
    });
    const mapRef = useRef(null);
    const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me() });

    // Load navigation preference from user settings on load
    useEffect(() => {
        if (user?.navigation_app) {
            setNavigationApp(user.navigation_app);
        }
    }, [user]);

    // Update user preference when changed
    const updateNavigationApp = (app) => {
        setNavigationApp(app);
        base44.auth.updateMe({ navigation_app: app });
    };

    // Fetch Route Templates
    const { data: routeTemplates = [], refetch: refetchTemplates } = useQuery({
        queryKey: ['routeTemplates', user?.id],
        queryFn: () => user ? base44.entities.RouteTemplate.list('-created_date') : [],
        enabled: !!user
    });

    const saveTemplateMutation = useMutation({
        mutationFn: (data) => base44.entities.RouteTemplate.create(data),
        onSuccess: () => {
            refetchTemplates();
            toast.success("Template saved!");
            setTemplateName("");
        }
    });

    const loadTemplate = (template) => {
        if (!template.config) return;
        if (template.config.houses_per_route) setHousesPerRoute(template.config.houses_per_route);
        if (template.config.max_distance) setMaxRouteDistance(template.config.max_distance);
        if (template.config.min_score) setMinScore(template.config.min_score);
        if (template.config.street_cooldown_days) setStreetCooldownDays(template.config.street_cooldown_days);
        if (template.config.zip_code_filter) setZipCodeFilter(template.config.zip_code_filter);
        if (template.config.start_location) setStartLocation(template.config.start_location);
        
        toast.success(`Loaded template: ${template.name}`);
    };
    
    // Working Area Setup - Replaced by TerritorySetupWizard
    const [showSetupWizard, setShowSetupWizard] = useState(false);

    const handleWizardComplete = () => {
        setShowSetupWizard(false);
        // Refresh everything
        queryClient.invalidateQueries({ queryKey: ['savedRoutes'] });
        queryClient.invalidateQueries({ queryKey: ['user'] });
        queryClient.invalidateQueries({ queryKey: ['masterProperties'] });
        toast.success("Territory setup complete! Loading map...");
    };

    // Update Rep Color logic...
    // Fetch Team Members for Analysis & Coloring (Filtered by Manager)
    const { data: teamMembers = [] } = useQuery({
        queryKey: ['teamMembers', user?.id],
        queryFn: () => {
            if (!user?.id) return [];
            return base44.entities.TeamMember.filter({ manager_id: user.id }, '-created_date', 100)
                .then(res => Array.isArray(res) ? res : (res?.items || []));
        },
        enabled: !!user?.id
    });

    // Generate Rep Colors Map - Use stored colors from TeamMember entity
    const [localRepColors, setLocalRepColors] = useState({});
    
    const repColors = useMemo(() => {
        const colors = {};
        const PALETTE = ['#FFD700', '#ef4444', '#22c55e', '#3b82f6', '#ec4899', '#f97316', '#8b5cf6', '#06b6d4', '#eab308', '#14b8a6'];
        teamMembers.forEach((m, idx) => {
            // Priority: local override -> stored color -> palette fallback
            colors[m.id] = localRepColors[m.id] || m.color || PALETTE[idx % PALETTE.length];
        });
        return colors;
    }, [teamMembers, localRepColors]);

    // Update rep color in database
    const handleUpdateRepColor = async (memberId, color) => {
        // Optimistic local update
        setLocalRepColors(prev => ({ ...prev, [memberId]: color }));
        // Persist to database
        try {
            await base44.entities.TeamMember.update(memberId, { color });
            queryClient.invalidateQueries({ queryKey: ['teamMembers'] });
        } catch (e) {
            console.error('Failed to update rep color:', e);
        }
    };

    const handleAssignRoute = async (routeId, memberId) => {
        try {
            const member = teamMembers.find(m => m.id === memberId);
            const isSelf = memberId === user?.id;
            const assigneeName = isSelf ? (user?.full_name || 'Manager') : (member ? member.name : null);

            await base44.entities.SavedRoute.update(routeId, {
                assigned_to: memberId,
                assigned_to_name: assigneeName,
                status: 'ACTIVE'
            });
            queryClient.invalidateQueries({ queryKey: ['savedRoutes'] });
            toast.success(`Assigned to ${assigneeName || 'Unassigned'}`);
            
            // Update local state if active
            if (activeRoute && activeRoute.id === routeId) {
                setActiveRoute(prev => ({ ...prev, assigned_to: memberId, assigned_to_name: assigneeName }));
            }
        } catch (e) {
            console.error(e);
            toast.error("Assignment failed");
        }
    };

    // Dark Room Manager Component - only active when enabled
    const DarkRoomManager = () => {
        const map = useMap();

        useEffect(() => {
            if (!darkRoomEnabled || !map) return;

            let debounceTimer = null;

            const fetchDarkRoomData = async () => {
                try {
                    if (!map || !map.getBounds) return;
                    const bounds = map.getBounds();
                    const zoom = map.getZoom();

                    setIsLoadingDarkRoom(true);

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
                try {
                    map.off('moveend', debouncedFetch);
                    map.off('zoomend', debouncedFetch);
                } catch (e) { /* Map destroyed */ }
                if (debounceTimer) clearTimeout(debounceTimer);
            };
        }, [map, darkRoomEnabled]);

        return null;
    };

    // Connection check disabled by default - Dark Room is opt-in
    // useEffect(() => {
    //     darkRoom.testConnection().then(result => {
    //         if (result.connected) {
    //             setDarkRoomCount(result.totalProperties);
    //         }
    //     });
    // }, []);

    // Fetch Properties - support both user-specific and fallback for mobile auth
    const { data: userProperties = [], isLoading: propsLoading } = useQuery({
        queryKey: ['masterProperties', user?.email, user?.territory_zip_codes],
        queryFn: async () => {
            if (!user) return [];
            
            try {
                let items = [];
                // If user has configured territory zip codes, fetch properties for those zips
                // This ensures we get the data regardless of who created it (e.g. system import)
                if (user.territory_zip_codes && user.territory_zip_codes.length > 0) {
                    console.log(`[Home] Fetching properties for zips: ${user.territory_zip_codes.join(', ')}`);
                    const promises = user.territory_zip_codes.map(zip => 
                        base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 5000)
                    );
                    const results = await Promise.all(promises);
                    items = results.flatMap(r => Array.isArray(r) ? r : (r.items || []));
                } else {
                    // Fallback to properties created by the user if no territory is defined
                    const result = await base44.entities.MasterProperty.filter({ created_by: user.email }, '-created_date', 10000);
                    items = Array.isArray(result) ? result : (result?.items || []);
                }
                
                console.log(`[Home] Total fetched properties: ${items.length}`);
                return items;
            } catch (e) {
                console.log('[Home] Error fetching properties:', e);
                return [];
            }
        },
        enabled: !!user
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
        const combined = [...userProperties, ...localProperties, ...darkRoomProperties, ...fetchedProperties];
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
        queryKey: ['savedRoutes', user?.id],
        queryFn: () => {
            if (!user?.id) return [];
            return base44.entities.SavedRoute.filter({ manager_id: user.id }, '-created_date', 500);
        },
        enabled: !!user?.id
    });
    const savedRoutes = Array.isArray(savedRoutesRaw) ? savedRoutesRaw : (savedRoutesRaw?.items || []);

    // Effect for checking setup wizard status - Moved after savedRoutes declaration
    useEffect(() => {
        // Trigger wizard if manager hasn't set working area OR if they have no saved routes
        // This ensures they are walked through the process
        if (user && user.app_role === 'manager') {
            const hasRoutes = savedRoutes.length > 0;
            const hasArea = !!user.working_area;
            
            // If they have area but no routes, we still might want to prompt them, 
            // but let's be less aggressive if they have area. 
            // Main trigger: No Area.
            if (!hasArea) {
                setShowSetupWizard(true);
            }
        }
    }, [user, savedRoutes.length]);

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
            toast.success("Route saved successfully!", { duration: 2000 });
        }
    });

    const handleSaveRoute = (route, assignedRepId = null, assignedRepName = null) => {
        createRouteMutation.mutate({
            name: route.name,
            property_hashes: route.properties.map(p => p.address_hash),
            metrics: {
                distance: route.totalDistance,
                house_count: route.houseCount,
                score: route.competitivenessScore
            },
            status: 'ACTIVE',
            start_location: startLocation,
            assigned_to: assignedRepId,
            assigned_to_name: assignedRepName,
            manager_id: user.id
        });
    };

    const { data: logsRaw = [], isLoading: logsLoading } = useQuery({
        queryKey: ['interactionLogs', user?.email],
        // Manager sees ALL logs to track team progress
        queryFn: () => user ? base44.entities.InteractionLog.list('-created_date', 5000) : [],
        enabled: !!user
    });
    const logs = Array.isArray(logsRaw) ? logsRaw : (logsRaw?.items || []);

    // --- UBER-STYLE DISPATCH LOGIC ---
    // Helper: Haversine Distance (Miles)
    const calcDist = (lat1, lng1, lat2, lng2) => {
        if (!lat1 || !lng1 || !lat2 || !lng2) return 9999;
        const R = 3959; // Miles
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
                Math.sin(dLng/2) * Math.sin(dLng/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return R * c;
    };

    // Calculate Availability & Match Score
    const getRepRecommendations = useCallback((routeCenter) => {
        if (teamMembers.length === 0) return [];

        // 1. Identify "Busy" Reps (Have Active Route)
        // Using savedRoutes to determine if someone has an 'IN_PROGRESS' or 'ACTIVE' route recently assigned
        // For simplicity, we assume if they have > 0 active routes, they are "Busy" but can be queued
        const busyMap = {};
        savedRoutes.forEach(r => {
            if (r.status === 'IN_PROGRESS' || r.status === 'ACTIVE') {
                if (r.assigned_to) busyMap[r.assigned_to] = (busyMap[r.assigned_to] || 0) + 1;
            }
        });

        // 2. Determine Rep Location (Last Log)
        const repLocations = {};
        teamMembers.forEach(rep => {
            const repLogs = logs.filter(l => l.created_by === rep.email).sort((a,b) => new Date(b.created_date) - new Date(a.created_date));
            if (repLogs.length > 0) {
                repLocations[rep.id] = { lat: repLogs[0].gps_proof_lat, lng: repLogs[0].gps_proof_lng, lastActive: repLogs[0].created_date };
            }
        });

        return teamMembers.map(rep => {
            // A. Availability Score (30%)
            const activeRoutesCount = busyMap[rep.id] || 0;
            const isAvailable = activeRoutesCount === 0;
            const availabilityScore = isAvailable ? 100 : Math.max(0, 100 - (activeRoutesCount * 50));

            // B. Distance Score (30%)
            let distance = 9999;
            if (repLocations[rep.id] && routeCenter) {
                distance = calcDist(repLocations[rep.id].lat, repLocations[rep.id].lng, routeCenter.lat, routeCenter.lng);
            }
            // Score: < 2 miles = 100, > 20 miles = 0
            const distanceScore = Math.max(0, 100 - (distance * 5));

            // C. Performance Score (40%) - From Logs
            const repLogs = logs.filter(l => l.created_by === rep.email);
            const sales = repLogs.filter(l => ['SOLD', 'QUALIFIED'].includes(l.parsed_status)).length;
            const knocks = Math.max(repLogs.length, 1);
            const conversionRate = (sales / knocks) * 100; // 0-100 theoretically, likely 0-20
            const performanceScore = Math.min(conversionRate * 5, 100); // Scale up so 20% conv = 100 score

            // Total Weighted Match Score
            const totalScore = (availabilityScore * 0.3) + (distanceScore * 0.3) + (performanceScore * 0.4);

            return {
                ...rep,
                matchScore: Math.round(totalScore),
                distance: distance === 9999 ? null : distance.toFixed(1),
                isAvailable,
                performanceScore: Math.round(performanceScore),
                activeRoutesCount
            };
        }).sort((a, b) => b.matchScore - a.matchScore);
    }, [teamMembers, logs, savedRoutes]);

    const handleAutoAssignAll = async () => {
        if (!confirm("This will automatically assign the best available rep to each generated route based on location, availability, and performance. Continue?")) return;
        
        // Track assignments to load balance locally during loop
        const tempBusyCounts = {}; 
        
        for (const route of routes) {
            // Recalculate best match for this route considering new assignments
            const center = route.properties[0]; // Approx center
            const recommendations = getRepRecommendations(center);
            
            // Adjust scores based on temp assignments in this batch
            const bestRep = recommendations.map(r => {
                const addedLoad = tempBusyCounts[r.id] || 0;
                return { ...r, matchScore: r.matchScore - (addedLoad * 30) }; // Penalty for multiple assignments in one batch
            }).sort((a,b) => b.matchScore - a.matchScore)[0];

            if (bestRep) {
                // Trigger save
                handleSaveRoute(route, bestRep.id, bestRep.name);
                tempBusyCounts[bestRep.id] = (tempBusyCounts[bestRep.id] || 0) + 1;
            }
        }
        setShowRoutePanel(false);
    };

    const createLogMutation = useMutation({
        mutationFn: (logData) => base44.entities.InteractionLog.create(logData),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['interactionLogs'] });
            queryClient.invalidateQueries({ queryKey: ['selectedPropertyHistory'] });
        },
    });

    // Process ALL properties with territory filter
    const effectiveProperties = useMemo(() => {
        const propsArray = Array.isArray(properties) ? properties : (properties?.items || []);
        const territoryZips = user?.territory_zip_codes || [];
        
        return propsArray
            .filter(p => {
                if (!p?.lat || !p?.lng || isNaN(p.lat) || isNaN(p.lng)) return false;
                // Filter out Null Island (0,0) coordinates
                if (Math.abs(p.lat) < 0.0001 && Math.abs(p.lng) < 0.0001) return false;
                
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

    // Extract unique zips from properties for Analyze filter
    const uniqueZips = useMemo(() => {
        const zips = new Set(effectiveProperties.map(p => p.zip_code).filter(Boolean));
        return Array.from(zips).sort();
    }, [effectiveProperties]);

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

    const generateRoutes = useCallback(async () => {
        setRoutesGenerating(true);
        
        try {
            // 1. DYNAMIC DATA FETCHING (if zip code is set)
            let dynamicProps = [];
            if (zipCodeFilter && zipCodeFilter.trim()) {
                const targetZips = zipCodeFilter.split(',').map(z => z.trim()).filter(Boolean);
                
                // Check if we need to fetch (simple check: do we have enough data for these zips?)
                // We'll just fetch to be safe and merge.
                // Note: Parallel fetch for multiple zips
                const fetchPromises = targetZips.map(zip => 
                    base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 5000)
                        .then(res => Array.isArray(res) ? res : (res?.items || []))
                        .catch(err => {
                            console.warn(`Failed to fetch zip ${zip}`, err);
                            return [];
                        })
                );
                
                const results = await Promise.all(fetchPromises);
                let flattened = results.flat();

                // If no properties found, try to generate/import them via backend
                if (flattened.length === 0) {
                    console.log(`[Generate] No properties found for ${targetZips.join(', ')}. Attempting generation...`);
                    // Try one by one or parallel? Parallel.
                    const generatePromises = targetZips.map(zip => 
                        base44.functions.invoke('fetchZipProperties', { zip_code: zip })
                            .catch(err => {
                                console.warn(`Failed to generate zip ${zip}`, err);
                                return null;
                            })
                    );
                    
                    await Promise.all(generatePromises);
                    
                    // Re-fetch after generation
                    const retryResults = await Promise.all(fetchPromises);
                    flattened = retryResults.flat();
                }
                
                if (flattened.length > 0) {
                    console.log(`[Generate] Fetched ${flattened.length} properties from backend for zips: ${targetZips.join(', ')}`);
                    dynamicProps = flattened;
                    // Update state to show on map (will trigger re-render eventually, but we use local var for now)
                    setFetchedProperties(prev => {
                        // Dedup with existing fetched
                        const existingIds = new Set(prev.map(p => p.id));
                        const newUnique = flattened.filter(p => !existingIds.has(p.id));
                        return [...prev, ...newUnique];
                    });
                }
            }

            // 2. PREPARE DATA FOR ROUTING
            // Combine current available (memoized) with newly fetched dynamic props
            // Need to apply same processing (dedup, assigned filtering) to dynamicProps
            const assignedSet = assignedHashes; // closed over from render
            
            // Convert dynamicProps to effective format (add lat/lng parse if needed, though filter returns entities)
            const processedDynamic = dynamicProps.map(p => {
                const propLogs = logs.filter(l => (p.address_hash && l.address_hash === p.address_hash));
                return {
                    ...p,
                    address_hash: p.address_hash || p.id,
                    lat: parseFloat(p.lat),
                    lng: parseFloat(p.lng),
                    effective_status: determineEffectiveStatus(p, propLogs)
                };
            }).filter(p => 
                !assignedSet.has(p.address_hash) && 
                p.lat && p.lng && 
                !(Math.abs(p.lat) < 0.0001 && Math.abs(p.lng) < 0.0001)
            );

            // Merge with existing availableProperties, deduping by address_hash
            const combinedMap = new Map();
            availableProperties.forEach(p => combinedMap.set(p.address_hash, p));
            processedDynamic.forEach(p => combinedMap.set(p.address_hash, p));
            
            let workingSet = Array.from(combinedMap.values());

            // 3. FILTERING
            let targetZips = [];
            if (zipCodeFilter && zipCodeFilter.trim()) {
                targetZips = zipCodeFilter.split(',').map(z => z.trim()).filter(Boolean);
            } else if (user?.territory_zip_codes?.length > 0) {
                targetZips = user.territory_zip_codes;
            }

            if (targetZips.length > 0) {
                workingSet = workingSet.filter(p => {
                    const pZip = String(p.zip_code || '').trim().slice(0, 5);
                    return targetZips.includes(pZip);
                });
            }

            // Apply Sold Date Filter
            if (soldDateFilter !== null) {
                workingSet = workingSet.filter(p => {
                    if (!p.sold_date) return true;
                    try {
                        const date = parseISO(p.sold_date);
                        const cutoff = subMonths(new Date(), soldDateFilter);
                        return isAfter(date, cutoff);
                    } catch (e) { return true; }
                });
            }

            // Apply Property Type Filter
            if (routeConfig.propertyTypes.length > 0) {
                workingSet = workingSet.filter(p => {
                    if (!p.property_type) return true;
                    const pt = p.property_type.toLowerCase();
                    return routeConfig.propertyTypes.some(t => pt.includes(t.toLowerCase()));
                });
            }

            // Apply Price Range Filter
            if (routeConfig.minPrice) {
                workingSet = workingSet.filter(p => !p.price || p.price >= routeConfig.minPrice);
            }
            if (routeConfig.maxPrice) {
                workingSet = workingSet.filter(p => !p.price || p.price <= routeConfig.maxPrice);
            }

            // Apply Year Built Filter
            if (routeConfig.minYearBuilt) {
                workingSet = workingSet.filter(p => !p.year_built || p.year_built >= routeConfig.minYearBuilt);
            }
            if (routeConfig.maxYearBuilt) {
                workingSet = workingSet.filter(p => !p.year_built || p.year_built <= routeConfig.maxYearBuilt);
            }

            // Exclude terminal statuses (configurable)
            if (!routeConfig.excludeTerminal) {
                // Don't filter out SOLD/HARD_NO — the optimizer will still do it, but we pass them through
            }

            // Include/exclude callbacks
            if (!routeConfig.includeCallbacks) {
                workingSet = workingSet.filter(p => p.effective_status !== 'CALLBACK');
            }

            if (workingSet.length === 0) {
                alert("No properties found in the selected zip codes (checked local and database).");
                setRoutesGenerating(false);
                return;
            }

            // 4. UI UPDATES (Close Panel & Move Map)
            setShowCompare(false);
            
            if (mapRef.current && workingSet.length > 0) {
                const bounds = L.latLngBounds(workingSet.map(p => [p.lat, p.lng]));
                if (bounds.isValid()) {
                    mapRef.current.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
                }
            }

            // 5. GENERATE ROUTES
            // Use current map center as start location if not set
            const currentCenter = mapRef.current ? mapRef.current.getCenter() : null;
            const start = startLocation || (currentCenter ? { lat: currentCenter.lat, lng: currentCenter.lng } : null);

            const generated = generateOptimizedRoutes(
                workingSet,
                housesPerRoute,
                start,
                logs,
                { 
                    streetCooldownDays, 
                    useStreetSweep: routeConfig.walkingPattern === 'street_sweep',
                    minimizeTurns: routeConfig.minimizeTurns,
                    use2Opt: routeConfig.use2Opt,
                    maxRouteDistance: maxRouteDistance > 0 ? maxRouteDistance : null,
                    walkingPattern: routeConfig.walkingPattern,
                    returnToStart: routeConfig.returnToStart,
                }
            );

            if (generated._cooldownInfo) {
                setCooldownInfo(generated._cooldownInfo);
            }

            setRoutes(generated);
            setShowRoutePanel(true);

        } catch (e) {
            console.error("Route generation error:", e);
            alert("An error occurred while generating routes.");
        } finally {
            setRoutesGenerating(false);
        }
    }, [availableProperties, housesPerRoute, startLocation, logs, streetCooldownDays, zipCodeFilter, assignedHashes]);

    // Filter and sort routes
    const filteredRoutes = useMemo(() => {
        let filtered = routes.filter(r => r.competitivenessScore >= minScore);
        if (sortBy === 'score') filtered.sort((a, b) => b.competitivenessScore - a.competitivenessScore);
        else if (sortBy === 'houses') filtered.sort((a, b) => b.houseCount - a.houseCount);
        else if (sortBy === 'distance') filtered.sort((a, b) => a.totalDistance - b.totalDistance);
        return filtered;
    }, [routes, sortBy, minScore]);

    // Generation Stats for Command Center
    const genStats = useMemo(() => {
        if (routes.length === 0) return null;
        const totalHouses = routes.reduce((acc, r) => acc + r.houseCount, 0);
        const totalDist = routes.reduce((acc, r) => acc + r.totalDistance, 0).toFixed(1);
        const avgScore = Math.round(routes.reduce((acc, r) => acc + r.competitivenessScore, 0) / routes.length);

        // Identify "High Potential" (score > 100)
        const highPotentialCount = routes.filter(r => r.competitivenessScore >= 100).length;
        
        // Count excluded if available from generation metadata
        const excludedCount = routes._cooldownInfo ? routes._cooldownInfo.propertiesExcluded : 0;

        return { totalHouses, totalDist, avgScore, routeCount: routes.length, highPotentialCount, excludedCount };
    }, [routes]);

    const fitBounds = useMemo(() => {
        if (activeRoute?.properties?.length > 0) return activeRoute.properties.map(p => [p.lat, p.lng]);
        return null;
    }, [activeRoute]);

    // Initial Fit Effect
    const hasCenteredRef = useRef(false);
    useEffect(() => {
        if (availableProperties.length > 0 && !hasCenteredRef.current && mapRef.current) {
             const bounds = L.latLngBounds(availableProperties.slice(0, 1000).map(p => [p.lat, p.lng]));
             if (bounds.isValid()) {
                 mapRef.current.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
                 hasCenteredRef.current = true;
             }
        }
    }, [availableProperties]);

    // Determine Map Center
    const [mapCenter, setMapCenter] = useState([34.0522, -118.2437]); // Default LA

    useEffect(() => {
        const updateCenter = async () => {
            if (activeRoute?.properties?.length > 0) {
                 // Active route takes priority
                 return; 
            }
            
            if (availableProperties[0]) {
                setMapCenter([availableProperties[0].lat, availableProperties[0].lng]);
            } else if (user?.working_area) {
                // Geocode working area if needed (simplified: assume it's set or we just rely on properties)
                // If working_area is zip, we might need to fetch a coord. 
                // For now, let's try to search properties in that area first which usually sets availableProperties.
                
                // If we have no properties but have a working area zip, we might want to fetch/geocode it.
                // Using a fallback for now or the first property found.
            }
        };
        updateCenter();
    }, [activeRoute, availableProperties, user?.working_area]);

    const center = availableProperties[0] ? [availableProperties[0].lat, availableProperties[0].lng] : mapCenter;

    // Fetch full history for selected property (manager view)
    const { data: selectedPropertyLogs = [] } = useQuery({
        queryKey: ['selectedPropertyHistory', selectedProperty?.address_hash],
        queryFn: async () => {
            if (!selectedProperty?.address_hash) return [];
            const res = await base44.entities.InteractionLog.filter(
                { address_hash: selectedProperty.address_hash },
                '-created_date', 100
            );
            return Array.isArray(res) ? res : (res?.items || []);
        },
        enabled: !!selectedProperty?.address_hash
    });

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
                attributionControl={false}
            >
                <MapRefHandler mapRef={mapRef} />
                <TileLayer
                    url={
                        mapTheme === 'satellite' 
                            ? "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                            : mapTheme === 'hybrid'
                            ? "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                            : mapTheme === 'light' 
                            ? "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
                            : "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                    }
                    attribution={mapTheme === 'satellite' || mapTheme === 'hybrid' ? '&copy; Esri' : '&copy; CARTO'}
                />
                {mapTheme === 'hybrid' && (
                    <TileLayer
                        url="https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png"
                        attribution=""
                    />
                )}
                <LocationMarker />
                <DarkRoomManager />
                <MapController 
                    fitBounds={fitBounds} 
                    onZoomChange={setZoomLevel} 
                    onMoveEnd={() => {}}
                />

                {/* --- ANALYZE MODE: Existing Routes --- */}
                <LayerGroup>
                    {mode === 'analyze' && !activeRoute && zoomLevel >= 8 && hydratedSavedRoutes
                        .filter(route => {
                            if (analyzeZipFilter === 'all') return true;
                            // Check if route has any property in the selected zip
                            return route.properties.some(p => p.zip_code === analyzeZipFilter);
                        })
                        .map((route, routeIdx) => {
                        // If assigned, use Rep Color. If unassigned, use palette color to make it visible.
                        const repColor = route.assigned_to 
                            ? (repColors[route.assigned_to] || '#3b82f6') 
                            : ROUTE_COLORS[routeIdx % ROUTE_COLORS.length];
                            
                        const isUnassigned = !route.assigned_to;
                        const centerProp = route.properties[Math.floor(route.properties.length / 2)];

                        return (
                            <React.Fragment key={`saved-group-${route.id}`}>
                                {/* Rank/Label Marker at Center - VISIBLE IN ANALYZE MODE */}
                                {centerProp && (
                                    <CircleMarker
                                        center={[centerProp.lat, centerProp.lng]}
                                        radius={14}
                                        pathOptions={{ fillColor: 'black', fillOpacity: 0.7, color: repColor, weight: 2 }}
                                        eventHandlers={{ click: (e) => { L.DomEvent.stopPropagation(e); setActiveRoute(route); } }}
                                    >
                                        <Tooltip permanent direction="center" className="route-number-tooltip">
                                            <span style={{ color: repColor, fontWeight: '900', fontSize: '10px' }}>#{routeIdx + 1}</span>
                                        </Tooltip>
                                    </CircleMarker>
                                )}

                                {showRouteDetails && route.properties
                                    .filter(p => {
                                        if (quickFilter === 'all') return true;
                                        if (quickFilter === 'eligible') return p.effective_status === 'ELIGIBLE' || p.effective_status === 'NO_ANSWER';
                                        if (quickFilter === 'sold') return p.effective_status === 'SOLD' || p.effective_status === 'QUALIFIED';
                                        if (quickFilter === 'rejected') return p.effective_status === 'HARD_NO';
                                        return true;
                                    })
                                    .map((p, idx) => (
                                    <CircleMarker
                                        key={`saved-${route.id}-${p.address_hash || 'no-hash'}-${idx}`}
                                        center={[p.lat, p.lng]}
                                        radius={pinSize}
                                        eventHandlers={{ click: (e) => { L.DomEvent.stopPropagation(e); setActiveRoute(route); } }}
                                        pathOptions={{ 
                                            fillColor: repColor, 
                                            fillOpacity: isUnassigned ? 0.6 : 0.8, 
                                            color: repColor, 
                                            weight: 1 
                                        }}
                                    />
                                ))}
                                {showRouteLines && route.properties.length > 1 && (
                                    <Polyline
                                        positions={route.properties.map(p => [p.lat, p.lng])}
                                        pathOptions={{ color: repColor, weight: 2, opacity: 0.4, dashArray: '4,6' }}
                                    />
                                )}
                            </React.Fragment>
                        );
                    })}
                </LayerGroup>

                {/* --- GENERATE MODE: Existing Routes (Dimmed) --- */}
                <LayerGroup>
                    {mode === 'generate' && !activeRoute && zoomLevel >= 8 && hydratedSavedRoutes.map((route) => {
                        return route.properties.map((p, idx) => (
                            <CircleMarker
                                key={`saved-dim-${route.id}-${idx}`}
                                center={[p.lat, p.lng]}
                                radius={2}
                                pathOptions={{ fillColor: '#333', fillOpacity: 0.2, color: '#333', weight: 0 }}
                            />
                        ));
                    })}
                </LayerGroup>

                {/* --- GENERATE MODE: New Routes --- */}
                <LayerGroup>
                    {mode === 'generate' && !activeRoute && filteredRoutes.length > 0 && filteredRoutes.map((route, rIdx) => {
                        const routeColor = ROUTE_COLORS[rIdx % ROUTE_COLORS.length];
                        const centerProp = route.properties[Math.floor(route.properties.length / 2)];
                        
                        return (
                            <React.Fragment key={`route-group-${route.id}`}>
                                {/* Rank Marker at Center */}
                                {centerProp && (
                                    <CircleMarker
                                        center={[centerProp.lat, centerProp.lng]}
                                        radius={16}
                                        pathOptions={{ fillColor: 'black', fillOpacity: 0.8, color: routeColor, weight: 3 }}
                                        eventHandlers={{ click: (e) => { L.DomEvent.stopPropagation(e); setActiveRoute(route); } }}
                                    >
                                        <Tooltip permanent direction="center" className="route-number-tooltip">
                                            <span style={{ color: routeColor, fontWeight: '900', fontSize: '14px' }}>#{rIdx + 1}</span>
                                        </Tooltip>
                                    </CircleMarker>
                                )}
                                
                                {showRouteDetails && route.properties.map((p, idx) => (
                                    <CircleMarker
                                        key={`generated-${route.id}-${idx}`}
                                        center={[p.lat, p.lng]}
                                        radius={6}
                                        eventHandlers={{ click: (e) => { L.DomEvent.stopPropagation(e); setActiveRoute(route); } }}
                                        pathOptions={{ fillColor: routeColor, fillOpacity: 0.6, color: routeColor, weight: 1 }}
                                    />
                                ))}
                            </React.Fragment>
                        );
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

                {/* USER PROPERTIES PIN LAYER - Visible in Generate Mode or Explicit Show */}
                <LayerGroup>
                    {viewMode === 'pins' && zoomLevel >= 13 && !activeRoute && (mode === 'generate' || showAllProperties) && effectiveProperties
                        .filter(p => !p.is_dark_room)
                        .filter(p => {
                            // In Generate mode, hide properties already in saved routes (unless filtering explicitly)
                            if (mode === 'generate' && assignedHashes.has(p.address_hash)) return false;

                            // Visual Filter: Only show requested Zips in Generate Mode
                            if (mode === 'generate' && zipCodeFilter && zipCodeFilter.trim()) {
                                const targetZips = zipCodeFilter.split(',').map(z => z.trim()).filter(Boolean);
                                const pZip = String(p.zip_code || '').trim().slice(0, 5);
                                if (targetZips.length > 0 && !targetZips.includes(pZip)) return false;
                            }
                            
                            // Date Filter (Sold Date)
                            if (soldDateFilter !== null && p.sold_date) {
                                try {
                                    const date = parseISO(p.sold_date);
                                    const cutoff = subMonths(new Date(), soldDateFilter);
                                    if (!isAfter(date, cutoff)) return false;
                                } catch (e) { /* invalid date */ }
                            }

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
                                radius={5}
                                eventHandlers={{ click: (e) => { L.DomEvent.stopPropagation(e); setSelectedProperty(p); } }}
                                pathOptions={{
                                    fillColor: STATUS_COLORS[p.effective_status] || STATUS_COLORS.OTHER,
                                    fillOpacity: mode === 'generate' ? 0.9 : 0.5,
                                    color: '#000',
                                    weight: 1
                                }}
                            />
                        ))}
                </LayerGroup>

                {/* GPS TRACKER LAYERS */}
                <GpsTrackerMapLayers 
                    properties={effectiveProperties}
                    isTracking={gpsTracking}
                    onSelectProperty={setSelectedProperty}
                />

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
                <div className="flex flex-nowrap items-center gap-2 overflow-x-auto no-scrollbar pb-1">
                    {/* DASHBOARD & SETTINGS TOGGLES */}
                    <div className="pointer-events-auto shrink-0 flex gap-2">
                        <Button
                            onClick={() => setShowDashboard(true)}
                            size="icon"
                            className="bg-black/90 hover:bg-black border border-gray-800 shadow-xl h-9 w-9 sm:h-[42px] sm:w-[42px] rounded-lg"
                        >
                            <LayoutDashboard className="w-4 h-4 sm:w-5 sm:h-5 text-yellow-500" />
                        </Button>
                        <Button
                            onClick={() => setShowMapSettings(true)}
                            size="icon"
                            className="bg-black/90 hover:bg-black border border-gray-800 shadow-xl h-9 w-9 sm:h-[42px] sm:w-[42px] rounded-lg"
                        >
                            <Settings className="w-4 h-4 sm:w-5 sm:h-5 text-gray-400" />
                        </Button>
                    </div>

                    {/* MODE TOGGLE - Compact Single Row */}
                    <div className="pointer-events-auto bg-black/90 backdrop-blur rounded-lg p-1 border border-gray-800 flex gap-1 shadow-xl shrink-0 mx-auto">
                        <button
                            onClick={() => setMode('analyze')}
                            className={`px-2 py-1.5 sm:px-3 sm:py-2 rounded-md text-[9px] sm:text-[10px] font-bold transition-all whitespace-nowrap ${mode === 'analyze' ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-400 hover:text-white'}`}
                        >
                            DISPATCH MAP
                        </button>
                        <button
                            onClick={() => setMode('generate')}
                            className={`px-2 py-1.5 sm:px-3 sm:py-2 rounded-md text-[9px] sm:text-[10px] font-bold transition-all whitespace-nowrap ${mode === 'generate' ? 'bg-yellow-500 text-black shadow-lg' : 'text-gray-400 hover:text-white'}`}
                        >
                            ROUTE BUILDER
                        </button>
                    </div>

                    {/* FILTER BUTTON */}
                    <div className="pointer-events-auto shrink-0 ml-auto">
                        <Button
                            onClick={() => setShowCompare(true)}
                            size="icon"
                            className="rounded-lg h-9 w-9 sm:h-10 sm:w-10 font-bold tracking-wide shadow-lg"
                            style={{ 
                                background: mode === 'generate' ? BRAND.gold : BRAND.charcoal, 
                                color: mode === 'generate' ? BRAND.voidBlack : BRAND.gold, 
                                border: `1px solid ${BRAND.gold}40` 
                            }}
                        >
                            {mode === 'generate' ? <Navigation className="w-4 h-4 sm:w-5 sm:h-5" /> : <Filter className="w-4 h-4 sm:w-5 sm:h-5" />}
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
                                <div className="mt-1 flex items-center">
                                    <select
                                        value={activeRoute.assigned_to || ""}
                                        onChange={(e) => handleAssignRoute(activeRoute.id, e.target.value)}
                                        onClick={(e) => e.stopPropagation()}
                                        className="text-xs font-bold bg-black/10 border-none rounded px-3 py-2 outline-none cursor-pointer hover:bg-black/20 transition-colors h-8"
                                        style={{ color: BRAND.voidBlack }}
                                    >
                                        <option value="">Unassigned</option>
                                        <option value={user?.id}>Me (Manager)</option>
                                        {teamMembers.map(m => (
                                            <option key={m.id} value={m.id}>{m.name} ({m.email})</option>
                                        ))}
                                    </select>
                                </div>
                            </div>
                        </div>
                        <button 
                            onClick={() => {
                                setActiveRoute(null);
                                if (mapRef.current) {
                                    // Zoom out slightly (1 standard deviation-ish) instead of full reset
                                    mapRef.current.setZoom(Math.max(13, mapRef.current.getZoom() - 2));
                                }
                            }} 
                            className="w-10 h-10 flex items-center justify-center bg-black/10 hover:bg-black/20 active:bg-black/30 rounded-full transition-colors ml-3 shrink-0"
                        >
                            <X className="w-6 h-6" style={{ color: BRAND.voidBlack }} />
                        </button>
                    </div>
                )}

            </div>

            {/* Team Analysis Legend (Top Right) */}
            {!activeRoute && (
                <div className="absolute top-20 right-4 z-[900] pointer-events-auto bg-black/80 backdrop-blur-md border border-gray-800 rounded-xl p-3 max-w-[200px] animate-in slide-in-from-right">
                    <p className="text-[10px] font-bold text-gray-400 mb-2 uppercase">Team Analysis</p>
                    <div className="space-y-2 max-h-[200px] overflow-y-auto">
                        {teamMembers.map(member => {
                            const memberRoutes = hydratedSavedRoutes.filter(r => r.assigned_to === member.id);
                            if (memberRoutes.length === 0) return null;
                            return (
                                <div key={member.id} className="flex items-center justify-between text-xs">
                                    <div className="flex items-center gap-2">
                                        <span className="w-2 h-2 rounded-full" style={{ background: repColors[member.id] }} />
                                        <span className="text-white truncate max-w-[80px]">{member.name}</span>
                                    </div>
                                    <span className="text-gray-500">{memberRoutes.length} Rts</span>
                                </div>
                            );
                        })}
                        <div className="flex items-center justify-between text-xs opacity-50">
                            <div className="flex items-center gap-2">
                                <span className="w-2 h-2 rounded-full bg-[#666]" />
                                <span className="text-white">Unassigned</span>
                            </div>
                            <span className="text-gray-500">{hydratedSavedRoutes.filter(r => !r.assigned_to).length}</span>
                        </div>
                    </div>
                </div>
            )}

            {/* Bottom Action Bar */}
            <div className="absolute bottom-6 left-4 right-4 z-[1000] pointer-events-none">
                <div className="flex items-end justify-between gap-2">
                    {/* Left: Compact Route List Button */}
                    <div className="pointer-events-auto">
                        <Button
                            onClick={() => setShowRoutePanel(true)}
                            className="rounded-full h-12 px-6 text-xs sm:text-sm font-bold tracking-wide shadow-[0_0_20px_rgba(255,215,0,0.3)] hover:shadow-[0_0_30px_rgba(255,215,0,0.5)] transition-all duration-300 transform active:scale-95 whitespace-nowrap"
                            style={{ background: 'linear-gradient(135deg, #FFD700 0%, #F59E0B 100%)', color: BRAND.voidBlack }}
                        >
                            <List className="w-5 h-5 mr-2" />
                            ROUTES
                            {routesGenerating && <Loader2 className="w-3 h-3 ml-2 animate-spin" />}
                            {!routesGenerating && (hydratedSavedRoutes.length > 0 || routes.length > 0) && (
                                <Badge className="ml-2 h-5 min-w-[20px] px-1" style={{ background: BRAND.voidBlack, color: BRAND.gold }}>
                                    {hydratedSavedRoutes.length > 0 ? hydratedSavedRoutes.length : routes.length}
                                </Badge>
                            )}
                        </Button>
                    </div>

                    {/* Center: Checklist (if active) */}
                    <div className="absolute left-1/2 -translate-x-1/2 bottom-0 pointer-events-auto">
                        {activeRoute && (
                            <Button
                                onClick={() => setShowChecklist(true)}
                                className="rounded-full h-12 px-6 text-xs sm:text-sm font-bold tracking-wide shadow-2xl backdrop-blur-md transition-all duration-300 transform active:scale-95 whitespace-nowrap"
                                style={{ background: 'rgba(31, 31, 31, 0.9)', color: BRAND.gold, border: `1px solid ${BRAND.gold}` }}
                            >
                                <List className="w-5 h-5 mr-2" />
                                CHECKLIST
                                <ChevronRight className="w-3 h-3 ml-1" />
                            </Button>
                        )}
                    </div>

                    {/* Right: GPS + Locate */}
                    <div className="pointer-events-auto flex flex-col gap-2">
                        {/* GPS Live Tracking Toggle */}
                        <Button
                            onClick={() => {
                                setGpsTracking(!gpsTracking);
                                if (!gpsTracking && mapRef.current) {
                                    mapRef.current.locate({ setView: true, maxZoom: 18 });
                                }
                            }}
                            size="icon"
                            className={`rounded-full w-12 h-12 sm:w-14 sm:h-14 shadow-2xl backdrop-blur-md transition-all ${gpsTracking ? 'ring-2 ring-green-500 ring-offset-2 ring-offset-black' : ''}`}
                            style={{ 
                                background: gpsTracking ? 'rgba(34, 197, 94, 0.3)' : 'rgba(31, 31, 31, 0.8)', 
                                color: gpsTracking ? '#22c55e' : BRAND.gold, 
                                border: `1px solid ${gpsTracking ? '#22c55e' : BRAND.gold + '40'}` 
                            }}
                        >
                            <Crosshair className="w-5 h-5" />
                        </Button>

                        <Button
                            onClick={(e) => {
                                e.stopPropagation();
                                if (mapRef.current) {
                                    if (fitBounds && fitBounds.length > 0) {
                                        mapRef.current.fitBounds(fitBounds, { padding: [30, 30], maxZoom: 17 });
                                        toast.success("Centered on Territory");
                                    } else {
                                        mapRef.current.locate({ setView: true, maxZoom: 16 });
                                        toast.success("Locating...");
                                    }
                                } else {
                                    toast.error("Map not ready");
                                }
                            }}
                            size="icon"
                            className="rounded-full w-12 h-12 sm:w-14 sm:h-14 shadow-2xl backdrop-blur-md"
                            style={{ background: 'rgba(31, 31, 31, 0.8)', color: BRAND.gold, border: `1px solid ${BRAND.gold}40` }}
                        >
                            <Locate className="w-5 h-5" />
                        </Button>
                    </div>
                </div>
            </div>

            {/* Routes Panel - Refactored Command Panel */}
            {showRoutePanel && (
                <RouteCommandPanel
                    generatedRoutes={routes}
                    savedRoutes={hydratedSavedRoutes}
                    filteredRoutes={filteredRoutes}
                    genStats={genStats}
                    repColors={repColors}
                    teamMembers={teamMembers}
                    getRepRecommendations={getRepRecommendations}
                    onSelectRoute={(route) => {
                        setActiveRoute(route);
                        setPreviewRoute(null);
                        setShowRoutePanel(false);
                    }}
                    onSaveRoute={handleSaveRoute}
                    onAutoAssignAll={handleAutoAssignAll}
                    onClose={() => setShowRoutePanel(false)}
                    activeRouteId={activeRoute?.id}
                    streetCooldownDays={streetCooldownDays}
                    zipCodeFilter={zipCodeFilter}
                    housesPerRoute={housesPerRoute}
                />
            )}

            {/* Filter Panel - ANALYZE MODE */}
            {showCompare && mode === 'analyze' && (
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
                            <div className="space-y-4">
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
                                        FILTER BY ZIP CODE
                                    </label>
                                    <select
                                        value={analyzeZipFilter}
                                        onChange={(e) => setAnalyzeZipFilter(e.target.value)}
                                        className="w-full px-3 py-2 rounded-lg text-sm bg-[#1F1F1F] text-white border border-[#333]"
                                    >
                                        <option value="all">All Zip Codes</option>
                                        {uniqueZips.map(zip => (
                                            <option key={zip} value={zip}>{zip}</option>
                                        ))}
                                    </select>
                                </div>

                                <div>
                                    <label className="text-xs font-bold tracking-wide mb-3 block" style={{ color: BRAND.offWhite }}>
                                        SOLD DATE FILTER
                                    </label>
                                    <div className="space-y-4">
                                        <div className="flex justify-between text-[10px] font-bold text-gray-500 uppercase">
                                            <span>3 Mo</span>
                                            <span>6 Mo</span>
                                            <span>1 Yr</span>
                                            <span>2 Yr</span>
                                            <span>All</span>
                                        </div>
                                        <Slider
                                            value={[soldDateFilter === null ? 100 : (
                                                soldDateFilter <= 3 ? 0 : 
                                                soldDateFilter <= 6 ? 25 : 
                                                soldDateFilter <= 12 ? 50 : 
                                                soldDateFilter <= 24 ? 75 : 100
                                            )]}
                                            onValueChange={([v]) => {
                                                if (v === 0) setSoldDateFilter(3);
                                                else if (v === 25) setSoldDateFilter(6);
                                                else if (v === 50) setSoldDateFilter(12);
                                                else if (v === 75) setSoldDateFilter(24);
                                                else setSoldDateFilter(null);
                                            }}
                                            min={0}
                                            max={100}
                                            step={25}
                                            className="w-full"
                                        />
                                        <p className="text-center text-xs font-bold text-yellow-500">
                                            {soldDateFilter ? `Sold within last ${soldDateFilter} months` : 'Showing All Sales History'}
                                        </p>
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
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Route Builder Settings - GENERATE MODE */}
            {showCompare && mode === 'generate' && (
                <RouteBuilderSettings
                    housesPerRoute={housesPerRoute} setHousesPerRoute={setHousesPerRoute}
                    maxRouteDistance={maxRouteDistance} setMaxRouteDistance={setMaxRouteDistance}
                    streetCooldownDays={streetCooldownDays} setStreetCooldownDays={setStreetCooldownDays}
                    minScore={minScore} setMinScore={setMinScore}
                    zipCodeFilter={zipCodeFilter} setZipCodeFilter={setZipCodeFilter}
                    startLocation={startLocation} setStartLocation={setStartLocation}
                    startAddressInput={startAddressInput} setStartAddressInput={setStartAddressInput}
                    sortBy={sortBy} setSortBy={setSortBy}
                    soldDateFilter={soldDateFilter} setSoldDateFilter={setSoldDateFilter}
                    routeConfig={routeConfig} setRouteConfig={setRouteConfig}
                    onGenerate={generateRoutes} routesGenerating={routesGenerating}
                    onReset={() => {
                        if(confirm("Reset all generated routes?")) {
                            setRoutes([]);
                            setFetchedProperties([]);
                            toast.success("Builder reset");
                        }
                    }}
                    mapRef={mapRef}
                    routeTemplates={routeTemplates}
                    templateName={templateName} setTemplateName={setTemplateName}
                    onSaveTemplate={() => {
                        if (!templateName) return toast.error("Enter name");
                        saveTemplateMutation.mutate({
                            name: templateName,
                            config: {
                                houses_per_route: housesPerRoute,
                                max_distance: maxRouteDistance,
                                min_score: minScore,
                                street_cooldown_days: streetCooldownDays,
                                zip_code_filter: zipCodeFilter,
                                start_location: startLocation,
                                ...routeConfig
                            },
                            created_by: user?.email
                        });
                    }}
                    onLoadTemplate={loadTemplate}
                    filteredRoutes={filteredRoutes}
                    onSelectRoute={(route) => { setActiveRoute(route); setShowCompare(false); }}
                    onClose={() => setShowCompare(false)}
                    onForceSync={async () => {
                        if (!confirm(`Force sync properties for ${zipCodeFilter}?`)) return;
                        const toastId = toast.loading("Syncing...");
                        try {
                            const res = await base44.functions.invoke('fetchZipProperties', { zip_code: zipCodeFilter, force_sync: true });
                            if (res.data.count > 0) {
                                toast.success(`Synced ${res.data.count} new properties!`, { id: toastId });
                                window.location.reload();
                            } else {
                                toast.info(res.data.message || "Up to date", { id: toastId });
                            }
                        } catch (e) { toast.error("Sync failed", { id: toastId }); }
                    }}
                    onClearArea={async () => {
                        if (!confirm(`DELETE ALL properties in zip ${zipCodeFilter}?`)) return;
                        const toastId = toast.loading("Deleting...");
                        try {
                            const res = await base44.functions.invoke('cleanupDatabase', { action: 'cleanup', zip_code: zipCodeFilter });
                            toast.success(`Deleted ${res.data.deleted} properties`, { id: toastId });
                            setTimeout(() => window.location.reload(), 1500);
                        } catch (e) { toast.error("Failed", { id: toastId }); }
                    }}
                    user={user}
                />
            )}

            {/* GPS HUD Overlay */}
            <GpsTrackerHud
                properties={effectiveProperties}
                isTracking={gpsTracking}
                onToggleTracking={() => setGpsTracking(false)}
                onSelectProperty={setSelectedProperty}
            />

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
                            navigationApp={navigationApp}
                        />
                    </div>
                </div>
            )}

            {/* New Territory Setup Wizard */}
            {showSetupWizard && (
                <TerritorySetupWizard 
                    user={user} 
                    onComplete={handleWizardComplete} 
                />
            )}

            {/* Property Details Drawer */}
            {/* Command Center Dashboard Overlay */}
                              {showDashboard && (
                                  <CommandCenterDashboard
                                      properties={effectiveProperties}
                                      logs={logs}
                                      routes={savedRoutes}
                                      teamMembers={teamMembers}
                                      onClose={() => setShowDashboard(false)}
                                  />
                              )}

                              {/* Map Settings Panel */}
                              {showMapSettings && (
                                  <MapSettingsPanel
                                      mapTheme={mapTheme}
                                      setMapTheme={setMapTheme}
                                      teamMembers={teamMembers}
                                      repColors={repColors}
                                      onUpdateRepColor={handleUpdateRepColor}
                                      onClose={() => setShowMapSettings(false)}
                                      quickFilter={quickFilter}
                                      setQuickFilter={setQuickFilter}
                                      showRouteDetails={showRouteDetails}
                                      setShowRouteDetails={setShowRouteDetails}
                                      navigationApp={navigationApp}
                                      setNavigationApp={updateNavigationApp}
                                      pinSize={pinSize}
                                      setPinSize={setPinSize}
                                      showRouteLines={showRouteLines}
                                      setShowRouteLines={setShowRouteLines}
                                  />
                              )}

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
            )}
            </div>
            );
            }