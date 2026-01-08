import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Route, TrendingUp, MapPin, Download, Navigation, Award } from 'lucide-react';
import { generateOptimizedRoutes, exportRouteToJSON } from '../components/logic/routeOptimizer';
import { determineEffectiveStatus } from '../components/logic/territoryLogic';
import { generateGhostLeads } from '../components/logic/ghostLeadGenerator';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';

export default function RoutesPage() {
    const [housesPerRoute, setHousesPerRoute] = useState(50);
    const [selectedRoute, setSelectedRoute] = useState(null);
    
    // Fetch properties and logs
    const { data: properties, isLoading: propsLoading } = useQuery({
        queryKey: ['masterProperties'],
        queryFn: () => base44.entities.MasterProperty.list('-created_date', 5000),
        initialData: []
    });

    const { data: logs, isLoading: logsLoading } = useQuery({
        queryKey: ['interactionLogs'],
        queryFn: () => base44.entities.InteractionLog.list('-created_date', 5000),
        initialData: []
    });

    // Calculate effective status
    const effectiveProperties = useMemo(() => {
        const ghostLeads = generateGhostLeads(properties);
        const allProps = [...properties, ...ghostLeads];
        
        return allProps.map(prop => {
            const propLogs = logs.filter(l => l.address_hash === prop.address_hash);
            const status = determineEffectiveStatus(prop, propLogs);
            return { ...prop, effective_status: status };
        });
    }, [properties, logs]);

    // Generate routes
    const routes = useMemo(() => {
        if (effectiveProperties.length === 0) return [];
        return generateOptimizedRoutes(effectiveProperties, housesPerRoute);
    }, [effectiveProperties, housesPerRoute]);

    const handleExportRoute = (route) => {
        const jsonData = exportRouteToJSON(route);
        const blob = new Blob([JSON.stringify(jsonData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${route.id}_${new Date().toISOString().split('T')[0]}.json`;
        link.click();
        URL.revokeObjectURL(url);
    };

    const isLoading = propsLoading || logsLoading;

    if (isLoading) {
        return (
            <div className="h-full bg-slate-900 flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
            </div>
        );
    }

    return (
        <div className="h-full bg-slate-900 p-6 overflow-auto">
            <div className="max-w-6xl mx-auto">
                <div className="mb-6">
                    <h1 className="text-2xl font-bold text-white mb-2">Route Optimizer</h1>
                    <p className="text-slate-400 text-sm">Generate competitive door-to-door routes with AI-powered clustering</p>
                </div>

                {/* Configuration */}
                <Card className="bg-slate-800 border-slate-700 mb-6">
                    <CardHeader>
                        <CardTitle className="text-white text-lg">Route Configuration</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="flex items-end gap-4">
                            <div className="flex-1">
                                <Label className="text-slate-300 text-sm">Houses Per Route</Label>
                                <Input
                                    type="number"
                                    min="10"
                                    max="200"
                                    value={housesPerRoute}
                                    onChange={(e) => setHousesPerRoute(Number(e.target.value))}
                                    className="bg-slate-900 border-slate-700 text-white mt-1"
                                />
                            </div>
                            <div className="text-slate-400 text-sm">
                                <div className="font-medium text-white">{effectiveProperties.length} Total Properties</div>
                                <div className="text-xs">{routes.length} Routes Generated</div>
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {/* Routes Grid */}
                {routes.length === 0 ? (
                    <Card className="bg-slate-800 border-slate-700">
                        <CardContent className="py-12 text-center">
                            <MapPin className="w-12 h-12 text-slate-600 mx-auto mb-3" />
                            <p className="text-slate-400">No eligible properties to route</p>
                        </CardContent>
                    </Card>
                ) : (
                    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                        {routes.map((route) => (
                            <Card key={route.id} className="bg-slate-800 border-slate-700 hover:border-indigo-600 transition-colors">
                                <CardHeader>
                                    <div className="flex justify-between items-start mb-2">
                                        <CardTitle className="text-white text-lg">{route.name}</CardTitle>
                                        <Badge className={
                                            route.competitivenessScore >= 150 ? 'bg-green-900 text-green-200' :
                                            route.competitivenessScore >= 100 ? 'bg-yellow-900 text-yellow-200' :
                                            'bg-slate-700 text-slate-300'
                                        }>
                                            <Award className="w-3 h-3 mr-1" />
                                            {route.competitivenessScore}
                                        </Badge>
                                    </div>
                                    <CardDescription className="text-slate-400 text-xs">
                                        Competitiveness Score
                                    </CardDescription>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <div className="grid grid-cols-2 gap-3 text-sm">
                                        <div className="bg-slate-900/50 p-2 rounded">
                                            <div className="text-slate-500 text-xs">Houses</div>
                                            <div className="text-white font-bold">{route.houseCount}</div>
                                        </div>
                                        <div className="bg-slate-900/50 p-2 rounded">
                                            <div className="text-slate-500 text-xs">Distance</div>
                                            <div className="text-white font-bold">{route.totalDistance} mi</div>
                                        </div>
                                        <div className="bg-slate-900/50 p-2 rounded">
                                            <div className="text-slate-500 text-xs">Avg Score</div>
                                            <div className="text-white font-bold">{route.avgScore}</div>
                                        </div>
                                        <div className="bg-slate-900/50 p-2 rounded">
                                            <div className="text-slate-500 text-xs">Status</div>
                                            <div className="text-green-400 font-bold text-xs">READY</div>
                                        </div>
                                    </div>
                                    
                                    <div className="flex gap-2">
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            className="flex-1 bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-700 hover:text-white"
                                            onClick={() => setSelectedRoute(selectedRoute?.id === route.id ? null : route)}
                                        >
                                            <Navigation className="w-3 h-3 mr-1" />
                                            {selectedRoute?.id === route.id ? 'Hide' : 'View'}
                                        </Button>
                                        <Button
                                            size="sm"
                                            className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white"
                                            onClick={() => handleExportRoute(route)}
                                        >
                                            <Download className="w-3 h-3 mr-1" />
                                            Export
                                        </Button>
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                )}

                {/* Selected Route Details */}
                {selectedRoute && (
                    <Card className="bg-slate-800 border-slate-700 mt-6">
                        <CardHeader>
                            <CardTitle className="text-white flex items-center justify-between">
                                <span>{selectedRoute.name} - Property List</span>
                                <Badge className="bg-indigo-900 text-indigo-200">
                                    {selectedRoute.houseCount} Properties
                                </Badge>
                            </CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-2 max-h-96 overflow-y-auto">
                                {selectedRoute.properties.map((prop, idx) => (
                                    <div key={prop.address_hash} className="bg-slate-900/50 p-3 rounded flex items-center justify-between">
                                        <div className="flex items-center gap-3">
                                            <div className="w-8 h-8 bg-indigo-600 rounded-full flex items-center justify-center text-white text-xs font-bold">
                                                {idx + 1}
                                            </div>
                                            <div>
                                                <div className="text-white font-medium text-sm">{prop.full_address}</div>
                                                <div className="text-slate-400 text-xs">{prop.street_name}</div>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <Badge variant="outline" className={
                                                prop.effective_status === 'ELIGIBLE' ? 'bg-green-900/20 text-green-400 border-green-900' :
                                                prop.effective_status === 'CALLBACK' ? 'bg-yellow-900/20 text-yellow-400 border-yellow-900' :
                                                'bg-slate-700 text-slate-300 border-slate-600'
                                            }>
                                                {prop.effective_status}
                                            </Badge>
                                            {prop.is_ghost && (
                                                <Badge variant="outline" className="bg-slate-700/50 text-slate-400 border-slate-600 text-xs">
                                                    GHOST
                                                </Badge>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </CardContent>
                    </Card>
                )}

                {/* Info Card */}
                <Card className="bg-slate-800/50 border-slate-700/50 mt-6">
                    <CardContent className="py-4">
                        <div className="flex items-start gap-3">
                            <TrendingUp className="w-5 h-5 text-indigo-400 mt-0.5" />
                            <div className="text-xs text-slate-400">
                                <div className="font-medium text-slate-300 mb-1">Route Optimization Algorithm</div>
                                Routes are generated using K-means clustering for geographic grouping, nearest neighbor TSP for order optimization, and weighted scoring based on property status and density. Higher competitiveness scores indicate more valuable routes with better efficiency.
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}