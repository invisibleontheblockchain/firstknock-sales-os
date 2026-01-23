import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Loader2, Navigation, CheckCircle, Clock } from 'lucide-react';
import { determineEffectiveStatus } from '../components/logic/territoryLogic';
import { getKnockWindowLabel } from '../components/logic/knockTimeOptimizer';

const BRAND = {
    gold: '#FFD700',
    voidBlack: '#0A0A0A',
};

export default function RepHome() {
    const queryClient = useQueryClient();
    
    // Use staleTime to ensure we use cached user from Layout if available
    const { data: user } = useQuery({ 
        queryKey: ['user'], 
        queryFn: () => base44.auth.me(),
        staleTime: 1000 * 60 * 5 
    });

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
                console.error("Error fetching routes:", e);
                return [];
            }
        },
        enabled: !!user?.email
    });

    const { data: properties = [], isLoading: propsLoading } = useQuery({
        queryKey: ['masterProperties', user?.email],
        queryFn: async () => {
            if (!user?.email) return [];
            try {
                const result = await base44.entities.MasterProperty.filter({ created_by: user.email }, '-created_date', 5000);
                return Array.isArray(result) ? result : (result?.items || []);
            } catch (e) {
                console.error("Error fetching properties:", e);
                return [];
            }
        },
        enabled: !!user?.email
    });

    const { data: logsRaw = [] } = useQuery({
        queryKey: ['interactionLogs', user?.email],
        queryFn: async () => {
            if (!user?.email) return [];
            try {
                const result = await base44.entities.InteractionLog.filter({ created_by: user.email }, '-created_date', 1000);
                return Array.isArray(result) ? result : (result?.items || []);
            } catch (e) {
                console.error("Error fetching logs:", e);
                return [];
            }
        },
        enabled: !!user?.email
    });
    const logs = Array.isArray(logsRaw) ? logsRaw : (logsRaw?.items || []);

    const createLogMutation = useMutation({
        mutationFn: (logData) => base44.entities.InteractionLog.create(logData),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['interactionLogs'] });
        },
    });

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
                const propLogs = logs.filter(l => l.address_hash === p.address_hash);
                return {
                    ...p,
                    lat: parseFloat(p.lat || 0),
                    lng: parseFloat(p.lng || 0),
                    effective_status: determineEffectiveStatus(p, propLogs)
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
        return routeProperties.find(p => p.effective_status === 'ELIGIBLE');
    }, [routeProperties]);
    
    const nextIdx = nextHouse ? routeProperties.indexOf(nextHouse) : -1;

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

    // Safe knock window calculation
    const knockWindow = useMemo(() => {
        try {
            return getKnockWindowLabel(new Date());
        } catch (e) {
            return { label: 'Go Knock', color: '#22c55e' };
        }
    }, []);

    // Explicit loading state
    const isLoading = (routesLoading || propsLoading) && !!user;

    if (isLoading) {
        return (
            <div className="h-full flex items-center justify-center bg-black">
                <Loader2 className="w-10 h-10 animate-spin text-yellow-500" />
            </div>
        );
    }

    if (!currentRoute) {
        return (
            <div className="h-full flex items-center justify-center p-6 bg-black">
                <div className="text-center space-y-4">
                    <div className="w-20 h-20 bg-yellow-500/20 rounded-full flex items-center justify-center mx-auto">
                        <Navigation className="w-10 h-10 text-yellow-500" />
                    </div>
                    <h2 className="text-2xl font-bold text-white">No Route Yet</h2>
                    <p className="text-gray-400">Ask your manager to assign you a route.</p>
                </div>
            </div>
        );
    }

    // Route Complete State
    if (!nextHouse) {
        return (
            <div className="h-full flex items-center justify-center p-6 bg-black">
                <div className="text-center space-y-4">
                    <div className="w-20 h-20 bg-green-500/20 rounded-full flex items-center justify-center mx-auto">
                        <CheckCircle className="w-10 h-10 text-green-500" />
                    </div>
                    <h2 className="text-2xl font-bold text-white">Route Complete! 🎉</h2>
                    <p className="text-gray-400">Great job! You finished all {progress.total} houses.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col bg-black">
            {/* Header */}
            <div className="p-4 border-b border-gray-800">
                <div className="flex justify-between items-center">
                    <div>
                        <p className="text-xs text-gray-500">{currentRoute.name}</p>
                        <p className="text-sm text-white font-bold">{progress.visited} of {progress.total} done</p>
                    </div>
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full" style={{ background: `${knockWindow.color}20` }}>
                        <Clock className="w-4 h-4" style={{ color: knockWindow.color }} />
                        <span className="text-xs font-bold" style={{ color: knockWindow.color }}>{knockWindow.label}</span>
                    </div>
                </div>
                <div className="h-2 bg-gray-800 rounded-full mt-3 overflow-hidden">
                    <div className="h-full bg-green-500 rounded-full transition-all" style={{ width: `${progress.percent}%` }} />
                </div>
            </div>

            {/* Main Content - Next House */}
            <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
                <div className="w-24 h-24 bg-yellow-500 rounded-full flex items-center justify-center mb-6 shadow-[0_0_40px_rgba(255,215,0,0.4)]">
                    <span className="text-4xl font-bold text-black">{nextIdx + 1}</span>
                </div>
                
                <p className="text-gray-400 text-sm mb-1 uppercase tracking-widest">Next House</p>
                <h1 className="text-3xl font-bold text-white text-center mb-2 leading-tight">
                    {nextHouse.full_address || `${nextHouse.house_number} ${nextHouse.street_name}`}
                </h1>
                {nextHouse.city && (
                    <p className="text-gray-500 text-sm">{nextHouse.city}, {nextHouse.state}</p>
                )}

                <p className="text-gray-600 text-xs mt-6">
                    {routeProperties.length - progress.visited - 1} more after this
                </p>
            </div>

            {/* Bottom Actions */}
            <div className="p-4 space-y-3 pb-8">
                <Button
                    onClick={() => openInMaps(nextHouse)}
                    className="w-full h-16 text-xl font-bold rounded-2xl mb-2 hover:scale-[1.02] transition-transform"
                    style={{ background: BRAND.gold, color: '#000' }}
                >
                    <Navigation className="w-6 h-6 mr-3" />
                    NAVIGATE
                </Button>
                
                <div className="grid grid-cols-2 gap-3">
                    <Button
                        onClick={() => handleLogResult(nextHouse, 'SOLD')}
                        className="h-16 font-bold text-lg bg-green-600 hover:bg-green-500 rounded-xl"
                    >
                        ✅ SOLD
                    </Button>
                    <Button
                        onClick={() => handleLogResult(nextHouse, 'NO_ANSWER')}
                        className="h-16 font-bold text-lg bg-gray-700 hover:bg-gray-600 rounded-xl"
                    >
                        🚪 NO ONE
                    </Button>
                </div>
                
                <div className="grid grid-cols-2 gap-3">
                    <Button
                        onClick={() => handleLogResult(nextHouse, 'CALLBACK')}
                        className="h-14 font-bold bg-yellow-600 hover:bg-yellow-500 text-black rounded-xl"
                    >
                        📞 CALLBACK
                    </Button>
                    <Button
                        onClick={() => handleLogResult(nextHouse, 'HARD_NO')}
                        className="h-14 font-bold bg-red-600 hover:bg-red-500 rounded-xl"
                    >
                        ❌ NO
                    </Button>
                </div>
            </div>
        </div>
    );
}