import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { 
    Loader2, MapPin, Navigation, CheckCircle2, Circle, Clock, 
    ChevronRight, Phone, AlertTriangle, User, Home, Calendar, ArrowRight,
    Search, Filter, X, Camera, WifiOff
} from 'lucide-react';
import localforage from 'localforage';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format } from 'date-fns';
import { optimizeRouteForTime, getKnockWindowLabel } from '@/components/logic/knockTimeOptimizer';
import { determineEffectiveStatus } from '@/components/logic/territoryLogic';
import QuickMarkButtons from '@/components/rep/QuickMarkButtons';

const BRAND = {
    voidBlack: '#0A0A0A',
    gold: '#FFD700',
    charcoal: '#1F1F1F',
    offWhite: '#E5E5E5'
};

const STATUS_CONFIG = {
    ELIGIBLE: { color: 'bg-gray-500', label: 'Not Visited', icon: Circle },
    SOLD: { color: 'bg-green-500', label: 'Sold', icon: CheckCircle2 },
    HARD_NO: { color: 'bg-purple-500', label: 'Hard No', icon: AlertTriangle },
    CALLBACK: { color: 'bg-yellow-500', label: 'Callback', icon: Clock },
    NO_ANSWER: { color: 'bg-orange-500', label: 'No Answer', icon: Home },
};

export default function RepHome() {
    const queryClient = useQueryClient();
    const [selectedProperty, setSelectedProperty] = useState(null);
    const [filterStatus, setFilterStatus] = useState('todo'); // 'todo', 'done', 'all'
    const [searchQuery, setSearchQuery] = useState('');
    const [uploading, setUploading] = useState(false);
    const [isOffline, setIsOffline] = useState(!navigator.onLine);
    
    // Log State
    const [logNote, setLogNote] = useState('');
    const [callbackTime, setCallbackTime] = useState('');
    const [callbackPhone, setCallbackPhone] = useState('');

    // Reset log state when opening property
    React.useEffect(() => {
        if (selectedProperty) {
            setLogNote('');
            setCallbackTime('');
            setCallbackPhone('');
        }
    }, [selectedProperty]);
    
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
    const { data: teamMember } = useQuery({
        queryKey: ['myTeamMember', user?.email],
        queryFn: async () => {
            if (!user?.email) return null;
            try {
                // Fetch list and find client-side for robust case-insensitive matching
                const res = await base44.entities.TeamMember.list('-created_date', 100);
                const members = Array.isArray(res) ? res : (res?.items || []);
                // Robust match: trim and lowercase
                return members.find(m => m.email?.trim().toLowerCase() === user.email.trim().toLowerCase()) || null;
            } catch (e) {
                console.error("Error fetching team member profile", e);
                return null;
            }
        },
        enabled: !!user?.email
    });

    // 1. Fetch Assigned Routes - scoped to rep's team (manager_id)
    const { data: routes = [], isLoading: routesLoading } = useQuery({
        queryKey: ['myRoutes', user?.id, teamMember?.id, teamMember?.manager_id],
        queryFn: async () => {
            if (!user) return [];
            try {
                let allRoutes = [];
                
                // If we know the rep's manager, fetch only that manager's routes
                if (teamMember?.manager_id) {
                    const res = await base44.entities.SavedRoute.filter(
                        { manager_id: teamMember.manager_id }, 
                        '-created_date', 200
                    );
                    allRoutes = Array.isArray(res) ? res : (res?.items || []);
                } else {
                    // Fallback: fetch all and filter client-side
                    const res = await base44.entities.SavedRoute.list('-created_date', 200);
                    allRoutes = Array.isArray(res) ? res : (res?.items || []);
                }
                
                // Filter for routes assigned to THIS rep specifically
                const myRoutes = allRoutes.filter(r => 
                    (teamMember && r.assigned_to === teamMember.id) || // Match TeamMember ID (Primary)
                    r.assigned_to === user.id // Match Auth ID (Fallback)
                );
                
                console.log(`[RepHome] Found ${myRoutes.length} routes assigned to me out of ${allRoutes.length} total (manager: ${teamMember?.manager_id || 'unknown'})`);
                
                // Cache routes for offline
                if (myRoutes.length > 0) {
                    localforage.setItem('cached_routes', myRoutes);
                }
                return myRoutes;
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

    // 2. Fetch Route Properties - fetch ALL properties then filter client-side by hash
    // The SDK filter with array values may not return all matches, so we fetch broadly
    const { data: properties = [], isLoading: propsLoading } = useQuery({
        queryKey: ['routeProperties', activeRoute?.id],
        queryFn: async () => {
            if (!activeRoute?.property_hashes?.length) return [];
            const hashSet = new Set(activeRoute.property_hashes);
            
            try {
                // Strategy: fetch by zip codes if available, or fetch all created by user's manager
                // First, try fetching all properties and filtering client-side
                let allProps = [];
                
                // Try fetching in batches by individual hash (most reliable)
                // But for large routes this is too many calls. Instead, fetch broadly.
                
                // Approach: Fetch all properties (up to 5000) and filter client-side
                const res = await base44.entities.MasterProperty.list('-created_date', 5000);
                const items = Array.isArray(res) ? res : (res?.items || []);
                allProps = items.filter(p => hashSet.has(p.address_hash));
                
                console.log(`[RepHome] Route has ${activeRoute.property_hashes.length} hashes, found ${allProps.length} matching properties`);
                
                // If we didn't find all, try fetching individually for missing ones
                if (allProps.length < activeRoute.property_hashes.length) {
                    const foundHashes = new Set(allProps.map(p => p.address_hash));
                    const missingHashes = activeRoute.property_hashes.filter(h => !foundHashes.has(h));
                    
                    if (missingHashes.length > 0 && missingHashes.length <= 50) {
                        console.log(`[RepHome] Fetching ${missingHashes.length} missing properties individually`);
                        const missingResults = await Promise.all(
                            missingHashes.map(hash => 
                                base44.entities.MasterProperty.filter({ address_hash: hash }, '-created_date', 1)
                                    .then(r => (Array.isArray(r) ? r : (r?.items || [])))
                                    .catch(() => [])
                            )
                        );
                        const extraProps = missingResults.flat();
                        allProps = [...allProps, ...extraProps];
                        console.log(`[RepHome] After individual fetch: ${allProps.length} total properties`);
                    }
                }
                
                // Cache properties for offline
                if (allProps.length > 0) {
                    localforage.setItem(`cached_props_${activeRoute.id}`, allProps);
                }
                return allProps;
            } catch (e) {
                console.error("Error fetching properties", e);
                // Try fallback
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
                // Fetch logs for the properties in this route (regardless of who created them)
                return await base44.entities.InteractionLog.filter({ 
                    address_hash: activeRoute.property_hashes 
                }, '-created_date', 1000);
            }
            // Fallback if no active route properties (shouldn't happen often in this view)
            if (user?.email) {
                return await base44.entities.InteractionLog.filter({ created_by: user.email }, '-created_date', 500);
            }
            return [];
        },
        enabled: !!activeRoute || !!user
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

    const handleLog = (status, imageUrl = null) => {
        if (!selectedProperty) return;

        // Haptic feedback
        if (navigator.vibrate) navigator.vibrate(50);

        // Get Real GPS
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    submitLog(status, position.coords, imageUrl);
                },
                (error) => {
                    console.warn("GPS failed, using property location", error);
                    // Fallback to property location if GPS fails
                    submitLog(status, { 
                        latitude: selectedProperty.lat, 
                        longitude: selectedProperty.lng,
                        accuracy: 0
                    }, imageUrl);
                },
                { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
            );
        } else {
            submitLog(status, { 
                latitude: selectedProperty.lat, 
                longitude: selectedProperty.lng,
                accuracy: 0
            }, imageUrl);
        }
    };

    const submitLog = (status, coords, imageUrl) => {
        let noteText = `Marked as ${status}`;
        if (logNote) noteText += ` | Note: ${logNote}`;
        if (callbackPhone) noteText += ` | Phone: ${callbackPhone}`;
        if (callbackTime) noteText += ` | Time: ${callbackTime}`;

        // Calculate next eligible date if callback
        let nextDate = null;
        if (status === 'CALLBACK' && callbackTime) {
            const today = new Date();
            const [hours, minutes] = callbackTime.split(':');
            today.setHours(parseInt(hours), parseInt(minutes));
            nextDate = today.toISOString();
        }

        createLogMutation.mutate({
            address_hash: selectedProperty.address_hash,
            raw_input_text: noteText,
            parsed_status: status,
            gps_proof_lat: coords.latitude,
            gps_proof_lng: coords.longitude,
            gps_accuracy: coords.accuracy,
            image_url: imageUrl,
            next_eligible_date: nextDate
        });
    };

    const handlePhotoUpload = async (e) => {
        const file = e.target.files[0];
        if (!file) return;

        setUploading(true);
        try {
            // Haptic
            if (navigator.vibrate) navigator.vibrate([50, 50, 50]);
            
            const { file_url } = await base44.integrations.Core.UploadFile({ file });
            // Auto-log as visited with photo? Or just attach? 
            // For now, let's just log it as a generic visit/note or re-log current status if needed.
            // Actually, usually photo is part of the outcome. 
            // Let's assume taking a photo is a "Door Knocked" proof.
            // We'll pass it to the log function.
            // For this UI, let's just toast it and pass it to the next status click?
            // Better: Auto-log as "ELIGIBLE" (Proof) or just save state?
            // Let's immediately log it as a "Callback" or "Interaction" with the photo?
            // OR: Just store it in state to attach to next button press?
            // Let's store in a ref or state? No, let's just trigger a log "Note" with photo.
            // Wait, the requirement is "Camera Integration".
            // Let's modify handleLog to accept image.
            
            // For simplicity in this UI: Taking a photo logs it as "CALLBACK" (common use case) or we can add a specific "PHOTO" action?
            // Let's add the photo to the next status tap.
            // Actually, let's just immediately log it with the current effective status or 'CALLBACK' default.
            
            // Let's KEEP IT SIMPLE: Button takes photo -> Uploads -> Logs as "Proof of Visit" (CALLBACK)
            handleLog('CALLBACK', file_url);
            toast.success("Photo saved!");
            
        } catch (error) {
            console.error(error);
            toast.error("Upload failed");
        } finally {
            setUploading(false);
        }
    };

    return (
        <div className="h-full overflow-y-auto bg-black text-white pb-safe">
            {/* 1. Header Area */}
            <div className="sticky top-0 z-30 bg-black/80 backdrop-blur-md border-b border-gray-800 px-4 py-3">
                <div className="flex justify-between items-center mb-3">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-yellow-500 flex items-center justify-center text-black font-bold text-lg">
                        {user?.full_name?.[0] || user?.email?.[0] || 'U'}
                    </div>
                    <div className="min-w-0 flex-1">
                        <p className="font-bold leading-none truncate max-w-[120px] sm:max-w-none">{user?.full_name || 'Rep'}</p>
                        {isOffline ? (
                            <div className="flex items-center gap-1 text-xs text-red-500 mt-1 font-bold">
                                <WifiOff className="w-3 h-3" />
                                OFFLINE MODE
                            </div>
                        ) : (
                            <div className="flex items-center gap-1 text-xs text-green-500 mt-1">
                                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                                ON DUTY
                            </div>
                        )}
                    </div>
                </div>
                    <Badge variant="outline" className="border-yellow-500/50 text-yellow-500">
                        {knockWindow.emoji} {knockWindow.label}
                    </Badge>
                </div>
                
                {/* Route Progress Card */}
                <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
                    <div className="flex justify-between items-center mb-2">
                        <div className="flex items-center gap-2">
                            <h3 className="font-bold text-sm text-gray-200">{activeRoute.name}</h3>
                            {routes.length > 1 && (
                                <Badge 
                                    variant="outline" 
                                    className="cursor-pointer hover:bg-yellow-500 hover:text-black border-yellow-500/50 text-yellow-500 text-[9px] h-5 px-1.5"
                                    onClick={() => setShowRouteList(true)}
                                >
                                    SWITCH
                                </Badge>
                            )}
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-500">{stats.done}/{stats.total} Homes</span>
                            {stats.percent >= 100 && (
                                <Button 
                                    size="sm" 
                                    onClick={() => {
                                        if(confirm("Mark route as complete? This may auto-assign a new route.")) {
                                            completeRouteMutation.mutate();
                                        }
                                    }}
                                    className="h-6 text-[10px] bg-green-600 hover:bg-green-700 text-white border-0"
                                >
                                    COMPLETE
                                </Button>
                            )}
                        </div>
                    </div>
                    <Progress value={stats.percent} className="h-2 bg-gray-800" indicatorClassName="bg-yellow-500" />
                </div>

                {/* Filters & Search */}
                <div className="mt-3 space-y-3">
                    {/* Search */}
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                        <Input 
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search address..."
                            className="h-10 pl-9 bg-gray-900 border-gray-800 text-white placeholder:text-gray-600 focus:border-yellow-500"
                        />
                        {searchQuery && (
                            <button 
                                onClick={() => setSearchQuery('')}
                                className="absolute right-3 top-1/2 -translate-y-1/2"
                            >
                                <X className="w-4 h-4 text-gray-500" />
                            </button>
                        )}
                    </div>

                    {/* Filter Tabs */}
                    <div className="flex p-1 bg-gray-900 rounded-lg border border-gray-800">
                        <button
                            onClick={() => setFilterStatus('todo')}
                            className={`flex-1 py-2 text-xs font-bold rounded-md transition-all ${
                                filterStatus === 'todo' ? 'bg-yellow-500 text-black' : 'text-gray-500 hover:text-gray-300'
                            }`}
                        >
                            TO DO ({routeProperties.length - stats.done})
                        </button>
                        <button
                            onClick={() => setFilterStatus('done')}
                            className={`flex-1 py-2 text-xs font-bold rounded-md transition-all ${
                                filterStatus === 'done' ? 'bg-yellow-500 text-black' : 'text-gray-500 hover:text-gray-300'
                            }`}
                        >
                            DONE ({stats.done})
                        </button>
                        <button
                            onClick={() => setFilterStatus('all')}
                            className={`flex-1 py-2 text-xs font-bold rounded-md transition-all ${
                                filterStatus === 'all' ? 'bg-yellow-500 text-black' : 'text-gray-500 hover:text-gray-300'
                            }`}
                        >
                            ALL
                        </button>
                    </div>
                </div>
            </div>

            {/* 2. Main Content - Optimized List */}
            <div className="px-4 pb-20 space-y-4">
                <div className="flex items-center justify-between text-xs font-bold text-gray-500 tracking-wider">
                    <span>
                        {searchQuery ? 'SEARCH RESULTS' : filterStatus === 'done' ? 'COMPLETED' : 'UP NEXT'} 
                        {' '}({filteredProperties.length})
                    </span>
                    <span>OPTIMIZED BY TIME</span>
                </div>

                {filteredProperties.length === 0 ? (
                    <div className="text-center py-20 border border-dashed border-gray-800 rounded-xl bg-gray-900/20">
                        <div className="w-16 h-16 bg-gray-800 rounded-full flex items-center justify-center mx-auto mb-4">
                            {filterStatus === 'done' ? <CheckCircle2 className="w-8 h-8 text-green-500" /> : <Home className="w-8 h-8 text-gray-600" />}
                        </div>
                        <p className="text-gray-500 font-medium">
                            {searchQuery ? 'No matching properties found' : 
                             filterStatus === 'done' ? 'No completed properties yet' : 
                             'All caught up! Great work.'}
                        </p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {filteredProperties.map((prop, idx) => {
                            const isDone = prop.effective_status !== 'ELIGIBLE' && prop.effective_status !== 'CALLBACK';
                            const statusConfig = STATUS_CONFIG[prop.effective_status] || STATUS_CONFIG.ELIGIBLE;
                            const StatusIcon = statusConfig.icon;

                            return (
                                <Card 
                                    key={prop.address_hash}
                                    onClick={() => setSelectedProperty(prop)}
                                    className="bg-[#151515] border-gray-800 hover:border-yellow-500/50 transition-all active:scale-98 cursor-pointer"
                                >
                                    <div className="p-4 flex items-center gap-4">
                                        <div className="flex flex-col items-center justify-center w-12 h-12 bg-gray-800 rounded-xl border border-gray-700">
                                            <span className="text-lg font-bold text-white">{idx + 1}</span>
                                        </div>
                                        
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 mb-1">
                                                <h4 className="font-bold text-lg text-white truncate">
                                                    {prop.house_number} {prop.street_name}
                                                </h4>
                                            </div>
                                            <div className="flex items-center gap-3 text-xs text-gray-400">
                                                <span>{prop.city}</span>
                                                {prop.timeScore > 80 && (
                                                    <span className="text-green-500 font-bold flex items-center gap-1">
                                                        <Clock className="w-3 h-3" /> BEST TIME
                                                    </span>
                                                )}
                                            </div>
                                        </div>

                                        <ChevronRight className="w-6 h-6 text-gray-600" />
                                    </div>
                                    
                                    {/* Quick Info Footer */}
                                    {(prop.status || prop.original_status) && (
                                        <div className="px-4 py-2 bg-gray-900/50 border-t border-gray-800 flex items-center gap-2 text-xs text-gray-500">
                                            <Badge variant="secondary" className="h-5 text-[10px] bg-gray-800 text-gray-400">
                                                {prop.original_status}
                                            </Badge>
                                            {prop.sqft && <span>{prop.sqft.toLocaleString()} sqft</span>}
                                        </div>
                                    )}
                                </Card>
                            );
                        })}
                        
                    </div>
                )}
            </div>

            {/* Route Switching Drawer */}
            {showRouteList && (
                <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={() => setShowRouteList(false)}>
                    <div className="bg-[#151515] rounded-t-2xl border-t border-gray-800 max-h-[70vh] flex flex-col" onClick={e => e.stopPropagation()}>
                        <div className="p-4 border-b border-gray-800 flex justify-between items-center bg-[#0A0A0A] rounded-t-2xl">
                            <h3 className="font-bold text-white">Select Route</h3>
                            <Button variant="ghost" size="icon" onClick={() => setShowRouteList(false)}>
                                <X className="w-5 h-5 text-gray-500" />
                            </Button>
                        </div>
                        <ScrollArea className="flex-1 p-4">
                            <div className="space-y-3">
                                {routes.map(route => {
                                    const isActive = activeRoute?.id === route.id;
                                    return (
                                        <button
                                            key={route.id}
                                            onClick={() => {
                                                setManualRouteId(route.id);
                                                setShowRouteList(false);
                                            }}
                                            className={`w-full p-4 rounded-xl border text-left transition-all ${
                                                isActive 
                                                    ? 'bg-yellow-500/10 border-yellow-500' 
                                                    : 'bg-gray-900 border-gray-800 hover:border-gray-700'
                                            }`}
                                        >
                                            <div className="flex justify-between items-start mb-1">
                                                <span className={`font-bold ${isActive ? 'text-yellow-500' : 'text-white'}`}>
                                                    {route.name}
                                                </span>
                                                {isActive && <CheckCircle2 className="w-4 h-4 text-yellow-500" />}
                                            </div>
                                            <div className="flex gap-3 text-xs text-gray-500">
                                                <span>{route.metrics?.house_count || 0} doors</span>
                                                <span>{route.status}</span>
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        </ScrollArea>
                    </div>
                </div>
            )}

            {/* 3. Property Detail Drawer (Overlay) */}
            {selectedProperty && (
                <div className="fixed inset-0 z-50 flex flex-col bg-black animate-in slide-in-from-bottom duration-300">
                    {/* Header */}
                    <div className="px-4 py-4 border-b border-gray-800 flex items-center justify-between bg-gray-900/50 backdrop-blur">
                        <Button 
                            variant="ghost" 
                            onClick={() => setSelectedProperty(null)}
                            className="text-gray-400 hover:text-white -ml-2"
                        >
                            <ArrowRight className="w-5 h-5 mr-1 rotate-180" /> Back
                        </Button>
                        <p className="font-bold text-sm text-gray-400">Property Details</p>
                        <div className="w-10" /> {/* Spacer */}
                    </div>

                    <ScrollArea className="flex-1 p-6">
                        <div className="space-y-8">
                            {/* Hero Address */}
                            <div className="text-center">
                                <h2 className="text-3xl font-bold text-white mb-2">
                                    {selectedProperty.house_number} {selectedProperty.street_name}
                                </h2>
                                <p className="text-xl text-gray-400">{selectedProperty.city}, {selectedProperty.state}</p>
                            </div>

                            {/* Interaction Details Input */}
                            <div className="space-y-3 bg-gray-900/50 p-4 rounded-xl border border-gray-800">
                                <div className="space-y-2">
                                    <label className="text-xs font-bold text-gray-500 uppercase">Interaction Note</label>
                                    <textarea
                                        value={logNote}
                                        onChange={(e) => setLogNote(e.target.value)}
                                        placeholder="Add notes..."
                                        className="w-full bg-black/50 border border-gray-700 rounded-lg p-3 text-sm text-white resize-none h-24 focus:border-yellow-500 focus:outline-none"
                                    />
                                </div>
                                
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="space-y-2">
                                        <label className="text-xs font-bold text-gray-500 uppercase flex items-center gap-1">
                                            <Clock className="w-3 h-3" /> Callback Time
                                        </label>
                                        <input
                                            type="time"
                                            value={callbackTime}
                                            onChange={(e) => setCallbackTime(e.target.value)}
                                            className="w-full bg-black/50 border border-gray-700 rounded-lg p-2 text-sm text-white focus:border-yellow-500 focus:outline-none"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-xs font-bold text-gray-500 uppercase flex items-center gap-1">
                                            <Phone className="w-3 h-3" /> Phone #
                                        </label>
                                        <input
                                            type="tel"
                                            value={callbackPhone}
                                            onChange={(e) => setCallbackPhone(e.target.value)}
                                            placeholder="(555) 555-5555"
                                            className="w-full bg-black/50 border border-gray-700 rounded-lg p-2 text-sm text-white focus:border-yellow-500 focus:outline-none"
                                        />
                                    </div>
                                </div>
                            </div>

                            {/* Main Actions - Simplified */}
                            <QuickMarkButtons
                                size="large"
                                onMark={(status) => handleLog(status)}
                            />

                            {/* Camera Action */}
                            <div className="relative">
                                <input
                                    type="file"
                                    accept="image/*"
                                    capture="environment"
                                    onChange={handlePhotoUpload}
                                    className="hidden"
                                    id="camera-input"
                                    disabled={uploading}
                                />
                                <label 
                                    htmlFor="camera-input"
                                    className={`flex items-center justify-center w-full h-12 rounded-md font-bold text-sm cursor-pointer transition-colors ${
                                        uploading ? 'bg-gray-800 text-gray-500' : 'bg-blue-600 hover:bg-blue-700 text-white'
                                    }`}
                                >
                                    {uploading ? (
                                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                    ) : (
                                        <Camera className="w-4 h-4 mr-2" />
                                    )}
                                    {uploading ? 'Uploading Proof...' : 'Take Photo Proof'}
                                </label>
                            </div>

                            {/* Property Data Grid */}
                            <div className="bg-gray-900 rounded-xl p-6 border border-gray-800">
                                <h3 className="font-bold text-yellow-500 mb-4 text-sm uppercase tracking-wider">Property Intel</h3>
                                <div className="grid grid-cols-2 gap-y-6 gap-x-4">
                                    <div>
                                        <p className="text-xs text-gray-500 uppercase">Owner</p>
                                        <p className="font-medium text-lg">Current Resident</p>
                                    </div>
                                    <div>
                                        <p className="text-xs text-gray-500 uppercase">Est. Value</p>
                                        <p className="font-medium text-lg">${(selectedProperty.price / 1000).toFixed(0)}k</p>
                                    </div>
                                    <div>
                                        <p className="text-xs text-gray-500 uppercase">Last Sold</p>
                                        <p className="font-medium text-lg">
                                            {selectedProperty.sold_date ? format(new Date(selectedProperty.sold_date), 'yyyy') : 'N/A'}
                                        </p>
                                    </div>
                                    <div>
                                        <p className="text-xs text-gray-500 uppercase">Size</p>
                                        <p className="font-medium text-lg">{selectedProperty.sqft} sqft</p>
                                    </div>
                                </div>
                            </div>

                            {/* Map Preview / Link */}
                            <a 
                                href={`https://maps.apple.com/?q=${selectedProperty.lat},${selectedProperty.lng}`}
                                target="_blank"
                                rel="noreferrer"
                                className="block w-full h-32 bg-gray-800 rounded-xl flex items-center justify-center border border-gray-700 hover:border-yellow-500 transition-colors"
                            >
                                <div className="text-center">
                                    <Navigation className="w-8 h-8 text-yellow-500 mx-auto mb-2" />
                                    <p className="font-bold text-sm">Open in Maps</p>
                                </div>
                            </a>
                        </div>
                    </ScrollArea>
                </div>
            )}
        </div>
    );
}