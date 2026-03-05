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

// Fix Leaflet unmount error during scroll wheel zoom
const originalGetMapPanePos = L.Map.prototype._getMapPanePos;
if (originalGetMapPanePos) {
    L.Map.prototype._getMapPanePos = function () {
        if (!this._mapPane) return L.point(0, 0);
        return originalGetMapPanePos.call(this);
    };
}

// Fix leaflet fast-unmount/interaction error
const originalSetPosition = L.DomUtil.setPosition;
if (originalSetPosition) {
    L.DomUtil.setPosition = function (el, point) {
        if (!el) return;
        return originalSetPosition.call(this, el, point);
    };
}
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { storage } from '@/lib/storage';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

import { Slider } from "@/components/ui/slider";
import { Loader2, Navigation, Locate, List, ChevronRight, X, BarChart3, Filter, MapPin, User, Shield, Layers, Flame, Home as HomeIcon, Calendar, DollarSign, Ruler, ArrowRight, RefreshCw, Zap } from 'lucide-react';
import { toast } from "sonner";
import { determineEffectiveStatus, isPointInPolygon } from '../components/logic/territoryLogic';
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
import GpsTracker, { GpsMapLayer as GpsTrackerMapLayers, GpsHud as GpsTrackerHud } from '../components/map/GpsTracker';
import QuickMarkButtons from '../components/rep/QuickMarkButtons';
import PropertyHistory from '../components/rep/PropertyHistory';
import ManagerPropertyDetailSheet from '../components/map/ManagerPropertyDetailSheet';
import MapDrawTool from '../components/map/MapDrawTool';
import TerritoryPrompt from '../components/map/TerritoryPrompt';
import ManagerMapLayers from '../components/map/ManagerMapLayers';
import MapToolbar from '../components/map/MapToolbar';

// Brand Colors
const BRAND = {
    voidBlack: '#0A0A0F', // Updated to new dark background
    gold: '#FFD93D',      // Updated Warning/Gold
    charcoal: '#12121A',  // Surface
    offWhite: '#F0F0F5',  // Text Primary
    primary: '#6C5CE7',
    success: '#00F5A0',
    danger: '#FF6B6B'
};

// Default Status colors matching Design System
const DEFAULT_STATUS_COLORS = {
    ELIGIBLE: '#404040', // Dark Gray (not knocked)
    SOLD: '#00F5A0',     // Neon Green (interested/closed)
    HARD_NO: '#FF6B6B',  // Soft Red (not interested)
    CALLBACK: '#FFD93D', // Gold (follow-ups)
    NO_ANSWER: '#404040',// Dark Gray
    QUALIFIED: '#00F5A0',// Neon Green
    OTHER: '#404040'     // Dark Gray
};

const COLOR_SCHEME_MAP = {
    default: DEFAULT_STATUS_COLORS,
    neon: { ELIGIBLE: '#00fff7', SOLD: '#39ff14', HARD_NO: '#ff073a', CALLBACK: '#ffed00', NO_ANSWER: '#00fff7', QUALIFIED: '#39ff14', OTHER: '#00fff7' },
    pastel: { ELIGIBLE: '#a8b8c8', SOLD: '#77dd77', HARD_NO: '#b39ddb', CALLBACK: '#fff176', NO_ANSWER: '#a8b8c8', QUALIFIED: '#77dd77', OTHER: '#a8b8c8' },
    heatmap: { ELIGIBLE: '#1e3a5f', SOLD: '#ff4500', HARD_NO: '#8b0000', CALLBACK: '#ff8c00', NO_ANSWER: '#1e3a5f', QUALIFIED: '#ff4500', OTHER: '#1e3a5f' },
    monochrome: { ELIGIBLE: '#555', SOLD: '#fff', HARD_NO: '#888', CALLBACK: '#bbb', NO_ANSWER: '#555', QUALIFIED: '#fff', OTHER: '#555' },
};

const LINE_DASH_MAP = {
    solid: null,
    dashed: '8,6',
    dotted: '2,4',
    dashdot: '10,4,2,4',
};

const ROUTE_COLORS = ['#FFD700', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#f97316', '#a855f7'];

import { LocationMarker, MapRefHandler, MapController } from '../components/map/MapHelpers';



export default function Home() {
    const queryClient = useQueryClient();
    const [activeRoute, setActiveRoute] = useState(null);
    const [activeRouteSoldFilter, setActiveRouteSoldFilter] = useState('all');
    const [showChecklist, setShowChecklist] = useState(false);

    const filteredActiveRoute = useMemo(() => {
        if (!activeRoute) return null;
        if (activeRouteSoldFilter === 'all') return activeRoute;

        const cutoff = subMonths(new Date(), parseInt(activeRouteSoldFilter));
        const filteredProps = activeRoute.properties.filter(p => {
            if (!p.sold_date) return false;
            try {
                return isAfter(parseISO(p.sold_date), cutoff);
            } catch (e) { return false; }
        });

        return {
            ...activeRoute,
            properties: filteredProps,
            houseCount: filteredProps.length
        };
    }, [activeRoute, activeRouteSoldFilter]);
    const [showRoutePanel, setShowRoutePanel] = useState(false);
    const [showCompare, setShowCompare] = useState(true);
    const [housesPerRoute, setHousesPerRoute] = useState(100);
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
    const [soldDateFilter, setSoldDateFilter] = useState(null); // null = All Time, number = months (Default: All Time)
    const [highlightRecentlySold, setHighlightRecentlySold] = useState(false);
    const [showAllProperties, setShowAllProperties] = useState(false);
    const [viewMode, setViewMode] = useState('pins'); // 'pins' or 'heatmap'
    const [mode, setModeRaw] = useState('generate'); // Default to generate mode
    const setMode = (newMode) => {
        setModeRaw(newMode);
        // Logic moved to useEffect to be smarter about when to open
    };
    const [showDashboard, setShowDashboard] = useState(false);
    const [drawingMode, setDrawingMode] = useState(false);
    const [drawnPolygon, setDrawnPolygon] = useState(null);
    const [draftPolygon, setDraftPolygon] = useState([]);
    const [drawShape, setDrawShape] = useState('circle');
    const [drawSizeMiles, setDrawSizeMiles] = useState(10);
    const [showTimingPanel, setShowTimingPanel] = useState(false);
    const [selectedProperty, setSelectedProperty] = useState(null);
    const [zoomLevel, setZoomLevel] = useState(15);
    const [showMapSettings, setShowMapSettings] = useState(false);
    const [navigationApp, setNavigationApp] = useState('apple');

    // Persisted Map Settings
    const [mapTheme, setMapTheme] = useState(() => localStorage.getItem('fk_mapTheme_v2') || 'satellite');
    const [showRouteDetails, setShowRouteDetails] = useState(() => {
        const saved = localStorage.getItem('fk_showRouteDetails_v2');
        return saved ? JSON.parse(saved) : true;
    });
    const [pinSize, setPinSize] = useState(() => {
        const saved = localStorage.getItem('fk_pinSize_v2');
        return saved ? JSON.parse(saved) : 5;
    });
    const [showRouteLines, setShowRouteLines] = useState(() => {
        const saved = localStorage.getItem('fk_showRouteLines_v2');
        return saved ? JSON.parse(saved) : true;
    });
    const [mapSettings, setMapSettings] = useState(() => {
        const saved = localStorage.getItem('fk_mapSettings_v3');
        return saved ? JSON.parse(saved) : {
            pinShape: 'circle',
            colorScheme: 'default',
            lineStyle: 'solid',
            lineWidth: 3,
            lineOpacity: 0.8,
            pinOpacity: 0.85,
            pinBorderWidth: 1,
            pinBorderColor: '#000',
            showLabels: false,
            labelType: 'number',
            glowEffect: false,
            fillStyle: 'solid',
        };
    });

    useEffect(() => {
        try {
            localStorage.setItem('fk_mapTheme_v2', mapTheme);
            localStorage.setItem('fk_showRouteDetails_v2', JSON.stringify(showRouteDetails));
            localStorage.setItem('fk_pinSize_v2', JSON.stringify(pinSize));
            localStorage.setItem('fk_showRouteLines_v2', JSON.stringify(showRouteLines));
            localStorage.setItem('fk_mapSettings_v3', JSON.stringify(mapSettings));
        } catch (e) {
            // Ignore quota errors in preview if any
        }
    }, [mapTheme, showRouteDetails, pinSize, showRouteLines, mapSettings]);
    const [darkRoomProperties] = useState([]);
    const [darkRoomClusters] = useState([]);
    const [fetchedProperties, setFetchedProperties] = useState([]); // Dynamic fetch storage
    const [templateName, setTemplateName] = useState("");
    const [gpsTracking, setGpsTracking] = useState(false);
    const [userLocation, setUserLocation] = useState(null); // {lat, lng} from Center on Me
    const [routeConfig, setRouteConfig] = useState({
        walkingPattern: 'street_sweep',
        minimizeTurns: true,
        use2Opt: true,
        returnToStart: false,
        excludeTerminal: true,
        includeCallbacks: true,
        excludeAssigned: true,
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

    const DarkRoomManager = () => null;

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
                    
                    // Chunk requests to avoid crashing the browser with too many concurrent requests
                    const zips = user.territory_zip_codes;
                    const chunkSize = 5;
                    let totalFetched = 0;
                    const MAX_PROPERTIES = 75000; // Increased limit to support larger drawn areas
                    
                    for (let i = 0; i < zips.length; i += chunkSize) {
                        if (totalFetched >= MAX_PROPERTIES) {
                            console.log(`[Home] Reached max property limit (${MAX_PROPERTIES}), skipping remaining zips.`);
                            break;
                        }
                        const chunk = zips.slice(i, i + chunkSize);
                        const promises = chunk.map(zip =>
                            base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 5000)
                        );
                        const results = await Promise.all(promises);
                        const newItems = results.flatMap(r => Array.isArray(r) ? r : (r.items || []));
                        items = [...items, ...newItems];
                        totalFetched += newItems.length;
                    }
                    
                    if (items.length > MAX_PROPERTIES) {
                        items = items.slice(0, MAX_PROPERTIES);
                    }
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
    }, [userProperties, localProperties, darkRoomProperties, fetchedProperties]);

    const { data: savedRoutesRaw = [] } = useQuery({
        queryKey: ['savedRoutes', user?.id],
        queryFn: () => {
            if (!user?.id) return [];
            return base44.entities.SavedRoute.filter({ manager_id: user.id }, '-created_date', 500);
        },
        enabled: !!user?.id
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

    const { data: leadScoringWeightsRaw = [] } = useQuery({
        queryKey: ['leadScoringWeights'],
        queryFn: () => base44.entities.LeadScoringWeights.list(),
    });
    const learnedWeights = leadScoringWeightsRaw[0]?.weights || null;

    // REAL-TIME UPDATES: Listen for interactions from other reps
    useEffect(() => {
        if (!user) return;
        const unsubscribe = base44.entities.InteractionLog.subscribe((event) => {
            if (event.type === 'create' || event.type === 'update') {
                // If the log wasn't created by us (to avoid double-updating our own optimistic writes)
                if (event.data && event.data.created_by !== user.email) {
                    queryClient.invalidateQueries({ queryKey: ['interactionLogs'] });
                    toast.info(`New interaction logged nearby!`, { duration: 2000, id: 'realtime-log' });
                }
            }
        });
        return unsubscribe;
    }, [user, queryClient]);

    // --- UBER-STYLE DISPATCH LOGIC ---
    // Helper: Haversine Distance (Miles)
    const calcDist = (lat1, lng1, lat2, lng2) => {
        if (!lat1 || !lng1 || !lat2 || !lng2) return 9999;
        const R = 3959; // Miles
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
            const repLogs = logs.filter(l => l.created_by === rep.email).sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
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
            }).sort((a, b) => b.matchScore - a.matchScore)[0];

            if (bestRep) {
                // Trigger save
                handleSaveRoute(route, bestRep.id, bestRep.name);
                tempBusyCounts[bestRep.id] = (tempBusyCounts[bestRep.id] || 0) + 1;
            }
        }
        setShowRoutePanel(false);
    };

    const createLogMutation = useMutation({
        mutationFn: (logData) => base44.entities.InteractionLog.create({
            ...logData,
            route_id: activeRoute?.id || null,
        }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['interactionLogs'] });
            queryClient.invalidateQueries({ queryKey: ['selectedPropertyHistory'] });
        },
    });

    // Process ALL properties with territory filter
    const effectiveProperties = useMemo(() => {
        const propsArray = Array.isArray(properties) ? properties : (properties?.items || []);
        const territoryZips = [...(user?.territory_zip_codes || []), ...(user?.generated_zip_codes || [])];
        const hasActivePolygon = !!(drawnPolygon && drawnPolygon.length > 2);
        const hasExplicitZipFilter = !!(zipCodeFilter && zipCodeFilter.trim());
        const applyTerritoryFilter = territoryZips.length > 0 && !hasActivePolygon && !hasExplicitZipFilter;

        return propsArray
            .filter(p => {
                if (!p?.lat || !p?.lng || isNaN(p.lat) || isNaN(p.lng)) return false;
                // Filter out Null Island (0,0) coordinates
                if (Math.abs(p.lat) < 0.0001 && Math.abs(p.lng) < 0.0001) return false;

                // Apply territory filter only when appropriate (not when polygon/explicit zips are active)
                if (applyTerritoryFilter) {
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
    }, [properties, logs, user?.territory_zip_codes, user?.generated_zip_codes, zipCodeFilter, drawnPolygon]);

    // Smart Auto-Open/Close for Generate Mode
    useEffect(() => {
        if (mode === 'generate') {
            // If we have NO data AND NO polygon, ensure settings are closed so user sees the "Zero State" (TerritoryPrompt)
            // But if we have a polygon, we might be fetching or about to, so don't force close
            if (effectiveProperties.length === 0 && (!drawnPolygon || drawnPolygon.length === 0)) {
                setShowCompare(false);
            }
        }
    }, [mode, effectiveProperties.length === 0, drawnPolygon]); // Dependency on "has properties" or polygon state change

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
        const toastId = toast.loading("Building routes...", { id: 'build-routes' });

        try {
            // 1. DYNAMIC DATA FETCHING (if zip code is set)
            let dynamicProps = [];
            if (zipCodeFilter && zipCodeFilter.trim()) {
                const targetZips = zipCodeFilter.split(',').map(z => z.trim()).filter(Boolean);

                const isPaid = user?.subscription_status === 'active' || user?.subscription_status === 'trialing';
                const isOwner = user?.is_owner === true || user?.email?.toLowerCase().includes('christian');
                const zipLimit = isOwner ? 999 : (isPaid ? 10 : 3);
                const generatedZips = user?.generated_zip_codes || [];
                const newZips = targetZips.filter(z => !generatedZips.includes(z));

                if (generatedZips.length + newZips.length > zipLimit) {
                    toast.error(isPaid 
                        ? `Limit reached (${zipLimit} zips). Add seats for more.` 
                        : `Free limit is 3 zips. Upgrade for more.`, { id: 'build-routes' });
                    if (!isPaid) {
                        setTimeout(() => { window.location.href = '/Billing'; }, 2000);
                    }
                    setRoutesGenerating(false);
                    return;
                }

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

                // If no properties found, pull from RentCast via backend
                if (flattened.length === 0) {
                    console.log(`[Generate] No properties found for ${targetZips.join(', ')}. Fetching from RentCast...`);
                    toast.loading("Pulling property data...", { id: 'fetch-zip' });

                    let hitLimit = false;
                    for (const zip of targetZips) {
                        try {
                            const res = await base44.functions.invoke('fetchZipProperties', { zip_code: zip });
                            console.log(`[Generate] Fetch result for ${zip}:`, res.data);
                            if (res.data?.error) {
                                toast.error(res.data.message || res.data.error, { id: 'fetch-zip' });
                                hitLimit = true;
                                break;
                            }
                        } catch (err) {
                            console.warn(`Failed to fetch zip ${zip}`, err);
                            const errData = err?.response?.data;
                            if (errData?.error?.includes('limit')) {
                                toast.error(errData.message || 'Zip code limit reached. Upgrade your plan.', { id: 'fetch-zip' });
                                hitLimit = true;
                                break;
                            }
                        }
                    }

                    if (hitLimit && !isPaid) {
                        setTimeout(() => { window.location.href = '/Billing'; }, 2000);
                        setRoutesGenerating(false);
                        return;
                    }

                    toast.success("Data synced!", { id: 'fetch-zip' });

                    // Re-fetch after import
                    const retryPromises = targetZips.map(zip =>
                        base44.entities.MasterProperty.filter({ zip_code: zip }, '-created_date', 5000)
                            .then(res => Array.isArray(res) ? res : (res?.items || []))
                            .catch(() => [])
                    );
                    const retryResults = await Promise.all(retryPromises);
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
                (routeConfig.excludeAssigned === false || !assignedSet.has(p.address_hash)) &&
                p.lat && p.lng &&
                !(Math.abs(p.lat) < 0.0001 && Math.abs(p.lng) < 0.0001)
            );

            // Merge with existing availableProperties, deduping by address_hash
            const combinedMap = new Map();
            const baseProps = routeConfig.excludeAssigned === false ? effectiveProperties : availableProperties;
            baseProps.forEach(p => combinedMap.set(p.address_hash, p));
            processedDynamic.forEach(p => combinedMap.set(p.address_hash, p));

            let workingSet = Array.from(combinedMap.values());

            // 3. FILTERING
            let targetZips = [];
            if (zipCodeFilter && zipCodeFilter.trim()) {
                targetZips = zipCodeFilter.split(',').map(z => z.trim()).filter(Boolean);
            } else if (!(drawnPolygon && drawnPolygon.length > 2) && user?.territory_zip_codes?.length > 0) {
                targetZips = user.territory_zip_codes;
            }

            if (targetZips.length > 0) {
                workingSet = workingSet.filter(p => {
                    const pZip = String(p.zip_code || '').trim().slice(0, 5);
                    return targetZips.includes(pZip);
                });
            }

            // Apply Polygon Filter (Drawn Area)
            if (drawnPolygon && drawnPolygon.length > 2) {
                workingSet = workingSet.filter(p => isPointInPolygon({ lat: p.lat, lng: p.lng }, drawnPolygon));
            }

            const beforeSoldDateFilter = workingSet.length;
            const preSoldWorkingSet = workingSet.slice();

            // Apply Sold Date Filter (STRICT: If filter active, MUST have sold_date within range)
            if (soldDateFilter !== null) {
                workingSet = workingSet.filter(p => {
                    if (!p.sold_date) return false;
                    try {
                        const date = parseISO(p.sold_date);
                        const cutoff = subMonths(new Date(), soldDateFilter);
                        return isAfter(date, cutoff);
                    } catch (e) { return false; }
                });
            }

            if (soldDateFilter !== null && beforeSoldDateFilter > 0 && workingSet.length === 0) {
                toast.error(`No homes match "Sold in last ${soldDateFilter} months" with current filters.`);
                setRoutesGenerating(false);
                return;
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
                toast.error("No properties found with current filters/area.", { id: 'build-routes' });
                setRoutesGenerating(false);
                return;
            }

            // 4. UI UPDATES (Keep Builder available & Move Map)
            setShowCompare(true);

            if (mapRef.current && workingSet.length > 0) {
                const bounds = L.latLngBounds(workingSet.map(p => [p.lat, p.lng]));
                if (bounds.isValid()) {
                    try { if (mapRef.current._mapPane) mapRef.current.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 }); } catch (e) { }
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
                    excludeTerminal: routeConfig.excludeTerminal,
                },
                learnedWeights
            );

            if (generated._cooldownInfo) {
                setCooldownInfo(generated._cooldownInfo);
            }

            setRoutes(generated);
            setShowRoutePanel(true);
            setShowCompare(false); // Close builder to see the map
            toast.success(`Built ${generated.length} route${generated.length === 1 ? '' : 's'}`, { id: 'build-routes' });

        } catch (e) {
            console.error("Route generation error:", e);
            alert("An error occurred while generating routes.");
        } finally {
            setRoutesGenerating(false);
        }
    }, [availableProperties, housesPerRoute, startLocation, logs, streetCooldownDays, zipCodeFilter, assignedHashes, routeConfig, maxRouteDistance, soldDateFilter, drawnPolygon]);

    // Filter and sort routes
    const filteredRoutes = useMemo(() => {
        let filtered = routes.filter(r => r.competitivenessScore >= minScore);
        if (sortBy === 'score') {
            filtered.sort((a, b) => b.competitivenessScore - a.competitivenessScore);
        } else if (sortBy === 'houses') {
            filtered.sort((a, b) => b.houseCount - a.houseCount);
        } else if (sortBy === 'distance') {
            filtered.sort((a, b) => a.totalDistance - b.totalDistance);
        } else if (sortBy === 'recent_sale') {
            // Sort by the presence and recency of sold dates within the route's properties
            filtered.sort((a, b) => {
                const getLatestSale = (route) => {
                    let latest = 0;
                    route.properties.forEach(p => {
                        if (p.sold_date) {
                            try {
                                const dt = new Date(p.sold_date).getTime();
                                if (dt > latest) latest = dt;
                            } catch (e) { }
                        }
                    });
                    return latest;
                };
                return getLatestSale(b) - getLatestSale(a);
            });
        }
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
        if (filteredActiveRoute?.properties?.length > 0) {
            return filteredActiveRoute.properties
                .filter(p => p && p.lat !== undefined && p.lng !== undefined)
                .map(p => [p.lat, p.lng]);
        }
        if (availableProperties?.length > 0) {
            return availableProperties
                .slice(0, 1000)
                .filter(p => p && p.lat !== undefined && p.lng !== undefined)
                .map(p => [p.lat, p.lng]);
        }
        return null;
    }, [filteredActiveRoute, availableProperties]);

    // Initial Fit Effect
    const hasCenteredRef = useRef(false);
    useEffect(() => {
        if (availableProperties.length > 0 && !hasCenteredRef.current && mapRef.current) {
            const bounds = L.latLngBounds(availableProperties.slice(0, 1000).map(p => [p.lat, p.lng]));
            if (bounds.isValid()) {
                try { if (mapRef.current._mapPane) mapRef.current.fitBounds(bounds, { padding: [50, 50], maxZoom: 16, animate: false }); } catch (e) { }
                hasCenteredRef.current = true;
            }
        }
    }, [availableProperties]);

    // Determine Map Center
    const [mapCenter, setMapCenter] = useState([34.0522, -118.2437]); // Default LA

    useEffect(() => {
        const updateCenter = async () => {
            if (filteredActiveRoute?.properties?.length > 0) {
                // Active route takes priority
                return;
            }

            if (availableProperties[0] && availableProperties[0].lat) {
                setMapCenter([availableProperties[0].lat, availableProperties[0].lng]);
            }
        };
        updateCenter();
    }, [filteredActiveRoute, availableProperties, user?.working_area]);

    const center = availableProperties[0] && availableProperties[0].lat ? [availableProperties[0].lat, availableProperties[0].lng] : mapCenter;

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
            gps_proof_lng: property.lng,
            route_id: activeRoute?.id || null
        });
    }, [createLogMutation, activeRoute]);

    const generateRoutesRef = useRef(generateRoutes);
    useEffect(() => {
        generateRoutesRef.current = generateRoutes;
    }, [generateRoutes]);

    const [pendingAutoGenerate, setPendingAutoGenerate] = useState(false);

    // Callback for when area pull is complete (from TerritoryPrompt)
    const handleAreaPullComplete = useCallback(async () => {
        console.log('[Home] Area pull complete, updating state...');

        // Refresh data first
        try {
            await queryClient.invalidateQueries({ queryKey: ['masterProperties'] });
            await queryClient.invalidateQueries({ queryKey: ['user'] });
        } catch (e) {
            console.error("Error refreshing data:", e);
        }

        // Open the Route Builder (Generate tab) after a successful area fetch
        // Small delay to ensure the properties filter has updated and won't trigger the auto-close
        setTimeout(() => {
            localStorage.setItem('fk_autobuild_next_open', 'true');
            setMode('generate');
            setShowCompare(true);
            console.log('[Home] Opening Route Builder after pull');
        }, 300);
    }, [queryClient, setMode]);

    // Run auto generation when data is fresh
    useEffect(() => {
        // Auto-generation disabled here to prioritize opening the Builder panel after fetch
    }, [pendingAutoGenerate]);

    // Dynamic status colors based on selected color scheme
    const STATUS_COLORS = useMemo(() => {
        return COLOR_SCHEME_MAP[mapSettings.colorScheme] || DEFAULT_STATUS_COLORS;
    }, [mapSettings.colorScheme]);

    // Compute line dash array from settings
    const lineDashArray = mapSettings.lineStyle === 'solid' ? undefined : (LINE_DASH_MAP[mapSettings.lineStyle] || '8,6');

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
                preferCanvas={true}
            >
                <MapRefHandler mapRef={mapRef} />
                <TileLayer
                    key={`basemap-${mapTheme}`}
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
                {(mapTheme === 'hybrid' || mapTheme === 'satellite') && (
                    <TileLayer
                        key={`basemap-labels-${mapTheme}`}
                        url="https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png"
                        attribution=""
                        zIndex={100}
                    />
                )}
                <LocationMarker autoCenter={availableProperties.length === 0} userLocation={userLocation} />
                <DarkRoomManager />
                <MapController
                    fitBounds={fitBounds}
                    onZoomChange={setZoomLevel}
                    onMoveEnd={() => { }}
                />

                <MapDrawTool
                    active={drawingMode}
                    onPointsUpdate={setDraftPolygon}
                    drawnPolygon={drawnPolygon}
                    drawShape={drawShape}
                    drawSizeMiles={drawSizeMiles}
                />

                {/* All map data layers extracted to ManagerMapLayers */}
                <ManagerMapLayers
                    mode={mode}
                    activeRoute={filteredActiveRoute}
                    zoomLevel={zoomLevel}
                    viewMode={viewMode}
                    hydratedSavedRoutes={hydratedSavedRoutes}
                    filteredRoutes={filteredRoutes}
                    ROUTE_COLORS={ROUTE_COLORS}
                    effectiveProperties={effectiveProperties}
                    darkRoomProperties={darkRoomProperties}
                    darkRoomClusters={darkRoomClusters}
                    heatmapData={heatmapData}
                    previewRoute={previewRoute}
                    analyzeZipFilter={analyzeZipFilter}
                    quickFilter={quickFilter}
                    zipCodeFilter={zipCodeFilter}
                    soldDateFilter={soldDateFilter}
                    drawnPolygon={drawnPolygon}
                    assignedHashes={assignedHashes}
                    showAllProperties={showAllProperties}
                    showRouteDetails={showRouteDetails}
                    showRouteLines={showRouteLines}
                    highlightRecentlySold={highlightRecentlySold}
                    mapSettings={mapSettings}
                    pinSize={pinSize}
                    lineDashArray={lineDashArray}
                    STATUS_COLORS={STATUS_COLORS}
                    repColors={repColors}
                    BRAND={BRAND}
                    setActiveRoute={setActiveRoute}
                    setSelectedProperty={setSelectedProperty}
                    mapRef={mapRef}
                    isPointInPolygon={isPointInPolygon}
                    getHeatColor={getHeatColor}
                    parseISO={parseISO}
                    subMonths={subMonths}
                    isAfter={isAfter}
                    darkRoom={darkRoom}
                />

                {/* GPS TRACKER LAYERS */}
                <GpsTrackerMapLayers
                    properties={effectiveProperties}
                    isTracking={gpsTracking}
                    onSelectProperty={setSelectedProperty}
                />
            </MapContainer>

            {/* Map UI Overlays extracted to MapToolbar */}
            <MapToolbar
                mode={mode}
                setMode={setMode}
                activeRoute={filteredActiveRoute}
                setActiveRoute={setActiveRoute}
                routesGenerating={routesGenerating}
                setShowDashboard={setShowDashboard}
                setShowMapSettings={setShowMapSettings}
                setShowCompare={setShowCompare}
                setShowRoutePanel={setShowRoutePanel}
                setShowChecklist={setShowChecklist}
                teamMembers={teamMembers}
                hydratedSavedRoutes={hydratedSavedRoutes}
                routes={routes}
                filteredRoutes={filteredRoutes}
                fitBounds={fitBounds}
                repColors={repColors}
                user={user}
                mapRef={mapRef}
                setUserLocation={setUserLocation}
                handleAssignRoute={handleAssignRoute}
                BRAND={BRAND}
                activeRouteSoldFilter={activeRouteSoldFilter}
                setActiveRouteSoldFilter={setActiveRouteSoldFilter}
            />

            <TerritoryPrompt
                mode={mode}
                setMode={setMode}
                activeRoute={filteredActiveRoute}
                routesGenerating={routesGenerating}
                showCompare={showCompare}
                setShowCompare={setShowCompare}
                showRoutePanel={showRoutePanel}
                setShowRoutePanel={setShowRoutePanel}
                drawingMode={drawingMode}
                setDrawingMode={setDrawingMode}
                drawnPolygon={drawnPolygon}
                setDrawnPolygon={setDrawnPolygon}
                draftPolygon={draftPolygon}
                setDraftPolygon={setDraftPolygon}
                drawShape={drawShape}
                setDrawShape={setDrawShape}
                drawSizeMiles={drawSizeMiles}
                setDrawSizeMiles={setDrawSizeMiles}
                user={user}
                setZipCodeFilter={setZipCodeFilter}
                onPullComplete={handleAreaPullComplete}
            />



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
                    onDeleteAllRoutes={async () => {
                        try {
                            const ids = hydratedSavedRoutes.map(r => r.id);
                            if (ids.length > 0) {
                                await Promise.all(ids.map(id => base44.entities.SavedRoute.delete(id)));
                                queryClient.invalidateQueries({ queryKey: ['savedRoutes'] });
                                if (activeRoute && ids.includes(activeRoute.id)) {
                                    setActiveRoute(null);
                                }
                                toast.success("All saved routes deleted");
                            }
                        } catch (e) {
                            toast.error("Failed to delete routes");
                        }
                    }}
                    onDeleteRoute={async (route) => {
                        if (confirm(`Delete route "${route.name}"?`)) {
                            try {
                                await base44.entities.SavedRoute.delete(route.id);
                                queryClient.invalidateQueries({ queryKey: ['savedRoutes'] });
                                if (activeRoute && activeRoute.id === route.id) {
                                    setActiveRoute(null);
                                }
                                toast.success("Route deleted");
                            } catch (e) {
                                toast.error("Failed to delete route");
                            }
                        }
                    }}
                    onReplaceRoutes={(newRoutes) => setRoutes(newRoutes)}
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

                                {/* Sold Date Filter moved to Map Settings Panel */}

                                <div>
                                    <label className="text-xs font-bold tracking-wide mb-3 block" style={{ color: BRAND.offWhite }}>
                                        <Filter className="w-3 h-3 inline mr-1" /> SORT BY
                                    </label>
                                    <div className="flex gap-2 flex-wrap">
                                        {[{ id: 'score', label: 'SCORE' }, { id: 'houses', label: 'HOUSES' }, { id: 'distance', label: 'DISTANCE' }, { id: 'recent_sale', label: 'RECENT SALE' }].map(opt => (
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
                    onDraw={() => {
                        setShowCompare(false);
                        setDrawingMode(true);
                    }}
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
                        if (confirm("Reset all generated routes?")) {
                            setRoutes([]);
                            setFetchedProperties([]);
                            setDrawnPolygon(null); // Clear polygon on reset
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
                            if (res.data?.error) {
                                toast.error(res.data.message || res.data.error, { id: toastId });
                                const isPaid = user?.subscription_status === 'active' || user?.subscription_status === 'trialing';
                                if (!isPaid) {
                                    setTimeout(() => { window.location.href = '/Billing'; }, 2000);
                                }
                                return;
                            }
                            if (res.data.count > 0) {
                                toast.success(`Synced ${res.data.count} new properties!`, { id: toastId });
                                queryClient.invalidateQueries({ queryKey: ['masterProperties'] });
                            } else {
                                toast.info(res.data.message || "Up to date", { id: toastId });
                            }
                        } catch (e) { 
                            const errData = e?.response?.data;
                            if (errData?.error?.includes('limit')) {
                                toast.error(errData.message || 'Zip code limit reached. Upgrade your plan.', { id: toastId });
                                const isPaid = user?.subscription_status === 'active' || user?.subscription_status === 'trialing';
                                if (!isPaid) {
                                    setTimeout(() => { window.location.href = '/Billing'; }, 2000);
                                }
                            } else {
                                toast.error("Sync failed", { id: toastId }); 
                            }
                        }
                    }}
                    onClearArea={async () => {
                        if (!confirm(`DELETE ALL properties in zip ${zipCodeFilter}?`)) return;
                        const toastId = toast.loading("Deleting...");
                        try {
                            const res = await base44.functions.invoke('cleanupDatabase', { action: 'cleanup', zip_code: zipCodeFilter });
                            toast.success(`Deleted ${res.data.deleted} properties`, { id: toastId });
                            queryClient.invalidateQueries({ queryKey: ['masterProperties'] });
                        } catch (e) { toast.error("Failed", { id: toastId }); }
                    }}
                    user={user}
                    hasDrawnArea={drawnPolygon && drawnPolygon.length > 2}
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
            {showChecklist && filteredActiveRoute && (
                <div className="fixed inset-0 z-[2000]">
                    <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowChecklist(false)} />
                    <div
                        className="absolute top-0 right-0 bottom-0 w-full max-w-lg overflow-hidden shadow-2xl animate-in slide-in-from-right duration-300"
                        style={{ background: 'transparent' }}
                    >
                        <RouteChecklist
                            route={filteredActiveRoute}
                            logs={logs}
                            onLogResult={handleLogResult}
                            onClose={() => setShowChecklist(false)}
                            navigationApp={navigationApp}
                            activeRouteSoldFilter={activeRouteSoldFilter}
                            setActiveRouteSoldFilter={setActiveRouteSoldFilter}
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
                    showAllProperties={showAllProperties}
                    setShowAllProperties={setShowAllProperties}
                    navigationApp={navigationApp}
                    setNavigationApp={updateNavigationApp}
                    pinSize={pinSize}
                    setPinSize={setPinSize}
                    showRouteLines={showRouteLines}
                    setShowRouteLines={setShowRouteLines}
                    mapSettings={mapSettings}
                    setMapSettings={setMapSettings}
                    soldDateFilter={soldDateFilter}
                    setSoldDateFilter={setSoldDateFilter}
                    highlightRecentlySold={highlightRecentlySold}
                    setHighlightRecentlySold={setHighlightRecentlySold}
                    onRequestGenerate={generateRoutes}
                />
            )}

            <ManagerPropertyDetailSheet
                selectedProperty={selectedProperty}
                setSelectedProperty={setSelectedProperty}
                STATUS_COLORS={STATUS_COLORS}
                navigationApp={navigationApp}
                selectedPropertyLogs={selectedPropertyLogs}
                handleLogResult={handleLogResult}
                toast={toast}
            />
        </div>
    );
}