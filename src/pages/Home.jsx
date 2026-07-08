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
import { format, subMonths, subDays, isAfter, parseISO } from 'date-fns';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { generateOptimizedRoutes, optimizeRouteByDistance } from '../components/logic/routeOptimizer';
import { applyRouteFilters, formatStageCounts } from '../components/logic/routeFilterPipeline';
import RouteGenerationOverlay from '../components/routes/RouteGenerationOverlay';
import { generateHeatmapGrid, generateStateClusters, getHeatColor } from '../components/logic/heatmapLogic';
const RouteChecklist = React.lazy(() => import('../components/routes/RouteChecklist'));
import RouteCommandPanel from '../components/routes/RouteCommandPanel';
import KnockTimeBanner from '../components/timing/KnockTimeBanner';
// MarketSetupPrompt removed — onboarding handled by MarketOnboarding + TerritoryPrompt
import TerritoryPrompt from '../components/map/TerritoryPrompt';
import { darkRoom, DarkRoomClient } from '@/components/logic/neonClient';
const CommandCenterDashboard = React.lazy(() => import('../components/dashboard/CommandCenterDashboard'));
const MapSettingsPanel = React.lazy(() => import('../components/map/MapSettingsPanel'));
import RouteBuilderSettings from '../components/map/RouteBuilderSettings';
const TerritorySetupWizard = React.lazy(() => import('../components/manager/TerritorySetupWizard'));
import { LayoutDashboard, Settings, Crosshair } from 'lucide-react';
import { openInMaps } from '../components/logic/navigation';
import { hydrateRoutesForMap } from '@/components/logic/routeHydration';
import GpsTracker, { GpsMapLayer as GpsTrackerMapLayers, GpsHud as GpsTrackerHud } from '../components/map/GpsTracker';
import QuickMarkButtons from '../components/rep/QuickMarkButtons';
import PropertyHistory from '../components/rep/PropertyHistory';
import ManagerPropertyDetailSheet from '../components/map/ManagerPropertyDetailSheet';
import MapDrawTool from '../components/map/MapDrawTool';
import ManagerMapLayers from '../components/map/ManagerMapLayers';
import MapToolbar from '../components/map/MapToolbar';
import ZipCodeOverlay from '../components/map/ZipCodeOverlay';
import PolygonHistory, { savePolygonToHistory } from '../components/map/PolygonHistory';
import KnockLimitSheet from '@/components/upgrade/KnockLimitSheet';
import { getOutcomesLogged, isOutcomeBlocked, isProUser, needsCardOnFile } from '@/components/upgrade/knockGate';


import { BRAND, DEFAULT_STATUS_COLORS, COLOR_SCHEME_MAP, LINE_DASH_MAP, ROUTE_COLORS } from '../components/map/homeMapConstants';

import { LocationMarker, MapRefHandler, MapController } from '../components/map/MapHelpers';
import useViewportMapProperties from '../components/map/useViewportMapProperties';

function normalizeHistoryPolygon(value) {
    if (!Array.isArray(value)) return [];
    let points = value;
    if (Array.isArray(points[0]) && Array.isArray(points[0][0])) {
        points = points[0];
    }

    return points.map((point) => {
        if (Array.isArray(point)) {
            const lng = Number(point[0]);
            const lat = Number(point[1]);
            return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
        }
        const lat = Number(point?.lat ?? point?.latitude);
        const lng = Number(point?.lng ?? point?.lon ?? point?.longitude);
        return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    }).filter(Boolean);
}

function polygonHistoryKey(polygon = []) {
    const first = polygon[0] || {};
    return `${Number(first.lat || 0).toFixed(5)}:${Number(first.lng || 0).toFixed(5)}:${polygon.length}`;
}

function getRouteHistoryPolygon(route) {
    return normalizeHistoryPolygon(
        route?.metadata?.precision_area?.polygon ||
        route?.metadata?.drawn_polygon ||
        route?.metadata?.polygon ||
        route?.precision_area?.polygon ||
        route?.polygon
    );
}

function getFetchJobHistoryPolygon(job) {
    return normalizeHistoryPolygon(
        job?.polygon ||
        job?.metadata?.polygon ||
        job?.request?.polygon ||
        job?.request_payload?.polygon ||
        job?.input?.polygon ||
        job?.searchCriteria?.address?.geoLocationPolygon?.geoPoints ||
        job?.request?.searchCriteria?.address?.geoLocationPolygon?.geoPoints ||
        job?.request_payload?.searchCriteria?.address?.geoLocationPolygon?.geoPoints
    );
}

function getPrecisionJobId(jobStatus = {}) {
    return jobStatus?.job_id || jobStatus?.fetch_job_id || jobStatus?.id || jobStatus?.jobId || null;
}

function getRequestedPrecisionCount(jobStatus = {}) {
    const diagnostics = jobStatus?.diagnostics || {};
    const value =
        diagnostics.requested_properties_before_cap ||
        diagnostics.requested_properties ||
        jobStatus?.requested_properties ||
        jobStatus?.total_expected ||
        jobStatus?.active_count;
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.round(count) : null;
}

function precisionCandidateRank(property) {
    const score = Number(property?.score ?? property?.competitivenessScore ?? 0) || 0;
    const price = Number(property?.price ?? property?.sale_price ?? 0) || 0;
    const soldTime = property?.sold_date ? new Date(property.sold_date).getTime() : 0;
    return (score * 1000000000000) + (Number.isFinite(soldTime) ? soldTime : 0) + Math.min(price, 10000000);
}

function buildPrecisionRouteShortfallMessage({ requested, routed, filtered }) {
    if (!requested || routed >= requested) return '';
    const missing = requested - routed;
    const filterText = filtered > 0 ? ` ${filtered.toLocaleString()} were removed by saved-route or route filters.` : '';
    return `Built ${routed.toLocaleString()} of ${requested.toLocaleString()} requested homes from this exact area. FirstKnock only routes unique single-family homes that survive the current filters.${filterText} Draw a wider nearby area or loosen value/date filters to fill the remaining ${missing.toLocaleString()}.`;
}



export default function Home() {
    const queryClient = useQueryClient();
    const [activeRoute, setActiveRoute] = useState(null);
    const [activeRouteSoldFilter, setActiveRouteSoldFilter] = useState('all');
    const [activeRoutePriceFilter, setActiveRoutePriceFilter] = useState('all');
    const [showChecklist, setShowChecklist] = useState(false);

    const filteredActiveRoute = useMemo(() => {
        if (!activeRoute) return null;
        const hD = activeRouteSoldFilter !== 'all', hPr = activeRoutePriceFilter !== 'all';
        if (!hD && !hPr) return activeRoute;
        let fp = activeRoute.properties;
        if (hD) { let c; if (activeRouteSoldFilter === '0.25') c = subDays(new Date(), 7); else if (activeRouteSoldFilter === '0.5') c = subDays(new Date(), 14); else c = subMonths(new Date(), Number(activeRouteSoldFilter)); fp = fp.filter(p => { if (!p.sold_date) return false; try { const d = new Date(p.sold_date); return !isNaN(d.getTime()) && isAfter(d, c); } catch { return false; } }); }
        if (hPr) { const min = Number(activeRoutePriceFilter); fp = fp.filter(p => { const v = Number(p.price ?? p.sale_price); return Number.isFinite(v) && v > 0 && v >= min; }); }
        return { ...activeRoute, _originalId: activeRoute.id, properties: fp, houseCount: fp.length };
    }, [activeRoute, activeRouteSoldFilter, activeRoutePriceFilter]);

    const [showRoutePanel, setShowRoutePanel] = useState(false);
    const [showCompare, setShowCompare] = useState(false);
    const [routes, setRoutes] = useState([]);
    const [housesPerRoute, setHousesPerRoute] = useState(10000); // Default: All-in-One route
    const ROUTE_SIZE_OPTIONS = [25, 50, 75, 100];
    const [sortBy, setSortBy] = useState('score'); // score, houses, distance
    const [minScore, setMinScore] = useState(0); // Default All Scores
    const [quickFilter, setQuickFilter] = useState('all'); // all, eligible, sold, rejected
    const [repFilter, setRepFilter] = useState('all');
    const [previewRoute, setPreviewRoute] = useState(null);
    const [startLocation, setStartLocation] = useState(null); // { lat, lng, address }
    const [startAddressInput, setStartAddressInput] = useState("");
    const [zipCodeFilter, setZipCodeFilter] = useState(''); // Comma separated string
    const [analyzeZipFilter, setAnalyzeZipFilter] = useState('all'); // Filter for Analyze mode
    const [soldDateFilter, setSoldDateFilterRaw] = useState(12);
    const setSoldDateFilter = (val) => { setSoldDateFilterRaw(val); setFrozenWorkingSet(null); }; // Clear frozen on filter change
    const [lastPullMode, setLastPullMode] = useState(null);
    const [maxDataMonths, setMaxDataMonths] = useState(() => { try { return parseInt(localStorage.getItem('fk_maxDataMonths')) || null; } catch { return null; } });
    const [hasMlsData, setHasMlsData] = useState(() => { try { return localStorage.getItem('fk_hasMlsData') === 'true'; } catch { return false; } });
    const [currentBatchDataJobId, setCurrentBatchDataJobId] = useState(null);
    const currentBatchDataJobIdRef = useRef(null);
    const currentBatchDataSoldMonthsRef = useRef(null);
    const currentBatchDataRequestedCountRef = useRef(null);
    const currentBatchDataPolygonRef = useRef(null);
    const [highlightRecentlySold, setHighlightRecentlySold] = useState(false);
    const [showAllProperties, setShowAllProperties] = useState(false);
    const [viewMode, setViewMode] = useState('pins'); // 'pins' or 'heatmap'
    const [mode, setModeRaw] = useState('analyze'); // Default to routes mode
    const setMode = (newMode) => {
        setModeRaw(newMode);
        // Logic moved to useEffect to be smarter about when to open
    };
    const [showDashboard, setShowDashboard] = useState(false);
    const [drawingMode, setDrawingMode] = useState(false);
    const [drawnPolygon, setDrawnPolygonRaw] = useState(() => {
        try {
            const saved = localStorage.getItem('fk_drawnPolygon');
            return saved ? JSON.parse(saved) : null;
        } catch { return null; }
    });
    const setDrawnPolygon = (val, persist = false) => {
        setDrawnPolygonRaw(val);
        try {
            if (persist && val && val.length > 2) {
                localStorage.setItem('fk_drawnPolygon', JSON.stringify(val));
            } else if (!val || val.length < 3) {
                localStorage.removeItem('fk_drawnPolygon');
            }
        } catch { }
    };
    const [draftPolygon, setDraftPolygon] = useState([]);
    const [drawShape, setDrawShape] = useState('circle');
    const [drawSizeMiles, setDrawSizeMiles] = useState(5);
    const [showTimingPanel, setShowTimingPanel] = useState(false);
    const [selectedProperty, setSelectedProperty] = useState(null);
    const [zoomLevel, setZoomLevel] = useState(15);
    const [showMapSettings, setShowMapSettings] = useState(false);
    const [showZipOverlay, setShowZipOverlay] = useState(false);
    const [navigationApp, setNavigationApp] = useState('apple');

    // Persisted Map Settings
    const [mapTheme, setMapTheme] = useState(() => localStorage.getItem('fk_mapTheme_v2') || 'satellite');
    const [showRouteDetails, setShowRouteDetails] = useState(() => {
        const saved = localStorage.getItem('fk_showRouteDetails_v2');
        return saved ? JSON.parse(saved) : true;
    });
    const [pinSize, setPinSize] = useState(() => {
        const saved = localStorage.getItem('fk_pinSize_v2');
        return saved ? JSON.parse(saved) : 4;
    });
    const [showRouteLines, setShowRouteLines] = useState(() => {
        const saved = localStorage.getItem('fk_showRouteLines_v2');
        return saved ? JSON.parse(saved) : true;
    });
    const [routeStatusView, setRouteStatusView] = useState(() => {
        try { return localStorage.getItem('fk_routeStatusView') || 'active'; } catch { return 'active'; }
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
            localStorage.setItem('fk_routeStatusView', routeStatusView);
            localStorage.setItem('fk_mapSettings_v3', JSON.stringify(mapSettings));
        } catch (e) {
            // Ignore quota errors in preview if any
        }
    }, [mapTheme, showRouteDetails, pinSize, showRouteLines, routeStatusView, mapSettings]);
    const [darkRoomProperties] = useState([]);
    const [darkRoomClusters] = useState([]);
    const [fetchedProperties, setFetchedProperties] = useState([]); // Dynamic fetch storage
    const [templateName, setTemplateName] = useState("");
    const [gpsTracking, setGpsTracking] = useState(false);
    const [userLocation, setUserLocation] = useState(null); // {lat, lng} from Center on Me
    const [gpsInitialLocation, setGpsInitialLocation] = useState(null); // GPS on first load
    const [routeConfig, setRouteConfig] = useState({
        walkingPattern: 'street_sweep',
        minimizeTurns: true,
        use2Opt: true,
        returnToStart: false,
        excludeTerminal: true,
        includeCallbacks: true,
        excludeAssigned: true,
        excludeCommercial: true,
        excludeCondos: true,
        excludePreviouslyKnocked: true,
        excludeLand: true,
        propertyTypes: ['Single Family'],
        minPrice: null,
        maxPrice: null,
        minYearBuilt: null,
        maxYearBuilt: null,
        includeUnverifiedSales: false,
    });
    const mapRef = useRef(null);
    const appointmentMapFocusHandledRef = useRef(false);
    const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me(), staleTime: 1000 * 60 * 5 });
    const [showKnockLimitSheet, setShowKnockLimitSheet] = useState(false);
    const [knockGateMode, setKnockGateMode] = useState('limit');

    const fetchRouteCandidatesFromNeon = useCallback(async ({ zipCodes = [], zipCodeFilterValue = '', soldMonths = null, polygon = null, limit = 100000, fetchJobId = null } = {}) => {
        const res = await base44.functions.invoke('getRouteCandidatesFromNeon', {
            zip_codes: zipCodes,
            zip_code_filter: zipCodeFilterValue,
            sold_months: soldMonths,
            polygon,
            limit,
            fetch_job_id: fetchJobId
        });
        return Array.isArray(res.data?.properties) ? res.data.properties : [];
    }, []);

    // Load navigation preference from user settings on load
    useEffect(() => {
        if (user?.navigation_app) {
            setNavigationApp(user.navigation_app);
        }
    }, [user]);

    // Update user preference when changed
    const updateNavigationApp = async (app) => {
        setNavigationApp(app);
        await base44.auth.updateMe({ navigation_app: app });
        queryClient.invalidateQueries({ queryKey: ['user'] });
    };

    // Fetch Route Templates
    const { data: routeTemplatesRaw = [], refetch: refetchTemplates } = useQuery({
        queryKey: ['routeTemplates', user?.email],
        queryFn: () => user ? base44.entities.RouteTemplate.filter({ created_by: user.email }, '-created_date', 100) : [],
        enabled: !!user,
        staleTime: 1000 * 60 * 5,
    });
    const routeTemplates = Array.isArray(routeTemplatesRaw) ? routeTemplatesRaw : (routeTemplatesRaw?.items || []);

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

        // Restore base settings (default 10000 = all-in-one route)
        setHousesPerRoute(template.config.houses_per_route || 10000);
        if (template.config.min_score) setMinScore(template.config.min_score);
        if (template.config.street_cooldown_days) setStreetCooldownDays(template.config.street_cooldown_days);
        if (template.config.zip_code_filter) setZipCodeFilter(template.config.zip_code_filter);
        if (template.config.start_location) setStartLocation(template.config.start_location);

        // Restore routeConfig fields
        setRouteConfig(prev => ({
            ...prev,
            walkingPattern: template.config.walkingPattern || 'street_sweep',
            minimizeTurns: template.config.minimizeTurns ?? true,
            use2Opt: template.config.use2Opt ?? true,
            returnToStart: template.config.returnToStart ?? false,
            excludeTerminal: template.config.excludeTerminal ?? true,
            includeCallbacks: template.config.includeCallbacks ?? true,
            excludeCommercial: true,
            excludeCondos: true,
            excludeLand: true,
            excludePreviouslyKnocked: template.config.excludePreviouslyKnocked ?? true,
            propertyTypes: ['Single Family'],
            minPrice: template.config.minPrice || null,
            maxPrice: template.config.maxPrice || null
        }));

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
        staleTime: 1000 * 60 * 5,
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

    // Fetch Properties — Phase 4: viewport-based fetching with slim 'map' payloads.
    // Stage 1 loads a capped slim territory set; stage 2 fills detail per viewport on pan
    // only when the territory exceeds the cap. Route generation still fetches full
    // records on-demand via fetchRouteCandidatesFromNeon (unchanged).
    // NOTE: drawn polygon stays a LOCAL FILTER (effectiveProperties) — not a fetch key.
    const {
        baseProperties: userProperties,
        viewportProperties,
        isLoading: propsLoading,
        onMapMoveEnd
    } = useViewportMapProperties(user);



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
        const combined = userProperties.concat(viewportProperties, localProperties, darkRoomProperties, fetchedProperties);
        const seen = new Set();
        return combined.filter(p => {
            // Use id as fallback for address_hash if missing (Dark Room props might rely on ID)
            const id = p.address_hash || p.id;
            if (!id || seen.has(id)) return false;
            seen.add(id);
            return true;
        });
    }, [userProperties, viewportProperties, localProperties, darkRoomProperties, fetchedProperties]);

    const { data: savedRoutesRaw = [] } = useQuery({
        queryKey: ['savedRoutes', user?.id],
        staleTime: 1000 * 60 * 2,
        queryFn: () => {
            if (!user?.id) return [];
            return base44.entities.SavedRoute.filter({ manager_id: user.id }, '-created_date', 500);
        },
        enabled: !!user?.id
    });
    const savedRoutes = Array.isArray(savedRoutesRaw) ? savedRoutesRaw : (savedRoutesRaw?.items || []);
    const [serverHydratedSavedRoutes, setServerHydratedSavedRoutes] = useState([]);
    const { data: precisionFetchJobsRaw = [] } = useQuery({
        queryKey: ['precisionFetchJobs', user?.email],
        staleTime: 1000 * 60 * 2,
        queryFn: () => user?.email ? base44.entities.FetchJob.filter({ user_email: user.email }, '-created_date', 50) : [],
        enabled: !!user?.email
    });
    const precisionFetchJobs = Array.isArray(precisionFetchJobsRaw) ? precisionFetchJobsRaw : (precisionFetchJobsRaw?.items || []);

    const precisionAreaHistory = useMemo(() => {
        const byKey = new Map();
        const addEntry = (polygon, entry = {}) => {
            if (!polygon || polygon.length < 3) return;
            const key = polygonHistoryKey(polygon);
            byKey.set(key, {
                ...byKey.get(key),
                ...entry,
                polygon,
                queried: true,
                source: 'server'
            });
        };

        savedRoutes.forEach((route) => {
            const polygon = getRouteHistoryPolygon(route);
            const precisionArea = route?.metadata?.precision_area || {};
            addEntry(polygon, {
                id: `route_${route.id}`,
                route_id: route.id,
                route_name: route.name,
                date: precisionArea.date || precisionArea.last_pull_date || route.metadata?.generated_at || route.created_date || route.updated_date,
                last_pull_date: precisionArea.last_pull_date || route.metadata?.generated_at || route.created_date,
                job_id: precisionArea.job_id,
                criteria: precisionArea.criteria || {}
            });
        });

        precisionFetchJobs.forEach((job) => {
            const polygon = getFetchJobHistoryPolygon(job);
            const completedOrUseful = job.status === 'completed' || Number(job.active_count || job.total_inserted || job.total_existed || 0) > 0;
            if (!completedOrUseful) return;
            addEntry(polygon, {
                id: `job_${job.id}`,
                job_id: job.id,
                date: job.completed_at || job.updated_date || job.created_date,
                last_pull_date: job.completed_at || job.updated_date || job.created_date,
                criteria: {
                    requested_properties: job.requested_properties || job.total_expected || job.active_count || null,
                    sold_months: job.sold_months || job.fetch_months || null,
                    min_price: job.min_price ?? job.filters?.min_price ?? null,
                    max_price: job.max_price ?? job.filters?.max_price ?? null
                }
            });
        });

        return Array.from(byKey.values())
            .filter((entry) => entry.polygon?.length >= 3)
            .sort((a, b) => new Date(b.last_pull_date || b.date || 0) - new Date(a.last_pull_date || a.date || 0))
            .slice(0, 20);
    }, [savedRoutes, precisionFetchJobs]);

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
        onSuccess: (data, variables) => {
            queryClient.invalidateQueries({ queryKey: ['savedRoutes'] });
            queryClient.invalidateQueries({ queryKey: ['localRoutes'] }); // Ensure local readers update
            // @ts-ignore - 'silent' is a dynamic property added for auto-save
            if (!variables?.silent) {
                toast.success("Route saved successfully!", { duration: 2000 });
            }
        }
    });

    const cleanRouteAreaLabel = (value) => {
        if (value === undefined || value === null) return '';
        return String(value).trim().replace(/\s+/g, ' ').replace(/\bcounty\b$/i, '').trim();
    };

    const mostCommonRouteLabel = (properties, getters) => {
        const counts = new Map();
        properties.forEach((property) => {
            for (const getter of getters) {
                const value = cleanRouteAreaLabel(getter(property));
                if (value) {
                    counts.set(value, (counts.get(value) || 0) + 1);
                    break;
                }
            }
        });
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    };

    const isStockRouteName = (name) => /^(precision\s+route|canvas\s+route|route)\s+\d+$/i.test(String(name || '').trim());

    const deriveRouteName = (route) => {
        if (route?.name && !isStockRouteName(route.name)) return route.name;
        const props = route?.allProperties || route?.properties || [];
        const batchIndex = Number(String(route?.name || '').match(/(\d+)$/)?.[1] || route?.route_number || 1) || 1;
        const county = mostCommonRouteLabel(props, [
            p => p.county,
            p => p.county_name,
            p => p.countyName,
            p => p.raw_metadata?.county,
            p => p.raw_metadata?.county_name,
            p => p.raw_metadata?.COUNTY,
            p => p.raw_metadata?.County
        ]);
        const city = mostCommonRouteLabel(props, [p => p.city, p => p.raw_metadata?.city, p => p.raw_metadata?.CITY, p => p.raw_metadata?.City]);
        const zip = mostCommonRouteLabel(props, [p => p.zip_code, p => p.zip, p => p.raw_metadata?.zip, p => p.raw_metadata?.ZIP]);
        const street = mostCommonRouteLabel(props, [p => p.street_name]);
        const area = county ? `${county} County` : city || (zip ? `ZIP ${zip}` : street || 'Territory');
        const type = route?.route_mode === 'canvas' ? 'Canvas' : 'Precision';
        const base = `${area} ${type} Route`;
        // Continue numbering from existing saved routes with the same base name
        // (e.g. "Kannapolis Precision Route 1" exists → next is Route 2), instead of always defaulting to 1.
        const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`^(?:New\\s*[—-]\\s*)?${escaped}\\s+(\\d+)`, 'i');
        let maxExisting = 0;
        savedRoutes.forEach(r => {
            const m = String(r.name || '').match(pattern);
            if (m) maxExisting = Math.max(maxExisting, Number(m[1]) || 0);
        });
        return `${base} ${maxExisting + batchIndex}`;
    };

    const handleSaveRoute = async (route, assignedRepId = null, assignedRepName = null, silent = false) => {
        const defaultAssigneeId = assignedRepId || user?.id;
        const defaultAssigneeName = assignedRepName || user?.full_name || 'Me';
        const baseRouteName = deriveRouteName(route);
        const isGeneratedRoute = !route?.isSaved && Array.isArray(route?.properties) && route.properties.length > 0;
        const routeMode = route.route_mode || 'precision';
        const currentPrecisionPolygon = routeMode === 'precision' ? normalizeHistoryPolygon(drawnPolygon) : [];
        const generatedAt = new Date().toISOString();
        const precisionAreaMetadata = isGeneratedRoute && currentPrecisionPolygon.length >= 3
            ? {
                precision_area: {
                    polygon: currentPrecisionPolygon,
                    job_id: currentBatchDataJobIdRef.current || currentBatchDataJobId || null,
                    last_pull_date: generatedAt,
                    date: generatedAt,
                    criteria: {
                        sold_months: currentBatchDataSoldMonthsRef.current || soldDateFilter || null,
                        route_mode: routeMode,
                        pull_mode: lastPullMode || null
                    }
                }
            }
            : {};
        // No "New —" name prefix — the NEW badge (from metadata.newly_generated) marks fresh routes instead.
        const routeName = baseRouteName.replace(/^New\s*[—-]\s*/i, '');

        // @ts-ignore - 'mutateAsync' incorrectly expects 'void' instead of the data object
        return await createRouteMutation.mutateAsync({
            name: routeName,
            route_mode: routeMode,
            property_hashes: route.properties.map(p => p.address_hash),
            metrics: {
                distance: route.totalDistance,
                house_count: route.houseCount,
                score: route.competitivenessScore
            },
            status: 'ACTIVE',
            start_location: startLocation,
            assigned_to: defaultAssigneeId,
            assigned_to_name: defaultAssigneeName,
            manager_id: user.id,
            metadata: isGeneratedRoute ? { ...(route.metadata || {}), ...precisionAreaMetadata, newly_generated: true, generated_at: generatedAt } : route.metadata,
            silent // Pass silent flag to mutation
        });
    };

    const handleSaveFilteredRoute = useCallback(() => {
        if (!activeRoute || !filteredActiveRoute || activeRouteSoldFilter === 'all') return;

        const newRoute = {
            ...filteredActiveRoute,
            id: `route-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            name: `${activeRoute.name} (${activeRouteSoldFilter}M Filter)`,
        };

        // Auto-save to backend/local storage
        handleSaveRoute(newRoute);

        setActiveRoute(newRoute);
        setActiveRouteSoldFilter('all');
        // toast.success moved to handleSaveRoute/createRouteMutation onSuccess
    }, [activeRoute, filteredActiveRoute, activeRouteSoldFilter, handleSaveRoute]);

    const { data: logsRaw = [], isLoading: logsLoading } = useQuery({
        queryKey: ['interactionLogs', user?.email],
        staleTime: 1000 * 60 * 2,
        queryFn: () => user ? base44.entities.InteractionLog.list('-created_date', 5000) : [],
        enabled: !!user
    });

    // CRITICAL: Filter logs to only show interactions from this user's organization to prevent cross-account leaks
    const logs = useMemo(() => {
        const rawArray = Array.isArray(logsRaw) ? logsRaw : (logsRaw?.items || []);
        if (!user) return [];
        const validEmails = new Set([user.email, ...(teamMembers || []).map(m => m.email)].map(e => e.toLowerCase()));
        return rawArray.filter(l => l.created_by && validEmails.has(l.created_by.toLowerCase()));
    }, [logsRaw, user, teamMembers]);
    const { data: leadScoringWeightsRaw = [] } = useQuery({
        queryKey: ['leadScoringWeights'],
        staleTime: 1000 * 60 * 30,
        queryFn: () => base44.entities.LeadScoringWeights.list(),
    });
    const learnedWeights = leadScoringWeightsRaw[0]?.weights || null;

    // REAL-TIME UPDATES: global InteractionLog subscription removed —
    // it caused thundering-herd refetches at scale. Logs refresh via query staleTime (2 min).

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
            manager_id: user?.id || null,
        }),
        onSuccess: async () => {
            queryClient.invalidateQueries({ queryKey: ['interactionLogs'] });
            queryClient.invalidateQueries({ queryKey: ['selectedPropertyHistory'] });
            if (!isProUser(user)) {
                try {
                    const freshUser = await base44.auth.me().catch(() => user);
                    await base44.auth.updateMe({ outcomes_logged: getOutcomesLogged(freshUser) + 1 });
                    queryClient.invalidateQueries({ queryKey: ['user'] });
                } catch (error) {
                    console.error('Failed to increment outcomes_logged', error);
                }
            }
        },
    });

    // Process ALL properties with territory filter
    const effectiveProperties = useMemo(() => {
        const propsArray = Array.isArray(properties) ? properties : (properties?.items || []);
        const territoryZips = [...(user?.territory_zip_codes || []), ...(user?.generated_zip_codes || [])];
        const hasActivePolygon = !!(drawnPolygon && drawnPolygon.length > 2);
        const hasExplicitZipFilter = !!(zipCodeFilter && zipCodeFilter.trim());
        const applyTerritoryFilter = territoryZips.length > 0 && !hasActivePolygon && !hasExplicitZipFilter;

        // Pre-compute logs by address hash for O(1) lookup
        const logsByAddress = new Map();
        logs.forEach(l => {
            if (!l.address_hash) return;
            if (!logsByAddress.has(l.address_hash)) {
                logsByAddress.set(l.address_hash, []);
            }
            logsByAddress.get(l.address_hash).push(l);
        });

        const mapped = propsArray
            .filter(p => {
                if (!p?.lat || !p?.lng || isNaN(p.lat) || isNaN(p.lng)) return false;
                // Filter out Null Island (0,0) coordinates
                if (Math.abs(p.lat) < 0.0001 && Math.abs(p.lng) < 0.0001) return false;

                // Apply territory filter only when appropriate (not when polygon/explicit zips are active)
                if (applyTerritoryFilter) {
                    const hash = p.address_hash || p.id;
                    // ALWAYS keep properties that are part of a saved route to prevent them from disappearing
                    if (assignedHashes.has(hash)) return true;

                    const propZip = String(p.zip_code || '').trim().slice(0, 5);
                    if (!territoryZips.includes(propZip)) return false;
                }

                return true;
            })
            .map(p => {
                const hash = p.address_hash || p.id;
                // Support legacy_hash alias: check both current hash and legacy hash for logs
                const propLogs = [
                    ...(logsByAddress.get(hash) || []),
                    ...(p.legacy_hash && p.legacy_hash !== hash ? (logsByAddress.get(p.legacy_hash) || []) : [])
                ];
                return {
                    ...p,
                    address_hash: hash,
                    lat: parseFloat(p.lat),
                    lng: parseFloat(p.lng),
                    effective_status: p.is_dark_room ? (p.effective_status || 'ELIGIBLE') : determineEffectiveStatus(p, propLogs)
                };
            });

        // Deduplicate by normalized address (catches Phase1/Phase2 hash mismatch duplicates)
        const dedupMap = new Map();
        mapped.forEach(p => {
            const street = (p.street_name || '').toUpperCase().trim();
            const num = p.house_number || 0;
            const zip = String(p.zip_code || '').trim().slice(0, 5);
            const dedupKey = `${num}|${street}|${zip}`;
            const existing = dedupMap.get(dedupKey);
            if (!existing) {
                dedupMap.set(dedupKey, p);
            } else {
                // Keep whichever has the most recent sold_date
                const existingDate = existing.sold_date ? new Date(existing.sold_date).getTime() : 0;
                const newDate = p.sold_date ? new Date(p.sold_date).getTime() : 0;
                if (newDate > existingDate) {
                    dedupMap.set(dedupKey, p);
                }
            }
        });
        const deduped = Array.from(dedupMap.values());
        if (deduped.length < mapped.length) {
            console.log(`[Home] Deduped properties: ${mapped.length} → ${deduped.length} (removed ${mapped.length - deduped.length} duplicates)`);
        }
        return deduped;
    }, [properties, logs, user?.territory_zip_codes, user?.generated_zip_codes, zipCodeFilter, drawnPolygon]);

    useEffect(() => {
        let cancelled = false;
        async function hydrateOnLoad() {
            if (!user?.email || savedRoutes.length === 0) {
                setServerHydratedSavedRoutes([]);
                return;
            }
            const hydrated = await hydrateRoutesForMap(savedRoutes, user.email, effectiveProperties);
            if (!cancelled) setServerHydratedSavedRoutes(hydrated);
        }
        hydrateOnLoad();
        return () => { cancelled = true; };
    }, [savedRoutes, user?.email, effectiveProperties]);

    // Smart Auto-Open/Close for Generate Mode
    useEffect(() => {
        if (mode === 'generate') {
            if (effectiveProperties.length === 0 && (!drawnPolygon || drawnPolygon.length === 0)) {
                setShowCompare(false);
            }
        }
    }, [mode, effectiveProperties.length === 0, drawnPolygon]);

    // When user returns and has data, auto-set to analyze mode so they see the map directly.
    // Skip this if the Route Builder is open or we're already in generate mode after a pull.
    useEffect(() => {
        if (user?.has_pulled_data && effectiveProperties.length > 0 && !activeRoute && routes.length === 0 && !showCompare && mode !== 'generate') {
            setModeRaw('analyze');
        }
    }, [user?.has_pulled_data, effectiveProperties.length > 0, activeRoute, routes.length, showCompare, mode]);

    // Filter out properties that are already in saved routes for generation
    const availableProperties = useMemo(() => {
        return effectiveProperties.filter(p => !assignedHashes.has(p.address_hash));
    }, [effectiveProperties, assignedHashes]);

    // Hydrate Saved Routes for Map Display
    const hydratedSavedRoutes = useMemo(() => {
        const propsByHash = new Map();
        effectiveProperties.forEach(p => propsByHash.set(p.address_hash, p));

        const routesForDisplay = serverHydratedSavedRoutes.length > 0 ? serverHydratedSavedRoutes : savedRoutes;

        return routesForDisplay
            .filter(r => repFilter === 'all' || (r.assigned_to_name && r.assigned_to_name.includes(repFilter)))
            .map(route => {
                const routeHashes = Array.isArray(route.property_hashes) ? route.property_hashes : [];
                const hydratedProps = Array.isArray(route.properties) ? route.properties.filter(p => p?.lat && p?.lng) : [];
                const allRouteProps = hydratedProps.length > 0 ? hydratedProps : routeHashes
                    .map(hash => propsByHash.get(hash))
                    .filter(Boolean);
                // Saved routes ALWAYS display their full door set — the global sold-date window
                // must never silently trim or hide a saved route on the map/Route Command.
                // (It once turned a 33-door route into 31 in Route Command, and a narrow window
                // could empty a route's pins entirely so it vanished from the map on deselect.)
                // Only the explicit per-route Dates/Price filters on a selected route narrow it.
                const routeProps = allRouteProps;

                // Route is completed if all properties have been knocked (non-ELIGIBLE status)
                const isCompleted = routeProps.length > 0 && routeProps.every(p =>
                    p.effective_status !== 'ELIGIBLE' && p.effective_status !== 'OTHER'
                );

                return {
                    ...route,
                    id: route.id,
                    properties: routeProps,
                    allProperties: allRouteProps,
                    houseCount: routeProps.length || route.metrics?.house_count || routeHashes.length,
                    totalDistance: route.metrics?.distance || 0,
                    competitivenessScore: route.metrics?.score || 0,
                    isSaved: true,
                    isCompleted
                };
            }).filter(r => r.houseCount > 0)
            .sort((a, b) => (b.competitivenessScore || 0) - (a.competitivenessScore || 0));
    }, [savedRoutes, serverHydratedSavedRoutes, effectiveProperties, repFilter]);

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

    // Handle startDraw from onboarding/deep links
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        if (params.get('startDraw') === 'true') {
            const shapeParam = params.get('drawShape');
            setDrawnPolygon(null);
            setDraftPolygon([]);
            if (shapeParam && ['circle', 'square', 'triangle'].includes(shapeParam)) {
                setDrawShape(shapeParam);
            }
            setDrawingMode(true);
            window.history.replaceState({}, '', window.location.pathname);
        }
    }, []);

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
                    // Clear route-only deep links after loading, but keep appointment links until the appointment focus handler runs.
                    if (params.get('appointment') !== '1') {
                        window.history.replaceState({}, '', window.location.pathname);
                    }
                }
            }
        }
    }, [savedRoutes, effectiveProperties, activeRoute]);

    // Handle appointment deep links from the Appointments tab.
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        if (params.get('appointment') !== '1' || appointmentMapFocusHandledRef.current) return;

        const savedRouteId = params.get('savedRoute');
        const routeExistsHere = savedRouteId && savedRoutes.some(route => route.id === savedRouteId);
        if (routeExistsHere && !activeRoute) return;

        const focusHash = params.get('focus');
        const hasLatLng = params.has('lat') && params.has('lng');
        const lat = hasLatLng ? Number(params.get('lat')) : null;
        const lng = hasLatLng ? Number(params.get('lng')) : null;
        const hasValidLatLng = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) > 0.0001 && Math.abs(lng) > 0.0001;
        const address = params.get('address') || 'Appointment address';
        const routeProps = activeRoute?.properties || activeRoute?.allProperties || [];
        const allProps = [...routeProps, ...effectiveProperties];
        const target = allProps.find((property) =>
            focusHash && (
                property.address_hash === focusHash ||
                property.legacy_hash === focusHash ||
                property.id === focusHash
            )
        ) || (hasValidLatLng ? {
            id: focusHash || `appointment-${lat}-${lng}`,
            address_hash: focusHash || `appointment-${lat}-${lng}`,
            full_address: address,
            address,
            house_number: '',
            street_name: address,
            lat,
            lng,
            effective_status: 'CALLBACK'
        } : null);

        appointmentMapFocusHandledRef.current = true;
        setModeRaw('analyze');
        setShowRoutePanel(false);
        setShowCompare(false);

        const targetLat = Number(target?.lat);
        const targetLng = Number(target?.lng);
        if (Number.isFinite(targetLat) && Number.isFinite(targetLng) && Math.abs(targetLat) > 0.0001 && Math.abs(targetLng) > 0.0001) {
            setSelectedProperty({ ...target, lat: targetLat, lng: targetLng });
            if (mapRef.current) {
                try { mapRef.current.setView([targetLat, targetLng], 18, { animate: true }); } catch { }
            }
            toast.success('Opened appointment on the map');
        } else {
            toast.error("Couldn't find this appointment on the map yet.");
        }
        window.history.replaceState({}, '', window.location.pathname);
    }, [activeRoute, effectiveProperties]);

    // Generate routes with configurable houses per route
    const [routesGenerating, setRoutesGenerating] = useState(false);
    const routesGeneratingRef = useRef(false);
    const [generationStage, setGenerationStage] = useState('Preparing data...');

    const [streetCooldownDays, setStreetCooldownDays] = useState(30);
    const [cooldownInfo, setCooldownInfo] = useState(null);
    const [frozenWorkingSet, setFrozenWorkingSet] = useState(null); // Frozen data for reorder
    const [generationError, setGenerationError] = useState(null); // Error shown in overlay

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
        if (routesGeneratingRef.current) {
            toast.info('Route generation is already running.');
            return false;
        }
        routesGeneratingRef.current = true;

        // If frozen data exists, reorder instead of refetch (unless filter just changed, which clears frozen)
        if (frozenWorkingSet?.length > 0) {
            console.log(`[generateRoutes] Frozen data exists (${frozenWorkingSet.length} props). Using handleReorder.`);
            try { return await handleReorder() === true; }
            finally { routesGeneratingRef.current = false; }
        }

        // IMMEDIATE visual feedback — show overlay + toast BEFORE any heavy work.
        // Then yield 2 frames (~32ms) so React paints before we block the main thread.
        setGenerationError(null);
        setGenerationStage('Preparing data...');
        setRoutesGenerating(true);
        toast.loading("Preparing data...", { id: 'build-routes' });
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        const t0 = performance.now();
        try {
            // 1. DYNAMIC DATA FETCHING
            // If a drawn polygon is active, load candidates for that area on-demand.
            // The initial map cache can be zip-scoped and may be empty for polygon-only generation.
            let dynamicProps = [];
            const addDynamicProps = (newProps) => {
                if (!Array.isArray(newProps) || newProps.length === 0) return;
                const merged = new Map(dynamicProps.map(p => [p.address_hash || p.id, p]));
                newProps.forEach(p => merged.set(p.address_hash || p.id, p));
                dynamicProps = Array.from(merged.values());
            };
            let storedPolygon = null;
            try {
                const savedPolygon = localStorage.getItem('fk_drawnPolygon');
                storedPolygon = savedPolygon ? JSON.parse(savedPolygon) : null;
            } catch { }
            const rawActiveGenerationPolygon = Array.isArray(drawnPolygon) && drawnPolygon.length > 2
                ? drawnPolygon
                : Array.isArray(draftPolygon) && draftPolygon.length > 2
                    ? draftPolygon
                    : Array.isArray(storedPolygon) && storedPolygon.length > 2
                        ? storedPolygon
                        : null;
            const normalizedActivePolygon = normalizeHistoryPolygon(rawActiveGenerationPolygon);
            const activeGenerationPolygon = normalizedActivePolygon.length > 2 ? normalizedActivePolygon : null;
            console.log(`[generateRoutes] Polygon source: state=${Array.isArray(drawnPolygon) ? drawnPolygon.length : 0}, draft=${Array.isArray(draftPolygon) ? draftPolygon.length : 0}, stored=${Array.isArray(storedPolygon) ? storedPolygon.length : 0}`);
            const activeFetchJobId = currentBatchDataJobIdRef.current || currentBatchDataJobId;
            const activePolygonKey = activeGenerationPolygon ? polygonHistoryKey(activeGenerationPolygon) : null;
            const currentJobPolygon = normalizeHistoryPolygon(currentBatchDataPolygonRef.current);
            const currentJobPolygonKey = currentJobPolygon.length > 2 ? polygonHistoryKey(currentJobPolygon) : null;
            const requestedPrecisionCount = activeFetchJobId ? currentBatchDataRequestedCountRef.current : null;
            const isCurrentBatchDataRun = !!activeFetchJobId && !!activeGenerationPolygon && !!activePolygonKey && activePolygonKey === currentJobPolygonKey;
            const effectiveGenerationSoldFilter = isCurrentBatchDataRun ? (currentBatchDataSoldMonthsRef.current || soldDateFilter) : soldDateFilter;
            if (activeFetchJobId && activeGenerationPolygon && !isCurrentBatchDataRun) {
                console.warn('[generateRoutes] Ignoring stale BatchData job context for a different polygon', {
                    activeFetchJobId,
                    activePolygonKey,
                    currentJobPolygonKey
                });
            }
            if (activeGenerationPolygon) {
                const polygonProps = await fetchRouteCandidatesFromNeon({
                    polygon: activeGenerationPolygon,
                    soldMonths: isCurrentBatchDataRun ? effectiveGenerationSoldFilter : 'all',
                    limit: 50000,
                    fetchJobId: isCurrentBatchDataRun ? activeFetchJobId : null
                });
                console.log(`[Generate] Drawn area candidate fetch returned ${polygonProps.length} properties${isCurrentBatchDataRun ? ` for job ${activeFetchJobId}` : ''}`);
                if (isCurrentBatchDataRun && polygonProps.length === 0) {
                    toast.dismiss('build-routes');
                    setGenerationError('This pull returned no active routeable properties, so route generation was stopped to avoid using stale old data. Try broadening the area or relaxing the parameters.');
                    return false;
                }

                if (polygonProps.length > 0) {
                    console.log(`[Generate] Fetched ${polygonProps.length} properties from backend for drawn area`);
                    addDynamicProps(polygonProps);
                    setFetchedProperties(prev => {
                        const existingIds = new Set(prev.map(p => p.address_hash || p.id));
                        const newUnique = polygonProps.filter(p => !existingIds.has(p.address_hash || p.id));
                        return prev.concat(newUnique);
                    });
                }
            }

            if (zipCodeFilter && zipCodeFilter.trim()) {
                const targetZips = zipCodeFilter.split(',').map(z => z.trim()).filter(Boolean);

                // Zip codes are unlimited — no limit check needed

                // Check if we need to fetch (simple check: do we have enough data for these zips?)
                // We'll just fetch to be safe and merge.
                // Note: Parallel fetch for multiple zips
                let flattened = await fetchRouteCandidatesFromNeon({
                    zipCodes: targetZips,
                    soldMonths: 'all',
                    limit: 50000
                });

                const userGeneratedZips = user?.generated_zip_codes || [];
                const ungeneratedZips = targetZips.filter(z => !userGeneratedZips.includes(z));

                // If no properties found OR zip not generated yet, pull from RentCast via backend
                if (flattened.length === 0 || ungeneratedZips.length > 0) {
                    const zipsToFetch = ungeneratedZips.length > 0 ? ungeneratedZips : targetZips;
                    console.log(`[Generate] Need to fetch zips from RentCast: ${zipsToFetch.join(', ')}`);
                    toast.loading("Pulling property data...", { id: 'fetch-zip' });

                    for (const zip of zipsToFetch) {
                        try {
                            const res = await base44.functions.invoke('fetchZipProperties', {
                                zip_code: zip,
                                sold_months: 3 // v16 Fix 4A: Tightened from 12→3 months (90 days)
                            });
                            console.log(`[Generate] Fetch result for ${zip}:`, JSON.stringify(res.data));
                            if (res.data?.error) {
                                toast.error(res.data.message || res.data.error, { id: 'fetch-zip' });
                                break;
                            }
                            // Log sold/MLS counts for debugging
                            if (res.data?.sold_count !== undefined) {
                                console.log(`[Generate] ${zip}: ${res.data.count} imported, ${res.data.sold_count} sold, ${res.data.mls_count} MLS`);
                            }
                        } catch (err) {
                            console.warn(`Failed to fetch zip ${zip}`, err);
                            const errData = err?.response?.data;
                            if (errData?.error) {
                                toast.error(errData.message || 'Failed to fetch zip data.', { id: 'fetch-zip' });
                            }
                        }
                    }

                    // Backend now auto-adds zips to territory_zip_codes, refresh user
                    queryClient.invalidateQueries({ queryKey: ['user'] });
                    toast.success("Data synced!", { id: 'fetch-zip' });

                    // Re-fetch after import
                    flattened = await fetchRouteCandidatesFromNeon({
                        zipCodes: targetZips,
                        soldMonths: 'all',
                        limit: 50000
                    });
                }

                if (flattened.length > 0) {
                    console.log(`[Generate] Fetched ${flattened.length} properties from backend for zips: ${targetZips.join(', ')}`);
                    addDynamicProps(flattened);
                    // Update state to show on map (will trigger re-render eventually, but we use local var for now)
                    setFetchedProperties(prev => {
                        // Dedup with existing fetched
                        const existingIds = new Set(prev.map(p => p.id));
                        const newUnique = flattened.filter(p => !existingIds.has(p.id));
                        return prev.concat(newUnique);
                    });
                }
            }

            if (!activeGenerationPolygon && !(zipCodeFilter && zipCodeFilter.trim())) {
                const territoryZips = Array.from(new Set([...(user?.territory_zip_codes || []), ...(user?.generated_zip_codes || [])]));
                const territoryProps = await fetchRouteCandidatesFromNeon({
                    zipCodes: territoryZips,
                    soldMonths: 'all',
                    limit: 50000
                });
                console.log(`[Generate] Neon territory candidate fetch returned ${territoryProps.length} properties`);
                addDynamicProps(territoryProps);
            }

            // 2. PREPARE DATA FOR ROUTING
            // Combine current available (memoized) with newly fetched dynamic props
            // Need to apply same processing (dedup, assigned filtering) to dynamicProps
            const assignedSet = assignedHashes; // closed over from render

            const logsByAddress = new Map();
            logs.forEach(l => {
                if (!l.address_hash) return;
                if (!logsByAddress.has(l.address_hash)) {
                    logsByAddress.set(l.address_hash, []);
                }
                logsByAddress.get(l.address_hash).push(l);
            });

            // Convert dynamicProps to effective format (add lat/lng parse if needed, though filter returns entities)
            const processedDynamic = dynamicProps.map(p => {
                const hash = p.address_hash || p.id;
                const propLogs = [
                    ...(logsByAddress.get(hash) || []),
                    ...(p.legacy_hash && p.legacy_hash !== hash ? (logsByAddress.get(p.legacy_hash) || []) : [])
                ];
                return {
                    ...p,
                    address_hash: hash,
                    lat: parseFloat(p.lat),
                    lng: parseFloat(p.lng),
                    effective_status: determineEffectiveStatus(p, propLogs)
                };
            }).filter(p =>
                p.lat && p.lng &&
                !(Math.abs(p.lat) < 0.0001 && Math.abs(p.lng) < 0.0001)
            );

            // Merge with existing availableProperties, deduping by address_hash.
            // After a paid Precision pull, route generation is job-scoped so stale prior data cannot be reused.
            const combinedMap = new Map();
            const baseProps = isCurrentBatchDataRun ? [] : effectiveProperties;
            baseProps.forEach(p => combinedMap.set(p.address_hash, p));
            processedDynamic.forEach(p => combinedMap.set(p.address_hash, p));

            const initialSet = Array.from(combinedMap.values());
            const initialCount = initialSet.length;
            console.log(`[RoutePipeline] before_route_command initial=${initialCount} base=${baseProps.length} dynamic=${processedDynamic.length} assigned=${assignedSet.size} polygon=${activeGenerationPolygon ? activeGenerationPolygon.length : 0} zipFilter=${zipCodeFilter || 'none'}`);
            setGenerationStage(`Filtering ${initialCount.toLocaleString()} properties...`);
            toast.loading(`Loaded ${initialCount.toLocaleString()} properties. Filtering...`, { id: 'build-routes' });
            await new Promise(r => setTimeout(r, 30));

            // 3. FILTERING — delegated to routeFilterPipeline for clarity + diagnostics
            const effectiveRouteConfig = isCurrentBatchDataRun
                ? { ...routeConfig, excludeAssigned: true }
                : routeConfig;
            const filterResult = applyRouteFilters({
                initialSet, drawnPolygon: activeGenerationPolygon, zipCodeFilter,
                territoryZipCodes: user?.territory_zip_codes,
                soldDateFilter: effectiveGenerationSoldFilter, routeConfig: effectiveRouteConfig, lastPullMode, logsByAddress, assignedHashes,
            });
            console.log(`[generateRoutes] Filter funnel: ${formatStageCounts(filterResult.stages)}`);
            if (filterResult.frozenSet) setFrozenWorkingSet(filterResult.frozenSet);
            if (filterResult.diagnostic) console.warn(`[generateRoutes] Sold-date diagnostic:`, filterResult.diagnostic);
            if (filterResult.error) {
                console.warn(`[generateRoutes] Filter error:`, filterResult.error, 'stages:', filterResult.stages);
                toast.dismiss('build-routes');
                setGenerationError(filterResult.error);
                return false; // Keep overlay visible to show the error — user dismisses manually
            }
            let workingSet = filterResult.workingSet;
            const beforePrecisionRequestedCap = workingSet.length;
            if (isCurrentBatchDataRun && requestedPrecisionCount && workingSet.length > requestedPrecisionCount) {
                workingSet = [...workingSet]
                    .sort((a, b) => precisionCandidateRank(b) - precisionCandidateRank(a))
                    .slice(0, requestedPrecisionCount);
                console.log(`[generateRoutes] Precision fixed-count cap: requested=${requestedPrecisionCount} beforeCap=${beforePrecisionRequestedCap} routed=${workingSet.length}`);
            }

            // 4. UI UPDATES (Keep Builder available & Move Map)
            setShowCompare(true);

            if (mapRef.current && workingSet.length > 0) {
                const bounds = L.latLngBounds(workingSet.map(p => [p.lat, p.lng]));
                if (bounds.isValid()) {
                    try { if (mapRef.current._mapPane) mapRef.current.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 }); } catch (e) { }
                }
            }

            // 5. GENERATE ROUTES — yield to UI before heavy computation
            const currentCenter = mapRef.current ? mapRef.current.getCenter() : null;
            const start = startLocation || (currentCenter ? { lat: currentCenter.lat, lng: currentCenter.lng } : null);
            const finalCount = workingSet.length; const filteredOut = initialCount - finalCount; const effectiveUse2Opt = finalCount > 3000 ? false : routeConfig.use2Opt;
            if (finalCount > 3000 && routeConfig.use2Opt) console.warn(`[generateRoutes] Auto-disabled 2-Opt (n=${finalCount} > 3K)`);
            const optStart = performance.now();
            setGenerationStage(`Optimizing ${finalCount.toLocaleString()} doors — ~${Math.max(2, Math.round(finalCount / 1500))}s`);
            toast.loading(`Optimizing ${finalCount.toLocaleString()} properties${filteredOut > 0 ? ` (${filteredOut.toLocaleString()} filtered)` : ''}... ~${Math.max(2, Math.round(finalCount / 1500))}s`, { id: 'build-routes' });
            console.log(`[generateRoutes] Opt start | n=${finalCount} | 2opt=${effectiveUse2Opt}`);
            const generated = finalCount > 5000
                ? (await base44.functions.invoke('generateRoutesBackend', {
                    properties: workingSet,
                    houses_per_route: housesPerRoute,
                    start_location: start
                })).data.routes
                : await new Promise(resolve => setTimeout(() => resolve(generateOptimizedRoutes(workingSet, housesPerRoute, start, logs, { streetCooldownDays, useStreetSweep: routeConfig.walkingPattern === 'street_sweep', minimizeTurns: routeConfig.minimizeTurns, use2Opt: effectiveUse2Opt, walkingPattern: routeConfig.walkingPattern, returnToStart: routeConfig.returnToStart, excludeTerminal: routeConfig.excludeTerminal }, learnedWeights)), 50));
            const generatedDoorCount = Array.isArray(generated) ? generated.reduce((sum, route) => sum + (route.properties?.length || route.houseCount || 0), 0) : 0;
            console.log(`[RoutePipeline] after_route_command routes=${generated?.length || 0} doors=${generatedDoorCount} elapsed_ms=${Math.round(performance.now() - optStart)}`);
            if (!generated || generated.length === 0) { toast.dismiss('build-routes'); setGenerationError(`Optimizer returned 0 routes from ${finalCount.toLocaleString()} properties. Try relaxing filters or pulling fresh data.`); return false; }
            if (generated['_cooldownInfo']) setCooldownInfo(generated['_cooldownInfo']);
            setRoutes(generated);
            // AUTO-SAVE (skip routes >10K properties — payload too large)
            const saveable = generated.filter(r => r.houseCount <= 10000);
            let savedRecords = [];
            if (saveable.length > 0) {
                setGenerationStage(`Saving ${saveable.length} routes...`);
                const bulkId = toast.loading(`Auto-saving ${saveable.length} routes...`);
                try {
                    savedRecords = await Promise.all(saveable.map(r => handleSaveRoute(r, null, null, true)));
                    toast.success(`Saved ${saveable.length} routes`, { id: bulkId, duration: 3000 });
                    setModeRaw('analyze');
                    // Saved routes now live in Active (with NEW badge) — drop the in-memory copies so
                    // Route Command doesn't show the same route twice. Keep only unsaveable >10K routes.
                    setRoutes(generated.filter(r => r.houseCount > 10000));
                } catch (error) { console.error('[Home] Auto-save failed:', error); toast.error('Auto-save failed.', { id: bulkId }); }
            } else if (generated.length > 0) {
                toast.info(`Route has ${generated[0].houseCount} properties — too large to auto-save. View on map.`, { id: 'build-routes', duration: 5000 });
            }
            // Go straight to the map: activate the first generated route instead of opening the command panel
            const firstRoute = generated[0];
            const firstSaved = savedRecords[0];
            setActiveRoute(firstSaved?.id ? { ...firstRoute, id: firstSaved.id, isSaved: true, status: firstSaved.status || 'ACTIVE' } : firstRoute);
            setPreviewRoute(null);
            setShowRoutePanel(false); setShowCompare(false);
            let skippedDueToAssigned = 0;
            if (effectiveRouteConfig.excludeAssigned) {
                skippedDueToAssigned = (effectiveProperties.length - availableProperties.length) +
                    (dynamicProps ? dynamicProps.filter(p => assignedHashes.has(p.address_hash || p.id)).length : 0);
            }

            const routeWord = generated.length === 1 ? 'route' : 'routes';
            const totalHouses = generated.reduce((s, r) => s + r.houseCount, 0);
            const precisionShortfallMessage = buildPrecisionRouteShortfallMessage({
                requested: isCurrentBatchDataRun ? requestedPrecisionCount : null,
                routed: generatedDoorCount,
                filtered: Math.max(0, initialCount - finalCount)
            });
            if (precisionShortfallMessage) {
                toast.info(precisionShortfallMessage, { duration: 14000 });
            }
            const toastMsg = `Built ${generated.length} ${routeWord} (${totalHouses.toLocaleString()} doors)` + (skippedDueToAssigned > 0 ? ` — ${skippedDueToAssigned} already assigned` : '');

            const requestedText = isCurrentBatchDataRun && requestedPrecisionCount
                ? `, ${Math.min(totalHouses, requestedPrecisionCount).toLocaleString()} of ${requestedPrecisionCount.toLocaleString()} requested`
                : '';
            const finalToastMsg = isCurrentBatchDataRun && requestedPrecisionCount
                ? `Built ${generated.length} ${routeWord} (${totalHouses.toLocaleString()} doors${requestedText})` + (skippedDueToAssigned > 0 ? ` — ${skippedDueToAssigned} already assigned` : '')
                : toastMsg;

            toast.success(finalToastMsg, { id: 'build-routes', duration: 5000 });
            return true;

        } catch (e) {
            console.error(`[generateRoutes] Failed after ${Math.round((performance.now() - t0) / 1000)}s:`, e);
            toast.dismiss('build-routes');
            setGenerationError(`Route generation failed: ${e?.message || 'Unknown error'}. Check console for details.`);
            return false;
        } finally {
            // Hide overlay — but if an error was set, keep it visible until user dismisses
            // (we re-check generationError via a functional setState)
            routesGeneratingRef.current = false;
            setRoutesGenerating(false);
        }
    }, [availableProperties, housesPerRoute, startLocation, logs, streetCooldownDays, zipCodeFilter, assignedHashes, routeConfig, soldDateFilter, drawnPolygon, draftPolygon, frozenWorkingSet, effectiveProperties, fetchRouteCandidatesFromNeon, currentBatchDataJobId, user?.territory_zip_codes, user?.generated_zip_codes, user?.email]);

    // Reorder: re-run filtering + routing on frozen data without re-fetching
    const handleReorder = useCallback(async () => {
        if (!frozenWorkingSet || frozenWorkingSet.length === 0) { toast.error('No data to reorder.'); return false; }
        setGenerationError(null);
        setGenerationStage(`Reordering ${frozenWorkingSet.length.toLocaleString()} doors...`);
        setRoutesGenerating(true);
        toast.loading('Reordering routes...', { id: 'reorder-routes' });
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        try {
            const logsByAddr = new Map();
            logs.forEach(l => { if (!l.address_hash) return; if (!logsByAddr.has(l.address_hash)) logsByAddr.set(l.address_hash, []); logsByAddr.get(l.address_hash).push(l); });
            const filterResult = applyRouteFilters({
                initialSet: frozenWorkingSet, drawnPolygon, zipCodeFilter,
                territoryZipCodes: user?.territory_zip_codes,
                soldDateFilter, routeConfig, lastPullMode, logsByAddress: logsByAddr, assignedHashes,
            });
            console.log(`[handleReorder] Filter funnel: ${formatStageCounts(filterResult.stages)}`);
            if (filterResult.error) { toast.dismiss('reorder-routes'); setGenerationError(filterResult.error); return false; }
            const workingSet = filterResult.workingSet;
            const effectiveUse2Opt = workingSet.length > 3000 ? false : routeConfig.use2Opt;
            const start = startLocation || (mapRef.current ? { lat: mapRef.current.getCenter().lat, lng: mapRef.current.getCenter().lng } : null);
            const generated = workingSet.length > 5000
                ? (await base44.functions.invoke('generateRoutesBackend', {
                    properties: workingSet,
                    houses_per_route: housesPerRoute,
                    start_location: start
                })).data.routes
                : generateOptimizedRoutes(workingSet, housesPerRoute, start, logs, { streetCooldownDays, useStreetSweep: routeConfig.walkingPattern === 'street_sweep', minimizeTurns: routeConfig.minimizeTurns, use2Opt: effectiveUse2Opt, walkingPattern: routeConfig.walkingPattern, returnToStart: routeConfig.returnToStart, excludeTerminal: routeConfig.excludeTerminal }, learnedWeights);
            setRoutes(generated);
            let savedRecords = [];
            if (generated.length > 0) {
                const bulkId = toast.loading(`Auto-saving ${generated.length} routes...`);
                try { savedRecords = await Promise.all(generated.map(r => handleSaveRoute(r, null, null, true))); toast.success(`Reordered into ${generated.length} routes`, { id: bulkId, duration: 3000 }); setModeRaw('analyze'); setRoutes([]); } catch (e) { toast.error('Auto-save failed.', { id: bulkId }); }
            }
            // Go straight to the map: activate the first generated route instead of opening the command panel
            if (generated.length > 0) {
                const firstSaved = savedRecords[0];
                setActiveRoute(firstSaved?.id ? { ...generated[0], id: firstSaved.id, isSaved: true, status: firstSaved.status || 'ACTIVE' } : generated[0]);
                setPreviewRoute(null);
            }
            setShowRoutePanel(false); setShowCompare(false);
            toast.success(`Reordered! ${generated.length} route(s)`, { id: 'reorder-routes', duration: 5000 });
            return true;
        } catch (e) { console.error('Reorder error:', e); toast.error('Reorder failed.', { id: 'reorder-routes' }); return false; }
        finally { setRoutesGenerating(false); }
    }, [frozenWorkingSet, housesPerRoute, startLocation, logs, streetCooldownDays, zipCodeFilter, routeConfig, soldDateFilter, drawnPolygon, lastPullMode, learnedWeights, user?.territory_zip_codes, assignedHashes]);

    // Re-optimize a single saved route's order in-place — pure distance minimization (NN + 2-Opt + Or-Opt)
    const handleReoptimizeRoute = useCallback(async (route) => {
        const toastId = toast.loading('Optimizing for shortest distance...', { id: 'reoptimize-route' });
        const savedView = mapRef.current ? { center: mapRef.current.getCenter(), zoom: mapRef.current.getZoom() } : null;
        try {
            const hashes = route.property_hashes || (route.properties || []).map(p => p.address_hash || p.id);
            const routePropsByHash = new Map((route.properties || route.allProperties || []).map(p => [p.address_hash || p.id, p]));
            const routeProperties = hashes.map(hash => effectiveProperties.find(p => p.address_hash === hash) || routePropsByHash.get(hash)).filter(Boolean);
            if (routeProperties.length === 0) { toast.error('No properties found for this route.', { id: 'reoptimize-route' }); return; }
            const currentCenter = mapRef.current ? mapRef.current.getCenter() : null;
            const start = startLocation || (currentCenter ? { lat: currentCenter.lat, lng: currentCenter.lng } : null);
            const optimized = optimizeRouteByDistance(routeProperties, start);
            if (!optimized || optimized.length === 0) { toast.error('Optimization produced no results.', { id: 'reoptimize-route' }); return; }
            let newDistance = 0;
            for (let i = 0; i < optimized.length - 1; i++) {
                const R = 3959, dLat = (optimized[i + 1].lat - optimized[i].lat) * Math.PI / 180, dLng = (optimized[i + 1].lng - optimized[i].lng) * Math.PI / 180;
                const a = Math.sin(dLat / 2) ** 2 + Math.cos(optimized[i].lat * Math.PI / 180) * Math.cos(optimized[i + 1].lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
                newDistance += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            }
            newDistance = Math.round(newDistance * 100) / 100;
            const oldDistance = route.metrics?.distance || route.totalDistance || 0;
            const newOrder = optimized.map(p => p.address_hash || p.id).filter(Boolean);
            await base44.entities.SavedRoute.update(route.id, { property_hashes: newOrder, metrics: { ...route.metrics, distance: newDistance, house_count: optimized.length } });
            queryClient.invalidateQueries({ queryKey: ['savedRoutes'] });
            if (activeRoute && activeRoute.id === route.id) {
                setActiveRoute(prev => ({ ...prev, property_hashes: newOrder, properties: optimized, allProperties: optimized, houseCount: optimized.length, totalDistance: newDistance, metrics: { ...prev?.metrics, distance: newDistance, house_count: optimized.length } }));
            }
            // Restore map view to prevent zoom-out from fitBounds reacting to property reorder
            if (savedView && mapRef.current) { try { mapRef.current.setView(savedView.center, savedView.zoom, { animate: false }); } catch (e) { } }
            const savedMiles = Math.round((oldDistance - newDistance) * 100) / 100;
            const msg = savedMiles > 0 ? `Route optimized! Saved ~${savedMiles} miles (${newDistance} mi total)` : `Route optimized (${newDistance} mi total)`;
            toast.success(msg, { id: 'reoptimize-route', duration: 4000 });
        } catch (e) { console.error('Re-optimize error:', e); toast.error('Failed to re-optimize route.', { id: 'reoptimize-route' }); }
    }, [effectiveProperties, startLocation, logs, routeConfig, learnedWeights, activeRoute]);

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
        const excludedCount = routes['_cooldownInfo'] ? routes['_cooldownInfo'].propertiesExcluded : 0;

        return { totalHouses, totalDist, avgScore, routeCount: routes.length, highPotentialCount, excludedCount };
    }, [routes]);

    // Only update fitBounds when the active route ID actually changes — NOT on every filter/state update.
    // Previously, any change to availableProperties or filteredActiveRoute (e.g. toggling a filter) would
    // create a new array reference, triggering MapController to re-fit and zoom the user out.
    const activeRouteId = filteredActiveRoute?.id || null;
    const fitBounds = useMemo(() => {
        if (filteredActiveRoute?.properties?.length > 0) {
            return filteredActiveRoute.properties
                .filter(p => p && p.lat !== undefined && p.lng !== undefined)
                .map(p => [p.lat, p.lng]);
        }
        return null;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeRouteId]);

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

    // On first load, get user's GPS location as the initial map center
    useEffect(() => {
        if (!navigator.geolocation) return;
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const loc = [pos.coords.latitude, pos.coords.longitude];
                setGpsInitialLocation(loc);
                setMapCenter(loc);
                setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
            },
            () => { /* GPS denied/unavailable, keep default */ },
            { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
        );
    }, []);

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

    const center = availableProperties[0] && availableProperties[0].lat
        ? [availableProperties[0].lat, availableProperties[0].lng]
        : (gpsInitialLocation || mapCenter);

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

    const checkAndHandleOutcomeGate = useCallback(async () => {
        let freshUser = user;
        try {
            freshUser = await base44.auth.me();
            if (freshUser) queryClient.setQueryData(['user'], freshUser);
        } catch { /* keep cached user */ }

        if (isProUser(freshUser)) return false;
        if (needsCardOnFile(freshUser)) {
            setKnockGateMode('card');
            setShowKnockLimitSheet(true);
            return true;
        }
        if (isOutcomeBlocked(freshUser)) {
            setKnockGateMode('limit');
            setShowKnockLimitSheet(true);
            return true;
        }
        return false;
    }, [queryClient, user]);

    const handleLogResult = useCallback(async (property, statusOrLogData, note = null) => {
        const blocked = await checkAndHandleOutcomeGate();
        if (blocked) return false;

        const logData = typeof statusOrLogData === 'object'
            ? statusOrLogData
            : {
                raw_input_text: note || statusOrLogData,
                parsed_status: statusOrLogData,
            };

        createLogMutation.mutate({
            ...logData,
            address_hash: property.address_hash,
            gps_proof_lat: property.lat,
            gps_proof_lng: property.lng,
            route_id: logData.route_id || activeRoute?.id || null
        });
        return true;
    }, [activeRoute, checkAndHandleOutcomeGate, createLogMutation]);

    const handleDeleteInteraction = useCallback(async (log) => {
        if (!log?.id) return;
        if (!confirm('Remove this interaction history?')) return;
        await base44.entities.InteractionLog.delete(log.id);
        queryClient.invalidateQueries({ queryKey: ['interactionLogs'] });
        queryClient.invalidateQueries({ queryKey: ['selectedPropertyHistory'] });
        toast.success('Interaction removed');
    }, [queryClient]);

    const generateRoutesRef = useRef(generateRoutes);
    useEffect(() => {
        generateRoutesRef.current = generateRoutes;
    }, [generateRoutes]);

    const [pendingAutoGenerate, setPendingAutoGenerate] = useState(false);

    // handleAreaPullComplete removed — MarketSetupPrompt handles flow directly

    // Run auto generation when data is fresh after Precision's unified pull+generate flow.
    useEffect(() => {
        if (!pendingAutoGenerate || routesGenerating) return;
        const timer = setTimeout(() => {
            setPendingAutoGenerate(false);
            generateRoutesRef.current?.();
        }, 100);
        return () => clearTimeout(timer);
    }, [pendingAutoGenerate, routesGenerating, effectiveProperties.length]);

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
            {/* Generation Overlay — immediate visual feedback */}
            <RouteGenerationOverlay
                visible={routesGenerating || !!generationError}
                stage={generationStage}
                error={generationError}
                onDismiss={() => { setGenerationError(null); setRoutesGenerating(false); }}
            />

            {/* Map */}
            <MapContainer
                center={center}
                zoom={15}
                style={{ height: '100%', width: '100%' }}
                zoomControl={false}
                attributionControl={false}
                preferCanvas={true}
                wheelPxPerZoomLevel={120}
                wheelDebounceTime={150}
                zoomAnimation={true}
                markerZoomAnimation={true}
                fadeAnimation={true}
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


                {/* Map Controls Handlers */}

                <MapController
                    fitBounds={fitBounds}
                    onZoomChange={setZoomLevel}
                    onMoveEnd={onMapMoveEnd}
                />

                <MapDrawTool
                    active={drawingMode}
                    onPointsUpdate={setDraftPolygon}
                    onConfirm={(polygon) => {
                        // One active builder shape at a time. Do not save to previous-area history until a preview/query succeeds.
                        setDrawnPolygon(polygon); setDraftPolygon([]); setDrawingMode(false);
                        toast.success("Freehand area selected! Choose property count and run Sandbox Preview.");
                    }}
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
                    routeStatusView={routeStatusView}
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

                {/* Zip Code Overlay */}
                {showZipOverlay && (
                    <ZipCodeOverlay properties={effectiveProperties} />
                )}

                {/* Previous drawn area history */}
                {!drawingMode && !showRoutePanel && !filteredActiveRoute && (
                    <PolygonHistory
                        currentPolygon={drawnPolygon}
                        mode={mode}
                        serverHistory={precisionAreaHistory}
                    />
                )}

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
                drawnPolygon={drawnPolygon}
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
                activeRoutePriceFilter={activeRoutePriceFilter}
                setActiveRoutePriceFilter={setActiveRoutePriceFilter}
                showRouteDetails={showRouteDetails}
                setShowRouteDetails={setShowRouteDetails}
                showRouteLines={showRouteLines}
                setShowRouteLines={setShowRouteLines}
                routeStatusView={routeStatusView}
                setRouteStatusView={setRouteStatusView}
                onSaveFilteredRoute={handleSaveFilteredRoute}
                onReoptimizeRoute={handleReoptimizeRoute}
                startLocation={startLocation}
                hasMlsData={hasMlsData}
                logs={logs}
            />

            {/* Territory Prompt - Drawing Controls + Initial Prompt */}
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
                savedRoutes={savedRoutes}
                setZipCodeFilter={setZipCodeFilter}
                routeConfig={routeConfig}
                onPullComplete={async (pullFetchMonths, pulledWithMls, jobStatus = {}) => {
                    setFrozenWorkingSet(null);
                    setFetchedProperties([]);
                    const completedJobId = getPrecisionJobId(jobStatus);
                    if (!completedJobId) {
                        setCurrentBatchDataJobId(null);
                        currentBatchDataJobIdRef.current = null;
                        currentBatchDataRequestedCountRef.current = null;
                        currentBatchDataPolygonRef.current = null;
                        setGenerationError('This Precision pull completed, but the completed job id was missing. Route generation was stopped so old account data cannot be mixed into this new area. Please generate the area again.');
                        return;
                    }
                    const drawnPullPolygon = normalizeHistoryPolygon(drawnPolygon);
                    const normalizedPullPolygon = drawnPullPolygon.length > 2 ? drawnPullPolygon : getFetchJobHistoryPolygon(jobStatus);
                    if (normalizedPullPolygon.length < 3) {
                        setCurrentBatchDataJobId(null);
                        currentBatchDataJobIdRef.current = null;
                        currentBatchDataRequestedCountRef.current = null;
                        currentBatchDataPolygonRef.current = null;
                        setGenerationError('This Precision pull completed, but the selected area was missing before routes could be built. Route generation was stopped so old account data cannot be mixed into this new area. Please generate the area again.');
                        return;
                    }
                    setCurrentBatchDataJobId(completedJobId);
                    currentBatchDataJobIdRef.current = completedJobId;
                    currentBatchDataRequestedCountRef.current = getRequestedPrecisionCount(jobStatus);
                    currentBatchDataPolygonRef.current = normalizedPullPolygon;
                    setRoutes([]);
                    setShowCompare(false);
                    setShowRoutePanel(false);
                    await queryClient.refetchQueries({ queryKey: ['masterProperties'] });
                    await queryClient.refetchQueries({ queryKey: ['user'] });

                    const pm = pullFetchMonths || 12;
                    currentBatchDataSoldMonthsRef.current = pm;
                    setMaxDataMonths(pm);
                    try { localStorage.setItem('fk_maxDataMonths', String(pm)); } catch { }
                    setHasMlsData(!!pulledWithMls);
                    try { localStorage.setItem('fk_hasMlsData', pulledWithMls ? 'true' : 'false'); } catch { }

                    let pulledProperties = [];
                    if (normalizedPullPolygon.length > 2) {
                        pulledProperties = await fetchRouteCandidatesFromNeon({
                            polygon: normalizedPullPolygon,
                            soldMonths: pm,
                            limit: 50000,
                            fetchJobId: completedJobId
                        });
                        setFetchedProperties(pulledProperties);
                    }

                    setMode('generate');
                    setLastPullMode('batchdata_job');
                    setSoldDateFilterRaw(pm);
                    if ((jobStatus?.active_count || pulledProperties.length) > 0) {
                        const routeBuilt = await generateRoutesRef.current?.();
                        if (routeBuilt === true) {
                            setDrawnPolygon(null);
                            setDraftPolygon([]);
                            try { localStorage.removeItem('fk_drawnPolygonQueried'); } catch { }
                        }
                    } else {
                        const isUltraRecent = Number(pm) <= 0.25;
                        setGenerationError(isUltraRecent
                            ? 'No BatchData-confirmed sales were returned inside this exact area for the selected last-week window. Route generation was stopped so stale old data is not reused. Provider sale/intel records can lag — try 2 weeks or 1 month for this territory.'
                            : 'This pull produced no active routeable properties. Route generation was stopped so stale old data is not reused. Try a larger area or looser parameters.');
                    }
                }}
            />

            {/* MarketSetupPrompt removed — onboarding now handled by MarketOnboarding + TerritoryPrompt */}



            {/* Routes Panel - Refactored Command Panel */}
            {showRoutePanel && (
                <React.Suspense fallback={null}>
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
                        logs={logs}
                        onReoptimizeRoute={handleReoptimizeRoute}
                        routeConfig={routeConfig} mode={mode}
                    />
                </React.Suspense>
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
                        setDrawnPolygon(null);
                        setDraftPolygon([]);
                        setDrawingMode(true);
                    }}
                    housesPerRoute={housesPerRoute} setHousesPerRoute={setHousesPerRoute}
                    streetCooldownDays={streetCooldownDays} setStreetCooldownDays={setStreetCooldownDays}
                    minScore={minScore} setMinScore={setMinScore}
                    zipCodeFilter={zipCodeFilter} setZipCodeFilter={setZipCodeFilter}
                    startLocation={startLocation} setStartLocation={setStartLocation}
                    startAddressInput={startAddressInput} setStartAddressInput={setStartAddressInput}
                    sortBy={sortBy} setSortBy={setSortBy}
                    soldDateFilter={soldDateFilter} setSoldDateFilter={setSoldDateFilter}
                    lastPullMode={lastPullMode}
                    routeConfig={routeConfig} setRouteConfig={setRouteConfig}
                    onGenerate={generateRoutes} routesGenerating={routesGenerating}
                    onReorder={handleReorder}
                    hasFrozenData={!!frozenWorkingSet && frozenWorkingSet.length > 0}
                    onClearPolygon={() => setDrawnPolygon(null)}
                    onReset={() => {
                        if (confirm("Reset all generated routes?")) {
                            setRoutes([]);
                            setFetchedProperties([]);
                            setDrawnPolygon(null);
                            setFrozenWorkingSet(null);
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
                            const res = await base44.functions.invoke('fetchZipProperties', {
                                zip_code: zipCodeFilter,
                                force_sync: true,
                                sold_months: 3 // v16 Fix 4A: Tightened from 12→3 months (90 days)
                            });
                            if (res.data?.error) {
                                toast.error(res.data.message || res.data.error, { id: toastId });
                                return;
                            }
                            if (res.data.count > 0) {
                                toast.success(`Synced ${res.data.count} new properties!`, { id: toastId });
                                queryClient.invalidateQueries({ queryKey: ['masterProperties'] });
                            } else {
                                toast.info(res.data.message || "Up to date", { id: toastId });
                            }
                        } catch (e) {
                            toast.error("Sync failed", { id: toastId });
                        }
                    }}
                    user={user}
                    drawnPolygon={drawnPolygon}
                    hasDrawnArea={drawnPolygon && drawnPolygon.length > 2}
                    maxDataMonths={maxDataMonths}
                    hasMlsData={hasMlsData}
                />
            )}

            {/* GPS HUD Overlay */}
            <GpsTrackerHud
                properties={effectiveProperties}
                isTracking={gpsTracking}
                onToggleTracking={() => setGpsTracking(false)}
                onSelectProperty={setSelectedProperty}
            />

            {/* Route Checklist */}
            {showChecklist && filteredActiveRoute && (
                <div className="fixed inset-0 z-[2000]">
                    <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowChecklist(false)} />
                    <div
                        className="absolute top-0 right-0 bottom-0 w-full max-w-lg overflow-hidden shadow-2xl animate-in slide-in-from-right duration-300"
                        style={{ background: 'transparent' }}
                    >
                        <React.Suspense fallback={null}>
                            <RouteChecklist
                                route={filteredActiveRoute}
                                logs={logs}
                                onLogResult={handleLogResult}
                                onClose={() => setShowChecklist(false)}
                                navigationApp={navigationApp}
                                activeRouteSoldFilter={activeRouteSoldFilter}
                                setActiveRouteSoldFilter={setActiveRouteSoldFilter}
                            />
                        </React.Suspense>
                    </div>
                </div>
            )}

            {/* New Territory Setup Wizard */}
            {showSetupWizard && (
                <React.Suspense fallback={null}>
                    <TerritorySetupWizard
                        user={user}
                        onComplete={handleWizardComplete}
                    />
                </React.Suspense>
            )}

            {/* Property Details Drawer */}
            {/* Command Center Dashboard Overlay */}
            {showDashboard && (
                <React.Suspense fallback={null}>
                    <CommandCenterDashboard
                        properties={effectiveProperties}
                        logs={logs}
                        routes={savedRoutes}
                        teamMembers={teamMembers}
                        onClose={() => setShowDashboard(false)}
                    />
                </React.Suspense>
            )}

            {/* Map Settings Panel */}
            {showMapSettings && (
                <React.Suspense fallback={null}>
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
                        showZipOverlay={showZipOverlay}
                        setShowZipOverlay={setShowZipOverlay}
                    />
                </React.Suspense>
            )}


            <ManagerPropertyDetailSheet selectedProperty={selectedProperty} setSelectedProperty={setSelectedProperty} STATUS_COLORS={STATUS_COLORS} navigationApp={navigationApp} selectedPropertyLogs={selectedPropertyLogs} handleLogResult={handleLogResult} onClearInteraction={handleDeleteInteraction} toast={toast} />
            <KnockLimitSheet
                open={showKnockLimitSheet}
                mode={knockGateMode}
                onClose={() => setShowKnockLimitSheet(false)}
            />
        </div>
    );
}
