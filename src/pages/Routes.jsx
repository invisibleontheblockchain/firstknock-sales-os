import React, { useState, useMemo, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, MapPin, Download, Award, ExternalLink, Map } from 'lucide-react';
import { generateOptimizedRoutes, exportRouteToJSON, generateGoogleMapsUrl } from '../components/logic/routeOptimizer';
import { determineEffectiveStatus } from '../components/logic/territoryLogic';
import { generateGhostLeads } from '../components/logic/ghostLeadGenerator';
import RouteMapPreview from '../components/routes/RouteMapPreview';

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

    // Calculate effective status - LIMIT to 2000 properties max for performance
    const effectiveProperties = useMemo(() => {
        const limited = properties.slice(0, 2000);
        return limited
            .filter(prop => prop.lat && prop.lng)
            .map(prop => {
                const propLogs = logs.filter(l => l.address_hash === prop.address_hash);
                const status = determineEffectiveStatus(prop, propLogs);
                return { ...prop, effective_status: status };
            });
    }, [properties, logs]);

    // Generate routes - debounced and limited
    const [routes, setRoutes] = useState([]);
    const [generating, setGenerating] = useState(false);

    useEffect(() => {
        if (effectiveProperties.length === 0) {
            setRoutes([]);
            return;
        }

        setGenerating(true);
        const timer = setTimeout(() => {
            try {
                // Limit to max 20 routes to prevent crash
                const maxRoutes = Math.min(20, Math.ceil(effectiveProperties.length / housesPerRoute));
                const limitedProps = effectiveProperties.slice(0, maxRoutes * housesPerRoute);
                const generated = generateOptimizedRoutes(limitedProps, housesPerRoute);
                setRoutes(generated);
            } catch (error) {
                console.error('Route generation error:', error);
                setRoutes([]);
            }
            setGenerating(false);
        }, 500);

        return () => clearTimeout(timer);
    }, [effectiveProperties.length, housesPerRoute]);

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

    const isLoading = propsLoading || logsLoading || generating;

    if (propsLoading || logsLoading) {
        return (
            <div className="h-full bg-slate-900 flex items-center justify-center">
                <div className="text-center">
                    <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-2" />
                    <p className="text-slate-400 text-sm">Loading properties...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="h-full bg-slate-900 flex flex-col">
            {/* Header */}
            <div className="p-4 border-b border-slate-700">
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-xl font-bold text-white flex items-center gap-2">
                            Route Optimizer
                            {generating && <Loader2 className="w-4 h-4 animate-spin" />}
                        </h1>
                        <p className="text-slate-400 text-xs">{effectiveProperties.length} properties → {routes.length} optimized routes</p>
                    </div>
                    <div className="flex items-center gap-3">
                        <Label className="text-slate-400 text-xs">Houses/Route</Label>
                        <Input
                            type="number"
                            min="10"
                            max="200"
                            value={housesPerRoute}
                            onChange={(e) => setHousesPerRoute(Number(e.target.value))}
                            className="w-20 bg-slate-800 border-slate-700 text-white h-8"
                        />
                    </div>
                </div>
            </div>

            {routes.length === 0 ? (
                <div className="flex-1 flex items-center justify-center">
                    <div className="text-center">
                        <MapPin className="w-12 h-12 text-slate-600 mx-auto mb-3" />
                        <p className="text-slate-400">No eligible properties to route</p>
                    </div>
                </div>
            ) : (
                <div className="flex-1 flex overflow-hidden">
                    {/* Map Preview */}
                    <div className="flex-1 relative">
                        <RouteMapPreview routes={routes} selectedRouteId={selectedRoute?.id} />
                    </div>

                    {/* Routes Sidebar */}
                    <div className="w-80 bg-slate-800 border-l border-slate-700 overflow-y-auto">
                        <div className="p-4 space-y-3">
                            {routes.map((route, idx) => (
                                <Card 
                                    key={route.id} 
                                    className={`bg-slate-900 border-slate-700 cursor-pointer transition-all ${
                                        selectedRoute?.id === route.id ? 'border-indigo-500 shadow-lg shadow-indigo-500/20' : 'hover:border-slate-600'
                                    }`}
                                    onClick={() => setSelectedRoute(selectedRoute?.id === route.id ? null : route)}
                                >
                                    <CardHeader className="p-3">
                                        <div className="flex items-center justify-between">
                                            <CardTitle className="text-white text-sm font-bold">{route.name}</CardTitle>
                                            <Badge className={
                                                route.competitivenessScore >= 150 ? 'bg-green-900 text-green-200' :
                                                route.competitivenessScore >= 100 ? 'bg-yellow-900 text-yellow-200' :
                                                'bg-slate-700 text-slate-300'
                                            }>
                                                <Award className="w-3 h-3 mr-1" />
                                                {route.competitivenessScore}
                                            </Badge>
                                        </div>
                                    </CardHeader>
                                    <CardContent className="p-3 pt-0 space-y-2">
                                        <div className="grid grid-cols-3 gap-2 text-xs">
                                            <div>
                                                <div className="text-slate-500">Houses</div>
                                                <div className="text-white font-bold">{route.houseCount}</div>
                                            </div>
                                            <div>
                                                <div className="text-slate-500">Miles</div>
                                                <div className="text-white font-bold">{route.totalDistance}</div>
                                            </div>
                                            <div>
                                                <div className="text-slate-500">Score</div>
                                                <div className="text-white font-bold">{route.avgScore}</div>
                                            </div>
                                        </div>
                                        
                                        <div className="flex gap-2">
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                className="flex-1 bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700 h-7 text-xs"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleExportRoute(route);
                                                }}
                                            >
                                                <Download className="w-3 h-3 mr-1" />
                                                JSON
                                            </Button>
                                            <Button
                                                size="sm"
                                                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white h-7 text-xs"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    window.open(generateGoogleMapsUrl(route), '_blank');
                                                }}
                                            >
                                                <Map className="w-3 h-3 mr-1" />
                                                Google Maps
                                            </Button>
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}