import React, { useState, useMemo, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Download, Award, Navigation, Map } from 'lucide-react';
import { getEffectiveStatus } from '../components/logic/resultParser';
import { generateRoutes, getGoogleMapsUrl, exportRouteJSON } from '../components/logic/routeOptimizer';
import RouteMap from '../components/map/RouteMap';

export default function Routes() {
    const [housesPerRoute, setHousesPerRoute] = useState(50);
    const [selectedRoute, setSelectedRoute] = useState(null);
    const [routes, setRoutes] = useState([]);
    const [generating, setGenerating] = useState(false);
    
    const { data: properties = [], isLoading: propsLoading } = useQuery({
        queryKey: ['properties'],
        queryFn: () => base44.entities.MasterProperty.list('-created_date', 5000)
    });
    
    const { data: results = [], isLoading: resultsLoading } = useQuery({
        queryKey: ['results'],
        queryFn: () => base44.entities.DailyResult.list('-created_date', 5000)
    });
    
    // Calculate effective status
    const enhancedProperties = useMemo(() => {
        return properties
            .filter(p => p.lat && p.lng && !isNaN(p.lat) && !isNaN(p.lng))
            .map(prop => {
                const propResults = results.filter(r => r.address_hash === prop.address_hash);
                return { ...prop, effective_status: getEffectiveStatus(prop, propResults) };
            });
    }, [properties, results]);
    
    // Generate routes with debounce
    useEffect(() => {
        if (enhancedProperties.length === 0) {
            setRoutes([]);
            return;
        }
        
        setGenerating(true);
        const timer = setTimeout(() => {
            try {
                const generated = generateRoutes(enhancedProperties, housesPerRoute);
                setRoutes(generated);
            } catch (err) {
                console.error('Route error:', err);
                setRoutes([]);
            }
            setGenerating(false);
        }, 500);
        
        return () => clearTimeout(timer);
    }, [enhancedProperties.length, housesPerRoute]);
    
    const handleExport = (route) => {
        const json = exportRouteJSON(route);
        const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${route.id}.json`;
        a.click();
        URL.revokeObjectURL(url);
    };
    
    const isLoading = propsLoading || resultsLoading;
    
    if (isLoading) {
        return (
            <div className="h-full bg-slate-900 flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
            </div>
        );
    }
    
    return (
        <div className="h-full bg-slate-900 flex flex-col">
            {/* Header */}
            <div className="p-4 border-b border-slate-700">
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-lg font-bold text-white flex items-center gap-2">
                            Route Optimizer
                            {generating && <Loader2 className="w-4 h-4 animate-spin" />}
                        </h1>
                        <p className="text-xs text-slate-400">{enhancedProperties.length} properties → {routes.length} routes</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Label className="text-slate-400 text-xs">Houses</Label>
                        <Input
                            type="number"
                            min="10"
                            max="200"
                            value={housesPerRoute}
                            onChange={(e) => setHousesPerRoute(Number(e.target.value))}
                            className="w-16 bg-slate-800 border-slate-700 text-white h-8 text-sm"
                        />
                    </div>
                </div>
            </div>
            
            {routes.length === 0 ? (
                <div className="flex-1 flex items-center justify-center">
                    <div className="text-center text-slate-500">
                        <Navigation className="w-12 h-12 mx-auto mb-2 opacity-50" />
                        <p className="text-sm">No eligible properties to route</p>
                    </div>
                </div>
            ) : (
                <div className="flex-1 flex overflow-hidden">
                    {/* Map */}
                    <div className="flex-1">
                        <RouteMap route={selectedRoute} colorIndex={routes.findIndex(r => r.id === selectedRoute?.id)} />
                    </div>
                    
                    {/* Sidebar */}
                    <div className="w-72 bg-slate-800 border-l border-slate-700 overflow-y-auto">
                        <div className="p-3 space-y-2">
                            {routes.map((route, idx) => (
                                <Card 
                                    key={route.id}
                                    className={`bg-slate-900 border-slate-700 cursor-pointer transition-all ${
                                        selectedRoute?.id === route.id ? 'border-indigo-500 shadow-lg shadow-indigo-500/20' : 'hover:border-slate-600'
                                    }`}
                                    onClick={() => setSelectedRoute(selectedRoute?.id === route.id ? null : route)}
                                >
                                    <CardHeader className="p-3 pb-2">
                                        <div className="flex items-center justify-between">
                                            <CardTitle className="text-white text-sm">{route.name}</CardTitle>
                                            <Badge className={
                                                route.competitiveness >= 100 ? 'bg-green-900 text-green-200' :
                                                route.competitiveness >= 60 ? 'bg-yellow-900 text-yellow-200' :
                                                'bg-slate-700 text-slate-300'
                                            }>
                                                <Award className="w-3 h-3 mr-1" />
                                                {route.competitiveness}
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
                                                <div className="text-white font-bold">{route.distance}</div>
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
                                                onClick={(e) => { e.stopPropagation(); handleExport(route); }}
                                            >
                                                <Download className="w-3 h-3 mr-1" />
                                                JSON
                                            </Button>
                                            <Button
                                                size="sm"
                                                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white h-7 text-xs"
                                                onClick={(e) => { e.stopPropagation(); window.open(getGoogleMapsUrl(route), '_blank'); }}
                                            >
                                                <Map className="w-3 h-3 mr-1" />
                                                Maps
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