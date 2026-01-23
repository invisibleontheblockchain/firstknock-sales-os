import React, { useState, useMemo, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Loader2, Navigation, CheckCircle, Clock, MapPin, AlertCircle } from 'lucide-react';

export default function RepHome() {
    const queryClient = useQueryClient();
    const [error, setError] = useState(null);
    
    // 1. User Query - Safe
    const { data: user, isLoading: userLoading } = useQuery({ 
        queryKey: ['user'], 
        queryFn: () => base44.auth.me().catch(e => null),
        staleTime: 1000 * 60 * 5 // 5 minutes
    });

    // 2. Routes Query - Safe
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
                console.error("Route fetch failed", e);
                return [];
            }
        },
        enabled: !!user?.email
    });

    // 3. Properties Query - Safe
    const { data: properties = [], isLoading: propsLoading } = useQuery({
        queryKey: ['masterProperties', user?.email],
        queryFn: async () => {
            if (!user?.email) return [];
            try {
                const result = await base44.entities.MasterProperty.filter({ created_by: user.email }, '-created_date', 5000);
                return Array.isArray(result) ? result : (result?.items || []);
            } catch (e) {
                console.error("Property fetch failed", e);
                return [];
            }
        },
        enabled: !!user?.email
    });

    // 4. Logs Query - Safe
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

    // 5. Mutation - Safe
    const createLogMutation = useMutation({
        mutationFn: async (logData) => {
            try {
                return await base44.entities.InteractionLog.create(logData);
            } catch (e) {
                console.error("Log creation failed", e);
                throw e;
            }
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['interactionLogs'] });
        },
    });

    // 6. Logic - Safe with Try/Catch inside Memo
    const { currentRoute, routeProperties, progress, nextHouse, nextIdx } = useMemo(() => {
        try {
            const route = myRoutesRaw.find(r => r.status === 'IN_PROGRESS') || myRoutesRaw.find(r => r.status === 'ACTIVE');
            
            if (!route || !route.property_hashes) {
                return { currentRoute: null, routeProperties: [], progress: { visited: 0, total: 0, percent: 0 }, nextHouse: null, nextIdx: -1 };
            }

            const rProps = route.property_hashes
                .map(hash => properties.find(p => p.address_hash === hash))
                .filter(p => !!p)
                .map(p => {
                    const propLogs = logs.filter(l => l.address_hash === p.address_hash);
                    let status = 'ELIGIBLE';
                    if (propLogs.length > 0) {
                        const latest = propLogs.sort((a, b) => new Date(b.created_date) - new Date(a.created_date))[0];
                        status = latest.parsed_status || 'ELIGIBLE';
                    }
                    return { ...p, effective_status: status };
                });

            const total = rProps.length;
            const visited = rProps.filter(p => p.effective_status !== 'ELIGIBLE' && p.effective_status !== 'NO_ANSWER').length;
            const percent = total > 0 ? Math.round((visited / total) * 100) : 0;
            
            const next = rProps.find(p => p.effective_status === 'ELIGIBLE' || p.effective_status === 'NO_ANSWER');
            const idx = next ? rProps.indexOf(next) : -1;

            return { currentRoute: route, routeProperties: rProps, progress: { visited, total, percent }, nextHouse: next, nextIdx: idx };
        } catch (e) {
            console.error("Logic error", e);
            return { currentRoute: null, routeProperties: [], progress: { visited: 0, total: 0, percent: 0 }, nextHouse: null, nextIdx: -1 };
        }
    }, [myRoutesRaw, properties, logs]);

    const handleLogResult = (property, status) => {
        if (!property) return;
        createLogMutation.mutate({
            address_hash: property.address_hash,
            raw_input_text: status,
            parsed_status: status,
            gps_proof_lat: parseFloat(property.lat || 0),
            gps_proof_lng: parseFloat(property.lng || 0)
        });
    };

    const openInMaps = (property) => {
        if (!property) return;
        const url = `https://maps.apple.com/?daddr=${property.lat},${property.lng}`;
        window.open(url, '_blank');
    };

    // 7. Loading State
    if (userLoading) {
        return (
            <div className="flex h-full items-center justify-center bg-black">
                <Loader2 className="h-8 w-8 animate-spin text-yellow-500" />
            </div>
        );
    }

    // 8. No Route State
    if (!currentRoute) {
        return (
            <div className="flex h-full flex-col items-center justify-center bg-black p-6 text-center">
                <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-yellow-500/20">
                    <Navigation className="h-10 w-10 text-yellow-500" />
                </div>
                <h2 className="mb-2 text-2xl font-bold text-white">No Route Active</h2>
                <p className="text-gray-400">Please ask your manager to assign a route.</p>
            </div>
        );
    }

    // 9. Route Complete State
    if (!nextHouse) {
        return (
            <div className="flex h-full flex-col items-center justify-center bg-black p-6 text-center">
                <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-green-500/20">
                    <CheckCircle className="h-10 w-10 text-green-500" />
                </div>
                <h2 className="mb-2 text-2xl font-bold text-white">Route Complete!</h2>
                <p className="text-gray-400">You finished {progress.total} houses.</p>
            </div>
        );
    }

    // 10. Main Render
    return (
        <div className="flex h-full flex-col bg-black text-white">
            {/* Header */}
            <div className="border-b border-gray-800 bg-black p-4">
                <div className="mb-3 flex items-center justify-between">
                    <div>
                        <p className="text-xs font-bold text-gray-500 uppercase tracking-wider">Current Route</p>
                        <p className="text-lg font-bold">{currentRoute.name}</p>
                    </div>
                    <div className="text-right">
                        <p className="text-2xl font-bold text-yellow-500">{progress.visited}<span className="text-base text-gray-600">/{progress.total}</span></p>
                    </div>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-gray-800">
                    <div className="h-full bg-green-500 transition-all" style={{ width: `${progress.percent}%` }} />
                </div>
            </div>

            {/* Content */}
            <div className="relative flex flex-1 flex-col items-center justify-center p-6">
                <div className="mb-8 flex h-24 w-24 items-center justify-center rounded-full bg-yellow-500 shadow-lg shadow-yellow-500/20">
                    <span className="text-4xl font-bold text-black">{nextIdx + 1}</span>
                </div>

                <div className="mb-8 text-center">
                    <h2 className="text-3xl font-bold leading-tight mb-2">
                        {nextHouse.house_number} {nextHouse.street_name}
                    </h2>
                    {nextHouse.city && (
                        <div className="flex items-center justify-center text-gray-400 gap-2">
                            <MapPin className="h-4 w-4" />
                            <span>{nextHouse.city}</span>
                        </div>
                    )}
                </div>

                <Button 
                    onClick={() => openInMaps(nextHouse)}
                    className="h-16 w-full max-w-sm rounded-2xl bg-yellow-500 text-xl font-bold text-black hover:bg-yellow-400"
                >
                    <Navigation className="mr-3 h-6 w-6" />
                    NAVIGATE
                </Button>
            </div>

            {/* Actions */}
            <div className="border-t border-gray-800 bg-gray-900/50 p-4 backdrop-blur-sm">
                <div className="mb-3 grid grid-cols-2 gap-3">
                    <Button onClick={() => handleLogResult(nextHouse, 'SOLD')} className="h-14 rounded-xl bg-green-600 text-lg font-bold hover:bg-green-500">
                        SOLD
                    </Button>
                    <Button onClick={() => handleLogResult(nextHouse, 'NO_ANSWER')} className="h-14 rounded-xl bg-gray-700 text-lg font-bold hover:bg-gray-600">
                        NO ANSWER
                    </Button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                    <Button onClick={() => handleLogResult(nextHouse, 'CALLBACK')} className="h-12 rounded-xl bg-yellow-600 font-bold text-black hover:bg-yellow-500">
                        CALLBACK
                    </Button>
                    <Button onClick={() => handleLogResult(nextHouse, 'HARD_NO')} className="h-12 rounded-xl border border-red-800 bg-red-900/50 font-bold text-red-200 hover:bg-red-900">
                        NO
                    </Button>
                </div>
            </div>
        </div>
    );
}