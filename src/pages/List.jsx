import React, { useState, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from "@tanstack/react-query";
import { Loader2, MapPin, Search, Navigation, ChevronRight, BarChart3 } from 'lucide-react';
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { determineEffectiveStatus } from '../components/logic/territoryLogic';
import { generateOptimizedRoutes } from '../components/logic/routeOptimizer';

const BRAND = {
    voidBlack: '#0A0A0A',
    gold: '#FFD700',
    charcoal: '#1F1F1F',
    offWhite: '#E5E5E5'
};

const ROUTE_SIZE_OPTIONS = [25, 50, 75, 100];

export default function ListPage() {
    const [searchTerm, setSearchTerm] = useState("");
    const [view, setView] = useState('routes'); // 'routes' or 'properties'
    const [selectedSize, setSelectedSize] = useState(50);
    
    const { data: properties = [], isLoading: propsLoading } = useQuery({
        queryKey: ['masterProperties'],
        queryFn: () => base44.entities.MasterProperty.list('-created_date', 5000),
    });

    const { data: logs = [], isLoading: logsLoading } = useQuery({
        queryKey: ['interactionLogs'],
        queryFn: () => base44.entities.InteractionLog.list('-created_date', 10000),
    });

    const effectiveProperties = useMemo(() => {
        return properties
            .filter(p => p?.lat && p?.lng && !isNaN(p.lat) && !isNaN(p.lng))
            .map(p => {
                const propLogs = logs.filter(l => l.address_hash === p.address_hash);
                return {
                    ...p,
                    lat: parseFloat(p.lat),
                    lng: parseFloat(p.lng),
                    effective_status: determineEffectiveStatus(p, propLogs)
                };
            });
    }, [properties, logs]);

    // Generate routes for selected size
    const routes = useMemo(() => {
        if (effectiveProperties.length === 0) return [];
        return generateOptimizedRoutes(effectiveProperties, selectedSize);
    }, [effectiveProperties, selectedSize]);

    const filteredProperties = properties.filter(p => 
        p.full_address?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        p.street_name?.toLowerCase().includes(searchTerm.toLowerCase())
    );

    const isLoading = propsLoading || logsLoading;

    return (
        <div className="h-full flex flex-col" style={{ background: BRAND.voidBlack }}>
            {/* Header */}
            <div className="p-4 border-b sticky top-0 z-10" style={{ background: BRAND.voidBlack, borderColor: BRAND.charcoal }}>
                <div className="flex gap-2 mb-4">
                    <button
                        onClick={() => setView('routes')}
                        className="flex-1 py-3 rounded-lg font-bold tracking-wide transition-all"
                        style={{ 
                            background: view === 'routes' ? BRAND.gold : BRAND.charcoal,
                            color: view === 'routes' ? BRAND.voidBlack : BRAND.offWhite
                        }}
                    >
                        <Navigation className="w-4 h-4 inline mr-2" />
                        ROUTES
                    </button>
                    <button
                        onClick={() => setView('properties')}
                        className="flex-1 py-3 rounded-lg font-bold tracking-wide transition-all"
                        style={{ 
                            background: view === 'properties' ? BRAND.gold : BRAND.charcoal,
                            color: view === 'properties' ? BRAND.voidBlack : BRAND.offWhite
                        }}
                    >
                        <MapPin className="w-4 h-4 inline mr-2" />
                        PROPERTIES
                    </button>
                </div>

                {view === 'routes' && (
                    <div>
                        <p className="text-xs font-bold tracking-wide mb-2" style={{ color: '#888' }}>ROUTE SIZE</p>
                        <div className="flex gap-2">
                            {ROUTE_SIZE_OPTIONS.map(size => (
                                <button
                                    key={size}
                                    onClick={() => setSelectedSize(size)}
                                    className="flex-1 py-2 rounded-lg text-sm font-bold tracking-wide transition-all"
                                    style={{ 
                                        background: selectedSize === size ? BRAND.gold : BRAND.charcoal,
                                        color: selectedSize === size ? BRAND.voidBlack : BRAND.offWhite
                                    }}
                                >
                                    {size}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {view === 'properties' && (
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4" style={{ color: '#666' }} />
                        <Input 
                            placeholder="Search addresses..." 
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="pl-9"
                            style={{ background: BRAND.charcoal, borderColor: '#333', color: BRAND.offWhite }}
                        />
                    </div>
                )}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-auto p-4 space-y-3">
                {isLoading ? (
                    <div className="flex justify-center p-8">
                        <Loader2 className="w-8 h-8 animate-spin" style={{ color: BRAND.gold }} />
                    </div>
                ) : view === 'routes' ? (
                    <>
                        <div className="mb-4 p-3 rounded-lg" style={{ background: BRAND.charcoal }}>
                            <p className="text-xs" style={{ color: '#888' }}>
                                {effectiveProperties.length.toLocaleString()} properties → {routes.length} routes of ~{selectedSize} homes
                            </p>
                        </div>
                        
                        {routes.length === 0 ? (
                            <p className="text-center py-8" style={{ color: '#888' }}>No routes available</p>
                        ) : (
                            routes.map((route, idx) => (
                                <Card 
                                    key={route.id} 
                                    className="p-4 cursor-pointer transition-all hover:opacity-90"
                                    style={{ background: BRAND.charcoal, borderColor: '#333', borderLeft: `3px solid ${BRAND.gold}` }}
                                >
                                    <div className="flex justify-between items-start mb-3">
                                        <div>
                                            <h3 className="font-bold" style={{ color: BRAND.offWhite }}>{route.name}</h3>
                                            <p className="text-xs mt-1" style={{ color: '#888' }}>
                                                {route.houseCount} homes • {route.totalDistance} mi
                                            </p>
                                        </div>
                                        <Badge style={{ 
                                            background: route.competitivenessScore >= 150 ? '#22c55e' : route.competitivenessScore >= 100 ? '#eab308' : '#666',
                                            color: '#000'
                                        }}>
                                            {route.competitivenessScore}
                                        </Badge>
                                    </div>
                                    
                                    <div className="flex gap-4 text-xs mb-3" style={{ color: '#666' }}>
                                        <span>Avg Score: {route.avgScore}</span>
                                        <span>Total: {route.totalScore}</span>
                                    </div>

                                    <div className="flex gap-2">
                                        <Link 
                                            to={`${createPageUrl('Home')}?route=${idx}&size=${selectedSize}`}
                                            className="flex-1"
                                        >
                                            <Button 
                                                className="w-full h-10 font-bold tracking-wide"
                                                style={{ background: BRAND.gold, color: BRAND.voidBlack }}
                                            >
                                                <Navigation className="w-4 h-4 mr-2" />
                                                VIEW ON MAP
                                            </Button>
                                        </Link>
                                        <Button 
                                            variant="outline"
                                            className="h-10"
                                            style={{ borderColor: '#333', color: BRAND.offWhite }}
                                            onClick={() => {
                                                const props = route.properties.slice(0, 10);
                                                const origin = props[0];
                                                const dest = props[props.length - 1];
                                                const waypoints = props.slice(1, -1).map(p => `${p.lat},${p.lng}`).join('|');
                                                let url = `https://www.google.com/maps/dir/?api=1&origin=${origin.lat},${origin.lng}&destination=${dest.lat},${dest.lng}&travelmode=walking`;
                                                if (waypoints) url += `&waypoints=${waypoints}`;
                                                window.open(url, '_blank');
                                            }}
                                        >
                                            <MapPin className="w-4 h-4" />
                                        </Button>
                                    </div>
                                </Card>
                            ))
                        )}
                    </>
                ) : (
                    <>
                        {filteredProperties.length === 0 ? (
                            <div className="text-center py-10" style={{ color: '#888' }}>
                                No properties found
                            </div>
                        ) : (
                            filteredProperties.map(prop => (
                                <Card key={prop.id} className="p-4" style={{ background: BRAND.charcoal, borderColor: '#333' }}>
                                    <div className="flex justify-between items-start">
                                        <div>
                                            <h3 className="font-semibold" style={{ color: BRAND.offWhite }}>{prop.full_address}</h3>
                                            <div className="flex items-center gap-2 mt-1 text-sm" style={{ color: '#888' }}>
                                                <MapPin className="w-3 h-3" />
                                                <span>{prop.street_name}</span>
                                            </div>
                                        </div>
                                        <Badge variant="outline" style={{
                                            background: prop.original_status === 'SOLD' ? '#22c55e20' : 
                                                       prop.original_status === 'HARD_NO' ? '#ef444420' : '#6b728020',
                                            color: prop.original_status === 'SOLD' ? '#22c55e' : 
                                                   prop.original_status === 'HARD_NO' ? '#ef4444' : '#6b7280',
                                            borderColor: prop.original_status === 'SOLD' ? '#22c55e' : 
                                                         prop.original_status === 'HARD_NO' ? '#ef4444' : '#6b7280'
                                        }}>
                                            {prop.original_status || 'ELIGIBLE'}
                                        </Badge>
                                    </div>
                                </Card>
                            ))
                        )}
                    </>
                )}
            </div>
        </div>
    );
}