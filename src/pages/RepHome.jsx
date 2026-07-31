import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Navigation, CheckCircle2, Search, X, TrendingUp, MessageCircle, CalendarDays, Sparkles, ChevronDown } from 'lucide-react';
import localforage from 'localforage';
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getKnockWindowLabel } from '@/components/logic/knockTimeOptimizer';
import { determineEffectiveStatus } from '@/components/logic/territoryLogic';
import {
    hydrateRouteWithLookup,
    isRecoveryLimitedProperty,
    isRouteHydrationCacheable,
    orderRouteProperties,
} from '@/components/logic/routeHydrationCore';
import { optimizeRouteByStreetSweep } from '@/components/logic/routeOptimizer';
import {
  buildPersistedRoadRoutingMetadata,
  createRouteContinuityContext,
} from '@/components/logic/routeRoadContext';
import { buildFullAddress, getRouteNavigationPlan, openNavigationBatch } from '@/components/logic/navigation';
import { collectUnretiredOutcomes, confirmOutcomeRow } from '@/components/logic/optimisticOutcomes';
import { getNavigationSessionProgress, selectRemainingTodoStops } from '@/components/logic/routeNavigation';
import {
  ROUTE_BULK_ACTIONS,
  buildWorkflowTransitionLogs,
  getLatestInteractionLog,
  getPropertyAliases,
  getPropertySelectionKey,
  getVisiblePropertyKeys,
  getWorkflowBucketFromLogs,
  orderRoutePropertiesByHashes,
  pruneSelectionToProperties,
  removeSelectedRouteStops,
  resolveWorkflowEffectiveStatus,
  selectionsEqual,
  togglePropertySelection,
  toggleVisiblePropertySelection,
} from '@/components/logic/routeBulkActions';
import RepMapView from '@/components/rep/RepMapView';
import CanvasFieldView from '@/components/rep/CanvasFieldView';
import { getMyCanvasAssignments } from '@/components/canvas/canvasProductionClient';
import RepHeader from '@/components/rep/RepHeader';
import RepUnifiedSearch from '@/components/rep/RepUnifiedSearch';
import PropertyCard from '@/components/rep/PropertyCard';
import PropertyDetailSheet from '@/components/rep/PropertyDetailSheet';
import {
  buildRepRouteScope,
  buildSavedRouteQueryFilters,
  collectKnockRoutes,
  fetchAllSavedRoutePages,
  getKnockRouteCacheKey,
  routeIsVisibleInKnock,
  selectKnockRoute,
} from '@/components/rep/repRouteCollection';
import PullToRefresh from '@/components/mobile/PullToRefresh';
import RepAnalytics from '@/components/rep/RepAnalytics';
import TeamChat from '@/components/rep/TeamChat';
import KnockLimitSheet from '@/components/upgrade/KnockLimitSheet';
import KnockLimitBanner from '@/components/upgrade/KnockLimitBanner';
import { createOutcomeIdempotencyKey, getOutcomeGateFromError } from '@/components/upgrade/knockGate';
import { geocodeAddress } from '@/lib/geocoding';
import { calculateRouteDistanceMiles, isValidRoutePoint } from '@/lib/routeBounds';
import { getFieldRoutesCapability, getFieldRoutesStatuses } from '@/api/fieldRoutes';
import { useFieldRoutesInspectionQueue } from '@/components/fieldroutes/useFieldRoutesInspectionQueue';
import {
  fieldRoutesStatusPresentation,
  fieldRoutesStatusRows,
  findFieldRoutesStatus,
  isFieldRoutesCapabilityReady,
  isFieldRoutesTerminalStatus,
  preferFieldRoutesStatus,
} from '@/components/fieldroutes/fieldRoutesPresentation';

const CANVAS_ASSIGNMENT_POLL_MS = 15_000;
const FIELDROUTES_STATUS_POLL_MS = 15_000;
// A device fix is warmed while the rep reads the house card, so an outcome tap
// almost always reuses it instead of waiting on the GPS radio.
const GPS_FIX_MAX_AGE_MS = 90_000;
// The fix resolves behind an already-closed sheet, so accuracy no longer costs
// the rep anything and this can stay generous.
const GPS_FIX_WAIT_MS = 4_000;

function precisionFieldRoutesStatus(response, sourceKey, addressHash) {
  return findFieldRoutesStatus(response, (row) => (
    String(row?.source_key || '') === sourceKey
    || String(row?.source_reference || '') === sourceKey
    || String(row?.address_hash || row?.property_key || '') === String(addressHash || '')
  ));
}

function shouldPollPrecisionFieldRoutes(response, localStatuses, routeId) {
  const routePrefix = routeId ? `precision:${routeId}:` : '';
  const serverRows = fieldRoutesStatusRows(response).filter((row) => (
    !routeId || String(row?.route_id || '') === String(routeId)
      || String(row?.source_key || row?.source_reference || '').startsWith(routePrefix)
  ));
  if (serverRows.some((row) => !isFieldRoutesTerminalStatus(row))) return true;
  return Object.entries(localStatuses || {}).some(([sourceKey, localStatus]) => {
    if (!routePrefix || !sourceKey.startsWith(routePrefix)) return false;
    const serverStatus = precisionFieldRoutesStatus(response, sourceKey, sourceKey.slice(routePrefix.length));
    return !isFieldRoutesTerminalStatus(preferFieldRoutesStatus(localStatus, serverStatus));
  });
}

function requireUsableRouteContext(routingContext) {
  if (
    routingContext
    && ['full', 'cost-only', 'fallback'].includes(routingContext.mode)
    && typeof routingContext.accessGroupKey === 'function'
  ) return;
  throw new Error('The route optimizer could not initialize safely. The existing route was left unchanged.');
}

export default function RepHome() {
  const queryClient = useQueryClient();
  const [selectedProperty, setSelectedProperty] = useState(null);
  const [selectedPropertyIndex, setSelectedPropertyIndex] = useState(null);
  const [filterStatus, setFilterStatus] = useState('todo');
  const [searchQuery, setSearchQuery] = useState('');
  const [uploading, setUploading] = useState(false);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [showMap, setShowMap] = useState(false);
  const [focusProperty, setFocusProperty] = useState(null);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [showLimitSheet, setShowLimitSheet] = useState(false);
  const [limitDismissed, setLimitDismissed] = useState(false);
  const [gateMode, setGateMode] = useState('limit');
  const outcomeQueueRef = React.useRef(Promise.resolve());
  const pendingOutcomesRef = React.useRef(new Map());
  const gpsFixRef = React.useRef(null);
  const bulkWorkflowRetryRef = React.useRef(null);
  const appointmentRunFocusHandledRef = React.useRef(false);
  const [soldDateFilter, setSoldDateFilter] = useState('all');
  const [decisionFilter, setDecisionFilter] = useState('all');
  const [selectedPropertyKeys, setSelectedPropertyKeys] = useState(() => new Set());
  const [navigationSession, setNavigationSession] = useState(null);
  const [navigationError, setNavigationError] = useState('');
  const [homeBaseAddress, setHomeBaseAddress] = useState('');
  const [homeBaseSaving, setHomeBaseSaving] = useState(false);
  const [homeBaseError, setHomeBaseError] = useState('');
  const [homeRouteOptimizing, setHomeRouteOptimizing] = useState(false);
  const [homeRouteError, setHomeRouteError] = useState('');
  const [homeBasePanelOpen, setHomeBasePanelOpen] = useState(false);
  const [canvasFieldDismissed, setCanvasFieldDismissed] = useState(false);
  const [canvasFieldOpen, setCanvasFieldOpen] = useState(false);
  const [canvasAssignmentNotice, setCanvasAssignmentNotice] = useState('');
  const previousCanvasAssignmentIdentityRef = React.useRef('');
  const hydratedHomeBaseUserRef = React.useRef(null);
  const routeSwitcherRef = React.useRef(null);
  const routeSwitcherCloseButtonRef = React.useRef(null);
  const routeSwitcherReturnFocusRef = React.useRef(null);

  // Offline Listener
  React.useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const { data: user } = useQuery({ queryKey: ['user'], queryFn: () => base44.auth.me().catch(() => null) });

  React.useEffect(() => {
    if (!user?.id || hydratedHomeBaseUserRef.current === user.id) return;
    hydratedHomeBaseUserRef.current = user.id;
    setHomeBaseAddress(user.home_base?.address || '');
  }, [user?.home_base?.address, user?.id]);

  const [localNavigationApp, setLocalNavigationApp] = useState(() => {
    try {return localStorage.getItem('fk_navigation_app') || 'apple';} catch {return 'apple';}
  });
  const navigationApp = user?.navigation_app || localNavigationApp || 'apple';

  React.useEffect(() => {
    if (user?.navigation_app) setLocalNavigationApp(user.navigation_app);
  }, [user?.navigation_app]);

  React.useEffect(() => {
    const handler = (event) => {
      const nextApp = event.detail?.navigationApp;
      if (nextApp === 'apple' || nextApp === 'google') setLocalNavigationApp(nextApp);
    };
    window.addEventListener('fk-navigation-app-changed', handler);
    return () => window.removeEventListener('fk-navigation-app-changed', handler);
  }, []);

  // 0. Fetch Team Member Profile (to link Auth User -> Team Member ID)
  const teamTenantIdentity = user?.team_manager_id || user?.data?.team_manager_id || user?.id || '';
  const userEmail = user?.email || user?.data?.email || '';
  const {
    data: teamMemberMatches = [],
    isLoading: teamMembersLoading,
    isError: teamMemberLookupFailed,
  } = useQuery({
    queryKey: ['myTeamMember', user?.id, userEmail, teamTenantIdentity],
    queryFn: async () => {
      if (!userEmail) return [];
      try {
        const emailLower = userEmail.trim().toLowerCase();
        const res = await base44.entities.TeamMember.filter({ email: emailLower }, '-created_date', 50);
        const allMatches = Array.isArray(res) ? res : res?.items || [];
        console.log(`[RepHome] TeamMember lookup returned ${allMatches.length} email match${allMatches.length === 1 ? '' : 'es'} before tenant scoping`);
        return allMatches;
      } catch (e) {
        console.error("Error fetching team member profile", e);
        throw e;
      }
    },
    enabled: !!userEmail,
    retry: 2,
  });

  const routeScope = useMemo(
    () => buildRepRouteScope(user, teamMemberMatches),
    [teamMemberMatches, user],
  );
  const teamMember = routeScope.primaryTeamMember;
  const allTeamMemberIds = routeScope.teamMemberIds;
  const repManagerId = routeScope.managerId;
  const routeCacheKey = getKnockRouteCacheKey(routeScope);
  const [fieldRoutesLocalStatuses, setFieldRoutesLocalStatuses] = useState({});

  const { data: fieldRoutesCapability = null } = useQuery({
    queryKey: ['fieldRoutesCapability', user?.id, repManagerId],
    queryFn: () => getFieldRoutesCapability(),
    enabled: !!user?.id && !!repManagerId,
    retry: false,
    staleTime: 60_000,
  });

  const handleFieldRoutesServerAcknowledged = React.useCallback((result, intent) => {
    const sourceKey = String(intent?.source?.source_key || intent?.source?.address_hash || '');
    if (sourceKey) setFieldRoutesLocalStatuses((current) => ({ ...current, [sourceKey]: result }));
    queryClient.invalidateQueries({ queryKey: ['fieldRoutesStatuses'] });
  }, [queryClient]);

  const {
    discardAttentionBySource: discardFieldRoutesDeviceAttention,
    pendingBySource: fieldRoutesPendingBySource,
    pendingCount: fieldRoutesPendingDeviceCount,
    submitInspection: submitFieldRoutesInspection,
  } = useFieldRoutesInspectionQueue({
    actorUserId: user?.id,
    managerId: repManagerId,
    onServerAcknowledged: handleFieldRoutesServerAcknowledged,
  });

  // 1. Fetch the complete route collection visible to this account/viewer.
  // Managers see every tenant route (including past and empty shell routes);
  // reps remain limited to routes assigned to their tenant-scoped identities.
  const myRoutesQueryKey = [
    'myRoutes',
    routeScope.userId,
    routeScope.managerId,
    routeScope.managerAccount ? 'manager' : 'rep',
    routeScope.assigneeIds.join(','),
    teamMemberLookupFailed ? 'identity-error' : 'identity-ok',
  ];
  const { data: routes = [], isLoading: routesLoading } = useQuery({
    queryKey: myRoutesQueryKey,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      if (!user) return [];
      if (teamMemberLookupFailed && !routeScope.managerAccount) {
        // A failed identity lookup is not proof that this viewer has no routes.
        // Use only the already-scoped cache and do not replace it with an empty
        // network result built from incomplete TeamMember identities.
        try {
          const cached = await localforage.getItem(routeCacheKey);
          return Array.isArray(cached) ? cached : [];
        } catch (cacheError) {
          console.warn('[RepHome] Could not read the offline route cache after identity lookup failed', cacheError);
          return [];
        }
      }
      try {
        // Server-side scoped queries: assigned-to-me + (managers) owned-by-me.
        // Name-based fallback removed — backfillRouteAssignments resolves legacy name-only assignments to IDs.
        const fetchRouteGroup = (filter) => fetchAllSavedRoutePages((limit, skip) => (
          base44.entities.SavedRoute.filter(filter, '-created_date', limit, skip)
        ));
        // Legacy routes may predate manager_id. The shared query plan includes
        // exact creator fallback for managers, then collectKnockRoutes applies
        // the final tenant boundary before anything reaches the UI or cache.
        const routeQueries = buildSavedRouteQueryFilters(routeScope).map(fetchRouteGroup);

        const routeGroups = await Promise.all(routeQueries);
        const accountRoutes = collectKnockRoutes(routeGroups, routeScope);

        const selectedRouteId = (() => {
          try {return localStorage.getItem('fk_selectedKnockRouteId');} catch {return null;}
        })();

        console.log(`[RepHome] Found ${accountRoutes.length} scoped routes for assignees [${routeScope.assigneeIds.join(', ')}], selected=${selectedRouteId || 'none'}`);

        try {
          // Write empty results too so a valid empty account does not revive a
          // stale route list the next time this viewer is offline.
          await localforage.setItem(routeCacheKey, accountRoutes);
        } catch (cacheError) {
          console.warn('[RepHome] Could not refresh the offline route cache', cacheError);
        }
        return accountRoutes;
      } catch (e) {
        console.error("Error fetching routes", e);
        const cached = await localforage.getItem(routeCacheKey);
        return collectKnockRoutes([cached || []], routeScope);
      }
    },
    enabled: !!user && !teamMembersLoading
  });

  // --- Derived State ---

  // Get the Active Route (Highest priority or most recent active)
  const [manualRouteId, setManualRouteId] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('route') || (() => {try {return localStorage.getItem('fk_selectedKnockRouteId');} catch {return null;}})();
  });
  const [showRouteList, setShowRouteList] = useState(false);
  const openRouteSwitcher = React.useCallback((event) => {
    routeSwitcherReturnFocusRef.current = event?.currentTarget || document.activeElement;
    setShowRouteList(true);
  }, []);
  const closeRouteSwitcher = React.useCallback(() => setShowRouteList(false), []);
  const handleRouteSwitcherKeyDown = React.useCallback((event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeRouteSwitcher();
      return;
    }
    if (event.key !== 'Tab') return;

    const dialog = routeSwitcherRef.current;
    if (!dialog) return;
    const focusableElements = [...dialog.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    )].filter((element) => element.getAttribute('aria-hidden') !== 'true');
    if (!focusableElements.length) {
      event.preventDefault();
      return;
    }

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];
    const focusOutsideDialog = !dialog.contains(document.activeElement);
    if (event.shiftKey && (document.activeElement === firstElement || focusOutsideDialog)) {
      event.preventDefault();
      lastElement.focus();
    } else if (!event.shiftKey && (document.activeElement === lastElement || focusOutsideDialog)) {
      event.preventDefault();
      firstElement.focus();
    }
  }, [closeRouteSwitcher]);

  React.useEffect(() => {
    if (!showRouteList) return undefined;
    const returnFocusTarget = routeSwitcherReturnFocusRef.current;
    const focusFrame = window.requestAnimationFrame(() => routeSwitcherCloseButtonRef.current?.focus());

    return () => {
      window.cancelAnimationFrame(focusFrame);
      if (returnFocusTarget && document.contains(returnFocusTarget)) returnFocusTarget.focus();
      routeSwitcherReturnFocusRef.current = null;
    };
  }, [showRouteList]);

  const activeRoute = useMemo(() => {
    return selectKnockRoute(routes, manualRouteId);
  }, [routes, manualRouteId]);
  const activeRouteStatus = String(activeRoute?.status || 'PENDING').toUpperCase();
  const activeRouteArchived = activeRouteStatus === 'ARCHIVED';
  const activeRouteCompleted = activeRouteStatus === 'COMPLETED';
  const activeRouteCanComplete = !activeRouteArchived && !activeRouteCompleted;
  const routeIdentityUnavailable = teamMemberLookupFailed && !routeScope.managerAccount;
  const activeRouteBelongsToCurrentUser = Boolean(
    activeRoute?.assigned_to && (
      activeRoute.assigned_to === user?.id || allTeamMemberIds.includes(activeRoute.assigned_to)
    )
  );

  const {
    data: canvasAssignmentPackage,
    isLoading: canvasAssignmentsLoading,
    isError: canvasAssignmentsUnavailable,
    refetch: refetchCanvasAssignments,
  } = useQuery({
    queryKey: ['myCanvasAssignments', user?.id],
    queryFn: () => getMyCanvasAssignments(),
    enabled: !!user,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: canvasFieldOpen || (!activeRoute && !canvasFieldDismissed) ? CANVAS_ASSIGNMENT_POLL_MS : false,
  });
  const canvasAssignments = canvasAssignmentPackage?.assignments || [];
  const canvasAssignmentIdentity = useMemo(() => canvasAssignments
    .map((assignment) => `${assignment.session_id}:${assignment.version}:${assignment.zone?.zone_id || assignment.zone?.zone_number || ''}`)
    .sort()
    .join('|'), [canvasAssignments]);

  React.useEffect(() => {
    const previousIdentity = previousCanvasAssignmentIdentityRef.current;
    const canvasWasVisible = canvasFieldOpen || (!activeRoute?.id && !canvasFieldDismissed);
    if (previousIdentity && previousIdentity !== canvasAssignmentIdentity && canvasWasVisible) {
      if (canvasAssignmentIdentity) {
        toast.info('Your manager updated your Canvas assignment. The map now shows the current deployed area.');
        setCanvasAssignmentNotice('');
      } else {
        const notice = 'Your Canvas assignment was completed, recalled, or replaced. The old area has been removed from your map.';
        toast.info(notice);
        setCanvasAssignmentNotice(notice);
        setCanvasFieldOpen(false);
      }
    } else if (canvasAssignmentIdentity) {
      setCanvasAssignmentNotice('');
    }
    previousCanvasAssignmentIdentityRef.current = canvasAssignmentIdentity;
  }, [activeRoute?.id, canvasAssignmentIdentity, canvasFieldDismissed, canvasFieldOpen]);

  React.useEffect(() => {
    if (!activeRoute?.id) return;
    const readyForWork = ['IN_PROGRESS', 'ACTIVE', 'PENDING'].includes(activeRouteStatus);
    const explicitlySelected = manualRouteId === activeRoute.id;
    try {
      if (readyForWork || explicitlySelected) localStorage.setItem('fk_selectedKnockRouteId', activeRoute.id);
      else localStorage.removeItem('fk_selectedKnockRouteId');
    } catch {}
  }, [activeRoute?.id, activeRouteStatus, manualRouteId]);

  const teamMemberIdsKey = allTeamMemberIds.join(',');
  React.useEffect(() => {
    if (!user) return;
    const unsubscribe = base44.entities.SavedRoute.subscribe((event) => {
      if (!event?.id) return;
      const isSelectedRoute = event.id === activeRoute?.id || event.id === manualRouteId;
      // Tenant guard: only react to create events that belong to this user/team.
      // Unscoped 'create' invalidation caused thundering-herd refetches at scale.
      const d = event.data;
      const isMine = !!d && routeIsVisibleInKnock({ ...d, id: event.id }, routeScope);
      if (isSelectedRoute) {
        queryClient.invalidateQueries({ queryKey: ['myRoutes'] });
        queryClient.invalidateQueries({ queryKey: ['routeProperties'] });
      } else if (event.type === 'create' && isMine) {
        queryClient.invalidateQueries({ queryKey: ['myRoutes'] });
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, activeRoute?.id, manualRouteId, queryClient, teamMemberIdsKey]);

  const activeRouteOrderKey = React.useMemo(
    () => (activeRoute?.property_hashes || []).join('|'),
    [activeRoute?.property_hashes]
  );

  // 2. Fetch Route Properties - batch filter by address_hash
  const { data: properties = [], isLoading: propsLoading } = useQuery({
    queryKey: ['routeProperties', activeRoute?.id, activeRoute?.updated_date, activeRouteOrderKey],
    refetchOnWindowFocus: true,
    queryFn: async () => {
      if (!activeRoute?.property_hashes?.length) return [];
      const hashes = activeRoute.property_hashes;

      try {
        console.log(`[RepHome] Fetching ${hashes.length} route properties from route lookup`);

        const hydratedRoute = await hydrateRouteWithLookup(activeRoute, async ({ hashes: requestedHashes, routeId }) => {
          const response = await base44.functions.invoke('getRoutePropertiesByHashes', {
            address_hashes: requestedHashes,
            ...(routeId ? { route_id: routeId } : {}),
            user_email: activeRoute.created_by,
            limit: requestedHashes.length
          });
          return Array.isArray(response.data?.properties) ? response.data.properties : [];
        });
        let bestRoute = hydratedRoute;
        let loaded = Array.isArray(hydratedRoute?.properties) ? hydratedRoute.properties : [];

        // A previously complete offline snapshot is safer than replacing the
        // route with a transient partial response. It only fills hashes that
        // are already present on this exact active route.
        if (!isRouteHydrationCacheable(hydratedRoute)) {
          const cached = await localforage.getItem(`cached_props_${activeRoute.id}`);
          if (Array.isArray(cached) && cached.length > 0) {
            if (cached.some(isRecoveryLimitedProperty)) {
              await localforage.removeItem(`cached_props_${activeRoute.id}`);
            } else {
              bestRoute = orderRouteProperties(hydratedRoute, cached);
              loaded = Array.isArray(bestRoute?.properties) ? bestRoute.properties : loaded;
            }
          }
        }
        console.log(`[RepHome] Found ${loaded.length}/${hashes.length} properties`);

        if (isRouteHydrationCacheable(bestRoute)) {
          await localforage.setItem(`cached_props_${activeRoute.id}`, loaded);
        }
        return loaded;
      } catch (e) {
        console.error("Error fetching properties", e);
        const cached = await localforage.getItem(`cached_props_${activeRoute.id}`);
        if (!Array.isArray(cached) || cached.length === 0) return [];
        if (cached.some(isRecoveryLimitedProperty)) {
          await localforage.removeItem(`cached_props_${activeRoute.id}`);
          return [];
        }
        const cachedRoute = orderRouteProperties(activeRoute, cached);
        return isRouteHydrationCacheable(cachedRoute)
          ? cachedRoute.properties
          : [];
      }
    },
    enabled: !!activeRoute
  });

  // Outcomes whose write has not settled yet survive any refetch that lands in
  // the meantime, so a door never flickers back to Todo under the rep.
  const withPendingOutcomes = React.useCallback((rows, addressHash = null) => {
    const unretired = collectUnretiredOutcomes(pendingOutcomesRef.current, rows, addressHash);
    return unretired.length ? [...rows, ...unretired] : rows;
  }, []);

  // 3. Fetch Interaction Logs (History for this route)
  const { data: logs = [], isLoading: logsLoading } = useQuery({
    queryKey: ['routeLogs', activeRoute?.id],
    queryFn: async () => {
      if (activeRoute?.property_hashes?.length > 0) {
        const [hashLogsRes, routeLogsRes] = await Promise.all([
          base44.entities.InteractionLog.filter({ address_hash: activeRoute.property_hashes }, '-created_date', 1000),
          activeRoute.id ? base44.entities.InteractionLog.filter({ route_id: activeRoute.id }, '-created_date', 1000) : []
        ]);
        const merged = [...(Array.isArray(hashLogsRes) ? hashLogsRes : hashLogsRes?.items || []), ...(Array.isArray(routeLogsRes) ? routeLogsRes : routeLogsRes?.items || [])];
        const seen = new Set();
        return withPendingOutcomes(merged.filter((log) => {
          const key = log.id || `${log.address_hash}-${log.created_date}-${log.parsed_status}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }));
      }
      if (user?.email) {
        const res = await base44.entities.InteractionLog.filter({ created_by: user.email }, '-created_date', 500);
        return withPendingOutcomes(Array.isArray(res) ? res : res?.items || []);
      }
      return withPendingOutcomes([]);
    },
    enabled: !!activeRoute || !!user
  });

  // Fetch ALL logs by this rep for analytics
  const { data: allMyLogs = [] } = useQuery({
    queryKey: ['allMyLogs', user?.email],
    queryFn: async () => {
      if (!user?.email) return [];
      const res = await base44.entities.InteractionLog.filter({ created_by: user.email }, '-created_date', 2000);
      return Array.isArray(res) ? res : res?.items || [];
    },
    enabled: !!user?.email
  });

  // The server mutation is authoritative; cached browser billing flags never
  // prevent live Stripe verification from running. Archived routes remain
  // read-only regardless of billing state.
  const outcomeLoggingDisabled = activeRouteArchived;
  const showLimitBanner = limitDismissed;

  // REAL-TIME UPDATES: Prevent double-knocking (Team Mode)
  React.useEffect(() => {
    if (!user) return;
    const unsubscribe = base44.entities.InteractionLog.subscribe((event) => {
      if (event.type === 'create' && event.data && event.data.created_by !== user.email) {
        // If another rep knocks a door on our route, update immediately
        if (activeRoute && activeRoute.property_hashes?.includes(event.data.address_hash)) {
          queryClient.invalidateQueries({ queryKey: ['routeLogs'] });
          queryClient.invalidateQueries({ queryKey: ['routeProperties'] });
        }
      }
    });
    return unsubscribe;
  }, [user, activeRoute, queryClient]);

  // Fetch ALL logs for a selected property (for full history view - any rep, any time)
  const { data: selectedPropertyLogs = [] } = useQuery({
    queryKey: ['propertyHistory', selectedProperty?.address_hash],
    queryFn: async () => {
      if (!selectedProperty?.address_hash) return [];
      const res = await base44.entities.InteractionLog.filter(
        { address_hash: selectedProperty.address_hash },
        '-created_date', 100
      );
      return withPendingOutcomes(
        Array.isArray(res) ? res : res?.items || [],
        selectedProperty.address_hash
      );
    },
    enabled: !!selectedProperty?.address_hash
  });

  // Optimistic outcome rows are keyed by their own id so a rollback removes one
  // failed write without discarding outcomes the rep logged after it.
  const applyOptimisticLog = React.useCallback((entry) => {
    // Held until the write settles so a refetch triggered by an earlier outcome
    // cannot wipe rows whose own write is still queued behind it.
    pendingOutcomesRef.current.set(entry.id, entry);
    const insert = (old) => [...(Array.isArray(old) ? old : []), entry];
    queryClient.setQueryData(['routeLogs', activeRoute?.id], insert);
    queryClient.setQueryData(['propertyHistory', entry.address_hash], insert);
  }, [queryClient, activeRoute?.id]);

  const replaceOptimisticLog = React.useCallback((optimisticId, confirmedRow) => {
    if (!optimisticId || !confirmedRow) return;
    const swap = (old) => [
      ...(Array.isArray(old) ? old : []).filter((log) => log?.id !== optimisticId && log?.id !== confirmedRow.id),
      confirmedRow
    ];
    queryClient.setQueryData(['routeLogs', activeRoute?.id], swap);
    queryClient.setQueryData(['propertyHistory', confirmedRow.address_hash], swap);
  }, [queryClient, activeRoute?.id]);

  const dropOptimisticLog = React.useCallback((optimisticId, addressHash) => {
    if (!optimisticId) return;
    pendingOutcomesRef.current.delete(optimisticId);
    const remove = (old) => (Array.isArray(old) ? old.filter((log) => log?.id !== optimisticId) : old);
    queryClient.setQueryData(['routeLogs', activeRoute?.id], remove);
    queryClient.setQueryData(['propertyHistory', addressHash], remove);
  }, [queryClient, activeRoute?.id]);


  // Log Result Mutation
  const createLogMutation = useMutation({
    mutationFn: async (logData) => {
      const { property_snapshot, callback_contact_name, callback_contact_phone, callback_time, optimistic_id, ...persistedLog } = logData;
      const response = await base44.functions.invoke('recordKnockOutcome', {
        action: 'record',
        idempotency_key: createOutcomeIdempotencyKey('rep-knock'),
        interaction: {
          ...persistedLog,
          route_id: persistedLog.route_id || activeRoute?.id || null
        }
      });
      return response.data;
    },
    // The optimistic row is written at tap time by handleLog, not here: a queued
    // write can start seconds after the rep already moved on, and the door has
    // to read as done immediately.
    onError: (err, newLog) => {
      // A reverted door means the write failed; leave the reason in the console
      // so it can be read back without reproducing the tap.
      console.error('[RepHome] Outcome write failed; rolling the door back', err);
      dropOptimisticLog(newLog?.optimistic_id, newLog?.address_hash);
      const gate = getOutcomeGateFromError(err);
      if (gate) {
        setGateMode(gate);
        setShowLimitSheet(true);
        if (gate === 'limit') setLimitDismissed(true);
        return;
      }
      toast.error(
        err?.response?.data?.error
        || err?.message
        || 'Outcome could not be saved. Please try again.'
      );
    },
    onSettled: () => {
      // The optimistic row is deliberately left in place here; withPendingOutcomes
      // retires it when the refetch below actually returns the server row.
      queryClient.invalidateQueries({ queryKey: ['myLogs'] });
      queryClient.invalidateQueries({ queryKey: ['routeLogs'] });
      queryClient.invalidateQueries({ queryKey: ['allMyLogs'] });
      queryClient.invalidateQueries({ queryKey: ['propertyHistory'] });
    },
    onSuccess: async (result, logData) => {
      // Swap the authoritative row in for the optimistic sketch, so the door
      // reflects the real record and holds regardless of whether the log query
      // returns it yet.
      const confirmed = confirmOutcomeRow(
        pendingOutcomesRef.current,
        logData?.optimistic_id,
        result?.interaction
      );
      if (confirmed) replaceOptimisticLog(logData?.optimistic_id, confirmed);

      if (logData?.parsed_status === 'CALLBACK' && logData?.next_eligible_date) {
        try {
          const p = logData.property_snapshot || {};
          const fullAddress = p.full_address || p.address || `${p.house_number || ''} ${p.street_name || ''}`.trim();
          if (fullAddress) {
            await base44.entities.Appointment.create({
              address_hash: logData.address_hash,
              manager_id: repManagerId,
              full_address: fullAddress,
              homeowner_name: logData.callback_contact_name || null,
              phone: logData.callback_contact_phone || null,
              scheduled_date: logData.next_eligible_date,
              industry: 'other',
              status: 'scheduled',
              outcome: 'follow_up',
              route_id: result?.interaction?.route_id || logData.route_id || activeRoute?.id || null,
              assigned_rep: teamMember?.id || user?.id || null,
              assigned_rep_name: teamMember?.name || user?.full_name || null,
              zip_code: p.zip_code || p.zip || null,
              lat: p.lat || null,
              lng: p.lng || null,
              notes: logData.raw_input_text || 'Callback scheduled from Knock Mode'
            });
            queryClient.invalidateQueries({ queryKey: ['appointments'] });
          }
        } catch (error) {
          console.error('Interaction saved, but callback appointment creation failed', error);
          toast.warning('Outcome saved, but the callback could not be added to Appointments.');
        }
      }

      if (Number.isFinite(result?.outcomes_logged)) {
        queryClient.setQueryData(['user'], (current) => ({
          ...(current || user || {}),
          outcomes_logged: result.outcomes_logged
        }));
      }
    }
  });

  const clearDecisionMutation = useMutation({
    mutationFn: async (log) => {
      if (activeRouteArchived) throw new Error('Archived routes are read-only.');
      const response = await base44.functions.invoke('recordKnockOutcome', {
        action: 'clear_decision',
        idempotency_key: createOutcomeIdempotencyKey('clear-decision'),
        interaction: {
          address_hash: log.address_hash,
          raw_input_text: 'Decision cleared — moved back to Todo',
          parsed_status: 'ELIGIBLE',
          counts_as_knock: false,
          workflow_action: 'CLEAR_TO_TODO',
          workflow_bucket: 'TODO',
          route_id: log.route_id || activeRoute?.id || null,
          gps_proof_lat: selectedProperty?.lat,
          gps_proof_lng: selectedProperty?.lng,
          gps_accuracy: 0
        }
      });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['routeLogs'] });
      queryClient.invalidateQueries({ queryKey: ['allMyLogs'] });
      queryClient.invalidateQueries({ queryKey: ['propertyHistory'] });
      toast.success('Moved back to Todo');
    }
  });

  // Complete Route Mutation
  const completeRouteMutation = useMutation({
    mutationFn: (routeId) => base44.entities.SavedRoute.update(routeId, {
      status: 'COMPLETED'
    }),
    onMutate: async (routeId) => {
      await queryClient.cancelQueries({ queryKey: myRoutesQueryKey });
      const cachedRoutes = queryClient.getQueryData(myRoutesQueryKey);
      const previousRoutes = Array.isArray(cachedRoutes) ? cachedRoutes : routes;
      const previousManualRouteId = manualRouteId;
      const previousUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      let previousStoredRouteId = null;
      try { previousStoredRouteId = localStorage.getItem('fk_selectedKnockRouteId'); } catch {}

      queryClient.setQueryData(myRoutesQueryKey, previousRoutes.map((route) => (
        route.id === routeId ? { ...route, status: 'COMPLETED' } : route
      )));
      setManualRouteId(null);
      try { localStorage.removeItem('fk_selectedKnockRouteId'); } catch {}
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.delete('route');
      window.history.replaceState({}, '', `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);

      return { previousRoutes, previousManualRouteId, previousStoredRouteId, previousUrl };
    },
    onError: (error, _routeId, context) => {
      if (context?.previousRoutes) queryClient.setQueryData(myRoutesQueryKey, context.previousRoutes);
      setManualRouteId(context?.previousManualRouteId || null);
      try {
        if (context?.previousStoredRouteId) {
          localStorage.setItem('fk_selectedKnockRouteId', context.previousStoredRouteId);
        } else {
          localStorage.removeItem('fk_selectedKnockRouteId');
        }
      } catch {}
      if (context?.previousUrl) window.history.replaceState({}, '', context.previousUrl);
      toast.error(error?.message || 'The route could not be completed. Please try again.');
    },
    onSuccess: async () => {
      try {
        const completedRoutes = queryClient.getQueryData(myRoutesQueryKey);
        if (Array.isArray(completedRoutes)) {
          await localforage.setItem(routeCacheKey, completedRoutes);
        }
      } catch (cacheError) {
        console.warn('[RepHome] Could not update the offline route cache after completion', cacheError);
      }
      toast.success('Route completed.');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['myRoutes'] });
    }
  });

  // Hydrate Route with Property Data & Status
  const routeProperties = useMemo(() => {
    if (!activeRoute || routesLoading || !properties.length) return [];

    const byHash = new Map();
    properties.forEach((p) => {
      if (p.address_hash) byHash.set(p.address_hash, p);
      if (p.legacy_hash) byHash.set(p.legacy_hash, p);
    });

    const rerunCreatedAt = activeRoute?.metadata?.rerun_created_at ? new Date(activeRoute.metadata.rerun_created_at).getTime() : null;

    const orderedProps = (activeRoute.property_hashes || []).
    map((hash) => byHash.get(hash)).
    filter(Boolean).
    map((p) => {
      const pLogs = logs.filter((l) => {
        const matchesProperty = l.address_hash === p.address_hash || p.legacy_hash && l.address_hash === p.legacy_hash;
        if (!matchesProperty) return false;
        if (!rerunCreatedAt) return true;
        if (l.route_id === activeRoute.id) return true;
        const logTime = new Date(l.created_date || 0).getTime();
        return !Number.isNaN(logTime) && logTime >= rerunCreatedAt;
      });
      const derivedStatus = determineEffectiveStatus(p, pLogs);
      const latestLog = getLatestInteractionLog(pLogs);
      const status = resolveWorkflowEffectiveStatus(derivedStatus, pLogs);
      return {
        ...p,
        effective_status: status,
        workflow_bucket: getWorkflowBucketFromLogs(pLogs),
        workflow_action: latestLog?.workflow_action || null,
      };
    });

    // SavedRoute.property_hashes is the source of truth. Checklist/Optimize writes this order,
    // so Knock must preserve it exactly instead of applying another local reorder.
    return orderedProps;
  }, [activeRoute, properties, logs]);

  const expectedRoutePropertyCount = activeRoute?.property_hashes?.length || 0;
  const routeHydrationComplete = expectedRoutePropertyCount === 0 || (
    routeProperties.length === expectedRoutePropertyCount
    && routeProperties.every(isValidRoutePoint)
    && !routeProperties.some(isRecoveryLimitedProperty)
  );

  const fieldRoutesPropertyKeys = useMemo(
    () => routeProperties.map((property) => property.address_hash).filter(Boolean),
    [routeProperties],
  );
  const fieldRoutesPropertyKeysSignature = fieldRoutesPropertyKeys.join('|');
  const { data: fieldRoutesStatuses = null } = useQuery({
    queryKey: ['fieldRoutesStatuses', 'precision', repManagerId, activeRoute?.id, fieldRoutesPropertyKeysSignature],
    queryFn: () => getFieldRoutesStatuses({
      source_mode: 'precision',
      route_id: activeRoute?.id,
      property_keys: fieldRoutesPropertyKeys,
    }),
    enabled: isFieldRoutesCapabilityReady(fieldRoutesCapability) && !!activeRoute?.id && fieldRoutesPropertyKeys.length > 0,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => shouldPollPrecisionFieldRoutes(
      query.state.data,
      fieldRoutesLocalStatuses,
      activeRoute?.id,
    ) ? FIELDROUTES_STATUS_POLL_MS : false,
  });
  const selectedFieldRoutesSourceKey = selectedProperty?.address_hash && activeRoute?.id
    ? `precision:${activeRoute.id}:${selectedProperty.address_hash}`
    : '';
  const selectedFieldRoutesStatus = useMemo(() => {
    if (!selectedProperty?.address_hash) return null;
    const localStatus = fieldRoutesLocalStatuses[selectedFieldRoutesSourceKey]
      || fieldRoutesPendingBySource[selectedFieldRoutesSourceKey];
    const serverStatus = precisionFieldRoutesStatus(
      fieldRoutesStatuses,
      selectedFieldRoutesSourceKey,
      selectedProperty.address_hash,
    );
    return preferFieldRoutesStatus(localStatus, serverStatus);
  }, [fieldRoutesLocalStatuses, fieldRoutesPendingBySource, fieldRoutesStatuses, selectedFieldRoutesSourceKey, selectedProperty?.address_hash]);

  const mapRouteProperties = useMemo(() => routeProperties.map((property) => {
    const sourceKey = activeRoute?.id && property?.address_hash
      ? `precision:${activeRoute.id}:${property.address_hash}`
      : '';
    if (!sourceKey) return property;
    const localStatus = fieldRoutesLocalStatuses[sourceKey] || fieldRoutesPendingBySource[sourceKey];
    const serverStatus = precisionFieldRoutesStatus(fieldRoutesStatuses, sourceKey, property.address_hash);
    const fieldRoutesStatus = preferFieldRoutesStatus(localStatus, serverStatus);
    return fieldRoutesStatus
      ? { ...property, fieldroutes_status: fieldRoutesStatusPresentation(fieldRoutesStatus) }
      : property;
  }), [activeRoute?.id, fieldRoutesLocalStatuses, fieldRoutesPendingBySource, fieldRoutesStatuses, routeProperties]);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const focusHash = params.get('focus');
    if (!focusHash || appointmentRunFocusHandledRef.current || !routeProperties.length) return;

    const index = routeProperties.findIndex((property) =>
      property.address_hash === focusHash ||
      property.legacy_hash === focusHash ||
      property.id === focusHash
    );

    appointmentRunFocusHandledRef.current = true;
    if (index >= 0) {
      const property = routeProperties[index];
      setFilterStatus('all');
      setSearchQuery('');
      setSelectedProperty(property);
      setSelectedPropertyIndex(index);
      setFocusProperty(property);
      setShowMap(true);
      toast.success('Opened appointment route');
    } else {
      toast.error('Opened route, but this appointment address was not found on it.');
    }

    if (activeRoute?.id) {
      window.history.replaceState({}, '', `${window.location.pathname}?route=${encodeURIComponent(activeRoute.id)}`);
    }
  }, [routeProperties, activeRoute?.id]);

  // Stats
  const stats = useMemo(() => {
    const total = expectedRoutePropertyCount || routeProperties.length;
    if (!total) return { total: 0, done: 0, todo: 0, reKnock: 0, percent: 0 };
    const done = routeProperties.filter((p) => p.effective_status !== 'ELIGIBLE').length;
    const reKnock = routeProperties.filter((p) => p.effective_status === 'ELIGIBLE' && p.workflow_bucket === 'RE_KNOCK').length;
    return {
      total,
      done,
      todo: Math.max(total - done - reKnock, 0),
      reKnock,
      percent: Math.round(done / total * 100)
    };
  }, [expectedRoutePropertyCount, routeProperties]);

  const filteredProperties = useMemo(() => {
    return routeProperties.filter((p) => {
      // Search filter
      if (searchQuery) {
        const searchLower = searchQuery.toLowerCase();
        const address = `${p.house_number} ${p.street_name}`.toLowerCase();
        if (!address.includes(searchLower)) return false;
      }

      // Sold date filter — filter by how recently the property was sold
      if (soldDateFilter !== 'all' && p.sold_date) {
        const soldDate = new Date(p.sold_date);
        if (!isNaN(soldDate.getTime())) {
          const now = new Date();
          let cutoff;
          switch (soldDateFilter) {
            case '1w':cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);break;
            case '2w':cutoff = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);break;
            case '1m':cutoff = new Date(now.setMonth(now.getMonth() - 1));break;
            case '3m':cutoff = new Date(new Date().setMonth(new Date().getMonth() - 3));break;
            case '6m':cutoff = new Date(new Date().setMonth(new Date().getMonth() - 6));break;
            case '9m':cutoff = new Date(new Date().setMonth(new Date().getMonth() - 9));break;
            case '1y':cutoff = new Date(new Date().setFullYear(new Date().getFullYear() - 1));break;
            default:cutoff = null;
          }
          if (cutoff && soldDate < cutoff) return false;
        }
      }

      // Status filter
      const isDone = p.effective_status !== 'ELIGIBLE';

      if (filterStatus === 'todo') return !isDone && p.workflow_bucket !== 'RE_KNOCK';
      if (filterStatus === 'done') {
        if (!isDone) return false;
        return decisionFilter === 'all' || p.effective_status === decisionFilter;
      }
      if (filterStatus === 're_knock') {
        return !isDone && p.workflow_bucket === 'RE_KNOCK';
      }
      return true;
    });
  }, [routeProperties, filterStatus, searchQuery, soldDateFilter, decisionFilter]);

  const visiblePropertyKeys = useMemo(
    () => getVisiblePropertyKeys(filteredProperties),
    [filteredProperties]
  );
  const selectedProperties = useMemo(
    () => routeProperties.filter((property) => selectedPropertyKeys.has(getPropertySelectionKey(property))),
    [routeProperties, selectedPropertyKeys]
  );
  const allVisibleSelected = visiblePropertyKeys.length > 0
    && visiblePropertyKeys.every((key) => selectedPropertyKeys.has(key));

  React.useEffect(() => {
    setSelectedPropertyKeys(new Set());
    setNavigationSession(null);
    setNavigationError('');
  }, [activeRoute?.id]);

  React.useEffect(() => {
    setSelectedPropertyKeys((previous) => {
      const next = filterStatus === 'done'
        ? pruneSelectionToProperties(previous, filteredProperties)
        : new Set();
      return selectionsEqual(previous, next) ? previous : next;
    });
  }, [filterStatus, filteredProperties]);

  const invalidateBulkWorkflowQueries = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['myRoutes'] }),
    queryClient.invalidateQueries({ queryKey: ['savedRoutes'] }),
    queryClient.invalidateQueries({ queryKey: ['routeProperties'] }),
    queryClient.invalidateQueries({ queryKey: ['routeLogs'] }),
    queryClient.invalidateQueries({ queryKey: ['allMyLogs'] }),
    queryClient.invalidateQueries({ queryKey: ['myLogs'] }),
    queryClient.invalidateQueries({ queryKey: ['propertyHistory'] }),
    queryClient.invalidateQueries({ queryKey: ['interactionLogs'] }),
    queryClient.invalidateQueries({ queryKey: ['teamLogs'] }),
    queryClient.invalidateQueries({ queryKey: ['appointments'] }),
  ]);

  const bulkActionMutation = useMutation({
    mutationFn: async ({ action, properties: targetProperties, idempotencyKey }) => {
      if (!activeRoute?.id) throw new Error('No active route is available.');
      if (activeRouteArchived) throw new Error('Archived routes are read-only.');
      if (!routeHydrationComplete) {
        throw new Error(`Route recovery is incomplete (${routeProperties.length}/${expectedRoutePropertyCount} homes loaded). Refresh before changing this route.`);
      }
      if (!targetProperties?.length) throw new Error('Select at least one route stop.');

      if (action === ROUTE_BULK_ACTIONS.DELETE) {
        const latestRouteResult = await base44.entities.SavedRoute.filter({ id: activeRoute.id }, '-updated_date', 1);
        const latestRoute = Array.isArray(latestRouteResult) ? latestRouteResult[0] : latestRouteResult?.items?.[0];
        if (!latestRoute) throw new Error('This saved route could not be refreshed before deletion.');

        const { remainingHashes, removedHashes, unmatchedSelectionKeys } = removeSelectedRouteStops(
          latestRoute.property_hashes || [],
          targetProperties
        );
        if (unmatchedSelectionKeys.length > 0) {
          throw new Error('The route changed before every selected stop could be matched. Refresh and try again.');
        }
        if (!removedHashes.length) throw new Error('The selected stops were not found on this saved route.');

        const nextMetrics = {
          ...(latestRoute.metrics || {}),
          house_count: remainingHashes.length,
        };
        const { orderedProperties: remainingRouteProperties, unmatchedHashes } = orderRoutePropertiesByHashes(
          remainingHashes,
          routeProperties
        );
        const allRemainingCoordinatesAvailable = unmatchedHashes.length === 0
          && remainingRouteProperties.every(isValidRoutePoint);
        if (remainingHashes.length === 0) {
          nextMetrics.distance = 0;
        } else if (allRemainingCoordinatesAvailable) {
          const originMode = String(latestRoute.route_origin_mode || 'none').toLowerCase();
          const savedStart = isValidRoutePoint(latestRoute.start_location) ? latestRoute.start_location : null;
          const savedEnd = isValidRoutePoint(latestRoute.end_location) ? latestRoute.end_location : null;
          const homeBase = isValidRoutePoint(user?.home_base) ? user.home_base : null;
          let distanceBounds = null;

          if (originMode === 'home_round_trip' && homeBase) {
            distanceBounds = { startLocation: homeBase, endLocation: homeBase };
          } else if (originMode === 'current_to_home') {
            const endLocation = savedEnd || homeBase;
            if (savedStart && endLocation) distanceBounds = { startLocation: savedStart, endLocation };
          } else if (savedStart && savedEnd) {
            distanceBounds = { startLocation: savedStart, endLocation: savedEnd };
          } else {
            distanceBounds = {};
          }

          if (distanceBounds) {
            nextMetrics.distance = Math.round(calculateRouteDistanceMiles(
              remainingRouteProperties,
              distanceBounds
            ) * 100) / 100;
          }
        }

        await base44.entities.SavedRoute.update(activeRoute.id, {
          property_hashes: remainingHashes,
          metrics: nextMetrics,
        });
        return { action, count: removedHashes.length };
      }

      const routeHashSet = new Set((activeRoute.property_hashes || []).map(String));
      const requestedTransitions = buildWorkflowTransitionLogs(targetProperties, action, {
        routeId: activeRoute.id,
      }).map((transition, index) => ({
        ...transition,
        address_hash: getPropertyAliases(targetProperties[index])
          .find((alias) => routeHashSet.has(alias))
          || transition.address_hash,
      }));
      const transitionLogs = [...new Map(
        requestedTransitions.map((transition) => [transition.address_hash, transition])
      ).values()];
      if (!idempotencyKey) throw new Error('This workflow update is missing its retry key.');
      const batchSize = 500;
      let completedCount = 0;
      for (let index = 0; index < transitionLogs.length; index += batchSize) {
        const batch = transitionLogs.slice(index, index + batchSize);
        try {
          const response = await base44.functions.invoke('recordKnockOutcome', {
            action: 'workflow_transition',
            route_id: activeRoute.id,
            address_hashes: batch.map((transition) => transition.address_hash),
            workflow_action: batch[0].workflow_action,
            idempotency_key: `${idempotencyKey}:${Math.floor(index / batchSize)}`,
          });
          const updatedCount = Number(response?.data?.updated_count);
          completedCount += Number.isFinite(updatedCount) ? updatedCount : batch.length;
        } catch (error) {
          const wrappedError = new Error(
            error?.response?.data?.error
            || error?.message
            || 'The workflow update could not be saved.'
          );
          wrappedError.completedCount = completedCount;
          throw wrappedError;
        }
      }
      return { action, count: completedCount };
    },
    onSuccess: async ({ action, count }) => {
      bulkWorkflowRetryRef.current = null;
      setSelectedPropertyKeys(new Set());
      await invalidateBulkWorkflowQueries();

      if (action === ROUTE_BULK_ACTIONS.TODO) {
        setFilterStatus('todo');
        toast.success(`${count} stop${count === 1 ? '' : 's'} moved to Todo`);
      } else if (action === ROUTE_BULK_ACTIONS.CALLBACK) {
        setFilterStatus('done');
        setDecisionFilter('CALLBACK');
        toast.success(`${count} stop${count === 1 ? '' : 's'} moved to Callback`);
      } else if (action === ROUTE_BULK_ACTIONS.RE_KNOCK) {
        setFilterStatus('re_knock');
        toast.success(`${count} stop${count === 1 ? '' : 's'} queued for Re-Knock`);
      } else if (action === ROUTE_BULK_ACTIONS.DELETE) {
        toast.success(`${count} stop${count === 1 ? '' : 's'} removed from this route. History was preserved.`);
      }
    },
    onError: async (error) => {
      if (error?.completedCount > 0) {
        await invalidateBulkWorkflowQueries();
        toast.error(`${error.completedCount} stop${error.completedCount === 1 ? '' : 's'} updated before the request failed. The route was refreshed.`);
        return;
      }
      toast.error(error?.message || 'The selected stops could not be updated.');
    },
  });

  const knockWindow = getKnockWindowLabel(new Date());

  const remainingNavigationStops = selectRemainingTodoStops(
    routeProperties,
    (property) => property.effective_status
  );
  const navigationProgress = getNavigationSessionProgress(
    navigationSession?.routeId === activeRoute?.id ? navigationSession : null,
    remainingNavigationStops
  );
  const hasNextNavigationBatch = navigationProgress.canAdvance;
  const canResumeNavigationBatch = navigationProgress.canResume;

  const handleStartRouteNavigation = () => {
    setNavigationError('');
    if (activeRouteArchived) {
      setNavigationError('Archived routes are read-only and cannot be started.');
      return;
    }
    if (!routeHydrationComplete) {
      setNavigationError(`Route recovery is incomplete (${routeProperties.length}/${expectedRoutePropertyCount} homes loaded). Refresh before starting navigation.`);
      return;
    }
    try {
      if (canResumeNavigationBatch) {
        const resumePlan = getRouteNavigationPlan(navigationProgress.remainingStops, navigationApp, {
          startDelaySeconds: 0,
        });
        openNavigationBatch(resumePlan, 0);
        return;
      }

      if (hasNextNavigationBatch) {
        const continuationPlan = getRouteNavigationPlan(navigationProgress.continuationStops, navigationApp, {
          startDelaySeconds: 0,
        });
        if (!continuationPlan.batches.length) return;
        const nextSession = { routeId: activeRoute?.id, plan: continuationPlan, batchIndex: 0 };
        setNavigationSession(nextSession);
        openNavigationBatch(continuationPlan, 0);
        return;
      }

      const plan = getRouteNavigationPlan(remainingNavigationStops, navigationApp, { startDelaySeconds: 0 });
      if (!plan.batches.length) return;
      const nextSession = { routeId: activeRoute?.id, plan, batchIndex: 0 };
      setNavigationSession(nextSession);
      openNavigationBatch(plan, 0);
    } catch (error) {
      setNavigationError(error?.message || 'This route could not be opened in maps.');
    }
  };

  const warmGpsFix = React.useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        gpsFixRef.current = {
          gps_proof_lat: position.coords.latitude,
          gps_proof_lng: position.coords.longitude,
          gps_accuracy: position.coords.accuracy,
          capturedAt: Date.now(),
        };
      },
      () => {},
      { enableHighAccuracy: true, timeout: 10000, maximumAge: GPS_FIX_MAX_AGE_MS }
    );
  }, []);

  // Opening a house card is the cue that an outcome tap is coming next.
  const selectedPropertyHash = selectedProperty?.address_hash;
  React.useEffect(() => {
    if (!selectedPropertyHash) return;
    warmGpsFix();
  }, [selectedPropertyHash, warmGpsFix]);

  const resolveGpsProof = React.useCallback(async (prop) => {
    const fallback = {
      gps_proof_lat: prop?.lat ?? null,
      gps_proof_lng: prop?.lng ?? null,
      gps_accuracy: 0,
    };

    const cached = gpsFixRef.current;
    if (cached && Date.now() - cached.capturedAt < GPS_FIX_MAX_AGE_MS) {
      warmGpsFix();
      return {
        gps_proof_lat: cached.gps_proof_lat,
        gps_proof_lng: cached.gps_proof_lng,
        gps_accuracy: cached.gps_accuracy,
      };
    }

    if (typeof navigator === 'undefined' || !navigator.geolocation) return fallback;

    // The radio never holds the write hostage: after a short wait the outcome
    // saves against the property coordinates while the fix keeps warming.
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const timer = setTimeout(() => finish(fallback), GPS_FIX_WAIT_MS);

      navigator.geolocation.getCurrentPosition(
        (position) => {
          const proof = {
            gps_proof_lat: position.coords.latitude,
            gps_proof_lng: position.coords.longitude,
            gps_accuracy: position.coords.accuracy,
          };
          gpsFixRef.current = { ...proof, capturedAt: Date.now() };
          clearTimeout(timer);
          finish(proof);
        },
        () => {
          clearTimeout(timer);
          finish(fallback);
        },
        { enableHighAccuracy: true, timeout: GPS_FIX_WAIT_MS, maximumAge: GPS_FIX_MAX_AGE_MS }
      );
    });
  }, [warmGpsFix]);

  if (teamMembersLoading || routesLoading || propsLoading || logsLoading || (!activeRoute && canvasAssignmentsLoading)) {
    return (
      <div className="flex h-screen items-center justify-center bg-black text-white">
                <div className="text-center">
                    <Loader2 className="w-10 h-10 animate-spin text-[#2EEB57] mx-auto mb-4" />
                    <p className="font-medium animate-pulse text-white/70">Loading Route Data...</p>
                </div>
            </div>);

  }

  if (canvasAssignments.length > 0 && (canvasFieldOpen || (!activeRoute && !canvasFieldDismissed))) {
    return <CanvasFieldView
      assignments={canvasAssignments}
      truncated={canvasAssignmentPackage?.truncated === true}
      rejectedDeployments={canvasAssignmentPackage?.rejected_deployments || 0}
      user={user}
      navigationApp={navigationApp}
      fieldRoutesCapability={fieldRoutesCapability}
      fieldRoutesPendingBySource={fieldRoutesPendingBySource}
      fieldRoutesPendingDeviceCount={fieldRoutesPendingDeviceCount}
      onDiscardFieldRoutesDeviceAttention={discardFieldRoutesDeviceAttention}
      onScheduleFieldRoutesInspection={submitFieldRoutesInspection}
      onClose={() => { setCanvasFieldOpen(false); setCanvasFieldDismissed(true); }}
    />;
  }

  if (!activeRoute) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-black text-white p-6 text-center">
                <div className="w-20 h-20 bg-white/[0.04] border border-white/10 rounded-3xl flex items-center justify-center mb-6 shadow-[0_0_40px_rgba(46,235,87,0.12)]">
                    <Navigation className="w-10 h-10 text-[#2EEB57]" />
                </div>
                <h1 className="text-2xl font-bold mb-2">
                    {routeIdentityUnavailable ? 'Routes Temporarily Unavailable' : 'No Active Routes'}
                </h1>
                <p className="text-gray-400 mb-8 max-w-xs">
                    {routeIdentityUnavailable
                      ? 'We could not verify your team profile. Your saved route cache was preserved; try again when your connection is stable.'
                      : "You don't have any routes assigned yet. Ask your manager to assign one, or check back later."}
                </p>
                {canvasAssignmentNotice && (
                  <p className="mb-4 max-w-sm rounded-xl border border-purple-400/25 bg-purple-500/10 p-3 text-xs text-purple-100">
                    {canvasAssignmentNotice}
                  </p>
                )}
                {canvasAssignmentsUnavailable && (
                  <p className="mb-4 max-w-sm rounded-xl border border-amber-400/20 bg-amber-400/10 p-3 text-xs text-amber-200">
                    Canvas assignments are temporarily unavailable. No local or name-matched assignment was substituted.
                  </p>
                )}
                {Number(canvasAssignmentPackage?.rejected_deployments) > 0 && (
                  <p className="mb-4 max-w-sm rounded-xl border border-red-400/20 bg-red-400/10 p-3 text-xs text-red-200">
                    The server rejected {canvasAssignmentPackage.rejected_deployments} Canvas deployment{canvasAssignmentPackage.rejected_deployments === 1 ? '' : 's'} because its signed plan snapshot failed verification. Ask your manager to deploy a fresh plan.
                  </p>
                )}
                <Button onClick={() => {
                  setCanvasFieldDismissed(false);
                  refetchCanvasAssignments();
                  queryClient.invalidateQueries({ queryKey: ['myTeamMember'] });
                  queryClient.invalidateQueries({ queryKey: ['myRoutes'] });
                }} variant="outline" className="border-gray-700 text-white">
                    {routeIdentityUnavailable ? 'Try Again' : 'Check Again'}
                </Button>
            </div>);

  }

  // --- RENDER HELPERS ---

  const handleClearDecision = (log) => {
    if (activeRouteArchived) {
      toast.error('Archived routes are read-only.');
      return;
    }
    if (!log?.address_hash) return;
    if (confirm('Clear this decision and move the home back to Todo?')) {
      clearDecisionMutation.mutate(log);
    }
  };

  const handleTogglePropertySelection = (property) => {
    if (activeRouteArchived || bulkActionMutation.isPending) return;
    setSelectedPropertyKeys((previous) => togglePropertySelection(previous, property));
  };

  const handleToggleVisibleSelection = () => {
    if (activeRouteArchived || bulkActionMutation.isPending || filteredProperties.length === 0) return;
    setSelectedPropertyKeys((previous) => toggleVisiblePropertySelection(previous, filteredProperties));
  };

  const handleBulkAction = (action) => {
    if (activeRouteArchived) {
      toast.error('Archived routes are read-only.');
      return;
    }
    if (bulkActionMutation.isPending) return;
    if (!selectedProperties.length) {
      toast.error('Select at least one completed stop.');
      return;
    }
    if (action === ROUTE_BULK_ACTIONS.DELETE) {
      const confirmed = confirm(
        `Remove ${selectedProperties.length} selected stop${selectedProperties.length === 1 ? '' : 's'} from this route? Global properties and interaction history will be preserved.`
      );
      if (!confirmed) return;
    }
    const selectionFingerprint = selectedProperties
      .map(getPropertySelectionKey)
      .filter(Boolean)
      .sort()
      .join('|');
    const retryFingerprint = `${activeRoute?.id || ''}:${action}:${selectionFingerprint}`;
    const retryState = bulkWorkflowRetryRef.current;
    const idempotencyKey = action === ROUTE_BULK_ACTIONS.DELETE
      ? null
      : retryState?.fingerprint === retryFingerprint
        ? retryState.idempotencyKey
        : createOutcomeIdempotencyKey('rep-workflow');

    if (action !== ROUTE_BULK_ACTIONS.DELETE) {
      bulkWorkflowRetryRef.current = { fingerprint: retryFingerprint, idempotencyKey };
    }
    bulkActionMutation.mutate({ action, properties: selectedProperties, idempotencyKey });
  };

  const handleLog = async (logData) => {
    if (activeRouteArchived) {
      toast.error('Archived routes are read-only.');
      return false;
    }
    if (!selectedProperty && !logData.address_hash) return false;
    const prop = selectedProperty || {};
    const addressHash = logData.address_hash || prop.address_hash;
    if (!addressHash) return false;

    const saleSnapshot = logData.parsed_status === 'SOLD'
      ? {
          sale_date: logData.sale_date || new Date().toISOString(),
          property_address: buildFullAddress(prop),
          homeowner_name: prop.owner_full_name || prop.owner_name || prop.ownerFullName || null,
          rep_id: teamMember?.id || user?.id || null,
          rep_name: teamMember?.name || user?.full_name || user?.name || user?.email || null,
          route_name: activeRoute?.name || null,
        }
      : {};
    const optimisticId = `optimistic-${createOutcomeIdempotencyKey('rep-knock')}`;
    const enrichedLogData = {
      ...logData,
      ...saleSnapshot,
      address_hash: addressHash,
      optimistic_id: optimisticId,
      property_snapshot: prop,
      route_id: logData.route_id || activeRoute?.id || null,
    };

    // Haptic feedback
    if (navigator.vibrate) navigator.vibrate(50);

    // The door is marked and the sheet closes on the tap. The GPS fix and the
    // authoritative write run behind the rep, who is already at the next door;
    // a failure rolls the row back and surfaces the billing gate or an error.
    applyOptimisticLog({
      ...enrichedLogData,
      id: optimisticId,
      created_date: new Date().toISOString(),
      created_by: user?.email || null,
      property_snapshot: undefined,
    });
    setSelectedProperty(null);
    setSelectedPropertyIndex(null);

    // Every outcome write takes a per-user server lease, so concurrent taps
    // would collide with 409 outcome_write_in_progress. Queue them instead.
    outcomeQueueRef.current = outcomeQueueRef.current
      .then(async () => {
        const gpsProof = await resolveGpsProof(prop);
        await createLogMutation.mutateAsync({ ...enrichedLogData, ...gpsProof });
      })
      .catch(() => {
        // Mutation callbacks roll the row back and display gates and errors.
      });

    return true;
  };

  const handleScheduleInspection = async ({ contact, property, notes }) => {
    if (activeRouteArchived) throw new Error('Archived routes are read-only.');
    const target = selectedProperty;
    if (!target?.address_hash || !activeRoute?.id) throw new Error('This route property is not ready for FieldRoutes yet.');
    const sourceKey = `precision:${activeRoute.id}:${target.address_hash}`;
    const delivery = await submitFieldRoutesInspection({
      source: {
        kind: 'precision',
        source_key: sourceKey,
        route_id: activeRoute.id,
        address_hash: target.address_hash,
        property_id: target.id ? String(target.id) : null,
      },
      contact,
      property: {
        ...property,
        lat: Number.isFinite(Number(target.lat)) ? Number(target.lat) : null,
        lng: Number.isFinite(Number(target.lng)) ? Number(target.lng) : null,
      },
      notes,
    });
    setFieldRoutesLocalStatuses((current) => ({ ...current, [sourceKey]: delivery }));
    if (delivery.kind === 'synced') toast.success(delivery.copy);
    else if (delivery.kind === 'attention') toast.error(delivery.copy);
    else if (delivery.kind === 'device_pending') toast.warning(delivery.copy, { duration: 7000 });
    else toast.info(delivery.copy);
    return delivery;
  };

  const handlePhotoUpload = async (e) => {
    if (activeRouteArchived) return;
    const file = e.target.files[0];
    if (!file || !selectedProperty) return;
    setUploading(true);
    try {
      if (navigator.vibrate) navigator.vibrate([50, 50, 50]);
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      handleLog({
        address_hash: selectedProperty.address_hash,
        raw_input_text: 'Photo proof uploaded',
        parsed_status: 'CALLBACK',
        image_url: file_url
      });
    } catch (error) {
      console.error(error);
    } finally {
      setUploading(false);
    }
  };

  const handleRouteRefresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['myRoutes'] }),
    queryClient.invalidateQueries({ queryKey: ['routeProperties'] }),
    queryClient.invalidateQueries({ queryKey: ['routeLogs'] })
  ]);

  const handleSaveRepHomeBase = async (event) => {
    event?.preventDefault();
    if (homeBaseSaving || homeRouteOptimizing) return;

    setHomeBaseSaving(true);
    setHomeBaseError('');
    setHomeRouteError('');
    toast.loading('Looking up your Home Base...', { id: 'rep-home-base' });
    try {
      const resolved = await geocodeAddress(homeBaseAddress);
      const exactHomeBase = {
        address: resolved.address,
        lat: Number(resolved.lat),
        lng: Number(resolved.lng)
      };
      if (!isValidRoutePoint(exactHomeBase)) throw new Error('Choose a valid Home Base address first.');

      await base44.auth.updateMe({ home_base: exactHomeBase });
      setHomeBaseAddress(exactHomeBase.address);
      queryClient.setQueryData(['user'], (current) => ({
        ...(current || user || {}),
        home_base: exactHomeBase
      }));

      await queryClient.invalidateQueries({ queryKey: ['user'] });
      toast.success('Home Base saved privately.', { id: 'rep-home-base' });
    } catch (error) {
      const message = error?.message || 'Could not save your Home Base. Please try again.';
      setHomeBaseError(message);
      toast.error(message, { id: 'rep-home-base', duration: 6000 });
    } finally {
      setHomeBaseSaving(false);
    }
  };

  const handleOptimizeSelectedRouteFromHome = async () => {
    if (homeRouteOptimizing || homeBaseSaving) return;
    if (activeRouteArchived) {
      const message = 'Archived routes are read-only and cannot be optimized.';
      setHomeRouteError(message);
      toast.error(message, { id: 'rep-home-route' });
      return;
    }
    if (!activeRoute?.id) {
      const message = 'Select a route before optimizing from home.';
      setHomeRouteError(message);
      toast.error(message, { id: 'rep-home-route' });
      return;
    }

    const routeToOptimize = activeRoute;
    if (!activeRouteBelongsToCurrentUser) {
      const message = 'This route must be assigned to you before you can optimize it from your Home Base.';
      setHomeRouteError(message);
      toast.error(message, { id: 'rep-home-route', duration: 6000 });
      return;
    }
    setHomeRouteOptimizing(true);
    setHomeRouteError('');
    toast.loading('Optimizing the selected route from home...', { id: 'rep-home-route' });

    try {
      let freshUser = null;
      try {
        freshUser = await base44.auth.me();
        if (freshUser) queryClient.setQueryData(['user'], freshUser);
      } catch {
        freshUser = user;
      }

      const exactHomeBase = freshUser?.home_base || user?.home_base;
      if (!isValidRoutePoint(exactHomeBase)) {
        throw new Error('Save a Home Base above before optimizing this route.');
      }
      if (!routeProperties.length) throw new Error('No properties are loaded for the selected route.');

      const expectedPropertyCount = routeToOptimize.property_hashes?.length || 0;
      if (expectedPropertyCount > 0 && routeProperties.length !== expectedPropertyCount) {
        throw new Error(`Only ${routeProperties.length} of ${expectedPropertyCount} route properties loaded. Refresh and try again.`);
      }
      const invalidProperty = routeProperties.find((property) => !isValidRoutePoint(property));
      if (invalidProperty) throw new Error('A route property is missing map coordinates. Ask your manager to repair this route.');

      const routingContext = createRouteContinuityContext(routeProperties);
      requireUsableRouteContext(routingContext);
      const optimized = optimizeRouteByStreetSweep(
        routeProperties,
        exactHomeBase,
        exactHomeBase,
        routingContext,
      );
      if (optimized.length !== routeProperties.length) {
        throw new Error('The optimizer could not preserve every property in this route.');
      }

      const propertyHashes = optimized.map((property) => property.address_hash || property.legacy_hash || property.id);
      if (propertyHashes.some((hash) => !hash)) {
        throw new Error('A route property is missing its address identifier. Ask your manager to repair this route.');
      }
      const expectedHashes = new Set(routeProperties.map(
        (property) => property.address_hash || property.legacy_hash || property.id,
      ));
      if (
        new Set(propertyHashes).size !== expectedHashes.size
        || propertyHashes.some((hash) => !expectedHashes.has(hash))
      ) {
        throw new Error('Route integrity verification failed, so the existing route was left unchanged.');
      }

      const distance = Math.round(calculateRouteDistanceMiles(optimized, {
        startLocation: exactHomeBase,
        endLocation: exactHomeBase,
      }) * 100) / 100;
      const existingMetadata = { ...(routeToOptimize.metadata || {}) };
      delete existingMetadata.road_geometry;
      const routeUpdate = {
        property_hashes: propertyHashes,
        metrics: {
          ...(routeToOptimize.metrics || {}),
          distance,
          house_count: optimized.length
        },
        start_location: null,
        end_location: null,
        route_origin_mode: 'home_round_trip',
        metadata: {
          ...existingMetadata,
          ...buildPersistedRoadRoutingMetadata(routingContext, null, propertyHashes),
          route_bounds: { enabled: true, mode: 'home_round_trip' }
        }
      };

      await base44.entities.SavedRoute.update(routeToOptimize.id, routeUpdate);
      queryClient.setQueryData(myRoutesQueryKey, (currentRoutes) =>
        Array.isArray(currentRoutes)
          ? currentRoutes.map((route) => route.id === routeToOptimize.id ? { ...route, ...routeUpdate } : route)
          : currentRoutes
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['myRoutes'] }),
        queryClient.invalidateQueries({ queryKey: ['routeProperties'] })
      ]);
      toast.success(`Home round trip optimized (${distance} mi street-continuity estimate).`, {
        id: 'rep-home-route',
        duration: 5000
      });
    } catch (error) {
      const message = error?.message || 'Could not optimize this route from home. Please try again.';
      setHomeRouteError(message);
      toast.error(message, { id: 'rep-home-route', duration: 6000 });
    } finally {
      setHomeRouteOptimizing(false);
    }
  };

  return (
    <div className="h-full flex flex-col bg-black text-[#F0F0F5] relative overflow-hidden">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_-10%,rgba(46,235,87,0.14),transparent_34%),linear-gradient(180deg,#000000_0%,#030303_45%,#000000_100%)]" />
            <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-white/[0.035] to-transparent" />
            <div className="relative z-10 h-full flex flex-col">
            {/* Compact Header */}
            <RepHeader
        user={user}
        isOffline={isOffline}
        activeRoute={activeRoute}
        stats={stats}
        knockWindow={knockWindow}
        routes={routes}
        onShowMap={() => setShowMap(true)}
        onShowRouteList={openRouteSwitcher}
        routeListOpen={showRouteList}
        routeProperties={routeProperties}
        onStartNavigation={handleStartRouteNavigation}
        navigationDisabled={activeRouteArchived || !routeHydrationComplete || (!hasNextNavigationBatch && remainingNavigationStops.length === 0)}
        navigationButtonLabel={hasNextNavigationBatch ? 'Next Batch' : canResumeNavigationBatch ? 'Resume' : 'Start'}
        navigationBatchLabel={hasNextNavigationBatch
          ? `${navigationProgress.continuationStops.length} left`
          : canResumeNavigationBatch
            ? `${navigationProgress.remainingStops.length} left`
            : remainingNavigationStops.length > 0 ? `${remainingNavigationStops.length} stops` : ''}
        navigationError={navigationError} />

            {showLimitBanner && <KnockLimitBanner mode={gateMode} />}

            {!routeHydrationComplete &&
      <div className="mx-3 mt-2 rounded-xl border border-amber-400/35 bg-amber-400/10 px-3 py-2 text-[11px] leading-relaxed text-amber-100" role="alert">
                    Recovering this saved route: {routeProperties.length}/{expectedRoutePropertyCount} homes loaded. Pins already recovered remain visible, but navigation, bulk changes, optimization, and completion stay locked until every home is restored.
                    <button type="button" onClick={handleRouteRefresh} className="ml-2 font-black underline underline-offset-2">
                        Retry now
                    </button>
                </div>
      }

            {/* Filter tabs + search */}
            <div className="border-b border-white/10 bg-black/70 px-3 py-3 shadow-[0_12px_36px_rgba(0,0,0,0.32)] backdrop-blur-xl sm:px-4 lg:grid lg:grid-cols-[minmax(520px,0.9fr)_minmax(360px,1.1fr)] lg:items-center lg:gap-4 lg:px-6">
                {/* Account-wide customer / address search (callback handling) */}
                <RepUnifiedSearch
                  routeProperties={routeProperties}
                  onOpenProperty={(property) => {
                    const index = routeProperties.findIndex((stop) => stop.address_hash === property.address_hash);
                    setSelectedProperty(property);
                    setSelectedPropertyIndex(index >= 0 ? index : null);
                  }}
                  onLocateOnRoute={(property) => {
                    setFocusProperty(property);
                    setShowMap(true);
                  }}
                />

                {/* Top Row: Segmented Control */}
                <div className="grid grid-cols-4 gap-1 rounded-2xl border border-white/10 bg-white/[0.045] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_10px_30px_rgba(0,0,0,0.24)]">
                    {[
          { id: 'todo', label: 'Todo', count: stats.todo },
          { id: 'done', label: 'Done', count: stats.done },
          { id: 're_knock', label: 'Re-Knock', count: stats.reKnock },
          { id: 'all', label: 'All', count: routeProperties.length }].
          map((tab) =>
          <button
            key={tab.id}
            onClick={() => setFilterStatus(tab.id)}
            className={`flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-xl px-2 text-[11px] font-black tracking-[0.04em] transition-all sm:text-xs lg:h-12 lg:gap-2 lg:text-sm ${filterStatus === tab.id ? 'bg-gradient-to-b from-white to-white/90 text-black shadow-[0_8px_24px_rgba(255,255,255,0.16)]' : 'text-white/55 hover:bg-white/[0.06] hover:text-white'}`
            }>
                            <span className="truncate">{tab.label}</span>
                            <span className={`flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[9px] font-black lg:h-6 lg:min-w-6 lg:text-[10px] ${filterStatus === tab.id ? 'bg-black/10 text-black/70' : 'bg-white/10 text-white/60'}`}>
                                {tab.count}
                            </span>
                        </button>
          )}
                </div>

                {/* Bottom Row: Date Filter & Search */}
                <div className="mt-2 flex items-center gap-2 lg:mt-0 lg:min-w-0 lg:justify-end">
                    {/* Sold Date Filter */}
                    <div className="relative flex-1 min-w-0">
                        <select
              value={soldDateFilter}
              onChange={(e) => setSoldDateFilter(e.target.value)}
              className="h-10 w-full cursor-pointer appearance-none rounded-xl border border-white/10 bg-white/[0.045] pl-3 pr-9 text-[11px] font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] outline-none transition-colors focus:border-[#2EEB57]/60 lg:h-12 lg:text-xs [color-scheme:dark]">
              
                            <option className="bg-black text-white" value="all">Sale: All Time</option>
                            <option className="bg-black text-white" value="1w">Sale: 1 Week</option>
                            <option className="bg-black text-white" value="2w">Sale: 2 Weeks</option>
                            <option className="bg-black text-white" value="1m">Sale: 1 Month</option>
                            <option className="bg-black text-white" value="3m">Sale: 3 Months</option>
                            <option className="bg-black text-white" value="6m">Sale: 6 Months</option>
                            <option className="bg-black text-white" value="9m">Sale: 9 Months</option>
                            <option className="bg-black text-white" value="1y">Sale: 1 Year</option>
                        </select>
                        <CalendarDays className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#8888A0] pointer-events-none" />
                    </div>

                    {filterStatus === 'done' &&
          <div className="relative flex-1 min-w-0">
                            <select
              value={decisionFilter}
              onChange={(e) => setDecisionFilter(e.target.value)}
              className="h-10 w-full cursor-pointer appearance-none rounded-xl border border-white/10 bg-white/[0.045] pl-3 pr-8 text-[11px] font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] outline-none transition-colors focus:border-[#2EEB57]/60 lg:h-12 lg:text-xs [color-scheme:dark]">
              
                                <option className="bg-black text-white" value="all">Decision: All</option>
                                <option className="bg-black text-white" value="SOLD">Sold</option>
                                <option className="bg-black text-white" value="NO_ANSWER">No Answer</option>
                                <option className="bg-black text-white" value="CALLBACK">Callback</option>
                                <option className="bg-black text-white" value="HARD_NO">Not Interested</option>
                                <option className="bg-black text-white" value="NOT_MOVED_IN">Not Moved In</option>
                                <option className="bg-black text-white" value="DM_NOT_HOME">DM Not Home</option>
                            </select>
                        </div>
          }

                    {/* Inline search */}
                    {routeProperties.length > 8 &&
          <div className="relative flex-1">
                            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#8888A0]" />
                            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search address..."
              className="h-10 w-full rounded-xl border border-white/10 bg-white/[0.045] pl-8 pr-8 text-[11px] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] placeholder:text-white/35 focus:border-[#2EEB57]/60 lg:h-12 lg:text-xs" />
            
                            {searchQuery &&
            <button onClick={() => setSearchQuery('')} className="absolute right-2.5 top-1/2 -translate-y-1/2">
                                    <X className="w-3.5 h-3.5 text-[#8888A0]" />
                                </button>
            }
                        </div>
          }
                </div>
            </div>

            {filterStatus === 'done' &&
            <div className="border-b border-white/10 bg-black/85 px-3 py-2 shadow-[0_10px_30px_rgba(0,0,0,0.28)] backdrop-blur-xl">
                <div className="mb-2 flex items-center justify-between gap-3">
                    <label className="flex min-w-0 cursor-pointer items-center gap-2 text-[10px] font-black uppercase tracking-[0.12em] text-white/75">
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          aria-checked={!allVisibleSelected && selectedProperties.length > 0 ? 'mixed' : allVisibleSelected}
                          aria-label={`Select all ${filteredProperties.length} visible completed stops`}
                          disabled={activeRouteArchived || bulkActionMutation.isPending || filteredProperties.length === 0}
                          onChange={handleToggleVisibleSelection}
                          className="h-4 w-4 shrink-0 cursor-pointer accent-[#39FF4A] disabled:cursor-not-allowed disabled:opacity-40"
                        />
                        <span className="truncate">{allVisibleSelected ? 'Clear All' : 'Select All'} ({filteredProperties.length})</span>
                    </label>
                    <span className="shrink-0 text-[10px] font-bold text-[#39FF4A]" aria-live="polite">
                        {bulkActionMutation.isPending
                          ? <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Updating</span>
                          : `${selectedProperties.length} selected`}
                    </span>
                </div>
                <div className="grid grid-cols-4 gap-1.5">
                    <button
                      type="button"
                      disabled={activeRouteArchived || bulkActionMutation.isPending || selectedProperties.length === 0}
                      onClick={() => handleBulkAction(ROUTE_BULK_ACTIONS.TODO)}
                      className="h-9 rounded-xl border border-white/15 bg-white/[0.07] px-1 text-[9px] font-black text-white transition-colors hover:bg-white/[0.12] disabled:cursor-not-allowed disabled:opacity-35"
                    >
                        To Todo
                    </button>
                    <button
                      type="button"
                      disabled={activeRouteArchived || bulkActionMutation.isPending || selectedProperties.length === 0}
                      onClick={() => handleBulkAction(ROUTE_BULK_ACTIONS.CALLBACK)}
                      className="h-9 rounded-xl border border-sky-400/25 bg-sky-400/10 px-1 text-[9px] font-black text-sky-300 transition-colors hover:bg-sky-400/15 disabled:cursor-not-allowed disabled:opacity-35"
                    >
                        Callback
                    </button>
                    <button
                      type="button"
                      disabled={activeRouteArchived || bulkActionMutation.isPending || selectedProperties.length === 0}
                      onClick={() => handleBulkAction(ROUTE_BULK_ACTIONS.RE_KNOCK)}
                      className="h-9 rounded-xl border border-amber-400/25 bg-amber-400/10 px-1 text-[9px] font-black text-amber-300 transition-colors hover:bg-amber-400/15 disabled:cursor-not-allowed disabled:opacity-35"
                    >
                        Re-Knock
                    </button>
                    <button
                      type="button"
                      disabled={activeRouteArchived || bulkActionMutation.isPending || selectedProperties.length === 0}
                      onClick={() => handleBulkAction(ROUTE_BULK_ACTIONS.DELETE)}
                      className="h-9 rounded-xl border border-red-400/25 bg-red-400/10 px-1 text-[9px] font-black text-red-300 transition-colors hover:bg-red-400/15 disabled:cursor-not-allowed disabled:opacity-35"
                    >
                        Delete
                    </button>
                </div>
            </div>
            }

            {/* Property List */}
            <PullToRefresh onRefresh={handleRouteRefresh} className="flex-1 overflow-y-auto px-2.5 py-2 pb-20 bg-transparent">
                {filteredProperties.length === 0 ?
        <div className="text-center py-16">
                        <div className="w-14 h-14 bg-gray-800 rounded-full flex items-center justify-center mx-auto mb-3">
                            {filterStatus === 'done' ? <CheckCircle2 className="w-7 h-7 text-green-500" /> : <Navigation className="w-7 h-7 text-gray-600" />}
                        </div>
                        <p className="text-gray-500 text-sm font-medium">
                            {searchQuery ? 'No matches' : filterStatus === 'done' ? 'None completed yet' : filterStatus === 're_knock' ? 'No Re-Knock stops queued' : 'All done! 🎉'}
                        </p>
                    </div> :

        <div className="space-y-1.5">
                        {filteredProperties.map((prop, idx) =>
          <PropertyCard
            key={getPropertySelectionKey(prop)}
            property={prop}
            index={idx}
            navigationApp={navigationApp}
            selectable={filterStatus === 'done' && !activeRouteArchived}
            selected={selectedPropertyKeys.has(getPropertySelectionKey(prop))}
            onToggleSelect={handleTogglePropertySelection}
            onSelect={(p, i) => {setSelectedProperty(p);setSelectedPropertyIndex(i);}} />

          )}
                    </div>
        }
            </PullToRefresh>

            {/* Floating action buttons */}
            <div className="fixed bottom-20 left-4 right-4 z-30 flex items-center gap-2 rounded-[28px] border border-white/10 bg-black/55 p-2 shadow-[0_22px_70px_rgba(0,0,0,0.65)] backdrop-blur-2xl">
                {routeHydrationComplete && stats.percent >= 100 && activeRouteCanComplete &&
        <Button
          onClick={() => {
            if (confirm("Mark route as complete?")) completeRouteMutation.mutate(activeRoute.id);
          }}
          disabled={completeRouteMutation.isPending}
          className="flex-1 h-12 rounded-[20px] border border-[#B6FF5C]/40 bg-gradient-to-r from-[#2EEB57] via-[#39FF4A] to-[#B6FF5C] text-black font-black text-xs tracking-[0.16em] shadow-[0_14px_34px_rgba(46,235,87,0.35)] transition-all hover:scale-[1.01] hover:shadow-[0_18px_46px_rgba(57,255,74,0.45)] active:scale-[0.98]">
          
                        ✅ Complete Route
                    </Button>
        }
                <button
          onClick={() => setShowAnalytics(true)}
          className="group relative flex h-12 w-12 items-center justify-center overflow-hidden rounded-[20px] border border-white/15 bg-white/[0.08] text-white shadow-[0_14px_34px_rgba(255,255,255,0.12)] transition-all hover:-translate-y-0.5 hover:border-white/30 hover:bg-white/[0.14] active:translate-y-0 active:scale-95">
          
                    <span className="absolute inset-0 bg-gradient-to-br from-white/28 via-white/5 to-transparent opacity-80" />
                    <span className="absolute -bottom-5 left-1/2 h-10 w-10 -translate-x-1/2 rounded-full bg-white/20 blur-xl transition-opacity group-hover:opacity-100" />
                    <TrendingUp className="relative mx-auto h-4 w-4" />
                </button>
                <button
          onClick={() => setShowChat(true)}
          className="group relative flex h-12 w-12 items-center justify-center overflow-hidden rounded-[20px] border border-[#39FF4A]/50 bg-gradient-to-br from-[#39FF4A] via-[#2EEB57] to-[#139B38] text-black shadow-[0_14px_34px_rgba(46,235,87,0.32)] transition-all hover:-translate-y-0.5 hover:shadow-[0_18px_46px_rgba(57,255,74,0.45)] active:translate-y-0 active:scale-95">
          
                    <span className="absolute inset-0 bg-gradient-to-br from-white/45 via-transparent to-black/10" />
                    <span className="absolute -bottom-5 left-1/2 h-10 w-10 -translate-x-1/2 rounded-full bg-[#39FF4A]/60 blur-xl transition-opacity group-hover:opacity-100" />
                    <MessageCircle className="relative mx-auto h-4 w-4" />
                </button>
            </div>

            {/* Route Switching Drawer */}
            {showRouteList && createPortal(
      <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-sm" onClick={closeRouteSwitcher}>
                    <div ref={routeSwitcherRef} id="rep-route-switcher" role="dialog" aria-modal="true" aria-labelledby="rep-route-switcher-title" onKeyDown={handleRouteSwitcherKeyDown} className="min-h-0 max-h-[85dvh] overflow-hidden bg-[#050505]/95 backdrop-blur-2xl rounded-t-3xl border-t border-white/10 flex flex-col shadow-[0_-20px_70px_rgba(0,0,0,0.7)]" onClick={(e) => e.stopPropagation()}>
                        <div className="shrink-0 p-4 border-b border-white/10 flex justify-between items-center">
                            <div>
                                <h3 id="rep-route-switcher-title" className="font-bold text-white">Switch Route</h3>
                                <p className="mt-0.5 text-[10px] text-white/45">
                                    {routes.length} {routeScope.managerAccount ? 'account' : 'assigned'} route{routes.length === 1 ? '' : 's'}
                                </p>
                            </div>
                            <button ref={routeSwitcherCloseButtonRef} type="button" aria-label="Close route switcher" onClick={closeRouteSwitcher} className="-mr-2 flex h-10 w-10 items-center justify-center rounded-xl text-gray-500 transition hover:bg-white/[0.06] hover:text-white"><X className="w-5 h-5" /></button>
                        </div>
                        <div
                          id="rep-route-switcher-scroll-region"
                          tabIndex={0}
                          aria-label="Scrollable route switcher content"
                          className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-y-contain p-4 pb-[calc(2rem+env(safe-area-inset-bottom))] scroll-pb-[calc(2rem+env(safe-area-inset-bottom))] space-y-4 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#39FF4A]/45"
                        >
                            {canvasAssignments.length > 0 && (
                              <button
                                type="button"
                                onClick={() => {
                                  setCanvasFieldDismissed(false);
                                  setCanvasFieldOpen(true);
                                  closeRouteSwitcher();
                                }}
                                className="w-full rounded-2xl border border-purple-400/35 bg-purple-500/10 p-3.5 text-left transition-colors hover:bg-purple-500/15"
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <p className="text-sm font-black text-white">Canvas assignments</p>
                                    <p className="mt-0.5 text-[11px] text-purple-100/60">{canvasAssignments.length} deployed area{canvasAssignments.length === 1 ? '' : 's'} available</p>
                                  </div>
                                  <Navigation className="h-5 w-5 text-purple-300" />
                                </div>
                              </button>
                            )}
                            <section className="overflow-hidden rounded-2xl border border-[#2EEB57]/25 bg-[#2EEB57]/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                                <button
                                  id="rep-home-base-toggle"
                                  type="button"
                                  aria-expanded={homeBasePanelOpen}
                                  aria-controls="rep-home-base-controls"
                                  onClick={() => setHomeBasePanelOpen((open) => !open)}
                                  className="flex w-full items-center justify-between gap-3 p-3 text-left transition hover:bg-white/[0.035]"
                                >
                                    <div className="min-w-0">
                                        <p className="text-xs font-black text-white">Home Base &amp; optimization</p>
                                        <p className="mt-0.5 truncate text-[10px] text-white/45">
                                            {user?.home_base ? 'Saved privately' : 'Not set'} · {activeRoute?.name || 'No route selected'}
                                        </p>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-2">
                                        {user?.home_base &&
                    <span className="rounded-full border border-[#39FF4A]/30 bg-[#39FF4A]/10 px-2 py-1 text-[8px] font-black uppercase tracking-[0.12em] text-[#39FF4A]">
                                            Saved
                                        </span>
                    }
                                        <ChevronDown className={`h-4 w-4 text-white/45 transition-transform ${homeBasePanelOpen ? 'rotate-180' : ''}`} />
                                    </div>
                                </button>

                                {homeBasePanelOpen &&
                  <div id="rep-home-base-controls" role="region" aria-labelledby="rep-home-base-toggle" className="border-t border-white/10 p-3">
                                <p className="mb-3 text-[11px] leading-relaxed text-white/55">
                                    Set your private start and finish, then optimize the selected route.
                                </p>
                                <form onSubmit={handleSaveRepHomeBase} className="space-y-2.5">
                                    <label htmlFor="rep-home-base-address" className="block text-[10px] font-black uppercase tracking-[0.14em] text-white/50">
                                        Home address
                                    </label>
                                    <Input
                    id="rep-home-base-address"
                    value={homeBaseAddress}
                    onChange={(event) => {
                      setHomeBaseAddress(event.target.value);
                      setHomeBaseError('');
                    }}
                    autoComplete="street-address"
                    placeholder="Street, city, state, ZIP"
                    disabled={homeBaseSaving || homeRouteOptimizing}
                    className="h-11 rounded-xl border-white/10 bg-black/45 px-3 text-sm text-white placeholder:text-white/30 focus:border-[#2EEB57]/60" />

                                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                        <Button
                      type="submit"
                      disabled={!homeBaseAddress.trim() || homeBaseSaving || homeRouteOptimizing}
                      className="h-11 w-full rounded-xl border border-white/15 bg-white/[0.08] text-xs font-black text-white hover:bg-white/[0.14] disabled:opacity-45">
                                            {homeBaseSaving ?
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving...</> :
                        user?.home_base ? 'Change Home Base' : 'Save Home Base'
                      }
                                        </Button>
                                        <Button
                      type="button"
                      onClick={handleOptimizeSelectedRouteFromHome}
                      disabled={activeRouteArchived || !activeRouteBelongsToCurrentUser || !routeHydrationComplete || !routeProperties.length || homeRouteOptimizing || homeBaseSaving}
                      className="h-11 w-full rounded-xl bg-gradient-to-r from-[#2EEB57] to-[#B6FF5C] px-3 text-[11px] font-black text-black hover:brightness-110 disabled:opacity-45">
                                            {homeRouteOptimizing ?
                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Optimizing...</> :
                        <><Sparkles className="mr-2 h-4 w-4" />Optimize selected route from home</>
                      }
                                        </Button>
                                    </div>
                                </form>

                                {(homeBaseError || homeRouteError) &&
                  <p aria-live="polite" className="mt-2.5 rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-[11px] leading-relaxed text-red-200">
                                        {homeBaseError || homeRouteError}
                                </p>
                  }
                                <p className="mt-3 text-[10px] leading-relaxed text-white/40">
                                    Address lookup uses OpenStreetMap. Your exact address stays private; your manager can request only an approximate point for a route assigned to you. Optimization keeps streets and subdivisions together using local route data, and estimated mileage may differ from live navigation.
                                </p>
                  </div>
                  }
                            </section>

                            <div className="space-y-2" aria-label={`${routes.length} routes available`}>
                            <div className="flex items-center justify-between px-1">
                                <p className="text-[10px] font-black uppercase tracking-[0.14em] text-white/45">Routes</p>
                                <p className="text-[10px] text-white/35">Active and past routes</p>
                            </div>
                            {routes.map((route) =>
            <button
              type="button"
              key={route.id}
              aria-current={activeRoute?.id === route.id ? 'true' : undefined}
              onClick={() => {
                setManualRouteId(route.id);
                try {localStorage.setItem('fk_selectedKnockRouteId', route.id);} catch {}
                window.history.replaceState({}, '', `${window.location.pathname}?route=${route.id}`);
                closeRouteSwitcher();
              }}
              className={`w-full p-3 rounded-2xl border text-left transition-all ${activeRoute?.id === route.id ? 'bg-[#2EEB57]/10 border-[#2EEB57]/60 shadow-[0_0_24px_rgba(46,235,87,0.12)]' : 'bg-white/[0.04] border-white/10 hover:border-white/20'}`
              }>
              
                                    <div className="flex items-start justify-between gap-3">
                                        <span className={`min-w-0 truncate font-bold text-sm ${activeRoute?.id === route.id ? 'text-[#39FF4A]' : 'text-white'}`}>
                                            {route.name}
                                        </span>
                                        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[8px] font-black uppercase tracking-[0.1em] ${['COMPLETED', 'ARCHIVED'].includes(String(route.status || '').toUpperCase()) ? 'border-white/10 bg-white/[0.05] text-white/40' : 'border-[#2EEB57]/25 bg-[#2EEB57]/10 text-[#39FF4A]'}`}>
                                            {String(route.status || 'PENDING').replaceAll('_', ' ')}
                                        </span>
                                    </div>
                                    <div className="mt-1.5 flex items-center justify-between gap-3 text-[10px] text-white/40">
                                        <span>{route.assigned_to_name || (routeScope.managerAccount ? 'Unassigned' : 'Assigned to you')}</span>
                                        <span>{route.metrics?.house_count || route.property_hashes?.length || 0} doors</span>
                                    </div>
                                </button>
            )}
                            </div>
                        </div>
                    </div>
                </div>,
      document.body
      )}

            {/* Map View */}
            {showMap &&
      <RepMapView
        properties={mapRouteProperties}
        onSelectProperty={(p) => setSelectedProperty(p)}
        onClose={() => {setShowMap(false);setFocusProperty(null);}}
        focusProperty={focusProperty}
        roadGeometry={activeRoute?.metadata?.road_geometry}
        roadGeometryFingerprint={activeRoute?.metadata?.routing?.property_order_fingerprint}
        startLocation={activeRoute?.route_origin_mode === 'home_round_trip' ? user?.home_base : null}
        endLocation={['home_round_trip', 'current_to_home'].includes(activeRoute?.route_origin_mode) ? user?.home_base : null} />

      }

            {/* Property Detail - Bottom Sheet (overlays map when map is open) */}
            {selectedProperty &&
      <PropertyDetailSheet
        property={selectedProperty}
        logs={selectedPropertyLogs}
        onLog={handleLog}
        outcomeDisabled={outcomeLoggingDisabled}
        onBlockedAttempt={() => {
          if (activeRouteArchived) {
            toast.error('Archived routes are read-only.');
          }
        }}
        onClearDecision={activeRouteArchived ? undefined : handleClearDecision}
        onPhotoUpload={activeRouteArchived ? undefined : handlePhotoUpload}
        uploading={uploading}
        onClose={() => {setSelectedProperty(null);setSelectedPropertyIndex(null);}}
        routePosition={selectedPropertyIndex !== null ? selectedPropertyIndex + 1 : null}
        totalStops={filteredProperties.length}
        navigationApp={navigationApp}
        fieldRoutesCapability={fieldRoutesCapability}
        fieldRoutesStatus={selectedFieldRoutesStatus}
        fieldRoutesPendingDeviceCount={fieldRoutesPendingDeviceCount}
        onDiscardFieldRoutesDeviceAttention={() => discardFieldRoutesDeviceAttention(selectedFieldRoutesSourceKey)}
        onScheduleInspection={activeRouteArchived ? undefined : handleScheduleInspection}
        onViewOnMap={() => {
          const prop = selectedProperty;
          setSelectedProperty(null);
          setSelectedPropertyIndex(null);
          setFocusProperty(prop);
          setShowMap(true);
        }} />

      }

            {/* Team Chat */}
            {showChat &&
      <TeamChat
        user={user}
        teamMember={teamMember}
        onClose={() => setShowChat(false)} />

      }

            {/* Knock Mode freemium gate sheet */}
            <KnockLimitSheet
        open={showLimitSheet}
        mode={gateMode}
        onClose={() => {setShowLimitSheet(false);}} />
      
            </div>

            {/* Analytics — outside the z-10 wrapper so it renders above the app header */}
            {showAnalytics &&
      <RepAnalytics
        logs={allMyLogs}
        routeProperties={routeProperties}
        activeRoute={activeRoute}
        onClose={() => setShowAnalytics(false)} />

      }
        </div>);

}