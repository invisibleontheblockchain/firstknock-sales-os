import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Navigation, CheckCircle2, Search, X, TrendingUp, MessageCircle } from 'lucide-react';
import localforage from 'localforage';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { optimizeRouteForTime, getKnockWindowLabel } from '@/components/logic/knockTimeOptimizer';
import { determineEffectiveStatus } from '@/components/logic/territoryLogic';
import RepMapView from '@/components/rep/RepMapView';
import RepHeader from '@/components/rep/RepHeader';
import PropertyCard from '@/components/rep/PropertyCard';
import PropertyDetailSheet from '@/components/rep/PropertyDetailSheet';
import RepAnalytics from '@/components/rep/RepAnalytics';
import TeamChat from '@/components/rep/TeamChat';

export default function RepHome() {
    const queryClient = useQueryClient();
    const [selectedProperty, setSelectedProperty] = useState(null);
    const [filterStatus, setFilterStatus] = useState('todo');
    const [searchQuery, setSearchQuery] = useState('');
    const [uploading, setUploading] = useState(false);
    const [isOffline, setIsOffline] = useState(!navigator.onLine);
    const [showMap, setShowMap] = useState(false);
    const [showAnalytics, setShowAnalytics] = useState(false);
    const [showChat, setShowChat] = useState(false);
    
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
                
                const myRoutes = allRoutes.filter(r => {
                    // Match by any known ID
                    if (r.assigned_to && myIds.has(r.assigned_to)) return true;
                    
                    // Manager in Rep Mode: also show routes they own (created as manager)
                    if (isManager && r.manager_id === user.id) return true;
                    
                    // Fallback: match by assigned_to_name (handles cases where assignment was by old/different ID)
                    if (r.assigned_to_name && myName) {
                        const routeName = r.assigned_to_name.trim().toLowerCase();
                        if (routeName === myName) return true;
                        // Also check partial name match for "Charles Henson" vs "Charlie Henson" etc.
                        const routeNameParts = routeName.split(' ');
                        const myNameParts = myName.split(' ');
                        if (routeNameParts.length > 1 && myNameParts.length > 1) {
                            // Match last name + first 3 chars of first name
                            const lastMatch = routeNameParts[routeNameParts.length-1] === myNameParts[myNameParts.length-1];
                            const firstPartial = routeNameParts[0].slice(0,3) === myNameParts[0].slice(0,3) || 
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
                
                console.log(`[RepHome] Found ${activeRoutes.length} active routes (${myRoutes.length} total) for IDs: [${[...myIds].join(', ')}], name: "${myName}"`);
                
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
    const [manualRouteId, setManualRouteId] = useState(null);
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

    // 2. Fetch Route Properties - batch filter by address_hash
    const { data: properties = [], isLoading: propsLoading } = useQuery({
        queryKey: ['routeProperties', activeRoute?.id],
        queryFn: async () => {
            if (!activeRoute?.property_hashes?.length) return [];
            const hashes = activeRoute.property_hashes;
            
            try {
                let allProps = [];
                
                // Batch fetch in chunks of 20 hashes at a time using filter
                const BATCH_SIZE = 20;
                const batches = [];
                for (let i = 0; i < hashes.length; i += BATCH_SIZE) {
                    batches.push(hashes.slice(i, i + BATCH_SIZE));
                }
                
                console.log(`[RepHome] Fetching ${hashes.length} properties in ${batches.length} batches`);
                
                const results = await Promise.all(
                    batches.map(batch => 
                        base44.entities.MasterProperty.filter(
                            { address_hash: batch }, 
                            '-created_date', 
                            batch.length
                        ).then(r => Array.isArray(r) ? r : (r?.items || []))
                         .catch(err => {
                             console.warn('[RepHome] Batch fetch failed, trying individually', err);
                             // Fallback: fetch individually for this batch
                             return Promise.all(
                                 batch.map(hash => 
                                     base44.entities.MasterProperty.filter({ address_hash: hash }, '-created_date', 1)
                                         .then(r => Array.isArray(r) ? r : (r?.items || []))
                                         .catch(() => [])
                                 )
                             ).then(results => results.flat());
                         })
                    )
                );
                
                allProps = results.flat();
                console.log(`[RepHome] Found ${allProps.length}/${hashes.length} properties`);
                
                // Cache for offline
                if (allProps.length > 0) {
                    localforage.setItem(`cached_props_${activeRoute.id}`, allProps);
                }
                return allProps;
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
        mutationFn: (logData) => base44.entities.InteractionLog.create(logData),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['myLogs'] });
            queryClient.invalidateQueries({ queryKey: ['routeLogs'] }); // Also invalidate route logs to update progress
            setSelectedProperty(null); // Close detail view on success
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
        if (!activeRoute || !properties.length) return [];
        
        // Map hashes to real properties
        const props = (activeRoute.property_hashes || [])
            .map(hash => properties.find(p => p.address_hash === hash))
            .filter(Boolean)
            .map(p => {
                const pLogs = logs.filter(l => l.address_hash === p.address_hash);
                const status = determineEffectiveStatus(p, pLogs);
                return { ...p, effective_status: status };
            });

        // Optimize sort based on time
        return optimizeRouteForTime(props, new Date());
    }, [activeRoute, properties, logs]);

    // Stats
    const stats = useMemo(() => {
        if (!routeProperties.length) return { total: 0, done: 0, percent: 0 };
        const done = routeProperties.filter(p => p.effective_status !== 'ELIGIBLE' && p.effective_status !== 'CALLBACK').length;
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

            // Status filter
            const isDone = p.effective_status !== 'ELIGIBLE' && p.effective_status !== 'CALLBACK';
            
            if (filterStatus === 'todo') return !isDone;
            if (filterStatus === 'done') return isDone;
            return true;
        });
    }, [routeProperties, filterStatus, searchQuery]);

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
        <div className="h-full flex flex-col bg-black text-white">
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
            <div className="px-4 pt-3 pb-2 space-y-2 bg-black border-b border-gray-800/50">
                <div className="flex p-0.5 bg-gray-900 rounded-lg">
                    {[
                        { id: 'todo', label: `To Do (${routeProperties.length - stats.done})` },
                        { id: 'done', label: `Done (${stats.done})` },
                        { id: 'all', label: 'All' },
                    ].map(tab => (
                        <button
                            key={tab.id}
                            onClick={() => setFilterStatus(tab.id)}
                            className={`flex-1 py-1.5 text-[11px] font-bold rounded-md transition-all ${
                                filterStatus === tab.id ? 'bg-yellow-500 text-black' : 'text-gray-500'
                            }`}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>

                {/* Inline search - only show when there are enough properties */}
                {routeProperties.length > 8 && (
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-600" />
                        <Input 
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search..."
                            className="h-8 pl-8 text-xs bg-gray-900 border-gray-800 text-white placeholder:text-gray-600 focus:border-yellow-500"
                        />
                        {searchQuery && (
                            <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2">
                                <X className="w-3.5 h-3.5 text-gray-500" />
                            </button>
                        )}
                    </div>
                )}
            </div>

            {/* Property List */}
            <div className="flex-1 overflow-y-auto px-4 py-3 pb-20">
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
                    <div className="space-y-2">
                        {filteredProperties.map((prop, idx) => (
                            <PropertyCard
                                key={prop.address_hash}
                                property={prop}
                                index={idx}
                                onSelect={setSelectedProperty}
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
                            if(confirm("Mark route as complete?")) completeRouteMutation.mutate();
                        }}
                        className="flex-1 h-11 bg-green-600 hover:bg-green-700 text-white font-bold rounded-xl shadow-2xl text-xs"
                    >
                        ✅ Complete Route
                    </Button>
                )}
                <button
                    onClick={() => setShowAnalytics(true)}
                    className="w-11 h-11 rounded-xl bg-[#151515] border border-gray-800 flex items-center justify-center active:bg-gray-800 shadow-lg"
                >
                    <TrendingUp className="w-5 h-5 text-yellow-500" />
                </button>
                <button
                    onClick={() => setShowChat(true)}
                    className="w-11 h-11 rounded-xl bg-[#151515] border border-gray-800 flex items-center justify-center active:bg-gray-800 shadow-lg"
                >
                    <MessageCircle className="w-5 h-5 text-blue-400" />
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
                                    onClick={() => { setManualRouteId(route.id); setShowRouteList(false); }}
                                    className={`w-full p-3 rounded-xl border text-left transition-all ${
                                        activeRoute?.id === route.id ? 'bg-yellow-500/10 border-yellow-500' : 'bg-gray-900 border-gray-800'
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
                    onSelectProperty={(p) => { setSelectedProperty(p); setShowMap(false); }}
                    onClose={() => setShowMap(false)}
                />
            )}

            {/* Property Detail - Bottom Sheet */}
            {selectedProperty && (
                <PropertyDetailSheet
                    property={selectedProperty}
                    logs={selectedPropertyLogs}
                    onLog={handleLog}
                    onPhotoUpload={handlePhotoUpload}
                    uploading={uploading}
                    onClose={() => setSelectedProperty(null)}
                />
            )}

            {/* Analytics */}
            {showAnalytics && (
                <RepAnalytics
                    logs={allMyLogs}
                    routeProperties={routeProperties}
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
        </div>
    );
}