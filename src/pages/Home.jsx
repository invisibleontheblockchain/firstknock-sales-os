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
import CommandCenterDashboard from '../components/dashboard/CommandCenterDashboard';
import MapSettingsPanel from '../components/map/MapSettingsPanel';
import { LayoutDashboard, Settings } from 'lucide-react';

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
    const [zipCodeFilter, setZipCodeFilter] = useState(''); // Comma separated string
    const [showAllProperties, setShowAllProperties] = useState(false);
    const [viewMode, setViewMode] = useState('pins'); // 'pins' or 'heatmap'
    const [mode, setMode] = useState('analyze'); // 'analyze' or 'generate'
    const [showDashboard, setShowDashboard] = useState(false);
    const [showTimingPanel, setShowTimingPanel] = useState(false);
    const [selectedProperty, setSelectedProperty] = useState(null);
    const [zoomLevel, setZoomLevel] = useState(15);
    const [mapTheme, setMapTheme] = useState('dark'); // 'dark' or 'light'
    const [showMapSettings, setShowMapSettings] = useState(false);
    const [darkRoomProperties, setDarkRoomProperties] = useState([]);
    const [darkRoomClusters, setDarkRoomClusters] = useState([]);
    const [darkRoomCount, setDarkRoomCount] = useState(0);
    const [isLoadingDarkRoom, setIsLoadingDarkRoom] = useState(false);
    const [darkRoomEnabled, setDarkRoomEnabled] = useState(false);
    const [fetchedProperties, setFetchedProperties] = useState([]); // Dynamic fetch storage
    const mapRef = useRef(null);
    const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me() });

    // Fetch Team Members for Analysis & Coloring
    const { data: teamMembers = [] } = useQuery({
        queryKey: ['teamMembers'],
        queryFn: () => base44.entities.TeamMember.list('-created_date', 100).then(res => Array.isArray(res) ? res : (res?.items || []))
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
        queryKey: ['masterProperties', user?.email],
        queryFn: async () => {
            if (!user?.email) return [];
            
            try {
                // Increased limit to 5000 to accommodate larger datasets/zip codes
                const result = await base44.entities.MasterProperty.filter({ created_by: user.email }, '-created_date', 5000);
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
            alert("Route saved successfully!");
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
            assigned_to_name: assignedRepName
        });
    };

    const { data: logsRaw = [], isLoading: logsLoading } = useQuery({
        queryKey: ['interactionLogs', user?.email],
        queryFn: () => user ? base44.entities.InteractionLog.filter({ created_by: user.email }, '-created_date', 5000) : [],
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
            }).filter(p => !assignedSet.has(p.address_hash) && p.lat && p.lng);

            // Merge with existing availableProperties, deduping by address_hash
            const combinedMap = new Map();
            availableProperties.forEach(p => combinedMap.set(p.address_hash, p));
            processedDynamic.forEach(p => combinedMap.set(p.address_hash, p));
            
            let workingSet = Array.from(combinedMap.values());

            // 3. FILTERING
            if (zipCodeFilter && zipCodeFilter.trim()) {
                const targetZips = zipCodeFilter.split(',').map(z => z.trim()).filter(Boolean);
                if (targetZips.length > 0) {
                    workingSet = workingSet.filter(p => {
                        const pZip = String(p.zip_code || '').trim().slice(0, 5);
                        return targetZips.includes(pZip);
                    });
                }
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
                    useStreetSweep: true,
                    minimizeTurns: true
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

        return { totalHouses, totalDist, avgScore, routeCount: routes.length, highPotentialCount };
    }, [routes]);

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

                {/* --- ANALYZE MODE: Existing Routes --- */}
                <LayerGroup>
                    {mode === 'analyze' && !activeRoute && zoomLevel >= 8 && hydratedSavedRoutes.map((route) => {
                        const repColor = route.assigned_to ? (repColors[route.assigned_to] || '#3b82f6') : '#666'; 
                        const isUnassigned = !route.assigned_to;
                        return route.properties.map((p, idx) => (
                            <CircleMarker
                                key={`saved-${route.id}-${p.address_hash || 'no-hash'}-${idx}`}
                                center={[p.lat, p.lng]}
                                radius={4}
                                eventHandlers={{ click: (e) => { L.DomEvent.stopPropagation(e); setActiveRoute(route); } }}
                                pathOptions={{ fillColor: repColor, fillOpacity: isUnassigned ? 0.3 : 0.8, color: repColor, weight: 1 }}
                            />
                        ));
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
                    {mode === 'generate' && !activeRoute && routes.length > 0 && routes.map((route, rIdx) => {
                        const routeColor = ROUTE_COLORS[rIdx % ROUTE_COLORS.length];
                        return route.properties.map((p, idx) => (
                            <CircleMarker
                                key={`generated-${route.id}-${idx}`}
                                center={[p.lat, p.lng]}
                                radius={6}
                                eventHandlers={{ click: (e) => { L.DomEvent.stopPropagation(e); setActiveRoute(route); } }}
                                pathOptions={{ fillColor: routeColor, fillOpacity: 0.7, color: routeColor, weight: 1 }}
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
                    {/* DASHBOARD TOGGLE */}
                    <div className="pointer-events-auto shrink-0">
                        <Button
                            onClick={() => setShowDashboard(true)}
                            size="icon"
                            className="bg-black/90 hover:bg-black border border-gray-800 shadow-xl h-[42px] w-[42px] rounded-lg"
                        >
                            <LayoutDashboard className="w-5 h-5 text-yellow-500" />
                        </Button>
                    </div>

                    {/* MODE TOGGLE */}
                    <div className="pointer-events-auto bg-black/90 backdrop-blur rounded-lg p-1 border border-gray-800 flex gap-1 shadow-xl shrink-0">
                        <button
                            onClick={() => setMode('analyze')}
                            className={`px-3 py-2 rounded-md text-[10px] font-bold transition-all ${mode === 'analyze' ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-400 hover:text-white'}`}
                        >
                            COMMAND CENTER
                        </button>
                        <button
                            onClick={() => setMode('generate')}
                            className={`px-3 py-2 rounded-md text-[10px] font-bold transition-all ${mode === 'generate' ? 'bg-yellow-500 text-black shadow-lg' : 'text-gray-400 hover:text-white'}`}
                        >
                            BUILD ROUTES
                        </button>
                    </div>

                    <div className="pointer-events-auto flex-1" />

                    <div className="pointer-events-auto shrink-0">
                        <Button
                            onClick={() => setShowCompare(true)}
                            size="icon"
                            className="rounded-lg h-10 w-10 font-bold tracking-wide shadow-lg"
                            style={{ 
                                background: mode === 'generate' ? BRAND.gold : BRAND.charcoal, 
                                color: mode === 'generate' ? BRAND.voidBlack : BRAND.gold, 
                                border: `1px solid ${BRAND.gold}40` 
                            }}
                        >
                            {mode === 'generate' ? <Navigation className="w-5 h-5" /> : <Filter className="w-5 h-5" />}
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
                <div className="flex items-end gap-2">
                    <div className="flex-1 flex gap-2 overflow-x-auto no-scrollbar pb-1 pointer-events-auto">
                        <Button
                            onClick={() => setShowRoutePanel(true)}
                            className="rounded-full flex-1 px-4 h-12 sm:h-14 text-xs sm:text-sm font-bold tracking-wide shadow-[0_0_20px_rgba(255,215,0,0.3)] hover:shadow-[0_0_30px_rgba(255,215,0,0.5)] transition-all duration-300 transform active:scale-95 whitespace-nowrap min-w-[100px]"
                            style={{ background: 'linear-gradient(135deg, #FFD700 0%, #F59E0B 100%)', color: BRAND.voidBlack }}
                        >
                            <Navigation className="w-4 h-4 sm:w-5 sm:h-5 mr-2" />
                            COMMAND CENTER
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

                                    {/* GENERATION REPORT SUMMARY */}
                                    {genStats && (
                                        <div className="bg-[#1A1A1A] rounded-xl p-4 border border-[#333] mb-5 shadow-lg relative overflow-hidden">
                                            {/* Decorator */}
                                            <div className="absolute top-0 right-0 w-20 h-20 bg-yellow-500/5 rounded-full blur-2xl pointer-events-none"></div>

                                            <div className="flex justify-between items-start mb-4">
                                                <div>
                                                    <h3 className="text-sm font-bold text-white tracking-wide flex items-center gap-2">
                                                        <BarChart3 className="w-4 h-4 text-yellow-500" />
                                                        GENERATION REPORT
                                                    </h3>
                                                    <p className="text-[10px] text-gray-500 mt-1 font-medium">
                                                        Target: {zipCodeFilter || 'Current View'} • {housesPerRoute} Homes/Route
                                                    </p>
                                                </div>
                                                {/* AUTO DISPATCH BUTTON */}
                                                <Button 
                                                    onClick={handleAutoAssignAll}
                                                    size="sm"
                                                    className="bg-green-600 hover:bg-green-500 text-white border-none font-bold text-[10px] h-7 px-3 animate-in fade-in"
                                                >
                                                    <User className="w-3 h-3 mr-1" />
                                                    AUTO-DISPATCH ALL
                                                </Button>
                                            </div>

                                            <div className="grid grid-cols-4 gap-2 mb-4">
                                                <div className="bg-black/40 p-2 rounded-lg border border-white/5">
                                                    <p className="text-lg font-bold text-white">{genStats.totalHouses}</p>
                                                    <p className="text-[9px] text-gray-500 uppercase font-bold tracking-wider">Doors</p>
                                                </div>
                                                <div className="bg-black/40 p-2 rounded-lg border border-white/5">
                                                    <p className="text-lg font-bold text-yellow-500">{genStats.routeCount}</p>
                                                    <p className="text-[9px] text-gray-500 uppercase font-bold tracking-wider">Routes</p>
                                                </div>
                                                <div className="bg-black/40 p-2 rounded-lg border border-white/5">
                                                    <p className="text-lg font-bold text-white">{genStats.avgScore}</p>
                                                    <p className="text-[9px] text-gray-500 uppercase font-bold tracking-wider">Avg Score</p>
                                                </div>
                                                <div className="bg-black/40 p-2 rounded-lg border border-white/5">
                                                    <p className="text-lg font-bold text-white">{genStats.totalDist}</p>
                                                    <p className="text-[9px] text-gray-500 uppercase font-bold tracking-wider">Miles</p>
                                                </div>
                                            </div>

                                            <div className="flex items-center gap-2 text-[10px] text-gray-400 bg-black/20 p-2 rounded-lg border border-dashed border-gray-800">
                                                <Flame className="w-3 h-3 text-orange-500" />
                                                <span>
                                                    <span className="text-white font-bold">{genStats.highPotentialCount}</span> routes identified as High Potential (Score 100+)
                                                </span>
                                            </div>
                                        </div>
                                    )}

                                    <div className="flex items-center gap-2 mb-2 px-1">
                                        <Badge className="bg-yellow-500 text-black font-bold h-5 text-[10px]">NEW</Badge>
                                        <span className="text-xs font-bold text-gray-400">ROUTE LIST</span>
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
                                            
                                            {/* Uber-Style Assign Recommendation */}
                                            {(() => {
                                                const center = route.properties[0];
                                                const recommendations = getRepRecommendations(center);
                                                const bestMatch = recommendations[0];
                                                
                                                return (
                                                    <div className="mt-3 flex flex-col gap-2">
                                                        {/* Primary Action: Assign Best Match */}
                                                        <div className="flex gap-2">
                                                            <Button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    handleSaveRoute(route, bestMatch?.id, bestMatch?.name);
                                                                }}
                                                                size="sm"
                                                                className="flex-1 h-8 text-[10px] font-bold bg-[#333] hover:bg-green-600 text-white transition-all border border-gray-700 relative overflow-hidden group/btn"
                                                            >
                                                                {bestMatch ? (
                                                                    <div className="flex items-center justify-between w-full px-1">
                                                                        <div className="flex items-center">
                                                                            <span className={`w-2 h-2 rounded-full mr-2 ${bestMatch.isAvailable ? 'bg-green-500 animate-pulse' : 'bg-yellow-500'}`} />
                                                                            <span>DISPATCH: {bestMatch.name.split(' ')[0].toUpperCase()}</span>
                                                                        </div>
                                                                        <span className="text-[9px] opacity-70 bg-black/30 px-1 rounded">
                                                                            {bestMatch.matchScore}% MATCH
                                                                        </span>
                                                                    </div>
                                                                ) : 'SAVE UNASSIGNED'}
                                                                {/* Hover Effect Details */}
                                                                {bestMatch && (
                                                                    <div className="absolute inset-0 bg-green-600 transform translate-y-full group-hover/btn:translate-y-0 transition-transform flex items-center justify-center gap-2">
                                                                        <span>CONFIRM ASSIGNMENT</span>
                                                                        <ArrowRight className="w-3 h-3" />
                                                                    </div>
                                                                )}
                                                            </Button>
                                                            <Button
                                                                onClick={(e) => {
                                                                    e.stopPropagation();
                                                                    handleSaveRoute(route);
                                                                }}
                                                                size="sm"
                                                                className="h-8 w-8 p-0 bg-black hover:bg-gray-800 border border-gray-700 text-gray-400"
                                                                title="Save Unassigned"
                                                            >
                                                                <Shield className="w-3 h-3" />
                                                            </Button>
                                                        </div>

                                                        {/* Secondary Info: Why this rep? */}
                                                        {bestMatch && (
                                                            <div className="flex items-center justify-between text-[9px] text-gray-500 px-1">
                                                                <span className="flex items-center gap-1">
                                                                    <MapPin className="w-3 h-3" />
                                                                    {bestMatch.distance ? `${bestMatch.distance}mi away` : 'N/A'}
                                                                </span>
                                                                <span className="flex items-center gap-1">
                                                                    <BarChart3 className="w-3 h-3" />
                                                                    Perf: {bestMatch.performanceScore}
                                                                </span>
                                                                {bestMatch.activeRoutesCount > 0 && (
                                                                    <span className="text-yellow-500 font-bold">
                                                                        {bestMatch.activeRoutesCount} Active
                                                                    </span>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })()}
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
                                {mode === 'generate' ? <Navigation className="w-5 h-5" /> : <BarChart3 className="w-5 h-5" />}
                                {mode === 'generate' ? 'BUILDER SETTINGS' : 'ROUTE FILTERS'}
                            </h2>
                            <button onClick={() => setShowCompare(false)} className="p-4 -mr-2 hover:bg-[#333] rounded-full transition-colors">
                                <X className="w-6 h-6" style={{ color: BRAND.offWhite }} />
                            </button>
                        </div>

                        <div className="p-5 space-y-6 overflow-y-auto h-[calc(100%-70px)]">
                            
                            {/* --- ANALYZE MODE CONTROLS --- */}
                            {mode === 'analyze' && (
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
                            )}

                            {/* --- GENERATE MODE CONTROLS --- */}
                            {mode === 'generate' && (
                                <>
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
                                        {startLocation ? (
                                            <div className="flex justify-between items-center mt-1">
                                                <p className="text-[10px] text-green-500">✓ Set: {startLocation.address}</p>
                                                <button onClick={() => { setStartLocation(null); setStartAddressInput(""); }} className="text-[10px] text-red-400 hover:text-white">Clear</button>
                                            </div>
                                        ) : (
                                            <p className="text-[10px] text-gray-500 mt-1 italic">Optional (Defaults to map center)</p>
                                        )}
                                    </div>

                                    <div>
                                        <label className="text-xs font-bold tracking-wide mb-3 block" style={{ color: BRAND.offWhite }}>
                                            FILTER BY ZIP CODES
                                        </label>
                                        <input
                                            type="text"
                                            placeholder="e.g. 90210, 90001 (Optional)"
                                            value={zipCodeFilter}
                                            onChange={(e) => setZipCodeFilter(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg text-sm bg-[#1F1F1F] text-white border border-[#333]"
                                        />
                                        <p className="text-[10px] text-gray-500 mt-1">
                                            Separate multiple zips with commas. Leave empty to use all visible.
                                        </p>
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

                                    {/* Advanced Logic Toggles */}
                                    <div className="bg-[#151515] p-3 rounded-lg space-y-3 border border-[#333]">
                                        <p className="text-[10px] font-bold text-gray-500 uppercase">ADVANCED OPTIMIZATION</p>
                                        <div className="flex items-center justify-between">
                                            <span className="text-xs text-gray-300">Minimize Turns (Straighter Paths)</span>
                                            <input type="checkbox" className="accent-yellow-500" defaultChecked />
                                        </div>
                                        <div className="flex items-center justify-between opacity-50">
                                            <span className="text-xs text-gray-300">School Zone Avoidance (Time)</span>
                                            <input type="checkbox" className="accent-yellow-500" disabled />
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
                                                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> BUILDING...</>
                                            ) : (
                                                <><Navigation className="w-4 h-4 mr-2" /> GENERATE NEW</>
                                            )}
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
                                        <Slider
                                            value={[streetCooldownDays]}
                                            onValueChange={([v]) => setStreetCooldownDays(v)}
                                            min={7}
                                            max={90}
                                            step={7}
                                            className="w-full"
                                        />
                                    </div>
                                </>
                            )}

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