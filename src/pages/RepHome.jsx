import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Navigation, CheckCircle2, Search, X, TrendingUp, MessageCircle, ChevronDown, CalendarDays, Sparkles } from 'lucide-react';
import localforage from 'localforage';
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getKnockWindowLabel } from '@/components/logic/knockTimeOptimizer';
import { determineEffectiveStatus } from '@/components/logic/territoryLogic';
import RepMapView from '@/components/rep/RepMapView';
import CanvasFieldView from '@/components/rep/CanvasFieldView';
import RepHeader from '@/components/rep/RepHeader';
import PropertyCard from '@/components/rep/PropertyCard';
import PropertyDetailSheet from '@/components/rep/PropertyDetailSheet';
import PullToRefresh from '@/components/mobile/PullToRefresh';
import RepAnalytics from '@/components/rep/RepAnalytics';
import TeamChat from '@/components/rep/TeamChat';
import KnockLimitSheet from '@/components/upgrade/KnockLimitSheet';
import KnockLimitBanner from '@/components/upgrade/KnockLimitBanner';
import { isProUser, isOutcomeBlocked, getOutcomesLogged } from '@/components/upgrade/knockGate';

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
  const loggingInFlightRef = React.useRef(false);
  const [soldDateFilter, setSoldDateFilter] = useState('all');
  const [decisionFilter, setDecisionFilter] = useState('all');

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
  // Server-side scoped lookup by email (no full-table scan); duplicates across managers still handled.
  const { data: teamMemberData } = useQuery({
    queryKey: ['myTeamMember', user?.email],
    queryFn: async () => {
      if (!user?.email) return null;
      try {
        const emailLower = user.email.trim().toLowerCase();
        const res = await base44.entities.TeamMember.filter({ email: emailLower }, '-created_date', 50);
        const allMatches = Array.isArray(res) ? res : res?.items || [];

        // The "primary" record is the one whose manager_id matches user.team_manager_id (from invite code),
        // or the most recently created one
        const primary = allMatches.find((m) => user.team_manager_id && m.manager_id === user.team_manager_id) ||
        allMatches[0] ||
        null;

        const allIds = [...new Set(allMatches.map((m) => m.id))];

        console.log(`[RepHome] TeamMember lookup: primary=${primary?.id}, allIds=${allIds.join(',')}, matches=${allMatches.length}`);

        return { primary, allIds, allMatches };
      } catch (e) {
        console.error("Error fetching team member profile", e);
        return null;
      }
    },
    enabled: !!user?.email
  });

  const teamMember = teamMemberData?.primary || null;
  const allTeamMemberIds = teamMemberData?.allIds || [];

  // 1. Fetch Assigned Routes - search across ALL possible team member IDs for this rep
  const { data: routes = [], isLoading: routesLoading } = useQuery({
    queryKey: ['myRoutes', user?.id, allTeamMemberIds.join(',')],
    refetchOnWindowFocus: true,
    queryFn: async () => {
      if (!user) return [];
      try {
        // Server-side scoped queries: assigned-to-me + (managers) owned-by-me.
        // Name-based fallback removed — backfillRouteAssignments resolves legacy name-only assignments to IDs.
        const myIds = [...new Set([user.id, ...(allTeamMemberIds || [])])];
        const isManager = user.app_role === 'manager';

        const toArr = (r) => Array.isArray(r) ? r : r?.items || [];
        const [assignedRes, ownedRes, createdRes] = await Promise.all([
        myIds.length > 0 ? base44.entities.SavedRoute.filter({ assigned_to: myIds }, '-created_date', 200) : [],
        isManager ? base44.entities.SavedRoute.filter({ manager_id: user.id }, '-created_date', 200) : [],
        isManager ? base44.entities.SavedRoute.filter({ created_by: user.email }, '-created_date', 200) : []]
        );

        const seen = new Set();
        const myRoutes = [...toArr(assignedRes), ...toArr(ownedRes), ...toArr(createdRes)].filter((r) => {
          if (seen.has(r.id)) return false;
          seen.add(r.id);
          return true;
        });

        const selectedRouteId = (() => {
          try {return localStorage.getItem('fk_selectedKnockRouteId');} catch {return null;}
        })();

        // Filter to only non-completed, non-archived routes
        const activeRoutes = myRoutes.filter((r) =>
        r.status !== 'COMPLETED' && r.status !== 'ARCHIVED'
        );

        console.log(`[RepHome] Found ${activeRoutes.length} active routes (${myRoutes.length} matched) for IDs: [${myIds.join(', ')}], selected=${selectedRouteId || 'none'}`);

        // Cache routes for offline
        if (activeRoutes.length > 0) {
          localforage.setItem('cached_routes', activeRoutes);
        }
        return activeRoutes.length > 0 ? activeRoutes : myRoutes;
      } catch (e) {
        console.error("Error fetching routes", e);
        const cached = await localforage.getItem('cached_routes');
        return cached || [];
      }
    },
    enabled: !!user
  });

  // --- Derived State ---

  // Get the Active Route (Highest priority or most recent active)
  const [manualRouteId, setManualRouteId] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('route') || (() => {try {return localStorage.getItem('fk_selectedKnockRouteId');} catch {return null;}})();
  });
  const [showRouteList, setShowRouteList] = useState(false);

  const activeRoute = useMemo(() => {
    if (!routes.length) return null;
    if (manualRouteId) {
      const manual = routes.find((r) => r.id === manualRouteId);
      if (manual) return manual;
    }
    // Prioritize 'IN_PROGRESS' then 'ACTIVE'
    return routes.find((r) => r.status === 'IN_PROGRESS') || routes.find((r) => r.status === 'ACTIVE') || routes[0];
  }, [routes, manualRouteId]);

  const localCanvasAssignment = useMemo(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('fk_canvasCampaignSprint1') || 'null');
      if (!saved?.locked || !Array.isArray(saved.zones)) return null;
      const myName = (user?.full_name || '').toLowerCase();
      const assignedZone = saved.zones.find((zone) => (zone.assignments || []).some((name) => name?.toLowerCase() === myName)) || saved.zones.find((zone) => (zone.assignments || []).length > 0) || saved.zones[0];
      return assignedZone ? { campaign: saved, zone: assignedZone } : null;
    } catch {
      return null;
    }
  }, [user?.full_name]);

  React.useEffect(() => {
    if (!activeRoute?.id) return;
    try {localStorage.setItem('fk_selectedKnockRouteId', activeRoute.id);} catch {}
  }, [activeRoute?.id]);

  const teamMemberIdsKey = allTeamMemberIds.join(',');
  React.useEffect(() => {
    if (!user) return;
    const myIds = new Set([user.id, ...allTeamMemberIds]);
    const unsubscribe = base44.entities.SavedRoute.subscribe((event) => {
      if (!event?.id) return;
      const isSelectedRoute = event.id === activeRoute?.id || event.id === manualRouteId;
      // Tenant guard: only react to create events that belong to this user/team.
      // Unscoped 'create' invalidation caused thundering-herd refetches at scale.
      const d = event.data;
      const isMine = !!d && (
        d.created_by === user.email ||
        d.manager_id === user.id ||
        (user.team_manager_id && d.manager_id === user.team_manager_id) ||
        myIds.has(d.assigned_to)
      );
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

        const response = await base44.functions.invoke('getRoutePropertiesByHashes', {
          address_hashes: hashes,
          user_email: activeRoute.created_by,
          limit: hashes.length
        });

        const loaded = Array.isArray(response.data?.properties) ? response.data.properties : [];
        console.log(`[RepHome] Found ${loaded.length}/${hashes.length} properties`);

        if (loaded.length > 0) {
          localforage.setItem(`cached_props_${activeRoute.id}`, loaded);
        }
        return loaded;
      } catch (e) {
        console.error("Error fetching properties", e);
        const cached = await localforage.getItem(`cached_props_${activeRoute.id}`);
        return cached || [];
      }
    },
    enabled: !!activeRoute
  });

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
        return merged.filter((log) => {
          const key = log.id || `${log.address_hash}-${log.created_date}-${log.parsed_status}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      if (user?.email) {
        return await base44.entities.InteractionLog.filter({ created_by: user.email }, '-created_date', 500);
      }
      return [];
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

  // Knock Mode freemium gate: disabled once the limit sheet has been dismissed
  // this session, OR if the user is already at/over the limit on load.
  const outcomeLoggingDisabled = !isProUser(user) && (limitDismissed || isOutcomeBlocked(user));
  const showLimitBanner = limitDismissed && !isProUser(user);

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
      return Array.isArray(res) ? res : res?.items || [];
    },
    enabled: !!selectedProperty?.address_hash
  });

  // Tenant key stamped on every log so RLS can scope team reads
  const repManagerId = teamMember?.manager_id || user?.team_manager_id || (user?.app_role === 'manager' ? user?.id : null);

  // Log Result Mutation
  const createLogMutation = useMutation({
    mutationFn: (logData) => base44.entities.InteractionLog.create({
      ...logData,
      route_id: activeRoute?.id || null,
      manager_id: repManagerId
    }),
    onMutate: async (newLog) => {
      await queryClient.cancelQueries({ queryKey: ['routeLogs', activeRoute?.id] });
      const previousLogs = queryClient.getQueryData(['routeLogs', activeRoute?.id]);
      queryClient.setQueryData(['routeLogs', activeRoute?.id], (old) => {
        return [...(old || []), { ...newLog, created_date: new Date().toISOString() }];
      });
      setSelectedProperty(null);
      return { previousLogs };
    },
    onError: (err, newLog, context) => {
      queryClient.setQueryData(['routeLogs', activeRoute?.id], context?.previousLogs);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['myLogs'] });
      queryClient.invalidateQueries({ queryKey: ['routeLogs'] });
      queryClient.invalidateQueries({ queryKey: ['allMyLogs'] });
      queryClient.invalidateQueries({ queryKey: ['propertyHistory'] });
    },
    onSuccess: async () => {
      // Free users: increment the persisted lifetime counter. The counter only
      // ever increases and is never checked/incremented for Pro users.
      if (!isProUser(user)) {
        try {
          await base44.auth.updateMe({ outcomes_logged: getOutcomesLogged(user) + 1 });
          queryClient.invalidateQueries({ queryKey: ['user'] });
        } catch (e) {
          console.error('Failed to increment outcomes_logged', e);
        }
      }
    }
  });

  const clearDecisionMutation = useMutation({
    mutationFn: (log) => base44.entities.InteractionLog.create({
      address_hash: log.address_hash,
      raw_input_text: 'Decision cleared — moved back to Todo',
      parsed_status: 'ELIGIBLE',
      route_id: activeRoute?.id || null,
      manager_id: repManagerId,
      gps_proof_lat: selectedProperty?.lat,
      gps_proof_lng: selectedProperty?.lng,
      gps_accuracy: 0
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['routeLogs'] });
      queryClient.invalidateQueries({ queryKey: ['allMyLogs'] });
      queryClient.invalidateQueries({ queryKey: ['propertyHistory'] });
      toast.success('Moved back to Todo');
    }
  });

  // Complete Route Mutation
  const completeRouteMutation = useMutation({
    mutationFn: () => base44.entities.SavedRoute.update(activeRoute.id, {
      status: 'COMPLETED'
      // optional: completed_date: new Date().toISOString()
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['myRoutes'] });
      // Show celebration or something?
      // The route will disappear from "Active" list, so activeRoute might become null or switch to next
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
      const status = determineEffectiveStatus(p, pLogs);
      return { ...p, effective_status: status };
    });

    // SavedRoute.property_hashes is the source of truth. Checklist/Optimize writes this order,
    // so Knock must preserve it exactly instead of applying another local reorder.
    return orderedProps;
  }, [activeRoute, properties, logs]);

  // Stats
  const stats = useMemo(() => {
    if (!routeProperties.length) return { total: 0, done: 0, percent: 0 };
    const done = routeProperties.filter((p) => p.effective_status !== 'ELIGIBLE').length;
    return {
      total: routeProperties.length,
      done,
      percent: Math.round(done / routeProperties.length * 100)
    };
  }, [routeProperties]);

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

      if (filterStatus === 'todo') return !isDone;
      if (filterStatus === 'done') {
        if (!isDone) return false;
        return decisionFilter === 'all' || p.effective_status === decisionFilter;
      }
      return true;
    });
  }, [routeProperties, filterStatus, searchQuery, soldDateFilter, decisionFilter]);

  const knockWindow = getKnockWindowLabel(new Date());

  if (routesLoading || propsLoading || logsLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-black text-white">
                <div className="text-center">
                    <Loader2 className="w-10 h-10 animate-spin text-[#2EEB57] mx-auto mb-4" />
                    <p className="font-medium animate-pulse text-white/70">Loading Route Data...</p>
                </div>
            </div>);

  }

  if (!activeRoute && localCanvasAssignment) {
    return <CanvasFieldView campaign={localCanvasAssignment.campaign} zone={localCanvasAssignment.zone} user={user} onClose={() => localStorage.removeItem('fk_canvasCampaignSprint1')} />;
  }

  if (!activeRoute) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-black text-white p-6 text-center">
                <div className="w-20 h-20 bg-white/[0.04] border border-white/10 rounded-3xl flex items-center justify-center mb-6 shadow-[0_0_40px_rgba(46,235,87,0.12)]">
                    <Navigation className="w-10 h-10 text-[#2EEB57]" />
                </div>
                <h1 className="text-2xl font-bold mb-2">No Active Routes</h1>
                <p className="text-gray-400 mb-8 max-w-xs">
                    You don't have any routes assigned yet. Ask your manager to assign one, or check back later.
                </p>
                <Button onClick={() => window.location.reload()} variant="outline" className="border-gray-700 text-white">
                    Check Again
                </Button>
            </div>);

  }

  // --- RENDER HELPERS ---

  const handleClearDecision = (log) => {
    if (!log?.address_hash) return;
    if (confirm('Clear this decision and move the home back to Todo?')) {
      clearDecisionMutation.mutate(log);
    }
  };

  // Re-fetch the user fresh on each tap so a mid-session upgrade (in another tab)
  // lifts the gate without a full reload. Returns true if the gate fired.
  const checkAndHandleGate = async () => {
    let freshUser = user;
    try {
      freshUser = await base44.auth.me();
      if (freshUser) queryClient.setQueryData(['user'], freshUser);
    } catch { /* keep cached user */ }

    if (isProUser(freshUser)) return false;
    if (limitDismissed || isOutcomeBlocked(freshUser)) {
      setShowLimitSheet(true);
      return true;
    }
    return false;
  };

  const handleLog = async (logData) => {
    if (!selectedProperty && !logData.address_hash) return;
    const prop = selectedProperty || {};

    // Atomic guard: block re-entrancy from rapid double-taps at the boundary.
    if (loggingInFlightRef.current) return;
    loggingInFlightRef.current = true;
    try {
      const blocked = await checkAndHandleGate();
      if (blocked) return; // No outcome saved, no stop marked, no state change.
    } finally {
      loggingInFlightRef.current = false;
    }

    // Haptic feedback
    if (navigator.vibrate) navigator.vibrate(50);

    // Get Real GPS
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          createLogMutation.mutate({
            ...logData,
            gps_proof_lat: position.coords.latitude,
            gps_proof_lng: position.coords.longitude,
            gps_accuracy: position.coords.accuracy
          });
        },
        () => {
          createLogMutation.mutate({
            ...logData,
            gps_proof_lat: prop.lat,
            gps_proof_lng: prop.lng,
            gps_accuracy: 0
          });
        },
        { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
      );
    } else {
      createLogMutation.mutate({
        ...logData,
        gps_proof_lat: prop.lat,
        gps_proof_lng: prop.lng,
        gps_accuracy: 0
      });
    }
  };

  const handlePhotoUpload = async (e) => {
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
        onShowRouteList={() => setShowRouteList(true)}
        routeProperties={routeProperties} />

            {showLimitBanner && <KnockLimitBanner />}

            {/* Filter tabs + search */}
            <div className="px-3 pt-2 pb-2 space-y-2 border-b border-white/10 bg-black/70 backdrop-blur-xl shadow-[0_12px_36px_rgba(0,0,0,0.32)]">
                {/* Top Row: Segmented Control */}
                <div className="flex bg-white/[0.04] p-0.5 rounded-xl border border-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
                    {[
          { id: 'todo', label: `Todo ${routeProperties.length - stats.done}` },
          { id: 'done', label: `Done ${stats.done}` },
          { id: 'all', label: 'All' }].
          map((tab) =>
          <button
            key={tab.id}
            onClick={() => setFilterStatus(tab.id)}
            className={`flex-1 py-1.5 rounded-lg text-[10px] font-black tracking-[0.1em] transition-all whitespace-nowrap ${filterStatus === tab.id ? 'bg-white text-black shadow-[0_6px_18px_rgba(255,255,255,0.12)]' : 'text-white/45 hover:text-white'}`
            }>
            
                            {tab.label}
                        </button>
          )}
                </div>

                {/* Bottom Row: Date Filter & Search */}
                <div className="flex items-center gap-2">
                    {/* Sold Date Filter */}
                    <div className="relative flex-1 min-w-0">
                        <select
              value={soldDateFilter}
              onChange={(e) => setSoldDateFilter(e.target.value)}
              className="appearance-none w-full h-8 pl-2.5 pr-7 text-[10px] font-bold bg-white/[0.04] border border-white/10 text-white rounded-lg outline-none focus:border-[#2EEB57]/60 cursor-pointer [color-scheme:dark] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              
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
              className="appearance-none w-full h-8 pl-2.5 pr-6 text-[10px] font-bold bg-white/[0.04] border border-white/10 text-white rounded-lg outline-none focus:border-[#2EEB57]/60 cursor-pointer [color-scheme:dark] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              
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
              className="h-8 w-full pl-7 pr-7 text-[10px] bg-white/[0.04] border border-white/10 text-white placeholder:text-white/35 focus:border-[#2EEB57]/60 rounded-lg shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]" />
            
                            {searchQuery &&
            <button onClick={() => setSearchQuery('')} className="absolute right-2.5 top-1/2 -translate-y-1/2">
                                    <X className="w-3.5 h-3.5 text-[#8888A0]" />
                                </button>
            }
                        </div>
          }
                </div>
            </div>

            {/* Property List */}
            <PullToRefresh onRefresh={handleRouteRefresh} className="flex-1 overflow-y-auto px-2.5 py-2 pb-20 bg-transparent">
                {filteredProperties.length === 0 ?
        <div className="text-center py-16">
                        <div className="w-14 h-14 bg-gray-800 rounded-full flex items-center justify-center mx-auto mb-3">
                            {filterStatus === 'done' ? <CheckCircle2 className="w-7 h-7 text-green-500" /> : <Navigation className="w-7 h-7 text-gray-600" />}
                        </div>
                        <p className="text-gray-500 text-sm font-medium">
                            {searchQuery ? 'No matches' : filterStatus === 'done' ? 'None completed yet' : 'All done! 🎉'}
                        </p>
                    </div> :

        <div className="space-y-1.5">
                        {filteredProperties.map((prop, idx) =>
          <PropertyCard
            key={prop.address_hash}
            property={prop}
            index={idx}
            navigationApp={navigationApp}
            onSelect={(p, i) => {setSelectedProperty(p);setSelectedPropertyIndex(i);}} />

          )}
                    </div>
        }
            </PullToRefresh>

            {/* Floating action buttons */}
            <div className="fixed bottom-20 left-4 right-4 z-30 flex items-center gap-2 rounded-[28px] border border-white/10 bg-black/55 p-2 shadow-[0_22px_70px_rgba(0,0,0,0.65)] backdrop-blur-2xl">
                {stats.percent >= 100 &&
        <Button
          onClick={() => {
            if (confirm("Mark route as complete?")) completeRouteMutation.mutate();
          }}
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
            {showRouteList &&
      <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-sm" onClick={() => setShowRouteList(false)}>
                    <div className="bg-[#050505]/95 backdrop-blur-2xl rounded-t-3xl border-t border-white/10 max-h-[60vh] flex flex-col shadow-[0_-20px_70px_rgba(0,0,0,0.7)]" onClick={(e) => e.stopPropagation()}>
                        <div className="p-4 border-b border-white/10 flex justify-between items-center">
                            <h3 className="font-bold text-white">Switch Route</h3>
                            <button onClick={() => setShowRouteList(false)}><X className="w-5 h-5 text-gray-500" /></button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 space-y-2">
                            {routes.map((route) =>
            <button
              key={route.id}
              onClick={() => {
                setManualRouteId(route.id);
                try {localStorage.setItem('fk_selectedKnockRouteId', route.id);} catch {}
                window.history.replaceState({}, '', `${window.location.pathname}?route=${route.id}`);
                setShowRouteList(false);
              }}
              className={`w-full p-3 rounded-2xl border text-left transition-all ${activeRoute?.id === route.id ? 'bg-[#2EEB57]/10 border-[#2EEB57]/60 shadow-[0_0_24px_rgba(46,235,87,0.12)]' : 'bg-white/[0.04] border-white/10 hover:border-white/20'}`
              }>
              
                                    <div className="flex justify-between items-center">
                                        <span className={`font-bold text-sm ${activeRoute?.id === route.id ? 'text-[#39FF4A]' : 'text-white'}`}>
                                            {route.name}
                                        </span>
                                        <span className="text-xs text-gray-500">{route.metrics?.house_count || 0} doors</span>
                                    </div>
                                </button>
            )}
                        </div>
                    </div>
                </div>
      }

            {/* Map View */}
            {showMap &&
      <RepMapView
        properties={routeProperties}
        onSelectProperty={(p) => setSelectedProperty(p)}
        onClose={() => {setShowMap(false);setFocusProperty(null);}}
        focusProperty={focusProperty} />

      }

            {/* Property Detail - Bottom Sheet (overlays map when map is open) */}
            {selectedProperty &&
      <PropertyDetailSheet
        property={selectedProperty}
        logs={selectedPropertyLogs}
        onLog={handleLog}
        outcomeDisabled={outcomeLoggingDisabled}
        onBlockedAttempt={() => setShowLimitSheet(true)}
        onClearDecision={handleClearDecision}
        onPhotoUpload={handlePhotoUpload}
        uploading={uploading}
        onClose={() => {setSelectedProperty(null);setSelectedPropertyIndex(null);}}
        routePosition={selectedPropertyIndex !== null ? selectedPropertyIndex + 1 : null}
        totalStops={filteredProperties.length}
        navigationApp={navigationApp}
        onViewOnMap={() => {
          const prop = selectedProperty;
          setSelectedProperty(null);
          setSelectedPropertyIndex(null);
          setFocusProperty(prop);
          setShowMap(true);
        }} />

      }

            {/* Analytics */}
            {showAnalytics &&
      <RepAnalytics
        logs={allMyLogs}
        routeProperties={routeProperties}
        activeRoute={activeRoute}
        onClose={() => setShowAnalytics(false)} />

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
        onClose={() => {setShowLimitSheet(false);setLimitDismissed(true);}} />
      
            </div>
        </div>);

}