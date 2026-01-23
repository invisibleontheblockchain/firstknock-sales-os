import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Loader2, Navigation, CheckCircle, MapPin, AlertCircle } from 'lucide-react';

export default function RepHome() {
    const queryClient = useQueryClient();
    
    // 1. User Query
    const { data: user, isLoading: userLoading, error: userError } = useQuery({ 
        queryKey: ['user'], 
        queryFn: () => base44.auth.me().catch(() => null),
    });

    // 2. Routes Query
    const { data: myRoutes = [], isLoading: routesLoading, error: routesError } = useQuery({
        queryKey: ['myRoutes', user?.email],
        queryFn: async () => {
            if (!user?.email) return [];
            try {
                const res = await base44.entities.SavedRoute.list('-created_date', 100);
                const items = Array.isArray(res) ? res : (res?.items || []);
                return items.filter(r => 
                    r.assigned_to_name === user.email || 
                    r.assigned_to === user.id ||
                    (!r.assigned_to && r.status === 'ACTIVE')
                );
            } catch (e) {
                console.warn("Route fetch error", e);
                return [];
            }
        },
        enabled: !!user?.email
    });

    // 3. Properties Query
    const { data: properties = [], isLoading: propsLoading, error: propsError } = useQuery({
        queryKey: ['masterProperties', user?.email],
        queryFn: async () => {
            if (!user?.email) return [];
            try {
                const res = await base44.entities.MasterProperty.filter({ created_by: user.email }, '-created_date', 1000); // reduced limit for speed
                return Array.isArray(res) ? res : (res?.items || []);
            } catch (e) {
                console.warn("Prop fetch error", e);
                return [];
            }
        },
        enabled: !!user?.email
    });

    // 4. Logs Query
    const { data: logs = [] } = useQuery({
        queryKey: ['interactionLogs', user?.email],
        queryFn: async () => {
            if (!user?.email) return [];
            try {
                const res = await base44.entities.InteractionLog.filter({ created_by: user.email }, '-created_date', 500);
                return Array.isArray(res) ? res : (res?.items || []);
            } catch (e) {
                return [];
            }
        },
        enabled: !!user?.email
    });

    // 5. Mutation
    const createLogMutation = useMutation({
        mutationFn: (logData) => base44.entities.InteractionLog.create(logData),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['interactionLogs'] }),
    });

    // 6. Logic
    const { currentRoute, nextHouse, progress, nextIdx } = useMemo(() => {
        try {
            const route = myRoutes.find(r => r.status === 'IN_PROGRESS') || myRoutes.find(r => r.status === 'ACTIVE');
            
            if (!route || !route.property_hashes) {
                return { currentRoute: null, nextHouse: null, progress: { visited: 0, total: 0, percent: 0 }, nextIdx: -1 };
            }

            // Map properties
            const rProps = route.property_hashes
                .map(hash => properties.find(p => p.address_hash === hash))
                .filter(p => !!p);
                
            const processedProps = rProps.map(p => {
                const pLogs = logs.filter(l => l.address_hash === p.address_hash);
                const latest = pLogs.sort((a,b) => new Date(b.created_date) - new Date(a.created_date))[0];
                return { ...p, effective_status: latest?.parsed_status || 'ELIGIBLE' };
            });

            const next = processedProps.find(p => p.effective_status === 'ELIGIBLE' || p.effective_status === 'NO_ANSWER');
            const visited = processedProps.filter(p => p.effective_status !== 'ELIGIBLE' && p.effective_status !== 'NO_ANSWER').length;
            const total = processedProps.length;
            
            return {
                currentRoute: route,
                nextHouse: next,
                progress: { visited, total, percent: total ? Math.round((visited/total)*100) : 0 },
                nextIdx: next ? processedProps.indexOf(next) : -1
            };
        } catch (e) {
            console.error("Logic Error", e);
            return { currentRoute: null, nextHouse: null, progress: { visited: 0, total: 0, percent: 0 }, nextIdx: -1 };
        }
    }, [myRoutes, properties, logs]);

    // 7. Loading States
    if (userLoading || (!!user && (routesLoading || propsLoading))) {
        return (
            <div className="flex h-full flex-col items-center justify-center bg-black gap-4 text-white p-6 text-center">
                <Loader2 className="h-10 w-10 animate-spin text-yellow-500" />
                <div>
                    <p className="font-bold">Loading your territory...</p>
                    <p className="text-xs text-gray-500 mt-2">
                        {userLoading && "Authenticating..."}
                        {routesLoading && "Fetching routes..."}
                        {propsLoading && "Syncing properties..."}
                    </p>
                </div>
            </div>
        );
    }

    // 8. Error States
    if (userError || routesError || propsError) {
        return (
            <div className="flex h-full flex-col items-center justify-center bg-black text-white p-6 text-center">
                <AlertCircle className="h-12 w-12 text-red-500 mb-4" />
                <h2 className="text-xl font-bold mb-2">Connection Issue</h2>
                <p className="text-gray-400 mb-6">We couldn't load your data. Please check your connection.</p>
                <Button onClick={() => window.location.reload()} variant="outline" className="border-gray-700 text-white">
                    Retry
                </Button>
            </div>
        );
    }

    if (!currentRoute) {
        return (
            <div className="flex h-full flex-col items-center justify-center bg-black p-6 text-center text-white">
                <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-yellow-500/20">
                    <Navigation className="h-10 w-10 text-yellow-500" />
                </div>
                <h2 className="mb-2 text-2xl font-bold">No Route Active</h2>
                <p className="text-gray-400 max-w-xs mx-auto">
                    You don't have an active route assigned.
                </p>
                <Button 
                    onClick={() => window.location.reload()} 
                    className="mt-6 bg-gray-800 hover:bg-gray-700"
                >
                    Refresh
                </Button>
            </div>
        );
    }

    if (!nextHouse) {
        return (
            <div className="flex h-full flex-col items-center justify-center bg-black p-6 text-center text-white">
                <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-green-500/20">
                    <CheckCircle className="h-10 w-10 text-green-500" />
                </div>
                <h2 className="mb-2 text-2xl font-bold">All Done!</h2>
                <p className="text-gray-400">You've visited all {progress.total} houses.</p>
            </div>
        );
    }

    const handleAction = (status) => {
        if (!nextHouse) return;
        createLogMutation.mutate({
            address_hash: nextHouse.address_hash,
            raw_input_text: status,
            parsed_status: status,
            gps_proof_lat: nextHouse.lat || 0,
            gps_proof_lng: nextHouse.lng || 0
        });
    };

    return (
        <div className="flex h-full flex-col bg-black text-white">
            {/* Header */}
            <div className="bg-black p-4 border-b border-gray-800">
                <div className="flex justify-between items-center mb-2">
                    <span className="text-xs font-bold text-gray-500 uppercase">Current Route</span>
                    <span className="text-xs font-bold text-gray-500">{progress.visited} / {progress.total}</span>
                </div>
                <h1 className="text-lg font-bold truncate mb-3">{currentRoute.name}</h1>
                <div className="h-1.5 w-full bg-gray-800 rounded-full overflow-hidden">
                    <div className="h-full bg-green-500 transition-all duration-500" style={{ width: `${progress.percent}%` }} />
                </div>
            </div>

            {/* Main Card */}
            <div className="flex-1 flex flex-col items-center justify-center p-6 relative">
                <div className="absolute top-0 left-0 right-0 h-32 bg-gradient-to-b from-yellow-500/10 to-transparent pointer-events-none" />
                
                <div className="flex items-center justify-center w-20 h-20 rounded-full bg-yellow-500 text-black text-3xl font-bold mb-6 shadow-[0_0_30px_rgba(255,215,0,0.3)]">
                    {nextIdx + 1}
                </div>

                <div className="text-center mb-8 space-y-1">
                    <h2 className="text-4xl font-bold tracking-tight">{nextHouse.house_number}</h2>
                    <p className="text-xl text-gray-300 font-medium">{nextHouse.street_name}</p>
                    {nextHouse.city && (
                        <div className="flex items-center justify-center gap-1.5 text-gray-500 text-sm mt-2">
                            <MapPin className="w-3 h-3" />
                            {nextHouse.city}
                        </div>
                    )}
                </div>

                <Button 
                    onClick={() => {
                        const url = `https://maps.apple.com/?daddr=${nextHouse.lat},${nextHouse.lng}`;
                        window.open(url, '_blank');
                    }}
                    className="w-full max-w-xs h-14 bg-yellow-500 hover:bg-yellow-400 text-black font-bold text-lg rounded-xl shadow-lg shadow-yellow-500/20"
                >
                    <Navigation className="w-5 h-5 mr-2" />
                    NAVIGATE
                </Button>
            </div>

            {/* Controls */}
            <div className="bg-gray-900/80 backdrop-blur-md p-4 border-t border-gray-800 pb-8">
                <p className="text-center text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-3">
                    LOG OUTCOME
                </p>
                <div className="grid grid-cols-2 gap-3 mb-3">
                    <Button onClick={() => handleAction('SOLD')} className="h-12 bg-green-600 hover:bg-green-500 font-bold text-base rounded-lg">SOLD</Button>
                    <Button onClick={() => handleAction('NO_ANSWER')} className="h-12 bg-gray-700 hover:bg-gray-600 font-bold text-base rounded-lg">NO ANSWER</Button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                    <Button onClick={() => handleAction('CALLBACK')} className="h-12 bg-yellow-600 hover:bg-yellow-500 text-black font-bold text-base rounded-lg">CALLBACK</Button>
                    <Button onClick={() => handleAction('HARD_NO')} className="h-12 bg-red-900/40 hover:bg-red-900 border border-red-900 text-red-100 font-bold text-base rounded-lg">NOT INTERESTED</Button>
                </div>
            </div>
        </div>
    );
}