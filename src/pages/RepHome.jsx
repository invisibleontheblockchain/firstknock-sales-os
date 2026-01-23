import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { 
    Loader2, MapPin, Navigation, CheckCircle2, Circle, Clock, 
    ChevronRight, Phone, AlertTriangle, User, Home, Calendar, ArrowRight,
    Search, Filter, X
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format } from 'date-fns';
import { optimizeRouteForTime, getKnockWindowLabel } from '@/components/logic/knockTimeOptimizer';
import { determineEffectiveStatus } from '@/components/logic/territoryLogic';

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

    // 1. Fetch Assigned Routes
    const { data: routes = [], isLoading: routesLoading } = useQuery({
        queryKey: ['myRoutes', user?.id, teamMember?.id],
        queryFn: async () => {
            if (!user) return [];
            try {
                // Fetch all active routes and filter for this user
                // (In a real backend we'd filter by assigned_to in the query)
                const res = await base44.entities.SavedRoute.list('-created_date', 50);
                const allRoutes = Array.isArray(res) ? res : (res?.items || []);
                
                // Filter for routes assigned to me (by Team ID) OR created by me if I'm a rep
                return allRoutes.filter(r => 
                    (teamMember && r.assigned_to === teamMember.id) || // Match TeamMember ID (Primary)
                    r.assigned_to === user.id || // Match Auth ID (Fallback)
                    r.assigned_to_name === user.email || // Match Email (Legacy)
                    (r.status === 'ACTIVE' && r.created_by === user.email) // Creator
                );
            } catch (e) {
                console.error("Error fetching routes", e);
                return [];
            }
        },
        enabled: !!user
    });

    // --- Derived State ---

    // Get the Active Route (Highest priority or most recent active)
    const activeRoute = useMemo(() => {
        if (!routes.length) return null;
        // Prioritize 'IN_PROGRESS' then 'ACTIVE'
        return routes.find(r => r.status === 'IN_PROGRESS') || routes.find(r => r.status === 'ACTIVE') || routes[0];
    }, [routes]);

    // 2. Fetch Route Properties (filtered by hash)
    const { data: properties = [], isLoading: propsLoading } = useQuery({
        queryKey: ['routeProperties', activeRoute?.id],
        queryFn: async () => {
            if (!activeRoute?.property_hashes?.length) return [];
            try {
                // Fetch only properties in this route using the hashes
                const res = await base44.entities.MasterProperty.filter({ 
                    address_hash: activeRoute.property_hashes 
                }, '-created_date', 1000);
                return Array.isArray(res) ? res : (res?.items || []);
            } catch (e) {
                console.error("Error fetching properties", e);
                return [];
            }
        },
        enabled: !!activeRoute
    });

    // 3. Fetch Interaction Logs (for status)
    const { data: logs = [], isLoading: logsLoading } = useQuery({
        queryKey: ['myLogs', user?.email],
        queryFn: async () => {
            if (!user?.email) return [];
            return await base44.entities.InteractionLog.filter({ created_by: user.email }, '-created_date', 500);
        },
        enabled: !!user
    });

    // Log Result Mutation
    const createLogMutation = useMutation({
        mutationFn: (logData) => base44.entities.InteractionLog.create(logData),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['myLogs'] });
            setSelectedProperty(null); // Close detail view on success
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

    const handleLog = (status) => {
        if (!selectedProperty) return;
        createLogMutation.mutate({
            address_hash: selectedProperty.address_hash,
            raw_input_text: `Marked as ${status}`,
            parsed_status: status,
            gps_proof_lat: selectedProperty.lat,
            gps_proof_lng: selectedProperty.lng
        });
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
                        <div>
                            <p className="font-bold leading-none">{user?.full_name || 'Rep'}</p>
                            <div className="flex items-center gap-1 text-xs text-green-500 mt-1">
                                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                                ON DUTY
                            </div>
                        </div>
                    </div>
                    <Badge variant="outline" className="border-yellow-500/50 text-yellow-500">
                        {knockWindow.emoji} {knockWindow.label}
                    </Badge>
                </div>
                
                {/* Route Progress Card */}
                <div className="bg-gray-900 rounded-lg p-3 border border-gray-800">
                    <div className="flex justify-between items-center mb-2">
                        <h3 className="font-bold text-sm text-gray-200">{activeRoute.name}</h3>
                        <span className="text-xs text-gray-500">{stats.done}/{stats.total} Homes</span>
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

                            {/* Main Actions */}
                            <div className="grid grid-cols-2 gap-3">
                                <Button 
                                    className="h-12 bg-green-600 hover:bg-green-700 font-bold text-xs sm:text-sm"
                                    onClick={() => handleLog('SOLD')}
                                >
                                    <CheckCircle2 className="w-4 h-4 mr-2" />
                                    SOLD / LEAD
                                </Button>
                                <Button 
                                    className="h-12 bg-purple-600 hover:bg-purple-700 font-bold text-xs sm:text-sm"
                                    onClick={() => handleLog('HARD_NO')}
                                >
                                    <AlertTriangle className="w-4 h-4 mr-2" />
                                    NOT INTERESTED
                                </Button>
                                <Button 
                                    className="h-12 bg-yellow-600 hover:bg-yellow-700 font-bold text-xs sm:text-sm"
                                    onClick={() => handleLog('CALLBACK')}
                                >
                                    <Clock className="w-4 h-4 mr-2" />
                                    CALLBACK
                                </Button>
                                <Button 
                                    className="h-12 bg-gray-700 hover:bg-gray-600 font-bold text-xs sm:text-sm"
                                    onClick={() => handleLog('NO_ANSWER')}
                                >
                                    <Home className="w-4 h-4 mr-2" />
                                    NO ANSWER
                                </Button>
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