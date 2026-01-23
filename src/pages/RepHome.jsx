import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Loader2, Navigation, CheckCircle, Clock, MapPin } from 'lucide-react';

// Brand constants
const BRAND = {
    gold: '#FFD700',
    black: '#0A0A0A',
};

export default function RepHome() {
    const queryClient = useQueryClient();
    
    // User Query
    const { data: user, isLoading: userLoading } = useQuery({ 
        queryKey: ['user'], 
        queryFn: () => base44.auth.me(),
        retry: false
    });

    // Routes Query
    const { data: myRoutesRaw = [], isLoading: routesLoading } = useQuery({
        queryKey: ['myRoutes', user?.email],
        queryFn: async () => {
            if (!user?.email) return [];
            try {
                const all = await base44.entities.SavedRoute.list('-created_date', 100);
                const routes = Array.isArray(all) ? all : (all?.items || []);
                return routes.filter(r => 
                    r.assigned_to_name === user.email || 
                    r.assigned_to === user.id ||
                    (!r.assigned_to && r.status === 'ACTIVE')
                );
            } catch (e) {
                console.error("Fetch routes error", e);
                return [];
            }
        },
        enabled: !!user?.email
    });

    // Properties Query
    const { data: properties = [], isLoading: propsLoading } = useQuery({
        queryKey: ['masterProperties', user?.email],
        queryFn: async () => {
            if (!user?.email) return [];
            try {
                const result = await base44.entities.MasterProperty.filter({ created_by: user.email }, '-created_date', 5000);
                return Array.isArray(result) ? result : (result?.items || []);
            } catch (e) {
                console.error("Fetch properties error", e);
                return [];
            }
        },
        enabled: !!user?.email
    });

    // Logs Query
    const { data: logsRaw = [] } = useQuery({
        queryKey: ['interactionLogs', user?.email],
        queryFn: async () => {
            if (!user?.email) return [];
            try {
                const result = await base44.entities.InteractionLog.filter({ created_by: user.email }, '-created_date', 1000);
                return Array.isArray(result) ? result : (result?.items || []);
            } catch (e) {
                return [];
            }
        },
        enabled: !!user?.email
    });
    const logs = Array.isArray(logsRaw) ? logsRaw : (logsRaw?.items || []);

    // Mutation
    const createLogMutation = useMutation({
        mutationFn: (logData) => base44.entities.InteractionLog.create(logData),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['interactionLogs'] });
        },
    });

    // Derived State
    const currentRoute = useMemo(() => {
        if (!myRoutesRaw.length) return null;
        return myRoutesRaw.find(r => r.status === 'IN_PROGRESS') || myRoutesRaw.find(r => r.status === 'ACTIVE');
    }, [myRoutesRaw]);

    const routeProperties = useMemo(() => {
        if (!currentRoute?.property_hashes) return [];
        if (!properties.length) return [];
        
        return currentRoute.property_hashes
            .map(hash => properties.find(p => p.address_hash === hash))
            .filter(p => !!p)
            .map(p => {
                // Inline status logic to prevent import crashes
                const propLogs = logs.filter(l => l.address_hash === p.address_hash);
                let status = 'ELIGIBLE';
                if (propLogs.length > 0) {
                    const latest = propLogs.sort((a, b) => new Date(b.created_date) - new Date(a.created_date))[0];
                    status = latest.parsed_status || 'ELIGIBLE';
                }
                
                return {
                    ...p,
                    lat: parseFloat(p.lat || 0),
                    lng: parseFloat(p.lng || 0),
                    effective_status: status
                };
            });
    }, [currentRoute, properties, logs]);

    const progress = useMemo(() => {
        const total = routeProperties.length;
        const visited = routeProperties.filter(p => 
            p.effective_status !== 'ELIGIBLE' && p.effective_status !== 'NO_ANSWER'
        ).length;
        return { total, visited, percent: total > 0 ? Math.round((visited / total) * 100) : 0 };
    }, [routeProperties]);

    const nextHouse = useMemo(() => {
        return routeProperties.find(p => p.effective_status === 'ELIGIBLE' || p.effective_status === 'NO_ANSWER');
    }, [routeProperties]);
    
    const nextIdx = nextHouse ? routeProperties.indexOf(nextHouse) : -1;

    // Handlers
    const handleLogResult = (property, status) => {
        if (!property) return;
        createLogMutation.mutate({
            address_hash: property.address_hash,
            raw_input_text: status,
            parsed_status: status,
            gps_proof_lat: property.lat,
            gps_proof_lng: property.lng
        });
    };

    const openInMaps = (property) => {
        if (!property) return;
        const url = `https://maps.apple.com/?daddr=${property.lat},${property.lng}`;
        window.open(url, '_blank');
    };

    // Rendering
    if (userLoading || (!!user && (routesLoading || propsLoading))) {
        return (
            <div className="h-full flex flex-col items-center justify-center bg-black text-white">
                <Loader2 className="w-10 h-10 animate-spin text-yellow-500 mb-4" />
                <p className="text-gray-400">Loading Route...</p>
            </div>
        );
    }

    if (!user) {
        return null; // Layout handles redirect
    }

    if (!currentRoute) {
        return (
            <div className="h-full flex flex-col items-center justify-center p-6 bg-black text-white">
                <div className="w-20 h-20 bg-yellow-500/20 rounded-full flex items-center justify-center mb-6">
                    <Navigation className="w-10 h-10 text-yellow-500" />
                </div>
                <h2 className="text-2xl font-bold mb-2">No Route Assigned</h2>
                <p className="text-gray-400 text-center max-w-xs">
                    Please ask your manager to assign a route to you.
                </p>
                <Button 
                    onClick={() => window.location.reload()}
                    className="mt-6 bg-gray-800"
                >
                    Refresh
                </Button>
            </div>
        );
    }

    if (!nextHouse) {
        return (
            <div className="h-full flex flex-col items-center justify-center p-6 bg-black text-white">
                <div className="w-20 h-20 bg-green-500/20 rounded-full flex items-center justify-center mb-6">
                    <CheckCircle className="w-10 h-10 text-green-500" />
                </div>
                <h2 className="text-2xl font-bold mb-2">Route Complete!</h2>
                <p className="text-gray-400 text-center">
                    You've visited all {routeProperties.length} houses. Great job!
                </p>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col bg-black text-white overflow-hidden">
            {/* Header */}
            <div className="px-6 py-4 border-b border-gray-800 bg-black">
                <div className="flex justify-between items-center mb-3">
                    <div>
                        <h3 className="text-sm font-bold text-gray-400 tracking-wider">CURRENT ROUTE</h3>
                        <p className="text-lg font-bold truncate max-w-[200px]">{currentRoute.name}</p>
                    </div>
                    <div className="text-right">
                        <p className="text-2xl font-bold text-yellow-500">{progress.visited}<span className="text-gray-600 text-lg">/{progress.total}</span></p>
                    </div>
                </div>
                <div className="w-full bg-gray-800 h-2 rounded-full overflow-hidden">
                    <div 
                        className="bg-green-500 h-full transition-all duration-500" 
                        style={{ width: `${progress.percent}%` }}
                    />
                </div>
            </div>

            {/* Main Content */}
            <div className="flex-1 flex flex-col items-center justify-center p-6 relative">
                <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-yellow-500/5 via-transparent to-transparent pointer-events-none" />
                
                <div className="relative z-10 text-center w-full max-w-md">
                    <div className="inline-flex items-center justify-center w-24 h-24 rounded-full bg-yellow-500 text-black text-4xl font-bold mb-8 shadow-[0_0_50px_rgba(255,215,0,0.3)]">
                        {nextIdx + 1}
                    </div>

                    <div className="space-y-2 mb-8">
                        <h2 className="text-3xl font-bold leading-tight">
                            {nextHouse.house_number} {nextHouse.street_name}
                        </h2>
                        {nextHouse.city && (
                            <div className="flex items-center justify-center text-gray-400 gap-1">
                                <MapPin className="w-4 h-4" />
                                <span>{nextHouse.city}</span>
                            </div>
                        )}
                    </div>

                    <Button 
                        onClick={() => openInMaps(nextHouse)}
                        className="w-full h-16 text-xl font-bold bg-yellow-500 hover:bg-yellow-400 text-black rounded-2xl shadow-lg shadow-yellow-500/20 transition-all hover:scale-[1.02]"
                    >
                        <Navigation className="w-6 h-6 mr-3" />
                        NAVIGATE
                    </Button>
                </div>
            </div>

            {/* Action Grid */}
            <div className="p-4 bg-gray-900/50 border-t border-gray-800 backdrop-blur-sm">
                <p className="text-center text-gray-500 text-xs font-bold mb-3 uppercase tracking-widest">Log Outcome</p>
                <div className="grid grid-cols-2 gap-3 mb-3">
                    <Button
                        onClick={() => handleLogResult(nextHouse, 'SOLD')}
                        className="h-14 bg-green-600 hover:bg-green-500 text-white font-bold text-lg rounded-xl"
                    >
                        SOLD
                    </Button>
                    <Button
                        onClick={() => handleLogResult(nextHouse, 'NO_ANSWER')}
                        className="h-14 bg-gray-700 hover:bg-gray-600 text-white font-bold text-lg rounded-xl"
                    >
                        NO ANSWER
                    </Button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                    <Button
                        onClick={() => handleLogResult(nextHouse, 'CALLBACK')}
                        className="h-12 bg-yellow-600 hover:bg-yellow-500 text-black font-bold rounded-xl"
                    >
                        CALLBACK
                    </Button>
                    <Button
                        onClick={() => handleLogResult(nextHouse, 'HARD_NO')}
                        className="h-12 bg-red-900/50 hover:bg-red-900 text-red-200 border border-red-800 font-bold rounded-xl"
                    >
                        NOT INTERESTED
                    </Button>
                </div>
            </div>
        </div>
    );
}