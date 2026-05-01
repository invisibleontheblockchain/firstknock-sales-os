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
import RepHeader from '@/components/rep/RepHeader';
import PropertyCard from '@/components/rep/PropertyCard';
import PropertyDetailSheet from '@/components/rep/PropertyDetailSheet';
import RepAnalytics from '@/components/rep/RepAnalytics';
import TeamChat from '@/components/rep/TeamChat';
import UpgradeGate, { shouldShowUpgradeGate } from '@/components/upgrade/UpgradeGate';

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
    const [showUpgradeGate, setShowUpgradeGate] = useState(false);
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
        try { return localStorage.getItem('fk_navigation_app') || 'apple'; } catch { return 'apple'; }
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
    // Also find ALL matching records (by email or name) to handle duplicates from different invite codes
    const { data: teamMemberData } = useQuery({
        queryKey: ['myTeamMember', user?.email],
        queryFn: async () => {
            if (!user?.email) return null;
            try {
                const res = await base44.entities.TeamMember.list('-created_date', 500);
                const members = Array.isArray(res) ? res : (res?.items || []);
                const emailLower = user.email.trim().toLowerCase();
                const nameLower = (user.full_name || '').trim().toLowerCase();

                // Primary: exact email match (could be multiple from different managers)
                const emailMatches = members.filter(m => m.email?.trim().toLowerCase() === emailLower);

                // Secondary: also find records where the name matches but email differs
                // (e.g. manager manually created "Charles Henson" with work email, but rep logs in with personal email)
                const nameMatches = nameLower ? members.filter(m => {
                    if (emailMatches.some(em => em.id === m.id)) return false; // skip already matched
                    const mName = (m.name || '').trim().toLowerCase();
                    // Match if names are similar (contains or equal)
                    return mName && (mName === nameLower || nameLower.includes(mName) || mName.includes(nameLower));
                }) : [];

                const allMatches = [...emailMatches, ...nameMatches];

                // The "primary" record is the one whose manager_id matches user.team_manager_id (from invite code),
                // or the most recently created one
                const primary = allMatches.find(m => user.team_manager_id && m.manager_id === user.team_manager_id)
                    || emailMatches[0]
                    || allMatches[0]
                    || null;

                // Collect all unique IDs this rep could be known as
                const allIds = [...new Set(allMatches.map(m => m.id))];

                console.log(`[RepHome] TeamMember lookup: primary=${primary?.id}, allIds=${allIds.join(',')}, emailMatches=${emailMatches.length}, nameMatches=${nameMatches.length}`);

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
        queryFn: async () => {
            if (!user) return [];
            try {
                // Fetch ALL routes (we need to match against multiple possible IDs)
                const res = await base44.entities.SavedRoute.list('-created_date', 500);
                const allRoutes = Array.isArray(res) ? res : (res?.items || []);

                // Build a set of all IDs this rep could be assigned under
                const myIds = new Set([
                    user.id,                            // Auth user ID (manager may have assigned to this)
                    ...(allTeamMemberIds || []),         // All TeamMember record IDs (from different invite codes)
                ]);

                // Also match by assigned_to_name as a fallback (case-insensitive)
                const myName = (user.full_name || '').trim().toLowerCase();
                const myEmail = (user.email || '').trim().toLowerCase();
                const isManager = user.app_role === 'manager';

                const selectedRouteId = (() => {
                    try { return localStorage.getItem('fk_selectedKnockRouteId'); } catch { return null; }
                })();

                const myRoutes = allRoutes.filter(r => {
                    // Route Command handoff: always show the route the manager just selected for Knock.
                    if (selectedRouteId && r.id === selectedRouteId) return true;

                    // Match by any known assignee ID
                    if (r.assigned_to && myIds.has(r.assigned_to)) return true;

                    // Manager in Rep Mode: also show routes they own or created, including older routes without manager_id.
                    if (isManager && (r.manager_id === user.id || r.created_by === user.email)) return true;

                    // Fallback: match by assigned_to_name (handles cases where assignment was by old/different ID)
                    if (r.assigned_to_name && myName) {
                        const routeName = r.assigned_to_name.trim().toLowerCase();
                        if (routeName === myName) return true;
                        // Also check partial name match for "Charles Henson" vs "Charlie Henson" etc.
                        const routeNameParts = routeName.split(' ');
                        const myNameParts = myName.split(' ');
                        if (routeNameParts.length > 1 && myNameParts.length > 1) {
                            // Match last name + first 3 chars of first name
                            const lastMatch = routeNameParts[routeNameParts.length - 1] === myNameParts[myNameParts.length - 1];
                            const firstPartial = routeNameParts[0].slice(0, 3) === myNameParts[0].slice(0, 3) ||
                                myNameParts[0].startsWith(routeNameParts[0]) ||
                                routeNameParts[0].startsWith(myNameParts[0]);
                            if (lastMatch && firstPartial) return true;
                        }
                    }

                    return false;
                });

                // Filter to only non-completed, non-archived routes
                const activeRoutes = myRoutes.filter(r =>
                    r.status !== 'COMPLETED' && r.status !== 'ARCHIVED'
                );

                console.log(`[RepHome] Found ${activeRoutes.length} active routes (${myRoutes.length} matched, ${allRoutes.length} visible) for IDs: [${[...myIds].join(', ')}], selected=${selectedRouteId || 'none'}, name: "${myName}"`);

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
        return params.get('route') || (() => { try { return localStorage.getItem('fk_selectedKnockRouteId'); } catch { return null; } })();
    });
    const [showRouteList, setShowRouteList] = useState(false);

    const activeRoute = useMemo(() => {
        if (!routes.length) return null;
        if (manualRouteId) {
            const manual = routes.find(r => r.id === manualRouteId);
            if (manual) return manual;
        }
        // Prioritize 'IN_PROGRESS' then 'ACTIVE'
        return routes.find(r => r.status === 'IN_PROGRESS') || routes.find(r => r.status === 'ACTIVE') || routes[0];
    }, [routes, manualRouteId]);

    React.useEffect(() => {
        if (!activeRoute?.id) return;
        try { localStorage.setItem('fk_selectedKnockRouteId', activeRoute.id); } catch {}
    }, [activeRoute?.id]);

    React.useEffect(() => {
        if (!user) return;
        const unsubscribe = base44.entities.SavedRoute.subscribe((event) => {
            if (!event?.id) return;
            const isSelectedRoute = event.id === activeRoute?.id || event.id === manualRouteId;
            if (isSelectedRoute || event.type === 'create') {
                queryClient.invalidateQueries({ queryKey: ['myRoutes'] });
                queryClient.invalidateQueries({ queryKey: ['routeProperties'] });
            }
        });
        return unsubscribe;
    }, [user, activeRoute?.id, manualRouteId, queryClient]);

    const activeRouteOrderKey = React.useMemo(
        () => (activeRoute?.property_hashes || []).join('|'),
        [activeRoute?.property_hashes]
    );

    // 2. Fetch Route Properties - batch filter by address_hash
    const { data: properties = [], isLoading: propsLoading } = useQuery({
        queryKey: ['routeProperties', activeRoute?.id, activeRoute?.updated_date, activeRouteOrderKey],
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
                return await base44.entities.InteractionLog.filter({
                    address_hash: activeRoute.property_hashes
                }, '-created_date', 1000);
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
            return Array.isArray(res) ? res : (res?.items || []);
        },
        enabled: !!user?.email
    });

    // Show upgrade gate on load if user is over free limit
    React.useEffect(() => {
        if (allMyLogs.length > 0 && user && shouldShowUpgradeGate(user, allMyLogs.length)) {
            setShowUpgradeGate(true);
        }
    }, [allMyLogs.length, user]);

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
            return Array.isArray(res) ? res : (res?.items || []);
        },
        enabled: !!selectedProperty?.address_hash
    });

    // Log Result Mutation
    const createLogMutation = useMutation({
        mutationFn: (logData) => base44.entities.InteractionLog.create({
            ...logData,
            route_id: activeRoute?.id || null,
        }),
        onMutate: async (newLog) => {
            await queryClient.cancelQueries({ queryKey: ['routeLogs', activeRoute?.id] });
            const previousLogs = queryClient.getQueryData(['routeLogs', activeRoute?.id]);
            queryClient.setQueryData(['routeLogs', activeRoute?.id], old => {
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
        },
        onSuccess: () => {
            // Check if user just hit the 50-house limit
            const newCount = (allMyLogs?.length || 0) + 1;
            if (shouldShowUpgradeGate(user, newCount)) {
                setShowUpgradeGate(true);
            }
        }
    });

    const clearDecisionMutation = useMutation({
        mutationFn: (log) => base44.entities.InteractionLog.create({
            address_hash: log.address_hash,
            raw_input_text: 'Decision cleared — moved back to Todo',
            parsed_status: 'ELIGIBLE',
            route_id: activeRoute?.id || null,
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
            status: 'COMPLETED',
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
        properties.forEach(p => {
            if (p.address_hash) byHash.set(p.address_hash, p);
            if (p.legacy_hash) byHash.set(p.legacy_hash, p);
        });

        const orderedProps = (activeRoute.property_hashes || [])
            .map(hash => byHash.get(hash))
            .filter(Boolean)
            .map(p => {
                const pLogs = logs.filter(l => l.address_hash === p.address_hash || (p.legacy_hash && l.address_hash === p.legacy_hash));
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
        const done = routeProperties.filter(p => p.effective_status !== 'ELIGIBLE').length;
        return {
            total: routeProperties.length,
            done,
            percent: Math.round((done / routeProperties.length) * 100)
        };
    }, [routeProperties]);

    const filteredProperties = useMemo(() => {
        return routeProperties.filter(p => {
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
                        case '1w': cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); break;
                        case '2w': cutoff = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000); break;
                        case '1m': cutoff = new Date(now.setMonth(now.getMonth() - 1)); break;
                        case '3m': cutoff = new Date(new Date().setMonth(new Date().getMonth() - 3)); break;
                        case '6m': cutoff = new Date(new Date().setMonth(new Date().getMonth() - 6)); break;
                        case '9m': cutoff = new Date(new Date().setMonth(new Date().getMonth() - 9)); break;
                        case '1y': cutoff = new Date(new Date().setFullYear(new Date().getFullYear() - 1)); break;
                        default: cutoff = null;
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
                    <Loader2 className="w-10 h-10 animate-spin text-yellow-500 mx-auto mb-4" />
                    <p className="font-medium animate-pulse">Loading Route Data...</p>
                </div>
            </div>
        );
    }

    if (!activeRoute) {
        return (
            <div className="flex h-screen flex-col items-center justify-center bg-black text-white p-6 text-center">
                <div className="w-20 h-20 bg-gray-800 rounded-full flex items-center justify-center mb-6">
                    <Navigation className="w-10 h-10 text-gray-500" />
                </div>
                <h1 className="text-2xl font-bold mb-2">No Active Routes</h1>
                <p className="text-gray-400 mb-8 max-w-xs">
                    You don't have any routes assigned yet. Ask your manager to assign one, or check back later.
                </p>
                <Button onClick={() => window.location.reload()} variant="outline" className="border-gray-700 text-white">
                    Check Again
                </Button>
            </div>
        );
    }

    // --- RENDER HELPERS ---

    const handleClearDecision = (log) => {
        if (!log?.address_hash) return;
        if (confirm('Clear this decision and move the home back to Todo?')) {
            clearDecisionMutation.mutate(log);
        }
    };

    const handleLog = (logData) => {
        if (!selectedProperty && !logData.address_hash) return;
        const prop = selectedProperty || {};

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
                        gps_accuracy: position.coords.accuracy,
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

    return (
        <div className="h-full flex flex-col bg-[#0A0A0F] text-[#F0F0F5]">
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
                routeProperties={routeProperties}
            />

            {/* Filter tabs + search */}
            <div className="px-4 pt-2 pb-3 space-y-2.5 bg-[#12121A] border-b border-white/5">
                {/* Top Row: Segmented Control */}
                <div className="flex bg-black/40 p-0.5 rounded-xl border border-white/5">
                    {[
                        { id: 'todo', label: `Todo ${routeProperties.length - stats.done}` },
                        { id: 'done', label: `Done ${stats.done}` },
                        { id: 'all', label: 'All' },
                    ].map(tab => (
                        <button
                            key={tab.id}
                            onClick={() => setFilterStatus(tab.id)}
                            className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold tracking-wide transition-all whitespace-nowrap ${filterStatus === tab.id ? 'bg-white text-black shadow-md' : 'text-[#8888A0] hover:text-white'
                                }`}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>

                {/* Bottom Row: Date Filter & Search */}
                <div className="flex items-center gap-2">
                    {/* Sold Date Filter */}
                    <div className="relative flex-1 min-w-0">
                        <select
                            value={soldDateFilter}
                            onChange={(e) => setSoldDateFilter(e.target.value)}
                            className="appearance-none w-full h-8 pl-3 pr-8 text-[11px] font-bold bg-black/40 border border-white/5 text-white rounded-xl outline-none focus:border-white/15 cursor-pointer [color-scheme:dark]"
                        >
                            <option value="all">Sale: All Time</option>
                            <option value="1w">Sale: 1 Week</option>
                            <option value="2w">Sale: 2 Weeks</option>
                            <option value="1m">Sale: 1 Month</option>
                            <option value="3m">Sale: 3 Months</option>
                            <option value="6m">Sale: 6 Months</option>
                            <option value="9m">Sale: 9 Months</option>
                            <option value="1y">Sale: 1 Year</option>
                        </select>
                        <CalendarDays className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#8888A0] pointer-events-none" />
                    </div>

                    {filterStatus === 'done' && (
                        <div className="relative flex-1 min-w-0">
                            <select
                                value={decisionFilter}
                                onChange={(e) => setDecisionFilter(e.target.value)}
                                className="appearance-none w-full h-8 pl-3 pr-6 text-[11px] font-bold bg-black/40 border border-white/5 text-white rounded-xl outline-none focus:border-white/15 cursor-pointer [color-scheme:dark]"
                            >
                                <option value="all">Decision: All</option>
                                <option value="SOLD">Sold</option>
                                <option value="NO_ANSWER">No Answer</option>
                                <option value="CALLBACK">Callback</option>
                                <option value="HARD_NO">Not Interested</option>
                                <option value="NOT_MOVED_IN">Not Moved In</option>
                                <option value="DM_NOT_HOME">DM Not Home</option>
                            </select>
                        </div>
                    )}

                    {/* Inline search */}
                    {routeProperties.length > 8 && (
                        <div className="relative flex-1">
                            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#8888A0]" />
                            <Input
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder="Search address..."
                                className="h-8 w-full pl-8 pr-8 text-[11px] bg-black/40 border border-white/5 text-white placeholder:text-[#8888A0] focus:border-[#6C5CE7]/50 rounded-xl"
                            />
                            {searchQuery && (
                                <button onClick={() => setSearchQuery('')} className="absolute right-2.5 top-1/2 -translate-y-1/2">
                                    <X className="w-3.5 h-3.5 text-[#8888A0]" />
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* Property List */}
            <div className="flex-1 overflow-y-auto px-3 py-2 pb-20">
                {filteredProperties.length === 0 ? (
                    <div className="text-center py-16">
                        <div className="w-14 h-14 bg-gray-800 rounded-full flex items-center justify-center mx-auto mb-3">
                            {filterStatus === 'done' ? <CheckCircle2 className="w-7 h-7 text-green-500" /> : <Navigation className="w-7 h-7 text-gray-600" />}
                        </div>
                        <p className="text-gray-500 text-sm font-medium">
                            {searchQuery ? 'No matches' : filterStatus === 'done' ? 'None completed yet' : 'All done! 🎉'}
                        </p>
                    </div>
                ) : (
                    <div className="space-y-1.5">
                        {filteredProperties.map((prop, idx) => (
                            <PropertyCard
                                key={prop.address_hash}
                                property={prop}
                                index={idx}
                                navigationApp={navigationApp}
                                onSelect={(p, i) => { setSelectedProperty(p); setSelectedPropertyIndex(i); }}
                            />
                        ))}
                    </div>
                )}
            </div>

            {/* Floating action buttons */}
            <div className="fixed bottom-20 left-4 right-4 z-30 flex items-center gap-2">
                {stats.percent >= 100 && (
                    <Button
                        onClick={() => {
                            if (confirm("Mark route as complete?")) completeRouteMutation.mutate();
                        }}
                        className="flex-1 h-10 bg-green-600 hover:bg-green-700 text-white font-bold rounded-xl shadow-2xl text-xs"
                    >
                        ✅ Complete Route
                    </Button>
                )}
                <button
                    onClick={() => setShowAnalytics(true)}
                    className="w-10 h-10 rounded-xl bg-[#111] border border-white/5 flex items-center justify-center active:bg-white/10 shadow-lg"
                >
                    <TrendingUp className="w-4 h-4 text-yellow-500" />
                </button>
                <button
                    onClick={() => setShowChat(true)}
                    className="w-10 h-10 rounded-xl bg-[#111] border border-white/5 flex items-center justify-center active:bg-white/10 shadow-lg"
                >
                    <MessageCircle className="w-4 h-4 text-blue-400" />
                </button>
            </div>

            {/* Route Switching Drawer */}
            {showRouteList && (
                <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-sm" onClick={() => setShowRouteList(false)}>
                    <div className="bg-[#151515] rounded-t-2xl border-t border-gray-800 max-h-[60vh] flex flex-col" onClick={e => e.stopPropagation()}>
                        <div className="p-4 border-b border-gray-800 flex justify-between items-center">
                            <h3 className="font-bold text-white">Switch Route</h3>
                            <button onClick={() => setShowRouteList(false)}><X className="w-5 h-5 text-gray-500" /></button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 space-y-2">
                            {routes.map(route => (
                                <button
                                    key={route.id}
                                    onClick={() => {
                                        setManualRouteId(route.id);
                                        try { localStorage.setItem('fk_selectedKnockRouteId', route.id); } catch {}
                                        window.history.replaceState({}, '', `${window.location.pathname}?route=${route.id}`);
                                        setShowRouteList(false);
                                    }}
                                    className={`w-full p-3 rounded-xl border text-left transition-all ${activeRoute?.id === route.id ? 'bg-yellow-500/10 border-yellow-500' : 'bg-gray-900 border-gray-800'
                                        }`}
                                >
                                    <div className="flex justify-between items-center">
                                        <span className={`font-bold text-sm ${activeRoute?.id === route.id ? 'text-yellow-500' : 'text-white'}`}>
                                            {route.name}
                                        </span>
                                        <span className="text-xs text-gray-500">{route.metrics?.house_count || 0} doors</span>
                                    </div>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* Map View */}
            {showMap && (
                <RepMapView
                    properties={routeProperties}
                    onSelectProperty={(p) => setSelectedProperty(p)}
                    onClose={() => { setShowMap(false); setFocusProperty(null); }}
                    focusProperty={focusProperty}
                />
            )}

            {/* Property Detail - Bottom Sheet (overlays map when map is open) */}
            {selectedProperty && (
                <PropertyDetailSheet
                    property={selectedProperty}
                    logs={selectedPropertyLogs}
                    onLog={handleLog}
                    onClearDecision={handleClearDecision}
                    onPhotoUpload={handlePhotoUpload}
                    uploading={uploading}
                    onClose={() => { setSelectedProperty(null); setSelectedPropertyIndex(null); }}
                    routePosition={selectedPropertyIndex !== null ? selectedPropertyIndex + 1 : null}
                    totalStops={filteredProperties.length}
                    navigationApp={navigationApp}
                    onViewOnMap={() => {
                        const prop = selectedProperty;
                        setSelectedProperty(null);
                        setSelectedPropertyIndex(null);
                        setFocusProperty(prop);
                        setShowMap(true);
                    }}
                />
            )}

            {/* Analytics */}
            {showAnalytics && (
                <RepAnalytics
                    logs={allMyLogs}
                    routeProperties={routeProperties}
                    activeRoute={activeRoute}
                    onClose={() => setShowAnalytics(false)}
                />
            )}

            {/* Team Chat */}
            {showChat && (
                <TeamChat
                    user={user}
                    teamMember={teamMember}
                    onClose={() => setShowChat(false)}
                />
            )}

            {/* Upgrade Gate - shows after 50 houses */}
            {showUpgradeGate && (
                <UpgradeGate onClose={() => setShowUpgradeGate(false)} />
            )}
        </div>
    );
}