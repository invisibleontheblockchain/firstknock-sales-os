import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { MapContainer } from 'react-leaflet'; import BaseMapTiles from '@/components/map/BaseMapTiles';
// Leaflet icon defaults and the unmount/scroll-zoom patches live in one module.
import L from '../components/map/leafletPatches';
import AnalyzeFiltersPanel from '../components/map/AnalyzeFiltersPanel';
import HomeUnifiedSearch from '@/components/search/HomeUnifiedSearch';
import useAppointmentMapFocus from '@/hooks/useAppointmentMapFocus'; import AppointmentFocusMarker from '@/components/map/AppointmentFocusMarker';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { storage } from '@/lib/storage';

import { Loader2 } from 'lucide-react';
import { toast } from "sonner";
import { determineEffectiveStatus, isPointInPolygon } from '../components/logic/territoryLogic';
import { subMonths, subDays, isAfter, parseISO } from 'date-fns';
import {
    generateOptimizedRoutes,
    isStrictRoutePropertyPoint,
} from '../components/logic/routeOptimizer';
import { optimizeLargeRoutesAsync } from '../components/logic/largeRouteOptimizer';
import {
    createRouteContinuityContext,
    routePropertyOrderFingerprint,
} from '../components/logic/routeRoadContext';
import { calculateRouteDistanceMiles, isValidRoutePoint } from '@/lib/routeBounds';
import { applyRouteFilters, formatStageCounts } from '../components/logic/routeFilterPipeline';
import { normalizeOwnershipRangeDays as normalizeStrictOwnershipRangeDays } from '../components/logic/soldDateRange';
import RouteGenerationOverlay from '../components/routes/RouteGenerationOverlay';
import { generateHeatmapGrid, generateStateClusters, getHeatColor } from '../components/logic/heatmapLogic';
const RouteChecklist = React.lazy(() => import('../components/routes/RouteChecklist'));
import RouteCommandPanel from '../components/routes/RouteCommandPanel';
// MarketSetupPrompt removed — onboarding handled by MarketOnboarding + TerritoryPrompt
import TerritoryPrompt from '../components/map/TerritoryPrompt';
import { darkRoom } from '@/components/logic/neonClient';
const CommandCenterDashboard = React.lazy(() => import('../components/dashboard/CommandCenterDashboard'));
const MapSettingsPanel = React.lazy(() => import('../components/map/MapSettingsPanel'));
import RouteBuilderSettings from '../components/map/RouteBuilderSettings';
const TerritorySetupWizard = React.lazy(() => import('../components/manager/TerritorySetupWizard'));
import { hydrateRoutesForMap } from '@/components/logic/routeHydration';
import { GpsMapLayer as GpsTrackerMapLayers, GpsHud as GpsTrackerHud } from '../components/map/GpsTracker';
import ManagerPropertyDetailSheet from '../components/map/ManagerPropertyDetailSheet';
import MapDrawTool from '../components/map/MapDrawTool';
import ManagerMapLayers from '../components/map/ManagerMapLayers';
import { filterRoutesByStatus, isRenderableMapPoint } from '../components/map/mapLayerVisibility.js';
import MapToolbar from '../components/map/MapToolbar';
import BoundaryOverlays from '../components/map/BoundaryOverlays';
import PolygonHistory from '../components/map/PolygonHistory';
import KnockLimitSheet from '@/components/upgrade/KnockLimitSheet';
import { createOutcomeIdempotencyKey, getOutcomeGateFromError } from '@/components/upgrade/knockGate';
import { hasCanvasAccess } from '@/lib/canvasAccess';
import { validateCanvasBoundary } from '@/components/canvas/canvasPlannerUtils';
import { fetchAllCanvasTeamMembers } from '@/components/canvas/canvasRosterPagination';
import { buildFullAddress } from '@/components/logic/navigation';
import { collectUnretiredOutcomes, confirmOutcomeRow } from '@/components/logic/optimisticOutcomes';
import { isKnockActivityLog } from '@/lib/interactionLogs'; import { fetchAccountInteractionLogs, scopeInteractionLogsToAccount } from '@/lib/accountInteractionLogs'; import { buildLogsByAddress, withDerivedStatus } from '@/components/logic/routePropertyStatus';
import {
    buildRepRouteScope,
    buildSavedRouteQueryFilters,
    collectKnockRoutes,
    fetchAllSavedRoutePages,
} from '@/components/rep/repRouteCollection';


import { BRAND, DEFAULT_STATUS_COLORS, COLOR_SCHEME_MAP, LINE_DASH_MAP, ROUTE_COLORS } from '../components/map/homeMapConstants';

import { LocationMarker, MapRefHandler, MapController } from '../components/map/MapHelpers';
import useViewportMapProperties from '../components/map/useViewportMapProperties';
import { reoptimizeRoute } from '@/lib/reoptimizeRouteAction'; import { deleteSavedRoute } from '@/lib/deleteRouteAction';
import { buildRoadAwareGeneratedRoutes } from '@/lib/roadMatrixRouteGeneration'; import { requireUsableRouteContext } from '@/lib/routeContextGuard';
import { computeAccountWorkingArea } from '@/lib/accountWorkingArea';

// Pure polygon/precision-context helpers live in components/map/homeMapHelpers.js
import {
    buildPrecisionRouteShortfallMessage,
    exactPolygonKey,
    getFetchJobHistoryPolygon,
    getPrecisionJobId,
    getRequestedPrecisionCount,
    getRouteHistoryPolygon,
    mapWithConcurrency,
    mergeLogCache,
    normalizeHistoryPolygon,
    normalizeOwnershipRangeDays,
    normalizeRouteBoundsIntent,
    persistPrecisionJobContext,
    polygonHistoryKey,
    precisionCandidateRank,
    readPersistedPrecisionJobContext,
} from '../components/map/homeMapHelpers';
import { matchesDecisionFilter } from '../components/map/routeDecisionFilters'; import { deriveRouteName as buildRouteName } from '../components/map/routeNaming';



export default function Home() {
    const queryClient = useQueryClient();
    const [activeRoute, setActiveRoute] = useState(null);
    const [activeRouteSoldFilter, setActiveRouteSoldFilter] = useState('all');
    const [activeRoutePriceFilter, setActiveRoutePriceFilter] = useState('all');
    const [showChecklist, setShowChecklist] = useState(false);

    // Closing the checklist is when the map becomes worth rebuilding again.
    useEffect(() => {
        showChecklistRef.current = showChecklist;
        if (showChecklist || !mapRefreshPendingRef.current) return;
        mapRefreshPendingRef.current = false;
        queryClient.invalidateQueries({ queryKey: ['interactionLogs'] });
    }, [showChecklist, queryClient]);

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
    const [repFilter, setRepFilter] = useState('all'); const [decisionFilter, setDecisionFilter] = useState('all'); // map filter on recorded knock decisions
    const [previewRoute, setPreviewRoute] = useState(null);
    const [startLocation, setStartLocation] = useState(null); // { lat, lng, address }
    const [startAddressInput, setStartAddressInput] = useState("");
    const pendingRouteBoundsRef = useRef(null);
    const lastGeneratedRouteBoundsRef = useRef(null);
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
    const [currentBatchDataOwnershipRangeDays, setCurrentBatchDataOwnershipRangeDays] = useState(null);
    const currentBatchDataOwnershipRangeDaysRef = useRef(null);
    const [currentBatchDataOwnershipReferenceDate, setCurrentBatchDataOwnershipReferenceDate] = useState(null);
    const currentBatchDataOwnershipReferenceDateRef = useRef(null);
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
    const [canvasDrawnPolygon, setCanvasDrawnPolygon] = useState(null);
    const [canvasDraftPolygon, setCanvasDraftPolygon] = useState([]);
    const [canvasZonePreview, setCanvasZonePreview] = useState({ zones: [], workUnits: [] });
    const [drawShape, setDrawShape] = useState('circle');
    const [drawSizeMiles, setDrawSizeMiles] = useState(5);
    const [showTimingPanel, setShowTimingPanel] = useState(false);
    const [selectedProperty, setSelectedProperty] = useState(null); const [appointmentPin, setAppointmentPin] = useState(null);
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
        return saved ? JSON.parse(saved) : 4;
    });
    const [showRouteLines, setShowRouteLines] = useState(() => {
        const saved = localStorage.getItem('fk_showRouteLines_v2');
        return saved ? JSON.parse(saved) : true;
    });
    const [routeStatusView, setRouteStatusView] = useState(() => {
        try { return localStorage.getItem('fk_routeStatusView') || 'all'; } catch { return 'all'; }
    });
    const [routeMode, setRouteMode] = useState('precision');
    const routeModeRef = useRef(routeMode);
    routeModeRef.current = routeMode;
    const [canvasDraftDirty, setCanvasDraftDirty] = useState(false);
    useEffect(() => {
        window.dispatchEvent(new CustomEvent('fk-canvas-draft-dirty-changed', { detail: { dirty: canvasDraftDirty } }));
    }, [canvasDraftDirty]);
    useEffect(() => () => {
        window.dispatchEvent(new CustomEvent('fk-canvas-draft-dirty-changed', { detail: { dirty: false } }));
    }, []);
    const confirmCanvasDiscard = useCallback((action = 'Leaving Canvas') => {
        if (!canvasDraftDirty) return true;
        return window.confirm(`You have unsaved Canvas territory changes. ${action} will discard them. Continue?`);
    }, [canvasDraftDirty]);
    const requestRouteModeChange = useCallback((nextMode) => {
        if (routeMode === 'canvas' && nextMode !== 'canvas' && !confirmCanvasDiscard('Switching to Precision mode')) return false;
        setRouteMode(nextMode);
        if (nextMode !== 'canvas') setCanvasDraftDirty(false);
        return true;
    }, [confirmCanvasDiscard, routeMode]);
    const activeDrawnPolygon = routeMode === 'canvas' ? canvasDrawnPolygon : drawnPolygon;
    const activeDraftPolygon = routeMode === 'canvas' ? canvasDraftPolygon : draftPolygon;
    const setActiveDrawnPolygon = (value, persist = false) => {
        if (routeMode === 'canvas') setCanvasDrawnPolygon(value);
        else setDrawnPolygon(value, persist);
    };
    const setActiveDraftPolygon = (value) => {
        if (routeMode === 'canvas') setCanvasDraftPolygon(value);
        else setDraftPolygon(value);
    };
    const routeModeHydratedUserRef = useRef(null);
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
        excludeBusinessOwned: false,
        propertyTypes: ['Single Family'],
        minPrice: null,
        maxPrice: null,
        minYearBuilt: null,
        maxYearBuilt: null,
        includeUnverifiedSales: false,
    });
    const mapRef = useRef(null);
    const outcomeQueueRef = useRef(Promise.resolve());
    const pendingOutcomesRef = useRef(new Map());
    const showChecklistRef = useRef(false);
    const mapRefreshPendingRef = useRef(false);
    const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me(), staleTime: 1000 * 60 * 5 });
    useEffect(() => {
        if (!user?.id || routeModeHydratedUserRef.current === user.id) return;
        routeModeHydratedUserRef.current = user.id;
        let persisted = 'precision';
        try { persisted = localStorage.getItem('fk_routeMode') || 'precision'; } catch {}
        const safeMode = persisted === 'canvas' && hasCanvasAccess(user) ? 'canvas' : 'precision';
        setRouteMode(safeMode);
        if (safeMode !== persisted) {
            try { localStorage.setItem('fk_routeMode', safeMode); } catch {}
        }
    }, [user]);
    useEffect(() => {
        const handleRouteModeChange = (event) => setRouteMode(event.detail?.routeMode || 'precision');
        window.addEventListener('fk-route-mode-changed', handleRouteModeChange);
        return () => window.removeEventListener('fk-route-mode-changed', handleRouteModeChange);
    }, []);
    useEffect(() => {
        if (!user || routeMode !== 'canvas' || hasCanvasAccess(user)) return;
        setRouteMode('precision');
        try { localStorage.setItem('fk_routeMode', 'precision'); } catch {}
        window.dispatchEvent(new CustomEvent('fk-route-mode-changed', { detail: { routeMode: 'precision' } }));
    }, [routeMode, user]);
    useEffect(() => {
        if (!user?.email) return;
        const context = readPersistedPrecisionJobContext(user.email);
        if (!context) {
            setCurrentBatchDataJobId(null);
            currentBatchDataJobIdRef.current = null;
            currentBatchDataSoldMonthsRef.current = null;
            setCurrentBatchDataOwnershipRangeDays(null);
            currentBatchDataOwnershipRangeDaysRef.current = null;
            setCurrentBatchDataOwnershipReferenceDate(null);
            currentBatchDataOwnershipReferenceDateRef.current = null;
            currentBatchDataRequestedCountRef.current = null;
            currentBatchDataPolygonRef.current = null;
            return;
        }
        setCurrentBatchDataJobId(context.jobId);
        currentBatchDataJobIdRef.current = context.jobId;
        currentBatchDataSoldMonthsRef.current = context.soldMonths;
        setCurrentBatchDataOwnershipRangeDays(context.ownershipRangeDays);
        currentBatchDataOwnershipRangeDaysRef.current = context.ownershipRangeDays;
        setCurrentBatchDataOwnershipReferenceDate(context.ownershipReferenceDate);
        currentBatchDataOwnershipReferenceDateRef.current = context.ownershipReferenceDate;
        currentBatchDataRequestedCountRef.current = context.requestedCount;
        currentBatchDataPolygonRef.current = context.polygon;
    }, [user?.email]);
    const [showKnockLimitSheet, setShowKnockLimitSheet] = useState(false);
    const [knockGateMode, setKnockGateMode] = useState('limit');

    const fetchRouteCandidatesFromNeon = useCallback(async ({ zipCodes = [], zipCodeFilterValue = '', soldMonths = null, ownershipRangeDays = null, polygon = null, limit = 100000, fetchJobId = null } = {}) => {
        const customOwnershipRange = normalizeOwnershipRangeDays(ownershipRangeDays);
        const res = await base44.functions.invoke('getRouteCandidatesFromNeon', {
            zip_codes: zipCodes,
            zip_code_filter: zipCodeFilterValue,
            sold_months: soldMonths,
            ...(customOwnershipRange ? {
                ownership_range_mode: 'custom',
                ownership_min_days: customOwnershipRange[0],
                ownership_max_days: customOwnershipRange[1]
            } : {}),
            polygon,
            limit,
            fetch_job_id: fetchJobId
        });
        const data = res.data || {};
        if (data.capped === true) {
            const confirmedLimit = Math.max(
                1,
                Number(data.limit) || Number(limit) || 1
            );
            throw new Error(
                `Route candidate retrieval reached its ${confirmedLimit.toLocaleString()}-home safety window. Generation stopped before optimization so no homes could be silently omitted.`
            );
        }
        if (customOwnershipRange) {
            const confirmedRange = normalizeStrictOwnershipRangeDays(
                data.ownership_range_days ?? {
                    min: data.ownership_min_days,
                    max: data.ownership_max_days
                }
            );
            if (
                data.ownership_range_mode !== 'custom' ||
                !confirmedRange ||
                confirmedRange[0] !== customOwnershipRange[0] ||
                confirmedRange[1] !== customOwnershipRange[1]
            ) {
                throw new Error('The route-candidate service did not confirm the selected custom recorded-sale range. Route generation stopped so properties outside that range cannot be used.');
            }
        }
        return Array.isArray(data.properties) ? data.properties : [];
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
            excludeBusinessOwned: template.config.excludeBusinessOwned ?? false,
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
    const { data: teamMembers = [], isLoading: teamMembersLoading } = useQuery({
        queryKey: ['teamMembers', user?.id],
        staleTime: 1000 * 60 * 5,
        queryFn: () => {
            if (!user?.id) return [];
            return base44.entities.TeamMember.filter({ manager_id: user.id }, '-created_date', 250)
                .then(res => Array.isArray(res) ? res : (res?.items || []));
        },
        enabled: !!user?.id
    });

    const { data: canvasTeamMembers = [], isLoading: canvasTeamMembersLoading, refetch: refetchCanvasTeamMembers } = useQuery({
        queryKey: ['canvasTeamMembers', user?.id],
        staleTime: 1000 * 60 * 5,
        queryFn: () => {
            if (!user?.id) return [];
            return fetchAllCanvasTeamMembers((limit, skip) => (
                base44.entities.TeamMember.filter({ manager_id: user.id }, '-created_date', limit, skip)
            ));
        },
        enabled: !!user?.id && routeMode === 'canvas'
    });

    const refreshCanvasTeamMembers = useCallback(async () => {
        const result = await refetchCanvasTeamMembers();
        if (result.error) throw result.error;
        return result.data;
    }, [refetchCanvasTeamMembers]);

    const preparePrecisionRouteBounds = useCallback((value) => {
        const normalized = normalizeRouteBoundsIntent(value);
        pendingRouteBoundsRef.current = normalized.enabled ? normalized : null;
        return normalized;
    }, []);

    const handleSaveHomeBase = useCallback(async (value) => {
        if (!isValidRoutePoint(value)) throw new Error('Choose a valid home base first.');
        const homeBase = {
            lat: Number(value.lat),
            lng: Number(value.lng),
            ...(value.address ? { address: String(value.address).trim() } : {})
        };
        await base44.auth.updateMe({ home_base: homeBase });

        queryClient.invalidateQueries({ queryKey: ['user'] });
        return homeBase;
    }, [queryClient]);

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
            const currentRoute = savedRoutes.find(route => route.id === routeId) || (activeRoute?.id === routeId ? activeRoute : null);
            const assignmentChanged = !currentRoute || currentRoute.assigned_to !== memberId;
            const assignmentUpdate = {
                assigned_to: memberId,
                assigned_to_name: assigneeName,
                status: 'ACTIVE',
                ...(assignmentChanged ? {
                    start_location: null,
                    end_location: null,
                    route_origin_mode: 'none',
                    metadata: {
                        ...(currentRoute?.metadata || {}),
                        route_bounds: { enabled: false, cleared_reason: 'assignee_changed' }
                    }
                } : {})
            };

            await base44.entities.SavedRoute.update(routeId, assignmentUpdate);
            queryClient.invalidateQueries({ queryKey: ['savedRoutes'] });
            toast.success(`Assigned to ${assigneeName || 'Unassigned'}`);

            // Update local state if active
            if (activeRoute && activeRoute.id === routeId) {
                setActiveRoute(prev => ({ ...prev, ...assignmentUpdate }));
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

    const savedRouteScope = useMemo(() => buildRepRouteScope(user), [user]);
    const { data: savedRoutesRaw = [] } = useQuery({
        queryKey: [
            'savedRoutes',
            savedRouteScope.userId,
            savedRouteScope.managerId,
            savedRouteScope.managerAccount ? 'manager' : 'rep',
            savedRouteScope.userEmail,
        ],
        staleTime: 1000 * 60 * 2,
        refetchOnWindowFocus: true,
        queryFn: async () => {
            if (!user?.id) return [];
            const fetchRouteGroup = (filter) => fetchAllSavedRoutePages((limit, skip) => (
                base44.entities.SavedRoute.filter(filter, '-created_date', limit, skip)
            ));
            const routeGroups = await Promise.all(
                buildSavedRouteQueryFilters(savedRouteScope).map(fetchRouteGroup)
            );
            return collectKnockRoutes(routeGroups, savedRouteScope);
        },
        enabled: !!user?.id
    });
    const allSavedRoutes = Array.isArray(savedRoutesRaw) ? savedRoutesRaw : (savedRoutesRaw?.items || []);
    const savedRoutes = useMemo(
        () => filterRoutesByStatus(allSavedRoutes, 'all'),
        [allSavedRoutes]
    );
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
            const existing = byKey.get(key);
            const existingTime = new Date(existing?.last_pull_date || existing?.date || 0).getTime();
            const incomingTime = new Date(entry.last_pull_date || entry.date || 0).getTime();
            if (existing && Number.isFinite(existingTime) && (!Number.isFinite(incomingTime) || existingTime > incomingTime)) {
                return;
            }
            byKey.set(key, {
                ...existing,
                ...entry,
                polygon,
                queried: true,
                source: 'server'
            });
        };

        allSavedRoutes.forEach((route) => {
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
            const jobMetadata = job.dry_run_metadata || {};
            const jobOwnershipRangeDays = normalizeOwnershipRangeDays(
                job.ownership_range_days ?? jobMetadata.ownership_range_days
            );
            const jobOwnershipRangeMode = (
                job.ownership_range_mode ?? jobMetadata.ownership_range_mode
            ) === 'custom' && jobOwnershipRangeDays ? 'custom' : 'quick';
            addEntry(polygon, {
                id: `job_${job.id}`,
                job_id: job.id,
                date: job.completed_at || job.updated_date || job.created_date,
                last_pull_date: job.completed_at || job.updated_date || job.created_date,
                criteria: {
                    requested_properties: jobMetadata.requested_properties || job.requested_properties || job.total_expected || job.active_count || null,
                    count_mode: jobMetadata.count_mode || null,
                    sold_months: job.sold_months || job.fetch_months || null,
                    ownership_range_mode: jobOwnershipRangeMode,
                    ownership_range_days: jobOwnershipRangeDays
                        ? { min: jobOwnershipRangeDays[0], max: jobOwnershipRangeDays[1] }
                        : null,
                    min_price: job.min_price ?? job.filters?.min_price ?? jobMetadata.filters?.min_price ?? null,
                    max_price: job.max_price ?? job.filters?.max_price ?? jobMetadata.filters?.max_price ?? null
                }
            });
        });

        return Array.from(byKey.values())
            .filter((entry) => entry.polygon?.length >= 3)
            .sort((a, b) => new Date(b.last_pull_date || b.date || 0) - new Date(a.last_pull_date || a.date || 0))
            .slice(0, 20);
    }, [allSavedRoutes, precisionFetchJobs]);

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

    // Route naming lives in components/map/routeNaming.js
    const deriveRouteName = (route) => buildRouteName(route, savedRoutes);

    const handleSaveRoute = async (route, assignedRepId = null, assignedRepName = null, silent = false) => {
        const defaultAssigneeId = assignedRepId || user?.id;
        const defaultAssigneeName = assignedRepName || user?.full_name || 'Me';
        const baseRouteName = deriveRouteName(route);
        const isGeneratedRoute = !route?.isSaved && Array.isArray(route?.properties) && route.properties.length > 0;
        const routeMode = route.route_mode || 'precision';
        const jobPrecisionPolygon = normalizeHistoryPolygon(currentBatchDataPolygonRef.current);
        const drawnPrecisionPolygon = normalizeHistoryPolygon(drawnPolygon);
        const currentPrecisionPolygon = routeMode === 'precision'
            ? (jobPrecisionPolygon.length >= 3 ? jobPrecisionPolygon : drawnPrecisionPolygon)
            : [];
        const currentOwnershipRangeDays = normalizeOwnershipRangeDays(currentBatchDataOwnershipRangeDaysRef.current);
        const generatedAt = new Date().toISOString();
        const precisionAreaMetadata = isGeneratedRoute && currentPrecisionPolygon.length >= 3
            ? {
                precision_area: {
                    polygon: currentPrecisionPolygon,
                    job_id: currentBatchDataJobIdRef.current || currentBatchDataJobId || null,
                    last_pull_date: generatedAt,
                    date: generatedAt,
                    criteria: {
                        requested_properties: currentBatchDataRequestedCountRef.current || null,
                        sold_months: currentBatchDataSoldMonthsRef.current || soldDateFilter || null,
                        ownership_range_mode: currentOwnershipRangeDays ? 'custom' : 'quick',
                        ownership_range_days: currentOwnershipRangeDays
                            ? { min: currentOwnershipRangeDays[0], max: currentOwnershipRangeDays[1] }
                            : null,
                        route_mode: routeMode,
                        pull_mode: lastPullMode || null
                    }
                }
            }
            : {};
        // No "New —" name prefix — the NEW badge (from metadata.newly_generated) marks fresh routes instead.
        const routeName = baseRouteName.replace(/^New\s*[—-]\s*/i, '');

        const requestedRouteOriginMode = ['home_round_trip', 'current_to_home'].includes(route?.routeOriginMode || route?.route_origin_mode)
            ? (route.routeOriginMode || route.route_origin_mode)
            : 'none';
        const sourceAssigneeId = route?.assigned_to || null;
        const canPreserveRequestedBounds = requestedRouteOriginMode !== 'none' && (
            sourceAssigneeId
                ? sourceAssigneeId === defaultAssigneeId
                : defaultAssigneeId === user?.id
        );
        const routeOriginMode = canPreserveRequestedBounds ? requestedRouteOriginMode : 'none';
        const routeWasExplicitlyUnbounded = route?.routeOriginMode === 'none' || route?.route_origin_mode === 'none';
        const routeStartLocation = canPreserveRequestedBounds && isValidRoutePoint(route?.startLocation || route?.start_location)
            ? (route.startLocation || route.start_location)
            : requestedRouteOriginMode !== 'none' || routeWasExplicitlyUnbounded
                ? null
                : startLocation;
        const routeEndLocation = canPreserveRequestedBounds && isValidRoutePoint(route?.endLocation || route?.end_location)
            ? (route.endLocation || route.end_location)
            : null;
        // Removing another user's private route bounds must not replace a
        // road-aware order with the old aerial-only optimizer. The door order
        // and its non-personal road geometry remain valid without the bounds.
        const savedProperties = route.properties;
        if (
            !Array.isArray(savedProperties)
            || savedProperties.length === 0
            || savedProperties.some((property) => !isStrictRoutePropertyPoint(property))
        ) {
            throw new Error('Route integrity verification failed before save: one or more homes have an invalid map pin.');
        }
        const savedPropertyOrderFingerprint = routePropertyOrderFingerprint(savedProperties);
        const sourceGeometryMatchesSavedOrder =
            route?.metadata?.routing?.property_order_fingerprint === savedPropertyOrderFingerprint;
        const roadGeometry = sourceGeometryMatchesSavedOrder
            && Array.isArray(route?.metadata?.road_geometry)
            && route.metadata.road_geometry.length > 1
            ? route.metadata.road_geometry
            : null;
        const doorOnlyDistance = roadGeometry
            ? calculateRouteDistanceMiles(roadGeometry)
            : calculateRouteDistanceMiles(savedProperties);
        const savedDistance = requestedRouteOriginMode !== 'none' && !canPreserveRequestedBounds
            ? Math.round(doorOnlyDistance * 100) / 100
            : route.totalDistance;
        const savedRouteStartLocation = routeOriginMode === 'none'
            ? routeStartLocation
            : null;
        const savedRouteEndLocation = routeOriginMode === 'none'
            ? routeEndLocation
            : null;

        const safeRouteMetadata = { ...(route.metadata || {}) };
        if (!canPreserveRequestedBounds) delete safeRouteMetadata.route_bounds;
        if (!sourceGeometryMatchesSavedOrder) {
            delete safeRouteMetadata.road_geometry;
            delete safeRouteMetadata.routing;
        }

        const savedPropertyHashes = savedProperties.map(p => p.address_hash || p.legacy_hash || p.id).filter(Boolean);
        if (
            savedPropertyHashes.length !== savedProperties.length
            || new Set(savedPropertyHashes.map(String)).size !== savedProperties.length
        ) {
            throw new Error('Route integrity verification failed before save. No homes were persisted.');
        }
        if (sourceGeometryMatchesSavedOrder && safeRouteMetadata.road_geometry && safeRouteMetadata.routing) {
            safeRouteMetadata.routing = {
                ...safeRouteMetadata.routing,
                property_order_fingerprint: routePropertyOrderFingerprint(savedPropertyHashes)
            };
        }
        const precisionJobId = precisionAreaMetadata.precision_area?.job_id;

        // A completed FetchJob can be recovered after a reload. If the browser
        // closed after this chunk was saved but before its recovery key was
        // cleared, treat replaying the same job/property set as idempotent.
        if (isGeneratedRoute && precisionJobId && savedPropertyHashes.length > 0) {
            const savedHashSet = new Set(savedPropertyHashes);
            const existingJobRoute = savedRoutes.find(existingRoute => {
                const existingHashes = (existingRoute?.property_hashes || []).filter(Boolean);
                return existingRoute?.metadata?.precision_area?.job_id === precisionJobId
                    && existingHashes.length === savedPropertyHashes.length
                    && existingHashes.every(hash => savedHashSet.has(hash));
            });

            if (existingJobRoute) {
                console.info(`[RoutePipeline] Skipping duplicate recovered route for precision job ${precisionJobId}.`);
                return existingJobRoute;
            }
        }

        // @ts-ignore - 'mutateAsync' incorrectly expects 'void' instead of the data object
        return await createRouteMutation.mutateAsync({
            name: routeName,
            route_mode: routeMode,
            property_hashes: savedPropertyHashes,
            metrics: {
                distance: savedDistance,
                house_count: savedProperties.length,
                score: route.competitivenessScore
            },
            status: 'ACTIVE',
            start_location: savedRouteStartLocation,
            ...(savedRouteEndLocation ? { end_location: savedRouteEndLocation } : {}),
            route_origin_mode: routeOriginMode,
            assigned_to: defaultAssigneeId,
            assigned_to_name: defaultAssigneeName,
            manager_id: user.id,
            metadata: isGeneratedRoute ? { ...safeRouteMetadata, ...precisionAreaMetadata, newly_generated: true, generated_at: generatedAt } : safeRouteMetadata,
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

    // Outcomes whose write has not settled yet survive any refetch that lands in
    // the meantime, so a checklist stop never flickers back to Todo under the rep.
    const withPendingOutcomes = useCallback((rows, addressHash = null) => {
        const unretired = collectUnretiredOutcomes(pendingOutcomesRef.current, rows, addressHash);
        return unretired.length ? [...rows, ...unretired] : rows;
    }, []);

    const { data: logsRaw = [], isLoading: logsLoading } = useQuery({
        queryKey: ['interactionLogs', user?.email],
        staleTime: 1000 * 60 * 2,
        queryFn: async () => {
            if (!user) return withPendingOutcomes([]);
            return withPendingOutcomes(await fetchAccountInteractionLogs(user));
        },
        enabled: !!user
    });

    // Org scoping lives in lib/accountInteractionLogs.js — see the note there on
    // service-written outcome rows.
    const logs = useMemo(
        () => scopeInteractionLogsToAccount(logsRaw, user, teamMembers),
        [logsRaw, user, teamMembers]
    );

    // The checklist reads its outcomes exactly the way the knock tab does: a
    // route-scoped filter, no 5000-row global list and no org email filter on
    // top. Those two extra hops are what kept losing a freshly logged row and
    // letting a stop revert to Todo.
    const { data: checklistLogs = [] } = useQuery({
        queryKey: ['routeChecklistLogs', activeRoute?.id],
        queryFn: async () => {
            const hashes = activeRoute?.property_hashes || [];
            if (!hashes.length && !activeRoute?.id) return withPendingOutcomes([]);
            const [hashLogsRes, routeLogsRes] = await Promise.all([
                hashes.length
                    ? base44.entities.InteractionLog.filter({ address_hash: hashes }, '-created_date', 1000)
                    : [],
                activeRoute?.id
                    ? base44.entities.InteractionLog.filter({ route_id: activeRoute.id }, '-created_date', 1000)
                    : []
            ]);
            const merged = [
                ...(Array.isArray(hashLogsRes) ? hashLogsRes : hashLogsRes?.items || []),
                ...(Array.isArray(routeLogsRes) ? routeLogsRes : routeLogsRes?.items || [])
            ];
            const seen = new Set();
            return withPendingOutcomes(merged.filter((log) => {
                const key = log.id || `${log.address_hash}-${log.created_date}-${log.parsed_status}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            }));
        },
        enabled: !!activeRoute?.id
    });
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
            const repLogs = logs.filter(l => isKnockActivityLog(l) && l.created_by === rep.email).sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
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
            const repLogs = logs.filter(l => isKnockActivityLog(l) && l.created_by === rep.email);
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
                // Saving for another rep automatically removes any private
                // start/end bounds and reorders the doors as a normal route.
                await handleSaveRoute(route, bestRep.id, bestRep.name);
                tempBusyCounts[bestRep.id] = (tempBusyCounts[bestRep.id] || 0) + 1;
            }
        }
        setShowRoutePanel(false);
    };

    // Optimistic outcome rows are keyed by their own id so a rollback removes one
    // failed write without discarding outcomes the rep logged after it.
    // Every cache the checklist or the detail sheet reads from has to be kept in
    // step; a row applied to only some of them is a stop that reverts.
    //
    // The global interactionLogs cache is deliberately NOT one of them. `logs`
    // feeds effectiveProperties, which walks every property on the map, so
    // touching it on tap made the whole page recompute before the stop could
    // repaint — the exact latency this optimistic path exists to remove. The map
    // picks the row up on the refetch in onSettled, off the tap path.
    const writeToLogCaches = useCallback((addressHash, mutate) => {
        const apply = (old) => mergeLogCache(old, mutate);
        queryClient.setQueryData(['routeChecklistLogs', activeRoute?.id], apply);
        queryClient.setQueryData(['selectedPropertyHistory', addressHash], apply);
    }, [queryClient, activeRoute?.id]);

    const applyOptimisticLog = useCallback((entry) => {
        pendingOutcomesRef.current.set(entry.id, entry);
        writeToLogCaches(entry.address_hash, (rows) => [...rows, entry]);
    }, [writeToLogCaches]);

    const replaceOptimisticLog = useCallback((optimisticId, confirmedRow) => {
        if (!optimisticId || !confirmedRow) return;
        writeToLogCaches(confirmedRow.address_hash, (rows) => [
            ...rows.filter((log) => log?.id !== optimisticId && log?.id !== confirmedRow.id),
            confirmedRow
        ]);
    }, [writeToLogCaches]);

    const dropOptimisticLog = useCallback((optimisticId, addressHash) => {
        if (!optimisticId) return;
        pendingOutcomesRef.current.delete(optimisticId);
        writeToLogCaches(addressHash, (rows) => rows.filter((log) => log?.id !== optimisticId));
    }, [writeToLogCaches]);

    const createLogMutation = useMutation({
        mutationFn: async (logData) => {
            const { optimistic_id, ...persistedLog } = logData;
            const response = await base44.functions.invoke('recordKnockOutcome', {
                action: 'record',
                idempotency_key: createOutcomeIdempotencyKey('manager-knock'),
                interaction: {
                    ...persistedLog,
                    route_id: persistedLog.route_id || activeRoute?.id || null
                }
            });
            return response.data;
        },
        onSettled: () => {
            // The optimistic row is deliberately left in place here;
            // withPendingOutcomes retires it when the refetch below actually
            // returns the server row.
            queryClient.invalidateQueries({ queryKey: ['routeChecklistLogs'] });
            queryClient.invalidateQueries({ queryKey: ['selectedPropertyHistory'] });

            // Refreshing the global log list re-pulls 5000 rows and rebuilds
            // effectiveProperties across the whole map. While the rep is working
            // the checklist that is pure jank behind a panel they cannot see, so
            // it is deferred until the checklist closes.
            if (showChecklistRef.current) {
                mapRefreshPendingRef.current = true;
                return;
            }
            queryClient.invalidateQueries({ queryKey: ['interactionLogs'] });
        },
        onSuccess: (result, logData) => {
            // Swap the authoritative row in for the optimistic sketch. The stop
            // then reflects the real record and holds regardless of whether the
            // list query returns it — which is what kept flipping it back.
            const confirmed = confirmOutcomeRow(
                pendingOutcomesRef.current,
                logData?.optimistic_id,
                result?.interaction
            );
            if (confirmed) replaceOptimisticLog(logData?.optimistic_id, confirmed);

            if (Number.isFinite(result?.outcomes_logged)) {
                queryClient.setQueryData(['user'], (current) => ({
                    ...(current || user || {}),
                    outcomes_logged: result.outcomes_logged
                }));
            }
        },
        onError: (error, logData) => {
            // A reverted stop means the write failed; leave the reason in the
            // console so it can be read back without reproducing the tap.
            console.error('[Home] Outcome write failed; rolling the stop back', error);
            dropOptimisticLog(logData?.optimistic_id, logData?.address_hash);
            const gate = getOutcomeGateFromError(error);
            if (gate) {
                setKnockGateMode(gate);
                setShowKnockLimitSheet(true);
                return;
            }
            toast.error(
                error?.response?.data?.error
                || error?.message
                || 'Outcome could not be saved. Please try again.'
            );
        }
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
        const logsByAddress = buildLogsByAddress(logs); const propsByHash = new Map();
        effectiveProperties.forEach(p => {
            if (p.address_hash) propsByHash.set(p.address_hash, p);
            if (p.legacy_hash) propsByHash.set(p.legacy_hash, p);
        });

        const routesForDisplay = filterRoutesByStatus(
            serverHydratedSavedRoutes.length > 0 ? serverHydratedSavedRoutes : savedRoutes,
            'all'
        );

        return routesForDisplay
            .filter(r => repFilter === 'all' || (r.assigned_to_name && r.assigned_to_name.includes(repFilter)))
            .map(route => {
                const routeHashes = Array.isArray(route.property_hashes) ? route.property_hashes : [];
                const hydratedProps = Array.isArray(route.properties)
                    ? route.properties.filter(isRenderableMapPoint)
                    : [];
                const allRouteProps = withDerivedStatus(hydratedProps.length > 0 ? hydratedProps : routeHashes
                    .map(hash => propsByHash.get(hash))
                    .filter(Boolean), logsByAddress, propsByHash);
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
                    // Keep the saved manifest count stable during a transient
                    // partial hydration; map pins repair independently.
                    houseCount: routeHashes.length || route.metrics?.house_count || routeProps.length,
                    totalDistance: route.metrics?.distance || 0,
                    competitivenessScore: route.metrics?.score || 0,
                    isSaved: true,
                    isCompleted
                };
            }).filter(r => r.houseCount > 0)
            .sort((a, b) => (b.competitivenessScore || 0) - (a.competitivenessScore || 0));
    }, [savedRoutes, serverHydratedSavedRoutes, effectiveProperties, repFilter, logs]);

    useEffect(() => {
        if (!hydratedSavedRoutes.length || routeStatusView === 'all') return;
        const hasCompletedRoutes = hydratedSavedRoutes.some(route => route.status === 'COMPLETED');
        const hasActiveRoutes = hydratedSavedRoutes.some(route => route.status !== 'COMPLETED');
        const selectedBucketHasRoutes = routeStatusView === 'completed'
            ? hasCompletedRoutes
            : hasActiveRoutes;
        if (!selectedBucketHasRoutes) setRouteStatusView('all');
    }, [hydratedSavedRoutes, routeStatusView]);

    const savedRouteOverviewPoints = useMemo(() => {
        const points = [];
        for (const route of hydratedSavedRoutes) {
            for (const property of route.properties || []) {
                if (!isRenderableMapPoint(property)) continue;
                points.push([Number(property.lat), Number(property.lng)]);
                if (points.length >= 2000) return points;
            }
        }
        return points;
    }, [hydratedSavedRoutes]);

    const savedRouteOverviewKey = useMemo(() => (
        hydratedSavedRoutes
            .map(route => `${route.id || ''}:${route.updated_date || ''}:${(route.properties || []).length}`)
            .join('|')
    ), [hydratedSavedRoutes]);
    // Note: Initial map positioning is managed authoritatively by computeAccountWorkingArea effect.
    // We do not fit bounds on savedRouteOverviewKey here to prevent asynchronous saved route hydration from overriding the working area.

    // Extract unique reps from saved routes for filter
    const uniqueReps = useMemo(() => {
        const reps = new Set(savedRoutes.map(r => r.assigned_to_name).filter(Boolean));
        return Array.from(reps);
    }, [savedRoutes]);


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

    useAppointmentMapFocus({
        savedRoutes, activeRoute, effectiveProperties, mapRef,
        setMode: setModeRaw, setShowRoutePanel, setShowCompare, setSelectedProperty, setAppointmentPin,
    });

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
            const rawUiGenerationPolygon = Array.isArray(drawnPolygon) && drawnPolygon.length > 2
                ? drawnPolygon
                : Array.isArray(draftPolygon) && draftPolygon.length > 2
                    ? draftPolygon
                    : Array.isArray(storedPolygon) && storedPolygon.length > 2
                        ? storedPolygon
                        : null;
            const activeFetchJobId = currentBatchDataJobIdRef.current || currentBatchDataJobId;
            const currentJobPolygon = normalizeHistoryPolygon(currentBatchDataPolygonRef.current);
            const normalizedUiPolygon = normalizeHistoryPolygon(rawUiGenerationPolygon);
            const activeGenerationPolygon = normalizedUiPolygon.length > 2
                ? normalizedUiPolygon
                : (activeFetchJobId && currentJobPolygon.length > 2 ? currentJobPolygon : null);
            console.log(`[generateRoutes] Polygon source: job=${currentJobPolygon.length}, state=${Array.isArray(drawnPolygon) ? drawnPolygon.length : 0}, draft=${Array.isArray(draftPolygon) ? draftPolygon.length : 0}, stored=${Array.isArray(storedPolygon) ? storedPolygon.length : 0}`);
            const activeCustomOwnershipRangeDays = activeFetchJobId
                ? normalizeOwnershipRangeDays(currentBatchDataOwnershipRangeDaysRef.current)
                : null;
            const activePolygonKey = activeGenerationPolygon
                ? (activeCustomOwnershipRangeDays ? exactPolygonKey(activeGenerationPolygon) : polygonHistoryKey(activeGenerationPolygon))
                : null;
            const currentJobPolygonKey = currentJobPolygon.length > 2
                ? (activeCustomOwnershipRangeDays ? exactPolygonKey(currentJobPolygon) : polygonHistoryKey(currentJobPolygon))
                : null;
            const requestedPrecisionCount = activeFetchJobId ? currentBatchDataRequestedCountRef.current : null;
            const isCurrentBatchDataRun = !!activeFetchJobId && !!activeGenerationPolygon && !!activePolygonKey && activePolygonKey === currentJobPolygonKey;
            const effectiveGenerationSoldFilter = isCurrentBatchDataRun ? (currentBatchDataSoldMonthsRef.current || soldDateFilter) : soldDateFilter;
            const effectiveGenerationOwnershipRangeDays = isCurrentBatchDataRun
                ? activeCustomOwnershipRangeDays
                : null;
            const effectiveGenerationOwnershipReferenceDate = isCurrentBatchDataRun
                ? currentBatchDataOwnershipReferenceDateRef.current
                : null;
            if (activeCustomOwnershipRangeDays && !isCurrentBatchDataRun) {
                toast.dismiss('build-routes');
                setGenerationError('The selected map area no longer matches the completed custom-range import. Route generation stopped so account-wide properties or properties from another date range cannot be substituted. Re-select the completed area and try again.');
                return false;
            }
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
                    ownershipRangeDays: effectiveGenerationOwnershipRangeDays,
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
                soldDateFilter: effectiveGenerationSoldFilter,
                ownershipRangeDays: effectiveGenerationOwnershipRangeDays,
                ownershipRangeReferenceDate: effectiveGenerationOwnershipReferenceDate,
                routeConfig: effectiveRouteConfig, lastPullMode, logsByAddress, assignedHashes,
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
            const preparedRouteBounds = normalizeRouteBoundsIntent(pendingRouteBoundsRef.current);
            const start = preparedRouteBounds.enabled
                ? preparedRouteBounds.startLocation
                : startLocation || (currentCenter ? { lat: currentCenter.lat, lng: currentCenter.lng } : null);
            const end = preparedRouteBounds.enabled
                ? preparedRouteBounds.endLocation
                : routeConfig.returnToStart && isValidRoutePoint(start)
                    ? start
                    : null;
            const routeOriginMode = preparedRouteBounds.enabled ? preparedRouteBounds.mode : 'none';
            const finalCount = workingSet.length; const filteredOut = initialCount - finalCount; const effectiveUse2Opt = finalCount > 3000 ? false : routeConfig.use2Opt;
            if (finalCount > 3000 && routeConfig.use2Opt) console.warn(`[generateRoutes] Auto-disabled 2-Opt (n=${finalCount} > 3K)`);
            const optStart = performance.now();
            setGenerationStage(`Optimizing ${finalCount.toLocaleString()} doors — ~${Math.max(2, Math.round(finalCount / 1500))}s`);
            toast.loading(`Optimizing ${finalCount.toLocaleString()} properties${filteredOut > 0 ? ` (${filteredOut.toLocaleString()} filtered)` : ''}... ~${Math.max(2, Math.round(finalCount / 1500))}s`, { id: 'build-routes' });
            console.log(`[generateRoutes] Opt start | n=${finalCount} | 2opt=${effectiveUse2Opt}`);
            const routingContext = finalCount <= 5000
                ? createRouteContinuityContext(workingSet)
                : null;
            if (finalCount <= 5000) requireUsableRouteContext(routingContext);
            const largeRouteResult = finalCount > 5000
                ? await optimizeLargeRoutesAsync({
                    properties: workingSet,
                    housesPerRoute,
                    startLocation: start,
                    optimizerOptions: {
                        streetCooldownDays,
                        useStreetSweep: routeConfig.walkingPattern === 'street_sweep',
                        minimizeTurns: routeConfig.minimizeTurns,
                        walkingPattern: routeConfig.walkingPattern,
                        returnToStart: !preparedRouteBounds.enabled && routeConfig.returnToStart,
                        endLocation: end,
                        routeOriginMode,
                        excludeTerminal: routeConfig.excludeTerminal,
                    },
                    allLogs: logs,
                    learnedWeights,
                })
                : null;
            const rawGenerated = largeRouteResult
                ? largeRouteResult.routes
                : await new Promise(resolve => setTimeout(() => resolve(generateOptimizedRoutes(workingSet, housesPerRoute, start, logs, { streetCooldownDays, useStreetSweep: routeConfig.walkingPattern === 'street_sweep', minimizeTurns: routeConfig.minimizeTurns, use2Opt: effectiveUse2Opt, walkingPattern: routeConfig.walkingPattern, returnToStart: !preparedRouteBounds.enabled && routeConfig.returnToStart, endLocation: end, routeOriginMode, excludeTerminal: routeConfig.excludeTerminal, routingContext }, learnedWeights)), 50));
            // ROAD-AWARE BY DEFAULT: the continuity candidate is re-priced through the
            // same backend OSRM pipeline the Optimize button uses, and the road order is
            // kept only when it measures better on one shared matrix. Every failure path
            // (timeout, rate limit, >100 doors, no gain) keeps the continuity route.
            const roadMatrixPass = await buildRoadAwareGeneratedRoutes({ rawGenerated, routingContext, onStage: setGenerationStage });
            const generated = roadMatrixPass.routes;
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
                    savedRecords = await mapWithConcurrency(
                        saveable,
                        4,
                        (route) => handleSaveRoute(route, null, null, true)
                    );
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

            toast.success(finalToastMsg + (roadMatrixPass.appliedCount > 0 ? ` — real road distances saved ~${roadMatrixPass.savedMiles} mi` : ''), { id: 'build-routes', duration: 5000 });
            lastGeneratedRouteBoundsRef.current = preparedRouteBounds.enabled ? preparedRouteBounds : null;
            if (preparedRouteBounds.enabled) preparePrecisionRouteBounds({ enabled: false });
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
    }, [availableProperties, housesPerRoute, startLocation, logs, streetCooldownDays, zipCodeFilter, assignedHashes, routeConfig, soldDateFilter, drawnPolygon, draftPolygon, frozenWorkingSet, effectiveProperties, fetchRouteCandidatesFromNeon, currentBatchDataJobId, preparePrecisionRouteBounds, user?.territory_zip_codes, user?.generated_zip_codes, user?.email]);

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
                soldDateFilter,
                ownershipRangeDays: normalizeOwnershipRangeDays(currentBatchDataOwnershipRangeDaysRef.current),
                ownershipRangeReferenceDate: currentBatchDataOwnershipReferenceDateRef.current,
                routeConfig, lastPullMode, logsByAddress: logsByAddr, assignedHashes,
            });
            console.log(`[handleReorder] Filter funnel: ${formatStageCounts(filterResult.stages)}`);
            if (filterResult.error) { toast.dismiss('reorder-routes'); setGenerationError(filterResult.error); return false; }
            const workingSet = filterResult.workingSet;
            const effectiveUse2Opt = workingSet.length > 3000 ? false : routeConfig.use2Opt;
            const reorderBounds = normalizeRouteBoundsIntent(lastGeneratedRouteBoundsRef.current);
            const start = reorderBounds.enabled
                ? reorderBounds.startLocation
                : startLocation || (mapRef.current ? { lat: mapRef.current.getCenter().lat, lng: mapRef.current.getCenter().lng } : null);
            const end = reorderBounds.enabled
                ? reorderBounds.endLocation
                : routeConfig.returnToStart && isValidRoutePoint(start) ? start : null;
            const routeOriginMode = reorderBounds.enabled ? reorderBounds.mode : 'none';
            const routingContext = workingSet.length <= 5000
                ? createRouteContinuityContext(workingSet)
                : null;
            if (workingSet.length <= 5000) requireUsableRouteContext(routingContext);
            const largeRouteResult = workingSet.length > 5000
                ? await optimizeLargeRoutesAsync({
                    properties: workingSet,
                    housesPerRoute,
                    startLocation: start,
                    optimizerOptions: {
                        streetCooldownDays,
                        useStreetSweep: routeConfig.walkingPattern === 'street_sweep',
                        minimizeTurns: routeConfig.minimizeTurns,
                        walkingPattern: routeConfig.walkingPattern,
                        returnToStart: !reorderBounds.enabled && routeConfig.returnToStart,
                        endLocation: end,
                        routeOriginMode,
                        excludeTerminal: routeConfig.excludeTerminal,
                    },
                    allLogs: logs,
                    learnedWeights,
                })
                : null;
            const rawGenerated = largeRouteResult
                ? largeRouteResult.routes
                : generateOptimizedRoutes(workingSet, housesPerRoute, start, logs, { streetCooldownDays, useStreetSweep: routeConfig.walkingPattern === 'street_sweep', minimizeTurns: routeConfig.minimizeTurns, use2Opt: effectiveUse2Opt, walkingPattern: routeConfig.walkingPattern, returnToStart: !reorderBounds.enabled && routeConfig.returnToStart, endLocation: end, routeOriginMode, excludeTerminal: routeConfig.excludeTerminal, routingContext }, learnedWeights);
            // Reorder runs the identical road-aware pipeline as Create Route.
            const roadMatrixPass = await buildRoadAwareGeneratedRoutes({ rawGenerated, routingContext, onStage: setGenerationStage });
            const generated = roadMatrixPass.routes;
            setRoutes(generated);
            let savedRecords = [];
            if (generated.length > 0) {
                const bulkId = toast.loading(`Auto-saving ${generated.length} routes...`);
                try {
                    savedRecords = await mapWithConcurrency(
                        generated,
                        4,
                        (route) => handleSaveRoute(route, null, null, true)
                    );
                    toast.success(`Reordered into ${generated.length} routes`, { id: bulkId, duration: 3000 });
                    setModeRaw('analyze');
                    setRoutes([]);
                } catch (e) { toast.error('Auto-save failed.', { id: bulkId }); }
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
        } catch (e) {
            console.error('Reorder error:', e);
            toast.error(
                e?.message || 'Reorder failed. No routes were changed.',
                { id: 'reorder-routes', duration: 6000 }
            );
            return false;
        }
        finally { setRoutesGenerating(false); }
    }, [frozenWorkingSet, housesPerRoute, startLocation, logs, streetCooldownDays, zipCodeFilter, routeConfig, soldDateFilter, drawnPolygon, lastPullMode, learnedWeights, user?.territory_zip_codes, assignedHashes]);

    // Re-optimize a single saved route while keeping each street sweep contiguous.
    // Injectable so the low-accuracy interaction is executable in tests rather
    // than only reachable through a real browser dialog.
    const confirmLowAccuracyLocation = useCallback(
        (message) => (typeof window !== 'undefined' && typeof window.confirm === 'function'
            ? window.confirm(message)
            : true),
        []
    );

    // Optimize modes AND custom ANCHORS both run through the extracted action —
    // see lib/reoptimizeRouteAction.js. Options are either { mode } / { fromHome }
    // or { anchors: { start, end } } (anchors: null clears them).
    const handleReoptimizeRoute = useCallback((route, options = {}) => reoptimizeRoute(route, options, {
        user, teamMembers, effectiveProperties, mapRef, queryClient, activeRoute, setActiveRoute,
        confirmLowAccuracyLocation,
    }), [activeRoute, confirmLowAccuracyLocation, effectiveProperties, queryClient, teamMembers, user]);

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
    }, [activeRouteId]); const statusSyncedActiveRoute = useMemo(() => (filteredActiveRoute ? { ...filteredActiveRoute, properties: withDerivedStatus(filteredActiveRoute.properties || [], buildLogsByAddress(logs)) } : filteredActiveRoute), [filteredActiveRoute, logs]); /* A decision filter turns the map into a pure outcome view: only doors with that outcome are drawn. */ const decisionFiltered = useCallback((route) => (decisionFilter === 'all' || !route ? route : { ...route, properties: (route.properties || []).filter(p => matchesDecisionFilter(p, decisionFilter)) }), [decisionFilter]); const decisionFilteredActiveRoute = useMemo(() => decisionFiltered(statusSyncedActiveRoute), [statusSyncedActiveRoute, decisionFiltered]); const decisionFilteredSavedRoutes = useMemo(() => (decisionFilter === 'all' ? hydratedSavedRoutes : hydratedSavedRoutes.map(decisionFiltered).filter(r => r.properties.length > 0)), [hydratedSavedRoutes, decisionFilter, decisionFiltered]);

    // Account Active Working Area Resolver — see lib/accountWorkingArea.js
    const resolveAccountWorkingArea = useCallback(() => computeAccountWorkingArea({
        drawnPolygon, user, savedRoutes, hydratedSavedRoutes, precisionFetchJobs, availableProperties,
    }), [drawnPolygon, user, savedRoutes, hydratedSavedRoutes, precisionFetchJobs, availableProperties]);

    // Initial Account Working Area Map Load Effect
    const hasCenteredAccountWorkingAreaRef = useRef(false);
    useEffect(() => {
        if (hasCenteredAccountWorkingAreaRef.current || !mapRef.current) return;

        const workingArea = resolveAccountWorkingArea();
        if (!workingArea) return;

        hasCenteredAccountWorkingAreaRef.current = true;

        if (workingArea.type === 'bounds' && workingArea.bounds.isValid()) {
            const bounds = workingArea.bounds;
            try {
                if (mapRef.current._mapPane) {
                    mapRef.current.fitBounds(bounds, { padding: [50, 50], maxZoom: 16, animate: false });
                }
            } catch (e) {}
        } else if (workingArea.type === 'center') {
            try {
                if (mapRef.current._mapPane) {
                    mapRef.current.setView(workingArea.center, workingArea.zoom, { animate: false });
                }
            } catch (e) {}
        }
    }, [resolveAccountWorkingArea]);

    // Determine Initial Map Center
    const [mapCenter, setMapCenter] = useState(() => {
        const storageKey = (user?.id || user?.email) ? `fk_last_map_position_${user?.id || user?.email}` : null;
        if (storageKey && typeof localStorage !== 'undefined') {
            try {
                const stored = JSON.parse(localStorage.getItem(storageKey));
                if (stored && Number.isFinite(stored.lat) && Number.isFinite(stored.lng) && (stored.lat !== 0 || stored.lng !== 0)) {
                    return [stored.lat, stored.lng];
                }
            } catch (e) {}
        }
        return [34.0522, -118.2437];
    });

    // On first load, get user's GPS location if no explicit account working area is stored
    useEffect(() => {
        if (!navigator.geolocation) return;
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const loc = [pos.coords.latitude, pos.coords.longitude];
                setGpsInitialLocation(loc);
                setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
                if (!hasCenteredAccountWorkingAreaRef.current) {
                    setMapCenter(loc);
                }
            },
            () => { /* GPS denied/unavailable, keep default */ },
            { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
        );
    }, []);

    const handleMapMoveEnd = useCallback((bounds) => {
        onMapMoveEnd(bounds);
        if (!mapRef.current) return;
        try {
            const c = mapRef.current.getCenter();
            const z = mapRef.current.getZoom();
            if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng) && (c.lat !== 0 || c.lng !== 0)) {
                const storageKey = (user?.id || user?.email) ? `fk_last_map_position_${user.id || user.email}` : null;
                if (storageKey && typeof localStorage !== 'undefined') {
                    localStorage.setItem(storageKey, JSON.stringify({ lat: c.lat, lng: c.lng, zoom: z }));
                }
            }
        } catch (e) {}
    }, [onMapMoveEnd, user?.id, user?.email]);

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
            return withPendingOutcomes(
                Array.isArray(res) ? res : (res?.items || []),
                selectedProperty.address_hash
            );
        },
        enabled: !!selectedProperty?.address_hash
    });

    const handleLogResult = useCallback(async (property, statusOrLogData, note = null) => {
        if (!property?.address_hash) return false;

        const logData = typeof statusOrLogData === 'object'
            ? statusOrLogData
            : {
                raw_input_text: note || statusOrLogData,
                parsed_status: statusOrLogData,
            };

        const saleSnapshot = logData.parsed_status === 'SOLD'
            ? {
                sale_date: logData.sale_date || new Date().toISOString(),
                property_address: buildFullAddress(property),
                homeowner_name: property.owner_full_name || property.owner_name || property.ownerFullName || null,
                rep_id: user?.id || null,
                rep_name: user?.full_name || user?.name || user?.email || null,
                route_name: activeRoute?.name || null,
            }
            : {};

        const optimisticId = `optimistic-${createOutcomeIdempotencyKey('manager-knock')}`;
        const enrichedLogData = {
            ...logData,
            ...saleSnapshot,
            address_hash: property.address_hash,
            optimistic_id: optimisticId,
            gps_proof_lat: property.lat,
            gps_proof_lng: property.lng,
            route_id: logData.route_id || activeRoute?.id || null
        };

        // The stop is marked on the tap; the authoritative write runs behind the
        // rep. A failure rolls that row back and surfaces the gate or an error.
        // created_by has to be set — the logs memo drops rows outside the org.
        applyOptimisticLog({
            ...enrichedLogData,
            id: optimisticId,
            created_date: new Date().toISOString(),
            created_by: user?.email || null,
        });

        // Every outcome write takes a per-user server lease, so concurrent taps
        // would collide with 409 outcome_write_in_progress. Queue them instead.
        outcomeQueueRef.current = outcomeQueueRef.current
            .then(() => createLogMutation.mutateAsync(enrichedLogData))
            .catch(() => {
                // Mutation callbacks roll the row back and display gates and errors.
            });

        return true;
    }, [activeRoute, applyOptimisticLog, createLogMutation, user]);

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
                attributionControl
                preferCanvas={true}
                wheelPxPerZoomLevel={80} zoomSnap={1} zoomDelta={1}
                wheelDebounceTime={40} maxZoom={20}
                zoomAnimation={true}
                markerZoomAnimation={true}
                fadeAnimation={true}
            >
                <MapRefHandler mapRef={mapRef} />
                <BaseMapTiles mapTheme={mapTheme} />
                <LocationMarker autoCenter={false} userLocation={userLocation} /><AppointmentFocusMarker property={appointmentPin} onSelect={setSelectedProperty} />
                <DarkRoomManager />


                {/* Map Controls Handlers */}

                <MapController
                    fitBounds={fitBounds}
                    onZoomChange={setZoomLevel}
                    onMoveEnd={handleMapMoveEnd}
                />

                <MapDrawTool
                    active={drawingMode}
                    onPointsUpdate={setActiveDraftPolygon}
                    confirmOnRelease={routeMode === 'canvas'}
                    onConfirm={(polygon) => {
                        const canvasBoundary = routeMode === 'canvas' ? validateCanvasBoundary(polygon) : null;
                        if (canvasBoundary && !canvasBoundary.valid) {
                            toast.error(canvasBoundary.message);
                            return;
                        }
                        const confirmedPolygon = canvasBoundary?.points || polygon;
                        // One active builder shape at a time. Do not save to previous-area history until a preview/query succeeds.
                        setActiveDrawnPolygon(confirmedPolygon); setActiveDraftPolygon([]); setDrawingMode(false);
                        if (routeMode === 'canvas') {
                            setShowCompare(true);
                            toast.success('Canvas global area selected. Choose reps or a territory count, then divide the streets.');
                        } else {
                            toast.success("Freehand area selected! Choose property count and run Sandbox Preview.");
                        }
                    }}
                    drawnPolygon={activeDrawnPolygon}
                    drawShape={drawShape}
                    drawSizeMiles={drawSizeMiles}
                />

                {/* All map data layers extracted to ManagerMapLayers */}
                <ManagerMapLayers
                    mode={mode}
                    routeMode={routeMode}
                    canvasZonePreview={canvasZonePreview}
                    activeRoute={decisionFilteredActiveRoute}
                    zoomLevel={zoomLevel}
                    viewMode={viewMode}
                    hydratedSavedRoutes={decisionFilteredSavedRoutes}
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
                    ownershipRangeDays={currentBatchDataOwnershipRangeDays}
                    ownershipRangeReferenceDate={currentBatchDataOwnershipReferenceDate}
                    drawnPolygon={drawnPolygon}
                    assignedHashes={assignedHashes}
                    showAllProperties={showAllProperties}
                    showRouteDetails={decisionFilter !== 'all' ? true : showRouteDetails} decisionFilterActive={decisionFilter !== 'all'}
                    showRouteLines={decisionFilter === 'all' && showRouteLines}
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

                {/* ZIP + county boundary lines (toggled in Map Settings) */}
                <BoundaryOverlays properties={effectiveProperties} />

                {/* Previous drawn area history */}
                {routeMode === 'precision' && !drawingMode && !showRoutePanel && !filteredActiveRoute && (
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
                onRequestRouteModeChange={requestRouteModeChange}
                onConfirmCanvasDiscard={confirmCanvasDiscard}
                activeRoute={filteredActiveRoute}
                setActiveRoute={setActiveRoute}
                routesGenerating={routesGenerating}
                setShowDashboard={setShowDashboard}
                setShowMapSettings={setShowMapSettings}
                setShowCompare={setShowCompare}
                setShowRoutePanel={setShowRoutePanel}
                setShowChecklist={setShowChecklist}
                drawnPolygon={activeDrawnPolygon}
                drawingMode={drawingMode}
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
                onReoptimizeRoute={handleReoptimizeRoute} onDeleteRoute={(route) => deleteSavedRoute({ route, queryClient, activeRoute, setActiveRoute })}
                startLocation={startLocation} onSaveHomeBase={handleSaveHomeBase}
                hasMlsData={hasMlsData}
                logs={logs}
            />

            {/* Territory Prompt - Drawing Controls + Initial Prompt */}
            <TerritoryPrompt
                mode={mode}
                routeMode={routeMode}
                setMode={setMode}
                activeRoute={filteredActiveRoute}
                routesGenerating={routesGenerating}
                showCompare={showCompare}
                setShowCompare={setShowCompare}
                showRoutePanel={showRoutePanel}
                setShowRoutePanel={setShowRoutePanel}
                drawingMode={drawingMode}
                setDrawingMode={setDrawingMode}
                drawnPolygon={activeDrawnPolygon}
                setDrawnPolygon={setActiveDrawnPolygon}
                draftPolygon={activeDraftPolygon}
                setDraftPolygon={setActiveDraftPolygon}
                drawShape={drawShape}
                setDrawShape={setDrawShape}
                drawSizeMiles={drawSizeMiles}
                setDrawSizeMiles={setDrawSizeMiles}
                user={user}
                savedRoutes={savedRoutes}
                setZipCodeFilter={setZipCodeFilter}
                routeConfig={routeConfig}
                homeBase={user?.home_base || null}
                onSaveHomeBase={handleSaveHomeBase}
                onRouteBoundsPrepared={preparePrecisionRouteBounds}
                onPullComplete={async (pullFetchMonths, pulledWithMls, jobStatus = {}) => {
                    if (routeModeRef.current !== 'precision') return;
                    const completedRouteBounds = jobStatus?.diagnostics?.route_bounds || jobStatus?.route_bounds;
                    if (completedRouteBounds) preparePrecisionRouteBounds(completedRouteBounds);
                    setFrozenWorkingSet(null);
                    setFetchedProperties([]);
                    const completedJobId = getPrecisionJobId(jobStatus);
                    if (!completedJobId) {
                        setCurrentBatchDataJobId(null);
                        currentBatchDataJobIdRef.current = null;
                        setCurrentBatchDataOwnershipRangeDays(null);
                        currentBatchDataOwnershipRangeDaysRef.current = null;
                        setCurrentBatchDataOwnershipReferenceDate(null);
                        currentBatchDataOwnershipReferenceDateRef.current = null;
                        currentBatchDataRequestedCountRef.current = null;
                        currentBatchDataPolygonRef.current = null;
                        persistPrecisionJobContext(null);
                        preparePrecisionRouteBounds({ enabled: false });
                        setGenerationError('This Precision pull completed, but the completed job id was missing. Route generation was stopped so old account data cannot be mixed into this new area. Please generate the area again.');
                        return;
                    }
                    const statusPolygon = getFetchJobHistoryPolygon(jobStatus);
                    const drawnPullPolygon = normalizeHistoryPolygon(drawnPolygon);
                    const normalizedPullPolygon = statusPolygon.length > 2 ? statusPolygon : drawnPullPolygon;
                    if (normalizedPullPolygon.length < 3) {
                        setCurrentBatchDataJobId(null);
                        currentBatchDataJobIdRef.current = null;
                        setCurrentBatchDataOwnershipRangeDays(null);
                        currentBatchDataOwnershipRangeDaysRef.current = null;
                        setCurrentBatchDataOwnershipReferenceDate(null);
                        currentBatchDataOwnershipReferenceDateRef.current = null;
                        currentBatchDataRequestedCountRef.current = null;
                        currentBatchDataPolygonRef.current = null;
                        persistPrecisionJobContext(null);
                        preparePrecisionRouteBounds({ enabled: false });
                        setGenerationError('This Precision pull completed, but the selected area was missing before routes could be built. Route generation was stopped so old account data cannot be mixed into this new area. Please generate the area again.');
                        return;
                    }
                    setCurrentBatchDataJobId(completedJobId);
                    currentBatchDataJobIdRef.current = completedJobId;
                    const completedOwnershipRangeDays = normalizeStrictOwnershipRangeDays(jobStatus?.diagnostics?.ownership_range_days);
                    setCurrentBatchDataOwnershipRangeDays(completedOwnershipRangeDays);
                    currentBatchDataOwnershipRangeDaysRef.current = completedOwnershipRangeDays;
                    const rawOwnershipReferenceDate = jobStatus?.ownership_reference_date ?? jobStatus?.diagnostics?.ownership_reference_date;
                    const completedOwnershipReferenceDate = completedOwnershipRangeDays && Number.isFinite(new Date(rawOwnershipReferenceDate).getTime())
                        ? new Date(rawOwnershipReferenceDate).toISOString()
                        : null;
                    setCurrentBatchDataOwnershipReferenceDate(completedOwnershipReferenceDate);
                    currentBatchDataOwnershipReferenceDateRef.current = completedOwnershipReferenceDate;
                    const completedRequestedCount = getRequestedPrecisionCount(jobStatus);
                    currentBatchDataRequestedCountRef.current = completedRequestedCount;
                    currentBatchDataPolygonRef.current = normalizedPullPolygon;
                    try { localStorage.setItem('fk_drawnPolygonQueried', 'true'); } catch { }
                    setDrawnPolygon(normalizedPullPolygon, true);
                    setRoutes([]);
                    setShowCompare(false);
                    setShowRoutePanel(false);
                    await queryClient.refetchQueries({ queryKey: ['masterProperties'] });
                    await queryClient.refetchQueries({ queryKey: ['user'] });
                    if (routeModeRef.current !== 'precision') return;

                    const pm = pullFetchMonths || 12;
                    currentBatchDataSoldMonthsRef.current = pm;
                    persistPrecisionJobContext(completedOwnershipRangeDays ? {
                        userEmail: user?.email || '',
                        jobId: completedJobId,
                        soldMonths: pm,
                        ownershipRangeDays: completedOwnershipRangeDays,
                        ownershipReferenceDate: completedOwnershipReferenceDate,
                        requestedCount: completedRequestedCount,
                        polygon: normalizedPullPolygon
                    } : null);
                    setMaxDataMonths(pm);
                    try { localStorage.setItem('fk_maxDataMonths', String(pm)); } catch { }
                    setHasMlsData(!!pulledWithMls);
                    try { localStorage.setItem('fk_hasMlsData', pulledWithMls ? 'true' : 'false'); } catch { }

                    let pulledProperties = [];
                    if (normalizedPullPolygon.length > 2) {
                        pulledProperties = await fetchRouteCandidatesFromNeon({
                            polygon: normalizedPullPolygon,
                            soldMonths: pm,
                            ownershipRangeDays: completedOwnershipRangeDays,
                            limit: 50000,
                            fetchJobId: completedJobId
                        });
                        if (routeModeRef.current !== 'precision') return;
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
                        preparePrecisionRouteBounds({ enabled: false });
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
                        onDeleteRoute={(route) => deleteSavedRoute({ route, queryClient, activeRoute, setActiveRoute })}
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

            {/* Unified customer / address / county search */}
            <HomeUnifiedSearch
                mapRef={mapRef}
                properties={effectiveProperties}
                workingAreaCenteredRef={hasCenteredAccountWorkingAreaRef}
                onOpenProperty={(property) => {
                    setModeRaw('analyze');
                    /* Focus pin (shared with appointment links) keeps the searched door individually clickable after its card closes. */ setSelectedProperty(property); setAppointmentPin(property);
                }}
                onRefreshProperties={() => Promise.all([
                    queryClient.invalidateQueries({ queryKey: ['masterProperties'] }),
                    queryClient.invalidateQueries({ queryKey: ['localProperties'] }),
                ])}
            />

            {/* Filter Panel - ANALYZE MODE */}
            {showCompare && mode === 'analyze' && (
                <AnalyzeFiltersPanel
                    BRAND={BRAND}
                    repFilter={repFilter}
                    setRepFilter={setRepFilter}
                    uniqueReps={uniqueReps}
                    decisionFilter={decisionFilter}
                    setDecisionFilter={setDecisionFilter}
                    onClose={() => setShowCompare(false)}
                />
            )}

            {/* Route Builder Settings - GENERATE MODE */}
            {showCompare && mode === 'generate' && (
                <RouteBuilderSettings
                    onDraw={() => {
                        setShowCompare(false);
                        setActiveDrawnPolygon(null);
                        setActiveDraftPolygon([]);
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
                    ownershipRangeDays={currentBatchDataOwnershipRangeDays}
                    lastPullMode={lastPullMode}
                    routeConfig={routeConfig} setRouteConfig={setRouteConfig}
                    onGenerate={generateRoutes} routesGenerating={routesGenerating}
                    onReorder={handleReorder}
                    hasFrozenData={!!frozenWorkingSet && frozenWorkingSet.length > 0}
                    onClearPolygon={() => setActiveDrawnPolygon(null)}
                    onResumeBoundary={(savedBoundary) => {
                        const validation = validateCanvasBoundary(savedBoundary);
                        if (!validation.valid) throw new Error(validation.message);
                        setCanvasDrawnPolygon(validation.points);
                        setCanvasDraftPolygon([]);
                        setDrawingMode(false);
                        setShowCompare(true);
                    }}
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
                    teamMembers={teamMembers}
                    teamMembersReady={!teamMembersLoading}
                    canvasTeamMembers={canvasTeamMembers}
                    canvasTeamMembersReady={!canvasTeamMembersLoading}
                    onRefreshCanvasTeamMembers={refreshCanvasTeamMembers}
                    onCanvasDraftDirtyChange={setCanvasDraftDirty}
                    onCanvasPreviewChange={setCanvasZonePreview}
                    drawnPolygon={activeDrawnPolygon}
                    hasDrawnArea={activeDrawnPolygon && activeDrawnPolygon.length > 2}
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
                                logs={checklistLogs}
                                onLogResult={handleLogResult}
                                onNoteSaved={() => {
                                    queryClient.invalidateQueries({ queryKey: ['routeChecklistLogs'] });
                                    queryClient.invalidateQueries({ queryKey: ['selectedPropertyHistory'] });
                                }}
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
                        teamMembers={teamMembers} onSelectRoute={(routeId) => { const target = hydratedSavedRoutes.find(r => r.id === routeId); if (!target) return toast.error("Route data is still loading"); setActiveRoute(target); setPreviewRoute(null); setShowDashboard(false); }}
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
                        homeBase={user?.home_base || null} onSaveHomeBase={handleSaveHomeBase}
                    />
                </React.Suspense>
            )}


            <ManagerPropertyDetailSheet selectedProperty={selectedProperty ? withDerivedStatus([selectedProperty], buildLogsByAddress(selectedPropertyLogs))[0] : null} setSelectedProperty={(next) => { setSelectedProperty(next); if (!next) setAppointmentPin(null); }} STATUS_COLORS={STATUS_COLORS} navigationApp={navigationApp} selectedPropertyLogs={selectedPropertyLogs} handleLogResult={handleLogResult} onClearInteraction={handleDeleteInteraction} toast={toast} />
            <KnockLimitSheet
                open={showKnockLimitSheet}
                mode={knockGateMode}
                onClose={() => setShowKnockLimitSheet(false)}
            />
        </div>
    );
}